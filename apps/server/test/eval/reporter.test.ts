import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeResults, buildReport, passAtK, passConsecutiveK } from '../../eval/agent/reporter.js';
import type { EpisodeArtifact, EpisodeScore, Scenario, Verdict } from '../../eval/agent/types.js';
import { loadByFileUrl } from '../../eval/agent/datasets.js';

const out = join(tmpdir(), `eval-report-test-${Date.now()}`);

function artifact(i: number): EpisodeArtifact {
  return {
    scenarioId: 't1-order-status', runIndex: i, sessionId: `s-${i}`, startedAt: '', wallMs: 100,
    turnsUsed: 2, transcript: [{ role: 'user', text: 'q' }, { role: 'assistant', text: 'a' }],
    toolCalls: [], approvals: [], envSnapshot: { contractLinked: {} },
    finalAssistantText: 'a', totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  };
}
function score(i: number, verdict: Verdict): EpisodeScore {
  return { scenarioId: 't1-order-status', runIndex: i, verdict, verifierFailures: [], judge: null, rubricScore: verdict === 'pass' ? 3.5 : null, vetoTriggered: false, firstFailure: null };
}

beforeAll(() => mkdirSync(out, { recursive: true }));
afterAll(() => rmSync(out, { recursive: true, force: true }));

describe('pass metrics', () => {
  it('passAtK: true iff at least one pass in k runs', () => {
    expect(passAtK([score(1, 'fail'), score(2, 'pass'), score(3, 'fail')], 3)).toBe(true);
    expect(passAtK([score(1, 'fail'), score(2, 'fail')], 2)).toBe(false);
  });
  it('passConsecutiveK: true iff ALL k runs pass (book Pass^k)', () => {
    expect(passConsecutiveK([score(1, 'pass'), score(2, 'pass')], 2)).toBe(true);
    expect(passConsecutiveK([score(1, 'pass'), score(2, 'fail')], 2)).toBe(false);
    expect(passConsecutiveK([score(1, 'fail'), score(2, 'pass'), score(3, 'pass')], 3)).toBe(false);
  });
});

describe('writeResults', () => {
  it('writes episodes.jsonl (one line per episode) and report.md', () => {
    const scenarios = [loadByFileUrl(new URL('../../eval/agent/datasets/core.yaml', import.meta.url).href)[0]!];
    const { episodesPath, reportPath } = writeResults(out, [artifact(1)], [score(1, 'pass')]);
    expect(existsSync(episodesPath)).toBe(true);
    expect(existsSync(reportPath)).toBe(true);
    const lines = readFileSync(episodesPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).artifact.scenarioId).toBe('t1-order-status');
    const md = readFileSync(reportPath, 'utf-8');
    expect(md).toContain('t1-order-status');
    expect(md).toContain('Pass@');
    expect(md).toContain('Pass^');
  });
  it('buildReport includes failure clustering and veto stats', () => {
    const scenarios: Scenario[] = [];
    const md = buildReport(scenarios, [artifact(1)], [score(1, 'fail')]);
    expect(md).toContain('fail');
  });
});
