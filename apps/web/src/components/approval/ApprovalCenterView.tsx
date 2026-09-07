import { useCallback, useEffect, useState } from 'react';
import { ApprovalDetailDrawer } from './ApprovalDetailDrawer';

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

export function ApprovalCenterView() {
  const [tab, setTab] = useState<Tab>('pending');
  const [items, setItems] = useState<ApprovalItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/approval/list?status=${tab}&limit=100`);
      if (res.ok) setItems((await res.json()).items ?? []);
    } finally { setLoading(false); }
  }, [tab]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const t = setInterval(() => { void load(); }, 10_000); // v1 轮询，spec §9
    return () => clearInterval(t);
  }, [load]);

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <div className="flex items-center gap-2">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`rounded-md px-3 py-1.5 text-sm ${tab === t.id ? 'bg-primary text-white' : 'bg-surface text-ink-soft hover:bg-line/30'}`}>
            {t.label}
          </button>
        ))}
        {loading && <span className="text-xs text-ink-soft">刷新中...</span>}
      </div>

      <div className="flex-1 overflow-y-auto">
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
