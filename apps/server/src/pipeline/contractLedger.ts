// Contract ledger persistence layer: turns an ingest extraction into a lookup-
// keyed ledger entry (normalized contract_no) that the 合同台账 surfaces by
// contract number. Pure types + functions only -- no DB access here; the repo
// layer (db/repositories.ts) owns the rows.
import type { SourceSpan } from './types.js';
import type { SpanMatchStrength } from './spanValidator.js';
import type { ContractType } from '../domain/tradeSemantics.js';
import { firstNonEmpty } from './fieldValue.js';

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
  /** 主体视角合同类型(采购/销售/...), deriveContractType 派生; null = 未识别。 */
  contractType: ContractType | null;
  fields: Record<string, { value: string | number; sourceSpans: SourceSpan[] }>;
  fieldMeta: Record<string, { strength: SpanMatchStrength; confidence: number }>;
  /** Mean of fieldMeta confidences (0 when no fields). */
  overallConfidence: number;
  /** True when any field confidence < 0.7. */
  needsReview: boolean;
  /** Normalized: '' when the caller was unscoped. */
  userId: string;
}

/** 合同族 doc_type(2026-09-23 数据治理): 只有合同族单据拥有台账行的"合同口径"
 *  (doc_type/document_id/title/fields)。凭证类单据(货转单/磅单/结算单...)带
 *  合同号仍会建行(绑定/流水/图谱锚点都挂在行上), 但 ON CONFLICT 不得覆盖既有
 *  合同族行——否则后录入的运单会把真合同的类型/字段整体clobber成运单口径
 *  (dev 实测 5 行被污染)。本体台账投影(listContracts)也以此清单过滤。 */
export const CONTRACT_FAMILY_DOC_TYPES: readonly string[] = ['合同', '补充合同'];

/** 台账 upsert 守卫(SQL 片段, 2026-09-23 数据治理): 唯一禁止的更新方向 =
 *  既有合同族行被非合同族单据覆盖(凭证带合同号仍建锚点行, 但不得把真合同的
 *  doc_type/document_id/title/fields 整体clobber成运单口径, dev 实测 5 行被污染)。
 *  其余方向保持既有 upsert 语义: 合同→合同刷新 / 凭证→凭证刷新 /
 *  合同→凭证行 = 修复转化。PG/SQLite 均用小写别名(无引号标识符不区分大小写)。 */
export function contractLedgerUpsertWhere(): string {
  const list = CONTRACT_FAMILY_DOC_TYPES.map((t) => `'${t}'`).join(',');
  return `contract_ledger.doc_type NOT IN (${list}) OR excluded.doc_type IN (${list})`;
}

/**
 * Normalize a raw contract number into its canonical lookup form:
 * trim; full-width ASCII (U+FF01..U+FF5E) mapped back to half-width; full-width
 * space (U+3000) and all whitespace (incl. zero-width space U+200B) removed;
 * uppercased; only [A-Z0-9()-] kept, everything else dropped. Parentheses are
 * contract-number identity (e.g. '2021-ZNFXCG(T1)-010'), not OCR noise. ''
 * means "no usable contract number" (an extracted field that normalizes away
 * does not form an entry). Example:
 * ' ｃｊｘｃ－ｃｔｃｌ－ｊｙ－2024-131-01 ' -> 'CJXC-CTCL-JY-2024-131-01'.
 */
export function normalizeContractNo(raw: string): string {
  // Map full-width ASCII (U+FF01..U+FF5E) to its half-width equivalent so an
  // OCR'd '－'/'ｃ' keys identically to the typed '-'/'c'.
  let half = '';
  for (const ch of raw.trim()) {
    const code = ch.codePointAt(0)!;
    half += code >= 0xff01 && code <= 0xff5e ? String.fromCharCode(code - 0xfee0) : ch;
  }
  // Uppercase + keep only [A-Z0-9()-]. The single pass drops everything else:
  // full-width space (U+3000), all whitespace (incl. zero-width space U+200B),
  // and stray punctuation/illegal characters.
  return half.toUpperCase().replace(/[^A-Z0-9()-]/g, '');
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
  contractType?: ContractType | null;
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

  // Title: prefer 合同名称, fall back to 标的物, else ''. 空串保底字段不遮蔽回退链(spec 2026-08-28)。
  const titleSource = firstNonEmpty([args.fields['合同名称']?.value, args.fields['标的物']?.value]);
  const title = titleSource !== undefined ? String(titleSource) : '';

  return {
    contractNo,
    displayContractNo,
    docType: args.docType,
    documentId: args.documentId,
    title,
    contractType: args.contractType ?? null,
    fields: args.fields,
    fieldMeta: args.fieldMeta,
    overallConfidence: confidences.length
      ? confidences.reduce((sum, c) => sum + c, 0) / confidences.length
      : 0,
    needsReview: confidences.some((c) => c < 0.7),
    userId: args.userId && args.userId.length > 0 ? args.userId : '',
  };
}
