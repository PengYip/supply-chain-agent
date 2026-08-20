import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate, type DbContext } from '../../../src/pipeline/db/client.js';
import {
  saveDocument, loadDocument, saveExtraction, saveBinding, listBindingsForContract,
  saveDocumentTags, listDocumentTags, countDocuments, countExtractionsNeedingReview,
  deleteDocument, listBindingProposals, updateBindingStatus, findBindingByDocAndContract,
} from '../../../src/pipeline/db/repositories.js';
import type { BlockModel } from '../../../src/pipeline/types.js';

function mkModel(docId: string): BlockModel {
  return {
    docId, docType: '合同', modality: 'digital',
    blocks: [{ id: 'b1', type: 'kv', text: '合同号: HT-2024-001', page: 1, bbox: null, ocrConfidence: 1 }],
    sourceUri: 'file:///x', createdAt: '2026-08-05T00:00:00.000Z',
  };
}

let ctx: ReturnType<typeof createDb>;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
});

describe('repositories', () => {
  it('round-trips a document BlockModel', async () => {
    const id = await saveDocument(ctx, mkModel('DOC-1'));
    expect(id).toBe('DOC-1');
    const loaded = await loadDocument(ctx, 'DOC-1');
    expect(loaded?.blocks[0].text).toBe('合同号: HT-2024-001');
  });

  it('saves and lists an extraction + binding', async () => {
    await saveDocument(ctx, mkModel('DOC-1'));
    const exId = await saveExtraction(ctx, {
      documentId: 'DOC-1', docType: '合同',
      fields: { 合同号: { value: 'HT-2024-001', sourceSpans: [{ blockId: 'b1', start: 5, end: 16 }] } },
      fieldMeta: { 合同号: { strength: 'exact', confidence: 0.98 } },
      overallConfidence: 0.98, needsReview: false,
    });
    expect(exId).toMatch(/^EX-/);
    const bId = await saveBinding(ctx, {
      documentId: 'DOC-1', contractNo: 'HT-2024-001', relation: 'primary',
      sourceRefs: [{ blockId: 'b1', start: 5, end: 16 }], confidence: 0.98, createdBy: 'agent',
    });
    expect(bId).toMatch(/^BD-/);
    const list = await listBindingsForContract(ctx, 'HT-2024-001');
    expect(list).toHaveLength(1);
    expect(list[0].documentId).toBe('DOC-1');
  });

  it('saveDocumentTags is idempotent per (document, tag, source, user)', async () => {
    // Seed a real document row so the document_tags FK is satisfied.
    await saveDocument(ctx, mkModel('DOC-TAG-1'));
    const userId = 'user-1';
    const tags = ['合同', '信用证'];

    // First write: seeds both rows.
    await saveDocumentTags(ctx, 'DOC-TAG-1', tags, 'auto', userId);
    const rowsBefore = await listDocumentTags(ctx, 'DOC-TAG-1', userId);
    expect(rowsBefore).toHaveLength(2);

    // Second write with the SAME (document, tag, source, user): MUST not grow.
    // This is the load-bearing invariant -- fails if anyone removes the dedup
    // guard (and the UNIQUE index backstop turns a regression into a loud
    // constraint error instead of silent duplicate rows).
    await saveDocumentTags(ctx, 'DOC-TAG-1', tags, 'auto', userId);
    const rowsAfter = await listDocumentTags(ctx, 'DOC-TAG-1', userId);

    // No-growth + order stability (both queries use the same ORDER BY tag ASC).
    expect(rowsAfter).toEqual(rowsBefore);
    expect(rowsAfter).toHaveLength(2);
    // Pin the exact survivor set (order-independent content check).
    expect(rowsAfter.map((r) => r.tag).sort()).toEqual(['信用证', '合同']);
    expect(rowsAfter.every((r) => r.source === 'auto')).toBe(true);
  });
});

describe('countDocuments / countExtractionsNeedingReview', () => {
  let ctx: DbContext;
  beforeEach(() => {
    ctx = createDb(':memory:');
    migrate(ctx.sqlite);
    ctx.sqlite
      .prepare(
        "INSERT INTO documents (id, doc_type, modality, source_uri, block_model, user_id, created_at) VALUES ('d1','合同','digital','s','{}','alice',datetime('now'))",
      )
      .run();
    ctx.sqlite
      .prepare(
        "INSERT INTO documents (id, doc_type, modality, source_uri, block_model, user_id, created_at) VALUES ('d2','发票','digital','s','{}','',datetime('now'))",
      )
      .run();
    ctx.sqlite
      .prepare(
        "INSERT INTO extractions (id, document_id, doc_type, fields, field_meta, overall_confidence, needs_review, user_id, created_at) VALUES ('e1','d1','合同','[]','{}',0.8,1,'alice',datetime('now'))",
      )
      .run();
    ctx.sqlite
      .prepare(
        "INSERT INTO extractions (id, document_id, doc_type, fields, field_meta, overall_confidence, needs_review, user_id, created_at) VALUES ('e2','d2','发票','[]','{}',0.9,0,'',datetime('now'))",
      )
      .run();
  });

  it('counts documents scoped by userId plus legacy rows', async () => {
    expect(await countDocuments(ctx, 'alice')).toBe(2); // d1 (alice) + d2 (legacy '')
  });

  it('counts extractions needing review scoped by userId plus legacy rows', async () => {
    expect(await countExtractionsNeedingReview(ctx, 'alice')).toBe(1); // only e1 (needs_review=1)
  });

  it('with no userId counts only legacy rows', async () => {
    expect(await countDocuments(ctx)).toBe(1); // only d2 (user_id='')
    expect(await countExtractionsNeedingReview(ctx)).toBe(0); // e2 legacy but needs_review=0
  });
});

describe('deleteDocument (cascade)', () => {
  let ctx: DbContext;
  const userId = 'alice';
  beforeEach(() => {
    ctx = createDb(':memory:');
    migrate(ctx.sqlite);
    // Seed a full doc stack under alice (D1) + a second doc (D2) for isolation.
    ctx.sqlite
      .prepare(
        "INSERT INTO documents (id, doc_type, modality, source_uri, block_model, user_id, created_at) VALUES ('D1','合同','digital','s','{}','alice',datetime('now'))",
      )
      .run();
    ctx.sqlite
      .prepare(
        "INSERT INTO documents (id, doc_type, modality, source_uri, block_model, user_id, created_at) VALUES ('D2','发票','digital','s','{}','alice',datetime('now'))",
      )
      .run();
    // 2 chunks with explicit ids (so the fts rowid assertion is deterministic).
    ctx.sqlite
      .prepare(
        "INSERT INTO doc_chunk (id, document_id, chunk_text, chunk_index, created_at) VALUES (1, 'D1', 'chunk1', 0, datetime('now'))",
      )
      .run();
    ctx.sqlite
      .prepare(
        "INSERT INTO doc_chunk (id, document_id, chunk_text, chunk_index, created_at) VALUES (2, 'D1', 'chunk2', 1, datetime('now'))",
      )
      .run();
    // doc_chunk_fts external-content index entries (rowid = doc_chunk.id).
    ctx.sqlite
      .prepare('INSERT INTO doc_chunk_fts (rowid, chunk_text) VALUES (1, \'chunk1\')')
      .run();
    ctx.sqlite
      .prepare('INSERT INTO doc_chunk_fts (rowid, chunk_text) VALUES (2, \'chunk2\')')
      .run();
    // Stage tables (Phase 2).
    ctx.sqlite
      .prepare(
        "INSERT INTO extractions (id, document_id, doc_type, fields, field_meta, overall_confidence, needs_review, user_id, created_at) VALUES ('E1','D1','合同','[]','{}',0.9,0,'alice',datetime('now'))",
      )
      .run();
    ctx.sqlite
      .prepare(
        "INSERT INTO classifications (id, document_id, doc_type, confidence, source, hint, user_id, created_at) VALUES ('CL1','D1','合同',0.9,'classified',NULL,'alice',datetime('now'))",
      )
      .run();
    ctx.sqlite
      .prepare(
        "INSERT INTO bindings (id, document_id, contract_no, relation, source_refs, confidence, created_by, user_id, created_at) VALUES ('BD1','D1','HT','primary','[]',0.9,'agent','alice',datetime('now'))",
      )
      .run();
    ctx.sqlite
      .prepare(
        "INSERT INTO document_tags (id, document_id, tag, source, user_id, created_at) VALUES ('TG1','D1','重要','explicit','alice',datetime('now'))",
      )
      .run();
  });

  it('removes the documents row and all dependents (chunks/fts/extractions/classifications/bindings/document_tags)', async () => {
    expect(await loadDocument(ctx, 'D1', userId)).toBeTruthy();
    const res = await deleteDocument(ctx, 'D1', userId);
    expect(res.deleted).toBe(true);

    // documents row gone.
    expect(await loadDocument(ctx, 'D1', userId)).toBeNull();
    // dependents gone (raw check by document_id).
    const chk = (table: string) =>
      ctx.sqlite.prepare(`SELECT 1 FROM ${table} WHERE document_id = ?`).get('D1');
    expect(chk('doc_chunk')).toBeUndefined();
    expect(chk('extractions')).toBeUndefined();
    expect(chk('classifications')).toBeUndefined();
    expect(chk('bindings')).toBeUndefined();
    expect(chk('document_tags')).toBeUndefined();
    // fts index entries (by chunk rowid) gone.
    expect(
      ctx.sqlite.prepare('SELECT 1 FROM doc_chunk_fts WHERE rowid IN (1,2) LIMIT 1').get(),
    ).toBeUndefined();
    // (doc_chunk_vec is optional — only exists when sqlite-vec loads; the repo
    // fn guards its delete on table existence, so it is not seeded/asserted here.)
  });

  it('deleteDocument on a missing docId returns { deleted: false } and is a no-op', async () => {
    expect((await deleteDocument(ctx, 'nope', userId)).deleted).toBe(false);
    expect(await loadDocument(ctx, 'D1', userId)).toBeTruthy(); // untouched
  });

  it('deleteDocument respects userId isolation (other user cannot delete)', async () => {
    expect((await deleteDocument(ctx, 'D1', 'bob')).deleted).toBe(false);
    expect(await loadDocument(ctx, 'D1', userId)).toBeTruthy(); // still present
    expect(await loadDocument(ctx, 'D2', userId)).toBeTruthy(); // untouched
  });
});

describe('Phase B: bindings 状态机', () => {
  let ctx: ReturnType<typeof createDb>;
  beforeEach(() => {
    ctx = createDb(':memory:');
    migrate(ctx.sqlite);
    saveDocument(ctx, mkModel('DOC-PB-1'));
  });

  it('saveBinding 写新列(status/confirmation_source/proposed_by/evidence), 旧调用默认 confirmed', async () => {
    // 旧签名(无状态参数) -> status 默认 confirmed。
    const _legacyId = await saveBinding(ctx, {
      documentId: 'DOC-PB-1', contractNo: 'HT-OLD-001', relation: 'primary',
      sourceRefs: [], confidence: 0.9, createdBy: 'agent',
    });
    const legacy = (await listBindingsForContract(ctx, 'HT-OLD-001'))[0]!;
    expect(legacy.status).toBe('confirmed');
    expect(legacy.confirmationSource).toBeNull();
    expect(legacy.proposedBy).toBeNull();
    expect(legacy.evidence).toBeNull();

    // 新签名 -> 全部落库。
    const proposedId = await saveBinding(ctx, {
      documentId: 'DOC-PB-1', contractNo: 'HT-NEW-001', relation: '付款',
      sourceRefs: [], confidence: 0.85, createdBy: 'system',
      status: 'proposed', confirmationSource: null, proposedBy: 'system',
      evidence: { partyScore: 0.9, timeScore: 0.9, amountScore: 0.5, qtyScore: 0.5, details: ['x'] },
    });
    const proposed = (await listBindingsForContract(ctx, 'HT-NEW-001'))[0]!;
    expect(proposed.status).toBe('proposed');
    expect(proposed.proposedBy).toBe('system');
    expect(proposed.evidence?.details).toEqual(['x']);
    expect(proposedId).toMatch(/^BD-/);
  });

  it('findBindingByDocAndContract 定位 (document, contract)', async () => {
    await saveBinding(ctx, {
      documentId: 'DOC-PB-1', contractNo: 'HT-F-001', relation: '付款',
      sourceRefs: [], confidence: 0.8, createdBy: 'system',
      status: 'proposed', proposedBy: 'system',
    });
    const row = await findBindingByDocAndContract(ctx, 'DOC-PB-1', 'HT-F-001');
    expect(row?.status).toBe('proposed');
    expect(await findBindingByDocAndContract(ctx, 'DOC-PB-1', 'NOPE')).toBeNull();
  });

  it('listBindingProposals join documents 取 doc_type/filename, 按 status 过滤', async () => {
    await saveBinding(ctx, {
      documentId: 'DOC-PB-1', contractNo: 'HT-P1-001', relation: '付款',
      sourceRefs: [], confidence: 0.85, createdBy: 'system',
      status: 'proposed', proposedBy: 'system',
      evidence: { partyScore: 0.9, timeScore: 0.9, amountScore: 0.5, qtyScore: 0.5, details: [] },
    });
    await saveBinding(ctx, {
      documentId: 'DOC-PB-1', contractNo: 'HT-P2-001', relation: '付款',
      sourceRefs: [], confidence: 0.99, createdBy: 'system',
      status: 'confirmed', confirmationSource: 'auto_rule', proposedBy: 'system',
    });

    const proposed = await listBindingProposals(ctx);
    expect(proposed).toHaveLength(1);
    expect(proposed[0]!.contractNo).toBe('HT-P1-001');
    expect(proposed[0]!.status).toBe('proposed');
    expect(proposed[0]!.docType).toBe('合同');
    expect(proposed[0]!.fileName).toBe('x'); // mkModel sourceUri 'file:///x'

    const confirmed = await listBindingProposals(ctx, undefined, 'confirmed');
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]!.contractNo).toBe('HT-P2-001');
    expect(confirmed[0]!.confirmationSource).toBe('auto_rule');
  });

  it('updateBindingStatus 确认/拒绝流转', async () => {
    const id = await saveBinding(ctx, {
      documentId: 'DOC-PB-1', contractNo: 'HT-U-001', relation: '付款',
      sourceRefs: [], confidence: 0.8, createdBy: 'system',
      status: 'proposed', proposedBy: 'system',
    });
    const ok = await updateBindingStatus(ctx, id, 'confirmed', 'human');
    expect(ok).toBe(true);
    const row = (await listBindingsForContract(ctx, 'HT-U-001'))[0]!;
    expect(row.status).toBe('confirmed');
    expect(row.confirmationSource).toBe('human');
    // 不存在的 id -> false。
    expect(await updateBindingStatus(ctx, 'nope', 'rejected', 'human')).toBe(false);
  });
});
