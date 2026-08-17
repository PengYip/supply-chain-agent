// Pure unit tests for toPgFtsQuery (CJK unigram preprocessing). The function is
// the query-side twin of the fts_vector GENERATED column expression in
// migratePostgres() (client.ts) -- both must apply the identical transformation
// or Chinese multi-char queries silently miss. No DB needed; runs in every lane.

import { describe, it, expect } from 'vitest';
import { toPgFtsQuery } from '../../src/pipeline/db/postgres-repositories.js';

describe('toPgFtsQuery (CJK unigram preprocessing)', () => {
  it('spaces out contiguous CJK so to_tsvector lexes unigrams', () => {
    expect(toPgFtsQuery('违约责任')).toBe('违 约 责 任 ');
  });

  it('keeps ASCII words and single spaces unchanged (no doubling)', () => {
    expect(toPgFtsQuery('diesel fuel')).toBe('diesel fuel');
  });

  it('puts a space after hyphens and other non-[0-9A-Za-z ] chars', () => {
    expect(toPgFtsQuery('CJXC-CTCL-JY-2024-131-01')).toBe('CJXC- CTCL- JY- 2024- 131- 01');
  });

  it('returns empty string for empty input', () => {
    expect(toPgFtsQuery('')).toBe('');
  });

  it('handles mixed CJK + ASCII', () => {
    expect(toPgFtsQuery('CJXC 交货')).toBe('CJXC 交 货 ');
  });
});