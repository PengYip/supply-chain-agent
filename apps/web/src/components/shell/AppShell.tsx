import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { NAV_ITEM_MAP, type ViewId } from './navigation';
import { AppNav } from './AppNav';
import { AppTopbar } from './AppTopbar';
import { CommandPalette } from './CommandPalette';

/** 折叠态持久化键（菜单重构 2026-09-23）：'0' = 展开，其余/缺失 = 收起（保持
 *  原默认窄条）。隐私模式等 localStorage 不可用场景静默降级为会话内状态。 */
const NAV_COLLAPSED_KEY = 'sca.navCollapsed';

function readNavCollapsed(): boolean {
  try {
    return localStorage.getItem(NAV_COLLAPSED_KEY) !== '0';
  } catch {
    return true;
  }
}

/** 全局布局骨架：左侧双态导航 + 右侧（顶栏 + 路由出口 + 停靠侧板）。
 *  标题/副标题默认按 currentView 查 navigation 注册表，视图无需自报。
 *  filesPanel 与 main 平级（推挤主内容而非覆盖），由调用方传入文件管理面板；
 *  面板常驻挂载，收起时自身宽度归零，main 以 flex-1 延展占满剩余空间。
 *  命令面板（Ctrl+K）挂在本层：fixed 定位不占布局，跳转复用 onNavigate。 */
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
  // 默认收起为窄条（56px 纯图标），把横向空间留给主内容区；用户手动切换后记忆。
  const [navCollapsed, setNavCollapsed] = useState(readNavCollapsed);
  const toggleNavCollapsed = useCallback(() => {
    setNavCollapsed((v) => {
      const next = !v;
      try {
        localStorage.setItem(NAV_COLLAPSED_KEY, next ? '1' : '0');
      } catch {
        /* 存储不可用时仅会话内生效 */
      }
      return next;
    });
  }, []);

  const [paletteOpen, setPaletteOpen] = useState(false);
  // Ctrl+K / Cmd+K 全局唤起命令面板；再按一次切换关闭。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const navItem = NAV_ITEM_MAP[currentView];

  return (
    <div className="flex h-screen w-full overflow-hidden bg-surface">
      <AppNav
        current={currentView}
        onNavigate={onNavigate}
        collapsed={navCollapsed}
        onToggleCollapsed={toggleNavCollapsed}
        onOpenPalette={() => setPaletteOpen(true)}
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
      <CommandPalette
        open={paletteOpen}
        current={currentView}
        onClose={() => setPaletteOpen(false)}
        onNavigate={onNavigate}
      />
    </div>
  );
}
