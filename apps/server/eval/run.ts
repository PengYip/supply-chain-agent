// 合同 eval runner — exercises the full pipeline (ingest -> extract -> confidence)
// against synthetic samples with field-level ground truth + a grounding trap.
//
// Metrics: 字段抽取准确率 (field value exact match), span接地率 (% strength!=none),
// 引用准确率 (% cited spans whose text contains the value), HITL触发 (precision/recall
// of needsReview vs trap fields).
//
// This runner calls the REAL DeepSeek model (OPENAI_* env). It is intentionally a
// separate `npm run eval` script so `npm test` stays hermetic/offline.
//
// NOTE: env.ts exports only `env` (no buildModelFromEnv); getModel() uses the same
// createOpenAI(...).chat(env.OPENAI_MODEL) factory as src/harness/agent.ts.
//
// Achieved metrics (implementer run vs real DeepSeek, deepseek-v4-flash):
//   clean-digital  : 字段抽取准确率=1.000 span接地率=1.000 引用准确率=1.000 HITL p=1.000 r=1.000 (no traps)
//   scanned-trap   : 字段抽取准确率=0.875 span接地率=1.000 引用准确率=1.000 HITL p=1.000 r=0.000
//     NOTE: the trap did NOT trigger because the model transcribed the garbled OCR
//     "3 9X0 000" verbatim (NOT the true 3950000), so the value IS grounded against
//     the source (strength=exact, conf=0.95=KEY threshold -> review=false). The
//     grounding gate catches HALLUCINATION (invented values), not OCR-transcription
//     errors. The gate's catch of ungrounded values is proven deterministically by
//     test/pipeline/extraction.test.ts + spanValidator.test.ts (strength=none ->
//     needsReview). See task-10-report.md for full analysis.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, migrate } from '../src/pipeline/db/client.js';
import { saveDocument } from '../src/pipeline/db/repositories.js';
import { ingestWithDigital } from '../src/pipeline/digitalAdapter.js';
import { ingestWithMinerU } from '../src/pipeline/mineruAdapter.js';
import { extractGroundedFields } from '../src/pipeline/extraction.js';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

// Build the real DeepSeek LanguageModel from env (same factory as the agent harness).
async function getModel() {
  const { createOpenAI } = await import('@ai-sdk/openai');
  const { env } = await import('../src/env.js');
  const openai = createOpenAI({ baseURL: env.OPENAI_BASE_URL, apiKey: env.OPENAI_API_KEY });
  return openai.chat(env.OPENAI_MODEL);
}

interface Sample {
  id: string; path: string; modality: 'digital' | 'scanned';
  docType: '合同'; expected: Record<string, string | number>; traps: string[];
}

function eq(a: unknown, b: unknown): boolean {
  return String(a).replace(/[,，\s]/g, '') === String(b).replace(/[,，\s]/g, '');
}

async function main() {
  const gt = JSON.parse(readFileSync(resolve(here, 'contracts/ground-truth.json'), 'utf-8')) as { samples: Sample[] };
  const model = await getModel();
  const ctx = createDb(':memory:');
  migrate(ctx.sqlite);

  const only = process.argv.find((a) => a.startsWith('--sample='))?.split('=')[1];
  const samples = only ? gt.samples.filter((s) => s.id === only) : gt.samples;

  let tp = 0, fp = 0, fn = 0;
  let fieldTotal = 0, fieldCorrect = 0;
  let spanTotal = 0, spanGrounded = 0, citationCorrect = 0;

  for (const s of samples) {
    const abs = resolve(here, s.path.replace(/^eval\//, ''));
    const docId = `EVAL-${s.id}`;
    const blockModel = s.modality === 'scanned'
      ? await ingestWithMinerU(abs, s.docType, docId)
      : await ingestWithDigital(abs, s.docType, docId);
    await saveDocument(ctx, blockModel);
    const result = await extractGroundedFields({ model }, { blockModel, docType: s.docType });

    for (const [name, expected] of Object.entries(s.expected)) {
      fieldTotal++;
      const f = result.fields.find((x) => x.name === name);
      if (f && eq(f.value, expected)) fieldCorrect++;
      if (f) {
        spanTotal++;
        if (f.strength !== 'none') spanGrounded++;
        if (f.citedText && eq(f.citedText, f.value)) citationCorrect++;
      }
      // HITL recall: trap fields MUST trigger needsReview
      const isTrap = s.traps.includes(name);
      const flagged = f?.needsReview ?? true;
      if (isTrap && flagged) tp++;
      if (isTrap && !flagged) fn++;
      if (!isTrap && flagged) fp++;
    }
    console.log(`\n[${s.id}] overallConfidence=${result.overallConfidence} needsReview=${result.needsReview} missing=${result.missingRequired.join(',') || '-'}`);
    for (const f of result.fields) {
      console.log(`  ${f.name}=${f.value} strength=${f.strength} conf=${f.confidence} review=${f.needsReview}`);
    }
  }

  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  console.log('\n===== METRICS =====');
  console.log(`字段抽取准确率: ${fieldCorrect}/${fieldTotal} = ${(fieldCorrect / fieldTotal).toFixed(3)}`);
  console.log(`span接地率:     ${spanGrounded}/${spanTotal} = ${(spanGrounded / spanTotal).toFixed(3)}`);
  console.log(`引用准确率:     ${citationCorrect}/${spanTotal} = ${(citationCorrect / spanTotal).toFixed(3)}`);
  console.log(`HITL触发 precision=${precision.toFixed(3)} recall=${recall.toFixed(3)} (tp=${tp} fp=${fp} fn=${fn})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
