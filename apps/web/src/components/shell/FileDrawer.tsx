import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { ChevronRight, FileText, Folder, FolderOpen, X } from 'lucide-react';
import { type FileEntry, type FileFolder, type FilesApi } from '../../hooks/useFiles';
import { FilePreviewModal } from '../FilePreviewModal';

interface FileDrawerProps {
  open: boolean;
  onClose: () => void;
  onAddToConversation: (file: FileEntry) => void;
  contextFileKeys: Set<string>;
  /** Shared file list owned by App (upload + drawer share one useFiles). */
  filesApi: FilesApi;
}

interface TreeNode {
  files: FileEntry[];
  subdirs: Record<string, TreeNode>;
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function pathSegments(p: string | undefined): string[] {
  if (!p) return [];
  return p.split('/').map((s) => s.trim()).filter((s) => s.length > 0);
}

function buildTree(files: FileEntry[], folders: FileFolder[]): TreeNode {
  const root: TreeNode = { files: [], subdirs: {} };
  const getOrCreate = (segs: string[]): TreeNode => {
    let node = root;
    for (const seg of segs) {
      if (!node.subdirs[seg]) node.subdirs[seg] = { files: [], subdirs: {} };
      node = node.subdirs[seg];
    }
    return node;
  };
  for (const folder of folders) getOrCreate(pathSegments(folder.path));
  for (const file of files) getOrCreate(pathSegments(file.directory)).files.push(file);
  return root;
}

function normalizeMoveDirectory(directory: string): string {
  return directory
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join('/');
}

/** 文件行的解析状态徽标。null（无解析记录）不渲染。uploaded/parsing 均显示
 *  未解析，等服务端解析结束后翻转为终态。 */
function parseBadge(
  parseStatus: FileEntry['parseStatus'],
): { text: string; className: string } | null {
  switch (parseStatus) {
    case 'uploaded':
    case 'parsing':
      return { text: '未解析', className: 'bg-surface text-ink-soft' };
    case 'parsed':
      return { text: '已解析', className: 'bg-success/10 text-success' };
    case 'needs_ocr':
      return { text: '需OCR', className: 'bg-warning/10 text-warning' };
    case 'failed':
      return { text: '解析失败', className: 'bg-danger/10 text-danger' };
    default:
      return null;
  }
}

/** 行内动作链接的统一样式（下载/预览/添加到对话/移动/删除共用）。 */
function actionLinkClass(tone: 'primary' | 'danger' = 'primary') {
  return clsx(
    'cursor-pointer rounded px-1 py-0.5 text-[11px] whitespace-nowrap transition-colors',
    tone === 'danger' ? 'text-danger hover:bg-danger/5' : 'text-primary hover:bg-primary/10',
  );
}

function MoveDropdown({
  file,
  folders,
  onMove,
  onClose,
}: {
  file: FileEntry;
  folders: FileFolder[];
  onMove: (key: string, directory: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [onClose]);

  const current = normalizeMoveDirectory(file.directory);

  return (
    <div
      ref={ref}
      onClick={(e) => e.stopPropagation()}
      className="absolute right-0 top-full z-20 mt-1 min-w-[170px] rounded-md border border-line bg-white py-1 shadow-pop"
    >
      {folders.length === 0 ? (
        <div className="px-3 py-2 text-xs text-ink-soft">暂无文件夹，请先新建</div>
      ) : (
        <>
          <div
            onClick={() => { onMove(file.key, ''); onClose(); }}
            className="cursor-pointer whitespace-nowrap px-3 py-1.5 text-xs text-ink hover:bg-surface"
          >
            根目录
            {current === '' && <span className="ml-2 text-ink-soft">当前</span>}
          </div>
          {folders.map((folder) => {
            const isCurrent = folder.path === current;
            return (
              <div
                key={folder.id}
                onClick={() => { onMove(file.key, folder.path); onClose(); }}
                className="cursor-pointer whitespace-nowrap px-3 py-1.5 text-xs text-ink hover:bg-surface"
              >
                {folder.path}
                {isCurrent && <span className="ml-2 text-ink-soft">当前</span>}
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

function DeleteConfirmOverlay({
  message,
  onConfirm,
  onCancel,
}: {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onCancel();
      }
    }
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [onCancel]);

  return (
    <div
      ref={ref}
      onClick={(e) => e.stopPropagation()}
      className="absolute right-2 top-full z-20 mt-1 flex items-center gap-2 whitespace-nowrap rounded-md border border-line bg-white px-2.5 py-1.5 text-[11px] shadow-pop"
    >
      <span className="text-ink-soft">{message}</span>
      <span onClick={onConfirm} className="cursor-pointer font-medium text-danger">
        确定
      </span>
      <span onClick={onCancel} className="cursor-pointer text-ink-soft">
        取消
      </span>
    </div>
  );
}

function FileRow(props: {
  file: FileEntry;
  depth: number;
  isSelected: boolean;
  onSelect: (key: string) => void;
  downloadFile: (key: string) => void;
  onPreview: (file: FileEntry) => void;
  onAddToConversation: (file: FileEntry) => void;
  onStartMove: (key: string) => void;
  moving: boolean;
  folders: FileFolder[];
  onMove: (key: string, directory: string) => void;
  onCancelMove: () => void;
  added: boolean;
  onDelete: (key: string) => void;
  deletingFilePath: string | null;
  setDeletingFilePath: (key: string | null) => void;
}) {
  const {
    file,
    depth,
    isSelected,
    onSelect,
    downloadFile,
    onPreview,
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
  } = props;
  const badge = parseBadge(file.parseStatus);
  // 动作区在 hover / 移动中 / 删除确认中保持可见
  const showActions = moving || deletingFilePath === file.key;

  return (
    <div
      onClick={() => onSelect(file.key)}
      className={clsx(
        'group relative flex cursor-pointer items-center border-b border-line/60 pr-3 text-sm text-ink transition-colors',
        isSelected ? 'bg-primary/5' : 'hover:bg-surface',
      )}
      style={{ paddingLeft: 12 + depth * 14, paddingTop: 7, paddingBottom: 7 }}
    >
      <div className="flex w-[18px] shrink-0 items-center justify-center text-ink-soft">
        <FileText className="h-4 w-4" aria-hidden />
      </div>
      <span
        title={file.name}
        className="line-clamp-2 ml-2 min-w-0 flex-1 [overflow-wrap:anywhere]"
      >
        {file.name}
      </span>
      {badge && (
        <span className={clsx('shrink-0 whitespace-nowrap rounded px-1.5 py-px text-[10px]', badge.className)}>
          {badge.text}
        </span>
      )}
      <span className="mr-2 hidden shrink-0 whitespace-nowrap text-[11px] text-ink-soft group-hover:inline">
        {formatSize(file.size)}
      </span>
      <div
        onClick={(e) => e.stopPropagation()}
        className={clsx('items-center gap-1.5 whitespace-nowrap', showActions ? 'flex' : 'hidden group-hover:flex')}
      >
        <span onClick={() => downloadFile(file.key)} className={actionLinkClass()}>
          下载
        </span>
        <span onClick={(e) => { e.stopPropagation(); onPreview(file); }} className={actionLinkClass()}>
          预览
        </span>
        {added ? (
          <span className="px-1 py-0.5 text-[11px] text-success">已添加</span>
        ) : (
          <span onClick={() => onAddToConversation(file)} className={actionLinkClass()}>
            添加到对话
          </span>
        )}
        <span onClick={() => onStartMove(file.key)} className={actionLinkClass()}>
          移动
        </span>
        <span
          onClick={(e) => { e.stopPropagation(); setDeletingFilePath(file.key); }}
          className={actionLinkClass('danger')}
        >
          删除
        </span>
      </div>
      {moving && <MoveDropdown file={file} folders={folders} onMove={onMove} onClose={onCancelMove} />}
      {deletingFilePath === file.key && (
        <DeleteConfirmOverlay
          message="删除文件？"
          onConfirm={() => { onDelete(file.key); setDeletingFilePath(null); }}
          onCancel={() => setDeletingFilePath(null)}
        />
      )}
    </div>
  );
}

interface TreeFolderProps {
  name: string;
  fullPath: string;
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  toggle: (path: string) => void;
  downloadFile: (key: string) => void;
  removeFolder: (path: string) => void;
  onPreview: (file: FileEntry) => void;
  onAddToConversation: (file: FileEntry) => void;
  onStartMove: (key: string) => void;
  movingFileKey: string | null;
  folders: FileFolder[];
  onMove: (key: string, directory: string) => void;
  onCancelMove: () => void;
  contextFileKeys: Set<string>;
  deletingFolderPath: string | null;
  setDeletingFolderPath: (path: string | null) => void;
  onDelete: (key: string) => void;
  deletingFilePath: string | null;
  setDeletingFilePath: (key: string | null) => void;
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
    onPreview,
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
  } = props;
  const isOpen = expanded.has(fullPath);
  const hasChildren = node.files.length > 0 || Object.keys(node.subdirs).length > 0;

  return (
    <div>
      <div
        onClick={() => toggle(fullPath)}
        className="group relative flex cursor-pointer items-center border-b border-line/60 pr-3 text-sm text-ink transition-colors hover:bg-surface"
        style={{ paddingLeft: 12 + depth * 14, paddingTop: 7, paddingBottom: 7 }}
      >
        <span
          onClick={(e) => { e.stopPropagation(); toggle(fullPath); }}
          className="mr-1 flex w-[18px] shrink-0 items-center justify-center"
        >
          {hasChildren ? (
            <ChevronRight
              className={clsx('h-3.5 w-3.5 text-ink-soft transition-transform', isOpen && 'rotate-90')}
              aria-hidden
            />
          ) : (
            <span className="w-3.5" />
          )}
        </span>
        {isOpen ? (
          <FolderOpen className="h-4 w-4 shrink-0 text-warning" aria-hidden />
        ) : (
          <Folder className="h-4 w-4 shrink-0 text-warning" aria-hidden />
        )}
        <span title={name} className="line-clamp-2 ml-2 min-w-0 flex-1 font-medium [overflow-wrap:anywhere]">
          {name}
        </span>
        <span
          onClick={(e) => { e.stopPropagation(); setDeletingFolderPath(fullPath); }}
          className="hidden cursor-pointer rounded px-1 py-0.5 text-[11px] text-danger transition-colors hover:bg-danger/5 group-hover:inline"
        >
          删除
        </span>
        {deletingFolderPath === fullPath && (
          <DeleteConfirmOverlay
            message="移除文件夹？(文件不删)"
            onConfirm={() => { removeFolder(fullPath); setDeletingFolderPath(null); }}
            onCancel={() => setDeletingFolderPath(null)}
          />
        )}
      </div>
      {isOpen && (
        <div className="ml-5 border-l border-line pl-2">
          {node.files.length === 0 && Object.keys(node.subdirs).length === 0 && (
            <div className="px-3 py-1.5 text-xs text-ink-soft">（空）</div>
          )}
          {node.files.map((f) => (
            <FileRow
              key={f.key}
              file={f}
              depth={depth + 1}
              isSelected={false}
              onSelect={() => {}}
              downloadFile={downloadFile}
              onPreview={onPreview}
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
              onPreview={onPreview}
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
  );
}

/** 全局文件抽屉：右侧滑入 + 遮罩，任意视图可从 AppTopbar 唤起。
 *  内容迁移自 FilePanel（树形列表/移动/删除/预览逻辑不变，样式 Tailwind 化）。 */
export function FileDrawer(props: FileDrawerProps) {
  const { open, onClose, onAddToConversation, contextFileKeys, filesApi } = props;
  const { files, folders, loading, downloadFile, moveFile, createFolder, removeFolder, deleteFile } = filesApi;
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [movingFileKey, setMovingFileKey] = useState<string | null>(null);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [deletingFolderPath, setDeletingFolderPath] = useState<string | null>(null);
  const [deletingFilePath, setDeletingFilePath] = useState<string | null>(null);
  const [previewingFile, setPreviewingFile] = useState<FileEntry | null>(null);

  const tree = useMemo(() => buildTree(files, folders), [files, folders]);

  // 关闭时清空所有临态（选中/移动/删除确认/新建输入/预览）
  useEffect(() => {
    if (!open) {
      setMovingFileKey(null);
      setDeletingFolderPath(null);
      setDeletingFilePath(null);
      setCreatingFolder(false);
      setSelectedKey(null);
      setPreviewingFile(null);
    }
  }, [open]);

  // Esc 关闭抽屉。文件夹命名输入中的 Esc 由输入框自行消费（stopPropagation）。
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const toggle = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const handleCreateFolder = () => {
    const name = newFolderName.trim();
    if (!name) return;
    createFolder(name);
    setNewFolderName('');
    setCreatingFolder(false);
  };

  const handleCancelCreate = () => {
    setCreatingFolder(false);
    setNewFolderName('');
  };

  const hasContent = files.length > 0 || folders.length > 0;

  return (
    <>
      {/* 遮罩：点击关闭 */}
      <div className="animate-fade-in fixed inset-0 z-40 bg-ink/30" onClick={onClose} />
      <aside className="animate-slide-in-right fixed inset-y-0 right-0 z-drawer flex w-[360px] max-w-[90vw] flex-col border-l border-line bg-white">
        {/* 头部：标题 + 新建文件夹 + 关闭 */}
        <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-3">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold leading-tight text-ink">文件管理</div>
            <div className="text-[11px] text-ink-soft">{files.length} 个文件</div>
          </div>
          <button
            type="button"
            onClick={() => setCreatingFolder(true)}
            className="rounded-md border border-line bg-surface px-2.5 py-1 text-xs font-medium text-ink transition-colors hover:border-ink-soft/30"
          >
            新建文件夹
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭文件抽屉"
            className="flex h-7 w-7 items-center justify-center rounded-md text-ink-soft transition-colors hover:bg-surface hover:text-ink"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        {/* 新建文件夹输入 */}
        {creatingFolder && (
          <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
            <Folder className="h-4 w-4 shrink-0 text-warning" aria-hidden />
            <input
              autoFocus
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleCreateFolder();
                } else if (e.key === 'Escape') {
                  // 仅取消命名，不冒泡触发抽屉关闭
                  e.preventDefault();
                  e.stopPropagation();
                  handleCancelCreate();
                }
              }}
              placeholder="文件夹名称"
              className="min-w-0 flex-1 rounded border border-line px-2 py-1 text-sm outline-none focus:border-primary"
            />
            <button type="button" onClick={handleCreateFolder} className="px-1.5 text-xs text-primary hover:underline">
              确认
            </button>
            <button type="button" onClick={handleCancelCreate} className="px-1.5 text-xs text-ink-soft hover:underline">
              取消
            </button>
          </div>
        )}

        {/* 文件树 */}
        <div className="flex-1 overflow-y-auto" onClick={() => setSelectedKey(null)}>
          {loading ? (
            <div className="p-8 text-center text-sm text-ink-soft">加载中...</div>
          ) : !hasContent ? (
            <div className="flex flex-col items-center p-10 text-sm text-ink-soft">
              <Folder className="mb-2 h-10 w-10 text-line" aria-hidden />
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
                  onPreview={setPreviewingFile}
                  onAddToConversation={onAddToConversation}
                  onStartMove={setMovingFileKey}
                  moving={movingFileKey === f.key}
                  folders={folders}
                  onMove={(key, directory) => moveFile(key, directory)}
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
                  onPreview={setPreviewingFile}
                  onAddToConversation={onAddToConversation}
                  onStartMove={setMovingFileKey}
                  movingFileKey={movingFileKey}
                  folders={folders}
                  onMove={(key, directory) => moveFile(key, directory)}
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

        {previewingFile && <FilePreviewModal file={previewingFile} onClose={() => setPreviewingFile(null)} />}
      </aside>
    </>
  );
}

export default FileDrawer;
