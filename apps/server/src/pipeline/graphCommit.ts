import type { DbContext } from './db/client.js';
import {
  getDocumentSourceUri,
  getReviewSnapshot,
  setDocumentGraphStatus,
  type DocumentGraphStatus,
} from './db/repositories.js';
import { writeDocumentGraph, type GraphWriteResult, type GraphWriterIo } from '../graph/graphWriter.js';

/**
 * 确认时图提交编排（design 2026-08-17 §4）：读持久化快照（字段 + 实体提议 +
 * docType）-> 派生实体/边 -> writeDocumentGraph -> 结果落 documents.graph_status。
 * 永不抛出：确认流程不被图层阻塞（图不可达 => status 'failed'/'skipped' 记录）。
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
        entities: snapshot.proposedRelationships.map((r) => ({
          kind: r.kind, name: r.name, role: r.role, confidence: r.confidence,
        })),
        edges: snapshot.proposedEdges.map((e) => ({
          type: e.type, dstKind: e.dstKind, dstName: e.dstName, role: e.role, confidence: e.confidence,
        })),
      },
      io,
    );
    status = {
      status: result.status,
      nodeCount: result.nodeCount,
      edgeCount: result.edgeCount,
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
