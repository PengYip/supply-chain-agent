import clsx from 'clsx';
import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, FileStack, RefreshCw } from 'lucide-react';
import type { OverviewDoc } from '../../hooks/useBindings';
import { prettyDocName } from '../graph/businessTypes';

function formatDate(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

interface DocListPanelProps {
  docs: OverviewDoc[];
  /** 类型词汇表(SSOT: 后端 overview 响应的 docTypes), 用于筛选 chips。 */
  docTypes: string[];
  loading: boolean;
  error: string | null;
  selectedDocId: string | null;
  onSelect: (doc: OverviewDoc) => void;
  onRetry: () => void;
}

/** 目录分组标签: 去掉前导斜杠; 根目录文档归入"(根目录)"组。 */
function dirLabel(directory: string): string {
  const trimmed = directory.replace(/^\/+/, '');
  return trimmed || '(根目录)';
}

interface DirGroup {
  directory: string;
  label: string;
  docs: OverviewDoc[];
}

function DocRow({
  doc,
  selected,
  onSelect,
}: {
  doc: OverviewDoc;
  selected: boolean;
  onSelect: () => void;
}) {
  const name = prettyDocName(doc.fileName) || doc.fileName || doc.docId;
  const date = formatDate(doc.createdAt);
  // 分组语义: 有 confirmed 行才算"已绑定"; 仅有 proposed(待确认建议)算待处理。
  const bound = doc.bindings.some((b) => b.status === 'confirmed');
  const pendingCount = doc.bindings.filter((b) => b.status === 'proposed').length;
  return (
    <button
      type="button"
      onClick={onSelect}
      title={`${dirLabel(doc.directory)}/${doc.fileName}`}
      className={clsx(
        'block w-full border-b border-line/60 px-3 py-2.5 text-left transition-colors',
        selected ? 'bg-primary/10' : 'hover:bg-surface',
      )}
      style={selected ? { boxShadow: 'inset 2px 0 0 #0F3A5C' } : undefined}
    >
      <div className="flex items-center gap-1.5">
        <span className="max-w-[110px] shrink-0 truncate rounded border border-primary/20 bg-primary/10 px-1.5 py-px text-[10px] text-primary-500">
          {doc.docType || '文档'}
        </span>
        {!bound && pendingCount > 0 && (
          <span className="shrink-0 rounded border border-warning/35 bg-warning/15 px-1.5 py-px text-[10px] text-warning">
            建议 {pendingCount}
          </span>
        )}
        {bound && (
          <span
            className="shrink-0 rounded border px-1.5 py-px text-[10px] tabular-nums"
            style={
              pendingCount > 0
                ? { color: '#4A6D8C', background: '#EBF1F5', borderColor: '#CFDCE6' }
                : { color: '#15803D', background: '#E9F4EC', borderColor: '#CBE5D3' }
            }
          >
            {doc.bindings.length} 项绑定{pendingCount > 0 ? ` · ${pendingCount} 待确认` : ''}
          </span>
        )}
        {date && <span className="ml-auto shrink-0 text-[11px] text-ink-soft">{date}</span>}
      </div>
      <div className="mt-1 line-clamp-1 text-[13px] leading-5 text-ink">{name}</div>
    </button>
  );
}

export function DocListPanel({ docs, docTypes, loading, error, selectedDocId, onSelect, onRetry }: DocListPanelProps) {
  // 类型筛选: 空集合 = 全部。多选取并集。
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(new Set());
  // 目录折叠状态: 集合内 = 展开。默认全部展开(用户要一眼看到目录归属关系)。
  const [expandedDirs, setExpandedDirs] = useState<Set<string> | null>(null);

  const toggleType = (t: string) => {
    setSelectedTypes((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  };

  const filtered = useMemo(
    () => (selectedTypes.size === 0 ? docs : docs.filter((d) => selectedTypes.has(d.docType))),
    [docs, selectedTypes],
  );

  // 目录分组: 组按中文语序排序, 组内按文件名排序。
  const groups = useMemo<DirGroup[]>(() => {
    const map = new Map<string, OverviewDoc[]>();
    for (const d of filtered) {
      const key = d.directory || '/';
      const list = map.get(key);
      if (list) list.push(d);
      else map.set(key, [d]);
    }
    return Array.from(map.entries())
      .map(([directory, list]) => ({
        directory,
        label: dirLabel(directory),
        docs: list.sort((a, b) => a.fileName.localeCompare(b.fileName, 'zh-CN')),
      }))
      .sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'));
  }, [filtered]);

  const isExpanded = (directory: string) =>
    expandedDirs === null ? true : expandedDirs.has(directory);

  const toggleDir = (directory: string) => {
    setExpandedDirs((prev) => {
      const base = prev ?? new Set(groups.map((g) => g.directory));
      const next = new Set(base);
      if (next.has(directory)) next.delete(directory);
      else next.add(directory);
      return next;
    });
  };

  const setAllExpanded = (expanded: boolean) => {
    setExpandedDirs(expanded ? null : new Set());
  };

  const allCollapsed = expandedDirs !== null && expandedDirs.size === 0;

  return (
    <aside className="flex w-full shrink-0 flex-col border-r border-line bg-white">
      <div className="shrink-0 border-b border-line px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-[15px] font-semibold text-ink">文档</span>
          <span className="text-[11px] tabular-nums text-ink-soft">
            {selectedTypes.size === 0 ? `共 ${docs.length} 个` : `筛出 ${filtered.length}/${docs.length} 个`}
          </span>
          {!allCollapsed && groups.length > 1 && (
            <button
              type="button"
              onClick={() => setAllExpanded(false)}
              className="ml-auto text-[11px] text-ink-soft hover:text-ink"
            >
              全部折叠
            </button>
          )}
          {allCollapsed && (
            <button
              type="button"
              onClick={() => setAllExpanded(true)}
              className="ml-auto text-[11px] text-ink-soft hover:text-ink"
            >
              全部展开
            </button>
          )}
        </div>
        <div className="mt-0.5 text-[11px] text-ink-soft">按目录分组，同文件夹单据便于配对绑定</div>

        {/* 类型筛选 chips */}
        {docTypes.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1" data-testid="doc-type-filter">
            <button
              type="button"
              onClick={() => setSelectedTypes(new Set())}
              className={clsx(
                'rounded-full border px-2 py-0.5 text-[11px] transition-colors',
                selectedTypes.size === 0
                  ? 'border-primary bg-primary text-white'
                  : 'border-line text-ink-soft hover:border-primary/40 hover:text-ink',
              )}
            >
              全部
            </button>
            {docTypes.map((t) => {
              const active = selectedTypes.has(t);
              const n = docs.filter((d) => d.docType === t).length;
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => toggleType(t)}
                  title={`${t} · ${n} 个`}
                  className={clsx(
                    'rounded-full border px-2 py-0.5 text-[11px] transition-colors',
                    active
                      ? 'border-primary bg-primary text-white'
                      : 'border-line text-ink-soft hover:border-primary/40 hover:text-ink',
                  )}
                >
                  {t}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="space-y-2 p-3">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-14 animate-pulse rounded-lg bg-surface" />
            ))}
            <div className="pt-1 text-center text-[12px] text-ink-soft">文档列表加载中</div>
          </div>
        ) : error ? (
          <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
            <span className="text-[13px] leading-5 text-danger">{error}</span>
            <button
              type="button"
              onClick={onRetry}
              className="flex items-center gap-1 rounded-md border border-line px-2.5 py-1 text-[12px] text-ink hover:bg-surface"
            >
              <RefreshCw className="h-3 w-3" aria-hidden />
              重试
            </button>
          </div>
        ) : docs.length === 0 ? (
          <div className="flex flex-col items-center px-5 py-12 text-center">
            <FileStack className="h-9 w-9 text-line" aria-hidden />
            <div className="mt-3 text-[13px] font-medium text-ink">暂无文档</div>
            <div className="mt-1 text-[12px] leading-5 text-ink-soft">上传文档后即可在这里查看绑定状态</div>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center px-5 py-12 text-center">
            <div className="text-[13px] font-medium text-ink">没有符合筛选条件的文档</div>
            <button
              type="button"
              onClick={() => setSelectedTypes(new Set())}
              className="mt-3 rounded-md border border-line px-2.5 py-1 text-[12px] text-ink hover:bg-surface"
            >
              清空类型筛选
            </button>
          </div>
        ) : (
          groups.map((g) => {
            const expanded = isExpanded(g.directory);
            return (
              <section key={g.directory}>
                <button
                  type="button"
                  onClick={() => toggleDir(g.directory)}
                  className={clsx(
                    'sticky top-0 z-10 flex w-full items-center gap-1 border-b border-line bg-white/95 px-3 py-1.5 text-left backdrop-blur-sm hover:bg-surface',
                  )}
                  title={g.label}
                >
                  {expanded ? (
                    <ChevronDown className="h-3 w-3 shrink-0 text-ink-soft" aria-hidden />
                  ) : (
                    <ChevronRight className="h-3 w-3 shrink-0 text-ink-soft" aria-hidden />
                  )}
                  <span className="truncate text-[11px] font-medium tracking-wide text-ink-soft">{g.label}</span>
                  <span className="ml-0.5 shrink-0 text-[11px] font-semibold tabular-nums text-ink">{g.docs.length}</span>
                </button>
                {expanded &&
                  g.docs.map((doc) => (
                    <DocRow key={doc.docId} doc={doc} selected={doc.docId === selectedDocId} onSelect={() => onSelect(doc)} />
                  ))}
              </section>
            );
          })
        )}
      </div>
    </aside>
  );
}
