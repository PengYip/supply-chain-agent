import { memo, useCallback, useEffect, useState } from 'react'
import { X } from 'lucide-react'
import FileViewer from '@file-viewer/react'
import officePreset from '@file-viewer/preset-office'
import litePreset from '@file-viewer/preset-lite'
import { type FileEntry, fetchFileBlob } from '../hooks/useFiles'

interface FilePreviewModalProps {
  file: FileEntry
  onClose: () => void
}

type LoadPhase = 'loading' | 'error' | 'ready'

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Memoized so parent re-renders (hover, file list refresh) never reload the
 *  document: props stay referentially stable while the modal is open. */
const ViewerBody = memo(function ViewerBody({ fileObj, name }: { fileObj: File; name: string }) {
  return (
    <FileViewer
      file={fileObj}
      name={name}
      options={{ preset: [officePreset, litePreset], theme: 'light' }}
      style={{ width: '100%', height: '100%' }}
    />
  )
})

export function FilePreviewModal({ file, onClose }: FilePreviewModalProps) {
  const [phase, setPhase] = useState<LoadPhase>('loading')
  const [fileObj, setFileObj] = useState<File | null>(null)
  const [attempt, setAttempt] = useState(0)

  // Fetch the file bytes on mount and on every retry.
  useEffect(() => {
    let cancelled = false
    setPhase('loading')
    setFileObj(null)
    fetchFileBlob(file.key)
      .then((blob) => {
        if (cancelled) return
        setFileObj(new File([blob], file.name, { type: blob.type }))
        setPhase('ready')
      })
      .catch(() => {
        if (!cancelled) setPhase('error')
      })
    return () => {
      cancelled = true
    }
  }, [file.key, file.name, attempt])

  // Close on Escape; lock background scroll while open.
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

  const handleDownload = useCallback(async () => {
    try {
      const res = await fetch(`/api/files/presign?key=${encodeURIComponent(file.key)}`)
      if (res.ok) {
        const { url } = await res.json()
        window.open(url, '_blank')
      }
    } catch { /* ignore */ }
  }, [file.key])

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-modal flex items-center justify-center bg-ink/50"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex h-[88vh] w-[90vw] flex-col overflow-hidden rounded-[10px] bg-panel shadow-2xl"
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2.5">
          <span title={file.name} className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">
            {file.name}
          </span>
          <span className="whitespace-nowrap text-xs text-ink-soft">{formatSize(file.size)}</span>
          <span
            onClick={handleDownload}
            className="cursor-pointer whitespace-nowrap rounded px-1.5 py-0.5 text-xs text-primary transition-colors hover:bg-primary/10"
          >
            下载
          </span>
          <button
            type="button"
            aria-label="关闭预览"
            onClick={onClose}
            className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-ink-soft transition-colors hover:bg-surface hover:text-ink"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <div className="min-h-0 flex-1 bg-surface">
          {phase === 'loading' && (
            <div className="flex h-full items-center justify-center text-sm text-ink-soft">
              加载中...
            </div>
          )}
          {phase === 'error' && (
            <div className="flex h-full flex-col items-center justify-center gap-3">
              <span className="text-sm text-ink-soft">加载失败</span>
              <button
                type="button"
                onClick={() => setAttempt((n) => n + 1)}
                className="cursor-pointer rounded-md border border-line bg-panel px-3.5 py-1 text-xs text-primary transition-colors hover:bg-primary/10"
              >
                重试
              </button>
            </div>
          )}
          {phase === 'ready' && fileObj && <ViewerBody fileObj={fileObj} name={file.name} />}
        </div>
      </div>
    </div>
  )
}

export default FilePreviewModal
