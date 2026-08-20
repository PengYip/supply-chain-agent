import clsx from 'clsx';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { NAV_GROUPS, NAV_ITEMS, type ViewId } from './navigation';

/** 左侧双态导航：展开 224px（分组标签 + 图标 + 文字），折叠 56px（纯图标，hover 提示）。
 *  底部为折叠开关；用户身份与登出在 AppTopbar，避免双入口。 */
export function AppNav({
  current,
  onNavigate,
  collapsed,
  onToggleCollapsed,
}: {
  current: ViewId;
  onNavigate: (view: ViewId) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  return (
    <nav
      className={clsx(
        'flex shrink-0 flex-col border-r border-borderGray bg-white transition-[width] duration-200',
        collapsed ? 'w-14' : 'w-56',
      )}
    >
      {/* 产品标识 */}
      <div
        className={clsx(
          'flex h-14 shrink-0 items-center border-b border-borderGray',
          collapsed ? 'justify-center' : 'px-4',
        )}
      >
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-deepSea text-xs font-bold text-white">
          供
        </div>
        {!collapsed && (
          <span className="ml-2.5 truncate text-sm font-semibold text-textDark">供应链 Agent</span>
        )}
      </div>

      {/* 分组导航 */}
      <div className="flex-1 overflow-y-auto px-2 py-3">
        {NAV_GROUPS.map((group) => (
          <div key={group.id} className="mb-4 last:mb-0">
            {!collapsed && (
              <div className="px-2 pb-1.5 text-[11px] font-medium text-textGray">{group.label}</div>
            )}
            <div className="space-y-0.5">
              {NAV_ITEMS.filter((item) => item.group === group.id && item.enabled).map((item) => {
                const active = item.id === current;
                const Icon = item.icon;
                return (
                  <button
                    key={item.id}
                    type="button"
                    title={item.label}
                    aria-label={item.label}
                    aria-current={active ? 'page' : undefined}
                    onClick={() => onNavigate(item.id)}
                    className={clsx(
                      'flex w-full items-center rounded-lg text-sm transition-colors',
                      collapsed ? 'h-9 justify-center' : 'px-2.5 py-2',
                      active
                        ? 'bg-deepSea font-medium text-white'
                        : 'text-textGray hover:bg-bgGray hover:text-textDark',
                    )}
                  >
                    <Icon className="h-5 w-5 shrink-0" aria-hidden />
                    {!collapsed && <span className="ml-2.5 truncate">{item.label}</span>}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* 底部折叠开关（与图谱/绑定面板一致：不持久化） */}
      <div className="shrink-0 border-t border-borderGray p-2">
        <button
          type="button"
          onClick={onToggleCollapsed}
          title={collapsed ? '展开导航' : '收起导航'}
          aria-label={collapsed ? '展开导航' : '收起导航'}
          className="flex h-9 w-full items-center justify-center rounded-lg text-textGray transition-colors hover:bg-bgGray hover:text-textDark"
        >
          {collapsed ? (
            <PanelLeftOpen className="h-5 w-5" aria-hidden />
          ) : (
            <PanelLeftClose className="h-5 w-5" aria-hidden />
          )}
        </button>
      </div>
    </nav>
  );
}
