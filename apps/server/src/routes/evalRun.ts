// apps/server/src/routes/evalRun.ts
// Server-triggered eval runs: spawn + single-lock + SSE live stream.
// POST /runs, GET /runs/:runId/live, GET /runs/:runId/events (SSE),
// DELETE /runs/:runId. requireAuth-gated by the /api/eval/* middleware group
// in index.ts (same group as the Phase 1 results routes).

import { Hono } from 'hono';
import type { AuthEnv } from '../lib/auth-middleware.js';
import { evalRunRegistry, type EvalRunRegistry } from './evalRunCore.js';

export function createEvalRunRoute(reg: EvalRunRegistry = evalRunRegistry) {
  const route = new Hono<AuthEnv>();

  route.post('/runs', async (c) => {
    const user = c.get('user');
    if (!user) return c.json({ ok: false, error: 'unauthorized' }, 401);
    const body = await c.req.json().catch(() => null) as { dataset?: unknown; runs?: unknown; filter?: unknown } | null;
    const dataset = typeof body?.dataset === 'string' ? body.dataset : '';
    const runs = Number(body?.runs ?? 1);
    const filter = typeof body?.filter === 'string' && body.filter ? body.filter : undefined;
    if (!Number.isInteger(runs) || runs < 1 || runs > 10) return c.json({ ok: false, error: 'runs 需为 1-10' }, 400);
    // Dataset identifier validation is delegated to evalRunCore's contract
    // ('core' | 'user/<name>'): an invalid identifier makes start() throw
    // 「无效数据集」, mapped to 422 here (T3.5 dataset-arg adjudication).
    let res;
    try {
      res = reg.start({ dataset, runs, filter });
    } catch (e) {
      return c.json({ ok: false, error: e instanceof Error ? e.message : '无效数据集' }, 422);
    }
    if (!res.ok) return c.json({ ok: false, error: '已有评估运行中' }, 409);
    return c.json({ ok: true, data: { runId: res.runId } });
  });

  route.get('/runs/:runId/live', (c) => {
    const user = c.get('user');
    if (!user) return c.json({ ok: false, error: 'unauthorized' }, 401);
    const st = reg.get(c.req.param('runId'));
    if (!st) return c.json({ ok: false, error: 'run 不存在' }, 404);
    return c.json({ ok: true, data: { runId: st.runId, state: st.state, events: st.events, error: st.error ?? null } });
  });

  // SSE: replay buffer, then live fan-out (pattern: routes/sessions.ts /:id/events).
  route.get('/runs/:runId/events', (c) => {
    const user = c.get('user');
    if (!user) return c.json({ ok: false, error: 'unauthorized' }, 401);
    const st = reg.get(c.req.param('runId'));
    if (!st) return c.json({ ok: false, error: 'run 不存在' }, 404);

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const send = (obj: unknown) =>
      writer.write(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`)).catch(() => {});

    for (const e of st.events) void send(e);
    const unsub = reg.subscribe(st.runId, (e) => void send(e));
    const heartbeat = setInterval(() => {
      void writer.write(encoder.encode(`: heartbeat\n\n`)).catch(() => {});
    }, 10000);
    const cleanup = () => {
      unsub();
      clearInterval(heartbeat);
      void writer.close().catch(() => {});
    };
    c.req.raw.signal?.addEventListener('abort', cleanup);

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
    });
  });

  route.delete('/runs/:runId', (c) => {
    const user = c.get('user');
    if (!user) return c.json({ ok: false, error: 'unauthorized' }, 401);
    const ok = reg.kill(c.req.param('runId'));
    if (!ok) return c.json({ ok: false, error: 'run 不存在或已结束' }, 404);
    return c.json({ ok: true, data: { aborted: true } });
  });

  return route;
}

export const evalRunRoute = createEvalRunRoute();
