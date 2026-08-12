import neo4j, { type Node, type Relationship } from 'neo4j-driver';
import { getDriver } from './neo4j.js';

/**
 * Relation graph layer (design §7). Neo4j-primary, open schema: node label and
 * relationship type are open strings (validated identifiers); props are JSON.
 * Dynamic labels/types use the injection-safe $($kind) form (Neo4j >= 5.26);
 * assertToken + interpolation is the <5.26 fallback and is always used for
 * constraint DDL (which cannot use $($kind)).
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
export async function linkEntities(input: LinkEntitiesInput): Promise<GraphEdge> {
  const cypher = `
    MATCH (a) WHERE elementId(a) = $srcId
    MATCH (b) WHERE elementId(b) = $dstId
    CREATE (a)-[r:$($kind)]->(b)
    SET r += $props, r.confidence = $confidence, r.createdAt = datetime()
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
      throw new Error(`linkEntities: src or dst node not found (src=${input.srcId} dst=${input.dstId})`);
    }
    const rec = records[0];
    if (!rec) throw new Error('linkEntities: unexpected empty record');
    return relToEdge(rec.get('rel') as Relationship);
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
