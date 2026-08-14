import { describe, it, expect, beforeEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDb, migrate, type SqliteDbContext } from '../../src/pipeline/db/client.js';
import { env } from '../../src/env.js';
import { buildIngestDocumentTool } from '../../src/pipeline/tools/documentEntry.js';
import { buildRecallDocumentsTool } from '../../src/pipeline/tools/recall.js';
import { saveBinding } from '../../src/pipeline/db/repositories.js';
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

    // Non-matching tag -> 标签过滤无命中, 但候选非空: 自动放宽(不返回空), 并
    // 标记 tagFilterFallback=true 供 agent 如实说明。
    const miss = (await recall.execute(
      { query: 'diesel', strategy: 'fts', wantTags: ['不存在的标签'] },
      execOpts,
    )) as { matchCount: number; matches: unknown[]; tagFilterFallback?: boolean };
    expect(miss.matchCount).toBeGreaterThan(0);
    expect(miss.matches.length).toBeGreaterThan(0);
    expect(miss.tagFilterFallback).toBe(true);
  });

  it('relaxes wantTags when chunks are untagged (tagFilterFallback=true)', async () => {
    // 无 tagger -> chunks 的 tags 为 NULL, 任何 wantTags 都不会命中。
    await ingest();
    const recall = buildRecallDocumentsTool({ ctx });
    const res = (await recall.execute(
      { query: 'diesel', strategy: 'fts', wantTags: ['违约责任'] },
      execOpts,
    )) as { matchCount: number; matches: unknown[]; tagFilterFallback?: boolean };
    expect(res.matchCount).toBeGreaterThan(0);
    expect(res.tagFilterFallback).toBe(true);
  });
});

describe('recall_documents contractNo filter (接线闭环)', () => {
  it('only returns chunks bound to the given contract', async () => {
    const docA = await ingest();
    // 第二份文档也含 diesel, 但不绑定到该合同。
    const file2 = join(env.INGEST_ROOT, `recall-cno-${Date.now()}.txt`);
    writeFileSync(file2, 'diesel shipment for a different deal', 'utf-8');
    const ingestTool = buildIngestDocumentTool({ ctx });
    const docB = (await ingestTool.execute(
      { sourceUri: file2, docType: '合同', modality: 'digital' },
      execOpts,
    )) as { docId: string };
    expect(docB.docId).not.toBe(docA);
    // 只把 docA 绑定到 HT-2024-001(bindings 按原文匹配)。
    await saveBinding(ctx, {
      documentId: docA,
      contractNo: 'HT-2024-001',
      relation: 'primary',
      sourceRefs: [],
      confidence: 1,
      createdBy: 'test',
    });

    const recall = buildRecallDocumentsTool({ ctx });
    const res = (await recall.execute(
      { query: 'diesel', strategy: 'fts', contractNo: 'HT-2024-001' },
      execOpts,
    )) as { matchCount: number; matches: Array<{ document_id: string }>; contractNo?: string };
    expect(res.matchCount).toBeGreaterThan(0);
    // 过滤后只回 docA 的片段。
    expect(res.matches.every((m) => m.document_id === docA)).toBe(true);
    // 响应回显归一化后的合同号。
    expect(res.contractNo).toBe('HT-2024-001');
  });

  it('returns an empty result with a note when no document is bound to the contract', async () => {
    await ingest(); // 存在 diesel 片段, 但没有任何文档绑定到该合同号
    const recall = buildRecallDocumentsTool({ ctx });
    const res = (await recall.execute(
      { query: 'diesel', strategy: 'fts', contractNo: 'HT-2024-777' },
      execOpts,
    )) as { matchCount: number; matches: unknown[]; note?: string; contractNo?: string };
    expect(res.matchCount).toBe(0);
    expect(res.matches).toEqual([]);
    expect(res.note).toBe('未找到与该合同号绑定的文档');
    expect(res.contractNo).toBe('HT-2024-777');
  });
});
