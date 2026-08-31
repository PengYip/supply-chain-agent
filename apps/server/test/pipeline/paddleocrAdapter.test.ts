import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { normalizeQianfanOutput, ingestWithPaddleOCR } from '../../src/pipeline/paddleocrAdapter.js';
import type { BlockModel } from '../../src/pipeline/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const load = (p: string) => JSON.parse(readFileSync(resolve(here, p), 'utf-8'));

describe('normalizeQianfanOutput — real Qianfan PaddleOCR-VL shape', () => {
  it('turns the Qianfan response into a grounded BlockModel with bbox + reading order', () => {
    const qianfan = load('fixtures/qianfan-real-slice.json');
    const model: BlockModel = normalizeQianfanOutput({
      docId: 'DOC-QF-1',
      docType: '发票',
      sourceUri: 'file:///invoice-raw.pdf',
      qianfanOutput: qianfan,
    });
    expect(model.modality).toBe('scanned');
    expect(model.docId).toBe('DOC-QF-1');
    expect(model.blocks.length).toBeGreaterThan(0);
    for (const b of model.blocks) {
      expect(b.id).toMatch(/^b\d+$/);
      expect(b.page).toBe(1); // single-page fixture -> 1-indexed page 1
      expect(b.bbox).not.toBeNull(); // scanned => layout preserved
      expect(b.ocrConfidence).toBeGreaterThan(0);
      expect(b.ocrConfidence).toBeLessThanOrEqual(1);
      expect(b.text.length).toBeGreaterThan(0);
    }
    // block types: image -> figure, everything else folds to text (table HTML kept)
    const fig = model.blocks.find((b) => b.type === 'figure');
    expect(fig).toBeDefined();
    expect(model.blocks.filter((b) => b.type === 'text').length).toBeGreaterThan(0);
    const table = model.blocks.find((b) => b.text.includes('<table'));
    expect(table).toBeDefined();
    expect(table?.text).toContain('买方示例能源有限公司'); // redacted real content survives
  });

  it('rejects unknown Qianfan shapes with a clear error', () => {
    expect(() =>
      normalizeQianfanOutput({ docId: 'x', docType: '合同', sourceUri: 'u', qianfanOutput: { nope: true } }),
    ).toThrowError(/Qianfan/);
  });
});

describe('ingestWithPaddleOCR — hermetic sidecar path', () => {
  let dir: string;
  let pdfPath: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'qianfan-'));
    pdfPath = join(dir, 'sample.pdf');
    writeFileSync(pdfPath, '%PDF-1.4 fake');
    writeFileSync(
      `${pdfPath}.paddleocr.json`,
      readFileSync(resolve(here, 'fixtures/qianfan-real-slice.json'), 'utf-8'),
    );
  });

  afterAll(() => {
    // temp dir cleanup is unnecessary for tests; OS tmp handles it.
  });

  it('reads the <file>.paddleocr.json sidecar without network or API key', async () => {
    // No QIANFAN_API_KEY in the test env: the sidecar path must not require it.
    const model = await ingestWithPaddleOCR(pdfPath, '发票', 'DOC-HERMETIC');
    expect(model.docId).toBe('DOC-HERMETIC');
    expect(model.modality).toBe('scanned');
    expect(model.blocks.length).toBeGreaterThan(0);
  });

  it('throws a config error (not a network call) when the key is missing and no sidecar exists', async () => {
    const noSidecar = join(dir, 'other.pdf');
    writeFileSync(noSidecar, '%PDF-1.4 fake');
    await expect(ingestWithPaddleOCR(noSidecar, '合同', 'DOC-NOKEY')).rejects.toThrowError(
      /QIANFAN_API_KEY/,
    );
  });
});
