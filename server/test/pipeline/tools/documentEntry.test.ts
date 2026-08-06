import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, migrate } from '../../../src/pipeline/db/client.js';
import {
  buildIngestDocumentTool, buildExtractFieldsTool, buildBindDocumentTool,
} from '../../../src/pipeline/tools/documentEntry.js';

let ctx: ReturnType<typeof createDb>;
let dir: string;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
  dir = mkdtempSync(join(tmpdir(), 'dc-'));
});

// stub model returns a grounded extraction the validator accepts
const stubModel = {
  doGenerate: async () => ({ rawResponse: {} }),
} as any;

describe('document-entry tools', () => {
  it('ingest_document parses a digital file and persists a BlockModel', async () => {
    const f = join(dir, 'c.txt');
    writeFileSync(f, '合同号: HT-2024-001\n金额: 2860000', 'utf-8');
    const ingest = buildIngestDocumentTool({ ctx });
    const res = await ingest.execute({ sourceUri: f, docType: '合同', modality: 'digital' }, {
      messages: [], toolCallId: 't', abortSignal: undefined as any,
    } as any);
    expect(res.docId).toBeDefined();
    expect(res.blockCount).toBe(2);
    expect(res.modality).toBe('digital');
  });

  it('bind_document (L2) writes a binding for the contract', async () => {
    const f = join(dir, 'c.txt');
    writeFileSync(f, '合同号: HT-2024-001', 'utf-8');
    const ingest = buildIngestDocumentTool({ ctx });
    const { docId } = await ingest.execute({ sourceUri: f, docType: '合同', modality: 'digital' }, {
      messages: [], toolCallId: 't', abortSignal: undefined as any,
    } as any);

    const bind = buildBindDocumentTool({ ctx });
    const res = await bind.execute(
      { documentId: docId, contractNo: 'HT-2024-001', relation: 'primary', confidence: 0.98 },
      { messages: [], toolCallId: 't', abortSignal: undefined as any } as any,
    );
    expect(res.ok).toBe(true);
    expect(res.bindingId).toMatch(/^BD-/);
  });
});
