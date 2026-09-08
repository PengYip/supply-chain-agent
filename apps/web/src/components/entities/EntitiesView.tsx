import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { useHashRoute } from '../../hooks/useHashRoute';
import {
  fetchMasterDataFormSchema, fetchOntologySchema, listEntities,
  type MasterDataTypeFormDTO, type OntologyEntitySchemaDTO, type ProjectedEntity,
} from '../../api/ontology';
import { EntityDetailDrawer } from './EntityDetailDrawer';
import { EventRegisterDrawer } from './EventRegisterDrawer';
import { MasterDataDrawer } from './MasterDataDrawer';
import type { GraphFocusTarget } from '../graph/focus';

/** 实体台账(roadmap Item 3)：类型列表由注册表 schema 驱动，空源类型显示空态不报错。 */
const PAGE_SIZE = 20; // 模块级常量

/** 事件实体基础过滤(2026-09-08)：业务时间范围 + 金额范围(仅注册表含 amount 字段与否决定显隐)。 */
const EMPTY_FILTERS = { validFrom: '', validTo: '', amountMin: '', amountMax: '' };

export function EntitiesView({ onOpenInGraph }: { onOpenInGraph?: (t: GraphFocusTarget) => void }) {
  const [schema, setSchema] = useState<OntologyEntitySchemaDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 路由参数预选(#/entities?type=X，治理全景图「在实体台账中查看」入口)；
  // 非注册表类型自然落到「从左侧选择实体类型」空态，无需校验。
  const { route, navigate } = useHashRoute();
  const [selected, setSelected] = useState<string | null>(route.params['type'] ?? null);
  const [detailId, setDetailId] = useState<string | null>(null);
  // 事件登记表单入口（仅事件类实体显示，清单来自 schema 端点 phase 字段）。
  const [registerOpen, setRegisterOpen] = useState(false);
  // 主数据登记表单入口（商品/交易对手/内部组织，清单来自 master-data/schema 投影）。
  const [masterForm, setMasterForm] = useState<MasterDataTypeFormDTO[] | null>(null);
  const [masterRegisterOpen, setMasterRegisterOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchOntologySchema()
      .then((s) => { if (alive) setSchema(s.entities); })
      .catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    fetchMasterDataFormSchema()
      .then((s) => { if (alive) setMasterForm(s.types); })
      .catch(() => { if (alive) setMasterForm([]); });
    return () => { alive = false; };
  }, []);

  const active = schema?.find((e) => e.name === selected) ?? null;
  const activeMaster = masterForm?.find((t) => t.name === selected) ?? null;
  const eventEntities = useMemo(
    () => (schema ?? []).filter((e) => e.phase === 'event').map((e) => ({ name: e.name, label: e.label })),
    [schema],
  );
  // 事件登记抽屉顶部所选类型说明（注册表 ENTITY_DESCRIPTIONS 经 schema 端点透出）。
  const entityDescriptions = useMemo(
    () => Object.fromEntries((schema ?? []).map((e) => [e.name, e.description])),
    [schema],
  );

  const [rows, setRows] = useState<ProjectedEntity[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [draftFilters, setDraftFilters] = useState(EMPTY_FILTERS);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  // 过期响应守卫: 搜索每键触发 load, 先发后至的旧响应不得覆盖新结果。
  const seqRef = useRef(0);

  const load = useCallback(async () => {
    if (!selected) return;
    const seq = ++seqRef.current;
    setLoading(true);
    setListError(null);
    try {
      const res = await listEntities(selected, {
        page,
        pageSize: PAGE_SIZE,
        q: q.trim() || undefined,
        validFrom: filters.validFrom || undefined,
        validTo: filters.validTo || undefined,
        amountMin: filters.amountMin === '' ? undefined : Number(filters.amountMin),
        amountMax: filters.amountMax === '' ? undefined : Number(filters.amountMax),
      });
      if (seq !== seqRef.current) return;
      setRows(res.items);
      setTotal(res.total);
    } catch (e) {
      if (seq !== seqRef.current) return;
      setListError(e instanceof Error ? e.message : String(e));
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [selected, page, q, filters]);

  useEffect(() => { setPage(1); }, [selected, q, filters]);
  // 切换实体类型时清空过滤(不同类型的过滤维度不同, 残留过滤易造成"空列表"困惑)。
  useEffect(() => { setDraftFilters(EMPTY_FILTERS); setFilters(EMPTY_FILTERS); }, [selected]);
  useEffect(() => {
    // 搜索框每键一次请求太密, 300ms 防抖合并连续键入(翻页/切换类型同样稍延)。
    const t = setTimeout(() => { void load(); }, 300);
    return () => clearTimeout(t);
  }, [load]);

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
            title={e.description}
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
        {active && (
          <div className="mt-2 border-t border-line px-4 pt-2 pb-4 text-xs leading-5 text-ink-soft" title={active.description}>
            {active.description}
          </div>
        )}
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
              {active.phase === 'event' && (
                <button
                  type="button"
                  onClick={() => setRegisterOpen(true)}
                  className="rounded-md bg-blue-600 px-3 py-1.5 text-xs text-white transition-colors hover:bg-blue-700"
                >
                  登记事件
                </button>
              )}
              {activeMaster && (
                <button
                  type="button"
                  onClick={() => setMasterRegisterOpen(true)}
                  className="rounded-md bg-blue-600 px-3 py-1.5 text-xs text-white transition-colors hover:bg-blue-700"
                >
                  登记
                </button>
              )}
            </div>
            {active.ownFields.includes('amount') && (
              <div className="flex flex-wrap items-center gap-2 text-xs text-ink-soft">
                <span>业务时间</span>
                <input type="date" value={draftFilters.validFrom} onChange={(e) => setDraftFilters({ ...draftFilters, validFrom: e.target.value })} aria-label="业务时间从" className="h-7 rounded border border-line bg-white px-2 text-xs text-ink" />
                <span>至</span>
                <input type="date" value={draftFilters.validTo} onChange={(e) => setDraftFilters({ ...draftFilters, validTo: e.target.value })} aria-label="业务时间到" className="h-7 rounded border border-line bg-white px-2 text-xs text-ink" />
                <span className="ml-2">金额</span>
                <input type="number" placeholder="最小" value={draftFilters.amountMin} onChange={(e) => setDraftFilters({ ...draftFilters, amountMin: e.target.value })} aria-label="金额最小" className="h-7 w-24 rounded border border-line bg-white px-2 text-xs text-ink placeholder:text-ink-soft/60" />
                <span>至</span>
                <input type="number" placeholder="最大" value={draftFilters.amountMax} onChange={(e) => setDraftFilters({ ...draftFilters, amountMax: e.target.value })} aria-label="金额最大" className="h-7 w-24 rounded border border-line bg-white px-2 text-xs text-ink placeholder:text-ink-soft/60" />
                <button type="button" onClick={() => setFilters(draftFilters)} className="h-7 rounded border border-line px-3 transition-colors hover:border-primary/40 hover:text-primary">应用过滤</button>
                {(draftFilters.validFrom || draftFilters.validTo || draftFilters.amountMin || draftFilters.amountMax) ? (
                  <button type="button" onClick={() => { setDraftFilters(EMPTY_FILTERS); setFilters(EMPTY_FILTERS); }} className="h-7 rounded border border-line px-3 transition-colors hover:border-primary/40 hover:text-primary">清除</button>
                ) : null}
              </div>
            )}
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
                        {activeMaster ? '暂无数据，点击右上角「登记」录入' : '待本体基座灌数（该类型暂无数据源）'}
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
          typeDescription={active.description}
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
      {registerOpen && active && (
        <EventRegisterDrawer
          eventEntities={eventEntities}
          initialType={active.name}
          entityDescriptions={entityDescriptions}
          onClose={() => setRegisterOpen(false)}
        />
      )}
      {masterRegisterOpen && activeMaster && (
        <MasterDataDrawer
          masterType={activeMaster}
          onClose={() => setMasterRegisterOpen(false)}
          onSaved={() => { void load(); }}
        />
      )}
    </div>
  );
}
