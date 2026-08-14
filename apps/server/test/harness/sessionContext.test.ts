import { describe, it, expect, beforeEach } from 'vitest';
import {
  runSessionContext,
  getSessionCtx,
  getSessionId,
  setSessionContext,
  getSessionContext,
} from '../../src/harness/sessionContext.js';

describe('sessionContext AsyncLocalStorage (transition)', () => {
  beforeEach(() => {
    // 清旧单槽,避免跨用例污染
    setSessionContext(null);
  });

  it('getSessionCtx throws outside a run context', () => {
    expect(() => getSessionCtx()).toThrow(/not set/i);
  });

  it('getSessionId returns null when neither ALS nor legacy slot is set', () => {
    expect(getSessionId()).toBeNull();
  });

  it('runSessionContext sets ALS context for the call', () => {
    runSessionContext({ sessionId: 's1', role: 'trader' }, () => {
      expect(getSessionCtx().sessionId).toBe('s1');
      expect(getSessionId()).toBe('s1');
    });
  });

  it('getSessionId degrades to legacy slot when ALS unset', () => {
    setSessionContext('legacy-id');
    expect(getSessionId()).toBe('legacy-id');
    // 旧 API 仍可用
    expect(getSessionContext()).toBe('legacy-id');
  });

  it('ALS takes precedence over legacy slot', () => {
    setSessionContext('legacy');
    runSessionContext({ sessionId: 'als-id', role: 'trader' }, () => {
      expect(getSessionId()).toBe('als-id');
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
