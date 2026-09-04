// 全局复核弹窗(App 层单例): 文件树子单据行、复核卡拆分清单等入口经
// lib/reviewModal 通道请求打开。挂载即拉取当前快照(GET /api/documents/:docId
// /review)并渲染既有 DocumentReviewCard —— container/unit/普通文档三种
// payload 都可开,卡片自身已处理 pending 水合与提交后的状态推进。
// 交互惯例照 FilePreviewModal: Esc/遮罩点击关闭、打开期间锁定背景滚动、
// 失败可重试。
//
// 队列模式(入口传 queue 时启用,照 ExportPreviewModal 的翻页交互语言):
// - 底栏「上一份 / 第 i / N 份 / 下一份」,左右方向键翻页,队首/队尾禁用;
// - 复核卡确认/更正成功(onUpdated)后把 snapshot.reviewStatus 回写队列
//   (App 持有队列副本,跨 key 化重挂载保留),并自动前进到当前位置之后
//   第一个 pending(跳过已复核的);后面没有 pending 时停在原地给行内
//   完成提示,不再弹窗。
// 方向键守卫: 复核卡内有字段输入框/表格单元格输入与下拉框,焦点落在
// 可编辑元素上时方向键留给文本光标,不翻页(ExportPreviewModal 无输入区,
// 不需要这道守卫)。
import { useCallback, useEffect, useState } from 'react'
import clsx from 'clsx'
import { CheckCircle2, ChevronLeft, ChevronRight, Loader2, X } from 'lucide-react'
import { fetchReviewSnapshot } from '../api/review'
import { DocumentReviewCard, type DocumentReviewPayload } from './DocumentReviewCard'
import type { ReviewQueueItem } from '../lib/reviewModal'

interface ReviewModalProps {
  docId: string
  onClose: () => void
  /** 可选: 透传给复核卡的「去绑定」跳转(App 持有导航通道时提供);
   *  触发时先关闭本弹窗再跳转。 */
  onOpenBindings?: (docId: string) => void
  /** 可选: 复核队列(container 拆分清单/文件树入口传入,App 持有)。
   *  缺省、空、或当前 docId 不在队列中 = 单文档模式,不渲染翻页器、
   *  方向键不翻页(优雅降级,行为与队列化之前一致)。 */
  queue?: ReviewQueueItem[] | null
  /** 可选: 队列内切换当前复核目标(App setReviewDocId;docId 作 key,
   *  切换即重挂载重拉快照)。 */
  onNavigate?: (docId: string) => void
  /** 可选: 队列状态回写(确认/更正后更新对应项的 reviewStatus)。 */
  onQueueChange?: (queue: ReviewQueueItem[]) => void
}

type LoadPhase = 'loading' | 'error' | 'ready'

/** 单文档模式的空队列占位(模块级常量保住引用稳定,避免 effect/callback
 *  依赖数组每渲染失效)。 */
const EMPTY_QUEUE: ReviewQueueItem[] = []

/** 焦点是否落在会消费方向键的可编辑元素上(输入框/下拉/富文本)。 */
function isTextEntryTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  if (t.isContentEditable) return true
  const tag = t.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

export function ReviewModal({
  docId,
  onClose,
  onOpenBindings,
  queue,
  onNavigate,
  onQueueChange,
}: ReviewModalProps) {
  const [phase, setPhase] = useState<LoadPhase>('loading')
  const [snapshot, setSnapshot] = useState<DocumentReviewPayload | null>(null)
  const [errorText, setErrorText] = useState('')
  const [attempt, setAttempt] = useState(0)
  // 完成提示(行内,非弹窗): 确认/更正后当前位置之后已无 pending 时设置;
  // 任何前进/翻页都会触发 key 化重挂载,提示随之自然清除。
  const [finishNote, setFinishNote] = useState<string | null>(null)

  const queueItems = queue ?? EMPTY_QUEUE
  const index = queueItems.findIndex((q) => q.docId === docId)
  const hasPager = queueItems.length > 1 && index >= 0
  const pendingCount = queueItems.filter((q) => (q.reviewStatus ?? 'pending') === 'pending').length

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

  // Esc 关闭 + 队列模式左右方向键翻页 + 打开期间锁定背景滚动(照
  // FilePreviewModal 惯例;翻页部分照 ExportPreviewModal,增加编辑态守卫)。
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      if (!hasPager || !onNavigate) return
      if (isTextEntryTarget(e.target)) return
      const nextIndex = index + (e.key === 'ArrowLeft' ? -1 : 1)
      if (nextIndex < 0 || nextIndex >= queueItems.length) return
      e.preventDefault()
      onNavigate(queueItems[nextIndex].docId)
    }
    document.addEventListener('keydown', handleKeyDown)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = prevOverflow
    }
  }, [onClose, hasPager, onNavigate, index, queueItems])

  const handleOpenBindings = useCallback(
    (targetDocId: string) => {
      onClose()
      onOpenBindings?.(targetDocId)
    },
    [onClose, onOpenBindings],
  )

  // onUpdated(复核卡确认/更正成功): (a) 回写队列状态 —— App 持有的队列副本
  // 跨 key 化重挂载保留,连续确认多份后回翻看到的仍是最新口径;
  // (b) 状态从 pending 推进到 confirmed/corrected 时,自动前进到「当前位置
  // 之后第一个 pending」(不是简单 +1,跳过已复核的);后面没有 pending 则
  // 停在原地,按「前方是否还有待复核」给出行内提示。
  // 改类型也会触发 onUpdated,但其快照不改变 reviewStatus —— 以队列里上一
  // 次已知状态判定跃迁,不会误触发前进。
  const handleUpdated = useCallback(
    (snap: DocumentReviewPayload) => {
      const idx = queueItems.findIndex((q) => q.docId === snap.docId)
      if (idx < 0) return
      const was = queueItems[idx].reviewStatus ?? 'pending'
      const nextItems = queueItems.map((q) =>
        q.docId === snap.docId ? { ...q, reviewStatus: snap.reviewStatus } : q,
      )
      onQueueChange?.(nextItems)
      if (was !== 'pending' || (snap.reviewStatus !== 'confirmed' && snap.reviewStatus !== 'corrected')) {
        return
      }
      const nextIdx = nextItems.findIndex(
        (q, i) => i > idx && (q.reviewStatus ?? 'pending') === 'pending',
      )
      if (nextIdx >= 0) {
        onNavigate?.(nextItems[nextIdx].docId)
        return
      }
      const pendingElsewhere = nextItems.filter(
        (q, i) => i !== idx && (q.reviewStatus ?? 'pending') === 'pending',
      ).length
      setFinishNote(
        pendingElsewhere > 0
          ? `后面已无待复核单据，前方还有 ${pendingElsewhere} 份待复核`
          : `本组 ${nextItems.length} 份单据已全部复核`,
      )
    },
    [queueItems, onQueueChange, onNavigate],
  )

  // 队列长度 <= 1 时无翻页控件,但确认唯一一份后的完成提示仍值得展示
  // (hasPager 为 false 的完成条)。
  const showQueueFooter = hasPager || finishNote !== null

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
              onUpdated={handleUpdated}
              onOpenBindings={onOpenBindings ? handleOpenBindings : undefined}
            />
          )}
        </div>
        {/* 队列底栏: 完成提示 / 待复核计数 + 上一份·位置·下一份。
            样式对齐 ExportPreviewModal 的页码条(tabular-nums 计数)与
            ContainerSplitCard 的幽灵按钮语言。 */}
        {showQueueFooter && (
          <div className="flex shrink-0 items-center gap-2 border-t border-line px-3 py-2">
            {finishNote !== null ? (
              <span
                className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-success"
                role="status"
              >
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden />
                <span className="truncate">{finishNote}</span>
              </span>
            ) : (
              <span className="min-w-0 flex-1 truncate text-xs text-ink-soft">
                {pendingCount > 0
                  ? `剩 ${pendingCount} 份待复核`
                  : '本组单据已全部复核'}
              </span>
            )}
            {hasPager && (
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  aria-label="上一份"
                  onClick={() => onNavigate?.(queueItems[index - 1].docId)}
                  disabled={index <= 0}
                  className={clsx(
                    'inline-flex h-6 cursor-pointer items-center gap-1 rounded-md border border-line px-2',
                    'text-[11px] text-ink-soft transition-colors hover:bg-surface hover:text-ink',
                    'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink-soft',
                  )}
                >
                  <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
                  上一份
                </button>
                <span className="whitespace-nowrap text-xs tabular-nums text-ink-soft">
                  第 {index + 1} / {queueItems.length} 份
                </span>
                <button
                  type="button"
                  aria-label="下一份"
                  onClick={() => onNavigate?.(queueItems[index + 1].docId)}
                  disabled={index >= queueItems.length - 1}
                  className={clsx(
                    'inline-flex h-6 cursor-pointer items-center gap-1 rounded-md border border-line px-2',
                    'text-[11px] text-ink-soft transition-colors hover:bg-surface hover:text-ink',
                    'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink-soft',
                  )}
                >
                  下一份
                  <ChevronRight className="h-3.5 w-3.5" aria-hidden />
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export default ReviewModal
