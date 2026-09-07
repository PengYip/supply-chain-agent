import { useEffect, useState } from 'react';

interface Detail {
  id: string; session_id: string; level: 'L2' | 'L3'; tool_name: string;
  status: string; created_at: string; decided_by?: string | null;
  decided_at?: string | null; reason?: string | null; input_json: string;
  ticket_id?: string | null; approval_id?: string | null;
  sideEffects: Array<{ target: string; action: string; ok: boolean; detail: string; at: string }> | null;
}

export function ApprovalDetailDrawer(props: { id: string; onClose(): void; onDecided(): void }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    const res = await fetch(`/api/approval/${props.id}`);
    if (!res.ok) {
      setError(`加载失败 (HTTP ${res.status})`);
      return;
    }
    const data = await res.json();
    // 200 但 body 缺 item 时不能 setDetail(undefined): 会让 !detail 恒真且
    // error 为空, 界面永久卡在"加载中"。
    if (data?.item) setDetail(data.item);
    else setError('加载失败: 响应缺少票据数据');
  };
  useEffect(() => {
    void load().catch((e) => setError(`加载失败: ${String(e)}`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.id]);

  const decide = async (approved: boolean) => {
    if (!detail) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch('/api/approval/callback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ticketId: detail.ticket_id ?? undefined,
          approvalId: detail.approval_id ?? undefined,
          approved, reason: reason || undefined,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      props.onDecided();
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };

  let payload: Array<[string, unknown]> = [];
  try { payload = Object.entries(JSON.parse(detail?.input_json ?? '{}')); }
  catch { payload = [['raw', detail?.input_json ?? '']]; }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={props.onClose}>
      <div className="h-full w-[480px] overflow-y-auto bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        {!detail ? (
          error ? (
            <p className="text-sm text-danger">加载失败: {error}</p>
          ) : (
            <p className="text-sm text-ink-soft">加载中...</p>
          )
        ) : (
          <>
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold">{detail.tool_name}</h2>
              <span className="text-xs text-ink-soft">{detail.level} · {detail.status}</span>
            </div>

            <h3 className="mb-1 text-sm font-medium text-ink-soft">参数</h3>
            <div className="mb-4 rounded-md bg-surface p-3">
              {payload.map(([k, v]) => (
                <div key={k} className="mb-1 text-sm">
                  <span className="text-ink-soft">{k}: </span>
                  <span className="break-all">{String(v).slice(0, 200)}</span>
                </div>
              ))}
            </div>

            {detail.status === 'pending' && (
              <>
                <h3 className="mb-1 text-sm font-medium text-ink-soft">理由（留痕）</h3>
                <textarea value={reason} onChange={(e) => setReason(e.target.value)}
                  rows={2} className="mb-3 w-full rounded-md border border-line p-2 text-sm"
                  placeholder="批准/拒绝理由，将写入审计" />
                <div className="mb-4 flex gap-2">
                  <button disabled={busy} onClick={() => decide(true)}
                    className="rounded-md bg-success px-4 py-1.5 text-sm text-white disabled:opacity-50">批准</button>
                  <button disabled={busy} onClick={() => decide(false)}
                    className="rounded-md bg-danger px-4 py-1.5 text-sm text-white disabled:opacity-50">拒绝</button>
                </div>
              </>
            )}

            {detail.status !== 'pending' && (
              <p className="mb-4 text-sm text-ink-soft">
                决策: {detail.status} · 决策人: {detail.decided_by ?? '-'} · 时间: {detail.decided_at ?? '-'} · 理由: {detail.reason ?? '-'}
              </p>
            )}

            <h3 className="mb-1 text-sm font-medium text-ink-soft">执行副作用</h3>
            {(!detail.sideEffects || detail.sideEffects.length === 0)
              ? <p className="mb-4 text-xs text-ink-soft">暂无（L3 或未执行）</p>
              : (
                <ul className="mb-4 space-y-1">
                  {detail.sideEffects.map((s, i) => (
                    <li key={i} className={`rounded px-2 py-1 text-xs ${s.ok ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger'}`}>
                      {s.action} · {s.ok ? '成功' : '失败'} · {s.detail.slice(0, 120)}
                    </li>
                  ))}
                </ul>
              )}

            {error && <p className="mb-2 text-sm text-danger">操作失败: {error}</p>}
            <a className="text-sm text-primary-500 underline" href={`#/chat?session=${detail.session_id}`}>
              打开相关会话
            </a>
          </>
        )}
      </div>
    </div>
  );
}
