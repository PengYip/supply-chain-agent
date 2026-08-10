// Hono auth middleware (Phase 1). Three layers:
//   attachSession -- runs on ALL requests; resolves the Better Auth session from
//                    the cookie/header and stores the user (or null) on the
//                    Hono context for downstream handlers.
//   requireAuth   -- 401 when no user is attached (use on protected /api routes).
//   requireRole   -- 403 when the user's role is not in the allow-list.
//
// /api/health stays public (health checks need no auth). All other /api routes
// are gated with requireAuth in index.ts. requireRole is available for
// role-scoped endpoints (e.g. admin-only).

import type { MiddlewareHandler } from 'hono';
import { auth } from './auth.js';

/** The user fields stored on the Hono context after session resolution. */
export interface SessionUser {
  id: string;
  email: string;
  name?: string | null;
  role?: string | null;
}

/** Hono Variables shape used by the auth middlewares. */
export type AuthEnv = {
  Variables: {
    user: SessionUser | null;
  };
};

function toSessionUser(u: unknown): SessionUser | null {
  if (!u || typeof u !== 'object') return null;
  const obj = u as Record<string, unknown>;
  const id = obj.id;
  const email = obj.email;
  if (typeof id !== 'string' || typeof email !== 'string') return null;
  return {
    id,
    email,
    name: typeof obj.name === 'string' ? obj.name : null,
    role: typeof obj.role === 'string' ? obj.role : null,
  };
}

/** Resolve the session and attach the user (or null) to c.var.user. */
export const attachSession: MiddlewareHandler<AuthEnv> = async (c, next) => {
  try {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    c.set('user', session?.user ? toSessionUser(session.user) : null);
  } catch {
    // Session resolution must never break the request path; treat as anonymous.
    c.set('user', null);
  }
  await next();
};

/** 401 if no authenticated user is attached. */
export const requireAuth: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const user = c.get('user');
  if (!user) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  await next();
};

/** 403 if the user's role is not in the allow-list (401 if not signed in). */
export const requireRole = (
  ...allowedRoles: string[]
): MiddlewareHandler<AuthEnv> =>
  async (c, next) => {
    const user = c.get('user');
    if (!user) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    const role = user.role ?? 'viewer';
    if (!allowedRoles.includes(role)) {
      return c.json(
        { error: 'forbidden', requiredRole: allowedRoles, yourRole: role },
        403,
      );
    }
    await next();
  };
