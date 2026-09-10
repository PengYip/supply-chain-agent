import { useCallback, useEffect, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { AlertTriangle, Loader2, X } from 'lucide-react';
import {
  fetchFlowPanel,
  type FlowNode, type FlowPanelDocRef, type FlowPanelMilestone, type FlowPanelResponse, type MilestoneStatus,
} from '../../api/flowPanel';
import { FilePreviewModal } from '../FilePreviewModal';
import { prettyDocName } from '../graph/businessTypes';

/* 对账面板：合同四流泳道可视化(spec 2026-09-09 §15)。
 *
 * 四条泳道(货/权/款/票)共享一条节点轴(上游 -> 在途 -> 我方 -> 下游)。
 * 状态点语义: 实心=完成 / 琥珀=进行中 / 空心=未发生 / 红圈=异常(后端告警联动)。
 * 三级钻取: 点状态点 -> 明细抽屉(逐笔构成+证据 id) -> 原始凭证(FilePreviewModal)。
 * 背靠背对偶合同经 correlates chip 相互切换(chip 内部换合同号重拉面板)。
 * 全部数字来自 /api/contracts/:no/flow-panel, 每个点可三步点到证据。
 */

const NODES: readonly FlowNode[] = ['上游', '在途', '我方', '下游'];
const nodeIdx = (n: FlowNode): number => NODES.indexOf(n);
/** 节点列中心(色带/转移 ✕ 的横轴位置, %)。 */
const nodeCenter = (n: FlowNode): number => ((nodeIdx(n) + 0.5) / NODES.length) * 100;

const DOT_CLASS: Record<MilestoneStatus, string> = {
  done: 'bg-primary border-primary',
  ongoing: 'bg-warning border-warning',
  pending: 'bg-white border-ink-soft/50',
  abnormal: 'bg-danger/15 border-danger',
};

const LANE_ACCENT: Record<string, string> = {
  goods: 'bg-primary/10 text-primary',
  title: 'bg-violet-500/10 text-violet-600',
  funds: 'bg-warning/10 text-warning',
  invoice: 'bg-success/10 text-success',
};

const fmtQty = (n: number): string => n.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
const fmtAmt = (n: number): string =>
  Math.abs(n) >= 10000
    ? `${(n / 10000).toLocaleString('zh-CN', { maximumFractionDigits: 1 })}万`
    : n.toLocaleString('zh-CN', { maximumFractionDigits: 2 });

interface PreviewDoc { name: string; minioKey: string; docId: string | null }

/** 泳道里的一个状态点(三级钻取入口)。 */
function Dot({
  m, onClick,
}: {
  m: FlowPanelMilestone;
  onClick: () => void;
}) {
  const tip = [m.label, m.note, m.date ?? '', m.evidenceIds.length > 0 ? `证据 ${m.evidenceIds.length} 条` : '']
    .filter(Boolean).join('\n');
  return (
    <button
      type="button"
      onClick={onClick}
      data-milestone={m.key}
      data-status={m.status}
      title={tip}
      className="group flex min-w-0 flex-col items-center gap-0.5 focus:outline-none"
    >
      <span
        aria-hidden
        className={clsx(
          'block h-3 w-3 rounded-full border-2 transition-transform group-hover:scale-125',
          DOT_CLASS[m.status],
          m.status === 'abnormal' && 'ring-2 ring-danger/30',
        )}
      />
      <span className="w-16 truncate text-center text-[9px] leading-3 text-ink-soft/90">{m.label}</span>
      {(m.quantity != null || m.amount != null || m.date != null) && (
        <span className="w-16 truncate text-center text-[9px] leading-3 tabular-nums text-ink" title={tip}>
          {m.quantity ? `${fmtQty(m.quantity.value)}${m.quantity.unit === '吨' ? 't' : m.quantity.unit}` : ''}
          {m.amount ? `${m.quantity ? ' ' : ''}${fmtAmt(m.amount.value)}` : ''}
          {m.date ? ` ${m.date.slice(5)}` : ''}
        </span>
      )}
    </button>
  );
}

/** 明细抽屉(第二级钻取): 逐笔构成 + 证据 id + 原始凭证直达(第三级)。 */
function DetailOverlay({
  m, documents, onClose, onPreview,
}: {
  m: FlowPanelMilestone;
  documents: Record<string, FlowPanelDocRef>;
  onClose: () => void;
  onPreview: (d: PreviewDoc) => void;
}) {
  return (
    <div className="absolute inset-y-0 right-0 z-20 flex w-80 max-w-[85%] flex-col border-l border-line bg-white shadow-lg" data-testid="flow-detail">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
        <span className={clsx('inline-flex items-center text-[11px] px-1.5 py-0.5 rounded', LANE_ACCENT[m.lane] ?? '')}>{m.node}</span>
        <span className="text-xs font-medium text-ink">{m.label}</span>
        <span
          className={clsx(
            'text-[10px] px-1 rounded border',
            m.status === 'done' && 'border-success/30 bg-success/10 text-success',
            m.status === 'ongoing' && 'border-warning/30 bg-warning/10 text-warning',
            m.status === 'abnormal' && 'border-danger/30 bg-danger/10 text-danger',
            m.status === 'pending' && 'border-line bg-surface text-ink-soft',
          )}
        >
          {m.status === 'done' ? '完成' : m.status === 'ongoing' ? '进行中' : m.status === 'abnormal' ? '异常' : '未发生'}
        </span>
        <button type="button" onClick={onClose} aria-label="关闭明细" className="ml-auto rounded p-0.5 text-ink-soft hover:bg-surface hover:text-ink">
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>
      {m.note && <div className="shrink-0 border-b border-line/60 px-3 py-1.5 text-[10px] leading-4 text-ink-soft">{m.note}</div>}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {m.breakdown.length === 0 ? (
          <div className="py-4 text-center text-[11px] text-ink-soft">本节点暂无逐笔明细</div>
        ) : (
          <div className="space-y-1.5">
            {m.breakdown.map((r, i) => {
              const doc = r.documentId != null ? documents[r.documentId] : undefined;
              return (
                <div key={i} className="rounded border border-line px-2 py-1.5">
                  <div className="flex items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate text-[11px] text-ink" title={r.label}>{r.label}</span>
                    {r.quantity && <span className="shrink-0 text-[11px] tabular-nums text-ink">{fmtQty(r.quantity.value)}{r.quantity.unit}</span>}
                    {r.amount && <span className="shrink-0 text-[11px] tabular-nums text-ink">{fmtAmt(r.amount.value)}{r.amount.currency}</span>}
                    {r.date && <span className="shrink-0 text-[10px] text-ink-soft">{r.date}</span>}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1">
                    {r.evidenceIds.map((id) => (
                      <span key={id} className="rounded bg-surface px-1 font-mono text-[9px] text-ink-soft">{id}</span>
                    ))}
                    {r.documentId && doc?.minioKey && (
                      <button
                        type="button"
                        data-testid={`evidence-${r.documentId}`}
                        onClick={() => onPreview({
                          name: prettyDocName(doc.fileName) || doc.fileName,
                          minioKey: doc.minioKey!,
                          docId: r.documentId,
                        })}
                        className="rounded border border-primary/20 bg-primary/5 px-1 text-[9px] text-primary hover:underline"
                        title="查看原始凭证"
                      >
                        凭证
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/** 权泳道: 货权归属色带 + 转移时点 ✕(titleTransfer 口径)。 */
function TitleBand({ panel }: { panel: FlowPanelResponse }) {
  const inPts = panel.title.transferPoints.filter((t) => t.direction === 'in');
  const outPts = panel.title.transferPoints.filter((t) => t.direction === 'out');
  // 发货即转: 在途已属我方(决策 #11) -> 转入点画在在途列。
  const inNode: FlowNode = inPts.some((t) => t.caliber.includes('发货即转')) ? '在途' : '我方';
  const inX = inPts.length > 0 ? nodeCenter(inNode) : 0;
  const outX = outPts.length > 0 ? nodeCenter('下游') : 100;
  const holder = panel.title.currentHolder;
  return (
    <div className="relative col-start-2 col-end-[-1] self-center" data-testid="title-band" data-holder={holder ?? ''}>
      <div className="flex h-2.5 overflow-hidden rounded-full bg-line/60">
        {holder == null ? (
          <span className="flex-1 bg-ink-soft/20" title={panel.title.note ?? '待货权凭证'} />
        ) : (
          <>
            <span className="bg-ink-soft/30" style={{ width: `${inX}%` }} title="货权在上游" />
            <span className="bg-primary/70" style={{ width: `${Math.max(0, outX - inX)}%` }} title="货权在我方" />
            <span className="bg-success/60" style={{ width: `${Math.max(0, 100 - outX)}%` }} title="货权在下游" />
          </>
        )}
      </div>
      {/* 转移时点 ✕ + 口径 */}
      {[...inPts.map((t) => ({ t, x: inX })), ...outPts.map((t) => ({ t, x: outX }))].map(({ t, x }) => (
        <div key={t.factId} className="absolute top-0 flex -translate-x-1/2 flex-col items-center" style={{ left: `${x}%` }}>
          <span
            className="block text-[10px] font-medium leading-2.5 text-ink"
            title={`${t.direction === 'in' ? '转入' : '转出'} · ${t.caliber} · ${t.at.slice(0, 10)}\n证据 ${t.factId}`}
          >
            ✕
          </span>
          <span className="whitespace-nowrap text-[9px] leading-3 text-ink-soft">
            {t.caliber} {t.at.slice(5, 10)}
          </span>
        </div>
      ))}
      {holder == null && panel.title.note && (
        <div className="mt-0.5 truncate text-[9px] text-ink-soft" title={panel.title.note}>{panel.title.note}</div>
      )}
    </div>
  );
}

export function ContractFlowPanel({ contractNo }: { contractNo: string }) {
  const [activeNo, setActiveNo] = useState(contractNo);
  const [panel, setPanel] = useState<FlowPanelResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<FlowPanelMilestone | null>(null);
  const [previewDoc, setPreviewDoc] = useState<PreviewDoc | null>(null);
  // 过期响应守卫: correlates 互切时慢的旧响应不得覆盖新合同数据。
  const seqRef = useRef(0);

  useEffect(() => { setActiveNo(contractNo); }, [contractNo]);

  const load = useCallback(async (no: string) => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    setDetail(null);
    try {
      const p = await fetchFlowPanel(no);
      if (seq !== seqRef.current) return;
      setPanel(p);
    } catch (e) {
      if (seq !== seqRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => { void load(activeNo); }, [activeNo, load]);

  if (loading && !panel) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-lg border border-line bg-white px-3 py-8 text-xs text-ink-soft" data-testid="flow-panel">
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> 对账面板加载中...
      </div>
    );
  }
  if (error) {
    return (
      <div className="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger" data-testid="flow-panel">
        对账面板加载失败：{error}
      </div>
    );
  }
  if (!panel) return null;

  const lanes: Array<{ key: string; label: string; milestones: FlowPanelMilestone[]; special?: 'title' }> = [
    { key: 'goods', label: '货', milestones: panel.goods },
    { key: 'title', label: '权', milestones: panel.title.milestones, special: 'title' },
    { key: 'funds', label: '款', milestones: panel.funds },
    { key: 'invoice', label: '票', milestones: panel.invoice },
  ];
  const pct = panel.progress != null ? (panel.progress * 100).toFixed(2) : null;
  const net = panel.netPosition.currencies[0];

  return (
    <div className="relative rounded-lg border border-line bg-white" data-testid="flow-panel">
      {/* 头部: 标题 + 进度 + 净占用 + 背靠背对偶 chips */}
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-1.5">
        <span className="text-xs font-semibold text-ink">对账面板</span>
        <span className="font-mono text-[11px] text-ink-soft">{panel.displayContractNo}</span>
        {pct != null && panel.basis && (
          <span className="text-[11px] tabular-nums text-ink-soft">
            进度 <span className="font-medium text-ink">{pct}%</span>
            （执行 {panel.goods.find((m) => m.key === 'receipt')?.quantity
              ? `${fmtQty(panel.goods.find((m) => m.key === 'receipt')!.quantity!.value)} ${panel.basis.unit}`
              : '—'} / {fmtQty(panel.basis.quantity)}{panel.basis.unit}）
          </span>
        )}
        {pct == null && panel.progressReason && (
          <span className="text-[11px] text-ink-soft" title="合同台账缺「数量/单位」基准或量纲不对齐">
            进度—（{panel.progressReason}）
          </span>
        )}
        {net && (
          <span className="text-[11px] tabular-nums text-ink-soft">
            已付 <span className="text-ink">{fmtAmt(net.paid)}</span> · 已收 <span className="text-ink">{fmtAmt(net.received)}</span>
            {panel.netPosition.invoices[0] && (
              <> · 进项 <span className="text-ink">{fmtAmt(panel.netPosition.invoices[0]!.inAmount)}</span> / 销项 <span className="text-ink">{fmtAmt(panel.netPosition.invoices[0]!.outAmount)}</span></>
            )}
            · <span title="净占用=已付−已收（先收后付为负）">净占用 <span className={clsx('font-medium', net.netOccupancy > 0 ? 'text-danger' : 'text-success')}>{fmtAmt(net.netOccupancy)}</span></span>
          </span>
        )}
        {panel.correlates.length > 0 && (
          <span className="ml-auto flex items-center gap-1">
            <span className="text-[10px] text-ink-soft">背靠背</span>
            {panel.correlates.map((c) => (
              <button
                key={c.contractNo}
                type="button"
                data-testid={`correlate-${c.contractNo}`}
                onClick={() => setActiveNo(c.contractNo)}
                title={c.title || c.contractNo}
                className="max-w-40 truncate rounded-full border border-primary/30 bg-primary/5 px-2 py-0.5 font-mono text-[10px] text-primary transition-colors hover:bg-primary/10"
              >
                ⇄ {c.displayContractNo}
              </button>
            ))}
          </span>
        )}
      </div>

      {/* 告警条(红圈同步标在泳道节点上) */}
      {panel.alerts.length > 0 && (
        <div className="border-b border-line bg-danger/5 px-3 py-1">
          {panel.alerts.map((a) => (
            <div key={a.code} className="flex items-start gap-1.5 py-0.5 text-[11px] leading-4 text-danger" title={a.evidenceIds.join(', ')}>
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
              <span>{a.message}</span>
            </div>
          ))}
        </div>
      )}
      {loading && panel && <div className="absolute right-2 top-2 z-10"><Loader2 className="h-3 w-3 animate-spin text-ink-soft" aria-hidden /></div>}

      {/* 四泳道 × 节点轴 */}
      <div
        className="grid items-center gap-y-1 px-3 py-2"
        style={{ gridTemplateColumns: '32px repeat(4, minmax(0, 1fr))' }}
      >
        <span />
        {NODES.map((n) => (
          <span key={n} data-testid={`axis-${n}`} className="text-center text-[10px] font-medium text-ink-soft">{n}</span>
        ))}
        {lanes.map((lane) => (
          <div key={lane.key} className="col-span-5 grid items-center" style={{ gridTemplateColumns: '32px repeat(4, minmax(0, 1fr))' }}>
            <span
              data-testid={`lane-label-${lane.label}`}
              title={{ goods: '货物流', title: '货权(权)泳道', funds: '资金流', invoice: '发票流' }[lane.key]}
              className={clsx('mr-1 flex h-5 w-5 items-center justify-center rounded text-[11px] font-semibold', LANE_ACCENT[lane.key])}
            >
              {lane.label}
            </span>
            {lane.special === 'title' ? (
              <TitleBand panel={panel} />
            ) : (
              NODES.map((n) => {
                const cell = lane.milestones.filter((m) => m.node === n);
                // 我方列常有多节点(收货/库存/发货): 纵向堆叠防横向溢出。
                return (
                  <span key={n} className="flex min-w-0 flex-col items-center justify-start gap-1.5">
                    {cell.map((m) => (
                      <Dot key={m.key} m={m} onClick={() => setDetail(m)} />
                    ))}
                  </span>
                );
              })
            )}
          </div>
        ))}
      </div>

      {/* 图例 */}
      <div className="flex items-center gap-3 border-t border-line/60 px-3 py-1 text-[9px] text-ink-soft">
        <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full border-2 border-primary bg-primary" aria-hidden /> 完成</span>
        <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full border-2 border-warning bg-warning" aria-hidden /> 进行中</span>
        <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full border-2 border-ink-soft/50 bg-white" aria-hidden /> 未发生</span>
        <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full border-2 border-danger bg-danger/15" aria-hidden /> 异常</span>
        <span className="ml-auto">点状态点看逐笔构成与原始凭证</span>
      </div>

      {/* 第二级: 明细抽屉 */}
      {detail && (
        <DetailOverlay
          m={detail}
          documents={panel.documents}
          onClose={() => setDetail(null)}
          onPreview={setPreviewDoc}
        />
      )}

      {/* 第三级: 原始凭证 */}
      {previewDoc && (
        <FilePreviewModal
          file={{
            key: previewDoc.minioKey,
            name: previewDoc.name,
            size: 0,
            lastModified: '',
            docId: previewDoc.docId ?? undefined,
            directory: '/',
            parseStatus: null,
          }}
          onClose={() => setPreviewDoc(null)}
        />
      )}
    </div>
  );
}
