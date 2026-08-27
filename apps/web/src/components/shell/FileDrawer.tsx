// 全局文件管理抽屉：右侧滑入 + 遮罩，任意视图可从 AppTopbar 唤起。
// 树形展示已拆至 FileTree.tsx；本文件只负责容器状态编排与预览弹窗。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Folder, X } from 'lucide-react';
import { type FileEntry, type FilesApi } from '../../hooks/useFiles';
import { processDocument } from '../../api/process';
import { FilePreviewModal } from '../FilePreviewModal';
import { buildTree, normalizeMoveDirectory } from '../../lib/fileTree';
import { FileTree, type TreeCallbacks } from './FileTree';
import { readPayload, useFileDnd, type DropTarget } from '../../hooks/useFileDnd';
import {
  collectDropItems,
  useFolderDropUpload,
} from '../../hooks/useFolderDropUpload';

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
    removeFolder, renameFolderPath, deleteFile, refresh,
  } = filesApi;
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [movingFileKey, setMovingFileKey] = useState<string | null>(null);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [deletingFolderPath, setDeletingFolderPath] = useState<string | null>(null);
  const [deletingFilePath, setDeletingFilePath] = useState<string | null>(null);
  const [previewingFile, setPreviewingFile] = useState<FileEntry | null>(null);
  // 正在命名子文件夹的目录路径（null = 输入行关闭）
  const [creatingInDir, setCreatingInDir] = useState<string | null>(null);
  // 行内重命名中的文件夹路径（null = 关闭）
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  // 面板内部拖拽移动状态机
  const dnd = useFileDnd();

  // -- 停靠面板宽度（左缘手柄拖拽，280–560px，记忆于 localStorage） --
  const PANEL_MIN = 280;
  const PANEL_MAX = 560;
  const [panelWidth, setPanelWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem('sca.filesPanelWidth'));
    return Number.isFinite(saved) && saved >= PANEL_MIN && saved <= PANEL_MAX ? saved : 360;
  });
  useEffect(() => {
    if (!open) return;
    let startW = 0;
    let startX = 0;
    const onMove = (e: MouseEvent) => {
      const next = Math.min(PANEL_MAX, Math.max(PANEL_MIN, startW + (startX - e.clientX)));
      setPanelWidth(next);
    };
    const onUp = (e: MouseEvent) => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
      const next = Math.min(PANEL_MAX, Math.max(PANEL_MIN, startW + (startX - e.clientX)));
      localStorage.setItem('sca.filesPanelWidth', String(next));
    };
    const onDown = (e: MouseEvent) => {
      startW = panelWidth;
      startX = e.clientX;
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      e.preventDefault();
    };
    const handle = document.getElementById('files-panel-resize-handle');
    handle?.addEventListener('mousedown', onDown);
    return () => {
      handle?.removeEventListener('mousedown', onDown);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
    };
  }, [open, panelWidth]);

  /** 上传队列：先把层级里的缺失目录补齐，再逐个串行上传。 */
  const uploadQueue = useFolderDropUpload({
    ensureDirs: useCallback(
      async (dirs: string[]) => {
        const have = new Set(folders.map((f) => f.path));
        for (const d of dirs) {
          if (!have.has(d)) {
            await createFolder(d);
            have.add(d);
          }
        }
      },
      [folders, createFolder],
    ),
    onDone: () => void refresh(),
  });

  const handleDropFiles = useCallback(
    (dt: DataTransfer, targetDir: DropTarget) => {
      void collectDropItems(dt).then((items) => {
        if (items.length > 0) void uploadQueue.enqueue(items, targetDir);
      });
    },
    [uploadQueue],
  );

  const basenameOf = (p: string) => p.split('/').filter(Boolean).pop() ?? p;

  /** 拖拽/重命名共用的父目录数学：from 移入 toParent（''=根）。 */
  const moveFolderInto = useCallback(
    async (from: string, toParent: string) => {
      const base = basenameOf(from);
      const to = toParent ? `${toParent}/${base}` : base;
      if (to === from) return;
      try {
        await renameFolderPath(from, to);
      } catch (e) {
        console.error('move folder failed:', e);
      }
    },
    [renameFolderPath],
  );

  const handleRootDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const payload = readPayload(e);
      if (!payload) {
        handleDropFiles(e.dataTransfer, '');
        dnd.clear();
        return;
      }
      if (payload.kind === 'file') {
        void moveFile(payload.key, '');
      } else {
        void moveFolderInto(payload.path, '');
      }
      dnd.clear();
    },
    [moveFile, moveFolderInto, dnd, handleDropFiles],
  );
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
    creatingInDir,
    setCreatingInDir,
    onCreateSubfolder: (parentPath, name) => {
      void createFolder(parentPath ? `${parentPath}/${name}` : name);
    },
    dnd,
    onMoveFile: (key, targetDir) => {
      void moveFile(key, normalizeMoveDirectory(targetDir));
    },
    onMoveFolder: (from, toParent) => {
      void moveFolderInto(from, normalizeMoveDirectory(toParent));
    },
    renamingPath,
    setRenamingPath,
    onRenameFolder: (from, newName) => {
      const idx = from.lastIndexOf('/');
      const parent = idx > 0 ? from.slice(0, idx) : '';
      void renameFolderPath(from, parent ? `${parent}/${newName}` : newName).catch((e) => {
        console.error('rename folder failed:', e);
      });
    },
    onDropFiles: handleDropFiles,
  };

  return (
    <aside
      className="relative flex h-full shrink-0 flex-col border-l border-line bg-white"
      style={{ width: panelWidth, minWidth: 280, maxWidth: 560 }}
      aria-label="文件管理"
    >
      {/* 左缘手柄：拖拽伸缩宽度 */}
      <div
        id="files-panel-resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整面板宽度"
        className="absolute inset-y-0 left-0 z-30 w-1 cursor-col-resize bg-transparent transition-colors hover:bg-primary/40"
      />
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

        {/* 文件树（根区同时是拖拽回根的落点） */}
        <div
          className={`flex-1 overflow-y-auto${dnd.dragging ? ' ring-1 ring-inset ring-primary/30' : ''}`}
          onClick={() => setSelectedKey(null)}
          onDragOver={dnd.onDragOver('')}
          onDragLeave={dnd.onDragLeave('')}
          onDrop={handleRootDrop}
        >
          {dnd.dragging && dnd.dropTarget === '' && (
            <div className="sticky top-0 z-10 border-b border-primary/20 bg-primary/5 px-3 py-1.5 text-center text-[11px] text-primary">
              拖放到此处移到根目录
            </div>
          )}
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

        {/* 上传队列汇总条：进行中或存在失败项时展示 */}
        {(uploadQueue.uploads.length > 0) && (
          <div className="shrink-0 border-t border-line px-3 py-2">
            <div className="flex items-center justify-between text-[11px] text-ink-soft">
              <span>
                {uploadQueue.active
                  ? `上传中 ${uploadQueue.aggregate.done}/${uploadQueue.aggregate.total}`
                  : uploadQueue.aggregate.failed > 0
                    ? '上传完成（有失败项）'
                    : '上传完成'}
              </span>
              {uploadQueue.aggregate.failed > 0 && (
                <span className="text-danger">失败 {uploadQueue.aggregate.failed}</span>
              )}
            </div>
            <div className="mt-1 h-1 overflow-hidden rounded bg-surface">
              <div
                className={`h-full rounded transition-all ${
                  uploadQueue.aggregate.failed > 0 ? 'bg-warning' : 'bg-primary'
                }`}
                style={{
                  width: `${
                    uploadQueue.aggregate.bytesTotal > 0
                      ? Math.round(
                          (uploadQueue.aggregate.bytesLoaded /
                            uploadQueue.aggregate.bytesTotal) *
                            100,
                        )
                      : 0
                  }%`,
                }}
              />
            </div>
            {uploadQueue.uploads
              .filter((u) => u.status === 'failed')
              .map((u) => (
                <div key={u.id} className="mt-1 truncate text-[11px] text-danger" title={u.error}>
                  {u.name}：{u.error ?? '上传失败'}
                </div>
              ))}
          </div>
        )}

        {previewingFile && <FilePreviewModal file={previewingFile} onClose={() => setPreviewingFile(null)} />}
    </aside>
  );
}

export default FileDrawer;
