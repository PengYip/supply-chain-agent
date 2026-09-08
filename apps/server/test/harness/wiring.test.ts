import { describe, it, expect } from 'vitest';
import { getToolsForRole, listToolNames } from '../../src/harness/roleToolRegistry.js';
import { createDb, migrate } from '../../src/pipeline/db/client.js';

describe('trader role wiring', () => {
  it('trader exposes ingest/bind document tools; extract_fields stays removed', () => {
    const ctx = createDb(':memory:');
    migrate(ctx.sqlite);
    const names = listToolNames('trader');
    expect(names).toContain('ingest_document');
    expect(names).toContain('bind_document');
    // 2026-09-08 工具精简阶段1: extract_fields removed (blacklisted).
    expect(names).not.toContain('extract_fields');
  });

  it('bind_document is flagged needsApproval (L2)', () => {
    const ctx = createDb(':memory:');
    migrate(ctx.sqlite);
    const tools = getToolsForRole('trader', { ctx });
    const bind = tools.find((t) => t.name === 'bind_document')!;
    expect(bind.needsApproval).toBe(true);
  });

  it('ingest_document is L1 (no needsApproval)', () => {
    const ctx = createDb(':memory:');
    migrate(ctx.sqlite);
    const tools = getToolsForRole('trader', { ctx });
    const ingest = tools.find((t) => t.name === 'ingest_document')!;
    expect(ingest.needsApproval ?? false).toBe(false);
  });
});
