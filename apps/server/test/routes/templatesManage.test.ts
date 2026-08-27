// P4 Task 3: /api/templates 管理 REST 测试。
// 脚手架照抄 bindingsRead.test.ts(vi.hoisted getDbContext 注入 + 内存库打底),
// 角色按用例参数化(admin/trader)以验证读放开、变更限 admin 的权限矩阵。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { AuthEnv } from '../../src/lib/auth-middleware.js';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import { ensureTemplateSeed } from '../../src/pipeline/templateSeed.js';

const { ctxHolder } = vi.hoisted(() => ({ ctxHolder: { current: null as DbContext | null } }));
vi.mock('../../src/pipeline/db/dbBackend.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/pipeline/db/dbBackend.js')>();
  return { ...mod, getDbContext: () => ctxHolder.current };
});
const { templatesRoute } = await import('../../src/routes/templates.js');

function appAs(userId: string, role: string) {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { id: userId, email: 't@t', role } as never);
    await next();
  });
  app.route('/api/templates', templatesRoute);
  return app;
}

let ctx: DbContext;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
  ctxHolder.current = ctx;
  return ensureTemplateSeed(ctx);
});

describe('/api/templates 管理 REST', () => {
  it('trader PATCH /types -> 403 forbidden(requireRole)', async () => {
    const res = await appAs('u-trader', 'trader')
      .request('/api/templates/types/dt-发票', { method: 'PATCH', body: JSON.stringify({ props: {} }) });
    expect(res.status).toBe(403);
    const data = await res.json() as { error: string };
    expect(data.error).toBe('forbidden');
  });

  it('admin POST /types 创建带 props(bindingsTargetKind 等) -> 201, GET 可见 managed_by=admin', async () => {
    const res = await appAs('admin-1', 'admin').request('/api/templates/types', {
      method: 'POST',
      body: JSON.stringify({
        kind: 'doc_type', name: '磅码单',
        props: { requiredFields: ['毛重'], fieldHints: { 毛重: '皮重后毛重' }, bindingsTargetKind: 'Contract' },
      }),
    });
    expect(res.status).toBe(201);
    const created = await res.json() as { id: string; templateVersion: number };
    expect(created.id).toBe('dt-磅码单');
    expect(created.templateVersion).toBe(1);

    const listRes = await appAs('anyone-1', 'viewer').request('/api/templates/types');
    expect(listRes.status).toBe(200);
    const data = await listRes.json() as { types: Array<{ id: string; props: Record<string, unknown>; managedBy?: string | null }> };
    const row = data.types.find((t) => t.id === 'dt-磅码单');
    expect(row?.props.requiredFields).toEqual(['毛重']);
    expect(row?.managedBy).toBe('admin-1');
  });

  it('admin POST /types 重名(kind+name 唯一) -> 409 duplicate', async () => {
    const res = await appAs('admin-1', 'admin').request('/api/templates/types', {
      method: 'POST',
      body: JSON.stringify({ kind: 'doc_type', name: '合同' }),
    });
    expect(res.status).toBe(409);
    const data = await res.json() as { error: string };
    expect(data.error).toContain('合同');
  });

  it('admin PATCH /rules/:id 改词表 -> GET 反映新词表且 versions 落审计行', async () => {
    const res = await appAs('admin-1', 'admin').request('/api/templates/rules/er-bind-huozhuan', {
      method: 'PATCH',
      body: JSON.stringify({ allowedVocab: ['货权转移', '货交承运人'] }),
    });
    expect(res.status).toBe(200);
    const patched = await res.json() as { id: string; templateVersion: number };
    expect(patched.templateVersion).toBe(1);

    const rulesRes = await appAs('anyone-1', 'viewer').request('/api/templates/rules');
    expect(rulesRes.status).toBe(200);
    const rd = await rulesRes.json() as { rules: Array<{ id: string; allowedVocab: string[]; isActive: boolean }> };
    // listAllEdgeRules 是全量面: 登记 inactive 的 er-exec-fapiao 也应在列。
    expect(rd.rules.some((r) => r.id === 'er-exec-fapiao')).toBe(true);
    expect(rd.rules.find((r) => r.id === 'er-bind-huozhuan')?.allowedVocab).toEqual(['货权转移', '货交承运人']);

    const vr = await appAs('anyone-1', 'viewer').request('/api/templates/versions');
    expect(vr.status).toBe(200);
    const vv = await vr.json() as { versions: Array<{ changeSummary: string; changedBy: string }> };
    expect(vv.versions[0]).toMatchObject({ changeSummary: 'rule.vocab_update er-bind-huozhuan', changedBy: 'admin-1' });
  });

  it('admin DELETE /types/:id 软禁用: is_active=0 且响应带 inUseReasons(预置 active 规则引用)', async () => {
    // 种子里 er-settle-fahuodan(源=dt-发货单)为激活态, 构成占用证据。
    const res = await appAs('admin-1', 'admin').request('/api/templates/types/dt-发货单', { method: 'DELETE' });
    expect(res.status).toBe(200);
    const data = await res.json() as { id: string; inUseReasons: string[]; templateVersion: number };
    expect(data.id).toBe('dt-发货单');
    expect(data.inUseReasons).toContain('激活边规则 er-settle-fahuodan 引用');

    const listRes = await appAs('anyone-1', 'viewer').request('/api/templates/types');
    const ld = await listRes.json() as { types: Array<{ id: string; isActive: boolean }> };
    expect(ld.types.find((t) => t.id === 'dt-发货单')?.isActive).toBe(false);
  });

  it('非 admin(trader/viewer) GET types/rules/versions -> 200 读放开', async () => {
    for (const [userId, role] of [['u-t', 'trader'], ['u-v', 'viewer']] as const) {
      const app = appAs(userId, role);
      for (const p of ['/types', '/rules', '/versions']) {
        const res = await app.request(`/api/templates${p}`);
        expect(res.status).toBe(200);
      }
    }
  });

  it('DELETE 不存在的类型 -> 404 且不带伪占用(fallback 通配不计)', async () => {
    const res = await appAs('admin-1', 'admin').request('/api/templates/types/dt-没有', { method: 'DELETE' });
    expect(res.status).toBe(404);
    const data = await res.json() as { error: string };
    expect(data.error).toContain('没有');
  });

  it('POST /rules 登记悬空 sourceTypeId 允许创建并带 warnings', async () => {
    const res = await appAs('admin-1', 'admin').request('/api/templates/rules', {
      method: 'POST',
      body: JSON.stringify({
        sourceTypeId: 'dt-尚不存在', targetTypeId: '', edgeType: 'binds',
        allowedVocab: ['凭证'], isActive: false,
      }),
    });
    expect(res.status).toBe(201);
    const data = await res.json() as { id: string; warnings: string[]; templateVersion: number };
    expect(data.warnings).toEqual(['sourceTypeId 不存在（登记先行）']);
    // 机械 slug 约定: er-{edgeType 消毒}-{8 位随机}, 与 seed 手工缩写(er-bind-*)无冲突。
    expect(data.id.startsWith('er-binds-')).toBe(true);

    const rulesRes = await appAs('anyone-1', 'viewer').request('/api/templates/rules');
    const rd = await rulesRes.json() as { rules: Array<{ id: string; isActive: boolean; edgeType: string }> };
    const created = rd.rules.find((r) => r.id === data.id);
    expect(created?.isActive).toBe(false);
    expect(created?.edgeType).toBe('binds');
  });
});
