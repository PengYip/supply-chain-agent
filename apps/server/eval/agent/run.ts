// apps/server/eval/agent/run.ts
// CLI: npm run eval:agent --workspace apps/server -- --dataset=datasets/core.yaml --runs=3 [--filter=t1-order-status]
// Uses the REAL agent model (DeepSeek via env.OPENAI_*) + an independent judge
// model (EVAL_JUDGE_*, falling back to the main model config). Intentionally
// NOT part of npm test (online); unit tests cover the offline pieces.
import { createOpenAI } from '@ai-sdk/openai';
import { env } from '../../src/env.js';
import { loadDataset } from './datasets.js';
import { runEpisode } from './driver.js';
import { runVerifiers } from './verifiers.js';
import { judgeEpisode } from './judge.js';
import { aggregateScore } from './scoring.js';
import { writeResults } from './reporter.js';
import type { EpisodeArtifact, EpisodeScore } from './types.js';
import { createDb, migrate } from '../../src/pipeline/db/client.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
}

async function main() {
  const datasetArg = arg('dataset') ?? 'datasets/core.yaml';
  const runs = Number(arg('runs') ?? 3);
  const filter = arg('filter');
  const datasetPath = datasetArg.startsWith('/') || /^[A-Za-z]:/.test(datasetArg)
    ? datasetArg
    : resolve(here, datasetArg);

  const scenarios = loadDataset(datasetPath).filter((s) => !filter || s.id === filter);
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

  const artifacts: EpisodeArtifact[] = [];
  const scores: EpisodeScore[] = [];
  for (const scenario of scenarios) {
    for (let run = 1; run <= runs; run++) {
      console.log(`[eval] scenario=${scenario.id} run=${run}/${runs} ...`);
      // Fresh in-memory pipeline DB per episode; extraction shares the agent model.
      const ctx = createDb(':memory:');
      migrate(ctx.sqlite);
      const artifact = await runEpisode({
        scenario,
        runIndex: run,
        agentModel,
        simModel,
        deps: { ctx, extraction: { model: agentModel } },
      });
      const verifier = runVerifiers(scenario.verifiers, artifact);
      const judge = await judgeEpisode(judgeModel, scenario.rubric, artifact);
      const score = aggregateScore(artifact, verifier, judge);
      artifacts.push(artifact);
      scores.push(score);
      console.log(
        `[eval] scenario=${scenario.id} run=${run} verdict=${score.verdict}` +
        (score.rubricScore != null ? ` score=${score.rubricScore}` : '') +
        (score.vetoTriggered ? ' VETO' : ''),
      );
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dsName = datasetArg.split('/').pop()!.replace(/\.yaml$/, '');
  const outDir = resolve(here, 'results', `${stamp}-${dsName}`);
  const { episodesPath, reportPath } = writeResults(outDir, artifacts, scores);
  console.log(`\n[eval] episodes: ${episodesPath}`);
  console.log(`[eval] report:   ${reportPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
