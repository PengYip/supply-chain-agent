import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Link2,
  RefreshCw,
  X,
  type LucideIcon,
} from 'lucide-react';
import {
  useBindings,
  type BindingListItem,
  type OverviewDoc,
  type ProposalItem,
} from '../../hooks/useBindings';
import { prettyDocName } from '../graph/kinds';
import type { GraphFocusTarget } from '../graph/focus';
import { DocListPanel } from './DocListPanel';
import { CandidatePanel } from './CandidatePanel';
import { DetailPanel } from './DetailPanel';

/* ---------- 视图模型：候选行(实时评分) + 已保存建议(proposals) 合并 ---------- */

export interface WorkbenchRow {
  /** 行唯一键 = 合同号(合并已按合同号去重)。 */
  key: string;
  contractNo: string;
  score: number;
  route: 'auto_rule' | 'human' | 'none';
  evidence: {
    partyScore: number;
    timeScore: number;
    amountScore: number;
    qtyScore: number;
    details: string[];
  } | null;
  /** 已存在的绑定行(proposed/confirmed), 无则为 null。 */
  bindingId: string | null;
  bindingStatus: 'proposed' | 'confirmed' | null;
  ledger: { contractNo: string; displayContractNo: string; title: string; docType: string } | null;
  /** 该行背后是否有已落库的 proposed 建议。 */
  savedProposal: ProposalItem | null;
}

/* ---------- 二次确认弹窗 / toast ---------- */

interface ConfirmRequest {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  action: () => Promise<void>;
}

interface ToastItem {
  id: number;
  kind: 'success' | 'error';
  text: string;
}

/** 文档类型修正的服务端错误码 -> 中文文案(assertOk 会透传 data.error)。 */
const DOC_TYPE_ERROR_TEXT: Record<string, string> = {
  invalid_doc_type: '不支持的文档类型',
  invalid_body: '请求参数错误',
  document_not_found: '文档不存在或已删除',
};

/** 面板折叠把手(样式与 graph/GraphView.tsx 一致)。 */
function PanelRail({
  collapsed,
  side,
  label,
  onToggle,
}: {
  collapsed: boolean;
  side: 'left' | 'right';
  label: string;
  onToggle: () => void;
}) {
  const Chevron: LucideIcon = collapsed
    ? side === 'left'
      ? ChevronRight
      : ChevronLeft
    : side === 'left'
      ? ChevronLeft
      : ChevronRight;
  const action = collapsed ? `展开${label}面板` : `收起${label}面板`;
  return (
    <div
      className={clsx(
        'flex w-7 shrink-0 flex-col items-center bg-white',
        side === 'left' ? 'border-r border-borderGray' : 'border-l border-borderGray',
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        title={action}
        aria-label={action}
        className="mt-1 flex h-7 w-7 items-center justify-center rounded-md text-textGray transition-colors hover:bg-bgGray hover:text-deepSea"
      >
        <Chevron className="h-4 w-4" aria-hidden />
      </button>
      {collapsed && (
        <div className="flex flex-1 items-center justify-center pt-2 text-[11px] tracking-[0.3em] text-textGray [writing-mode:vertical-rl]">
          {label}
        </div>
      )}
    </div>
  );
}

export function BindingsView({ onOpenInGraph }: { onOpenInGraph?: (target: GraphFocusTarget) => void }) {
  const b = useBindings();
  const { overview, proposals, candidates, contracts } = b;

  const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
  const [selected, setSelected] = useState<OverviewDoc | null>(null);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const [docsCollapsed, setDocsCollapsed] = useState(false);
  const [detailCollapsed, setDetailCollapsed] = useState(false);

  const [confirmReq, setConfirmReq] = useState<ConfirmRequest | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastIdRef = useRef(0);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [batchPending, setBatchPending] = useState(false);
  const [batchErrors, setBatchErrors] = useState<Record<string, string>>({});
  // 手动创建绑定的确认桥：表单提交 -> 弹窗确认 -> Promise 回传结果(取消则表单保留)。
  const manualResolveRef = useRef<((ok: boolean) => void) | null>(null);

  /* ---------- 派生状态 ---------- */

  // 分组语义与左栏一致: 有 confirmed 行才算已绑定, 仅有待确认建议仍计入未绑定。
  const unboundCount = useMemo(
    () => overview.filter((d) => !d.bindings.some((x) => x.status === 'confirmed')).length,
    [overview],
  );

  // overview 刷新后同步 selected(文档仍存在则保留选中)。
  useEffect(() => {
    if (!selectedDocId) return;
    setSelected(overview.find((d) => d.docId === selectedDocId) ?? null);
  }, [overview, selectedDocId]);

  /** 候选(实时评分) + 已保存建议(proposals) 按合同号合并, 分数倒序。 */
  const rows = useMemo<WorkbenchRow[]>(() => {
    if (!selected) return [];
    const byContract = new Map<string, WorkbenchRow>();
    const bindingByContract = new Map(selected.bindings.map((x) => [x.contractNo, x]));
    const proposalByContract = new Map<string, ProposalItem>();
    for (const p of proposals) {
      if (p.documentId === selected.docId && !proposalByContract.has(p.contractNo)) {
        proposalByContract.set(p.contractNo, p);
      }
    }
    const ledgerByNo = new Map(contracts.map((c) => [c.contractNo, c]));

    const candidateList =
      candidates && candidates.docId === selected.docId ? candidates.list : [];
    for (const c of candidateList) {
      const binding = bindingByContract.get(c.contractNo);
      const proposal = proposalByContract.get(c.contractNo);
      byContract.set(c.contractNo, {
        key: c.contractNo,
        contractNo: c.contractNo,
        score: c.score,
        route: c.route,
        evidence: c.evidence,
        bindingId: c.existingBindingId ?? binding?.bindingId ?? proposal?.bindingId ?? null,
        bindingStatus: binding
          ? binding.status === 'confirmed'
            ? 'confirmed'
            : 'proposed'
          : null,
        ledger: c.ledger,
        savedProposal: proposal ?? null,
      });
    }
    // 已落库建议但不在实时候选里(如台账变化/锚点缺失) -> 补充为「已保存」行。
    for (const [contractNo, p] of proposalByContract) {
      if (byContract.has(contractNo)) continue;
      byContract.set(contractNo, {
        key: contractNo,
        contractNo,
        score: p.confidence,
        route: 'human',
        evidence: p.evidence,
        bindingId: p.bindingId,
        bindingStatus: 'proposed',
        ledger: ledgerByNo.get(contractNo) ?? null,
        savedProposal: p,
      });
    }
    return [...byContract.values()].sort((a, x) => x.score - a.score);
  }, [selected, candidates, proposals, contracts]);

  const focusedRow = rows.find((r) => r.key === focusedKey) ?? null;
  const docName = selected ? prettyDocName(selected.fileName) || selected.fileName : '';
  const busy = b.loading || b.candidatesLoading;

  /* ---------- toast / pending 基础设施 ---------- */

  const pushToast = useCallback((kind: 'success' | 'error', text: string) => {
    const id = ++toastIdRef.current;
    setToasts((prev) => [...prev.slice(-2), { id, kind, text }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3000);
  }, []);

  const markPending = useCallback((key: string, on: boolean) => {
    setPending((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  // Esc 关闭确认弹窗(执行中不允许)。
  useEffect(() => {
    if (!confirmReq) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !confirmBusy) closeConfirm();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [confirmReq, confirmBusy]);

  /** 关闭确认弹窗；若有等待中的手动创建请求, 回传取消。 */
  const closeConfirm = () => {
    if (manualResolveRef.current) {
      manualResolveRef.current(false);
      manualResolveRef.current = null;
    }
    setConfirmReq(null);
  };

  const runConfirmed = async () => {
    if (!confirmReq || confirmBusy) return;
    setConfirmBusy(true);
    try {
      await confirmReq.action();
      setConfirmReq(null);
    } catch (e) {
      pushToast('error', e instanceof Error ? e.message : '操作失败');
    } finally {
      setConfirmBusy(false);
    }
  };

  /* ---------- 选中文档 ---------- */

  const handleSelectDoc = (doc: OverviewDoc) => {
    setSelectedDocId(doc.docId);
    setSelected(doc);
    setFocusedKey(null);
    setBatchErrors({});
    void b.loadCandidates(doc.docId);
  };

  const handleClearDoc = () => {
    setSelectedDocId(null);
    setSelected(null);
    setFocusedKey(null);
    setBatchErrors({});
  };

  const handleRefresh = () => {
    b.refreshAll(selectedDocId);
  };

  /* ---------- 文档类型修正 ---------- */

  /** 轻量修正不做二次确认; 下拉值始终由 overview 的 docType 驱动,
   *  成功才在本地补丁并全量对账, 失败不动本地状态即自动回显原值。 */
  const handleChangeDocType = async (nextType: string) => {
    if (!selected || pending.has('docType')) return;
    if (!nextType || nextType === selected.docType) return;
    const docId = selected.docId;
    markPending('docType', true);
    try {
      const res = await b.correctDocType(docId, nextType);
      // 本地先更新 docType, 右栏下拉与左栏徽标即时跟随; 随后刷新建议与候选。
      b.patchOverview((docs) =>
        docs.map((d) => (d.docId === docId ? { ...d, docType: res.docType || nextType } : d)),
      );
      const flows = Number.isFinite(res.refreshedFlows) ? res.refreshedFlows : 0;
      pushToast(
        'success',
        flows > 0 ? `文档类型已改为「${nextType}」，已刷新 ${flows} 条关联流水` : `文档类型已改为「${nextType}」`,
      );
      b.refreshAll(docId);
    } catch (e) {
      const code = e instanceof Error ? e.message : '';
      pushToast('error', DOC_TYPE_ERROR_TEXT[code] ?? (e instanceof Error ? e.message : '类型修正失败'));
    } finally {
      markPending('docType', false);
    }
  };

  /* ---------- 写操作(二次确认 -> 乐观更新 -> 失败回滚 + toast) ---------- */

  const graphStatusOf = (graphSync: string, reason?: string): BindingListItem['graphStatus'] =>
    graphSync === 'ok' ? { status: 'ok' } : { status: graphSync, ...(reason ? { reason } : {}) };

  const requestConfirmRow = (row: WorkbenchRow) => {
    if (!row.bindingId || !selected) return;
    const id = row.bindingId;
    const snapOverview = overview;
    const snapProposals = proposals;
    setConfirmReq({
      title: '确认绑定',
      body: `即将确认文档《${docName}》与合同 ${row.contractNo} 的绑定建议。确认后写入绑定记录并同步图谱。`,
      confirmLabel: '确认绑定',
      action: async () => {
        markPending(id, true);
        b.patchOverview((docs) =>
          docs.map((d) =>
            d.docId !== selected.docId
              ? d
              : {
                  ...d,
                  bindings: d.bindings.map((x) =>
                    x.bindingId === id ? { ...x, status: 'confirmed', confirmationSource: 'human' } : x,
                  ),
                },
          ),
        );
        b.patchProposals((ps) => ps.filter((p) => p.bindingId !== id));
        try {
          const res = await b.confirmBinding(id);
          const gs = graphStatusOf(res.graphSync, res.graphReason);
          b.patchOverview((docs) =>
            docs.map((d) => ({
              ...d,
              bindings: d.bindings.map((x) => (x.bindingId === id ? { ...x, graphStatus: gs } : x)),
            })),
          );
          pushToast(
            'success',
            res.graphSync === 'ok'
              ? `已确认绑定 ${row.contractNo}`
              : `已确认绑定 ${row.contractNo}（图谱未同步）`,
          );
        } catch (e) {
          b.patchOverview(() => snapOverview);
          b.patchProposals(() => snapProposals);
          pushToast('error', e instanceof Error ? e.message : '确认失败');
        } finally {
          markPending(id, false);
          b.refreshAll(selected.docId);
        }
      },
    });
  };

  const requestRejectRow = (row: WorkbenchRow) => {
    if (!row.bindingId || !selected) return;
    const id = row.bindingId;
    const snapOverview = overview;
    const snapProposals = proposals;
    setConfirmReq({
      title: '拒绝建议',
      body: `即将拒绝文档《${docName}》与合同 ${row.contractNo} 的绑定建议。拒绝后不再展示，历史记录保留以备审计。`,
      confirmLabel: '拒绝建议',
      danger: true,
      action: async () => {
        markPending(id, true);
        b.patchOverview((docs) =>
          docs.map((d) =>
            d.docId !== selected.docId ? d : { ...d, bindings: d.bindings.filter((x) => x.bindingId !== id) },
          ),
        );
        b.patchProposals((ps) => ps.filter((p) => p.bindingId !== id));
        try {
          await b.rejectBinding(id);
          pushToast('success', '已拒绝该建议');
        } catch (e) {
          b.patchOverview(() => snapOverview);
          b.patchProposals(() => snapProposals);
          pushToast('error', e instanceof Error ? e.message : '拒绝失败');
        } finally {
          markPending(id, false);
          b.refreshAll(selected.docId);
        }
      },
    });
  };

  const requestUnbind = (binding: BindingListItem) => {
    if (!selected) return;
    const id = binding.bindingId;
    const snapOverview = overview;
    setConfirmReq({
      title: '解除绑定',
      body: `即将解除文档《${docName}》与合同 ${binding.contractNo} 的绑定（关系：${binding.relation}）。图谱中的绑定边将被删除；如需恢复可重新绑定。`,
      confirmLabel: '解除绑定',
      danger: true,
      action: async () => {
        markPending(id, true);
        b.patchOverview((docs) =>
          docs.map((d) =>
            d.docId !== selected.docId ? d : { ...d, bindings: d.bindings.filter((x) => x.bindingId !== id) },
          ),
        );
        try {
          await b.unbindBinding(id);
          pushToast('success', `已解除绑定 ${binding.contractNo}`);
        } catch (e) {
          b.patchOverview(() => snapOverview);
          pushToast('error', e instanceof Error ? e.message : '解除失败');
        } finally {
          markPending(id, false);
          b.refreshAll(selected.docId);
        }
      },
    });
  };

  const requestBatchConfirm = (bindingIds: string[]) => {
    if (!selected || bindingIds.length === 0) return;
    const snapOverview = overview;
    setConfirmReq({
      title: '批量确认绑定',
      body: `即将确认 ${bindingIds.length} 条绑定建议。部分失败时不影响已成功项，失败原因会标注在对应候选行上。`,
      confirmLabel: `确认 ${bindingIds.length} 项`,
      action: async () => {
        setBatchPending(true);
        setBatchErrors({});
        const idSet = new Set(bindingIds);
        b.patchOverview((docs) =>
          docs.map((d) =>
            d.docId !== selected.docId
              ? d
              : {
                  ...d,
                  bindings: d.bindings.map((x) =>
                    idSet.has(x.bindingId) ? { ...x, status: 'confirmed', confirmationSource: 'human' } : x,
                  ),
                },
          ),
        );
        try {
          const results = await b.batchConfirm(bindingIds);
          const failed = results.filter((r) => !r.ok);
          if (failed.length > 0) {
            setBatchErrors(Object.fromEntries(failed.map((f) => [f.bindingId, f.error || '确认失败'])));
            pushToast('error', `批量确认：成功 ${results.length - failed.length} 项 · 失败 ${failed.length} 项`);
          } else {
            pushToast('success', `已确认 ${results.length} 项绑定`);
          }
        } catch (e) {
          b.patchOverview(() => snapOverview);
          pushToast('error', e instanceof Error ? e.message : '批量确认失败');
        } finally {
          setBatchPending(false);
          b.refreshAll(selected.docId);
        }
      },
    });
  };

  /** 手动创建绑定：表单提交 -> 二次确认弹窗 -> 执行(取消则 Promise 回 false, 表单保留)。 */
  const handleManualCreate = (p: { contractNo: string; relation: string; note?: string }): Promise<boolean> => {
    if (!selected) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      manualResolveRef.current = resolve;
      setConfirmReq({
        title: '创建绑定',
        body: `即将手动创建文档《${docName}》与合同 ${p.contractNo} 的绑定（关系：${p.relation}）。创建后立即生效并同步图谱。`,
        confirmLabel: '创建绑定',
        action: async () => {
          const ok = await doCreateManual(p);
          if (manualResolveRef.current) {
            manualResolveRef.current(ok);
            manualResolveRef.current = null;
          }
        },
      });
    });
  };

  const doCreateManual = async (p: { contractNo: string; relation: string; note?: string }): Promise<boolean> => {
    if (!selected) return false;
    markPending('manual', true);
    try {
      const res = await b.createBinding({ documentId: selected.docId, ...p });
      b.patchOverview((docs) =>
        docs.map((d) =>
          d.docId !== selected.docId
            ? d
            : {
                ...d,
                bindings: [
                  ...d.bindings.filter((x) => x.contractNo !== p.contractNo),
                  {
                    bindingId: res.bindingId,
                    contractNo: p.contractNo,
                    relation: p.relation,
                    status: 'confirmed',
                    confidence: 1,
                    confirmationSource: 'human',
                    graphStatus: graphStatusOf(res.graphSync, res.graphReason),
                  },
                ],
              },
        ),
      );
      pushToast(
        'success',
        res.existing
          ? `该绑定已存在：${p.contractNo}`
          : res.graphSync === 'ok'
            ? `已创建绑定 ${p.contractNo}`
            : `已创建绑定 ${p.contractNo}（图谱未同步）`,
      );
      return true;
    } catch (e) {
      pushToast('error', e instanceof Error ? e.message : '创建失败');
      return false;
    } finally {
      markPending('manual', false);
      b.refreshAll(selected.docId);
    }
  };

  /** 图谱同步重试: 幂等 createBinding 重跑(服务端 upsert), 不弹确认。 */
  const handleRetrySync = async (binding: BindingListItem) => {
    if (!selected) return;
    const key = `retry:${binding.bindingId}`;
    markPending(key, true);
    try {
      await b.createBinding({
        documentId: selected.docId,
        contractNo: binding.contractNo,
        relation: binding.relation,
      });
      pushToast('success', '已重新请求图谱同步');
    } catch (e) {
      pushToast('error', e instanceof Error ? e.message : '重试失败');
    } finally {
      markPending(key, false);
      b.refreshAll(selected.docId);
    }
  };

  /** 详情面板绑定条目上的确认/拒绝(与候选行共用流程)。 */
  const requestConfirmBinding = (binding: BindingListItem) => {
    const row = rows.find((r) => r.bindingId === binding.bindingId);
    if (row) {
      requestConfirmRow(row);
      return;
    }
    // 行不在候选列表(如建议被过滤): 构造临时行复用流程。
    requestConfirmRow({
      key: binding.bindingId,
      contractNo: binding.contractNo,
      score: binding.confidence,
      route: 'human',
      evidence: null,
      bindingId: binding.bindingId,
      bindingStatus: binding.status === 'confirmed' ? 'confirmed' : 'proposed',
      ledger: null,
      savedProposal: null,
    });
  };

  const requestRejectBinding = (binding: BindingListItem) => {
    const row = rows.find((r) => r.bindingId === binding.bindingId);
    if (row) requestRejectRow(row);
    else
      requestRejectRow({
        key: binding.bindingId,
        contractNo: binding.contractNo,
        score: binding.confidence,
        route: 'human',
        evidence: null,
        bindingId: binding.bindingId,
        bindingStatus: binding.status === 'confirmed' ? 'confirmed' : 'proposed',
        ledger: null,
        savedProposal: null,
      });
  };

  /* ---------- 渲染 ---------- */

  return (
    <div className="flex h-full flex-col bg-bgGray">
      {/* 顶部工具条 */}
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-borderGray bg-white px-4">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-deepSea">
            <Link2 className="h-4 w-4 text-white" aria-hidden />
          </span>
          <span className="text-[15px] font-semibold text-textDark">绑定工作台</span>
        </div>

        {selected && (
          <div className="flex min-w-0 items-center gap-2 rounded-md bg-bgGray px-2.5 py-1">
            <span className="shrink-0 text-[11px] text-textGray">当前文档</span>
            <span className="max-w-[220px] truncate text-[12px] font-medium text-textDark" title={selected.fileName}>
              {docName}
            </span>
            <button
              type="button"
              onClick={handleClearDoc}
              title="取消选择"
              aria-label="取消选择"
              className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-textGray transition-colors hover:text-danger"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
        )}

        <div className="ml-auto flex items-center gap-2.5">
          <span className="flex items-center gap-1.5 rounded-md bg-bgGray px-2.5 py-1 text-[11px] text-textGray">
            未绑定 <span className="font-semibold tabular-nums text-textDark">{unboundCount}</span>
          </span>
          <span
            className={clsx(
              'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px]',
              proposals.length > 0 ? 'bg-[#FBF0DE] text-amber' : 'bg-bgGray text-textGray',
            )}
          >
            待确认建议 <span className="font-semibold tabular-nums">{proposals.length}</span>
          </span>
          <button
            type="button"
            onClick={handleRefresh}
            className="flex h-7 items-center gap-1 rounded-md border border-borderGray bg-white px-2.5 text-[12px] text-textDark hover:bg-bgGray"
          >
            <RefreshCw className={clsx('h-3.5 w-3.5', busy && 'animate-spin')} aria-hidden />
            刷新
          </button>
        </div>
      </div>

      {/* 三栏主体：左右面板可折叠 */}
      <div className="flex min-h-0 flex-1">
        <div
          className={clsx(
            'flex min-h-0 shrink-0 overflow-hidden transition-[width] duration-200',
            docsCollapsed ? 'w-0' : 'w-64',
          )}
        >
          <DocListPanel
            docs={overview}
            loading={b.loading}
            error={b.error}
            selectedDocId={selectedDocId}
            onSelect={handleSelectDoc}
            onRetry={() => void b.refreshOverview()}
          />
        </div>
        <PanelRail
          collapsed={docsCollapsed}
          side="left"
          label="文档"
          onToggle={() => setDocsCollapsed((v) => !v)}
        />

        <CandidatePanel
          doc={selected}
          rows={rows}
          anchors={candidates?.anchors ?? null}
          hasExtraction={candidates?.hasExtraction ?? true}
          loading={b.candidatesLoading}
          error={b.candidatesError}
          focusedKey={focusedKey}
          contracts={contracts}
          batchErrors={batchErrors}
          pending={pending}
          batchPending={batchPending}
          onFocus={setFocusedKey}
          onConfirm={requestConfirmRow}
          onReject={requestRejectRow}
          onBatchConfirm={requestBatchConfirm}
          onManualCreate={handleManualCreate}
          onRetryLoad={() => selectedDocId && void b.loadCandidates(selectedDocId)}
        />

        <PanelRail
          collapsed={detailCollapsed}
          side="right"
          label="详情"
          onToggle={() => setDetailCollapsed((v) => !v)}
        />
        <div
          className={clsx(
            'flex min-h-0 shrink-0 overflow-hidden transition-[width] duration-200',
            detailCollapsed ? 'w-0' : 'w-80',
          )}
        >
          <DetailPanel
            doc={selected}
            row={focusedRow}
            anchors={candidates?.anchors ?? null}
            pending={pending}
            docTypes={b.docTypes}
            onChangeDocType={(t) => void handleChangeDocType(t)}
            onConfirm={requestConfirmRow}
            onReject={requestRejectRow}
            onConfirmBinding={requestConfirmBinding}
            onRejectBinding={requestRejectBinding}
            onUnbind={requestUnbind}
            onRetrySync={handleRetrySync}
            onOpenInGraph={onOpenInGraph}
          />
        </div>
      </div>

      {/* 二次确认弹窗 */}
      {confirmReq && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4">
          <div className="w-full max-w-sm animate-fade-in rounded-lg border border-borderGray bg-white p-5 shadow-card">
            <div className="flex items-center gap-2">
              {confirmReq.danger && <AlertTriangle className="h-4 w-4 shrink-0 text-danger" aria-hidden />}
              <div className="text-[14px] font-semibold text-textDark">{confirmReq.title}</div>
            </div>
            <div className="mt-2 whitespace-pre-line text-[12px] leading-5 text-textGray">{confirmReq.body}</div>
            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={closeConfirm}
                disabled={confirmBusy}
                className="h-8 rounded-md border border-borderGray bg-white px-3 text-[12px] text-textGray hover:bg-bgGray disabled:opacity-50"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void runConfirmed()}
                disabled={confirmBusy}
                className={clsx(
                  'flex h-8 items-center gap-1.5 rounded-md px-3 text-[12px] font-medium text-white disabled:opacity-50',
                  confirmReq.danger ? 'bg-danger hover:bg-[#991B1B]' : 'bg-deepSea hover:bg-[#164a76]',
                )}
              >
                {confirmBusy && (
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden />
                )}
                {confirmReq.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 右上角 toast(3s 自动消失) */}
      <div className="pointer-events-none fixed right-4 top-4 z-[60] flex w-80 flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={clsx(
              'animate-fade-in rounded-md border border-borderGray border-l-4 bg-white px-3.5 py-2.5 shadow-card',
              t.kind === 'error' ? 'border-l-danger' : 'border-l-success',
            )}
          >
            <div className="flex items-start gap-2">
              {t.kind === 'error' ? (
                <AlertTriangle className="mt-px h-4 w-4 shrink-0 text-danger" aria-hidden />
              ) : (
                <CheckCircle2 className="mt-px h-4 w-4 shrink-0 text-success" aria-hidden />
              )}
              <span className="text-[12px] leading-5 text-textDark">{t.text}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default BindingsView;
