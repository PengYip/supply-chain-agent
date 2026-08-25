// apps/server/test/routes/evalResultsCore.test.ts
// Hermetic: tmp 目录 fixture, 不触网。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  parseRunId, parseEpisodesFile, loadTierMap, listRuns, toEpisodeView,
  type EpisodePair,
} from '../../src/routes/evalResultsCore.js';

const artifact = (scenarioId: string, runIndex: number) => ({
  scenarioId, runIndex, sessionId: 's1', startedAt: '2026-08-15T03:00:00.000Z',
  wallMs: 1000 * runIndex, turnsUsed: 3,
  transcript: [
    { role: 'user', text: '查一下订单' },
    { role: 'system-note', text: 'L3 ticket created' },
    { role: 'assistant', text: '已查到' },
  ],
  toolCalls: [{ toolName: 'query_orders', args: { no: 'ORD-2024-0881' }, result: { ok: true }, durationMs: 12 }],
  approvals: [{ id: 'p1', level: 'L3', toolName: 'escalate_to_human', input: {}, decision: 'approved', reason: '人工已复核', matchedRule: undefined }],
  finalAssistantText: '已查到', totalUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
});
const score = (scenarioId: string, runIndex: number, verdict: string, rubricScore: number | null) => ({
  scenarioId, runIndex, verdict,
  verifierFailures: verdict === 'fail' ? [{ check: 'keywordInReply', detail: '缺少关键词' }] : [],
  judge: { ok: true, dimensions: [{ name: '准确性', weight: 'essential', score: 3, rationale: 'ok' }], vetoTriggered: false, confidence: 0.9 },
  rubricScore, vetoTriggered: false, firstFailure: null,
});
const pair = (sid: string, ri: number, v = 'pass', rs: number | null = 3): EpisodePair =>
  ({ artifact: artifact(sid, ri) as EpisodePair['artifact'], score: score(sid, ri, v, rs) as EpisodePair['score'] });

describe('parseRunId', () => {
  it('解析 stamp 与 dataset', () => {
    const r = parseRunId('2026-08-15T03-21-07-123Z-core');
    expect(r.dataset).toBe('core');
    expect(r.startedAt).toBe('2026-08-15T03:21:07.123Z');
  });
  it('无法解析时 startedAt=null, dataset=整个串', () => {
    const r = parseRunId('manual-run');
    expect(r.startedAt).toBeNull();
    expect(r.dataset).toBe('manual-run');
  });
});

describe('parseEpisodesFile', () => {
  it('逐行解析 {artifact, score} 对', () => {
    const text = JSON.stringify(pair('a', 1)) + '\n' + JSON.stringify(pair('a', 2)) + '\n';
    expect(parseEpisodesFile(text).pairs).toHaveLength(2);
  });
  it('损坏行跳过并计数; 缺 artifact/score 核心字段的行也跳过', () => {
    const text = '{not json\n' + JSON.stringify({ artifact: {}, score: {} }) + '\n';
    const r = parseEpisodesFile(text);
    expect(r.pairs).toHaveLength(0);
    expect(r.droppedLines).toBe(2);
  });
});

describe('loadTierMap', () => {
  it('从 yaml 读 id→tier; 文件缺失返回空 map', () => {
    const dir = mkdtempSync(join(tmpdir(), 'evaltier-'));
    writeFileSync(join(dir, 'core.yaml'), 'scenarios:\n  - id: t1-order-status\n    tier: 1\n  - id: t3-pressure-claim\n    tier: 3\n', 'utf-8');
    const m = loadTierMap(dir, 'core');
    expect(m.get('t1-order-status')).toBe(1);
    expect(m.get('t3-pressure-claim')).toBe(3);
    expect(loadTierMap(dir, 'nope')).toEqual(new Map());
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('listRuns + toEpisodeView', () => {
  const root = mkdtempSync(join(tmpdir(), 'evalruns-'));
  const runA = join(root, '2026-08-15T03-00-00-000Z-core');
  const runB = join(root, '2026-08-14T09-00-00-000Z-core');
  const emptyDir = join(root, '2026-08-15T04-00-00-000Z-core');
  mkdirSync(runA); mkdirSync(runB); mkdirSync(emptyDir);
  writeFileSync(join(runA, 'episodes.jsonl'),
    [pair('t1-order-status', 1, 'fail', 2), pair('t1-order-status', 2, 'pass', 3), pair('t3-pressure-claim', 1, 'pass', 4)].map((p) => JSON.stringify(p)).join('\n') + '\n', 'utf-8');
  writeFileSync(join(runB, 'episodes.jsonl'), JSON.stringify(pair('t1-order-status', 1)) + '\n', 'utf-8');
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('时间倒序, 跳过无 episodes.jsonl 的目录, 聚合 verdict 分布与场景行', () => {
    const runs = listRuns(root);
    expect(runs.map((r) => r.runId)).toEqual([ '2026-08-15T03-00-00-000Z-core', '2026-08-14T09-00-00-000Z-core' ]);
    const a = runs[0];
    expect(a.episodeCount).toBe(3);
    expect(a.verdictDist).toEqual({ fail: 1, pass: 2 });
    expect(a.totalTokens).toBe(45);
    const row = a.scenarios.find((s) => s.scenarioId === 't1-order-status')!;
    expect(row.verdicts).toEqual(['fail', 'pass']);
    expect(row.passAt1).toBe(false);
    expect(row.passConsecutiveK).toBe(false); // k=2 (全局 max), fail 起始
    expect(row.avgRubricScore).toBe(2.5);
    expect(row.tier).toBeNull(); // datasets 目录不存在
  });

  it('toEpisodeView: 文本分段映射 system-note→system; 工具/审批独立数组透传', () => {
    const v = toEpisodeView(pair('t1-order-status', 1));
    expect(v.transcript).toEqual([
      { kind: 'text', role: 'user', content: '查一下订单' },
      { kind: 'text', role: 'system', content: 'L3 ticket created' },
      { kind: 'text', role: 'assistant', content: '已查到' },
    ]);
    expect(v.toolCalls).toHaveLength(1);
    expect(v.toolCalls[0].toolName).toBe('query_orders');
    expect(v.approvals[0].level).toBe('L3');
    expect(v.judgeDimensions[0].name).toBe('准确性');
  });
});
