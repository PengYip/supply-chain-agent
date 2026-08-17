import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  appendSessionEvent,
  listSessionEventsSince,
  pruneSessionEvents,
} from '../../src/harness/sessionStore.js';

const uid = () => `ev-store-${randomUUID().slice(0, 8)}`;

describe('session_events store', () => {
  it('assigns monotonically increasing seq starting at 1, per session', () => {
    const sid = uid();
    const s1 = appendSessionEvent(sid, 'run.started', { sessionId: sid, runId: 'r1' });
    const s2 = appendSessionEvent(sid, 'message.part', { sessionId: sid, part: { type: 'text-start' } });
    expect(s1).toBe(1);
    expect(s2).toBe(2);
  });

  it('independent sessions have independent seq counters', () => {
    const a = uid();
    const b = uid();
    appendSessionEvent(a, 'x', {});
    expect(appendSessionEvent(b, 'x', {})).toBe(1);
    expect(appendSessionEvent(a, 'x', {})).toBe(2);
  });

  it('listSessionEventsSince returns rows with seq > sinceSeq in ascending order', () => {
    const sid = uid();
    appendSessionEvent(sid, 'e1', { n: 1 });
    appendSessionEvent(sid, 'e2', { n: 2 });
    appendSessionEvent(sid, 'e3', { n: 3 });
    const rows = listSessionEventsSince(sid, 1);
    expect(rows.map((r) => r.type)).toEqual(['e2', 'e3']);
    expect(rows[0].payload).toEqual({ n: 2 });
  });

  it('listSessionEventsSince on empty/unknown session returns []', () => {
    expect(listSessionEventsSince(uid(), 0)).toEqual([]);
  });

  it('pruneSessionEvents clears all rows for the session only', () => {
    const a = uid();
    const b = uid();
    appendSessionEvent(a, 'e', {});
    appendSessionEvent(b, 'e', {});
    pruneSessionEvents(a);
    expect(listSessionEventsSince(a, 0)).toEqual([]);
    expect(listSessionEventsSince(b, 0).length).toBe(1);
  });
});
