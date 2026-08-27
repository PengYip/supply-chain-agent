import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import {
  DeterministicEmbedder,
  OllamaEmbedder,
  OpenAICompatEmbedder,
} from '../../src/pipeline/embedder.js';
import { OpenAICompatReranker, defaultReranker } from '../../src/pipeline/reranker.js';
import { defaultEmbedder } from '../../src/pipeline/ingestModel.js';

afterEach(() => {
  fetchMock.mockReset();
  delete process.env.SILICONFLOW_API_KEY;
  delete process.env.SILICONFLOW_BASE_URL;
});

describe('OpenAICompatEmbedder (SiliconFlow /v1/embeddings)', () => {
  it('posts model+input and returns order-aligned embeddings', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { index: 1, embedding: [3, 4] },
            { index: 0, embedding: [1, 2] },
          ],
          usage: { prompt_tokens: 9 },
        }),
        { status: 200 },
      ),
    );
    const emb = new OpenAICompatEmbedder({
      apiKey: 'k',
      baseUrl: 'https://api.siliconflow.cn/',
      dim: 2,
    });
    const vecs = await emb.embed(['合同一', 'hello']);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.siliconflow.cn/v1/embeddings');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer k');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'BAAI/bge-m3',
      input: ['合同一', 'hello'],
    });
    // index-sorted defensively: input[0] -> first vector.
    expect(vecs).toEqual([[1, 2], [3, 4]]);
  });

  it('throws a clear error on non-2xx and on missing api key', async () => {
    const emb = new OpenAICompatEmbedder({ apiKey: 'k' });
    fetchMock.mockResolvedValue(new Response('{"code":20015}', { status: 400 }));
    // Non-retryable 4xx: fail fast, exactly one attempt.
    await expect(emb.embed(['x'])).rejects.toThrow(/\/v1\/embeddings failed \(400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const noKey = new OpenAICompatEmbedder({});
    await expect(noKey.embed(['x'])).rejects.toThrow(/SILICONFLOW_API_KEY is not configured/);
  });

  it('kind is openai-compat:<model> so model switches invalidate stored modes', () => {
    expect(new OpenAICompatEmbedder({ apiKey: 'k' }).kind).toBe('openai-compat:BAAI/bge-m3');
    expect(
      new OpenAICompatEmbedder({ apiKey: 'k', model: 'BAAI/bge-large-zh-v1.5' }).kind,
    ).toBe('openai-compat:BAAI/bge-large-zh-v1.5');
  });

  it('dimension mismatch between configured dim and returned vectors throws', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 2] }] }), { status: 200 }),
    );
    const emb = new OpenAICompatEmbedder({ apiKey: 'k', dim: 3 });
    await expect(emb.embed(['x'])).rejects.toThrow(/dimension mismatch.*expected 3, got 2/s);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a 429 honoring Retry-After over the default backoff', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response('rate limited', { status: 429, headers: { 'retry-after': '5' } }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ index: 0, embedding: [7, 8, 9] }] }), { status: 200 }),
      );
    vi.useFakeTimers();
    try {
      const emb = new OpenAICompatEmbedder({ apiKey: 'k', dim: 3 });
      const pending = emb.embed(['q']);
      // Default backoff slot is 2s; honoring Retry-After means waiting 5s instead,
      // so no second attempt may fire within 2.5s.
      await vi.advanceTimersByTimeAsync(2_500);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(3_000); // now past 5s
      const vecs = await pending;
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(vecs).toEqual([[7, 8, 9]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a network TypeError, then succeeds', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ index: 0, embedding: [1] }] }), { status: 200 }),
      );
    vi.useFakeTimers();
    try {
      const emb = new OpenAICompatEmbedder({ apiKey: 'k', dim: 1 });
      const pending = emb.embed(['q']);
      await vi.advanceTimersByTimeAsync(2_100); // exponential backoff slot 1: 2s
      expect(await pending).toEqual([[1]]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up after initial + 2 retries on persistent 5xx', async () => {
    fetchMock.mockResolvedValue(new Response('{"error":"overloaded"}', { status: 503 }));
    vi.useFakeTimers();
    try {
      const emb = new OpenAICompatEmbedder({ apiKey: 'k', dim: 2 });
      const pending = emb.embed(['x']).catch((e) => e);
      await vi.advanceTimersByTimeAsync(2_100);
      await vi.advanceTimersByTimeAsync(4_100);
      const err = (await pending) as Error;
      expect(err.message).toMatch(/\/v1\/embeddings failed \(503/);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a request timeout fails fast (no retries) naming the call and budget', async () => {
    const aborted = new Error('The operation was aborted due to timeout');
    aborted.name = 'TimeoutError';
    fetchMock.mockRejectedValue(aborted);
    const emb = new OpenAICompatEmbedder({ apiKey: 'k', dim: 2, timeoutMs: 12_345 });
    await expect(emb.embed(['x'])).rejects.toThrow(/timed out after 12345ms/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('defaultEmbedder priority chain (env-driven)', () => {
  const ENV_KEYS = [
    'SILICONFLOW_API_KEY',
    'SILICONFLOW_BASE_URL',
    'SILICONFLOW_EMBED_MODEL',
    'OLLAMA_BASE_URL',
    'OLLAMA_EMBED_MODEL',
    'NODE_ENV',
  ] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('siliconflow key wins over ollama; ollama beats deterministic fallback', () => {
    for (const k of ENV_KEYS) delete process.env[k];
    expect(defaultEmbedder()).toBeInstanceOf(DeterministicEmbedder);

    process.env.OLLAMA_BASE_URL = 'http://localhost:11434';
    expect(defaultEmbedder()).toBeInstanceOf(OllamaEmbedder);

    process.env.SILICONFLOW_API_KEY = 'k';
    expect(defaultEmbedder().kind).toBe('openai-compat:BAAI/bge-m3');
  });

  it('warns once per selection when production falls back to deterministic', () => {
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.NODE_ENV = 'production';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(defaultEmbedder().kind).toBe('deterministic');
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0]?.[0])).toMatch(/SILICONFLOW_API_KEY/);
      // One warning per SELECTION, not per embed call.
      defaultEmbedder();
      expect(warnSpy).toHaveBeenCalledTimes(2);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('OpenAICompatReranker (SiliconFlow /v1/rerank)', () => {
  it('posts query/documents/top_n and returns descending results', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [
            { index: 2, relevance_score: 0.93 },
            { index: 0, relevance_score: 0.007 },
          ],
        }),
        { status: 200 },
      ),
    );
    const rr = new OpenAICompatReranker({ apiKey: 'k' });
    const out = await rr.rerank('甲醇采购', ['a', 'b', 'c'], 2);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.siliconflow.cn/v1/rerank');
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'BAAI/bge-reranker-v2-m3',
      query: '甲醇采购',
      documents: ['a', 'b', 'c'],
      top_n: 2,
    });
    expect(out).toEqual([
      { index: 2, relevanceScore: 0.93 },
      { index: 0, relevanceScore: 0.007 },
    ]);
  });

  it('empty documents short-circuits without an HTTP call; missing key throws clearly', async () => {
    const rr = new OpenAICompatReranker({ apiKey: 'k' });
    expect(await rr.rerank('q', [])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();

    const noKey = new OpenAICompatReranker({});
    await expect(noKey.rerank('q', ['d'])).rejects.toThrow(/SILICONFLOW_API_KEY is not configured/);
  });

  it('defaultReranker is null without the env key and non-null with it', () => {
    expect(defaultReranker()).toBeNull();
    process.env.SILICONFLOW_API_KEY = 'k';
    expect(defaultReranker()).not.toBeNull();
  });
});
