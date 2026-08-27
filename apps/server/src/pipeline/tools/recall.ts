import { tool } from 'ai';
import { z } from 'zod';
import type { DbContext } from '../db/client.js';
import {
  searchChunks,
  getChunkMetaByRowids,
  listBindingsForContract,
  findContractLedgerByNo,
  type ChunkMeta,
  type ChunkMatch,
} from '../db/repositories.js';
import { vectorKnn, isVecReady, type VecKnnHit } from '../db/vecStore.js';
import { tagExternal } from '../../harness/injectionDefense.js';
import type { Embedder } from '../embedder.js';
import type { Reranker } from '../reranker.js';
import { filterChunksByTag, type TagFilterMode } from '../chunkTagFilter.js';
import { normalizeContractNo } from '../contractLedger.js';

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
  /** Optional precision stage over vector/hybrid candidates (SiliconFlow
   *  bge-reranker). Applied to the pre-truncation candidate list; any failure
   *  degrades silently to the fusion order. Absent -> no rerank (tests/CI). */
  reranker?: Reranker | null;
  /** Phase 2 business-data isolation: only recall chunks owned by this user.
   *  Empty/undefined = unscoped (legacy/tests; no filtering). */
  userId?: string;
}

/** RRF constant (standard 60 from the original TREC paper). */
const RRF_K = 60;
/** Max snippet length for vector-only hits (no FTS highlight available). */
const VECTOR_SNIPPET_MAX = 400;

/**
 * 合同号过滤无命中时的如实说明: 区分"该合同号根本没有绑定文档"与"有绑定但本次
 * 检索未命中其内容片段"两种情形, 避免把检索失败误报成"未找到绑定"。
 */
function contractNoMissNote(docIdSet: Set<string>): string {
  return docIdSet.size === 0
    ? '未找到与该合同号绑定的文档'
    : `该合同号绑定了 ${docIdSet.size} 个文档，但本次检索未命中其中的相关内容片段`;
}

interface FusedMatch {
  chunkRowId: number;
  documentId: string;
  chunkIndex: number | null;
  snippet: string;
  bm25: number | null;
  vectorDistance: number | null;
  rrf: number;
  /** doc_chunk.tags attached at fusion so the hybrid list can be tag-filtered. */
  tags: string[] | null;
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
        tags: m?.tags ?? null,
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

/**
 * Narrow FTS hits (ChunkMatch carries no tags) by chunk tags. Loads doc_chunk
 * tags in one batched call and applies filterChunksByTag. Only used on the
 * fts-feeding return paths; the vector/hybrid paths already hold meta in scope.
 */
async function attachTagsAndFilter(
  ctx: DbContext,
  userId: string | undefined,
  hits: ChunkMatch[],
  wantTags: string[],
  tagMode: TagFilterMode,
): Promise<(ChunkMatch & { tags: string[] | null })[]> {
  const meta = await getChunkMetaByRowids(
    ctx,
    hits.map((h) => h.chunkRowId),
    userId,
  );
  const tagged = hits.map((h) => ({ ...h, tags: meta.get(h.chunkRowId)?.tags ?? null }));
  return filterChunksByTag(tagged, wantTags, tagMode);
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

/**
 * Precision stage over the candidate list BEFORE truncation to `limit`.
 * Reorders `candidates` by the reranker's relevance scores (descending).
 * Fault-tolerant by design: any reranker failure logs once and returns the
 * input order unchanged -- recall output shape never depends on rerank
 * availability. Returns [reorderedCandidates, applied] so the response can
 * honestly report whether rerank ran.
 */
async function applyRerank<T>(
  reranker: Reranker | null | undefined,
  query: string,
  candidates: T[],
  textOf: (c: T) => string,
): Promise<[T[], boolean]> {
  if (!reranker || candidates.length === 0) return [candidates, false];
  try {
    const t0 = performance.now();
    const results = await reranker.rerank(
      query,
      candidates.map((c) => textOf(c)),
    );
    console.log(`[perf-recall] rerank ${Math.round(performance.now() - t0)}ms n=${candidates.length}`);
    const ordered: T[] = [];
    const seen = new Set<number>();
    for (const r of results) {
      const c = candidates[r.index];
      if (c !== undefined && !seen.has(r.index)) {
        seen.add(r.index);
        ordered.push(c);
      }
    }
    // Safety net: append any candidate the response skipped, preserving order.
    for (let i = 0; i < candidates.length; i++) {
      if (!seen.has(i)) ordered.push(candidates[i]!);
    }
    return [ordered, true];
  } catch (e) {
    console.warn('[recall_documents] rerank failed; keeping fusion order:', (e as Error).message);
    return [candidates, false];
  }
}

export function buildRecallDocumentsTool(deps: RecallToolDeps) {
  return tool({
    description:
      '召回已录入单据的文本片段(L4 检索层), 用于任何"找单据原文/查文档内容"类问题。' +
      'strategy 何时选哪个: 用户给出精确词(合同号/单据号/物料编码/专有名词)选 fts; ' +
      '用户换说法或语义描述(如"关于烧碱采购的那批文件")选 vector; 不确定时用默认 hybrid。' +
      '(fts=FTS5 BM25 关键词, 多词空格分隔按 AND; vector=sqlite-vec 余弦 KNN 语义; hybrid=两者 RRF 融合。) ' +
      'vector/hybrid 候选会在配置了 rerank 服务时用 bge-reranker 精排重排序(响应含 reranked:true)。' +
      '返回片段 + document_id + score + source。未命中时 fts 返回空(不编造); ' +
      'vector/hybrid 在 sqlite-vec 不可用时自动降级为 fts。' +
      'contractNo 可按合同号过滤, 只返回绑定到该合同的文档片段。' +
      'wantTags 标签过滤无命中时已自动放宽(响应带 tagFilterFallback=true, 如实说明即可)。' +
      '调用示例: 1) 按单据号精确找原文 {query: "BL-2024-0920-002", strategy: "fts"}; ' +
      '2) 语义召回并按合同过滤 {query: "烧碱采购付款条款", strategy: "hybrid", contractNo: "HT-2024-001", limit: 5}。',
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
      wantTags: z
        .array(z.string())
        .optional()
        .describe(
          '可选: 按 chunk 标签过滤召回片段 (与 doc_chunk.tags 取交集, 标签来自入库时按文档类型打的语义标签)。配合 tagMode 使用。无命中时自动放宽(不返回空)',
        ),
      tagMode: z
        .enum(['any', 'all'])
        .default('any')
        .describe('wantTags 匹配模式: any=命中任一标签即保留(默认); all=须命中全部标签'),
      contractNo: z
        .string()
        .optional()
        .describe('可选: 按合同号过滤, 只返回绑定到该合同的文档片段'),
    }),
    execute: async ({ query, limit, strategy, wantTags, tagMode, contractNo }) => {
      const effective = await resolveStrategy(strategy, deps.ctx);

      // contractNo 过滤(接线闭环): 归一化后先从合同台账取绑定文档, 再对 bindings
      // 表按原文(归一化值 + 原始值)各查一遍取并集, 得到该合同号对应的 docId 集合。
      const normalizedContractNo =
        contractNo && contractNo.trim().length > 0 ? normalizeContractNo(contractNo) : undefined;
      let docIdSet: Set<string> | undefined;
      if (normalizedContractNo && contractNo) {
        docIdSet = new Set<string>();
        const ledgerEntry = await findContractLedgerByNo(deps.ctx, normalizedContractNo, deps.userId);
        if (ledgerEntry) docIdSet.add(ledgerEntry.documentId);
        for (const raw of new Set([contractNo, normalizedContractNo])) {
          const binds = await listBindingsForContract(deps.ctx, raw);
          for (const b of binds) docIdSet.add(b.documentId);
        }
      }
      // 响应回显归一化后的合同号(仅当传入时); tagFilterFallback 标记标签过滤已放宽。
      const contractNoField = normalizedContractNo ? { contractNo: normalizedContractNo } : {};

      // Tag filter (chunk-level): when wantTags is set, over-fetch candidates so a
      // selective tag filter still leaves enough survivors to fill `limit`, then
      // narrow by doc_chunk.tags via filterChunksByTag before truncating. No-op
      // (candidateLimit === limit) when wantTags is empty/absent.
      const filtering = Array.isArray(wantTags) && wantTags.length > 0;
      const candidateLimit = filtering ? Math.min(Math.max(limit * 4, 20), 200) : limit;

      // FTS path (always cheap; also feeds hybrid).
      const ftsHits = await searchChunks(deps.ctx, query, candidateLimit, deps.userId);

      if (effective === 'fts') {
        // 先按合同号收窄候选, 再做标签过滤; 都在截断到 limit 之前。
        const inScope = docIdSet ? ftsHits.filter((h) => docIdSet.has(h.documentId)) : ftsHits;
        if (docIdSet && inScope.length === 0) {
          return {
            query,
            strategy: 'fts' as const,
            matchCount: 0,
            matches: [],
            ...contractNoField,
            note: contractNoMissNote(docIdSet),
          };
        }
        const kept = filtering
          ? await attachTagsAndFilter(deps.ctx, deps.userId, inScope, wantTags!, tagMode)
          : inScope;
        let candidates = kept;
        let tagFilterFallback = false;
        if (filtering && kept.length === 0 && inScope.length > 0) {
          // 标签过滤无命中但候选非空 -> 自动放宽(用未过滤候选填充)。
          candidates = inScope;
          tagFilterFallback = true;
        }
        const matches = candidates.slice(0, limit);
        return {
          query,
          strategy: 'fts' as const,
          matchCount: matches.length,
          matches: matches.map((h) => ({
            document_id: h.documentId,
            chunk_index: h.chunkIndex,
            snippet: tagExternal(h.snippet),
            score: -h.bm25Score, // unify higher=better
            source: 'fts' as const,
            bm25_score: h.bm25Score,
            vector_distance: null,
          })),
          ...contractNoField,
          ...(tagFilterFallback ? { tagFilterFallback: true as const } : {}),
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
        const knn = await vectorKnn(deps.ctx, queryVec ?? [], candidateLimit);

        if (effective === 'vector') {
          const meta = await getChunkMetaByRowids(
            deps.ctx,
            knn.map((k) => k.chunkRowId),
            deps.userId,
          );
          const knnTagged = knn.map((k) => ({
            ...k,
            tags: meta.get(k.chunkRowId)?.tags ?? null,
          }));
          // 合同号过滤: documentId 来自 meta, 在截断前按集合成员过滤。
          const inScope = docIdSet
            ? knnTagged.filter((k) => docIdSet.has(meta.get(k.chunkRowId)?.documentId ?? ''))
            : knnTagged;
          if (docIdSet && inScope.length === 0) {
            return {
              query,
              strategy: 'vector' as const,
              matchCount: 0,
              matches: [],
              ...contractNoField,
              note: contractNoMissNote(docIdSet),
            };
          }
          const kept = filtering ? filterChunksByTag(inScope, wantTags!, tagMode) : inScope;
          let candidates = kept;
          let tagFilterFallback = false;
          if (filtering && kept.length === 0 && inScope.length > 0) {
            candidates = inScope;
            tagFilterFallback = true;
          }
          const [reranked, rerankedApplied] = await applyRerank(
            deps.reranker,
            query,
            candidates,
            (k) => meta.get(k.chunkRowId)?.text ?? '',
          );
          const matches = reranked.slice(0, limit);
          return {
            query,
            strategy: 'vector' as const,
            matchCount: matches.length,
            matches: matches.map((k) => {
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
            ...(rerankedApplied ? { reranked: true as const } : {}),
            ...contractNoField,
            ...(tagFilterFallback ? { tagFilterFallback: true as const } : {}),
          };
        }

        // hybrid: RRF over fts + vector. When filtering, meta must cover FTS-only
        // rowids too -- a chunk FTS found but KNN missed still has tags to filter on.
        const metaRowids = filtering
          ? Array.from(
              new Set([...ftsHits.map((h) => h.chunkRowId), ...knn.map((k) => k.chunkRowId)]),
            )
          : knn.map((k) => k.chunkRowId);
        const meta = await getChunkMetaByRowids(deps.ctx, metaRowids, deps.userId);
        const fusedAll = reciprocalRankFusion(ftsHits, knn, meta, candidateLimit);
        // 合同号过滤 + 标签过滤, 都在截断到 limit 之前。
        const inScope = docIdSet ? fusedAll.filter((f) => docIdSet.has(f.documentId)) : fusedAll;
        if (docIdSet && inScope.length === 0) {
          return {
            query,
            strategy: 'hybrid' as const,
            matchCount: 0,
            matches: [],
            ...contractNoField,
            note: contractNoMissNote(docIdSet),
          };
        }
        const fused = filtering ? filterChunksByTag(inScope, wantTags!, tagMode) : inScope;
        let candidates = fused;
        let tagFilterFallback = false;
        if (filtering && fused.length === 0 && inScope.length > 0) {
          candidates = inScope;
          tagFilterFallback = true;
        }
        const [reranked, rerankedApplied] = await applyRerank(
          deps.reranker,
          query,
          candidates,
          (f) => f.snippet,
        );
        const matches = reranked.slice(0, limit);
        return {
          query,
          strategy: 'hybrid' as const,
          matchCount: matches.length,
          matches: matches.map((f) => ({
            document_id: f.documentId,
            chunk_index: f.chunkIndex,
            snippet: tagExternal(f.snippet),
            score: f.rrf,
            source: 'hybrid' as const,
            bm25_score: f.bm25,
            vector_distance: f.vectorDistance,
          })),
          ...(rerankedApplied ? { reranked: true as const } : {}),
          ...contractNoField,
          ...(tagFilterFallback ? { tagFilterFallback: true as const } : {}),
        };
      }

      // Fallback (no embedder, or vec unavailable): emit fts results. Report
      // strategy as 'fts' since that is what actually produced these matches.
      const inScope = docIdSet ? ftsHits.filter((h) => docIdSet.has(h.documentId)) : ftsHits;
      if (docIdSet && inScope.length === 0) {
        return {
          query,
          strategy: 'fts' as const,
          matchCount: 0,
          matches: [],
          ...contractNoField,
          note: contractNoMissNote(docIdSet),
        };
      }
      const kept = filtering
        ? await attachTagsAndFilter(deps.ctx, deps.userId, inScope, wantTags!, tagMode)
        : inScope;
      let candidates = kept;
      let tagFilterFallback = false;
      if (filtering && kept.length === 0 && inScope.length > 0) {
        candidates = inScope;
        tagFilterFallback = true;
      }
      const matches = candidates.slice(0, limit);
      return {
        query,
        strategy: 'fts' as const,
        matchCount: matches.length,
        matches: matches.map((h) => ({
          document_id: h.documentId,
          chunk_index: h.chunkIndex,
          snippet: tagExternal(h.snippet),
          score: -h.bm25Score,
          source: 'fts' as const,
          bm25_score: h.bm25Score,
          vector_distance: null,
        })),
        ...contractNoField,
        ...(tagFilterFallback ? { tagFilterFallback: true as const } : {}),
      };
    },
  });
}
