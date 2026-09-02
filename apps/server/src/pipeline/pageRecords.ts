// 逐页提取编排 + 服务端聚合(spec 2026-08-28 §5.2/§5.1)。
// 重量凭证组: 逐页独立 VLM 调用(单页失败重试 1 次, 不扩散), 全部页终态后
// 服务端确定性聚合总净重(聚合零幻觉: 模型只对单页/单行负责)。
import type { RenderedPage } from './pdfRender.js';
import { extractVoucherTyped } from './vlmAdapter.js';
import { classifyProviderError } from '../harness/providerErrors.js';
import {
  汽运磅单行Schema,
  轨道衡行Schema,
  WEIGHT_AGGREGATE_DOCTYPES,
  type VoucherType,
} from './schemas/vouchers.js';

export type WeightDocType = '汽运磅单' | '轨道衡称重单' | '水尺计重单';

/** 有界并发, 保序返回(结果顺序与输入一致)。 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

export interface PageImage {
  mime: string;
  buffer: Buffer;
}

export type PageExtractOne = (
  image: PageImage,
  docType: WeightDocType,
) => Promise<{ fields: Record<string, unknown> }>;

export interface WeightDocResult {
  fields: Record<string, unknown>;
  warnings: string[];
  okPages: number[];
  failedPages: number[];
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** 单页提取结果按类型校验: 行类型必须完整(绝不静默丢行/丢字段)。 */
function validatePage(fields: Record<string, unknown>, docType: WeightDocType): boolean {
  if (docType === '汽运磅单') {
    return 汽运磅单行Schema.safeParse(fields).success;
  }
  if (docType === '轨道衡称重单') {
    const rows = fields['rows'];
    if (!Array.isArray(rows) || rows.length === 0) return false;
    return rows.every((r) => 轨道衡行Schema.safeParse(r).success);
  }
  return true; // 水尺: 文档级 schema 在聚合后由 VOUCHER_SCHEMAS 统一校验
}

/**
 * 逐页提取重量凭证并聚合。页级失败重试 1 次(沿用回灌模式由 extractOne 内部
 * 处理网络层; 本层对"校验不过/抛错"的页重试 1 次后记入 failedPages)。
 * 全部页失败 -> throw; 部分失败 -> fields.失败页 + warnings, 由上层落 needs_review。
 */
export async function extractWeightDoc(
  pages: RenderedPage[],
  docType: WeightDocType,
  opts: { concurrency?: number; extractOne?: PageExtractOne } = {},
): Promise<WeightDocResult> {
  if (!WEIGHT_AGGREGATE_DOCTYPES.has(docType as VoucherType)) {
    throw new Error(`非重量聚合类型: ${docType}`);
  }
  const extractOne =
    opts.extractOne ??
    (async (image: PageImage, dt: WeightDocType) => {
      const r = await extractVoucherTyped([image], dt);
      return { fields: r.fields };
    });

  const warnings: string[] = [];
  const okPages: number[] = [];
  const failedPages: number[] = [];
  const pageFields = await mapLimit(pages, opts.concurrency ?? 4, async (p) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { fields } = await extractOne({ mime: p.mime, buffer: p.buffer }, docType);
        if (!validatePage(fields, docType)) throw new Error('页字段校验未通过(缺必填项或行不完整)');
        return { page: p.page, fields };
      } catch (e) {
        if (attempt === 0) continue;
        const reason = e instanceof Error ? e.message : String(e);
        // 分类可见性(2026-09-02 双供应商错误分类): 供应商级失败(欠费/限流/
        // 内容安全拦截等)逐页告警。页仍照常记入 failedPages, 行为不变。
        const cls = classifyProviderError(e);
        if (cls.code) {
          console.warn(`[voucher] 重量凭证第 ${p.page} 页 VLM 调用失败(${cls.shortLabel}), 记为失败页: ${reason}`);
        }
        warnings.push(`页 ${p.page} 提取失败: ${reason}`);
        return { page: p.page, fields: null };
      }
    }
    return { page: p.page, fields: null }; // 不可达(mapLimit 泛型需要)
  });

  for (const pf of pageFields) {
    if (pf.fields === null) failedPages.push(pf.page);
    else {
      okPages.push(pf.page);
    }
  }
  if (okPages.length === 0) {
    throw new Error(`全部页面提取失败(docType=${docType}): ${warnings.join('; ')}`);
  }
  const byPage = [...pageFields].sort((a, b) => a.page - b.page);

  const fields: Record<string, unknown> = {};
  if (docType === '汽运磅单') {
    fields['明细行'] = byPage
      .filter((p): p is { page: number; fields: Record<string, unknown> } => p.fields !== null)
      .map((p) => ({ ...p.fields, 页码: p.page }));
    const total = (fields['明细行'] as Record<string, unknown>[]).reduce<number>(
      (s, r) => s + (typeof r['净重_吨'] === 'number' ? r['净重_吨'] : 0),
      0,
    );
    fields['总净重_吨'] = round3(total);
  } else if (docType === '轨道衡称重单') {
    const header: Record<string, unknown> = {};
    const rows: Record<string, unknown>[] = [];
    let total = 0;
    for (const p of byPage) {
      if (p.fields === null) continue;
      for (const k of ['编号', '称量日期'] as const) {
        if (header[k] === undefined && typeof p.fields[k] === 'string') header[k] = p.fields[k];
      }
      const pageRows = Array.isArray(p.fields['rows']) ? p.fields['rows'] : [];
      for (const r of pageRows as Record<string, unknown>[]) {
        rows.push({ ...r, 页码: p.page });
        if (typeof r['净重_吨'] === 'number') total += r['净重_吨'];
      }
    }
    Object.assign(fields, header);
    fields['明细行'] = rows;
    fields['总净重_吨'] = round3(total);
  } else {
    // 水尺: 首个成功页整体字段(单页表单)
    const first = byPage.find((p): p is { page: number; fields: Record<string, unknown> } => p.fields !== null);
    Object.assign(fields, first!.fields);
  }
  fields['页数'] = pages.length;
  fields['失败页'] = failedPages;
  if (failedPages.length > 0) {
    warnings.push(`失败页未计入总净重: ${failedPages.join(', ')}`);
  }
  return { fields, warnings, okPages, failedPages };
}
