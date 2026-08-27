// 纠错回溯(spec 2026-08-27 选择性向量化): 五维卡人工修正 docType 后把向量库
// 对齐新类型——改为可向量化类型补嵌入, 改为不可向量化类型清空已有向量。
// 永不抛出: 任何失败降级为 failed/skipped meta 并 warn, 不阻断类型修正主流程。
import type { Embedder } from './embedder.js';
import type { DbContext } from './db/client.js';
import type { DocumentVectorization } from './db/repositories.js';
import {
  listChunksByDocument,
  listTemplateTypes,
  setDocumentVectorization,
} from './db/repositories.js';
import { isVecReady, saveChunkVectors, clearChunkVectorsForDocument } from './db/vecStore.js';
import { isVectorizableDocType, SKIP_REASON_NOT_VECTORIZABLE } from './vectorPolicy.js';

export async function reconcileVectorizationAfterDocTypeChange(
  ctx: DbContext,
  docId: string,
  newDocType: string,
  embedder: Embedder | undefined,
  userId?: string,
): Promise<DocumentVectorization> {
  try {
    const types = await listTemplateTypes(ctx);
    const chunks = await listChunksByDocument(ctx, docId);
    const mode = embedder?.kind ?? 'none';
    if (!isVectorizableDocType(newDocType, types)) {
      await clearChunkVectorsForDocument(ctx, docId);
      const meta: DocumentVectorization = {
        status: 'skipped', mode, chunkCount: chunks.length,
        reason: SKIP_REASON_NOT_VECTORIZABLE,
      };
      await setDocumentVectorization(ctx, docId, meta, userId);
      return meta;
    }
    if (!embedder || !(await isVecReady(ctx))) {
      const meta: DocumentVectorization = {
        status: 'skipped', mode, chunkCount: chunks.length,
        reason: 'vec_store_not_ready',
      };
      await setDocumentVectorization(ctx, docId, meta, userId);
      return meta;
    }
    const embeddable = chunks.filter((c) => c.text.trim().length > 0);
    if (embeddable.length === 0) {
      const meta: DocumentVectorization = {
        status: 'skipped', mode, chunkCount: 0, reason: '无有效文本块',
      };
      await setDocumentVectorization(ctx, docId, meta, userId);
      return meta;
    }
    const vecs = await embedder.embed(embeddable.map((c) => c.text));
    await saveChunkVectors(
      ctx,
      embeddable.map((c, i) => ({ chunkRowId: c.id, vec: vecs[i] ?? [] })),
    );
    const meta: DocumentVectorization = { status: 'ok', mode: embedder.kind, chunkCount: embeddable.length };
    await setDocumentVectorization(ctx, docId, meta, userId);
    return meta;
  } catch (e) {
    console.warn('[vectorReconcile] 回溯失败:', e instanceof Error ? e.message : String(e));
    return {
      status: 'failed', mode: embedder?.kind ?? 'none', chunkCount: 0,
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}
