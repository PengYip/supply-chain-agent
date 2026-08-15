// apps/web/src/components/eval/EvalWorkbenchView.tsx
import { useState } from 'react'
import { EvalRunsList } from './EvalRunsList'

type Page =
  | { page: 'runs' }
  | { page: 'report'; runId: string }
  | { page: 'episode'; runId: string; scenarioId: string; runIndex: number }

export function EvalWorkbenchView() {
  const [nav, setNav] = useState<Page>({ page: 'runs' })
  return (
    <div className="h-full overflow-auto bg-bgGray">
      {nav.page === 'runs' && <EvalRunsList onOpenRun={(runId) => setNav({ page: 'report', runId })} />}
      {nav.page === 'report' && (
        <div className="p-8 text-sm text-textGray">
          报告页 (Task 5) — runId={nav.runId}
          <button type="button" className="ml-2 text-deepSea underline" onClick={() => setNav({ page: 'runs' })}>返回</button>
        </div>
      )}
      {nav.page === 'episode' && (
        <div className="p-8 text-sm text-textGray">episode 页 (Task 6)</div>
      )}
    </div>
  )
}
