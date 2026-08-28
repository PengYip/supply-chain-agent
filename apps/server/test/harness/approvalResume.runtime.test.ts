import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { convertToModelMessages, type ModelMessage, type UIMessage } from 'ai';
import { runStream } from '../../src/harness/agent.js';
import { runSession } from '../../src/harness/runSession.js';
import { createDb, migrate } from '../../src/pipeline/db/client.js';
import {
  createSession,
  appendMessages,
  loadSession,
  listPending,
} from '../../src/harness/sessionStore.js';
import { env } from '../../src/env.js';

/**
 * Phase 4 runtime semantics (spec §2), verified end-to-end with a scripted
 * fake LanguageModelV2 and an in-memory pipeline DB:
 *  1. turn-1 gate: a needsApproval (L2) tool-call emits tool-approval-request
 *     and the stream FINISHES (I-1: the RunManager slot is released, not held).
 *  2. approve resume: history + transient tool-approval-response -> the SDK
 *     re-executes the gated tool (update_document_fields) and the model finishes.
 *  3. deny resume: approved:false -> the tool does NOT execute; the model
 *     receives the denial and answers.
 *  4. runSession persists the resume reply as a NEW message id (spec §5.3).
 */

interface ScriptStep {
  toolCall?: { toolCallId: string; toolName: string; input: unknown };
  text?: string;
}

// Canned fake model: each doStream call consumes the next script step.
// A toolCall step emits tool-call + finish('tool-calls'); a text step emits
// text parts + finish('stop'). Shape mirrors e2e-loop.test.ts (verified V2).
// Optional onPrompt captures the converted messages handed to the model.
function scriptedModel(script: ScriptStep[], onPrompt?: (prompt: unknown) => void) {
  let calls = 0;
  const usage = () => ({ inputTokens: 1, outputTokens: 1, totalTokens: 2 });
  return {
    specificationVersion: 'v2' as const,
    provider: 'fake',
    modelId: 'fake-model',
    supportedUrls: {} as Record<string, RegExp[]>,
    async doGenerate() {
      return {
        content: [{ type: 'text' as const, text: 'ok' }],
        finishReason: 'stop' as const,
        usage: usage(),
        warnings: [] as unknown[],
      };
    },
    async doStream(options?: { prompt?: unknown }) {
      const step = script[Math.min(calls, script.length - 1)];
      calls++;
      if (onPrompt) onPrompt(options?.prompt);
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
          } else {
            controller.enqueue({ type: 'text-start', id: 't1' });
            controller.enqueue({ type: 'text-delta', id: 't1', delta: step.text ?? 'done' });
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

// Seed one document row in a FRESH in-memory ctx by driving ingest_document
// (an L1 tool, executes immediately) with a canned tool-call.
async function seedDoc() {
  const ctx = createDb(':memory:');
  migrate(ctx.sqlite);
  const f = join(env.INGEST_ROOT, `apr-${Date.now()}-${randomUUID().slice(0, 6)}.txt`);
  writeFileSync(f, '合同号: HT-2024-009\n金额: 1000', 'utf-8');
  const fake = scriptedModel([
    { toolCall: { toolCallId: 'call_seed', toolName: 'ingest_document', input: { sourceUri: f, docType: '合同', modality: 'digital' } } },
    { text: 'seeded' },
  ]);
  const result = await runStream({
    messages: [{ role: 'user', content: '录入' }],
    role: 'trader',
    auditTraceId: 't-seed',
    sessionId: 'rt-seed',
    model: fake as any,
    deps: { ctx, extraction: { model: fake as any } },
  });
  let docId = '';
  for await (const part of result.fullStream as AsyncIterable<any>) {
    if (part?.type === 'tool-result' && part.toolName === 'ingest_document') {
      docId = part.output?.docId ?? '';
    }
  }
  expect(docId).toMatch(/^DOC-/);
  return { ctx, docId };
}

const userUIMsg = (text: string): UIMessage =>
  ({ id: randomUUID(), role: 'user', parts: [{ type: 'text', text }] }) as UIMessage;

describe('L2 gate/resume runtime semantics (fake model, in-memory ctx)', () => {
  it('turn-1 gates update_document_fields, the stream finishes, pending is recorded; approve resume re-executes it', async () => {
    const { ctx, docId } = await seedDoc();
    const s = await createSession('trader', 'u-rt1');
    await appendMessages(s.id, [userUIMsg('给文档打标签')]);

    // --- Turn 1 (production shape: via runSession, which persists + records) ---
    const gateFake = scriptedModel([
      { toolCall: { toolCallId: 'call_tag', toolName: 'update_document_fields', input: { docId, tags: ['重要'] } } },
      { text: '已打标' },
    ]);
    await runSession({
      sessionId: s.id,
      userId: 'u-rt1',
      role: 'trader',
      messages: await convertToModelMessages((await loadSession(s.id))!.messages as UIMessage[]),
      auditTraceId: 'rt-gate',
      abortSignal: new AbortController().signal,
      model: gateFake as any,
    });

    // The assistant message with the approval-requested part IS persisted
    // (spec §2 Q4 closure) with its SDK-generated approval id.
    const loaded = (await loadSession(s.id))!;
    const assistantMsg = loaded.messages.find((m) => m.role === 'assistant');
    expect(assistantMsg).toBeTruthy();
    const part = (assistantMsg!.parts as any[]).find(
      (p) => typeof p?.type === 'string' && p.type.startsWith('tool-') && p.state === 'approval-requested',
    );
    expect(part).toBeTruthy();
    const approvalId = part.approval?.id as string;
    expect(approvalId).toBeTruthy();

    // L2 pending row recorded (runSession -> recordL2PendingFromResponse).
    const pend = (await listPending(s.id)).find(
      (p) => p.level === 'L2' && p.tool_name === 'update_document_fields',
    );
    expect(pend).toBeTruthy();
    expect(pend!.approval_id).toBe(approvalId);
    expect(pend!.tool_call_id).toBe('call_tag');

    // --- Resume (approve): production message shape built from the store ---
    const resumeMsg = {
      role: 'tool',
      content: [
        {
          type: 'tool-approval-response',
          approvalId,
          toolCallId: 'call_tag',
          approved: true,
          reason: '用户已确认',
        },
      ],
    } as unknown as ModelMessage;
    const history = await convertToModelMessages((await loadSession(s.id))!.messages as UIMessage[]);
    const resumeFake = scriptedModel([{ text: '已完成打标' }]);
    const result = await runStream({
      messages: [...history, resumeMsg],
      role: 'trader',
      auditTraceId: 'rt-resume',
      sessionId: s.id,
      // Production shape: approvalCallback sets skipStatusMessage on the resume
      // run so the transient tool message stays LAST for SDK pairing.
      skipStatusMessage: true,
      model: resumeFake as any,
      deps: { ctx, extraction: { model: resumeFake as any } },
    });

    const parts: any[] = [];
    for await (const p of result.fullStream as AsyncIterable<any>) parts.push(p);

    // The SDK paired the response with the persisted request and EXECUTED
    // the gated tool (this is the core approve-resume proof).
    const toolResult = parts.find(
      (p) => p?.type === 'tool-result' && p.toolName === 'update_document_fields',
    );
    expect(toolResult).toBeTruthy();
    expect(String(JSON.stringify(toolResult.output))).not.toContain('error');
  });

  it('deny resume: the tool does NOT execute; the model still answers', async () => {
    const { ctx, docId } = await seedDoc();
    const s = await createSession('trader', 'u-rt2');
    await appendMessages(s.id, [userUIMsg('给文档打标签')]);

    const gateFake = scriptedModel([
      { toolCall: { toolCallId: 'call_tag2', toolName: 'update_document_fields', input: { docId, tags: ['次要'] } } },
      { text: '已打标' },
    ]);
    await runSession({
      sessionId: s.id,
      userId: 'u-rt2',
      role: 'trader',
      messages: await convertToModelMessages((await loadSession(s.id))!.messages as UIMessage[]),
      auditTraceId: 'rt-gate2',
      abortSignal: new AbortController().signal,
      model: gateFake as any,
    });

    const loaded = (await loadSession(s.id))!;
    const assistantMsg = loaded.messages.find((m) => m.role === 'assistant')!;
    const part = (assistantMsg.parts as any[]).find(
      (p) => typeof p?.type === 'string' && p.type.startsWith('tool-') && p.state === 'approval-requested',
    )!;
    const approvalId = part.approval?.id as string;

    const resumeMsg = {
      role: 'tool',
      content: [
        {
          type: 'tool-approval-response',
          approvalId,
          toolCallId: 'call_tag2',
          approved: false,
          reason: '用户已拒绝',
        },
      ],
    } as unknown as ModelMessage;
    const history = await convertToModelMessages(loaded.messages as UIMessage[]);
    let capturedPrompt: unknown;
    const resumeFake = scriptedModel(
      [{ text: '好的，已按用户要求取消打标' }],
      (p) => { capturedPrompt = p; },
    );
    const result = await runStream({
      messages: [...history, resumeMsg],
      role: 'trader',
      auditTraceId: 'rt-resume2',
      sessionId: s.id,
      // Production shape: approvalCallback sets skipStatusMessage on resume.
      skipStatusMessage: true,
      model: resumeFake as any,
      deps: { ctx, extraction: { model: resumeFake as any } },
    });

    const parts: any[] = [];
    for await (const p of result.fullStream as AsyncIterable<any>) parts.push(p);

    // Denied: NO successful tool-result for the gated tool (execute skipped).
    const toolResult = parts.find(
      (p) => p?.type === 'tool-result' && p.toolName === 'update_document_fields',
    );
    expect(toolResult).toBeUndefined();
    // The model produced its final text over the denial.
    expect(parts.some((p) => p?.type === 'text-delta')).toBe(true);
    const finish = parts.find((p) => p?.type === 'finish');
    expect(finish).toBeTruthy();

    // Deny was PROCESSED (not "approval never processed"): the SDK fed the
    // model an execution-denied tool-result for the gated tool, so the model's
    // prompt must contain it.
    expect(capturedPrompt).toBeTruthy();
    const promptJson = JSON.stringify(capturedPrompt);
    expect(promptJson).toContain('execution-denied');
    expect(promptJson).toContain('call_tag2');
  });

  it('runSession resume WITHOUT originalMessages appends a NEW assistant message (L3/instruction shape)', async () => {
    // Covers the no-continuation path, which is the production L3 resume shape
    // (the just-persisted user instruction is the last original message, so the
    // SDK creates a NEW message). Production L2 resume uses the
    // originalMessages continuation — that path is covered by the test below.
    const s = await createSession('trader', 'u-rt3');
    await appendMessages(s.id, [
      userUIMsg('第一轮'),
      { id: 'old-assistant-' + randomUUID().slice(0, 6), role: 'assistant', parts: [{ type: 'text', text: '旧回复' }] } as UIMessage,
      userUIMsg('继续'),
    ]);
    const before = (await loadSession(s.id))!.messages;

    const fake = scriptedModel([{ text: '续写回复' }]);
    await runSession({
      sessionId: s.id,
      userId: 'u-rt3',
      role: 'trader',
      messages: await convertToModelMessages(before),
      auditTraceId: 'rt-cont',
      abortSignal: new AbortController().signal,
      model: fake as any,
    });

    const after = (await loadSession(s.id))!.messages;
    expect(after.length).toBe(before.length + 1);
    const appended = after[after.length - 1];
    expect(appended.role).toBe('assistant');
    expect(before.some((m) => m.id === appended.id)).toBe(false);
  });

  it('approve resume via runSession continues the persisted assistant message (UI assembly)', async () => {
    const { docId } = await seedDoc();
    const s = await createSession('trader', 'u-rt4');
    await appendMessages(s.id, [userUIMsg('给文档打标签')]);

    // --- Turn 1 gate: same seeding as test 1 ---
    const gateFake = scriptedModel([
      { toolCall: { toolCallId: 'call_tag4', toolName: 'update_document_fields', input: { docId, tags: ['重要'] } } },
      { text: '已打标' },
    ]);
    await runSession({
      sessionId: s.id,
      userId: 'u-rt4',
      role: 'trader',
      messages: await convertToModelMessages((await loadSession(s.id))!.messages as UIMessage[]),
      auditTraceId: 'rt-gate4',
      abortSignal: new AbortController().signal,
      model: gateFake as any,
    });

    const before = (await loadSession(s.id))!;
    const origAssistant = before.messages.find((m) => m.role === 'assistant')!;
    const gatePart = (origAssistant.parts as any[]).find(
      (p) => typeof p?.type === 'string' && p.type.startsWith('tool-') && p.state === 'approval-requested',
    )!;
    const approvalId = gatePart.approval?.id as string;
    expect(approvalId).toBeTruthy();
    const origAssistantId = origAssistant.id;

    // --- Approve resume THROUGH runSession (production shape) ---
    const resumeMsg = {
      role: 'tool',
      content: [
        {
          type: 'tool-approval-response',
          approvalId,
          toolCallId: 'call_tag4',
          approved: true,
          reason: '用户已确认',
        },
      ],
    } as unknown as ModelMessage;
    const history = await convertToModelMessages(before.messages as UIMessage[]);
    const resumeFake = scriptedModel([{ text: '已完成打标' }]);
    await runSession({
      sessionId: s.id,
      userId: 'u-rt4',
      role: 'trader',
      messages: [...history, resumeMsg],
      auditTraceId: 'rt-resume4',
      abortSignal: new AbortController().signal,
      model: resumeFake as any,
      skipStatusMessage: true,
      // Production shape: approvalCallback passes the persisted history as
      // originalMessages so the SDK continues the approval-requested assistant
      // message instead of assembling a fresh one (which throws
      // UIMessageStreamError "No tool invocation found for tool call ID").
      originalMessages: before.messages as UIMessage[],
    });

    // runSession resolved without throwing (regression: pre-fix it rejects
    // with the UIMessageStreamError above).

    // The ORIGINAL assistant message was updated IN PLACE: the tag part is now
    // output-available (tool re-executed), not approval-requested.
    const after = (await loadSession(s.id))!;
    const continued = after.messages.find((m) => m.id === origAssistantId);
    expect(continued).toBeTruthy();
    const tagPart = (continued!.parts as any[]).find(
      (p) => typeof p?.type === 'string' && p.type.startsWith('tool-') && p.toolCallId === 'call_tag4',
    );
    expect(tagPart).toBeTruthy();
    expect(tagPart.state).toBe('output-available');
    // No NEW assistant message appended beyond the continued one.
    expect(after.messages.length).toBe(before.messages.length);
  });
});
