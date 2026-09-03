// B 方案验收脚本(2026-09-03): 走生产分类/提取路径验证「质检汇总表」扩展。
//   Phase 1 分类回归: 51 份样本逐份 renderPdfPages 第 1 页 -> classifyForm
//     (formTypes 取自 templateSeed 种子, 与 collectFormTypes 同源), 断言:
//     上轮 10 份 B 类命中新类型, 35 份 C 类与 2 份 A 类不漂移。
//   Phase 2 抽取验证: B 类样本全页渲染 -> extractVoucherTyped('质检汇总表')
//     -> VOUCHER_SCHEMAS 校验 + validateVoucher warnings, 报告行数/合计/告警。
// 产物: 样本收集/B方案验证报告.csv。不修改任何业务数据。
import '../src/env.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderPdfPages } from '../src/pipeline/pdfRender.js';
import { classifyForm } from '../src/pipeline/vlmClassifier.js';
import { extractVoucherTyped } from '../src/pipeline/vlmAdapter.js';
import { validateVoucher, VOUCHER_SCHEMAS } from '../src/pipeline/schemas/vouchers.js';
import { DOC_TYPE_SEED } from '../src/pipeline/templateSeed.js';

const BASE = 'D:/Users/yepeng/orca/workspaces/supply-chain-agent-prototype/文档解析/样本收集';
const CSV_IN = join(BASE, '内容验证报告.csv');
const CSV_OUT = join(BASE, 'B方案验证报告.csv');
const CONC = 3;
const NEW_FORM_TYPES = new Set(['收货质检汇总表', '下游收货数据']);

// formTypes 候选与生产一致: 模板种子全部 active doc_type 的 props.formTypes 并集。
const formTypes = DOC_TYPE_SEED
  .flatMap((t) => Array.isArray(t.props?.formTypes) ? t.props.formTypes as string[] : []);

interface PrevRow { file: string; dir: string; vlm_type: string }
const prev = readFileSync(CSV_IN, 'utf8').replace(/^\uFEFF/, '')
  .split('\n').slice(1).filter((l) => l.trim().length > 0)
  .map((l) => {
    const m = l.match(/^"([^"]+)",([^,]+),([^,]+),/);
    return m ? { file: m[1]!, dir: m[2]!, vlm_type: m[3]! } : null;
  }).filter((r): r is PrevRow => r !== null);

function expectedFormOf(prevType: string): 'new' | 'keep-other' {
  return prevType === 'B' ? 'new' : 'keep-other';
}

async function classifyOne(rel: string): Promise<{ formType: string; confidence: number }> {
  const full = join(BASE, rel);
  const [page] = await renderPdfPages(full, { first: 1 });
  if (!page) throw new Error('渲染失败');
  return classifyForm({ page: { mime: page.mime, buffer: page.buffer }, formTypes });
}

async function extractOne(rel: string): Promise<{
  rows: number; totalOk: boolean; schemaOk: boolean; warnings: string[]; netSum: number | null;
}> {
  const pages = await renderPdfPages(join(BASE, rel));
  const typed = await extractVoucherTyped(
    pages.map((p) => ({ mime: p.mime, buffer: p.buffer })),
    '质检汇总表',
  );
  const parsed = VOUCHER_SCHEMAS['质检汇总表']!.safeParse(typed.fields);
  const warnings = validateVoucher('质检汇总表', typed.fields);
  const rows = Array.isArray(typed.fields['明细行']) ? (typed.fields['明细行'] as unknown[]).length : 0;
  const total = typed.fields['合计净重_吨'];
  let netSum: number | null = null;
  if (Array.isArray(typed.fields['明细行'])) {
    netSum = (typed.fields['明细行'] as Array<Record<string, unknown>>).reduce<number>((s, r) => {
      const v = r?.['净重_吨'];
      return s + (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    }, 0);
  }
  return {
    rows,
    totalOk: typeof total === 'number',
    schemaOk: parsed.success,
    warnings,
    netSum,
  };
}

async function main() {
  console.log(`formTypes(${formTypes.length}): ${formTypes.join(' / ')}`);
  const jobs = prev;
  const results: Array<{ row: PrevRow; hit: boolean; formType: string; confidence: number; err?: string }> = [];
  let idx = 0;
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (idx < jobs.length) {
      const row = jobs[idx++]!;
      try {
        const c = await classifyOne(row.file);
        const hit = expectedFormOf(row.vlm_type) === 'new'
          ? NEW_FORM_TYPES.has(c.formType)
          : !NEW_FORM_TYPES.has(c.formType);
        results.push({ row, hit, formType: c.formType, confidence: c.confidence });
        console.log(`[${results.length}] prev=${row.vlm_type} -> ${c.formType} (${c.confidence.toFixed(2)}) ${hit ? 'OK' : 'DRIFT'}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        results.push({ row, hit: false, formType: 'ERROR', confidence: 0, err: msg });
        console.log(`[ERR] ${row.file}: ${msg}`);
      }
    }
  }));

  const drift = results.filter((r) => !r.hit);
  const bRows = results.filter((r) => r.row.vlm_type === 'B');
  const bHit = bRows.filter((r) => NEW_FORM_TYPES.has(r.formType));
  console.log(`\n== 分类回归 == B 类命中 ${bHit.length}/${bRows.length}; 漂移/异常 ${drift.length}/${results.length}`);

  // Phase 2: 对命中新类型的样本做抽取验证。
  const extractRows: Array<{ file: string; rows: number; totalOk: boolean; schemaOk: boolean; netSum: number | null; warnings: string; err?: string }> = [];
  const extractTargets = results
    .filter((r) => NEW_FORM_TYPES.has(r.formType))
    .map((r) => r.row.file);
  console.log(`\n== 抽取验证 == 目标 ${extractTargets.length} 份`);
  let eidx = 0;
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (eidx < extractTargets.length) {
      const rel = extractTargets[eidx++]!;
      try {
        const e = await extractOne(rel);
        extractRows.push({ file: rel, ...e, warnings: e.warnings.join('; ') });
        console.log(`[ext] ${rel}: rows=${e.rows} totalOk=${e.totalOk} schemaOk=${e.schemaOk} netSum=${e.netSum} warn=${e.warnings.length}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        extractRows.push({ file: rel, rows: 0, totalOk: false, schemaOk: false, netSum: null, warnings: '', err: msg });
        console.log(`[ext ERR] ${rel}: ${msg}`);
      }
    }
  }));
  const extOk = extractRows.filter((r) => r.schemaOk && r.rows > 0);
  console.log(`抽取通过(schema 过 + 有行): ${extOk.length}/${extractTargets.length}`);

  const csv = [
    'phase,file,prev_type,form_type,confidence,hit,rows,total_ok,schema_ok,net_sum,warnings,error',
    ...results.map((r) => [
      'classify', `"${r.row.file}"`, r.row.vlm_type, r.formType,
      r.confidence.toFixed(2), r.hit ? '1' : '0', '', '', '', '', '', r.err ?? '',
    ].join(',')),
    ...extractRows.map((r) => [
      'extract', `"${r.file}"`, 'B', '质检汇总表', '', '',
      String(r.rows), r.totalOk ? '1' : '0', r.schemaOk ? '1' : '0',
      r.netSum !== null ? r.netSum.toFixed(2) : '', `"${r.warnings}"`, r.err ?? '',
    ].join(',')),
  ].join('\n');
  writeFileSync(CSV_OUT, '\uFEFF' + csv, 'utf8');
  console.log(`\n报告已写入 ${CSV_OUT}`);
}

void main();
