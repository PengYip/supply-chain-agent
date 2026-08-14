import { describe, it, expect } from 'vitest';
import { emit, subscribe, subscriberCount } from '../../src/harness/sessionEvents.js';

describe('sessionEvents', () => {
  it('emit delivers to subscribers of that session', () => {
    const received: unknown[] = [];
    const unsub = subscribe('s1', (e) => received.push(e));
    emit({ type: 'run.started', sessionId: 's1', runId: 'r1' });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ type: 'run.started', runId: 'r1' });
    unsub();
  });

  it('emit does not deliver to other sessions', () => {
    const received: unknown[] = [];
    subscribe('s1', (e) => received.push(e));
    emit({ type: 'run.started', sessionId: 's2', runId: 'r2' });
    expect(received).toHaveLength(0);
  });

  it('unsubscribe stops delivery', () => {
    const received: unknown[] = [];
    const unsub = subscribe('s1', (e) => received.push(e));
    unsub();
    emit({ type: 'run.started', sessionId: 's1' });
    expect(received).toHaveLength(0);
  });

  it('multiple subscribers each receive', () => {
    let a = 0, b = 0;
    subscribe('s1', () => a++);
    subscribe('s1', () => b++);
    emit({ type: 'x', sessionId: 's1' });
    expect(a).toBe(1);
    expect(b).toBe(1);
  });

  it('subscriberCount reports active subscribers', () => {
    // Use a dedicated sessionId: the bus is module-global, and earlier tests
    // in this file intentionally leave subscribers on 's1' behind.
    expect(subscriberCount('s-count')).toBe(0);
    const u1 = subscribe('s-count', () => {});
    expect(subscriberCount('s-count')).toBe(1);
    const u2 = subscribe('s-count', () => {});
    expect(subscriberCount('s-count')).toBe(2);
    u1();
    expect(subscriberCount('s-count')).toBe(1);
    u2();
    expect(subscriberCount('s-count')).toBe(0);
  });
});
