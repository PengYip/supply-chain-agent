import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import type { ModelMessage } from 'ai';
import { startSessionRun, isRunning } from '../../src/harness/runManager.js';
import { runSession } from '../../src/harness/runSession.js';
import { createSession, listSessionEventsSince } from '../../src/harness/sessionStore.js';
import { sessionsRoute } from '../../src/routes/sessions.js';
import type { AuthEnv, SessionUser } from '../../src/lib/auth-middleware.js';

// Outer Hono app + auth injection (same shape as sseReplay.test.ts).
function appAs(user: SessionUser | null): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('user', user);
    await next();
  });
  app.route('/api/sessions', sessionsRoute);
  return app;
}

// Parse the SSE body stream into frames (id line optional, heartbeats skipped).
async function* frames(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const idLine = frame.split('\n').find((l) => l.startsWith('id: '));
      const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
      if (!dataLine) continue; // heartbeat comment or keep-alive
      yield {
        id: idLine ? Number(idLine.slice(4)) : undefined,
        data: JSON.parse(dataLine.slice(6)),
      };
    }
  }
}

// Gated fake model: emits text-start, delta 'a', delta 'b' synchronously, then
// awaits the gate, then delta 'c', text-end, finish('stop').
function gatedModel(gate: Promise<void>) {
  const usage = () => ({ inputTokens: 1, outputTokens: 1, totalTokens: 2 });
  return {
    specificationVersion: 'v2' as const,
    provider: 'fake',
    modelId: 'fake-model',
    supportedUrls: {} as Record<string, RegExp[]>,
    async doGenerate() {
      throw new Error('gatedModel does not implement doGenerate');
    },
    async doStream() {
      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue({ type: 'text-start', id: 't1' });
          controller.enqueue({ type: 'text-delta', id: 't1', delta: 'a' });
          controller.enqueue({ type: 'text-delta', id: 't1', delta: 'b' });
          await gate;
          controller.enqueue({ type: 'text-delta', id: 't1', delta: 'c' });
          controller.enqueue({ type: 'text-end', id: 't1' });
          controller.enqueue({ type: 'finish', finishReason: 'stop', usage: usage() });
          controller.close();
        },
      });
      return { stream };
    },
  };
}

async function waitUntil(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('event replay integration (mid-run reconnect)', () => {
  it('a mid-run disconnect reconnects with Last-Event-ID and receives exactly the missed parts', async () => {
    const s = createSession('trader', 'u-er1');
    const userId = 'u-er1';
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fake = gatedModel(gate);

    // Connect FIRST so the SSE subscriber is registered before the run emits —
    // deterministic (the gated model emits 'a'/'b' synchronously once invoked;
    // connecting after startSessionRun could race the subscription and miss
    // them live, which would hang the read-until-'b' loop).
    const app = appAs({ id: userId, email: 'er1@test', role: 'trader' });
    const ac1 = new AbortController();
    const res1 = await app.request(
      new Request(`http://test/api/sessions/${s.id}/events`, { signal: ac1.signal }),
    );
    expect(res1.status).toBe(200);

    // Start the background run.
    const start = startSessionRun(s.id, userId, 'trader', (signal) =>
      runSession({
        sessionId: s.id,
        userId,
        role: 'trader',
        messages: [{ role: 'user', content: 'hi' } as ModelMessage],
        auditTraceId: 't-er1',
        abortSignal: signal,
        model: fake as any,
      }),
    );
    expect('runId' in start).toBe(true);
    expect(isRunning(s.id)).toBe(true);

    // Read frames on conn1 until the 'b' delta arrives; track its id (the
    // persisted seq carried in the SSE id line).
    const gen1 = frames(res1.body as ReadableStream<Uint8Array>);
    let lastSeen: number | undefined;
    while (lastSeen === undefined) {
      const { done, value } = await gen1.next();
      if (done) throw new Error('conn1 stream closed before delta b');
      const d = value.data as { type?: string; part?: { type?: string; delta?: string } };
      if (d.type === 'message.part' && d.part?.type === 'text-delta' && d.part.delta === 'b') {
        lastSeen = value.id;
      }
    }
    expect(lastSeen).toBeGreaterThan(0);

    // Disconnect conn1 (client mid-run disconnect). The run keeps going; the
    // gate is still closed so no parts are emitted during the gap.
    ac1.abort();
    await new Promise((r) => setTimeout(r, 20));

    // Reconnect with Last-Event-ID = lastSeen. The run is still in flight
    // (gate closed) — replay serves nothing missed, then continues live with
    // ids continuing from lastSeen (no duplicates of 'a'/'b').
    const ac2 = new AbortController();
    const res2 = await app.request(
      new Request(`http://test/api/sessions/${s.id}/events`, {
        signal: ac2.signal,
        headers: { 'Last-Event-ID': String(lastSeen) },
      }),
    );
    expect(res2.status).toBe(200);

    const gen2 = frames(res2.body as ReadableStream<Uint8Array>);

    // Snapshot: run still in flight -> busy, no id line.
    const snap = (await gen2.next()).value;
    expect(snap.id).toBeUndefined();
    expect((snap.data as { type?: string }).type).toBe('session.status');
    expect((snap.data as { status?: string }).status).toBe('busy');

    // Release the gate: 'c' then text-end arrive (live, ids continue from
    // lastSeen+1). No duplicate 'a'/'b' (a gap/dup would shift the id).
    release();
    const cFrame = (await gen2.next()).value;
    expect(cFrame.id).toBe(lastSeen! + 1);
    expect((cFrame.data as { type?: string }).type).toBe('message.part');
    expect((cFrame.data as { part?: { delta?: string } }).part?.delta).toBe('c');
    const endFrame = (await gen2.next()).value;
    expect(endFrame.id).toBe(lastSeen! + 2);
    expect((endFrame.data as { part?: { type?: string } }).part?.type).toBe('text-end');

    ac2.abort();

    // Run finalizes -> prune runs end-to-end (buffer empty again).
    await waitUntil(() => !isRunning(s.id));
    expect(listSessionEventsSince(s.id, 0)).toEqual([]);
  });
});
