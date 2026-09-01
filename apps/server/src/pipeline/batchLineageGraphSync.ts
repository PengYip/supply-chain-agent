// P3 谱系图同步(批量拆分器 Phase 3): container 的 (container)-[:CONTAINS]->
// (unit) 边幂等刷新。照 bindingGraphSync 模式: 业务写入永不被图同步阻塞 ——
// 未配置(NEO4J_PASSWORD 未设) -> 'skipped'; 驱动/读库异常 -> 'failed'
// (console.warn, 不抛出)。io 可注入, 单测无需 Neo4j。
import type { DbContext } from './db/client.js';
import { getDocumentSourceUri, listDocumentUnitsByParent } from './db/repositories.js';
import { writeBatchLineageEdges, defaultGraphWriterIo, type GraphWriterIo } from '../graph/graphWriter.js';

export type BatchLineageSyncOutcome = 'ok' | 'skipped' | 'failed';

/**
 * 刷新一个 container 的 CONTAINS 子图。读 documents.source_uri(供 container
 * 节点 props, 与 writeDocumentGraph 同形)与 document_units, 过滤出已回填
 * child_document_id 且页码齐备的行, 组 pages 字符串(单页 'pN' / 跨页
 * 'pN-M')后交 writeBatchLineageEdges。幂等: 重拆/合并/重抽后重复调用,
 * 图只体现最终状态。
 */
export async function syncBatchLineageGraph(
  ctx: DbContext,
  containerDocId: string,
  io: GraphWriterIo = defaultGraphWriterIo,
): Promise<BatchLineageSyncOutcome> {
  if (!process.env.NEO4J_PASSWORD) return 'skipped';
  try {
    const sourceUri = await getDocumentSourceUri(ctx, containerDocId);
    const units = await listDocumentUnitsByParent(ctx, containerDocId);
    const graphUnits = units
      .filter((u) => u.childDocumentId !== null && u.pageStart !== null && u.pageEnd !== null)
      .map((u) => ({
        unitDocId: u.childDocumentId!,
        unitIndex: u.unitIndex,
        pages: u.pageStart === u.pageEnd ? `p${u.pageStart}` : `p${u.pageStart}-p${u.pageEnd}`,
      }));
    await writeBatchLineageEdges(
      { containerDocId, sourceUri, units: graphUnits },
      io,
    );
    return 'ok';
  } catch (e) {
    console.warn(
      '[batchLineageGraphSync] CONTAINS 边同步失败:',
      containerDocId,
      e instanceof Error ? e.message : String(e),
    );
    return 'failed';
  }
}
