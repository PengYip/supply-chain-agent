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

// Store API is async on BOTH backends (SQLite/Postgres dual-backend split),
// so every call awaits once.
describe('session status', () => {
  beforeEach(() => {
    // resetBusyOnStartup is global; ensure no busy sessions leak across cases.
    // (It only touches 'busy' rows, so idle/interrupted are unaffected.)
  });

  it('new session defaults to idle', async () => {
    const s = await createSession('trader', 'u1');
    expect((await getSessionStatus(s.id))?.status).toBe('idle');
  });

  it('setSessionStatus busy records runId and startedAt', async () => {
    const s = await createSession('trader', 'u1');
    await setSessionStatus(s.id, 'busy', 'run-123');
    const st = await getSessionStatus(s.id);
    expect(st?.status).toBe('busy');
    expect(st?.runId).toBe('run-123');
    expect(st?.startedAt).toBeTruthy();
  });

  it('setSessionStatus back to idle clears runId', async () => {
    const s = await createSession('trader', 'u1');
    await setSessionStatus(s.id, 'busy', 'run-1');
    await setSessionStatus(s.id, 'idle');
    const st = await getSessionStatus(s.id);
    expect(st?.status).toBe('idle');
    expect(st?.runId).toBeUndefined();
  });

  it('listSessionsForUser includes status', async () => {
    const s = await createSession('trader', 'u2');
    await setSessionStatus(s.id, 'busy', 'run-9');
    const rows = await listSessionsForUser('u2');
    const row = rows.find((r) => r.id === s.id);
    expect(row?.status).toBe('busy');
  });

  it('listSessionsForUser includes messageCount (0 until first message)', async () => {
    const s = await createSession('trader', 'u-mc');
    expect((await listSessionsForUser('u-mc')).find((r) => r.id === s.id)?.messageCount).toBe(0);
    await appendMessages(s.id, [
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: '你好' }] } as UIMessage,
    ]);
    expect((await listSessionsForUser('u-mc')).find((r) => r.id === s.id)?.messageCount).toBe(1);
  });

  it('purgeEmptySessionsForUser removes zero-message sessions of the calling user only', async () => {
    const emptyMine = await createSession('trader', 'u-purge');
    const usedMine = await createSession('trader', 'u-purge');
    await appendMessages(usedMine.id, [
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: '查合同' }] } as UIMessage,
    ]);
    const emptyOther = await createSession('trader', 'u-other');

    expect(await purgeEmptySessionsForUser('u-purge')).toBe(1);
    expect(await loadSession(emptyMine.id)).toBeNull();
    // 有消息的会话不受影响，其他用户的空会话也不受影响（数据隔离）。
    expect(await loadSession(usedMine.id)).not.toBeNull();
    expect(await loadSession(emptyOther.id)).not.toBeNull();
  });

  it('resetBusyOnStartup turns busy into interrupted', async () => {
    const s = await createSession('trader', 'u3');
    await setSessionStatus(s.id, 'busy', 'run-x');
    await resetBusyOnStartup();
    expect((await getSessionStatus(s.id))?.status).toBe('interrupted');
  });
});
