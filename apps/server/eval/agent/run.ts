// apps/server/eval/agent/run.ts
// CLI: npm run eval:agent --workspace apps/server -- --dataset=datasets/core.yaml --runs=3 [--filter=t1-order-status]
// Uses the REAL agent model (DeepSeek via env.OPENAI_*) + an independent judge
// model (EVAL_JUDGE_*, falling back to the main model config). Intentionally
// NOT part of npm test (online); unit tests cover the offline pieces.
import { createOpenAI } from '@ai-sdk/openai';
import { copyFileSync, mkdirSync } from 'node:fs';
import { env } from '../../src/env.js';
import { defaultEmbedder } from '../../src/pipeline/ingestModel.js';
import { loadDataset } from './datasets.js';
import { runEpisode } from './driver.js';
import { runVerifiers } from './verifiers.js';
import { judgeEpisode } from './judge.js';
import { aggregateScore } from './scoring.js';
import { writeResults } from './reporter.js';
import { formatEventLine, type EvalRunEvent } from './events.js';
import type { EpisodeArtifact, EpisodeScore, Scenario } from './types.js';
import { createDb, migrate } from '../../src/pipeline/db/client.js';
import { enableVec } from '../../src/pipeline/db/vecStore.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
}

/**
 * Replace {{INGEST_ROOT}} placeholders in scenario text with the resolved
 * ingest root. Doc-entry personas reference fixture paths through this
 * placeholder so the same dataset works on any checkout / INGEST_ROOT config.
 * JSON-level replace: backslashes in Windows paths must be escaped to keep the
 * intermediate JSON string valid.
 */
function hydrateIngestRoot(s: Scenario, root: string): Scenario {
  const jsonSafeRoot = root.replaceAll('\\', '\\\\');
  return JSON.parse(JSON.stringify(s).replaceAll('{{INGEST_ROOT}}', jsonSafeRoot)) as Scenario;
}

/** Copy the doc-entry fixtures into INGEST_ROOT (assertWithinRoot allowlist). */
function seedFixturesIntoIngestRoot(): string {
  const root = resolve(env.INGEST_ROOT);
  mkdirSync(root, { recursive: true });
  for (const fixture of ['sample-clean-digital.txt', 'sample-ambiguous-quantity.txt']) {
    copyFileSync(resolve(here, '..', 'contracts', fixture), resolve(root, fixture));
  }
  return root;
}

async function main() {
  const emit = (e: EvalRunEvent) => process.stdout.write(formatEventLine(e) + '\n');
  const datasetArg = arg('dataset') ?? 'datasets/core.yaml';
  const runs = Number(arg('runs') ?? 3);
  const filter = arg('filter');
  const datasetPath = datasetArg.startsWith('/') || /^[A-Za-z]:/.test(datasetArg)
    ? datasetArg
    : resolve(here, datasetArg);

  // Doc-entry datasets reference fixtures via {{INGEST_ROOT}}; seed them before
  // episodes run. Harmless for datasets without the placeholder.
  const ingestRoot = seedFixturesIntoIngestRoot();

  const scenarios = loadDataset(datasetPath)
    .filter((s) => !filter || s.id === filter)
    .map((s) => hydrateIngestRoot(s, ingestRoot));
  if (scenarios.length === 0) {
    console.error(`no scenarios matched (dataset=${datasetPath}, filter=${filter ?? '-'})`);
    process.exit(1);
  }

  const agentModel = createOpenAI({
    baseURL: env.OPENAI_BASE_URL,
    apiKey: env.OPENAI_API_KEY,
  }).chat(env.OPENAI_MODEL);
  const simModel = createOpenAI({
    baseURL: env.OPENAI_BASE_URL,
    apiKey: env.OPENAI_API_KEY,
  }).chat(env.OPENAI_MODEL);
  const judgeModel = createOpenAI({
    baseURL: env.EVAL_JUDGE_BASE_URL ?? env.OPENAI_BASE_URL,
    apiKey: env.EVAL_JUDGE_API_KEY ?? env.OPENAI_API_KEY,
  }).chat(env.EVAL_JUDGE_MODEL ?? env.OPENAI_MODEL);

  const runId = process.env.EVAL_RUN_ID ?? null; // server-generated, keeps registry/URL/dir in sync

  const total = scenarios.length * runs;
  emit({ type: 'run_started', runId: runId ?? `${new Date().toISOString().replace(/[:.]/g, '-')}-${datasetArg.split('/').pop()!.replace(/\.yaml$/, '')}`, total });
  const artifacts: EpisodeArtifact[] = [];
  const scores: EpisodeScore[] = [];
  for (const scenario of scenarios) {
    for (let run = 1; run <= runs; run++) {
      console.error(`[eval] scenario=${scenario.id} run=${run}/${runs} ...`);
      emit({ type: 'scenario_started', scenarioId: scenario.id, runIndex: run });
      // Fresh in-memory pipeline DB per episode; extraction shares the agent model.
      // Deterministic embedder (Ollama unset) keeps vector/hybrid recall offline
      // and reproducible -- enough to exercise the KNN + RRF paths deterministically.
      // enableVec mirrors dbBackend.ts / pipeline tests: migrate() alone does not
      // load sqlite-vec or create doc_chunk_vec, so vector recall would silently
      // degrade to fts without it.
      const ctx = createDb(':memory:');
      migrate(ctx.sqlite);
      enableVec(ctx.sqlite);
      const artifact = await runEpisode({
        scenario,
        runIndex: run,
        agentModel,
        simModel,
        deps: { ctx, extraction: { model: agentModel }, embedder: defaultEmbedder() },
        onEvent: emit,
      });
      const verifier = runVerifiers(scenario.verifiers, artifact);
      const judge = await judgeEpisode(judgeModel, scenario.rubric, artifact);
      const score = aggregateScore(artifact, verifier, judge);
      artifacts.push(artifact);
      scores.push(score);
      console.error(
        `[eval] scenario=${scenario.id} run=${run} verdict=${score.verdict}` +
        (score.rubricScore != null ? ` score=${score.rubricScore}` : '') +
        (score.vetoTriggered ? ' VETO' : ''),
      );
      emit({ type: 'episode_done', scenarioId: scenario.id, runIndex: run, verdict: score.verdict, rubricScore: score.rubricScore, vetoTriggered: score.vetoTriggered });
    }
  }

  const dsName = datasetArg.split('/').pop()!.replace(/\.yaml$/, '');
  // EVAL_RUN_ID mode: the server-assigned runId already embeds the stamp +
  // dataset tag, so outDir uses it verbatim (no re-appended dsName). Plain CLI
  // (no EVAL_RUN_ID) keeps the legacy stamp-dsName directory.
  const outDir = runId
    ? resolve(here, 'results', runId)
    : resolve(here, 'results', `${new Date().toISOString().replace(/[:.]/g, '-')}-${dsName}`);
  const { episodesPath, reportPath } = writeResults(outDir, artifacts, scores);
  emit({ type: 'run_done', outDir });
  console.error(`\n[eval] episodes: ${episodesPath}`);
  console.error(`[eval] report:   ${reportPath}`);
}

main().catch((e) => {
  process.stdout.write(formatEventLine({ type: 'run_error', message: e instanceof Error ? e.message : String(e) }) + '\n');
  console.error(e);
  process.exit(1);
});
