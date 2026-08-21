import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listSessionEventsSince } from '../../src/harness/sessionStore.js';
import { emit, subscribe } from '../../src/harness/sessionEvents.js';

const uid = () => `ev-persist-${randomUUID().slice(0, 8)}`;

describe('emit write-through', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('persists every emit and delivers seq to subscribers', async () => {
    const sid = uid();
    const seen: Array<{ type: string; seq?: number }> = [];
    const unsub = subscribe(sid, (e) => seen.push({ type: e.type, seq: e.seq }));
    await emit({ type: 'run.started', sessionId: sid, runId: 'r1' });
    await emit({ type: 'message.part', sessionId: sid, part: { type: 'text-start', id: 't1' } });
    unsub();
    expect(seen.length).toBe(2);
    expect(seen[0].seq).toBe(1);
    expect(seen[1].seq).toBe(2);
    const rows = await listSessionEventsSince(sid, 0);
    expect(rows.map((r) => r.type)).toEqual(['run.started', 'message.part']);
    expect(rows[1].payload.part).toEqual({ type: 'text-start', id: 't1' });
  });

  it('persists even with zero subscribers (replay buffer must capture the gap)', async () => {
    const sid = uid();
    await emit({ type: 'run.started', sessionId: sid, runId: 'r2' });
    expect((await listSessionEventsSince(sid, 0)).length).toBe(1);
  });

  it('persistence failure degrades gracefully: subscriber still receives the event, without seq', async () => {
    // Patch the SAME module instance sessionEvents is bound to. (The brief's
    // vi.doMock form cannot work here: sessionEvents is statically imported at
    // the top, so its binding to the real appendSessionEvent is already cached;
    // a later doMock + dynamic re-import returns that cached instance.)
    const store = await import('../../src/harness/sessionStore.js');
    vi.spyOn(store, 'appendSessionEvent').mockImplementation(() => {
      throw new Error('table missing');
    });
    const sid = uid();
    const seen: Array<Record<string, unknown>> = [];
    const unsub = subscribe(sid, (e) => seen.push(e as Record<string, unknown>));
    await emit({ type: 'run.started', sessionId: sid, runId: 'r3' });
    unsub();
    expect(seen.length).toBe(1);
    expect(seen[0].seq).toBeUndefined();
  });
});
