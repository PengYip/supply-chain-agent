import { describe, expect, it, vi, afterEach } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { OpenAICompatEmbedder } from '../../src/pipeline/embedder.js';
import { OpenAICompatReranker, defaultReranker } from '../../src/pipeline/reranker.js';

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
    const emb = new OpenAICompatEmbedder({ apiKey: 'k', baseUrl: 'https://api.siliconflow.cn/' });
    const vecs = await emb.embed(['合同一', 'hello']);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.siliconflow.cn/v1/embeddings');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer k');
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
    await expect(emb.embed(['x'])).rejects.toThrow(/\/v1\/embeddings failed \(400/);

    const noKey = new OpenAICompatEmbedder({});
    await expect(noKey.embed(['x'])).rejects.toThrow(/SILICONFLOW_API_KEY is not configured/);
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
