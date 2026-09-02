// 全局文件管理面板：布局内右侧伸缩停靠板（常驻挂载，默认展开，登录后可直接
// 使用；收起时宽度归零不占空间，主对话区以 flex-1 延展占满）。AppTopbar 的
// 右缘 panel 开关负责展开/收起，左缘手柄可拖拽调宽（280–560px）。
// 树形展示已拆至 FileTree.tsx；本文件只负责容器状态编排与预览弹窗。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { Folder, X } from 'lucide-react';
import { type FileEntry, type FilesApi } from '../../hooks/useFiles';
import { processDocument } from '../../api/process';
import { listDocumentUnits } from '../../api/documents';
import { FilePreviewModal } from '../FilePreviewModal';
import { buildTree, normalizeMoveDirectory } from '../../lib/fileTree';
import { FileTree, type ContainerUnitsState, type TreeCallbacks } from './FileTree';
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
  /** 复核弹窗关闭后的刷新令牌： App 递增时重拉已展开单据组的子单据清单
   *  （复核确认/更正后，unit 行的复核状态徽标需要跟上）。 */
  batchRefreshToken?: number;
}

export function FileDrawer(props: FileDrawerProps) {
  const {
    open, onClose, onAddToConversation, contextFileKeys, filesApi, uploadQueue,
    onOpenBindings, batchRefreshToken = 0,
  } = props;
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

  // -- 单据组(container)子单据层级： 展开态 + 懒加载缓存（key = container
  //    docId）。面板常驻挂载，展开记忆在会话内自然保留；每次展开都重拉
  //    （刷新中保留旧清单做 stale-while-revalidate，失败可重试）。 --
  const [expandedContainers, setExpandedContainers] = useState<Set<string>>(() => new Set());
  const [containerUnits, setContainerUnits] = useState<Record<string, ContainerUnitsState>>({});
  // 展开集合的 ref 镜像： 刷新令牌 effect 与 toggle 判定读取最新值，避免
  // 依赖数组引入整集合导致 effect 频繁重挂。
  const expandedContainersRef = useRef(expandedContainers);
  useEffect(() => {
    expandedContainersRef.current = expandedContainers;
  }, [expandedContainers]);
  // 缓存 ref 镜像： 进度轮询 tick 内读最新缓存计算轮询目标，同理避免
  // useCallback 依赖整缓存对象。
  const containerUnitsRef = useRef(containerUnits);
  useEffect(() => {
    containerUnitsRef.current = containerUnits;
  }, [containerUnits]);

  /** 拉取某 container 的子单据清单。silent=true 供进度轮询复用： 不把状态
   *  翻成 loading（避免展开行的「刷新中」每 4s 闪烁）、失败静默保留旧缓存
   *  下一轮再试；手动展开/重试走非静默路径，保留既有加载/失败反馈。 */
  const loadContainerUnits = useCallback(async (docId: string, opts?: { silent?: boolean }) => {
    const silent = opts?.silent === true;
    if (!silent) {
      setContainerUnits((prev) => ({
        ...prev,
        [docId]: { status: 'loading', units: prev[docId]?.units ?? [] },
      }));
    }
    try {
      const units = await listDocumentUnits(docId);
      setContainerUnits((prev) => ({ ...prev, [docId]: { status: 'ready', units } }));
    } catch (e) {
      if (!silent) {
        setContainerUnits((prev) => ({
          ...prev,
          [docId]: {
            status: 'error',
            units: prev[docId]?.units ?? [],
            error: e instanceof Error ? e.message : '加载失败',
          },
        }));
      }
    }
  }, []);

  const toggleContainerUnits = useCallback(
    (docId: string) => {
      const opening = !expandedContainersRef.current.has(docId);
      setExpandedContainers((prev) => {
        const next = new Set(prev);
        if (next.has(docId)) next.delete(docId);
        else next.add(docId);
        return next;
      });
      if (opening) void loadContainerUnits(docId);
    },
    [loadContainerUnits],
  );

  const reloadContainerUnits = useCallback(
    (docId: string) => {
      void loadContainerUnits(docId);
    },
    [loadContainerUnits],
  );

  // 复核弹窗关闭后(App 递增令牌)： 重拉所有已展开 container 的子单据，
  // 让 unit 行的复核状态徽标跟上弹窗内的确认/更正结果。
  useEffect(() => {
    if (!batchRefreshToken) return;
    for (const docId of expandedContainersRef.current) void loadContainerUnits(docId);
  }, [batchRefreshToken, loadContainerUnits]);

  // -- 解析进度轮询： 解析常耗时数分钟（拼贴 PDF 实测 >900s），抽屉展开
  //    期间用 4s 轮询让行内进度可见。定时器仅在「抽屉开 + 存在进行中解析」
  //    时存在： 进行中 = 任一文件 parseStatus='parsing' / 本地刚触发解析
  //    （parsingDocIds，覆盖 /api/files 尚未翻成 parsing 的窗口）/ 任一已
  //    缓存 container 存在未终态子单据。全部空闲或抽屉收起即拆除定时器，
  //    网络行为与现状零差异（FileDrawer 常驻挂载，必须以 open 为门）。 --
  const filesParsing = files.some((f) => f.parseStatus === 'parsing');
  const unitsParsing = Object.values(containerUnits).some((s) =>
    s.units.some((u) => u.unitStatus === 'pending' || u.unitStatus === 'processing'),
  );
  const progressPollActive =
    open && (filesParsing || parsingDocIds.size > 0 || unitsParsing);

  /** 一轮进度轮询： 拉一次 /api/files（整表替换但 keys 稳定，排序由服务端
   *  rank 持有，选中/展开态在组件 state 里不受影响），再静默拉取相关
   *  container 的子单据。目标优先级： 缓存未终态 > 容器仍在 parsing >
   *  已展开（展开行实时刷新状态徽标）；每轮上限 8 个防多容器并发刷屏。
   *  页面隐藏时整轮跳过；上一轮未返回时跳过本轮，避免请求堆叠。 */
  const tickBusyRef = useRef(false);
  const runProgressTick = useCallback(async () => {
    if (tickBusyRef.current || document.visibilityState === 'hidden') return;
    tickBusyRef.current = true;
    try {
      const fresh = await refresh();
      const freshFiles = fresh ?? [];
      const nonTerminal: string[] = [];
      for (const [docId, s] of Object.entries(containerUnitsRef.current)) {
        if (
          s.units.some((u) => u.unitStatus === 'pending' || u.unitStatus === 'processing')
        ) {
          nonTerminal.push(docId);
        }
      }
      const parsingContainers: string[] = [];
      for (const f of freshFiles) {
        if (f.batchRole === 'container' && f.docId && f.parseStatus === 'parsing') {
          parsingContainers.push(f.docId);
        }
      }
      const targets = [
        ...new Set([...nonTerminal, ...parsingContainers, ...expandedContainersRef.current]),
      ];
      for (const docId of targets.slice(0, 8)) {
        void loadContainerUnits(docId, { silent: true });
      }
    } finally {
      tickBusyRef.current = false;
    }
  }, [refresh, loadContainerUnits]);

  useEffect(() => {
    if (!progressPollActive) return;
    // 激活即跑一轮（抽屉展开/解析刚触发时立刻探一次），之后每 4s 一拍。
    void runProgressTick();
    const id = window.setInterval(() => void runProgressTick(), 4000);
    return () => window.clearInterval(id);
  }, [progressPollActive, runProgressTick]);

  // -- 已耗时秒表（单一共享时钟，2026-09-02 修复「停在 0 秒」事故）： 行内
  //    已耗时读数需要每秒走字，但不能每行一个定时器、也不能在渲染期调
  //    Date.now（react purity）。此处仅一枚 1s interval，激活条件与进度
  //    轮询完全一致（抽屉开 + 存在进行中的解析），经 TreeCallbacks.nowMs
  //    下发驱动行重渲染；全部空闲或抽屉收起即拆除，空闲行不显示读数、
  //    不产生任何额外请求。 --
  const [nowMs, setNowMs] = useState(0);
  useEffect(() => {
    if (!progressPollActive) return;
    // 激活帧不立即写时钟（行读数在首拍前由锚点基线 baseSec 正确显示），
    // 之后每秒一拍；interval 回调属异步上下文，不触发 set-state-in-effect。
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [progressPollActive]);

  const tree = useMemo(() => buildTree(files, folders), [files, folders]);

  // Esc 关闭抽屉。文件夹命名输入中的 Esc 由输入框自行消费（stopPropagation）。
  // 顶层 modal（全局复核弹窗等 role=dialog 元素）打开时让给 modal 自己的
  // Esc 处理： 两侧都是 document 级监听、触发顺序无法保证，此处只退避，
  // 避免「关弹窗连带收起抽屉」。
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      onClose();
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
    containerUnits,
    expandedContainers,
    nowMs,
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
    toggleContainerUnits,
    reloadContainerUnits,
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
      id="file-management-panel"
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
