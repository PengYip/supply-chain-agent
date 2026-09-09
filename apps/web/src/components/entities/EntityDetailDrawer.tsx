import { useCallback, useEffect, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { getEntityDetail, type EntityDetailResult } from '../../api/ontology';

interface Props {
  type: string;
  typeLabel: string;
  /** 注册表实体说明（详情抽屉头部说明行；schema 端点透出）。 */
  typeDescription?: string;
  ownFields: string[];
  entityId: string;
  onClose: () => void;
  /** 「在图中查看」回调(Item 4 穿透跳入)；入参为展示名(抽屉自己持有 detail 数据)。 */
  onViewInGraph?: (label: string) => void;
}

/** 实体详情：字段表 + as-of 时间线(红冲负数红标) + 净额轧差。仅事件实体有时间线。 */
export function EntityDetailDrawer({ type, typeLabel, typeDescription, ownFields, entityId, onClose, onViewInGraph }: Props) {
  // asOf 语义(技术备忘 §4)：最新口径=business@now；当时口径=system@<日期>(月报复现)。
  const [mode, setMode] = useState<'business' | 'system'>('business');
  const [at, setAt] = useState('');
  const [detail, setDetail] = useState<EntityDetailResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 过期响应守卫: 快速切换实体/口径时, 慢的旧响应不得覆盖新数据。
  const seqRef = useRef(0);

  const load = useCallback(async () => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await getEntityDetail(type, entityId,
        mode === 'system' ? { asOf: 'system', at: at || new Date().toISOString() } : {});
      if (seq !== seqRef.current) return;
      setDetail(res);
    } catch (e) {
      if (seq !== seqRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [type, entityId, mode, at]);

  useEffect(() => { void load(); }, [load]);

  const hasTimeline = detail != null && detail.timeline.length > 0;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" role="dialog" aria-modal="true">
      <div className="h-full w-[520px] max-w-[90vw] overflow-y-auto bg-white shadow-lg">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <div>
            <div className="text-sm font-medium text-ink">{typeLabel}详情</div>
            <div className="mt-0.5 text-xs text-ink-soft">{detail?.entity.label ?? entityId}</div>
            {typeDescription && (
              <div className="mt-0.5 max-w-[380px] text-xs leading-5 text-ink-soft/80">{typeDescription}</div>
            )}
          </div>
          {onViewInGraph && (
            <button
              type="button"
              onClick={() => onViewInGraph(detail?.entity.label ?? entityId)}
              className="rounded border border-line px-2 py-1 text-xs text-ink-soft transition-colors hover:border-primary/40 hover:text-primary"
            >
              在图中查看
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="rounded p-1 text-ink-soft transition-colors hover:bg-surface hover:text-ink"
          >
            关闭
          </button>
        </div>

        {/* as-of 切换 */}
        <div className="flex items-center gap-2 border-b border-line px-4 py-2">
          <div className="flex rounded border border-line text-xs">
            <button
              type="button"
              onClick={() => setMode('business')}
              className={clsx('px-2 py-1', mode === 'business' ? 'bg-surface font-medium text-ink' : 'text-ink-soft')}
            >
              最新口径
            </button>
            <button
              type="button"
              onClick={() => setMode('system')}
              className={clsx('px-2 py-1', mode === 'system' ? 'bg-surface font-medium text-ink' : 'text-ink-soft')}
            >
              当时口径
            </button>
          </div>
          {mode === 'system' && (
            <input
              type="date"
              value={at ? at.slice(0, 10) : ''}
              onChange={(e) => setAt(e.target.value ? `${e.target.value}T23:59:59.000Z` : '')}
              className="h-7 rounded border border-line px-2 text-xs text-ink"
              aria-label="时间点"
            />
          )}
          {loading && <span className="text-xs text-ink-soft">加载中...</span>}
          {error && <span className="text-xs text-danger">{error}</span>}
        </div>

        {/* 字段表 */}
        {detail && (
          <div className="border-b border-line px-4 py-3">
            <div className="mb-2 text-xs font-medium text-ink-soft">字段（注册表口径）</div>
            <table className="w-full text-sm">
              <tbody>
                {ownFields.map((f) => (
                  <tr key={f} className="border-b border-line/40 last:border-b-0">
                    <td className="w-32 py-1.5 text-xs text-ink-soft">{f}</td>
                    <td className="py-1.5 tabular-nums text-ink">
                      {detail.entity.fields[f] == null || detail.entity.fields[f] === ''
                        ? '—'
                        : String(detail.entity.fields[f])}
                    </td>
                  </tr>
                ))}
                <tr className="border-t border-line/40">
                  <td className="py-1.5 text-xs text-ink-soft">ingestedAt</td>
                  <td className="py-1.5 text-xs text-ink-soft">{detail.entity.ingestedAt ?? '—'}</td>
                </tr>
                {detail.entity.meta?.documentId && (
                  <tr className="border-t border-line/40">
                    <td className="py-1.5 text-xs text-ink-soft">来源单据</td>
                    <td className="py-1.5 text-xs text-ink">{detail.entity.meta.documentId}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {/* 时间线 + 净额 */}
        {detail && (
          <div className="px-4 py-3">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-xs font-medium text-ink-soft">时间线（as-of 切片，红冲负数红标）</div>
              {/* 数量-only 行（收/发货金额后置结算）无净额：显示 — 而非 0/NaN */}
              {hasTimeline && (
                <div className="text-sm">
                  净额：
                  <span className={clsx('font-medium tabular-nums', detail.netAmount != null && detail.netAmount < 0 ? 'text-danger' : 'text-ink')}>
                    {detail.netAmount != null ? detail.netAmount.toLocaleString() : '—'}
                  </span>
                </div>
              )}
            </div>
            {hasTimeline ? (
              <div className="space-y-1">
                {detail.timeline.map((row) => {
                  const amount = row.fields['amount'];
                  const negative = typeof amount === 'number' && amount < 0;
                  const reverse = row.fields['eventBizType'] === '逆向';
                  return (
                    <div
                      key={row.id}
                      className={clsx(
                        'flex items-center gap-2 rounded border px-2 py-1.5 text-sm',
                        negative || reverse
                          ? 'border-danger/30 bg-danger/5'
                          : 'border-line bg-white',
                      )}
                    >
                      <span className={clsx('font-medium', negative ? 'text-danger' : 'text-ink')}>{row.label}</span>
                      {reverse && (
                        <span className="rounded border border-danger/30 bg-danger/10 px-1 text-xs text-danger">逆向</span>
                      )}
                      {typeof amount === 'number' ? (
                        <span className={clsx('ml-auto tabular-nums', negative ? 'text-danger' : 'text-ink')}>
                          {amount.toLocaleString()}
                        </span>
                      ) : (
                        <span className="ml-auto tabular-nums text-ink-soft">—</span>
                      )}
                      <span className="text-xs text-ink-soft">{row.validAt?.slice(0, 10) ?? ''}</span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="rounded border border-line bg-surface/40 px-3 py-4 text-center text-xs text-ink-soft">
                仅事件实体（本体事实源）支持时间切片；合同 / 单据投影无双时间轴。
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}