// apps/server/test/harness/scenarioDetection.regression.test.ts
// 回归（2026-09-09 冒烟发现）：runStream 的场景检测曾跑在"追加了 <agent_status>
// user 消息之后"的消息尾部上——快照文本恒命中 ENTRY_RE（含"复核"），导致每回合
// 都被收窄到 entry 工具集，settlement 写工具（link_ontology/create_trade_event/
// create_writeoff/...）与 qa 读工具（graph_query 等）永远不可见。
// 修复语义：场景检测必须基于真实对话尾部（用户实际消息），而非注入的系统状态。
import { describe, it, expect } from 'vitest';
import type { ModelMessage } from 'ai';
import { runStream } from '../../src/harness/agent.js';
import { createDb, migrate } from '../../src/pipeline/db/client.js';

/** 只记录首步工具集、随即 finish('stop') 的最小 fake LanguageModelV2（无网络）。 */
function createRecordingModel(onTools: (names: string[]) => void) {
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
    async doStream(options: { tools?: Array<{ name?: string }> }) {
      calls += 1;
      if (calls === 1 && options.tools) onTools(options.tools.map((t) => t.name ?? ''));
      const stream = new ReadableStream<unknown>({
        start(controller) {
          controller.enqueue({ type: 'text-start', id: 't1' });
          controller.enqueue({ type: 'text-delta', id: 't1', delta: '收到' });
          controller.enqueue({ type: 'text-end', id: 't1' });
          controller.enqueue({ type: 'finish', finishReason: 'stop', usage: usage() });
          controller.close();
        },
      });
      return { stream };
    },
  };
}

describe('runStream 场景检测基于真实用户消息（<agent_status> 注入不参与路由）', () => {
  it('结算语义的用户消息可挂载 settlement 写工具（link_ontology）', async () => {
    const ctx = createDb(':memory:');
    migrate(ctx.sqlite);
    let captured: string[] = [];
    const fake = createRecordingModel((names) => { captured = names; });
    const messages: ModelMessage[] = [{
      role: 'user',
      content: '请在本体里登记母子公司关系用于对账归口：link_ontology PARENT_OF 持股 0.6',
    }];
    const result = await runStream({
      messages,
      role: 'trader',
      auditTraceId: 'scenario-regression',
      sessionId: 'scenario-regression-session',
      model: fake as never,
      deps: { ctx, extraction: { model: fake as never } },
    });
    for await (const _ of result.fullStream as AsyncIterable<unknown>) { void _; }
    expect(captured).toContain('link_ontology');
  });

  it('录入语义的用户消息仍挂载 entry 工具（bind_document）', async () => {
    const ctx = createDb(':memory:');
    migrate(ctx.sqlite);
    let captured: string[] = [];
    const fake = createRecordingModel((names) => { captured = names; });
    const messages: ModelMessage[] = [{ role: 'user', content: '请录入这份合同' }];
    const result = await runStream({
      messages,
      role: 'trader',
      auditTraceId: 'scenario-regression-entry',
      sessionId: 'scenario-regression-entry-session',
      model: fake as never,
      deps: { ctx, extraction: { model: fake as never } },
    });
    for await (const _ of result.fullStream as AsyncIterable<unknown>) { void _; }
    expect(captured).toContain('bind_document');
    expect(captured).not.toContain('link_ontology');
  });
});
