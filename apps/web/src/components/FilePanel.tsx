import { useEffect, useMemo, useRef, useState } from 'react'
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

function normalizeMoveDirectory(directory: string): string {
  return directory
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join('/')
}

// Inline SVG icons (no emoji, no icon library)
function FileIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <polyline points="10 9 9 9 8 9" />
    </svg>
  )
}

function FolderIcon({ open = false }: { open?: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style={{ color: open ? '#f59e0b' : '#d97706', flexShrink: 0 }}>
      {open ? (
        <path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z" />
      ) : (
        <path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" />
      )}
    </svg>
  )
}

function ChevronIcon({ open = false }: { open?: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="currentColor"
      style={{
        color: '#6b7280',
        flexShrink: 0,
        transition: 'transform 120ms ease',
        transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
      }}
    >
      <path d="M9 18l6-6-6-6" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
}

function EmptyIcon() {
  return (
    <svg width="40" height="40" viewBox="0 0 24 24" fill="currentColor" style={{ color: '#d1d5db', marginBottom: 8 }}>
      <path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z" />
    </svg>
  )
}

function MoveDropdown({
  file,
  folders,
  onMove,
  onClose,
}: {
  file: FileEntry
  folders: FileFolder[]
  onMove: (key: string, directory: string) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [onClose])

  const current = normalizeMoveDirectory(file.directory)

  const optionStyle = {
    padding: '7px 12px',
    fontSize: 12,
    color: '#374151',
    cursor: 'pointer',
    whiteSpace: 'nowrap' as const,
  }

  const optionHoverStyle = {
    background: '#f5f7fa',
  }

  return (
    <div
      ref={ref}
      onClick={(e) => e.stopPropagation()}
      style={{
        position: 'absolute',
        right: 0,
        top: '100%',
        marginTop: 4,
        minWidth: 170,
        background: '#ffffff',
        border: '1px solid #e5e7eb',
        borderRadius: 6,
        boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
        zIndex: 20,
        padding: '4px 0',
      }}
    >
      {folders.length === 0 ? (
        <div style={{ padding: '8px 12px', fontSize: 12, color: '#9ca3af' }}>暂无文件夹，请先新建</div>
      ) : (
        <>
          <div
            onClick={() => { onMove(file.key, ''); onClose() }}
            onMouseEnter={(e) => { e.currentTarget.style.background = optionHoverStyle.background }}
            onMouseLeave={(e) => { e.currentTarget.style.background = '' }}
            style={optionStyle}
          >
            根目录
            {current === '' && <span style={{ marginLeft: 8, color: '#9ca3af' }}>当前</span>}
          </div>
          {folders.map((folder) => {
            const isCurrent = folder.path === current
            return (
              <div
                key={folder.id}
                onClick={() => { onMove(file.key, folder.path); onClose() }}
                onMouseEnter={(e) => { e.currentTarget.style.background = optionHoverStyle.background }}
                onMouseLeave={(e) => { e.currentTarget.style.background = '' }}
                style={optionStyle}
              >
                {folder.path}
                {isCurrent && <span style={{ marginLeft: 8, color: '#9ca3af' }}>当前</span>}
              </div>
            )
          })}
        </>
      )}
    </div>
  )
}

function FileRow(props: {
  file: FileEntry
  depth: number
  isSelected: boolean
  onSelect: (key: string) => void
  downloadFile: (key: string) => void
  onAddToConversation: (file: FileEntry) => void
  onStartMove: (key: string) => void
  moving: boolean
  folders: FileFolder[]
  onMove: (key: string, directory: string) => void
  onCancelMove: () => void
  added: boolean
  onDelete: (key: string) => void
  deletingFilePath: string | null
  setDeletingFilePath: (key: string | null) => void
}) {
  const {
    file,
    depth,
    isSelected,
    onSelect,
    downloadFile,
    onAddToConversation,
    onStartMove,
    moving,
    folders,
    onMove,
    onCancelMove,
    added,
    onDelete,
    deletingFilePath,
    setDeletingFilePath,
  } = props
  const [hover, setHover] = useState(false)

  return (
    <div
      onClick={() => onSelect(file.key)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        padding: '7px 12px',
        paddingLeft: 12 + depth * 14,
        cursor: 'pointer',
        background: isSelected ? '#e8f0fe' : hover ? '#f5f7fa' : 'transparent',
        borderBottom: '1px solid #f3f4f6',
        fontSize: 13,
        color: '#111827',
      }}
    >
      <div style={{ width: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6b7280' }}>
        <FileIcon />
      </div>
      <span
        title={file.name}
        style={{
          marginLeft: 8,
          flex: 1,
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
          overflowWrap: 'anywhere',
        }}
      >
        {file.name}
      </span>
      <span style={{ fontSize: 11, color: '#9ca3af', marginRight: 8, whiteSpace: 'nowrap', display: hover ? 'inline' : 'none' }}>{formatSize(file.size)}</span>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          display: hover || moving || deletingFilePath === file.key ? 'flex' : 'none',
          alignItems: 'center',
          gap: 6,
          whiteSpace: 'nowrap',
        }}
      >
        <span
          onClick={() => downloadFile(file.key)}
          style={{ fontSize: 11, color: '#2563eb', cursor: 'pointer', padding: '2px 4px', borderRadius: 3 }}
          onMouseEnter={(e) => { e.currentTarget.style.background = '#eff6ff' }}
          onMouseLeave={(e) => { e.currentTarget.style.background = '' }}
        >
          下载
        </span>
        {added ? (
          <span style={{ fontSize: 11, color: '#16a34a', padding: '2px 4px' }}>已添加</span>
        ) : (
          <span
            onClick={() => onAddToConversation(file)}
            style={{ fontSize: 11, color: '#2563eb', cursor: 'pointer', padding: '2px 4px', borderRadius: 3 }}
            onMouseEnter={(e) => { e.currentTarget.style.background = '#eff6ff' }}
            onMouseLeave={(e) => { e.currentTarget.style.background = '' }}
          >
            添加到对话
          </span>
        )}
        <span
          onClick={() => onStartMove(file.key)}
          style={{ fontSize: 11, color: '#2563eb', cursor: 'pointer', padding: '2px 4px', borderRadius: 3 }}
          onMouseEnter={(e) => { e.currentTarget.style.background = '#eff6ff' }}
          onMouseLeave={(e) => { e.currentTarget.style.background = '' }}
        >
          移动
        </span>
        {deletingFilePath === file.key ? (
          <div onClick={(e) => e.stopPropagation()} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
            <span style={{ color: '#6b7280' }}>删除文件？</span>
            <span
              onClick={() => { onDelete(file.key); setDeletingFilePath(null) }}
              style={{ color: '#dc2626', cursor: 'pointer', fontWeight: 500 }}
            >
              确定
            </span>
            <span
              onClick={() => setDeletingFilePath(null)}
              style={{ color: '#6b7280', cursor: 'pointer' }}
            >
              取消
            </span>
          </div>
        ) : (
          <span
            onClick={(e) => { e.stopPropagation(); setDeletingFilePath(file.key) }}
            style={{ fontSize: 11, color: '#dc2626', cursor: 'pointer', padding: '2px 4px', borderRadius: 3 }}
            onMouseEnter={(e) => { e.currentTarget.style.background = '#fef2f2' }}
            onMouseLeave={(e) => { e.currentTarget.style.background = '' }}
          >
            删除
          </span>
        )}
      </div>
      {moving && (
        <MoveDropdown file={file} folders={folders} onMove={onMove} onClose={onCancelMove} />
      )}
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
  onStartMove: (key: string) => void
  movingFileKey: string | null
  folders: FileFolder[]
  onMove: (key: string, directory: string) => void
  onCancelMove: () => void
  contextFileKeys: Set<string>
  deletingFolderPath: string | null
  setDeletingFolderPath: (path: string | null) => void
  onDelete: (key: string) => void
  deletingFilePath: string | null
  setDeletingFilePath: (key: string | null) => void
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
    onStartMove,
    movingFileKey,
    folders,
    onMove,
    onCancelMove,
    contextFileKeys,
    deletingFolderPath,
    setDeletingFolderPath,
    onDelete,
    deletingFilePath,
    setDeletingFilePath,
  } = props
  const isOpen = expanded.has(fullPath)
  const [hover, setHover] = useState(false)
  const hasChildren = node.files.length > 0 || Object.keys(node.subdirs).length > 0

  return (
    <div>
      <div
        onClick={() => toggle(fullPath)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '7px 12px',
          paddingLeft: 12 + depth * 14,
          cursor: 'pointer',
          background: hover ? '#f5f7fa' : 'transparent',
          borderBottom: '1px solid #f3f4f6',
          fontSize: 13,
          color: '#111827',
          position: 'relative',
        }}
      >
        <span
          onClick={(e) => { e.stopPropagation(); toggle(fullPath) }}
          style={{ width: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', marginRight: 4 }}
        >
          {hasChildren ? <ChevronIcon open={isOpen} /> : <span style={{ width: 14 }} />}
        </span>
        <FolderIcon open={isOpen} />
        <span
          title={name}
          style={{
            marginLeft: 8,
            flex: 1,
            fontWeight: 600,
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            overflowWrap: 'anywhere',
          }}
        >
          {name}
        </span>
        {deletingFolderPath === fullPath ? (
          <div onClick={(e) => e.stopPropagation()} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
            <span style={{ color: '#6b7280' }}>移除文件夹？(文件不删)</span>
            <span
              onClick={() => { removeFolder(fullPath); setDeletingFolderPath(null) }}
              style={{ color: '#dc2626', cursor: 'pointer', fontWeight: 500 }}
            >
              确定
            </span>
            <span
              onClick={() => setDeletingFolderPath(null)}
              style={{ color: '#6b7280', cursor: 'pointer' }}
            >
              取消
            </span>
          </div>
        ) : (
          <span
            onClick={(e) => { e.stopPropagation(); setDeletingFolderPath(fullPath) }}
            style={{
              fontSize: 11,
              color: '#dc2626',
              cursor: 'pointer',
              display: hover ? 'inline-block' : 'none',
              padding: '2px 4px',
              borderRadius: 3,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = '#fef2f2' }}
            onMouseLeave={(e) => { e.currentTarget.style.background = '' }}
          >
            删除
          </span>
        )}
      </div>
      {isOpen && (
        <div
          style={{
            marginLeft: 20,
            paddingLeft: 8,
            borderLeft: '1px solid #e5e7eb',
          }}
        >
          {node.files.length === 0 && Object.keys(node.subdirs).length === 0 && (
            <div style={{ padding: '5px 12px', fontSize: 12, color: '#9ca3af' }}>（空）</div>
          )}
          {node.files.map((f) => (
            <FileRow
              key={f.key}
              file={f}
              depth={depth + 1}
              isSelected={false}
              onSelect={() => {}}
              downloadFile={downloadFile}
              onAddToConversation={onAddToConversation}
              onStartMove={onStartMove}
              moving={movingFileKey === f.key}
              folders={folders}
              onMove={onMove}
              onCancelMove={onCancelMove}
              added={contextFileKeys.has(f.key)}
              onDelete={onDelete}
              deletingFilePath={deletingFilePath}
              setDeletingFilePath={setDeletingFilePath}
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
              onStartMove={onStartMove}
              movingFileKey={movingFileKey}
              folders={folders}
              onMove={onMove}
              onCancelMove={onCancelMove}
              contextFileKeys={contextFileKeys}
              deletingFolderPath={deletingFolderPath}
              setDeletingFolderPath={setDeletingFolderPath}
              onDelete={onDelete}
              deletingFilePath={deletingFilePath}
              setDeletingFilePath={setDeletingFilePath}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export function FilePanel(props: FilePanelProps) {
  const { visible, onClose, onAddToConversation, contextFileKeys } = props
  const { files, folders, loading, downloadFile, moveFile, createFolder, removeFolder, deleteFile } = useFiles()
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [movingFileKey, setMovingFileKey] = useState<string | null>(null)
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [deletingFolderPath, setDeletingFolderPath] = useState<string | null>(null)
  const [deletingFilePath, setDeletingFilePath] = useState<string | null>(null)

  const tree = useMemo(() => buildTree(files, folders), [files, folders])

  useEffect(() => {
    if (!visible) {
      setMovingFileKey(null)
      setDeletingFolderPath(null)
      setDeletingFilePath(null)
      setCreatingFolder(false)
      setSelectedKey(null)
    }
  }, [visible])

  const toggle = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const handleCreateFolder = () => {
    const name = newFolderName.trim()
    if (!name) return
    createFolder(name)
    setNewFolderName('')
    setCreatingFolder(false)
  }

  const handleCancelCreate = () => {
    setCreatingFolder(false)
    setNewFolderName('')
  }

  const handleMove = (key: string, directory: string) => {
    moveFile(key, directory)
  }

  const hasContent = files.length > 0 || folders.length > 0

  const listContainerStyle = {
    flex: 1,
    overflowY: 'auto' as const,
    background: '#ffffff',
  }

  const headerStyle = {
    padding: 12,
    borderBottom: '1px solid #e5e7eb',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    background: '#ffffff',
  }

  const titleStyle = {
    fontSize: 15,
    fontWeight: 600,
    color: '#111827',
    lineHeight: 1.2,
  }

  const countStyle = {
    fontSize: 11,
    color: '#6b7280',
  }

  const ghostButtonStyle = {
    fontSize: 12,
    fontWeight: 500,
    color: '#374151',
    background: '#f3f4f6',
    border: '1px solid #e5e7eb',
    borderRadius: 5,
    padding: '4px 10px',
    cursor: 'pointer',
  }

  const iconButtonStyle = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 28,
    height: 28,
    color: '#6b7280',
    background: 'transparent',
    border: '1px solid transparent',
    borderRadius: 5,
    cursor: 'pointer',
  }

  const inputStyle = {
    flex: 1,
    fontSize: 13,
    padding: '5px 8px',
    border: '1px solid #d1d5db',
    borderRadius: 4,
    outline: 'none',
  }

  const textButtonStyle = {
    fontSize: 12,
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    padding: '2px 6px',
  }

  return (
    <div
      style={{
        position: 'fixed',
        right: 0,
        top: 0,
        width: 300,
        height: '100vh',
        borderLeft: '1px solid #e5e7eb',
        background: '#fafafa',
        display: visible ? 'flex' : 'none',
        flexDirection: 'column',
        boxSizing: 'border-box',
        zIndex: 30,
      }}
    >
      <div style={headerStyle}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={titleStyle}>文件管理</div>
          <div style={countStyle}>{files.length} 个文件</div>
        </div>
        <button
          type="button"
          onClick={() => setCreatingFolder(true)}
          style={ghostButtonStyle}
          onMouseEnter={(e) => { e.currentTarget.style.background = '#e5e7eb' }}
          onMouseLeave={(e) => { e.currentTarget.style.background = '#f3f4f6' }}
        >
          新建文件夹
        </button>
        <button
          type="button"
          onClick={onClose}
          style={iconButtonStyle}
          onMouseEnter={(e) => { e.currentTarget.style.background = '#f3f4f6'; e.currentTarget.style.borderColor = '#e5e7eb' }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = 'transparent' }}
        >
          <CloseIcon />
        </button>
      </div>

      {creatingFolder && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 12px',
            borderBottom: '1px solid #e5e7eb',
            background: '#ffffff',
          }}
        >
          <FolderIcon />
          <input
            autoFocus
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                handleCreateFolder()
              } else if (e.key === 'Escape') {
                handleCancelCreate()
              }
            }}
            placeholder="文件夹名称"
            style={inputStyle}
          />
          <button type="button" onClick={handleCreateFolder} style={{ ...textButtonStyle, color: '#2563eb' }}>确认</button>
          <button type="button" onClick={handleCancelCreate} style={{ ...textButtonStyle, color: '#6b7280' }}>取消</button>
        </div>
      )}

      <div onClick={() => setSelectedKey(null)} style={listContainerStyle}>
        {loading ? (
          <div style={{ textAlign: 'center', color: '#6b7280', padding: 32, fontSize: 13 }}>加载中...</div>
        ) : !hasContent ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: 40, color: '#6b7280', fontSize: 13 }}>
            <EmptyIcon />
            <span>暂无文件</span>
          </div>
        ) : (
          <>
            {tree.files.map((f) => (
              <FileRow
                key={f.key}
                file={f}
                depth={0}
                isSelected={selectedKey === f.key}
                onSelect={(key) => setSelectedKey(key)}
                downloadFile={downloadFile}
                onAddToConversation={onAddToConversation}
                onStartMove={setMovingFileKey}
                moving={movingFileKey === f.key}
                folders={folders}
                onMove={handleMove}
                onCancelMove={() => setMovingFileKey(null)}
                added={contextFileKeys.has(f.key)}
                onDelete={deleteFile}
                deletingFilePath={deletingFilePath}
                setDeletingFilePath={setDeletingFilePath}
              />
            ))}
            {Object.entries(tree.subdirs).map(([subname, subnode]) => (
              <TreeFolder
                key={subname}
                name={subname}
                fullPath={subname}
                node={subnode}
                depth={0}
                expanded={expanded}
                toggle={toggle}
                downloadFile={downloadFile}
                removeFolder={removeFolder}
                onAddToConversation={onAddToConversation}
                onStartMove={setMovingFileKey}
                movingFileKey={movingFileKey}
                folders={folders}
                onMove={handleMove}
                onCancelMove={() => setMovingFileKey(null)}
                contextFileKeys={contextFileKeys}
                deletingFolderPath={deletingFolderPath}
                setDeletingFolderPath={setDeletingFolderPath}
                onDelete={deleteFile}
                deletingFilePath={deletingFilePath}
                setDeletingFilePath={setDeletingFilePath}
              />
            ))}
          </>
        )}
      </div>
    </div>
  )
}

export default FilePanel
