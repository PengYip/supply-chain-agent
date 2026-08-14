// apps/server/eval/agent/approver.ts
// Policy-driven approval simulation (spec decision: strategy-driven, NOT an
// LLM approver -- keeps episodes reproducible). Rules run in order; the first
// matching rule decides; otherwise the policy default applies.
import type { ApprovalPolicy, ApprovalRule } from './types.js';

export interface PendingLike {
  id: string;
  level: 'L2' | 'L3';
  tool_name: string;
  input: unknown;
}

export interface ApprovalDecision {
  approved: boolean;
  reason: string;
  matchedRule?: string;
}

function toNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string') {
    const n = Number(v.replace(/[,，\s]/g, ''));
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function ruleMatches(rule: ApprovalRule, toolName: string, input: Record<string, unknown>): boolean {
  if (rule.tool !== toolName) return false;
  const v = input[rule.ifField];
  if (v === undefined) return false;
  if (typeof rule.value === 'number') {
    const n = toNumber(v);
    if (n === undefined) return false;
    switch (rule.op) {
      case '>': return n > rule.value;
      case '<': return n < rule.value;
      case '>=': return n >= rule.value;
      case '<=': return n <= rule.value;
      case '==': return n === rule.value;
      case '!=': return n !== rule.value;
    }
  }
  const s = String(v);
  const t = String(rule.value);
  switch (rule.op) {
    case '==': return s === t;
    case '!=': return s !== t;
    case '>': return s > t;
    case '<': return s < t;
    case '>=': return s >= t;
    case '<=': return s <= t;
  }
}

export function decideApproval(pending: PendingLike, policy: ApprovalPolicy): ApprovalDecision {
  const input =
    pending.input && typeof pending.input === 'object' && !Array.isArray(pending.input)
      ? (pending.input as Record<string, unknown>)
      : {};
  for (const rule of policy.rules) {
    if (ruleMatches(rule, pending.tool_name, input)) {
      const approved = rule.action === 'approve';
      const desc = `${rule.tool}.${rule.ifField} ${rule.op} ${rule.value}`;
      return {
        approved,
        reason: approved ? `规则命中(${desc}) -> approve` : `规则命中(${desc}) -> reject`,
        matchedRule: `${rule.tool}.${rule.ifField}${rule.op}${rule.value}`,
      };
    }
  }
  const approved = policy.default === 'approve';
  return { approved, reason: approved ? '默认策略: approve' : '默认策略: reject' };
}
