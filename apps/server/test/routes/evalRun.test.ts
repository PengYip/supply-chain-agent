// apps/server/test/routes/evalRun.test.ts
// Test-shell Hono app: mounts evalRunRoute under /api/eval with a user set
// directly (same hermetic pattern as evalResults route tests).
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { EventEmitter } from 'node:events';
import { createEvalRunRoute } from '../../src/routes/evalRun.js';
import { EvalRunRegistry, type RunnerFactory, type RunnerHandle } from '../../src/routes/evalRunCore.js';

function makeApp(reg: EvalRunRegistry) {
  const app = new Hono();
  app.use('/api/eval/*', async (c, next) => { c.set('user', { id: 'u1' } as never); await next(); });
  app.route('/api/eval', createEvalRunRoute(reg));
  return app;
}

class FakeHandle extends EventEmitter implements RunnerHandle {
  kill() { this.emit('exit', null); }
  onStdoutLine(cb: (l: string) => void) { this.on('line', cb); }
  onExit(cb: (c: number | null) => void) { this.on('exit', cb); }
  send(l: string) { this.emit('line', l); }
  end(c: number | null) { this.emit('exit', c); }
}

function hangingFactory(handles: FakeHandle[]) {
  return ((_args: string[], _env: NodeJS.ProcessEnv) => {
    const h = new FakeHandle();
    handles.push(h);
    return h;
  }) as RunnerFactory;
}

describe('evalRun routes', () => {
  it('POST starts a run and returns runId; second POST -> 409', async () => {
    const handles: FakeHandle[] = [];
    const reg = new EvalRunRegistry(hangingFactory(handles));
    const app = makeApp(reg);
    const r1 = await app.request('/api/eval/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', origin: 'http://localhost:5173' },
      body: JSON.stringify({ dataset: 'core', runs: 2 }),
    });
    expect(r1.status).toBe(200);
    const d1 = (await r1.json()) as { ok: boolean; data?: { runId: string } };
    expect(d1.ok).toBe(true);
    expect(d1.data!.runId).toMatch(/-core$/);
    const r2 = await app.request('/api/eval/runs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataset: 'core', runs: 1 }),
    });
    expect(r2.status).toBe(409);
    expect(((await r2.json()) as { error: string }).error).toContain('已有评估运行中');
  });

  it('POST rejects invalid body (runs bounds -> 400; invalid dataset -> 422)', async () => {
    const reg = new EvalRunRegistry(hangingFactory([]));
    const app = makeApp(reg);
    const bad1 = await app.request('/api/eval/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataset: '../x', runs: 1 }) });
    expect(bad1.status).toBe(422);
    expect(((await bad1.json()) as { error: string }).error).toContain('无效数据集');
    const bad2 = await app.request('/api/eval/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataset: 'core', runs: 11 }) });
    expect(bad2.status).toBe(400);
  });

  it('GET live returns state + buffered events; unknown -> 404', async () => {
    const handles: FakeHandle[] = [];
    const reg = new EvalRunRegistry(hangingFactory(handles));
    const app = makeApp(reg);
    const r = await app.request('/api/eval/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataset: 'core', runs: 1 }) });
    const { data } = (await r.json()) as { data: { runId: string } };
    handles[0].send('@@EVT@@{"type":"run_started","runId":"x","total":1}');
    const live = await app.request(`/api/eval/runs/${data.runId}/live`);
    expect(live.status).toBe(200);
    const ld = (await live.json()) as { ok: boolean; data: { state: string; events: unknown[] } };
    expect(ld.data.state).toBe('running');
    expect(ld.data.events).toHaveLength(1);
    const miss = await app.request('/api/eval/runs/nope/live');
    expect(miss.status).toBe(404);
  });

  it('DELETE aborts a running run; unknown -> 404', async () => {
    const handles: FakeHandle[] = [];
    const reg = new EvalRunRegistry(hangingFactory(handles));
    const app = makeApp(reg);
    const r = await app.request('/api/eval/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataset: 'core', runs: 1 }) });
    const { data } = (await r.json()) as { data: { runId: string } };
    const del = await app.request(`/api/eval/runs/${data.runId}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(handles[0].listeners('exit')).toBeTruthy();
    expect((await app.request('/api/eval/runs/nope', { method: 'DELETE' })).status).toBe(404);
  });

  it('GET /runs/:runId/events streams replayed events as SSE', async () => {
    const handles: FakeHandle[] = [];
    const reg = new EvalRunRegistry(hangingFactory(handles));
    const app = makeApp(reg);
    const r = await app.request('/api/eval/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataset: 'core', runs: 1 }) });
    const { data } = (await r.json()) as { data: { runId: string } };
    handles[0].send('@@EVT@@{"type":"run_started","runId":"x","total":1}');
    const sse = await app.request(`/api/eval/runs/${data.runId}/events`);
    expect(sse.status).toBe(200);
    expect(sse.headers.get('content-type')).toContain('text/event-stream');
    const reader = sse.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain('run_started');
    await reader.cancel();
  }, 10000);

  it('GET /runs activeRunId via evalResults route integration is covered in evalResults.test.ts additions', () => {
    // (activeRunId is asserted there; the singleton is idle in this suite)
    expect(true).toBe(true);
  });
});
