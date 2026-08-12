import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import { buildAgentStatusSnapshot } from '../../src/harness/agent.js';
import type { ToolCallRecord } from '../../src/harness/auditRecorder.js';

describe('buildAgentStatusSnapshot', () => {
  let ctx: DbContext;
  beforeEach(() => {
    ctx = createDb(':memory:');
    migrate(ctx.sqlite);
    ctx.sqlite
      .prepare(
        "INSERT INTO documents (id, doc_type, modality, source_uri, block_model, user_id, created_at) VALUES ('d1','合同','digital','s','{}','alice',datetime('now'))",
      )
      .run();
    ctx.sqlite
      .prepare(
        "INSERT INTO extractions (id, document_id, doc_type, fields, field_meta, overall_confidence, needs_review, user_id, created_at) VALUES ('e1','d1','合同','[]','{}',0.8,1,'alice',datetime('now'))",
      )
      .run();
  });

  it('aggregates per-tool counts, pending approvals, and DB progress counts', async () => {
    const records: ToolCallRecord[] = [
      { toolName: 'ingest_document', args: {}, result: {}, durationMs: 1, timestamp: 't', sessionId: 's1' },
      { toolName: 'ingest_document', args: {}, result: {}, durationMs: 1, timestamp: 't', sessionId: 's1' },
    ];
    const snap = await buildAgentStatusSnapshot({ sessionId: 's1', userId: 'alice', ctx, recorder: { records } });
    expect(snap.toolCounts).toEqual([{ tool: 'ingest_document', count: 2 }]);
    expect(snap.totalCalls).toBe(2);
    expect(snap.docsIngested).toBe(1);
    expect(snap.extractionsPendingReview).toBe(1);
  });

  it('reports zero pending approvals for an unknown session', async () => {
    const snap = await buildAgentStatusSnapshot({
      sessionId: 'never-existed',
      userId: 'alice',
      ctx,
      recorder: { records: [] },
    });
    expect(snap.pendingApprovals).toBe(0);
    expect(snap.totalCalls).toBe(0);
  });
});
