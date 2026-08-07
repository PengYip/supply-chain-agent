import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { normalizeMinerUOutput } from '../../src/pipeline/mineruAdapter.js';
import type { BlockModel } from '../../src/pipeline/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const load = (p: string) => JSON.parse(readFileSync(resolve(here, p), 'utf-8'));

/**
 * H2 real-sample integration test.
 *
 * `fixtures/mineru-real-slice.json` is a REDACTED 2-block slice of the ACTUAL
 * MinerU 3.4.4 pipeline-backend `<doc>_middle.json` output (captured via
 * `uvx --from 'mineru[pipeline]' --with six mineru -p <real.pdf> -b pipeline`,
 * 2026-08-07). The real PDF + raw full output are gitignored (real customer
 * data); only this redacted structural slice (content replaced with generic
 * values, exact bbox/score/type/structure preserved) is committed.
 *
 * This locks the adapter against the real MinerU 3.4.4 shape, which differs
 * from the earlier ASSUMED shape in three ways the assertions exercise:
 *   (1) text is in line.spans[].content (not line.text);
 *   (2) per-block `score` is the OCR confidence (no page-level statistics);
 *   (3) bbox is corner coordinates [x0,y0,x1,y1] -> BBox {x,y,w=x1-x0,h=y1-y0}.
 */
describe('normalizeMinerUOutput — real MinerU 3.4.4 shape', () => {
  it('parses spans[].content, per-block score, and corner-coord bbox', () => {
    const minerU = load('fixtures/mineru-real-slice.json');
    const model: BlockModel = normalizeMinerUOutput({
      docId: 'DOC-REAL-1',
      docType: '合同',
      sourceUri: 'file:///redacted.pdf',
      minerUOutput: minerU,
    });

    expect(model.modality).toBe('scanned');
    expect(model.blocks.length).toBe(2);

    // (1) text came from spans[].content (real shape), not line.text.
    expect(model.blocks[0].text).toBe('合同标题');
    expect(model.blocks[1].text).toBe('合同编号: DEMO-001');

    // (2) per-block score used as ocrConfidence; title block had score 0.9334.
    expect(model.blocks[0].ocrConfidence).toBeCloseTo(0.9334, 4);
    expect(model.blocks[1].ocrConfidence).toBeCloseTo(0.95, 4);
    for (const b of model.blocks) {
      expect(b.ocrConfidence).toBeGreaterThan(0);
      expect(b.ocrConfidence).toBeLessThanOrEqual(1);
      // (3) bbox present and converted from corners -> {x,y,w,h}.
      expect(b.bbox).not.toBeNull();
      expect(b.page).toBe(1);
    }

    // (3) corner->xywh conversion: title bbox [258,99,353,118] -> w=95, h=19.
    const t = model.blocks[0].bbox!;
    expect(t.x).toBe(258);
    expect(t.y).toBe(99);
    expect(t.w).toBe(353 - 258);
    expect(t.h).toBe(118 - 99);
  });
});
