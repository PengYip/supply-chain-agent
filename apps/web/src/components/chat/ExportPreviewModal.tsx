import { useCallback, useEffect, useState } from 'react'
import clsx from 'clsx'
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  ImageDown,
  Images,
  Loader2,
  X,
} from 'lucide-react'
import {
  buildFileStem,
  canCopyImageToClipboard,
  canvasToBlob,
  copyCanvasToClipboard,
  downloadLongImage,
  downloadPagedZip,
  sliceExportPage,
  type ChatExportResult,
} from '../../lib/chatExport'

/** 导出预览弹窗的对外回调：与 ChatWorkspace 本地 toast 对齐（duration 可选）。 */
type ToastFn = (kind: 'success' | 'error', text: string, detail?: string, duration?: number) => void

interface ExportPreviewModalProps {
  /** renderChatExport 的产物；弹窗存续期间持有主画布，关闭时由父级释放 */
  result: ChatExportResult
  onClose: () => void
  onToast: ToastFn
}

/** 导出前预览模态：生成结果先在这里确认，再落盘 / 复制。
 *  - 长图：白底滚动区按内容宽度平铺，可完整滚动核验内容（空白问题后这
 *    一步就是最后防线），头部展示实际像素尺寸。
 *  - 多图：主区单页查看（object-contain）+ 底部缩略图条 + 左右翻页，
 *    方向键翻页、Esc 关闭（样式与 FilePreviewModal 同一交互语言）。
 *  预览图全部走 blob URL，关闭时统一 revoke；下载动作在弹窗内完成后
 *  自动关闭（父级随之释放主画布）。 */
export function ExportPreviewModal({ result, onClose, onToast }: ExportPreviewModalProps) {
  const isLong = result.mode === 'long'
  const canCopy = canCopyImageToClipboard()

  // 长图预览地址（blob URL，随弹窗生命周期 revoke）
  const [longUrl, setLongUrl] = useState<string | null>(null)
  // 分页模式各页预览地址；生成是逐页进行的，先占位后填充
  const [pageUrls, setPageUrls] = useState<(string | null)[]>(() =>
    isLong ? [] : Array.from({ length: result.pageCount }, () => null),
  )
  const [pageIndex, setPageIndex] = useState(0)
  const [copying, setCopying] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const busy = copying || downloading

  // 生成主画布的预览图：canvas -> PNG blob -> objectURL。生成失败只 toast，
  // 弹窗保留（下载仍可用，用户可自行落盘核验）。
  useEffect(() => {
    if (!isLong) return
    let cancelled = false
    let created: string | null = null
    void canvasToBlob(result.canvas)
      .then((blob) => {
        if (cancelled) return
        created = URL.createObjectURL(blob)
        setLongUrl(created)
      })
      .catch(() => {
        if (!cancelled) onToast('error', '预览图生成失败')
      })
    return () => {
      cancelled = true
      if (created) URL.revokeObjectURL(created)
    }
  }, [isLong, result, onToast])

  // 分页模式：逐页切片 -> blob URL，边生成边填充缩略图条。
  // 每页编码完立即释放切片画布，超长对话也不会累积内存。
  useEffect(() => {
    if (isLong) return
    let cancelled = false
    const created: string[] = []
    void (async () => {
      for (let i = 0; i < result.pageCount; i++) {
        if (cancelled) return
        const slice = sliceExportPage(result.canvas, i)
        const blob = await canvasToBlob(slice)
        slice.width = 0
        slice.height = 0
        if (cancelled) return
        const url = URL.createObjectURL(blob)
        created.push(url)
        setPageUrls((prev) => {
          const next = prev.slice()
          next[i] = url
          return next
        })
      }
    })().catch(() => {
      if (!cancelled) onToast('error', '分页预览生成失败')
    })
    return () => {
      cancelled = true
      for (const url of created) URL.revokeObjectURL(url)
    }
  }, [isLong, result, onToast])

  // Esc 关闭（busy 时忽略，避免打断打包/复制中途释放画布）；分页模式
  // 方向键翻页；打开期间锁定背景滚动（与 FilePreviewModal 一致）。
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (!busy) onClose()
        return
      }
      if (!isLong) {
        if (e.key === 'ArrowLeft') setPageIndex((i) => Math.max(0, i - 1))
        else if (e.key === 'ArrowRight') setPageIndex((i) => Math.min(result.pageCount - 1, i + 1))
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = prevOverflow
    }
  }, [busy, isLong, result.pageCount, onClose])

  const requestClose = useCallback(() => {
    if (!busy) onClose()
  }, [busy, onClose])

  // 长图复制：能力不足时按钮禁用（title 提示环境要求）；失败 toast 具体原因
  const handleCopy = useCallback(async () => {
    if (busy) return
    setCopying(true)
    try {
      await copyCanvasToClipboard(result.canvas)
      onToast('success', '已成功复制', '可直接粘贴到文档或聊天窗口')
    } catch (err) {
      onToast('error', '复制图片失败', err instanceof Error ? err.message : undefined, 5000)
    } finally {
      setCopying(false)
    }
  }, [busy, result, onToast])

  // 确认下载：长图单 PNG；多图打包 ZIP。成功后自动关闭（父级释放画布）。
  const handleDownload = useCallback(async () => {
    if (busy) return
    setDownloading(true)
    try {
      if (isLong) {
        await downloadLongImage(result)
        onToast('success', '长图已开始下载')
      } else {
        const { filename, pageCount } = await downloadPagedZip(result)
        onToast('success', `已导出压缩包（${pageCount} 张图片）`, filename)
      }
      onClose()
    } catch (err) {
      onToast('error', '导出失败，请重试', err instanceof Error ? err.message : undefined, 5000)
    } finally {
      setDownloading(false)
    }
  }, [busy, isLong, result, onClose, onToast])

  const stem = buildFileStem(result.title)
  const dims = `${result.canvas.width} x ${result.canvas.height} px`
  const generatedPages = pageUrls.filter(Boolean).length

  return (
    <div
      onClick={requestClose}
      className="animate-fade-in fixed inset-0 z-modal flex items-center justify-center bg-ink/50"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex h-[86vh] w-[min(960px,92vw)] flex-col overflow-hidden rounded-[10px] bg-panel shadow-2xl"
      >
        {/* 头部：标题 + 实际像素尺寸 + 关闭 */}
        <div className="flex shrink-0 items-center gap-2.5 border-b border-line px-4 py-3">
          {isLong ? (
            <ImageDown className="h-4 w-4 shrink-0 text-primary" aria-hidden />
          ) : (
            <Images className="h-4 w-4 shrink-0 text-primary" aria-hidden />
          )}
          <span
            title={result.title}
            className="min-w-0 flex-1 truncate text-sm font-semibold text-ink"
          >
            {result.title || '未命名对话'} · 导出预览
          </span>
          <span className="whitespace-nowrap text-xs tabular-nums text-ink-soft">{dims}</span>
          <button
            type="button"
            aria-label="关闭预览"
            onClick={requestClose}
            disabled={busy}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-soft transition-colors hover:bg-surface hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        {/* 主体预览区 */}
        {isLong ? (
          <div className="min-h-0 flex-1 overflow-auto bg-surface">
            {longUrl ? (
              <div className="flex justify-center p-4">
                {/* 按内容宽度平铺、保留原始高度：滚动核验整段对话是否渲染完整 */}
                <img
                  src={longUrl}
                  alt="长图导出预览"
                  className="max-w-full rounded-md border border-line bg-white shadow-card"
                />
              </div>
            ) : (
              <div className="flex h-full items-center justify-center gap-2 text-sm text-ink-soft">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                正在生成预览...
              </div>
            )}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col bg-surface">
            {/* 单页主视图 + 左右翻页 */}
            <div className="relative flex min-h-0 flex-1">
              <button
                type="button"
                aria-label="上一页"
                onClick={() => setPageIndex((i) => Math.max(0, i - 1))}
                disabled={pageIndex === 0}
                className="absolute left-3 top-1/2 z-10 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full border border-line bg-panel/90 text-ink-soft shadow-card transition-colors hover:text-ink disabled:pointer-events-none disabled:opacity-30"
              >
                <ChevronLeft className="h-4 w-4" aria-hidden />
              </button>
              <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6">
                {pageUrls[pageIndex] ? (
                  <img
                    src={pageUrls[pageIndex] as string}
                    alt={`第 ${pageIndex + 1} 页预览`}
                    className="max-h-full max-w-full rounded-md border border-line shadow-card"
                  />
                ) : (
                  <div className="flex items-center justify-center gap-2 text-sm text-ink-soft">
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                    正在生成预览（{generatedPages}/{result.pageCount}）...
                  </div>
                )}
              </div>
              <button
                type="button"
                aria-label="下一页"
                onClick={() => setPageIndex((i) => Math.min(result.pageCount - 1, i + 1))}
                disabled={pageIndex >= result.pageCount - 1}
                className="absolute right-3 top-1/2 z-10 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full border border-line bg-panel/90 text-ink-soft shadow-card transition-colors hover:text-ink disabled:pointer-events-none disabled:opacity-30"
              >
                <ChevronRight className="h-4 w-4" aria-hidden />
              </button>
            </div>
            {/* 缩略图条 + 页码 */}
            <div className="flex shrink-0 items-center gap-3 border-t border-line px-3 py-2.5">
              <span className="shrink-0 text-xs tabular-nums text-ink-soft">
                第 {pageIndex + 1} / {result.pageCount} 页
              </span>
              <div className="flex min-w-0 flex-1 gap-2 overflow-x-auto pb-0.5">
                {pageUrls.map((url, i) => (
                  <button
                    key={i}
                    type="button"
                    aria-label={`查看第 ${i + 1} 页`}
                    onClick={() => setPageIndex(i)}
                    className={clsx(
                      'h-14 shrink-0 overflow-hidden rounded-md border transition-opacity',
                      i === pageIndex ? 'border-primary shadow-pop' : 'border-line opacity-60 hover:opacity-100',
                    )}
                  >
                    {url ? (
                      <img
                        src={url}
                        alt={`第 ${i + 1} 页缩略图`}
                        className="h-14 w-auto max-w-[72px] object-contain"
                      />
                    ) : (
                      <span className="block h-14 w-11 animate-pulse bg-line/60" />
                    )}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* 底部：目标文件名 + 动作区 */}
        <div className="flex shrink-0 items-center justify-between gap-4 border-t border-line px-4 py-3">
          <span className="min-w-0 truncate text-xs text-ink-soft">
            {isLong ? `${stem}.png` : `${stem}.zip（内含 ${result.pageCount} 张 PNG）`}
          </span>
          <div className="flex shrink-0 items-center gap-2">
            {isLong && (
              <>
                {!canCopy && (
                  <span className="text-xs text-ink-soft">
                    需 HTTPS 或 localhost 环境才能复制
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => {
                    void handleCopy()
                  }}
                  disabled={!canCopy || busy}
                  title={canCopy ? '复制图片到剪贴板' : '需 HTTPS 或 localhost 环境'}
                aria-label="复制到剪贴板"
                className={clsx(
                  'flex items-center gap-1.5 rounded-lg border border-line px-3.5 py-1.5',
                  'text-[13px] font-medium text-ink transition-colors hover:bg-surface',
                  'disabled:cursor-not-allowed disabled:opacity-50',
                )}
              >
                {copying ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <Copy className="h-4 w-4" aria-hidden />
                )}
                复制到剪贴板
              </button>
                </>
            )}
            <button
              type="button"
              onClick={() => {
                void handleDownload()
              }}
              disabled={busy}
              className={clsx(
                'flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-1.5',
                'text-[13px] font-medium text-white transition-colors hover:bg-primary-800',
                'disabled:cursor-not-allowed disabled:opacity-50',
              )}
            >
              {downloading ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Download className="h-4 w-4" aria-hidden />
              )}
              {isLong ? '下载 PNG' : `下载 ZIP（${result.pageCount} 张）`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default ExportPreviewModal
