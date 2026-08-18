import { describe, it, expect } from 'vitest';
import { createAuditRecorder, type ToolCallRecord } from '../../src/harness/auditRecorder.js';
import { getSessionStatus, getToolCallCounts } from '../../src/harness/statusAggregator.js';
import { runSessionContext } from '../../src/harness/sessionContext.js';
import { statusRoute } from '../../src/routes/status.js';

/**
 * Status aggregator (P0 status bar backend).
 *
 * The audit recorder stamps each record with the ambient sessionId (read from
 * the ALS session context set per run via runSessionContext). getSessionStatus
 * filters by sessionId, tallies each call's contract `signal` dimension, and
 * reports the last call + pending approvals.
 *
 * Real tool names are used so getContract resolves real signals:
 *   query_contract -> counter, escalate_to_human -> todo,
 *   bind_document -> env, (unknown name) -> none (contract throws).
 */

describe('getSessionStatus', () => {
  it('tallies by signal and strictly filters by sessionId', () => {
    const rec = createAuditRecorder();

    runSessionContext({ sessionId: 'sessA', role: 'trader' }, () => {
      rec.recordToolCall({
        toolName: 'query_contract',
        args: { contractNo: 'HT-2024-001' },
        result: { contractNo: 'HT-2024-001' },
        durationMs: 5,
      });
      rec.recordToolCall({
        toolName: 'escalate_to_human',
        args: { reason: 'x' },
        result: { ticketId: 't1' },
        durationMs: 8,
      });
    });

    // A different session's call must be EXCLUDED from sessA's status.
    runSessionContext({ sessionId: 'sessB', role: 'trader' }, () => {
      rec.recordToolCall({
        toolName: 'bind_document',
        args: {},
        result: {},
        durationMs: 12,
      });
    });

    const status = getSessionStatus('sessA', rec);
    expect(status.sessionId).toBe('sessA');
    expect(status.totalCalls).toBe(2);
    expect(status.bySignal).toEqual({ counter: 1, todo: 1, env: 0, none: 0 });
    // records preserve push order; escalate_to_human was the last for sessA.
    expect(status.lastToolName).toBe('escalate_to_human');
    expect(status.lastToolAt).toBe(
      rec.records.find((r) => r.toolName === 'escalate_to_human')!.timestamp,
    );
    // 'sessA' is not a real session row -> no pending approvals.
    expect(status.pendingApprovals).toBe(0);
  });

  it('counts the env bucket and reflects the actual last call', () => {
    const rec = createAuditRecorder();
    runSessionContext({ sessionId: 'sessA', role: 'trader' }, () => {
      rec.recordToolCall({
        toolName: 'query_contract',
        args: {},
        result: {},
        durationMs: 1,
      });
      rec.recordToolCall({
        toolName: 'bind_document',
        args: {},
        result: {},
        durationMs: 2,
      });
    });

    const status = getSessionStatus('sessA', rec);
    expect(status.totalCalls).toBe(2);
    expect(status.bySignal).toEqual({ counter: 1, todo: 0, env: 1, none: 0 });
    expect(status.lastToolName).toBe('bind_document');
  });

  it('routes unknown tool names (no contract) into the none bucket', () => {
    const rec = createAuditRecorder();
    runSessionContext({ sessionId: 'sessA', role: 'trader' }, () => {
      rec.recordToolCall({
        toolName: 'totally_unknown_tool',
        args: {},
        result: {},
        durationMs: 1,
      });
    });

    const status = getSessionStatus('sessA', rec);
    expect(status.totalCalls).toBe(1);
    expect(status.bySignal).toEqual({ counter: 0, todo: 0, env: 0, none: 1 });
  });

  it('returns zeros and nulls for a session with no records', () => {
    const rec = createAuditRecorder();
    const status = getSessionStatus('sess-empty', rec);
    expect(status.sessionId).toBe('sess-empty');
    expect(status.totalCalls).toBe(0);
    expect(status.bySignal).toEqual({ counter: 0, todo: 0, env: 0, none: 0 });
    expect(status.lastToolName).toBeNull();
    expect(status.lastToolAt).toBeNull();
    expect(status.pendingApprovals).toBe(0);
  });
});

describe('status route GET /sessions/:id/status', () => {
  it('returns the AgentStatus JSON for the given session id', async () => {
    const res = await statusRoute.request('/sessions/sess-route/status');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['sessionId']).toBe('sess-route');
    expect(body['totalCalls']).toBe(0);
    expect(body['bySignal']).toEqual({
      counter: 0,
      todo: 0,
      env: 0,
      none: 0,
    });
    expect(body['lastToolName']).toBeNull();
    expect(body['lastToolAt']).toBeNull();
    expect(body['pendingApprovals']).toBe(0);
  });
});

const rec: ToolCallRecord[] = [
  { toolName: 'ingest_document', args: {}, result: {}, durationMs: 10, timestamp: '2026-08-12T00:00:00Z', sessionId: 's1' },
  { toolName: 'extract_fields', args: {}, result: {}, durationMs: 5, timestamp: '2026-08-12T00:00:01Z', sessionId: 's1' },
  { toolName: 'ingest_document', args: {}, result: {}, durationMs: 8, timestamp: '2026-08-12T00:00:02Z', sessionId: 's1' },
  { toolName: 'recall_documents', args: {}, result: {}, durationMs: 3, timestamp: '2026-08-12T00:00:03Z', sessionId: 's2' },
];

describe('getToolCallCounts', () => {
  it('groups tool calls by toolName in first-seen order, scoped by session', () => {
    expect(getToolCallCounts('s1', { records: rec })).toEqual([
      { tool: 'ingest_document', count: 2 },
      { tool: 'extract_fields', count: 1 },
    ]);
  });

  it('ignores records from other sessions', () => {
    expect(getToolCallCounts('s2', { records: rec })).toEqual([
      { tool: 'recall_documents', count: 1 },
    ]);
  });

  it('returns an empty array for an unknown session', () => {
    expect(getToolCallCounts('unknown', { records: rec })).toEqual([]);
  });
});
