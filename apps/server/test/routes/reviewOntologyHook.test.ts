import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { AuthEnv } from '../../src/lib/auth-middleware.js';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import { createDocumentStub, saveExtraction } from '../../src/pipeline/db/repositories.js';

// 确认钩子集成用例(review.test.ts 同款 mock 范式, 独立文件/独立 fork 规避
// "同文件第二个 confirm 请求 404" 的既有测试环境怪癖——该怪癖与钩子无关,
// 在钩子禁用时同样复现, 见 task-4-report 自审 ②)。
const { ctxHolder } = vi.hoisted(() => ({
  ctxHolder: { current: null as DbContext | null },
}));
vi.mock('../../src/pipeline/db/dbBackend.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/pipeline/db/dbBackend.js')>();
  return { ...mod, getDbContext: () => ctxHolder.current };
});

const { reviewRoute } = await import('../../src/routes/review.js');

function appAs(userId: string) {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { id: userId, email: 't@t', role: 'trader' } as any);
    await next();
  });
  app.route('/api/documents', reviewRoute);
  return app;
}

describe('POST /:docId/review confirm -> ontology materialize hook (wave2)', () => {
  beforeEach(() => {
    const ctx = createDb(':memory:');
    migrate(ctx.sqlite);
    ctxHolder.current = ctx;
  });

  it('confirm 后实体化钩子 fire-and-forget: 待实体化流水被消费为事实并回写', async () => {
    const ctx = ctxHolder.current!;
    const { docId } = await createDocumentStub(ctx, { sourceUri: 'file:///rec.pdf', docType: '发票' });
    await saveExtraction(ctx, {
      documentId: docId, docType: '发票',
      fields: { 合同号: { value: 'HT-1', sourceSpans: [] } },
      fieldMeta: {},
      overallConfidence: 0.95, needsReview: false,
    });
    // 合同台账行 + 待实体化流水(货物流 in, quantity, 未回写)
    ctx.sqlite.prepare(
      `INSERT INTO contract_ledger (id, contract_no, display_contract_no, doc_type, document_id,
          title, fields, field_meta, overall_confidence, needs_review, user_id, contract_type)
       VALUES ('CL-1', 'HT-1', 'HT-1', '合同', 'doc-1', '', '{}', '{}', 1, 0, '', '采购')`,
    ).run();
    ctx.sqlite.prepare(
      `INSERT INTO execution_flows (id, binding_id, document_id, contract_no, flow_type, direction,
          amount, quantity_ton, unit, doc_type, voucher_date, created_by, user_id)
       VALUES ('F-1', 'B-1', ?, 'HT-1', '货物流', 'in', NULL, 620, '吨', '合同', '2026-09-01T00:00:00Z', 'agent', '')`,
    ).run(docId);

    const res = await appAs('u1').request(`/api/documents/${docId}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    expect(res.status).toBe(200);

    // 钩子 fire-and-forget: 轮询等待异步实体化完成(纯进程内, 数毫秒内收敛)。
    const deadline = Date.now() + 3000;
    let factId: string | null = null;
    while (Date.now() < deadline) {
      const row = ctx.sqlite.prepare(
        'SELECT ontology_fact_id AS f FROM execution_flows WHERE id = ?',
      ).get('F-1') as { f: string | null };
      if (row.f) { factId = row.f; break; }
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(factId).not.toBeNull();
    const fact = ctx.sqlite.prepare(
      'SELECT entity_type, payload FROM trade_facts WHERE id = ?',
    ).get(factId!) as { entity_type: string; payload: string };
    expect(fact.entity_type).toBe('GoodsReceiptEvent');
    expect(JSON.parse(fact.payload)).toMatchObject({ quantity: 620 });
  });
});
