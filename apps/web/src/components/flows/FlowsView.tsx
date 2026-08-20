import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { fetchFlowContracts, type FlowContractOption } from '../../api/flows';
import { PageHeader } from '../shell/PageHeader';
import { ExecutionFlowPanel } from './ExecutionFlowPanel';
import { FilePreviewModal } from '../FilePreviewModal';
import type { FileEntry } from '../../hooks/useFiles';

type Phase = 'loading' | 'ready' | 'error';

/** 执行流水(四流合一)独立报表页: 合同下拉 + 选中合同的六向汇总与逐笔明细。 */
export function FlowsView({ onOpenParties }: { onOpenParties?: () => void }) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [contracts, setContracts] = useState<FlowContractOption[]>([]);
  const [error, setError] = useState('');
  const [selectedNo, setSelectedNo] = useState('');
  const [previewFile, setPreviewFile] = useState<FileEntry | null>(null);

  const load = useCallback(async () => {
    setPhase('loading');
    setError('');
    try {
      const rows = await fetchFlowContracts();
      setContracts(rows);
      setPhase('ready');
    } catch (e) {
      setError(e instanceof Error ? e.message : '合同列表加载失败');
      setPhase('error');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = contracts.find((c) => c.contractNo === selectedNo) ?? null;

  return (
    <div className="flex h-full flex-col overflow-hidden bg-bgGray">
      <PageHeader
        actions={
          <select
            value={selectedNo}
            onChange={(e) => setSelectedNo(e.target.value)}
            aria-label="选择合同"
            className="h-8 w-64 rounded-md border border-borderGray bg-white px-2.5 text-[12px] text-textDark focus:border-deepSea focus:outline-none"
          >
            <option value="">选择合同…</option>
            {contracts.map((c) => (
              <option key={c.contractNo} value={c.contractNo}>
                {c.displayContractNo ?? c.contractNo}
              </option>
            ))}
          </select>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {phase === 'loading' && (
          <div className="space-y-2">
            <div className="h-14 animate-pulse rounded-lg bg-bgGray" />
            <div className="h-14 animate-pulse rounded-lg bg-bgGray" />
            <div className="pt-1 text-center text-[12px] text-textGray">合同列表加载中</div>
          </div>
        )}

        {phase === 'error' && (
          <div className="flex flex-col items-center px-4 py-12 text-center">
            <AlertTriangle className="h-7 w-7 text-danger" aria-hidden />
            <div className="mt-2 max-w-[280px] break-all text-[13px] leading-5 text-danger">{error}</div>
            <button
              type="button"
              onClick={() => void load()}
              className="mt-3 flex items-center gap-1 rounded-md border border-borderGray bg-white px-2.5 py-1 text-[11px] text-textDark transition-colors hover:bg-bgGray"
            >
              <RefreshCw className="h-3 w-3" aria-hidden />
              重试
            </button>
          </div>
        )}

        {phase === 'ready' &&
          (contracts.length === 0 ? (
            <div className="flex flex-col items-center px-5 py-14 text-center">
              <div className="text-[13px] font-medium text-textDark">暂无可用合同</div>
            </div>
          ) : !selectedNo ? (
            <div className="flex flex-col items-center px-5 py-14 text-center">
              <div className="text-[13px] font-medium text-textDark">请选择合同号查看执行流水</div>
            </div>
          ) : (
            <ExecutionFlowPanel
              contractNo={selectedNo}
              displayContractNo={selected?.displayContractNo ?? undefined}
              onOpenParties={onOpenParties}
              onPreviewFile={setPreviewFile}
            />
          ))}
        {previewFile && <FilePreviewModal file={previewFile} onClose={() => setPreviewFile(null)} />}
      </div>
    </div>
  );
}
