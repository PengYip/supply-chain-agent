// apps/web/src/components/governance/ApprovalAuditTab.tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchApprovalAudit, type ApprovalAuditItemDTO } from '../../api/governance';
import { Section, Provenance } from './OntologyTab';

const STATUS_OPTIONS = ['all', 'pending', 'approved', 'denied'] as const;

const fmt = (iso: string) => new Date(iso).toLocaleString('zh-CN', { hour12: false });

/** datetime-local 原始值(本地时区, 无时区后缀) -> ISO; 空串/非法值返回 undefined。
 *  控件的 value 必须存原始值: ISO 的 Z 后缀不符合 datetime-local 格式, 浏览器
 *  会把输入框清洗成空显示。 */
const toIsoOrUndefined = (v: string): string | undefined => {
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
};

/** 治理 Tab 4 审批审计：pending_approvals 经 GET /api/approval/list 的
 *  时间/决策人/工具/状态过滤视图（只读，不做审批决策——决策在审批中心）。 */
export function ApprovalAuditTab() {
  const [status, setStatus] = useState<string>('all');
  const [toolName, setToolName] = useState('');
  const [decidedBy, setDecidedBy] = useState('');
  const [createdFrom, setCreatedFrom] = useState('');
  const [createdTo, setCreatedTo] = useState('');
  const [items, setItems] = useState<ApprovalAuditItemDTO[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 过期响应守卫: 文本过滤每键触发 load, 先发后至的旧响应不得覆盖新结果。
  const seqRef = useRef(0);

  const load = useCallback(async () => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await fetchApprovalAudit({
        status,
        toolName: toolName.trim() || undefined,
        decidedBy: decidedBy.trim() || undefined,
        createdFrom: toIsoOrUndefined(createdFrom),
        createdTo: toIsoOrUndefined(createdTo),
        limit: 200,
      });
      if (seq !== seqRef.current) return; // 已有更新的请求, 丢弃过期响应
      setItems(res.items);
    } catch (e) {
      if (seq !== seqRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [status, toolName, decidedBy, createdFrom, createdTo]);

  useEffect(() => {
    // 文本输入每键一次请求太密, 400ms 防抖合并连续键入。
    const t = setTimeout(() => { void load(); }, 400);
    return () => clearTimeout(t);
  }, [load]);

  const inputCls = 'h-8 rounded border border-line bg-white px-2 text-sm text-ink placeholder:text-ink-soft/60 focus:outline-none focus:ring-1 focus:ring-primary/40';

  return (
    <div className="max-w-6xl space-y-4 pb-2">
      <div className="flex flex-wrap items-center gap-2">
        <select value={status} onChange={(e) => setStatus(e.target.value)}
          className={inputCls + ' text-xs'}>
          {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <input value={toolName} onChange={(e) => setToolName(e.target.value)}
          placeholder="工具名（精确）" className={inputCls + ' w-44 text-xs'} />
        <input value={decidedBy} onChange={(e) => setDecidedBy(e.target.value)}
          placeholder="决策人" className={inputCls + ' w-36 text-xs'} />
        <label className="text-xs text-ink-soft">从
          <input type="datetime-local" value={createdFrom}
            onChange={(e) => setCreatedFrom(e.target.value)}
            className={inputCls + ' ml-1 text-xs'} />
        </label>
        <label className="text-xs text-ink-soft">到
          <input type="datetime-local" value={createdTo}
            onChange={(e) => setCreatedTo(e.target.value)}
            className={inputCls + ' ml-1 text-xs'} />
        </label>
        {loading && <span className="text-xs text-ink-soft">加载中...</span>}
        {error && <span className="text-xs text-danger">{error}</span>}
        <span className="ml-auto text-xs text-ink-soft">共 {items.length} 条</span>
      </div>

      <Section title="审批流水">
        <div className="overflow-x-auto rounded-lg border border-line bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-ink-soft">
                <th className="px-3 py-2 font-medium">层级</th>
                <th className="px-3 py-2 font-medium">工具</th>
                <th className="px-3 py-2 font-medium">状态</th>
                <th className="px-3 py-2 font-medium">创建时间</th>
                <th className="px-3 py-2 font-medium">决策人</th>
                <th className="px-3 py-2 font-medium">决策时间</th>
                <th className="px-3 py-2 font-medium">理由</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.id} className="border-b border-line/60 last:border-b-0">
                  <td className="px-3 py-2">
                    <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${it.level === 'L3' ? 'bg-danger/10 text-danger' : 'bg-amber-100 text-amber-700'}`}>
                      {it.level}
                    </span>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-ink">{it.tool_name}</td>
                  <td className="px-3 py-2 text-xs text-ink">{it.status}</td>
                  <td className="px-3 py-2 text-xs text-ink-soft">{fmt(it.created_at)}</td>
                  <td className="px-3 py-2 text-xs text-ink-soft">{it.decided_by ?? '-'}</td>
                  <td className="px-3 py-2 text-xs text-ink-soft">{it.decided_at ? fmt(it.decided_at) : '-'}</td>
                  <td className="max-w-52 truncate px-3 py-2 text-xs text-ink-soft">{it.reason ?? '-'}</td>
                </tr>
              ))}
              {!loading && items.length === 0 && (
                <tr><td colSpan={7} className="px-3 py-8 text-center text-sm text-ink-soft">无匹配票据</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Section>

      <Provenance text="数据出处：pending_approvals 审批表（sessionStore 双后端 SSOT，经 GET /api/approval/list；审批决策操作在审批中心进行，本视图只读）" />
    </div>
  );
}
