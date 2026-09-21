import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { AuthEnv } from '../../src/lib/auth-middleware.js';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import { ensureTemplateSeed } from '../../src/pipeline/templateSeed.js';
import { asOfBusinessTime } from '../../src/ontology/asof.js';
import { listTradeFactsAsOf } from '../../src/ontology/repo.js';

// 沿 reviewOntologyHook.test.ts 范式: mock dbBackend.getDbContext。
const { ctxHolder } = vi.hoisted(() => ({ ctxHolder: { current: null as DbContext | null } }));
vi.mock('../../src/pipeline/db/dbBackend.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/pipeline/db/dbBackend.js')>();
  return { ...mod, getDbContext: () => ctxHolder.current };
});
const { bindingsRoute } = await import('../../src/routes/bindings.js');

function appAs(userId: string) {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { id: userId, email: 't@t', role: 'trader' } as never);
    await next();
  });
  app.route('/api/bindings', bindingsRoute);
  return app;
}

let ctx: DbContext;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
  ctxHolder.current = ctx;
});

describe('bindings ontology hook (wave5 acceptance fix 3)', () => {
  it('POST /api/bindings 创建 confirmed 绑定 -> 本体事实出现(trade_facts 含该 doc)', async () => {
    await ensureTemplateSeed(ctx);
    // 合同台账行 + 收货单文档
    ctx.sqlite.prepare(
      `INSERT INTO contract_ledger (id, contract_no, display_contract_no, doc_type, document_id,
          title, fields, field_meta, overall_confidence, needs_review, user_id, contract_type)
       VALUES ('CL-1', 'CON-W5', 'CON-W5', '合同', 'doc-1', '', '{}', '{}', 1, 0, '', '采购')`,
    ).run();
    ctx.sqlite.prepare(
      `INSERT INTO documents (id, doc_type, modality, source_uri, block_model, user_id, review_status, parse_status)
       VALUES ('DOC-W5', '收货单', 'text', '/ingest/w5.pdf', 'raw', '', 'confirmed', 'uploaded')`,
    ).run();
    // 抽取行(货物流物化依赖: materializeExecutionFlow 无 extraction 直接返回 null)
    ctx.sqlite.prepare(
      `INSERT INTO extractions (id, document_id, doc_type, fields, field_meta, overall_confidence, needs_review, user_id)
       VALUES ('EX-W5', 'DOC-W5', '收货单', '{}', '{}', 1, 0, '')`,
    ).run();

    const res = await appAs('u1').request('http://test/api/bindings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentId: 'DOC-W5', contractNo: 'CON-W5', relation: 'primary' }),
    });
    expect(res.status).toBe(200);

    // 钩子 fire-and-forget: 轮询等待异步实体化(纯进程内, 数毫秒内收敛)。
    const deadline = Date.now() + 3000;
    let found = false;
    while (Date.now() < deadline) {
      const facts = await listTradeFactsAsOf(
        ctx, asOfBusinessTime('2099-01-01T00:00:00.000Z'), { entityType: 'GoodsReceiptEvent' }, 'u1',
      );
      if (facts.some((f) => f.documentId === 'DOC-W5')) { found = true; break; }
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(found).toBe(true);
  });
});
