// 对话收藏 (session favorites): MVP 多人试用期的用户反馈通道。用户可收藏自己
// 的会话并附一条反馈备注；admin 可聚合查看全员收藏 (?scope=all) 作为反馈收件箱。
//
// Mounted at /api/favorites in index.ts. Ownership rules mirror sessions.ts:
// a user may only favorite/read their OWN sessions (404 hides existence of
// unknown/not-owned ids); the aggregated all-scope view is admin-only (403).

import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../lib/auth-middleware.js';
import { requireRole } from '../lib/auth-middleware.js';
import {
  clearSessionFavorite,
  getSessionFavorite,
  listAllSessionFavorites,
  listSessionFavorites,
  sessionBelongsTo,
  setSessionFavorite,
} from '../harness/sessionStore.js';

export const favoritesRoute = new Hono<AuthEnv>();

// Note cap: feedback is meant to be a one-liner pointer, not an essay. Long
// product feedback belongs in the issue tracker this list feeds into.
const MAX_NOTE_LENGTH = 2000;

const PutBody = z.object({
  note: z.string().trim().max(MAX_NOTE_LENGTH).optional().nullable(),
});

// List favorites. Default: the current user's own. ?scope=all (admin only)
// aggregates every user's favorites with attribution (userId/userEmail).
favoritesRoute.get('/', requireRole('admin', 'trader', 'viewer'), (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const scopeAll = c.req.query('scope') === 'all';
  if (scopeAll && user.role !== 'admin') {
    return c.json({ error: 'forbidden' }, 403);
  }
  const rows = scopeAll ? listAllSessionFavorites() : listSessionFavorites(user.id);
  return c.json({
    favorites: rows.map((r) => ({
      sessionId: r.sessionId,
      userId: r.userId,
      userEmail: r.userEmail,
      title: r.title ?? null,
      status: r.status,
      note: r.note,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    })),
  });
});

// Read the current user's favorite state for one session. Always 200 with
// { favorited: false } for not-favorited (own or not) — a boolean probe, not
// a resource fetch, so it does not leak existence.
favoritesRoute.get('/:sessionId', (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const sessionId = c.req.param('sessionId');
  if (!sessionBelongsTo(sessionId, user.id)) {
    return c.json({ error: 'not found' }, 404);
  }
  const fav = getSessionFavorite(sessionId, user.id);
  return c.json({
    sessionId,
    favorited: !!fav,
    note: fav?.note ?? null,
    updatedAt: fav?.updatedAt ?? null,
  });
});

// Favorite (upsert) a session with an optional feedback note. Only own
// sessions; only admin/trader (viewer is read-only, mirroring sessions.ts).
favoritesRoute.put('/:sessionId', requireRole('admin', 'trader'), async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const sessionId = c.req.param('sessionId');
  if (!sessionBelongsTo(sessionId, user.id)) {
    return c.json({ error: 'not found' }, 404);
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const parsed = PutBody.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid body', detail: parsed.error.flatten() }, 400);
  }
  // Empty/whitespace-only note normalizes to null (no note), not ''.
  const note = parsed.data.note?.trim() ? parsed.data.note : null;
  const fav = setSessionFavorite(sessionId, user.id, user.email, note);
  return c.json({ ok: true, favorite: { sessionId: fav.sessionId, note: fav.note, updatedAt: fav.updatedAt } });
});

// Remove the current user's favorite of a session. Idempotent: removing a
// non-favorited (but owned) session returns removed=false, still 200.
favoritesRoute.delete('/:sessionId', requireRole('admin', 'trader'), (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const sessionId = c.req.param('sessionId');
  if (!sessionBelongsTo(sessionId, user.id)) {
    return c.json({ error: 'not found' }, 404);
  }
  const removed = clearSessionFavorite(sessionId, user.id);
  return c.json({ ok: true, removed });
});
