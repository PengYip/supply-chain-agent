import { describe, expect, it, vi } from 'vitest';
import { applyRerank, RERANK_MAX_DOCS } from '../../src/pipeline/tools/recall.js';
import type { RerankResult, Reranker } from '../../src/pipeline/reranker.js';

interface Cand {
  id: string;
  text: string;
}

function makeCandidates(n: number): Cand[] {
  return Array.from({ length: n }, (_, i) => ({ id: `c${i}`, text: `doc-${i}` }));
}

/** Offline stub reranker: no OpenAICompatReranker construction, zero network. */
function makeStub(outcome: RerankResult[] | Error) {
  const rerank = vi.fn(
    async (_query: string, _documents: string[], _topN?: number): Promise<RerankResult[]> => {
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  );
  return { reranker: { kind: 'stub', rerank } as unknown as Reranker, rerank };
}

describe('applyRerank', () => {
  it('no reranker configured -> passthrough with applied=false, no calls', async () => {
    const cands = makeCandidates(3);
    const [out, applied] = await applyRerank(null, 'q', cands, (c) => c.text);
    expect(applied).toBe(false);
    expect(out).toEqual(cands);
    expect((out as Cand[]).map((c) => c.id)).toEqual(['c0', 'c1', 'c2']);
  });

  it('duplicate texts: provider called once per unique text, mapped back to ALL indices', async () => {
    // a and b share 'dup'; unique list is ['dup','zz'] (first-occurrence order).
    const cands: Cand[] = [
      { id: 'a', text: 'dup' },
      { id: 'b', text: 'dup' },
      { id: 'c', text: 'zz' },
    ];
    const { reranker, rerank } = makeStub([
      { index: 1, relevanceScore: 0.9 }, // 'zz'
      { index: 0, relevanceScore: 0.1 }, // 'dup'
    ]);
    const [out, applied] = await applyRerank(reranker, 'q', cands, (c) => c.text);

    expect(rerank).toHaveBeenCalledTimes(1);
    expect(rerank.mock.calls[0]?.[0]).toBe('q');
    expect(rerank.mock.calls[0]?.[1]).toEqual(['dup', 'zz']);
    expect(applied).toBe(true);
    // 'zz' wins; BOTH duplicates surface afterwards in original relative order.
    expect((out as Cand[]).map((c) => c.id)).toEqual(['c', 'a', 'b']);
  });

  it('skipped-index safety net: omitted candidates keep original order, output stays complete', async () => {
    const cands = makeCandidates(3); // unique texts doc-0..doc-2
    // Provider only scored the third document.
    const { reranker, rerank } = makeStub([{ index: 2, relevanceScore: 0.99 }]);
    const [out, applied] = await applyRerank(reranker, 'q', cands, (c) => c.text);

    expect(rerank).toHaveBeenCalledTimes(1);
    expect(applied).toBe(true);
    expect(out).toHaveLength(3);
    expect((out as Cand[]).map((c) => c.id)).toEqual(['c2', 'c0', 'c1']);
  });

  it('provider throws -> original ranked list returned unchanged with applied=false', async () => {
    const cands = makeCandidates(3);
    const { reranker, rerank } = makeStub(new Error('rerank endpoint down'));
    const [out, applied] = await applyRerank(reranker, 'q', cands, (c) => c.text);

    expect(rerank).toHaveBeenCalledTimes(1);
    expect(applied).toBe(false);
    expect(out).toEqual(cands);
    expect((out as Cand[]).map((c) => c.id)).toEqual(['c0', 'c1', 'c2']);
  });

  it('cap enforcement: more than RERANK_MAX_DOCS docs -> exactly RERANK_MAX_DOCS sent', async () => {
    const n = RERANK_MAX_DOCS + 10;
    const cands = makeCandidates(n);
    const results: RerankResult[] = Array.from({ length: RERANK_MAX_DOCS }, (_, i) => ({
      index: RERANK_MAX_DOCS - 1 - i,
      relevanceScore: 1 - i * 0.01,
    }));
    const { reranker, rerank } = makeStub(results);
    const [out, applied] = await applyRerank(reranker, 'q', cands, (c) => c.text);

    expect(rerank).toHaveBeenCalledTimes(1);
    const docs = rerank.mock.calls[0]?.[1] as string[];
    expect(docs).toHaveLength(RERANK_MAX_DOCS);    // Slice follows the EXISTING ranking order (head preserved).
    expect(docs[0]).toBe('doc-0');
    expect(docs[RERANK_MAX_DOCS - 1]).toBe(`doc-${RERANK_MAX_DOCS - 1}`);
    expect(docs).not.toContain(`doc-${n - 1}`);
    expect(applied).toBe(true);
    expect(out).toHaveLength(RERANK_MAX_DOCS);
    expect((out as Cand[])[0]?.id).toBe(`c${RERANK_MAX_DOCS - 1}`);
  });

  it('happy path: output order follows provider scores', async () => {
    const cands = makeCandidates(4);
    const { reranker, rerank } = makeStub([
      { index: 2, relevanceScore: 0.95 },
      { index: 0, relevanceScore: 0.7 },
      { index: 3, relevanceScore: 0.2 },
      { index: 1, relevanceScore: 0.01 },
    ]);
    const [out, applied] = await applyRerank(reranker, 'q', cands, (c) => c.text);

    expect(rerank.mock.calls[0]?.[1]).toEqual(['doc-0', 'doc-1', 'doc-2', 'doc-3']);
    expect(applied).toBe(true);
    expect((out as Cand[]).map((c) => c.id)).toEqual(['c2', 'c0', 'c3', 'c1']);
  });
});
