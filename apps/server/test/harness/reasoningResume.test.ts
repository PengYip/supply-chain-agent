import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { convertToModelMessages, type ModelMessage, type UIMessage } from 'ai';
import { runStream } from '../../src/harness/agent.js';
import { createDb, migrate } from '../../src/pipeline/db/client.js';
import { env } from '../../src/env.js';
import {
  createSession,
  appendMessages,
  loadSession,
} from '../../src/harness/sessionStore.js';

/**
 * Task 4: DeepSeek `reasoning_content` resume-survival investigation.
 *
 * CONCERN (docs/context-handoff.md §6): DeepSeek returns `reasoning_content`
 * and V4 requires it to be echoed back on every assistant message across a
 * kill-process -> restart -> loadSession -> runStream resume. "思考不是废料,
 * 而是状态." If sessionStore (or AI SDK 6 rehydration) strips reasoning parts,
 * multi-turn resume loses intermediate reasoning state.
 *
 * INVESTIGATION RESULT -- this is an SDK/PROVIDER LIMITATION, NOT a
 * sessionStore bug. The reasoning round-trip itself is sound:
 *
 *   1. AI SDK 6 ModelMessage DOES carry reasoning: AssistantModelMessage.content
 *      includes reasoningPartSchema = { type:'reasoning', text } (see
 *      ai/src/prompt/message.ts).
 *   2. streamText accumulates `reasoning-start/delta/end` stream parts into a
 *      reasoning ContentPart (ai/src/generate-text/stream-text.ts ~1000), and
 *      toResponseMessages (to-response-messages.ts:52) pushes
 *      {type:'reasoning', text} into the assistant ModelMessage.
 *   3. sessionStore stores ModelMessage via JSON.stringify and rehydrates via
 *      JSON.parse (sessionStore.ts appendMessages/loadSession) -- a lossless
 *      plain-JSON round-trip that does NOT strip any part type, reasoning
 *      included.
 *   4. On resume, convertToLanguageModelMessage (convert-to-language-model-
 *      prompt.ts:273) maps a reasoning part back to {type:'reasoning', text}
 *      in the outgoing LanguageModelV3Message, so DeepSeek would receive it.
 *
 * THE GAP lives entirely in @ai-sdk/openai's Chat Completions provider: its
 * doStream (@ai-sdk/openai/dist/index.mjs ~1066) reads only choice.delta.content
 * / tool_calls / annotations. It NEVER reads choice.delta.reasoning_content
 * (the field DeepSeek actually streams), so it never emits reasoning-* stream
 * parts. Reasoning handling in that package exists only for the Responses API
 * (`.response()`), which agent.ts deliberately avoids (it corrupts DeepSeek
 * tool-call id correlation, per agent.ts comment). Net: reasoning_content never
 * enters the ModelMessage in the first place, so there is nothing for
 * sessionStore to drop.
 *
 * RESOLVED (Task 4 V2 -- provider swap): the gap above was fixed by swapping
 * agent.ts from @ai-sdk/openai `createOpenAI().chat()` to @ai-sdk/deepseek
 * `createDeepSeek().chat()` (pinned @ai-sdk/deepseek@2.0.52). The deepseek
 * provider's Chat Completions doStream reads `delta.reasoning_content`
 * (dist index.mjs:641) and emits reasoning-start/delta/end (642-665), so
 * reasoning_content now flows into the ModelMessage as a reasoning part and
 * survives the sessionStore round-trip end-to-end. Still .chat() (Chat
 * Completions) -- tool-call ids are preserved verbatim, never regenerated, so
 * there is ZERO tool-call-id risk versus the prior openai.chat() wiring (both
 * are Chat-Completions-only with id-required validation). The OPENAI_* env
 * names are unchanged (DeepSeek creds misnamed as OPENAI_*, pointing at
 * api.deepseek.com / deepseek-v4-flash) to avoid .env/deployment churn.
 *
 * Note: @ai-sdk/deepseek@2.0.52 ships as a V3-spec provider
 * (specificationVersion 'v3'); ai@6's `LanguageModel` union accepts V3 natively,
 * so no compatibility shim is needed.
 *
 * THE TESTS BELOW: (1) a fake LanguageModelV2 that emits reasoning-* stream
 * parts + a tool call -- mirroring what the deepseek provider emits internally
 * -- proving the reasoning part survives runStream -> response.messages, then
 * persists through the UIMessage-canonical round-trip (appendMessages stores
 * UIMessages; loadSession rehydrates UIMessages; convertToModelMessages
 * re-derives ModelMessages carrying the reasoning part); (2) a construction
 * test asserting the swapped provider wiring (createDeepSeek().chat()) yields a
 * valid V3 model, exercising the model-resolution path agent.ts now uses in
 * production (no network).
 */

interface FakeModelOptions {
  toolCall: { id: string; toolName: string; input: unknown };
}

// Minimal fake LanguageModelV2 that emits a reasoning part THEN a tool call on
// step 1 (mirroring a DeepSeek reasoning + tool-call turn), and a short final
// text on step 2+. Follows the e2e-loop.test.ts seam shape.
function createReasoningFakeModel(opts: FakeModelOptions) {
  let calls = 0;
  const usage = () => ({ inputTokens: 1, outputTokens: 1, totalTokens: 2 });
  return {
    specificationVersion: 'v2' as const,
    provider: 'fake',
    modelId: 'fake-reasoning-model',
    supportedUrls: {} as Record<string, RegExp[]>,
    async doGenerate() {
      return {
        content: [{ type: 'text' as const, text: 'ok' }],
        finishReason: 'stop' as const,
        usage: usage(),
        warnings: [] as unknown[],
      };
    },
    async doStream() {
      calls++;
      const stream = new ReadableStream<unknown>({
        start(controller) {
          if (calls === 1) {
            // Reasoning part -- the exact stream protocol a correct provider
            // emits to surface DeepSeek reasoning_content (see stream-text.ts).
            controller.enqueue({ type: 'reasoning-start', id: 'r1' });
            controller.enqueue({
              type: 'reasoning-delta',
              id: 'r1',
              delta: '用户要录入合同，先调 ingest_document 解析。',
            });
            controller.enqueue({ type: 'reasoning-end', id: 'r1' });
            // Tool call (complete part form, v2).
            controller.enqueue({
              type: 'tool-call',
              toolCallId: opts.toolCall.id,
              toolName: opts.toolCall.toolName,
              input: JSON.stringify(opts.toolCall.input),
            });
            controller.enqueue({
              type: 'finish',
              finishReason: 'tool-calls',
              usage: usage(),
            });
          } else {
            controller.enqueue({ type: 'text-start', id: 't1' });
            controller.enqueue({ type: 'text-delta', id: 't1', delta: '录入完成' });
            controller.enqueue({ type: 'text-end', id: 't1' });
            controller.enqueue({ type: 'finish', finishReason: 'stop', usage: usage() });
          }
          controller.close();
        },
      });
      return { stream };
    },
  };
}

function drain(result: Awaited<ReturnType<typeof runStream>>): Promise<void> {
  return new Promise((resolve, reject) => {
    void (async () => {
      try {
        for await (const _ of result.fullStream as AsyncIterable<unknown>) {
          /* drain to completion so execute + response.messages resolve */
        }
        resolve();
      } catch (e) {
        reject(e);
      }
    })();
  });
}

function reasoningParts(msgs: ModelMessage[]): Array<{ text: string }> {
  return msgs
    .filter((m) => m.role === 'assistant')
    .flatMap((m) =>
      Array.isArray(m.content)
        ? m.content.filter((p) => (p as { type?: string }).type === 'reasoning')
        : [],
    ) as Array<{ text: string }>;
}

describe('reasoning_content resume survival (Task 4)', () => {
  it('reasoning parts survive runStream -> appendMessages -> loadSession round-trip', async () => {
    const ctx = createDb(':memory:');
    migrate(ctx.sqlite);
    // ingest_document enforces a path allowlist against env.INGEST_ROOT.
    const f = join(env.INGEST_ROOT, `reasoning-${Date.now()}.txt`);
    writeFileSync(f, '合同号: HT-2024-001\n金额: 2860000', 'utf-8');

    const fake = createReasoningFakeModel({
      toolCall: {
        id: 'call_1',
        toolName: 'ingest_document',
        input: { sourceUri: f, docType: '合同', modality: 'digital' },
      },
    });

    const messages: ModelMessage[] = [{ role: 'user', content: '请录入这份合同' }];
    const result = await runStream({
      messages,
      role: 'trader',
      auditTraceId: 'reasoning-trace',
      model: fake as any,
      deps: { ctx, extraction: { model: fake as any } },
    });

    await drain(result);

    const response = await result.response;
    const responseMessages = response.messages as ModelMessage[];

    // (1) streamText DID carry the reasoning part into response.messages. This
    //     confirms AI SDK 6 surfaces reasoning when a provider emits it.
    const before = reasoningParts(responseMessages);
    expect(before.length, 'response.messages should contain a reasoning part').toBeGreaterThan(0);
    expect(before[0].text).toBe('用户要录入合同，先调 ingest_document 解析。');

    // (2) CORE ROUND-TRIP under the UIMessage-canonical contract: the assistant
    //     UIMessage (mirroring SDK responseMessage shape, reasoning part
    //     included) is persisted via appendMessages, reloaded via loadSession,
    //     and re-converted via convertToModelMessages. The re-converted
    //     assistant ModelMessage must still carry the reasoning part with the
    //     same text -- proving reasoning survives the persistence round-trip.
    const reasoningText = before[0].text;
    const assistantUIMessage: UIMessage = {
      id: randomUUID(),
      role: 'assistant',
      parts: [
        { type: 'reasoning', text: reasoningText } as UIMessage['parts'][number],
        { type: 'text', text: '录入完成' },
      ],
    };
    const session = createSession('trader');
    appendMessages(session.id, [assistantUIMessage]);
    const loaded = loadSession(session.id);
    expect(loaded, 'loaded session must exist').not.toBeNull();

    const reconverted = await convertToModelMessages(loaded!.messages as UIMessage[]);
    const after = reasoningParts(reconverted);
    expect(after.length, 're-converted messages must still contain the reasoning part').toBeGreaterThanOrEqual(1);
    expect(after[0].text).toBe(reasoningText);

    // Structural fidelity: the re-converted assistant ModelMessage's content
    // array still has BOTH the reasoning part and a text part.
    const reconvertedAssistant = reconverted.find(
      (m) => m.role === 'assistant' && Array.isArray(m.content) &&
        (m.content as Array<{ type?: string }>).some((p) => p.type === 'reasoning'),
    );
    expect(reconvertedAssistant).toBeDefined();
    const types = (reconvertedAssistant!.content as Array<{ type?: string }>).map((p) => p.type);
    expect(types).toContain('reasoning');
    expect(types).toContain('text');
  });

  it('re-feeding loaded messages into runStream (resume) does not throw', async () => {
    const ctx = createDb(':memory:');
    migrate(ctx.sqlite);
    const f = join(env.INGEST_ROOT, `reasoning-resume-${Date.now()}.txt`);
    writeFileSync(f, '合同号: HT-2024-001\n金额: 2860000', 'utf-8');

    const fake = createReasoningFakeModel({
      toolCall: {
        id: 'call_2',
        toolName: 'ingest_document',
        input: { sourceUri: f, docType: '合同', modality: 'digital' },
      },
    });

    // Turn 1: produce messages that include reasoning + a tool call, then
    // persist the assistant turn as a UIMessage (UIMessage-canonical contract).
    const result1 = await runStream({
      messages: [{ role: 'user', content: '请录入这份合同' }],
      role: 'trader',
      auditTraceId: 'reasoning-resume-1',
      model: fake as any,
      deps: { ctx, extraction: { model: fake as any } },
    });
    await drain(result1);
    const response1 = await result1.response;
    const reasoning1 = reasoningParts(response1.messages as ModelMessage[]);
    expect(reasoning1.length, 'turn 1 produced a reasoning part').toBeGreaterThan(0);
    const assistantUIMessage1: UIMessage = {
      id: randomUUID(),
      role: 'assistant',
      parts: [
        { type: 'reasoning', text: reasoning1[0].text } as UIMessage['parts'][number],
        { type: 'text', text: '录入完成' },
      ],
    };
    const session = createSession('trader');
    appendMessages(session.id, [assistantUIMessage1]);

    // Turn 2 (resume): load the persisted UIMessage history and re-convert it
    // to ModelMessages for runStream. This is the kill-process -> restart ->
    // loadSession path under the UIMessage-canonical contract.
    const loaded = loadSession(session.id)!;
    const reconvertedLoaded = await convertToModelMessages(loaded.messages as UIMessage[]);
    expect(reasoningParts(reconvertedLoaded).length).toBeGreaterThan(0);

    let threw = false;
    let errorMsg = '';
    try {
      const result2 = await runStream({
        messages: reconvertedLoaded,
        role: 'trader',
        auditTraceId: 'reasoning-resume-2',
        model: fake as any,
        deps: { ctx, extraction: { model: fake as any } },
      });
      await drain(result2);
      // response must still resolve on the resumed turn.
      await result2.response;
    } catch (e) {
      threw = true;
      errorMsg = e instanceof Error ? e.message : String(e);
    }
    expect(threw, `resume runStream threw: ${errorMsg}`).toBe(false);
  });
});

describe('deepseek provider swap wiring (Task 4 V2)', () => {
  it('createDeepSeek().chat() constructs a V3 model via the agent.ts resolution path', async () => {
    // Mirrors the production model-resolution path in agent.ts runStream (the
    // `model ?? createDeepSeek({...}).chat(env.OPENAI_MODEL)` branch). Tests
    // inject fakes, so without this case the swapped provider import + chain
    // would be unexercised. Construction makes NO network call; a dummy apiKey
    // is used (loadApiKey only runs per-request inside getHeaders).
    const { createDeepSeek } = await import('@ai-sdk/deepseek');
    const model = createDeepSeek({
      baseURL: env.OPENAI_BASE_URL,
      apiKey: 'test-key-no-network',
    }).chat(env.OPENAI_MODEL);

    // V3 spec -- the native form that surfaces delta.reasoning_content as
    // reasoning-start/delta/end (see @ai-sdk/deepseek dist index.mjs:641-665).
    expect(model).toBeDefined();
    expect((model as { specificationVersion?: string }).specificationVersion).toBe('v3');
  });
});
