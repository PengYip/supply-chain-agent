// 全局文件管理面板：布局内右侧伸缩停靠板（常驻挂载，收起时宽度归零不占空间，
// 主对话区以 flex-1 延展占满），任意视图可从 AppTopbar 的「文件」开关唤起，
// 左缘手柄可拖拽调宽（280–560px）。
// 树形展示已拆至 FileTree.tsx；本文件只负责容器状态编排与预览弹窗。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { Folder, X } from 'lucide-react';
import { type FileEntry, type FilesApi } from '../../hooks/useFiles';
import { processDocument } from '../../api/process';
import { FilePreviewModal } from '../FilePreviewModal';
import { buildTree, normalizeMoveDirectory } from '../../lib/fileTree';
import { FileTree, type TreeCallbacks } from './FileTree';
import { readPayload, useFileDnd, type DropTarget } from '../../hooks/useFileDnd';
import { collectDropItems, type UploadQueueApi } from '../../hooks/useFolderDropUpload';

interface FileDrawerProps {
  open: boolean;
  onClose: () => void;
  onAddToConversation: (file: FileEntry) => void;
  contextFileKeys: Set<string>;
  /** Shared file list owned by App (upload + drawer share one useFiles). */
  filesApi: FilesApi;
  /** 上传队列（App 层持有，全页面拖拽与抽屉共用一个实例；汇总条在本组件内消费）。 */
  uploadQueue: UploadQueueApi;
  /** 「未挂合同」徽标跳转绑定工作台的通道（App 分配 nonce 并导航）。 */
  onOpenBindings?: (docId: string) => void;
}

export function FileDrawer(props: FileDrawerProps) {
  const { open, onClose, onAddToConversation, contextFileKeys, filesApi, uploadQueue, onOpenBindings } = props;
  const {
    files, folders, loading, downloadFile, moveFile, createFolder,
    removeFolder, renameFolderPath, reorderFolders, reorderFiles, deleteFile, refresh,
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
    return Number.isFinite(saved) && saved >= PANEL_MIN && saved <= PANEL_MAX ? saved : 320;
  });
  // 拖拽期间不走宽度过渡（动画会追赶鼠标），并以 ref 读当前宽度：
  // 监听只在挂载时绑一次（面板常驻），避免每次 setPanelWidth 都重挂监听
  // 导致拖拽中 mousemove 被拆掉的旧问题。
  const panelWidthRef = useRef(panelWidth);
  // open 镜像到 ref 供挂载一次的监听读取；在 effect 中同步，避免渲染期写 ref。
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  }, [open]);
  const [resizing, setResizing] = useState(false);
  useEffect(() => {
    const handle = document.getElementById('files-panel-resize-handle');
    if (!handle) return;
    const onDown = (e: MouseEvent) => {
      if (!openRef.current) return;
      e.preventDefault();
      setResizing(true);
      const startW = panelWidthRef.current;
      const startX = e.clientX;
      const clamp = (clientX: number) =>
        Math.min(PANEL_MAX, Math.max(PANEL_MIN, startW + (startX - clientX)));
      const onMove = (ev: MouseEvent) => {
        const next = clamp(ev.clientX);
        panelWidthRef.current = next;
        setPanelWidth(next);
      };
      const onUp = (ev: MouseEvent) => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.userSelect = '';
        const next = clamp(ev.clientX);
        panelWidthRef.current = next;
        localStorage.setItem('sca.filesPanelWidth', String(next));
        setResizing(false);
      };
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    };
    handle.addEventListener('mousedown', onDown);
    return () => handle.removeEventListener('mousedown', onDown);
  }, []);

  /** 抽屉内落点上传：收集条目（保层级）后经 App 层队列入队到目标目录。
   *  队列实例由 prop 注入，抽屉关闭不销毁进行中的上传。 */
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
    async (docId: string, opts?: { force?: boolean }) => {
      setParsingDocIds((prev) => {
        const next = new Set(prev);
        next.add(docId);
        return next;
      });
      try {
        // parsed 文档的「重新处理」带 {force:true} 放行服务端终态短路(6b);
        // uploaded/failed 维持既有空请求形状。
        await processDocument(docId, opts?.force ? { force: true } : undefined);
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

  // 常驻挂载：收起态只是宽度归零（见下方 style），不再卸载组件，
  // 内部选中/展开/命名中的状态跨开关保留。
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
    tree,
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
    onReorderFolders: (parentPath, names) => {
      const paths = names.map((n) => (parentPath ? `${parentPath}/${n}` : n));
      void reorderFolders(paths).catch((e) => console.error('reorder folders failed:', e));
    },
    onReorderFiles: (_directory, keys) => {
      void reorderFiles(keys).catch((e) => console.error('reorder files failed:', e));
    },
  };

  return (
    <aside
      className={clsx(
        'relative flex h-full shrink-0 flex-col overflow-hidden bg-white',
        open ? 'border-l border-line' : 'border-l-0',
        // 开关时做 200ms 宽度过渡；手柄拖拽期间直写宽度，关掉过渡避免追赶鼠标
        resizing ? '' : 'transition-[width] duration-200 ease-out',
      )}
      style={{ width: open ? panelWidth : 0 }}
      aria-label="文件管理"
    >
      {/* 左缘手柄：拖拽伸缩宽度（收起时随 overflow-hidden 裁掉，不可命中） */}
      <div
        id="files-panel-resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整面板宽度"
        className="absolute inset-y-0 left-0 z-30 w-1 cursor-col-resize bg-transparent transition-colors hover:bg-primary/40"
      />
      {/* 内容层锁定最小宽：收合动画期间只被裁切、不重排；inert 阻断隐藏态的焦点与读屏 */}
      {/* min-h-0 是嵌套 flex 滚动的关键：flex 子项默认 min-height:auto，
          否则文件树会被内容撑高并绕过 overflow-y-auto 的滚动约束。 */}
      <div
        className="flex min-h-0 w-full flex-1 flex-col"
        style={{ minWidth: PANEL_MIN }}
        inert={!open}
      >
      {/* 头部：标题 + 新建文件夹 + 收起 */}
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
            title="收起文件面板"
            aria-label="收起文件面板"
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
          className={`min-h-0 flex-1 overflow-y-auto overflow-x-hidden${dnd.dragging ? ' ring-1 ring-inset ring-primary/30' : ''}`}
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
              <span className="mt-2 max-w-[230px] text-center text-xs leading-5">
                把合同、发票、提单等文件直接拖到这里即可上传并自动解析；支持整文件夹拖入以保留层级
              </span>
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

        {/* 预览弹窗仅在展开态渲染：收起后残留的 fixed 弹窗会卡在 inert 层无法交互 */}
        {open && previewingFile && (
          <FilePreviewModal file={previewingFile} onClose={() => setPreviewingFile(null)} />
        )}
      </div>
    </aside>
  );
}

export default FileDrawer;
