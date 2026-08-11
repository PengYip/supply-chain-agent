import { useState, useEffect, useCallback } from 'react';

export interface Session {
  id: string;
  role: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
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
      setSessions(prev => [session, ...prev]);
      return session;
    }
    return null;
  }, []);

  const deleteSession = useCallback(async (id: string) => {
    try {
      await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
      setSessions(prev => prev.filter(s => s.id !== id));
    } catch { /* ignore */ }
  }, []);

  return { sessions, loading, refresh, createSession, deleteSession };
}
