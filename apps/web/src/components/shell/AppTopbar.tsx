import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { FolderOpen, LogOut } from 'lucide-react';

/** 顶栏：左侧视图标题（来自 navigation 注册表），右侧全局「文件」按钮 + 用户菜单。
 *  登出入口从 RealChatView 迁到这里（原为聊天顶栏的图标按钮）。 */
export function AppTopbar({
  title,
  subtitle,
  onOpenFiles,
  filesOpen = false,
  user,
  onSignOut,
}: {
  title: string;
  subtitle?: string;
  onOpenFiles: () => void;
  filesOpen?: boolean;
  user: { name?: string; email?: string } | null;
  onSignOut: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const handleMouseDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [menuOpen]);

  const displayName = user?.name ?? user?.email ?? '';
  const initial = displayName.slice(0, 1).toUpperCase() || '?';

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-line bg-white px-4">
      <div className="min-w-0">
        <h1 className="truncate text-base font-medium leading-tight text-ink">{title}</h1>
        {subtitle && <p className="truncate text-xs leading-tight text-ink-soft">{subtitle}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={onOpenFiles}
          title={filesOpen ? '收起文件面板' : '展开文件面板'}
          aria-pressed={filesOpen}
          className={clsx(
            'flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition-colors',
            filesOpen
              ? 'border-primary/30 bg-primary/5 font-medium text-primary'
              : 'border-line bg-white text-ink-soft hover:bg-surface hover:text-ink',
          )}
        >
          <FolderOpen className="h-4 w-4" aria-hidden />
          文件
        </button>
        <div className="relative" ref={menuRef}>
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            title={user?.email ?? displayName}
            aria-label="用户菜单"
            className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-sm font-medium text-primary transition-colors hover:bg-primary/20"
          >
            {initial}
          </button>
          {menuOpen && (
            <div className="animate-fade-in absolute right-0 top-full z-30 mt-2 w-56 rounded-lg border border-line bg-white p-1 shadow-lg">
              <div className="truncate px-3 py-2 text-xs text-ink-soft">
                {user?.email ?? '已登录'}
              </div>
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  onSignOut();
                }}
                className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-danger transition-colors hover:bg-danger/5"
              >
                <LogOut className="h-4 w-4" aria-hidden />
                退出登录
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
