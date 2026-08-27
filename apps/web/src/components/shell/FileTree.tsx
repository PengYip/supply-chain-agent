// 树形文件列表展示：从 FileDrawer 拆出（行为不变）。
// 包含树构建、行渲染（文件/文件夹）、移动下拉与删除确认浮层。
// 交互回调经单一 callbacks 对象由容器（FileDrawer）下发。
import { useEffect, useRef, type ReactNode } from 'react';
import clsx from 'clsx';
import { ChevronRight, FileText, Folder, FolderOpen } from 'lucide-react';
import { type FileEntry, type FileFolder } from '../../hooks/useFiles';

export interface TreeNode {
  files: FileEntry[];
  subdirs: Record<string, TreeNode>;
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function pathSegments(p: string | undefined): string[] {
  if (!p) return [];
  return p.split('/').map((s) => s.trim()).filter((s) => s.length > 0);
}

export function buildTree(files: FileEntry[], folders: FileFolder[]): TreeNode {
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

export function normalizeMoveDirectory(directory: string): string {
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

/** 文件/文件夹名列：两行截断显示，hover 即时浮出完整名称气泡。
 *  气泡锚定在名称列自身的相对定位容器内（left-0 + top-full），宽度上限
 *  240px，横向不会超出抽屉；滚动容器底缘的极端裁剪场景由保留的原生
 *  title 兜底。气泡为主交互，无 hover 延迟，带 100ms 淡入缩放过渡。 */
function FileNameText({ name, className }: { name: string; className?: string }) {
  return (
    <div className="group/name relative ml-2 min-w-0 flex-1">
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
  onTriggerParse?: (docId: string) => void;
}

function FileRow(props: {
  file: FileEntry;
  depth: number;
  isSelected: boolean;
  cb: TreeCallbacks;
}) {
  const { file, depth, isSelected, cb } = props;
  const badge = parseBadge(file.parseStatus);
  // 动作区在 hover / 移动中 / 删除确认中保持可见
  const showActions = cb.movingFileKey === file.key || cb.deletingFilePath === file.key;

  // 绑定徽标：未绑定且有 docId 时可点击跳转绑定工作台（孤儿对象/已绑定纯展示）。
  const unbound = file.bound !== true;
  const boundBadgeNode = !unbound ? (
    <span
      title="已绑定到合同台账"
      className="whitespace-nowrap rounded bg-success/10 px-1.5 py-px text-[10px] text-success"
    >
      已绑定
    </span>
  ) : file.docId && cb.onOpenBindings ? (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        if (file.docId && cb.onOpenBindings) cb.onOpenBindings(file.docId);
      }}
      title="尚未绑定合同，点击前往绑定"
      aria-label="尚未绑定合同，点击前往绑定"
      className="cursor-pointer whitespace-nowrap rounded bg-surface px-1.5 py-px text-[10px] text-ink-soft transition-colors hover:bg-ink-soft/15 hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
    >
      未绑定
    </button>
  ) : (
    <span
      title="尚未绑定合同"
      className="whitespace-nowrap rounded bg-surface px-1.5 py-px text-[10px] text-ink-soft"
    >
      未绑定
    </span>
  );

  // 解析徽标：本地触发中或后端 parsing -> 「解析中」纯展示（带脉冲提示活动）；
  // uploaded / failed 且有 docId -> 可点击触发（failed 为重试语义）；其余纯展示。
  const parseInFlight =
    (file.docId ? cb.parsingDocIds.has(file.docId) : false) || file.parseStatus === 'parsing';
  const canTriggerParse =
    !!file.docId &&
    !!cb.onTriggerParse &&
    !parseInFlight &&
    (file.parseStatus === 'uploaded' || file.parseStatus === 'failed');
  let parseBadgeNode: ReactNode = null;
  if (parseInFlight) {
    parseBadgeNode = (
      <span className="animate-pulse whitespace-nowrap rounded bg-surface px-1.5 py-px text-[10px] text-ink-soft">
        解析中
      </span>
    );
  } else if (canTriggerParse && badge) {
    const isRetry = file.parseStatus === 'failed';
    parseBadgeNode = (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          if (file.docId && cb.onTriggerParse) cb.onTriggerParse(file.docId);
        }}
        title={isRetry ? '解析失败，点击重试' : '点击触发解析'}
        aria-label={isRetry ? '解析失败，点击重试' : '点击触发解析'}
        className={clsx(
          'cursor-pointer whitespace-nowrap rounded px-1.5 py-px text-[10px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary',
          isRetry
            ? 'bg-danger/10 text-danger hover:bg-danger/20'
            : 'bg-surface text-ink-soft hover:bg-ink-soft/15 hover:text-ink',
        )}
      >
        {badge.text}
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
      className={clsx(
        'group relative flex cursor-pointer items-center border-b border-line/60 pr-3 text-sm text-ink transition-colors',
        isSelected ? 'bg-primary/5' : 'hover:bg-surface',
      )}
      style={{ paddingLeft: 12 + depth * 14, paddingTop: 7, paddingBottom: 7 }}
    >
      <div className="flex w-[18px] shrink-0 items-center justify-center text-ink-soft">
        <FileText className="h-4 w-4" aria-hidden />
      </div>
      {/* 徽标容器锚定在行首（图标后、文件名前）：hover 时大小/操作区入场只
          压窄文件名（唯一 flex-1 可收缩项），徽标不再左移导致点击落空。 */}
      <div className="ml-2 flex shrink-0 items-center gap-1">
        {boundBadgeNode}
        {parseBadgeNode}
      </div>
      <FileNameText name={file.name} />
      <span className="mr-2 hidden shrink-0 whitespace-nowrap text-[11px] text-ink-soft group-hover:inline">
        {formatSize(file.size)}
      </span>
      <div
        onClick={(e) => e.stopPropagation()}
        className={clsx('items-center gap-1.5 whitespace-nowrap', showActions ? 'flex' : 'hidden group-hover:flex')}
      >
        <span onClick={() => cb.downloadFile(file.key)} className={actionLinkClass()}>
          下载
        </span>
        <span onClick={(e) => { e.stopPropagation(); cb.onPreview(file); }} className={actionLinkClass()}>
          预览
        </span>
        {cb.contextFileKeys.has(file.key) ? (
          <span className="px-1 py-0.5 text-[11px] text-success">已添加</span>
        ) : (
          <span onClick={() => cb.onAddToConversation(file)} className={actionLinkClass()}>
            添加到对话
          </span>
        )}
        <span onClick={() => cb.onStartMove(file.key)} className={actionLinkClass()}>
          移动
        </span>
        <span
          onClick={(e) => { e.stopPropagation(); cb.setDeletingFilePath(file.key); }}
          className={actionLinkClass('danger')}
        >
          删除
        </span>
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
        <FileNameText name={name} className="font-medium" />
        <span
          onClick={(e) => { e.stopPropagation(); cb.setDeletingFolderPath(fullPath); }}
          className="hidden cursor-pointer rounded px-1 py-0.5 text-[11px] text-danger transition-colors hover:bg-danger/5 group-hover:inline"
        >
          删除
        </span>
        {cb.deletingFolderPath === fullPath && (
          <DeleteConfirmOverlay
            message="移除文件夹？(文件不删)"
            onConfirm={() => { cb.removeFolder(fullPath); cb.setDeletingFolderPath(null); }}
            onCancel={() => cb.setDeletingFolderPath(null)}
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
