import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { convertToModelMessages, type ModelMessage, type UIMessage } from 'ai';
import { z } from 'zod';
import type { Role } from '../harness/roleToolRegistry.js';
import {
  createSession,
  loadSession,
  appendMessages,
  sessionBelongsTo,
  getSessionStatus,
} from '../harness/sessionStore.js';
import { startSessionRun } from '../harness/runManager.js';
import { runSession, extractMessageText } from '../harness/runSession.js';
import type { AuthEnv } from '../lib/auth-middleware.js';

export const chatRoute = new Hono<AuthEnv>();

// AI SDK 6 `useChat` posts UIMessages in the `parts` format
// ({ id, role, parts: [...] }), NOT the legacy { role, content: string }.
// Be permissive here and let `convertToModelMessages` do the real validation.
//
// contextFiles (Phase 3+): the client may attach the files the user "@-mentioned"
// in this turn so the agent has their docIds up front. We surface them as a
// leading system message that tells the model to use recall_documents to read
// the actual content (the message carries metadata only, never file bytes).
const BodySchema = z.object({
  messages: z.array(z.any()).min(1),
  role: z.enum(['trader']).default('trader'),
  contextFiles: z
    .array(z.object({ docId: z.string(), filename: z.string() }))
    .optional()
    .default([]),
});

chatRoute.post('/chat', async (c) => {
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const parsed = BodySchema.safeParse(json);
  if (!parsed.success) {
    return c.json(
      { error: 'Invalid request body', detail: parsed.error.flatten() },
      400,
    );
  }

  const { messages, role, contextFiles } = parsed.data;

  // Session: reuse x-session-id if it exists AND belongs to the authenticated
  // user (Phase 2 data isolation), else create a new one owned by the user.
  // Background runtime: session context is set via ALS inside RunManager's
  // runSessionContext wrapper (not the legacy single-slot setSessionContext).
  const user = c.get('user');
  const userId = user?.id ?? null;
  // Phase 4 RBAC: map the authenticated user's role to the agent role. For now
  // every authenticated user runs the trader agent (admin/trader/undefined -> all
  // map to 'trader'); viewer->agent-role isolation is a future enhancement. The
  // route is already requireAuth-gated in index.ts, so a user is always attached.
  const agentRole: Role = (user?.role === 'admin' || user?.role === 'trader' || !user?.role) ? 'trader' : 'trader';
  const headerId = c.req.header('x-session-id');
  const candidate = headerId && userId ? (sessionBelongsTo(headerId, userId) ? loadSession(headerId) : null) : null;
  const loaded = headerId && !userId ? loadSession(headerId) : candidate;
  const sessionId = loaded?.id ?? createSession(role as Role, userId).id;
  const priorMessages = loaded?.messages ?? [];
  // First turn = no prior messages. Detecting via `loaded == null` misses the
  // primary user flow: the sidebar pre-creates an empty session (新建会话), the
  // first message carries that x-session-id, loadSession returns the empty
  // session (loaded != null) but with zero messages — title-gen must still fire.
  const isFirstTurn = priorMessages.length === 0;

  const auditTraceId = randomUUID();
  console.log(
    JSON.stringify({
      event: 'chat_request',
      traceId: auditTraceId,
      role,
      sessionId,
      resumed: loaded != null,
    }),
  );

  // Convert incoming UIMessages -> model messages for streamText input. The raw
  // client UIMessages are persisted as the canonical form (NOT the converted
  // ModelMessages); the assistant UIMessage is persisted via onFinish below.
  let newModelMessages: ModelMessage[];
  try {
    newModelMessages = (await convertToModelMessages(messages)) as ModelMessage[];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to convert messages', detail: msg }, 400);
  }
  appendMessages(sessionId, messages as UIMessage[]);
  // Convert prior persisted UIMessages -> ModelMessages for streamText input.
  const priorModelMessages = priorMessages.length > 0
    ? (await convertToModelMessages(priorMessages as UIMessage[]))
    : ([] as ModelMessage[]);

  // When the user @-references files this turn, surface them as a leading system
  // message so the agent has the docIds/filenames up front. The model is told to
  // use recall_documents to read the actual content (we never inline file bytes
  // into the prompt -- the recall tool is the grounded read path).
  let streamMessages: ModelMessage[];
  if (contextFiles.length > 0) {
    const fileList = contextFiles
      .map((f, i) => `${i + 1}. ${f.filename} (docId: ${f.docId})`)
      .join('\n');
    const contextMsg: ModelMessage = {
      role: 'system',
      content:
        '用户在本次对话中引用了以下文件。请使用 recall 工具搜索文档内容来回答关于这些文件的问题：\n' +
        fileList,
    };
    streamMessages = [contextMsg, ...priorModelMessages, ...newModelMessages];
  } else {
    streamMessages = [...priorModelMessages, ...newModelMessages];
  }

  // firstUserText for title-gen (runSession handles title-gen via isFirstTurn).
  const firstUserText = isFirstTurn
    ? extractMessageText(newModelMessages.find((m) => m.role === 'user'))
    : undefined;

  try {
    // Background runtime: start a detached run via RunManager and return
    // immediately. The run consumes the stream + persists via onFinish +
    // emits to the session event bus (GET /api/sessions/:id/events). The HTTP
    // response no longer carries the stream — disconnects do NOT abort the run.
    const start = startSessionRun(sessionId, userId ?? undefined, agentRole, (signal) =>
      runSession({
        sessionId,
        userId: userId ?? undefined,
        role: agentRole,
        messages: streamMessages,
        auditTraceId,
        abortSignal: signal,
        isFirstTurn,
        firstUserText,
      }),
    );
    if ('conflict' in start) {
      const st = getSessionStatus(sessionId);
      return c.json({ error: 'session_busy', activeRunId: st?.runId }, 409);
    }
    return c.json(
      { sessionId, runId: start.runId, status: 'busy' },
      { status: 200, headers: { 'x-session-id': sessionId } },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[chat] setup error:', msg);
    return c.json({ error: 'Chat run failed', detail: msg }, 500);
  }
});
