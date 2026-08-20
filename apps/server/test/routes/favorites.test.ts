import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import type { AuthEnv, SessionUser } from '../../src/lib/auth-middleware.js';
import { favoritesRoute } from '../../src/routes/favorites.js';
import { createSession, setSessionTitle } from '../../src/harness/sessionStore.js';

// Route-level tests for /api/favorites. The route talks to the shared
// file-backed sessionStore directly (no DbContext indirection like parties),
// so fixtures just create sessions there and the app wrapper injects the user.

function appAs(user: SessionUser | null) {
  const app = new Hono<AuthEnv>();
  if (user) {
    app.use('*', async (c, next) => {
      c.set('user', user);
      await next();
    });
  }
  app.route('/api/favorites', favoritesRoute);
  return app;
}

function trader(id: string, email = `${id}@t`): SessionUser {
  return { id, email, name: null, role: 'trader' };
}
function admin(id: string): SessionUser {
  return { id, email: `${id}@t`, name: null, role: 'admin' };
}
function viewer(id: string): SessionUser {
  return { id, email: `${id}@t`, name: null, role: 'viewer' };
}

const jsonHeaders = { 'Content-Type': 'application/json' };

describe('PUT /api/favorites/:sessionId', () => {
  it('favorites an own session with a note', async () => {
    const s = createSession('trader', 'r1');
    const res = await appAs(trader('r1')).request(`/api/favorites/${s.id}`, {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify({ note: '  对账结果很准  ' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; favorite: { note: string | null } };
    expect(body.ok).toBe(true);
    expect(body.favorite.note).toBe('对账结果很准');
  });

  it('blank note normalizes to null', async () => {
    const s = createSession('trader', 'r1');
    const res = await appAs(trader('r1')).request(`/api/favorites/${s.id}`, {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify({ note: '   ' }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { favorite: { note: string | null } }).favorite.note).toBeNull();
  });

  it('note over 2000 chars -> 400', async () => {
    const s = createSession('trader', 'r1');
    const res = await appAs(trader('r1')).request(`/api/favorites/${s.id}`, {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify({ note: 'x'.repeat(2001) }),
    });
    expect(res.status).toBe(400);
  });

  it("someone else's session -> 404 (existence hidden)", async () => {
    const s = createSession('trader', 'r1');
    const res = await appAs(trader('r2')).request(`/api/favorites/${s.id}`, {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });

  it('unknown session -> 404', async () => {
    const res = await appAs(trader('r1')).request('/api/favorites/no-such-id', {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });

  it('viewer cannot favorite -> 403', async () => {
    const s = createSession('trader', 'v1');
    const res = await appAs(viewer('v1')).request(`/api/favorites/${s.id}`, {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
  });

  it('unauthenticated -> 401', async () => {
    const res = await appAs(null).request('/api/favorites/x', {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });
});

describe('GET /api/favorites/:sessionId', () => {
  it('reports favorited state and note', async () => {
    const s = createSession('trader', 'r1');
    const app = appAs(trader('r1'));
    const before = (await (await app.request(`/api/favorites/${s.id}`)).json()) as {
      favorited: boolean;
      note: string | null;
    };
    expect(before.favorited).toBe(false);

    await app.request(`/api/favorites/${s.id}`, {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify({ note: '值得保留' }),
    });
    const after = (await (await app.request(`/api/favorites/${s.id}`)).json()) as {
      favorited: boolean;
      note: string | null;
    };
    expect(after.favorited).toBe(true);
    expect(after.note).toBe('值得保留');
  });

  it("not-owned session -> 404", async () => {
    const s = createSession('trader', 'r1');
    const res = await appAs(trader('r2')).request(`/api/favorites/${s.id}`);
    expect(res.status).toBe(404);
  });
});

describe('GET /api/favorites', () => {
  it('lists own favorites with title', async () => {
    const s = createSession('trader', 'r1');
    setSessionTitle(s.id, '查合同');
    const app = appAs(trader('r1'));
    await app.request(`/api/favorites/${s.id}`, {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify({ note: 'ok' }),
    });
    const res = await app.request('/api/favorites');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      favorites: Array<{ sessionId: string; title: string | null; note: string | null }>;
    };
    const row = body.favorites.find((r) => r.sessionId === s.id);
    expect(row?.title).toBe('查合同');
    expect(row?.note).toBe('ok');
  });

  it('own scope excludes other users favorites', async () => {
    const s = createSession('trader', 'r2');
    const app2 = appAs(trader('r2'));
    await app2.request(`/api/favorites/${s.id}`, {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify({}),
    });
    const res = await appAs(trader('r1')).request('/api/favorites');
    const body = (await res.json()) as { favorites: Array<{ sessionId: string }> };
    expect(body.favorites.map((r) => r.sessionId)).not.toContain(s.id);
  });

  it('scope=all as admin aggregates with attribution', async () => {
    const s1 = createSession('trader', 'r1');
    const s2 = createSession('trader', 'r2');
    const app1 = appAs(trader('r1', 'one@corp'));
    const app2 = appAs(trader('r2', 'two@corp'));
    await app1.request(`/api/favorites/${s1.id}`, {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify({ note: '发票识别不准' }),
    });
    await app2.request(`/api/favorites/${s2.id}`, {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify({}),
    });

    const res = await appAs(admin('boss')).request('/api/favorites?scope=all');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      favorites: Array<{ sessionId: string; userId: string; userEmail: string | null; note: string | null }>;
    };
    const one = body.favorites.find((r) => r.sessionId === s1.id);
    const two = body.favorites.find((r) => r.sessionId === s2.id);
    expect(one?.userId).toBe('r1');
    expect(one?.userEmail).toBe('one@corp');
    expect(one?.note).toBe('发票识别不准');
    expect(two?.userEmail).toBe('two@corp');
  });

  it('scope=all as trader -> 403', async () => {
    const res = await appAs(trader('r1')).request('/api/favorites?scope=all');
    expect(res.status).toBe(403);
  });

  it('viewer can list own scope (read-only role)', async () => {
    const res = await appAs(viewer('v1')).request('/api/favorites');
    expect(res.status).toBe(200);
  });

  it('unauthenticated -> 401', async () => {
    const res = await appAs(null).request('/api/favorites');
    expect(res.status).toBe(401);
  });
});

describe('DELETE /api/favorites/:sessionId', () => {
  it('removes a favorite, then reports removed=false', async () => {
    const s = createSession('trader', 'r1');
    const app = appAs(trader('r1'));
    await app.request(`/api/favorites/${s.id}`, {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify({}),
    });
    const first = (await (await app.request(`/api/favorites/${s.id}`, { method: 'DELETE' })).json()) as {
      removed: boolean;
    };
    expect(first.removed).toBe(true);
    const second = (await (await app.request(`/api/favorites/${s.id}`, { method: 'DELETE' })).json()) as {
      removed: boolean;
    };
    expect(second.removed).toBe(false);
  });

  it("someone else's favorite is not removable (404 on not-owned session)", async () => {
    const s = createSession('trader', 'r1');
    await appAs(trader('r1')).request(`/api/favorites/${s.id}`, {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify({}),
    });
    const res = await appAs(trader('r2')).request(`/api/favorites/${s.id}`, { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  it('unauthenticated -> 401', async () => {
    const res = await appAs(null).request('/api/favorites/x', { method: 'DELETE' });
    expect(res.status).toBe(401);
  });
});
