// OTel/Langfuse instrumentation MUST be imported before everything else so
// tracing is patched before the AI SDK loads.
import './instrumentation.js';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serveStatic } from '@hono/node-server/serve-static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { env } from './env.js';
import { chatRoute } from './routes/chat.js';
import { approvalCallback } from './routes/approvalCallback.js';
import { statusRoute } from './routes/status.js';
import { sessionsRoute } from './routes/sessions.js';
import { favoritesRoute } from './routes/favorites.js';
import { filesRoute } from './routes/files.js';
import { graphRoute } from './routes/graph.js';
import { quotasRoute } from './routes/quotas.js';
import { reconciliationRoute } from './routes/reconciliation.js';
import { bindingsRoute } from './routes/bindings.js';
import { contractsRoute } from './routes/contracts.js';
import { partiesRoute } from './routes/parties.js';
import { projectsRoute } from './routes/projects.js';
import { reviewRoute } from './routes/review.js';
import { createEvalResultsRoute } from './routes/evalResults.js';
import { evalRunRoute } from './routes/evalRun.js';
import { evalDatasetsRoute } from './routes/evalDatasets.js';
import { ensureBucket } from './lib/minio.js';
import { migrateOnStartup, getDbContext } from './pipeline/db/dbBackend.js';
import { runExtractionBackfill } from './pipeline/extractionBackfill.js';
import { getDriver, closeNeo4j } from './graph/neo4j.js';
import { listToolNames, type Role } from './harness/roleToolRegistry.js';
import { resetBusyOnStartup } from './harness/sessionStore.js';
import { auth } from './lib/auth.js';
import {
  attachSession,
  requireAuth,
  type AuthEnv,
} from './lib/auth-middleware.js';

const DEFAULT_ROLE: Role = 'trader';

// Build info baked by CD into apps/server/dist/build-info.json. Read ONCE at
// boot so a stale pm2 process reports the SHA it was built with — lets the
// deploy verify the running code matches the deployed commit (catches reload
// no-ops that otherwise leave the server on old code).
let BUILD_SHA = 'unknown';
try {
  BUILD_SHA =
    (JSON.parse(readFileSync(new URL('./build-info.json', import.meta.url), 'utf-8')) as { sha?: string }).sha ??
    'unknown';
} catch {
  /* dev / build without build-info.json — leave 'unknown' */
}

// AuthEnv gives the auth middlewares a typed `user` slot on the context.
const app = new Hono<AuthEnv>();

// CORS: allow the Vite dev server, the production origin (BETTER_AUTH_URL),
// and any extra trusted origins (TRUSTED_ORIGINS env). In production the
// frontend is same-origin so the browser does not enforce CORS, but we still
// echo the header so credential-bearing requests are not blocked by a
// restrictive preflight.
const corsAllowedOrigins = new Set(
  [
    'http://localhost:5173',
    env.BETTER_AUTH_URL,
    ...(env.TRUSTED_ORIGINS?.split(',').map((s) => s.trim()).filter(Boolean) ?? []),
  ].filter(Boolean) as string[],
);

app.use(
  '/api/*',
  cors({
    origin: (origin) => (origin && corsAllowedOrigins.has(origin) ? origin : null),
    allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type'],
    // Cookies must be sent cross-origin in dev (Vite :5173 -> API :3001).
    credentials: true,
  }),
);

// Better Auth owns ALL auth routes (sign-up/sign-in/sign-out/session/admin/etc.).
// Same-origin in production (:3001) -> cookie flows natively.
app.on(['POST', 'GET'], '/api/auth/*', (c) => auth.handler(c.req.raw));

// Resolve the session on EVERY request (populates c.get('user'), or null).
app.use('*', attachSession);

app.get('/api/health', (c) =>
  c.json({
    ok: true,
    model: env.OPENAI_MODEL,
    role: DEFAULT_ROLE,
    tools: listToolNames(DEFAULT_ROLE),
    sha: BUILD_SHA,
  }),
);

// Protect all other /api routes (health stays public).
app.use('/api/chat/*', requireAuth);
app.use('/api/sessions/*', requireAuth);
app.use('/api/favorites/*', requireAuth);
app.use('/api/approval/*', requireAuth);
app.use('/api/documents/*', requireAuth);
app.use('/api/eval/*', requireAuth);
app.use('/api/graph/*', requireAuth);
app.use('/api/quotas/*', requireAuth);
app.use('/api/reconcile/*', requireAuth);
app.use('/api/bindings/*', requireAuth);
app.use('/api/contracts/*', requireAuth);
app.use('/api/parties/*', requireAuth);
app.use('/api/projects/*', requireAuth);

app.route('/api', chatRoute);
app.route('/api', approvalCallback);
app.route('/api', statusRoute);
// Phase 2: chat-session list/create/history, scoped to the auth user.
// /api/sessions/:id/status (statusRoute) is a distinct 3-segment path; no clash.
app.route('/api/sessions', sessionsRoute);

// 对话收藏: MVP 用户反馈通道。own-scope 读写 + admin ?scope=all 聚合视图。
app.route('/api/favorites', favoritesRoute);

// Phase 3: file upload (MinIO) + ingest bridge, scoped to the auth user.
app.route('/api/files', filesRoute);

// Feature: in-card correction HITL. Mounted at /api/documents so the route's
// POST /:docId/review resolves to the final path /api/documents/:docId/review.
app.route('/api/documents', reviewRoute);

// Graph REST surface (read-only): user documents, bounded traversal, entity search.
app.route('/api/graph', graphRoute);

// 额度管控(spec 2026-08-25 方案A §6): quotas SSOT + granted 投影 + 即时占用。
app.route('/api/quotas', quotasRoute);
// 对账桥(§5): R1/R2/R3 全量物化 + 报告。
app.route('/api/reconcile', reconciliationRoute);

// Bindings workbench (read-only, spec §5.1): overview / proposals / candidates / contracts.
app.route('/api/bindings', bindingsRoute);

// 合同搜索(spec 2026-08-26): 图谱/绑定页共用组合框。
app.route('/api/contracts', contractsRoute);

// Self-party list management (Task A): DB-backed 自主体名单 + candidates + backfill.
app.route('/api/parties', partiesRoute);

// 项目维度工作台(spec 2026-08-20 §6.1): projects + memberships CRUD + 确认/拒绝。
app.route('/api/projects', projectsRoute);

// Eval results viewer (read-only): scan/aggregate CLI-written results dirs.
app.route('/api/eval', createEvalResultsRoute());

// Eval run orchestration: trigger/kill/live/SSE on the in-memory registry.
app.route('/api/eval', evalRunRoute);

// Eval dataset CRUD: user-authored datasets (core read-only).
app.route('/api/eval', evalDatasetsRoute);

// Production: serve frontend static files from apps/web/dist on the same port.
// Same-origin => no CORS needed; dev mode uses Vite on :5173 with /api proxy.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.resolve(__dirname, '../../web/dist');
app.use('*', serveStatic({ root: webDist }));

const port = env.PORT;

// Graceful shutdown: close the Neo4j driver on SIGTERM/SIGINT so in-flight
// transactions settle and the connection pool is released before exit.
process.on('SIGTERM', async () => { await closeNeo4j(); });
process.on('SIGINT', async () => { await closeNeo4j(); });

// Boot sequence: run DB startup migrations BEFORE accepting traffic, then start
// the HTTP server. migrateOnStartup is a no-op on SQLite (its migration runs
// synchronously inside getDbContext); on Postgres it adds the Phase 2 user_id
// columns + indexes (idempotent). It never throws -- failures log a warning and
// the server still boots (the failing query would then surface a clear error at
// runtime rather than crashing startup). ensureBucket stays best-effort.
(async () => {
  await migrateOnStartup();
  // Background session runtime: any session left 'busy' by a previous process
  // was interrupted by a crash/restart. Flip it to 'interrupted' so the UI can
  // flag it and the caller can decide to resume or discard. Best-effort: a
  // failure here would only leave a stale 'busy' flag, not crash the boot.
  try {
    await resetBusyOnStartup();
  } catch (e) {
    console.error('[boot] resetBusyOnStartup failed:', e instanceof Error ? e.message : e);
  }
  // 接线闭环: 启动抽取回填(不 await, 不阻塞启动)。重新跑历史上抽取
  // pending/skipped/failed/NULL 的已解析文档, 把合同台账回填齐。失败只记日志。
  void runExtractionBackfill({
    ctx: getDbContext(),
    limit: env.EXTRACTION_BACKFILL_LIMIT,
  }).catch((e) => console.error('[extractionBackfill]', e instanceof Error ? e.message : e));
  void ensureBucket();
  // Phase 4: best-effort Neo4j connectivity check at boot. Warn-not-crash: an
  // unreachable graph store logs a warning and graph tools error per-call, but
  // the HTTP server still boots (graph is not on the request critical path).
  if (process.env.NEO4J_PASSWORD) {
    try {
      await getDriver().verifyConnectivity();
      console.log('[boot] neo4j connectivity ok');
    } catch (e) {
      console.warn('[boot] neo4j unreachable, graph tools will error per-call:', (e as Error).message);
    }
  }
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`Server running on http://localhost:${info.port}`);
  });
})();
