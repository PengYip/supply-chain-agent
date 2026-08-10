// OTel/Langfuse instrumentation MUST be imported before everything else so
// tracing is patched before the AI SDK loads.
import './instrumentation.js';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serveStatic } from '@hono/node-server/serve-static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from './env.js';
import { chatRoute } from './routes/chat.js';
import { approvalCallback } from './routes/approvalCallback.js';
import { statusRoute } from './routes/status.js';
import { sessionsRoute } from './routes/sessions.js';
import { listToolNames, type Role } from './harness/roleToolRegistry.js';
import { auth } from './lib/auth.js';
import {
  attachSession,
  requireAuth,
  type AuthEnv,
} from './lib/auth-middleware.js';

const DEFAULT_ROLE: Role = 'trader';

// AuthEnv gives the auth middlewares a typed `user` slot on the context.
const app = new Hono<AuthEnv>();

// Allow the Vite dev server (http://localhost:5173) to call the API directly.
app.use(
  '/api/*',
  cors({
    origin: 'http://localhost:5173',
    allowMethods: ['GET', 'POST', 'OPTIONS'],
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
  }),
);

// Protect all other /api routes (health stays public).
app.use('/api/chat/*', requireAuth);
app.use('/api/sessions/*', requireAuth);
app.use('/api/approval/*', requireAuth);

app.route('/api', chatRoute);
app.route('/api', approvalCallback);
app.route('/api', statusRoute);
// Phase 2: chat-session list/create/history, scoped to the auth user.
// /api/sessions/:id/status (statusRoute) is a distinct 3-segment path; no clash.
app.route('/api/sessions', sessionsRoute);

// Production: serve frontend static files from apps/web/dist on the same port.
// Same-origin => no CORS needed; dev mode uses Vite on :5173 with /api proxy.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.resolve(__dirname, '../../web/dist');
app.use('*', serveStatic({ root: webDist }));

const port = env.PORT;

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Server running on http://localhost:${info.port}`);
});
