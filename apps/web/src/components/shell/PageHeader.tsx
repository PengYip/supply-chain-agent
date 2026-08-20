import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

/** 视图内页头/工具条。全局视图标题由 AppTopbar 按注册表渲染，
 *  这里承载视图私有内容：可选标题（内部子页）、tabs（eval 双 Tab）、actions（刷新/计数等）。
 *  Phase 2 各视图迁移时使用；高度与 AppTopbar 对齐保持节奏一致。 */
export function PageHeader({
  title,
  subtitle,
  icon: Icon,
  tabs,
  actions,
}: {
  title?: string;
  subtitle?: string;
  icon?: LucideIcon;
  tabs?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex h-14 shrink-0 items-center gap-3 border-b border-borderGray bg-white px-4">
      {title && (
        <div className="flex min-w-0 items-center gap-2.5">
          {Icon && <Icon className="h-5 w-5 shrink-0 text-deepSea" aria-hidden />}
          <div className="min-w-0">
            <h2 className="truncate text-sm font-medium leading-tight text-textDark">{title}</h2>
            {subtitle && <p className="truncate text-xs leading-tight text-textGray">{subtitle}</p>}
          </div>
        </div>
      )}
      <div className="min-w-0 flex-1" />
      {tabs && <div className="flex shrink-0 items-center gap-1">{tabs}</div>}
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
