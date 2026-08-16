// apps/web/src/components/eval/verdictBadge.tsx
import clsx from 'clsx'
import { ShieldAlert, ShieldCheck, CircleAlert, CircleHelp } from 'lucide-react'

/** verdict -> 视觉类 (全局约束: pass=success, fail/veto=danger, review=warning, 机器故障=灰)。 */
function verdictClass(verdict: string, veto: boolean): string {
  if (veto) return 'bg-danger/15 text-danger border-danger/40 font-semibold'
  switch (verdict) {
    case 'pass': return 'bg-success/10 text-success border-success/25'
    case 'fail': return 'bg-danger/10 text-danger border-danger/25'
    case 'needs_human_review': return 'bg-warning/10 text-warning border-warning/30'
    case 'sim_error':
    case 'judge_error': return 'bg-bgGray text-textGray border-borderGray'
    default: return 'bg-bgGray text-textGray border-borderGray'
  }
}

const VERDICT_LABEL: Record<string, string> = {
  pass: '通过', fail: '失败', veto: '一票否决',
  needs_human_review: '待人工复核', sim_error: '模拟器故障', judge_error: '裁判故障',
}

export function VerdictBadge({ verdict, veto }: { verdict: string; veto?: boolean }) {
  const label = veto ? '一票否决' : (VERDICT_LABEL[verdict] ?? verdict)
  const Icon = verdict === 'pass' && !veto ? ShieldCheck : veto ? ShieldAlert : verdict === 'needs_human_review' ? CircleHelp : CircleAlert
  return (
    <span className={clsx('inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs whitespace-nowrap', verdictClass(verdict, !!veto))}>
      <Icon className="h-3 w-3" aria-hidden />
      {label}
    </span>
  )
}
