import { describe, it, expect } from 'vitest';
import { filterChunksByTag } from '../../src/pipeline/chunkTagFilter.js';

interface ChunkLike {
  text: string;
  tags?: string[] | null;
}

const chunk = (text: string, tags?: string[] | null): ChunkLike => ({ text, tags });

describe('filterChunksByTag', () => {
  it('returns all chunks unchanged when wantTags is empty', () => {
    const chunks = [chunk('a', ['x']), chunk('b', null), chunk('c')];
    expect(filterChunksByTag(chunks, [])).toBe(chunks); // same ref, no copy
    expect(filterChunksByTag(chunks, [])).toEqual(chunks);
  });

  it('any mode (default): keeps chunks with >=1 intersecting tag', () => {
    const chunks = [
      chunk('a', ['当事人信息', '标的物']),
      chunk('b', ['数量与计量']),
      chunk('c', ['付款条款']),
      chunk('d', null),
    ];
    const result = filterChunksByTag(chunks, ['标的物', '数量与计量']);
    expect(result.map((c) => c.text)).toEqual(['a', 'b']);
  });

  it('all mode: keeps chunks that contain every wanted tag', () => {
    const chunks = [
      chunk('a', ['当事人信息', '标的物', '价格与金额']),
      chunk('b', ['当事人信息', '标的物']), // missing 价格与金额
      chunk('c', ['当事人信息']), // missing two
    ];
    const result = filterChunksByTag(
      chunks,
      ['当事人信息', '标的物', '价格与金额'],
      'all',
    );
    expect(result.map((c) => c.text)).toEqual(['a']);
  });

  it('excludes chunks with null / undefined / empty tags', () => {
    const chunks = [
      chunk('null', null),
      chunk('undef', undefined),
      chunk('empty', []),
      chunk('match', ['标的物']),
    ];
    const result = filterChunksByTag(chunks, ['标的物']);
    expect(result.map((c) => c.text)).toEqual(['match']);
  });

  it('any mode keeps nothing when no chunk matches', () => {
    const chunks = [chunk('a', ['x']), chunk('b', ['y'])];
    const result = filterChunksByTag(chunks, ['z']);
    expect(result).toEqual([]);
  });

  it('all mode with single wantTag behaves like any for that tag', () => {
    const chunks = [
      chunk('a', ['x', 'y']),
      chunk('b', ['x']),
      chunk('c', ['y']),
    ];
    const result = filterChunksByTag(chunks, ['x'], 'all');
    expect(result.map((c) => c.text)).toEqual(['a', 'b']);
  });
});
