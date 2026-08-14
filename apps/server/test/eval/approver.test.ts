// apps/server/test/eval/approver.test.ts
import { describe, it, expect } from 'vitest';
import { decideApproval } from '../../eval/agent/approver.js';

const base = { id: 'p1', level: 'L3' as const, tool_name: 'create_payment' };

describe('decideApproval', () => {
  it('defaults to approve when no rules match', () => {
    const d = decideApproval({ ...base, input: { contractNo: 'HT-2024-001', amount: 100 } }, { default: 'approve', rules: [] });
    expect(d.approved).toBe(true);
    expect(d.matchedRule).toBeUndefined();
  });
  it('defaults to reject', () => {
    const d = decideApproval({ ...base, input: {} }, { default: 'reject', rules: [] });
    expect(d.approved).toBe(false);
  });
  it('rejects when a numeric rule matches (amount > threshold)', () => {
    const rules = [{ tool: 'create_payment', ifField: 'amount', op: '>' as const, value: 500000, action: 'reject' as const }];
    const d = decideApproval({ ...base, input: { amount: 858000 } }, { default: 'approve', rules });
    expect(d.approved).toBe(false);
    expect(d.matchedRule).toBe('create_payment.amount>500000');
  });
  it('does not match when value is below threshold', () => {
    const rules = [{ tool: 'create_payment', ifField: 'amount', op: '>' as const, value: 500000, action: 'reject' as const }];
    const d = decideApproval({ ...base, input: { amount: 1000 } }, { default: 'approve', rules });
    expect(d.approved).toBe(true);
  });
  it('matches a different tool only', () => {
    const rules = [{ tool: 'bind_document', ifField: 'confidence', op: '<' as const, value: 0.5, action: 'reject' as const }];
    const d = decideApproval({ ...base, tool_name: 'create_payment', input: { confidence: 0.1 } }, { default: 'approve', rules });
    expect(d.approved).toBe(true);
  });
  it('parses numeric strings with commas (seed-style amounts)', () => {
    const rules = [{ tool: 'create_payment', ifField: 'amount', op: '>=' as const, value: 500000, action: 'reject' as const }];
    const d = decideApproval({ ...base, input: { amount: '715,000' } }, { default: 'approve', rules });
    expect(d.approved).toBe(false);
  });
  it('string equality match', () => {
    const rules = [{ tool: 'create_payment', ifField: 'contractNo', op: '==' as const, value: 'HT-2024-001', action: 'reject' as const }];
    const d = decideApproval({ ...base, input: { contractNo: 'HT-2024-001' } }, { default: 'approve', rules });
    expect(d.approved).toBe(false);
  });
  it('missing field never matches', () => {
    const rules = [{ tool: 'create_payment', ifField: 'nope', op: '>' as const, value: 1, action: 'reject' as const }];
    const d = decideApproval({ ...base, input: { amount: 99 } }, { default: 'approve', rules });
    expect(d.approved).toBe(true);
  });
  it('first matching rule wins', () => {
    const rules = [
      { tool: 'create_payment', ifField: 'amount', op: '>' as const, value: 100, action: 'approve' as const },
      { tool: 'create_payment', ifField: 'amount', op: '>' as const, value: 50, action: 'reject' as const },
    ];
    const d = decideApproval({ ...base, input: { amount: 999 } }, { default: 'reject', rules });
    expect(d.approved).toBe(true);
  });
});
