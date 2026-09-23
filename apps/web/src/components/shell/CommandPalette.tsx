import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import clsx from 'clsx';
import { CornerDownLeft, Search } from 'lucide-react';
import { NAV_GROUPS, NAV_ITEMS, type NavItem, type ViewId } from './navigation';
import { useApprovalPendingCount } from '../../hooks/useApprovalPendingCount';

/** 命令面板（Ctrl+K，菜单重构 2026-09-23）：按 label / description / keywords
 *  检索导航注册表并跳转。挂在 AppShell 层（fixed 遮罩 + 顶部居中卡片），
 *  键盘 ↑↓ 选择、Enter 跳转、Esc / 点击遮罩关闭；空查询展示全部分组。
 *  检索目标是导航注册表而非任意内容 —— 与侧边栏同一 SSOT，不另维护索引。 */

/** 多关键词检索：按空白切分查询词，全部命中才保留（AND 语义）。 */
function matches(item: NavItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [item.label, item.description ?? '', item.id, ...(item.keywords ?? [])]
    .join(' ')
    .toLowerCase();
  return q.split(/\s+/).every((token) => haystack.includes(token));
}

/** 角标数字的展示口径：超过 99 折叠为 99+，0 不渲染角标。 */
function formatBadge(count: number): string | null {
  if (count <= 0) return null;
  return count > 99 ? '99+' : String(count);
}

type Row =
  | { kind: 'group'; key: string; label: string }
  | { kind: 'item'; key: string; item: NavItem; index: number };

export function CommandPalette({
  open,
  current,
  onClose,
  onNavigate,
}: {
  open: boolean;
  current: ViewId;
  onClose: () => void;
  onNavigate: (view: ViewId) => void;
}) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const pendingCount = useApprovalPendingCount();

  const results = useMemo(
    () => NAV_ITEMS.filter((item) => item.enabled && matches(item, query)),
    [query],
  );

  // 分组展开为渲染行序列；group 行不占检索索引，键盘导航只落在 item 行。
  const rows = useMemo<Array<Row>>(() => {
    const out: Row[] = [];
    let index = 0;
    for (const group of NAV_GROUPS) {
      const items = results.filter((item) => item.group === group.id);
      if (items.length === 0) continue;
      out.push({ kind: 'group', key: `g-${group.id}`, label: group.label });
      for (const item of items) out.push({ kind: 'item', key: item.id, item, index: index++ });
    }
    return out;
  }, [results]);

  // 每次打开重置检索词与选中项，等渲染完成后聚焦输入框。
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveIndex(0);
    const raf = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [open]);

  // 检索结果变化时选中项收敛回首项，避免越界残留。
  useEffect(() => {
    setActiveIndex((i) => Math.min(i, Math.max(0, results.length - 1)));
  }, [results.length]);

  // 选中项滚动跟随（键盘连按时保持可见）；scrollIntoView 可选调用 ——
  // jsdom 等测试环境未实现该 API，缺席时静默跳过。
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex, open]);

  // 焦点不在输入框时也允许 Esc 关闭（点击面板空白处后键盘仍可用）。
  useEffect(() => {
    if (!open) return;
    const onWindowKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onWindowKeyDown);
    return () => window.removeEventListener('keydown', onWindowKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const choose = (view: ViewId) => {
    onClose();
    onNavigate(view);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = results[activeIndex];
      if (item) choose(item.id);
    }
  };

  return (
    <div
      className="animate-fade-in fixed inset-0 z-modal flex items-start justify-center bg-black/30 px-4 pt-[12vh]"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="快速跳转"
        onMouseDown={(e) => e.stopPropagation()}
        className="flex w-[min(30rem,92vw)] flex-col overflow-hidden rounded-xl border border-line bg-white shadow-lg"
      >
        {/* 检索输入行 */}
        <div className="flex items-center gap-2.5 border-b border-line px-4">
          <Search className="h-4 w-4 shrink-0 text-ink-soft" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            type="text"
            placeholder="搜索视图，如：审批 / 图谱 / 核销"
            aria-label="搜索视图"
            className="h-12 w-full bg-transparent text-sm text-ink outline-none placeholder:text-ink-soft"
          />
          <kbd className="shrink-0 rounded border border-line bg-surface px-1.5 py-0.5 text-[10px] text-ink-soft">
            Esc
          </kbd>
        </div>

        {/* 结果列表：按导航分组展开，审批中心带待办角标，当前视图打点 */}
        <div ref={listRef} role="listbox" aria-label="视图列表" className="max-h-80 overflow-y-auto p-1.5">
          {rows.map((row) =>
            row.kind === 'group' ? (
              <div key={row.key} className="px-2.5 pb-1 pt-2 text-[11px] font-medium text-ink-soft">
                {row.label}
              </div>
            ) : (
              (() => {
                const { item, index } = row;
                const active = index === activeIndex;
                const badge = item.badge === 'approvalPending' ? formatBadge(pendingCount) : null;
                return (
                  <button
                    key={row.key}
                    type="button"
                    role="option"
                    aria-selected={active}
                    data-index={index}
                    onMouseMove={() => setActiveIndex(index)}
                    onClick={() => choose(item.id)}
                    className={clsx(
                      'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors',
                      active ? 'bg-primary/5 text-primary' : 'text-ink hover:bg-surface',
                    )}
                  >
                    <item.icon className="h-4 w-4 shrink-0" aria-hidden />
                    <span className={clsx('truncate', active && 'font-medium')}>{item.label}</span>
                    {item.description && (
                      <span className="truncate text-xs text-ink-soft">{item.description}</span>
                    )}
                    <span className="min-w-0 flex-1" />
                    {badge && (
                      <span className="shrink-0 rounded-full bg-danger/10 px-1.5 py-0.5 text-[10px] font-medium text-danger">
                        {badge}
                      </span>
                    )}
                    {item.id === current && (
                      <span className="shrink-0 text-[10px] text-ink-soft">当前</span>
                    )}
                    {active && <CornerDownLeft className="h-3.5 w-3.5 shrink-0" aria-hidden />}
                  </button>
                );
              })()
            ),
          )}
          {results.length === 0 && (
            <p className="px-2.5 py-8 text-center text-sm text-ink-soft">
              没有匹配的视图，换个关键词试试
            </p>
          )}
        </div>

        {/* 键盘提示脚注 */}
        <div className="flex items-center gap-3 border-t border-line bg-surface px-4 py-2 text-[11px] text-ink-soft">
          <span>↑↓ 选择</span>
          <span>Enter 跳转</span>
          <span>Esc 关闭</span>
          <span className="min-w-0 flex-1" />
          <span>Ctrl K 唤起</span>
        </div>
      </div>
    </div>
  );
}
