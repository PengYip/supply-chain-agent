import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { Check, ChevronDown, Info, Link2, Loader2, MousePointerClick, Network, RefreshCw, Unlink, X } from 'lucide-react';
import type { Anchors, BindingListItem, OverviewDoc } from '../../hooks/useBindings';
import type { GraphFocusTarget } from '../graph/focus';
import { buildDocMetaResolver } from '../graph/docMeta';
import { prettyDocName, type DocMetaResolver } from '../graph/businessTypes';
import type { WorkbenchRow } from './BindingsView';
import { BindingMiniGraph } from './BindingMiniGraph';

function ratio(score: number | undefined | null): number {
  if (typeof score !== 'number' || !Number.isFinite(score) || score <= 0) return 0;
  return Math.min(1, score);
}

function pctText(score: number | undefined | null): string {
  return `${Math.round(ratio(score) * 100)}%`;
}

function ScoreBar({
  label,
  score,
  muted,
}: {
  label: string;
  score: number | undefined | null;
  muted?: boolean;
}) {
  return (
    <div>
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-ink-soft">{label}</span>
        <span className="text-[11px] font-medium tabular-nums text-ink">{pctText(score)}</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface">
        <div
          className={clsx('h-full rounded-full transition-[width] duration-300', muted ? 'bg-primary/25' : 'bg-primary')}
          style={{ width: `${Math.round(ratio(score) * 100)}%` }}
        />
      </div>
    </div>
  );
}

interface CompareField {
  label: string;
  anchor: string;
  ledger: string;
  /** true=两侧一致 false=不一致 null=台账未提供, 无法比较。 */
  match: boolean | null;
}

/** 锚点 vs 台账对照表：台账仅携带合同号/标题/类型, 其余字段显示「未提供」。 */
function buildCompareFields(anchors: Anchors | null, row: WorkbenchRow): CompareField[] {
  const ledgerNo = row.ledger?.displayContractNo || row.ledger?.contractNo || '';
  const anchorNo = anchors?.contractNo ?? '';
  const contractMatch =
    anchorNo && ledgerNo ? anchorNo.trim().toUpperCase() === ledgerNo.trim().toUpperCase() : null;
  return [
    { label: '合同号', anchor: anchorNo, ledger: ledgerNo, match: contractMatch },
    { label: '买方', anchor: anchors?.buyer ?? '', ledger: '', match: null },
    { label: '卖方', anchor: anchors?.seller ?? '', ledger: '', match: null },
    { label: '日期', anchor: anchors?.date ?? '', ledger: '', match: null },
    {
      label: '金额',
      anchor: anchors?.amount != null ? String(anchors.amount) : '',
      ledger: '',
      match: null,
    },
    {
      label: '数量（吨）',
      anchor: anchors?.quantityTon != null ? String(anchors.quantityTon) : '',
      ledger: '',
      match: null,
    },
  ];
}

function CompareTable({ anchors, row }: { anchors: Anchors | null; row: WorkbenchRow }) {
  const fields = buildCompareFields(anchors, row);
  return (
    <div className="mt-3">
      <div className="text-[11px] font-medium tracking-wide text-ink-soft">锚点对照</div>
      <div className="mt-1.5 overflow-hidden rounded-md border border-line">
        <div className="grid grid-cols-[64px_1fr_1fr] border-b border-line bg-surface text-[10px] font-medium text-ink-soft">
          <div className="px-2 py-1.5">字段</div>
          <div className="px-2 py-1.5">文档锚点</div>
          <div className="px-2 py-1.5">合同台账</div>
        </div>
        {fields.map((f) => (
          <div
            key={f.label}
            className="grid grid-cols-[64px_1fr_1fr] items-center border-b border-line/60 last:border-b-0"
          >
            <div className="px-2 py-1.5 text-[11px] text-ink-soft">{f.label}</div>
            <div className="break-all px-2 py-1.5 text-[12px] leading-4 text-ink">
              {f.anchor || <span className="text-line">—</span>}
            </div>
            <div className="flex min-w-0 items-center gap-1 px-2 py-1.5">
              <span className="min-w-0 break-all text-[12px] leading-4 text-ink">
                {f.ledger || <span className="text-line">未提供</span>}
              </span>
              {f.match === true && <Check className="h-3.5 w-3.5 shrink-0 text-success" aria-hidden />}
              {f.match === false && <X className="h-3.5 w-3.5 shrink-0 text-danger" aria-hidden />}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-1.5 text-[10px] leading-4 text-ink-soft">台账侧仅回传合同号与标题，其余字段以「未提供」展示</div>
    </div>
  );
}

function CandidateDetail({
  row,
  anchors,
  pending,
  onConfirm,
  onReject,
}: {
  row: WorkbenchRow;
  anchors: Anchors | null;
  pending: Set<string>;
  onConfirm: (row: WorkbenchRow) => void;
  onReject: (row: WorkbenchRow) => void;
}) {
  const isPending = !!row.bindingId && pending.has(row.bindingId);
  return (
    <div className="animate-fade-in">
      <div className="flex items-center gap-1.5">
        <span className="rounded border border-success/25 bg-success/10 px-1.5 py-px text-[10px] text-success">
          {row.ledger?.docType || '合同'}
        </span>
        {row.bindingStatus === 'confirmed' && (
          <span className="rounded border border-success/25 bg-success/10 px-1.5 py-px text-[10px] text-success">
            已绑定
          </span>
        )}
      </div>
      <div className="mt-2 break-all text-[14px] font-medium leading-5 text-ink">
        {row.ledger?.title || row.ledger?.displayContractNo || row.contractNo}
      </div>
      <div className="mt-1 break-all font-mono text-[10px] leading-4 text-ink-soft">
        {row.ledger?.displayContractNo ?? row.contractNo}
      </div>

      <div className="mt-3">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium tracking-wide text-ink-soft">综合评分</span>
          <span className="tabular-nums text-[13px] font-semibold text-ink">{pctText(row.score)}</span>
        </div>
        <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-surface">
          <div
            className={clsx(
              'h-full rounded-full transition-[width] duration-300',
              row.route === 'none' ? 'bg-primary/25' : 'bg-primary',
            )}
            style={{ width: `${Math.round(ratio(row.score) * 100)}%` }}
          />
        </div>
      </div>

      <CompareTable anchors={anchors} row={row} />

      {row.evidence ? (
        <div className="mt-3 space-y-2">
          <div className="text-[11px] font-medium tracking-wide text-ink-soft">评分明细</div>
          <ScoreBar label="交易方" score={row.evidence.partyScore} />
          <ScoreBar label="时间" score={row.evidence.timeScore} />
          <ScoreBar label="金额" score={row.evidence.amountScore} />
          <ScoreBar label="数量" score={row.evidence.qtyScore} />
          {row.evidence.details.length > 0 && (
            <div className="mt-2">
              <div className="text-[11px] font-medium tracking-wide text-ink-soft">证据说明</div>
              <ul className="mt-1.5 space-y-1">
                {row.evidence.details.map((d, i) => (
                  <li key={i} className="flex gap-1.5 text-[11px] leading-4 text-ink-soft">
                    <span className="mt-[5px] h-1 w-1 shrink-0 rounded-full bg-primary/25" aria-hidden />
                    <span className="break-all">{d}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : (
        <div className="mt-3 text-[11px] text-ink-soft">无评分证据</div>
      )}

      <div className="mt-4">
        {row.bindingStatus === 'proposed' && row.bindingId ? (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => onConfirm(row)}
              disabled={isPending}
              className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md bg-primary text-[12px] font-medium text-white transition-colors hover:bg-primary-800 disabled:opacity-50"
            >
              {isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
              确认绑定
            </button>
            <button
              type="button"
              onClick={() => onReject(row)}
              disabled={isPending}
              className="h-8 rounded-md border border-line bg-white px-3 text-[12px] text-ink-soft transition-colors hover:border-danger hover:text-danger disabled:opacity-50"
            >
              拒绝建议
            </button>
          </div>
        ) : row.bindingStatus === 'confirmed' ? (
          <div className="rounded-md bg-surface px-3 py-2 text-[11px] leading-4 text-ink-soft">
            该合同已与文档绑定，如需调整请在下方绑定条目中操作
          </div>
        ) : (
          <div className="rounded-md bg-surface px-3 py-2 text-[11px] leading-4 text-ink-soft">
            该候选尚未生成建议记录，可在中栏底部「手动创建绑定」中确认
          </div>
        )}
      </div>
    </div>
  );
}

function BindingCard({
  binding,
  docId,
  docMeta,
  pending,
  onConfirm,
  onReject,
  onUnbind,
  onRetrySync,
  onOpenInGraph,
}: {
  binding: BindingListItem;
  docId: string;
  docMeta: DocMetaResolver | null;
  pending: Set<string>;
  onConfirm: (binding: BindingListItem) => void;
  onReject: (binding: BindingListItem) => void;
  onUnbind: (binding: BindingListItem) => void;
  onRetrySync: (binding: BindingListItem) => void;
  onOpenInGraph?: (target: GraphFocusTarget) => void;
}) {
  const isPending = pending.has(binding.bindingId);
  const retryPending = pending.has(`retry:${binding.bindingId}`);
  const graphIssue = !!binding.graphStatus && binding.graphStatus.status !== 'ok';
  const graphReason = binding.graphStatus?.reason;
  const proposed = binding.status === 'proposed';
  // 已确认绑定的内嵌迷你图谱（合同邻域），默认收起
  const [graphOpen, setGraphOpen] = useState(false);
  return (
    <div className="animate-fade-in rounded-md border border-line px-3 py-2.5">
      <div className="flex items-start gap-1.5">
        <span className="min-w-0 break-all font-mono text-[12px] font-medium leading-5 text-ink">
          {binding.contractNo}
        </span>
        <span className="ml-auto shrink-0 rounded border border-primary/20 bg-primary/10 px-1.5 py-px text-[10px] text-primary-500">
          {binding.relation}
        </span>
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        {proposed ? (
          <span className="rounded border border-primary/20 bg-primary/10 px-1.5 py-px text-[10px] text-primary-500">
            待确认
          </span>
        ) : (
          <span className="rounded border border-success/25 bg-success/10 px-1.5 py-px text-[10px] text-success">
            已确认
          </span>
        )}
        {graphIssue && (
          <span
            className="flex items-center gap-1 rounded border border-warning/35 bg-warning/15 px-1.5 py-px text-[10px] text-warning"
            title={graphReason || '图谱同步未完成'}
          >
            图谱未同步
          </span>
        )}
        <span className="ml-auto text-[11px] tabular-nums text-ink-soft">{pctText(binding.confidence)}</span>
      </div>
      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-surface">
        <div
          className="h-full rounded-full bg-primary"
          style={{ width: `${Math.round(ratio(binding.confidence) * 100)}%` }}
        />
      </div>

      <div className="mt-2.5 flex items-center justify-end gap-1.5">
        {graphIssue && (
          <button
            type="button"
            onClick={() => onRetrySync(binding)}
            disabled={retryPending}
            className="flex h-6 items-center gap-1 rounded-md border border-line bg-white px-2 text-[11px] text-ink-soft transition-colors hover:text-primary disabled:opacity-50"
            title="重新执行图谱同步（幂等）"
          >
            <RefreshCw className={clsx('h-3 w-3', retryPending && 'animate-spin')} aria-hidden />
            重试同步
          </button>
        )}
        {!proposed && (
          <button
            type="button"
            onClick={() => setGraphOpen((v) => !v)}
            aria-expanded={graphOpen}
            title={graphOpen ? '收起图谱邻域' : '查看该绑定在图谱中的关联'}
            className="mr-auto flex h-6 items-center gap-1 rounded-md border border-line bg-white px-2 text-[11px] text-ink-soft transition-colors hover:border-primary hover:text-primary"
          >
            <Network className="h-3 w-3" aria-hidden />
            图谱
            <ChevronDown className={clsx('h-3 w-3 transition-transform', graphOpen && 'rotate-180')} aria-hidden />
          </button>
        )}
        {proposed ? (
          <>
            <button
              type="button"
              onClick={() => onConfirm(binding)}
              disabled={isPending}
              className="flex h-6 items-center gap-1 rounded-md bg-primary px-2 text-[11px] font-medium text-white transition-colors hover:bg-primary-800 disabled:opacity-50"
            >
              {isPending && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
              确认
            </button>
            <button
              type="button"
              onClick={() => onReject(binding)}
              disabled={isPending}
              className="h-6 rounded-md border border-line bg-white px-2 text-[11px] text-ink-soft transition-colors hover:border-danger hover:text-danger disabled:opacity-50"
            >
              拒绝
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => onUnbind(binding)}
            disabled={isPending}
            className="flex h-6 items-center gap-1 rounded-md border border-line bg-white px-2 text-[11px] text-ink-soft transition-colors hover:border-danger hover:text-danger disabled:opacity-50"
          >
            {isPending ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <Unlink className="h-3 w-3" aria-hidden />}
            解除
          </button>
        )}
      </div>

      {!proposed && graphOpen && (
        <BindingMiniGraph
          docId={docId}
          contractNo={binding.contractNo}
          bindingId={binding.bindingId}
          docMeta={docMeta}
          onOpenInGraph={onOpenInGraph}
        />
      )}
    </div>
  );
}

interface DetailPanelProps {
  doc: OverviewDoc | null;
  row: WorkbenchRow | null;
  anchors: Anchors | null;
  pending: Set<string>;
  /** 文档类型可选值(来自 overview 响应的 docTypes, 前端有兜底常量)。 */
  docTypes: string[];
  /** 文档类型修正: 选中新类型即触发 PATCH, 失败时由调用方回显原值。 */
  onChangeDocType: (docType: string) => void;
  onConfirm: (row: WorkbenchRow) => void;
  onReject: (row: WorkbenchRow) => void;
  onConfirmBinding: (binding: BindingListItem) => void;
  onRejectBinding: (binding: BindingListItem) => void;
  onUnbind: (binding: BindingListItem) => void;
  onRetrySync: (binding: BindingListItem) => void;
  onOpenInGraph?: (target: GraphFocusTarget) => void;
}

export function DetailPanel({
  doc,
  row,
  anchors,
  pending,
  docTypes,
  onChangeDocType,
  onConfirm,
  onReject,
  onConfirmBinding,
  onRejectBinding,
  onUnbind,
  onRetrySync,
  onOpenInGraph,
}: DetailPanelProps) {
  // 迷你图谱的 docId 兜底：单条映射（当前文档），足以补齐被绑定文档节点缺 sourceUri 的老数据。
  const docMeta: DocMetaResolver | null = useMemo(
    () =>
      doc
        ? buildDocMetaResolver([{ docId: doc.docId, sourceUri: doc.fileName, docType: doc.docType }])
        : null,
    [doc],
  );
  // 类型修正的选项: 当前类型不在列表中(历史数据/后端列表不一致)时追加为选项,
  // 保证既有值始终可见、可回退; 空类型补一个「未识别」占位。
  const typeOptions = useMemo(() => {
    const list = docTypes.filter(Boolean);
    if (doc?.docType && !list.includes(doc.docType)) list.push(doc.docType);
    return list;
  }, [docTypes, doc]);
  const typePending = pending.has('docType');
  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-line bg-white">
      <div className="shrink-0 border-b border-line px-4 py-3 text-[15px] font-semibold text-ink">详情</div>
      {doc && (
        <div className="shrink-0 border-b border-line px-4 py-3">
          <div className="truncate text-[13px] font-medium leading-5 text-ink" title={doc.fileName}>
            {prettyDocName(doc.fileName) || doc.fileName}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <span className="shrink-0 text-[11px] font-medium text-ink-soft">文档类型</span>
            <select
              value={doc.docType}
              onChange={(e) => onChangeDocType(e.target.value)}
              disabled={typePending}
              aria-label="修正文档类型"
              title="修正文档类型"
              className="h-7 min-w-0 flex-1 rounded-md border border-line bg-white px-2 text-[12px] text-ink focus:border-primary focus:outline-none disabled:opacity-50"
            >
              {doc.docType === '' && <option value="">未识别</option>}
              {typeOptions.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            {typePending && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-ink-soft" aria-hidden />}
          </div>
          <div className="mt-1.5 text-[10px] leading-4 text-ink-soft">修正类型后，绑定建议与关联流水将自动刷新</div>
          {/* 合同文档下一步引导(与复核卡同一口径): 合同不需要「绑定到合同」,
              抽取后自动入台账; 真正的下一步是挂项目/被单据挂。 */}
          {(doc.docType === '合同' || doc.docType === '补充合同') && (
            <div className="mt-2 flex items-start gap-1.5 rounded border border-line/50 bg-surface/50 px-2 py-1.5 text-[11px] leading-4 text-ink-soft">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
              <span className="leading-relaxed">
                该合同已在台账中（抽取自动完成）。下一步：到「项目」页挂到项目；发票、货转单等执行单据可在中栏挂到该合同。
              </span>
            </div>
          )}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {row ? (
          <CandidateDetail row={row} anchors={anchors} pending={pending} onConfirm={onConfirm} onReject={onReject} />
        ) : doc ? (
          doc.bindings.length === 0 ? (
            <div className="flex flex-col items-center px-2 py-14 text-center">
              <Link2 className="h-9 w-9 text-line" aria-hidden />
              <div className="mt-3 text-[13px] leading-5 text-ink-soft">
                该文档还没有绑定
                <br />
                在中栏查看候选建议或手动创建
              </div>
            </div>
          ) : (
            <div className="space-y-2.5">
              <div className="text-[11px] font-medium tracking-wide text-ink-soft">
                绑定条目（{doc.bindings.length}）
              </div>
              {doc.bindings.map((b) => (
                <BindingCard
                  key={b.bindingId}
                  binding={b}
                  docId={doc.docId}
                  docMeta={docMeta}
                  pending={pending}
                  onConfirm={onConfirmBinding}
                  onReject={onRejectBinding}
                  onUnbind={onUnbind}
                  onRetrySync={onRetrySync}
                  onOpenInGraph={onOpenInGraph}
                />
              ))}
            </div>
          )
        ) : (
          <div className="flex flex-col items-center px-2 py-14 text-center">
            <MousePointerClick className="h-9 w-9 text-line" aria-hidden />
            <div className="mt-3 text-[13px] leading-5 text-ink-soft">
              点击中栏的候选行
              <br />
              这里会展示锚点对照与评分证据
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
