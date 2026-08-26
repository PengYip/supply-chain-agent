// 合同搜索组合框(spec 2026-08-26 §4.3): 防抖 200ms -> /api/contracts/search,
// 下拉按 matchedField 分组(合同编号/买方/卖方/标题), 键盘导航, 竞态取最后请求。
import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { Loader2, Search } from 'lucide-react';
import { fetchContractSearch, type ContractSearchItem } from '../../api/contractSearch';

const GROUP_ORDER: Array<{ field: ContractSearchItem['matchedField']; label: string }> = [
  { field: 'contractNo', label: '合同编号' },
  { field: 'buyer', label: '买方' },
  { field: 'seller', label: '卖方' },
  { field: 'title', label: '标题' },
];

interface ContractSearchBarProps {
  placeholder?: string;
  onSelect: (item: ContractSearchItem) => void;
  /** 空输入聚焦时展示的默认候选(如 CandidatePanel 的台账前 N 条)。 */
  idleItems?: ContractSearchItem[];
  /** 每项右侧徽标文案(如 已挂合同文件)。 */
  itemNote?: (item: ContractSearchItem) => string | null;
  className?: string;
}

export function ContractSearchBar({
  placeholder = '搜索合同：编号 / 买方 / 卖方 / 标题',
  onSelect,
  idleItems,
  itemNote,
  className,
}: ContractSearchBarProps) {
  const [text, setText] = useState('');
  const [items, setItems] = useState<ContractSearchItem[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 防抖 + 竞态(AbortController, 后发先至丢弃)
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
      fetchContractSearch(q, 10, ac.signal)
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

  const flatItems = text.trim() ? items : (idleItems ?? []);

  // 单一有序列表：按 GROUP_ORDER 分组排序，与下拉渲染顺序完全一致。
  // 键盘导航的 activeIndex 与 Enter 选中都基于这份列表，避免「高亮项」与
  // 「回车提交项」因 API 原始顺序与分组渲染顺序不一致而错位。
  const orderedItems = useMemo(() => {
    const out: ContractSearchItem[] = [];
    for (const { field } of GROUP_ORDER) {
      for (const it of flatItems) {
        if (it.matchedField === field) out.push(it);
      }
    }
    return out;
  }, [flatItems]);

  // 列表变化时把 activeIndex 收敛到有效范围(新结果/清空时避免越界)。
  useEffect(() => {
    setActiveIndex((i) => (orderedItems.length === 0 ? 0 : Math.min(i, orderedItems.length - 1)));
  }, [orderedItems.length]);

  const choose = (item: ContractSearchItem) => {
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
    if (e.key === 'ArrowDown' && orderedItems.length > 0) {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % orderedItems.length);
    } else if (e.key === 'ArrowUp' && orderedItems.length > 0) {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + orderedItems.length) % orderedItems.length);
    } else if (e.key === 'Enter' && open && orderedItems[activeIndex]) {
      e.preventDefault();
      choose(orderedItems[activeIndex]!);
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
        <div className="absolute left-0 top-9 z-30 max-h-72 w-[340px] overflow-auto rounded-md border border-line bg-white py-1 shadow-card">
          {error && <div className="px-3 py-2 text-[12px] text-danger">搜索暂不可用：{error}</div>}
          {!error && flatItems.length === 0 && (
            <div className="px-3 py-2 text-[12px] text-ink-soft">
              {text.trim() ? `没有匹配「${text.trim()}」的合同` : '输入关键词搜索合同'}
            </div>
          )}
          {!error &&
            orderedItems.map((it, idx) => {
              // 分组头：字段切换时插入(与 orderedItems 顺序一致)。
              const showHeader = idx === 0 || orderedItems[idx - 1]!.matchedField !== it.matchedField;
              const note = itemNote?.(it) ?? null;
              return (
                <div key={it.contractNo}>
                  {showHeader && (
                    <div className="bg-surface px-3 py-1 text-[10px] font-medium text-ink-soft">
                      {GROUP_ORDER.find((g) => g.field === it.matchedField)?.label}
                    </div>
                  )}
                  <button
                    type="button"
                    onMouseEnter={() => setActiveIndex(idx)}
                    onClick={() => choose(it)}
                    className={clsx(
                      'block w-full px-3 py-1.5 text-left',
                      idx === activeIndex ? 'bg-primary/10' : 'hover:bg-surface',
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <span className="max-w-[220px] truncate text-[12px] font-medium text-ink">
                        {it.displayContractNo || it.contractNo}
                      </span>
                      {it.title && (
                        <span className="max-w-[90px] truncate text-[11px] text-ink-soft">{it.title}</span>
                      )}
                      {note && (
                        <span className="ml-auto shrink-0 rounded border border-line bg-surface px-1 py-px text-[10px] text-ink-soft">
                          {note}
                        </span>
                      )}
                    </div>
                    {(it.buyer || it.seller) && (
                      <div className="mt-0.5 truncate text-[11px] text-ink-soft">
                        {[it.buyer, it.seller].filter(Boolean).join(' -> ')}
                      </div>
                    )}
                  </button>
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
}