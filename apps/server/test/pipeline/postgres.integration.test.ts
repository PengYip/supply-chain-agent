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
import { migratePostgres } from '../../src/pipeline/db/client.js';
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
  upsertExecutionFlow,
  summarizeExecutionFlows,
  addSelfParty,
  listSelfParties,
  removeSelfParty,
  saveDocumentUnits,
  listDocumentUnitsByParent,
  updateDocumentUnitChild,
  setDocumentBatchRole,
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

  beforeAll(async () => {
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
    // Ensure the startup migration has run: it recreates doc_chunk.fts_vector as
    // a GENERATED column with CJK unigram preprocessing (drizzle 0000 created a
    // plain NULL column, so FTS silently returned 0 hits). Idempotent -- safe to
    // run on every boot and here.
    await migratePostgres(ctx.pool);
  });

  // Isolation: wipe pipeline tables between tests (dev container only).
  beforeEach(async () => {
    await ctx.pool.query(
      'TRUNCATE doc_chunk, extractions, bindings, documents, document_units, execution_flows, self_parties RESTART IDENTITY CASCADE',
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

  // ---- 批量拆分器(spec 2026-09-01): document_units + documents.batch_role ----

  it('saveDocumentUnits round-trips unit rows + batch_role + child backfill', async () => {
    await saveDocument(ctx, mkModel('DOC-PG-BATCH'));
    await setDocumentBatchRole(ctx, 'DOC-PG-BATCH', 'container');
    const ids = await saveDocumentUnits(ctx, [
      {
        parentDocumentId: 'DOC-PG-BATCH',
        unitIndex: 1,
        docType: '质检报告',
        pageStart: 1,
        pageEnd: 1,
        bboxJson: JSON.stringify({ x: 0, y: 0.025, w: 0.52, h: 0.95 }),
        rotationDeg: 90,
        detectorConfidence: 0.95,
        manifest: { identifier: 'HX-001', evidence: '检测报告', regions: [{ page: 1 }] },
      },
      {
        parentDocumentId: 'DOC-PG-BATCH',
        unitIndex: 2,
        docType: '汽运磅单',
        pageStart: 1,
        pageEnd: 2,
        rotationDeg: 0,
        detectorConfidence: 0.8,
        manifest: { identifier: null, merged: true },
      },
    ]);
    expect(ids).toHaveLength(2);

    await saveDocument(ctx, mkModel('DOC-PG-UNIT-1'));
    await updateDocumentUnitChild(ctx, ids[0]!, 'DOC-PG-UNIT-1', 'processed');
    await setDocumentBatchRole(ctx, 'DOC-PG-UNIT-1', 'unit');

    const units = await listDocumentUnitsByParent(ctx, 'DOC-PG-BATCH');
    expect(units).toHaveLength(2);
    expect(units.map((u) => u.unitIndex)).toEqual([1, 2]);
    expect(units[0]!.childDocumentId).toBe('DOC-PG-UNIT-1');
    expect(units[0]!.status).toBe('processed');
    expect(units[0]!.detectorConfidence).toBeCloseTo(0.95, 5);
    expect(JSON.parse(units[0]!.bboxJson!)).toMatchObject({ w: 0.52 });
    expect(units[0]!.manifest.identifier).toBe('HX-001');
    expect(units[1]!.pageStart).toBe(1);
    expect(units[1]!.pageEnd).toBe(2);
    expect(units[1]!.bboxJson).toBeNull();

    const roles = await ctx.pool.query(
      "SELECT id, batch_role FROM documents WHERE id = ANY($1) ORDER BY id",
      [['DOC-PG-BATCH', 'DOC-PG-UNIT-1']],
    );
    expect(roles.rows.map((r: { id: string; batch_role: string }) => r.batch_role).sort()).toEqual([
      'container',
      'unit',
    ]);
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

  it('searchChunks CJK unigram: Chinese multi-char query hits (fts_vector GENERATED + toPgFtsQuery)', async () => {
    // migratePostgres ran in beforeAll: fts_vector is a GENERATED column with
    // CJK unigram preprocessing, and searchChunksPg preprocesses the query the
    // same way -- so '违约责任' matches the unigrams of '第七条 违约责任'.
    await saveDocument(ctx, mkModel('DOC-PG-1'));
    await saveChunks(ctx, 'DOC-PG-1', [
      { text: 'CJXC-CTCL-JY-2024-131-01 第七条 违约责任：乙方逾期交货的，应向甲方支付违约金。', index: 0 },
      { text: '交货标准：产品质量应符合国标。', index: 1 },
    ]);

    const hits = await searchChunks(ctx, '违约责任', 10);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.documentId).toBe('DOC-PG-1');
    // windowSnippet windows around the earliest term occurrence -> the snippet
    // carries the matched clause body (第七条), not a chunk-start fragment.
    expect(hits[0]!.snippet).toContain('第七条');
    expect(hits[0]!.snippet).toContain('违约');
    // ts_headline is gone: no <b> markers, no injected spaces between CJK chars.
    expect(hits[0]!.snippet).not.toContain('<b>');
    expect(hits[0]!.snippet).not.toContain('违 约');

    // Mixed CJK + ASCII query (OR semantics since incident 2026-08-28).
    const mixed = await searchChunks(ctx, 'CJXC 交货', 10);
    expect(mixed.length).toBeGreaterThan(0);
    expect(mixed.some((h) => h.documentId === 'DOC-PG-1')).toBe(true);
  });

  it('searchChunks OR semantics: multi-keyword query hits on partial matches (incident d6cb688f)', async () => {
    // The incident: "结算 两票制 发热量 扣款 结算单价 轨道衡" required EVERY
    // unigram in ONE chunk under AND -> structurally 0 hits despite relevant
    // chunks existing. With OR, chunks matching ANY term surface and ts_rank
    // floats multi-term matches up.
    await saveChunks(ctx, 'DOC-PG-OR', [
      { text: '第四条 煤炭价格与结算方式：基准到站含税包干价，发热量调整扣款。', index: 0 },
      { text: '货物到达甲方指定地点交付，轨道衡验收数量为结算依据。', index: 1 },
    ]);
    const hits = await searchChunks(ctx, '结算 两票制 发热量 扣款 结算单价 轨道衡', 10);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.documentId === 'DOC-PG-OR')).toBe(true);
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

  it('vectorKnn scoped by docIds filters INSIDE the KNN (incident d6cb688f)', async () => {
    await saveDocument(ctx, mkModel('DOC-PG-SCOPED-A'));
    await saveDocument(ctx, mkModel('DOC-PG-SCOPED-B'));
    const rowsA = await saveChunks(ctx, 'DOC-PG-SCOPED-A', [
      { text: 'scoped knn target coal settlement', index: 0 },
    ]);
    const rowsB = await saveChunks(ctx, 'DOC-PG-SCOPED-B', [
      { text: 'unrelated other document cargo manifest', index: 0 },
    ]);
    const [va, vb, q] = await embedder.embed([
      'scoped knn target coal settlement',
      'unrelated other document cargo manifest',
      'scoped knn coal',
    ]);
    await saveChunkVectors(ctx, [
      { chunkRowId: rowsA[0]!, vec: va ?? [] },
      { chunkRowId: rowsB[0]!, vec: vb ?? [] },
    ]);
    // Scoped to doc A: only A's chunks may return, even though k=5 exceeds A's
    // chunk count. (Pre-fix, a global top-k + caller-side filter starved
    // contractNo-scoped recalls.)
    const scoped = await vectorKnn(ctx, q ?? [], 5, { docIds: ['DOC-PG-SCOPED-A'] });
    expect(scoped.length).toBeGreaterThan(0);
    const scopedMeta = await getChunkMetaByRowids(ctx, scoped.map((h) => h.chunkRowId));
    for (const [, m] of scopedMeta) {
      expect(m.documentId).toBe('DOC-PG-SCOPED-A');
    }
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

  it('recall_documents fullText: short doc returns whole-document text on Postgres', async () => {
    const file = join(env.INGEST_ROOT, `pg-fulltext-${Date.now()}.txt`);
    writeFileSync(file, '质量奖罚条款全文锚点 PGFT-1\n灰分未约定时的判定依据见第三条', 'utf-8');
    const ingest = buildIngestDocumentTool({ ctx, embedder });
    const { docId } = await ingest.execute(
      { sourceUri: file, docType: '合同', modality: 'digital' },
      execOpts,
    );
    const recall = buildRecallDocumentsTool({ ctx, embedder });
    const res = (await recall.execute(
      { query: '质量奖罚条款全文锚点', strategy: 'fts', limit: 5, tagMode: 'any' },
      execOpts,
    )) as { mode?: string; documents?: Array<{ document_id: string; text: string }> };
    expect(res.mode).toBe('fullText');
    expect(
      (res.documents ?? []).some((d) => d.document_id === docId && d.text.includes('PGFT-1')),
    ).toBe(true);
  });

  // ---- execution_flows (六向执行流水) ----------------------------------------

  it('upsertExecutionFlow is idempotent per (binding_id, user_id); summarize aggregates', async () => {
    const base = {
      documentId: 'DOC-PG-1',
      contractNo: 'HT-PG-100',
      flowType: '资金流',
      docType: '银行回单',
      confidence: 0.95,
      createdBy: 'agent',
    };
    await upsertExecutionFlow(ctx, {
      ...base, bindingId: 'BD-1', direction: 'in', amount: 1000, quantityTon: 10, voucherDate: '2024-01-10',
    });
    // Same binding -> update in place, no duplicate row.
    await upsertExecutionFlow(ctx, {
      ...base, bindingId: 'BD-1', direction: 'in', amount: 2000, quantityTon: 20, voucherDate: '2024-02-01',
    });
    // null amount -> excluded from SUM(amount), counted in entryCount.
    await upsertExecutionFlow(ctx, {
      ...base, bindingId: 'BD-2', direction: 'in', amount: null, quantityTon: 30, voucherDate: '2024-03-01',
    });
    await upsertExecutionFlow(ctx, {
      ...base, bindingId: 'BD-3', direction: 'out', amount: 500, quantityTon: 5, voucherDate: '2024-01-15',
    });

    const count = await ctx.pool.query(
      'SELECT count(*)::int AS n FROM execution_flows WHERE contract_no = $1',
      ['HT-PG-100'],
    );
    expect(Number(count.rows[0].n)).toBe(3); // BD-1 upserted, not duplicated

    const summary = await summarizeExecutionFlows(ctx, 'HT-PG-100');
    expect(summary).toHaveLength(2);
    const inRow = summary.find((s) => s.direction === 'in')!;
    expect(inRow.entryCount).toBe(2);
    expect(inRow.totalAmount).toBe(2000); // null excluded
    expect(inRow.totalQuantityTon).toBe(50); // 20 + 30
    expect(inRow.lastVoucherDate).toBe('2024-03-01');
    const outRow = summary.find((s) => s.direction === 'out')!;
    expect(outRow.entryCount).toBe(1);
    expect(outRow.totalAmount).toBe(500);
  });

  // ---- self_parties 自主体名单(Task A) ----------------------------------------

  it('migratePostgres 建 self_parties 表; add/list/remove roundtrip + 幂等', async () => {
    // migratePostgres 在 beforeAll 已跑: 表必须存在。
    const table = await ctx.pool.query("SELECT to_regclass('public.self_parties') AS t");
    expect(table.rows[0]?.t).toBeTruthy();

    expect(await addSelfParty(ctx, '浙江浙能富兴燃料有限公司', 'u1')).toBe(true);
    // 精确重复 -> 第二次 false(先读后插 + ON CONFLICT (name) DO NOTHING 兜底)。
    expect(await addSelfParty(ctx, '浙江浙能富兴燃料有限公司', 'u1')).toBe(false);
    // 归一化重复(全角括号)同样 false。
    expect(await addSelfParty(ctx, '华能（上海）', 'u1')).toBe(true);
    expect(await addSelfParty(ctx, '华能上海', 'u1')).toBe(false);

    const rows = await listSelfParties(ctx);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.name).sort()).toEqual(['华能（上海）', '浙江浙能富兴燃料有限公司']);
    expect(rows.every((r) => r.createdBy === 'u1' && !!r.createdAt)).toBe(true);

    expect(await removeSelfParty(ctx, '浙江浙能富兴燃料有限公司')).toBe(true);
    expect(await removeSelfParty(ctx, '浙江浙能富兴燃料有限公司')).toBe(false);
    expect(await listSelfParties(ctx)).toHaveLength(1);
  });
});
