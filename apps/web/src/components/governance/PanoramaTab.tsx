// apps/web/src/components/governance/PanoramaTab.tsx
// 治理全景图(roadmap Item 8)：一张图展现业务全景。
// 节点=本体注册表 11 实体(GET /api/ontology/schema)，边=全部关系连接对；
// 节点实时事实数来自 GET /api/ontology/counts(与实体台账 listProjectedEntities 同口径)。
// 画布复用 graph/GraphCanvas(g6)；除 businessTypes 呈现 tokens 外零硬编码业务字段——
// 节点/边/连接对全部来自 schema 接口。不新增 agent 工具(HTTP 只读路由)。
import { useEffect, useMemo, useState } from 'react';
import {
  fetchOntologyCounts, fetchOntologySchema,
  type OntologyCountsDTO, type OntologySchemaDTO,
} from '../../api/ontology';
import type { GraphEdge, GraphNode, Subgraph } from '../../hooks/useGraph';
import { GraphCanvas } from '../graph/GraphCanvas';
import { computeOntologyLayout } from '../graph/ontologyLayout';
import { edgeLabel } from '../graph/businessTypes';
import { useHashRoute } from '../../hooks/useHashRoute';

/** 全景节点 elementId 前缀(与本体穿透模式 `<type>:<id>` 复合键同一形态)。 */
const ENTITY_ID_PREFIX = 'entity:';
/** 中心锚：合同节点(全景图的业务主轴)，schema 缺失该实体时回退 null。 */
const CENTER_ENTITY = 'TradeContract';

/** 穿透模式同款：不过滤类型，模块级空集避免每次渲染 new Set() 触发画布全量重排。 */
const NO_HIDDEN_KINDS: ReadonlySet<string> = new Set();

type PanoramaSelection =
  | { type: 'node'; node: GraphNode }
  | { type: 'edge'; edge: GraphEdge };

const entityNameOf = (elementId: string): string => elementId.replace(/^entity:/, '');

export function PanoramaTab() {
  const [schema, setSchema] = useState<OntologySchemaDTO | null>(null);
  const [counts, setCounts] = useState<OntologyCountsDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<PanoramaSelection | null>(null);
  const { navigate } = useHashRoute();

  // schema(词汇) 与 counts(实时事实数) 并行拉取；任一失败即整卡报错。
  useEffect(() => {
    let alive = true;
    Promise.all([fetchOntologySchema(), fetchOntologyCounts()])
      .then(([s, c]) => { if (alive) { setSchema(s); setCounts(c); } })
      .catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, []);

  // schema -> Subgraph 合成：节点=实体，边=关系连接对。counts 只回填节点 props。
  const subgraph: Subgraph | null = useMemo(() => {
    if (!schema) return null;
    const nodes: GraphNode[] = schema.entities.map((e) => ({
      elementId: `${ENTITY_ID_PREFIX}${e.name}`,
      kind: e.name,
      name: e.label,
      props: { count: counts?.counts[e.name] ?? 0, description: e.description, meaning: e.meaning, ownFields: e.ownFields },
    }));
    const edges: GraphEdge[] = schema.relations.flatMap((r) =>
      r.pairs.map((p) => ({
        elementId: `${r.name}:${p.from}:${p.to}`,
        type: r.name,
        srcId: `${ENTITY_ID_PREFIX}${p.from}`,
        dstId: `${ENTITY_ID_PREFIX}${p.to}`,
        props: { params: r.params },
        confidence: null,
      })),
    );
    const subject = nodes.find((n) => n.elementId === `${ENTITY_ID_PREFIX}${CENTER_ENTITY}`) ?? null;
    return { subject, nodes, edges };
  }, [schema, counts]);

  const labelOfEntity = useMemo(() => {
    const map = new Map<string, string>();
    for (const e of schema?.entities ?? []) map.set(e.name, e.label);
    return map;
  }, [schema]);

  const selectedRelation = selected?.type === 'edge'
    ? schema?.relations.find((r) => r.name === selected.edge.type) ?? null
    : null;

  if (error) {
    return <div className="rounded-lg border border-line bg-white p-4 text-sm text-danger">{error}</div>;
  }
  if (!schema || !subgraph) {
    return <div className="rounded-lg border border-line bg-white p-4 text-sm text-ink-soft">加载中...</div>;
  }

  return (
    <div className="flex h-full min-w-0 flex-col">
      {/* 边类型已内联标注在画布边上, 图例条仅保留实体/关系统计 */}
      <div className="flex items-center justify-end border-b border-line bg-white px-3 py-1.5 text-xs text-ink-soft">
        <span>
          实体 {subgraph.nodes.length} · 关系 {subgraph.edges.length} · 单击查看详情
        </span>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1 overflow-hidden">
          <GraphCanvas
            key="panorama"
            subgraph={subgraph}
            centerElementId={subgraph.subject?.elementId ?? null}
            hiddenKinds={NO_HIDDEN_KINDS}
            showPlainEdges
            // 本体分层布局 + 整图适配初始视口：11 节点按关系方向分列, 14 条边默认可辨。
            computeLayout={computeOntologyLayout}
            initialViewport="fit"
            onHover={() => { /* 全景图无悬停浮层，通道保留 */ }}
            onNodeSelect={(node) => setSelected({ type: 'node', node })}
            onEdgeSelect={(edge) => setSelected({ type: 'edge', edge })}
            onPaneSelect={() => setSelected(null)}
            onNodeDoubleClick={() => { /* 实体节点即词汇层，无邻接可展开 */ }}
          />
        </div>
        {/* 右侧信息面板：节点=实体卡片，边=关系卡片 */}
        <aside className="h-full w-72 shrink-0 overflow-y-auto border-l border-line bg-white">
          {!selected && (
            <div className="p-4 text-sm text-ink-soft">
              单击实体节点查看字段与实时事实数；单击关系边查看语义与参数。
            </div>
          )}
          {selected?.type === 'node' && (() => {
            const node = selected.node;
            const description = typeof node.props?.description === 'string' ? node.props.description : null;
            const meaning = typeof node.props?.meaning === 'string' ? node.props.meaning : null;
            const ownFields = Array.isArray(node.props?.ownFields)
              ? (node.props.ownFields as unknown[]).filter((f): f is string => typeof f === 'string')
              : [];
            const count = typeof node.props?.count === 'number' ? node.props.count : 0;
            return (
              <div className="space-y-3 p-4">
                <div>
                  <div className="text-sm font-medium text-ink">{node.name}</div>
                  <div className="mt-0.5 font-mono text-xs text-ink-soft">{entityNameOf(node.elementId)}</div>
                </div>
                <div>
                  <div className="text-xs font-medium text-ink-soft">实时事实数</div>
                  <div className="mt-1 text-2xl font-semibold tabular-nums text-ink">{count}</div>
                </div>
                <div>
                  <div className="text-xs font-medium text-ink-soft">自有字段</div>
                  <ul className="mt-1 space-y-0.5">
                    {ownFields.map((f) => (
                      <li key={f} className="font-mono text-xs text-ink">{f}</li>
                    ))}
                    {ownFields.length === 0 && <li className="text-xs text-ink-soft/60">（无）</li>}
                  </ul>
                </div>
                <div>
                  <div className="text-xs font-medium text-ink-soft">说明</div>
                  {description
                    ? <div className="mt-1 text-xs leading-5 text-ink">{description}</div>
                    : <div className="mt-1 text-xs text-ink-soft/60">（注册表未收录）</div>}
                </div>
                <div>
                  <div className="text-xs font-medium text-ink-soft">meaning</div>
                  {meaning
                    ? <div className="mt-1 break-all font-mono text-xs text-primary">{meaning}</div>
                    : <div className="mt-1 text-xs text-ink-soft/60">未挂载</div>}
                </div>
                <button
                  type="button"
                  onClick={() => navigate('entities', { type: entityNameOf(node.elementId) })}
                  className="rounded border border-line px-2.5 py-1 text-xs text-ink-soft transition-colors hover:border-primary/40 hover:text-primary"
                >
                  在实体台账中查看
                </button>
              </div>
            );
          })()}
          {selected?.type === 'edge' && (() => {
            const edge = selected.edge;
            const params = Array.isArray(edge.props?.params)
              ? (edge.props.params as unknown[]).filter((p): p is string => typeof p === 'string')
              : [];
            return (
              <div className="space-y-3 p-4">
                <div>
                  <div className="text-sm font-medium text-ink">{edgeLabel(edge.type)}</div>
                  <div className="mt-0.5 font-mono text-xs text-ink-soft">{edge.type}</div>
                </div>
                <div>
                  <div className="text-xs font-medium text-ink-soft">语义</div>
                  <div className="mt-1 text-xs leading-5 text-ink">{selectedRelation?.description ?? '（注册表未收录）'}</div>
                </div>
                <div>
                  <div className="text-xs font-medium text-ink-soft">连接对</div>
                  <div className="mt-1 font-mono text-xs text-ink">
                    {labelOfEntity.get(entityNameOf(edge.srcId)) ?? entityNameOf(edge.srcId)}
                    {' -> '}
                    {labelOfEntity.get(entityNameOf(edge.dstId)) ?? entityNameOf(edge.dstId)}
                  </div>
                </div>
                <div>
                  <div className="text-xs font-medium text-ink-soft">params</div>
                  <div className="mt-1 text-xs text-ink">
                    {params.length ? params.join('、') : '（无参关系）'}
                  </div>
                </div>
              </div>
            );
          })()}
        </aside>
      </div>
    </div>
  );
}
