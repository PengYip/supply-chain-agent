// 样本内容级三分类验证(2026-09-03):
//   对 样本收集/ 下的收货单据 PDF 逐份调 VLM, 判别
//   A 纯化验报告 / B 收货质检混合汇总表 / C 纯磅单(仅重量) / D 其他
// 目的: 量化"现有词表无法区分混合汇总表"的实际占比, 作为 B 方案
//   (新增质检汇总表类型)的实施依据与验收基线。只渲染每份第 1 页。
import '../src/env.js';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderPdfPages } from '../src/pipeline/pdfRender.js';
import { vlmCall } from '../src/pipeline/vlmClassifier.js';

const BASE = 'D:/Users/yepeng/orca/workspaces/supply-chain-agent-prototype/文档解析/样本收集';
const DIRS = ['6-收货单据-待细分', '1-纯化验报告', '2-混合汇总表', '3-纯收货表格'];
const CONC = 3;

const PROMPT = [
  '你是供应链单据分类器。图片是收货相关单据的一页, 判断它属于哪一类:',
  'A 纯化验报告: 仅有质量指标(发热量/水分/灰分/硫分/挥发分), 没有逐车重量明细',
  'B 收货质检混合汇总表: 逐车/逐行同时有重量列(毛重/皮重/净重)和质量列(发热量/水分/灰分/硫分), 常有合计行',
  'C 纯磅单或收货重量表: 只有重量/车次信息, 没有质量指标列',
  'D 其他(合同/会议纪要/空白等)',
  '严格输出 JSON, 不要解释: {"type":"A|B|C|D","evidence":"不超过30字的依据"}',
].join('\n');

interface Row { file: string; dir: string; type: string; evidence: string }

function expectedOf(name: string): string {
  if (/化验/.test(name)) return 'A';
  if (/收货数据|数据\+磅单|数据、磅单|截屏、数据确认|收货确认|收货证明|收货明细|数据\+确认/.test(name)) return 'B';
  return 'C';
}

async function classifyFile(path: string): Promise<{ type: string; evidence: string }> {
  const pages = await renderPdfPages(path, { first: 1 });
  const p = pages[0]!;
  const content = await vlmCall(PROMPT, { mime: p.mime, buffer: p.buffer }, 'vlm_batch_split');
  const m = content.match(/\{[\s\S]*\}/);
  if (!m) return { type: 'PARSE_FAIL', evidence: content.slice(0, 80) };
  try {
    const j = JSON.parse(m[0]) as { type?: string; evidence?: string };
    return { type: String(j.type ?? '?'), evidence: String(j.evidence ?? '').slice(0, 60) };
  } catch {
    return { type: 'PARSE_FAIL', evidence: content.slice(0, 80) };
  }
}

async function main() {
  const rows: Row[] = [];
  const jobs: Array<() => Promise<void>> = [];
  for (const dir of DIRS) {
    const full = join(BASE, dir);
    for (const f of readdirSync(full)) {
      if (!f.toLowerCase().endsWith('.pdf')) continue;
      jobs.push(async () => {
        try {
          const r = await classifyFile(join(full, f));
          rows.push({ file: `${dir}/${f}`, dir, type: r.type, evidence: r.evidence });
          console.log(`[${rows.length}] ${r.type}  ${f}`);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          rows.push({ file: `${dir}/${f}`, dir, type: 'ERROR', evidence: msg.slice(0, 60) });
          console.log(`[ERR] ${f}: ${msg}`);
        }
      });
    }
  }
  console.log(`total files: ${jobs.length}, concurrency ${CONC}`);
  let idx = 0;
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (idx < jobs.length) {
      const j = jobs[idx++]!;
      await j();
    }
  }));

  const csv = [
    'file,dir,vlm_type,filename_expected,evidence',
    ...rows.map((r) => `"${r.file}",${r.dir},${r.type},${expectedOf(r.file.split('/').pop()!)},${r.evidence}`),
  ].join('\n');
  writeFileSync(join(BASE, '内容验证报告.csv'), '\uFEFF' + csv, 'utf8');

  const by = new Map<string, number>();
  rows.forEach((r) => by.set(r.type, (by.get(r.type) ?? 0) + 1));
  console.log('--- VLM 判别分布 ---');
  by.forEach((v, k) => console.log(`${k}: ${v}`));
  let mismatch = 0;
  for (const r of rows) {
    if (r.type !== 'D' && r.type !== 'ERROR' && r.type !== 'PARSE_FAIL' && expectedOf(r.file.split('/').pop()!) !== r.type) mismatch++;
  }
  console.log(`文件名预期 vs VLM 不一致: ${mismatch}/${rows.length} (明细见 内容验证报告.csv)`);
}

void main();
