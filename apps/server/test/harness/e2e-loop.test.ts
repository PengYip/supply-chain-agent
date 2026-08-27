import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelMessage } from 'ai';
import { runStream, buildGatedTools } from '../../src/harness/agent.js';
import { createDb, migrate } from '../../src/pipeline/db/client.js';
import { env } from '../../src/env.js';

/**
 * H1: end-to-end agent-loop stub test.
 *
 * Exercises runStream -> streamText with the FULL 13-tool trader toolset against
 * a deterministic fake LanguageModelV2 (no network). Asserts:
 *  (a) the 13-tool trader toolset is folded into the live streamText call;
 *  (b) bind_document carries needsApproval (L2) in the gated toolset;
 *  (c) a canned tool call actually routes to the matching tool's execute;
 *  (d) the stream + telemetry path completes without throwing.
 *
 * Hermetic: the fake model returns canned bytes; instrumentation.ts (the only
 * module that registers an OTel/Langfuse exporter) is never imported in the test
 * process, so experimental_telemetry spans are no-op and emit no network traffic.
 */

interface FakeModelOptions {
  toolCall: { id: string; toolName: string; input: unknown };
  onTools?: (names: string[]) => void;
  /** Receives the converted `prompt` AI SDK 6 hands to doStream (call 1). */
  onPrompt?: (prompt: unknown) => void;
}

// Minimal fake LanguageModelV2. doStream drives the multi-step loop:
//   step 1 -> emit one canned tool call + finish('tool-calls')
//   step 2+ -> emit a short final text + finish('stop')
// On the first call it records the tool set streamText received.
function createFakeModel(opts: FakeModelOptions) {
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
    async doStream(options: { tools?: Array<{ name?: string }>; prompt?: unknown }) {
      calls++;
      if (calls === 1) {
        if (options.tools) opts.onTools?.(options.tools.map((t) => t.name ?? ''));
        opts.onPrompt?.(options.prompt);
      }
      const stream = new ReadableStream<unknown>({
        start(controller) {
          if (calls === 1) {
            // Complete tool-call part (v2) + finish('tool-calls') to trigger
            // tool execution and the next step.
            controller.enqueue({ type: 'tool-call', toolCallId: opts.toolCall.id, toolName: opts.toolCall.toolName, input: JSON.stringify(opts.toolCall.input) });
            controller.enqueue({ type: 'finish', finishReason: 'tool-calls', usage: usage() });
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

describe('agent e2e loop (stub model)', () => {
  it('routes a canned tool call through the 13-tool trader toolset offline', async () => {
    const ctx = createDb(':memory:');
    migrate(ctx.sqlite);
    // ingest_document now enforces a path allowlist against env.INGEST_ROOT, so
    // the fixture must live inside it (not a system tmpdir).
    const f = join(env.INGEST_ROOT, `e2e-${Date.now()}.txt`);
    writeFileSync(f, '合同号: HT-2024-001\n金额: 2860000', 'utf-8');

    let capturedNames: string[] = [];
    let capturedPrompt: unknown;
    const fake = createFakeModel({
      toolCall: { id: 'call_1', toolName: 'ingest_document', input: { sourceUri: f, docType: '合同', modality: 'digital' } },
      onTools: (names) => { capturedNames = names; },
      onPrompt: (p) => { capturedPrompt = p; },
    });

    const messages: ModelMessage[] = [{ role: 'user', content: '请录入这份合同' }];
    const result = await runStream({
      messages,
      role: 'trader',
      auditTraceId: 'e2e-trace',
      sessionId: 'e2e-session',
      model: fake as any,
      deps: { ctx, extraction: { model: fake as any } },
    });

    const toolResults: Array<{ toolName?: string; output?: unknown }> = [];
    let threw = false;
    try {
      for await (const part of result.fullStream as AsyncIterable<any>) {
        if (part?.type === 'tool-result') toolResults.push(part);
      }
    } catch (e) {
      threw = true;
      console.error('STREAM ERROR:', e);
    }

    // (d) stream + telemetry path completes without throwing.
    expect(threw).toBe(false);

    // (a) the live streamText call received the full trader toolset. base 4
    // (create_payment removed: no in-system money tools) + 3 doc-entry +
    // recall_documents + execute_code + inspect_extraction + tag_document +
    // create_entity + link_entities + graph_query + graph_find_entity +
    // present_document_review + update_document_fields + list_binding_proposals
    // + project_rollup = 21 live trader tools; 2026-08-25 方案A adds
    // link_contracts + link_projects = 23; 2026-08-26 模板 adds link_amends = 24;
    // template_overview = 25; manage_quota/query_quota_usage = 27;
    // 2026-08-28 P4 adds manage_template = 28; 2026-08-27 §15 adds
    // gather_settlement_evidence/confirm_settlement = 30.
    expect(capturedNames).toHaveLength(30);
    for (const n of ['ingest_document', 'extract_fields', 'bind_document', 'query_contract', 'escalate_to_human', 'recall_documents', 'project_rollup']) {
      expect(capturedNames).toContain(n);
    }

    // (b) bind_document is present with needsApproval (L2) in the gated toolset.
    const gated = buildGatedTools('trader', { ctx, extraction: { model: fake as any } });
    expect((gated['bind_document'] as any).needsApproval).toBe(true);

    // (c) the canned tool call actually routed to ingest_document's execute.
    expect(toolResults).toHaveLength(1);
    const out = toolResults[0]?.output as { docId?: string; blockCount?: number; modality?: string } | undefined;
    expect(out?.blockCount).toBe(2);
    expect(out?.modality).toBe('digital');
    expect(out?.docId).toMatch(/^DOC-/);

    // (e) runStream injects the model-facing <agent_status> user message at the
    // trajectory tail when sessionId is set. AI SDK 6 v2 hands the converted
    // messages to the model as options.prompt; the injected status message is
    // the last element. Asserting user role + both delimiters proves the
    // `messages: messagesForModel` wiring -- would fail if reverted to `messages,`.
    const prompt = (capturedPrompt ?? []) as Array<{ role?: string; content?: unknown }>;
    expect(prompt.length).toBeGreaterThan(0);
    const last = prompt[prompt.length - 1];
    expect(last.role).toBe('user');
    const lastJson = JSON.stringify(last);
    expect(lastJson).toContain('<agent_status>');
    expect(lastJson).toContain('</agent_status>');
  });
});
