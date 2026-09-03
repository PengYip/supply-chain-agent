// 树形文件列表展示：从 FileDrawer 拆出（行为不变）。
// 包含树构建、行渲染（文件/文件夹）、移动下拉与删除确认浮层。
// 交互回调经单一 callbacks 对象由容器（FileDrawer）下发。
import { useEffect, useRef, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Download,
  Eye,
  FileText,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Loader2,
  MessageSquarePlus,
  Pencil,
  Trash2,
} from 'lucide-react';
import { type FileEntry, type FileFolder, type FileParseStage } from '../../hooks/useFiles';
import { normalizeMoveDirectory, nodeAt, type TreeNode } from '../../lib/fileTree';
import { businessTypeTag } from '../../lib/businessTypeTag';
import {
  unitReviewStatusBadge,
  unitStatusBadge,
  type BatchUnitSummary,
} from '../../api/documents';
import { requestOpenReview } from '../../lib/reviewModal';
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

/** 解析阶段文案（parseStage 徽标；后端未部署阶段字段时为 null，走旧
 *  「解析中」文案，保证前端可独立于后端灰度部署）。 */
const PARSE_STAGE_LABEL: Record<FileParseStage, string> = {
  detecting: '检测单据边界',
  ocr: '整本 OCR 解析',
  extracting: '逐份抽取',
  indexing: '分块与向量化',
};

/** 秒数 → 「42 秒」/「2 分 10 秒」（解析/阶段徽标的已耗时读数，
 *  随进度轮询驱动的重渲染约 4s 刷新一拍）。 */
function formatElapsedSec(sec: number): string {
  if (sec < 60) return `${sec} 秒`;
  return `${Math.floor(sec / 60)} 分 ${String(sec % 60).padStart(2, '0')} 秒`;
}

/** 已解析业务类型的标签配色与样式查表已抽至 lib/businessTypeTag(文件树与
 *  复核卡拆分清单共用同一 SSOT,含「单据组」容器族样式)。 */

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
    <div className="group/name relative min-w-0 flex-1">
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
  // 单据组(container)子单据层级：展开态与懒加载缓存由 FileDrawer 持有
  // (面板常驻挂载，会话内自然记忆)，key = container docId。
  containerUnits: Record<string, ContainerUnitsState>;
  expandedContainers: ReadonlySet<string>;
  // 已耗时秒表（单一共享时钟值，毫秒）：仅进度轮询激活期间每秒更新，
  // 0 = 时钟未走动；行内已耗时读数以此驱动重渲染，渲染期不再调 Date.now
  // （修复 react(purity) 警告与「停在 0 秒」的显示事故）。
  nowMs: number;
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
  // 单据组(container)子单据层级
  /** 展开/收起某 container 的子单据(展开时由容器侧懒加载)。 */
  toggleContainerUnits: (docId: string) => void;
  /** 失败重试: 重新拉取某 container 的子单据清单。 */
  reloadContainerUnits: (docId: string) => void;
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

/** container 子单据清单的加载态（FileDrawer 持有，树消费；key = docId）。 */
export interface ContainerUnitsState {
  status: 'loading' | 'ready' | 'error';
  /** 已加载的子单据（loading/error 时保留上次结果做 stale-while-revalidate）。 */
  units: BatchUnitSummary[];
  /** status==='error' 时的中文错误信息。 */
  error?: string;
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

/** 单据组下的子单据行（缩进一层，depth 为所属 container 文件的层级）：
 *  序号 + 类型徽标（优先子单据落库业务类型，兜底检测词表标签）+ 解析/
 *  复核状态 + 待复核标记。整行与右侧「复核」按钮都打开该子单据的全局
 *  复核弹窗；子单据与 container 共享物理文件，「添加到对话」等文件级
 *  操作留在 container 行。不可拖拽。 */
function UnitRow({ unit, depth }: { unit: BatchUnitSummary; depth: number }) {
  const typeTag = businessTypeTag(unit.childDocType ?? unit.detectedFormType);
  const status = unitStatusBadge(unit.unitStatus);
  // 复核状态缺字段(旧版 /units 响应)时: 有子单据按「待复核」兜底(安全侧),
  // 无子单据才是真正的「未生成」—— 行内复核状态徽标即进度可见性, 无需
  // 另加圆点。
  const review = unitReviewStatusBadge(
    unit.reviewStatus ?? (unit.docId ? 'pending' : null),
  );
  const canReview = typeof unit.docId === 'string' && unit.docId.length > 0;
  const openReview = () => {
    if (unit.docId) requestOpenReview(unit.docId);
  };
  return (
    <div
      onClick={(e) => {
        e.stopPropagation();
        openReview();
      }}
      title={canReview ? `复核第 ${unit.unitIndex} 份子单据` : '子单据尚未生成，暂时无法复核'}
      className={clsx(
        'flex items-center gap-1 border-b border-line/40 pr-2 text-sm transition-colors',
        canReview ? 'cursor-pointer hover:bg-surface' : 'cursor-default',
      )}
      style={{ paddingLeft: 12 + (depth + 1) * 14, paddingTop: 4, paddingBottom: 4 }}
    >
      <span className="shrink-0 font-mono text-[10px] text-ink-soft">
        #{unit.unitIndex}
      </span>
      {typeTag ? (
        <span
          title={`业务类型：${typeTag.text}`}
          className={clsx(
            'max-w-[96px] shrink-0 truncate rounded border px-1.5 py-px text-[10px] leading-4',
            typeTag.className,
          )}
        >
          {typeTag.text}
        </span>
      ) : (
        <span className="max-w-[96px] shrink-0 truncate text-[10px] leading-4 text-ink-soft">
          {unit.detectedFormType || '未识别'}
        </span>
      )}
      <span className={clsx('shrink-0 whitespace-nowrap rounded px-1.5 py-px text-[10px]', status.className)}>
        {status.label}
      </span>
      <span className={clsx('shrink-0 whitespace-nowrap rounded px-1.5 py-px text-[10px]', review.className)}>
        {review.label}
      </span>
      {unit.needsReview && (
        <span className="inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap rounded bg-warning/10 px-1.5 py-px text-[10px] text-warning">
          <AlertTriangle className="h-2.5 w-2.5" aria-hidden />
          建议复核
        </span>
      )}
      <span className="ml-auto shrink-0 pl-1">
        {unit.docId ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              openReview();
            }}
            title="打开该子单据的复核卡"
            className="cursor-pointer whitespace-nowrap rounded px-1.5 py-px text-[11px] font-medium text-primary transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
          >
            复核
          </button>
        ) : (
          <span className="whitespace-nowrap text-[11px] text-ink-soft/70" title="子单据尚未生成">
            --
          </span>
        )}
      </span>
    </div>
  );
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
  // 单据组(container)：行为切换为「可展开的子单据层级」——批量徽标承载角色
  // 与份数，普通业务类型标签与挂合同徽标不渲染（绑定发生在 unit 子单据上）。
  const isContainer = file.batchRole === 'container' && !!file.docId;
  const containerDocId = isContainer && file.docId ? file.docId : null;
  const containerExpanded = containerDocId ? cb.expandedContainers.has(containerDocId) : false;
  const unitsState = containerDocId ? cb.containerUnits[containerDocId] : undefined;
  const typeTag = isContainer ? null : businessTypeTag(file.businessType);
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
  // 单据组不渲染： 绑定发生在 unit 子单据上，container 自身永不绑定，
  // 显示「未挂合同」会误导跳转到一份没有绑定关系的文档。
  const unbound = file.bound !== true;
  const boundBadgeNode = isContainer ? null : !unbound ? (
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

  // 已耗时秒表锚点（仅组件内存）：进入 in-flight、或阶段锚点对
  // (parseStage, stageStartedAt) 变化时记录客户端时刻 at；baseSec 以服务端
  // stageStartedAt 估算「首次见到时该阶段已进行时长」作基线。服务端与
  // 客户端时钟存在偏差（dev 实测曾快约 50s，导致旧实现钳在「已 0 秒」
  // 不动、偏差追平后瞬间跳读）——负基线钳到 0：读数保证单调递增每秒走字，
  // 绝对精确让位于稳定。阶段切换 = 锚点对变化 = 重新起算（进入新阶段
  // 重置耗时是口径设计）；stageStartedAt 缺失时 baseSec=0，退化为首次
  // 见到 in-flight 起算。走字由 cb.nowMs（FileDrawer 的共享秒表）驱动。
  const stageAnchorKey =
    file.parseStage && file.stageStartedAt
      ? `${file.parseStage}|${file.stageStartedAt}`
      : null;
  const [stageClock, setStageClock] = useState<{ key: string; at: number; baseSec: number } | null>(
    null,
  );
  useEffect(() => {
    if (!parseInFlight) {
      if (stageClock !== null) setStageClock(null);
      return;
    }
    const nextKey = stageAnchorKey ?? '__inflight__';
    if (stageClock?.key === nextKey) return;
    const now = Date.now();
    let baseSec = 0;
    if (stageAnchorKey && file.stageStartedAt) {
      const serverStart = Date.parse(file.stageStartedAt);
      if (Number.isFinite(serverStart)) {
        baseSec = Math.max(0, Math.round((now - serverStart) / 1000));
      }
    }
    setStageClock({ key: nextKey, at: now, baseSec });
  }, [parseInFlight, stageAnchorKey, file.stageStartedAt, stageClock]);
  const stage = file.parseStage ?? null;
  // 纯函数读数：基线 + 共享时钟走过的秒数（时钟未走动时退化为锚点时刻，
  // 即 0 秒——仅存在于激活后首帧之前的窗口）。
  const elapsedLabel = (() => {
    if (!parseInFlight || !stageClock) return null;
    const live = cb.nowMs > 0 ? cb.nowMs : stageClock.at;
    return formatElapsedSec(
      Math.max(0, stageClock.baseSec + Math.round((live - stageClock.at) / 1000)),
    );
  })();

  // 单据组抽取进度： 缓存里已有 unit 行且存在未终态（pending/processing）时，
  // 行级渲染「抽取中 i/N」+ 细进度条 —— 收起态同样可见（进度长在行上，而非
  // 仅展开清单里）。容器自身仍在 parsing 且尚无 unit 行时回落普通「解析中」。
  // done 口径 = processed + needs_ocr + failed（终态即已处理）。
  const containerProgress = (() => {
    if (!containerDocId || !unitsState) return null;
    const total = unitsState.units.length;
    if (total === 0) return null;
    const done = unitsState.units.filter(
      (u) =>
        u.unitStatus === 'processed' ||
        u.unitStatus === 'needs_ocr' ||
        u.unitStatus === 'failed',
    ).length;
    const inFlight = unitsState.units.some(
      (u) => u.unitStatus === 'pending' || u.unitStatus === 'processing',
    );
    return inFlight ? { total, done } : null;
  })();

  let parseBadgeNode: ReactNode = null;
  if (parseInFlight) {
    // 容器进入逐份抽取且 unit 进度可得时，由「抽取中 i/N」进度节点接管
    // （信息量更大），解析/阶段徽标让位；其余阶段（检测/OCR/向量化）与
    // 无 unit 进度时照常显示阶段徽标。
    const suppressedByUnitProgress =
      containerProgress !== null && (stage === null || stage === 'extracting');
    if (suppressedByUnitProgress) {
      parseBadgeNode = null;
    } else {
      const stageLabel = stage ? PARSE_STAGE_LABEL[stage] : null;
      const text = stageLabel
        ? elapsedLabel
          ? `${stageLabel} · 已 ${elapsedLabel}`
          : stageLabel
        : elapsedLabel
          ? `解析中 · ${elapsedLabel}`
          : '解析中';
      parseBadgeNode = (
        <span
          className="animate-pulse whitespace-nowrap rounded bg-surface px-1.5 py-px text-[10px] text-ink-soft"
          title={
            stageLabel
              ? `解析进行中，当前阶段：${stageLabel}`
              : elapsedLabel
                ? `解析进行中，已持续 ${elapsedLabel}`
                : '解析进行中'
          }
        >
          {text}
        </span>
      );
    }
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

  // 单据组批量徽标（第二行首位）： 虚线钢蓝族 + 展开箭头，点击切换子单据
  // 层级（与文件夹行的 ChevronRight 旋转语义一致）。份数优先取 /api/files
  // 的 unitCount，字段缺失（后端未升级）时兜底已加载清单长度。
  const unitCountDisplay =
    typeof file.unitCount === 'number' && file.unitCount >= 0
      ? file.unitCount
      : unitsState?.status === 'ready'
        ? unitsState.units.length
        : null;
  const batchBadgeNode = containerDocId ? (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        cb.toggleContainerUnits(containerDocId);
      }}
      aria-expanded={containerExpanded}
      title={containerExpanded ? '收起子单据清单' : '展开子单据清单'}
      className={clsx(
        'inline-flex max-w-full cursor-pointer items-center gap-0.5 whitespace-nowrap rounded border border-dashed px-1.5 py-px text-[10px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary',
        containerExpanded
          ? 'border-[#5D8FB5] bg-[#EDF3F8] text-[#1D5680]'
          : 'border-[#A9BCCD] bg-[#F2F6FA] text-[#35719C] hover:border-[#5D8FB5]',
      )}
    >
      <ChevronRight
        className={clsx('h-3 w-3 shrink-0 transition-transform', containerExpanded && 'rotate-90')}
        aria-hidden
      />
      单据组{unitCountDisplay != null ? ` · ${unitCountDisplay} 份单据` : ''}
    </button>
  ) : null;

  return (
    <>
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
        {typeTag && (
          <span
            title={`业务类型：${typeTag.text}`}
            className={clsx(
              'mt-px max-w-[92px] shrink-0 truncate rounded border px-1.5 py-px text-[10px] leading-4',
              typeTag.className,
            )}
          >
            {typeTag.text}
          </span>
        )}
      </div>
      <div className="mt-1.5 flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1 pl-[26px]">
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          {batchBadgeNode}
          {containerProgress && (
            <span
              className="flex shrink-0 items-center gap-1"
              title={`子单据抽取进度：已处理 ${containerProgress.done}/${containerProgress.total} 份`}
            >
              <span className="whitespace-nowrap rounded bg-primary/10 px-1.5 py-px text-[10px] text-primary animate-pulse">
                抽取中 {containerProgress.done}/{containerProgress.total}
              </span>
              <span className="h-1 w-12 overflow-hidden rounded-full bg-surface" aria-hidden>
                <span
                  className="block h-full rounded-full bg-primary transition-all duration-500"
                  style={{
                    width: `${Math.round((containerProgress.done / containerProgress.total) * 100)}%`,
                  }}
                />
              </span>
            </span>
          )}
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
    {/* 单据组子单据层级： 展开时渲染（数据由 FileDrawer 懒加载）。缩进沿用
        文件夹子级的视觉语言（左移位 + 竖向引导线），行内不可拖拽。 */}
    {containerDocId && containerExpanded && (
      <div
        className="ml-5 border-l border-line/70 pl-2"
        onClick={(e) => e.stopPropagation()}
      >
        {(unitsState?.units ?? []).map((u) => (
          <UnitRow key={u.unitId} unit={u} depth={depth} />
        ))}
        {unitsState?.status === 'loading' &&
          (unitsState.units.length > 0 ? (
            <div
              className="flex items-center gap-1.5 py-1 text-[10px] text-ink-soft"
              style={{ paddingLeft: 12 + (depth + 1) * 14 }}
            >
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
              刷新中...
            </div>
          ) : (
            <div
              className="flex items-center gap-1.5 py-1 text-[11px] text-ink-soft"
              style={{ paddingLeft: 12 + (depth + 1) * 14 }}
            >
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
              加载子单据...
            </div>
          ))}
        {unitsState?.status === 'error' && (
          <div
            className="flex items-center gap-2 py-1 text-[11px]"
            style={{ paddingLeft: 12 + (depth + 1) * 14 }}
          >
            <span className="text-danger" title={unitsState.error}>
              子单据加载失败{unitsState.error ? `：${unitsState.error}` : ''}
            </span>
            <button
              type="button"
              onClick={() => cb.reloadContainerUnits(containerDocId)}
              className="cursor-pointer text-primary hover:underline"
            >
              重试
            </button>
          </div>
        )}
        {unitsState?.status === 'ready' && unitsState.units.length === 0 && (
          <div
            className="py-1 text-[11px] text-ink-soft"
            style={{ paddingLeft: 12 + (depth + 1) * 14 }}
          >
            暂无子单据
          </div>
        )}
      </div>
    )}
    </>
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
  // OS 外部文件没有 useFileDnd 的 dragging payload；此时目标态本身就是
  // 「上传到当前文件夹」。内部文件夹拖拽则继续保持移动语义与自我/子树校验。
  const externalUploadHighlighted = !cb.dnd.dragging && cb.dnd.dropTarget === fullPath;
  const internalMoveHighlighted =
    !!cb.dnd.dragging &&
    cb.dnd.dropTarget === fullPath &&
    !isFolderSelfDrop(
      cb.dnd.dragging.kind === 'folder' ? cb.dnd.dragging.path : '',
      fullPath,
    );
  const highlighted = edgeZone === null && (externalUploadHighlighted || internalMoveHighlighted);

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
        data-upload-target-dir={fullPath}
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
          data-upload-target-dir={fullPath}
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
