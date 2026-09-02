// Lane B: per-chunk semantic tagging over a fixed taxonomy.
//
// Pure orchestration (`tagChunks`) + a concrete LLM-backed tagger
// (`makeLlmTagger`). The split lets callers inject a deterministic tagger in
// tests and the real one in production. The taxonomy is a CLOSED set: the LLM
// is constrained to it and `tagChunks` filters any stray label so an attacker
// (or a hallucinating model) cannot inject arbitrary tags downstream.
//
// Fault isolation: `tagChunks` NEVER throws -- a tagger failure degrades to
// "no tags for any chunk" (nulls) so the rest of the ingest pipeline keeps
// running. Tags are a retrieval hint, not a correctness boundary.

import { generateObject, type LanguageModel } from 'ai';
import { z } from 'zod';
import { recordLlmCall } from '../harness/usageAudit.js';

/**
 * Assigns 0..N taxonomy tags to each indexed chunk. Implementations must be
 * total over their input (catch their own errors) when used via `tagChunks`,
 * but the contract here is just "return a map chunkIndex -> tags".
 */
export type ChunkTagger = (
  chunks: Array<{ index: number; text: string }>,
  taxonomy: string[],
) => Promise<Record<number, string[]>>;

export interface TagChunksArgs {
  chunks: Array<{ text: string }>;
  taxonomy: string[];
  tagger: ChunkTagger;
}

/**
 * Tag a chunk list against a closed taxonomy.
 *
 * - Empty taxonomy (e.g. `其他`) -> returns all `null` WITHOUT calling the
 *   tagger (skip LLM entirely).
 * - Otherwise calls the tagger once with all chunks (batched) and maps the
 *   result back to a per-chunk array aligned with the input order. Every
 *   returned tag is filtered against `taxonomy`; non-members are dropped.
 *   Chunks with no entry (or whose tags all filtered out) -> `null`.
 * - On ANY error from the tagger, returns all `null` (never throws).
 */
export async function tagChunks(args: TagChunksArgs): Promise<(string[] | null)[]> {
  const { chunks, taxonomy, tagger } = args;

  // Empty taxonomy (e.g. 其他) -> skip the LLM entirely.
  // Empty chunk list -> no work to do either; avoid a pointless tagger call.
  if (!taxonomy || taxonomy.length === 0 || chunks.length === 0) {
    return chunks.map(() => null);
  }

  const allowed = new Set(taxonomy);
  const indexed = chunks.map((c, i) => ({ index: i, text: c.text }));

  let raw: Record<number, string[]>;
  try {
    raw = await tagger(indexed, taxonomy);
  } catch {
    return chunks.map(() => null);
  }

  return chunks.map((_, i) => {
    const tags = raw[i];
    if (!tags || !Array.isArray(tags) || tags.length === 0) return null;
    const filtered = tags.filter((t) => typeof t === 'string' && allowed.has(t));
    // De-dupe while preserving order so downstream recall sees stable input.
    const seen = new Set<string>();
    const deduped: string[] = [];
    for (const t of filtered) {
      if (!seen.has(t)) {
        seen.add(t);
        deduped.push(t);
      }
    }
    return deduped.length > 0 ? deduped : null;
  });
}

// --- Concrete LLM tagger ----------------------------------------------------

const TagAssignmentSchema = z.object({
  chunkIndex: z.number(),
  tags: z.array(z.string()),
});

const TagAssignmentResultSchema = z.object({
  assignments: z.array(TagAssignmentSchema),
});

const CHUNK_TAGGER_SYSTEM_PROMPT = [
  '给定若干文本块和一套固定标签体系，为每个文本块从体系内选出 0~N 个最贴切的标签。',
  '只能使用提供的标签，禁止自造。无贴切标签则返回空数组。',
  // DeepSeek's JSON-mode response_format requires the prompt to contain "json".
  '严格以 JSON 格式输出，不要包含任何注释或解释文字。',
  '输出结构: {"assignments": [{"chunkIndex": 0, "tags": ["标签A"]}, ...]}',
].join('\n');

/**
 * Build a production chunk tagger backed by an AI SDK 6 LanguageModel.
 *
 * Mirrors extraction.ts: uses `generateObject` with a zod schema (the v6
 * `schema` option), and forces JSON mode via `providerOptions.openai.structuredOutputs`
 * because DeepSeek rejects `response_format=json_schema`.
 */
export function makeLlmTagger(model: LanguageModel): ChunkTagger {
  return async (chunks, taxonomy) => {
    const taxonomyLine = `标签体系 (只能从中选择): ${taxonomy.join('、')}`;
    const chunksLine = `文本块:\n${JSON.stringify(
      chunks.map((c) => ({ index: c.index, text: c.text })),
    )}`;
    const prompt = `${taxonomyLine}\n\n${chunksLine}`;
    // Usage audit (2026-09-02): record every chunk-tagging LLM call so DeepSeek
    // spend is attributable. Fire-and-forget (never throws). No docId is
    // threaded through the tagger seam (would require signature reshuffling).
    const modelId = (model as { modelId?: string }).modelId ?? '';
    const t0 = performance.now();
    try {
      const res = await generateObject({
        model,
        schema: TagAssignmentResultSchema,
        system: CHUNK_TAGGER_SYSTEM_PROMPT,
        prompt,
        providerOptions: { openai: { structuredOutputs: false } },
      });
      recordLlmCall({
        kind: 'chunk_tagging',
        model: modelId,
        inputTokens: res.usage?.inputTokens ?? null,
        outputTokens: res.usage?.outputTokens ?? null,
        totalTokens: res.usage?.totalTokens ?? null,
        inputText: prompt,
        outputText: JSON.stringify(res.object),
        durationMs: Math.round(performance.now() - t0),
        finishReason: res.finishReason ?? undefined,
        status: 'ok',
      });
      const out: Record<number, string[]> = {};
      for (const a of res.object.assignments ?? []) {
        out[a.chunkIndex] = Array.isArray(a.tags) ? a.tags.slice() : [];
      }
      return out;
    } catch (e) {
      recordLlmCall({
        kind: 'chunk_tagging',
        model: modelId,
        inputText: prompt,
        durationMs: Math.round(performance.now() - t0),
        status: 'error',
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  };
}
