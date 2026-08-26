// Lane A (2a) -- auto-extraction step for the parse pipeline.
//
// Self-contained orchestration helper: extract -> persist -> stamp status.
// Fault-isolated by design -- a single document's extraction failure (model
// throw, timeout) is captured and surfaced as a non-throwing outcome so it can
// never kill the surrounding ingest pipeline. The two heavy-lift functions it
// calls (extractGroundedFields + saveExtraction) are injected as deps, so this
// module is fully testable with pure mocks and wireable by the orchestrator
// WITHOUT touching repositories.ts / extraction.ts.
//
// This is a pipeline helper, NOT an AI SDK tool (no inputSchema). AI SDK 6
// patterns are followed only indirectly via the injected extract dep; see
// extraction.ts for the canonical generateObject usage this wraps.

import type { BlockModel, DocType, SourceSpan } from './types.js';
import type { SpanMatchStrength } from './spanValidator.js';
import type { DbContext } from './db/client.js';
import { saveExtraction, setExtractionStatus, listTemplateTypes, type ProposedRelationship } from './db/repositories.js';
import { extractGroundedFields, type ExtractionDeps, type ExtractionResult } from './extraction.js';

/**
 * Fields record shape consumed by saveExtraction
 * (mirrors repositories.ExtractionInput.fields). Keyed by field name.
 */
export type AutoExtractionFields = Record<
  string,
  { value: string | number; sourceSpans: SourceSpan[] }
>;

/**
 * Per-field meta record shape consumed by saveExtraction
 * (mirrors repositories.ExtractionInput.fieldMeta). Keyed by field name.
 */
export type AutoExtractionFieldMeta = Record<
  string,
  { strength: SpanMatchStrength; confidence: number }
>;

/**
 * Result of the extract step: the post-conversion records handed to save.
 * The real extract dep wraps extractGroundedFields (which returns the
 * ExtractedField[] array + proposedRelationships) and performs the SAME
 * array->record conversion that the extract_fields tool does in
 * documentEntry.ts, so save receives exactly the shape it expects.
 */
export interface AutoExtractionResult {
  fields: AutoExtractionFields;
  fieldMeta: AutoExtractionFieldMeta;
  proposedRelationships: ProposedRelationship[];
}

/**
 * Injectable dependencies for runAutoExtraction. Each is a thin wrapper over a
 * shared pipeline function, keeping this module testable (pure mocks) and
 * wireable without editing the shared repo/extraction modules:
 *  - extract: wraps extractGroundedFields + the array->record conversion.
 *  - save:    wraps saveExtraction.
 *  - setStatus: optional review-status writer; the orchestrator supplies the
 *    real fn (e.g. a setDocumentReviewStatus helper). Always best-effort here --
 *    a setStatus throw never reclassifies an otherwise-ok outcome.
 */
export interface AutoExtractionDeps {
  extract: (blockModel: BlockModel) => Promise<AutoExtractionResult>;
  save: (args: {
    ctx: DbContext;
    docId: string;
    fields: AutoExtractionFields;
    fieldMeta: AutoExtractionFieldMeta;
    proposedRelationships: ProposedRelationship[];
    userId?: string;
  }) => Promise<void>;
  setStatus?: (args: {
    ctx: DbContext;
    docId: string;
    status: 'pending' | 'ok' | 'skipped' | 'failed';
    userId?: string;
  }) => Promise<void>;
}

/** Non-throwing outcome of runAutoExtraction. */
export interface AutoExtractionOutcome {
  status: 'ok' | 'skipped' | 'failed';
  reason?: string;
  fieldCount?: number;
  relationshipCount?: number;
}

/**
 * Default auto-extraction timeout (ms). Overridable per call (tests).
 *
 * 150s, not 60s: DeepSeek JSON-mode extraction over a scanned OCR contract
 * (10+ blocks, per-field sourceSpans) can legitimately exceed 60s. A premature
 * timeout silently kills extraction (runAutoExtraction's ONLY 'skipped' path),
 * leaving the review card with 暂无 fields. 150s stays comfortably under the
 * 180s chat-reference backstop cap (chat.ts).
 */
export const DEFAULT_AUTO_EXTRACTION_TIMEOUT_MS = 150_000;

/**
 * Sentinel thrown by the internal timeout timer. Using a distinct class (rather
 * than a plain Error with a magic message) avoids misclassifying a genuine
 * extract error whose message happens to contain 'timeout'.
 */
class AutoExtractionTimeout extends Error {
  constructor() {
    super('auto-extraction timed out');
    this.name = 'AutoExtractionTimeout';
  }
}

/**
 * Run one document's auto-extraction, fault-isolated.
 *
 * Flow: deps.extract -> deps.save -> deps.setStatus?.('ok').
 *  - On success returns { status:'ok', fieldCount, relationshipCount }.
 *  - On a thrown error from extract OR save returns { status:'failed', reason }
 *    (never rethrows).
 *  - On timeout returns { status:'skipped', reason:'timeout' }.
 *
 * setStatus is best-effort on every path: if it throws, the original outcome
 * classification is preserved (a status-stamp failure cannot flip an 'ok'
 * extraction into 'failed', nor mask a real failure reason).
 *
 * @param args.ctx         DB context (forwarded to deps.save / deps.setStatus).
 * @param args.docId       Target document id.
 * @param args.blockModel  Parsed BlockModel to extract from.
 * @param args.userId      Optional owning user (forwarded to deps).
 * @param args.deps        Injectable extract/save/setStatus wrappers.
 * @param args.timeoutMs   Per-call timeout override (ms); defaults to 60s.
 */
export async function runAutoExtraction(args: {
  ctx: DbContext;
  docId: string;
  blockModel: BlockModel;
  userId?: string;
  deps: AutoExtractionDeps;
  timeoutMs?: number;
}): Promise<AutoExtractionOutcome> {
  const { ctx, docId, blockModel, userId, deps } = args;
  const timeoutMs = args.timeoutMs ?? DEFAULT_AUTO_EXTRACTION_TIMEOUT_MS;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<AutoExtractionResult>((_, reject) => {
    timer = setTimeout(() => reject(new AutoExtractionTimeout()), timeoutMs);
  });

  try {
    const result = await Promise.race([deps.extract(blockModel), timeout]);

    await deps.save({
      ctx,
      docId,
      fields: result.fields,
      fieldMeta: result.fieldMeta,
      proposedRelationships: result.proposedRelationships,
      userId,
    });

    // Best-effort status stamp on success -- never reclassify on its failure.
    await deps.setStatus?.({ ctx, docId, status: 'ok', userId }).catch(() => {
      /* swallow: extraction already persisted; status is advisory */
    });

    return {
      status: 'ok',
      fieldCount: Object.keys(result.fields).length,
      relationshipCount: result.proposedRelationships.length,
    };
  } catch (e) {
    const isTimeout = e instanceof AutoExtractionTimeout;
    const stampStatus: 'skipped' | 'failed' = isTimeout ? 'skipped' : 'failed';
    // Best-effort status stamp on the failure/skip path too.
    await deps.setStatus?.({ ctx, docId, status: stampStatus, userId }).catch(() => {
      /* swallow: do not mask the real failure reason */
    });
    if (isTimeout) {
      return { status: 'skipped', reason: 'timeout' };
    }
    const reason = e instanceof Error ? e.message : String(e);
    return { status: 'failed', reason };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// --- Production deps factory ----------------------------------------------
//
// Builds real AutoExtractionDeps from a shared DbContext + ExtractionDeps (a
// LanguageModel handle), wiring the same extractGroundedFields + saveExtraction
// the extract_fields tool uses. This keeps runAutoExtraction itself free of any
// direct dependency on the extraction/repo modules (testable with pure mocks),
// while giving ingestFile a one-line wiring point.
//
// Closure stash: extract() must run before save() (runAutoExtraction guarantees
// this), and save() needs the full ExtractionResult (overallConfidence /
// needsReview / docType) that extract() produced. Those are stashed in factory-
// scope vars rather than re-threaded through the AutoExtractionDeps.save arg
// shape (which only carries the converted field records).

/**
 * Build production AutoExtractionDeps backed by extractGroundedFields +
 * saveExtraction + setExtractionStatus. The returned extract dep performs the
 * SAME ExtractedField[] -> Record conversion the extract_fields tool does in
 * documentEntry.ts:225-230, so save receives exactly the shape saveExtraction
 * expects.
 */
export function buildAutoExtractionDeps(args: {
  ctx: DbContext;
  extraction: ExtractionDeps;
  userId?: string;
}): AutoExtractionDeps {
  // Stash populated by extract(), read by save(). runAutoExtraction always calls
  // extract before save, so these are set by the time save runs.
  let stashed: { result: ExtractionResult; docType: DocType } | null = null;

  return {
    extract: async (blockModel) => {
      const templateTypes = await listTemplateTypes(args.ctx);
      const typeRow = templateTypes.find((t) => t.kind === 'doc_type' && t.name === blockModel.docType);
      const result = await extractGroundedFields(args.extraction, {
        blockModel,
        docType: blockModel.docType,
        requiredFields: Array.isArray(typeRow?.props.requiredFields) ? (typeRow.props.requiredFields as string[]) : undefined,
        fieldHints: typeof typeRow?.props.fieldHints === 'object' ? (typeRow.props.fieldHints as Record<string, string>) : undefined,
      });
      stashed = { result, docType: blockModel.docType };

      // ExtractedField[] -> saveExtraction record shapes (mirrors
      // documentEntry.ts:225-230).
      const fields: AutoExtractionFields = {};
      const fieldMeta: AutoExtractionFieldMeta = {};
      for (const f of result.fields) {
        fields[f.name] = { value: f.value, sourceSpans: f.sourceSpans };
        fieldMeta[f.name] = { strength: f.strength, confidence: f.confidence };
      }

      return {
        fields,
        fieldMeta,
        proposedRelationships: result.proposedRelationships,
      };
    },

    save: async ({ docId, fields, fieldMeta, proposedRelationships }) => {
      if (!stashed) {
        // Defensive: runAutoExtraction always calls extract first, so this is
        // unreachable in normal flow. Throw (caught by runAutoExtraction -> failed)
        // rather than silently writing a half-populated extraction.
        throw new Error('buildAutoExtractionDeps.save called before extract');
      }
      const { result, docType } = stashed;
      await saveExtraction(
        args.ctx,
        {
          documentId: docId,
          docType,
          fields,
          fieldMeta,
          overallConfidence: result.overallConfidence,
          // Zero-hallucination: empty LLM output stays needsReview (mirrors
          // documentEntry.ts:234).
          needsReview: result.needsReview || result.fields.length === 0,
          proposedRelationships,
        },
        args.userId,
      );
    },

    setStatus: async ({ docId, status }) => {
      await setExtractionStatus(args.ctx, docId, status, args.userId);
    },
  };
}
