import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import type { AuthEnv } from '../../src/lib/auth-middleware.js';

vi.mock('../../src/graph/repo.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/graph/repo.js')>();
  return { ...mod, graphLabelCounts: vi.fn() };
});
const { graphRoute } = await import('../../src/routes/graph.js');
const { graphLabelCounts } = await import('../../src/graph/repo.js');

function appAs(userId?: string) {
  const app = new Hono<AuthEnv>();
  if (userId) {
    app.use('*', async (c, next) => {
      c.set('user', { id: userId, email: 't@t', role: 'trader' } as never);
      await next();
    });
  }
  app.route('/api/graph', graphRoute);
  return app;
}

describe('GET /api/graph/schema', () => {
  it('未认证 -> 401', async () => {
    expect((await appAs().request('/api/graph/schema')).status).toBe(401);
  });

  it('返回 labels 计数', async () => {
    vi.mocked(graphLabelCounts).mockResolvedValue([{ label: 'Contract', count: 3 }]);
    const res = await appAs('u1').request('/api/graph/schema');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ labels: [{ label: 'Contract', count: 3 }] });
  });

  it('图谱不可用 -> 503', async () => {
    // isGraphUnavailable 识别: 消息含 'NEO4J_PASSWORD not set' 的普通 Error 或 Neo4jError 实例。
    vi.mocked(graphLabelCounts).mockRejectedValue(new Error('NEO4J_PASSWORD not set'));
    const res = await appAs('u1').request('/api/graph/schema');
    expect(res.status).toBe(503);
  });
});