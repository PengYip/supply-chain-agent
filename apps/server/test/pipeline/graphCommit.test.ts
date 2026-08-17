import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import {
  createDocumentStub, saveExtraction, setReviewStatus, getReviewSnapshot,
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
});
