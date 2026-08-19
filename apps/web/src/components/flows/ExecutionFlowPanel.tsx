import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { AlertTriangle, ChevronDown, ChevronUp, RefreshCw } from 'lucide-react';
import {
  fetchExecutionFlows,
  flowDirectionLabel,
  flowText,
  formatFlowAmount,
  formatFlowQuantity,
  pickRepresentativeUnit,
  sortFlowSummaries,
  type ExecutionFlowItem,
  type ExecutionFlowsResponse,
  type FlowSummary,
} from '../../api/flows';

export interface ExecutionFlowPanelProps {
  contractNo: string;
  /** 头部展示用, 缺省用 contractNo。 */
  displayContractNo?: string;
  /** 溯源: 定位到该凭证所属文档。缺省时不渲染按钮, 溯源列降级为悬浮文本。 */
  onLocateDocument?: (documentId: string) => void;
}

type Phase = 'idle' | 'loading' | 'ready' | 'error';

/** 单张六向汇总卡: 词汇名徽章 + 笔数 + 金额/数量合计 + 最近凭证日期。 */
function SummaryCard({ summary, groupFlows }: { summary: FlowSummary; groupFlows: ExecutionFlowItem[] }) {
  const isIn = summary.direction === 'in';
  const badgeCls = isIn
    ? 'border-[#CBE5D3] bg-[#E9F4EC] text-[#15803D]'
    : 'border-[#CFDCE6] bg-[#EBF1F5] text-steelBlue';
  return (
    <div className="rounded-md border border-borderGray px-3 py-2.5">
      <div className="flex items-center gap-1.5">
        <span className={clsx('shrink-0 rounded border px-1.5 py-px text-[10px]', badgeCls)}>
          {flowDirectionLabel(summary.flowType, summary.direction)}
        </span>
        <span className="ml-auto shrink-0 text-[11px] tabular-nums text-textGray">{summary.entryCount} 笔</span>
      </div>
      <div className="mt-2">
        <div className="text-[11px] text-textGray">金额合计</div>
        <div className="mt-0.5 truncate text-[13px] font-semibold tabular-nums text-textDark">
          {formatFlowAmount(summary.totalAmount)}
        </div>
      </div>
      {summary.totalQuantityTon !== null && (
        <div className="mt-1.5">
          <div className="text-[11px] text-textGray">数量合计</div>
          <div className="mt-0.5 truncate text-[13px] font-semibold tabular-nums text-textDark">
            {formatFlowQuantity(summary.totalQuantityTon, pickRepresentativeUnit(groupFlows))}
          </div>
        </div>
      )}
      <div className="mt-1.5 flex items-center justify-between gap-1">
        <span className="shrink-0 text-[11px] text-textGray">最近凭证</span>
        <span className="min-w-0 truncate text-[11px] tabular-nums text-textDark">{flowText(summary.lastVoucherDate)}</span>
      </div>
    </div>
  );
}

/** 逐笔明细行: 流向徽章 + 金额/数量(右对齐) + 凭证日期 + 凭证类型 + 溯源列。 */
function FlowRow({
  flow,
  onLocateDocument,
}: {
  flow: ExecutionFlowItem;
  onLocateDocument?: (documentId: string) => void;
}) {
  const isIn = flow.direction === 'in';
  const badgeCls = isIn
    ? 'border-[#CBE5D3] bg-[#E9F4EC] text-[#15803D]'
    : 'border-[#CFDCE6] bg-[#EBF1F5] text-steelBlue';
  const traceTitle = flow.extractionId
    ? `documentId: ${flow.documentId} / extractionId: ${flow.extractionId}`
    : `documentId: ${flow.documentId}`;
  return (
    <div className="grid grid-cols-[64px_1fr_1fr_92px_1fr_84px] items-center border-b border-borderGray/60 last:border-b-0">
      <div className="px-2 py-1.5">
        <span className={clsx('rounded border px-1.5 py-px text-[10px]', badgeCls)}>
          {flowDirectionLabel(flow.flowType, flow.direction)}
        </span>
      </div>
      <div className="px-2 py-1.5 text-right text-[12px] tabular-nums text-textDark">{formatFlowAmount(flow.amount)}</div>
      <div className="px-2 py-1.5 text-right text-[12px] tabular-nums text-textDark">
        {formatFlowQuantity(flow.quantityTon, flow.unit)}
      </div>
      <div className="px-2 py-1.5 text-[12px] tabular-nums text-textDark">{flowText(flow.voucherDate)}</div>
      <div className="break-all px-2 py-1.5 text-[12px] leading-4 text-textDark">{flowText(flow.docType)}</div>
      <div className="px-2 py-1.5">
        {flow.documentId ? (
          onLocateDocument ? (
            <button
              type="button"
              onClick={() => onLocateDocument(flow.documentId)}
              title={traceTitle}
              className="text-[11px] text-deepSea transition-colors hover:underline"
            >
              定位凭证
            </button>
          ) : (
            <span className="cursor-default text-[11px] text-textGray" title={traceTitle}>
              {flow.documentId.length > 12 ? `${flow.documentId.slice(0, 12)}…` : flow.documentId}
            </span>
          )
        ) : (
          <span className="text-[12px] text-borderGray">—</span>
        )}
      </div>
    </div>
  );
}

/** 执行流水(四流合一)报表: 六向汇总卡 + 逐笔明细表。 */
export function ExecutionFlowPanel({ contractNo, displayContractNo, onLocateDocument }: ExecutionFlowPanelProps) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [data, setData] = useState<ExecutionFlowsResponse | null>(null);
  const [error, setError] = useState('');
  const [collapsed, setCollapsed] = useState(false);
  // 自增请求序号: 快速切换合同时只认最新请求, 丢弃过期响应。
  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
    const reqId = ++requestIdRef.current;
    setPhase('loading');
    setError('');
    try {
      const res = await fetchExecutionFlows(contractNo);
      if (reqId !== requestIdRef.current) return;
      setData(res);
      setPhase('ready');
    } catch (e) {
      if (reqId !== requestIdRef.current) return;
      setError(e instanceof Error ? e.message : '执行流水加载失败');
      setPhase('error');
    }
  }, [contractNo]);

  useEffect(() => {
    void load();
  }, [load]);

  // 六向汇总按固定次序排序; 该组逐笔行用于数量合计的单位推断。
  const sortedSummaries = useMemo(() => (data ? sortFlowSummaries(data.summaries) : []), [data]);
  const flowsByGroup = useMemo(() => {
    const map = new Map<string, ExecutionFlowItem[]>();
    if (data) {
      for (const f of data.flows) {
        const key = `${f.flowType}-${f.direction}`;
        const arr = map.get(key);
        if (arr) arr.push(f);
        else map.set(key, [f]);
      }
    }
    return map;
  }, [data]);

  const headerNo = displayContractNo || contractNo;

  return (
    <div className="mt-2.5 animate-fade-in overflow-hidden rounded-md border border-borderGray bg-white">
      <div className="flex items-center gap-1.5 border-b border-borderGray bg-bgGray px-2.5 py-1.5">
        <span className="shrink-0 text-[11px] font-medium text-textDark">执行流水</span>
        <span className="min-w-0 truncate font-mono text-[10px] text-textGray" title={headerNo}>
          {headerNo}
        </span>
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          title={collapsed ? '展开执行流水' : '收起执行流水'}
          aria-label={collapsed ? '展开执行流水' : '收起执行流水'}
          aria-expanded={!collapsed}
          className="ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-textGray transition-colors hover:bg-white hover:text-deepSea"
        >
          {collapsed ? (
            <ChevronDown className="h-3.5 w-3.5" aria-hidden />
          ) : (
            <ChevronUp className="h-3.5 w-3.5" aria-hidden />
          )}
        </button>
      </div>

      {!collapsed && (
        <div className="max-h-[42vh] overflow-y-auto p-2.5">
          {(phase === 'idle' || phase === 'loading') && (
            <div className="space-y-2">
              <div className="h-14 animate-pulse rounded-lg bg-bgGray" />
              <div className="h-14 animate-pulse rounded-lg bg-bgGray" />
              <div className="pt-1 text-center text-[12px] text-textGray">执行流水加载中</div>
            </div>
          )}

          {phase === 'error' && (
            <div className="flex flex-col items-center px-4 py-6 text-center">
              <AlertTriangle className="h-6 w-6 text-danger" aria-hidden />
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

          {phase === 'ready' && data && data.flows.length === 0 && (
            <div className="flex flex-col items-center px-5 py-10 text-center">
              <div className="text-[13px] font-medium text-textDark">该合同暂无执行流水</div>
            </div>
          )}

          {phase === 'ready' && data && data.flows.length > 0 && (
            <>
              {sortedSummaries.length > 0 && (
                <div>
                  <div className="text-[11px] font-medium tracking-wide text-textGray">六向汇总</div>
                  <div className="mt-1.5 grid grid-cols-2 gap-2 lg:grid-cols-3 2xl:grid-cols-6">
                    {sortedSummaries.map((s) => (
                      <SummaryCard
                        key={`${s.flowType}-${s.direction}`}
                        summary={s}
                        groupFlows={flowsByGroup.get(`${s.flowType}-${s.direction}`) ?? []}
                      />
                    ))}
                  </div>
                </div>
              )}

              <div className="mt-2.5">
                <div className="text-[11px] font-medium tracking-wide text-textGray">逐笔明细</div>
                <div className="mt-1.5 overflow-hidden rounded-md border border-borderGray">
                  <div className="grid grid-cols-[64px_1fr_1fr_92px_1fr_84px] border-b border-borderGray bg-bgGray text-[10px] font-medium text-textGray">
                    <div className="px-2 py-1.5">流向</div>
                    <div className="px-2 py-1.5 text-right">金额</div>
                    <div className="px-2 py-1.5 text-right">数量</div>
                    <div className="px-2 py-1.5">凭证日期</div>
                    <div className="px-2 py-1.5">凭证类型</div>
                    <div className="px-2 py-1.5">溯源</div>
                  </div>
                  {data.flows.map((f) => (
                    <FlowRow key={f.id} flow={f} onLocateDocument={onLocateDocument} />
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
