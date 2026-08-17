// Pure unit tests for the round-2 PG FTS snippet fixes:
//  - windowSnippet (TS-side snippet windowing replacing ts_headline, which
//    cannot highlight CJK against a unigram-preprocessed query)
//  - compressSnippetsOutput (the 'snippets' compression budget tier that keeps
//    recall_documents matches visible to the model instead of dropping them)
// No DB needed; runs in every lane.

import { describe, it, expect } from 'vitest';
import {
  windowSnippet,
  toPgFtsQuery,
} from '../../src/pipeline/db/postgres-repositories.js';
import { compressSnippetsOutput } from '../../src/harness/compression.js';

describe('windowSnippet (TS-side FTS snippet windowing)', () => {
  it('windows around the earliest CJK term occurrence, prefixing ... when mid-chunk', () => {
    // 违约责任 appears at offset 400 (past the 300-char threshold) -> the window
    // must start at 400-50=350 and carry the 第七条 clause body, not the head.
    const text = '甲'.repeat(400) + '第七条 违约责任：乙方逾期交货的，应向甲方支付违约金。' + '乙'.repeat(1000);
    const snip = windowSnippet(text, '违约责任');
    expect(snip.startsWith('...')).toBe(true);
    expect(snip).toContain('第七条');
    expect(snip).toContain('违约责任');
    // window (800) + both ellipses
    expect(snip.length).toBeLessThanOrEqual(800 + 6);
  });

  it('matches ASCII case-insensitively', () => {
    const text = 'A'.repeat(100) + 'Diesel Fuel Specification' + 'B'.repeat(100);
    const snip = windowSnippet(text, 'diesel');
    expect(snip.startsWith('...')).toBe(true);
    expect(snip).toContain('Diesel');
    expect(snip).toContain('Fuel');
  });

  it('falls back to the text head with a trailing ellipsis when no term matches', () => {
    const text = 'x'.repeat(2000);
    const snip = windowSnippet(text, 'zzz-no-match');
    expect(snip).toBe('x'.repeat(800) + '...');
  });

  it('returns the whole text unchanged when it fits and the term is at the start', () => {
    const text = '第七条 违约责任';
    expect(windowSnippet(text, '违约')).toBe(text);
  });

  it('suffixes ... when the window ends before the text tail', () => {
    const text = '违约责任条款' + 'x'.repeat(1000);
    const snip = windowSnippet(text, '违约责任');
    expect(snip.startsWith('...')).toBe(false);
    expect(snip.startsWith('违约责任')).toBe(true);
    expect(snip.endsWith('...')).toBe(true);
  });

  it('handles mixed CJK + ASCII queries', () => {
    const text = 'x'.repeat(200) + 'CJXC-CTCL 交货标准：产品质量应符合国标。' + 'y'.repeat(200);
    const snip = windowSnippet(text, 'CJXC 交货');
    expect(snip).toContain('CJXC');
    expect(snip).toContain('交货');
  });

  it('produces no <b> markers and no injected spaces between CJK chars', () => {
    const text = '甲'.repeat(100) + '第七条 违约责任：乙方逾期交货的，应向甲方支付违约金。';
    const snip = windowSnippet(text, '违约责任');
    expect(snip).not.toContain('<b>');
    expect(snip).not.toContain('违 约');
  });
});

describe('compressSnippetsOutput (snippets budget tier)', () => {
  it('preserves recall shape: first 10 matches + matches_truncated + snippet capped at 500', () => {
    const matches = Array.from({ length: 12 }, (_, i) => ({
      document_id: `DOC-${i}`,
      chunk_index: i,
      snippet: 's'.repeat(600), // over the 500 cap -> truncated
      source: 'fts',
      score: 0.5,
      bm25_score: -1,
      vector_distance: null,
    }));
    const out = compressSnippetsOutput({
      type: 'json',
      value: {
        query: '违约责任',
        strategy: 'hybrid',
        matchCount: 12,
        contractNo: 'HT-001',
        matches,
      },
    }) as { type: string; value: Record<string, unknown> };
    expect(out.type).toBe('json');
    const v = out.value;
    expect(v.query).toBe('违约责任');
    expect(v.strategy).toBe('hybrid');
    expect(v.matchCount).toBe(12);
    expect(v.contractNo).toBe('HT-001');
    expect(v.matches_truncated).toBe(2);
    const kept = v.matches as Array<Record<string, unknown>>;
    expect(kept).toHaveLength(10);
    expect(kept[0]!.document_id).toBe('DOC-0');
    expect(kept[0]!.chunk_index).toBe(0);
    expect(kept[0]!.snippet).toHaveLength(500);
    expect(kept[0]!.source).toBe('fts');
    // per-match noise dropped
    expect(kept[0]!.score).toBeUndefined();
    expect(kept[0]!.bm25_score).toBeUndefined();
    expect(kept[0]!.vector_distance).toBeUndefined();
  });

  it('preserves note when present (miss case)', () => {
    const out = compressSnippetsOutput({
      type: 'json',
      value: {
        query: 'x',
        strategy: 'fts',
        matchCount: 0,
        matches: [],
        note: '未找到与该合同号绑定的文档',
      },
    }) as { type: string; value: Record<string, unknown> };
    expect(out.value.note).toBe('未找到与该合同号绑定的文档');
    expect((out.value.matches as unknown[]).length).toBe(0);
    expect(out.value.matches_truncated).toBeUndefined();
  });

  it('passes objects without a matches array through unchanged (same reference)', () => {
    const output = { type: 'json', value: { ok: true, contractNo: 'HT-001' } };
    expect(compressSnippetsOutput(output)).toBe(output);
  });

  it('passes text / non-json outputs through unchanged', () => {
    const text = { type: 'text', value: 'plain' };
    expect(compressSnippetsOutput(text)).toBe(text);
  });
});

describe('toPgFtsQuery + windowSnippet stay consistent', () => {
  it('the query the DB matches on and the snippet windowing both derive from the raw query', () => {
    // toPgFtsQuery unigram-spaces for the DB; windowSnippet uses the RAW query
    // terms (no injected spaces) so the snippet stays quotable.
    const raw = '违约责任';
    expect(toPgFtsQuery(raw)).toBe('违 约 责 任 ');
    const text = '甲'.repeat(100) + '第七条 违约责任：乙方逾期交货的，应向甲方支付违约金。';
    const snip = windowSnippet(text, raw);
    expect(snip).toContain('违约责任');
    expect(snip).not.toContain('违 约');
  });
});