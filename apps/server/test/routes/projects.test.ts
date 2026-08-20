import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { AuthEnv } from '../../src/lib/auth-middleware.js';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import {
  createProject, upsertProjectMembership, upsertContractLedgerEntry,
} from '../../src/pipeline/db/repositories.js';
import { buildLedgerEntryFromExtraction } from '../../src/pipeline/contractLedger.js';

// 项目维度 API(Task 9, spec 2026-08-20 §6.1): projects / project_memberships 的
// CRUD + 确认/拒绝。确认时图投影(故障隔离), NEO4J_PASSWORD 未设 -> skipped 落
// graph_status, 绝不阻塞指派。
const { ctxHolder } = vi.hoisted(() => ({ ctxHolder: { current: null as DbContext | null } }));
vi.mock('../../src/pipeline/db/dbBackend.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/pipeline/db/dbBackend.js')>();
  return { ...mod, getDbContext: () => ctxHolder.current };
});
const { projectsRoute } = await import('../../src/routes/projects.js');

function appAs(userId: string) {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { id: userId, email: 't@t', role: 'trader' } as never);
    await next();
  });
  app.route('/api/projects', projectsRoute);
  return app;
}

// 本地 .env 可能带 NEO4J_PASSWORD(vitest 会注入 process.env), 图门禁路径断言
// 需要"未设"态 -> 显式删除并在测试后恢复。
const prevNeo4j = process.env.NEO4J_PASSWORD;
beforeEach(() => { delete process.env.NEO4J_PASSWORD; });
afterEach(() => {
  if (prevNeo4j !== undefined) process.env.NEO4J_PASSWORD = prevNeo4j;
  else delete process.env.NEO4J_PASSWORD;
});

let ctx: DbContext;
beforeEach(() => { ctx = createDb(':memory:'); migrate(ctx.sqlite); ctxHolder.current = ctx; });

describe('POST /api/projects', () => {
  it('创建成功(201, code 归一大写); 重复 code -> 409; 空 code/name -> 400', async () => {
    const res = await appAs('u1').request('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'prj-2026-001', name: '曹妃甸项目' }),
    });
    expect(res.status).toBe(201);
    const data = await res.json() as { project: { code: string } };
    expect(data.project.code).toBe('PRJ-2026-001');

    const dup = await appAs('u1').request('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'PRJ-2026-001', name: '重复' }),
    });
    expect(dup.status).toBe(409);

    for (const bad of [{ code: '', name: 'x' }, { code: 'x', name: '' }, {}]) {
      const r = await appAs('u1').request('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bad),
      });
      expect(r.status).toBe(400);
    }
  });
});

describe('GET /api/projects', () => {
  it('列表带 membershipCount(confirmed)/proposedCount', async () => {
    await createProject(ctx, { code: 'PRJ-1', name: '一', userId: 'u1' });
    await upsertProjectMembership(ctx, {
      contractNo: 'HT-A', projectCode: 'PRJ-1', role: '采购', status: 'confirmed',
      proposedBy: 'human', confirmationSource: 'human', createdBy: 'u1',
    }, 'u1');
    await upsertProjectMembership(ctx, {
      contractNo: 'HT-B', projectCode: 'PRJ-1', role: '销售',
      proposedBy: 'system', createdBy: 'system',
    }, 'u1');

    const res = await appAs('u1').request('/api/projects');
    expect(res.status).toBe(200);
    const data = await res.json() as {
      projects: Array<{ code: string; membershipCount: number; proposedCount: number }>;
    };
    const p = data.projects.find((x) => x.code === 'PRJ-1');
    expect(p?.membershipCount).toBe(1);
    expect(p?.proposedCount).toBe(1);
  });
});

describe('GET /api/projects/:code/memberships', () => {
  it('项目不存在 -> 404; 200 返回各状态行(支持 ?status= 过滤)', async () => {
    const notFound = await appAs('u1').request('/api/projects/PRJ-404/memberships');
    expect(notFound.status).toBe(404);

    await createProject(ctx, { code: 'PRJ-1', name: '一', userId: 'u1' });
    await upsertProjectMembership(ctx, {
      contractNo: 'HT-A', projectCode: 'PRJ-1', status: 'confirmed',
      proposedBy: 'human', createdBy: 'u1',
    }, 'u1');
    await upsertProjectMembership(ctx, {
      contractNo: 'HT-B', projectCode: 'PRJ-1', proposedBy: 'system', createdBy: 'system',
    }, 'u1');

    const res = await appAs('u1').request('/api/projects/prj-1/memberships');
    expect(res.status).toBe(200);
    const data = await res.json() as { memberships: Array<{ contractNo: string; status: string }> };
    expect(data.memberships).toHaveLength(2);

    const filtered = await appAs('u1').request('/api/projects/PRJ-1/memberships?status=confirmed');
    const fdata = await filtered.json() as { memberships: Array<{ status: string }> };
    expect(fdata.memberships.every((m) => m.status === 'confirmed')).toBe(true);
    expect(fdata.memberships).toHaveLength(1);
  });
});

describe('POST /api/projects/:code/memberships (人工指派)', () => {
  it('confirmed 行 + contractNo 归一落库; graphStatus skipped 落库(NEO4J_PASSWORD 未设)', async () => {
    await createProject(ctx, { code: 'PRJ-1', name: '一', userId: 'u1' });
    const res = await appAs('u1').request('/api/projects/PRJ-1/memberships', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contractNo: 'ht-2026-009', role: '采购' }),
    });
    expect(res.status).toBe(201);
    const data = await res.json() as {
      membership: { contractNo: string; status: string; confirmationSource: string | null; graphStatus: { status: string } | null } | null;
      graphStatus: { status: string } | null;
    };
    expect(data.membership?.contractNo).toBe('HT-2026-009');
    expect(data.membership?.status).toBe('confirmed');
    expect(data.membership?.confirmationSource).toBe('human');
    expect(data.graphStatus?.status).toBe('skipped');
    expect(data.membership?.graphStatus?.status).toBe('skipped');
  });

  it('role 非法 -> 400; 项目不存在 -> 404; 空 contractNo -> 400', async () => {
    await createProject(ctx, { code: 'PRJ-1', name: '一', userId: 'u1' });
    const badRole = await appAs('u1').request('/api/projects/PRJ-1/memberships', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contractNo: 'HT-1', role: '房地产' }),
    });
    expect(badRole.status).toBe(400);

    const noProject = await appAs('u1').request('/api/projects/PRJ-404/memberships', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contractNo: 'HT-1', role: '采购' }),
    });
    expect(noProject.status).toBe(404);

    const noContract = await appAs('u1').request('/api/projects/PRJ-1/memberships', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contractNo: '   ', role: '采购' }),
    });
    expect(noContract.status).toBe(400);
  });
});

describe('GET /api/projects/:code/rollup', () => {
  it('200 带指标; 项目不存在 -> 404', async () => {
    await createProject(ctx, { code: 'PRJ-1', name: '一', userId: 'u1' });
    await upsertContractLedgerEntry(ctx, buildLedgerEntryFromExtraction({
      documentId: 'DOC-S1',
      docType: '合同',
      fields: {
        合同号: { value: 'HT-S1', sourceSpans: [] },
        金额: { value: 100, sourceSpans: [] },
      },
      fieldMeta: {
        合同号: { strength: 'exact', confidence: 0.95 },
        金额: { strength: 'exact', confidence: 0.9 },
      },
    })!);
    await upsertProjectMembership(ctx, {
      contractNo: 'HT-S1', projectCode: 'PRJ-1', role: '销售', status: 'confirmed',
      proposedBy: 'human', confirmationSource: 'human', createdBy: 'u1',
    }, 'u1');

    const res = await appAs('u1').request('/api/projects/prj-1/rollup');
    expect(res.status).toBe(200);
    const data = await res.json() as {
      rollup: {
        project: { code: string };
        metrics: { salesAmount: number; grossMargin: number };
        contracts: Array<{ contractNo: string }>;
      };
    };
    expect(data.rollup.project.code).toBe('PRJ-1');
    expect(data.rollup.metrics.salesAmount).toBe(100);
    expect(data.rollup.metrics.grossMargin).toBe(100);
    expect(data.rollup.contracts[0]?.contractNo).toBe('HT-S1');

    const notFound = await appAs('u1').request('/api/projects/PRJ-404/rollup');
    expect(notFound.status).toBe(404);
  });
});

describe('POST /api/projects/memberships/:id/confirm | reject', () => {
  it('confirm -> confirmed + confirmation_source human + graphStatus skipped; 未知 id 404', async () => {
    await createProject(ctx, { code: 'PRJ-1', name: '一', userId: 'u1' });
    const id = await upsertProjectMembership(ctx, {
      contractNo: 'HT-A', projectCode: 'PRJ-1', role: '销售',
      proposedBy: 'system', createdBy: 'system',
    }, 'u1');

    const res = await appAs('u1').request(`/api/projects/memberships/${id}/confirm`, { method: 'POST' });
    expect(res.status).toBe(200);
    const data = await res.json() as {
      membership: { status: string; confirmationSource: string | null } | null;
      graphStatus: { status: string } | null;
    };
    expect(data.membership?.status).toBe('confirmed');
    expect(data.membership?.confirmationSource).toBe('human');
    expect(data.graphStatus?.status).toBe('skipped');

    const unknown = await appAs('u1').request('/api/projects/memberships/PM-404/confirm', { method: 'POST' });
    expect(unknown.status).toBe(404);
  });

  it('reject -> rejected(不触图, graphStatus null)', async () => {
    await createProject(ctx, { code: 'PRJ-1', name: '一', userId: 'u1' });
    const id = await upsertProjectMembership(ctx, {
      contractNo: 'HT-A', projectCode: 'PRJ-1', proposedBy: 'system', createdBy: 'system',
    }, 'u1');

    const res = await appAs('u1').request(`/api/projects/memberships/${id}/reject`, { method: 'POST' });
    expect(res.status).toBe(200);
    const data = await res.json() as { membership: { status: string; graphStatus: unknown } | null };
    expect(data.membership?.status).toBe('rejected');
    expect(data.membership?.graphStatus).toBeNull();
  });
});
