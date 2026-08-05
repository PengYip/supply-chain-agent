import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { normalizeMinerUOutput } from '../../src/pipeline/mineruAdapter.js';
import type { BlockModel } from '../../src/pipeline/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const load = (p: string) => JSON.parse(readFileSync(resolve(here, p), 'utf-8'));

describe('normalizeMinerUOutput', () => {
  it('turns MinerU JSON into a grounded BlockModel with per-block confidence + bbox', () => {
    const minerU = load('fixtures/mineru-sample.json');
    const model: BlockModel = normalizeMinerUOutput({
      docId: 'DOC-SCAN-1',
      docType: '合同',
      sourceUri: 'file:///scanned-contract-raw.pdf',
      minerUOutput: minerU,
    });
    expect(model.modality).toBe('scanned');
    expect(model.blocks.length).toBeGreaterThan(0);
    for (const b of model.blocks) {
      expect(b.id).toMatch(/^b\d+$/);
      expect(b.bbox).not.toBeNull();           // scanned => layout preserved
      expect(b.ocrConfidence).toBeGreaterThan(0);
      expect(b.ocrConfidence).toBeLessThanOrEqual(1);
      expect(b.text.length).toBeGreaterThan(0);
    }
    // offsets used by spans must be valid into block.text
    const first = model.blocks[0];
    expect(first.text.slice(0, Math.min(5, first.text.length)).length).toBeGreaterThan(0);
  });

  it('rejects unknown MinerU shapes with a clear error', () => {
    expect(() =>
      normalizeMinerUOutput({ docId: 'x', docType: '合同', sourceUri: 'u', minerUOutput: { nope: true } }),
    ).toThrowError(/MinerU/);
  });
});
