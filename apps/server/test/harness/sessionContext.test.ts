import { describe, it, expect } from 'vitest';
import {
  runSessionContext,
  getSessionCtx,
  getSessionId,
} from '../../src/harness/sessionContext.js';

// ALS-only session context. Every run (chat POST and approval-callback
// resume alike) is started through RunManager.startSessionRun, which wraps
// the run body in runSessionContext, so tool executes always resolve their
// session through the ALS store.
describe('sessionContext AsyncLocalStorage', () => {
  it('getSessionCtx throws outside a run context', () => {
    expect(() => getSessionCtx()).toThrow(/not set/i);
  });

  it('getSessionId returns null outside a run context', () => {
    expect(getSessionId()).toBeNull();
  });

  it('runSessionContext sets ALS context for the call', () => {
    runSessionContext({ sessionId: 's1', role: 'trader' }, () => {
      expect(getSessionCtx().sessionId).toBe('s1');
      expect(getSessionId()).toBe('s1');
    });
  });

  it('context isolates across nested async runs', async () => {
    await runSessionContext({ sessionId: 'outer', role: 'trader' }, async () => {
      expect(getSessionId()).toBe('outer');
      await runSessionContext({ sessionId: 'inner', role: 'trader' }, async () => {
        expect(getSessionId()).toBe('inner');
      });
      expect(getSessionId()).toBe('outer');
    });
  });

  it('context does not leak across concurrent async chains', async () => {
    const out: string[] = [];
    await Promise.all([
      runSessionContext({ sessionId: 'a', role: 'trader' }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        out.push(getSessionId() ?? 'none');
      }),
      runSessionContext({ sessionId: 'b', role: 'trader' }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        out.push(getSessionId() ?? 'none');
      }),
    ]);
    expect(out.sort()).toEqual(['a', 'b']);
  });
});
