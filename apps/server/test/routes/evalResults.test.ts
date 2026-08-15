// apps/server/test/routes/evalResults.test.ts
// Hermetic: 工厂注入 tmp results 根; 测试壳直接 set user 绕过 Better Auth。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { AuthEnv } from '../../src/lib/auth-middleware.js';
import { createEvalResultsRoute } from '../../src/routes/evalResults.js';
import type { EpisodePair } from '../../src/routes/evalResultsCore.js';

const pairLine = (sid: string, ri: number, verdict: string) => JSON.stringify({
  artifact: {
    scenarioId: sid, runIndex: ri, sessionId: 's', startedAt: '2026-08-15T00:00:00.000Z',
    wallMs: 100, turnsUsed: 2, transcript: [{ role: 'user', text: 'hi' }],
    toolCalls: [], approvals: [], envSnapshot: {}, finalAssistantText: 'ok',
    totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  },
  score: {
    scenarioId: sid, runIndex: ri, verdict, verifierFailures: [], judge: null,
    rubricScore: null, vetoTriggered: false, firstFailure: null,
  },
} satisfies EpisodePair);

function appWith(root: string, authed = true) {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => { if (authed) c.set('user', { id: 't', email: 't@t.test' }); await next(); });
  app.route('/api/eval', createEvalResultsRoute(root));
  return app;
}

describe('evalResults routes', () => {
  const root = mkdtempSync(join(tmpdir(), 'evalroute-'));
  const runDir = join(root, '2026-08-15T03-00-00-000Z-core');
  mkdirSync(runDir);
  writeFileSync(join(runDir, 'episodes.jsonl'), pairLine('t1-order-status', 1, 'pass') + '\n{broken\n', 'utf-8');
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('GET /runs 返回聚合与信封', async () => {
    const res = await appWith(root).request('/api/eval/runs');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.runs).toHaveLength(1);
    expect(body.data.runs[0].runId).toBe('2026-08-15T03-00-00-000Z-core');
    expect(body.data.runs[0].verdictDist).toEqual({ pass: 1 });
  });

  it('GET /runs/:runId/episodes 返回视图与 droppedLines', async () => {
    const res = await appWith(root).request('/api/eval/runs/2026-08-15T03-00-00-000Z-core/episodes');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.episodes).toHaveLength(1);
    expect(body.data.episodes[0].transcript[0]).toEqual({ kind: 'text', role: 'user', content: 'hi' });
    expect(body.data.droppedLines).toBe(1);
  });

  it('未知 runId 404', async () => {
    const res = await appWith(root).request('/api/eval/runs/nope/episodes');
    expect(res.status).toBe(404);
    expect((await res.json()).ok).toBe(false);
  });

  it('拒绝含 .. 的 runId (目录穿越形状) 即使目录真实存在', async () => {
    const traversalDir = join(root, '2026-08-15T03-00-00-000Z-co..re');
    mkdirSync(traversalDir);
    writeFileSync(join(traversalDir, 'episodes.jsonl'), pairLine('t1-order-status', 1, 'pass') + '\n', 'utf-8');
    const res = await appWith(root).request('/api/eval/runs/2026-08-15T03-00-00-000Z-co..re/episodes');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: 'run 不存在' });
  });

  it('空 results 根返回空列表而非报错', async () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), 'evalempty-'));
    try {
      const res = await appWith(emptyRoot).request('/api/eval/runs');
      expect(res.status).toBe(200);
      expect((await res.json()).data.runs).toEqual([]);
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });
});
