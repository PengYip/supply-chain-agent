import clsx from 'clsx';
import { ChevronLeft, ChevronRight, type LucideIcon } from 'lucide-react';

/** 面板折叠把手：贴在面板画布侧边缘的窄竖条。折叠后仅剩本条，画布占满剩余空间。
 *  从 graph/GraphView 与 bindings/BindingsView 的重复实现抽取（props 不变）。 */
export function PanelRail({
  collapsed,
  side,
  label,
  onToggle,
}: {
  collapsed: boolean;
  side: 'left' | 'right';
  label: string;
  onToggle: () => void;
}) {
  // 箭头指向状态变化方向：展开态指向收起方向，折叠态指向展开方向
  const Chevron: LucideIcon = collapsed
    ? side === 'left'
      ? ChevronRight
      : ChevronLeft
    : side === 'left'
      ? ChevronLeft
      : ChevronRight;
  const action = collapsed ? `展开${label}面板` : `收起${label}面板`;
  return (
    <div
      className={clsx(
        'flex w-7 shrink-0 flex-col items-center bg-white',
        side === 'left' ? 'border-r border-line' : 'border-l border-line',
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        title={action}
        aria-label={action}
        className="mt-1 flex h-7 w-7 items-center justify-center rounded-md text-ink-soft transition-colors hover:bg-surface hover:text-primary"
      >
        <Chevron className="h-4 w-4" aria-hidden />
      </button>
      {collapsed && (
        <div className="flex flex-1 items-center justify-center pt-2 text-[11px] tracking-[0.3em] text-ink-soft [writing-mode:vertical-rl]">
          {label}
        </div>
      )}
    </div>
  );
}
