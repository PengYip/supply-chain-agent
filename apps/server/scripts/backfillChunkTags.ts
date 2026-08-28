// One-off backfill: re-run the Lane B chunk tagger over UNTAGGED chunks.
//
// WHY: 75% of doc_chunk rows carry no tags (ingested before Lane B went live or
// the tagger errored), so recall's wantTags filtering is a no-op for most of
// the library. This script finds chunks whose tags are NULL/empty, batches
// them per document against the docType's CLOSED taxonomy (tradeSemantics
// CHUNK_TAG_TAXONOMY), and writes the tag JSON back.
//
// RUN (on the server, project root):
//   export PATH=$HOME/.nvm/versions/node/v24.19.0/bin:$PATH
//   npx tsx apps/server/scripts/backfillChunkTags.ts --dry-run   # preview
//   npx tsx apps/server/scripts/backfillChunkTags.ts             # apply
//
// Safe to re-run: only NULL/empty-tag chunks are selected, so a completed pass
// is a no-op. Docs whose docType has no taxonomy (其他/图片凭证族) are skipped
// without an LLM call.

import 'dotenv/config';
import { performance } from 'node:perf_hooks';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { getDbContext } from '../src/pipeline/db/dbBackend.js';
import { env } from '../src/env.js';
import { makeLlmTagger, tagChunks } from '../src/pipeline/chunkTagging.js';
import { CHUNK_TAG_TAXONOMY } from '../src/domain/tradeSemantics.js';
import type { DbContext } from '../src/pipeline/db/client.js';

const DOC_PAUSE_MS = 150;

interface Row { docId: string; docType: string; cid: number; text: string }

async function listUntagged(ctx: DbContext): Promise<Row[]> {
  if (ctx.backend === 'postgres') {
    const res = await ctx.pool.query(
      `SELECT d.id AS "docId", d.doc_type AS "docType", c.id AS cid, c.chunk_text AS text
         FROM doc_chunk c JOIN documents d ON d.id = c.document_id
        WHERE c.tags IS NULL OR c.tags::text IN ('null', '[]', '')
        ORDER BY d.id, c.chunk_index`,
    );
    return res.rows as unknown as Row[];
  }
  return ctx.sqlite.prepare(
    `SELECT d.id AS docId, d.doc_type AS docType, c.id AS cid, c.chunk_text AS text
       FROM doc_chunk c JOIN documents d ON d.id = c.document_id
      WHERE c.tags IS NULL OR c.tags = ''
      ORDER BY d.id, c.chunk_index`,
  ).all() as unknown as Row[];
}

async function writeTags(ctx: DbContext, cid: number, tags: string[] | null): Promise<void> {
  if (ctx.backend === 'postgres') {
    await ctx.pool.query('UPDATE doc_chunk SET tags = $1::jsonb WHERE id = $2', [
      tags === null ? null : JSON.stringify(tags), cid,
    ]);
    return;
  }
  ctx.sqlite.prepare('UPDATE doc_chunk SET tags = ? WHERE id = ?')
    .run(tags === null ? null : JSON.stringify(tags), cid);
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const ctx = getDbContext();
  const model = createDeepSeek({
    baseURL: env.OPENAI_BASE_URL,
    apiKey: env.OPENAI_API_KEY,
  }).chat(env.OPENAI_MODEL);
  const tagger = makeLlmTagger(model);
  console.log(`[backfill:tags] backend=${ctx.backend} model=${env.OPENAI_MODEL}`);

  const rows = await listUntagged(ctx);
  // group by doc, skipping docTypes with no taxonomy (tagChunks would no-op).
  const byDoc = new Map<string, { docType: string; chunks: Array<{ cid: number; text: string }> }>();
  let skippedNoTaxonomy = 0;
  for (const r of rows) {
    const taxonomy = CHUNK_TAG_TAXONOMY[r.docType as keyof typeof CHUNK_TAG_TAXONOMY] ?? [];
    if (taxonomy.length === 0) { skippedNoTaxonomy++; continue; }
    const entry = byDoc.get(r.docId) ?? { docType: r.docType, chunks: [] };
    entry.chunks.push({ cid: r.cid, text: r.text });
    byDoc.set(r.docId, entry);
  }
  const totalChunks = [...byDoc.values()].reduce((s, d) => s + d.chunks.length, 0);
  console.log(
    `[backfill:tags] untagged chunks: ${rows.length} (skippable no-taxonomy: ${skippedNoTaxonomy}), `
    + `docs to tag: ${byDoc.size}, chunks to tag: ${totalChunks}`,
  );
  for (const [docId, d] of [...byDoc.entries()].slice(0, 20)) {
    console.log(`[backfill:tags]   - ${docId} docType=${d.docType} chunks=${d.chunks.length}`);
  }
  if (byDoc.size > 20) console.log('[backfill:tags]   ... and more');

  if (dryRun || byDoc.size === 0) {
    console.log(dryRun ? '[backfill:tags] dry-run complete; nothing written.' : '[backfill:tags] nothing to do.');
    return;
  }

  let okDocs = 0; let okChunks = 0; let failed = 0;
  const t0 = performance.now();
  for (const [docId, d] of byDoc) {
    const taxonomy = CHUNK_TAG_TAXONOMY[d.docType as keyof typeof CHUNK_TAG_TAXONOMY] ?? [];
    try {
      // tagChunks never throws; a tagger failure yields nulls for the whole doc
      // and the re-run selector will pick those chunks up again next pass.
      const perChunk = await tagChunks({
        chunks: d.chunks.map((c) => ({ text: c.text })),
        taxonomy,
        tagger,
      });
      let written = 0;
      for (let i = 0; i < d.chunks.length; i++) {
        const tags = perChunk[i] ?? null;
        await writeTags(ctx, d.chunks[i]!.cid, tags);
        if (tags && tags.length > 0) written++;
      }
      okDocs++;
      okChunks += written;
      console.log(`[backfill:tags] ok ${docId}: ${written}/${d.chunks.length} chunks tagged`);
    } catch (e) {
      failed++;
      console.error(`[backfill:tags] FAILED ${docId}:`, (e as Error).message);
    }
    await new Promise((r) => setTimeout(r, DOC_PAUSE_MS));
  }
  console.log(
    `[backfill:tags] DONE in ${Math.round(performance.now() - t0)}ms: `
    + `docs=${okDocs} chunksTagged=${okChunks} failed=${failed}`,
  );
}

main().catch((e) => {
  console.error('[backfill:tags] fatal:', e);
  process.exit(1);
});
