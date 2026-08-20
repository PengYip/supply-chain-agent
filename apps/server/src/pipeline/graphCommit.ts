import type { DbContext } from './db/client.js';
import {
  getDocumentSourceUri,
  getReviewSnapshot,
  setDocumentGraphStatus,
  type DocumentGraphStatus,
} from './db/repositories.js';
import { deriveProposedRelationships } from './extraction.js';
import { normalizeName } from '../graph/normalize.js';
import { writeDocumentGraph, defaultGraphWriterIo, type GraphWriteResult, type GraphWriterIo, type GraphEdgeInput } from '../graph/graphWriter.js';
/** 边的最小投影（喂 writer 前先去重）。 */
interface EdgeLike {
  type: GraphEdgeInput['type'];
  dstKind: GraphEdgeInput['dstKind'];
  dstName: string;
  role?: string;
  confidence: number;
}

/**
 * 按 (type, dstKind, 归一化 dstName) 去重：同一 Party 的甲方+乙方同值会派生两条
 * party 边，写库时 MERGE 折叠后 role 会被后写覆盖、edgeCount 虚高（followup P1）。
 * role 冲突时合并为 '买方/卖方' 斜杠形式（Set 去重）。
 */
function dedupeEdges(edges: EdgeLike[]): EdgeLike[] {
  const seen = new Map<string, { edge: EdgeLike; roles: Set<string>; confidence: number }>();
  for (const e of edges) {
    const key = `${e.type}:${e.dstKind}:${normalizeName(e.dstName)}`;
    const existing = seen.get(key);
    if (existing) {
      if (e.role) existing.roles.add(e.role);
      existing.confidence = Math.max(existing.confidence, e.confidence);
    } else {
      seen.set(key, { edge: e, roles: new Set(e.role ? [e.role] : []), confidence: e.confidence });
    }
  }
  return [...seen.values()].map(({ edge, roles, confidence }) => ({
    ...edge,
    ...(roles.size > 0 ? { role: [...roles].join('/') } : {}),
    confidence,
  }));
}

/**
 * 确认时图提交编排（design 2026-08-17 §4）：读持久化快照（字段 + 实体提议 +
 * docType）-> 派生实体/边 -> writeDocumentGraph -> 结果落 documents.graph_status。
 * 永不抛出：确认流程不被图层阻塞（图不可达 => status 'failed'/'skipped' 记录）。
 *
 * Followup P0 (2026-08-17)：实体从 snapshot.fields 现场重派生（与边同源），
 * 不复用持久化 proposed_relationships 列——复核卡更正字段后该列已陈旧。
 */
export async function commitDocumentGraph(
  ctx: DbContext,
  docId: string,
  userId?: string,
  io?: GraphWriterIo,
): Promise<DocumentGraphStatus> {
  const failed = (reason: string): DocumentGraphStatus => ({
    status: 'failed', nodeCount: 0, edgeCount: 0, reason, failures: [], writtenAt: new Date().toISOString(),
  });
  let status: DocumentGraphStatus;
  try {
    const snapshot = await getReviewSnapshot(ctx, docId, userId);
    if (!snapshot) return failed('document_or_extraction_not_found');
    const sourceUri = await getDocumentSourceUri(ctx, docId, userId);
    const result: GraphWriteResult = await writeDocumentGraph(
      {
        docId,
        docType: snapshot.docType,
        sourceUri,
        entities: deriveProposedRelationships(snapshot.fields).map((r) => ({
          kind: r.kind, name: r.name, role: r.role, confidence: r.confidence,
        })),
        edges: dedupeEdges(
          snapshot.proposedEdges.map((e) => ({
            type: e.type, dstKind: e.dstKind, dstName: e.dstName, role: e.role, confidence: e.confidence,
          })),
        ),
      },
      io,
    );
    status = {
      status: result.status,
      nodeCount: result.nodeCount,
      edgeCount: result.edgeCount,
      ...(result.writtenEntities.length ? { entities: result.writtenEntities } : {}),
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.failures.length ? { failures: result.failures } : {}),
      writtenAt: new Date().toISOString(),
    };
  } catch (e) {
    status = failed(e instanceof Error ? e.message : String(e));
  }
  try {
    await setDocumentGraphStatus(ctx, docId, status, userId);
  } catch (e) {
    // 状态本身持久化失败：记日志，不阻断确认流程。
    console.error('[graphCommit] graph_status persistence failed:', e instanceof Error ? e.message : String(e));
  }
  return status;
}

/**
 * docType 修正后的轻量图同步（F3）：PATCH /api/documents/:docId/type 改库后，
 * 把新 docType 幂等 MERGE 到 Neo4j Document 节点（name=docId），让 /api/graph/query
 * 消费的节点 props.docType 不再陈旧。只更新单节点属性，不重派生子图、不写
 * graph_status（比 commitDocumentGraph 轻得多）。
 *
 * 永不抛出：图不可达/未配置（NEO4J_PASSWORD 未设）时静默跳过，绝不阻断 docType
 * 修正主流程。io 可注入（单测无需 Neo4j），缺省用真实 writer io。
 */
export async function syncDocumentTypeToGraph(
  docId: string,
  docType: string,
  io: GraphWriterIo = defaultGraphWriterIo,
): Promise<void> {
  // 图未配置 -> 跳过（与 writeDocumentGraph 同门禁，非错误）。
  if (!process.env.NEO4J_PASSWORD) return;
  await io.createEntity({
    kind: 'Document',
    name: docId,
    props: { docId, docType },
  });
}
