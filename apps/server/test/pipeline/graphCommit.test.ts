import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import {
  createDocumentStub, saveExtraction, setReviewStatus, getReviewSnapshot, updateExtractionFields,
  addSelfParty, setDocumentBatchRole, saveDocumentUnits,
} from '../../src/pipeline/db/repositories.js';
import { commitDocumentGraph, syncDocumentTypeToGraph } from '../../src/pipeline/graphCommit.js';
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
    // entities 透传 writer 的 writtenEntities（归一化名）。
    expect(status.entities).toEqual([
      { kind: 'Contract', name: 'HT-1' },
      { kind: 'Party', name: '中石化', role: '卖方' },
    ]);
    const snap = await getReviewSnapshot(ctx, id);
    expect(snap?.graphStatus).toEqual(status);
    expect(snap?.graphStatus?.entities).toEqual(status.entities);
  });

  it('未知文档返回 failed(document_or_extraction_not_found)', async () => {
    const status = await commitDocumentGraph(ctx, 'DOC-missing', 'user-1', okIo);
    expect(status.status).toBe('failed');
    expect(status.reason).toBe('document_or_extraction_not_found');
    expect(status.entities).toBeUndefined();
  });

  it('图提交时 Document 与 Contract 实体 props 带合同类型(快照派生)', async () => {
    await addSelfParty(ctx, '我方贸易', 'user-1');
    const { docId } = await createDocumentStub(ctx, { sourceUri: 'file:///c.pdf', docType: '合同' });
    await saveExtraction(ctx, {
      documentId: docId, docType: '合同',
      fields: {
        合同号: { value: 'HT-9', sourceSpans: [] },
        甲方: { value: '我方贸易', sourceSpans: [] },
        乙方: { value: '某供应商', sourceSpans: [] },
      },
      fieldMeta: {
        合同号: { strength: 'exact', confidence: 0.95 },
        甲方: { strength: 'exact', confidence: 0.9 },
        乙方: { strength: 'exact', confidence: 0.9 },
      },
      overallConfidence: 0.9, needsReview: false,
    });
    await setReviewStatus(ctx, docId, 'confirmed');
    const created: Array<{ kind: string; props: Record<string, unknown> }> = [];
    const io: GraphWriterIo = {
      createEntity: async ({ kind, name, props }) => {
        created.push({ kind, props: props ?? {} });
        return { elementId: `el-${kind}-${name}`, kind, name, props: props ?? {}, created: true };
      },
      mergeEdge: async () => ({}),
    };
    const status = await commitDocumentGraph(ctx, docId, 'user-1', io);
    expect(status.status).toBe('ok');
    // 甲方=主体 -> 采购; 快照派生的 contractType 进入 Document 与 Contract props。
    const docNode = created.find((c) => c.kind === 'Document');
    const contractNode = created.find((c) => c.kind === 'Contract');
    expect(docNode?.props.contractType).toBe('采购');
    expect(contractNode?.props.contractType).toBe('采购');
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
    expect(status.entities).toBeUndefined();
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

describe('syncDocumentTypeToGraph (F3)', () => {
  // 与 commitDocumentGraph 同门禁: 需要 NEO4J_PASSWORD 打开 writer 的 gate。
  let prevPassword: string | undefined;
  beforeAll(() => {
    prevPassword = process.env.NEO4J_PASSWORD;
    process.env.NEO4J_PASSWORD = 'graphwriter-test-dummy';
  });
  afterAll(() => {
    if (prevPassword !== undefined) process.env.NEO4J_PASSWORD = prevPassword;
    else delete process.env.NEO4J_PASSWORD;
  });

  it('调用 createEntity 写入 Document 节点 props {docId, docType}', async () => {
    const calls: Array<{ kind: string; name: string; props?: Record<string, unknown> }> = [];
    const io: GraphWriterIo = {
      createEntity: async ({ kind, name, props }) => {
        calls.push({ kind, name, props });
        return { elementId: `el-${kind}-${name}`, kind, name, props: props ?? {}, created: true };
      },
      mergeEdge: async () => ({}),
    };
    await syncDocumentTypeToGraph('DOC-1', '发票', io);
    expect(calls).toEqual([
      { kind: 'Document', name: 'DOC-1', props: { docId: 'DOC-1', docType: '发票' } },
    ]);
  });

  it('NEO4J_PASSWORD 未设 -> 跳过, 不调用 io', async () => {
    const prev = process.env.NEO4J_PASSWORD;
    delete process.env.NEO4J_PASSWORD;
    try {
      const io: GraphWriterIo = {
        createEntity: async () => { throw new Error('should not be called'); },
        mergeEdge: async () => ({}),
      };
      await expect(syncDocumentTypeToGraph('DOC-1', '发票', io)).resolves.toBeUndefined();
    } finally {
      if (prev !== undefined) process.env.NEO4J_PASSWORD = prev;
    }
  });
});

// ---- P3 谱系(批量拆分器 Phase 3): container 提交门控 + batchRole prop -------

describe('commitDocumentGraph batch lineage (P3)', () => {
  let prevPassword: string | undefined;
  beforeAll(() => {
    prevPassword = process.env.NEO4J_PASSWORD;
    process.env.NEO4J_PASSWORD = 'graphwriter-test-dummy';
  });
  afterAll(() => {
    if (prevPassword !== undefined) process.env.NEO4J_PASSWORD = prevPassword;
    else delete process.env.NEO4J_PASSWORD;
  });

  function trackingIo() {
    const created: Array<{ kind: string; name: string; props: Record<string, unknown> }> = [];
    const edgeCalls: Array<Record<string, unknown>> = [];
    const io: GraphWriterIo = {
      createEntity: async ({ kind, name, props }) => {
        created.push({ kind, name, props: props ?? {} });
        return { elementId: `el-${kind}-${name}`, kind, name, props: props ?? {}, created: true };
      },
      mergeEdge: async (input) => { edgeCalls.push(input); return {}; },
    };
    return { io, created, edgeCalls };
  }

  it('container snapshot 确认: 只写 Document 节点, 不派生实体/业务边(门控)', async () => {
    // container 刻意带 extraction 字段: 证明是门控跳过了派生, 而非字段为空。
    const { docId } = await createDocumentStub(ctx, { sourceUri: 'file:///batch.pdf', docType: '合同' });
    await setDocumentBatchRole(ctx, docId, 'container');
    await saveExtraction(ctx, {
      documentId: docId, docType: '合同',
      fields: { 合同号: { value: 'HT-B1', sourceSpans: [] } },
      fieldMeta: { 合同号: { strength: 'exact', confidence: 0.95 } },
      overallConfidence: 0.95, needsReview: false,
    });
    await setReviewStatus(ctx, docId, 'confirmed');
    const { io, created, edgeCalls } = trackingIo();
    const status = await commitDocumentGraph(ctx, docId, 'user-1', io);
    expect(status.status).toBe('ok');
    expect(status.nodeCount).toBe(1);
    expect(status.edgeCount).toBe(0);
    expect(created).toHaveLength(1);
    expect(created[0]!.kind).toBe('Document');
    expect(edgeCalls).toHaveLength(0);
    expect(status.entities).toBeUndefined();
  });

  it('container Document 节点带 batchRole=container prop(无 docType 决策对 unit 不适用, container 不携带业务 docType)', async () => {
    const { docId } = await createDocumentStub(ctx, { sourceUri: 'file:///batch.pdf' });
    await setDocumentBatchRole(ctx, docId, 'container');
    await setReviewStatus(ctx, docId, 'confirmed');
    const { io, created } = trackingIo();
    await commitDocumentGraph(ctx, docId, 'user-1', io);
    const docNode = created.find((c) => c.kind === 'Document')!;
    expect(docNode.props.batchRole).toBe('container');
  });

  it('unit snapshot 确认: Document 节点带 batchRole=unit prop', async () => {
    const { docId: containerId } = await createDocumentStub(ctx, { sourceUri: 'file:///b.pdf' });
    await setDocumentBatchRole(ctx, containerId, 'container');
    const { docId: childId } = await createDocumentStub(ctx, { sourceUri: 'file:///b.pdf' });
    await setDocumentBatchRole(ctx, childId, 'unit');
    await saveDocumentUnits(ctx, [
      { parentDocumentId: containerId, childDocumentId: childId, unitIndex: 1, docType: '汽运磅单' },
    ]);
    await saveExtraction(ctx, {
      documentId: childId, docType: '汽运磅单',
      fields: { 编号: { value: '10384417', sourceSpans: [] } },
      fieldMeta: { 编号: { strength: 'none', confidence: 0.9 } },
      overallConfidence: 0.9, needsReview: false,
    });
    await setReviewStatus(ctx, childId, 'confirmed');
    const { io, created } = trackingIo();
    const status = await commitDocumentGraph(ctx, childId, 'user-1', io);
    expect(status.status).toBe('ok');
    const docNode = created.find((c) => c.kind === 'Document')!;
    expect(docNode.props.batchRole).toBe('unit');
  });

  it('普通文档 Document 节点不带 batchRole prop(零行为变化)', async () => {
    const id = await seedInvoice();
    await setReviewStatus(ctx, id, 'confirmed');
    const { io, created } = trackingIo();
    await commitDocumentGraph(ctx, id, 'user-1', io);
    const docNode = created.find((c) => c.kind === 'Document')!;
    expect(docNode.props.batchRole).toBeUndefined();
  });
});
