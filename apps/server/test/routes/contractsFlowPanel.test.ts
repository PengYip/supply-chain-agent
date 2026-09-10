// GET /api/contracts/:contractNo/flow-panel 路由测试(spec §15): L1 只读聚合,
// requireAuth 沿既有合约路由域; 合同不在台账 -> 404。
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

async function seed(no: string) {
  const e: ContractLedgerEntry = {
    contractNo: no, displayContractNo: no, docType: '合同', documentId: 'D1', title: 'T',
    contractType: null,
    fields: { 合同号: { value: no, sourceSpans: [] }, 数量: { value: 100, sourceSpans: [] }, 单位: { value: '吨', sourceSpans: [] } },
    fieldMeta: {}, overallConfidence: 1, needsReview: false, userId: 'u1',
  };
  await upsertContractLedgerEntry(ctx, e, 'u1');
}

describe('GET /api/contracts/:contractNo/flow-panel', () => {
  it('未认证 -> 401', async () => {
    const app = new Hono<AuthEnv>();
    app.route('/api/contracts', contractsRoute);
    expect((await app.request('/api/contracts/X/flow-panel')).status).toBe(401);
  });

  it('合同不存在 -> 404', async () => {
    const res = await appAs('u1').request('/api/contracts/NOPE/flow-panel');
    expect(res.status).toBe(404);
  });

  it('200: 四泳道里程碑数组 + alerts + netPosition + correlates 齐备, 只读', async () => {
    await seed('GMNH-1');
    const res = await appAs('u1').request('/api/contracts/GMNH-1/flow-panel');
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body['contractNo']).toBe('GMNH-1');
    expect(typeof body['asOf']).toBe('string');
    expect(Array.isArray(body['goods'])).toBe(true);
    expect(Array.isArray(body['alerts'])).toBe(true);
    const title = body['title'] as Record<string, unknown>;
    expect(Array.isArray(title['milestones'])).toBe(true);
    expect(Array.isArray(title['transferPoints'])).toBe(true);
    expect(body['netPosition']).toBeDefined();
    expect(Array.isArray(body['correlates'])).toBe(true);
    expect(body['goods']).toBeDefined();
    expect(Array.isArray(body['funds'])).toBe(true);
    expect(Array.isArray(body['invoice'])).toBe(true);
  });
});
