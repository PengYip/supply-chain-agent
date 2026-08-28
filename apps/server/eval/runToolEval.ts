// Tool-use eval runner — real-model tool SELECTION accuracy over
// eval/datasets/tool-use.json (same dataset the offline vitest gate uses).
//
// For each case: send the user query through the PRODUCTION system prompt +
// the PRODUCTION gated toolset (scenario mounting NOT applied -- we are
// evaluating the model's choice from the full surface), stop after one step,
// and check the FIRST tool call lands in expectedTools. Also reports the
// accuracy of avoiding forbidden first-calls.
//
// RUN (real LLM, NOT part of npm test):
//   npm run eval:tools --workspace apps/server
//
// The scenario router is evaluated deterministically by
// test/eval/toolUse.dataset.test.ts (npm test); this runner measures the model.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateText, stepCountIs, type Tool, type ToolCallPart } from 'ai';

const here = dirname(fileURLToPath(import.meta.url));

interface ToolUseCase {
  id: string;
  query: string;
  expectedScenario: string;
  expectedTools: string[];
  forbiddenTools: string[];
  notes?: string;
}
interface Dataset { version: string; cases: ToolUseCase[] }

const dataset = JSON.parse(
  readFileSync(resolve(here, 'datasets/tool-use.json'), 'utf-8'),
) as Dataset;

async function getModel() {
  const { createDeepSeek } = await import('@ai-sdk/deepseek');
  const { env } = await import('../src/env.js');
  return createDeepSeek({ baseURL: env.OPENAI_BASE_URL, apiKey: env.OPENAI_API_KEY }).chat(env.OPENAI_MODEL);
}

async function main(): Promise<void> {
  const [{ SYSTEM_PROMPT }, { getToolsForRole }, { createDb, migrate }] = await Promise.all([
    import('../src/harness/agent.js'),
    import('../src/harness/roleToolRegistry.js'),
    import('../src/pipeline/db/client.js'),
  ]);
  const model = await getModel();
  const ctx = createDb(':memory:');
  migrate(ctx.sqlite);
  const gated = getToolsForRole('trader', { ctx, extraction: { model }, classifier: { model } });
  // Evaluate SELECTION only: strip execute so a chosen tool is not actually
  // run (no real ingest/quota mutations, no nested extraction LLM calls).
  // stopWhen stepCountIs(1) ends the loop after the first model step anyway.
  const tools: Record<string, Tool> = Object.fromEntries(
    gated.map((t) => [t.name, { description: t.description, inputSchema: t.inputSchema }]),
  );

  let hit = 0;
  let forbiddenMiss = 0;
  const failures: string[] = [];
  const t0 = Date.now();

  for (const c of dataset.cases) {
    try {
      const res = await generateText({
        model,
        system: SYSTEM_PROMPT,
        prompt: c.query,
        tools,
        stopWhen: stepCountIs(1),
      });
      const firstCall = res.content.find(
        (p): p is ToolCallPart => p.type === 'tool-call',
      )?.toolName ?? '(no-call)';
      const ok = c.expectedTools.includes(firstCall);
      const bad = c.forbiddenTools.includes(firstCall);
      if (ok) hit++;
      if (bad) forbiddenMiss++;
      const flag = ok ? 'ok  ' : 'MISS';
      console.log(`[${flag}] ${c.id}: first-call=${firstCall} expected=[${c.expectedTools.join('|')}]`);
      if (!ok) failures.push(`${c.id}: got ${firstCall}, expected ${c.expectedTools.join('|')}`);
    } catch (e) {
      failures.push(`${c.id}: runner error ${(e as Error).message}`);
      console.error(`[ERR ] ${c.id}:`, (e as Error).message);
    }
  }

  const n = dataset.cases.length;
  console.log(`\n[tool-use eval] selection accuracy: ${hit}/${n} = ${(hit / n).toFixed(3)}`);
  console.log(`[tool-use eval] forbidden first-calls: ${forbiddenMiss}/${n}`);
  console.log(`[tool-use eval] elapsed: ${Date.now() - t0}ms`);
  if (failures.length > 0) {
    console.log('[tool-use eval] failures:\n  - ' + failures.join('\n  - '));
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('[tool-use eval] fatal:', e);
  process.exit(1);
});
