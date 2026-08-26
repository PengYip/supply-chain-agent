import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { blockModelFromText, ingestWithDigital } from '../../src/pipeline/digitalAdapter.js';
import { writeDocxFixture } from './fixtures/makeDocx.js';

describe('digitalAdapter', () => {
  it('splits plain text into line blocks with ocrConfidence=1.0 and null bbox', () => {
    const model = blockModelFromText({
      docId: 'DOC-1',
      docType: '合同',
      sourceUri: 'file:///x.txt',
      text: '合同号: HT-2024-001\n金额: 2860000',
    });
    expect(model.modality).toBe('digital');
    expect(model.blocks).toHaveLength(2);
    expect(model.blocks[0].ocrConfidence).toBe(1.0);
    expect(model.blocks[0].bbox).toBeNull();
    expect(model.blocks[0].text).toBe('合同号: HT-2024-001');
    expect(model.blocks[0].page).toBe(1);
  });

  it('ingestWithDigital reads a .txt file from disk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dc-'));
    const f = join(dir, 'c.txt');
    writeFileSync(f, '甲方: 华盛集团\n乙方: 中石化', 'utf-8');
    const model = await ingestWithDigital(f, '合同', 'DOC-2');
    expect(model.blocks).toHaveLength(2);
    expect(model.blocks[0].text).toBe('甲方: 华盛集团');
  });

  it('ingestWithDigital extracts Chinese paragraphs from a .docx as kv/text blocks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dc-docx-'));
    const f = join(dir, '合同.docx');
    await writeDocxFixture(f, {
      paragraphs: ['合同编号：HT-2026-001', '甲方：华盛集团有限公司', '本合同经双方签署后生效。'],
    });
    const model = await ingestWithDigital(f, '合同', 'DOC-3');
    expect(model.modality).toBe('digital');
    // 3 paragraphs -> 3 blocks; colon lines become kv, the rest text.
    expect(model.blocks).toHaveLength(3);
    expect(model.blocks[0].text).toBe('合同编号：HT-2026-001');
    expect(model.blocks[0].type).toBe('kv');
    expect(model.blocks[2].text).toBe('本合同经双方签署后生效。');
    expect(model.blocks[2].type).toBe('text');
    for (const b of model.blocks) {
      expect(b.ocrConfidence).toBe(1.0);
      expect(b.bbox).toBeNull();
    }
  });

  it('ingestWithDigital keeps docx tables as GFM pipe rows (table_row blocks)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dc-docx-'));
    const f = join(dir, '报价.docx');
    await writeDocxFixture(f, {
      paragraphs: ['价格明细如下：'],
      table: [
        ['品名', '单价', '数量'],
        ['甲醇', '2450', '500'],
        ['乙二醇', '4380', '200'],
      ],
    });
    const model = await ingestWithDigital(f, '其他', 'DOC-4');
    const tableRows = model.blocks.filter((b) => b.type === 'table_row');
    // Header + GFM separator + 2 data rows = 4 pipe-row blocks.
    expect(tableRows).toHaveLength(4);
    expect(tableRows[0].text.startsWith('|')).toBe(true);
    expect(tableRows[0].text).toContain('品名');
    expect(tableRows[0].text).toContain('单价');
    expect(tableRows[2].text).toContain('甲醇');
    expect(tableRows[2].text).toContain('2450');
    // Cell values stay column-aligned (all data cells in the same row block).
    const cells = tableRows[3].text.split('|').filter((c) => c.trim().length > 0);
    expect(cells.map((c) => c.trim())).toEqual(['乙二醇', '4380', '200']);
  });

  it('ingestWithDigital throws on a corrupt .docx (not silently empty)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dc-docx-'));
    const f = join(dir, 'bad.docx');
    writeFileSync(f, 'not a zip archive', 'utf-8');
    await expect(ingestWithDigital(f, '合同', 'DOC-5')).rejects.toThrow();
  });
});
