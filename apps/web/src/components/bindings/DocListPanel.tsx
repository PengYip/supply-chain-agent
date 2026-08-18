import clsx from 'clsx';
import { FileStack, RefreshCw } from 'lucide-react';
import type { OverviewDoc } from '../../hooks/useBindings';
import { prettyDocName } from '../graph/kinds';

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
  loading: boolean;
  error: string | null;
  selectedDocId: string | null;
  /** 每文档的待确认建议数(未绑定文档显示提示角标)。 */
  proposalsByDoc: Map<string, number>;
  onSelect: (doc: OverviewDoc) => void;
  onRetry: () => void;
}

function GroupHeader({ label, count, hint }: { label: string; count: number; hint?: string }) {
  return (
    <div className="sticky top-0 z-10 flex items-baseline gap-1.5 border-b border-borderGray bg-white/95 px-4 py-1.5 backdrop-blur-sm">
      <span className="text-[11px] font-medium tracking-wide text-textGray">{label}</span>
      <span className="text-[11px] font-semibold tabular-nums text-textDark">{count}</span>
      {hint && <span className="ml-auto text-[10px] text-textGray">{hint}</span>}
    </div>
  );
}

function DocRow({
  doc,
  selected,
  proposalCount,
  onSelect,
}: {
  doc: OverviewDoc;
  selected: boolean;
  proposalCount: number;
  onSelect: () => void;
}) {
  const name = prettyDocName(doc.fileName) || doc.fileName || doc.docId;
  const date = formatDate(doc.createdAt);
  const bound = doc.bindings.length > 0;
  const pendingCount = doc.bindings.filter((b) => b.status === 'proposed').length;
  return (
    <button
      type="button"
      onClick={onSelect}
      title={doc.fileName}
      className={clsx(
        'block w-full border-b border-borderGray/60 px-3 py-2.5 text-left transition-colors',
        selected ? 'bg-[#E8EEF4]' : 'hover:bg-bgGray',
      )}
      style={selected ? { boxShadow: 'inset 2px 0 0 #0F3A5C' } : undefined}
    >
      <div className="flex items-center gap-1.5">
        <span className="max-w-[110px] shrink-0 truncate rounded border border-[#D8E2EB] bg-[#EEF2F6] px-1.5 py-px text-[10px] text-steelBlue">
          {doc.docType || '文档'}
        </span>
        {!bound && proposalCount > 0 && (
          <span className="shrink-0 rounded border border-[#F0D9B0] bg-[#FBF0DE] px-1.5 py-px text-[10px] text-amber">
            建议 {proposalCount}
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
        {date && <span className="ml-auto shrink-0 text-[11px] text-textGray">{date}</span>}
      </div>
      <div className="mt-1 line-clamp-1 text-[13px] leading-5 text-textDark">{name}</div>
    </button>
  );
}

export function DocListPanel({ docs, loading, error, selectedDocId, proposalsByDoc, onSelect, onRetry }: DocListPanelProps) {
  const unbound = docs.filter((d) => d.bindings.length === 0);
  const bound = docs.filter((d) => d.bindings.length > 0);

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-borderGray bg-white">
      <div className="shrink-0 border-b border-borderGray px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-[15px] font-semibold text-textDark">文档</span>
          <span className="text-[11px] text-textGray">共 {docs.length} 个</span>
        </div>
        <div className="mt-0.5 text-[11px] text-textGray">按绑定状态分组，未绑定在前</div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="space-y-2 p-3">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-14 animate-pulse rounded-lg bg-bgGray" />
            ))}
            <div className="pt-1 text-center text-[12px] text-textGray">文档列表加载中</div>
          </div>
        ) : error ? (
          <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
            <span className="text-[13px] leading-5 text-danger">{error}</span>
            <button
              type="button"
              onClick={onRetry}
              className="flex items-center gap-1 rounded-md border border-borderGray px-2.5 py-1 text-[12px] text-textDark hover:bg-bgGray"
            >
              <RefreshCw className="h-3 w-3" aria-hidden />
              重试
            </button>
          </div>
        ) : docs.length === 0 ? (
          <div className="flex flex-col items-center px-5 py-12 text-center">
            <FileStack className="h-9 w-9 text-borderGray" aria-hidden />
            <div className="mt-3 text-[13px] font-medium text-textDark">暂无文档</div>
            <div className="mt-1 text-[12px] leading-5 text-textGray">上传文档后即可在这里查看绑定状态</div>
          </div>
        ) : (
          <>
            <GroupHeader label="未绑定" count={unbound.length} hint="待处理" />
            {unbound.map((doc) => (
              <DocRow
                key={doc.docId}
                doc={doc}
                selected={doc.docId === selectedDocId}
                proposalCount={proposalsByDoc.get(doc.docId) ?? 0}
                onSelect={() => onSelect(doc)}
              />
            ))}
            <GroupHeader label="已绑定" count={bound.length} />
            {bound.map((doc) => (
              <DocRow
                key={doc.docId}
                doc={doc}
                selected={doc.docId === selectedDocId}
                proposalCount={proposalsByDoc.get(doc.docId) ?? 0}
                onSelect={() => onSelect(doc)}
              />
            ))}
          </>
        )}
      </div>
    </aside>
  );
}
