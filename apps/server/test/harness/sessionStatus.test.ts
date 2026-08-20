import { describe, it, expect, beforeEach } from 'vitest';
import type { UIMessage } from 'ai';
import {
  createSession,
  setSessionStatus,
  getSessionStatus,
  listSessionsForUser,
  purgeEmptySessionsForUser,
  appendMessages,
  loadSession,
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

  it('listSessionsForUser includes messageCount (0 until first message)', () => {
    const s = createSession('trader', 'u-mc');
    expect(listSessionsForUser('u-mc').find((r) => r.id === s.id)?.messageCount).toBe(0);
    appendMessages(s.id, [
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: '你好' }] } as UIMessage,
    ]);
    expect(listSessionsForUser('u-mc').find((r) => r.id === s.id)?.messageCount).toBe(1);
  });

  it('purgeEmptySessionsForUser removes zero-message sessions of the calling user only', () => {
    const emptyMine = createSession('trader', 'u-purge');
    const usedMine = createSession('trader', 'u-purge');
    appendMessages(usedMine.id, [
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: '查合同' }] } as UIMessage,
    ]);
    const emptyOther = createSession('trader', 'u-other');

    expect(purgeEmptySessionsForUser('u-purge')).toBe(1);
    expect(loadSession(emptyMine.id)).toBeNull();
    // 有消息的会话不受影响，其他用户的空会话也不受影响（数据隔离）。
    expect(loadSession(usedMine.id)).not.toBeNull();
    expect(loadSession(emptyOther.id)).not.toBeNull();
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
