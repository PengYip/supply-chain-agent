import { describe, it, expect, beforeEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDb, migrate, type SqliteDbContext } from '../../src/pipeline/db/client.js';
import { env } from '../../src/env.js';
import { buildIngestDocumentTool } from '../../src/pipeline/tools/documentEntry.js';
import { enableVec } from '../../src/pipeline/db/vecStore.js';
import { DeterministicEmbedder } from '../../src/pipeline/embedder.js';
import type { Embedder } from '../../src/pipeline/embedder.js';

const execOpts = { messages: [], toolCallId: 't', abortSignal: undefined } as unknown as Parameters<
  ReturnType<typeof buildIngestDocumentTool>['execute']
>[1];

let ctx: SqliteDbContext;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
});

function fixture(text: string): string {
  const f = join(env.INGEST_ROOT, `vec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.txt`);
  writeFileSync(f, text, 'utf-8');
  return f;
}

describe('ingest_document vectorization status', () => {
  it('reports status=skipped when no embedder wired', async () => {
    const ingest = buildIngestDocumentTool({ ctx });
    const res = await ingest.execute({ sourceUri: fixture('合同号: HT001'), docType: '合同', modality: 'digital' }, execOpts);
    expect(res.vectorization.status).toBe('skipped');
    expect(res.vectorization.chunkCount).toBeGreaterThan(0);
    expect(typeof res.vectorization.mode).toBe('string');
  });

  it('reports ok (or skipped-by-host) when an embedder is wired', async () => {
    const cap = enableVec(ctx.sqlite);
    const embedder = new DeterministicEmbedder();
    const ingest = buildIngestDocumentTool({ ctx, embedder });
    const res = await ingest.execute({ sourceUri: fixture('合同号: HT002'), docType: '合同', modality: 'digital' }, execOpts);
    // Robust to sqlite-vec not loading on the host:
    expect(res.vectorization.status).toBe(cap.ok ? 'ok' : 'skipped');
    if (cap.ok) expect(res.vectorization.mode).toBe('deterministic');
  });

  it('reports failed when embedding throws (or skipped-by-host)', async () => {
    const cap = enableVec(ctx.sqlite);
    const boom: Embedder = {
      dim: 1024, kind: 'test-throw',
      embed: async () => { throw new Error('boom'); },
    };
    const ingest = buildIngestDocumentTool({ ctx, embedder: boom });
    const res = await ingest.execute({ sourceUri: fixture('合同号: HT003'), docType: '合同', modality: 'digital' }, execOpts);
    expect(res.vectorization.status).toBe(cap.ok ? 'failed' : 'skipped');
    if (cap.ok) expect(res.vectorization.reason).toContain('boom');
  });
});
