import type { SpanMatchStrength } from './spanValidator.js';

export const CONFIDENCE_WEIGHTS = { w1: 0.4, w2: 0.4, w3: 0.2 } as const;

const STRENGTH_SCORE: Record<SpanMatchStrength, number> = {
  exact: 1.0,
  fuzzy: 0.7,
  none: 0.0,
};

export const REVIEW_THRESHOLD = 0.7;
export const AUTO_THRESHOLD = 0.9;
export const KEY_FIELD_THRESHOLD = 0.95;
export const KEY_FIELDS = new Set(['合同号', '发票号', '金额', '价税合计']);

export interface ConfidenceInput {
  blockOcrConfidence: number; // 0..1
  spanMatch: SpanMatchStrength;
  llmConsistency: number; // 0..1
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

export function computeFieldConfidence(input: ConfidenceInput): number {
  const { w1, w2, w3 } = CONFIDENCE_WEIGHTS;
  const raw =
    w1 * clamp01(input.blockOcrConfidence) +
    w2 * STRENGTH_SCORE[input.spanMatch] +
    w3 * clamp01(input.llmConsistency);
  return Math.round(raw * 1000) / 1000;
}

export function decisionForField(
  name: string,
  confidence: number,
): { needsReview: boolean; autoAccepted: boolean } {
  const threshold = KEY_FIELDS.has(name) ? KEY_FIELD_THRESHOLD : AUTO_THRESHOLD;
  return {
    needsReview: confidence < REVIEW_THRESHOLD,
    autoAccepted: confidence >= threshold,
  };
}
