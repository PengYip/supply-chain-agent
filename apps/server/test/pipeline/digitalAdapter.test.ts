import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { blockModelFromText, ingestWithDigital } from '../../src/pipeline/digitalAdapter.js';
import { writeDocxFixture } from './fixtures/makeDocx.js';
import { writeXlsxFixture } from './fixtures/makeXlsx.js';

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

  it('ingestWithDigital extracts a plain .xlsx sheet as table_row pipe rows', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dc-xlsx-'));
    const f = join(dir, '装箱单.xlsx');
    await writeXlsxFixture(f, [
      {
        name: '明细',
        rows: [
          ['品名', '数量', '单位'],
          ['甲醇', 500, '吨'],
        ],
      },
    ]);
    const model = await ingestWithDigital(f, '装箱单', 'DOC-6');
    // Sheet heading + header row + GFM separator + 1 data row.
    const sheetHeading = model.blocks.find((b) => b.text === '## Sheet: 明细');
    expect(sheetHeading).toBeDefined();
    const tableRows = model.blocks.filter((b) => b.type === 'table_row');
    expect(tableRows).toHaveLength(3);
    const dataRow = tableRows[2].text;
    expect(dataRow).toContain('甲醇');
    expect(dataRow).toContain('500');
    expect(dataRow).toContain('吨');
  });

  it('ingestWithDigital expands merged header cells so every row stays column-aligned', async () => {
    // Irregular header, common shape in Chinese trade documents:
    //   row 1: merged title (A1:E1)
    //   row 2: header row 1 — '单价' spans two COLUMNS (C2:D2)
    //   row 3: header row 2 — '数量' spans two ROWS (B2:B3, value lives in B2)
    //   row 4: data row
    const dir = mkdtempSync(join(tmpdir(), 'dc-xlsx-'));
    const f = join(dir, '报价.xlsx');
    await writeXlsxFixture(f, [
      {
        name: '报价',
        rows: [
          ['商品报价单', '', '', '', ''],
          ['品名', '数量', '单价', '', '备注'],
          ['', '', '', '', ''],
          ['甲醇', 500, 2450, 2450, '含税'],
        ],
        merges: ['A1:E1', 'B2:B3', 'C2:D2'],
      },
    ]);
    const model = await ingestWithDigital(f, '其他', 'DOC-7');
    const rows = model.blocks.filter((b) => b.type === 'table_row').map((b) => b.text);
    // rows[0] merged title expanded across A..E; rows[1] is the GFM separator
    // (inserted after the first emitted row); rows[2..4] follow.
    expect(rows[0].startsWith('| 商品报价单 | 商品报价单 |')).toBe(true);
    expect(rows[1]).toMatch(/^\| --- \| --- \|/);
    // Header row 1: horizontal merge C2:D2 expanded -> '单价' fills both cols.
    expect(rows[2]).toContain('| 品名 | 数量 | 单价 | 单价 | 备注 |');
    // Header row 2: vertical merge B2:B3 expanded -> '数量' carried down.
    expect(rows[3]).toContain('| 数量 |');
    // Data row intact.
    expect(rows[4]).toContain('| 甲醇 | 500 | 2450 | 2450 | 含税 |');
    // Every row keeps the same column count (5 columns -> 6 pipes).
    for (const r of rows) {
      expect(r.split('|')).toHaveLength(7);
    }
  });

  it('ingestWithDigital rejects legacy .xls with a clear error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dc-xlsx-'));
    const f = join(dir, 'old.xls');
    writeFileSync(f, 'fake legacy binary', 'utf-8');
    await expect(ingestWithDigital(f, '其他', 'DOC-8')).rejects.toThrow(/另存为 .xlsx/);
  });
});
