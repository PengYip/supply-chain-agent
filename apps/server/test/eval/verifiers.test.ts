// apps/server/test/eval/verifiers.test.ts
import { describe, it, expect } from 'vitest';
import { runVerifiers } from '../../eval/agent/verifiers.js';
import type { EpisodeArtifact } from '../../eval/agent/types.js';

function artifact(partial: Partial<EpisodeArtifact>): EpisodeArtifact {
  return {
    scenarioId: 'x', runIndex: 1, sessionId: 's', startedAt: '', wallMs: 0, turnsUsed: 1,
    transcript: [], toolCalls: [], approvals: [],
    envSnapshot: { payments: [], contractLinked: {} },
    finalAssistantText: '', totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    ...partial,
  };
}

const noChecks = { payments: [], paymentsAbsent: [], contractLinked: [], mustAppear: [], forbidden: [], keywordInReply: [] };

describe('runVerifiers', () => {
  it('passes when all checks hold', () => {
    const a = artifact({
      toolCalls: [{ toolName: 'query_orders', args: {}, result: {}, durationMs: 1 }],
      finalAssistantText: 'ORD-2024-0883 未开票',
      envSnapshot: { payments: [{ paymentId: 'PAY-1', contractNo: 'HT-2024-001', amount: 858000, authorizedTicketId: 'T' }], contractLinked: {} },
    });
    const r = runVerifiers(
      { ...noChecks, mustAppear: ['query_orders'], keywordInReply: ['未开票'], payments: [{ contractNo: 'HT-2024-001', amount: 858000 }] },
      a,
    );
    expect(r.passed).toBe(true);
    expect(r.failures).toEqual([]);
  });
  it('fails a missing payment entry', () => {
    const r = runVerifiers(
      { ...noChecks, payments: [{ contractNo: 'HT-2024-001', amount: 999 }] },
      artifact({}),
    );
    expect(r.passed).toBe(false);
    expect(r.failures[0]!.check).toBe('payments');
  });
  it('fails when a forbidden payment exists (paymentsAbsent)', () => {
    const r = runVerifiers(
      { ...noChecks, paymentsAbsent: [{ contractNo: 'HT-2024-001' }] },
      artifact({ envSnapshot: { payments: [{ paymentId: 'P', contractNo: 'HT-2024-001', amount: 1, authorizedTicketId: 'T' }], contractLinked: {} } }),
    );
    expect(r.passed).toBe(false);
    expect(r.failures[0]!.check).toBe('paymentsAbsent');
  });
  it('fails a missing mustAppear tool', () => {
    const r = runVerifiers(
      { ...noChecks, mustAppear: ['create_payment'] },
      artifact({ toolCalls: [{ toolName: 'query_orders', args: {}, result: {}, durationMs: 1 }] }),
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
  it('fails a missing contract link', () => {
    const r = runVerifiers(
      { ...noChecks, contractLinked: [{ contractNo: 'HT-2024-001', documentId: 'FP-2024-0920-009' }] },
      artifact({ envSnapshot: { payments: [], contractLinked: { 'HT-2024-001': ['BL-2024-0815-001'] } } }),
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
