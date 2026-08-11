// Better Auth instance (Phase 1). Owns its own Postgres connection (Pool + a
// Drizzle instance carrying the auth tables) so it is independent of the
// pipeline DbContext (which may be SQLite or Postgres depending on DB_BACKEND).
// Auth always uses Postgres (provider 'pg') -- the sca-pgvector container.
//
// All auth endpoints (sign-up/sign-in/sign-out/session/admin) are mounted in
// index.ts under /api/auth/* via auth.handler. Same-origin (:3001 in prod) means
// the auth cookie flows natively; no special CORS config is needed for cookies.

import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { admin } from 'better-auth/plugins';
import * as authSchema from './auth-schema.js';
import { ac, roles } from './permissions.js';
import { env } from '../env.js';

const databaseUrl =
  process.env.DATABASE_URL ?? 'postgresql://sca:sca_dev_password@localhost:5433/sca';

// Single long-lived pool for auth. Lazy-connecting (first query opens a client),
// so constructing this at module load never blocks even if Postgres is down.
const pool = new Pool({ connectionString: databaseUrl, max: 10 });
const db = drizzle(pool, { schema: authSchema });

// Additional origins Better Auth should trust (comma-separated in env). The
// baseURL is always trusted; TRUSTED_ORIGINS lets users access the app from
// other IPs (e.g. http://10.10.0.2:3001) without "Invalid origin" errors.
const extraTrustedOrigins = (process.env.TRUSTED_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: 'pg' }),
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  trustedOrigins: [env.BETTER_AUTH_URL, ...extraTrustedOrigins],
  emailAndPassword: { enabled: true },
  plugins: [
    admin({
      defaultRole: 'trader',
      ac,
      roles,
    }),
  ],
});
