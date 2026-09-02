import { describe, it, expect, beforeEach, vi } from 'vitest';
import { APICallError, type LanguageModel, type ModelMessage } from 'ai';
import type { DbContext } from '../../src/pipeline/db/client.js';
import { fakeStreamingModel } from '../fakeLanguageModel.js';

// Incident 2026-09-02 (dev 10.10.0.2, session 00530fe8): a provider call that
// failed BEFORE producing any chunk left the assistant message with ZERO
// parts, ZERO llm_calls rows, ZERO session_events, and a closing text that
// wrongly blamed tools/step-cap ("no tool ever ran"). Verified against
// ai@6.0.259: streamText converts internal errors into an in-band terminal
// `{type:'error'}` fullStream part (index.mjs:8253-8263), toUIMessageStream
// forwards it as `{type:'error', errorText}` (index.mjs:8628-8634), the
// consumer's for-await receives it, and onFinish STILL runs from the stream
// flush (handleUIMessageStreamFinish, index.mjs:6419-6448). New contract:
//   1. terminal stream errors are audited (ERROR llm_call, kind 'chat') and
//      console.error'd with a JSON diagnostic line;
//   2. the persisted closing text is the API-failure variant (provider
//      message for classified arrears) when the message has NO tool parts;
//   3. tools-then-stop turns keep the tools/step-cap closing text;
//   4. happy turns are unchanged (no fallback, audit status 'ok');
//   5. aborted runs keep today's skip semantics (no fallback, no error audit).

const { ctxHolder, fetchDeepseekBalanceMock } = vi.hoisted(() => ({
  ctxHolder: { current: null as DbContext | null },
  // DeepSeek balance re-check is fire-and-forget on arrears-classified errors;
  // mocked so tests never touch the network and can assert the trigger.
  fetchDeepseekBalanceMock: vi.fn(async () => null),
}));
vi.mock('../../src/pipeline/db/dbBackend.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/pipeline/db/dbBackend.js')>();
  return { ...mod, getDbContext: () => ctxHolder.current };
});
vi.mock('../../src/harness/deepseekBalance.js', () => ({
  fetchDeepseekBalance: fetchDeepseekBalanceMock,
  formatDeepseekBalance: (b: { available: boolean; currency: string | null; totalBalance: string | null }) =>
    `可用=${b.available}${b.currency ? `, ${b.currency} 总额=${b.totalBalance ?? '?'}` : ''}`,
}));

const { runSession, describeStreamError } = await import('../../src/harness/runSession.js');
const { createSession, loadSession } = await import('../../src/harness/sessionStore.js');
const { listLlmCalls, flushUsageAudit } = await import('../../src/harness/usageAudit.js');
const { createDb, migrate } = await import('../../src/pipeline/db/client.js');

let ctx: DbContext;

beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
  ctxHolder.current = ctx;
  fetchDeepseekBalanceMock.mockClear();
});

/** Fake model whose doStream throws immediately (provider call never yields a chunk). */
function failingModel(err: unknown): LanguageModel {
  return {
    specificationVersion: 'v2' as const,
    provider: 'fake',
    modelId: 'fake-model',
    supportedUrls: {} as Record<string, RegExp[]>,
    async doGenerate() {
      throw new Error('not used');
    },
    async doStream() {
      throw err;
    },
  } as unknown as LanguageModel;
}

interface ScriptStep {
  toolCall?: { toolCallId: string; toolName: string; input: unknown };
  /** When absent, a non-toolCall step emits a bare finish('stop') with NO content. */
  text?: string;
}

// Scripted fake model mirroring approvalResume.runtime.test.ts (verified V2
// shape). A {text: undefined} trailing step ends the turn with tool parts but
// no text -- the circuit-breaker/step-cap signature for the closing fallback.
function scriptedModel(script: ScriptStep[]): LanguageModel {
  let calls = 0;
  const usage = () => ({ inputTokens: 1, outputTokens: 1, totalTokens: 2 });
  return {
    specificationVersion: 'v2' as const,
    provider: 'fake',
    modelId: 'fake-model',
    supportedUrls: {} as Record<string, RegExp[]>,
    async doGenerate() {
      throw new Error('not used');
    },
    async doStream() {
      const step = script[Math.min(calls, script.length - 1)];
      calls++;
      const stream = new ReadableStream<unknown>({
        start(controller) {
          if (step.toolCall) {
            controller.enqueue({
              type: 'tool-call',
              toolCallId: step.toolCall.toolCallId,
              toolName: step.toolCall.toolName,
              input: JSON.stringify(step.toolCall.input),
            });
            controller.enqueue({ type: 'finish', finishReason: 'tool-calls', usage: usage() });
          } else if (step.text != null) {
            controller.enqueue({ type: 'text-start', id: 't1' });
            controller.enqueue({ type: 'text-delta', id: 't1', delta: step.text });
            controller.enqueue({ type: 'text-end', id: 't1' });
            controller.enqueue({ type: 'finish', finishReason: 'stop', usage: usage() });
          } else {
            // Bare finish, no content: turn ends with only tool parts.
            controller.enqueue({ type: 'finish', finishReason: 'stop', usage: usage() });
          }
          controller.close();
        },
      });
      return { stream };
    },
  } as unknown as LanguageModel;
}

function assistantOf(loaded: Awaited<ReturnType<typeof loadSession>>): any {
  return (loaded?.messages ?? []).find((m: any) => m.role === 'assistant');
}

function textPartsOf(msg: any): Array<{ type: string; text?: string }> {
  return ((msg?.parts ?? []) as Array<{ type: string; text?: string }>).filter((p) => p.type === 'text');
}

async function errorRows() {
  await flushUsageAudit();
  const llm = await listLlmCalls(ctx);
  return llm.rows.filter((r) => r.status === 'error');
}

describe('describeStreamError (diagnostic format)', () => {
  it('embeds the classified provider code, status code, and raw message', () => {
    const err = new APICallError({
      message: 'Insufficient Balance',
      url: 'https://api.deepseek.com/chat/completions',
      requestBodyValues: {},
      statusCode: 402,
      isRetryable: false,
    });
    const text = describeStreamError(err);
    expect(text).toContain('provider_arrears');
    expect(text).toContain('status=402');
    expect(text).toContain('Insufficient Balance');
  });

  it('falls back to the error name, or stream_error for non-Error throws', () => {
    const text = describeStreamError(new Error('connection reset'));
    expect(text).toContain('Error: connection reset');

    const text2 = describeStreamError('just a string failure');
    expect(text2).toContain('stream_error');
    expect(text2).toContain('just a string failure');
  });
});

describe('runSession terminal stream-error handling (incident 2026-09-02)', () => {
  it('records an ERROR llm_call and persists the arrears closing text on a 402 provider failure', async () => {
    const s = await createSession('trader', 'u-err402');
    const err = new APICallError({
      message: 'Insufficient Balance',
      url: 'https://api.deepseek.com/chat/completions',
      requestBodyValues: {},
      statusCode: 402,
      isRetryable: false,
    });

    await runSession({
      sessionId: s.id,
      userId: 'u-err402',
      role: 'trader',
      messages: [{ role: 'user', content: '录入单据' }] as ModelMessage[],
      auditTraceId: 't-err402',
      abortSignal: new AbortController().signal,
      model: failingModel(err),
    });

    const rows = await errorRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('chat');
    expect(rows[0]!.sessionId).toBe(s.id);
    expect(rows[0]!.error).toContain('provider_arrears');
    expect(rows[0]!.error).toContain('status=402');
    expect(rows[0]!.error).toContain('Insufficient Balance');
    // Arrears classification triggers the fire-and-forget balance re-check.
    expect(fetchDeepseekBalanceMock).toHaveBeenCalledTimes(1);

    const assistant = assistantOf(await loadSession(s.id));
    expect(assistant).toBeTruthy();
    const texts = textPartsOf(assistant);
    expect(texts).toHaveLength(1);
    // Arrears is classified: the provider-specific user message wins.
    expect(texts[0]!.text).toContain('欠费');
    expect(texts[0]!.text).not.toContain('工具调用连续失败');
  });

  it('records an ERROR llm_call and persists the server-error closing text on a 500 provider failure', async () => {
    const s = await createSession('trader', 'u-err500');
    const err = new APICallError({
      message: 'Internal Server Error',
      url: 'https://api.deepseek.com/chat/completions',
      requestBodyValues: {},
      statusCode: 500,
      isRetryable: false,
    });

    await runSession({
      sessionId: s.id,
      userId: 'u-err500',
      role: 'trader',
      messages: [{ role: 'user', content: '录入单据' }] as ModelMessage[],
      auditTraceId: 't-err500',
      abortSignal: new AbortController().signal,
      model: failingModel(err),
    });

    const rows = await errorRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.error).toContain('status=500');
    expect(rows[0]!.error).toContain('Internal Server Error');
    // Non-arrears errors must NOT trigger the balance re-check.
    expect(fetchDeepseekBalanceMock).not.toHaveBeenCalled();

    const assistant = assistantOf(await loadSession(s.id));
    const texts = textPartsOf(assistant);
    expect(texts).toHaveLength(1);
    // Dual-provider table (2026-09-02): 500 classifies as provider_server, so
    // the closing text is the specific server-error label, not the generic one.
    expect(texts[0]!.text).toContain('服务端异常');
    expect(texts[0]!.text).not.toContain('工具调用连续失败');
  });

  it('keeps the tools/step-cap closing text when the message has tool parts (no stream error)', async () => {
    const s = await createSession('trader', 'u-tools');
    await runSession({
      sessionId: s.id,
      userId: 'u-tools',
      role: 'trader',
      messages: [{ role: 'user', content: '连续查多份合同' }] as ModelMessage[],
      auditTraceId: 't-tools',
      abortSignal: new AbortController().signal,
      model: scriptedModel([
        { toolCall: { toolCallId: 'call_1', toolName: 'query_contract', input: { contractNo: 'HT-1' } } },
        {}, // bare finish: tool parts but no text -> old fallback signature
      ]),
    });

    const rows = await errorRows();
    expect(rows).toHaveLength(0);

    const assistant = assistantOf(await loadSession(s.id));
    const partTypes = ((assistant?.parts ?? []) as Array<{ type: string }>).map((p) => p.type);
    expect(partTypes.some((t) => t.startsWith('tool-') || t === 'dynamic-tool')).toBe(true);
    const texts = textPartsOf(assistant);
    expect(texts).toHaveLength(1);
    expect(texts[0]!.text).toContain('工具调用连续失败');
    expect(texts[0]!.text).not.toContain('模型服务调用失败');
  });

  it('happy path unchanged: text persists as-is, audit stays ok, no fallback appended', async () => {
    const s = await createSession('trader', 'u-ok');
    await runSession({
      sessionId: s.id,
      userId: 'u-ok',
      role: 'trader',
      messages: [{ role: 'user', content: 'hi' }] as ModelMessage[],
      auditTraceId: 't-ok',
      abortSignal: new AbortController().signal,
      model: fakeStreamingModel(['hel', 'lo']),
    });

    const rows = await errorRows();
    expect(rows).toHaveLength(0);

    const assistant = assistantOf(await loadSession(s.id));
    const texts = textPartsOf(assistant);
    expect(texts).toHaveLength(1);
    expect(texts[0]!.text).toBe('hello');
  });

  it('aborted run keeps skip semantics: no fallback text, no error audit', async () => {
    const s = await createSession('trader', 'u-abort');
    const controller = new AbortController();
    controller.abort(); // pre-aborted signal

    await runSession({
      sessionId: s.id,
      userId: 'u-abort',
      role: 'trader',
      messages: [{ role: 'user', content: 'hi' }] as ModelMessage[],
      auditTraceId: 't-abort',
      abortSignal: controller.signal,
      model: fakeStreamingModel(['hel', 'lo']),
    });

    const rows = await errorRows();
    expect(rows).toHaveLength(0);

    const assistant = assistantOf(await loadSession(s.id));
    expect(textPartsOf(assistant)).toHaveLength(0);
  });
});
