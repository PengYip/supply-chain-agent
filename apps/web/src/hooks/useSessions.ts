import { useState, useEffect, useCallback } from 'react';

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
}

export function useSessions() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/sessions');
      if (res.ok) {
        const data = await res.json();
        setSessions(Array.isArray(data) ? data : (data.sessions ?? []));
      }
    } catch { /* ignore */ }
    setLoading(false);
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

  return { sessions, loading, refresh, createSession, deleteSession };
}
