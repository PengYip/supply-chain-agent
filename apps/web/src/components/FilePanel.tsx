import { useFiles } from '../hooks/useFiles'

interface FilePanelProps {
  visible: boolean
  onClose: () => void
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function FilePanel(props: FilePanelProps) {
  const { visible, onClose } = props
  const { files, downloadFile } = useFiles()

  return (
    <div
      style={{
        position: 'fixed',
        right: 0,
        top: 0,
        width: 280,
        height: '100vh',
        borderLeft: '1px solid #e0e0e0',
        overflowY: 'auto',
        background: '#fafafa',
        display: visible ? 'block' : 'none',
        boxSizing: 'border-box',
        zIndex: 30,
      }}
    >
      <div style={{ padding: 12, fontSize: 16, fontWeight: 'bold' }}>
        文件管理
        <span
          onClick={onClose}
          style={{
            float: 'right',
            cursor: 'pointer',
            fontSize: 14,
            fontWeight: 'normal',
            color: '#555',
            marginLeft: 8,
          }}
        >
          X
        </span>
      </div>

      {files.length === 0 ? (
        <div style={{ textAlign: 'center', color: '#888', padding: 24, fontSize: 13 }}>
          暂无文件
        </div>
      ) : (
        files.map((f) => {
          const name = (f.key || '').split('/').pop() || f.key || ''
          return (
            <div
              key={f.key}
              style={{
                padding: '8px 12px',
                borderBottom: '1px solid #eee',
              }}
            >
              <div style={{ fontSize: 13, wordBreak: 'break-all' }}>{name}</div>
              <div style={{ fontSize: 12, color: '#888' }}>{formatSize(f.size)}</div>
              <div>
                <span
                  onClick={() => downloadFile(f.key)}
                  style={{ fontSize: 12, color: '#2563eb', cursor: 'pointer' }}
                >
                  下载
                </span>
              </div>
            </div>
          )
        })
      )}
    </div>
  )
}

export default FilePanel
