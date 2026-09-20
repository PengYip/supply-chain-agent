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
    // entityType 缺失 -> {error} 不抛
    const missing = await t.execute!({ entity: 'ontology' }, CALL) as { error?: string };
    expect(missing.error).toBeTruthy();
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