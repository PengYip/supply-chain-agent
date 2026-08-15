// apps/web/src/hooks/useEvalRunEpisodes.ts
import { useCallback, useEffect, useState } from 'react'
import { getEvalRunEpisodes, type EvalEpisodeView } from '../api/eval'

export function useEvalRunEpisodes(runId: string | null) {
  const [episodes, setEpisodes] = useState<EvalEpisodeView[]>([])
  const [droppedLines, setDroppedLines] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!runId) { setEpisodes([]); setDroppedLines(0); return }
    setLoading(true)
    setError(null)
    try {
      const data = await getEvalRunEpisodes(runId)
      setEpisodes(data.episodes)
      setDroppedLines(data.droppedLines)
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [runId])

  useEffect(() => { void refresh() }, [refresh])
  return { episodes, droppedLines, loading, error, refresh }
}
