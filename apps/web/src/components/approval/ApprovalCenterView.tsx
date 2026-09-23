import { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import { ApprovalDetailDrawer } from './ApprovalDetailDrawer';
import { useHashRoute } from '../../hooks/useHashRoute';
import { PageHeader } from '../shell/PageHeader';
import { setApprovalPendingCount } from '../../lib/approvalPending';

type Tab = 'pending' | 'approved' | 'denied';
interface ApprovalItem {
  id: string; session_id: string; level: 'L2' | 'L3'; tool_name: string;
  status: string; created_at: string; decided_by?: string | null;
  decided_at?: string | null; reason?: string | null;
  sideEffects: Array<{ action: string; ok: boolean; detail: string; at: string }> | null;
}

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'pending', label: '待处理' },
  { id: 'approved', label: '已批准' },
  { id: 'denied', label: '已拒绝' },
];

const fmt = (iso: string) => new Date(iso).toLocaleString('zh-CN', { hour12: false });

/** 审批中心（菜单重构 2026-09-23）：tab 落 hash 参数（#/approvals?tab=approved，
 *  与 projects/ontology 的深链口径统一，replace 切换不灌爆历史）；加载 pending
 *  tab 时把 total 回写审批待办角标 store，处理完即时刷新侧边栏角标。 */
export function ApprovalCenterView() {
  const { route, navigate } = useHashRoute();
  const tab: Tab = TABS.some((t) => t.id === route.params['tab'])
    ? (route.params['tab'] as Tab)
    : 'pending';
  const setTab = (t: Tab) =>
    navigate('approvals', t === 'pending' ? {} : { tab: t }, { replace: true });
  const [items, setItems] = useState<ApprovalItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/approval/list?status=${tab}&limit=100`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { items?: ApprovalItem[]; total?: number };
      setItems(data.items ?? []);
      if (tab === 'pending') {
        setApprovalPendingCount(
          typeof data.total === 'number' ? data.total : (data.items?.length ?? 0),
        );
      }
      setError(null);
    } catch (e) {
      // 轮询场景下静默失败会让用户对着过期列表毫无察觉, 必须显式提示。
      setError(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  }, [tab]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const t = setInterval(() => { void load(); }, 10_000); // v1 轮询，spec §9
    return () => clearInterval(t);
  }, [load]);

  return (
    <div className="flex h-full flex-col bg-surface">
      <PageHeader
        tabs={
          <div className="flex items-center gap-1 rounded-lg bg-surface p-0.5">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={clsx(
                  'rounded-md px-3 py-1 text-xs transition-colors',
                  tab === t.id ? 'bg-white font-medium text-primary shadow-sm' : 'text-ink-soft hover:text-ink',
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
        }
        actions={
          <>
            {loading && <span className="text-xs text-ink-soft">刷新中...</span>}
            {error && <span className="text-xs text-danger">刷新失败: {error}</span>}
          </>
        }
      />
      <div className="flex-1 overflow-y-auto p-6">
        {items.length === 0 && <p className="py-10 text-center text-sm text-ink-soft">暂无票据</p>}
        {items.map((it) => (
          <button key={it.id} onClick={() => setSelectedId(it.id)}
            className="mb-2 flex w-full items-center justify-between rounded-lg border border-line bg-white px-4 py-3 text-left hover:border-primary-400">
            <div className="flex items-center gap-3">
              <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${it.level === 'L3' ? 'bg-danger/10 text-danger' : 'bg-amber-100 text-amber-700'}`}>
                {it.level}
              </span>
              <span className="text-sm font-medium">{it.tool_name}</span>
              {it.status !== 'pending' && it.reason && (
                <span className="max-w-52 truncate text-xs text-ink-soft">理由: {it.reason}</span>
              )}
            </div>
            <span className="text-xs text-ink-soft">{fmt(it.created_at)}</span>
          </button>
        ))}
      </div>

      {selectedId && (
        <ApprovalDetailDrawer id={selectedId}
          onClose={() => setSelectedId(null)}
          onDecided={() => { setSelectedId(null); void load(); }} />
      )}
    </div>
  );
}
