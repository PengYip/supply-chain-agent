// OTel/Langfuse instrumentation MUST be imported before everything else so
// tracing is patched before the AI SDK loads.
import './instrumentation.js';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { env } from './env.js';
import { chatRoute } from './routes/chat.js';
import { approvalCallback } from './routes/approvalCallback.js';
import { listToolNames, type Role } from './harness/roleToolRegistry.js';

const DEFAULT_ROLE: Role = 'trader';

const app = new Hono();

// Allow the Vite dev server (http://localhost:5173) to call the API directly.
app.use(
  '/api/*',
  cors({
    origin: 'http://localhost:5173',
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type'],
  }),
);

app.get('/api/health', (c) =>
  c.json({
    ok: true,
    model: env.OPENAI_MODEL,
    role: DEFAULT_ROLE,
    tools: listToolNames(DEFAULT_ROLE),
  }),
);

app.route('/api', chatRoute);
app.route('/api', approvalCallback);

const port = env.PORT;

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Server running on http://localhost:${info.port}`);
});
