import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { AuthEnv } from '../../src/lib/auth-middleware.js';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import {
  createDocumentStub,
  saveExtraction,
  addSelfParty,
  listSelfParties,
} from '../../src/pipeline/db/repositories.js';

// partiesRoute 的 DbContext 经 getDbContext(dbBackend) 解析, 且每次调用取 fresh
// ctx(不做模块级单例缓存) -> ctxHolder mock 逐测试注入内存库即可。
const { ctxHolder } = vi.hoisted(() => ({
  ctxHolder: { current: null as DbContext | null },
}));
vi.mock('../../src/pipeline/db/dbBackend.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/pipeline/db/dbBackend.js')>();
  return { ...mod, getDbContext: () => ctxHolder.current };
});
const { partiesRoute } = await import('../../src/routes/parties.js');

function appAs(userId: string) {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { id: userId, email: 't@t', role: 'trader' } as never);
    await next();
  });
  app.route('/api/parties', partiesRoute);
  return app;
}

let ctx: DbContext;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
  ctxHolder.current = ctx;
});

const SELF_NAME = '浙江浙能富兴燃料有限公司';

describe('GET /api/parties', () => {
  it('空库 -> { parties:[], envOnly:[], candidates:[] }', async () => {
    const res = await appAs('u1').request('/api/parties');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ parties: [], envOnly: [], candidates: [] });
  });

  it('有凭证抽取 -> candidates 含候选公司(docCount>=1), 名单仍为空', async () => {
    const { docId } = await createDocumentStub(ctx, {
      sourceUri: 'file:///inv.pdf', docType: '发票', userId: 'u1',
    });
    await saveExtraction(ctx, {
      documentId: docId, docType: '发票',
      fields: {
        购买方名称: { value: SELF_NAME, sourceSpans: [] },
        销售方名称: { value: '上海某贸易有限公司', sourceSpans: [] },
      },
      fieldMeta: {}, overallConfidence: 1, needsReview: false,
    }, 'u1');

    const res = await appAs('u1').request('/api/parties');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      parties: unknown[];
      envOnly: unknown[];
      candidates: Array<{ name: string; docCount: number }>;
    };
    expect(body.parties).toEqual([]);
    expect(body.envOnly).toEqual([]);
    expect(body.candidates.length).toBeGreaterThanOrEqual(1);
    const self = body.candidates.find((c) => c.name === SELF_NAME);
    expect(self?.docCount).toBeGreaterThanOrEqual(1);
  });

  it('DB 名单展示为 source=db 且带 createdAt', async () => {
    await addSelfParty(ctx, SELF_NAME, 'u1');
    const res = await appAs('u1').request('/api/parties');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      parties: Array<{ name: string; source: string; createdAt: string | null }>;
    };
    expect(body.parties).toHaveLength(1);
    expect(body.parties[0]!.name).toBe(SELF_NAME);
    expect(body.parties[0]!.source).toBe('db');
    expect(body.parties[0]!.createdAt).toBeTruthy();
  });

  it('未认证 -> 401', async () => {
    const app = new Hono<AuthEnv>();
    app.route('/api/parties', partiesRoute);
    const res = await app.request('/api/parties');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/parties', () => {
  it('空 name -> 400 invalid_name', async () => {
    const res = await appAs('u1').request('/api/parties', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'invalid_name' });
  });

  it('缺 body -> 400 invalid_name', async () => {
    const res = await appAs('u1').request('/api/parties', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'invalid_name' });
  });

  it('新增成功 -> { ok:true, added:true } 且落库(空库无回填候选)', async () => {
    const res = await appAs('u1').request('/api/parties', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: SELF_NAME }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean; added: boolean; refreshedFlows: number; failed: number;
    };
    expect(body.ok).toBe(true);
    expect(body.added).toBe(true);
    expect(body.refreshedFlows).toBe(0);
    expect(body.failed).toBe(0);
    const rows = await listSelfParties(ctx);
    expect(rows.map((r) => r.name)).toEqual([SELF_NAME]);
  });

  it('重复新增 -> added=false(不触发回填)', async () => {
    await addSelfParty(ctx, SELF_NAME, 'u1');
    const res = await appAs('u1').request('/api/parties', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: SELF_NAME }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, added: false, refreshedFlows: 0, failed: 0 });
  });

  it('未认证 -> 401', async () => {
    const app = new Hono<AuthEnv>();
    app.route('/api/parties', partiesRoute);
    const res = await app.request('/api/parties', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: SELF_NAME }),
    });
    expect(res.status).toBe(401);
  });
});

describe('DELETE /api/parties/:name', () => {
  it('删除已存在名单 -> removed=true, 之后 GET 不再出现', async () => {
    await addSelfParty(ctx, SELF_NAME, 'u1');
    const res = await appAs('u1').request(
      `/api/parties/${encodeURIComponent(SELF_NAME)}`,
      { method: 'DELETE' },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, removed: true });
    expect(await listSelfParties(ctx)).toEqual([]);
  });

  it('删除不存在的名单 -> removed=false', async () => {
    const res = await appAs('u1').request(
      `/api/parties/${encodeURIComponent(SELF_NAME)}`,
      { method: 'DELETE' },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, removed: false });
  });

  it('未认证 -> 401', async () => {
    const app = new Hono<AuthEnv>();
    app.route('/api/parties', partiesRoute);
    const res = await app.request(
      `/api/parties/${encodeURIComponent(SELF_NAME)}`,
      { method: 'DELETE' },
    );
    expect(res.status).toBe(401);
  });
});