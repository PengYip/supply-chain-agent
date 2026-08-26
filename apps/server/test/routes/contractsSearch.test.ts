import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { AuthEnv } from '../../src/lib/auth-middleware.js';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import { upsertContractLedgerEntry } from '../../src/pipeline/db/repositories.js';
import type { ContractLedgerEntry } from '../../src/pipeline/contractLedger.js';

const { ctxHolder } = vi.hoisted(() => ({ ctxHolder: { current: null as DbContext | null } }));
vi.mock('../../src/pipeline/db/dbBackend.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/pipeline/db/dbBackend.js')>();
  return { ...mod, getDbContext: () => ctxHolder.current };
});
const { contractsRoute } = await import('../../src/routes/contracts.js');

function appAs(userId: string) {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { id: userId, email: 't@t', role: 'trader' } as never);
    await next();
  });
  app.route('/api/contracts', contractsRoute);
  return app;
}

let ctx: DbContext;
beforeEach(() => { ctx = createDb(':memory:'); migrate(ctx.sqlite); ctxHolder.current = ctx; });

async function seed(no: string, buyer?: string) {
  const e: ContractLedgerEntry = {
    contractNo: no, displayContractNo: no, docType: '合同', documentId: 'D1', title: 'T',
    contractType: null,
    fields: buyer
      ? { 合同号: { value: no, sourceSpans: [] }, 买方: { value: buyer, sourceSpans: [] } }
      : { 合同号: { value: no, sourceSpans: [] } },
    fieldMeta: {}, overallConfidence: 1, needsReview: false, userId: 'u1',
  };
  await upsertContractLedgerEntry(ctx, e, 'u1');
}

describe('GET /api/contracts/search', () => {
  it('未认证 -> 401', async () => {
    const app = new Hono<AuthEnv>();
    app.route('/api/contracts', contractsRoute);
    expect((await app.request('/api/contracts/search?q=x')).status).toBe(401);
  });

  it('缺 q / 空白 q -> 400', async () => {
    expect((await appAs('u1').request('/api/contracts/search')).status).toBe(400);
    expect((await appAs('u1').request('/api/contracts/search?q=%20%20')).status).toBe(400);
  });

  it('limit 越界 -> 400', async () => {
    expect((await appAs('u1').request('/api/contracts/search?q=a&limit=21')).status).toBe(400);
    expect((await appAs('u1').request('/api/contracts/search?q=a&limit=0')).status).toBe(400);
  });

  it('按买方模糊命中并返回分组字段', async () => {
    await seed('CJXC-1', '浙江浙能富兴燃料有限公司');
    const res = await appAs('u1').request('/api/contracts/search?q=' + encodeURIComponent('浙能富兴'));
    expect(res.status).toBe(200);
    const data = await res.json() as { items: Array<{ contractNo: string; matchedField: string; buyer: string }> };
    expect(data.items).toHaveLength(1);
    expect(data.items[0]?.matchedField).toBe('buyer');
    expect(data.items[0]?.buyer).toBe('浙江浙能富兴燃料有限公司');
  });

  it('默认 limit=10 生效', async () => {
    for (let i = 0; i < 12; i++) await seed(`BULK-${String(i).padStart(2, '0')}`);
    const res = await appAs('u1').request('/api/contracts/search?q=BULK');
    const data = await res.json() as { items: unknown[] };
    expect(data.items).toHaveLength(10);
  });

  it('空结果 -> items: [] 而非 404', async () => {
    const res = await appAs('u1').request('/api/contracts/search?q=zzz');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { items: unknown[] }).items).toEqual([]);
  });
});