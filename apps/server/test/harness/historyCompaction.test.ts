import { describe, it, expect } from 'vitest';
import type { UIMessage } from 'ai';
import {
  readCompactionPlan,
  shouldCompact,
  renderTranscript,
  buildSummaryMessage,
  buildHistoryModelMessages,
  maybeCompactHistory,
} from '../../src/harness/historyCompaction.js';
import { createSession, appendMessages, loadSession, mergeSessionMetadata } from '../../src/harness/sessionStore.js';
import { env } from '../../src/env.js';

function uiMsg(role: 'user' | 'assistant', text: string): UIMessage {
  return { id: `${role}-${Math.random().toString(36).slice(2, 8)}`, role, parts: [{ type: 'text', text }] } as UIMessage;
}

describe('readCompactionPlan', () => {
  it('returns null for missing/invalid metadata', () => {
    expect(readCompactionPlan(undefined)).toBeNull();
    expect(readCompactionPlan({})).toBeNull();
    expect(readCompactionPlan({ historyCompaction: { boundary: 'x', summary: 's' } })).toBeNull();
    expect(readCompactionPlan({ historyCompaction: { boundary: 3, summary: '' } })).toBeNull();
  });

  it('round-trips a valid plan', () => {
    expect(readCompactionPlan({ historyCompaction: { boundary: 3, summary: '摘要' } })).toEqual({
      boundary: 3,
      summary: '摘要',
    });
  });
});

describe('shouldCompact', () => {
  it('triggers at window - reserve and above', () => {
    const threshold = env.AGENT_CONTEXT_WINDOW_TOKENS - env.AGENT_COMPACT_RESERVE_TOKENS;
    expect(shouldCompact(threshold - 1)).toBe(false);
    expect(shouldCompact(threshold)).toBe(true);
    expect(shouldCompact(threshold + 1000)).toBe(true);
  });
});

describe('renderTranscript', () => {
  it('renders roles and truncates at the char cap', () => {
    const msgs = [
      uiMsg('user', '查一下 HT-2024-001 的合同'),
      uiMsg('assistant', '合同号 HT-2024-001，金额 2860000 元。'),
    ];
    const t = renderTranscript(msgs);
    expect(t).toContain('用户: 查一下');
    expect(t).toContain('助手:');
    expect(t).toContain('HT-2024-001');
  });

  it('omits the tail note only when messages are actually dropped', () => {
    const many = Array.from({ length: 5 }, (_, i) => uiMsg('user', 'x'.repeat(50) + i));
    const t = renderTranscript(many);
    expect(t).not.toContain('省略');
  });
});

describe('buildHistoryModelMessages', () => {
  it('without a plan behaves like plain conversion', async () => {
    const prior = [uiMsg('user', '你好'), uiMsg('assistant', '在的')];
    const out = await buildHistoryModelMessages(prior, undefined);
    expect(out).toHaveLength(2);
    expect(out[0]!.role).toBe('user');
  });

  it('with a plan sends [summary, tail]', async () => {
    const prior = [
      uiMsg('user', '第一轮'),
      uiMsg('assistant', '第一答'),
      uiMsg('user', '第二轮'),
      uiMsg('assistant', '第二答'),
    ];
    const out = await buildHistoryModelMessages(prior, {
      historyCompaction: { boundary: 2, summary: '第一轮摘要' },
    });
    // summary message + the 2 tail messages
    expect(out).toHaveLength(3);
    expect(out[0]!.role).toBe('user');
    expect(JSON.stringify(out[0])).toContain('第一轮摘要');
    expect(out[0]).toEqual(buildSummaryMessage('第一轮摘要'));
    // tail keeps original order/roles
    expect(out[1]!.role).toBe('user');
    expect(out[2]!.role).toBe('assistant');
  });

  it('ignores a stale plan whose boundary no longer fits', async () => {
    const prior = [uiMsg('user', '唯一一轮')];
    const out = await buildHistoryModelMessages(prior, {
      historyCompaction: { boundary: 5, summary: '过期' },
    });
    expect(out).toHaveLength(1);
  });
});

describe('maybeCompactHistory (store round-trip)', () => {
  it('does not compact below the token threshold', async () => {
    const s = await createSession('trader', 'u-compact');
    const compacted = await maybeCompactHistory({ sessionId: s.id, totalTokens: 10 });
    expect(compacted).toBe(false);
    const loaded = await loadSession(s.id);
    expect(readCompactionPlan(loaded?.metadata)).toBeNull();
  });

  it('compacts above the threshold and stores a forward boundary', async () => {
    const s = await createSession('trader', 'u-compact2');
    // Enough messages that boundary = len - KEEP lands on a user message
    // (alternating user/assistant keeps the tail start a user turn).
    const msgs: UIMessage[] = [];
    for (let i = 0; i < env.AGENT_COMPACT_KEEP_MESSAGES + 6; i++) {
      msgs.push(uiMsg(i % 2 === 0 ? 'user' : 'assistant', `第${i}条消息，合同号 HT-${i}`));
    }
    await appendMessages(s.id, msgs);

    const fakeModel = {
      specificationVersion: 'v2' as const,
      provider: 'fake',
      modelId: 'fake-model',
      supportedUrls: {} as Record<string, RegExp[]>,
      async doGenerate() {
        return {
          content: [{ type: 'text' as const, text: '## 用户目标\n测试摘要' }],
          finishReason: 'stop' as const,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          warnings: [] as unknown[],
        };
      },
      async doStream() {
        throw new Error('not used');
      },
    };
    const totalTokens = env.AGENT_CONTEXT_WINDOW_TOKENS; // >= threshold
    const compacted = await maybeCompactHistory({ sessionId: s.id, totalTokens, model: fakeModel as any });
    expect(compacted).toBe(true);

    const loaded = await loadSession(s.id);
    const plan = readCompactionPlan(loaded?.metadata);
    expect(plan).not.toBeNull();
    expect(plan!.boundary).toBeGreaterThan(0);
    expect(plan!.boundary).toBeLessThan(loaded!.messages.length);
    // Boundary message must be a user message (clean Q/A pair start).
    expect(loaded!.messages[plan!.boundary]!.role).toBe('user');
    // History rows are NEVER deleted.
    expect(loaded!.messages).toHaveLength(msgs.length);
  });

  it('keeps the full UI history untouched after compaction', async () => {
    // mergeSessionMetadata smoke: title survives a compaction write.
    const s = await createSession('trader', 'u-compact3');
    await mergeSessionMetadata(s.id, { title: '原标题' });
    await mergeSessionMetadata(s.id, { historyCompaction: { boundary: 1, summary: 's' } });
    const loaded = await loadSession(s.id);
    expect(loaded?.title).toBe('原标题');
    expect(readCompactionPlan(loaded?.metadata)?.boundary).toBe(1);
  });
});
