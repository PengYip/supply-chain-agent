import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate, type SqliteDbContext } from '../../src/pipeline/db/client.js';
import { enableVec, saveChunkVectors } from '../../src/pipeline/db/vecStore.js';
import { saveChunks } from '../../src/pipeline/db/repositories.js';
import { reconcileVectorizationAfterDocTypeChange } from '../../src/pipeline/vectorReconcile.js';
import { DeterministicEmbedder } from '../../src/pipeline/embedder.js';

let ctx: SqliteDbContext;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
});

async function seededDoc(): Promise<number> {
  ctx.sqlite.prepare(
    "INSERT INTO documents (id, doc_type, modality, source_uri, block_model) VALUES (?, '运输凭证', 'digital', '', '{}')",
  ).run('doc-r1');
  const ids = await saveChunks(ctx, 'doc-r1', [{ text: '运单号 YD001', index: 0 }]);
  return ids[0]!;
}

describe('reconcileVectorizationAfterDocTypeChange', () => {
  it('纠正为可向量化类型: 补嵌入 + meta ok (无模板表走字面回退)', async () => {
    const cap = enableVec(ctx.sqlite);
    await seededDoc();
    const meta = await reconcileVectorizationAfterDocTypeChange(
      ctx, 'doc-r1', '合同', new DeterministicEmbedder(),
    );
    expect(meta.status).toBe(cap.ok ? 'ok' : 'skipped');
    if (cap.ok) expect(meta.mode).toBe('deterministic');
  });

  it('纠正为不可向量化类型: 清空向量 + meta skipped(约定 reason)', async () => {
    const cap = enableVec(ctx.sqlite);
    const chunkId = await seededDoc();
    if (cap.ok) {
      await saveChunkVectors(ctx, [{ chunkRowId: chunkId, vec: new Array(1024).fill(0.1) }]);
    }
    const meta = await reconcileVectorizationAfterDocTypeChange(
      ctx, 'doc-r1', '运输凭证', new DeterministicEmbedder(),
    );
    expect(meta.status).toBe('skipped');
    expect(meta.reason).toContain('仅合同');
    if (cap.ok) {
      const left = ctx.sqlite.prepare(
        'SELECT COUNT(*) AS n FROM doc_chunk_vec WHERE id = ?',
      ).get(chunkId) as { n: number };
      expect(left.n).toBe(0);
    }
  });

  it('未接 embedder: meta skipped(vec_store_not_ready 语义路径)', async () => {
    await seededDoc();
    const meta = await reconcileVectorizationAfterDocTypeChange(ctx, 'doc-r1', '合同', undefined);
    expect(meta.status).toBe('skipped');
    expect(meta.reason).toBe('vec_store_not_ready');
  });
});
