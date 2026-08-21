import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  appendSessionEvent,
  listSessionEventsSince,
  pruneSessionEvents,
} from '../../src/harness/sessionStore.js';

const uid = () => `ev-store-${randomUUID().slice(0, 8)}`;

describe('session_events store', () => {
  it('assigns monotonically increasing seq starting at 1, per session', async () => {
    const sid = uid();
    const s1 = await appendSessionEvent(sid, 'run.started', { sessionId: sid, runId: 'r1' });
    const s2 = await appendSessionEvent(sid, 'message.part', { sessionId: sid, part: { type: 'text-start' } });
    expect(s1).toBe(1);
    expect(s2).toBe(2);
  });

  it('independent sessions have independent seq counters', async () => {
    const a = uid();
    const b = uid();
    await appendSessionEvent(a, 'x', {});
    expect(await appendSessionEvent(b, 'x', {})).toBe(1);
    expect(await appendSessionEvent(a, 'x', {})).toBe(2);
  });

  it('listSessionEventsSince returns rows with seq > sinceSeq in ascending order', async () => {
    const sid = uid();
    await appendSessionEvent(sid, 'e1', { n: 1 });
    await appendSessionEvent(sid, 'e2', { n: 2 });
    await appendSessionEvent(sid, 'e3', { n: 3 });
    const rows = await listSessionEventsSince(sid, 1);
    expect(rows.map((r) => r.type)).toEqual(['e2', 'e3']);
    expect(rows[0].payload).toEqual({ n: 2 });
  });

  it('listSessionEventsSince on empty/unknown session returns []', async () => {
    expect(await listSessionEventsSince(uid(), 0)).toEqual([]);
  });

  it('pruneSessionEvents clears all rows for the session only', async () => {
    const a = uid();
    const b = uid();
    await appendSessionEvent(a, 'e', {});
    await appendSessionEvent(b, 'e', {});
    await pruneSessionEvents(a);
    expect(await listSessionEventsSince(a, 0)).toEqual([]);
    expect((await listSessionEventsSince(b, 0)).length).toBe(1);
  });
});
