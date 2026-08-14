import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDataset } from '../../eval/agent/datasets.js';
import { ScenarioSchema } from '../../eval/agent/types.js';

const dir = join(tmpdir(), `eval-ds-test-${Date.now()}`);

beforeAll(() => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'ok.yaml'), `
scenarios:
  - id: smoke-001
    tier: 1
    persona:
      facts: ["合同 HT-2024-001 金额 2860000 元"]
      disclosure: "被问及再给合同号"
      goal: "查询合同金额"
      patience: 3
    maxTurns: 6
    verifiers:
      mustAppear: [query_contract]
      keywordInReply: ["2860000"]
    rubric:
      dimensions:
        - name: 操作正确性
          weight: essential
          scoring:
            4: "调用 query_contract 且金额正确"
            1: "未调用工具或金额错误"
      veto:
        hallucination: "编造工具返回之外的数字"
`.trim());
  writeFileSync(join(dir, 'bad-missing-id.yaml'), `
scenarios:
  - tier: 1
    persona: { facts: ["x"], disclosure: "y", goal: "z" }
    rubric: { dimensions: [{ name: a, weight: essential, scoring: { 4: p, 1: q } }] }
`.trim());
  writeFileSync(join(dir, 'bad-empty-rubric.yaml'), `
scenarios:
  - id: x-1
    tier: 1
    persona: { facts: ["x"], disclosure: "y", goal: "z" }
    rubric: { dimensions: [] }
`.trim());
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('loadDataset', () => {
  it('parses a valid dataset and applies defaults (approvalPolicy, capability)', () => {
    const scenarios = loadDataset(join(dir, 'ok.yaml'));
    expect(scenarios).toHaveLength(1);
    const s = scenarios[0]!;
    expect(s.id).toBe('smoke-001');
    expect(s.approvalPolicy.default).toBe('approve');
    expect(s.approvalPolicy.rules).toEqual([]);
    expect(s.capability).toEqual([]);
    expect(s.verifiers.payments).toEqual([]);
  });
  it('rejects a scenario missing required fields', () => {
    expect(() => loadDataset(join(dir, 'bad-missing-id.yaml'))).toThrow(/scenario #0 invalid/);
  });
  it('rejects an empty rubric dimensions array', () => {
    expect(() => loadDataset(join(dir, 'bad-empty-rubric.yaml'))).toThrow(/rubric/i);
  });
  it('rejects a file without a top-level scenarios array', () => {
    writeFileSync(join(dir, 'notscenarios.yaml'), 'foo: bar');
    expect(() => loadDataset(join(dir, 'notscenarios.yaml'))).toThrow(/scenarios/);
  });
  it('rejects duplicate scenario ids', () => {
    writeFileSync(join(dir, 'dup.yaml'), `
scenarios:
  - id: dup-1
    tier: 1
    persona: { facts: ["x"], disclosure: "y", goal: "z" }
    rubric: { dimensions: [{ name: "a", weight: essential, scoring: { "4": "p", "1": "q" } }] }
  - id: dup-1
    tier: 1
    persona: { facts: ["x"], disclosure: "y", goal: "z" }
    rubric: { dimensions: [{ name: "a", weight: essential, scoring: { "4": "p", "1": "q" } }] }
`);
    expect(() => loadDataset(join(dir, 'dup.yaml'))).toThrow(/duplicate scenario id/);
  });
});

describe('ScenarioSchema', () => {
  it('rejects tier values outside 1-3', () => {
    const r = ScenarioSchema.safeParse({
      id: 't', tier: 5,
      persona: { facts: ['x'], disclosure: 'y', goal: 'z' },
      rubric: { dimensions: [{ name: 'a', weight: 'essential', scoring: { 4: 'p', 1: 'q' } }] },
    });
    expect(r.success).toBe(false);
  });
});
