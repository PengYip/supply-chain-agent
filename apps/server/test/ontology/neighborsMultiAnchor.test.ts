// apps/server/test/ontology/neighborsMultiAnchor.test.ts
// P2 跨空间逐跳(spec 2026-09-09)：BFS 中途可达的 TradeContract / 收发单据源节点
// 也展开文档血缘。沿 neighborsLineage 范式 mock graph/repo 读写路径。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

/** 锚点 ServiceCostEvent --ALLOCATE_TO--> TradeContract C1（BFS 一跳可达合同）。 */
async function seedCostToContract() {
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
  return s;
}

describe('getNeighbors cross-space hops (P2 multi-anchor lineage)', () => {
  it('expands document lineage for a contract reached mid-traversal', async () => {
    const s = await seedCostToContract();
    graphRepoMocks.findEntities.mockResolvedValue([
      { elementId: 'e-contract', kind: 'Contract', name: 'ht-demo-001', props: {} },
    ]);
    graphRepoMocks.graphQuery.mockResolvedValue({
      subject: { elementId: 'e-contract', kind: 'Contract', name: 'ht-demo-001', props: {} },
      nodes: [
        { elementId: 'e-d1', kind: 'Document', name: 'doc-uuid-9', props: { docId: 'doc-uuid-9', docType: '发票' } },
      ],
      edges: [
        { elementId: 're-9', type: 'references', srcId: 'e-contract', dstId: 'e-d1', props: {}, confidence: 0.9 },
      ],
    });

    const res = await getNeighbors(ctx, { type: 'ServiceCostEvent', id: s, depth: 1 }, 'u1');

    expect(res.lineage.available).toBe(true);
    expect(res.lineage.bridgesExpanded).toBe(1);
    const doc = res.nodes.find((n) => n.entityType === 'Document');
    expect(doc?.id).toBe('doc-uuid-9');
    // lineage 边桥接到 BFS 已有的 TradeContract 节点(台账 id 键空间)
    const edge = res.edges.find((e) => e.origin === 'lineage');
    expect(edge).toMatchObject({
      relation: 'references',
      fromType: 'TradeContract', fromId: 'C1',
      toType: 'Document', toId: 'doc-uuid-9',
    });
  });

  it('degrades silently when the mid-traversal contract bridge misses the graph', async () => {
    const s = await seedCostToContract();
    graphRepoMocks.findEntities.mockResolvedValue([]);
    const res = await getNeighbors(ctx, { type: 'ServiceCostEvent', id: s, depth: 1 }, 'u1');
    expect(res.lineage.available).toBe(true);
    expect(res.lineage.bridgesExpanded).toBe(0);
    expect(res.nodes.some((n) => n.entityType === 'Document')).toBe(false);
    // 本体侧邻接不受影响
    expect(res.nodes.some((n) => n.entityType === 'TradeContract')).toBe(true);
  });

  it('stops cross-space expansion at the node cap (scale guard)', async () => {
    const s = await seedCostToContract();
    graphRepoMocks.findEntities.mockResolvedValue([
      { elementId: 'e-contract', kind: 'Contract', name: 'ht-demo-001', props: {} },
    ]);
    graphRepoMocks.graphQuery.mockResolvedValue({
      subject: { elementId: 'e-contract', kind: 'Contract', name: 'ht-demo-001', props: {} },
      nodes: [
        { elementId: 'e-d1', kind: 'Document', name: 'doc-1', props: { docId: 'doc-1', docType: '发票' } },
        { elementId: 'e-d2', kind: 'Document', name: 'doc-2', props: { docId: 'doc-2', docType: '收货单' } },
      ],
      edges: [],
    });
    // maxNodes=1：本体邻接(ServiceCost 锚点不进 nodes, TradeContract 1 个)已达上限，
    // 跨空间展开守卫触发即停。
    const res = await getNeighbors(ctx, { type: 'ServiceCostEvent', id: s, depth: 1 }, 'u1', { maxNodes: 1 });
    expect(res.lineage.bridgesExpanded).toBe(0);
    expect(res.nodes.some((n) => n.entityType === 'Document')).toBe(false);
  });
});
