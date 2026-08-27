import { useState, type ReactNode } from 'react';
import { NAV_ITEM_MAP, type ViewId } from './navigation';
import { AppNav } from './AppNav';
import { AppTopbar } from './AppTopbar';

/** 全局布局骨架：左侧双态导航 + 右侧（顶栏 + 路由出口 + 可选停靠侧板）。
 *  标题/副标题默认按 currentView 查 navigation 注册表，视图无需自报。
 *  filesPanel 与 main 平级（推挤主内容而非覆盖），由调用方传入文件管理等停靠面板。 */
export function AppShell({
  currentView,
  onNavigate,
  onOpenFiles,
  filesOpen = false,
  user,
  onSignOut,
  filesPanel,
  children,
}: {
  currentView: ViewId;
  onNavigate: (view: ViewId) => void;
  onOpenFiles: () => void;
  filesOpen?: boolean;
  user: { name?: string; email?: string } | null;
  onSignOut: () => void;
  filesPanel?: ReactNode;
  children: ReactNode;
}) {
  const [navCollapsed, setNavCollapsed] = useState(false);
  const navItem = NAV_ITEM_MAP[currentView];

  return (
    <div className="flex h-screen overflow-hidden bg-surface">
      <AppNav
        current={currentView}
        onNavigate={onNavigate}
        collapsed={navCollapsed}
        onToggleCollapsed={() => setNavCollapsed((v) => !v)}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <AppTopbar
          title={navItem?.label ?? '供应链 Agent'}
          subtitle={navItem?.description}
          onOpenFiles={onOpenFiles}
          filesOpen={filesOpen}
          user={user}
          onSignOut={onSignOut}
        />
        <div className="flex min-h-0 flex-1">
          <main className="relative min-w-0 flex-1">{children}</main>
          {filesPanel}
        </div>
      </div>
    </div>
  );
}
