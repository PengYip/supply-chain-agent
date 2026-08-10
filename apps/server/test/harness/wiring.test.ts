import { describe, it, expect } from 'vitest';
import { getToolsForRole, listToolNames } from '../../src/harness/roleToolRegistry.js';
import { createDb, migrate } from '../../src/pipeline/db/client.js';

describe('trader role wiring', () => {
  it('trader exposes ingest/extract/bind document tools', () => {
    const ctx = createDb(':memory:');
    migrate(ctx.sqlite);
    const names = listToolNames('trader');
    expect(names).toContain('ingest_document');
    expect(names).toContain('extract_fields');
    expect(names).toContain('bind_document');
  });

  it('bind_document is flagged needsApproval (L2)', () => {
    const ctx = createDb(':memory:');
    migrate(ctx.sqlite);
    const tools = getToolsForRole('trader', { ctx });
    const bind = tools.find((t) => t.name === 'bind_document')!;
    expect(bind.needsApproval).toBe(true);
  });

  it('ingest_document and extract_fields are L1 (no needsApproval)', () => {
    const ctx = createDb(':memory:');
    migrate(ctx.sqlite);
    const tools = getToolsForRole('trader', { ctx });
    const ingest = tools.find((t) => t.name === 'ingest_document')!;
    const extract = tools.find((t) => t.name === 'extract_fields')!;
    expect(ingest.needsApproval ?? false).toBe(false);
    expect(extract.needsApproval ?? false).toBe(false);
  });
});
