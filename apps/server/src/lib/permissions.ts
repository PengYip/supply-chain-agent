// RBAC access control for Better Auth's admin plugin (Phase 1).
//
// `createAccessControl` defines the permission statements (resource -> allowed
// actions). `roles` maps each role name to a set of allowed statements; the admin
// plugin reads both to enforce RBAC on the server. The web client does NOT need
// these (adminClient() infers server-side), so this file is server-only.
//
// defaultStatements (user/session) are merged in so the admin plugin's built-in
// user-management actions keep working alongside the supply-chain-specific ones.

import { createAccessControl } from 'better-auth/plugins/access';
import { defaultStatements } from 'better-auth/plugins/admin/access';

export const ac = createAccessControl({
  ...defaultStatements,
  document: ['create', 'read', 'update', 'delete'],
  file: ['upload', 'read', 'delete'],
  session: ['create', 'read', 'delete'],
  code: ['execute'],
});

export const roles = {
  admin: ac.newRole({
    ...defaultStatements,
    document: ['create', 'read', 'update', 'delete'],
    file: ['upload', 'read', 'delete'],
    session: ['create', 'read', 'delete'],
    code: ['execute'],
  }),
  trader: ac.newRole({
    document: ['create', 'read', 'update'],
    file: ['upload', 'read', 'delete'],
    session: ['create', 'read', 'delete'],
    code: ['execute'],
  }),
  viewer: ac.newRole({
    document: ['read'],
    file: ['read'],
    session: ['read'],
  }),
};
