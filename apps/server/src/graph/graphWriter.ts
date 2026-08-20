import { createEntity, mergeEdge, type GraphEntity } from './repo.js';
import { normalizeName } from './normalize.js';

/**
 * 确认时确定性 Neo4j 写入器（design 2026-08-17 §4）。不读 DB 行——调用方
 * （pipeline/graphCommit）把派生好的实体/边传入；本模块只负责幂等图写入与
 * 逐条容错。io 可注入，单测无需 Neo4j。
 */

export interface GraphEntityInput {
  kind: 'Party' | 'Commodity' | 'Contract';
  name: string; // 原始名；此处归一化
  role?: string;
  confidence: number;
}

export interface GraphEdgeInput {
  type: 'party' | 'commodity' | 'references' | 'executes';
  dstKind: 'Party' | 'Commodity' | 'Contract';
  dstName: string; // 原始名；此处归一化
  role?: string;
  confidence: number;
}

export interface GraphWriteResult {
  status: 'ok' | 'partial' | 'failed' | 'skipped';
  nodeCount: number;
  edgeCount: number;
  /** 确认时实际写入 Neo4j 的实体清单（归一化名）；skipped/failed 为空数组。 */
  writtenEntities: Array<{ kind: string; name: string; role?: string }>;
  reason?: string;
  failures: string[];
}

export interface GraphWriterIo {
  createEntity(input: { kind: string; name: string; props?: Record<string, unknown> }): Promise<GraphEntity & { created: boolean }>;
  mergeEdge(input: { srcId: string; dstId: string; kind: string; props?: Record<string, unknown>; confidence?: number }): Promise<unknown>;
}

export const defaultGraphWriterIo: GraphWriterIo = {
  createEntity: (i) => createEntity(i),
  mergeEdge: (i) => mergeEdge(i) as Promise<unknown>,
};

export interface WriteDocumentGraphInput {
  docId: string;
  docType: string;
  sourceUri: string | null;
  /** 合同类型(spec 2026-08-20): 非空时写入 Document 与 Contract 实体 props。 */
  contractType?: string | null;
  entities: GraphEntityInput[];
  edges: GraphEdgeInput[];
}

/**
 * 写入一份已确认文档：1) MERGE Document 节点（name=docId，受 name 唯一约束）
 * 2) MERGE 各实体（kind + 归一化名）3) MERGE 各边（Document -> 实体）。
 * 逐条失败记入 failures[] 并折算 'partial'；整体出错（驱动不可用等）为
 * 'failed'/'skipped'。永不抛出——确认流程不被图层阻塞。
 */
export async function writeDocumentGraph(
  input: WriteDocumentGraphInput,
  io: GraphWriterIo = defaultGraphWriterIo,
): Promise<GraphWriteResult> {
  const failures: string[] = [];
  let nodeCount = 0;
  let edgeCount = 0;

  // 0. 图未配置（NEO4J_PASSWORD 未设）-> skipped，非错误。
  if (!process.env.NEO4J_PASSWORD) {
    return { status: 'skipped', nodeCount: 0, edgeCount: 0, writtenEntities: [], reason: 'NEO4J_PASSWORD not set', failures: [] };
  }

  // 1. Document 节点（失败即整体 failed：没有锚点无法连边）。
  let docNodeId: string;
  try {
    const docNode = await io.createEntity({
      kind: 'Document',
      name: input.docId,
      props: {
        docId: input.docId,
        docType: input.docType,
        ...(input.sourceUri ? { sourceUri: input.sourceUri } : {}),
        ...(input.contractType ? { contractType: input.contractType } : {}),
      },
    });
    docNodeId = docNode.elementId;
    nodeCount += 1;
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return { status: 'failed', nodeCount, edgeCount, writtenEntities: [], reason, failures: [`Document:${reason}`] };
  }

  // 2. 实体节点（归一化名；归一化后为空则跳过并记录）。
  const entityIds = new Map<string, string>(); // `${kind}:${norm}` -> elementId
  const writtenEntities: GraphWriteResult['writtenEntities'] = [];
  for (const ent of input.entities) {
    const norm = normalizeName(ent.name);
    if (!norm) {
      failures.push(`entity ${ent.kind}: normalized name empty (raw='${ent.name}')`);
      continue;
    }
    const key = `${ent.kind}:${norm}`;
    if (entityIds.has(key)) continue;
    try {
      const node = await io.createEntity({
        kind: ent.kind,
        name: norm,
        props: {
          rawName: ent.name,
          ...(ent.role ? { role: ent.role } : {}),
          ...(ent.kind === 'Contract' && input.contractType ? { contractType: input.contractType } : {}),
        },
      });
      entityIds.set(key, node.elementId);
      nodeCount += 1;
      writtenEntities.push({ kind: ent.kind, name: norm, ...(ent.role ? { role: ent.role } : {}) });
    } catch (e) {
      failures.push(`entity ${ent.kind}/${norm}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 3. 边（Document -> 实体），按 (src,type,dst) MERGE 幂等。
  for (const edge of input.edges) {
    const norm = normalizeName(edge.dstName);
    if (!norm) {
      failures.push(`edge ${edge.type}: normalized dst empty (raw='${edge.dstName}')`);
      continue;
    }
    const dstId = entityIds.get(`${edge.dstKind}:${norm}`);
    if (!dstId) {
      failures.push(`edge ${edge.type}->${norm}: dst node missing (create failed or skipped)`);
      continue;
    }
    try {
      await io.mergeEdge({
        srcId: docNodeId,
        dstId,
        kind: edge.type,
        confidence: edge.confidence,
        props: { source: 'auto', ...(edge.role ? { role: edge.role } : {}) },
      });
      edgeCount += 1;
    } catch (e) {
      failures.push(`edge ${edge.type}->${norm}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return {
    status: failures.length === 0 ? 'ok' : 'partial',
    nodeCount,
    edgeCount,
    writtenEntities,
    failures,
  };
}
