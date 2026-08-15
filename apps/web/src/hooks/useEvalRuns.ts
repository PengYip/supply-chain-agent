// apps/web/src/hooks/useEvalRuns.ts
import { useCallback, useEffect, useState } from 'react'
import { listEvalRuns, type EvalRunSummary } from '../api/eval'

export function useEvalRuns() {
  const [runs, setRuns] = useState<EvalRunSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setRuns(await listEvalRuns())
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])
  return { runs, loading, error, refresh }
}
