// 左侧列表 — 项目为根的层级浏览(spec 2026-08-27 Task6):
// Project -> Contract(part_of) -> Document(履约), 后端 /api/graph/tree 聚合。
// 树不可用时静默降级为扁平文档兜底区; 点击任意层级即以该节点为画布中心展开。
import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { ChevronDown, FileText, FolderKanban, RefreshCw } from 'lucide-react';
import type { GraphDocument } from '../../hooks/useGraph';
import { prettyDocName } from './businessTypes';
import { treeDocIds, findDocMeta, type GraphTree } from './graphTree';

export interface ListNodeSelection {
  elementId: string;
  label: string;
  kind: string;
}

interface DocumentListPanelProps {
  tree: GraphTree | null;
  /** 已建图文档列表(树降级兜底 + 文件名解析用)。 */
  documents: GraphDocument[];
  loading: boolean;
  error: string | null;
  selectedId: string | null;
  onSelectNode: (item: ListNodeSelection) => void;
  onRetry: () => void;
}

function docLabel(doc: { elementId: string; name: string }, documents: GraphDocument[]): string {
  const meta = findDocMeta(documents, doc.elementId);
  if (meta?.sourceUri) return prettyDocName(meta.sourceUri);
  return doc.name || meta?.docId || '未命名单据';
}

function RowButton({
  depth, selected, onClick, title, children,
}: {
  depth: number; selected: boolean; onClick: () => void; title?: string; children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={clsx(
        'flex w-full items-center gap-1.5 border-b border-line/40 py-2 pr-3 text-left transition-colors',
        selected ? 'bg-primary/10' : 'hover:bg-surface',
      )}
      style={{ paddingLeft: `${12 + depth * 14}px`, ...(selected ? { boxShadow: 'inset 2px 0 0 #0F3A5C' } : undefined) }}
    >
      {children}
    </button>
  );
}

export function DocumentListPanel({
  tree, documents, loading, error, selectedId, onSelectNode, onRetry,
}: DocumentListPanelProps) {
  // 折叠态: key=elementId, 值恒为 false 才收起 → 只存"已收起"集合更简单
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const docIds = useMemo(() => treeDocIds(tree), [tree]);

  const docCount = docIds.size + documents.filter((d) => !docIds.has(d.elementId)).length;

  const toggleProject = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const renderContracts = (contracts: GraphTree['orphanContracts'], baseDepth: number) =>
    contracts.map((c) => (
      <div key={c.elementId}>
        <RowButton
          depth={baseDepth}
          selected={c.elementId === selectedId}
          onClick={() => onSelectNode({ elementId: c.elementId, label: c.name, kind: 'Contract' })}
          title={c.name}
        >
          <span className="h-1.5 w-1.5 shrink-0 rounded-[2px]" style={{ background: '#15803D' }} aria-hidden />
          <span className="line-clamp-1 text-[12.5px] leading-5 text-ink">{c.name}</span>
          <span className="ml-auto shrink-0 tabular-nums text-[10px] text-ink-soft">{c.docs.length}</span>
        </RowButton>
        {c.docs.map((d) => (
          <RowButton
            key={d.elementId}
            depth={baseDepth + 1}
            selected={d.elementId === selectedId}
            onClick={() => onSelectNode({ elementId: d.elementId, label: d.name, kind: 'Document' })}
            title={docLabel(d, documents)}
          >
            <FileText className="h-3 w-3 shrink-0 text-[#0F3A5C]" aria-hidden />
            <span className="line-clamp-1 text-[12px] leading-5 text-ink-soft">{docLabel(d, documents)}</span>
          </RowButton>
        ))}
      </div>
    ));

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-white">
      <div className="shrink-0 border-b border-line px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-[15px] font-semibold text-ink">图谱</span>
          <span className="text-[11px] text-ink-soft">{docCount} 个已建图</span>
        </div>
        <div className="mt-0.5 text-[11px] text-ink-soft">项目 · 合同 · 履约 层级浏览</div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="space-y-2 p-3">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-10 animate-pulse rounded-lg bg-surface" />
            ))}
            <div className="pt-1 text-center text-[12px] text-ink-soft">项目树加载中</div>
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
        ) : docCount === 0 ? (
          <div className="flex flex-col items-center px-5 py-12 text-center">
            <FolderKanban className="h-9 w-9 text-line" aria-hidden />
            <div className="mt-3 text-[13px] font-medium text-ink">暂无图谱数据</div>
            <div className="mt-1 text-[12px] leading-5 text-ink-soft">
              上传文档并在对话中完成实体抽取后，项目、合同与履约单据会按层级出现在这里
            </div>
          </div>
        ) : (
          <>
            {(tree?.projects ?? []).map((p) => {
              const isCollapsed = collapsed.has(p.elementId);
              return (
                <div key={p.elementId}>
                  <button
                    type="button"
                    onClick={() => toggleProject(p.elementId)}
                    onDoubleClick={() => onSelectNode({ elementId: p.elementId, label: p.name, kind: 'Project' })}
                    title={`${p.name}（双击设为画布中心）`}
                    className="flex w-full items-center gap-1.5 border-b border-line/60 bg-surface/60 px-3 py-2 text-left"
                  >
                    <ChevronDown
                      className={clsx('h-3 w-3 shrink-0 text-ink-soft transition-transform', isCollapsed && '-rotate-90')}
                      aria-hidden
                    />
                    <span className="rounded-[2px]" style={{ width: 8, height: 8, background: '#6D5FC3', display: 'inline-block' }} aria-hidden />
                    <span className="line-clamp-1 flex-1 text-[13px] font-medium leading-5 text-ink">{p.name}</span>
                    <span className="shrink-0 tabular-nums text-[10px] text-ink-soft">{p.contracts.length} 合同</span>
                  </button>
                  {!isCollapsed && renderContracts(p.contracts, 1)}
                </div>
              );
            })}
            {(tree?.orphanContracts.length ?? 0) > 0 && (
              <div>
                <div className="border-b border-line/60 bg-surface/40 px-3 py-1.5 text-[11px] text-ink-soft">
                  未分组
                </div>
                {renderContracts(tree!.orphanContracts, 0)}
              </div>
            )}
            {/* 树外兜底：未入树的文档仍可作中心展开 */}
            {documents
              .filter((d) => !docIds.has(d.elementId))
              .map((d) => {
                const name = d.sourceUri ? prettyDocName(d.sourceUri) : d.docId || '未命名单据';
                return (
                  <RowButton
                    key={d.elementId}
                    depth={0}
                    selected={d.elementId === selectedId}
                    onClick={() => onSelectNode({ elementId: d.elementId, label: name, kind: 'Document' })}
                    title={name}
                  >
                    <FileText className="h-3 w-3 shrink-0 text-[#0F3A5C]" aria-hidden />
                    <span className="line-clamp-1 flex-1 text-[12px] leading-5 text-ink-soft">{name}</span>
                  </RowButton>
                );
              })}
          </>
        )}
      </div>
    </aside>
  );
}
