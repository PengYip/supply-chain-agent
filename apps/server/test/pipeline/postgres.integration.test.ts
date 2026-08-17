// Postgres backend integration test. Genuinely exercises the pg repo + vecStore
// (pgvector) + tool layers against the real sca-pgvector container. SKIPPED
// unless DB_BACKEND=postgres (or DATABASE_URL is set) so it never breaks the
// SQLite CI lane -- this file is a no-op on the default SQLite run.
//
// The existing unit tests (repositories / recall / recall-vec / integration-recall)
// all build their own SQLite in-memory ctx via createDb(':memory:'), so they do
// NOT cover the Postgres path. This file is the coverage for that path: JSONB
// round-trips, numeric(5,4) confidence, GENERATED tsvector + ts_rank FTS, HNSW
// pgvector cosine KNN, and the ingest/recall tool bodies on a Postgres ctx.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPostgresContext } from '../../src/pipeline/db/postgres-client.js';
import type { PostgresDbContext } from '../../src/pipeline/db/client.js';
import { DB_BACKEND } from '../../src/pipeline/db/dbBackend.js';
import { env } from '../../src/env.js';
import {
  saveDocument,
  loadDocument,
  saveExtraction,
  saveBinding,
  listBindingsForContract,
  saveChunks,
  searchChunks,
  getChunkMetaByRowids,
} from '../../src/pipeline/db/repositories.js';
import { saveChunkVectors, vectorKnn, isVecReady } from '../../src/pipeline/db/vecStore.js';
import { buildIngestDocumentTool } from '../../src/pipeline/tools/documentEntry.js';
import { buildRecallDocumentsTool } from '../../src/pipeline/tools/recall.js';
import { DeterministicEmbedder } from '../../src/pipeline/embedder.js';
import type { BlockModel } from '../../src/pipeline/types.js';

// ---------------------------------------------------------------------------
// TRUNCATE 安全门禁：本文件 beforeEach 会对 doc_chunk / extractions / bindings /
// documents 执行 TRUNCATE，会清空目标库的全部业务数据。2026-08-17 曾有人把
// DATABASE_URL 指向共享开发库（10.10.0.2:5433/sca）直接跑本测试，导致真实业务
// 数据被清空。门禁规则：仅当连接串解析出的库名包含 "test"（推荐独立库 sca_test），
// 或显式设置 PG_TRUNCATE_OK=1 声明"目标库允许被清空"时，才允许执行。
// 连接串解析：优先 PG_TEST_URL，否则 DATABASE_URL（与 RUN_PG 判定保持一致）。
// ---------------------------------------------------------------------------

/** 解析本测试实际使用的连接串（PG_TEST_URL 优先，其次 DATABASE_URL）。 */
function resolvePgTestUrl(): string | undefined {
  return process.env.PG_TEST_URL ?? process.env.DATABASE_URL ?? undefined;
}

/** 从连接串 pathname 提取库名；无连接串或解析失败时返回 null。 */
function resolvePgDbName(): string | null {
  const url = resolvePgTestUrl();
  if (!url) return null;
  try {
    const dbName = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
    return dbName || null;
  } catch {
    return null;
  }
}

/** 库名包含 "test"，或显式设置了 PG_TRUNCATE_OK=1。 */
function pgTruncateAllowed(): boolean {
  const dbName = resolvePgDbName();
  return (
    (dbName !== null && dbName.includes('test')) || process.env.PG_TRUNCATE_OK === '1'
  );
}

/** 门禁总判定：请求了 PG 连接 且 目标库允许 TRUNCATE。 */
function pgGatePassed(): boolean {
  const pgRequested =
    DB_BACKEND === 'postgres' || !!process.env.PG_TEST_URL || !!process.env.DATABASE_URL;
  return pgRequested && pgTruncateAllowed();
}

const RUN_PG = pgGatePassed();

if (!RUN_PG) {
  const targetUrl = resolvePgTestUrl();
  const dbName = resolvePgDbName();
  console.warn(
    [
      '====================================================================',
      '[PG 集成测试已跳过] postgres.integration.test.ts 的 beforeEach 会对',
      'doc_chunk / extractions / bindings / documents 执行 TRUNCATE，会清空',
      '目标库的全部业务数据。',
      `当前连接串：${targetUrl ?? '未设置（PG_TEST_URL / DATABASE_URL 均缺失）'}`,
      `解析出的库名：${dbName ?? '（无连接串或解析失败）'}`,
      '门禁要求：库名必须包含 "test"（请使用独立测试库 sca_test，创建与迁移',
      '步骤见 docs/postgres-migration-runbook.md「PG 集成测试使用独立 sca_test 库」），',
      '或显式设置 PG_TRUNCATE_OK=1 声明目标库允许被清空（慎用，仅限一次性废弃库）。',
      '====================================================================',
    ].join('\n'),
  );
}

function mkModel(docId: string): BlockModel {
  return {
    docId,
    docType: '合同',
    modality: 'digital',
    blocks: [
      { id: 'b1', type: 'kv', text: '合同号: HT-PG-001', page: 1, bbox: null, ocrConfidence: 1 },
    ],
    sourceUri: 'file:///pg-fixture',
    createdAt: '2026-08-08T00:00:00.000Z',
  };
}

describe.skipIf(!RUN_PG)('Postgres backend (pgvector + FTS ts_rank)', () => {
  let ctx: PostgresDbContext;
  let embedder: DeterministicEmbedder;

  beforeAll(() => {
    // 双重门禁：skipIf 判定与实际连接必须一致（防环境变量在文件加载与
    // beforeAll 执行之间变化、导致连到非测试库），不满足直接 throw，
    // 绝不让 TRUNCATE 落到业务库。
    if (!pgGatePassed()) {
      throw new Error(
        `PG 集成测试门禁未通过：目标库名 ${resolvePgDbName() ?? '（未解析）'} ` +
          '不含 "test" 且未设置 PG_TRUNCATE_OK=1，拒绝执行 TRUNCATE。',
      );
    }
    ctx = createPostgresContext(resolvePgTestUrl());
    embedder = new DeterministicEmbedder();
  });

  // Isolation: wipe pipeline tables between tests (dev container only).
  beforeEach(async () => {
    await ctx.pool.query(
      'TRUNCATE doc_chunk, extractions, bindings, documents RESTART IDENTITY CASCADE',
    );
  });

  const execOpts = {
    messages: [],
    toolCallId: 't',
    abortSignal: undefined as any,
  } as any;

  // ---- repository layer (JSONB + numeric round-trips) -----------------------

  it('saveDocument/loadDocument round-trips a BlockModel via JSONB', async () => {
    const id = await saveDocument(ctx, mkModel('DOC-PG-1'));
    expect(id).toBe('DOC-PG-1');
    const loaded = await loadDocument(ctx, 'DOC-PG-1');
    expect(loaded).not.toBeNull();
    expect(loaded?.blocks[0]!.text).toBe('合同号: HT-PG-001');
    expect(loaded?.docType).toBe('合同');
  });

  it('loadDocument returns null for a missing id', async () => {
    const loaded = await loadDocument(ctx, 'DOES-NOT-EXIST');
    expect(loaded).toBeNull();
  });

  it('saveExtraction persists JSONB fields + numeric confidence', async () => {
    await saveDocument(ctx, mkModel('DOC-PG-1'));
    const exId = await saveExtraction(ctx, {
      documentId: 'DOC-PG-1',
      docType: '合同',
      fields: { 合同号: { value: 'HT-PG-001', sourceSpans: [{ blockId: 'b1', start: 5, end: 15 }] } },
      fieldMeta: { 合同号: { strength: 'exact', confidence: 0.98 } },
      overallConfidence: 0.98,
      needsReview: false,
    });
    expect(exId).toMatch(/^EX-/);
  });

  it('saveBinding/listBindingsForContract round-trips JSONB sourceRefs + numeric confidence', async () => {
    await saveDocument(ctx, mkModel('DOC-PG-1'));
    const bId = await saveBinding(ctx, {
      documentId: 'DOC-PG-1',
      contractNo: 'HT-PG-001',
      relation: 'primary',
      sourceRefs: [{ blockId: 'b1', start: 5, end: 15 }],
      confidence: 0.98,
      createdBy: 'agent',
    });
    expect(bId).toMatch(/^BD-/);
    const list = await listBindingsForContract(ctx, 'HT-PG-001');
    expect(list).toHaveLength(1);
    expect(list[0]!.documentId).toBe('DOC-PG-1');
    expect(list[0]!.confidence).toBeCloseTo(0.98, 4);
    expect(list[0]!.sourceRefs[0]!.blockId).toBe('b1');
  });

  // ---- chunk + FTS (GENERATED tsvector + ts_rank + GIN) ---------------------

  it('saveChunks returns serial ids; searchChunks ts_rank-recalls a keyword', async () => {
    await saveDocument(ctx, mkModel('DOC-PG-1'));
    const rowids = await saveChunks(ctx, 'DOC-PG-1', [
      { text: 'Product: diesel fuel for the contract shipment', index: 0 },
      { text: 'Signatories: 华盛集团 与 中石化', index: 1 },
    ]);
    expect(rowids).toHaveLength(2);
    expect(rowids.every((r) => typeof r === 'number' && r > 0)).toBe(true);

    const hits = await searchChunks(ctx, 'diesel', 5);
    expect(hits.length).toBeGreaterThan(0);
    // ts_rank: bm25Score is -rank (more negative = better). Finite, <= 0.
    for (const h of hits) {
      expect(Number.isFinite(h.bm25Score)).toBe(true);
      expect(h.bm25Score).toBeLessThanOrEqual(0);
    }
    expect(hits.some((h) => h.snippet.includes('diesel'))).toBe(true);
  });

  it('searchChunks returns [] for a non-matching query (no hallucination)', async () => {
    await saveDocument(ctx, mkModel('DOC-PG-1'));
    await saveChunks(ctx, 'DOC-PG-1', [{ text: 'diesel fuel', index: 0 }]);
    const hits = await searchChunks(ctx, 'zzznomatchxyz12345', 5);
    expect(hits).toEqual([]);
  });

  it('getChunkMetaByRowids maps rowid -> meta', async () => {
    await saveDocument(ctx, mkModel('DOC-PG-1'));
    const rowids = await saveChunks(ctx, 'DOC-PG-1', [
      { text: 'alpha chunk', index: 0 },
    ]);
    const meta = await getChunkMetaByRowids(ctx, rowids);
    expect(meta.size).toBe(1);
    expect(meta.get(rowids[0]!)?.text).toBe('alpha chunk');
    expect(meta.get(rowids[0]!)?.documentId).toBe('DOC-PG-1');
  });

  // ---- pgvector (vector(1024) + HNSW cosine KNN) ----------------------------

  it('isVecReady is true (pgvector provisioned)', async () => {
    expect(await isVecReady(ctx)).toBe(true);
  });

  it('saveChunkVectors + vectorKnn: cosine KNN returns nearest chunk ids', async () => {
    await saveDocument(ctx, mkModel('DOC-PG-1'));
    const rowids = await saveChunks(ctx, 'DOC-PG-1', [
      { text: 'diesel engine maintenance', index: 0 },
      { text: 'gasoline engine repair', index: 1 },
    ]);
    const [v0, v1, q] = await embedder.embed([
      'diesel engine maintenance',
      'gasoline engine repair',
      'diesel engine',
    ]);
    const written = await saveChunkVectors(ctx, [
      { chunkRowId: rowids[0]!, vec: v0 ?? [] },
      { chunkRowId: rowids[1]!, vec: v1 ?? [] },
    ]);
    expect(written).toBe(2);

    const hits = await vectorKnn(ctx, q ?? [], 5);
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      expect(Number.isFinite(h.distance)).toBe(true);
      expect(h.distance).toBeGreaterThanOrEqual(0);
    }
    // Nearest first (ascending distance).
    const dists = hits.map((h) => h.distance);
    expect(dists).toEqual([...dists].sort((a, b) => a - b));
  });

  // ---- tool bodies end-to-end on a Postgres ctx -----------------------------

  it('ingest_document tool persists doc + chunks + vectors on Postgres', async () => {
    const file = join(env.INGEST_ROOT, `pg-ingest-${Date.now()}.txt`);
    writeFileSync(file, 'Product: diesel fuel\nContract: HT-PG-002\nAmount: 2860000', 'utf-8');
    const ingest = buildIngestDocumentTool({ ctx, embedder });
    const res = await ingest.execute(
      { sourceUri: file, docType: '合同', modality: 'digital' },
      execOpts,
    );
    expect(res.docId).toBeDefined();
    expect(res.blockCount).toBe(3);

    // chunks persisted + vectors written (embedding column populated).
    const chunks = await ctx.pool.query('SELECT count(*)::int AS n FROM doc_chunk WHERE document_id = $1', [res.docId]);
    expect(Number(chunks.rows[0].n)).toBeGreaterThan(0);
    const vecs = await ctx.pool.query('SELECT count(*)::int AS n FROM doc_chunk WHERE document_id = $1 AND embedding IS NOT NULL', [res.docId]);
    expect(Number(vecs.rows[0].n)).toBeGreaterThan(0);
  });

  it('recall_documents hybrid tool returns RRF-fused matches on Postgres', async () => {
    const file = join(env.INGEST_ROOT, `pg-recall-${Date.now()}.txt`);
    writeFileSync(file, 'Product: diesel fuel\nContract: HT-PG-003', 'utf-8');
    const ingest = buildIngestDocumentTool({ ctx, embedder });
    const { docId } = await ingest.execute(
      { sourceUri: file, docType: '合同', modality: 'digital' },
      execOpts,
    );

    const recall = buildRecallDocumentsTool({ ctx, embedder });
    const ftsRes = (await recall.execute({ query: 'diesel', strategy: 'fts' }, execOpts)) as {
      matchCount: number;
      matches: Array<{ document_id: string }>;
    };
    expect(ftsRes.matchCount).toBeGreaterThan(0);
    expect(ftsRes.matches.some((m) => m.document_id === docId)).toBe(true);

    const hybridRes = (await recall.execute({ query: 'diesel', strategy: 'hybrid' }, execOpts)) as {
      strategy: string;
      matchCount: number;
      matches: Array<{ document_id: string; vector_distance: number | null }>;
    };
    expect(hybridRes.strategy).toBe('hybrid');
    expect(hybridRes.matchCount).toBeGreaterThan(0);
    // hybrid fused at least one vector contribution (pgvector KNN hit).
    expect(hybridRes.matches.some((m) => m.vector_distance !== null)).toBe(true);
  });
});
