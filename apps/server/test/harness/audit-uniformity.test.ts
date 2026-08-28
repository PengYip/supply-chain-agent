import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelMessage } from 'ai';
import { runStream } from '../../src/harness/agent.js';
import { auditRecorder } from '../../src/harness/auditRecorder.js';
import { createDb, migrate } from '../../src/pipeline/db/client.js';
import { env } from '../../src/env.js';

/**
 * H4: auditRecorder uniformity.
 *
 * Drives tool calls through the full runStream -> streamText path (fake model,
 * offline) and asserts the centralized `withAudit` wrapper in buildGatedTools
 * emits a uniform auditRecorder record for:
 *  (1) a doc-entry tool (ingest_document) -- the previously-uncovered gap;
 *  (2) an existing trader tool (query_contract) -- no regression after the
 *      per-tool recordCall helpers were removed in favor of the central wrapper.
 */

interface FakeModelOptions {
  toolCall: { id: string; toolName: string; input: unknown };
}
let dir: string;
// Minimal fake LanguageModelV2: step 1 emits one canned tool call + finish
// ('tool-calls'); step 2+ emits a short final text + finish ('stop'). Reuses the
// H1 e2e-loop pattern (complete tool-call part form).
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
    async doStream() {
      calls++;
      const stream = new ReadableStream<unknown>({
        start(controller) {
          if (calls === 1) {
            controller.enqueue({ type: 'tool-call', toolCallId: opts.toolCall.id, toolName: opts.toolCall.toolName, input: JSON.stringify(opts.toolCall.input) });
            controller.enqueue({ type: 'finish', finishReason: 'tool-calls', usage: usage() });
          } else {
            controller.enqueue({ type: 'text-start', id: 't1' });
            controller.enqueue({ type: 'text-delta', id: 't1', delta: 'done' });
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

async function drainToolCall(toolName: string, input: unknown) {
  const ctx = createDb(':memory:');
  migrate(ctx.sqlite);
  const fake = createFakeModel({ toolCall: { id: 'c1', toolName, input } });
  const messages: ModelMessage[] = [{ role: 'user', content: 'go' }];
  const result = await runStream({
    messages,
    role: 'trader',
    auditTraceId: 'h4',
    model: fake as any,
    deps: { ctx, extraction: { model: fake as any } },
    scenario: 'all',
  });
  for await (const _ of result.fullStream as AsyncIterable<any>) {
    /* drain to completion so execute + audit wrapper fire */
  }
}

describe('audit uniformity (H4)', () => {
  beforeEach(() => {
    // Shared in-memory singleton; clear between tests for deterministic asserts.
    auditRecorder.records.length = 0;
    // ingest_document now enforces a path allowlist against env.INGEST_ROOT, so
    // fixtures must live inside it (not a system tmpdir).
    dir = join(env.INGEST_ROOT, `h4-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(dir, { recursive: true });
  });

  it('doc-entry tool (ingest_document) emits a uniform audit record', async () => {
    const f = join(dir, 'c.txt');
    writeFileSync(f, '合同号: HT-2024-001\n金额: 2860000', 'utf-8');

    await drainToolCall('ingest_document', { sourceUri: f, docType: '合同', modality: 'digital' });

    const rec = auditRecorder.records.find((r) => r.toolName === 'ingest_document');
    expect(rec).toBeDefined();
    expect(rec?.args).toMatchObject({ sourceUri: f, docType: '合同', modality: 'digital' });
    expect(rec?.result).toMatchObject({ blockCount: 2, modality: 'digital' });
    expect(typeof rec?.durationMs).toBe('number');
    expect(rec?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('existing tool (query_business) still emits an audit record (no regression)', async () => {
    await drainToolCall('query_business', { entity: 'contract', contractNo: 'HT-2024-001' });

    const rec = auditRecorder.records.find((r) => r.toolName === 'query_business');
    expect(rec).toBeDefined();
    // HT-2024-001 is seeded, so the result is the contract object (not notFound).
    expect(rec?.result).toMatchObject({ contractNo: 'HT-2024-001' });
    expect(typeof rec?.durationMs).toBe('number');
  });
});
