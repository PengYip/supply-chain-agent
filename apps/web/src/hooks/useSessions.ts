import { useState, useEffect, useCallback } from 'react';
import { setFavorite, clearFavorite } from '../api/favorites';

export type SessionStatus = 'idle' | 'busy' | 'interrupted';

export interface Session {
  id: string;
  role: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
  /** Auto-generated session title (Phase 5); undefined until the first exchange completes. */
  title?: string;
  /** Background-run lifecycle state surfaced by GET /api/sessions (phase 1). */
  status?: SessionStatus;
  /** 对话收藏: true when the current user favorited this session (GET /api/sessions join). */
  favorited?: boolean;
  /** Persisted message count (GET /api/sessions). 0 = 新建后从未发言的空会话。 */
  messageCount?: number;
}

export function useSessions() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);

  // Returns the fresh rows so callers can act on authoritative data (e.g. the
  // 新建会话 guard needs the CURRENT message count, not the possibly-stale
  // rendered list).
  const refresh = useCallback(async (): Promise<Session[]> => {
    try {
      const res = await fetch('/api/sessions');
      if (res.ok) {
        const data = await res.json();
        const rows: Session[] = Array.isArray(data) ? data : (data.sessions ?? []);
        setSessions(rows);
        return rows;
      }
    } catch { /* ignore */ }
    setLoading(false);
    return [];
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const createSession = useCallback(async (role = 'trader'): Promise<Session | null> => {
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role }),
    });
    if (res.ok) {
      const session: Session = await res.json();
      // The POST endpoint returns only {id, role}; re-fetch the full list so
      // the new session appears with complete fields (createdAt/title).
      await refresh();
      return session;
    }
    return null;
  }, [refresh]);

  const deleteSession = useCallback(async (id: string) => {
    try {
      await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
      // Re-fetch authoritative state from the server instead of optimistic
      // local mutation, so the list stays consistent.
      await refresh();
    } catch { /* ignore */ }
  }, [refresh]);

  // 对话收藏 (upsert with optional feedback note) / 取消收藏. Both re-fetch the
  // list so the sidebar star and the 已收藏 filter stay authoritative.
  const favoriteSession = useCallback(async (id: string, note?: string | null) => {
    await setFavorite(id, note);
    await refresh();
  }, [refresh]);

  const unfavoriteSession = useCallback(async (id: string) => {
    await clearFavorite(id);
    await refresh();
  }, [refresh]);

  return { sessions, loading, refresh, createSession, deleteSession, favoriteSession, unfavoriteSession };
}
