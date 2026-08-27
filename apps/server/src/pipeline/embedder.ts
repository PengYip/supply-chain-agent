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
  /** Identity of the embedder implementation (e.g. 'deterministic', 'ollama-bge-m3').
   *  Used to surface which vector mode an ingest used in its vectorization status. */
  readonly kind: string;
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
  readonly kind = 'deterministic';

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
  readonly kind = 'ollama-bge-m3';
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

// ---- Shared OpenAI-compatible HTTP transport --------------------------------
// Post-with-retry used by both the embedder and the reranker clients below.

/** Backoff schedule between retries (attempt 0 fail -> 2s, attempt 1 -> 4s). */
const RETRY_BACKOFFS_MS = [2_000, 4_000];
/** Retry-After waits are honored but never exceed this. */
const RETRY_AFTER_CAP_MS = 15_000;
/** Initial attempt + max 2 retries. */
const MAX_HTTP_ATTEMPTS = 3;

/** Transient HTTP failure worth retrying (429 / 5xx). */
class RetryableHttpError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number | null,
  ) {
    super(message);
  }
}

/** Fetch-level network failure (DNS/socket/connection reset) -- transient. */
class NetworkHttpError extends Error {}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterMsOf(res: Response): number | null {
  const raw = res.headers.get('retry-after');
  if (!raw) return null;
  const secs = Number(raw);
  let ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(raw) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return Math.min(Math.round(ms), RETRY_AFTER_CAP_MS);
}

function isTimeout(err: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (err instanceof Error && err.name === 'TimeoutError');
}

interface PostJsonOpts {
  url: string;
  init: RequestInit;
  timeoutMs: number;
  /** Call identity for errors, e.g. 'OpenAICompatEmbedder: /v1/embeddings'. */
  errorPrefix: string;
  /** Extra context appended after status text, e.g. 'for model BAAI/bge-m3'. */
  errorSuffix?: string;
}

/**
 * POST JSON with a per-attempt AbortSignal.timeout, then classify-and-retry:
 * up to MAX_HTTP_ATTEMPTS on HTTP 429 / 5xx and network errors, waiting
 * Retry-After (capped at 15s) when present, else exponential 2s -> 4s.
 * Non-retryable 4xx and timeouts fail fast; timeouts surface an error naming
 * the call and the ms budget.
 */
export async function postJsonWithRetries(opts: PostJsonOpts): Promise<Response> {
  const suffix = opts.errorSuffix ? ` ${opts.errorSuffix}` : '';
  let lastError: unknown;
  for (let attempt = 0; ; attempt++) {
    const signal = AbortSignal.timeout(opts.timeoutMs);
    try {
      const res = await fetch(opts.url, { ...opts.init, signal });
      if (res.ok) return res;
      const message = `${opts.errorPrefix} failed (${res.status} ${res.statusText})${suffix}`;
      if (res.status === 429 || res.status >= 500) {
        throw new RetryableHttpError(message, retryAfterMsOf(res));
      }
      throw new Error(message);
    } catch (caught) {
      if (isTimeout(caught, signal)) {
        throw new Error(`${opts.errorPrefix} timed out after ${opts.timeoutMs}ms`);
      }
      // undici surfaces connect/socket failures as TypeError: normalize them so
      // every transient failure class is uniformly identifiable.
      const err: unknown =
        caught instanceof TypeError
          ? new NetworkHttpError(`${opts.errorPrefix}: network error: ${caught.message}`)
          : caught;
      lastError = err;
      const retryable = err instanceof RetryableHttpError || err instanceof NetworkHttpError;
      if (!retryable || attempt >= MAX_HTTP_ATTEMPTS - 1) throw lastError;
      const waitMs =
        err instanceof RetryableHttpError && err.retryAfterMs !== null
          ? err.retryAfterMs
          : RETRY_BACKOFFS_MS[Math.min(attempt, RETRY_BACKOFFS_MS.length - 1)] ?? RETRY_BACKOFFS_MS[0]!;
      await sleep(waitMs);
    }
  }
}

// ---- OpenAICompatEmbedder (hosted: SiliconFlow etc.) ------------------------

export interface OpenAICompatEmbedderOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  /** Per-request timeout in ms (default 10s). */
  timeoutMs?: number;
  /** Expected vector dimensionality (default 1024); mismatch fails fast. */
  dim?: number;
}

/**
 * Embedder for any OpenAI-compatible /v1/embeddings endpoint (SiliconFlow is
 * the deployment target; also works with OpenAI/DashScope-compatible hosts).
 *
 * bge-m3 on SiliconFlow returns exactly 1024 dims, matching EMBED_DIM and the
 * vec0 table — verified live 2026-08-27 (batch of 3, CJK + ASCII). Returned
 * vectors are dimension-checked against `dim` (default EMBED_DIM) fail-fast.
 *
 * Transport: postJsonWithRetries (10s default timeout; retries 429/5xx/network).
 *
 * kind embeds the model so changing SILICONFLOW_EMBED_MODEL invalidates stored
 * vectorization modes (backfill detects docs embedded under a stale model).
 *
 * Throws a CLEAR configuration error when no API key is configured, mirroring
 * OllamaEmbedder. Never invoked in the test path (tests inject
 * DeterministicEmbedder or mock fetch).
 */
export class OpenAICompatEmbedder implements Embedder {
  readonly dim: number;
  readonly kind: string;
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(opts: OpenAICompatEmbedderOptions = {}) {
    this.dim = opts.dim ?? EMBED_DIM;
    this.apiKey = opts.apiKey ?? process.env.SILICONFLOW_API_KEY;
    this.baseUrl = (opts.baseUrl ?? process.env.SILICONFLOW_BASE_URL ?? 'https://api.siliconflow.cn')
      .replace(/\/+$/, '');
    this.model = opts.model ?? process.env.SILICONFLOW_EMBED_MODEL ?? 'BAAI/bge-m3';
    this.kind = `openai-compat:${this.model}`;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!this.apiKey) {
      throw new Error(
        'OpenAICompatEmbedder: SILICONFLOW_API_KEY is not configured. Set it (and optionally ' +
          'SILICONFLOW_BASE_URL / SILICONFLOW_EMBED_MODEL, defaults https://api.siliconflow.cn ' +
          '/ BAAI/bge-m3) to enable vector recall, or inject DeterministicEmbedder for offline use.',
      );
    }
    const res = await postJsonWithRetries({
      url: `${this.baseUrl}/v1/embeddings`,
      init: {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ model: this.model, input: texts }),
      },
      timeoutMs: this.timeoutMs,
      errorPrefix: 'OpenAICompatEmbedder: /v1/embeddings',
      errorSuffix: `for model ${this.model}`,
    });
    // OpenAI shape: { data: [{ embedding: number[], index: number }], usage? }
    const data = (await res.json()) as { data?: Array<{ embedding?: number[]; index?: number }> };
    const rows = data.data ?? [];
    if (rows.length !== texts.length || rows.some((r) => !Array.isArray(r.embedding))) {
      throw new Error('OpenAICompatEmbedder: unexpected /v1/embeddings response shape');
    }
    // OpenAI guarantees order-aligned data but sort by index defensively.
    const vectors = [...rows]
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map((r) => r.embedding!);
    const badRow = vectors.findIndex((v) => v.length !== this.dim);
    if (badRow >= 0) {
      const got = vectors[badRow]?.length;
      throw new Error(
        `OpenAICompatEmbedder: dimension mismatch for model ${this.model} `
        + `(expected ${this.dim}, got ${got} at row ${badRow}). `
        + 'Check that the model matches the vector table dimension.',
      );
    }
    return vectors;
  }
}
