import { describe, it, expect, beforeEach } from 'vitest';
import {
  createSession,
  setSessionStatus,
  getSessionStatus,
  listSessionsForUser,
  resetBusyOnStartup,
} from '../../src/harness/sessionStore.js';

describe('session status', () => {
  beforeEach(() => {
    // resetBusyOnStartup is global; ensure no busy sessions leak across cases.
    // (It only touches 'busy' rows, so idle/interrupted are unaffected.)
  });

  it('new session defaults to idle', () => {
    const s = createSession('trader', 'u1');
    expect(getSessionStatus(s.id)?.status).toBe('idle');
  });

  it('setSessionStatus busy records runId and startedAt', () => {
    const s = createSession('trader', 'u1');
    setSessionStatus(s.id, 'busy', 'run-123');
    const st = getSessionStatus(s.id);
    expect(st?.status).toBe('busy');
    expect(st?.runId).toBe('run-123');
    expect(st?.startedAt).toBeTruthy();
  });

  it('setSessionStatus back to idle clears runId', () => {
    const s = createSession('trader', 'u1');
    setSessionStatus(s.id, 'busy', 'run-1');
    setSessionStatus(s.id, 'idle');
    const st = getSessionStatus(s.id);
    expect(st?.status).toBe('idle');
    expect(st?.runId).toBeUndefined();
  });

  it('listSessionsForUser includes status', () => {
    const s = createSession('trader', 'u2');
    setSessionStatus(s.id, 'busy', 'run-9');
    const rows = listSessionsForUser('u2');
    const row = rows.find((r) => r.id === s.id);
    expect(row?.status).toBe('busy');
  });

  it('resetBusyOnStartup turns busy into interrupted', () => {
    const s = createSession('trader', 'u3');
    setSessionStatus(s.id, 'busy', 'run-x');
    resetBusyOnStartup();
    expect(getSessionStatus(s.id)?.status).toBe('interrupted');
  });

  it('resetBusyOnStartup leaves idle sessions untouched', () => {
    const s = createSession('trader', 'u3');
    resetBusyOnStartup();
    expect(getSessionStatus(s.id)?.status).toBe('idle');
  });
});
