// Shared ingest deps (Model B).
//
// One place that assembles the model-backed deps every parse path needs:
// auto-extraction (Lane A), routing-classify (Phase 2), chunk tagging (Lane B)
// and the vector embedder. Upload (POST /api/files) is storage-only, so it no
// longer touches these; on-demand parsing (POST /api/documents/:docId/process)
// and the chat backstop both build the same deps here, reusing ONE lazy
// DeepSeek model handle so all three callers run the exact same model.

import { createDeepSeek } from '@ai-sdk/deepseek';
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
 * Lazy singleton DeepSeek handle. Reuses the SAME factory as agent.ts /
 * chat.ts (createDeepSeek(...).chat(env.OPENAI_MODEL)) so the parse path runs
 * the exact same model the agent loop uses. Note: `.chat` (Chat Completions),
 * NOT `openai(model)` — DeepSeek's Responses-API compatibility mangles
 * tool-call ids (AI SDK 6 Appendix D).
 */
let ingestModel: LanguageModel | null = null;
export function getIngestModel(): LanguageModel {
  if (!ingestModel) {
    ingestModel = createDeepSeek({
      baseURL: env.OPENAI_BASE_URL,
      apiKey: env.OPENAI_API_KEY,
    }).chat(env.OPENAI_MODEL);
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
