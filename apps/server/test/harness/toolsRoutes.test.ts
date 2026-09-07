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
  it('200：SSOT 工具清单 × 注册表对比，deprecated+mounted 如实在列', async () => {
    const res = await get(appAs('u1'), '/inventory');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe('docs/tool-inventory.json');
    expect(body.version).toBe('2026-08-28');
    const byName = new Map<string, {
      status: string; registry: { mounted: boolean }; removalPlan?: string;
    }>(body.tools.map((t: { name: string }) => [t.name, t]));
    for (const name of ['query_orders', 'cross_check', 'verify_document_fields', 'extract_fields']) {
      const t = byName.get(name)!;
      expect(t.status).toBe('deprecated');
      expect(t.registry.mounted).toBe(true);
      expect(t.removalPlan).toBeTruthy();
    }
    expect(byName.get('query_business')!.registry.mounted).toBe(true);
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
