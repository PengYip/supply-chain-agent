import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { convertToModelMessages, type ModelMessage, type UIMessage, type LanguageModel } from 'ai';
import { z } from 'zod';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { runStream, recordL2PendingFromResponse } from '../harness/agent.js';
import type { Role } from '../harness/roleToolRegistry.js';
import {
  createSession,
  loadSession,
  appendMessages,
  sessionBelongsTo,
  setSessionTitle,
} from '../harness/sessionStore.js';
import { setSessionContext } from '../harness/sessionContext.js';
import { generateSessionTitle } from '../harness/titleGen.js';
import { env } from '../env.js';
import type { AuthEnv } from '../lib/auth-middleware.js';
import { getDbContext } from '../pipeline/db/dbBackend.js';
import type { DbContext } from '../pipeline/db/client.js';
import { ensureDocumentExtracted } from '../pipeline/tools/documentEntry.js';
import { buildIngestDeps } from '../pipeline/ingestModel.js';

export const chatRoute = new Hono<AuthEnv>();

// One DbContext reused across requests (same 'pipeline.db' file / DB as the
// agent + uploads + review). Same lazy-singleton shape as routes/files.ts.
let _ctx: DbContext | null = null;
function ctx(): DbContext {
  if (!_ctx) _ctx = getDbContext();
  return _ctx;
}

// Phase 5: title-generation model handle. Lazy singleton reusing the SAME
// factory as agent.ts (createDeepSeek(...).chat(env.OPENAI_MODEL)). Only used on
// the first turn of a session (one-shot title), so construction amortizes.
let titleModel: LanguageModel | null = null;
function getTitleModel(): LanguageModel {
  if (!titleModel) {
    titleModel = createDeepSeek({
      baseURL: env.OPENAI_BASE_URL,
      apiKey: env.OPENAI_API_KEY,
    }).chat(env.OPENAI_MODEL);
  }
  return titleModel;
}

/**
 * Defensively extract text from a message, handling BOTH shapes:
 *   - ModelMessage: `.content` is a string or an array of `{type:'text', text}` parts.
 *   - UIMessage (AI SDK 6 parts format): `.parts` is an array of `{type:'text', text}`.
 * Without the `.parts` fallback, firstUserText/firstReplyText come back empty and
 * the title falls back to '新会话' every time. `any` is intentional — the two
 * message shapes don't share a TS structural field for text content.
 */
function extractMessageText(msg: any): string {
  const content = msg?.content;
  if (typeof content === 'string') return content;
  const parts = Array.isArray(content) ? content : msg?.parts;
  if (Array.isArray(parts)) {
    return parts
      .filter((p: any) => p?.type === 'text')
      .map((p: any) => String(p?.text ?? ''))
      .join('');
  }
  return '';
}

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

function isModelNotFound(message: string): boolean {
  return /model not found|model .* does not exist|invalid model|unknown model/i.test(
    message,
  );
}

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
  // Sets the request context so L3 tool execute can attribute pending tickets.
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
  setSessionContext(sessionId);

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
  // message so the agent has the docIds/filenames up front. Model B: uploads are
  // STORAGE-ONLY (parse_status='uploaded'), so referencing a file triggers
  // on-demand parsing right here (the chat backstop). ensureDocumentExtracted
  // single-flights with the /process endpoint (one run per doc, shared), skips
  // already-terminal docs, re-runs 'uploaded'/'failed' ones, and re-extracts
  // docs whose auto-extraction was skipped/failed (e.g. a 60s timeout). We cap
  // the total wait (~180s) and proceed regardless: the message notes each file's
  // resulting state so the agent tells the user honestly about needs_ocr files.
  let streamMessages: ModelMessage[];
  if (contextFiles.length > 0) {
    const deps = buildIngestDeps();
    const deadlineMs = Date.now() + 180_000;
    const statusByDoc = new Map<string, string>();
    await Promise.all(
      contextFiles.map(async (f) => {
        const remaining = deadlineMs - Date.now();
        if (remaining <= 0) return;
        try {
          const res = await Promise.race([
            ensureDocumentExtracted(ctx(), f.docId, deps, userId ?? undefined),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), remaining)),
          ]);
          if (res) statusByDoc.set(f.docId, res.parseStatus);
        } catch {
          // unknown doc / unexpected error -> the message below just omits state.
        }
      }),
    );
    const fileList = contextFiles
      .map((f, i) => {
        const st = statusByDoc.get(f.docId) ?? 'unknown';
        return `${i + 1}. ${f.filename} (docId: ${f.docId}, parseStatus: ${st})`;
      })
      .join('\n');
    const contextMsg: ModelMessage = {
      role: 'system',
      content:
        '用户在本次对话中引用了以下文件。系统已自动解析并自动抽取这些文件(结构化字段/关系/标签/向量均已就绪), 无需再次录入。\n' +
        '规则:\n' +
        '- 已解析(parsed)的文件: 直接调用 present_document_review 向用户呈现复核卡。\n' +
        '- 仅当上下文明确说明抽取缺失/失败时, 才调用 extract_fields 重新抽取。\n' +
        '- 禁止对已上传文件调用 ingest_document(上传为仅存储, 且路径不在录入根目录, 会失败)。\n' +
        '- 若某文件为 needs_ocr, 如实告知用户该文件需 OCR 处理后才能使用。\n' +
        '文件列表:\n' + fileList,
    };
    streamMessages = [contextMsg, ...priorModelMessages, ...newModelMessages];
  } else {
    streamMessages = [...priorModelMessages, ...newModelMessages];
  }

  try {
    const result = await runStream({
      messages: streamMessages,
      role: agentRole,
      auditTraceId,
      sessionId,
      userId: userId ?? undefined,
    });

    // After the stream completes, record any L2 soft-gate approvals requested
    // this turn. The assistant UIMessage itself is persisted via
    // toUIMessageStreamResponse onFinish (the clean server-side source).
    // `result.response` is a PromiseLike (no .catch), so use the 2-arg .then.
    result.response.then(
      async (r) => {
        try {
          recordL2PendingFromResponse(sessionId, r.messages);
        } catch (err) {
          console.error('[chat] L2 record failed:', err instanceof Error ? err.message : err);
        }
        // Phase 5: fire-and-forget title generation on the first exchange.
        // void + .catch so title-gen NEVER breaks a chat turn.
        if (isFirstTurn) {
          const firstUserText = extractMessageText(
            newModelMessages.find((m) => m.role === 'user'),
          );
          const firstReplyText = extractMessageText(
            r.messages.find((m) => m.role === 'assistant'),
          );
          void generateSessionTitle(getTitleModel(), firstUserText, firstReplyText)
            .then((title) => setSessionTitle(sessionId, title))
            .catch(() => {
              /* title-gen is best-effort; never surface to the user */
            });
        }
      },
      () => {
        /* stream errors surface via onError below */
      },
    );

    const streamResp = result.toUIMessageStreamResponse({
      originalMessages: messages as UIMessage[],
      generateMessageId: randomUUID,
      onFinish: ({ responseMessage }) => {
        try {
          appendMessages(sessionId, [responseMessage]);
        } catch (err) {
          console.error('[chat] persist failed:', err instanceof Error ? err.message : err);
        }
      },
      onError: (error: unknown) => {
        const msg = error instanceof Error ? error.message : String(error);
        console.error('[chat] streamText error:', msg);
        if (isModelNotFound(msg)) {
          return `Model "${process.env.OPENAI_MODEL ?? ''}" was rejected by the provider (${msg}). Try OPENAI_MODEL=deepseek-chat.`;
        }
        return msg;
      },
    });

    // Return the stream with the session id so the client can resume.
    return new Response(streamResp.body, {
      status: streamResp.status,
      headers: { ...streamResp.headers, 'x-session-id': sessionId },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[chat] setup error:', msg);
    return c.json({ error: 'Chat stream failed', detail: msg }, 500);
  }
});
