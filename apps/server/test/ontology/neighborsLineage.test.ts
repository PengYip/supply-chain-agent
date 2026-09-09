// apps/server/test/ontology/neighborsLineage.test.ts
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';

const graphRepoMocks = vi.hoisted(() => ({
  findEntities: vi.fn(),
  graphQuery: vi.fn(),
}));
vi.mock('../../src/graph/repo.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/graph/repo.js')>();
  return { ...mod, ...graphRepoMocks };
});
const { getNeighbors } = await import('../../src/ontology/neighbors.js');
const { insertTradeFact, insertOntologyEdge } = await import('../../src/ontology/repo.js');

let ctx: DbContext;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
  graphRepoMocks.findEntities.mockReset();
  graphRepoMocks.graphQuery.mockReset();
  process.env.NEO4J_PASSWORD = 'test-set';
});
afterEach(() => {
  delete process.env.NEO4J_PASSWORD;
});

const insertContract = (id: string, contractNo: string) => {
  ctx.sqlite.prepare(
    `INSERT INTO contract_ledger (id, contract_no, display_contract_no, doc_type, document_id,
        title, fields, field_meta, overall_confidence, needs_review, user_id, contract_type)
     VALUES (?, ?, ?, '合同', 'doc-1', '', '{}', '{}', 1, 0, '', '采购')`,
  ).run(id, contractNo, contractNo);
};

const G_ENTITY = (elementId: string, name: string, props: Record<string, unknown> = {}) =>
  ({ elementId, kind: (props['docId'] || props['batchRole']) ? 'Document' : 'Contract', name, props });

describe('getNeighbors lineage merge (mocked graph)', () => {
  it('contract anchor merges Neo4j document neighborhood keyed by docId', async () => {
    insertContract('C1', 'HT-DEMO-001');
    // 合同锚点：无本体边，纯血缘(findEntities 命中与否由 normalizeName 查询决定，此处直接回一个命中)
    graphRepoMocks.findEntities.mockResolvedValue([
      G_ENTITY('e-contract', 'ht-demo-001'),
    ]);
    graphRepoMocks.graphQuery.mockResolvedValue({
      subject: G_ENTITY('e-contract', 'ht-demo-001'),
      nodes: [
        G_ENTITY('e-d1', 'doc-uuid-1', { docId: 'doc-uuid-1', docType: '发票' }),
        G_ENTITY('e-d2', 'doc-uuid-2', { docId: 'doc-uuid-2', docType: '收货单' }),
      ],
      edges: [
        { elementId: 're-1', type: 'references', srcId: 'e-contract', dstId: 'e-d1', props: {}, confidence: 0.9 },
        { elementId: 're-2', type: 'executes', srcId: 'e-contract', dstId: 'e-d2', props: {}, confidence: 0.8 },
      ],
    });

    const res = await getNeighbors(ctx, { type: 'TradeContract', id: 'C1', depth: 1 }, 'u1');
    expect(res.lineage).toEqual({ available: true, subjectFound: true, bridgesExpanded: 0 });
    const docNodes = res.nodes.filter((n) => n.source === 'neo4j');
    expect(docNodes.map((n) => n.id).sort()).toEqual(['doc-uuid-1', 'doc-uuid-2']);
    expect(docNodes.every((n) => n.entityType === 'Document')).toBe(true);
    const lineageEdges = res.edges.filter((e) => e.origin === 'lineage');
    expect(lineageEdges).toHaveLength(2);
    const ref = lineageEdges.find((e) => e.relation === 'references')!;
    expect(ref.fromId).toBe('C1');           // 合同锚点侧映射回台账 id
    expect(ref.toId).toBe('doc-uuid-1');     // 文档侧映射回 docId
  });

  it('document anchor traverses CONTAINS lineage only (edgeKinds, D7)', async () => {
    ctx.sqlite.prepare(
      `INSERT INTO documents (id, doc_type, modality, source_uri, block_model, user_id, review_status, parse_status)
       VALUES ('D1', '收货单', 'text', '/ingest/x.pdf', 'raw', 'u1', 'pending', 'uploaded')`,
    ).run();
    graphRepoMocks.findEntities.mockResolvedValue([G_ENTITY('e-d1', 'D1', { docId: 'D1' })]);
    graphRepoMocks.graphQuery.mockResolvedValue({
      subject: G_ENTITY('e-d1', 'D1', { docId: 'D1' }),
      nodes: [G_ENTITY('e-u1', 'unit-1', { docId: 'unit-1', batchRole: 'unit' })],
      edges: [{ elementId: 'rc-1', type: 'CONTAINS', srcId: 'e-d1', dstId: 'e-u1',
        props: { unitIndex: 1, pages: 'p1-p3' }, confidence: 0 }],
    });

    const res = await getNeighbors(ctx, { type: 'GoodsReceiptEvent', id: 'D1', depth: 1 }, 'u1');
    expect(graphRepoMocks.graphQuery.mock.calls[0]![0]).toMatchObject({
      subjectId: 'e-d1', edgeKinds: ['CONTAINS'], direction: 'both',
    });
    expect(res.nodes.some((n) => n.id === 'unit-1' && n.label === '拆单单元')).toBe(true);
    const contains = res.edges.find((e) => e.relation === 'CONTAINS')!;
    expect(contains.params).toEqual({ unitIndex: 1, pages: 'p1-p3' });
  });

  it('event anchors never touch the graph (no TF counterpart)', async () => {
    const fid = await insertTradeFact(ctx, {
      entityType: 'InvoiceEvent',
      payload: { invoiceNo: 'INV-1', invoiceType: '销项', eventBizType: '正向', amount: 1, currency: 'CNY' },
      validAt: '2026-06-10', createdBy: 'test',
    }, 'u1');
    await getNeighbors(ctx, { type: 'InvoiceEvent', id: fid, depth: 1 }, 'u1');
    expect(graphRepoMocks.findEntities).not.toHaveBeenCalled();
    expect(graphRepoMocks.graphQuery).not.toHaveBeenCalled();
  });

  it('no graph subject -> subjectFound false, still available', async () => {
    insertContract('C1', 'HT-DEMO-001');
    graphRepoMocks.findEntities.mockResolvedValue([]);
    const res = await getNeighbors(ctx, { type: 'TradeContract', id: 'C1', depth: 1 }, 'u1');
    expect(res.lineage).toEqual({ available: true, subjectFound: false, bridgesExpanded: 0 });
    expect(graphRepoMocks.graphQuery).not.toHaveBeenCalled();
  });

  it('NEO4J_PASSWORD unset -> graceful degradation, ontology part intact (D5)', async () => {
    delete process.env.NEO4J_PASSWORD;
    insertContract('C1', 'HT-DEMO-001');
    const s = await insertTradeFact(ctx, {
      entityType: 'ServiceCostEvent',
      payload: { eventBizType: '正向', amount: 50_000, currency: 'CNY', costType: '物流' },
      validAt: '2026-06-01', createdBy: 'test',
    }, 'u1');
    await insertOntologyEdge(ctx, {
      relation: 'ALLOCATE_TO', fromType: 'ServiceCostEvent', fromId: s,
      toType: 'TradeContract', toId: 'C1',
      params: { amount: 50_000, method: '金额' }, validAt: '2026-06-01', createdBy: 'test',
    }, 'u1');
    const res = await getNeighbors(ctx, { type: 'TradeContract', id: 'C1', depth: 1 }, 'u1');
    expect(res.lineage).toEqual({ available: false, subjectFound: false, bridgesExpanded: 0 });
    expect(res.edges).toHaveLength(1);   // 本体部分照常
    expect(graphRepoMocks.findEntities).not.toHaveBeenCalled();
  });

  it('graph layer failure does not sink the ontology adjacency', async () => {
    insertContract('C1', 'HT-DEMO-001');
    graphRepoMocks.findEntities.mockRejectedValue(new Error('Neo4jError: connection refused'));
    const res = await getNeighbors(ctx, { type: 'TradeContract', id: 'C1', depth: 1 }, 'u1');
    expect(res.lineage.available).toBe(false);
    expect(res.anchorNode.source).toBe('contract_ledger');
  });
});