import { tool } from 'ai';
import { z } from 'zod';
import type { DbContext } from '../db/client.js';
import {
  searchChunks,
  getChunkMetaByRowids,
  type ChunkMeta,
  type ChunkMatch,
} from '../db/repositories.js';
import { vectorKnn, isVecReady, type VecKnnHit } from '../db/vecStore.js';
import { tagExternal } from '../../harness/injectionDefense.js';
import type { Embedder } from '../embedder.js';

// L4 document recall (Task 6 v2). Three strategies over the same chunk index:
//   fts    -- FTS5 BM25 keyword recall (Task 6 v1), exact "no match -> []".
//   vector -- sqlite-vec cosine KNN over chunk embeddings; KNN always returns
//             the k nearest regardless of relevance, so callers wanting a strict
//             "no match" semantic should use fts or hybrid.
//   hybrid -- reciprocal rank fusion (RRF, k=60) of the two: de-dups by chunk
//             rowid and merges ranks, so a chunk FTS5 missed but vector caught
//             (or vice versa) still surfaces.
//
// GRACEFUL DEGRADATION: if sqlite-vec is not loaded on the connection (air-
// gapped host, missing platform binary, npm package absent), vector/hybrid
// silently fall back to fts with a warning -- the agent never crashes on a
// missing extension; it just loses semantic recall.
//
// The returned snippets are EXTERNAL document content (untrusted text read off
// disk), so each is wrapped with tagExternal() -> <external_content> so the
// model treats them as DATA (injection defense). The contract entry
// (output:'tagged') is the metadata mirror of that intent.

export type RecallStrategy = 'fts' | 'vector' | 'hybrid';

export interface RecallToolDeps {
  ctx: DbContext;
  /** Embedder for vector/hybrid strategies. Defaults to a deterministic test
   *  embedder when unset (no Ollama needed); see roleToolRegistry/agent wiring. */
  embedder?: Embedder;
  /** Phase 2 business-data isolation: only recall chunks owned by this user.
   *  Empty/undefined = unscoped (legacy/tests; no filtering). */
  userId?: string;
}

/** RRF constant (standard 60 from the original TREC paper). */
const RRF_K = 60;
/** Max snippet length for vector-only hits (no FTS highlight available). */
const VECTOR_SNIPPET_MAX = 200;

interface FusedMatch {
  chunkRowId: number;
  documentId: string;
  chunkIndex: number | null;
  snippet: string;
  bm25: number | null;
  vectorDistance: number | null;
  rrf: number;
}

function snippetFromText(text: string): string {
  const t = text.length > VECTOR_SNIPPET_MAX ? `${text.slice(0, VECTOR_SNIPPET_MAX)}...` : text;
  return t;
}

/**
 * Reciprocal Rank Fusion of FTS5 BM25 hits and vector KNN hits. Each list
 * contributes 1/(RRF_K + rank) per chunk (rank is 1-based); scores sum across
 * lists and de-dupe by chunk rowid. The FTS-highlighted snippet is preferred
 * when available; vector-only hits get a plain substring snippet. Returns the
 * fused matches sorted by RRF score descending, truncated to `limit`.
 */
function reciprocalRankFusion(
  ftsHits: ChunkMatch[],
  vecHits: VecKnnHit[],
  meta: Map<number, ChunkMeta>,
  limit: number,
): FusedMatch[] {
  const acc = new Map<number, FusedMatch>();

  const ensure = (rowid: number, fromMeta?: ChunkMeta): FusedMatch => {
    let e = acc.get(rowid);
    if (!e) {
      const m = fromMeta ?? meta.get(rowid);
      e = {
        chunkRowId: rowid,
        documentId: m?.documentId ?? '',
        chunkIndex: m?.chunkIndex ?? null,
        snippet: m ? snippetFromText(m.text) : '',
        bm25: null,
        vectorDistance: null,
        rrf: 0,
      };
      acc.set(rowid, e);
    }
    return e;
  };

  ftsHits.forEach((h, i) => {
    const e = ensure(h.chunkRowId);
    e.rrf += 1 / (RRF_K + (i + 1));
    e.bm25 = h.bm25Score;
    // Prefer the FTS-highlighted snippet (it marks the match).
    e.snippet = h.snippet;
    e.documentId = h.documentId;
    e.chunkIndex = h.chunkIndex;
  });

  vecHits.forEach((h, i) => {
    const e = ensure(h.chunkRowId);
    e.rrf += 1 / (RRF_K + (i + 1));
    e.vectorDistance = h.distance;
  });

  return [...acc.values()].sort((a, b) => b.rrf - a.rrf).slice(0, limit);
}

/** Downgrade vector/hybrid to fts when the vector backend is unavailable (sqlite). */
async function resolveStrategy(
  strategy: RecallStrategy,
  ctx: DbContext,
): Promise<RecallStrategy> {
  if (strategy === 'fts') return 'fts';
  if (await isVecReady(ctx)) return strategy;
  console.warn(
    `[recall_documents] vector backend unavailable; strategy '${strategy}' falling back to 'fts'`,
  );
  return 'fts';
}

export function buildRecallDocumentsTool(deps: RecallToolDeps) {
  return tool({
    description:
      '召回已录入单据的文本片段(L4 检索层)。strategy: fts=FTS5 BM25 关键词; vector=sqlite-vec 余弦 KNN 语义; hybrid=两者 RRF 融合(默认)。返回片段 + document_id + score + source。未命中时 fts 返回空(不编造); vector/hybrid 在 sqlite-vec 不可用时自动降级为 fts。',
    inputSchema: z.object({
      query: z
        .string()
        .min(1)
        .describe('检索词; fts 时空格分隔多词按 AND, vector/hybrid 时为整段文本嵌入'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(5)
        .describe('返回片段上限, 默认 5'),
      strategy: z
        .enum(['fts', 'vector', 'hybrid'])
        .default('hybrid')
        .describe('检索策略, 默认 hybrid'),
    }),
    execute: async ({ query, limit, strategy }) => {
      const effective = await resolveStrategy(strategy, deps.ctx);

      // FTS path (always cheap; also feeds hybrid).
      const ftsHits = await searchChunks(deps.ctx, query, limit, deps.userId);

      if (effective === 'fts') {
        return {
          query,
          strategy: 'fts' as const,
          matchCount: ftsHits.length,
          matches: ftsHits.map((h) => ({
            document_id: h.documentId,
            chunk_index: h.chunkIndex,
            snippet: tagExternal(h.snippet),
            score: -h.bm25Score, // unify higher=better
            source: 'fts' as const,
            bm25_score: h.bm25Score,
            vector_distance: null,
          })),
        };
      }

      // Vector path (needs an embedder). If none is wired, degrade to fts so the
      // reported strategy/source stay honest rather than half-populated. (By here
      // `effective` is 'vector' | 'hybrid' -- the 'fts' case returned above.)
      const embedder = deps.embedder;
      if (!embedder) {
        console.warn('[recall_documents] no embedder wired; falling back to fts');
      }
      if (embedder) {
        const [queryVec] = await embedder.embed([query]);
        const knn = await vectorKnn(deps.ctx, queryVec ?? [], limit);

        if (effective === 'vector') {
          const meta = await getChunkMetaByRowids(
            deps.ctx,
            knn.map((k) => k.chunkRowId),
            deps.userId,
          );
          return {
            query,
            strategy: 'vector' as const,
            matchCount: knn.length,
            matches: knn.map((k) => {
              const m = meta.get(k.chunkRowId);
              return {
                document_id: m?.documentId ?? '',
                chunk_index: m?.chunkIndex ?? null,
                snippet: tagExternal(m ? snippetFromText(m.text) : ''),
                score: -k.distance, // unify higher=better (closer = higher)
                source: 'vector' as const,
                bm25_score: null,
                vector_distance: k.distance,
              };
            }),
          };
        }

        // hybrid: RRF over fts + vector.
        const meta = await getChunkMetaByRowids(
          deps.ctx,
          knn.map((k) => k.chunkRowId),
          deps.userId,
        );
        const fused = reciprocalRankFusion(ftsHits, knn, meta, limit);
        return {
          query,
          strategy: 'hybrid' as const,
          matchCount: fused.length,
          matches: fused.map((f) => ({
            document_id: f.documentId,
            chunk_index: f.chunkIndex,
            snippet: tagExternal(f.snippet),
            score: f.rrf,
            source: 'hybrid' as const,
            bm25_score: f.bm25,
            vector_distance: f.vectorDistance,
          })),
        };
      }

      // Fallback (no embedder, or vec unavailable): emit fts results. Report
      // strategy as 'fts' since that is what actually produced these matches.
      return {
        query,
        strategy: 'fts' as const,
        matchCount: ftsHits.length,
        matches: ftsHits.map((h) => ({
          document_id: h.documentId,
          chunk_index: h.chunkIndex,
          snippet: tagExternal(h.snippet),
          score: -h.bm25Score,
          source: 'fts' as const,
          bm25_score: h.bm25Score,
          vector_distance: null,
        })),
      };
    },
  });
}
