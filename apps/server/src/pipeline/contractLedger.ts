// Contract ledger persistence layer: turns an ingest extraction into a lookup-
// keyed ledger entry (normalized contract_no) that the 合同台账 surfaces by
// contract number. Pure types + functions only -- no DB access here; the repo
// layer (db/repositories.ts) owns the rows.
import type { SourceSpan } from './types.js';
import type { SpanMatchStrength } from './spanValidator.js';

export interface ContractLedgerEntry {
  /** Normalized contract number (unique-key component). Non-empty. */
  contractNo: string;
  /** Raw extraction value of the contract-number field (as found in the doc). */
  displayContractNo: string;
  /** Doc type, e.g. '合同'. */
  docType: string;
  /** Id of the source document. */
  documentId: string;
  /** fields['合同名称'] or fields['标的物'] string value, else ''. */
  title: string;
  fields: Record<string, { value: string | number; sourceSpans: SourceSpan[] }>;
  fieldMeta: Record<string, { strength: SpanMatchStrength; confidence: number }>;
  /** Mean of fieldMeta confidences (0 when no fields). */
  overallConfidence: number;
  /** True when any field confidence < 0.7. */
  needsReview: boolean;
  /** Normalized: '' when the caller was unscoped. */
  userId: string;
}

/**
 * Normalize a raw contract number into its canonical lookup form:
 * trim; full-width ASCII (U+FF01..U+FF5E) mapped back to half-width; full-width
 * space (U+3000) and all whitespace (incl. zero-width space U+200B) removed;
 * uppercased; only [A-Z0-9-] kept, everything else dropped. '' means "no usable
 * contract number" (an extracted field that normalizes away does not form an
 * entry). Example: ' ｃｊｘｃ－ｃｔｃｌ－ｊｙ－2024-131-01 ' -> 'CJXC-CTCL-JY-2024-131-01'.
 */
export function normalizeContractNo(raw: string): string {
  // Map full-width ASCII (U+FF01..U+FF5E) to its half-width equivalent so an
  // OCR'd '－'/'ｃ' keys identically to the typed '-'/'c'.
  let half = '';
  for (const ch of raw.trim()) {
    const code = ch.codePointAt(0)!;
    half += code >= 0xff01 && code <= 0xff5e ? String.fromCharCode(code - 0xfee0) : ch;
  }
  // Uppercase + keep only [A-Z0-9-]. The single pass drops everything else:
  // full-width space (U+3000), all whitespace (incl. zero-width space U+200B),
  // and stray punctuation/illegal characters.
  return half.toUpperCase().replace(/[^A-Z0-9-]/g, '');
}

/**
 * Build a ledger entry from an extraction's fields. The contract number comes
 * from the field named '合同号' or '合同编号' (both present -> the higher
 * confidence wins). Returns null when neither field exists or when the chosen
 * value normalizes to '' (no contract number -> no ledger entry).
 */
export function buildLedgerEntryFromExtraction(args: {
  documentId: string;
  docType: string;
  fields: Record<string, { value: string | number; sourceSpans: SourceSpan[] }>;
  fieldMeta: Record<string, { strength: SpanMatchStrength; confidence: number }>;
  userId?: string;
}): ContractLedgerEntry | null {
  const contractNoField = ['合同号', '合同编号']
    .filter((name) => args.fields[name] !== undefined)
    // Descending confidence so [0] is the winner; ties keep 合同号 (listed
    // first, Array.prototype.sort is stable).
    .sort((a, b) => (args.fieldMeta[b]?.confidence ?? 0) - (args.fieldMeta[a]?.confidence ?? 0))[0];
  if (!contractNoField) return null;
  const displayContractNo = String(args.fields[contractNoField]!.value);
  const contractNo = normalizeContractNo(displayContractNo);
  if (!contractNo) return null;

  const confidences = Object.values(args.fieldMeta).map((m) => m.confidence);

  // Title: prefer 合同名称, fall back to 标的物, else ''.
  const titleSource = args.fields['合同名称'] ?? args.fields['标的物'];
  const title = titleSource !== undefined ? String(titleSource.value) : '';

  return {
    contractNo,
    displayContractNo,
    docType: args.docType,
    documentId: args.documentId,
    title,
    fields: args.fields,
    fieldMeta: args.fieldMeta,
    overallConfidence: confidences.length
      ? confidences.reduce((sum, c) => sum + c, 0) / confidences.length
      : 0,
    needsReview: confidences.some((c) => c < 0.7),
    userId: args.userId && args.userId.length > 0 ? args.userId : '',
  };
}
