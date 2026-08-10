// Better Auth React client (Phase 1). baseURL defaults to same origin
// (production: the Hono server on :3001 serves both API + frontend, so cookies
// flow natively). In dev, Vite proxies /api/* (incl. /api/auth/*) to :3001.
//
// The admin client plugin is added without ac/roles: those are enforced
// server-side (apps/server/src/lib/permissions.ts); the client only needs the
// admin actions surface (e.g. authClient.admin.checkRolePermission).
//
// Usage: authClient.signUp.email(...), authClient.signIn.email(...),
//        authClient.signOut(), authClient.getSession()

import { createAuthClient } from 'better-auth/react';
import { adminClient } from 'better-auth/client/plugins';

export const authClient = createAuthClient({
  plugins: [adminClient()],
});
