import { describe, it, expect } from 'vitest';
import {
  computeFieldConfidence, decisionForField,
  REVIEW_THRESHOLD, AUTO_THRESHOLD, KEY_FIELD_THRESHOLD,
} from '../../src/pipeline/confidence.js';

describe('confidence model', () => {
  it('exact span + perfect OCR + high consistency => high confidence', () => {
    const c = computeFieldConfidence({ blockOcrConfidence: 1.0, spanMatch: 'exact', llmConsistency: 0.95 });
    expect(c).toBeGreaterThan(0.95);
  });

  it('none span => confidence bounded well below auto threshold regardless of OCR', () => {
    const c = computeFieldConfidence({ blockOcrConfidence: 1.0, spanMatch: 'none', llmConsistency: 0.9 });
    expect(c).toBeLessThan(AUTO_THRESHOLD);
  });

  it('key fields require KEY_FIELD_THRESHOLD, not AUTO_THRESHOLD', () => {
    const c = computeFieldConfidence({ blockOcrConfidence: 0.95, spanMatch: 'exact', llmConsistency: 0.9 });
    // c ~ 0.4*0.95 + 0.4*1 + 0.2*0.9 = 0.95  -> between AUTO(0.9) and KEY(0.95)
    const d = decisionForField('合同号', c);
    expect(d.autoAccepted).toBe(c >= KEY_FIELD_THRESHOLD);
    expect(d.needsReview).toBe(c < REVIEW_THRESHOLD);
  });

  it('non-key field auto-accepts at AUTO_THRESHOLD', () => {
    const c = computeFieldConfidence({ blockOcrConfidence: 1.0, spanMatch: 'exact', llmConsistency: 1.0 });
    const d = decisionForField('交货地', c);
    expect(d.autoAccepted).toBe(true);
  });
});
