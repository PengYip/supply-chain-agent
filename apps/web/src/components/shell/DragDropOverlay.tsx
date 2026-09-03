// 全页面文件拖拽提示遮罩：OS 文件拖入窗口任意位置（未松手）时浮层提示
// 可投放。主页面用通用文案；悬停到文件管理声明的目标目录时改为显示该
// 目录与「松开上传」的确认动作。容器 pointer-events-none，拖拽事件全部
// 穿透，不影响文件抽屉既有 drop zone 的命中判定。受控 visible，由
// usePageFileDrop 的 dragActive 驱动；targetDir=null 表示主页面，
// ''=文件管理根目录，非空值为文件夹完整路径。
import { File, FileSpreadsheet, FileText, Folder, FolderInput } from 'lucide-react';
import type { DropTarget } from '../../hooks/useFileDnd';

/** 漂浮文件图标的散布参数：绿/蓝/灰三色、倾斜错落，示意正落入投放区。 */
const FLOATING_ICONS: Array<{
  icon: typeof FileText;
  /** 外层定位（absolute 偏移）。 */
  pos: string;
  /** 图标尺寸与颜色。 */
  look: string;
  /** 外层旋转姿态。 */
  rotate: string;
  /** 漂浮动画相位错开。 */
  delay: string;
}> = [
  { icon: FileSpreadsheet, pos: 'left-5 top-1', look: 'h-9 w-9 text-success', rotate: '-rotate-[16deg]', delay: '0s' },
  { icon: FileText, pos: 'right-7 top-5', look: 'h-10 w-10 text-primary/70', rotate: 'rotate-[14deg]', delay: '0.4s' },
  { icon: File, pos: 'left-16 top-14', look: 'h-7 w-7 text-ink-soft/60', rotate: 'rotate-[6deg]', delay: '0.8s' },
  { icon: FileText, pos: 'right-20 top-0', look: 'h-6 w-6 text-success/80', rotate: '-rotate-[8deg]', delay: '1.2s' },
  { icon: FileSpreadsheet, pos: 'left-0 top-12', look: 'h-6 w-6 text-primary/60', rotate: 'rotate-[20deg]', delay: '1.6s' },
  { icon: File, pos: 'right-1 top-16', look: 'h-5 w-5 text-ink-soft/50', rotate: '-rotate-[20deg]', delay: '2s' },
];

/** 全屏拖拽提示遮罩。visibility 参与过渡：隐藏态在淡出结束后才置
 *  invisible，显示态立即可见，两端都有平滑的淡入淡出 + 缩放。 */
export function DragDropOverlay({
  visible,
  targetDir = null,
}: {
  visible: boolean;
  /** null=主页面；''=文件管理根目录；否则为文件夹完整路径。 */
  targetDir?: DropTarget | null;
}) {
  const hasFolderTarget = targetDir !== null;
  const targetSegments = targetDir ? targetDir.split('/').filter(Boolean) : [];
  const targetName = targetSegments.at(-1) ?? '根目录';

  return (
    <div
      aria-hidden
      className={`pointer-events-none fixed inset-0 z-modal flex items-center justify-center bg-white/70 backdrop-blur-sm transition-[opacity,transform,visibility] duration-200 ease-out ${
        visible ? 'visible scale-100 opacity-100' : 'invisible scale-95 opacity-0'
      }`}
    >
      {hasFolderTarget ? (
        <div className="flex flex-col items-center px-6 text-center">
          <div className="flex h-20 w-20 items-center justify-center rounded-3xl border border-primary/20 bg-primary/10 shadow-[0_18px_40px_-24px_rgb(var(--c-primary)/0.55)]">
            <FolderInput className="h-10 w-10 text-primary" aria-hidden />
          </div>
          <div className="mt-6 text-[11px] font-semibold uppercase tracking-[0.18em] text-primary">上传目标</div>
          <div className="mt-2 flex max-w-md items-center gap-2 rounded-2xl border border-line bg-white/85 px-4 py-2 shadow-sm">
            <Folder className="h-5 w-5 shrink-0 text-warning" aria-hidden />
            <span className="truncate text-2xl font-bold leading-8 text-ink">{targetName}</span>
          </div>
          {targetSegments.length > 1 && (
            <p className="mt-2 max-w-md truncate text-xs leading-5 text-ink-soft" title={targetDir}>
              完整路径：{targetSegments.join(' / ')}
            </p>
          )}
          <p className="mt-4 text-sm leading-6 text-ink-soft">松开鼠标即可上传到该文件夹</p>
        </div>
      ) : (
        <div className="flex flex-col items-center px-6 text-center">
          {/* 插图：漂浮文件正落入渐变绿箭头所示的投放区 */}
          <div className="relative h-40 w-48">
            <svg
              viewBox="0 0 96 112"
              aria-hidden
              className="absolute bottom-0 left-1/2 h-28 w-24 -translate-x-1/2 drop-shadow-sm"
            >
              <defs>
                <linearGradient id="drop-overlay-arrow" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" style={{ stopColor: 'rgb(var(--c-success) / 0.35)' }} />
                  <stop offset="1" style={{ stopColor: 'rgb(var(--c-success))' }} />
                </linearGradient>
              </defs>
              <path
                d="M36 4h24v54h18L48 106 18 58h18V4z"
                fill="url(#drop-overlay-arrow)"
                stroke="url(#drop-overlay-arrow)"
                strokeWidth="3"
                strokeLinejoin="round"
              />
            </svg>
            {FLOATING_ICONS.map(({ icon: Icon, pos, look, rotate, delay }) => (
              <div key={`${pos}-${delay}`} className={`absolute ${pos} ${rotate}`}>
                <Icon className={`animate-drop-float ${look}`} style={{ animationDelay: delay }} aria-hidden />
              </div>
            ))}
          </div>
          <div className="mt-6 text-2xl font-bold text-ink">在此处拖放文件</div>
          <p className="mt-2 max-w-md text-sm leading-6 text-ink-soft">
            文件数量：最多 50 个，文件类型：pdf, txt, csv, docx, doc, xlsx, xls, pptx, ppt, md, mobi, epub
          </p>
        </div>
      )}
    </div>
  );
}

export default DragDropOverlay;
