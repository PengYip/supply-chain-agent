import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import type { AuthEnv } from '../../src/lib/auth-middleware.js';

const { overviewRoute } = await import('../../src/routes/overview.js');

function appAs(userId: string) {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { id: userId, email: 't@t', role: 'trader' } as any);
    await next();
  });
  app.route('/api/overview', overviewRoute);
  return app;
}

describe('GET /api/overview', () => {
  it('200：local 聚合载荷，五卡片键齐备', async () => {
    const res = await appAs('u1').request('http://test/api/overview', { method: 'GET' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe('local');
    expect(typeof body.asOf).toBe('string');
    expect(Object.keys(body.cards).sort()).toEqual(
      ['executionRate', 'overReceipt', 'paymentBlocks', 'pendingApprovals', 'pendingWriteoff'],
    );
    for (const key of Object.keys(body.cards)) {
      expect(['ok', 'error']).toContain(body.cards[key].status);
    }
  });
});
