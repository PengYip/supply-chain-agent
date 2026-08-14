import { describe, it, expect, vi } from 'vitest';
import { tagChunks, type ChunkTagger } from '../../src/pipeline/chunkTagging.js';

describe('tagChunks', () => {
  it('returns all null and never calls the tagger when taxonomy is empty', async () => {
    const tagger = vi.fn<ChunkTagger>();
    const chunks = [{ text: 'a' }, { text: 'b' }, { text: 'c' }];

    const result = await tagChunks({ chunks, taxonomy: [], tagger });

    expect(result).toEqual([null, null, null]);
    expect(tagger).not.toHaveBeenCalled();
  });

  it('maps multi-tag results back per chunk, aligned to order', async () => {
    // chunk 0 -> 2 tags, chunk 1 -> 1 tag, chunk 2 -> none (out of order keys
    // to prove alignment by index, not by insertion).
    const tagger = vi.fn<ChunkTagger>().mockResolvedValue({
      1: ['数量与计量'],
      0: ['当事人信息', '标的物'],
    });
    const chunks = [{ text: '甲方...' }, { text: '数量...' }, { text: '封面' }];
    const taxonomy = ['当事人信息', '标的物', '数量与计量'];

    const result = await tagChunks({ chunks, taxonomy, tagger });

    expect(result).toEqual([
      ['当事人信息', '标的物'],
      ['数量与计量'],
      null,
    ]);
    // tagger received exactly the indexed chunks in order.
    expect(tagger).toHaveBeenCalledTimes(1);
    const [indexedArg, taxArg] = tagger.mock.calls[0];
    expect(indexedArg).toEqual([
      { index: 0, text: '甲方...' },
      { index: 1, text: '数量...' },
      { index: 2, text: '封面' },
    ]);
    expect(taxArg).toBe(taxonomy);
  });

  it('filters out tags not in the taxonomy (closed set)', async () => {
    const tagger = vi.fn<ChunkTagger>().mockResolvedValue({
      0: ['当事人信息', 'HACKED_LABEL', '标的物', '另一个假标签'],
      1: ['ONLY_UNKNOWN'], // all filtered -> null
    });
    const chunks = [{ text: 'x' }, { text: 'y' }];
    const taxonomy = ['当事人信息', '标的物'];

    const result = await tagChunks({ chunks, taxonomy, tagger });

    expect(result).toEqual([['当事人信息', '标的物'], null]);
  });

  it('returns all null when the tagger throws (fault isolation)', async () => {
    const tagger = vi.fn<ChunkTagger>().mockRejectedValue(new Error('boom'));
    const chunks = [{ text: 'a' }, { text: 'b' }];
    const taxonomy = ['当事人信息'];

    const result = await tagChunks({ chunks, taxonomy, tagger });

    expect(result).toEqual([null, null]);
    expect(tagger).toHaveBeenCalledTimes(1);
  });

  it('dedupes repeated tags within a single chunk', async () => {
    const tagger = vi.fn<ChunkTagger>().mockResolvedValue({
      0: ['当事人信息', '当事人信息', '标的物'],
    });
    const chunks = [{ text: 'a' }];
    const taxonomy = ['当事人信息', '标的物'];

    const result = await tagChunks({ chunks, taxonomy, tagger });

    expect(result).toEqual([['当事人信息', '标的物']]);
  });

  it('handles empty chunk list without calling the tagger', async () => {
    const tagger = vi.fn<ChunkTagger>();
    const result = await tagChunks({ chunks: [], taxonomy: ['x'], tagger });
    expect(result).toEqual([]);
    expect(tagger).not.toHaveBeenCalled();
  });

  it('treats non-array / empty tag entries as null', async () => {
    const tagger = vi.fn<ChunkTagger>().mockResolvedValue({
      0: [],
      1: undefined as unknown as string[],
    });
    const chunks = [{ text: 'a' }, { text: 'b' }];
    const taxonomy = ['x'];

    const result = await tagChunks({ chunks, taxonomy, tagger });

    expect(result).toEqual([null, null]);
  });
});
