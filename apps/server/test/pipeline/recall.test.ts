import { describe, it, expect, beforeEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDb, migrate, type SqliteDbContext } from '../../src/pipeline/db/client.js';
import { env } from '../../src/env.js';
import { buildIngestDocumentTool } from '../../src/pipeline/tools/documentEntry.js';
import { buildRecallDocumentsTool } from '../../src/pipeline/tools/recall.js';
import type { ChunkTagger } from '../../src/pipeline/chunkTagging.js';

let ctx: SqliteDbContext;
let file: string;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
  // ingest_document enforces the INGEST_ROOT path allowlist, so the fixture must
  // live inside it (not a system tmpdir). Unique name per run for isolation.
  file = join(env.INGEST_ROOT, `recall-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
  // Born-digital: one line per block. Three short KV blocks merge into one chunk.
  writeFileSync(
    file,
    'Product: diesel fuel\nContract: HT-2024-001\nAmount: 2860000',
    'utf-8',
  );
});

const execOpts = {
  messages: [], toolCallId: 't', abortSignal: undefined as any,
} as any;

async function ingest(): Promise<string> {
  const ingest = buildIngestDocumentTool({ ctx });
  const res = await ingest.execute(
    { sourceUri: file, docType: '合同', modality: 'digital' },
    execOpts,
  );
  return res.docId;
}

describe('L4 document recall (FTS5 BM25)', () => {
  it('ingest persists chunks into doc_chunk AND populates the FTS5 index', async () => {
    const docId = await ingest();

    // doc_chunk rows exist for the document.
    const rowCount = (
      ctx.sqlite
        .prepare('SELECT COUNT(*) AS n FROM doc_chunk WHERE document_id = ?')
        .get(docId) as { n: number }
    ).n;
    expect(rowCount).toBeGreaterThan(0);

    // The merged chunk carries the keyword text.
    const rows = ctx.sqlite
      .prepare('SELECT chunk_text AS t FROM doc_chunk WHERE document_id = ?')
      .all(docId) as Array<{ t: string }>;
    expect(rows.some((r) => r.t.includes('diesel'))).toBe(true);

    // FTS5 index is populated: a direct MATCH finds the row.
    const ftsHit = (
      ctx.sqlite
        .prepare(
          'SELECT COUNT(*) AS n FROM doc_chunk_fts AS f WHERE f.chunk_text MATCH ?',
        )
        .get('"diesel"') as { n: number }
    ).n;
    expect(ftsHit).toBeGreaterThan(0);
  });

  it('recall_documents matches a keyword and returns bm25-ranked chunks with document_id', async () => {
    const docId = await ingest();

    const recall = buildRecallDocumentsTool({ ctx });
    const res = (await recall.execute({ query: 'diesel', strategy: 'fts' }, execOpts)) as {
      query: string;
      matchCount: number;
      matches: Array<{ document_id: string; chunk_index: number | null; snippet: string; bm25_score: number }>;
    };

    expect(res.query).toBe('diesel');
    expect(res.matchCount).toBeGreaterThan(0);
    expect(res.matches.length).toBe(res.matchCount);
    // The match points back at the document we just ingested.
    expect(res.matches.some((m) => m.document_id === docId)).toBe(true);
    // bm25 score is a finite number (more negative = better).
    for (const m of res.matches) {
      expect(typeof m.bm25_score).toBe('number');
      expect(Number.isFinite(m.bm25_score)).toBe(true);
    }
    // Best match first (ascending bm25).
    const scores = res.matches.map((m) => m.bm25_score);
    const sorted = [...scores].sort((a, b) => a - b);
    expect(scores).toEqual(sorted);
    // Snippet highlights the matched term.
    expect(res.matches[0]!.snippet).toContain('diesel');
  });

  it('returns an empty result (no hallucination) when nothing matches (fts)', async () => {
    await ingest();
    const recall = buildRecallDocumentsTool({ ctx });
    // fts strategy: a nonsense term matches no token -> []. (vector KNN always
    // returns nearest, so the strict no-match guarantee is an fts property.)
    const res = (await recall.execute(
      { query: 'zzznomatchxyz12345', strategy: 'fts' },
      execOpts,
    )) as { matchCount: number; matches: unknown[] };
    expect(res.matchCount).toBe(0);
    expect(res.matches).toEqual([]);
  });

  it('wraps each snippet in the external-content delimiter (injection defense)', async () => {
    await ingest();
    const recall = buildRecallDocumentsTool({ ctx });
    const res = (await recall.execute({ query: 'diesel' }, execOpts)) as {
      matches: Array<{ snippet: string }>;
    };
    expect(res.matches.length).toBeGreaterThan(0);
    for (const m of res.matches) {
      // recall_documents returns external doc text -> must be delimited as DATA.
      expect(m.snippet).toContain('<external_content');
      expect(m.snippet).toContain('</external_content>');
      expect(m.snippet).toContain('diesel');
    }
  });

  it('respects the limit argument', async () => {
    // Ingest a second doc that also matches, then cap the result.
    await ingest();
    const file2 = join(env.INGEST_ROOT, `recall2-${Date.now()}.txt`);
    writeFileSync(file2, 'Another diesel shipment note', 'utf-8');
    const ingestTool = buildIngestDocumentTool({ ctx });
    await ingestTool.execute({ sourceUri: file2, docType: '合同', modality: 'digital' }, execOpts);

    const recall = buildRecallDocumentsTool({ ctx });
    const res = (await recall.execute({ query: 'diesel', limit: 1 }, execOpts)) as {
      matchCount: number; matches: unknown[];
    };
    expect(res.matches).toHaveLength(1);
  });
});

describe('recall_documents wantTags (chunk-tag filter)', () => {
  it('keeps chunks whose tags intersect wantTags and drops non-matching tags', async () => {
    // Deterministic tagger: stamp every chunk with a 合同-taxonomy tag so recall
    // has real doc_chunk.tags to filter on (no LLM needed). tagChunks keeps the
    // tag because it is a member of the 合同 taxonomy.
    const tagger: ChunkTagger = async (chunks) => {
      const out: Record<number, string[]> = {};
      for (const c of chunks) out[c.index] = ['付款条款'];
      return out;
    };
    const ingestTagged = buildIngestDocumentTool({ ctx, tagger });
    const ingestRes = (await ingestTagged.execute(
      { sourceUri: file, docType: '合同', modality: 'digital' },
      execOpts,
    )) as { docId: string };
    const docId = ingestRes.docId;

    const recall = buildRecallDocumentsTool({ ctx });

    // Matching tag -> the chunk survives the filter.
    const hit = (await recall.execute(
      { query: 'diesel', strategy: 'fts', wantTags: ['付款条款'] },
      execOpts,
    )) as { matchCount: number; matches: Array<{ document_id: string }> };
    expect(hit.matchCount).toBeGreaterThan(0);
    expect(hit.matches.some((m) => m.document_id === docId)).toBe(true);

    // Non-matching tag -> everything filtered out, no hallucinated results.
    const miss = (await recall.execute(
      { query: 'diesel', strategy: 'fts', wantTags: ['不存在的标签'] },
      execOpts,
    )) as { matchCount: number; matches: unknown[] };
    expect(miss.matchCount).toBe(0);
    expect(miss.matches).toEqual([]);
  });
});
