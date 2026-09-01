// 树形文件列表展示：从 FileDrawer 拆出（行为不变）。
// 包含树构建、行渲染（文件/文件夹）、移动下拉与删除确认浮层。
// 交互回调经单一 callbacks 对象由容器（FileDrawer）下发。
import { useEffect, useRef, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import {
  Check,
  ChevronRight,
  Download,
  Eye,
  FileText,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  MessageSquarePlus,
  Pencil,
  Trash2,
} from 'lucide-react';
import { type FileEntry, type FileFolder } from '../../hooks/useFiles';
import { normalizeMoveDirectory, nodeAt, type TreeNode } from '../../lib/fileTree';
import {
  isFolderSelfDrop,
  readPayload,
  rowZoneFromEvent,
  type DragPayload,
  type DropTarget,
} from '../../hooks/useFileDnd';

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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

/** 行内图标按钮：以可见的图形按钮替代悬浮文字条，避免遮住文件名。
 *  所有按钮都带 aria-label / title；破坏性动作使用 danger 色但保持相同热区。 */
function actionIconButtonClass(tone: 'primary' | 'danger' | 'success' = 'primary') {
  return clsx(
    'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors',
    'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary',
    tone === 'danger'
      ? 'text-danger hover:bg-danger/10'
      : tone === 'success'
        ? 'cursor-not-allowed bg-success/10 text-success'
        : 'text-ink-soft hover:bg-primary/10 hover:text-primary',
  );
}

/** 无 secondary 文案的图标按钮属性。图形含义由 aria-label 补齐。 */
type IconButtonProps = {
  label: string;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  tone?: 'primary' | 'danger' | 'success';
  disabled?: boolean;
  children: ReactNode;
};

function RowIconButton({ label, onClick, tone = 'primary', disabled = false, children }: IconButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      disabled={disabled}
      className={actionIconButtonClass(tone)}
    >
      {children}
    </button>
  );
}

/** 文件/文件夹名列：文件名独占整行，最多折两行展示；hover 浮出完整名称
 *  气泡。气泡锚定在名称列自身的相对定位容器内（left-0 + top-full），宽度
 *  上限 240px，横向不会超出抽屉；滚动容器底缘的极端裁剪场景由保留的原生
 *  title 兜底。气泡为主交互，无 hover 延迟，带 100ms 淡入缩放过渡。 */
function FileNameText({ name, className }: { name: string; className?: string }) {
  return (
    <div className="group/name relative min-w-0">
      <span title={name} className={clsx('line-clamp-2 [overflow-wrap:anywhere]', className)}>
        {name}
      </span>
      <span
        aria-hidden
        className={clsx(
          'pointer-events-none absolute left-0 top-full z-30 mt-1 w-max max-w-[240px] origin-top-left scale-95 rounded-md border border-line bg-white px-2 py-1.5 text-xs text-ink opacity-0 shadow-pop transition duration-100 [overflow-wrap:anywhere]',
          'group-hover/name:scale-100 group-hover/name:opacity-100',
        )}
      >
        {name}
      </span>
    </div>
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

/** 容器（FileDrawer）下发给树的全部数据与回调。 */
export interface TreeCallbacks {
  // 数据
  folders: FileFolder[];
  contextFileKeys: Set<string>;
  parsingDocIds: Set<string>;
  tree: TreeNode;
  // 临态高亮
  selectedKey: string | null;
  movingFileKey: string | null;
  deletingFolderPath: string | null;
  deletingFilePath: string | null;
  // 回调
  downloadFile: (key: string) => void;
  removeFolder: (path: string) => void;
  deleteFile: (key: string) => void;
  onPreview: (file: FileEntry) => void;
  onAddToConversation: (file: FileEntry) => void;
  onSelect: (key: string) => void;
  onStartMove: (key: string) => void;
  onCancelMove: () => void;
  onMove: (key: string, directory: string) => void;
  setDeletingFolderPath: (path: string | null) => void;
  setDeletingFilePath: (key: string | null) => void;
  onOpenBindings?: (docId: string) => void;
  /** 触发解析: parsed 状态的重新处理需带 {force:true}(服务端终态短路放行)。 */
  onTriggerParse?: (docId: string, opts?: { force?: boolean }) => void;
  // 子文件夹创建：creatingInDir 标记正在命名的目录（null 关闭输入行）
  creatingInDir: string | null;
  setCreatingInDir: (path: string | null) => void;
  onCreateSubfolder: (parentPath: string, name: string) => void;
  // 拖拽移动（内部载荷）
  dnd: {
    dragging: DragPayload | null;
    dropTarget: DropTarget | null;
    onDragStart: (payload: DragPayload) => (e: React.DragEvent) => void;
    onDragOver: (target: DropTarget) => (e: React.DragEvent) => void;
    onDragLeave: (target: DropTarget) => () => void;
    clear: () => void;
  };
  onMoveFile: (key: string, targetDir: DropTarget) => void;
  onMoveFolder: (from: string, toParent: DropTarget) => void;
  // 行内重命名
  renamingPath: string | null;
  setRenamingPath: (path: string | null) => void;
  onRenameFolder: (from: string, newName: string) => void;
  // OS 文件/文件夹拖入（上传队列），targetDir 为落点目录
  onDropFiles: (dt: DataTransfer, targetDir: DropTarget) => void;
  // 拖拽排序：parentPath 下文件夹名全组顺序 / directory 下文件 key 全组顺序
  onReorderFolders: (parentPath: string, names: string[]) => void;
  onReorderFiles: (directory: string, keys: string[]) => void;
}

/** parentOf('a/b/c') = 'a/b'；根层返回 ''。 */
function parentOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx > 0 ? path.slice(0, idx) : '';
}

/** 把 dragged（fromIndex 处）插到 targetIndex 的上/下方，返回新全组数组。 */
function moveItem<T>(list: T[], fromIndex: number, toIndex: number, zone: 'above' | 'below'): T[] {
  const next = [...list];
  const [item] = next.splice(fromIndex, 1);
  if (!item) return next;
  let insertAt = toIndex > fromIndex ? toIndex - 1 : toIndex;
  if (zone === 'below') insertAt += 1;
  next.splice(insertAt, 0, item);
  return next;
}

function FileRow(props: {
  file: FileEntry;
  depth: number;
  isSelected: boolean;
  cb: TreeCallbacks;
}) {
  const { file, depth, isSelected, cb } = props;
  const [edgeZone, setEdgeZone] = useState<'above' | 'below' | null>(null);
  const badge = parseBadge(file.parseStatus);
  // 动作区在 hover / focus / 选中 / 移动中 / 删除确认中保持可见
  const showActions =
    isSelected || cb.movingFileKey === file.key || cb.deletingFilePath === file.key;

  const handleDragOver = (e: React.DragEvent) => {
    if (!cb.dnd.dragging) return;
    e.preventDefault();
    e.stopPropagation();
    const payload = cb.dnd.dragging;
    if (payload.kind !== 'file') return;
    e.dataTransfer.dropEffect = 'move';
    setEdgeZone(rowZoneFromEvent(e, false));
  };

  const handleDragLeave = () => setEdgeZone(null);

  const handleDrop = (e: React.DragEvent) => {
    setEdgeZone(null);
    if (!cb.dnd.dragging || cb.dnd.dragging.kind !== 'file') return;
    e.preventDefault();
    e.stopPropagation();
    const payload = cb.dnd.dragging;
    const zone = rowZoneFromEvent(e, false);
    const dir = normalizeMoveDirectory(file.directory);
    // 仅同目录内的文件之间支持排序；跨目录落文件行 = 移到该行所在目录（尾部）。
    if (normalizeMoveDirectory(payload.directory) !== dir) {
      cb.onMoveFile(payload.key, dir);
      cb.dnd.clear();
      return;
    }
    const node = nodeAt(cb.tree, dir);
    const keys = (node?.files ?? []).map((f) => f.key);
    const from = keys.indexOf(payload.key);
    const to = keys.indexOf(file.key);
    if (from >= 0 && to >= 0 && from !== to) {
      cb.onReorderFiles(dir, moveItem(keys, from, to, zone));
    }
    cb.dnd.clear();
  };

  // 挂合同徽标：判据是「存在已确认的合同绑定」，对合同与执行单据统一表述为
  // 「挂到合同」，避免合同类文档把「未绑定」误读为「未入台账」（入台账由
  // 抽取自动完成，与绑定无关）。未挂且有 docId 时可点击跳转绑定工作台。
  const unbound = file.bound !== true;
  const boundBadgeNode = !unbound ? (
    <span
      title="该文件已与合同建立确认绑定"
      className="whitespace-nowrap rounded bg-success/10 px-1.5 py-px text-[10px] text-success"
    >
      已挂合同
    </span>
  ) : file.docId && cb.onOpenBindings ? (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        if (file.docId && cb.onOpenBindings) cb.onOpenBindings(file.docId);
      }}
      title="尚未挂到合同，点击前往绑定"
      aria-label="尚未挂到合同，点击前往绑定"
      className="cursor-pointer whitespace-nowrap rounded bg-surface px-1.5 py-px text-[10px] text-ink-soft transition-colors hover:bg-ink-soft/15 hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
    >
      未挂合同
    </button>
  ) : (
    <span
      title="尚未挂到合同"
      className="whitespace-nowrap rounded bg-surface px-1.5 py-px text-[10px] text-ink-soft"
    >
      未挂合同
    </span>
  );

  // 解析徽标：本地触发中或后端 parsing -> 「解析中」纯展示（带脉冲提示活动）；
  // uploaded / failed / parsed 且有 docId -> 可点击触发（failed 为重试语义，
  // parsed 为重新处理语义，6b：重跑需带 force 放行服务端终态短路）；其余纯展示。
  const parseInFlight =
    (file.docId ? cb.parsingDocIds.has(file.docId) : false) || file.parseStatus === 'parsing';
  const canTriggerParse =
    !!file.docId &&
    !!cb.onTriggerParse &&
    !parseInFlight &&
    (file.parseStatus === 'uploaded' || file.parseStatus === 'failed' || file.parseStatus === 'parsed');
  let parseBadgeNode: ReactNode = null;
  if (parseInFlight) {
    parseBadgeNode = (
      <span className="animate-pulse whitespace-nowrap rounded bg-surface px-1.5 py-px text-[10px] text-ink-soft">
        解析中
      </span>
    );
  } else if (canTriggerParse && badge) {
    const isRetry = file.parseStatus === 'failed';
    const isReprocess = file.parseStatus === 'parsed';
    // 6b 文案分支: failed='解析失败，点击重试' / uploaded 维持现状 / parsed='重新处理'
    const badgeLabel = isRetry ? '解析失败，点击重试' : isReprocess ? '重新处理' : badge.text;
    parseBadgeNode = (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          if (!file.docId || !cb.onTriggerParse) return;
          if (isReprocess) cb.onTriggerParse(file.docId, { force: true });
          else cb.onTriggerParse(file.docId);
        }}
        title={isRetry ? '解析失败，点击重试' : isReprocess ? '重新处理（覆盖已有解析与抽取结果）' : '点击触发解析'}
        aria-label={isRetry ? '解析失败，点击重试' : isReprocess ? '重新处理（覆盖已有解析与抽取结果）' : '点击触发解析'}
        className={clsx(
          'cursor-pointer whitespace-nowrap rounded px-1.5 py-px text-[10px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary',
          isRetry
            ? 'bg-danger/10 text-danger hover:bg-danger/20'
            : 'bg-surface text-ink-soft hover:bg-ink-soft/15 hover:text-ink',
        )}
      >
        {badgeLabel}
      </button>
    );
  } else {
    parseBadgeNode = badge ? (
      <span className={clsx('whitespace-nowrap rounded px-1.5 py-px text-[10px]', badge.className)}>
        {badge.text}
      </span>
    ) : null;
  }

  return (
    <div
      onClick={() => cb.onSelect(file.key)}
      draggable
      onDragStart={cb.dnd.onDragStart({ kind: 'file', key: file.key, name: file.name, directory: file.directory })}
      onDragEnd={cb.dnd.clear}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={clsx(
        'group relative cursor-pointer border-b border-line/60 py-2 pr-2 text-sm text-ink transition-colors',
        isSelected ? 'bg-primary/5' : 'hover:bg-surface',
      )}
      style={{ paddingLeft: 12 + depth * 14, paddingTop: 7, paddingBottom: 7 }}
    >
      {edgeZone && (
        <span
          aria-hidden
          className={clsx(
            'pointer-events-none absolute right-0 left-0 z-20 h-[2px] rounded-full bg-primary',
            edgeZone === 'above' ? 'top-0' : 'bottom-0',
          )}
        />
      )}
      {/* 文件卡片式两行布局：第一行给完整可折行文件名，第二行承载徽标、
          尺寸与动作。动作不再 absolute 覆盖文件名，窄面板下也不会被挤出。 */}
      <div className="flex items-start gap-2">
        <span className="flex w-[18px] shrink-0 items-center justify-center text-ink-soft">
          <FileText className="h-4 w-4" aria-hidden />
        </span>
        <FileNameText name={file.name} className="text-[13px] leading-5" />
      </div>
      <div className="mt-1.5 flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1 pl-[26px]">
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          {boundBadgeNode}
          {parseBadgeNode}
          <span
            title={formatSize(file.size)}
            className="shrink-0 whitespace-nowrap text-[11px] text-ink-soft"
          >
            {formatSize(file.size)}
          </span>
        </div>
        <div
          onClick={(e) => e.stopPropagation()}
          className={clsx(
            'ml-auto flex items-center gap-0.5',
            !showActions &&
              'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100',
          )}
        >
          <RowIconButton
            label="下载"
            onClick={() => cb.downloadFile(file.key)}
          >
            <Download className="h-4 w-4" aria-hidden />
          </RowIconButton>
          <RowIconButton
            label="预览"
            onClick={(e) => {
              e.stopPropagation();
              cb.onPreview(file);
            }}
          >
            <Eye className="h-4 w-4" aria-hidden />
          </RowIconButton>
          {cb.contextFileKeys.has(file.key) ? (
            <RowIconButton label="已添加到对话" tone="success" disabled onClick={(e) => e.stopPropagation()}>
              <Check className="h-4 w-4" aria-hidden />
            </RowIconButton>
          ) : (
            <RowIconButton label="添加到对话" onClick={() => cb.onAddToConversation(file)}>
              <MessageSquarePlus className="h-4 w-4" aria-hidden />
            </RowIconButton>
          )}
          <RowIconButton
            label="移动"
            onClick={(e) => {
              e.stopPropagation();
              cb.onStartMove(file.key);
            }}
          >
            <FolderInput className="h-4 w-4" aria-hidden />
          </RowIconButton>
          <RowIconButton
            label="删除"
            tone="danger"
            onClick={(e) => {
              e.stopPropagation();
              cb.setDeletingFilePath(file.key);
            }}
          >
            <Trash2 className="h-4 w-4" aria-hidden />
          </RowIconButton>
        </div>
      </div>
      {cb.movingFileKey === file.key && (
        <MoveDropdown file={file} folders={cb.folders} onMove={cb.onMove} onClose={cb.onCancelMove} />
      )}
      {cb.deletingFilePath === file.key && (
        <DeleteConfirmOverlay
          message="删除文件？"
          onConfirm={() => { cb.deleteFile(file.key); cb.setDeletingFilePath(null); }}
          onCancel={() => cb.setDeletingFilePath(null)}
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
  cb: TreeCallbacks;
}

function TreeFolder(props: TreeFolderProps) {
  const { name, fullPath, node, depth, expanded, toggle, cb } = props;
  const [subName, setSubName] = useState('');
  const [renameValue, setRenameValue] = useState('');
  const [edgeZone, setEdgeZone] = useState<'above' | 'below' | null>(null);
  const isOpen = expanded.has(fullPath);
  const hasChildren = node.files.length > 0 || Object.keys(node.subdirs).length > 0;
  const creatingHere = cb.creatingInDir === fullPath;
  const renamingHere = cb.renamingPath === fullPath;
  const highlighted =
    !!cb.dnd.dragging && edgeZone === null && cb.dnd.dropTarget === fullPath && !isFolderSelfDrop(
      cb.dnd.dragging.kind === 'folder' ? cb.dnd.dragging.path : '',
      fullPath,
    );

  const commitSubfolder = () => {
    const trimmed = subName.trim();
    if (!trimmed) {
      cb.setCreatingInDir(null);
      return;
    }
    cb.onCreateSubfolder(fullPath, trimmed);
    setSubName('');
    cb.setCreatingInDir(null);
  };

  const startRename = (e: React.MouseEvent) => {
    e.stopPropagation();
    setRenameValue(name);
    cb.setRenamingPath(fullPath);
  };

  const commitRename = () => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== name) {
      cb.onRenameFolder(fullPath, trimmed);
    }
    setRenameValue('');
    cb.setRenamingPath(null);
  };

  const handleRowDrop = (e: React.DragEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const payload = readPayload(e);
    // 边缘区（上/下 30%）：同级文件夹排序。仅文件夹载荷参与；文件载荷忽略边缘。
    if (edgeZone && payload?.kind === 'folder') {
      setEdgeZone(null);
      const parent = parentOf(fullPath);
      const dragName = payload.path.split('/').pop() ?? '';
      if (parentOf(payload.path) === parent && dragName !== name) {
        const parentNode = nodeAt(cb.tree, parent);
        const names = Object.keys(parentNode?.subdirs ?? {});
        const from = names.indexOf(dragName);
        const to = names.indexOf(name);
        if (from >= 0 && to >= 0 && from !== to) {
          cb.onReorderFolders(parent, moveItem(names, from, to, edgeZone));
        }
      }
      cb.dnd.clear();
      return;
    }
    setEdgeZone(null);
    if (payload) {
      if (payload.kind === 'file') {
        cb.onMoveFile(payload.key, fullPath);
      } else if (!isFolderSelfDrop(payload.path, fullPath)) {
        cb.onMoveFolder(payload.path, fullPath);
      }
      cb.dnd.clear();
      return;
    }
    // OS 文件/文件夹拖入：交给容器的上传队列（保层级）。
    cb.onDropFiles(e.dataTransfer, fullPath);
    cb.dnd.clear();
  };

  // 文件夹行三区判定：上/下 30% 为排序边缘，中间为移入/上传容器语义。
  const handleRowDragOver = (e: React.DragEvent) => {
    e.stopPropagation();
    const payload = cb.dnd.dragging;
    let zone: 'above' | 'below' | null = null;
    if (payload?.kind === 'folder' && !isFolderSelfDrop(payload.path, fullPath)) {
      const raw = rowZoneFromEvent(e, true);
      zone = raw === 'into' ? null : raw;
    }
    setEdgeZone(zone);
    cb.dnd.onDragOver(fullPath)(e);
  };

  return (
    <div>
      <div
        onClick={() => { if (!renamingHere) toggle(fullPath); }}
        draggable={!renamingHere}
        onDragStart={cb.dnd.onDragStart({ kind: 'folder', path: fullPath })}
        onDragEnd={cb.dnd.clear}
        onDragOver={handleRowDragOver}
        onDragLeave={cb.dnd.onDragLeave(fullPath)}
        onDrop={handleRowDrop}
        className={clsx(
          'group relative flex cursor-pointer items-center border-b border-line/60 pr-3 text-sm text-ink transition-colors hover:bg-surface',
          highlighted && 'bg-primary/10 outline outline-1 outline-primary/40',
        )}
        style={{ paddingLeft: 12 + depth * 14, paddingTop: 7, paddingBottom: 7 }}
      >
        {highlighted && <span className="absolute inset-y-0 left-0 w-[3px] rounded-full bg-primary" aria-hidden />}
        {edgeZone && (
          <span
            aria-hidden
            className={clsx(
              'pointer-events-none absolute right-0 left-0 z-20 h-[2px] rounded-full bg-primary',
              edgeZone === 'above' ? 'top-0' : 'bottom-0',
            )}
          />
        )}
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
        {renamingHere ? (
          <input
            autoFocus
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitRename();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setRenameValue('');
                cb.setRenamingPath(null);
              }
            }}
            onClick={(e) => e.stopPropagation()}
            onFocus={(e) => e.currentTarget.select()}
            className="ml-2 min-w-0 flex-1 rounded border border-primary px-1 py-0.5 text-sm outline-none"
          />
        ) : (
          <FileNameText name={name} className="ml-2 text-[13px] font-medium leading-5" />
        )}
        {/* 文件夹沿用列表行惯用的 trailing 图标组；按钮保留布局占位，hover 时
            只切换可见性，避免文件名与操作区发生重叠或跳动。 */}
        <div className="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <RowIconButton
            label="重命名"
            onClick={startRename}
          >
            <Pencil className="h-4 w-4" aria-hidden />
          </RowIconButton>
          <RowIconButton
            label="新建子文件夹"
            onClick={(e) => {
              e.stopPropagation();
              if (!isOpen) toggle(fullPath);
              cb.setCreatingInDir(fullPath);
            }}
          >
            <FolderPlus className="h-4 w-4" aria-hidden />
          </RowIconButton>
          <RowIconButton
            label="删除文件夹"
            tone="danger"
            onClick={(e) => {
              e.stopPropagation();
              cb.setDeletingFolderPath(fullPath);
            }}
          >
            <Trash2 className="h-4 w-4" aria-hidden />
          </RowIconButton>
        </div>
        {cb.deletingFolderPath === fullPath && (
          <DeleteConfirmOverlay
            message="移除文件夹？(文件不删)"
            onConfirm={() => { cb.removeFolder(fullPath); cb.setDeletingFolderPath(null); }}
            onCancel={() => cb.setDeletingFolderPath(null)}
          />
        )}
      </div>
      {isOpen && (
        <div
          className="ml-5 border-l border-line pl-2"
          onDragOver={handleRowDragOver}
          onDrop={handleRowDrop}
        >
          {creatingHere && (
            <div
              className="flex items-center gap-1.5 py-1 pr-3"
              style={{ paddingLeft: 12 + (depth + 1) * 14 }}
              onClick={(e) => e.stopPropagation()}
            >
              <Folder className="h-4 w-4 shrink-0 text-warning" aria-hidden />
              <input
                autoFocus
                value={subName}
                onChange={(e) => setSubName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commitSubfolder();
                  } else if (e.key === 'Escape') {
                    // 仅取消命名，不冒泡触发抽屉关闭
                    e.preventDefault();
                    e.stopPropagation();
                    setSubName('');
                    cb.setCreatingInDir(null);
                  }
                }}
                placeholder="子文件夹名称"
                className="min-w-0 flex-1 rounded border border-line px-2 py-1 text-xs outline-none focus:border-primary"
              />
              <button type="button" onClick={commitSubfolder} className="px-1 text-[11px] text-primary hover:underline">
                确认
              </button>
              <button
                type="button"
                onClick={() => { setSubName(''); cb.setCreatingInDir(null); }}
                className="px-1 text-[11px] text-ink-soft hover:underline"
              >
                取消
              </button>
            </div>
          )}
          {node.files.length === 0 && Object.keys(node.subdirs).length === 0 && !creatingHere && (
            <div className="px-3 py-1.5 text-xs text-ink-soft">（空）</div>
          )}
          {node.files.map((f) => (
            <FileRow
              key={f.key}
              file={f}
              depth={depth + 1}
              isSelected={false}
              cb={cb}
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
              cb={cb}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** 树入口：根层文件 + 根层文件夹。 */
export function FileTree(props: {
  tree: TreeNode;
  expanded: Set<string>;
  toggle: (path: string) => void;
  cb: TreeCallbacks;
}) {
  const { tree, expanded, toggle, cb } = props;
  return (
    <>
      {tree.files.map((f) => (
        <FileRow
          key={f.key}
          file={f}
          depth={0}
          isSelected={cb.selectedKey === f.key}
          cb={cb}
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
          cb={cb}
        />
      ))}
    </>
  );
}
