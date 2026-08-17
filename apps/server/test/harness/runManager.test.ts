import { describe, it, expect } from 'vitest';
import { startSessionRun, abortSessionRun, isRunning } from '../../src/harness/runManager.js';
import { emit } from '../../src/harness/sessionEvents.js';
import { listSessionEventsSince } from '../../src/harness/sessionStore.js';

describe('runManager', () => {
  it('startSessionRun returns a runId and marks running', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const r = startSessionRun('rm-1', undefined, 'trader', async () => { await gate; });
    expect('runId' in r).toBe(true);
    expect(isRunning('rm-1')).toBe(true);
    release();
    await new Promise((r) => setTimeout(r, 10));
    expect(isRunning('rm-1')).toBe(false);
  });

  it('second startSessionRun on same session while busy returns conflict', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    startSessionRun('rm-2', undefined, 'trader', async () => { await gate; });
    const r2 = startSessionRun('rm-2', undefined, 'trader', async () => {});
    expect('conflict' in r2 && r2.conflict).toBe(true);
    release();
    await new Promise((r) => setTimeout(r, 10));
  });

  it('different sessions run concurrently', async () => {
    let releaseA!: () => void;
    let releaseB!: () => void;
    const ga = new Promise<void>((r) => (releaseA = r));
    const gb = new Promise<void>((r) => (releaseB = r));
    startSessionRun('rm-a', undefined, 'trader', async () => { await ga; });
    startSessionRun('rm-b', undefined, 'trader', async () => { await gb; });
    expect(isRunning('rm-a')).toBe(true);
    expect(isRunning('rm-b')).toBe(true);
    releaseA();
    releaseB();
    await new Promise((r) => setTimeout(r, 10));
  });

  it('abortSessionRun aborts the signal', async () => {
    let aborted = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const r = startSessionRun('rm-3', undefined, 'trader', async (signal) => {
      signal.addEventListener('abort', () => { aborted = true; });
      await gate;
    });
    expect('runId' in r).toBe(true);
    const ok = abortSessionRun('rm-3');
    expect(ok).toBe(true);
    expect(aborted).toBe(true);
    release();
    await new Promise((r) => setTimeout(r, 10));
  });

  it('abortSessionRun on idle session returns false', () => {
    expect(abortSessionRun('rm-nope')).toBe(false);
  });

  it('fn error does not leave session marked running', async () => {
    startSessionRun('rm-4', undefined, 'trader', async () => { throw new Error('boom'); });
    await new Promise((r) => setTimeout(r, 10));
    expect(isRunning('rm-4')).toBe(false);
  });

  it('prunes the session_events replay buffer when the run finalizes', async () => {
    const sid = `rm-prune-${crypto.randomUUID().slice(0, 8)}`;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const start = startSessionRun(sid, 'u1', 'trader', async () => {
      await gate;
    });
    expect(start).not.toHaveProperty('conflict');
    // events emitted while the run is in flight are buffered
    emit({ type: 'message.part', sessionId: sid, part: { type: 'text-start', id: 't' } });
    expect(listSessionEventsSince(sid, 0).length).toBeGreaterThan(0);
    release();
    await new Promise((r) => setTimeout(r, 10));
    expect(isRunning(sid)).toBe(false);
    expect(listSessionEventsSince(sid, 0)).toEqual([]);
  });
});
