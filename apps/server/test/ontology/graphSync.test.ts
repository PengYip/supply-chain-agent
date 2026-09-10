// apps/server/test/ontology/graphSync.test.ts
// 本体图谱投影测试(spec 2026-09-09 §5): io 注入 fake 图(幂等语义与真实 repo 一致)
// + :memory: SQLite 真库(沿 neighbors 测试范式)。不依赖真实 Neo4j。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import { insertTradeFact, insertOntologyEdge } from '../../src/ontology/repo.js';
import {
  syncOntologyGraph, syncOntologyGraphSafe, type GraphSyncIo,
} from '../../src/ontology/graphSync.js';
import { normalizeName } from '../../src/graph/normalize.js';
import type { GraphEntity } from '../../src/graph/repo.js';

let ctx: DbContext;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
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

const PAYLOAD = {
  eventBizType: '正向', amount: 300_000, currency: 'CNY', payType: '预付',
} as const;

const insertFact = (userId: string, overrides: Partial<Parameters<typeof insertTradeFact>[1]> = {}) =>
  insertTradeFact(ctx, {
    entityType: 'PaymentEvent',
    payload: { ...PAYLOAD },
    validAt: '2026-06-20',
    createdBy: 'test',
    ...overrides,
  }, userId);

/** 内存图 fake: createEntity/mergeEdge 幂等语义与真实 repo 一致; prune 按
 * (label, userId 含共享 '') DETACH 语义; findEntities 按 kind+name 精确/包含匹配。 */
function makeFakeIo(seed: Array<{ kind: string; name: string }> = []) {
  const nodes = new Map<string, GraphEntity & { created: boolean }>();
  const edges: Array<{ srcId: string; dstId: string; kind: string; props: Record<string, unknown> }> = [];
  let nid = 0;
  for (const s of seed) {
    nodes.set(`${s.kind}:${s.name}`, {
      elementId: `el-seed-${nodes.size + 1}`, kind: s.kind, name: s.name, props: {}, created: false,
    });
  }
  const io: GraphSyncIo = {
    createEntity: async (i) => {
      const key = `${i.kind}:${i.name}`;
      const existing = nodes.get(key);
      if (existing) {
        Object.assign(existing.props, i.props ?? {});
        return { ...existing, created: false };
      }
      const node = { elementId: `el-${++nid}`, kind: i.kind, name: i.name, props: { ...(i.props ?? {}) }, created: true };
      nodes.set(key, node);
      return node;
    },
    mergeEdge: async (i) => {
      const found = edges.find((e) => e.srcId === i.srcId && e.dstId === i.dstId && e.kind === i.kind);
      if (found) {
        Object.assign(found.props, i.props ?? {});
        return found;
      }
      const edge = { srcId: i.srcId, dstId: i.dstId, kind: i.kind, props: { ...(i.props ?? {}) } };
      edges.push(edge);
      return edge;
    },
    findEntities: async (i) =>
      [...nodes.values()].filter((n) =>
        (i.kind ? n.kind === i.kind : true)
        && (i.exact ? n.name === i.name : n.name.includes(i.name)),
      ).slice(0, i.limit ?? 10),
    pruneFactNodes: async (i) => {
      let removed = 0;
      for (const [key, n] of [...nodes]) {
        if (n.kind !== i.label) continue;
        const uid = String(n.props['userId'] ?? '');
        if (uid !== i.userId && uid !== '') continue;
        if (i.keepIds.includes(n.name)) continue;
        for (let k = edges.length - 1; k >= 0; k -= 1) {
          if (edges[k]!.srcId === n.elementId || edges[k]!.dstId === n.elementId) edges.splice(k, 1);
        }
        nodes.delete(key);
        removed += 1;
      }
      return removed;
    },
  };
  return { io, nodes, edges };
}

describe('syncOntologyGraph', () => {
  it('skips when NEO4J_PASSWORD is unset (graph not configured)', async () => {
    delete process.env.NEO4J_PASSWORD;
    const { io } = makeFakeIo();
    const res = await syncOntologyGraph({ ctx, userId: 'u1', io });
    expect(res.status).toBe('skipped');
    expect(res.nodeCount).toBe(0);
  });

  it('projects trade_facts to nodes: label=entityType, name=TF id, flattened payload + provenance', async () => {
    const pid = await insertFact('u1');
    const { io, nodes } = makeFakeIo();
    const res = await syncOntologyGraph({ ctx, userId: 'u1', io });
    expect(res.status).toBe('ok');
    expect(res.nodeCount).toBe(1);
    const node = nodes.get(`PaymentEvent:${pid}`);
    expect(node).toBeDefined();
    expect(node!.props['amount']).toBe(300_000);
    expect(node!.props['payType']).toBe('预付');
    expect(node!.props['userId']).toBe('u1');
    expect(node!.props['createdBy']).toBe('test');
    expect(String(node!.props['validAt'])).toContain('2026-06-20');
  });

  it('TradeGoods attributes 袋展平为 attr.<键> 扁平 props（Neo4j props 不收嵌套对象, spec §3 隐藏约束）', async () => {
    const gid = await insertTradeFact(ctx, {
      entityType: 'TradeGoods',
      payload: {
        name: '螺纹钢', commodityCode: 'HRB400E', spec: 'HRB400E Φ12mm 9m定尺',
        attributes: { '牌号': 'HRB400E', '直径': '12mm', '件重': 12 },
      },
      validAt: '2026-06-20', createdBy: 'test',
    }, 'u1');
    const { io, nodes } = makeFakeIo();
    const res = await syncOntologyGraph({ ctx, userId: 'u1', io });
    expect(res.status).toBe('ok');
    const node = nodes.get(`TradeGoods:${gid}`);
    expect(node).toBeDefined();
    // 袋内键 -> attr. 前缀标量 props（含 number 值）
    expect(node!.props['attr.牌号']).toBe('HRB400E');
    expect(node!.props['attr.直径']).toBe('12mm');
    expect(node!.props['attr.件重']).toBe(12);
    // 嵌套 attributes 键不得出现在节点 props
    expect(node!.props['attributes']).toBeUndefined();
    // 其余 payload 字段照旧展平; 但 payload 的 name 键必须摘出——name 是 MERGE 键
    // (=TF id, spec §2.1), 随 props 回写会被品名覆盖 -> prune 按 TF id keep 集
    // 找不到节点把新建节点删掉, 同 payload name 多事实还会触发 name 唯一约束
    // 冲突(2026-09-10 dev 冒烟暴露的 Phase 1 缺陷)。
    expect(node!.props['name']).toBeUndefined();
    expect(node!.name).toBe(gid); // 节点键保持 TF id
    expect(node!.props['commodityCode']).toBe('HRB400E');
  });

  it('无 attributes 的事实 props 零变化（展平路径对既有 payload 无副作用）', async () => {
    const pid = await insertFact('u1');
    const { io, nodes } = makeFakeIo();
    await syncOntologyGraph({ ctx, userId: 'u1', io });
    const node = nodes.get(`PaymentEvent:${pid}`)!;
    expect(Object.keys(node.props).sort()).toEqual([
      'amount', 'createdBy', 'currency', 'eventBizType', 'ingestedAt',
      'payType', 'userId', 'validAt',
    ]);
  });

  it('projects ontology_edges to typed parametric relationships (WRITE_OFF)', async () => {
    const pid = await insertFact('u1');
    const iid = await insertTradeFact(ctx, {
      entityType: 'InvoiceEvent',
      payload: { eventBizType: '正向', amount: 800_000, currency: 'CNY', invoiceNo: 'INV-1', invoiceType: '销项' },
      validAt: '2026-06-10', createdBy: 'test',
    }, 'u1');
    await insertOntologyEdge(ctx, {
      relation: 'WRITE_OFF', fromType: 'PaymentEvent', fromId: pid,
      toType: 'InvoiceEvent', toId: iid,
      params: { amount: 100_000, partial: true }, validAt: '2026-06-25', createdBy: 'test',
    }, 'u1');
    const { io, edges } = makeFakeIo();
    const res = await syncOntologyGraph({ ctx, userId: 'u1', io });
    expect(res.edgeCount).toBe(1);
    const edge = edges[0]!;
    expect(edge.kind).toBe('WRITE_OFF');
    expect(edge.props['amount']).toBe(100_000);
    expect(edge.props['partial']).toBe(true);
    expect(edge.props['userId']).toBe('u1');
    expect(typeof edge.props['edgeId']).toBe('string');
  });

  it('bridges TradeContract endpoints to existing Contract nodes by normalized name', async () => {
    insertContract('C1', 'HT-DEMO-001');
    const sid = await insertTradeFact(ctx, {
      entityType: 'ServiceCostEvent',
      payload: { eventBizType: '正向', amount: 50_000, currency: 'CNY', costType: '物流' },
      validAt: '2026-06-01', createdBy: 'test',
    }, 'u1');
    await insertOntologyEdge(ctx, {
      relation: 'ALLOCATE_TO', fromType: 'ServiceCostEvent', fromId: sid,
      toType: 'TradeContract', toId: 'C1',
      params: { amount: 50_000, method: '金额' }, validAt: '2026-06-01', createdBy: 'test',
    }, 'u1');
    const contractName = normalizeName('HT-DEMO-001');
    const { io, edges } = makeFakeIo([{ kind: 'Contract', name: contractName }]);
    const res = await syncOntologyGraph({ ctx, userId: 'u1', io });
    expect(res.status).toBe('ok');
    expect(res.edgeCount).toBe(1);
    expect(edges[0]!.kind).toBe('ALLOCATE_TO');
    expect(edges[0]!.dstId).toBe('el-seed-1');
  });

  it('records a failure (partial) when the Contract bridge anchor is missing in graph', async () => {
    insertContract('C1', 'HT-DEMO-001');
    const sid = await insertTradeFact(ctx, {
      entityType: 'ServiceCostEvent',
      payload: { eventBizType: '正向', amount: 50_000, currency: 'CNY', costType: '物流' },
      validAt: '2026-06-01', createdBy: 'test',
    }, 'u1');
    await insertOntologyEdge(ctx, {
      relation: 'ALLOCATE_TO', fromType: 'ServiceCostEvent', fromId: sid,
      toType: 'TradeContract', toId: 'C1',
      params: { amount: 50_000, method: '金额' }, validAt: '2026-06-01', createdBy: 'test',
    }, 'u1');
    const { io, edges } = makeFakeIo(); // 空图: Contract 桥脱靶
    const res = await syncOntologyGraph({ ctx, userId: 'u1', io });
    expect(res.status).toBe('partial');
    expect(res.edgeCount).toBe(0);
    expect(res.failures[0]).toContain('endpoint not resolved');
    expect(edges).toHaveLength(0);
  });

  it('bridges document-anchored receipt endpoints to Document nodes (injected findDocRow)', async () => {
    const setId = await insertTradeFact(ctx, {
      entityType: 'SettlementEvent',
      payload: { eventBizType: '正向', amount: 120_000, currency: 'CNY', settledQuantity: 100, unit: '吨' },
      validAt: '2026-06-05', createdBy: 'test',
    }, 'u1');
    await insertOntologyEdge(ctx, {
      relation: 'FEEDS_INTO', fromType: 'GoodsReceiptEvent', fromId: 'DOC-1',
      toType: 'SettlementEvent', toId: setId,
      params: {}, validAt: '2026-06-05', createdBy: 'test',
    }, 'u1');
    const { io, edges } = makeFakeIo([{ kind: 'Document', name: 'DOC-1' }]);
    const res = await syncOntologyGraph({
      ctx, userId: 'u1', io,
      findDocRow: async (_ctx, id, type, _uid) => ({
        id, entityType: type, label: '收货单 DOC-1', fields: {},
        source: 'documents', validAt: null, ingestedAt: null,
      }),
    });
    expect(res.status).toBe('ok');
    expect(res.edgeCount).toBe(1);
    expect(edges[0]!.kind).toBe('FEEDS_INTO');
    expect(edges[0]!.srcId).toBe('el-seed-1'); // Document 桥节点
  });

  it('is idempotent: re-sync does not duplicate nodes or edges', async () => {
    const pid = await insertFact('u1');
    const iid = await insertTradeFact(ctx, {
      entityType: 'InvoiceEvent',
      payload: { eventBizType: '正向', amount: 800_000, currency: 'CNY', invoiceNo: 'INV-1', invoiceType: '销项' },
      validAt: '2026-06-10', createdBy: 'test',
    }, 'u1');
    await insertOntologyEdge(ctx, {
      relation: 'WRITE_OFF', fromType: 'PaymentEvent', fromId: pid,
      toType: 'InvoiceEvent', toId: iid,
      params: { amount: 100_000 }, validAt: '2026-06-25', createdBy: 'test',
    }, 'u1');
    const { io, nodes, edges } = makeFakeIo();
    const r1 = await syncOntologyGraph({ ctx, userId: 'u1', io });
    const r2 = await syncOntologyGraph({ ctx, userId: 'u1', io });
    expect(r1.status).toBe('ok');
    expect(r2.nodeCount).toBe(r1.nodeCount);
    expect(r2.edgeCount).toBe(r1.edgeCount);
    expect(nodes.size).toBe(2);
    expect(edges).toHaveLength(1);
  });

  it('prunes stale fact nodes on convergence (invalidated fact leaves the graph)', async () => {
    const tid = await insertFact('u1');
    const { io, nodes } = makeFakeIo();
    await syncOntologyGraph({ ctx, userId: 'u1', io });
    expect(nodes.size).toBe(1);
    ctx.sqlite.prepare('UPDATE trade_facts SET invalid_at = ? WHERE id = ?')
      .run('2026-07-01T00:00:00.000Z', tid);
    const r2 = await syncOntologyGraph({ ctx, userId: 'u1', io });
    expect(r2.prunedCount).toBe(1);
    expect(nodes.size).toBe(0);
  });

  it('prune respects user scope: other users fact nodes are untouched', async () => {
    const t1 = await insertFact('u1');
    const t2 = await insertFact('u2');
    const { io, nodes } = makeFakeIo();
    await syncOntologyGraph({ ctx, userId: 'u1', io });
    await syncOntologyGraph({ ctx, userId: 'u2', io });
    expect(nodes.size).toBe(2);
    ctx.sqlite.prepare('UPDATE trade_facts SET invalid_at = ? WHERE id = ?')
      .run('2026-07-01T00:00:00.000Z', t1);
    const r = await syncOntologyGraph({ ctx, userId: 'u1', io });
    expect(r.prunedCount).toBe(1);
    expect(nodes.size).toBe(1);
    expect([...nodes.values()][0]!.name).toBe(t2);
  });

  it('skips prune when truncated (cap guard against over-deletion)', async () => {
    // validAt 错开使 (valid_at, id) 排序确定: cap=1 时切片恒为 t1。
    const t1 = await insertFact('u1');
    const t2 = await insertFact('u1', {
      payload: { ...PAYLOAD, amount: 1 },
      validAt: '2026-06-21',
    });
    const { io, nodes } = makeFakeIo();
    const r1 = await syncOntologyGraph({ ctx, userId: 'u1', io, cap: 1 });
    expect(r1.truncated).toBe(true);
    expect(r1.prunedCount).toBe(0);
    expect(r1.nodeCount).toBe(1);
    expect(nodes.size).toBe(1);
    expect(nodes.has(`PaymentEvent:${t1}`)).toBe(true);
    expect(nodes.has(`PaymentEvent:${t2}`)).toBe(false);
    // 失效已投影的 t1 -> 第二次同步改投影 t2; t1 的陈旧节点因 truncated 不被 prune。
    ctx.sqlite.prepare('UPDATE trade_facts SET invalid_at = ? WHERE id = ?')
      .run('2026-07-01T00:00:00.000Z', t1);
    const r2 = await syncOntologyGraph({ ctx, userId: 'u1', io, cap: 1 });
    expect(r2.truncated).toBe(true);
    expect(r2.prunedCount).toBe(0);
    expect(nodes.size).toBe(2);
  });

  it('projects EVIDENCE edges for facts carrying documentId (P3 凭证据源)', async () => {
    const pid = await insertFact('u1', { documentId: 'doc-uuid-9' });
    const { io, nodes, edges } = makeFakeIo([{ kind: 'Document', name: 'doc-uuid-9' }]);
    const res = await syncOntologyGraph({ ctx, userId: 'u1', io });
    expect(res.status).toBe('ok');
    expect(res.skippedEvidence).toBe(0);
    // 节点 props 带溯源锚点
    expect(nodes.get(`PaymentEvent:${pid}`)!.props['documentId']).toBe('doc-uuid-9');
    // EVIDENCE 边: Document -> 事件节点
    const ev = edges.find((e) => e.kind === 'EVIDENCE');
    expect(ev).toBeDefined();
    expect(ev!.srcId).toBe('el-seed-1');           // Document 桥节点
    expect(ev!.dstId).toBe(nodes.get(`PaymentEvent:${pid}`)!.elementId);
  });

  it('counts skippedEvidence (not failures) when the document node is not in the graph', async () => {
    await insertFact('u1', { documentId: 'doc-unconfirmed' });
    const { io, edges } = makeFakeIo(); // 空图: 单据未确认
    const res = await syncOntologyGraph({ ctx, userId: 'u1', io });
    expect(res.status).toBe('ok');                 // 正常态, 非错误
    expect(res.skippedEvidence).toBe(1);
    expect(res.failures).toHaveLength(0);
    expect(edges.find((e) => e.kind === 'EVIDENCE')).toBeUndefined();
  });

  it('tolerates io failures per item: node failures are recorded, status is partial', async () => {
    await insertFact('u1');
    const boomIo: GraphSyncIo = {
      createEntity: async () => { throw new Error('neo4j down'); },
      mergeEdge: async () => ({}),
      findEntities: async () => [],
    };
    const res = await syncOntologyGraph({ ctx, userId: 'u1', io: boomIo });
    expect(res.status).toBe('partial');
    expect(res.failures[0]).toContain('neo4j down');
  });
});

describe('syncOntologyGraphSafe', () => {
  it('swallows projection errors (never blocks the business write path)', async () => {
    await insertFact('u1');
    const boomIo: GraphSyncIo = {
      createEntity: async () => { throw new Error('neo4j down'); },
      mergeEdge: async () => ({}),
      findEntities: async () => [],
    };
    await expect(syncOntologyGraphSafe(ctx, 'u1', boomIo)).resolves.toBeUndefined();
  });

  it('returns early when the graph is not configured', async () => {
    delete process.env.NEO4J_PASSWORD;
    await insertFact('u1');
    const boomIo: GraphSyncIo = {
      createEntity: async () => { throw new Error('should not be called'); },
      mergeEdge: async () => ({}),
      findEntities: async () => [],
    };
    await expect(syncOntologyGraphSafe(ctx, 'u1', boomIo)).resolves.toBeUndefined();
  });
});
