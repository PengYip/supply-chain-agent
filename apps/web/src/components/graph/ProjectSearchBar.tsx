// 项目搜索组合框(照 ContractSearchBar 的交互模式): 防抖 200ms ->
// /api/graph/entities?kind=Project&name=, 键盘导航 + 点击外部关闭 +
// AbortController 竞态取最后请求。选中项直接携带 elementId, 无需 resolve。
import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { FolderKanban, Loader2, Search } from 'lucide-react';
import { fetchGraphEntityItems, type GraphEntityItem } from '../../hooks/useGraph';

interface ProjectSearchBarProps {
  placeholder?: string;
  onSelect: (item: GraphEntityItem) => void;
  className?: string;
}

export function ProjectSearchBar({
  placeholder = '搜索项目',
  onSelect,
  className,
}: ProjectSearchBarProps) {
  const [text, setText] = useState('');
  const [items, setItems] = useState<GraphEntityItem[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const q = text.trim();
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!q) {
      abortRef.current?.abort();
      setItems([]);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    debounceRef.current = setTimeout(() => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      fetchGraphEntityItems({ kind: 'Project', name: q }, ac.signal)
        .then((list) => {
          if (ac.signal.aborted) return;
          setItems(list);
          setError(null);
          setActiveIndex(0);
        })
        .catch((e) => {
          if (ac.signal.aborted || (e instanceof DOMException && e.name === 'AbortError')) return;
          setItems([]);
          setError(e instanceof Error ? e.message : '搜索失败');
        })
        .finally(() => {
          if (!ac.signal.aborted) setLoading(false);
        });
    }, 200);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [text]);

  // 点击外部关闭
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  // 列表变化时把 activeIndex 收敛到有效范围。
  useEffect(() => {
    setActiveIndex((i) => (items.length === 0 ? 0 : Math.min(i, items.length - 1)));
  }, [items.length]);

  const choose = (item: GraphEntityItem) => {
    onSelect(item);
    setText('');
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // 中文输入法组合期间不响应导航/选中(Enter 用于上屏候选)。
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (!open && (e.key === 'ArrowDown' || e.key === 'Enter')) {
      setOpen(true);
      return;
    }
    if (e.key === 'ArrowDown' && items.length > 0) {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % items.length);
    } else if (e.key === 'ArrowUp' && items.length > 0) {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + items.length) % items.length);
    } else if (e.key === 'Enter' && open && items[activeIndex]) {
      e.preventDefault();
      choose(items[activeIndex]!);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div ref={rootRef} className={clsx('relative', className)}>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-soft" aria-hidden />
        <input
          type="text"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          className="h-8 w-full rounded-md border border-line bg-white pl-8 pr-7 text-[12px] text-ink focus:border-primary focus:outline-none"
        />
        {loading && (
          <Loader2 className="absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-ink-soft" aria-hidden />
        )}
      </div>
      {open && (
        <div className="absolute left-0 top-9 z-30 max-h-72 w-[240px] overflow-auto rounded-md border border-line bg-white py-1 shadow-card">
          {error && <div className="px-3 py-2 text-[12px] text-danger">项目搜索暂不可用：{error}</div>}
          {!error && items.length === 0 && (
            <div className="px-3 py-2 text-[12px] text-ink-soft">
              {text.trim() ? `没有匹配「${text.trim()}」的项目` : '输入项目名称搜索（需已同步到图谱）'}
            </div>
          )}
          {!error &&
            items.map((it, idx) => (
              <button
                key={it.elementId}
                type="button"
                onMouseEnter={() => setActiveIndex(idx)}
                onClick={() => choose(it)}
                className={clsx(
                  'flex w-full items-center gap-2 px-3 py-1.5 text-left',
                  idx === activeIndex ? 'bg-primary/10' : 'hover:bg-surface',
                )}
              >
                <FolderKanban className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
                <span className="min-w-0 truncate text-[12px] font-medium text-ink" title={it.name}>
                  {it.name}
                </span>
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
