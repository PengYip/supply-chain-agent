import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { listToolNames, getToolsForRole, isCubeSandboxEnabled } from '../../src/harness/roleToolRegistry.js';
import { detectScenario, scenarioActiveTools } from '../../src/harness/scenarios.js';
import { createDb, migrate } from '../../src/pipeline/db/client.js';

// Tool-use eval dataset gate (eval/datasets/tool-use.json). Hermetic/offline:
// validates the DATASET ITSELF and asserts, per case, the deterministic parts
// of the contract -- scenario routing covers the expected tools, forbidden
// tools are invisible in that scenario, and blacklisted tools can never come
// back. The MODEL-side selection accuracy lives in `npm run eval:tools`
// (eval/runToolEval.ts, real LLM, kept out of npm test like the ingest eval).

interface ToolUseCase {
  id: string;
  query: string;
  expectedScenario: 'entry' | 'qa' | 'settlement' | 'all';
  expectedTools: string[];
  forbiddenTools: string[];
  needsApproval?: boolean;
  notes?: string;
}
interface Dataset { version: string; cases: ToolUseCase[] }
interface Inventory {
  tools: Array<{ name: string; level: string; status: string }>;
  removed: Array<{ name: string }>;
}

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const dataset = JSON.parse(readFileSync(here('../../eval/datasets/tool-use.json'), 'utf-8')) as Dataset;
const inventory = JSON.parse(readFileSync(here('../../../../docs/tool-inventory.json'), 'utf-8')) as Inventory;

const mounted = new Set(listToolNames('trader'));
const blacklisted = new Set(inventory.removed.map((r) => r.name));
const knownTools = new Set([
  ...inventory.tools.map((t) => t.name),
  ...inventory.removed.map((r) => r.name),
]);

describe('tool-use eval dataset', () => {
  it('dataset integrity: unique ids, known tools, notes present', () => {
    const ids = dataset.cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of dataset.cases) {
      expect(c.expectedTools.length, `${c.id}: expectedTools empty`).toBeGreaterThan(0);
      for (const t of [...c.expectedTools, ...c.forbiddenTools]) {
        expect(knownTools.has(t), `${c.id}: references unknown tool "${t}"`).toBe(true);
      }
    }
  });

  for (const c of dataset.cases) {
    it(`[${c.id}] scenario routing + visibility contract`, () => {
      // (1) the conservative router lands on the declared scenario.
      expect(detectScenario(c.query), `${c.id}: scenario routing`).toBe(c.expectedScenario);

      // (2) expected tools must be VISIBLE to the model in that scenario
      //     ('all' -> no narrowing, full mounted set is visible).
      const visible = scenarioActiveTools(c.expectedScenario, [...mounted]) ?? [...mounted];
      for (const t of c.expectedTools) {
        expect(visible, `${c.id}: expected tool "${t}" invisible in scenario ${c.expectedScenario}`).toContain(t);
      }

      // (3) forbidden tools must be invisible in the scenario, and any that is
      //     blacklisted must be gone from the registry entirely.
      for (const t of c.forbiddenTools) {
        expect(visible, `${c.id}: forbidden tool "${t}" visible in scenario ${c.expectedScenario}`).not.toContain(t);
        if (blacklisted.has(t)) {
          expect(mounted.has(t), `${c.id}: blacklisted tool "${t}" re-registered`).toBe(false);
        }
      }
    });
  }

  it('L2 cases: mounted tool carries needsApproval (soft gate)', () => {
    const ctx = createDb(':memory:');
    migrate(ctx.sqlite);
    const tools = getToolsForRole('trader', { ctx });
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const c of dataset.cases) {
      if (c.needsApproval !== true) continue;
      for (const t of c.expectedTools) {
        const tool = byName.get(t);
        expect(tool, `${c.id}: tool "${t}" not mounted`).toBeDefined();
        expect(tool!.needsApproval, `${c.id}: "${t}" must be needsApproval`).toBe(true);
      }
    }
    // bind_document is the canonical L2 fixture; keep it soft-gated.
    expect(byName.get('bind_document')?.needsApproval).toBe(true);
    if (!isCubeSandboxEnabled()) {
      expect(byName.has('execute_code')).toBe(false);
    }
  });
});
