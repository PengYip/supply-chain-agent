// One-off backfill: re-embed legacy chunks with the CURRENT production embedder.
//
// WHY: chunks ingested before SiliconFlow was wired carry DeterministicEmbedder
// vectors (FNV hash, no semantics). Old vectors and new bge-m3 query vectors do
// not share a vector space, so mixed rows poison vector/hybrid recall with
// garbage cosine distances. This script finds docs whose persisted
// vectorization mode is not the current one, re-embeds their chunk texts, and
// upserts fresh vectors + vectorization_meta.
//
// RUN (on the server, project root):
//   export PATH=$HOME/.nvm/versions/node/v24.19.0/bin:$PATH
//   npx tsx apps/server/scripts/backfillEmbeddings.ts --dry-run   # preview
//   npx tsx apps/server/scripts/backfillEmbeddings.ts            # apply
//
// Safe to re-run: only docs whose stored mode differs from the current
// embedder are processed, so a completed pass is a no-op.

import 'dotenv/config';
import { performance } from 'node:perf_hooks';
import { getDbContext } from '../src/pipeline/db/dbBackend.js';
import { defaultEmbedder } from '../src/pipeline/ingestModel.js';
import { saveChunkVectors, isVecReady } from '../src/pipeline/db/vecStore.js';
import { setDocumentVectorizationPg } from '../src/pipeline/db/postgres-repositories.js';
import type { DbContext } from '../src/pipeline/db/client.js';

interface VecMeta {
  status?: string;
  mode?: string;
  chunkCount?: number;
  reason?: string;
}

const BATCH = 32;

async function listDocsNeedingReembed(
  ctx: DbContext,
): Promise<Array<{ docId: string; mode: string | null; chunkCount: number }>> {
  const currentKind = defaultEmbedder().kind;

  if (ctx.backend === 'postgres') {
    // vectorization_meta is jsonb; docs with NULL meta (legacy rows) count as
    // mode=null and are re-embedded too. Chunked docs only.
    const res = await ctx.pool.query(
      `SELECT d.id AS "docId",
              COALESCE(d.vectorization_meta->>'mode', '') AS mode,
              (SELECT COUNT(*) FROM doc_chunk c WHERE c.document_id = d.id) AS "chunkCount"
         FROM documents d
        WHERE EXISTS (SELECT 1 FROM doc_chunk c WHERE c.document_id = d.id)`,
    );
    return (res.rows as Array<{ docId: string; mode: string; chunkCount: string }>)
      .map((r) => ({ docId: r.docId, mode: r.mode || null, chunkCount: Number(r.chunkCount) }))
      .filter((r) => r.mode !== currentKind);
  }

  const rows = ctx.sqlite
    .prepare(
      `SELECT d.id AS docId, d.vectorization_meta AS meta,
              (SELECT COUNT(*) FROM doc_chunk c WHERE c.document_id = d.id) AS chunkCount
         FROM documents d
        WHERE EXISTS (SELECT 1 FROM doc_chunk c WHERE c.document_id = d.id)`,
    )
    .all() as Array<{ docId: string; meta: string | null; chunkCount: number }>;
  return rows
    .map((r) => {
      let parsed: VecMeta | null = null;
      try {
        parsed = r.meta ? (JSON.parse(r.meta) as VecMeta) : null;
      } catch {
        parsed = null;
      }
      return { docId: r.docId, mode: parsed?.mode ?? null, chunkCount: r.chunkCount };
    })
    .filter((r) => r.mode !== currentKind);
}

async function getChunksPg(
  ctx: DbContext,
  docId: string,
): Promise<Array<{ rowid: number; text: string }>> {
  const res = await ctx.pool.query(
    'SELECT id, chunk_text FROM doc_chunk WHERE document_id = $1 ORDER BY id',
    [docId],
  );
  return (res.rows as Array<{ id: number; chunk_text: string }>).map((r) => ({
    rowid: Number(r.id),
    text: r.chunk_text,
  }));
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const ctx = getDbContext();
  const embedder = defaultEmbedder();
  console.log(`[backfill] backend=${ctx.backend} embedder=${embedder.kind}`);

  if (!(await isVecReady(ctx))) {
    console.error('[backfill] vector store NOT ready on this connection; aborting.');
    process.exit(1);
  }

  const docs = await listDocsNeedingReembed(ctx);
  const totalChunks = docs.reduce((s, d) => s + d.chunkCount, 0);
  console.log(`[backfill] docs needing re-embed: ${docs.length}, chunks: ${totalChunks}`);
  for (const d of docs.slice(0, 20)) {
    console.log(`[backfill]   - ${d.docId} mode=${d.mode ?? 'none'} chunks=${d.chunkCount}`);
  }
  if (docs.length > 20) console.log(`[backfill]   ... and ${docs.length - 20} more`);

  if (dryRun || docs.length === 0) {
    console.log(dryRun ? '[backfill] dry-run complete; nothing written.' : '[backfill] nothing to do.');
    return;
  }

  let doneDocs = 0;
  let doneChunks = 0;
  let failedDocs = 0;
  const t0 = performance.now();

  for (const doc of docs) {
    try {
      const chunks =
        ctx.backend === 'postgres' ? await getChunksPg(ctx, doc.docId) : getChunks(doc.docId);
      if (chunks.length === 0) continue;
      // Batched embedding: BATCH texts per HTTP call (rate-limit friendly).
      const vectors: number[][] = [];
      for (let i = 0; i < chunks.length; i += BATCH) {
        const slice = chunks.slice(i, i + BATCH).map((c) => c.text);
        const vecs = await embedder.embed(slice);
        vectors.push(...vecs);
        if (i + BATCH < chunks.length) await new Promise((r) => setTimeout(r, 200));
      }
      const written = await saveChunkVectors(
        ctx,
        chunks.map((c, i) => ({ chunkRowId: c.rowid, vec: vectors[i] ?? [] })),
      );
      // Stamp vectorization_meta so a re-run skips this doc.
      if (ctx.backend === 'postgres') {
        await setDocumentVectorizationPg(ctx, doc.docId, {
          status: 'ok',
          mode: embedder.kind,
          chunkCount: chunks.length,
        });
      } else {
        ctx.sqlite
          .prepare('UPDATE documents SET vectorization_meta = ? WHERE id = ?')
          .run(JSON.stringify({ status: 'ok', mode: embedder.kind, chunkCount: chunks.length }), doc.docId);
      }
      doneDocs++;
      doneChunks += written;
      console.log(`[backfill] ok ${doc.docId}: ${written}/${chunks.length} vectors`);
    } catch (e) {
      failedDocs++;
      console.error(`[backfill] FAILED ${doc.docId}:`, (e as Error).message);
    }
  }

  console.log(
    `[backfill] DONE in ${Math.round(performance.now() - t0)}ms: `
    + `docs=${doneDocs} chunks=${doneChunks} failed=${failedDocs}`,
  );
}

main().catch((e) => {
  console.error('[backfill] fatal:', e);
  process.exit(1);
});
