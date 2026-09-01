// 全局复核弹窗(App 层单例): 文件树子单据行、复核卡拆分清单等入口经
// lib/reviewModal 通道请求打开。挂载即拉取当前快照(GET /api/documents/:docId
// /review)并渲染既有 DocumentReviewCard —— container/unit/普通文档三种
// payload 都可开,卡片自身已处理 pending 水合与提交后的状态推进。
// 交互惯例照 FilePreviewModal: Esc/遮罩点击关闭、打开期间锁定背景滚动、
// 失败可重试。
import { useCallback, useEffect, useState } from 'react'
import { Loader2, X } from 'lucide-react'
import { fetchReviewSnapshot } from '../api/review'
import { DocumentReviewCard, type DocumentReviewPayload } from './DocumentReviewCard'

interface ReviewModalProps {
  docId: string
  onClose: () => void
  /** 可选: 透传给复核卡的「去绑定」跳转(App 持有导航通道时提供);
   *  触发时先关闭本弹窗再跳转。 */
  onOpenBindings?: (docId: string) => void
}

type LoadPhase = 'loading' | 'error' | 'ready'

export function ReviewModal({ docId, onClose, onOpenBindings }: ReviewModalProps) {
  const [phase, setPhase] = useState<LoadPhase>('loading')
  const [snapshot, setSnapshot] = useState<DocumentReviewPayload | null>(null)
  const [errorText, setErrorText] = useState('')
  const [attempt, setAttempt] = useState(0)

  // 拉取当前快照(挂载与重试时;docId 变化由父层 key 化重挂载保证重拉)。
  useEffect(() => {
    let cancelled = false
    setPhase('loading')
    setSnapshot(null)
    fetchReviewSnapshot(docId)
      .then((res) => {
        if (cancelled) return
        setSnapshot(res.snapshot)
        setPhase('ready')
      })
      .catch((e) => {
        if (cancelled) return
        setErrorText(e instanceof Error ? e.message : '')
        setPhase('error')
      })
    return () => {
      cancelled = true
    }
  }, [docId, attempt])

  // Esc 关闭 + 打开期间锁定背景滚动(照 FilePreviewModal 惯例)。
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = prevOverflow
    }
  }, [onClose])

  const handleOpenBindings = useCallback(
    (targetDocId: string) => {
      onClose()
      onOpenBindings?.(targetDocId)
    },
    [onClose, onOpenBindings],
  )

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-modal flex items-center justify-center bg-ink/50 p-4 animate-fade-in"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="单据复核"
        className="flex max-h-[88vh] w-[min(720px,94vw)] flex-col overflow-hidden rounded-[10px] bg-panel shadow-2xl animate-slide-up"
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2.5">
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">
            单据复核
          </span>
          <button
            type="button"
            aria-label="关闭复核"
            onClick={onClose}
            className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-ink-soft transition-colors hover:bg-surface hover:text-ink"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
          {phase === 'loading' && (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-ink-soft">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              正在获取复核数据...
            </div>
          )}
          {phase === 'error' && (
            <div className="flex flex-col items-center justify-center gap-3 py-10">
              <span className="text-sm text-ink-soft">
                复核数据加载失败{errorText ? `：${errorText}` : ''}
              </span>
              <button
                type="button"
                onClick={() => setAttempt((n) => n + 1)}
                className="cursor-pointer rounded-md border border-line bg-panel px-3.5 py-1 text-xs text-primary transition-colors hover:bg-primary/10"
              >
                重试
              </button>
            </div>
          )}
          {phase === 'ready' && snapshot && (
            <DocumentReviewCard
              payload={snapshot}
              onOpenBindings={onOpenBindings ? handleOpenBindings : undefined}
            />
          )}
        </div>
      </div>
    </div>
  )
}

export default ReviewModal
