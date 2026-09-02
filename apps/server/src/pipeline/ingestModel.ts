// Shared ingest deps (Model B).
//
// One place that assembles the model-backed deps every parse path needs:
// auto-extraction (Lane A), routing-classify (Phase 2), chunk tagging (Lane B)
// and the vector embedder. Upload (POST /api/files) is storage-only, so it no
// longer touches these; on-demand parsing (POST /api/documents/:docId/process)
// and the chat backstop both build the same deps here, reusing ONE lazy model
// handle (resolveAuxModel: PIPELINE_LLM_* qwen group, else OPENAI_* DeepSeek)
// so all callers run the exact same model. The same resolver also feeds the
// session-title / history-compaction model in harness/titleGen.ts.

import { createDeepSeek } from '@ai-sdk/deepseek';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import { env } from '../env.js';
import { makeLlmTagger, type ChunkTagger } from './chunkTagging.js';
import {
  DeterministicEmbedder,
  OllamaEmbedder,
  OpenAICompatEmbedder,
  type Embedder,
} from './embedder.js';
import type { ExtractionDeps } from './extraction.js';
import type { ClassifierDeps } from './classifier.js';

/**
 * Shared "auxiliary LLM" resolver: the PIPELINE_LLM_* group (Bailian qwen) when
 * configured, else the main OPENAI_* (DeepSeek) config. Used by BOTH the ingest
 * pipeline (getIngestModel) and the session-title / history-compaction model
 * (getTitleModel in harness/titleGen.ts) so the cheap qwen group is reused
 * everywhere non-chat, and the fallback stays identical to the agent loop.
 *
 * Returns the model plus a human label for boot logging.
 */
export function resolveAuxModel(): { model: LanguageModel; label: string } {
  if (env.PIPELINE_LLM_API_KEY) {
    const baseURL = env.PIPELINE_LLM_BASE_URL ?? 'https://dashscope.aliyuncs.com/compatible-mode/v1';
    const modelId = env.PIPELINE_LLM_MODEL ?? 'qwen-flash-2025-07-28';
    const provider = createOpenAI({ baseURL, apiKey: env.PIPELINE_LLM_API_KEY });
    // structuredOutputs stays DISABLED (schema-in-prompt + response_format
    // json_object) for maximal endpoint compatibility. It is a per-call
    // provider option in AI SDK 6, applied by the consumers (extraction /
    // classifier / chunkTagging) via `openai: { structuredOutputs: false }`
    // — the same JSON-mode path DeepSeek already uses.
    return { model: provider.chat(modelId), label: `${modelId} @ ${new URL(baseURL).host}` };
  }
  // Fallback: the main OPENAI_* (DeepSeek) config, reusing the SAME factory as
  // agent.ts / chat.ts (createDeepSeek(...).chat(env.OPENAI_MODEL)) so the
  // parse path runs the exact same model the agent loop uses.
  return {
    model: createDeepSeek({
      baseURL: env.OPENAI_BASE_URL,
      apiKey: env.OPENAI_API_KEY,
    }).chat(env.OPENAI_MODEL),
    label: `fallback ${env.OPENAI_MODEL}`,
  };
}

/**
 * Lazy singleton pipeline LLM handle. Two branches (see resolveAuxModel):
 *  1. PIPELINE_LLM_API_KEY set -> a dedicated pipeline-side model (default
 *     Bailian qwen-flash-2025-07-28 via the OpenAI-compatible DashScope
 *     endpoint).
 *  2. otherwise -> the main OPENAI_* (DeepSeek) config.
 * Note: `.chat` (Chat Completions), NOT `openai(model)` — DeepSeek's
 * Responses-API compatibility mangles tool-call ids (AI SDK 6 Appendix D).
 */
let ingestModel: LanguageModel | null = null;
export function getIngestModel(): LanguageModel {
  if (!ingestModel) {
    const { model, label } = resolveAuxModel();
    ingestModel = model;
    console.log(`[boot] pipeline llm: ${label}`);
  }
  return ingestModel;
}

/**
 * Env-driven embedder priority chain -- SINGLE SOURCE OF TRUTH (agent.ts,
 * eval and backfill all import this): SiliconFlow hosted bge-m3
 * (SILICONFLOW_API_KEY, GPU-free) -> Ollama local (OLLAMA_BASE_URL) ->
 * deterministic hash embedder (offline, NOT semantically meaningful).
 *
 * Reads process.env at call time (same convention as defaultReranker) so a
 * deployment env change takes effect without a module reload.
 */
export function defaultEmbedder(): Embedder {
  if (process.env.SILICONFLOW_API_KEY) {
    return new OpenAICompatEmbedder({
      apiKey: process.env.SILICONFLOW_API_KEY,
      baseUrl: process.env.SILICONFLOW_BASE_URL,
      model: process.env.SILICONFLOW_EMBED_MODEL,
    });
  }
  if (process.env.OLLAMA_BASE_URL) {
    return new OllamaEmbedder({
      baseUrl: process.env.OLLAMA_BASE_URL,
      model: process.env.OLLAMA_EMBED_MODEL,
    });
  }
  if (process.env.NODE_ENV === 'production') {
    console.warn(
      '[defaultEmbedder] No SILICONFLOW_API_KEY (and no OLLAMA_BASE_URL) configured: '
        + 'falling back to DeterministicEmbedder, whose vectors are hash-based '
        + 'and NOT semantically meaningful.',
    );
  }
  return new DeterministicEmbedder();
}

/** The model-backed dep bundle processDocument / ensureDocumentParsed consume. */
export interface IngestDeps {
  extraction: ExtractionDeps;
  classifier: ClassifierDeps;
  tagger: ChunkTagger;
  embedder: Embedder;
}

/** Assemble the standard ingest deps around the shared lazy DeepSeek model. */
export function buildIngestDeps(): IngestDeps {
  const model = getIngestModel();
  return {
    extraction: { model },
    classifier: { model },
    tagger: makeLlmTagger(model),
    embedder: defaultEmbedder(),
  };
}
