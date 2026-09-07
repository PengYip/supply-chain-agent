import { useCallback, useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { useHashRoute } from '../../hooks/useHashRoute';
import { fetchOntologySchema, listEntities, type OntologyEntitySchemaDTO, type ProjectedEntity } from '../../api/ontology';
import { EntityDetailDrawer } from './EntityDetailDrawer';
import type { GraphFocusTarget } from '../graph/focus';

/** 实体台账(roadmap Item 3)：类型列表由注册表 schema 驱动，空源类型显示空态不报错。 */
const PAGE_SIZE = 20; // 模块级常量

export function EntitiesView({ onOpenInGraph }: { onOpenInGraph?: (t: GraphFocusTarget) => void }) {
  const [schema, setSchema] = useState<OntologyEntitySchemaDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchOntologySchema()
      .then((s) => { if (alive) setSchema(s.entities); })
      .catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, []);

  const active = schema?.find((e) => e.name === selected) ?? null;

  const { navigate } = useHashRoute();
  const [rows, setRows] = useState<ProjectedEntity[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!selected) return;
    setLoading(true);
    setListError(null);
    try {
      const res = await listEntities(selected, { page, pageSize: PAGE_SIZE, q: q.trim() || undefined });
      setRows(res.items);
      setTotal(res.total);
    } catch (e) {
      setListError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [selected, page, q]);

  useEffect(() => { setPage(1); }, [selected, q]);
  useEffect(() => { void load(); }, [load]);

  const askAgent = (row: ProjectedEntity) => {
    if (!active) return;
    const fieldSummary = Object.entries(row.fields)
      .filter(([, v]) => v != null && v !== '')
      .map(([k, v]) => `${k}=${String(v)}`)
      .join('，');
    const ask = fieldSummary
      ? `请帮我核对${active.label}「${row.label}」：${fieldSummary}`
      : `请帮我查看${active.label}「${row.label}」的相关信息`;
    navigate('chat', { session: 'new', ask });
  };

  return (
    <div className="flex h-full min-w-0 bg-surface/40">
      <aside className="h-full w-64 shrink-0 overflow-y-auto border-r border-line bg-white">
        <div className="px-4 pb-2 pt-4 text-xs font-medium text-ink-soft">实体类型（本体注册表）</div>
        {error && <div className="px-4 py-2 text-sm text-danger">{error}</div>}
        {!error && schema === null && <div className="px-4 py-2 text-sm text-ink-soft">加载中...</div>}
        {schema?.map((e) => (
          <button
            key={e.name}
            type="button"
            onClick={() => setSelected(e.name)}
            className={clsx(
              'block w-full px-4 py-2 text-left text-sm transition-colors',
              selected === e.name
                ? 'bg-surface font-medium text-ink'
                : 'text-ink-soft hover:bg-surface/60 hover:text-ink',
            )}
          >
            {e.label}
          </button>
        ))}
      </aside>
      <div className="min-w-0 flex-1 overflow-y-auto px-5 py-4">
        {active ? (
          <div className="max-w-5xl space-y-4">
            <div className="flex items-center gap-2">
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={`搜索${active.label}（标识 / 字段值）`}
                className="h-8 w-64 rounded border border-line bg-white px-2 text-sm text-ink placeholder:text-ink-soft/60 focus:outline-none focus:ring-1 focus:ring-primary/40"
              />
              {loading && <span className="text-xs text-ink-soft">加载中...</span>}
              {listError && <span className="text-xs text-danger">{listError}</span>}
              <span className="ml-auto text-xs text-ink-soft">共 {total} 条</span>
            </div>
            <div className="overflow-x-auto rounded-lg border border-line bg-white">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs text-ink-soft">
                    <th className="px-3 py-2 font-medium">标识</th>
                    {active.ownFields.map((f) => (
                      <th key={f} className="px-3 py-2 font-medium">{f}</th>
                    ))}
                    <th className="px-3 py-2 font-medium">来源</th>
                    <th className="px-3 py-2 font-medium" aria-label="操作" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const negative = typeof row.fields['amount'] === 'number' && (row.fields['amount'] as number) < 0;
                    return (
                      <tr key={row.id} onClick={() => setDetailId(row.id)} className={clsx('cursor-pointer border-b border-line/60 last:border-b-0 hover:bg-surface/40')}>
                        <td className="px-3 py-2 font-medium text-ink">{row.label}</td>
                        {active.ownFields.map((f) => {
                          const v = row.fields[f];
                          const isNegAmount = f === 'amount' && negative;
                          return (
                            <td key={f} className={clsx('px-3 py-2 tabular-nums', isNegAmount ? 'text-danger' : 'text-ink')}>
                              {v == null || v === '' ? '—' : String(v)}
                            </td>
                          );
                        })}
                        <td className="px-3 py-2 text-xs text-ink-soft">{row.source}</td>
                        <td className="px-3 py-2 text-right">
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); askAgent(row); }}
                            className="rounded border border-line px-2 py-0.5 text-xs text-ink-soft transition-colors hover:border-primary/40 hover:text-primary"
                          >
                            问 Agent
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                  {!loading && rows.length === 0 && (
                    <tr>
                      <td colSpan={active.ownFields.length + 3} className="px-3 py-8 text-center text-sm text-ink-soft">
                        待本体基座灌数（该类型暂无数据源）
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {/* 分页：照抄 AuditView 本地 Pagination 形态 */}
            <div className="flex items-center justify-end gap-2 text-sm">
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="rounded border border-line px-2 py-1 text-xs text-ink-soft disabled:opacity-40"
              >
                上一页
              </button>
              <span className="text-xs text-ink-soft">
                第 {page} / {Math.max(1, Math.ceil(total / PAGE_SIZE))} 页
              </span>
              <button
                type="button"
                disabled={page >= Math.ceil(total / PAGE_SIZE)}
                onClick={() => setPage((p) => p + 1)}
                className="rounded border border-line px-2 py-1 text-xs text-ink-soft disabled:opacity-40"
              >
                下一页
              </button>
            </div>
          </div>
        ) : (
          <div className="rounded-lg border border-line bg-white p-6 text-center text-sm text-ink-soft">
            从左侧选择实体类型
          </div>
        )}
      </div>
      {detailId && active && (
        <EntityDetailDrawer
          type={active.name}
          typeLabel={active.label}
          ownFields={active.ownFields}
          entityId={detailId}
          onClose={() => setDetailId(null)}
          onViewInGraph={
            onOpenInGraph && active
              ? (label) => onOpenInGraph({ entityType: active.name, entityId: detailId, label })
              : undefined
          }
        />
      )}
    </div>
  );
}
