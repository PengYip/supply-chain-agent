import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { AlertTriangle, Building2, RefreshCw } from 'lucide-react';
import {
  fetchExecutionFlows,
  flowDirectionLabel,
  flowText,
  formatFlowAmount,
  formatFlowQuantity,
  type ExecutionFlowItem,
} from '../../api/flows';
import {
  cumulativeAsOf,
  executedInBasisUnit,
  pendingInBasisUnit,
  roleNaturalDirection,
  timelineDates,
  type DirAggregate,
  type ExecutionProgressView,
  type TimelineFlowRow,
} from '../../lib/executionProgress';
import { prettyDocName } from '../graph/businessTypes';
import type { FileEntry } from '../../hooks/useFiles';

/* ---------- 合同执行区块(项目台账合同卡展开区, spec 2026-08-27 台账整合 §4.2) ----------
 *
 * 结构: [执行进度三行(货物/资金/发票)] -> [时间轴回放] -> [逐笔明细表]。
 * 数据: rollup.execution(最新态, 含无日期行) + 展开时 lazy 拉取的逐笔行(回放态按
 * voucherDate <= T 前端重算, 不发请求)。金额一律标注「未结算累计」(价值在结算时才确定)。
 */

export interface RollupExecutionView {
  summaries: Array<{
    contractNo: string;
    flowType: string;
    direction: 'in' | 'out';
    entryCount: number;
    totalAmount: number | null;
    totalQuantityTon: number | null;
    totalMassKg?: number | null;
    lastVoucherDate: string | null;
  }>;
  progress: ExecutionProgressView;
  flowCount: number;
}

export interface ContractExecutionSectionProps {
  contractNo: string;
  displayContractNo: string;
  role: string;
  contractAmount: number | null;
  execution: RollupExecutionView;
  /** 溯源: 点击文件名打开预览(FilePreviewModal)。需要 documentMinioKey 非空。 */
  onPreviewFile: (file: FileEntry) => void;
  /** 引导跳转: 主体名单未配置且流水为空时, 提供前往主体名单页的入口。 */
  onOpenParties?: () => void;
}

type Phase = 'idle' | 'loading' | 'ready' | 'error';

const FLOW_GROUPS = [
  { flowType: '货物流', label: '货物' },
  { flowType: '资金流', label: '资金' },
  { flowType: '发票流', label: '发票' },
] as const;

const fmtNum = (n: number): string => n.toLocaleString('zh-CN', { maximumFractionDigits: 2 });

/** 待执行/超额文案: null -> '—'; 负数 = 超额(如实呈现不封顶)。 */
function pendingText(pending: number | null): string {
  if (pending === null) return '—';
  return pending < 0 ? `超额 ${fmtNum(-pending)}` : fmtNum(pending);
}

const PENDING_CLS = (pending: number | null): string =>
  pending !== null && pending < 0 ? 'text-warning' : 'text-ink';

/** 逐笔明细行: 流向徽章 + 金额/数量(右对齐) + 凭证日期 + 凭证类型 + 溯源列。
 *  自 ExecutionFlowPanel FlowRow 迁入(溯源走 FilePreviewModal, 缺 minioKey 降级悬浮文本)。 */
function FlowRow({ flow, onPreviewFile }: { flow: ExecutionFlowItem; onPreviewFile: (file: FileEntry) => void }) {
  const isIn = flow.direction === 'in';
  const badgeCls = isIn
    ? 'border-success/25 bg-success/10 text-success'
    : 'border-primary/20 bg-primary/10 text-primary-500';
  const displayName = flow.documentFileName ? prettyDocName(flow.documentFileName) : null;
  const traceLabel = displayName
    ?? (flow.documentId.length > 12 ? `${flow.documentId.slice(0, 12)}…` : flow.documentId);
  const traceTitle = [
    displayName,
    `documentId: ${flow.documentId}`,
    flow.extractionId ? `extractionId: ${flow.extractionId}` : null,
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <div className="grid grid-cols-[64px_1fr_1fr_92px_1fr_140px] items-center border-b border-line/60 last:border-b-0">
      <div className="px-2 py-1.5">
        <span className={clsx('rounded border px-1.5 py-px text-[10px]', badgeCls)}>
          {flowDirectionLabel(flow.flowType, flow.direction)}
        </span>
      </div>
      <div className="px-2 py-1.5 text-right text-[12px] tabular-nums text-ink">{formatFlowAmount(flow.amount)}</div>
      <div className="px-2 py-1.5 text-right text-[12px] tabular-nums text-ink">
        {formatFlowQuantity(flow.quantityTon, flow.unit)}
      </div>
      <div className="px-2 py-1.5 text-[12px] tabular-nums text-ink">{flowText(flow.voucherDate)}</div>
      <div className="break-all px-2 py-1.5 text-[12px] leading-4 text-ink">{flowText(flow.docType)}</div>
      <div className="px-2 py-1.5">
        {flow.documentMinioKey ? (
          <button
            type="button"
            onClick={() =>
              onPreviewFile({
                key: flow.documentMinioKey!,
                name: traceLabel,
                size: 0,
                lastModified: '',
                docId: flow.documentId,
                directory: '/',
                parseStatus: null,
              })
            }
            title={traceTitle}
            className="block max-w-full truncate text-left text-[11px] text-primary transition-colors hover:underline"
          >
            {traceLabel}
          </button>
        ) : (
          <span className="block cursor-default truncate text-[11px] text-ink-soft" title={traceTitle}>
            {traceLabel}
          </span>
        )}
      </div>
    </div>
  );
}

/** 进度三行中的一行: 组名 + 已执行 | 待执行 | 基准。 */
function ProgressRow({
  label,
  executed,
  executedUnit,
  sub,
  pending,
  basis,
  basisRef,
  unsettled,
  reverseCount,
  mismatch,
}: {
  label: string;
  executed: string;
  executedUnit: string;
  /** 已执行下方的数量小字(凭证带数量时, 金额为主数量为辅)。 */
  sub?: string;
  pending: number | null;
  basis: string;
  /** 资金/发票行: 基准为合同金额, 标注「(参考)」。 */
  basisRef?: boolean;
  unsettled: boolean;
  reverseCount: number;
  mismatch?: string;
}) {
  return (
    <div className="grid grid-cols-[44px_1fr_1fr_1fr] items-center gap-2 px-2.5 py-1.5 text-[11px]">
      <span className="shrink-0 font-medium text-ink">{label}</span>
      <span className="min-w-0 truncate text-right tabular-nums text-ink" title={`已执行${executedUnit}`}>
        {executed}
        {executedUnit ? <span className="ml-0.5 text-[10px] text-ink-soft">{executedUnit}</span> : null}
        {sub && <span className="block text-[10px] font-normal text-ink-soft">{sub}</span>}
      </span>
      <span className={clsx('min-w-0 truncate text-right tabular-nums', PENDING_CLS(pending))} title="待执行 = 基准 - 已执行, 参考值(实际执行围绕约定浮动, 负数即超额)">
        {pendingText(pending)}
      </span>
      <span className="flex min-w-0 items-center justify-end gap-1 text-right tabular-nums text-ink-soft" title={mismatch ?? basis}>
        <span className="min-w-0 truncate">{basis}</span>
        {basisRef && <span className="shrink-0 text-[9px] text-ink-soft/70">(参考)</span>}
      </span>
      {(unsettled || reverseCount > 0) && (
        <span className="col-span-4 flex flex-wrap items-center gap-1.5 text-[10px] text-ink-soft">
          {unsettled && (
            <span className="rounded border border-warning/30 bg-warning/10 px-1 py-px text-warning">
              未结算累计
            </span>
          )}
          {reverseCount > 0 && <span>另有反向 {reverseCount} 笔</span>}
        </span>
      )}
    </div>
  );
}

/** 合同执行区块: 进度三行 + 时间轴回放 + 逐笔明细。展开时 lazy 拉取, 组件内自持状态。 */
export function ContractExecutionSection({
  contractNo,
  displayContractNo,
  role,
  contractAmount,
  execution,
  onPreviewFile,
  onOpenParties,
}: ContractExecutionSectionProps) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [flows, setFlows] = useState<ExecutionFlowItem[]>([]);
  const [partiesMissing, setPartiesMissing] = useState(false);
  const [error, setError] = useState('');
  // 时间轴位置: 0..dates.length-1 = 回放到该凭证日; dates.length = 最新(rollup 口径)。
  const [asOfIndex, setAsOfIndex] = useState<number | null>(null); // null = 最新
  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
    const reqId = ++requestIdRef.current;
    setPhase('loading');
    setError('');
    try {
      const res = await fetchExecutionFlows(contractNo);
      if (reqId !== requestIdRef.current) return;
      setFlows(res.flows);
      setPartiesMissing(res.selfPartiesConfigured === false);
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

  const dates = useMemo(() => timelineDates(flows), [flows]);
  // 新数据到达后默认停在「最新」。
  useEffect(() => {
    setAsOfIndex(null);
  }, [dates]);

  /** 当前展示口径的六向累计: 最新态用 rollup summaries(含无日期行), 回放态前端重算。 */
  const aggMap = useMemo(() => {
    const map = new Map<string, DirAggregate>();
    if (asOfIndex === null || asOfIndex >= dates.length) {
      for (const s of execution.summaries) {
        map.set(`${s.flowType}-${s.direction}`, {
          entryCount: s.entryCount,
          totalAmount: s.totalAmount,
          totalQuantityTon: s.totalQuantityTon,
        });
      }
    } else {
      const rows: TimelineFlowRow[] = flows.map((f) => ({
        flowType: f.flowType,
        direction: f.direction,
        amount: f.amount,
        quantityTon: f.quantityTon,
        voucherDate: f.voucherDate,
      }));
      return cumulativeAsOf(rows, dates[asOfIndex]);
    }
    return map;
  }, [asOfIndex, dates, execution.summaries, flows]);

  const progress = execution.progress;
  const basis = progress.basis;
  const basisMismatch = progress.reason === 'dimension-mismatch' || progress.reason === 'unit-pool-missing';

  return (
    <div className="rounded-md border border-line bg-surface/30 p-2.5">
      {/* 标题行 + 时间轴 */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-medium text-ink">执行进度</span>
        <span className="rounded border border-line bg-white px-1 py-px text-[10px] text-ink-soft">参考值</span>
        <span className="min-w-0 truncate font-mono text-[10px] text-ink-soft" title={displayContractNo}>
          {displayContractNo}
        </span>
        {dates.length > 0 && phase === 'ready' && (
          <div className="ml-auto flex min-w-0 items-center gap-2">
            <span className="shrink-0 text-[10px] text-ink-soft">回放</span>
            <input
              type="range"
              min={0}
              max={dates.length}
              value={asOfIndex ?? dates.length}
              onChange={(e) => setAsOfIndex(Number(e.target.value))}
              aria-label="执行时间轴回放"
              className="h-1 min-w-[120px] max-w-[220px] flex-1 cursor-pointer accent-primary"
            />
            <span className="w-[72px] shrink-0 text-right font-mono text-[10px] tabular-nums text-ink">
              {(asOfIndex === null || asOfIndex >= dates.length) ? '最新' : dates[asOfIndex]}
            </span>
          </div>
        )}
      </div>

      {/* 加载/错误/空态 */}
      {phase === 'idle' || phase === 'loading' ? (
        <div className="px-2.5 py-4 text-center text-[12px] text-ink-soft">执行流水加载中</div>
      ) : phase === 'error' ? (
        <div className="flex flex-col items-center px-4 py-5 text-center">
          <AlertTriangle className="h-5 w-5 text-danger" aria-hidden />
          <div className="mt-1.5 max-w-[280px] break-all text-[12px] leading-5 text-danger">{error}</div>
          <button
            type="button"
            onClick={() => void load()}
            className="mt-2 flex items-center gap-1 rounded-md border border-line bg-white px-2 py-0.5 text-[11px] text-ink transition-colors hover:bg-surface"
          >
            <RefreshCw className="h-3 w-3" aria-hidden />
            重试
          </button>
        </div>
      ) : flows.length === 0 && partiesMissing ? (
        <div className="flex flex-col items-center px-4 py-4 text-center">
          <div className="text-[12px] font-medium text-ink">主体名单未配置，流水方向无法判定</div>
          <div className="mt-1 max-w-[300px] text-[11px] leading-4 text-ink-soft">
            到主体名单面板确认主体后，此处将自动回填执行流水
          </div>
          {onOpenParties && (
            <button
              type="button"
              onClick={onOpenParties}
              className="mt-2 flex h-6 items-center gap-1.5 rounded-md bg-primary px-2 text-[11px] font-medium text-white transition-colors hover:bg-primary-800"
            >
              <Building2 className="h-3 w-3" aria-hidden />
              前往主体名单
            </button>
          )}
        </div>
      ) : flows.length === 0 ? (
        <div className="px-2.5 py-4 text-center text-[12px] text-ink-soft">该合同暂无执行流水</div>
      ) : (
        <>
          {/* 进度三行 */}
          <div className="mt-2 overflow-hidden rounded-md border border-line bg-white">
            <div className="grid grid-cols-[44px_1fr_1fr_1fr] gap-2 border-b border-line/60 bg-surface px-2.5 py-1 text-[10px] font-medium text-ink-soft">
              <span>流</span>
              <span className="text-right">已执行</span>
              <span className="text-right">待执行</span>
              <span className="text-right">基准</span>
            </div>
            {FLOW_GROUPS.map(({ flowType, label }) => {
              const natural = roleNaturalDirection(role, flowType);
              const isGoods = flowType === '货物流';
              // 自然方向聚合; 其他角色(自然方向 null)展示双向合计。
              const dirs: Array<'in' | 'out'> = natural ? [natural] : ['in', 'out'];
              const aggs = dirs.map((d) => aggMap.get(`${flowType}-${d}`) ?? null);
              const reverseAgg = natural ? (aggMap.get(`${flowType}-${natural === 'in' ? 'out' : 'in'}`) ?? null) : null;
              const reverseCount = reverseAgg?.entryCount ?? 0;
              const hasAny = aggs.some((a) => a && a.entryCount > 0);
              if (!hasAny && flowType !== '货物流') {
                return (
                  <ProgressRow
                    key={flowType}
                    label={label}
                    executed="—"
                    executedUnit=""
                    pending={null}
                    basis={contractAmount !== null ? fmtNum(contractAmount) : '—'}
                    basisRef={contractAmount !== null}
                    unsettled={false}
                    reverseCount={0}
                  />
                );
              }

              if (isGoods) {
                // 货物行: 优先台账基准口径(原单位); 无基准降级 吨 口径的流水合计。
                const qtyAggs = aggs.map((a) => a?.totalQuantityTon ?? null);
                const execTon = qtyAggs.some((q) => q !== null)
                  ? qtyAggs.reduce<number | null>((s, q) => (q === null ? s : (s ?? 0) + q), null)
                  : null;
                if (basis) {
                  const execBasis = asOfIndex === null ? executedInBasisUnit(progress) : null;
                  // 回放态: 台账基准为吨时直接用累计吨数, 否则不硬算。
                  const replayExec = basis.dimension === 'mass' && basis.unit === '吨' ? execTon : null;
                  const exec = asOfIndex === null ? execBasis : replayExec;
                  const pending = asOfIndex === null
                    ? pendingInBasisUnit(progress)
                    : basis.dimension === 'mass' && basis.unit === '吨' && exec !== null
                      ? basis.quantity - exec
                      : null;
                  return (
                    <ProgressRow
                      key={flowType}
                      label={label}
                      executed={exec !== null ? fmtNum(exec) : '—'}
                      executedUnit={basis.unit}
                      pending={pending}
                      basis={`${fmtNum(basis.quantity)}${basis.unit}`}
                      unsettled={false}
                      reverseCount={reverseCount}
                      mismatch={basisMismatch ? '台账基准量纲与流水不一致, 待执行不硬算' : undefined}
                    />
                  );
                }
                return (
                  <ProgressRow
                    key={flowType}
                    label={label}
                    executed={execTon !== null ? fmtNum(execTon) : '—'}
                    executedUnit={execTon !== null ? '吨' : ''}
                    pending={null}
                    basis="—"
                    unsettled={false}
                    reverseCount={reverseCount}
                    mismatch="合同台账无数量基准(缺「数量/单位」字段)"
                  />
                );
              }

              // 资金/发票行: 金额口径, 基准 = 合同金额(参考), 徽章「未结算累计」。
              const amounts = aggs.map((a) => a?.totalAmount ?? null);
              const executed = amounts.some((a) => a !== null)
                ? amounts.reduce<number | null>((s, a) => (a === null ? s : (s ?? 0) + a), null)
                : null;
              const qtyAggs = aggs.map((a) => a?.totalQuantityTon ?? null);
              const execQty = qtyAggs.some((q) => q !== null)
                ? qtyAggs.reduce<number | null>((s, q) => (q === null ? s : (s ?? 0) + q), null)
                : null;
              const pending = contractAmount !== null && executed !== null ? contractAmount - executed : null;
              return (
                <ProgressRow
                  key={flowType}
                  label={label}
                  executed={executed !== null ? fmtNum(executed) : '—'}
                  executedUnit=""
                  sub={execQty !== null ? `数量 ${fmtNum(execQty)}吨` : undefined}
                  pending={pending}
                  basis={contractAmount !== null ? fmtNum(contractAmount) : '—'}
                  basisRef={contractAmount !== null}
                  unsettled
                  reverseCount={reverseCount}
                />
              );
            })}
          </div>

          {/* 逐笔明细(全量, 不随时间轴过滤) */}
          <div className="mt-2.5">
            <div className="text-[11px] font-medium tracking-wide text-ink-soft">逐笔明细</div>
            <div className="mt-1.5 overflow-hidden rounded-md border border-line bg-white">
              <div className="grid grid-cols-[64px_1fr_1fr_92px_1fr_140px] border-b border-line bg-surface text-[10px] font-medium text-ink-soft">
                <div className="px-2 py-1.5">流向</div>
                <div className="px-2 py-1.5 text-right">金额</div>
                <div className="px-2 py-1.5 text-right">数量</div>
                <div className="px-2 py-1.5">凭证日期</div>
                <div className="px-2 py-1.5">凭证类型</div>
                <div className="px-2 py-1.5">溯源</div>
              </div>
              {flows.map((f) => (
                <FlowRow key={f.id} flow={f} onPreviewFile={onPreviewFile} />
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
