// apps/web/src/hooks/useEvalDatasets.ts
import { useCallback, useEffect, useState } from 'react';
import { listEvalDatasets, type DatasetInfo } from '../api/evalDatasets';

export function useEvalDatasets() {
  const [datasets, setDatasets] = useState<DatasetInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    setError(null);
    try {
      const d = await listEvalDatasets();
      setDatasets(d.datasets);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  return { datasets, loading, error, refresh };
}
