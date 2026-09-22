// 回归样本套件 runner(W9 T3): 冻结 block_model fixture -> saveDocument -> 真实 LLM
// 抽取 -> 字段级 ground-truth 比对(沿 eval/run.ts 的 seam 与 eq() 归一化语义)。
//
// Hermetic: 无 MinerU/网络下载 —— 输入是 dev 冻结的 blocks fixture; 唯一网络调用是
// 真实 DeepSeek 抽取(getIngestModel)。expectedFields 任一硬 MISS -> exit 1(gate)。
//
// 用法: npm run eval:regression --workspace apps/server [--sample=s01]
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, migrate } from '../src/pipeline/db/client.js';
import { saveDocument, listTemplateTypes } from '../src/pipeline/db/repositories.js';
import { ensureTemplateSeed } from '../src/pipeline/templateSeed.js';
import { extractGroundedFields } from '../src/pipeline/extraction.js';
import { getIngestModel } from '../src/pipeline/ingestModel.js';

const here = dirname(fileURLToPath(import.meta.url));

// 与 run.ts 同款模型工厂(PIPELINE_LLM_* 优先, 否则主 OPENAI_* DeepSeek)。
function getModel() {
  return getIngestModel();
}

/** 抽取值防御解包: 裸 string/number 原样; 对象包装 {value,...}(dev 存储形态)取 .value。 */
function unwrap(v: unknown): string | number {
  if (v !== null && typeof v === 'object' && 'value' in (v as Record<string, unknown>)) {
    const inner = (v as { value: unknown }).value;
    return unwrap(inner);
  }
  return v as string | number;
}

/** 归一化(沿 ground-truth 顶层 normalization 与 run.ts eq()): 剥 ASCII/全角逗号与空白。 */
function norm(v: unknown): string {
  return String(v).replace(/[,，\s]/g, '');
}

const NUM_TOKEN = /-?\d+(?:\.\d+)?/g;

/**
 * 数字锚定比较: 期望归一化后"首位是数字/负号且仅含一个数字 token"(如 10000 / 881.5 /
 * 10803.84吨 / 20260527)时, 以该数字对 actual 的数字 token 集做成员匹配——容忍单位与
 * 修饰语后缀('643.50元/吨(含煤款、运费)')及空格化 garble('1 0 0 0 0…'), 拒绝子串误报
 * (期望 643.50 不会被 1643.50 吃掉)。字母开头(合同号)或多数字期望(617.76/5200(0.1188))
 * 不走锚定, 保持严格串比较。
 */
function anchorCompare(expectedNorm: string, actualNorm: string): boolean {
  if (!/^[-\d]/.test(expectedNorm)) return false;
  const wantTokens = expectedNorm.match(NUM_TOKEN);
  if (!wantTokens || wantTokens.length !== 1) return false;
  const want = Number.parseFloat(wantTokens[0]!);
  const gotTokens = actualNorm.match(NUM_TOKEN) ?? [];
  return gotTokens.some((t) => Number.parseFloat(t) === want);
}

/** ground-truth 字段匹配: 严格归一化相等, 或数字锚定命中。 */
function matches(expected: unknown, got: unknown): boolean {
  const e = norm(expected);
  const g = norm(got);
  return e === g || anchorCompare(e, g);
}

interface SampleManifest {
  id: string;
  file: string;
  sourceDir: string;
  docType: string;
  whySelected: string;
  sizeBytes: number;
}
interface GroundTruthSample {
  id: string;
  file: string;
  docType: string;
  expectedFields: Record<string, string | number>;
  softFields: Record<string, string | number>;
  erpTruth: Record<string, string>;
  provenance: string;
}

function loadJson<T>(p: string): T {
  return JSON.parse(readFileSync(p, 'utf8')) as T;
}

async function main() {
  const manifest = loadJson<{ samples: SampleManifest[] }>(
    resolve(here, 'regression/samples/manifest.json'));
  const gt = loadJson<{ normalization: string; samples: GroundTruthSample[] }>(
    resolve(here, 'regression/ground-truth.json'));

  const byId = new Map(gt.samples.map((s) => [s.id, s]));
  // 真值对齐双向守卫(T5 评审必须修复): manifest 与 ground-truth 任何一侧缺条目都是
  // 配置错位, 硬错误退出——绝不静默按空真值把样本计为通过。
  const manifestIds = new Set(manifest.samples.map((s) => s.id));
  const orphanTruth = gt.samples.filter((s) => !manifestIds.has(s.id)).map((s) => s.id);
  if (orphanTruth.length > 0) {
    console.error(`[regression] ground-truth entries without manifest samples: ${orphanTruth.join(', ')}`);
    process.exit(1);
  }
  const only = process.argv.find((a) => a.startsWith('--sample='))?.split('=')[1];
  const rows = only
    ? manifest.samples.filter((s) => s.id === only)
    : manifest.samples;
  if (only && rows.length === 0) {
    console.error(`[regression] unknown sample id: ${only}`);
    process.exitCode = 1;
    return;
  }

  const model = getModel();
  const ctx = createDb(':memory:');
  migrate(ctx.sqlite);
  // 生产形状前置: 模板类型种子 + 解析(docType 词族 fieldHints 在模板行 props 上)。
  await ensureTemplateSeed(ctx);
  const templateTypes = await listTemplateTypes(ctx);

  let passed = 0;
  const misses: string[] = [];
  const noisy: string[] = [];
  for (const s of rows) {
    const truth = byId.get(s.id);
    if (!truth) {
      console.error(`[regression] no ground-truth entry for manifest sample ${s.id}`);
      process.exit(1);
    }
    const blocksPath = resolve(here, 'regression/samples/', s.file + '.blocks.json');
    if (!existsSync(blocksPath)) {
      // 选中样本缺 fixture = 硬错误(绝不静默跳过)。
      console.error(`[regression] missing blocks fixture for ${s.id}: ${s.file}.blocks.json`);
      process.exitCode = 1;
      return;
    }
    const blockModel = loadJson<Parameters<typeof saveDocument>[1]>(blocksPath);
    await saveDocument(ctx, blockModel);

    const attempt = async () => {
      // 生产形状(autoExtraction.ts buildAutoExtractionDeps.extract): 按 blockModel.docType
      // 解析模板行 props, 带 requiredFields/fieldHints 调用 —— 与 dev 真值同一路径。
      const typeRow = templateTypes.find((t) => t.kind === 'doc_type' && t.name === blockModel.docType);
      const result = await extractGroundedFields({ model }, {
        blockModel,
        docType: blockModel.docType,
        requiredFields: Array.isArray(typeRow?.props.requiredFields) ? (typeRow.props.requiredFields as string[]) : undefined,
        fieldHints: typeRow?.props.fieldHints !== null && typeof typeRow?.props.fieldHints === 'object' && !Array.isArray(typeRow.props.fieldHints)
          ? (typeRow.props.fieldHints as Record<string, string>)
          : undefined,
      });
      const got = new Map(result.fields.map((f) => [f.name, unwrap(f.value)]));
      const total = Object.keys(truth?.expectedFields ?? {}).length;
      const missFields: string[] = [];
      for (const [name, expected] of Object.entries(truth?.expectedFields ?? {})) {
        const gv = got.get(name);
        if (gv === undefined || !matches(expected, gv)) {
          missFields.push(`${name} expected '${expected}' got '${gv === undefined ? '<missing>' : gv}'`);
        }
      }
      // softFields: 只报告, 不守门。
      const softLines: string[] = [];
      for (const [name, expected] of Object.entries(truth?.softFields ?? {})) {
        const gv = got.get(name);
        softLines.push(gv !== undefined && matches(expected, gv)
          ? `SOFT ok ${name}`
          : `SOFT drift ${name} expected '${expected}' got '${gv === undefined ? '<missing>' : gv}'`);
      }
      return { total, missFields, softLines };
    };

    let r = await attempt();
    let attempts = 1;
    while (r.missFields.length > 0 && attempts < 5) {
      // 单跑偶发(LLM 漏抽/键游走)最多五试; 真回归系统性皆红仍拦。OK@n/MISS@n 暴露噪声水位。
      const r2 = await attempt();
      attempts += 1;
      r = r2;
    }
    const ok = r.missFields.length === 0;
    if (ok) passed += 1;
    if (ok && attempts >= 3) noisy.push(`${s.id}@${attempts}`);
    const mark = attempts > 1 ? `@${attempts}` : '';
    const line = ok
      ? `[${s.id}] ${s.docType} OK${mark} ${r.total - r.missFields.length}/${r.total}`
      : `[${s.id}] ${s.docType} MISS${mark} ${r.total - r.missFields.length}/${r.total}: ${r.missFields.join('; ')}`;
    console.log(line);
    for (const sl of r.softLines) console.log(`  ${sl}`);
    if (!ok) misses.push(...r.missFields.map((m) => `[${s.id}] ${m}`));
  }

  console.log(`\nPASSED ${passed}/${rows.length} FAILED ${rows.length - passed}`);
  // 噪声观察面(T5 minor): >=3 试才过的样本点名——出现率漂移(概率位移型回归)给人工看。
  if (noisy.length > 0) console.log(`noise-watch(>=3 attempts): ${noisy.join(' ')}`);
  if (misses.length > 0) {
    console.log('--- hard misses ---');
    for (const m of misses) console.log(`  ${m}`);
  }
  if (passed !== rows.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error('[regression] fatal:', e instanceof Error ? e.message : e);
  process.exit(1);
});