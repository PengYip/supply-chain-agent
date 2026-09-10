import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import type { AuthEnv } from '../../src/lib/auth-middleware.js';

const { toolsRoute } = await import('../../src/routes/tools.js');
const { listPermissions } = await import('../../src/harness/permissionGate.js');

function appAs(userId: string) {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { id: userId, email: 't@t', role: 'trader' } as any);
    await next();
  });
  app.route('/api/tools', toolsRoute);
  return app;
}

const get = (app: Hono<AuthEnv>, path: string) =>
  app.request(`http://test/api/tools${path}`, { method: 'GET' });

describe('GET /api/tools/inventory', () => {
  it('200：SSOT 工具清单 × 注册表对比，阶段1 移除的四工具只存在于黑名单', async () => {
    const res = await get(appAs('u1'), '/inventory');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe('docs/tool-inventory.json');
    expect(body.version).toBe('2026-09-10');
    const byName = new Map<string, {
      status: string; group?: string; registry: { mounted: boolean }; removalPlan?: string;
    }>(body.tools.map((t: { name: string }) => [t.name, t]));
    // 分组透出（2026-09-08 治理后台分组展示）：active 工具的 view 必须携带
    // 非空 group，取值 ∈ inventory policy.groups 词汇。
    const groupVocab: string[] = body.policy.groups;
    expect(groupVocab.length, 'policy.groups vocabulary must be non-empty').toBeGreaterThan(0);
    for (const [name, t] of byName) {
      expect(t.group?.trim(), `${name}: view tool missing group`).toBeTruthy();
      expect(groupVocab, `${name}: group "${t.group}" outside policy.groups`).toContain(t.group!);
    }
    // 2026-09-08 阶段1 移除落地：不再出现在 live tools[]，也不再有
    // deprecated+mounted 的过渡态；只存在于 removed[] 黑名单。
    const removedNames = new Set<string>(
      (body.removed as Array<{ name: string }>).map((r) => r.name),
    );
    for (const name of ['query_orders', 'cross_check', 'verify_document_fields', 'extract_fields']) {
      expect(byName.get(name), `${name} must leave tools[]`).toBeUndefined();
      expect(removedNames.has(name), `${name} must be blacklisted in removed[]`).toBe(true);
    }
    expect(byName.get('query_business')!.registry.mounted).toBe(true);
    // 黑名单工具也绝不允许以挂载态回流。
    const mountedNames = (body.tools as Array<{ name: string; registry: { mounted: boolean } }>)
      .filter((t) => t.registry.mounted).map((t) => t.name);
    for (const name of removedNames) {
      expect(mountedNames, `removed tool "${name}" must not be mounted`).not.toContain(name);
    }
  });
});

describe('GET /api/tools/permissions', () => {
  it('200：levels 词汇 + 注册声明快照与 listPermissions 一致', async () => {
    const res = await get(appAs('u1'), '/permissions');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect([...body.levels]).toEqual(['L1', 'L2', 'L3']);
    expect(body.entries).toEqual(listPermissions());
    expect(body.entries.some((e: { level: string }) => e.level === 'L3')).toBe(false);
  });
});
