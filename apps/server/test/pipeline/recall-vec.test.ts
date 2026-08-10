import { describe, it, expect, beforeEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDb, migrate, type SqliteDbContext } from '../../src/pipeline/db/client.js';
import { env } from '../../src/env.js';
import { buildIngestDocumentTool } from '../../src/pipeline/tools/documentEntry.js';
import { buildRecallDocumentsTool } from '../../src/pipeline/tools/recall.js';
import {
  enableVec,
  isVecReady,
  saveChunkVectors,
  vectorKnn,
  packVec,
} from '../../src/pipeline/db/vecStore.js';
import { DeterministicEmbedder } from '../../src/pipeline/embedder.js';

const execOpts = {
  messages: [], toolCallId: 't', abortSignal: undefined as any,
} as any;

let ctx: SqliteDbContext;
let embedder: DeterministicEmbedder;

beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
  enableVec(ctx.sqlite); // load sqlite-vec + create doc_chunk_vec
  embedder = new DeterministicEmbedder();
});

function fixture(name: string, text: string): string {
  const f = join(env.INGEST_ROOT, `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.txt`);
  writeFileSync(f, text, 'utf-8');
  return f;
}

async function ingest(text: string, docType: '合同' | '发票' = '合同'): Promise<string> {
  const f = fixture('vec', text);
  const ingest = buildIngestDocumentTool({ ctx, embedder });
  const res = await ingest.execute({ sourceUri: f, docType, modality: 'digital' }, execOpts);
  return res.docId;
}

function vecRowCount(): number {
  return (ctx.sqlite.prepare('SELECT COUNT(*) AS n FROM doc_chunk_vec').get() as { n: number }).n;
}

describe('L4 vector recall (sqlite-vec) - load + storage', () => {
  it('sqlite-vec loads on the connection and vec_version() is non-empty', async () => {
    expect(await isVecReady(ctx)).toBe(true);
    const v = (ctx.sqlite.prepare('SELECT vec_version() AS v').get() as { v: string }).v;
    expect(typeof v).toBe('string');
    expect(v.length).toBeGreaterThan(0);
  });

  it('ingest populates doc_chunk_vec (one vector per chunk rowid)', async () => {
    const docId = await ingest('Product: diesel fuel\nContract: HT-2024-001');
    expect(vecRowCount()).toBeGreaterThan(0);

    // The vec ids correspond to this document's chunk rowids.
    const chunkIds = (
      ctx.sqlite
        .prepare('SELECT id FROM doc_chunk WHERE document_id = ?')
        .all(docId) as Array<{ id: number }>
    ).map((r) => r.id);
    expect(chunkIds.length).toBeGreaterThan(0);
    const vecIds = new Set(
      (ctx.sqlite.prepare('SELECT id FROM doc_chunk_vec').all() as Array<{ id: number | bigint }>).map(
        (r) => Number(r.id),
      ),
    );
    for (const id of chunkIds) expect(vecIds.has(id)).toBe(true);
  });

  it('saveChunkVectors upserts (re-embedding a chunk rowid does not duplicate)', async () => {
    // Seed a documents row (doc_chunk FK -> documents.id) + one chunk row to key onto.
    ctx.sqlite
      .prepare(
        "INSERT INTO documents (id, doc_type, modality, source_uri, block_model) VALUES ('D','合同','digital','u','{}')",
      )
      .run();
    ctx.sqlite
      .prepare("INSERT INTO doc_chunk (document_id, chunk_text, chunk_index) VALUES ('D', 'x', 0)")
      .run();
    const rowid = Number(
      (ctx.sqlite.prepare('SELECT last_insert_rowid() AS id').get() as { id: number | bigint }).id,
    );
    const vec = new DeterministicEmbedder().embedOne('seed text');
    await saveChunkVectors(ctx, [{ chunkRowId: rowid, vec }]);
    const before = vecRowCount();
    expect(before).toBe(1);
    await saveChunkVectors(ctx, [{ chunkRowId: rowid, vec }]); // same id again
    expect(vecRowCount()).toBe(before); // upsert, not duplicate
  });
});

describe('L4 vector recall - KNN', () => {
  it('vector KNN returns nearest chunks for a query embedding', async () => {
    await ingest('diesel engine maintenance manual');
    await ingest('gasoline engine repair guide');
    const [queryVec] = await embedder.embed(['diesel engine']);
    const hits = await vectorKnn(ctx, queryVec, 5);
    expect(hits.length).toBeGreaterThan(0);
    // distances are finite, non-negative, ascending (nearest first).
    for (const h of hits) {
      expect(typeof h.distance).toBe('number');
      expect(Number.isFinite(h.distance)).toBe(true);
      expect(h.distance).toBeGreaterThanOrEqual(0);
    }
    const dists = hits.map((h) => h.distance);
    expect(dists).toEqual([...dists].sort((a, b) => a - b));
  });

  it("recall_documents 'vector' strategy returns nearest chunks via the tool", async () => {
    const docId = await ingest('diesel fuel contract alpha');
    const recall = buildRecallDocumentsTool({ ctx, embedder });
    const res = (await recall.execute({ query: 'diesel', strategy: 'vector' }, execOpts)) as {
      strategy: string;
      matchCount: number;
      matches: Array<{ document_id: string; source: string; vector_distance: number | null }>;
    };
    expect(res.strategy).toBe('vector');
    expect(res.matchCount).toBeGreaterThan(0);
    expect(res.matches.some((m) => m.document_id === docId)).toBe(true);
    for (const m of res.matches) {
      expect(m.source).toBe('vector');
      expect(typeof m.vector_distance).toBe('number');
    }
  });
});

describe('L4 vector recall - RRF hybrid', () => {
  it('hybrid surfaces chunks that FTS5 misses (vector contribution) via RRF', async () => {
    // A has 'diesel' but not 'contract'; B has 'contract' but not 'diesel';
    // C has both. Query "diesel contract" -> FTS5 AND matches ONLY C; the vector
    // lane also matches A and B (shared tokens), so hybrid must surface all three
    // and rank C (found by BOTH lanes) first.
    const docA = await ingest('diesel fuel alpha beta');
    const docB = await ingest('contract gamma delta epsilon');
    const docC = await ingest('diesel contract zeta eta');

    const recall = buildRecallDocumentsTool({ ctx, embedder });

    const ftsRes = (await recall.execute(
      { query: 'diesel contract', strategy: 'fts' },
      execOpts,
    )) as { matchCount: number; matches: Array<{ document_id: string }> };
    // FTS5 AND: only C has both tokens.
    expect(ftsRes.matchCount).toBe(1);
    expect(ftsRes.matches[0]!.document_id).toBe(docC);

    const hybridRes = (await recall.execute(
      { query: 'diesel contract', strategy: 'hybrid' },
      execOpts,
    )) as {
      strategy: string;
      matchCount: number;
      matches: Array<{
        document_id: string;
        source: string;
        rrf_score?: number;
        score: number;
        bm25_score: number | null;
        vector_distance: number | null;
      }>;
    };
    expect(hybridRes.strategy).toBe('hybrid');
    // Hybrid union (RRF) strictly broader than fts-only: A and B surface.
    expect(hybridRes.matchCount).toBeGreaterThan(ftsRes.matchCount);
    const docIds = hybridRes.matches.map((m) => m.document_id);
    expect(docIds).toContain(docA);
    expect(docIds).toContain(docB);
    expect(docIds).toContain(docC);
    // C is found by BOTH lanes -> highest fused rank.
    expect(docIds[0]).toBe(docC);
    // C carries both a bm25 and a vector_distance (evidence of fusion).
    const cMatch = hybridRes.matches.find((m) => m.document_id === docC)!;
    expect(cMatch.bm25_score).not.toBeNull();
    expect(cMatch.vector_distance).not.toBeNull();
  });
});

describe('DeterministicEmbedder', () => {
  it('is reproducible, 1024-dim, and L2-normalized', async () => {
    const a = new DeterministicEmbedder();
    const b = new DeterministicEmbedder();
    const [v1] = await a.embed(['hello diesel contract']);
    const [v2] = await b.embed(['hello diesel contract']);
    expect(v1).toEqual(v2);
    expect(v1.length).toBe(1024);
    const norm = Math.sqrt(v1.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it('produces different vectors for different texts', async () => {
    const e = new DeterministicEmbedder();
    const [v1] = await e.embed(['diesel fuel']);
    const [v2] = await e.embed(['completely unrelated zebra text']);
    expect(v1).not.toEqual(v2);
  });

  it('packVec round-trips a 1024-dim vector into a Float32 buffer', () => {
    const e = new DeterministicEmbedder();
    const v = e.embedOne('round trip');
    const buf = packVec(v);
    expect(buf.length).toBe(1024 * 4); // 4 bytes per float
    // packVec stores Float32; compare against the Float32-rounded source values
    // (the double -> float32 cast is lossy, so exact equality with `v` is wrong).
    const view = new Float32Array(buf.buffer, buf.byteOffset, 1024);
    const expected = Array.from(new Float32Array(v));
    expect(Array.from(view)).toEqual(expected);
  });
});

describe('graceful fallback when sqlite-vec is unavailable', () => {
  it("vector/hybrid strategies fall back to fts without crashing", async () => {
    // Separate connection where sqlite-vec is NEVER loaded.
    const noVec = createDb(':memory:');
    migrate(noVec.sqlite);
    expect(await isVecReady(noVec)).toBe(false);

    // Ingest still works (FTS5 populated; vectors skipped because !isVecReady).
    const f = fixture('nofallback', 'diesel fuel contract alpha');
    const ingest = buildIngestDocumentTool({ ctx: noVec, embedder });
    const { docId } = await ingest.execute(
      { sourceUri: f, docType: '合同', modality: 'digital' },
      execOpts,
    );

    const recall = buildRecallDocumentsTool({ ctx: noVec, embedder });
    // Request hybrid; must degrade to fts and still return the FTS hit.
    const res = (await recall.execute(
      { query: 'diesel', strategy: 'hybrid' },
      execOpts,
    )) as {
      strategy: string;
      matchCount: number;
      matches: Array<{ document_id: string; source: string }>;
    };
    expect(res.strategy).toBe('fts'); // downgraded
    expect(res.matchCount).toBeGreaterThan(0);
    expect(res.matches.some((m) => m.document_id === docId)).toBe(true);
    for (const m of res.matches) expect(m.source).toBe('fts');
  });
});
