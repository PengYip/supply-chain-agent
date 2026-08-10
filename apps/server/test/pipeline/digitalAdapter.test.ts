import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { blockModelFromText, ingestWithDigital } from '../../src/pipeline/digitalAdapter.js';

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
});
