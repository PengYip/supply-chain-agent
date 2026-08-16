// apps/web/src/hooks/useEvalRunLive.ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { getEvalRunLive, type RunEvent } from '../api/evalRun';

export type LiveState = 'connecting' | 'running' | 'done' | 'error' | 'interrupted';

export function useEvalRunLive(runId: string | null) {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [state, setState] = useState<LiveState>('connecting');
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const replay = useCallback(async () => {
    if (!runId) return;
    try {
      const info = await getEvalRunLive(runId);
      setEvents(info.events);
      setState(info.state);
    } catch {
      setState('interrupted');
    }
  }, [runId]);

  useEffect(() => {
    if (!runId) { setEvents([]); setState('connecting'); setError(null); return; }
    setState('connecting');
    setEvents([]);
    setError(null);
    const es = new EventSource(`/api/eval/runs/${encodeURIComponent(runId)}/events`);
    esRef.current = es;
    es.onmessage = (m) => {
      try {
        const e = JSON.parse(m.data) as RunEvent;
        setEvents((prev) => [...prev, e]);
        if (e.type === 'run_done') { setState('done'); es.close(); }
        else if (e.type === 'run_error') { setState('error'); setError(e.message); es.close(); }
        else setState((s) => (s === 'connecting' ? 'running' : s));
      } catch { /* ignore malformed frame */ }
    };
    es.onerror = () => {
      // EventSource auto-reconnects; if the run is gone (404) it keeps
      // failing -> fall back to a one-shot replay probe.
      es.close();
      void replay();
    };
    return () => { es.close(); esRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, replay]);

  return { events, state, error, replay };
}
