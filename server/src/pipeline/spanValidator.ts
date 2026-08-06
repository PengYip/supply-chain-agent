import type { Block, SourceSpan } from './types.js';

export type SpanMatchStrength = 'exact' | 'fuzzy' | 'none';

export interface SpanValidationResult {
  ok: boolean;
  strength: SpanMatchStrength;
  citedText: string | null;
  reason?: string;
}

// Normalize for matching: strip whitespace and full/half-width commas, lowercase.
const NORMALIZE = (s: string): string =>
  s.replace(/\s+/g, '').replace(/[,，]/g, '').toLowerCase();

export function validateSpan(
  value: string,
  span: SourceSpan,
  blocks: Block[],
): SpanValidationResult {
  const block = blocks.find((b) => b.id === span.blockId);
  if (!block) {
    return { ok: false, strength: 'none', citedText: null, reason: `block ${span.blockId} not found` };
  }
  const len = block.text.length;
  const start = Math.max(0, Math.floor(span.start));
  const end = Math.min(len, Math.floor(span.end));
  if (end <= start) {
    return { ok: false, strength: 'none', citedText: null, reason: `invalid span range [${span.start},${span.end}) in ${span.blockId}` };
  }
  const citedText = block.text.slice(start, end);
  const rawValue = String(value);
  const nv = NORMALIZE(rawValue);
  const nc = NORMALIZE(citedText);
  // exact: raw value matches cited text case-insensitively (no punctuation/format stripping).
  if (rawValue.toLowerCase() === citedText.toLowerCase()) {
    return { ok: true, strength: 'exact', citedText };
  }
  // fuzzy: match only after normalizing away whitespace/full+half-width commas/case.
  if (nc.length && nv.length && (nc === nv || nc.includes(nv) || nv.includes(nc))) {
    return { ok: true, strength: 'fuzzy', citedText };
  }
  return { ok: false, strength: 'none', citedText, reason: `value "${value}" not found in cited text "${citedText}"` };
}
