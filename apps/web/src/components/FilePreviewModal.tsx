import { memo, useCallback, useEffect, useState } from 'react'
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

// Inline SVG icon (same as FilePanel's CloseIcon, no emoji)
function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
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

  const actionSpanStyle = {
    fontSize: 12,
    color: '#2563eb',
    cursor: 'pointer',
    padding: '2px 6px',
    borderRadius: 3,
    whiteSpace: 'nowrap' as const,
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 40,
        background: 'rgba(17, 24, 39, 0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '90vw',
          height: '88vh',
          background: '#ffffff',
          borderRadius: 10,
          boxShadow: '0 20px 50px rgba(0,0,0,0.25)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '10px 12px',
            borderBottom: '1px solid #e5e7eb',
            flexShrink: 0,
          }}
        >
          <span
            title={file.name}
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 14,
              fontWeight: 600,
              color: '#111827',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {file.name}
          </span>
          <span style={{ fontSize: 12, color: '#6b7280', whiteSpace: 'nowrap' }}>{formatSize(file.size)}</span>
          <span
            onClick={handleDownload}
            style={actionSpanStyle}
            onMouseEnter={(e) => { e.currentTarget.style.background = '#eff6ff' }}
            onMouseLeave={(e) => { e.currentTarget.style.background = '' }}
          >
            下载
          </span>
          <button
            type="button"
            aria-label="关闭预览"
            onClick={onClose}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 26,
              height: 26,
              flexShrink: 0,
              color: '#6b7280',
              background: 'transparent',
              border: 'none',
              borderRadius: 5,
              cursor: 'pointer',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = '#f3f4f6' }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
          >
            <CloseIcon />
          </button>
        </div>
        <div style={{ flex: 1, minHeight: 0, background: '#f3f4f6' }}>
          {phase === 'loading' && (
            <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, color: '#6b7280' }}>
              加载中...
            </div>
          )}
          {phase === 'error' && (
            <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
              <span style={{ fontSize: 13, color: '#6b7280' }}>加载失败</span>
              <button
                type="button"
                onClick={() => setAttempt((n) => n + 1)}
                style={{
                  fontSize: 12,
                  color: '#2563eb',
                  background: '#ffffff',
                  border: '1px solid #e5e7eb',
                  borderRadius: 5,
                  padding: '5px 14px',
                  cursor: 'pointer',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = '#eff6ff' }}
                onMouseLeave={(e) => { e.currentTarget.style.background = '#ffffff' }}
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
