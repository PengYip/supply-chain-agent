import { describe, it, expect } from 'vitest';
import type { Block, DocType } from '../../src/pipeline/types.js';
import { deriveAutoTags } from '../../src/pipeline/tagging.js';

const blk = (text: string): Block[] => [
  { id: 'b0', type: 'text', text, page: 1, bbox: null, ocrConfidence: 1 },
];

describe('deriveAutoTags', () => {
  it('always includes the docType as the first tag', () => {
    const tags = deriveAutoTags({ docType: '合同' as DocType, blocks: blk('任意内容') });
    expect(tags[0]).toBe('合同');
  });

  it('adds keyword-matched tags from the content', () => {
    const tags = deriveAutoTags({
      docType: '合同' as DocType,
      blocks: blk('本合同采用信用证结算，含 CIF 条款'),
    });
    expect(tags).toContain('合同');
    expect(tags).toContain('信用证');
    expect(tags).toContain('CIF');
  });

  it('dedupes and does not repeat the docType if also keyword-matched', () => {
    const tags = deriveAutoTags({
      docType: '发票' as DocType,
      blocks: blk('发票号 INV-001，发票金额 100'),
    });
    const dupes = tags.filter((t) => t === '发票');
    expect(dupes.length).toBe(1);
  });

  it('caps the tag list at 8 entries', () => {
    // Craft content that hits many keyword rules at once.
    const text = '信用证 CIF FOB 提单 装箱单 发票 合同 港口 重量 检验';
    const tags = deriveAutoTags({ docType: '其他' as DocType, blocks: blk(text) });
    expect(tags.length).toBeLessThanOrEqual(8);
  });

  it('returns at least the docType for empty content', () => {
    const tags = deriveAutoTags({ docType: '提单' as DocType, blocks: blk('') });
    expect(tags).toEqual(['提单']);
  });
});
