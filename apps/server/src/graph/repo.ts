import neo4j, { type Node, type Relationship } from 'neo4j-driver';
import { getDriver } from './neo4j.js';

/**
 * Relation graph layer (design §7). Neo4j-primary, open schema: node label and
 * relationship type are open strings (validated identifiers); props are JSON.
 * Dynamic labels/types use the injection-safe $($kind) parameter form, which
 * REQUIRES Neo4j >= 5.26. No runtime fallback is wired; the deployment target
 * (ubuntu-server container neo4j-db) is verified 5.26.10. assertToken is used
 * ONLY for the constraint DDL, which cannot use $($kind).
 */

export type EntityKind = string;
export type Direction = 'out' | 'in' | 'both';

export interface GraphEntity {
  elementId: string;
  kind: string;
  name: string;
  props: Record<string, unknown>;
}
export interface GraphEdge {
  elementId: string;
  type: string;
  srcId: string;
  dstId: string;
  props: Record<string, unknown>;
  confidence: number;
}
export interface GraphQueryResult {
  subject: GraphEntity;
  nodes: GraphEntity[];
  edges: GraphEdge[];
}

const TOKEN_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function assertToken(kind: string, what: 'label' | 'relType'): string {
  if (!TOKEN_RE.test(kind)) {
    throw new Error(`Invalid ${what} '${kind}' — must match ${TOKEN_RE}`);
  }
  return kind;
}

const ensuredConstraints = new Set<string>();
export async function ensureNameConstraint(kind: string): Promise<void> {
  const label = assertToken(kind, 'label');
  if (ensuredConstraints.has(label)) return;
  const session = getDriver().session();
  try {
    await session.executeWrite((txc) =>
      txc.run(
        `CREATE CONSTRAINT sca_name_${label} IF NOT EXISTS FOR (n:${label}) REQUIRE n.name IS UNIQUE`,
      ),
    );
    ensuredConstraints.add(label);
  } finally {
    await session.close();
  }
}

function nodeToEntity(n: Node): GraphEntity {
  const labels: string[] = n.labels;
  const props = (n.properties ?? {}) as Record<string, unknown>;
  return {
    elementId: n.elementId,
    kind: labels[0] ?? '',
    name: String(props.name ?? ''),
    props,
  };
}
function relToEdge(r: Relationship): GraphEdge {
  const props = (r.properties ?? {}) as Record<string, unknown>;
  return {
    elementId: r.elementId,
    type: r.type,
    srcId: r.startNodeElementId,
    dstId: r.endNodeElementId,
    props,
    confidence: typeof props.confidence === 'number' ? props.confidence : 0,
  };
}

export interface CreateEntityInput {
  kind: string;
  name: string;
  props?: Record<string, unknown>;
}
export async function createEntity(input: CreateEntityInput): Promise<GraphEntity & { created: boolean }> {
  await ensureNameConstraint(input.kind);
  const cypher = `
    MERGE (n:$($kind) {name: $name})
    ON CREATE SET n += $props, n.createdAt = datetime()
    ON MATCH  SET n += $props
    RETURN elementId(n) AS elementId, labels(n) AS labels, n AS node
  `;
  const session = getDriver().session();
  try {
    const { records, summary } = await session.executeWrite(async (txc) => {
      const result = await txc.run(cypher, {
        kind: input.kind,
        name: input.name,
        props: input.props ?? {},
      });
      return result;
    });
    const rec = records[0];
    if (!rec) throw new Error('createEntity: MERGE returned no record');
    const node = rec.get('node') as Node;
    const created = summary.counters.updates().nodesCreated === 1;
    const entity = nodeToEntity(node);
    return { ...entity, created };
  } finally {
    await session.close();
  }
}

export interface LinkEntitiesInput {
  srcId: string;
  dstId: string;
  kind: string;
  props?: Record<string, unknown>;
  confidence?: number;
  sourceSpan?: unknown;
}
/**
 * Agent-facing link (graph_link_entities 工具入口)。2026-08-18 语义统一：
 * 最终结果语义 —— 同一 (src, kind, dst) 幂等 MERGE，重复调用只更新属性，
 * 不堆积历史边；图谱始终只体现最终关系状态。直接委托 mergeEdge。
 */
export async function linkEntities(input: LinkEntitiesInput): Promise<GraphEdge> {
  return mergeEdge(input);
}

export interface MergeEdgeInput {
  srcId: string;
  dstId: string;
  kind: string;
  props?: Record<string, unknown>;
  confidence?: number;
  sourceSpan?: unknown;
}
/**
 * Idempotent link: MERGE on (src)-[kind]->(dst) —— 重复确认同一文档不会产生
 * 重复边（design 2026-08-17 §4）。graphWriter（文档确认）与 bindingGraphSync
 * （工作台绑定）以及 agent 工具 linkEntities 都走此入口（2026-08-18 统一为
 * 最终结果语义）。
 */
export async function mergeEdge(input: MergeEdgeInput): Promise<GraphEdge> {
  assertToken(input.kind, 'label'); // followup P3: 与 findEntities 对齐的预检（不触驱动）
  const cypher = `
    MATCH (a) WHERE elementId(a) = $srcId
    MATCH (b) WHERE elementId(b) = $dstId
    MERGE (a)-[r:$($kind)]->(b)
    ON CREATE SET r.createdAt = datetime()
    SET r += $props, r.confidence = $confidence
    RETURN r AS rel
  `;
  const props = { ...(input.props ?? {}) };
  if (input.sourceSpan !== undefined) props.sourceSpan = input.sourceSpan;
  const session = getDriver().session();
  try {
    const { records } = await session.executeWrite(async (txc) => {
      const result = await txc.run(cypher, {
        srcId: input.srcId,
        dstId: input.dstId,
        kind: input.kind,
        props,
        confidence: input.confidence ?? 0,
      });
      return result;
    });
    if (records.length === 0) {
      throw new Error(`mergeEdge: src or dst node not found (src=${input.srcId} dst=${input.dstId})`);
    }
    const rec = records[0];
    if (!rec) throw new Error('mergeEdge: unexpected empty record');
    return relToEdge(rec.get('rel') as Relationship);
  } finally {
    await session.close();
  }
}

export interface FindEntitiesInput {
  kind?: string;
  name: string;
  /** true = 精确相等；默认（false）= CONTAINS 包含匹配。 */
  exact?: boolean;
  limit?: number;
}
/**
 * 按 kind+name 查实体（design 2026-08-17 §6.1）—— graph_query 缺的"按名称找
 * 实体"入口：用户说的是 "中石化"/合同号，不是 elementId。上限 10。
 */
export async function findEntities(input: FindEntitiesInput): Promise<GraphEntity[]> {
  if (input.kind) assertToken(input.kind, 'label');
  const name = (input.name ?? '').trim();
  if (!name) return [];
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 10) || 10, 1), 10);
  const session = getDriver().session({ defaultAccessMode: neo4j.session.READ });
  try {
    const nodePattern = input.kind ? 'MATCH (n:$($kind))' : 'MATCH (n)';
    const whereClause = input.exact ? 'WHERE n.name = $name' : 'WHERE toString(n.name) CONTAINS $name';
    const cypher = `${nodePattern} ${whereClause} RETURN n AS node ORDER BY n.name LIMIT $limit`;
    // neo4j-driver 会把普通 number 序列化为 float64，服务器要求 LIMIT 为
    // INTEGER（live 冒烟发现 10.0 被拒），必须经 neo4j.int() 转换。
    const params: Record<string, unknown> = { name, limit: neo4j.int(limit) };
    if (input.kind) params.kind = input.kind;
    const result = await session.executeRead((txc) => txc.run(cypher, params));
    return result.records.map((rec) => nodeToEntity(rec.get('node') as Node));
  } finally {
    await session.close();
  }
}

/**
 * 按 docId 批量查 Document 图节点（name = docId，见 graphWriter）。仅返回已有
 * 图节点的文档——docId 尚未写入图（graph_status 未落库）则自然不在结果中。
 * 调用方（路由层）负责与 DB 行对齐。
 */
export async function listDocumentNodes(docIds: string[]): Promise<GraphEntity[]> {
  if (docIds.length === 0) return [];
  const session = getDriver().session({ defaultAccessMode: neo4j.session.READ });
  try {
    const cypher =
      'MATCH (n:Document) WHERE n.name IN $docIds RETURN n AS node ORDER BY n.name';
    const result = await session.executeRead((txc) =>
      txc.run(cypher, { docIds }),
    );
    return result.records.map((rec) => nodeToEntity(rec.get('node') as Node));
  } finally {
    await session.close();
  }
}

const DIR_TEMPLATES: Record<Direction, string> = {
  out: '-[:$($edgeKinds)]->',
  in: '<-[:$($edgeKinds)]-',
  both: '-[:$($edgeKinds)]-',
};
function buildTraversal(direction: Direction, depth: number, withKinds: boolean): string {
  const d = Math.min(Math.max(Math.trunc(depth) || 1, 1), 5);
  const tmpl = DIR_TEMPLATES[direction];
  const rel = withKinds ? tmpl : tmpl.replace('[:$($edgeKinds)]', '[]');
  return `(subject)${rel}{1,${d}}(m)`;
}

export interface GraphQueryInput {
  subjectId: string;
  depth?: number;
  edgeKinds?: string[];
  direction?: Direction;
}
export async function graphQuery(input: GraphQueryInput): Promise<GraphQueryResult> {
  const depth = input.depth ?? 2;
  const direction: Direction = input.direction ?? 'both';
  const edgeKinds = input.edgeKinds ?? [];
  const withKinds = edgeKinds.length > 0;
  const traversal = buildTraversal(direction, depth, withKinds);
  const subjectCypher = `MATCH (subject) WHERE elementId(subject) = $subjectId RETURN subject AS subject`;
  const neighborhoodCypher = `
    MATCH (subject) WHERE elementId(subject) = $subjectId
    OPTIONAL MATCH p = ${traversal}
    WITH subject, m, p WHERE m IS NOT NULL
    UNWIND relationships(p) AS rel
    WITH subject, m, rel
    RETURN collect(DISTINCT m) AS nodes, collect(DISTINCT rel) AS edges
  `;
  const session = getDriver().session({ defaultAccessMode: neo4j.session.READ });
  try {
    let subjectEntity: GraphEntity | null = null;
    const nodeMap = new Map<string, GraphEntity>();
    const edgeMap = new Map<string, GraphEdge>();
    await session.executeRead(async (txc) => {
      const subjRes = await txc.run(subjectCypher, { subjectId: input.subjectId });
      if (subjRes.records.length === 0) {
        throw new Error(`graphQuery: subject not found (subjectId=${input.subjectId})`);
      }
      const subjRec = subjRes.records[0];
      if (!subjRec) throw new Error('graphQuery: unexpected empty subject record');
      const subjNode = subjRec.get('subject') as Node;
      subjectEntity = nodeToEntity(subjNode);
      const params: Record<string, unknown> = { subjectId: input.subjectId };
      if (withKinds) params.edgeKinds = edgeKinds;
      const nbrRes = await txc.run(neighborhoodCypher, params);
      for (const rec of nbrRes.records) {
        const nodes = (rec.get('nodes') as Node[] | null) ?? [];
        const edges = (rec.get('edges') as Relationship[] | null) ?? [];
        for (const n of nodes) {
          const e = nodeToEntity(n);
          nodeMap.set(e.elementId, e);
        }
        for (const r of edges) {
          const ed = relToEdge(r);
          edgeMap.set(ed.elementId, ed);
        }
      }
    });
    return {
      subject: subjectEntity as unknown as GraphEntity,
      nodes: [...nodeMap.values()],
      edges: [...edgeMap.values()],
    };
  } finally {
    await session.close();
  }
}

export interface RemoveEdgeInput {
  srcId: string;
  kind: string;
  dstId: string;
}
/** 按 (src, type, dst) 删边, 返回删除条数(0 = 无匹配)。幂等。 */
export async function removeEdge(input: RemoveEdgeInput): Promise<number> {
  const session = getDriver().session({ defaultAccessMode: neo4j.session.WRITE });
  try {
    const cypher = `
      MATCH (a)-[r:$($kind)]->(b)
      WHERE elementId(a) = $srcId AND elementId(b) = $dstId
      DELETE r RETURN count(r) AS removed
    `;
    const result = await session.executeWrite((txc) =>
      txc.run(cypher, { srcId: input.srcId, dstId: input.dstId, kind: input.kind }),
    );
    const rec = result.records[0];
    return Number(rec?.get('removed') ?? 0);
  } finally {
    await session.close();
  }
}

export interface UpdateNodePropsInput {
  elementId: string;
  props: Record<string, unknown>;
}
/**
 * 按 elementId 浅合并节点属性(`SET n += $props`)——对账桥物化通道: 把 SQL
 * 精确聚合出的 Quota.used / Project.rollup 等数值写回图节点(spec 2026-08-25
 * 方案A §2)。只更新已存在节点, 不创建; 匹配不到时静默无操作(调用方先行
 * findEntityByName 判存在)。
 */
export async function updateNodeProps(input: UpdateNodePropsInput): Promise<void> {
  const session = getDriver().session({ defaultAccessMode: neo4j.session.WRITE });
  try {
    const cypher = 'MATCH (n) WHERE elementId(n) = $elementId SET n += $props';
    await session.executeWrite((txc) =>
      txc.run(cypher, { elementId: input.elementId, props: input.props }),
    );
  } finally {
    await session.close();
  }
}
