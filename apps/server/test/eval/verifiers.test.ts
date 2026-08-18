// apps/server/test/eval/verifiers.test.ts
import { describe, it, expect } from 'vitest';
import { runVerifiers } from '../../eval/agent/verifiers.js';
import type { EpisodeArtifact } from '../../eval/agent/types.js';

function artifact(partial: Partial<EpisodeArtifact>): EpisodeArtifact {
  return {
    scenarioId: 'x', runIndex: 1, sessionId: 's', startedAt: '', wallMs: 0, turnsUsed: 1,
    transcript: [], toolCalls: [], approvals: [],
    envSnapshot: { contractLinked: {} },
    finalAssistantText: '', totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    ...partial,
  };
}

const noChecks = { contractLinked: [], mustAppear: [], forbidden: [], keywordInReply: [], keywordInTranscript: [] };

describe('runVerifiers', () => {
  it('passes when all checks hold', () => {
    const a = artifact({
      toolCalls: [{ toolName: 'query_orders', args: {}, result: {}, durationMs: 1 }],
      finalAssistantText: 'ORD-2024-0883 未开票',
    });
    const r = runVerifiers(
      { ...noChecks, mustAppear: ['query_orders'], keywordInReply: ['未开票'] },
      a,
    );
    expect(r.passed).toBe(true);
    expect(r.failures).toEqual([]);
  });
  it('fails a missing mustAppear tool', () => {
    const r = runVerifiers(
      { ...noChecks, mustAppear: ['query_orders'] },
      artifact({ toolCalls: [{ toolName: 'cross_check', args: {}, result: {}, durationMs: 1 }] }),
    );
    expect(r.failures[0]!.check).toBe('mustAppear');
  });
  it('fails a called forbidden tool', () => {
    const r = runVerifiers(
      { ...noChecks, forbidden: ['execute_code'] },
      artifact({ toolCalls: [{ toolName: 'execute_code', args: {}, result: {}, durationMs: 1 }] }),
    );
    expect(r.failures[0]!.check).toBe('forbidden');
  });
  it('fails a missing reply keyword', () => {
    const r = runVerifiers(
      { ...noChecks, keywordInReply: ['复核'] },
      artifact({ finalAssistantText: '一切正常' }),
    );
    expect(r.failures[0]!.check).toBe('keywordInReply');
  });
  it('keywordInTranscript passes when the fact appears in a mid-conversation assistant turn', () => {
    const r = runVerifiers(
      { ...noChecks, keywordInTranscript: ['张家港'] },
      artifact({
        finalAssistantText: '不客气, 有需要随时找我。',
        transcript: [
          { role: 'user', text: '交货地是哪里' },
          { role: 'assistant', text: '交货地点: 张家港 (引用自单据原文)' },
          { role: 'user', text: '好的谢谢' },
          { role: 'assistant', text: '不客气, 有需要随时找我。' },
        ],
      }),
    );
    expect(r.passed).toBe(true);
  });
  it('keywordInTranscript fails when no assistant turn contains the keyword', () => {
    const r = runVerifiers(
      { ...noChecks, keywordInTranscript: ['张家港'] },
      artifact({
        finalAssistantText: '没查到相关内容',
        transcript: [{ role: 'user', text: '交货地' }, { role: 'assistant', text: '没查到相关内容' }],
      }),
    );
    expect(r.failures[0]!.check).toBe('keywordInTranscript');
  });
  it('keywordInTranscript ignores user/system-note turns', () => {
    const r = runVerifiers(
      { ...noChecks, keywordInTranscript: ['张家港'] },
      artifact({
        finalAssistantText: '未找到',
        transcript: [
          { role: 'user', text: '合同上写的是张家港吧' },
          { role: 'assistant', text: '系统内未找到相关单据' },
        ],
      }),
    );
    expect(r.failures[0]!.check).toBe('keywordInTranscript');
  });
  it('fails a missing contract link', () => {
    const r = runVerifiers(
      { ...noChecks, contractLinked: [{ contractNo: 'HT-2024-001', documentId: 'FP-2024-0920-009' }] },
      artifact({ envSnapshot: { contractLinked: { 'HT-2024-001': ['BL-2024-0815-001'] } } }),
    );
    expect(r.failures[0]!.check).toBe('contractLinked');
  });
  it('simError episodes still get verified (state checks apply)', () => {
    const r = runVerifiers(
      { ...noChecks, mustAppear: ['query_orders'] },
      artifact({ simError: 'boom' }),
    );
    expect(r.passed).toBe(false);
  });
});
