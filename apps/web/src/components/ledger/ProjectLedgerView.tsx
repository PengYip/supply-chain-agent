import { useCallback, useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import {
  AlertCircle,
  BookOpen,
  ChevronDown,
  FileText,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { listProjects, fetchProjectRollup, type ProjectSummary, type ProjectRollupResp } from '../../api/projects';
import { fetchLedgerOverview, type LedgerDoc } from '../../api/ledger';
import { prettyDocName } from '../graph/businessTypes';
import {
  VOUCHER_DIMENSIONS,
  coverageOf,
  countByDimension,
  type VoucherEntry,
} from '../../lib/voucherCoverage';

/* ---------- 项目台账视图(P3 需求池 A) ----------
 *
 * 首屏: 左栏项目卡片列表 -> 点开项目 -> 右栏按 采购/销售/其他 分组的合同卡,
 * 每份合同展示凭证齐套率(五维: 合同文本/货权/资金/发票/质检)与凭证明细。
 * 纯前端聚合: rollup(合同面) + /api/bindings/overview(绑定总览), 不加后端。
 * 只读视图: 归属确认/指派仍走「项目」页, 本页只给到项目页的入口。
 */

const fmtAmount = (n: number | null): string =>
  n === null ? '—' : n.toLocaleString('zh-CN', { maximumFractionDigits: 2 });

const ROLE_BADGE: Record<string, { label: string; cls: string }> = {
  采购: { label: '采购', cls: 'bg-warning/10 text-warning border-warning/30' },
  销售: { label: '销售', cls: 'bg-success/10 text-success border-success/30' },
};

const GROUPS: Array<{ key: string; label: string }> = [
  { key: '采购', label: '采购合同' },
  { key: '销售', label: '销售合同' },
  { key: '其他', label: '其他合同（物流 / 租赁 / 服务 / 未分类）' },
];

const groupOf = (role: string): string => (role === '采购' || role === '销售' ? role : '其他');

/** 单份合同的凭证聚合(overview 只含非 rejected 绑定行)。 */
interface ContractVouchers {
  confirmed: Array<{ fileName: string; docType: string; relation: string }>;
  proposedCount: number;
}

/** 合同卡: 齐套率分段条 + 维度计数 chips + 可展开的凭证明细。 */
function ContractCard({
  contract,
  vouchers,
  expanded,
  onToggle,
}: {
  contract: ProjectRollupResp['contracts'][number];
  vouchers: ContractVouchers;
  expanded: boolean;
  onToggle: () => void;
}) {
  const entries: VoucherEntry[] = vouchers.confirmed;
  const coverage = useMemo(() => coverageOf(entries), [entries]);
  const counts = useMemo(() => countByDimension(entries), [entries]);
  const roleBadge = ROLE_BADGE[contract.role] ?? {
    label: contract.role,
    cls: 'bg-surface/50 text-ink border-line/50',
  };

  return (
    <div className="rounded-lg border border-line bg-white overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="w-full text-left px-3 py-2.5 transition-colors hover:bg-surface/40"
      >
        {/* 行 1: 角色 + 合同号 + 标题 + 金额 */}
        <div className="flex items-center gap-2">
          <span className={clsx('shrink-0 inline-flex items-center text-[11px] px-2 py-0.5 rounded border', roleBadge.cls)}>
            {roleBadge.label}
          </span>
          <span className="shrink-0 font-mono text-xs font-medium text-ink" title={contract.contractNo}>
            {contract.displayContractNo}
          </span>
          {contract.title && (
            <span className="min-w-0 flex-1 truncate text-xs text-ink-soft" title={contract.title}>
              {contract.title}
            </span>
          )}
          <span className="ml-auto shrink-0 font-mono text-xs tabular-nums text-ink">
            {fmtAmount(contract.amount)}
            {contract.currency ? <span className="ml-1 text-[11px] text-ink-soft">{contract.currency}</span> : null}
          </span>
          <ChevronDown
            className={clsx('h-3.5 w-3.5 shrink-0 text-ink-soft transition-transform', expanded && 'rotate-180')}
            aria-hidden
          />
        </div>
        {/* 行 2: 齐套率分段条 + 百分比 + 计数 */}
        <div className="mt-2 flex items-center gap-2">
          <span className="shrink-0 text-[11px] text-ink-soft">凭证齐套率</span>
          <div className="flex h-1.5 min-w-0 flex-1 gap-0.5" aria-hidden>
            {VOUCHER_DIMENSIONS.map((d) => (
              <span
                key={d.key}
                className={clsx('flex-1 rounded-full', coverage.covered.has(d.key) ? 'bg-primary' : 'bg-line')}
              />
            ))}
          </div>
          <span
            className={clsx(
              'shrink-0 font-mono text-xs tabular-nums',
              coverage.ratio >= 1 ? 'text-success font-semibold' : 'text-ink',
            )}
          >
            {Math.round(coverage.ratio * 100)}%
          </span>
          <span className="shrink-0 text-[11px] text-ink-soft">
            已绑定 {vouchers.confirmed.length} 张
            {vouchers.proposedCount > 0 ? ` · 待确认 ${vouchers.proposedCount}` : ''}
          </span>
        </div>
        {/* 行 3: 五维计数 chips(未覆盖维度弱化, 缺口一眼可见) */}
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {VOUCHER_DIMENSIONS.map((d) => {
            const n = counts.get(d.key) ?? 0;
            const covered = n > 0;
            return (
              <span
                key={d.key}
                title={covered ? `${d.label} ${n} 张` : `${d.label}：暂无已确认凭证`}
                className={clsx(
                  'inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded border tabular-nums',
                  covered ? 'bg-primary/5 text-primary border-primary/20' : 'bg-surface/50 text-ink-soft/70 border-line/50',
                )}
              >
                {d.label}
                <span className="font-mono">{n}</span>
              </span>
            );
          })}
        </div>
      </button>
      {/* 展开区: 凭证明细(已确认绑定在前, 文件名 / 类型 / 关系) */}
      {expanded && (
        <div className="border-t border-line/60">
          {vouchers.confirmed.length === 0 ? (
            <div className="px-3 py-3 text-xs text-ink-soft">该合同尚无已确认绑定的凭证，可在「绑定」页挂执行单据</div>
          ) : (
            <div className="divide-y divide-line/40">
              {vouchers.confirmed.map((v, i) => (
                <div key={`${v.fileName}-${i}`} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                  <FileText className="h-3.5 w-3.5 shrink-0 text-ink-soft" aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-ink" title={v.fileName}>
                    {prettyDocName(v.fileName) || v.fileName}
                  </span>
                  <span className="shrink-0 rounded border border-primary/20 bg-primary/10 px-1.5 py-px text-[10px] text-primary-500">
                    {v.docType || '未分类'}
                  </span>
                  <span className="shrink-0 text-[11px] text-ink-soft">{v.relation}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ProjectLedgerView({ onOpenProjects }: { onOpenProjects?: () => void }) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const [rollup, setRollup] = useState<ProjectRollupResp | null>(null);
  const [overviewDocs, setOverviewDocs] = useState<LedgerDoc[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [expandedNo, setExpandedNo] = useState<string | null>(null);

  const refreshProjects = useCallback(async (): Promise<ProjectSummary[]> => {
    setLoading(true);
    setError(null);
    try {
      const list = await listProjects();
      setProjects(list);
      // 选中项被删/不可见时退回首项; 否则保持当前选择。
      setSelectedCode((prev) =>
        prev && list.some((p) => p.code === prev) ? prev : (list[0]?.code ?? null));
      return list;
    } catch (e) {
      setError(e instanceof Error ? e.message : '项目列表加载失败');
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshProjects();
  }, [refreshProjects]);

  /** 明细 = rollup(合同面) + 绑定总览(凭证聚合), 并行拉取。 */
  const refreshDetail = useCallback(async (code: string | null) => {
    if (!code) {
      setRollup(null);
      return;
    }
    setDetailLoading(true);
    try {
      const [r, overview] = await Promise.all([fetchProjectRollup(code), fetchLedgerOverview()]);
      setRollup(r);
      setOverviewDocs(overview.docs);
    } catch (e) {
      setError(e instanceof Error ? e.message : '项目明细加载失败');
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    setExpandedNo(null);
    void refreshDetail(selectedCode);
  }, [selectedCode, refreshDetail]);

  const refreshAll = useCallback(async () => {
    await refreshProjects();
    await refreshDetail(selectedCode);
  }, [refreshProjects, refreshDetail, selectedCode]);

  /** contractNo -> 凭证聚合(全用户文档一次性聚合, 视图内按本项目合同取用)。 */
  const vouchersByContract = useMemo(() => {
    const map = new Map<string, ContractVouchers>();
    for (const doc of overviewDocs) {
      for (const b of doc.bindings) {
        if (b.status !== 'confirmed' && b.status !== 'proposed') continue;
        const cur = map.get(b.contractNo) ?? { confirmed: [], proposedCount: 0 };
        if (b.status === 'confirmed') {
          cur.confirmed.push({ fileName: doc.fileName, docType: doc.docType, relation: b.relation });
        } else {
          cur.proposedCount += 1;
        }
        map.set(b.contractNo, cur);
      }
    }
    return map;
  }, [overviewDocs]);

  /** 合同分组: 采购 / 销售 / 其他。 */
  const groups = useMemo(() => {
    const byGroup = new Map<string, ProjectRollupResp['contracts']>();
    for (const c of rollup?.contracts ?? []) {
      const key = groupOf(c.role);
      const list = byGroup.get(key) ?? [];
      list.push(c);
      byGroup.set(key, list);
    }
    return GROUPS.filter((g) => (byGroup.get(g.key) ?? []).length > 0).map((g) => ({ ...g, contracts: byGroup.get(g.key)! }));
  }, [rollup]);

  const selected = projects.find((p) => p.code === selectedCode) ?? null;
  const totalVouchers = useMemo(
    () => (rollup?.contracts ?? []).reduce((sum, c) => sum + (vouchersByContract.get(c.contractNo)?.confirmed.length ?? 0), 0),
    [rollup, vouchersByContract],
  );
  const totalProposed = useMemo(
    () => (rollup?.contracts ?? []).reduce((sum, c) => sum + (vouchersByContract.get(c.contractNo)?.proposedCount ?? 0), 0),
    [rollup, vouchersByContract],
  );

  return (
    <div className="flex h-full min-w-0 bg-surface/40">
      {/* 左栏: 项目列表 */}
      <aside className="w-72 shrink-0 flex flex-col border-r border-line bg-white">
        <div className="shrink-0 border-b border-line px-4 py-3 flex items-center gap-2">
          <BookOpen className="h-4 w-4 text-primary" aria-hidden />
          <span className="text-[15px] font-semibold text-ink">项目台账</span>
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
        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading && projects.length === 0 ? (
            <div className="px-4 py-10 text-center text-xs text-ink-soft">加载中...</div>
          ) : projects.length === 0 ? (
            <div className="px-4 py-10 text-center text-xs text-ink-soft leading-5">
              暂无项目
              <br />
              先到「项目」页创建并确认合同归属
            </div>
          ) : (
            projects.map((p) => (
              <button
                key={p.code}
                type="button"
                onClick={() => setSelectedCode(p.code)}
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

      {/* 右栏: 选中项目的台账 */}
      <div className="min-w-0 flex-1 overflow-y-auto">
        {!selected ? (
          <div className="h-full flex items-center justify-center text-sm text-ink-soft">
            选择左侧项目查看合同台账
          </div>
        ) : (
          <div className="px-5 py-4 space-y-4 max-w-5xl">
            <div className="flex items-center gap-2">
              <span className="font-mono text-sm font-semibold text-primary">{selected.code}</span>
              <span className="text-sm text-ink truncate">{selected.name}</span>
              {detailLoading && <Loader2 className="h-3.5 w-3.5 animate-spin text-ink-soft" aria-hidden />}
            </div>

            {error && (
              <div className="flex items-start gap-1.5 text-xs text-danger bg-danger/5 border border-danger/30 rounded px-2 py-1.5">
                <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden />
                <span className="leading-relaxed">{error}</span>
              </div>
            )}

            {rollup && (
              <>
                {/* 汇总 chips */}
                <div className="flex flex-wrap items-center gap-2 text-[11px] text-ink-soft">
                  <span className="rounded-md bg-white border border-line px-2 py-1">
                    合同 <span className="font-semibold tabular-nums text-ink">{rollup.contracts.length}</span>
                  </span>
                  <span className="rounded-md bg-white border border-line px-2 py-1">
                    已确认凭证 <span className="font-semibold tabular-nums text-ink">{totalVouchers}</span>
                  </span>
                  <span className={clsx('rounded-md border px-2 py-1', totalProposed > 0 ? 'bg-warning/10 border-warning/30 text-warning' : 'bg-white border-line')}>
                    待确认绑定 <span className="font-semibold tabular-nums">{totalProposed}</span>
                  </span>
                  <span>齐套率按五维口径：合同文本 / 货权 / 资金 / 发票 / 质检</span>
                </div>

                {/* 待确认归属提示条 */}
                {rollup.pendingMemberships.length > 0 && (
                  <div className="flex items-start gap-1.5 text-xs text-warning bg-warning/5 border border-warning/30 rounded px-2 py-1.5">
                    <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden />
                    <span className="leading-relaxed">
                      另有 {rollup.pendingMemberships.length} 份合同归属待确认
                      {onOpenProjects && (
                        <>
                          {'，'}
                          <button
                            type="button"
                            onClick={onOpenProjects}
                            className="text-primary underline underline-offset-2 hover:text-primary-800"
                          >
                            到项目页处理
                          </button>
                        </>
                      )}
                    </span>
                  </div>
                )}

                {/* 合同分组 */}
                {groups.length === 0 ? (
                  <div className="rounded-lg border border-line bg-white px-3 py-8 text-center text-xs text-ink-soft leading-5">
                    该项目暂无已确认归属的合同
                    <br />
                    归属确认与人工指派请在「项目」页操作
                  </div>
                ) : (
                  groups.map((g) => (
                    <section key={g.key} className="space-y-2">
                      <div className="flex items-center gap-2">
                        <span className="text-[13px] font-medium text-ink">{g.label}</span>
                        <span className="rounded-full bg-surface px-1.5 text-[11px] text-ink-soft tabular-nums">
                          {g.contracts.length}
                        </span>
                      </div>
                      <div className="space-y-2">
                        {g.contracts.map((c) => (
                          <ContractCard
                            key={c.contractNo}
                            contract={c}
                            vouchers={vouchersByContract.get(c.contractNo) ?? { confirmed: [], proposedCount: 0 }}
                            expanded={expandedNo === c.contractNo}
                            onToggle={() => setExpandedNo((prev) => (prev === c.contractNo ? null : c.contractNo))}
                          />
                        ))}
                      </div>
                    </section>
                  ))
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default ProjectLedgerView;
