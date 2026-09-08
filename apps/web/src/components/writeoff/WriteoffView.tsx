import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowLeftRight, CheckCircle2, RefreshCw } from 'lucide-react';
import {
  fetchWriteoffOverview, submitWriteoff,
  type WriteoffBalanceRow, type WriteoffMode, type SubmitResult,
} from '../../api/writeoff';

/** 模式短名（从 relation 名派生；新增同类关系走 fallback = relation 本名，零改动验收）。 */
function modeShortLabel(mode: WriteoffMode): string {
  if (mode.relation === 'WRITE_OFF') return '票款核销';
  if (mode.relation === 'OFFSET_SETTLE') return '预付冲抵';
  return mode.relation;
}

function targetColumnLabel(mode: WriteoffMode): string {
  return mode.dstTypes.includes('SettlementEvent') ? '待冲抵结算' : '待核销发票';
}

const STATUS_BADGE: Record<WriteoffBalanceRow['status'], { text: string; cls: string }> = {
  none: { text: '未核', cls: 'bg-gray-100 text-gray-500' },
  partial: { text: '部分核', cls: 'bg-amber-100 text-amber-700' },
  full: { text: '已核完', cls: 'bg-emerald-100 text-emerald-700' },
};

const fmt = (n: number) => n.toLocaleString('zh-CN', { maximumFractionDigits: 2 });

interface Cell { amount: string }

export function WriteoffView() {
  const [modes, setModes] = useState<WriteoffMode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [relation, setRelation] = useState<string | null>(null);
  const [selectedFunds, setSelectedFunds] = useState<Set<string>>(new Set());
  const [selectedTargets, setSelectedTargets] = useState<Set<string>>(new Set());
  const [cells, setCells] = useState<Record<string, Cell>>({});
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<SubmitResult | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const ov = await fetchWriteoffOverview();
      setModes(ov.modes);
      setRelation((prev) => prev && ov.modes.some((m) => m.relation === prev)
        ? prev : (ov.modes[0]?.relation ?? null));
      setSelectedFunds(new Set());
      setSelectedTargets(new Set());
      setCells({});
      // 不清 result: 提交成功后 refresh 会跑, 这里清掉会把"已提交"横幅立即抹掉。
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const mode = useMemo(() => modes.find((m) => m.relation === relation) ?? null, [modes, relation]);

  const toggle = (setter: React.Dispatch<React.SetStateAction<Set<string>>>, id: string) =>
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  const activeFunds = useMemo(
    () => mode?.funds.filter((f) => selectedFunds.has(f.id)) ?? [], [mode, selectedFunds]);
  const activeTargets = useMemo(
    () => mode?.targets.filter((t) => selectedTargets.has(t.id)) ?? [], [mode, selectedTargets]);

  const cellKey = (fundId: string, targetId: string) => `${fundId}::${targetId}`;
  const cellAmount = (fundId: string, targetId: string): number => {
    const raw = cells[cellKey(fundId, targetId)]?.amount?.trim();
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) ? n : 0;
  };

  // 前端守恒预检（镜像服务端规则）：行/列累计与正数性。
  const fundTotals = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of activeFunds) {
      m.set(f.id, activeTargets.reduce((s, t) => s + cellAmount(f.id, t.id), 0));
    }
    return m;
  }, [activeFunds, activeTargets, cells]);
  const targetTotals = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of activeTargets) {
      m.set(t.id, activeFunds.reduce((s, f) => s + cellAmount(f.id, t.id), 0));
    }
    return m;
  }, [activeFunds, activeTargets, cells]);

  const invalidCells = useMemo(() => {
    const bad = new Set<string>();
    for (const f of activeFunds) {
      for (const t of activeTargets) {
        const v = cellAmount(f.id, t.id);
        if (v < 0) bad.add(cellKey(f.id, t.id));
      }
    }
    return bad;
  }, [activeFunds, activeTargets, cells]);

  const fundOver = (f: WriteoffBalanceRow) => (fundTotals.get(f.id) ?? 0) > f.remaining + 0.005;
  const targetOver = (t: WriteoffBalanceRow) => (targetTotals.get(t.id) ?? 0) > t.remaining + 0.005;
  const hasAllocation = [...fundTotals.values()].some((v) => v > 0);
  const canSubmit = !!mode && hasAllocation
    && invalidCells.size === 0
    && !activeFunds.some(fundOver) && !activeTargets.some(targetOver)
    && !submitting;

  const onSubmit = async () => {
    if (!mode) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const items = activeFunds.flatMap((f) =>
        activeTargets
          .map((t) => ({ f, t, amount: cellAmount(f.id, t.id) }))
          .filter(({ amount }) => amount > 0)
          .map(({ t, amount }) => ({
            srcId: f.id, dstId: t.id, amount,
            partial: amount < f.remaining - 0.005 ? true : undefined,
            batch: items0Batch(mode.relation),
          })));
      const res = await submitWriteoff(mode.relation, items);
      setResult(res);
      void refresh();
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  if (loading && modes.length === 0) {
    return <div className="p-6 text-sm text-gray-500">加载核销工作台数据...</div>;
  }
  if (error) {
    return (
      <div className="p-6">
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>
        <button className="mt-3 rounded-md border px-3 py-1.5 text-sm" onClick={() => void refresh()}>
          重试
        </button>
      </div>
    );
  }
  if (modes.length === 0) {
    return <div className="p-6 text-sm text-gray-500">本体注册表中暂无核销类关系（params 含 amount 且资金侧发起）。</div>;
  }

  return (
    <div className="flex h-full flex-col p-6">
      <div className="mb-4 flex items-center gap-3">
        <ArrowLeftRight className="h-5 w-5 text-gray-400" />
        <h1 className="text-base font-semibold">核销工作台</h1>
        <div className="ml-auto flex items-center gap-2">
          <a className="text-xs text-blue-600 hover:underline" href="#/approvals">前往审批中心</a>
          <button className="rounded-md border px-2 py-1 text-xs text-gray-600 hover:bg-gray-50" onClick={() => void refresh()}>
            <RefreshCw className="mr-1 inline h-3 w-3" />刷新
          </button>
        </div>
      </div>

      {modes.length > 1 && (
        <div className="mb-4 flex gap-2">
          {modes.map((m) => (
            <button
              key={m.relation}
              className={`rounded-md border px-3 py-1.5 text-sm ${m.relation === relation ? 'border-blue-500 bg-blue-50 text-blue-700' : 'text-gray-600 hover:bg-gray-50'}`}
              onClick={() => { setRelation(m.relation); setSelectedFunds(new Set()); setSelectedTargets(new Set()); setCells({}); setResult(null); }}
            >
              {modeShortLabel(m)}
            </button>
          ))}
        </div>
      )}

      {result && (
        <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
          <div className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4" />已提交，等待审批中心批准后落边。</div>
          <div className="mt-1 flex gap-3 text-xs">
            <a className="text-blue-600 hover:underline" href="#/approvals">前往审批</a>
            <a className="text-blue-600 hover:underline" href={`#/chat?session=${result.sessionId}`}>查看会话</a>
          </div>
        </div>
      )}
      {submitError && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{submitError}
        </div>
      )}

      {mode && (
        <div className="grid min-h-0 flex-1 grid-cols-2 gap-4">
          <section className="rounded-lg border">
            <header className="border-b px-3 py-2 text-sm font-medium">待核销资金（{mode.srcTypes.length} 类）</header>
            <ul className="max-h-64 overflow-auto p-2 text-sm">
              {mode.funds.map((f) => (
                <li key={f.id} className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-gray-50">
                  <input
                    type="checkbox"
                    disabled={f.status === 'full'}
                    checked={selectedFunds.has(f.id)}
                    onChange={() => toggle(setSelectedFunds, f.id)}
                  />
                  <span className="min-w-0 flex-1 truncate" title={f.id}>{f.label}</span>
                  <span className={`rounded px-1.5 py-0.5 text-xs ${STATUS_BADGE[f.status].cls}`}>{STATUS_BADGE[f.status].text}</span>
                  <span className="tabular-nums text-gray-700">余 {fmt(f.remaining)}</span>
                  <a className="text-xs text-blue-600 hover:underline"
                     href={`#/chat?session=new&ask=${encodeURIComponent(`请分析资金流水 ${f.label}（${f.id}）的核销情况`)}`}>问 Agent</a>
                </li>
              ))}
              {mode.funds.length === 0 && <li className="px-2 py-4 text-gray-400">暂无待核销资金（待本体基座灌数）</li>}
            </ul>
          </section>
          <section className="rounded-lg border">
            <header className="border-b px-3 py-2 text-sm font-medium">{targetColumnLabel(mode)}</header>
            <ul className="max-h-64 overflow-auto p-2 text-sm">
              {mode.targets.map((t) => (
                <li key={t.id} className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-gray-50">
                  <input
                    type="checkbox"
                    disabled={t.status === 'full'}
                    checked={selectedTargets.has(t.id)}
                    onChange={() => toggle(setSelectedTargets, t.id)}
                  />
                  <span className="min-w-0 flex-1 truncate" title={t.id}>{t.label}</span>
                  <span className={`rounded px-1.5 py-0.5 text-xs ${STATUS_BADGE[t.status].cls}`}>{STATUS_BADGE[t.status].text}</span>
                  <span className="tabular-nums text-gray-700">余 {fmt(t.remaining)}</span>
                  <a className="text-xs text-blue-600 hover:underline"
                     href={`#/chat?session=new&ask=${encodeURIComponent(`请分析 ${t.label}（${t.id}）的核销/冲抵情况`)}`}>问 Agent</a>
                </li>
              ))}
              {mode.targets.length === 0 && <li className="px-2 py-4 text-gray-400">暂无待核销目标（待本体基座灌数）</li>}
            </ul>
          </section>
        </div>
      )}

      {mode && activeFunds.length > 0 && activeTargets.length > 0 && (
        <section className="mt-4 rounded-lg border">
          <header className="border-b px-3 py-2 text-sm font-medium">金额分配（每格 ≤ 两端余额；行/列合计守恒）</header>
          <div className="overflow-auto p-2">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th className="px-2 py-1 text-left font-medium text-gray-500">资金 \ 目标</th>
                  {activeTargets.map((t) => (
                    <th key={t.id} className="px-2 py-1 text-right font-medium text-gray-600">
                      {t.label}
                      <span className={`ml-1 text-xs ${targetOver(t) ? 'text-red-600' : 'text-gray-400'}`}>
                        (余 {fmt(t.remaining)})
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {activeFunds.map((f) => (
                  <tr key={f.id}>
                    <td className="px-2 py-1 text-gray-700">
                      {f.label}
                      <span className={`ml-1 text-xs ${fundOver(f) ? 'text-red-600' : 'text-gray-400'}`}>(余 {fmt(f.remaining)})</span>
                    </td>
                    {activeTargets.map((t) => {
                      const key = cellKey(f.id, t.id);
                      const bad = invalidCells.has(key);
                      return (
                        <td key={key} className="px-1 py-1">
                          <input
                            inputMode="decimal"
                            className={`w-24 rounded border px-2 py-1 text-right tabular-nums ${bad ? 'border-red-400' : 'border-gray-300'}`}
                            placeholder="0"
                            value={cells[key]?.amount ?? ''}
                            onChange={(e) => setCells((prev) => ({ ...prev, [key]: { amount: e.target.value } }))}
                          />
                        </td>
                      );
                    })}
                    <td className={`px-2 py-1 text-right text-xs tabular-nums ${fundOver(f) ? 'text-red-600 font-medium' : 'text-gray-500'}`}>
                      Σ {fmt(fundTotals.get(f.id) ?? 0)} / {fmt(f.remaining)}
                    </td>
                  </tr>
                ))}
                <tr>
                  <td className="px-2 py-1 text-xs text-gray-500">列合计 / 目标余额</td>
                  {activeTargets.map((t) => (
                    <td key={t.id} className={`px-2 py-1 text-right text-xs tabular-nums ${targetOver(t) ? 'text-red-600 font-medium' : 'text-gray-500'}`}>
                      {fmt(targetTotals.get(t.id) ?? 0)} / {fmt(t.remaining)}
                    </td>
                  ))}
                  <td />
                </tr>
              </tbody>
            </table>
          </div>
          <footer className="flex items-center gap-3 border-t px-3 py-2">
            <button
              className="rounded-md bg-blue-600 px-4 py-1.5 text-sm text-white disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!canSubmit}
              onClick={() => void onSubmit()}
            >
              {submitting ? '提交中...' : '提交审批'}
            </button>
            <span className="text-xs text-gray-500">
              提交后将生成 L2 审批单，批准后落核销边；拒绝则不产生任何边。
            </span>
          </footer>
        </section>
      )}
    </div>
  );
}

/** v1 批次号：关系缩写 + 日期（用户可后续在工作台扩展编辑，OUT of v1）。 */
function items0Batch(relation: string): string {
  return `${relation === 'WRITE_OFF' ? 'WO' : 'OS'}-${new Date().toISOString().slice(0, 10)}`;
}