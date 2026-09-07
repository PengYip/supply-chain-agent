// apps/server/test/routes/ontologySchema.test.ts
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import type { AuthEnv } from '../../src/lib/auth-middleware.js';
import { ontologyRoute } from '../../src/routes/ontology.js';

function appAs(userId: string) {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { id: userId, email: 't@t', role: 'trader' } as never);
    await next();
  });
  app.route('/api/ontology', ontologyRoute);
  return app;
}

describe('GET /api/ontology/schema', () => {
  it('401 without session', async () => {
    const app = new Hono<AuthEnv>();
    app.route('/api/ontology', ontologyRoute);
    const res = await app.request('http://test/api/ontology/schema');
    expect(res.status).toBe(401);
  });

  it('returns the registry projection with labels', async () => {
    const res = await appAs('u1').request('http://test/api/ontology/schema');
    expect(res.status).toBe(200);
    const json = (await res.json()) as { entities: Array<{ name: string; label: string; ownFields: string[] }> };
    expect(json.entities).toHaveLength(11);
    const contract = json.entities.find((e) => e.name === 'TradeContract')!;
    expect(contract.label).toBe('贸易合同');
    expect(contract.ownFields).toContain('contractNo');
  });
});
