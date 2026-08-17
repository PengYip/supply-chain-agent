import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import {
  createDocumentStub, saveExtraction, setReviewStatus, getReviewSnapshot, updateExtractionFields,
} from '../../src/pipeline/db/repositories.js';
import { commitDocumentGraph } from '../../src/pipeline/graphCommit.js';
import type { GraphWriterIo } from '../../src/graph/graphWriter.js';

let ctx: DbContext;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
});

async function seedInvoice(): Promise<string> {
  const { docId } = await createDocumentStub(ctx, { sourceUri: 'file:///inv.pdf', docType: '发票' });
  await saveExtraction(ctx, {
    documentId: docId, docType: '发票',
    fields: {
      合同号: { value: 'HT-1', sourceSpans: [] },
      卖方: { value: '中石化集团有限公司', sourceSpans: [] },
    },
    fieldMeta: {
      合同号: { strength: 'exact', confidence: 0.95 },
      卖方: { strength: 'exact', confidence: 0.9 },
    },
    overallConfidence: 0.9, needsReview: false,
    proposedRelationships: [
      { kind: 'Contract', name: 'HT-1', confidence: 0.95 },
      { kind: 'Party', role: '卖方', name: '中石化集团有限公司', confidence: 0.9 },
    ],
  });
  return docId;
}

const okIo: GraphWriterIo = {
  createEntity: async ({ kind, name }) => ({ elementId: `el-${kind}-${name}`, kind, name, props: {}, created: true }),
  mergeEdge: async () => ({}),
};

describe('commitDocumentGraph', () => {
  // writeDocumentGraph gates on process.env.NEO4J_PASSWORD (graphWriter.ts);
  // the ok/failed io paths need the gate OPEN, so self-manage a sentinel like
  // the graphWriter.test.ts patch (CI has no NEO4J_PASSWORD).
  let prevPassword: string | undefined;
  beforeAll(() => {
    prevPassword = process.env.NEO4J_PASSWORD;
    process.env.NEO4J_PASSWORD = 'graphwriter-test-dummy';
  });
  afterAll(() => {
    if (prevPassword !== undefined) process.env.NEO4J_PASSWORD = prevPassword;
    else delete process.env.NEO4J_PASSWORD;
  });

  it('从持久化快照提交实体+边并落 graph_status', async () => {
    const id = await seedInvoice();
    await setReviewStatus(ctx, id, 'confirmed');
    const status = await commitDocumentGraph(ctx, id, 'user-1', okIo);
    expect(status.status).toBe('ok');
    expect(status.nodeCount).toBe(3); // Document + Contract + Party
    expect(status.edgeCount).toBe(3); // party + references + executes
    const snap = await getReviewSnapshot(ctx, id);
    expect(snap?.graphStatus).toEqual(status);
  });

  it('未知文档返回 failed(document_or_extraction_not_found)', async () => {
    const status = await commitDocumentGraph(ctx, 'DOC-missing', 'user-1', okIo);
    expect(status.status).toBe('failed');
    expect(status.reason).toBe('document_or_extraction_not_found');
  });

  it('图 io 出错不抛异常，failed 状态仍持久化', async () => {
    const id = await seedInvoice();
    await setReviewStatus(ctx, id, 'confirmed');
    const badIo: GraphWriterIo = {
      createEntity: async () => { throw new Error('neo4j down'); },
      mergeEdge: async () => { throw new Error('neo4j down'); },
    };
    const status = await commitDocumentGraph(ctx, id, undefined, badIo);
    expect(status.status).toBe('failed');
    expect(status.reason).toBe('neo4j down');
    const snap = await getReviewSnapshot(ctx, id);
    expect(snap?.graphStatus?.status).toBe('failed');
  });

  it('更正后确认：喂给 writer 的实体使用修正后名称（与边同源）', async () => {
    // P0 regression: updateExtractionFields corrects 卖方 but leaves the
    // persisted proposed_relationships column stale. Entities must be derived
    // from the CURRENT fields, not the stale column.
    const id = await seedInvoice(); // 卖方: 中石化集团有限公司
    await updateExtractionFields(ctx, id,
      {
        合同号: { value: 'HT-1', sourceSpans: [] },
        卖方: { value: '中石化修正', sourceSpans: [] },
      },
      {
        合同号: { strength: 'exact', confidence: 0.95 },
        卖方: { strength: 'exact', confidence: 1.0 },
      },
    );
    await setReviewStatus(ctx, id, 'confirmed');
    const created: Array<{ kind: string; name: string }> = [];
    const io: GraphWriterIo = {
      createEntity: async ({ kind, name }) => {
        created.push({ kind, name });
        return { elementId: `el-${kind}-${name}`, kind, name, props: {}, created: true };
      },
      mergeEdge: async () => ({}),
    };
    const status = await commitDocumentGraph(ctx, id, 'user-1', io);
    expect(status.status).toBe('ok');
    expect(created).toContainEqual({ kind: 'Party', name: '中石化修正' });
    expect(created).not.toContainEqual({ kind: 'Party', name: '中石化集团有限公司' });
  });

  it('同值双角色 party 边去重：1 条边、role 合并、edgeCount=1', async () => {
    // P1 regression: 甲方+乙方同值 -> 两条 party 边（role 买方/卖方）折叠为 1 条。
    const { docId } = await createDocumentStub(ctx, { sourceUri: 'file:///inv.pdf', docType: '其他' });
    await saveExtraction(ctx, {
      documentId: docId, docType: '其他',
      fields: {
        甲方: { value: 'A公司', sourceSpans: [] },
        乙方: { value: 'A公司', sourceSpans: [] },
      },
      fieldMeta: {
        甲方: { strength: 'exact', confidence: 0.9 },
        乙方: { strength: 'exact', confidence: 0.9 },
      },
      overallConfidence: 0.9, needsReview: false,
    });
    await setReviewStatus(ctx, docId, 'confirmed');
    const calls: Array<{ kind: string; props?: Record<string, unknown> }> = [];
    const io: GraphWriterIo = {
      createEntity: async ({ kind, name }) => ({ elementId: `el-${kind}-${name}`, kind, name, props: {}, created: true }),
      mergeEdge: async (input) => { calls.push(input); return {}; },
    };
    const status = await commitDocumentGraph(ctx, docId, 'user-1', io);
    expect(status.status).toBe('ok');
    expect(status.edgeCount).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].kind).toBe('party');
    expect(calls[0].props?.role).toBe('买方/卖方');
  });

  it('setDocumentGraphStatus 抛错时仍不抛出并返回图写入 status', async () => {
    // P2: graph_status 持久化失败（此处用 SQLite trigger 强制）只 console.error，
    // 不阻断确认流程，也不覆盖返回的图写入结果。
    const id = await seedInvoice();
    await setReviewStatus(ctx, id, 'confirmed');
    (ctx as import('../../src/pipeline/db/client.js').SqliteDbContext).sqlite.exec(
      `CREATE TRIGGER fail_graph_status BEFORE UPDATE OF graph_status ON documents
       BEGIN SELECT RAISE(ABORT, 'boom'); END`,
    );
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const status = await commitDocumentGraph(ctx, id, 'user-1', okIo);
      expect(status.status).toBe('ok');
      expect(status.nodeCount).toBe(3);
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });
});
