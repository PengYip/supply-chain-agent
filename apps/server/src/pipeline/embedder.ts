// Pluggable text embedder for the L4 vector recall layer (Task 6 v2).
//
// The real embeddings (bge-m3 via Ollama) are a DEPLOYMENT concern: they require
// an Ollama model pull and network access. To keep implementation + tests fully
// offline, the embedder is an interface with a DETERMINISTIC default impl that
// needs no model and is reproducible. DeterministicEmbedder is TEST-ONLY quality
// (hash -> bag-of-tokens unit vector); it is NOT production-grade and must not
// be treated as semantically meaningful. At deployment, inject OllamaEmbedder
// (set OLLAMA_BASE_URL) and the same code path serves real bge-m3 vectors.
//
// Dimension is fixed at 1024 to match bge-m3 and the doc_chunk_vec vec0 table.

export interface Embedder {
  /** Embedding dimensionality (must match the vec0 table: 1024). */
  readonly dim: number;
  /** Embed a batch of texts; returns one vector per input, in order. */
  embed(texts: string[]): Promise<number[][]>;
}

export const EMBED_DIM = 1024;

// ---- DeterministicEmbedder (test/dev only) ----------------------------------

/** FNV-1a 32-bit string hash (stable across runs/platforms). */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Tokenize for the deterministic embedder. ASCII alnum runs become tokens; each
 * CJK char is its own token (mirrors FTS5 unicode61 behaviour so a CJK phrase
 * shares char tokens with a matching document). Lowercased.
 */
function tokenizeForEmbed(text: string): string[] {
  const lower = text.toLowerCase();
  const out: string[] = [];
  const ascii = lower.match(/[a-z0-9]+/g);
  if (ascii) out.push(...ascii);
  const cjk = lower.match(/[\u4e00-\u9fff]/g);
  if (cjk) out.push(...cjk);
  return out;
}

/**
 * Deterministic hash -> 1024-dim L2-normalized unit vector. Bag-of-tokens: each
 * token's FNV hash selects a dimension index and a sign, values accumulate,
 * then the vector is L2-normalized so cosine distance is meaningful.
 *
 * NOT production quality (no semantics, collisions galore). Two texts sharing
 * tokens overlap in the same dims -> non-trivial cosine similarity, which is
 * enough to exercise the vector KNN + RRF hybrid path in tests deterministically.
 */
export class DeterministicEmbedder implements Embedder {
  readonly dim: number = EMBED_DIM;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.embedOne(t));
  }

  embedOne(text: string): number[] {
    const vec = new Float32Array(this.dim);
    const tokens = tokenizeForEmbed(text);
    if (tokens.length === 0) {
      // Degenerate input: still deterministic (hash whole string into one dim).
      const h = fnv1a(text.toLowerCase());
      vec[h % this.dim] = 1;
    } else {
      for (const tok of tokens) {
        const h = fnv1a(tok);
        const idx = h % this.dim;
        const sign = ((h >>> 16) & 1) === 1 ? -1 : 1;
        vec[idx] = (vec[idx] ?? 0) + sign;
      }
    }
    // L2 normalize to a unit vector (cosine distance is then meaningful).
    let sum = 0;
    for (let i = 0; i < this.dim; i++) {
      const v = vec[i] ?? 0;
      sum += v * v;
    }
    const norm = Math.sqrt(sum) || 1;
    const out = new Array<number>(this.dim);
    for (let i = 0; i < this.dim; i++) out[i] = (vec[i] ?? 0) / norm;
    return out;
  }
}

// ---- OllamaEmbedder (deployment: real bge-m3) -------------------------------

export interface OllamaEmbedderOptions {
  baseUrl?: string;
  model?: string;
}

/**
 * Production embedder backed by an Ollama /api/embed endpoint (bge-m3 by
 * default). Throws a CLEAR configuration error if no base URL is configured, so
 * a misconfigured deployment fails loudly rather than silently producing junk.
 * Never invoked in the test path (tests inject DeterministicEmbedder instead).
 */
export class OllamaEmbedder implements Embedder {
  readonly dim: number = EMBED_DIM;
  private readonly baseUrl: string | undefined;
  private readonly model: string;

  constructor(opts: OllamaEmbedderOptions = {}) {
    this.baseUrl = opts.baseUrl ?? process.env.OLLAMA_BASE_URL;
    this.model = opts.model ?? process.env.OLLAMA_EMBED_MODEL ?? 'bge-m3';
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!this.baseUrl) {
      throw new Error(
        'OllamaEmbedder: OLLAMA_BASE_URL is not configured. Set OLLAMA_BASE_URL ' +
          '(and optionally OLLAMA_EMBED_MODEL, default bge-m3) to enable vector recall, ' +
          'or inject DeterministicEmbedder for offline/test use.',
      );
    }
    const url = `${this.baseUrl.replace(/\/+$/, '')}/api/embed`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!res.ok) {
      throw new Error(
        `OllamaEmbedder: /api/embed failed (${res.status} ${res.statusText}) for model ${this.model}`,
      );
    }
    const data = (await res.json()) as { embeddings?: number[][] };
    if (!data.embeddings || data.embeddings.length !== texts.length) {
      throw new Error('OllamaEmbedder: unexpected /api/embed response shape');
    }
    return data.embeddings;
  }
}
