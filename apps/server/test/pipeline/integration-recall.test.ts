import { describe, it, expect, beforeAll } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDb, migrate, type SqliteDbContext } from '../../src/pipeline/db/client.js';
import { env } from '../../src/env.js';
import { enableVec, isVecReady } from '../../src/pipeline/db/vecStore.js';
import { DeterministicEmbedder } from '../../src/pipeline/embedder.js';
import {
  buildIngestDocumentTool,
  buildExtractFieldsTool,
} from '../../src/pipeline/tools/documentEntry.js';
import { buildRecallDocumentsTool } from '../../src/pipeline/tools/recall.js';
import { getToolsForRole } from '../../src/harness/roleToolRegistry.js';
import { assertAllToolsContracted } from '../../src/harness/contextContract.js';

// End-to-end integration of the §7 document-entry -> hybrid recall chain. The 7
// pieces (ingest + path allowlist, chunking, FTS5 index, sqlite-vec index,
// DeterministicEmbedder, RRF hybrid recall, injection-defense tagExternal) were
// built + unit-tested in isolation across Task 6 v1/v2; this file exercises them
// as ONE chain against a single ingested document. DeterministicEmbedder only --
// zero network/Ollama.

const execOpts = {
  messages: [], toolCallId: 't', abortSignal: undefined as any,
} as any;

// A fake LanguageModelV2 whose doGenerate returns JSON the SDK parses into the
// grounded-extraction schema (same seam as test/harness/injectionDefense.test).
// The cited span points into block b0 ("合同号: HT-2024-001") of the test doc.
function createExtractModel() {
  return {
    specificationVersion: 'v2' as const,
    provider: 'fake',
    modelId: 'fake-model',
    supportedUrls: {} as Record<string, RegExp[]>,
    async doGenerate() {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              fields: {
                合同号: {
                  value: 'HT-2024-001',
                  sourceSpans: [{ blockId: 'b0', start: 5, end: 16 }],
                },
              },
              llmConsistency: 0.95,
            }),
          },
        ],
        finishReason: 'stop' as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [] as unknown[],
      };
    },
    async doStream() {
      throw new Error('doStream not used by extract_fields');
    },
  };
}

// Test doc with DISTINCT sections placed in DISTINCT chunks:
//   b0  "合同号: HT-2024-001"            -> chunk 0 (contract no; no diesel/arbitration)
//   b1  long goods line (>=500 chars)    -> chunk 1 (own chunk; contains "diesel")
//   b2  dispute line                     -> chunk 2 (merged with b3; contains "arbitration")
//   b3  signatories line                 ->   (merged into chunk 2)
// So no single chunk has BOTH "diesel" and "arbitration" -> FTS5 AND-misses the
// query "diesel arbitration", but the vector lane catches both chunks (RRF value).
const GOODS_LINE = `货物明细: ${'diesel fuel product '.repeat(40)}`; // > 500 chars
const DOC_TEXT = [
  '合同号: HT-2024-001',
  GOODS_LINE,
  '争议解决: arbitration clause governs dispute resolution under this contract',
  '签署方: 华盛集团 与 中石化',
].join('\n');

describe('integration: document-entry -> hybrid recall chain', () => {
  let ctx: SqliteDbContext;
  let embedder: DeterministicEmbedder;
  let docId: string;

  beforeAll(async () => {
    ctx = createDb(':memory:');
    migrate(ctx.sqlite);
    enableVec(ctx.sqlite); // load sqlite-vec + create doc_chunk_vec
    embedder = new DeterministicEmbedder();

    const file = join(env.INGEST_ROOT, `integration-${Date.now()}.txt`);
    writeFileSync(file, DOC_TEXT, 'utf-8');

    // STAGE 0 (chain entry): ingest the multi-section doc with the embedder wired
    // so chunking + FTS5 + sqlite-vec indexing all fire in one execute call.
    const ingest = buildIngestDocumentTool({ ctx, embedder });
    const res = await ingest.execute(
      { sourceUri: file, docType: '合同', modality: 'digital' },
      execOpts,
    );
    docId = res.docId;
  });

  // ---- 1. INGEST: doc + chunks + FTS5 + vec all persisted ------------------
  it('1. INGEST persists the document, multi chunk rows, FTS5 + vec indexes', async () => {
    expect(await isVecReady(ctx)).toBe(true);

    // document row persisted.
    const doc = ctx.sqlite
      .prepare('SELECT id, doc_type FROM documents WHERE id = ?')
      .get(docId) as { id: string; doc_type: string } | undefined;
    expect(doc?.id).toBe(docId);

    // chunk rows persisted, and MORE THAN ONE (the doc split into multiple chunks).
    const chunks = ctx.sqlite
      .prepare('SELECT id, chunk_index, chunk_text FROM doc_chunk WHERE document_id = ? ORDER BY chunk_index')
      .all(docId) as Array<{ id: number; chunk_index: number; chunk_text: string }>;
    expect(chunks.length).toBeGreaterThan(1);
    // The goods section became its own chunk carrying "diesel".
    expect(chunks.some((c) => c.chunk_text.includes('diesel'))).toBe(true);
    // The dispute section became a chunk carrying "arbitration".
    expect(chunks.some((c) => c.chunk_text.includes('arbitration'))).toBe(true);

    const chunkIds = new Set(chunks.map((c) => c.id));

    // FTS5 index populated: a direct MATCH on a known token hits.
    const ftsHit = (
      ctx.sqlite
        .prepare('SELECT COUNT(*) AS n FROM doc_chunk_fts AS f WHERE f.chunk_text MATCH ?')
        .get('"diesel"') as { n: number }
    ).n;
    expect(ftsHit).toBeGreaterThan(0);

    // sqlite-vec index populated: one vector per chunk rowid.
    const vecIds = new Set(
      (ctx.sqlite.prepare('SELECT id FROM doc_chunk_vec').all() as Array<{ id: number | bigint }>).map(
        (r) => Number(r.id),
      ),
    );
    expect(vecIds.size).toBeGreaterThan(0);
    for (const id of chunkIds) expect(vecIds.has(id)).toBe(true);
  });

  // ---- 2. EXTRACT: grounded fields returned AND wrapped (injection defense) -
  it('2. EXTRACT returns grounded fields wrapped in <external_content>', async () => {
    const extract = buildExtractFieldsTool({
      ctx,
      extraction: { model: createExtractModel() as any },
    });
    const res = (await extract.execute({ docId, docType: '合同' }, execOpts)) as {
      extractionId: string;
      fields: Array<{ name: string; value: string | number }>;
    };
    expect(res.extractionId).toBeDefined();
    expect(res.fields.length).toBeGreaterThan(0);

    // The contract-no field was grounded in b0 and its value is external-derived
    // doc text -> tagExternal applied (contract output:'tagged').
    const contract = res.fields.find((f) => f.name === '合同号');
    expect(contract).toBeDefined();
    expect(String(contract!.value)).toContain('<external_content');
    expect(String(contract!.value)).toContain('</external_content>');
    expect(String(contract!.value)).toContain('HT-2024-001');
  });

  // ---- 3. RECALL HYBRID: returns the doc's chunks, RRF-ranked + tagged ------
  it('3. RECALL hybrid returns the ingested doc chunks, RRF-ranked + tagged', async () => {
    const recall = buildRecallDocumentsTool({ ctx, embedder });
    const res = (await recall.execute(
      { query: 'diesel', strategy: 'hybrid' },
      execOpts,
    )) as {
      strategy: string;
      matchCount: number;
      matches: Array<{
        document_id: string;
        chunk_index: number | null;
        snippet: string;
        score: number;
        source: string;
        bm25_score: number | null;
        vector_distance: number | null;
      }>;
    };
    expect(res.strategy).toBe('hybrid');
    expect(res.matchCount).toBeGreaterThan(0);
    // Every match points at the ingested doc.
    expect(res.matches.every((m) => m.document_id === docId)).toBe(true);
    // The goods chunk (diesel) is found by BOTH lanes -> carries both signals.
    const diesel = res.matches.find((m) => m.snippet.includes('diesel'));
    expect(diesel).toBeDefined();
    expect(diesel!.bm25_score).not.toBeNull();
    expect(diesel!.vector_distance).not.toBeNull();
    // Unified score present (higher = better).
    expect(typeof diesel!.score).toBe('number');
    // Snippet is external content -> injection-defense wrapped.
    expect(diesel!.snippet).toContain('<external_content');
    expect(diesel!.snippet).toContain('</external_content>');
  });

  // ---- 4. RRF VALUE: vector catches what FTS5 AND-misses -------------------
  it('4. RRF hybrid surfaces chunks the FTS5 lane alone misses', async () => {
    const recall = buildRecallDocumentsTool({ ctx, embedder });

    // No single chunk has BOTH "diesel" and "arbitration" -> FTS5 AND finds 0.
    const ftsOnly = (await recall.execute(
      { query: 'diesel arbitration', strategy: 'fts' },
      execOpts,
    )) as { matchCount: number };
    expect(ftsOnly.matchCount).toBe(0);

    // Hybrid: the vector lane matches the goods chunk (via "diesel") AND the
    // dispute chunk (via "arbitration"), so they surface via RRF even though the
    // FTS5 lane contributed nothing.
    const hybrid = (await recall.execute(
      { query: 'diesel arbitration', strategy: 'hybrid' },
      execOpts,
    )) as {
      matchCount: number;
      matches: Array<{
        snippet: string;
        document_id: string;
        bm25_score: number | null;
        vector_distance: number | null;
      }>;
    };
    expect(hybrid.matchCount).toBeGreaterThan(ftsOnly.matchCount);
    // Pure vector contributions: bm25 null (fts missed), vector_distance set.
    const vectorCaught = hybrid.matches.filter((m) => m.bm25_score === null && m.vector_distance !== null);
    expect(vectorCaught.length).toBeGreaterThan(0);
    // The two relevant chunks (diesel + arbitration) both surface, same doc.
    const snips = hybrid.matches.map((m) => m.snippet).join('\n');
    expect(snips).toMatch(/diesel/);
    expect(snips).toMatch(/arbitration/);
    expect(hybrid.matches.every((m) => m.document_id === docId)).toBe(true);
  });

  // ---- 5. GRACEFUL FALLBACK: vec unavailable -> hybrid degrades to fts ------
  it('5. GRACEFUL FALLBACK: hybrid downgrades to fts when sqlite-vec is absent', async () => {
    // A separate connection on which sqlite-vec is NEVER loaded.
    const noVec = createDb(':memory:');
    migrate(noVec.sqlite);
    expect(await isVecReady(noVec)).toBe(false);

    const file = join(env.INGEST_ROOT, `fallback-${Date.now()}.txt`);
    writeFileSync(file, 'diesel fuel contract alpha', 'utf-8');
    const ingest = buildIngestDocumentTool({ ctx: noVec, embedder });
    const { docId: fbDocId } = await ingest.execute(
      { sourceUri: file, docType: '合同', modality: 'digital' },
      execOpts,
    );

    const recall = buildRecallDocumentsTool({ ctx: noVec, embedder });
    const res = (await recall.execute(
      { query: 'diesel', strategy: 'hybrid' },
      execOpts,
    )) as {
      strategy: string;
      matchCount: number;
      matches: Array<{ document_id: string; source: string }>;
    };
    // resolveStrategy downgraded hybrid -> fts; still returns the FTS hit, no crash.
    expect(res.strategy).toBe('fts');
    expect(res.matchCount).toBeGreaterThan(0);
    expect(res.matches.some((m) => m.document_id === fbDocId)).toBe(true);
    expect(res.matches.every((m) => m.source === 'fts')).toBe(true);
  });

  // ---- 6. CONTRACT GUARD: full trader toolset contracted -------------------
  it('6. CONTRACT GUARD: all trader tools (incl recall_documents) are contracted', () => {
    const tools = getToolsForRole('trader', {
      ctx,
      extraction: { model: createExtractModel() as any },
      embedder,
    });
    const names = tools.map((t) => t.name);
    // The 7 base + 3 doc-entry + recall_documents + execute_code = 12 live trader tools.
    expect(names).toHaveLength(12);
    expect(names).toContain('recall_documents');
    expect(names).toContain('ingest_document');
    expect(names).toContain('extract_fields');
    // The buildGatedTools choke point enforces a contract for every live tool;
    // passing here means recall_documents (and friends) all have contract entries.
    expect(() => assertAllToolsContracted(names)).not.toThrow();
  });
});
