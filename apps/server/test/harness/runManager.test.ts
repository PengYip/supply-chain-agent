import { describe, it, expect, vi } from 'vitest';
import { startSessionRun, abortSessionRun, isRunning } from '../../src/harness/runManager.js';
import { emit, subscribe } from '../../src/harness/sessionEvents.js';
import { listSessionEventsSince } from '../../src/harness/sessionStore.js';

describe('runManager', () => {
  it('startSessionRun returns a runId and marks running', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const r = await startSessionRun('rm-1', undefined, 'trader', async () => { await gate; });
    expect('runId' in r).toBe(true);
    expect(isRunning('rm-1')).toBe(true);
    release();
    await new Promise((r) => setTimeout(r, 10));
    expect(isRunning('rm-1')).toBe(false);
  });

  it('second startSessionRun on same session while busy returns conflict', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await startSessionRun('rm-2', undefined, 'trader', async () => { await gate; });
    const r2 = await startSessionRun('rm-2', undefined, 'trader', async () => {});
    expect('conflict' in r2 && r2.conflict).toBe(true);
    release();
    await new Promise((r) => setTimeout(r, 10));
  });

  it('different sessions run concurrently', async () => {
    let releaseA!: () => void;
    let releaseB!: () => void;
    const ga = new Promise<void>((r) => (releaseA = r));
    const gb = new Promise<void>((r) => (releaseB = r));
    void startSessionRun('rm-a', undefined, 'trader', async () => { await ga; });
    void startSessionRun('rm-b', undefined, 'trader', async () => { await gb; });
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
    const r = await startSessionRun('rm-3', undefined, 'trader', async (signal) => {
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
    void startSessionRun('rm-4', undefined, 'trader', async () => { throw new Error('boom'); }).catch(() => {});
    await new Promise((r) => setTimeout(r, 10));
    expect(isRunning('rm-4')).toBe(false);
  });

  it('prunes the session_events replay buffer when the run finalizes', async () => {
    const sid = `rm-prune-${crypto.randomUUID().slice(0, 8)}`;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const start = await startSessionRun(sid, 'u1', 'trader', async () => {
      await gate;
    });
    expect(start).not.toHaveProperty('conflict');
    // events emitted while the run is in flight are buffered
    await emit({ type: 'message.part', sessionId: sid, part: { type: 'text-start', id: 't' } });
    expect((await listSessionEventsSince(sid, 0)).length).toBeGreaterThan(0);
    release();
    await new Promise((r) => setTimeout(r, 10));
    expect(isRunning(sid)).toBe(false);
    expect(await listSessionEventsSince(sid, 0)).toEqual([]);
  });

  it('prune failure does not block slot release (single-flight stays un-bricked)', async () => {
    // Patch the SAME module instance runManager is bound to (proven pattern
    // from sessionEvents.persist.test.ts). spy.toHaveBeenCalled() self-validates
    // that interception actually happened.
    const store = await import('../../src/harness/sessionStore.js');
    const spy = vi.spyOn(store, 'pruneSessionEvents').mockImplementation(() => {
      throw new Error('db degraded');
    });
    try {
      const sid = `rm-prune-fail-${crypto.randomUUID().slice(0, 8)}`;
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const start = await startSessionRun(sid, 'u1', 'trader', async () => {
        await gate;
      });
      expect(start).not.toHaveProperty('conflict');
      release();
      await new Promise((r) => setTimeout(r, 10));
      // The prune threw on finalize, but the guard swallowed it: the slot
      // must still be released (not bricked into permanent conflict).
      expect(spy).toHaveBeenCalled();
      expect(isRunning(sid)).toBe(false);
      const again = startSessionRun(sid, 'u1', 'trader', async () => {});
      expect(again).not.toHaveProperty('conflict');
    } finally {
      spy.mockRestore();
    }
  });

  it('attaches provider_arrears code to run.error for DeepSeek-style 402 failures', async () => {
    const sid = `rm-arrears-${crypto.randomUUID().slice(0, 8)}`;
    const seen: Array<Record<string, unknown>> = [];
    const unsub = subscribe(sid, (e) => {
      if (e.type === 'run.error') seen.push(e as Record<string, unknown>);
    });
    const err = new Error('Insufficient Balance') as any;
    err.name = 'APICallError';
    err.statusCode = 402;
    void startSessionRun(sid, undefined, 'trader', async () => { throw err; }).catch(() => {});
    await new Promise((r) => setTimeout(r, 10));
    unsub();
    expect(seen.length).toBe(1);
    expect(seen[0]!.code).toBe('provider_arrears');
    expect(seen[0]!.userMessage).toBeUndefined();
    // 原始错误文本保留（排障用）
    expect(seen[0]!.message).toBe('Insufficient Balance');
  });

  it('generic failures keep run_failed code and no userMessage (backward compatible)', async () => {
    const sid = `rm-runfail-${crypto.randomUUID().slice(0, 8)}`;
    const seen: Array<Record<string, unknown>> = [];
    const unsub = subscribe(sid, (e) => {
      if (e.type === 'run.error') seen.push(e as Record<string, unknown>);
    });
    void startSessionRun(sid, undefined, 'trader', async () => { throw new Error('boom'); }).catch(() => {});
    await new Promise((r) => setTimeout(r, 10));
    unsub();
    expect(seen.length).toBe(1);
    expect(seen[0]!.code).toBe('run_failed');
    expect(seen[0]!.userMessage).toBeUndefined();
  });
});
