import { useState } from 'react';
import clsx from 'clsx';
import {
  AlertCircle,
  AlertTriangle,
  Check,
  FolderKanban,
  Loader2,
  Plus,
  RefreshCw,
  X,
} from 'lucide-react';
import { useProjects } from '../../hooks/useProjects';
import type { ProjectMembership } from '../../api/projects';

/* ---------- 项目工作台(spec 2026-08-20 §6.2) ----------
 *
 * 左栏: 项目列表(编号/名称/合同数/待确认角标) + 新建表单。
 * 右栏(选中项目): 指标卡六格 -> 合同面表格 -> 待确认归属(确认/拒绝) ->
 * 人工指派表单 -> 校验提示条 -> 六向流水小表。样式复用既有卡片/徽章 token。
 */

const CONTRACT_TYPES = ['采购', '销售', '物流', '租赁', '服务', '其他'] as const;

const fmtAmount = (n: number | null): string =>
  n === null ? '—' : n.toLocaleString('zh-CN', { maximumFractionDigits: 2 });

function StatusBadge({ status }: { status: ProjectMembership['status'] }) {
  const map: Record<ProjectMembership['status'], { label: string; cls: string }> = {
    proposed: { label: '待确认', cls: 'bg-warning/10 text-warning border-warning/30' },
    confirmed: { label: '已确认', cls: 'bg-success/10 text-success border-success/30' },
    rejected: { label: '已拒绝', cls: 'bg-surface text-ink-soft border-line' },
  };
  const entry = map[status];
  return (
    <span className={clsx('inline-flex items-center text-[11px] font-medium px-2 py-0.5 rounded border shrink-0', entry.cls)}>
      {entry.label}
    </span>
  );
}

/** 指标卡一格。 */
function MetricCell({ label, value, emphasis }: { label: string; value: string; emphasis?: boolean }) {
  return (
    <div className={clsx('rounded-lg border px-3 py-2.5', emphasis ? 'bg-primary/5 border-primary/30' : 'bg-white border-line')}>
      <div className="text-[11px] text-ink-soft">{label}</div>
      <div className={clsx('mt-1 font-mono text-sm tabular-nums', emphasis ? 'text-primary font-semibold' : 'text-ink')}>
        {value}
      </div>
    </div>
  );
}

export function ProjectsView() {
  const {
    projects, loading, error, selectedCode, selectProject,
    memberships, rollup, detailLoading, refreshAll,
    addProject, assign, confirm, reject,
  } = useProjects();

  // 新建表单与指派表单的本地状态。
  const [newCode, setNewCode] = useState('');
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [assignNo, setAssignNo] = useState('');
  const [assignRole, setAssignRole] = useState<string>('采购');
  const [assigning, setAssigning] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const handleCreate = async () => {
    if (!newCode.trim() || !newName.trim() || creating) return;
    setCreating(true);
    setActionError(null);
    try {
      await addProject(newCode.trim(), newName.trim());
      setNewCode('');
      setNewName('');
    } catch (e) {
      setActionError(e instanceof Error ? e.message : '创建失败');
    } finally {
      setCreating(false);
    }
  };

  const handleAssign = async () => {
    if (!selectedCode || !assignNo.trim() || assigning) return;
    setAssigning(true);
    setActionError(null);
    try {
      await assign(selectedCode, assignNo.trim(), assignRole);
      setAssignNo('');
    } catch (e) {
      setActionError(e instanceof Error ? e.message : '指派失败');
    } finally {
      setAssigning(false);
    }
  };

  const handleMembershipAction = async (id: string, action: 'confirm' | 'reject') => {
    setConfirmingId(id);
    setActionError(null);
    try {
      if (action === 'confirm') await confirm(id);
      else await reject(id);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : '操作失败');
    } finally {
      setConfirmingId(null);
    }
  };

  const pending = memberships.filter((m) => m.status === 'proposed');
  const selected = projects.find((p) => p.code === selectedCode) ?? null;

  return (
    <div className="flex h-full min-w-0 bg-surface/40">
      {/* 左栏: 项目列表 + 新建 */}
      <aside className="w-72 shrink-0 flex flex-col border-r border-line bg-white">
        <div className="shrink-0 border-b border-line px-4 py-3 flex items-center gap-2">
          <FolderKanban className="h-4 w-4 text-primary" aria-hidden />
          <span className="text-[15px] font-semibold text-ink">项目</span>
          <button
            type="button"
            title="刷新"
            aria-label="刷新"
            onClick={() => void refreshAll()}
            className="ml-auto w-7 h-7 rounded-md flex items-center justify-center text-ink-soft hover:bg-surface"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>

        {/* 新建表单 */}
        <div className="shrink-0 px-3 py-2.5 border-b border-line space-y-1.5">
          <div className="flex gap-1.5">
            <input
              type="text"
              value={newCode}
              onChange={(e) => setNewCode(e.target.value)}
              placeholder="编号 如 PRJ-2026-001"
              spellCheck={false}
              className="min-w-0 flex-1 rounded-md border border-line px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-primary-500/40"
            />
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="名称"
              spellCheck={false}
              className="min-w-0 flex-1 rounded-md border border-line px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-primary-500/40"
            />
          </div>
          <button
            type="button"
            onClick={() => void handleCreate()}
            disabled={creating || !newCode.trim() || !newName.trim()}
            className="w-full inline-flex items-center justify-center gap-1 rounded-md bg-primary-500 text-white text-xs font-medium px-3 py-1.5 hover:bg-primary-500/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Plus className="h-3.5 w-3.5" aria-hidden />}
            新建项目
          </button>
        </div>

        {/* 列表 */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading && projects.length === 0 ? (
            <div className="px-4 py-10 text-center text-xs text-ink-soft">加载中...</div>
          ) : projects.length === 0 ? (
            <div className="px-4 py-10 text-center text-xs text-ink-soft">暂无项目，先在上方新建</div>
          ) : (
            projects.map((p) => (
              <button
                key={p.code}
                type="button"
                onClick={() => selectProject(p.code)}
                className={clsx(
                  'w-full text-left px-4 py-2.5 border-b border-line/60 transition-colors',
                  p.code === selectedCode ? 'bg-primary/5' : 'hover:bg-surface/60',
                )}
              >
                <div className="flex items-center gap-2">
                  <span className={clsx('font-mono text-xs truncate', p.code === selectedCode ? 'text-primary font-semibold' : 'text-ink')}>
                    {p.code}
                  </span>
                  {p.proposedCount > 0 && (
                    <span className="shrink-0 inline-flex items-center rounded-full bg-warning/15 text-warning text-[10px] font-medium px-1.5 leading-4">
                      {p.proposedCount} 待确认
                    </span>
                  )}
                </div>
                <div className="mt-0.5 text-[11px] text-ink-soft truncate">{p.name || '—'}</div>
                <div className="mt-0.5 text-[11px] text-ink-soft">合同 {p.membershipCount}</div>
              </button>
            ))
          )}
        </div>
      </aside>

      {/* 右栏: 选中项目 */}
      <div className="min-w-0 flex-1 overflow-y-auto">
        {!selected ? (
          <div className="h-full flex items-center justify-center text-sm text-ink-soft">
            选择左侧项目查看统计
          </div>
        ) : (
          <div className="px-5 py-4 space-y-4 max-w-5xl">
            {/* 标题 */}
            <div className="flex items-center gap-2">
              <span className="font-mono text-sm font-semibold text-primary">{selected.code}</span>
              <span className="text-sm text-ink truncate">{selected.name}</span>
              {detailLoading && <Loader2 className="h-3.5 w-3.5 animate-spin text-ink-soft" aria-hidden />}
            </div>

            {(error || actionError) && (
              <div className="flex items-start gap-1.5 text-xs text-danger bg-danger/5 border border-danger/30 rounded px-2 py-1.5">
                <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden />
                <span className="leading-relaxed">{actionError ?? error}</span>
              </div>
            )}

            {rollup && (
              <>
                {/* 指标卡六格 */}
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
                  <MetricCell label="销售金额" value={fmtAmount(rollup.metrics.salesAmount)} />
                  <MetricCell label="采购金额" value={fmtAmount(rollup.metrics.purchaseAmount)} />
                  <MetricCell label="费用金额" value={fmtAmount(rollup.metrics.expenseAmount)} />
                  <MetricCell label="毛差" value={fmtAmount(rollup.metrics.grossMargin)} emphasis />
                  <MetricCell label="应收未清" value={fmtAmount(rollup.metrics.receivableOpen)} />
                  <MetricCell label="应付未清" value={fmtAmount(rollup.metrics.payableOpen)} />
                </div>

                {/* 合同面表格 */}
                <div className="rounded-lg border border-line bg-white overflow-hidden">
                  <div className="px-3 py-2 border-b border-line text-[13px] font-medium text-ink">
                    合同面（{rollup.contracts.length}）
                  </div>
                  {rollup.contracts.length === 0 ? (
                    <div className="px-3 py-6 text-center text-xs text-ink-soft">暂无已确认归属的合同</div>
                  ) : (
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-ink-soft border-b border-line/60">
                          <th className="text-left font-normal px-3 py-1.5">合同号</th>
                          <th className="text-left font-normal px-3 py-1.5">类型</th>
                          <th className="text-left font-normal px-3 py-1.5">对手方</th>
                          <th className="text-right font-normal px-3 py-1.5">金额</th>
                          <th className="text-left font-normal px-3 py-1.5">币种</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rollup.contracts.map((c) => (
                          <tr key={c.contractNo} className="border-b border-line/40 last:border-0">
                            <td className="px-3 py-1.5 font-mono text-ink">{c.displayContractNo}</td>
                            <td className="px-3 py-1.5">
                              <span className="inline-flex items-center text-[11px] px-2 py-0.5 rounded border bg-surface/50 text-ink border-line/50">
                                {c.role}
                              </span>
                            </td>
                            <td className="px-3 py-1.5 text-ink">{c.counterparty ?? '—'}</td>
                            <td className="px-3 py-1.5 text-right font-mono tabular-nums text-ink">{fmtAmount(c.amount)}</td>
                            <td className="px-3 py-1.5 text-ink-soft">{c.currency ?? '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>

                {/* 校验提示条 */}
                {rollup.checks.length > 0 && (
                  <div className="space-y-1.5">
                    {rollup.checks.map((chk, i) => (
                      <div
                        key={`${chk.code}-${i}`}
                        className={clsx(
                          'flex items-start gap-1.5 text-xs rounded px-2 py-1.5 border',
                          chk.level === 'warn'
                            ? 'text-warning bg-warning/5 border-warning/30'
                            : 'text-ink-soft bg-surface/50 border-line',
                        )}
                      >
                        {chk.level === 'warn' ? (
                          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden />
                        ) : (
                          <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden />
                        )}
                        <span className="leading-relaxed">{chk.message}</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* 六向流水小表 */}
                <div className="rounded-lg border border-line bg-white overflow-hidden">
                  <div className="px-3 py-2 border-b border-line text-[13px] font-medium text-ink">
                    六向执行流水
                  </div>
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-ink-soft border-b border-line/60">
                        <th className="text-left font-normal px-3 py-1.5">流</th>
                        <th className="text-right font-normal px-3 py-1.5">进</th>
                        <th className="text-right font-normal px-3 py-1.5">出</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="border-b border-line/40">
                        <td className="px-3 py-1.5 text-ink">资金流</td>
                        <td className="px-3 py-1.5 text-right font-mono tabular-nums text-success">{fmtAmount(rollup.flows.资金流.in)}</td>
                        <td className="px-3 py-1.5 text-right font-mono tabular-nums text-ink">{fmtAmount(rollup.flows.资金流.out)}</td>
                      </tr>
                      <tr className="border-b border-line/40">
                        <td className="px-3 py-1.5 text-ink">发票流</td>
                        <td className="px-3 py-1.5 text-right font-mono tabular-nums text-ink">{fmtAmount(rollup.flows.发票流.in)}</td>
                        <td className="px-3 py-1.5 text-right font-mono tabular-nums text-ink">{fmtAmount(rollup.flows.发票流.out)}</td>
                      </tr>
                      <tr>
                        <td className="px-3 py-1.5 text-ink">货物流（吨）</td>
                        <td className="px-3 py-1.5 text-right font-mono tabular-nums text-ink">{fmtAmount(rollup.flows.货物流.inTon)}</td>
                        <td className="px-3 py-1.5 text-right font-mono tabular-nums text-ink">{fmtAmount(rollup.flows.货物流.outTon)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </>
            )}

            {/* 待确认归属 */}
            <div className="rounded-lg border border-line bg-white overflow-hidden">
              <div className="px-3 py-2 border-b border-line text-[13px] font-medium text-ink">
                待确认归属（{pending.length}）
              </div>
              {pending.length === 0 ? (
                <div className="px-3 py-4 text-center text-xs text-ink-soft">暂无待确认归属</div>
              ) : (
                <div className="divide-y divide-line/40">
                  {pending.map((m) => (
                    <div key={m.id} className="flex items-center gap-2 px-3 py-2">
                      <span className="font-mono text-xs text-ink">{m.contractNo}</span>
                      <span className="inline-flex items-center text-[11px] px-2 py-0.5 rounded border bg-surface/50 text-ink border-line/50">
                        {m.role ?? '未分类'}
                      </span>
                      <div className="ml-auto flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => void handleMembershipAction(m.id, 'confirm')}
                          disabled={confirmingId === m.id}
                          className="inline-flex items-center gap-1 rounded bg-success text-white text-[11px] font-medium px-2 py-1 hover:bg-success/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        >
                          {confirmingId === m.id ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <Check className="h-3 w-3" aria-hidden />}
                          确认
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleMembershipAction(m.id, 'reject')}
                          disabled={confirmingId === m.id}
                          className="inline-flex items-center gap-1 rounded border border-line text-ink-soft text-[11px] font-medium px-2 py-1 hover:bg-surface disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        >
                          <X className="h-3 w-3" aria-hidden />
                          拒绝
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* 人工指派表单 */}
            <div className="rounded-lg border border-line bg-white px-3 py-2.5">
              <div className="text-[13px] font-medium text-ink mb-2">人工指派归属</div>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  value={assignNo}
                  onChange={(e) => setAssignNo(e.target.value)}
                  placeholder="合同号"
                  spellCheck={false}
                  className="min-w-40 rounded-md border border-line px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-primary-500/40"
                />
                <select
                  value={assignRole}
                  onChange={(e) => setAssignRole(e.target.value)}
                  className="rounded-md border border-line px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-primary-500/40 bg-white"
                >
                  {CONTRACT_TYPES.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => void handleAssign()}
                  disabled={assigning || !assignNo.trim()}
                  className="inline-flex items-center gap-1 rounded-md bg-primary-500 text-white text-xs font-medium px-3 py-1.5 hover:bg-primary-500/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {assigning ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Plus className="h-3.5 w-3.5" aria-hidden />}
                  指派
                </button>
              </div>
            </div>

            {/* 全部归属(含已确认/已拒绝, 状态可见) */}
            {memberships.length > 0 && (
              <div className="rounded-lg border border-line bg-white overflow-hidden">
                <div className="px-3 py-2 border-b border-line text-[13px] font-medium text-ink">
                  全部归属（{memberships.length}）
                </div>
                <div className="divide-y divide-line/40">
                  {memberships.map((m) => (
                    <div key={m.id} className="flex items-center gap-2 px-3 py-2 text-xs">
                      <span className="font-mono text-ink">{m.contractNo}</span>
                      <span className="inline-flex items-center text-[11px] px-2 py-0.5 rounded border bg-surface/50 text-ink border-line/50">
                        {m.role ?? '未分类'}
                      </span>
                      <span className="ml-auto text-[11px] text-ink-soft font-mono">
                        置信 {Math.round(m.confidence * 100)}%
                      </span>
                      <StatusBadge status={m.status} />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default ProjectsView;
