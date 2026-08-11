import { useMemo, useState } from 'react'
import { useFiles, type FileEntry, type FileFolder } from '../hooks/useFiles'

interface FilePanelProps {
  visible: boolean
  onClose: () => void
  onAddToConversation: (file: FileEntry) => void
  contextFileKeys: Set<string>
}

interface TreeNode {
  files: FileEntry[]
  subdirs: Record<string, TreeNode>
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function pathSegments(p: string | undefined): string[] {
  if (!p) return []
  return p.split('/').map((s) => s.trim()).filter((s) => s.length > 0)
}

function buildTree(files: FileEntry[], folders: FileFolder[]): TreeNode {
  const root: TreeNode = { files: [], subdirs: {} }
  const getOrCreate = (segs: string[]): TreeNode => {
    let node = root
    for (const seg of segs) {
      if (!node.subdirs[seg]) node.subdirs[seg] = { files: [], subdirs: {} }
      node = node.subdirs[seg]
    }
    return node
  }
  for (const folder of folders) getOrCreate(pathSegments(folder.path))
  for (const file of files) getOrCreate(pathSegments(file.directory)).files.push(file)
  return root
}

function FileRow(props: {
  file: FileEntry
  depth: number
  downloadFile: (key: string) => void
  onAddToConversation: (file: FileEntry) => void
  added: boolean
}) {
  const { file, depth, downloadFile, onAddToConversation, added } = props
  return (
    <div
      style={{
        padding: '6px 8px',
        paddingLeft: 8 + depth * 12,
        borderBottom: '1px solid #eee',
      }}
    >
      <div style={{ fontSize: 13, wordBreak: 'break-all' }}>{file.name}</div>
      <div style={{ fontSize: 12, color: '#888' }}>{formatSize(file.size)}</div>
      <div style={{ display: 'flex', gap: 8 }}>
        <span
          onClick={() => downloadFile(file.key)}
          style={{ fontSize: 12, color: '#2563eb', cursor: 'pointer' }}
        >
          下载
        </span>
        {added ? (
          <span style={{ fontSize: 12, color: '#16a34a' }}>已添加</span>
        ) : (
          <span
            onClick={() => onAddToConversation(file)}
            style={{ fontSize: 12, color: '#2563eb', cursor: 'pointer' }}
          >
            添加到对话
          </span>
        )}
      </div>
    </div>
  )
}

interface TreeFolderProps {
  name: string
  fullPath: string
  node: TreeNode
  depth: number
  expanded: Set<string>
  toggle: (path: string) => void
  downloadFile: (key: string) => void
  removeFolder: (path: string) => void
  onAddToConversation: (file: FileEntry) => void
  contextFileKeys: Set<string>
}

function TreeFolder(props: TreeFolderProps) {
  const {
    name,
    fullPath,
    node,
    depth,
    expanded,
    toggle,
    downloadFile,
    removeFolder,
    onAddToConversation,
    contextFileKeys,
  } = props
  const isOpen = expanded.has(fullPath)
  return (
    <div>
      <div
        onClick={() => toggle(fullPath)}
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '6px 8px',
          paddingLeft: 8 + depth * 12,
          cursor: 'pointer',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = '#eef1f5' }}
        onMouseLeave={(e) => { e.currentTarget.style.background = '' }}
      >
        <span style={{ marginRight: 6, fontSize: 12, color: '#555', width: 18 }}>
          {isOpen ? '[-]' : '[+]'}
        </span>
        <span style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>{name}</span>
        <span
          onClick={(e) => { e.stopPropagation(); removeFolder(fullPath) }}
          style={{ fontSize: 12, color: '#dc2626', cursor: 'pointer' }}
        >
          删除
        </span>
      </div>
      {isOpen && (
        <div>
          {node.files.length === 0 && Object.keys(node.subdirs).length === 0 && (
            <div
              style={{
                padding: '4px 8px',
                paddingLeft: 8 + (depth + 1) * 12,
                fontSize: 12,
                color: '#aaa',
              }}
            >
              （空）
            </div>
          )}
          {node.files.map((f) => (
            <FileRow
              key={f.key}
              file={f}
              depth={depth + 1}
              downloadFile={downloadFile}
              onAddToConversation={onAddToConversation}
              added={contextFileKeys.has(f.key)}
            />
          ))}
          {Object.entries(node.subdirs).map(([subname, subnode]) => (
            <TreeFolder
              key={subname}
              name={subname}
              fullPath={fullPath ? `${fullPath}/${subname}` : subname}
              node={subnode}
              depth={depth + 1}
              expanded={expanded}
              toggle={toggle}
              downloadFile={downloadFile}
              removeFolder={removeFolder}
              onAddToConversation={onAddToConversation}
              contextFileKeys={contextFileKeys}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export function FilePanel(props: FilePanelProps) {
  const { visible, onClose, onAddToConversation, contextFileKeys } = props
  const { files, folders, loading, downloadFile, createFolder, removeFolder } = useFiles()
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())

  const tree = useMemo(() => buildTree(files, folders), [files, folders])

  const toggle = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const handleNewFolder = () => {
    const name = window.prompt('请输入文件夹名称')
    if (name && name.trim()) createFolder(name.trim())
  }

  const hasContent = files.length > 0 || folders.length > 0

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
        display: visible ? 'flex' : 'none',
        boxSizing: 'border-box',
        zIndex: 30,
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          padding: 12,
          fontSize: 16,
          fontWeight: 'bold',
          display: 'flex',
          alignItems: 'center',
          borderBottom: '1px solid #eee',
        }}
      >
        <span style={{ flex: 1 }}>文件管理</span>
        <button
          type="button"
          onClick={handleNewFolder}
          style={{
            fontSize: 12,
            fontWeight: 'normal',
            color: '#2563eb',
            background: 'transparent',
            border: '1px solid #2563eb',
            borderRadius: 4,
            padding: '2px 8px',
            cursor: 'pointer',
            marginRight: 8,
          }}
        >
          新建文件夹
        </button>
        <span
          onClick={onClose}
          style={{ cursor: 'pointer', fontSize: 14, fontWeight: 'normal', color: '#555' }}
        >
          X
        </span>
      </div>

      <div style={{ flex: 1 }}>
        {loading ? (
          <div style={{ textAlign: 'center', color: '#888', padding: 24, fontSize: 13 }}>
            加载中...
          </div>
        ) : !hasContent ? (
          <div style={{ textAlign: 'center', color: '#888', padding: 24, fontSize: 13 }}>
            暂无文件
          </div>
        ) : (
          <>
            {tree.files.map((f) => (
              <FileRow
                key={f.key}
                file={f}
                depth={0}
                downloadFile={downloadFile}
                onAddToConversation={onAddToConversation}
                added={contextFileKeys.has(f.key)}
              />
            ))}
            {Object.entries(tree.subdirs).map(([subname, subnode]) => (
              <TreeFolder
                key={subname}
                name={subname}
                fullPath={subname}
                node={subnode}
                depth={1}
                expanded={expanded}
                toggle={toggle}
                downloadFile={downloadFile}
                removeFolder={removeFolder}
                onAddToConversation={onAddToConversation}
                contextFileKeys={contextFileKeys}
              />
            ))}
          </>
        )}
      </div>
    </div>
  )
}

export default FilePanel
