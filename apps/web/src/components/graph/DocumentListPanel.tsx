import clsx from 'clsx';
import { FileText, RefreshCw } from 'lucide-react';
import type { GraphDocument } from '../../hooks/useGraph';
import { prettyDocName } from './kinds';

function formatDate(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

interface DocumentListPanelProps {
  documents: GraphDocument[];
  loading: boolean;
  error: string | null;
  selectedId: string | null;
  onSelect: (doc: GraphDocument) => void;
  onRetry: () => void;
}

export function DocumentListPanel({ documents, loading, error, selectedId, onSelect, onRetry }: DocumentListPanelProps) {
  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-borderGray bg-white">
      <div className="shrink-0 border-b border-borderGray px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-[15px] font-semibold text-textDark">文档</span>
          <span className="text-[11px] text-textGray">{documents.length} 个已建图</span>
        </div>
        <div className="mt-0.5 text-[11px] text-textGray">按抽取时间倒序</div>
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
        ) : documents.length === 0 ? (
          <div className="flex flex-col items-center px-5 py-12 text-center">
            <FileText className="h-9 w-9 text-borderGray" aria-hidden />
            <div className="mt-3 text-[13px] font-medium text-textDark">暂无图谱文档</div>
            <div className="mt-1 text-[12px] leading-5 text-textGray">
              上传文档并在对话中完成实体抽取后，即可在这里浏览文档之间、文档与交易方和商品之间的关联
            </div>
          </div>
        ) : (
          documents.map((doc) => {
            const selected = doc.elementId === selectedId;
            const name = prettyDocName(doc.sourceUri);
            const date = formatDate(doc.createdAt);
            return (
              <button
                key={doc.elementId}
                type="button"
                onClick={() => onSelect(doc)}
                title={doc.sourceUri}
                className={clsx(
                  'block w-full border-b border-borderGray/60 px-3 py-2.5 text-left transition-colors',
                  selected ? 'bg-[#E8EEF4]' : 'hover:bg-bgGray',
                )}
                style={selected ? { boxShadow: 'inset 2px 0 0 #0F3A5C' } : undefined}
              >
                <div className="flex items-center gap-1.5">
                  <span className="max-w-[120px] truncate rounded border border-[#D8E2EB] bg-[#EEF2F6] px-1.5 py-px text-[10px] text-steelBlue">
                    {doc.docType || '文档'}
                  </span>
                  {date && <span className="ml-auto shrink-0 text-[11px] text-textGray">{date}</span>}
                </div>
                <div className="mt-1 line-clamp-1 text-[13px] leading-5 text-textDark">{name}</div>
              </button>
            );
          })
        )}
      </div>
    </aside>
  );
}
