import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDb, migrate } from '../../src/pipeline/db/client.js';
import { addSelfParty, upsertContractLedgerEntry } from '../../src/pipeline/db/repositories.js';
import {
  syncProjectMembershipGraph,
  removeProjectMembershipGraph,
  PART_OF_EDGE,
  COUNTERPARTY_EDGE,
  PARTICIPATES_EDGE,
  TRADES_EDGE,
  type ProjectGraphSyncIo,
} from '../../src/pipeline/projectGraphSync.js';
import { buildLedgerEntryFromExtraction } from '../../src/pipeline/contractLedger.js';

// 项目归属图同步(Task 7, spec 2026-08-20 §4.3): project_memberships 是 SSOT,
// Neo4j 图是投影。NEO4J_PASSWORD 门禁 -> skipped; io 抛错 -> failed 不上抛;
// 派生边(counterparty/participates)从台账甲乙方 + 主体名单锚定。
let ctx: ReturnType<typeof createDb>;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
});

const prevPwd = process.env.NEO4J_PASSWORD;
beforeEach(() => { process.env.NEO4J_PASSWORD = 'test'; });
afterEach(() => {
  if (prevPwd === undefined) delete process.env.NEO4J_PASSWORD;
  else process.env.NEO4J_PASSWORD = prevPwd;
});

/** 记录型 fake io: 节点/边按 key 归集, 记录调用供断言。 */
function makeIo() {
  const nodes = new Map<string, string>(); // `${kind}:${name}` -> elementId
  const created: Array<{ kind: string; name: string; props?: Record<string, unknown> }> = [];
  const edges: Array<{ srcId: string; dstId: string; kind: string; props?: Record<string, unknown> }> = [];
  let seq = 0;
  const idOf = (kind: string, name: string) => {
    const key = `${kind}:${name}`;
    if (!nodes.has(key)) nodes.set(key, `e${seq++}`);
    return { elementId: nodes.get(key)! };
  };
  const io: ProjectGraphSyncIo = {
    createEntity: async (i) => {
      created.push({ kind: i.kind, name: i.name, props: i.props });
      return idOf(i.kind, i.name);
    },
    mergeEdge: async (i) => {
      edges.push({ srcId: i.srcId, dstId: i.dstId, kind: i.kind, props: i.props });
      return {};
    },
    removeEdge: async (i) => {
      const before = edges.length;
      for (let k = 0; k < edges.length; k++) {
        if (edges[k]!.srcId === i.srcId && edges[k]!.kind === i.kind && edges[k]!.dstId === i.dstId) {
          edges.splice(k, 1);
          return 1;
        }
      }
      void before;
      return 0;
    },
    findEntityByName: async (kind, name) =>
      nodes.has(`${kind}:${name}`) ? { elementId: nodes.get(`${kind}:${name}`)! } : null,
  };
  return { io, nodes, created, edges };
}

/** 种一条台账: 甲方=我方贸易(主体), 乙方=某供应商(对手方)。 */
async function seedLedger(contractNo: string) {
  const entry = buildLedgerEntryFromExtraction({
    documentId: 'DOC-1',
    docType: '合同',
    fields: {
      合同号: { value: contractNo, sourceSpans: [] },
      甲方: { value: '我方贸易', sourceSpans: [] },
      乙方: { value: '某供应商', sourceSpans: [] },
    },
    fieldMeta: {
      合同号: { strength: 'exact', confidence: 0.95 },
      甲方: { strength: 'exact', confidence: 0.9 },
      乙方: { strength: 'exact', confidence: 0.9 },
    },
  })!;
  await upsertContractLedgerEntry(ctx, entry);
}

const baseInput = {
  contractNo: 'HT-2026-001',
  projectCode: 'PRJ-2026-001',
  projectName: '曹妃甸项目',
  role: '采购',
  confidence: 0.8,
};

describe('syncProjectMembershipGraph', () => {
  it('NEO4J_PASSWORD 未设 -> skipped, io 零调用', async () => {
    delete process.env.NEO4J_PASSWORD;
    const { io, created, edges } = makeIo();
    const r = await syncProjectMembershipGraph(ctx, baseInput, io);
    expect(r.status).toBe('skipped');
    expect(created).toHaveLength(0);
    expect(edges).toHaveLength(0);
  });

  it('ok 路径: part_of + 2 counterparty + 2 participates(采购 -> 对手方=供应商)', async () => {
    await addSelfParty(ctx, '我方贸易', 'u1');
    await seedLedger('HT-2026-001');
    const { io, created, edges, nodes } = makeIo();

    const r = await syncProjectMembershipGraph(ctx, baseInput, io);
    expect(r.status).toBe('ok');

    // Project/Contract 节点已建(ensureNode: find 未命中 -> create)。
    expect(nodes.has('Project:PRJ-2026-001')).toBe(true);
    expect(nodes.has('Contract:HT-2026-001')).toBe(true);

    const partOf = edges.filter((e) => e.kind === PART_OF_EDGE);
    expect(partOf).toHaveLength(1);
    expect(partOf[0]?.props?.role).toBe('采购');
    expect(partOf[0]?.props?.source).toBe('project_membership');

    const counterparty = edges.filter((e) => e.kind === COUNTERPARTY_EDGE);
    expect(counterparty).toHaveLength(2);
    const roles = counterparty.map((e) => e.props?.role).sort();
    expect(roles).toEqual(['买方', '卖方']);

    const participates = edges.filter((e) => e.kind === PARTICIPATES_EDGE);
    expect(participates).toHaveLength(2);
    const pr = participates.map((e) => e.props?.role).sort();
    expect(pr).toEqual(['主体', '供应商']);
    // 对手方 participates -> Project 节点。
    const projectEid = nodes.get('Project:PRJ-2026-001');
    expect(participates.every((e) => e.dstId === projectEid)).toBe(true);
    void created;
  });

  it('台账缺失 -> 只写 part_of, 无 counterparty/participates, 仍 ok', async () => {
    const { io, edges } = makeIo();
    const r = await syncProjectMembershipGraph(ctx, baseInput, io);
    expect(r.status).toBe('ok');
    expect(edges.filter((e) => e.kind === PART_OF_EDGE)).toHaveLength(1);
    expect(edges.filter((e) => e.kind === COUNTERPARTY_EDGE)).toHaveLength(0);
    expect(edges.filter((e) => e.kind === PARTICIPATES_EDGE)).toHaveLength(0);
  });

  it("role='物流' -> 有 counterparty 无 participates", async () => {
    await addSelfParty(ctx, '我方贸易', 'u1');
    await seedLedger('HT-2026-001');
    const { io, edges } = makeIo();
    const r = await syncProjectMembershipGraph(ctx, { ...baseInput, role: '物流' }, io);
    expect(r.status).toBe('ok');
    expect(edges.filter((e) => e.kind === COUNTERPARTY_EDGE)).toHaveLength(2);
    expect(edges.filter((e) => e.kind === PARTICIPATES_EDGE)).toHaveLength(0);
  });

  it('io 抛错 -> failed + reason, 不向上抛', async () => {
    const bad: ProjectGraphSyncIo = {
      ...makeIo().io,
      mergeEdge: async () => { throw new Error('neo4j down'); },
    };
    const r = await syncProjectMembershipGraph(ctx, baseInput, bad);
    expect(r.status).toBe('failed');
    expect(r.reason).toBe('neo4j down');
  });
});

describe('removeProjectMembershipGraph', () => {
  it('只删 part_of, 不触派生边', async () => {
    await addSelfParty(ctx, '我方贸易', 'u1');
    await seedLedger('HT-2026-001');
    const { io, edges } = makeIo();
    await syncProjectMembershipGraph(ctx, baseInput, io);
    expect(edges).toHaveLength(5); // part_of + 2 counterparty + 2 participates

    const r = await removeProjectMembershipGraph(
      { contractNo: 'HT-2026-001', projectCode: 'PRJ-2026-001' }, io,
    );
    expect(r.status).toBe('ok');
    expect(edges.filter((e) => e.kind === PART_OF_EDGE)).toHaveLength(0);
    expect(edges.filter((e) => e.kind === COUNTERPARTY_EDGE)).toHaveLength(2);
    expect(edges.filter((e) => e.kind === PARTICIPATES_EDGE)).toHaveLength(2);
  });

  it('节点缺失时也返回 ok(幂等)', async () => {
    const { io } = makeIo();
    const r = await removeProjectMembershipGraph(
      { contractNo: 'HT-404', projectCode: 'PRJ-404' }, io,
    );
    expect(r.status).toBe('ok');
  });
});

describe('trades 投影(spec 2026-08-25 方案A §3.3)', () => {
  async function seedLedgerWithCommodity(contractNo: string) {
    const entry = buildLedgerEntryFromExtraction({
      documentId: 'DOC-T',
      docType: '合同',
      fields: {
        合同号: { value: contractNo, sourceSpans: [] },
        甲方: { value: '我方贸易', sourceSpans: [] },
        乙方: { value: '某供应商', sourceSpans: [] },
        标的物: { value: '动力煤', sourceSpans: [] },
        数量: { value: '5,000', sourceSpans: [] },
        单价: { value: '650', sourceSpans: [] },
        金额: { value: '3250000', sourceSpans: [] },
      },
      fieldMeta: Object.fromEntries(
        ['合同号', '甲方', '乙方', '标的物', '数量', '单价', '金额'].map((k) => [k, { strength: 'exact' as const, confidence: 0.9 }]),
      ),
    })!;
    await upsertContractLedgerEntry(ctx, entry);
  }

  it('采购归属确认 -> trades 边 direction=buy 且带台账量价(千分位解析)', async () => {
    await addSelfParty(ctx, '我方贸易', 'u1');
    await seedLedgerWithCommodity('CG-TRADES-1');
    const { io, edges } = makeIo();
    const r = await syncProjectMembershipGraph(ctx, { ...baseInput, contractNo: 'CG-TRADES-1', role: '采购' }, io);
    expect(r.status).toBe('ok');
    const trades = edges.filter((e) => e.kind === TRADES_EDGE);
    expect(trades).toHaveLength(1);
    expect(trades[0]!.props).toMatchObject({ direction: 'buy', quantity: 5000, unitPrice: 650, amount: 3250000 });
  });

  it('销售归属确认 -> direction=sell; 商品名归一化收敛到同一 Commodity 节点', async () => {
    await addSelfParty(ctx, '我方贸易', 'u1');
    await seedLedgerWithCommodity('CG-TRADES-2');
    const { io, nodes, edges } = makeIo();
    const r = await syncProjectMembershipGraph(ctx, { ...baseInput, contractNo: 'CG-TRADES-2', role: '销售' }, io);
    expect(r.status).toBe('ok');
    const trades = edges.filter((e) => e.kind === TRADES_EDGE);
    expect(trades).toHaveLength(1);
    expect(trades[0]!.props?.direction).toBe('sell');
    expect(nodes.has('Commodity:动力煤')).toBe(true);
  });

  it("role='物流' -> 无 trades 边", async () => {
    await addSelfParty(ctx, '我方贸易', 'u1');
    await seedLedgerWithCommodity('CG-TRADES-3');
    const { io, edges } = makeIo();
    const r = await syncProjectMembershipGraph(ctx, { ...baseInput, contractNo: 'CG-TRADES-3', role: '物流' }, io);
    expect(r.status).toBe('ok');
    expect(edges.filter((e) => e.kind === TRADES_EDGE)).toHaveLength(0);
  });

  it('缺标的物 -> 安静跳过, 无 trades 边', async () => {
    await addSelfParty(ctx, '我方贸易', 'u1');
    await seedLedger('HT-2026-001'); // 只有甲乙方
    const { io, edges } = makeIo();
    const r = await syncProjectMembershipGraph(ctx, baseInput, io);
    expect(r.status).toBe('ok');
    expect(edges.filter((e) => e.kind === TRADES_EDGE)).toHaveLength(0);
  });
});
