// apps/web/src/components/overview/OverviewView.tsx
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { fetchOverview, type CardResult, type OverviewPayloadDTO } from '../../api/overview';
import { fetchGaps, type GapsReportDTO } from '../../api/ontology';
import { useHashRoute } from '../../hooks/useHashRoute';
import { TASK_CARDS, jumpTargetForCard, formatRate, formatAmount, type OverviewCardKey } from './overviewModel';

/** 总览工作台（roadmap Item 7）：待办与异常优先的登录门户。每卡片独立
 *  loading/error/空态；卡片级错误切片由服务端产出（单数据源故障不拖垮整页）。
 *  菜单重构 2026-09-23 二期：顶部新增「开始一件事」任务卡（静态配置，回答
 *  「想干事去哪里干」）；异常区新增勾稽缺口卡（GET /api/ontology/gaps 的
 *  tiles 摘要，点击直达 #/gaps —— 勾稽提级后不再藏在本体第 3 个 tab）。 */
export function OverviewView() {
  const [payload, setPayload] = useState<OverviewPayloadDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 勾稽缺口卡数据：独立拉取，静默失败（异常卡是增强信息，失败显示弱化态）。
  const [gapsReport, setGapsReport] = useState<GapsReportDTO | null>(null);
  const { navigate } = useHashRoute();

  useEffect(() => {
    let alive = true;
    fetchOverview()
      .then((p) => { if (alive) setPayload(p); })
      .catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    fetchGaps()
      .then((r) => { if (alive) setGapsReport(r); })
      .catch(() => { /* 勾稽卡失败静默降级为「暂不可用」 */ });
    return () => { alive = false; };
  }, []);

  if (error) {
    return <div className="p-6"><div className="rounded-lg border border-line bg-white p-4 text-sm text-danger">{error}</div></div>;
  }
  if (!payload) {
    return <div className="p-6 text-sm text-ink-soft">加载中...</div>;
  }
  if (payload.cards == null) {
    // METRICS_SOURCE=cube 预留位降级（路线图 OUT：Cube 实际接入不做）
    return (
      <div className="p-6">
        <div className="rounded-lg border border-dashed border-line bg-white p-6 text-sm text-ink-soft">
          {payload.note ?? '指标数据源未接入'}
        </div>
      </div>
    );
  }

  const jump = (card: OverviewCardKey) => {
    const target = jumpTargetForCard(card);
    navigate(target.view, target.params);
  };

  return (
    <div className="space-y-6 overflow-y-auto p-6">
      <div className="flex items-center gap-3 text-xs text-ink-soft">
        <span>数据口径：{payload.source === 'local' ? '本地聚合（台账 / 边表 / 审批表）' : 'Cube（预留位）'}</span>
        <span>as-of {new Date(payload.asOf).toLocaleString('zh-CN', { hour12: false })}</span>
      </div>

      <section className="space-y-2">
        <h3 className="text-sm font-medium text-ink">开始一件事</h3>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
          {TASK_CARDS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => navigate(t.target.view, t.target.params)}
              className="flex flex-col rounded-lg border border-line bg-white p-4 text-left transition-colors hover:border-primary/40"
            >
              <t.icon className="h-5 w-5 shrink-0 text-primary" aria-hidden />
              <div className="mt-2 text-sm font-medium text-ink">{t.title}</div>
              <div className="mt-1 text-xs leading-4 text-ink-soft">{t.desc}</div>
            </button>
          ))}
        </div>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-medium text-ink">待办</h3>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
          <Card cardKey="pendingApprovals" result={payload.cards.pendingApprovals}
            title="待审批" onJump={jump}
            render={(d) => <ValueMain main={String(d.count)} unit="条待处理审批" />} />
        </div>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-medium text-ink">异常</h3>
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <Card cardKey="overReceipt" result={payload.cards.overReceipt} title="超合同量收货" onJump={jump}
            render={(d) => d.anomalies.length === 0
              ? <Empty text="无超量收货" />
              : <ul className="space-y-1 text-xs">
                  {d.anomalies.map((a) => (
                    <li key={a.contractId} className="flex items-center justify-between gap-2 rounded bg-surface/60 px-2 py-1">
                      <span className="font-mono text-ink">{a.contractNo}</span>
                      <span className="text-danger">收 {formatAmount(a.receivedQty)} / 合同 {formatAmount(a.contractQty)}</span>
                    </li>
                  ))}
                </ul>} />
          <Card cardKey="paymentBlocks" result={payload.cards.paymentBlocks} title="无票付款拦截" onJump={jump}
            render={(d) => d.records.length === 0
              ? <Empty text="无拦截记录" />
              : <ul className="space-y-1 text-xs">
                  {d.records.slice(0, 5).map((r) => (
                    <li key={r.id} className="truncate rounded bg-surface/60 px-2 py-1">
                      <span className="font-mono text-ink">{r.ticketId ?? r.id}</span>
                      <span className="ml-2 text-ink-soft">{r.reason ?? ''}</span>
                    </li>
                  ))}
                  {d.records.length > 5 && <li className="text-ink-soft">...共 {d.records.length} 条</li>}
                </ul>} />
          {/* 勾稽缺口卡：与 GapsPanel 的 tiles 同源同格式（qty=吨 / amt=元 / 待登记），
              点击直达顶层勾稽视图。独立数据源，失败显示弱化态不拖垮其他卡。 */}
          <button type="button" onClick={() => navigate('gaps')}
            className="rounded-lg border border-line bg-white p-4 text-left transition-colors hover:border-primary/40">
            <div className="text-xs text-ink-soft">勾稽缺口</div>
            <div className="mt-2 min-h-10">
              {gapsReport == null ? (
                <Empty text="勾稽数据暂不可用" />
              ) : (
                <ul className="space-y-1 text-xs">
                  {gapsReport.tiles.map((tile) => (
                    <li key={tile.key} className="flex items-center justify-between gap-2 rounded bg-surface/60 px-2 py-1">
                      <span className="text-ink-soft">{tile.label}</span>
                      <span className="font-mono text-ink">
                        {tile.qty != null
                          ? `${formatAmount(tile.qty)} 吨`
                          : tile.amt != null
                            ? `${formatAmount(tile.amt)} 元`
                            : '待登记'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="mt-1 text-xs text-ink-soft/60">点击查看 -&gt;</div>
          </button>
        </div>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-medium text-ink">指标</h3>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Card cardKey="executionRate" result={payload.cards.executionRate} title="合同执行率" onJump={jump}
            render={(d) => <ValueMain main={formatRate(d.rate)} unit={`${d.executed} / ${d.total} 台账合同已有履约边`} />} />
          <Card cardKey="pendingWriteoff" result={payload.cards.pendingWriteoff} title="待核销金额" onJump={jump}
            render={(d) => <ValueMain main={formatAmount(d.amount)} unit={`${d.rows} 笔资金待核销`} />} />
        </div>
      </section>

      <p className="rounded border border-dashed border-line bg-white/60 px-3 py-2 text-xs text-ink-soft">
        数据出处：合同执行率 / 超量收货 &lt;- contract_ledger + ontology_edges（ALLOCATE_TO）+ trade_facts；
        待核销金额 &lt;- 核销余额聚合（ontology/writeoff.ts）；待审批 / 无票付款拦截 &lt;- pending_approvals 审批表；
        勾稽缺口 &lt;- GET /api/ontology/gaps（trade_facts + ontology_edges 现行口径）。
        经 GET /api/overview，METRICS_SOURCE={payload.source}。
      </p>
    </div>
  );
}

function Card<T>({ cardKey, result, title, render, onJump }: {
  cardKey: OverviewCardKey;
  result: CardResult<T>;
  title: string;
  render: (data: T) => ReactNode;
  onJump: (card: OverviewCardKey) => void;
}) {
  return (
    <button type="button" onClick={() => onJump(cardKey)}
      className="rounded-lg border border-line bg-white p-4 text-left transition-colors hover:border-primary/40">
      <div className="text-xs text-ink-soft">{title}</div>
      <div className="mt-2 min-h-10">
        {result.status === 'error'
          ? <span className="text-xs text-danger">{result.error}</span>
          : render(result.data)}
      </div>
      <div className="mt-1 text-xs text-ink-soft/60">点击查看 -&gt;</div>
    </button>
  );
}

function ValueMain({ main, unit }: { main: string; unit: string }) {
  return (
    <div>
      <div className="text-2xl font-semibold tabular-nums text-ink">{main}</div>
      <div className="mt-0.5 text-xs text-ink-soft">{unit}</div>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="text-xs text-ink-soft">{text}</div>;
}
