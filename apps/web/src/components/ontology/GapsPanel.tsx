import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { AlertCircle, ChevronDown, RefreshCw } from 'lucide-react';
import {
  fetchGaps,
  type GapContractRowDTO, type GapGroupDTO, type GapItemDTO, type GapsReportDTO,
} from '../../api/ontology';

/** 勾稽缺口面板（business-loop Wave 4，2026-09-20）：GET /api/ontology/gaps 的只读投影，
 *  挂在本体视图「勾稽缺口」tab。三段式：四块 tiles 摘要 -> 四组可折叠明细（行=勾稽项）
 *  -> 按合同下钻（Wave 8：合同号/侧别/收发量/结算票款累计，默认收起）-> 勾稽校验说明
 *  （默认收起）。qty/amt 为 null 表示该口径数据未登记（missingInputs 说明原因），
 *  显示「待登记」弱化态，不造数（后端 R19 口径的前端承诺）。 */

type GroupKey = GapGroupDTO['key'];

/** 组色标（克制）：stock=中性蓝灰 / recv=绿 / pay=橙 / mis=红，只落在点标、code 圆标
 *  与 tiles 左侧 2px 强调线上；数值本身保持 ink，避免整页被语义色淹没。 */
const GROUP_THEME: Record<GroupKey, { dot: string; code: string; accent: string }> = {
  stock: { dot: 'bg-primary-400', code: 'border-primary-200 bg-primary-50 text-primary-700', accent: 'border-l-primary-300' },
  recv: { dot: 'bg-success', code: 'border-success/25 bg-success/10 text-success', accent: 'border-l-success/60' },
  pay: { dot: 'bg-warning', code: 'border-warning/30 bg-warning/10 text-warning', accent: 'border-l-warning/60' },
  mis: { dot: 'bg-danger', code: 'border-danger/25 bg-danger/10 text-danger', accent: 'border-l-danger/60' },
};

/** ④⑥ 负值语义角标(weak 弱化态, 不新建视觉体系): 收款超结算/超开票时用文字点明
 *  方向 —— ④=Σ销结算−Σ收款<0 → 预收, ⑥=净销项−Σ收款<0 → 超收。其余 code 的
 *  负值(如 ② 结算超收货)无既定语义, 不渲染。 */
const NEGATIVE_BADGE_BY_CODE: Partial<Record<string, { text: string; hint: string }>> = {
  '④': { text: '预收', hint: '收款超结算' },
  '⑥': { text: '超收', hint: '收款超开票' },
};

const fmtNum = (n: number): string => n.toLocaleString('zh-CN', { maximumFractionDigits: 2 });

/** 按合同下钻的侧别徽标（Wave 8）：购/销沿用项目台账 ROLE_BADGE 的语义色
 *  （采购=warning / 销售=success 弱底色），null=未定侧弱化态——合同类型分不出
 *  方向时的诚实呈现，不猜侧。 */
const SIDE_BADGE: Record<'buy' | 'sell' | 'null', { text: string; cls: string; title: string }> = {
  buy: { text: '购', cls: 'bg-warning/10 text-warning border-warning/30', title: '采购侧' },
  sell: { text: '销', cls: 'bg-success/10 text-success border-success/30', title: '销售侧' },
  null: { text: '未定侧', cls: 'bg-surface/50 text-ink-soft/70 border-line/50', title: '合同侧别无法判定，相关勾稽口径受影响' },
};

export function GapsPanel() {
  const [report, setReport] = useState<GapsReportDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // projectNo 过滤：draft 是输入框草稿，applied 是已生效的查询条件（显式应用，不做逐键请求——
  // projectNo 是精确匹配，半截编号只会命中空范围，防抖自动查反而制造"查不到"困惑）。
  const [draftProjectNo, setDraftProjectNo] = useState('');
  const [appliedProjectNo, setAppliedProjectNo] = useState<string | null>(null);
  // 过期响应守卫（照抄 EntitiesView seqRef 模式）：刷新/改过滤时先发后至的旧响应不得覆盖新结果。
  const seqRef = useRef(0);
  // 折叠态：四组默认展开（明细是本面板的主体），checks 默认收起（等式推导是佐证材料）。
  // 按合同下钻默认收起（Wave 8）：七列宽表 + 行数不定，属二级下钻，头部计数引导展开。
  const [collapsed, setCollapsed] = useState<Partial<Record<GroupKey, boolean>>>({});
  const [checksOpen, setChecksOpen] = useState(false);
  const [contractsOpen, setContractsOpen] = useState(false);

  const load = useCallback(async (projectNo?: string) => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await fetchGaps(projectNo);
      if (seq !== seqRef.current) return;
      setReport(res);
    } catch (e) {
      if (seq !== seqRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, []);

  // 首载经 setTimeout 触发（照抄 EntitiesView 的 effect 防抖形态）：load 的同步前奏
  // (setLoading/setError) 在 effect 内直呼会触发 set-state-in-effect 级联渲染告警。
  useEffect(() => {
    const t = setTimeout(() => { void load(); }, 0);
    return () => clearTimeout(t);
  }, [load]);

  const applyFilter = () => {
    const pn = draftProjectNo.trim();
    setAppliedProjectNo(pn || null);
    void load(pn || undefined);
  };
  const clearFilter = () => {
    setDraftProjectNo('');
    setAppliedProjectNo(null);
    void load();
  };

  const tileByKey = useMemo(
    () => new Map((report?.tiles ?? []).map((t) => [t.key, t])),
    [report],
  );

  // 初始加载（无数据可展示）：错误卡 / 加载文案，不给工具栏（避免对空数据过滤）。
  if (!report) {
    if (error) {
      return (
        <div className="h-full overflow-y-auto p-6">
          <div className="rounded-lg border border-line bg-white p-4 text-sm text-danger">{error}</div>
          <button
            type="button"
            onClick={() => void load(appliedProjectNo ?? undefined)}
            className="mt-3 rounded-md border border-line px-3 py-1.5 text-xs text-ink-soft transition-colors hover:border-primary/40 hover:text-primary"
          >
            重试
          </button>
        </div>
      );
    }
    return <div className="p-6 text-sm text-ink-soft">加载中...</div>;
  }

  const scopeLabel = report.scope === 'all' ? '全部合同' : `项目 ${report.scope}`;

  return (
    <div className="h-full overflow-y-auto bg-surface/40">
      <div className="max-w-5xl space-y-5 px-5 py-4">
        {/* 工具栏：projectNo 过滤（显式应用）+ 刷新 + scope + 加载/错误态 */}
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={draftProjectNo}
            onChange={(e) => setDraftProjectNo(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') applyFilter(); }}
            placeholder="项目编号过滤（可选）"
            aria-label="项目编号过滤"
            className="h-8 w-56 rounded border border-line bg-white px-2 text-sm text-ink placeholder:text-ink-soft/60 focus:outline-none focus:ring-1 focus:ring-primary/40"
          />
          <button
            type="button"
            onClick={applyFilter}
            className="h-8 rounded border border-line px-3 text-xs text-ink-soft transition-colors hover:border-primary/40 hover:text-primary"
          >
            应用
          </button>
          {appliedProjectNo && (
            <button
              type="button"
              onClick={clearFilter}
              className="h-8 rounded border border-line px-3 text-xs text-ink-soft transition-colors hover:border-primary/40 hover:text-primary"
            >
              清除
            </button>
          )}
          <div className="ml-auto flex items-center gap-3">
            {loading && <span className="text-xs text-ink-soft">加载中...</span>}
            {/* 刷新失败但已有数据：保留旧数据 + 内联报错，不整页坍缩 */}
            {!loading && error && <span className="text-xs text-danger" title={error}>刷新失败</span>}
            <span className="text-xs text-ink-soft">{`范围：${scopeLabel}`}</span>
            <button
              type="button"
              onClick={() => void load(appliedProjectNo ?? undefined)}
              disabled={loading}
              className="flex h-8 items-center gap-1.5 rounded border border-line px-3 text-xs text-ink-soft transition-colors hover:border-primary/40 hover:text-primary disabled:opacity-40"
            >
              <RefreshCw className={clsx('h-3.5 w-3.5', loading && 'animate-spin')} aria-hidden />
              刷新
            </button>
          </div>
        </div>

        {/* 四块 tiles 摘要：大数字卡，组色标落在左侧 2px 强调线与点标上 */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {report.tiles.map((tile) => {
            const theme = GROUP_THEME[tile.key as GroupKey] ?? GROUP_THEME.stock;
            const hasQty = tile.qty != null;
            const hasAmt = tile.amt != null;
            const nullReasons = tileNullReasons(report, tile.key);
            const nullTitle = !hasQty && !hasAmt
              ? `${tile.hint ?? ''}；该口径数据未登记${nullReasons.length > 0 ? `（${nullReasons.join('；')}）` : ''}`
              : tile.hint;
            return (
              <div
                key={tile.key}
                title={nullTitle}
                className={clsx('rounded-lg border border-line border-l-2 bg-white p-4', theme.accent)}
              >
                <div className="flex items-center gap-1.5 text-xs text-ink-soft">
                  <span className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', theme.dot)} aria-hidden />
                  {tile.label}
                </div>
                <div className="mt-2 flex items-baseline gap-1">
                  {hasQty || hasAmt ? (
                    <>
                      <span className="text-2xl font-semibold tabular-nums text-ink">
                        {fmtNum(hasQty ? (tile.qty as number) : (tile.amt as number))}
                      </span>
                      <span className="text-xs text-ink-soft">{hasQty ? '吨' : '元'}</span>
                    </>
                  ) : (
                    <span className="pt-1.5 text-sm text-ink-soft/70">待登记</span>
                  )}
                </div>
                {tile.hint && <div className="mt-1.5 text-xs leading-4 text-ink-soft/70">{tile.hint}</div>}
              </div>
            );
          })}
        </div>

        {/* 四组可折叠明细 */}
        <div className="space-y-3">
          {report.groups.map((group) => {
            const theme = GROUP_THEME[group.key];
            const open = !collapsed[group.key];
            const tile = tileByKey.get(group.key);
            const headline = tile?.qty != null
              ? `${fmtNum(tile.qty)} 吨`
              : tile?.amt != null
                ? `${fmtNum(tile.amt)} 元`
                : '待登记';
            return (
              <section key={group.key} className="overflow-hidden rounded-lg border border-line bg-white">
                <button
                  type="button"
                  onClick={() => setCollapsed((c) => ({ ...c, [group.key]: open }))}
                  aria-expanded={open}
                  className="flex w-full items-center gap-2.5 px-4 py-3 text-left transition-colors hover:bg-surface/40"
                >
                  <span className={clsx('h-2 w-2 shrink-0 rounded-[3px]', theme.dot)} aria-hidden />
                  <span className="shrink-0 text-sm font-medium text-ink">{group.label}</span>
                  <span className="hidden min-w-0 truncate text-xs text-ink-soft md:inline">{group.desc}</span>
                  <span className="ml-auto shrink-0 text-xs tabular-nums text-ink-soft">{headline}</span>
                  <ChevronDown
                    className={clsx('h-4 w-4 shrink-0 text-ink-soft transition-transform', open && 'rotate-180')}
                    aria-hidden
                  />
                </button>
                {open && (
                  <div className="animate-fade-in divide-y divide-line/60 border-t border-line/60">
                    {group.items.map((item) => (
                      <GapRow key={item.code} item={item} theme={theme} />
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>

        {/* 按合同下钻（Wave 8）：T2 report.contracts 直接投影，后端已按 |结算+进项+销项|
            降序，前端不重排。空态（字段缺失 / 空数组）整块不渲染——安静不占位。 */}
        {(report.contracts ?? []).length > 0 && (
          <section className="overflow-hidden rounded-lg border border-line bg-white" data-testid="gaps-contracts">
            <button
              type="button"
              onClick={() => setContractsOpen((v) => !v)}
              aria-expanded={contractsOpen}
              className="flex w-full items-center gap-2.5 px-4 py-3 text-left transition-colors hover:bg-surface/40"
            >
              <span className="h-2 w-2 shrink-0 rounded-[3px] bg-primary-400" aria-hidden />
              <span className="shrink-0 text-sm font-medium text-ink">按合同</span>
              <span className="hidden min-w-0 truncate text-xs text-ink-soft md:inline">
                每份合同的收发 / 结算 / 票款累计
              </span>
              <span className="ml-auto shrink-0 text-xs tabular-nums text-ink-soft">
                {(report.contracts ?? []).length} 份{report.scope !== 'all' ? ` · ${scopeLabel}` : ''}
              </span>
              <ChevronDown
                className={clsx('h-4 w-4 shrink-0 text-ink-soft transition-transform', contractsOpen && 'rotate-180')}
                aria-hidden
              />
            </button>
            {contractsOpen && (
              <div className="animate-fade-in border-t border-line/60">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[760px] border-collapse">
                    <thead>
                      <tr className="border-b border-line bg-surface text-[10px] font-medium text-ink-soft">
                        <th className="px-3 py-1.5 text-left font-medium">合同号</th>
                        <th className="px-2 py-1.5 text-left font-medium">侧别</th>
                        <th className="whitespace-nowrap px-2 py-1.5 text-right font-medium">收货量</th>
                        <th className="whitespace-nowrap px-2 py-1.5 text-right font-medium">发货量</th>
                        <th className="whitespace-nowrap px-2 py-1.5 text-right font-medium">结算</th>
                        <th className="whitespace-nowrap px-2 py-1.5 text-right font-medium">进项</th>
                        <th className="whitespace-nowrap px-2 py-1.5 text-right font-medium">销项</th>
                        <th className="whitespace-nowrap px-2 py-1.5 text-right font-medium">付款</th>
                        <th className="whitespace-nowrap px-2 py-1.5 text-right font-medium">收款</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(report.contracts ?? []).map((c) => (
                        <ContractDrilldownRow key={c.contractNo} row={c} />
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="border-t border-line/60 px-4 py-2 text-[10px] leading-4 text-ink-soft">
                  数量单位为吨，金额单位为元；标「缺」的口径缺输入，数值按已登记部分计，不可作对账依据。
                </div>
              </div>
            )}
          </section>
        )}

        {/* 勾稽校验说明：等宽小字，默认收起 */}
        <div className="rounded-lg border border-line bg-white">
          <button
            type="button"
            onClick={() => setChecksOpen((v) => !v)}
            aria-expanded={checksOpen}
            className="flex w-full items-center gap-2.5 px-4 py-3 text-left transition-colors hover:bg-surface/40"
          >
            <span className="text-sm font-medium text-ink">勾稽校验说明</span>
            <span className="text-xs text-ink-soft">{report.checks.length} 条等式</span>
            <ChevronDown
              className={clsx('ml-auto h-4 w-4 shrink-0 text-ink-soft transition-transform', checksOpen && 'rotate-180')}
              aria-hidden
            />
          </button>
          {checksOpen && (
            <div className="animate-fade-in border-t border-line/60 px-4 py-3">
              {report.checks.length === 0 ? (
                <div className="text-xs text-ink-soft">暂无可展示的勾稽等式（存在未登记口径）</div>
              ) : (
                <ul className="space-y-1">
                  {report.checks.map((line) => (
                    <li key={line} className="break-all rounded bg-surface/60 px-2 py-1 font-mono text-[11px] leading-5 text-ink-soft">
                      {line}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        <p className="rounded border border-dashed border-line bg-white/60 px-3 py-2 text-xs leading-5 text-ink-soft">
          数据出处：本体事件事实（trade_facts）与合同归属关系（ontology_edges）按现行业务口径聚合，
          经 GET /api/ontology/gaps；金额单位为元，数量单位为吨。
          「待登记」表示该口径尚缺输入数据（悬停查看原因），不作估算；带「口径提示」的行数值照算，
          但口径不完整（如合同侧别无法判定）。
        </p>
      </div>
    </div>
  );
}

/** 明细行：code 圆标 + label + basis 小字 + 数值（或待登记）+ 口径提示/负值语义角标。 */
function GapRow({ item, theme }: { item: GapItemDTO; theme: { code: string } }) {
  const reasons = item.missingInputs ?? [];
  const hasQty = item.qty != null;
  const hasAmt = item.amt != null;
  // ④⑥ 负值语义角标: 仅当 code ∈ {④,⑥} 且 amt 为负时渲染(正值/空值/其他 code 不出)。
  const negBadge = item.amt != null && item.amt < 0 ? NEGATIVE_BADGE_BY_CODE[item.code] : null;
  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <span
        className={clsx('flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs', theme.code)}
        aria-hidden
      >
        {item.code}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm text-ink">{item.label}</div>
        <div className="mt-0.5 font-mono text-[11px] leading-4 text-ink-soft">{item.basis}</div>
      </div>
      {reasons.length > 0 && <CaliberBadge reasons={reasons} />}
      {negBadge && (
        <span
          title={negBadge.hint}
          className="shrink-0 rounded border border-line bg-surface/60 px-1.5 py-0.5 text-[10px] text-ink-soft"
        >
          {negBadge.text}
        </span>
      )}
      <div className="w-40 shrink-0 text-right">
        {hasQty || hasAmt ? (
          <span className="text-sm tabular-nums text-ink">
            {fmtNum(hasQty ? (item.qty as number) : (item.amt as number))}
            <span className="ml-0.5 text-xs text-ink-soft">{hasQty ? '吨' : '元'}</span>
          </span>
        ) : (
          <span className="cursor-help text-sm text-ink-soft/70">待登记</span>
        )}
      </div>
    </div>
  );
}

/** 按合同下钻行（Wave 8）：合同号 + 侧别徽标 + 七列量额。missing 口径数值照显但
 *  弱化着色，并挂「缺」角标（沿 ④预收/⑥超收 的 quiet chip 视觉）+ tooltip 说明。 */
function ContractDrilldownRow({ row }: { row: GapContractRowDTO }) {
  const side = SIDE_BADGE[row.side ?? 'null'];
  return (
    <tr className="border-b border-line/60 last:border-b-0">
      <td className="whitespace-nowrap px-3 py-1.5 font-mono text-xs text-ink" title={row.contractNo}>
        {row.contractNo}
      </td>
      <td className="px-2 py-1.5">
        <span
          title={side.title}
          className={clsx('inline-flex items-center rounded border px-1.5 py-px text-[10px]', side.cls)}
        >
          {side.text}
        </span>
      </td>
      <MetricCell label="收货量" value={row.receiptsQty} missing={row.receiptsQtyMissing} />
      <MetricCell label="发货量" value={row.deliveriesQty} missing={row.deliveriesQtyMissing} />
      <MetricCell label="结算" value={row.settlements} />
      <MetricCell label="进项" value={row.invoicesIn} />
      <MetricCell label="销项" value={row.invoicesOut} />
      <MetricCell label="付款" value={row.payments} missing={row.paymentsMissing} />
      <MetricCell label="收款" value={row.collections} />
    </tr>
  );
}

/** 数值单元格：missing=true 时弱化着色 + 「缺」角标（数值照显，不隐藏不归零）。 */
function MetricCell({ label, value, missing = false }: { label: string; value: number; missing?: boolean }) {
  return (
    <td className="whitespace-nowrap px-2 py-1.5 text-right">
      <span className={clsx('text-xs tabular-nums', missing ? 'text-ink-soft/70' : 'text-ink')}>
        {fmtNum(value)}
      </span>
      {missing && (
        <span
          title={`${label}口径缺输入，数值按已登记部分计，不可作对账依据`}
          aria-label={`${label}口径缺输入，数值按已登记部分计，不可作对账依据`}
          className="ml-1 rounded border border-line bg-surface/60 px-1 py-px text-[9px] text-ink-soft"
        >
          缺
        </span>
      )}
    </td>
  );
}

/** 「口径提示」角标：hover / 键盘聚焦展开 missingInputs 原因清单（纯 CSS，无 JS 定位）。 */
function CaliberBadge({ reasons }: { reasons: string[] }) {
  return (
    <div className="group/hint relative shrink-0">
      <button
        type="button"
        aria-label={`口径提示：${reasons.join('；')}`}
        className="flex items-center gap-1 rounded border border-warning/30 bg-warning/10 px-1.5 py-0.5 text-[10px] text-warning transition-colors hover:bg-warning/20"
      >
        <AlertCircle className="h-3 w-3" aria-hidden />
        口径提示
      </button>
      <div className="pointer-events-none absolute right-0 top-full z-sticky mt-1 hidden w-72 rounded-md border border-line bg-white px-3 py-2.5 text-left shadow-pop group-hover/hint:block group-focus-within/hint:block">
        <div className="text-xs font-medium text-ink">口径提示</div>
        <ul className="mt-1 space-y-0.5">
          {reasons.map((r) => (
            <li key={r} className="break-all text-xs leading-5 text-ink-soft">{r}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** tile 值为 null 时的原因汇集：同组内对应口径为 null 的行的 missingInputs 取并集
 *  （如 recv tile(⑤) 为 null 时，原因来自应收组里 amt 为 null 的行）。 */
function tileNullReasons(report: GapsReportDTO, tileKey: string): string[] {
  const group = report.groups.find((g) => g.key === tileKey);
  if (!group) return [];
  const reasons = new Set<string>();
  for (const item of group.items) {
    if (item.qty == null && item.amt == null) {
      for (const r of item.missingInputs ?? []) reasons.add(r);
    }
  }
  return [...reasons];
}
