import clsx from 'clsx';
import { PanelLeftClose, PanelLeftOpen, Search } from 'lucide-react';
import { NAV_GROUPS, NAV_ITEMS, type ViewId } from './navigation';
import { useApprovalPendingCount } from '../../hooks/useApprovalPendingCount';

/** 左侧双态导航：展开 192px（分组标签 + 图标 + 文字 + 角标），折叠 56px
 *  （纯图标 + 角标点，hover 提示）。底部为命令面板入口（Ctrl K）与折叠开关；
 *  用户身份与登出在 AppTopbar，避免双入口。
 *  待办角标（菜单重构 2026-09-23）：审批中心项显示 pending 总数，数据来自
 *  lib/approvalPending.ts 外部 store（AppSession 全局轮询 + 审批中心回写）。 */
export function AppNav({
  current,
  onNavigate,
  collapsed,
  onToggleCollapsed,
  onOpenPalette,
}: {
  current: ViewId;
  onNavigate: (view: ViewId) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onOpenPalette: () => void;
}) {
  const pendingCount = useApprovalPendingCount();

  return (
    <nav
      className={clsx(
        'flex shrink-0 flex-col border-r border-line bg-white transition-[width] duration-200',
        collapsed ? 'w-14' : 'w-48',
      )}
    >
      {/* 产品标识 */}
      <div
        className={clsx(
          'flex h-14 shrink-0 items-center border-b border-line',
          collapsed ? 'justify-center' : 'px-4',
        )}
      >
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary text-xs font-bold text-white">
          供
        </div>
        {!collapsed && (
          <span className="ml-2.5 truncate text-sm font-semibold text-ink">供应链 Agent</span>
        )}
      </div>

      {/* 分组导航 */}
      <div className="flex-1 overflow-y-auto px-2 py-3">
        {NAV_GROUPS.map((group) => (
          <div key={group.id} className="mb-4 last:mb-0">
            {!collapsed && (
              <div className="px-2 pb-1.5 text-[11px] font-medium text-ink-soft">{group.label}</div>
            )}
            <div className="space-y-0.5">
              {NAV_ITEMS.filter((item) => item.group === group.id && item.enabled).map((item) => {
                const active = item.id === current;
                const Icon = item.icon;
                const badgeCount =
                  item.badge === 'approvalPending' && pendingCount > 0
                    ? pendingCount > 99
                      ? '99+'
                      : String(pendingCount)
                    : null;
                return (
                  <button
                    key={item.id}
                    type="button"
                    title={item.label}
                    aria-label={badgeCount ? `${item.label}（${badgeCount} 条待办）` : item.label}
                    aria-current={active ? 'page' : undefined}
                    onClick={() => onNavigate(item.id)}
                    className={clsx(
                      'relative flex w-full items-center rounded-lg text-sm transition-colors',
                      collapsed ? 'h-9 justify-center' : 'px-2.5 py-2',
                      active
                        ? 'bg-primary font-medium text-white'
                        : 'text-ink-soft hover:bg-surface hover:text-ink',
                    )}
                  >
                    <Icon className="h-5 w-5 shrink-0" aria-hidden />
                    {!collapsed && <span className="ml-2.5 truncate">{item.label}</span>}
                    {/* 待办角标：展开态右对齐数字胶囊；折叠态浮在图标右上角 */}
                    {badgeCount &&
                      (collapsed ? (
                        <span className="absolute right-1 top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-medium leading-none text-white">
                          {badgeCount}
                        </span>
                      ) : (
                        <span
                          className={clsx(
                            'ml-auto shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-none',
                            active ? 'bg-white/20 text-white' : 'bg-danger/10 text-danger',
                          )}
                        >
                          {badgeCount}
                        </span>
                      ))}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* 底部：命令面板入口 + 折叠开关（折叠态记忆于 localStorage，见 AppShell） */}
      <div className="shrink-0 border-t border-line p-2">
        <button
          type="button"
          onClick={onOpenPalette}
          title="快速跳转（Ctrl K）"
          aria-label="快速跳转（Ctrl K）"
          className="mb-0.5 flex h-9 w-full items-center rounded-lg text-ink-soft transition-colors hover:bg-surface hover:text-ink"
        >
          <Search className="h-5 w-5 shrink-0" aria-hidden />
          {!collapsed && (
            <>
              <span className="ml-2.5 truncate">快速跳转</span>
              <kbd className="ml-auto rounded border border-line bg-surface px-1.5 py-0.5 text-[10px] text-ink-soft">
                Ctrl K
              </kbd>
            </>
          )}
        </button>
        <button
          type="button"
          onClick={onToggleCollapsed}
          title={collapsed ? '展开导航' : '收起导航'}
          aria-label={collapsed ? '展开导航' : '收起导航'}
          className="flex h-9 w-full items-center justify-center rounded-lg text-ink-soft transition-colors hover:bg-surface hover:text-ink"
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
