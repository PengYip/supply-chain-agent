import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { sessionsRoute } from '../../src/routes/sessions.js';
import type { AuthEnv, SessionUser } from '../../src/lib/auth-middleware.js';
import { createSession } from '../../src/harness/sessionStore.js';
import { emit } from '../../src/harness/sessionEvents.js';

// Outer Hono app + auth injection (same shape as sseEvents.test.ts).
function appAs(user: SessionUser | null): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('user', user);
    await next();
  });
  app.route('/api/sessions', sessionsRoute);
  return app;
}

// Parse the SSE body stream into frames, handling optional `id:` lines and
// skipping heartbeat comments. Yields { id?: number, data: unknown } per frame.
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

/** Read exactly n frames, then abort (closing the stream + triggering cleanup). */
async function readNFrames(
  body: ReadableStream<Uint8Array>,
  n: number,
  ac: AbortController,
): Promise<Array<{ id?: number; data: unknown }>> {
  const out: Array<{ id?: number; data: unknown }> = [];
  const gen = frames(body);
  for (let i = 0; i < n; i++) {
    const { done, value } = await gen.next();
    if (done) break;
    out.push(value);
  }
  ac.abort();
  return out;
}

describe('GET /api/sessions/:id/events SSE replay (Last-Event-ID)', () => {
  it('forwards live events with id lines once persistence assigns seq', async () => {
    const s = await createSession('trader', 'sse-r1');
    const app = appAs({ id: 'sse-r1', email: 'r1@test', role: 'trader' });
    const ac = new AbortController();
    const res = await app.request(
      new Request(`http://test/api/sessions/${s.id}/events`, { signal: ac.signal }),
    );
    expect(res.status).toBe(200);

    await emit({ type: 'run.started', sessionId: s.id, runId: 'r1' });
    await emit({ type: 'message.part', sessionId: s.id, part: { type: 'text-start' } });

    const got = await readNFrames(res.body as ReadableStream<Uint8Array>, 3, ac);
    expect(got.length).toBe(3);
    // First frame: status snapshot, NO id line.
    expect(got[0].id).toBeUndefined();
    expect((got[0].data as { type?: string }).type).toBe('session.status');
    // Live events carry their persisted seq as the SSE id.
    expect(got[1].id).toBe(1);
    expect((got[1].data as { type?: string }).type).toBe('run.started');
    expect(got[2].id).toBe(2);
    expect((got[2].data as { type?: string }).type).toBe('message.part');
  });

  it('replays missed events on Last-Event-ID, in order, with id lines', async () => {
    const s = await createSession('trader', 'sse-r2');
    // Seed 4 events BEFORE connecting (seqs 1-4, no subscriber).
    await emit({ type: 'run.started', sessionId: s.id, runId: 'r' });
    await emit({ type: 'message.part', sessionId: s.id, part: { type: 'text-start', id: 'a' } });
    await emit({ type: 'message.part', sessionId: s.id, part: { type: 'text-delta', id: 'a', delta: 'h' } });
    await emit({ type: 'message.part', sessionId: s.id, part: { type: 'text-end', id: 'a' } });

    const app = appAs({ id: 'sse-r2', email: 'r2@test', role: 'trader' });
    const ac = new AbortController();
    const res = await app.request(
      new Request(`http://test/api/sessions/${s.id}/events`, {
        signal: ac.signal,
        headers: { 'Last-Event-ID': '2' },
      }),
    );
    expect(res.status).toBe(200);

    // Snapshot (no id) + exactly events 3 and 4.
    const got = await readNFrames(res.body as ReadableStream<Uint8Array>, 3, ac);
    expect(got.length).toBe(3);
    expect(got[0].id).toBeUndefined();
    expect((got[0].data as { type?: string }).type).toBe('session.status');
    expect(got[1].id).toBe(3);
    expect((got[1].data as { type?: string }).type).toBe('message.part');
    expect(got[2].id).toBe(4);
  });

  it('treats an invalid Last-Event-ID as absent (no replay, live only)', async () => {
    const s = await createSession('trader', 'sse-r3');
    // Seed events that MUST NOT be replayed (invalid header => absent).
    await emit({ type: 'run.started', sessionId: s.id, runId: 'r' });
    await emit({ type: 'message.part', sessionId: s.id, part: { type: 'text-start' } });

    const app = appAs({ id: 'sse-r3', email: 'r3@test', role: 'trader' });
    const ac = new AbortController();
    const res = await app.request(
      new Request(`http://test/api/sessions/${s.id}/events`, {
        signal: ac.signal,
        headers: { 'Last-Event-ID': 'abc' },
      }),
    );
    expect(res.status).toBe(200);

    // Only the snapshot (no id) + a fresh live event (its seq is 3, not a
    // replay of 1-2).
    emit({ type: 'run.finished', sessionId: s.id, runId: 'r' });
    const got = await readNFrames(res.body as ReadableStream<Uint8Array>, 2, ac);
    expect(got.length).toBe(2);
    expect(got[0].id).toBeUndefined();
    expect((got[0].data as { type?: string }).type).toBe('session.status');
    expect(got[1].id).toBe(3);
    expect((got[1].data as { type?: string }).type).toBe('run.finished');
  });

  it('returns an empty replay for a stale larger Last-Event-ID', async () => {
    const s = await createSession('trader', 'sse-r4');
    await emit({ type: 'run.started', sessionId: s.id, runId: 'r' });
    await emit({ type: 'message.part', sessionId: s.id, part: { type: 'text-start' } });

    const app = appAs({ id: 'sse-r4', email: 'r4@test', role: 'trader' });
    const ac = new AbortController();
    const res = await app.request(
      new Request(`http://test/api/sessions/${s.id}/events`, {
        signal: ac.signal,
        headers: { 'Last-Event-ID': '999' },
      }),
    );
    expect(res.status).toBe(200);

    // Snapshot only; nothing replayed (seqs 1-2 <= 999). No live emit follows.
    const gen = frames(res.body as ReadableStream<Uint8Array>);
    const first = await gen.next();
    expect(first.done).toBe(false);
    expect(first.value.id).toBeUndefined();
    expect((first.value.data as { type?: string }).type).toBe('session.status');
    // Abort (client disconnect -> cleanup closes the stream), then confirm no
    // further frames arrive.
    ac.abort();
    await new Promise((r) => setTimeout(r, 30));
    const next = await gen.next();
    expect(next.done).toBe(true);
  });
});
