import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { AuthEnv } from '../../src/lib/auth-middleware.js';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import {
  findGraphLinkById, findGraphLinkByTriple, saveGraphLink,
} from '../../src/pipeline/db/repositories.js';

// 图关联工作台 REST(spec 2026-08-25 方案A §6): /api/graph/links。人工作台直建
// confirmed(human); 提案-确认流; props 白名单裁剪; 图同步 skipped 时落
// graph_status 供前端重试。scaffold 对齐 bindingsWrite.test.ts。

const { ctxHolder } = vi.hoisted(() => ({ ctxHolder: { current: null as DbContext | null } }));
vi.mock('../../src/pipeline/db/dbBackend.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/pipeline/db/dbBackend.js')>();
  return { ...mod, getDbContext: () => ctxHolder.current };
});
const { graphRoute } = await import('../../src/routes/graph.js');

function appAs(userId: string) {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { id: userId, email: 't@t', role: 'trader' } as never);
    await next();
  });
  app.route('/api/graph', graphRoute);
  return app;
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

function post(app: ReturnType<typeof appAs>, path: string, body: unknown) {
  return app.request(`/api/graph${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

describe('POST /api/graph/links (人工作台直建)', () => {
  it('创建 confirmed(human) + graphSync=skipped 落 graph_status', async () => {
    const res = await post(appAs('u1'), '/links', {
      kind: 'correlates', srcKey: 'CG-1', srcLabel: '采购一号', dstKey: 'XS-1', dstLabel: '销售一号',
      props: { share: 1 },
    });
    expect(res.status).toBe(200);
    const data = await res.json() as { linkId: string; graphSync: string };
    expect(data.graphSync).toBe('skipped');
    const row = await findGraphLinkById(ctx!, data.linkId, 'u1');
    expect(row?.status).toBe('confirmed');
    expect(row?.confirmationSource).toBe('human');
    expect(row?.srcKind).toBe('Contract');
    expect(row?.dstKind).toBe('Contract');
    expect(row?.props).toEqual({ share: 1 });
    expect(row?.graphStatus?.status).toBe('skipped');
  });

  it('relates -> Project/Project 节点类型', async () => {
    const res = await post(appAs('u1'), '/links', { kind: 'relates', srcKey: 'P1', dstKey: 'P2' });
    expect(res.status).toBe(200);
    const data = await res.json() as { linkId: string };
    const row = await findGraphLinkById(ctx!, data.linkId, 'u1');
    expect(row?.srcKind).toBe('Project');
    expect(row?.dstKind).toBe('Project');
  });

  it('同 triple 重发 -> existing:true 幂等返回同 id', async () => {
    const first = await post(appAs('u1'), '/links', { kind: 'correlates', srcKey: 'CG-1', dstKey: 'XS-1' });
    const d1 = await first.json() as { linkId: string };
    const second = await post(appAs('u1'), '/links', { kind: 'correlates', srcKey: 'CG-1', dstKey: 'XS-1', props: { share: 0.5 } });
    const d2 = await second.json() as { linkId: string; existing: boolean };
    expect(d2.existing).toBe(true);
    expect(d2.linkId).toBe(d1.linkId);
    expect((await findGraphLinkById(ctx!, d1.linkId, 'u1'))?.props).toEqual({ share: 0.5 });
  });

  it('props 白名单外键被剥离(hack 不落库)', async () => {
    const res = await post(appAs('u1'), '/links', {
      kind: 'correlates', srcKey: 'CG-1', dstKey: 'XS-1',
      props: { share: 1, hack: '<script>' } as Record<string, unknown>,
    });
    expect(res.status).toBe(200);
    const data = await res.json() as { linkId: string };
    const row = await findGraphLinkById(ctx!, data.linkId, 'u1');
    expect(row?.props).toEqual({ share: 1 });
  });

  it('非法 kind -> 400; 空键 -> 400', async () => {
    expect((await post(appAs('u1'), '/links', { kind: 'owns', srcKey: 'A', dstKey: 'B' })).status).toBe(400);
    expect((await post(appAs('u1'), '/links', { kind: 'correlates', srcKey: '', dstKey: 'B' })).status).toBe(400);
  });
});

describe('提案-确认状态机', () => {
  async function seedProposed(): Promise<string> {
    return saveGraphLink(ctx!, {
      kind: 'relates', srcKind: 'Project', srcKey: 'P1', dstKind: 'Project', dstKey: 'P2',
      createdBy: 'agent', props: {},
    }, 'u1');
  }

  it('confirm: proposed->confirmed(human) + graphSync 落库; 重复 -> 409', async () => {
    const id = await seedProposed();
    const res = await post(appAs('u1'), '/links/confirm', { id });
    expect(res.status).toBe(200);
    expect((await findGraphLinkById(ctx!, id, 'u1'))?.status).toBe('confirmed');
    const again = await post(appAs('u1'), '/links/confirm', { id });
    expect(again.status).toBe(409);
  });

  it('reject: proposed->rejected; 非 proposed -> 409', async () => {
    const id = await seedProposed();
    expect((await post(appAs('u1'), '/links/reject', { id })).status).toBe(200);
    expect((await findGraphLinkById(ctx!, id, 'u1'))?.status).toBe('rejected');
    expect((await post(appAs('u1'), '/links/reject', { id })).status).toBe(409);
  });

  it('remove: confirmed->rejected; 非 confirmed -> 409', async () => {
    const id = await seedProposed();
    await post(appAs('u1'), '/links/confirm', { id });
    expect((await post(appAs('u1'), '/links/remove', { id })).status).toBe(200);
    expect((await findGraphLinkById(ctx!, id, 'u1'))?.status).toBe('rejected');
    const fresh = await seedProposed();
    expect((await post(appAs('u1'), '/links/remove', { id: fresh })).status).toBe(409);
  });

  it('404: 不存在或他人行', async () => {
    expect((await post(appAs('u1'), '/links/confirm', { id: 'GL-404' })).status).toBe(404);
    const id = await seedProposed();
    expect((await post(appAs('u2'), '/links/confirm', { id })).status).toBe(404);
  });
});

describe('PATCH /links/:id/props (分摊录入通道)', () => {
  it('confirmed 行 patch 白名单键合并 + 重同步(无图 -> skipped)', async () => {
    const res = await post(appAs('u1'), '/links', { kind: 'correlates', srcKey: 'CG-1', dstKey: 'XS-1', props: { share: 1 } });
    const { linkId } = await res.json() as { linkId: string };
    const patch = await appAs('u1').request(`/api/graph/links/${linkId}/props`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ props: { allocatedAmount: 100, allocatedQuantity: 50, evil: 'x' } }),
    });
    expect(patch.status).toBe(200);
    const row = await findGraphLinkById(ctx!, linkId, 'u1');
    expect(row?.props).toEqual({ share: 1, allocatedAmount: 100, allocatedQuantity: 50 });
  });

  it('404: 他人行', async () => {
    const { linkId } = await (await post(appAs('u1'), '/links', { kind: 'correlates', srcKey: 'CG-1', dstKey: 'XS-1' })).json() as { linkId: string };
    const patch = await appAs('u2').request(`/api/graph/links/${linkId}/props`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ props: { note: 'x' } }),
    });
    expect(patch.status).toBe(404);
  });
});

describe('GET /api/graph/links', () => {
  it('proposals 只列 proposed; 列表默认排除 rejected', async () => {
    await saveGraphLink(ctx!, { kind: 'relates', srcKind: 'Project', srcKey: 'P1', dstKind: 'Project', dstKey: 'P2', createdBy: 'a', props: {} }, 'u1');
    await post(appAs('u1'), '/links', { kind: 'correlates', srcKey: 'CG-1', dstKey: 'XS-1' });

    const proposals = await (await appAs('u1').request('/api/graph/links/proposals')).json() as { proposals: unknown[] };
    expect(proposals.proposals).toHaveLength(1);

    const rej = await findGraphLinkByTriple(ctx!, { kind: 'relates', srcKey: 'P1', dstKey: 'P2' }, 'u1');
    await post(appAs('u1'), '/links/reject', { id: rej!.id });

    const proposalsAfter = await (await appAs('u1').request('/api/graph/links/proposals')).json() as { proposals: unknown[] };
    expect(proposalsAfter.proposals).toHaveLength(0);
    const list = await (await appAs('u1').request('/api/graph/links')).json() as { links: Array<{ status: string }> };
    expect(list.links.every((l) => l.status !== 'rejected')).toBe(true);
    expect(list.links).toHaveLength(1); // confirmed 的那条
  });

  it('401: 无 user', async () => {
    const app = new Hono<AuthEnv>();
    app.route('/api/graph', graphRoute);
    expect((await app.request('/api/graph/links')).status).toBe(401);
  });
});
