// 双分支解析验收脚本(spec 2026-08-28 §8): 遍历样例评估集, 真实执行
// 路由决策(PDF 文字层探测 -> VLM 表单分类 -> formTypeRegistry 路由),
// 以目录名作为类型基准真相输出分类正确率; --extract 时对凭证路由真实执行
// VLM 提取(重量组逐页聚合), 输出总净重/行数/失败页。
//
// 用法(tsx):
//   npx tsx eval/voucher-acceptance.ts                       # 仅路由验收
//   npx tsx eval/voucher-acceptance.ts --extract --max-pages 3
// 环境变量: SAMPLE_ROOT(默认 D:\repo\fastchain-agent-demo\example\document-sample)
// VLM 未配置时: 仅结构校验(扩展名/文字层), 跳过分类与提取, 退出码 0。
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { env } from '../src/env.js';
import { pdfHasTextLayer } from '../src/pipeline/digitalAdapter.js';
import { renderPdfPages } from '../src/pipeline/pdfRender.js';
import { classifyForm } from '../src/pipeline/vlmClassifier.js';
import { buildFormTypeIndex, collectFormTypes, type FormTypeIndex } from '../src/pipeline/formTypeRegistry.js';
import { extractWeightDoc } from '../src/pipeline/pageRecords.js';
import { extractVoucherTyped, type TypedImage } from '../src/pipeline/vlmAdapter.js';
import { VOUCHER_SCHEMAS, WEIGHT_AGGREGATE_DOCTYPES } from '../src/pipeline/schemas/vouchers.js';
import { DOC_TYPE_SEED } from '../src/pipeline/templateSeed.js';
import type { TemplateTypeRow } from '../src/pipeline/db/repositories.js';

const SAMPLE_ROOT = process.env.SAMPLE_ROOT ?? String.raw`D:\repo\fastchain-agent-demo\example\document-sample`;
const EXTRACT = process.argv.includes('--extract');
const maxPages = (() => {
  const i = process.argv.indexOf('--max-pages');
  return i >= 0 ? Number(process.argv[i + 1]) : undefined;
})();
const onlyDirs = (() => {
  const i = process.argv.indexOf('--dirs');
  return i >= 0 ? new Set(process.argv[i + 1]!.split(',')) : undefined;
})();

/** 目录名 -> 期望表单类型(分类基准真相)。 */
const DIR_TO_FORM: Record<string, string> = {
  合同: '合同扫描件',
  磅单: '汽车过磅单票据',
  轨道衡: '轨道衡称重记录',
  水尺: '水尺计重单',
  化验报告: '化验报告',
  银行回单: '银行回单',
  货权转让证明: '货权转移证明',
  发票: '发票',
  结算单: '结算单',
  交货确认: '货物交接清单',
  派船通知单: '派船通知单',
  铁路货物运单: '火运大票',
};

/** 与模板种子一致的静态类型表(脚本不连 DB, 用种子数据派生映射)。 */
function templateRows(): TemplateTypeRow[] {
  return DOC_TYPE_SEED.map((t) => ({
    id: `dt-${t.name}`, kind: 'doc_type' as const, name: t.name,
    parentId: t.parent ? `dt-${t.parent}` : null,
    props: t.props ?? {}, isActive: true,
  }));
}

interface RowResult {
  dir: string; file: string; form: 'image' | 'digital-pdf' | 'image-pdf' | 'other';
  expected?: string; classified?: string; conf?: number;
  route: 'document' | 'voucher' | 'unknown' | 'image-voucher' | 'text' | 'skipped';
  docType?: string;
  extract?: string;
  ms: number;
}

async function main(): Promise<void> {
  if (!statSync(SAMPLE_ROOT, { throwIfNoEntry: false })) {
    console.error(`样例根不存在: ${SAMPLE_ROOT} (可用 SAMPLE_ROOT 覆盖)`);
    process.exit(1);
  }
  const types = templateRows();
  const idx: FormTypeIndex = buildFormTypeIndex(types);
  const formTypes = collectFormTypes(types);
  const vlmReady = Boolean(env.VLM_BASE_URL && env.VLM_API_KEY);
  console.log(`样例根: ${SAMPLE_ROOT}`);
  console.log(`VLM: ${vlmReady ? `${env.VLM_MODEL} @ ${env.VLM_BASE_URL}` : '未配置(仅结构校验)'} | 提取: ${EXTRACT ? '开' : '关'}${maxPages ? ` (每文档最多 ${maxPages} 页)` : ''}\n`);

  const rows: RowResult[] = [];
  for (const dir of readdirSync(SAMPLE_ROOT)) {
    const dirPath = join(SAMPLE_ROOT, dir);
    if (!statSync(dirPath).isDirectory()) continue;
    if (onlyDirs && !onlyDirs.has(dir)) continue;
    for (const file of readdirSync(dirPath)) {
      const p = join(dirPath, file);
      const ext = extname(file).toLowerCase();
      const t0 = performance.now();
      const row: RowResult = { dir, file, form: 'other', expected: DIR_TO_FORM[dir], route: 'skipped', ms: 0 };
      try {
        if (['.jpg', '.jpeg', '.png'].includes(ext)) {
          row.form = 'image';
          row.route = 'image-voucher';
          row.docType = idx.docTypeOf(row.expected ?? '') ?? '其他';
          if (EXTRACT && vlmReady && row.expected && idx.docTypeOf(row.expected) && maxPages !== 0) {
            row.docType = idx.docTypeOf(row.expected);
            const dt = row.docType!;
            const img: TypedImage = { mime: ext === '.png' ? 'image/png' : 'image/jpeg', buffer: readFileSync(p) };
            if (WEIGHT_AGGREGATE_DOCTYPES.has(dt as never)) {
              const fake = { page: 1, mime: img.mime, buffer: img.buffer };
              const agg = await extractWeightDoc([fake], dt as never, { concurrency: 1 });
              row.extract = `ok=${agg.okPages.length} failed=${agg.failedPages.length} 总净重=${agg.fields['总净重_吨']} ${agg.fields['船名'] ?? ''}`;
            } else if (dt in VOUCHER_SCHEMAS) {
              const r = await extractVoucherTyped([img], dt as never);
              row.extract = `fields=${Object.keys(r.fields).length}`;
            }
          }
        } else if (ext === '.pdf') {
          const probe = await pdfHasTextLayer(readFileSync(p));
          if (probe === true) {
            row.form = 'digital-pdf';
            row.route = 'text';
          } else {
            row.form = 'image-pdf';
            const [firstPage] = await renderPdfPages(p, { first: 1 });
            if (!firstPage) throw new Error('渲染 0 页');
            // 提取页集: --max-pages 截断(验收不真跑 160 页), 缺省全量。
            const usePagesCached = maxPages !== undefined
              ? (await renderPdfPages(p)).slice(0, maxPages)
              : undefined;
            if (vlmReady) {
              const c = await classifyForm({ page: { mime: firstPage.mime, buffer: firstPage.buffer }, formTypes });
              row.classified = c.formType;
              row.conf = c.confidence;
              const route = idx.routeOf(c.formType);
              const dt = idx.docTypeOf(c.formType);
              row.route = route === 'voucher' && dt && dt in VOUCHER_SCHEMAS && c.confidence >= 0.6 ? 'voucher' : 'document';
              row.docType = row.route === 'voucher' ? dt : '其他';
              if (row.route === 'voucher' && EXTRACT && dt) {
                const usePages = usePagesCached ?? (await renderPdfPages(p));
                if (WEIGHT_AGGREGATE_DOCTYPES.has(dt as never)) {
                  const agg = await extractWeightDoc(usePages, dt as never, { concurrency: 2 });
                  row.extract = `ok=${agg.okPages.length} failed=${agg.failedPages.length} 总净重=${agg.fields['总净重_吨']} 行=${(agg.fields['明细行'] as unknown[] | undefined)?.length ?? 0}`;
                } else {
                  const r = await extractVoucherTyped(
                    usePages.map((pg) => ({ mime: pg.mime, buffer: pg.buffer })),
                    dt as never,
                  );
                  row.extract = `fields=${Object.keys(r.fields).length}`;
                }
              }
            } else {
              row.route = 'skipped';
            }
          }
        } else {
          row.form = 'other'; // docx 等 -> digital 文本路径(现状)
          row.route = 'text';
        }
      } catch (e) {
        row.extract = `ERROR: ${(e as Error).message.slice(0, 120)}`;
      }
      row.ms = Math.round(performance.now() - t0);
      rows.push(row);
      const cls = row.classified ? `${row.classified}(${(row.conf ?? 0).toFixed(2)})` : '-';
      const ok = row.expected && row.classified ? (row.classified === row.expected ? 'OK ' : 'MISS') : '   ';
      console.log(`[${ok}] ${dir}/${basename(file)} form=${row.form} route=${row.route} ${cls}${row.extract ? ` | ${row.extract}` : ''} ${row.ms}ms`);
    }
  }

  console.log(`\n==== 汇总(${rows.length} 文件) ====`);
  const classifiable = rows.filter((r) => r.expected && r.classified);
  if (classifiable.length > 0) {
    const hit = classifiable.filter((r) => r.classified === r.expected).length;
    console.log(`表单分类正确率: ${hit}/${classifiable.length} = ${(hit / classifiable.length * 100).toFixed(1)}%`);
    for (const r of classifiable.filter((x) => x.classified !== x.expected)) {
      console.log(`  MISS: ${r.dir}/${basename(r.file)} 期望=${r.expected} 实际=${r.classified}(${(r.conf ?? 0).toFixed(2)})`);
    }
  } else {
    console.log(vlmReady ? '无可分类样本(全数字/图片)' : 'VLM 未配置: 跳过分类与提取, 仅完成结构校验');
  }
  const errs = rows.filter((r) => r.extract?.startsWith('ERROR'));
  if (errs.length > 0) {
    console.log(`异常: ${errs.length}`);
    for (const r of errs) console.log(`  ${r.dir}/${basename(r.file)}: ${r.extract}`);
  }
}

await main();
