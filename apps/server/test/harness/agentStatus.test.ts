import { describe, it, expect } from 'vitest';
import {
  formatAgentStatusBody,
  buildStatusMessage,
  appendStatusMessage,
  type AgentStatusSnapshot,
} from '../../src/harness/agentStatus.js';

const snapshot: AgentStatusSnapshot = {
  toolCounts: [
    { tool: 'ingest_document', count: 2 },
    { tool: 'extract_fields', count: 1 },
  ],
  totalCalls: 3,
  pendingApprovals: 1,
  docsIngested: 5,
  extractionsPendingReview: 2,
};

describe('formatAgentStatusBody', () => {
  it('renders each tool count in first-seen order with the total', () => {
    const body = formatAgentStatusBody(snapshot);
    expect(body).toContain('- ingest_document: 2');
    expect(body).toContain('- extract_fields: 1');
    expect(body).toContain('总计: 3 次');
    expect(body.indexOf('ingest_document')).toBeLessThan(body.indexOf('extract_fields'));
  });

  it('renders pending approvals, docs ingested, and pending review counts', () => {
    const body = formatAgentStatusBody(snapshot);
    expect(body).toContain('待审批: 1 项 (L2/L3)');
    expect(body).toContain('已入库文档: 5');
    expect(body).toContain('待复核抽取: 2');
  });

  it('handles an empty snapshot gracefully', () => {
    const empty: AgentStatusSnapshot = {
      toolCounts: [],
      totalCalls: 0,
      pendingApprovals: 0,
      docsIngested: 0,
      extractionsPendingReview: 0,
    };
    const body = formatAgentStatusBody(empty);
    expect(body).toContain('总计: 0 次');
    expect(body).toContain('待审批: 0 项 (L2/L3)');
    expect(body).toContain('已入库文档: 0');
  });
});

describe('buildStatusMessage', () => {
  it('returns a user-role message wrapped in <agent_status> delimiters', () => {
    const msg = buildStatusMessage(snapshot);
    expect(msg.role).toBe('user');
    const text = typeof msg.content === 'string' ? msg.content : '';
    expect(text).toContain('<agent_status>');
    expect(text).toContain('</agent_status>');
    expect(text).toContain(formatAgentStatusBody(snapshot));
  });

  it('includes a non-instruction preamble stating this is system-generated, not a user command', () => {
    const msg = buildStatusMessage(snapshot);
    const text = typeof msg.content === 'string' ? msg.content : '';
    expect(text).toContain('非用户指令');
    expect(text).toContain('仅供参考');
  });
});

describe('appendStatusMessage', () => {
  const base = [{ role: 'user' as const, content: 'hi' }];

  it('appends a status message when a snapshot is provided', () => {
    const out = appendStatusMessage(base, snapshot);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(base[0]);
    expect(out[1].role).toBe('user');
  });

  it('returns the same array reference unchanged when snapshot is null', () => {
    expect(appendStatusMessage(base, null)).toBe(base);
  });
});
