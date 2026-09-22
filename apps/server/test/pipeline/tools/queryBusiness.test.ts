// apps/server/test/pipeline/tools/queryBusiness.test.ts
// query_business 扩本体读(Wave 3 Task 1): entity=ontology/neighbors/writeoff 三新值。
// L1 只读——新 case 无写路径; :memory: + migrate; 沿 unbound_docs 内联直调范式。
import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate, type DbContext } from '../../../src/pipeline/db/client.js';
import { buildQueryBusinessTool } from '../../../src/pipeline/tools/queryBusiness.js';
import { insertTradeFact, insertOntologyEdge } from '../../../src/ontology/repo.js';

let ctx: DbContext;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
});

const CALL = { toolCallId: 'call_test', messages: [] } as never;

const insertContract = (id: string, contractNo: string) => {
  ctx.sqlite.prepare(
    `INSERT INTO contract_ledger (id, contract_no, display_contract_no, doc_type, document_id,
        title, fields, field_meta, overall_confidence, needs_review, user_id, contract_type)
     VALUES (?, ?, ?, '合同', 'doc-1', '', '{}', '{}', 1, 0, '', '采购')`,
  ).run(id, contractNo, contractNo);
};

describe('query_business ontology/neighbors/writeoff (wave3)', () => {
  it('1) ontology: entityType 必填, 列出实体清单含 seed 事实', async () => {
    const id = await insertTradeFact(ctx, {
      entityType: 'GoodsReceiptEvent',
      payload: { eventBizType: '正向', quantity: 620, unit: '吨' },
      validAt: '2026-09-01T00:00:00Z', createdBy: 't',
    }, 'u1');
    const t = buildQueryBusinessTool({ ctx, userId: 'u1' });
    const out = await t.execute!({ entity: 'ontology', entityType: 'GoodsReceiptEvent' }, CALL) as {
      status: string; total?: number; items?: Array<{ id: string }>; error?: string;
    };
    expect(out.status).toBe('ok');
    expect(out.total).toBeGreaterThanOrEqual(1);
    expect(out.items?.some((i) => i.id === id)).toBe(true);
    // W3 Minor: page 透传(listProjectedEntities 分页)
    const page2 = await t.execute!({ entity: 'ontology', entityType: 'GoodsReceiptEvent', page: 1 }, CALL) as {
      status: string; page?: number;
    };
    expect(page2.status).toBe('ok');
    expect(page2.page).toBe(1);
    // entityType 缺失 -> {error} 不抛
    const missing = await t.execute!({ entity: 'ontology' }, CALL) as { error?: string };
    expect(missing.error).toBeTruthy();
    // W3 Minor: 白名单非法 entityType -> {error}
    const invalid = await t.execute!({ entity: 'ontology', entityType: 'NoSuchEntity' }, CALL) as { error?: string };
    expect(invalid.error).toContain('entityType 须为 12 实体名之一');
  });

  it('2) neighbors: factId 锚点穿透, 返回节点/边计数', async () => {
    const receipt = await insertTradeFact(ctx, {
      entityType: 'GoodsReceiptEvent',
      payload: { eventBizType: '正向', quantity: 620, unit: '吨' },
      validAt: '2026-09-01T00:00:00Z', createdBy: 't',
    }, 'u1');
    insertContract('CL-1', 'HT-1');
    await insertOntologyEdge(ctx, {
      relation: 'ALLOCATE_TO', fromType: 'GoodsReceiptEvent', fromId: receipt,
      toType: 'TradeContract', toId: 'CL-1',
      params: { quantity: 620, method: '数量' }, validAt: '2026-09-01T00:00:00Z', createdBy: 't',
    }, 'u1');
    const t = buildQueryBusinessTool({ ctx, userId: 'u1' });
    const out = await t.execute!({ entity: 'neighbors', factId: receipt }, CALL) as {
      status: string; nodeCount?: number; edgeCount?: number; error?: string;
    };
    expect(out.status).toBe('ok');
    expect(out.nodeCount).toBeGreaterThanOrEqual(1);
    expect(out.edgeCount).toBeGreaterThanOrEqual(1);
    // factId 缺失 -> {error}
    const missing = await t.execute!({ entity: 'neighbors' }, CALL) as { error?: string };
    expect(missing.error).toBeTruthy();
    // 锚点不存在 -> {error}
    const badAnchor = await t.execute!({ entity: 'neighbors', factId: 'TF-nope' }, CALL) as { error?: string };
    expect(badAnchor.error).toBeTruthy();
  });

  it('3) writeoff: 空数据也 status ok, 返回结构化模式总览', async () => {
    const t = buildQueryBusinessTool({ ctx, userId: 'u1' });
    const out = await t.execute!({ entity: 'writeoff' }, CALL) as {
      status: string; modes?: Array<{ relation: string; srcTypes: string[]; dstTypes: string[] }>; error?: string;
    };
    expect(out.status).toBe('ok');
    expect(Array.isArray(out.modes)).toBe(true);
    expect(out.modes!.length).toBeGreaterThanOrEqual(1); // 模式发现(WRITE_OFF/OFFSET_SETTLE/WRITE_OFF_SETTLEMENT)
    expect(out.modes!.some((m) => m.relation === 'WRITE_OFF')).toBe(true);
  });
});

describe('query_business entity=gaps (wave8 T1, AI 可答勾稽)', () => {
  // 金标准 seed(沿 gaps.test.ts): 采购 CON-0817 + 销售 CON-0512 -> 四 tiles 数字逐字可断言
  // (W8 sweep: 改名避免遮蔽外层两参 insertContract——本块需要带 contract_type 三参版本)。
  const insertContractWithProject = (id: string, contractNo: string, contractType: string) => {
    ctx.sqlite.prepare(
      `INSERT INTO contract_ledger (id, contract_no, display_contract_no, doc_type, document_id,
          title, fields, field_meta, overall_confidence, needs_review, user_id, contract_type)
       VALUES (?, ?, ?, '合同', 'doc-1', '', '{}', '{}', 1, 0, '', ?)`,
    ).run(id, contractNo, contractNo, contractType);
  };

  async function seedGolden(): Promise<void> {
    insertContractWithProject('CL-1', 'CON-0817', '采购');
    insertContractWithProject('CL-2', 'CON-0512', '销售');
    const receipt = await insertTradeFact(ctx, {
      entityType: 'GoodsReceiptEvent',
      payload: { eventBizType: '正向', quantity: 1600, amount: 3_200_000, currency: 'CNY', unit: '吨' },
      validAt: '2026-09-01T00:00:00Z', createdBy: 'golden',
    }, 'u1');
    await insertOntologyEdge(ctx, {
      relation: 'ALLOCATE_TO', fromType: 'GoodsReceiptEvent', fromId: receipt,
      toType: 'TradeContract', toId: 'CL-1',
      params: { quantity: 1600, method: '数量' }, validAt: '2026-09-01T00:00:00Z', createdBy: 'golden',
    }, 'u1');
    await insertTradeFact(ctx, {
      entityType: 'SettlementEvent',
      payload: { eventBizType: '正向', amount: 2_444_000, currency: 'CNY', contractNo: 'CON-0817' },
      validAt: '2026-09-02T00:00:00Z', createdBy: 'golden',
    }, 'u1');
    await insertTradeFact(ctx, {
      entityType: 'InvoiceEvent',
      payload: { eventBizType: '正向', amount: 2_444_000, currency: 'CNY', invoiceNo: 'INV-IN-1', invoiceType: '进项', contractNo: 'CON-0817' },
      validAt: '2026-09-03T00:00:00Z', createdBy: 'golden',
    }, 'u1');
    await insertTradeFact(ctx, {
      entityType: 'PaymentEvent',
      payload: { eventBizType: '正向', amount: 1_158_000, currency: 'CNY', payType: '预付', contractNo: 'CON-0817' },
      validAt: '2026-09-01T00:00:00Z', createdBy: 'golden',
    }, 'u1');
    await insertTradeFact(ctx, {
      entityType: 'PaymentEvent',
      payload: { eventBizType: '正向', amount: 1_544_000, currency: 'CNY', payType: '尾款', contractNo: 'CON-0817' },
      validAt: '2026-09-04T00:00:00Z', createdBy: 'golden',
    }, 'u1');
    await insertTradeFact(ctx, {
      entityType: 'PaymentEvent',
      payload: { eventBizType: '逆向', amount: -86_000, currency: 'CNY', payType: '预付', contractNo: 'CON-0817' },
      validAt: '2026-09-05T00:00:00Z', createdBy: 'golden',
    }, 'u1');
    const delivery = await insertTradeFact(ctx, {
      entityType: 'GoodsDeliveryEvent',
      payload: { eventBizType: '正向', quantity: 390, amount: 764_000, currency: 'CNY', unit: '吨' },
      validAt: '2026-09-01T00:00:00Z', createdBy: 'golden',
    }, 'u1');
    await insertOntologyEdge(ctx, {
      relation: 'ALLOCATE_TO', fromType: 'GoodsDeliveryEvent', fromId: delivery,
      toType: 'TradeContract', toId: 'CL-2',
      params: { quantity: 390, amount: 764_000, method: '金额' }, validAt: '2026-09-01T00:00:00Z', createdBy: 'golden',
    }, 'u1');
    await insertTradeFact(ctx, {
      entityType: 'SettlementEvent',
      payload: { eventBizType: '正向', amount: 588_000, currency: 'CNY', contractNo: 'CON-0512' },
      validAt: '2026-09-02T00:00:00Z', createdBy: 'golden',
    }, 'u1');
    await insertTradeFact(ctx, {
      entityType: 'InvoiceEvent',
      payload: { eventBizType: '正向', amount: 588_000, currency: 'CNY', invoiceNo: 'INV-OUT-1', invoiceType: '销项', contractNo: 'CON-0512' },
      validAt: '2026-09-03T00:00:00Z', createdBy: 'golden',
    }, 'u1');
    await insertTradeFact(ctx, {
      entityType: 'InvoiceEvent',
      payload: { eventBizType: '逆向', amount: -58_800, currency: 'CNY', invoiceNo: 'INV-OUT-1', invoiceType: '销项', contractNo: 'CON-0512' },
      validAt: '2026-09-04T00:00:00Z', createdBy: 'golden',
    }, 'u1');
    await insertTradeFact(ctx, {
      entityType: 'CollectionEvent',
      payload: { eventBizType: '正向', amount: 300_000, currency: 'CNY', collectionType: '回款', contractNo: 'CON-0512' },
      validAt: '2026-09-05T00:00:00Z', createdBy: 'golden',
    }, 'u1');
    await insertTradeFact(ctx, {
      entityType: 'CollectionEvent',
      payload: { eventBizType: '正向', amount: 288_000, currency: 'CNY', collectionType: '回款', contractNo: 'CON-0512' },
      validAt: '2026-09-06T00:00:00Z', createdBy: 'golden',
    }, 'u1');
  }

  it('1) entity=gaps 返回四 tiles 数字+hint + scope + usage(全局口径缺省)', async () => {
    await seedGolden();
    const t = buildQueryBusinessTool({ ctx, userId: 'u1' });
    const out = await t.execute!({ entity: 'gaps' }, CALL) as {
      status: string; entity?: string; scope?: string;
      tiles?: Array<{ key: string; label: string; qty?: number | null; amt?: number | null; hint?: string }>;
      checks?: string[]; usage?: string; error?: string;
    };
    expect(out.status).toBe('ok');
    expect(out.entity).toBe('gaps');
    expect(out.scope).toBe('all');
    const tile = (key: string) => out.tiles!.find((x) => x.key === key)!;
    expect(tile('stock').qty).toBe(1210);
    expect(tile('recv').amt).toBe(176_000);
    expect(tile('pay').amt).toBe(900_000);
    expect(tile('mis').amt).toBe(230_800);
    // hint 透传 + usage 引导明细走面板
    expect(tile('stock').hint).toBeTruthy();
    expect(out.checks!.length).toBeGreaterThanOrEqual(8);
    expect(out.usage).toContain('勾稽缺口面板');
  });

  it('2) projectCode 透传 -> BELONGS_TO 范围命中(scope=PRJ-1, 采购侧在范围)', async () => {
    await seedGolden();
    const proj = await insertTradeFact(ctx, {
      entityType: 'TradeProject',
      payload: { projectNo: 'PRJ-1', name: '年度采购' },
      validAt: '2026-09-01T00:00:00Z', createdBy: 'golden',
    }, 'u1');
    await insertOntologyEdge(ctx, {
      relation: 'BELONGS_TO', fromType: 'TradeContract', fromId: 'CL-1',
      toType: 'TradeProject', toId: proj,
      params: {}, validAt: '2026-09-01T00:00:00Z', createdBy: 'golden',
    }, 'u1');
    const t = buildQueryBusinessTool({ ctx, userId: 'u1' });
    const out = await t.execute!({ entity: 'gaps', projectCode: 'PRJ-1' }, CALL) as {
      status: string; scope?: string; tiles?: Array<{ key: string; qty?: number | null; amt?: number | null }>; error?: string;
    };
    expect(out.status).toBe('ok');
    expect(out.scope).toBe('PRJ-1'); // computeGaps 收到 projectNo
    // 销侧不在范围: recv(⑤ 发货未收)归 0
    expect(out.tiles!.find((x) => x.key === 'recv')!.amt).toBe(0);
  });

  it('3) computeGaps 抛错 -> 返回 {error} 对象不抛(沿 ontology/neighbors 分支风格)', async () => {
    const broken = {
      backend: 'sqlite',
      sqlite: { prepare: () => ({ all: () => { throw new Error('gaps boom'); }, get: () => { throw new Error('gaps boom'); } }) },
    } as never;
    const t = buildQueryBusinessTool({ ctx: broken, userId: 'u1' });
    const out = await t.execute!({ entity: 'gaps' }, CALL) as { error?: string };
    expect(out.error).toContain('gaps boom');
  });
});
