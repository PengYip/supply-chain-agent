// Session-scoped status aggregation (status bar signal dimension, P0).
//
// Reads the audit recorder's per-session tool-call records and tallies them by
// the contract `signal` dimension (counter/todo/env/none) so the frontend
// status bar can render a live summary of what the agent is doing in a session.
// Also surfaces the count of pending human approvals for that session.
//
// Pure read over existing state (audit recorder array + pending_approvals
// table); produces a snapshot, does not mutate anything.

import { getContract } from './contextContract.js';
import { auditRecorder, type ToolCallRecord } from './auditRecorder.js';
import { countPendingApprovals } from './sessionStore.js';
import type { ToolCallCount } from './agentStatus.js';

export interface AgentStatus {
  sessionId: string;
  totalCalls: number;
  bySignal: { counter: number; todo: number; env: number; none: number };
  lastToolName: string | null;
  lastToolAt: string | null;
  pendingApprovals: number;
}

type SignalBucket = 'counter' | 'todo' | 'env' | 'none';

/**
 * Build the status snapshot for a session. `recorder` defaults to the
 * process-wide singleton auditRecorder so production wiring needs no arg, but
 * tests can pass a local recorder for deterministic isolation.
 *
 * Async since the session store went dual-backend (SQLite/Postgres):
 * countPendingApprovals awaits the store regardless of backend.
 */
export async function getSessionStatus(
  sessionId: string,
  recorder: { records: ToolCallRecord[] } = auditRecorder,
): Promise<AgentStatus> {
  const bySignal: Record<SignalBucket, number> = {
    counter: 0,
    todo: 0,
    env: 0,
    none: 0,
  };

  // records are pushed in time order, so filter preserves chronological order
  // and the last element is the most recent call for this session.
  const records = recorder.records.filter((r) => r.sessionId === sessionId);

  for (const r of records) {
    // getContract THROWS for an unknown tool name (contract is mandatory); a
    // missing contract counts as the 'none' bucket so aggregation never breaks.
    let signal: SignalBucket;
    try {
      signal = getContract(r.toolName).signal;
    } catch {
      signal = 'none';
    }
    bySignal[signal] += 1;
  }

  const last = records.length > 0 ? records[records.length - 1] : null;

  return {
    sessionId,
    totalCalls: records.length,
    bySignal,
    lastToolName: last ? last.toolName : null,
    lastToolAt: last ? last.timestamp : null,
    pendingApprovals: await countPendingApprovals(sessionId),
  };
}

/**
 * Model-facing per-tool call counts for a session (design §9.2). Distinct from
 * `getSessionStatus`'s bySignal tally: this returns one entry per distinct
 * tool, in first-seen order, so formatAgentStatusBody can render the tool-by-
 * tool breakdown without duplicate lines. `recorder` defaults to the
 * process-wide singleton auditRecorder; tests pass a local recorder for
 * deterministic isolation.
 */
export function getToolCallCounts(
  sessionId: string,
  recorder: { records: ToolCallRecord[] } = auditRecorder,
): ToolCallCount[] {
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const r of recorder.records) {
    if (r.sessionId !== sessionId) continue;
    if (!counts.has(r.toolName)) order.push(r.toolName);
    counts.set(r.toolName, (counts.get(r.toolName) ?? 0) + 1);
  }
  return order.map((tool) => ({ tool, count: counts.get(tool) as number }));
}
