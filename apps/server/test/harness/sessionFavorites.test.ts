import { describe, it, expect } from 'vitest';
import {
  createSession,
  deleteSession,
  getSessionFavorite,
  listAllSessionFavorites,
  listSessionFavorites,
  listSessionsForUser,
  setSessionFavorite,
  clearSessionFavorite,
  setSessionTitle,
} from '../../src/harness/sessionStore.js';

// Store-level tests for 对话收藏. Like sessionStatus.test.ts these run against
// the shared file-backed DB; every fixture session gets a fresh UUID so cases
// cannot collide.

describe('session favorites store', () => {
  it('setSessionFavorite upserts note and email snapshot', () => {
    const s = createSession('trader', 'fav-u1');
    const first = setSessionFavorite(s.id, 'fav-u1', 'a@t', '合同查询很好用');
    expect(first.note).toBe('合同查询很好用');
    expect(getSessionFavorite(s.id, 'fav-u1')?.userEmail).toBe('a@t');

    const second = setSessionFavorite(s.id, 'fav-u1', 'a2@t', '备注更新');
    expect(second.note).toBe('备注更新');
    const stored = getSessionFavorite(s.id, 'fav-u1');
    expect(stored?.note).toBe('备注更新');
    expect(stored?.userEmail).toBe('a2@t');
    expect(stored?.updatedAt).toBe(second.updatedAt);
  });

  it('favorites are per-user (data isolation)', () => {
    const s = createSession('trader', 'fav-u1');
    setSessionFavorite(s.id, 'fav-u1', 'a@t', '我的收藏');
    expect(getSessionFavorite(s.id, 'fav-u2')).toBeNull();
    expect(listSessionFavorites('fav-u2').map((r) => r.sessionId)).not.toContain(s.id);
  });

  it('listSessionFavorites joins title/status and drops deleted sessions', () => {
    const s = createSession('trader', 'fav-u1');
    setSessionTitle(s.id, '查合同 HT-1');
    setSessionFavorite(s.id, 'fav-u1', 'a@t', null);

    const rows = listSessionFavorites('fav-u1').filter((r) => r.sessionId === s.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe('查合同 HT-1');
    expect(rows[0]!.status).toBe('idle');

    deleteSession(s.id);
    expect(listSessionFavorites('fav-u1').map((r) => r.sessionId)).not.toContain(s.id);
    expect(listAllSessionFavorites().map((r) => r.sessionId)).not.toContain(s.id);
  });

  it('listAllSessionFavorites aggregates across users with attribution', () => {
    const s1 = createSession('trader', 'fav-a');
    const s2 = createSession('trader', 'fav-b');
    setSessionFavorite(s1.id, 'fav-a', 'a@t', '反馈A');
    setSessionFavorite(s2.id, 'fav-b', 'b@t', '反馈B');

    const all = listAllSessionFavorites();
    const a = all.find((r) => r.sessionId === s1.id);
    const b = all.find((r) => r.sessionId === s2.id);
    expect(a?.userId).toBe('fav-a');
    expect(a?.userEmail).toBe('a@t');
    expect(b?.userId).toBe('fav-b');
  });

  it('clearSessionFavorite reports whether a row was removed', () => {
    const s = createSession('trader', 'fav-u1');
    expect(clearSessionFavorite(s.id, 'fav-u1')).toBe(false);
    setSessionFavorite(s.id, 'fav-u1', 'a@t', null);
    expect(clearSessionFavorite(s.id, 'fav-u1')).toBe(true);
    expect(getSessionFavorite(s.id, 'fav-u1')).toBeNull();
  });

  it('listSessionsForUser carries a favorited flag for the owning user only', () => {
    const s = createSession('trader', 'fav-u1');
    setSessionFavorite(s.id, 'fav-u1', 'a@t', null);
    const own = listSessionsForUser('fav-u1').find((r) => r.id === s.id);
    expect(own?.favorited).toBe(true);
    // Another user listing their sessions never sees u1's favorite (their own
    // sessions carry the flag; u1's session is not in their list at all).
    setSessionFavorite(createSession('trader', 'fav-u2').id, 'fav-u1', 'a@t', null);
    expect(listSessionsForUser('fav-u2').every((r) => r.id !== s.id)).toBe(true);
  });
});
