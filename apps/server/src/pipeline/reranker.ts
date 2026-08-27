// Reranker for the L4 recall layer (precision stage over fused candidates).
//
// Backed by an OpenAI/Cohere-compatible /v1/rerank endpoint -- deployment
// target is SiliconFlow's BAAI/bge-reranker-v2-m3 (verified live 2026-08-27:
// CJK query vs 3 candidate docs -> relevance_score 0.94/0.007/0.00002,
// response ordered by score desc with the original document index preserved).
//
// Contract: rerank(query, documents) returns results in DESCENDING relevance
// order, each carrying the input index so callers can reorder their own
// structures. Fault tolerance lives at the CALL SITE (recall.ts): a reranker
// failure degrades to the pre-rerank ordering, never breaks recall.
//
// Enablement: constructed only when SILICONFLOW_API_KEY is set (same key as
// the embedding endpoint); CI/tests stay offline via mock fetch or no key.

export interface RerankResult {
  /** Zero-based index into the caller's documents array. */
  index: number;
  relevanceScore: number;
}

export interface Reranker {
  /** Identity surfaced in logs/metrics (e.g. 'siliconflow-bge-reranker-v2-m3'). */
  readonly kind: string;
  rerank(query: string, documents: string[], topN?: number): Promise<RerankResult[]>;
}

export interface OpenAICompatRerankerOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

/** OpenAI/Cohere-compatible /v1/rerank client (SiliconFlow). */
export class OpenAICompatReranker implements Reranker {
  readonly kind: string;
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(opts: OpenAICompatRerankerOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.SILICONFLOW_API_KEY;
    this.baseUrl = (
      opts.baseUrl ?? process.env.SILICONFLOW_BASE_URL ?? 'https://api.siliconflow.cn'
    ).replace(/\/+$/, '');
    this.model = opts.model ?? process.env.SILICONFLOW_RERANK_MODEL ?? 'BAAI/bge-reranker-v2-m3';
    this.kind = `openai-compat-rerank:${this.model}`;
  }

  async rerank(query: string, documents: string[], topN?: number): Promise<RerankResult[]> {
    if (!this.apiKey) {
      throw new Error(
        'OpenAICompatReranker: SILICONFLOW_API_KEY is not configured (set it to enable rerank).',
      );
    }
    if (documents.length === 0) return [];
    const res = await fetch(`${this.baseUrl}/v1/rerank`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        query,
        documents,
        ...(topN !== undefined ? { top_n: topN } : {}),
      }),
    });
    if (!res.ok) {
      throw new Error(
        `OpenAICompatReranker: /v1/rerank failed (${res.status} ${res.statusText}) `
        + `for model ${this.model}`,
      );
    }
    const data = (await res.json()) as {
      results?: Array<{ index?: number; relevance_score?: number }>;
    };
    const rows = data.results ?? [];
    if (rows.length === 0) return [];
    return rows.map((r) => ({
      index: r.index ?? 0,
      relevanceScore: r.relevance_score ?? 0,
    }));
  }
}

/**
 * Env-driven factory shared by ingest/recall wiring. Returns null when no API
 * key is configured, so callers can treat rerank as absent instead of
 * threading a disabled client around.
 */
export function defaultReranker(): Reranker | null {
  if (!process.env.SILICONFLOW_API_KEY) return null;
  return new OpenAICompatReranker();
}
