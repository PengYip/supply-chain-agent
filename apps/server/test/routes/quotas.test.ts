import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { AuthEnv } from '../../src/lib/auth-middleware.js';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import {
  saveQuota, findQuotaById, upsertContractLedgerEntry, upsertExecutionFlow,
} from '../../src/pipeline/db/repositories.js';
import { buildLedgerEntryFromExtraction, type ContractLedgerEntry } from '../../src/pipeline/contractLedger.js';

// 额度/对账 REST(spec 2026-08-25 方案A §6): /api/quotas + /api/reconcile。
// 创建/更新即时重算占用(reconcileQuotaOne); 图同步 best-effort(无 Neo4j ->
// skipped)。scaffold 对齐 graphLinks.test.ts。

const { ctxHolder } = vi.hoisted(() => ({ ctxHolder: { current: null as DbContext | null } }));
vi.mock('../../src/pipeline/db/dbBackend.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/pipeline/db/dbBackend.js')>();
  return { ...mod, getDbContext: () => ctxHolder.current };
});
const { quotasRoute } = await import('../../src/routes/quotas.js');
const { reconciliationRoute } = await import('../../src/routes/reconciliation.js');

function appAs(userId: string) {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { id: userId, email: 't@t', role: 'trader' } as never);
    await next();
  });
  app.route('/api/quotas', quotasRoute);
  app.route('/api/reconcile', reconciliationRoute);
  return app;
}

const span = { blockId: 'b1', start: 0, end: 4 };
function ledger(contractNo: string, fields: Record<string, string | number>): ContractLedgerEntry {
  const names = Object.keys(fields);
  return buildLedgerEntryFromExtraction({
    documentId: `DOC-${contractNo}`,
    docType: '合同',
    fields: {
      合同号: { value: contractNo, sourceSpans: [span] },
      ...Object.fromEntries(names.map((n) => [n, { value: fields[n], sourceSpans: [span] }])),
    },
    fieldMeta: Object.fromEntries(
      ['合同号', ...names].map((n) => [n, { strength: 'exact' as const, confidence: 0.95 }]),
    ),
  })!;
}

let ctx: DbContext;
const prevPwd = process.env.NEO4J_PASSWORD;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
  ctxHolder.current = ctx;
  delete process.env.NEO4J_PASSWORD;
});
afterEach(() => {
  if (prevPwd === undefined) delete process.env.NEO4J_PASSWORD;
  else process.env.NEO4J_PASSWORD = prevPwd;
});

function req(app: ReturnType<typeof appAs>, method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
}

describe('POST /api/quotas', () => {
  it('创建 + 即时重算占用 + graphSync=skipped', async () => {
    await upsertContractLedgerEntry(ctx, ledger('HT-1', { 甲方: '我方', 乙方: '中石化股份有限公司', 金额: 100 }));
    const res = await req(appAs('u1'), 'POST', '/api/quotas', {
      scope: 'counterparty', ownerKey: '中石化股份有限公司', ownerLabel: '中石化', limitAmount: 60,
    });
    expect(res.status).toBe(200);
    const data = await res.json() as { quotaId: string; graphSync: string; used: number; remaining: number; overLimit: boolean };
    expect(data.graphSync).toBe('skipped');
    expect(data.used).toBe(100);
    expect(data.overLimit).toBe(true);
    const row = await findQuotaById(ctx, data.quotaId, 'u1');
    expect(row?.status).toBe('active');
    expect(row?.usedAmount).toBe(100);
  });

  it('scope 非法 -> 400', async () => {
    const res = await req(appAs('u1'), 'POST', '/api/quotas', { scope: 'bad', ownerKey: 'X', limitAmount: 1 });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/quotas', () => {
  it('active 列表含物化 used/computedAt', async () => {
    const id = await saveQuota(ctx, { scope: 'counterparty', ownerKey: 'A 公司', limitAmount: 10, createdBy: 'u1' }, 'u1');
    const res = await req(appAs('u1'), 'GET', '/api/quotas');
    expect(res.status).toBe(200);
    const data = await res.json() as { quotas: Array<{ id: string; usedAmount: number; computedAt: string | null }> };
    expect(data.quotas).toHaveLength(1);
    expect(data.quotas[0]!.id).toBe(id);
    expect(data.quotas[0]!.usedAmount).toBe(0);
  });
});

describe('PATCH /api/quotas/:id', () => {
  it('更新限额 + 重算', async () => {
    await upsertContractLedgerEntry(ctx, ledger('HT-1', { 甲方: '我方', 乙方: '中石化股份有限公司', 金额: 100 }));
    const id = await saveQuota(ctx, { scope: 'counterparty', ownerKey: '中石化股份有限公司', limitAmount: 50, createdBy: 'u1' }, 'u1');
    const res = await req(appAs('u1'), 'PATCH', `/api/quotas/${id}`, { limitAmount: 200 });
    expect(res.status).toBe(200);
    const data = await res.json() as { used: number; overLimit: boolean };
    expect(data.used).toBe(100);
    expect(data.overLimit).toBe(false);
    expect((await findQuotaById(ctx, id, 'u1'))?.limitAmount).toBe(200);
  });

  it('未命中 -> 404', async () => {
    const res = await req(appAs('u1'), 'PATCH', '/api/quotas/Q-NONE', { limitAmount: 1 });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/quotas/:id/deactivate', () => {
  it('inactive + granted 边移除(skipped)', async () => {
    const id = await saveQuota(ctx, { scope: 'project', ownerKey: 'P-1', limitAmount: 10, createdBy: 'u1' }, 'u1');
    const res = await req(appAs('u1'), 'POST', `/api/quotas/${id}/deactivate`);
    expect(res.status).toBe(200);
    const data = await res.json() as { graphSync: string };
    expect(data.graphSync).toBe('skipped');
    expect((await findQuotaById(ctx, id, 'u1'))?.status).toBe('inactive');
  });
});

describe('POST /api/reconcile/run', () => {
  it('全量报告(quotas/projects/alerts)', async () => {
    await upsertContractLedgerEntry(ctx, ledger('HT-1', { 甲方: '我方', 乙方: '中石化股份有限公司', 金额: 100 }));
    await saveQuota(ctx, { scope: 'counterparty', ownerKey: '中石化股份有限公司', limitAmount: 1, createdBy: 'u1' }, 'u1');
    const res = await req(appAs('u1'), 'POST', '/api/reconcile/run');
    expect(res.status).toBe(200);
    const data = await res.json() as { generatedAt: string; quotas: unknown[]; projects: unknown[]; alerts: Array<{ code: string }> };
    expect(data.quotas).toHaveLength(1);
    expect(data.projects).toEqual([]);
    expect(data.alerts.some((a) => a.code === 'quota_over_limit')).toBe(true);
  });
});
