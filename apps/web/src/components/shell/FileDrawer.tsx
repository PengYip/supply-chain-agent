// 全局文件管理抽屉：右侧滑入 + 遮罩，任意视图可从 AppTopbar 唤起。
// 树形展示已拆至 FileTree.tsx；本文件只负责容器状态编排与预览弹窗。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Folder, X } from 'lucide-react';
import { type FileEntry, type FilesApi } from '../../hooks/useFiles';
import { processDocument } from '../../api/process';
import { FilePreviewModal } from '../FilePreviewModal';
import { buildTree, FileTree, type TreeCallbacks } from './FileTree';

interface FileDrawerProps {
  open: boolean;
  onClose: () => void;
  onAddToConversation: (file: FileEntry) => void;
  contextFileKeys: Set<string>;
  /** Shared file list owned by App (upload + drawer share one useFiles). */
  filesApi: FilesApi;
  /** 「未绑定」徽标跳转绑定工作台的通道（App 分配 nonce 并导航）。 */
  onOpenBindings?: (docId: string) => void;
}

export function FileDrawer(props: FileDrawerProps) {
  const { open, onClose, onAddToConversation, contextFileKeys, filesApi, onOpenBindings } = props;
  const {
    files, folders, loading, downloadFile, moveFile, createFolder,
    removeFolder, deleteFile, refresh,
  } = filesApi;
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [movingFileKey, setMovingFileKey] = useState<string | null>(null);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [deletingFolderPath, setDeletingFolderPath] = useState<string | null>(null);
  const [deletingFilePath, setDeletingFilePath] = useState<string | null>(null);
  const [previewingFile, setPreviewingFile] = useState<FileEntry | null>(null);
  // 徽标点击触发的解析：processDocument 是同步 HTTP（跑完返回终态），期间用
  // 该集合把对应行的徽标翻成「解析中」；无论成败都 refresh 反映落库状态。
  const [parsingDocIds, setParsingDocIds] = useState<Set<string>>(() => new Set());

  const triggerParse = useCallback(
    async (docId: string) => {
      setParsingDocIds((prev) => {
        const next = new Set(prev);
        next.add(docId);
        return next;
      });
      try {
        await processDocument(docId);
      } catch (e) {
        console.error('triggerParse failed:', e);
      } finally {
        setParsingDocIds((prev) => {
          const next = new Set(prev);
          next.delete(docId);
          return next;
        });
        void refresh();
      }
    },
    [refresh],
  );

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

  const callbacks: TreeCallbacks = {
    folders,
    contextFileKeys,
    parsingDocIds,
    selectedKey,
    movingFileKey,
    deletingFolderPath,
    deletingFilePath,
    downloadFile,
    removeFolder,
    deleteFile,
    onPreview: setPreviewingFile,
    onAddToConversation,
    onSelect: setSelectedKey,
    onStartMove: setMovingFileKey,
    onCancelMove: () => setMovingFileKey(null),
    onMove: (key, directory) => moveFile(key, directory),
    setDeletingFolderPath,
    setDeletingFilePath,
    onOpenBindings,
    onTriggerParse: triggerParse,
  };

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
            <FileTree tree={tree} expanded={expanded} toggle={toggle} cb={callbacks} />
          )}
        </div>

        {previewingFile && <FilePreviewModal file={previewingFile} onClose={() => setPreviewingFile(null)} />}
      </aside>
    </>
  );
}

export default FileDrawer;
