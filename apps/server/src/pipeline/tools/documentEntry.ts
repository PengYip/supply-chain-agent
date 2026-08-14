import { tool } from 'ai';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';

import type { DbContext } from '../db/client.js';
import {
  saveDocument, loadDocument, saveExtraction, loadExtraction, saveBinding, saveChunks,
  saveClassification, saveDocumentTags, listDocumentTags, getReviewSnapshot,
  applyDocumentCorrections, setDocumentVectorization,
  // Model B (decouple upload from parse): stub + parse-lifecycle repo fns.
  getDocumentSourceUri, setDocumentParseStatus, getDocumentParseStatus, updateDocumentMeta,
  type ParseStatus,
  // Lane A (2a): extraction-status reader + extraction-row probe for
  // ensureDocumentExtracted's re-extraction decision.
  getExtractionStatus, loadLatestExtractionByDocId,
} from '../db/repositories.js';
import { parseDocument } from '../parseDocument.js';
import { extractGroundedFields, type ExtractionDeps } from '../extraction.js';
import { runAutoExtraction, buildAutoExtractionDeps } from '../autoExtraction.js';
import { tagChunks, type ChunkTagger } from '../chunkTagging.js';
import { getTaxonomy } from '../tag-taxonomy.js';
import { classifyDocument, classifyDocumentWithoutModel, type ClassifierDeps } from '../classifier.js';
import { deriveAutoTags } from '../tagging.js';
import { chunkBlockModel } from '../chunking.js';
import { linkDocumentToContract } from '../../data/seed.js';
import { tagExternal, assertWithinRoot } from '../../harness/injectionDefense.js';
import type { Embedder } from '../embedder.js';
import { isVecReady, saveChunkVectors } from '../db/vecStore.js';
import type { BlockModel, DocType, Modality, SourceSpan } from '../types.js';
import { validateSpan, type SpanMatchStrength } from '../spanValidator.js';

export interface ToolDeps {
  ctx: DbContext;
  extraction?: ExtractionDeps; // inject for extract_fields; defaults to real model
  /** Lane B: per-chunk semantic tagger. When set, ingest tags chunks against the
   *  docType's closed taxonomy (getTaxonomy); unset -> chunks stored untagged. */
  tagger?: ChunkTagger;
  /** Phase 2 routing-classify stage. When unset, ingest degrades to the
   *  caller-supplied docType hint (source 'hint', confidence 0). */
  classifier?: ClassifierDeps;
  /** Embedder for the L4 vector recall index (Task 6 v2). When unset OR when
   *  sqlite-vec is unavailable on the connection, ingest skips vector population
   *  and only the FTS5 keyword index (Task 6 v1) is populated. */
  embedder?: Embedder;
  /** Phase 2 business-data isolation: stamp + filter rows by this user. When
   *  unset or empty, the unscoped (legacy/test) path is used -- no filtering. */
  userId?: string;
}

/**
 * Outcome of the L4 vector-embedding step of ingest. Surfaced on the ingestFile
 * return so the model/UI can report whether vectorization succeeded and which
 * mode was used. `status`:
 *  - 'ok'      : vectors written for all chunks (mode = embedder.kind).
 *  - 'skipped' : no embedder wired, OR sqlite-vec unavailable on the connection
 *                (reason 'vec_store_not_ready'); FTS5 recall still serves.
 *  - 'failed'  : embedder threw; FTS5 recall still serves (reason = error message).
 */
export type VectorizationStatus = {
  status: 'ok' | 'skipped' | 'failed';
  mode: string;
  chunkCount: number;
  reason?: string;
};

const newDocId = () => `DOC-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

// T8 deviation from brief (per cross-task directive): T4's createDb omits the
// foreign_keys pragma, and SQLite defaults FK enforcement OFF. Without this,
// extractions/bindings could persist against a phantom document_id. Set it on
// the connection before any write. Idempotent and cheap. (Postgres enforces FKs
// by default, so this is a no-op on the postgres backend.)
function ensureFk(ctx: DbContext): void {
  if (ctx.backend === 'sqlite') {
    ctx.sqlite.pragma('foreign_keys = ON');
  }
}

/**
 * Reusable ingest pipeline (Phase 3 bridge): parse -> persist BlockModel ->
 * chunk -> index (FTS5 always; vectors when an embedder is wired and the vector
 * backend is ready). Called by BOTH the ingest_document tool and the /api/files
 * upload route so there is ONE ingest path. Returns the new docId + block count.
 */
export interface IngestOptions {
  ctx: DbContext;
  sourcePath: string;
  /** Caller hint. Classification determines the effective docType when a
   *  classifier is wired; otherwise this hint is used directly. Defaults to '其他'. */
  docType?: DocType;
  modality: Modality;
  classifier?: ClassifierDeps;
  embedder?: Embedder;
  /** Phase 2: owning user for the new document + its chunks. */
  userId?: string;
  /** Lane A (2a): when set, ingest runs auto-extraction (extractGroundedFields +
   *  saveExtraction) as a fault-isolated post-ingest stage. Unset -> skipped. */
  extraction?: ExtractionDeps;
  /** Lane B: per-chunk semantic tagger. When set + taxonomy non-empty, chunks are
   *  tagged against getTaxonomy(docType) and stored on doc_chunk.tags. */
  tagger?: ChunkTagger;
}

export async function ingestFile(opts: IngestOptions): Promise<{
  docId: string;
  blockCount: number;
  modality: string;
  classifiedDocType: DocType;
  classificationConfidence: number;
  classificationSource: 'classified' | 'hint' | 'fallback';
  tags: string[];
  vectorization: VectorizationStatus;
}> {
  const { ctx, sourcePath, docType, modality, embedder, classifier, userId, extraction, tagger } = opts;
  ensureFk(ctx);
  // Path allowlist (injection defense): reject anything outside INGEST_ROOT.
  const safePath = assertWithinRoot(sourcePath);
  const docId = newDocId();
  // Parse (pure, no DB) — extracted into parseDocument primitive (Phase 1).
  const blockModel = await parseDocument({ sourcePath: safePath, docType: docType ?? '其他', docId, modality });

  // Classify (Phase 2 routing-classify): parsed blocks -> effective docType.
  // Degrades to the hint when no classifier is wired (tests / dev offline).
  const cls = classifier
    ? await classifyDocument(classifier, { blocks: blockModel.blocks, hint: docType })
    : classifyDocumentWithoutModel({ blocks: blockModel.blocks, hint: docType });
  // The classified docType is the source of truth from here on (design §6:
  // routing-classify picks the docType used downstream).
  blockModel.docType = cls.docType;

  await saveDocument(ctx, blockModel, userId);
  await saveClassification(
    ctx,
    { documentId: docId, docType: cls.docType, confidence: cls.confidence, source: cls.source, hint: docType },
    userId,
  );
  const chunks = chunkBlockModel(blockModel);
  // Lane B: tag chunks against the (closed) docType taxonomy. tagChunks never
  // throws and short-circuits to all-null when the tagger is unset or the
  // taxonomy is empty (其他), so this degrades cleanly in tests / offline.
  const taxonomy = getTaxonomy(blockModel.docType);
  const chunkTagResult = tagger
    ? await tagChunks({ chunks: chunks.map((c) => ({ text: c.text })), taxonomy, tagger })
    : chunks.map(() => null);
  const chunkRowIds = await saveChunks(ctx, docId, chunks, chunkTagResult);
  let vectorization: VectorizationStatus = { status: 'skipped', mode: 'none', chunkCount: chunks.length };
  if (embedder) {
    if (await isVecReady(ctx)) {
      try {
        const vecs = await embedder.embed(chunks.map((c) => c.text));
        await saveChunkVectors(
          ctx,
          chunkRowIds.map((id, i) => ({ chunkRowId: id, vec: vecs[i] ?? [] })),
        );
        vectorization = { status: 'ok', mode: embedder.kind, chunkCount: chunks.length };
      } catch (e) {
        vectorization = {
          status: 'failed', mode: embedder.kind, chunkCount: chunks.length,
          reason: (e as Error).message,
        };
        console.warn('[ingest] vector embedding failed; FTS5 recall still available:', vectorization.reason);
      }
    } else {
      vectorization = { status: 'skipped', mode: embedder.kind, chunkCount: chunks.length, reason: 'vec_store_not_ready' };
    }
  }
  // Auto-tag (Phase 2): derive a small deterministic tag set from the effective
  // docType + content (design §8: auto-tags are an ingest byproduct, persisted
  // and included in the return summary). Explicit tags come from tag_document.
  // Fault-tolerant like the vector block above: by design a byproduct, so a
  // persistence failure degrades to an empty tag set instead of killing the
  // already-committed primary result. saveDocumentTags is now INSERT OR IGNORE /
  // ON CONFLICT DO NOTHING (Bug fix), so this catch only fires on GENUINE errors
  // (disk full, locked DB, schema mismatch) — logged at error level so real
  // failures are not silently swallowed.
  let tags: string[] = [];
  try {
    tags = deriveAutoTags({ docType: blockModel.docType, blocks: blockModel.blocks });
    await saveDocumentTags(ctx, docId, tags, 'auto', userId);
  } catch (e) {
    console.error('[ingest] auto-tag persistence failed:', (e as Error).message);
  }

  // Persist the vectorization outcome onto the document row (Bug fix: previously
  // only stored in an in-memory Map written by ingest_document, so it was lost
  // on restart and never written by the /api/files upload path — which calls
  // ingestFile directly — leaving present_document_review showing 'unknown').
  try {
    await setDocumentVectorization(ctx, docId, vectorization, userId);
  } catch (e) {
    console.error('[ingest] vectorization_meta persistence failed:', (e as Error).message);
  }

  // Lane A (2a): auto-extraction. Additive post-ingest stage: when a model is
  // wired, run extractGroundedFields + saveExtraction automatically so the
  // document is field-ready without an explicit extract_fields call. Fully
  // fault-isolated (runAutoExtraction never throws; failures -> 'failed' status
  // on the doc row), and wrapped here too for defense-in-depth. A failure never
  // blocks ingest -- the document stays searchable via FTS5 + vectors.
  if (extraction) {
    try {
      const outcome = await runAutoExtraction({
        ctx,
        docId,
        blockModel,
        userId,
        deps: buildAutoExtractionDeps({ ctx, extraction, userId }),
      });
      // Fault isolation is silent by design; surface non-ok outcomes (timeout /
      // model error) so a silently-missing extraction is never mistaken for success.
      if (outcome.status !== 'ok') {
        console.error(`[ingestFile] auto-extraction ${outcome.status}:`, outcome.reason ?? 'no reason');
      }
    } catch (e) {
      console.error('[ingestFile] auto-extraction failed:', (e as Error).message);
    }
  }

  // Model B: tool-created docs are fully parsed at the end of ingest, so stamp
  // parse_status='parsed' for consistency with the upload-then-process path.
  // Wrapped like the vectorization write above so a status write can't break ingest.
  try {
    await setDocumentParseStatus(ctx, docId, 'parsed', userId);
  } catch (e) {
    console.error('[ingest] parse_status persistence failed:', (e as Error).message);
  }

  return {
    docId,
    blockCount: blockModel.blocks.length,
    modality: blockModel.modality,
    classifiedDocType: cls.docType,
    classificationConfidence: cls.confidence,
    classificationSource: cls.source,
    tags,
    vectorization,
  };
}

// ---- Model B: on-demand parse of an upload stub ----------------------------
//
// Upload (POST /api/files) is STORAGE-ONLY: it creates a lightweight documents
// stub (parse_status='uploaded') and returns immediately. Parsing runs on demand
// when the document is referenced (添加到对话 triggers POST
// /api/documents/:docId/process; the chat route also backstops via
// ensureDocumentParsed). Parse/OCR failure becomes a STATE (parse_status
// 'needs_ocr' / 'failed'), NOT a thrown exception, so upload is never coupled to
// parsing.

/** Options for processDocument / ensureDocumentParsed (all deps optional). */
export interface ProcessDocumentOptions {
  docType?: DocType;
  modality?: Modality;
  embedder?: Embedder;
  classifier?: ClassifierDeps;
  extraction?: ExtractionDeps;
  tagger?: ChunkTagger;
  userId?: string;
}

export interface ProcessDocumentResult {
  docId: string;
  parseStatus: ParseStatus;
  blockCount?: number;
  classifiedDocType?: DocType;
  classificationConfidence?: number;
  classificationSource?: 'classified' | 'hint' | 'fallback';
  tags?: string[];
  vectorization?: VectorizationStatus;
  reason?: string;
}

/**
 * In-memory single-flight registry for parse runs, keyed by docId. Concurrent
 * callers (the /process endpoint + the chat backstop) share one run per doc so
 * a document is never parsed twice at the same time.
 */
const parseFlights = new Map<string, Promise<ProcessDocumentResult>>();

/** Terminal parse states: an already-terminal doc is never re-parsed. */
function isTerminalParseStatus(status: ParseStatus | null): boolean {
  return status === 'parsed' || status === 'needs_ocr';
}

/**
 * Parse a stub with a one-shot digital->scanned (MinerU OCR) retry. A 'digital'
 * parse that throws or yields 0 blocks is retried ONCE as 'scanned' before the
 * caller settles on 'needs_ocr'; an already-'scanned' parse that fails stays
 * failed. Throws the last parse error when both attempts fail.
 */
async function parseWithOcrRetry(
  sourceUri: string,
  docType: DocType,
  docId: string,
  modality: Modality | undefined,
): Promise<BlockModel> {
  const first = modality ?? 'digital';
  let lastError: unknown;
  const attempt = async (m: Modality): Promise<BlockModel | null> => {
    const model = await parseDocument({
      sourcePath: assertWithinRoot(sourceUri),
      docType,
      docId,
      modality: m,
    });
    return model.blocks.length > 0 ? model : null;
  };
  try {
    const m = await attempt(first);
    if (m) return m;
    lastError = new Error('文件解析得到 0 个内容块');
  } catch (e) {
    lastError = e;
  }
  // digital failed (0 blocks or threw): retry ONCE as scanned (MinerU OCR).
  if (first === 'digital') {
    try {
      const m = await attempt('scanned');
      if (m) return m;
      lastError = new Error('文件解析得到 0 个内容块');
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * On-demand parse of an EXISTING document stub (Model B). Upload creates a
 * lightweight documents row (parse_status='uploaded'); this fn runs the parse
 * pipeline against that stub when triggered by POST /api/documents/:docId/process
 * or by the chat backstop. OCR/parse failure becomes a STATE (parse_status
 * 'needs_ocr' / 'failed'), NOT a thrown exception — so upload is never coupled
 * to parsing. The ONLY thrown case is a missing doc row ('document_not_found').
 *
 * Mirrors ingestFile's body but operates on an EXISTING docId (the stub already
 * inserted by createDocumentStub), so it UPDATEs the row (updateDocumentMeta)
 * instead of INSERT-ing (saveDocument), and threads the same modern deps:
 * classifier, tagger (Lane B), embedder and auto-extraction (Lane A).
 */
export async function processDocument(
  ctx: DbContext,
  docId: string,
  opts: ProcessDocumentOptions = {},
): Promise<ProcessDocumentResult> {
  ensureFk(ctx);
  // 1. Resolve the stub's source path. A missing row is the one case that throws
  //    (the caller asked to process a doc that does not exist).
  const sourceUri = await getDocumentSourceUri(ctx, docId, opts.userId);
  if (!sourceUri) throw new Error('document_not_found');

  // 2. Mark parsing in progress.
  await setDocumentParseStatus(ctx, docId, 'parsing', opts.userId);

  // 3. Parse with a one-shot digital->scanned OCR retry. OCR failure -> a
  //    'needs_ocr' STATE (no throw), so upload/parse decoupling holds.
  let blockModel: BlockModel;
  try {
    blockModel = await parseWithOcrRetry(sourceUri, opts.docType ?? '其他', docId, opts.modality);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    await setDocumentParseStatus(ctx, docId, 'needs_ocr', opts.userId).catch(() => {});
    return { docId, parseStatus: 'needs_ocr', blockCount: 0, reason };
  }

  // Steps 4-12 mirror ingestFile's body; an unexpected error -> 'failed' STATE
  // (no throw — process-layer failures are states, not exceptions).
  try {
    // 4. Classify (Phase 2 routing-classify): parsed blocks -> effective docType.
    const cls = opts.classifier
      ? await classifyDocument(opts.classifier, { blocks: blockModel.blocks, hint: opts.docType })
      : classifyDocumentWithoutModel({ blocks: blockModel.blocks, hint: opts.docType });
    blockModel.docType = cls.docType;

    // 5. UPDATE the stub with the real docType/modality/block_model (replaces
    //    ingestFile's saveDocument INSERT).
    await updateDocumentMeta(
      ctx,
      docId,
      { docType: blockModel.docType, modality: blockModel.modality, blockModel },
      opts.userId,
    );

    // 6. Persist classification.
    await saveClassification(
      ctx,
      { documentId: docId, docType: cls.docType, confidence: cls.confidence, source: cls.source, hint: opts.docType },
      opts.userId,
    );

    // 7. Chunk + tag + save chunks (Lane B, same as ingestFile). tagChunks never
    //    throws and short-circuits to all-null when the tagger is unset or the
    //    taxonomy is empty (其他).
    const chunks = chunkBlockModel(blockModel);
    const taxonomy = getTaxonomy(blockModel.docType);
    const chunkTagResult = opts.tagger
      ? await tagChunks({ chunks: chunks.map((c) => ({ text: c.text })), taxonomy, tagger: opts.tagger })
      : chunks.map(() => null);
    const chunkRowIds = await saveChunks(ctx, docId, chunks, chunkTagResult);

    // 8. Vector block (verbatim from ingestFile).
    let vectorization: VectorizationStatus = { status: 'skipped', mode: 'none', chunkCount: chunks.length };
    if (opts.embedder) {
      if (await isVecReady(ctx)) {
        try {
          const vecs = await opts.embedder.embed(chunks.map((c) => c.text));
          await saveChunkVectors(
            ctx,
            chunkRowIds.map((id, i) => ({ chunkRowId: id, vec: vecs[i] ?? [] })),
          );
          vectorization = { status: 'ok', mode: opts.embedder.kind, chunkCount: chunks.length };
        } catch (e) {
          vectorization = {
            status: 'failed', mode: opts.embedder.kind, chunkCount: chunks.length,
            reason: (e as Error).message,
          };
          console.warn('[processDocument] vector embedding failed; FTS5 recall still available:', vectorization.reason);
        }
      } else {
        vectorization = { status: 'skipped', mode: opts.embedder.kind, chunkCount: chunks.length, reason: 'vec_store_not_ready' };
      }
    }

    // 9. Auto-tag (verbatim from ingestFile; fault-tolerant byproduct).
    let tags: string[] = [];
    try {
      tags = deriveAutoTags({ docType: blockModel.docType, blocks: blockModel.blocks });
      await saveDocumentTags(ctx, docId, tags, 'auto', opts.userId);
    } catch (e) {
      console.error('[processDocument] auto-tag persistence failed:', (e as Error).message);
    }

    // 10. Persist the vectorization outcome.
    try {
      await setDocumentVectorization(ctx, docId, vectorization, opts.userId);
    } catch (e) {
      console.error('[processDocument] vectorization_meta persistence failed:', (e as Error).message);
    }

    // 11. Lane A (2a): auto-extraction (fault-isolated; same as ingestFile).
    if (opts.extraction) {
      try {
        const outcome = await runAutoExtraction({
          ctx,
          docId,
          blockModel,
          userId: opts.userId,
          deps: buildAutoExtractionDeps({ ctx, extraction: opts.extraction, userId: opts.userId }),
        });
        // Surface non-ok outcomes (timeout / model error) so a silently-missing
        // extraction is never mistaken for success (processDocument discards the
        // outcome otherwise).
        if (outcome.status !== 'ok') {
          console.error(`[processDocument] auto-extraction ${outcome.status}:`, outcome.reason ?? 'no reason');
        }
      } catch (e) {
        console.error('[processDocument] auto-extraction failed:', (e as Error).message);
      }
    }

    // 12. Parsed.
    await setDocumentParseStatus(ctx, docId, 'parsed', opts.userId);

    return {
      docId,
      parseStatus: 'parsed',
      blockCount: blockModel.blocks.length,
      classifiedDocType: cls.docType,
      classificationConfidence: cls.confidence,
      classificationSource: cls.source,
      tags,
      vectorization,
    };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    await setDocumentParseStatus(ctx, docId, 'failed', opts.userId).catch(() => {});
    return { docId, parseStatus: 'failed', reason };
  }
}

/**
 * Single-flighted parse trigger (Model B). Safe to call from anywhere a docId is
 * referenced (the /process endpoint, the chat backstop):
 *  - a run already in flight for this docId -> await the SAME run (never double-parse);
 *  - terminal state ('parsed' | 'needs_ocr') -> return immediately (no re-parse);
 *  - 'uploaded' / 'failed' / missing -> start a run.
 * A missing doc row propagates 'document_not_found' from processDocument.
 */
export async function ensureDocumentParsed(
  ctx: DbContext,
  docId: string,
  opts: ProcessDocumentOptions = {},
  userId?: string,
): Promise<ProcessDocumentResult> {
  const fullOpts = userId ? { ...opts, userId } : opts;

  // 1. In-flight -> share the run (single-flight).
  const inFlight = parseFlights.get(docId);
  if (inFlight) return inFlight;

  // 2. Terminal -> no-op. 'needs_ocr' is a user-facing state the caller decides
  //    how to handle (e.g. tell the user honestly), never silently re-parsed.
  const status = await getDocumentParseStatus(ctx, docId, userId);
  if (isTerminalParseStatus(status)) {
    return { docId, parseStatus: status! };
  }

  // 3. Re-check the map AFTER the await: a concurrent caller may have started a
  //    run while we were reading the status. parseFlights.set runs synchronously
  //    right after processDocument() is invoked, so a second caller resuming
  //    later cannot slip in between the two.
  const started = parseFlights.get(docId);
  if (started) return started;

  // 4. 'uploaded' / 'failed' / 'parsing'-without-flight / missing -> start a run.
  const run = processDocument(ctx, docId, fullOpts).finally(() => {
    parseFlights.delete(docId);
  });
  parseFlights.set(docId, run);
  return run;
}

// ---- Model B: on-demand re-extraction --------------------------------------
//
// ensureDocumentExtracted ensures a doc is BOTH parsed and field-extracted. It
// reuses ensureDocumentParsed (single-flighted parse), then re-runs
// auto-extraction ONLY when extraction_status is 'skipped'/'failed' (e.g. the
// 60s timeout that killed DOC-msslpnju-vhm9's extraction) or when the doc has
// no extraction_status AND no extraction row. Otherwise it returns fast — the
// common case (already extracted) costs one status read + one extraction-row
// probe, no model call.

/** Result of ensureDocumentExtracted (additive extractionStatus for the API). */
export interface EnsureDocumentExtractedResult {
  docId: string;
  parseStatus: ParseStatus | 'needs_ocr';
  extractionStatus?: string;
}

/** In-memory single-flight registry for re-extraction runs (mirror parseFlights). */
const extractionFlights = new Map<string, Promise<EnsureDocumentExtractedResult>>();

/**
 * Ensure a document is parsed AND auto-extracted.
 *  - Step 1: ensureDocumentParsed (reuses the parse single-flight; propagates
 *    'document_not_found' for unknown docs).
 *  - Step 2: re-extract when extraction_status ∈ {'skipped','failed'} OR
 *    (extraction_status NULL AND no extraction row exists). Otherwise return fast.
 *  - Re-extraction is single-flighted (extractionFlights) and fault-isolated
 *    (runAutoExtraction never throws; wrapped for defense-in-depth).
 *  - `opts.extraction` is required to actually re-extract (both callers supply
 *    it via buildIngestDeps); when absent we return early with the status as-is.
 */
export async function ensureDocumentExtracted(
  ctx: DbContext,
  docId: string,
  opts: ProcessDocumentOptions = {},
  userId?: string,
): Promise<EnsureDocumentExtractedResult> {
  // 1. Ensure parsed (parse single-flight; document_not_found propagates).
  const parsed = await ensureDocumentParsed(ctx, docId, opts, userId);

  // In-flight re-extraction for this doc? Share it (single-flight).
  const inFlight = extractionFlights.get(docId);
  if (inFlight) return inFlight;

  // 2. Decide whether re-extraction is needed.
  const extractionStatus = await getExtractionStatus(ctx, docId, userId);
  const hasExtractionRow = (await loadLatestExtractionByDocId(ctx, docId, userId)) !== null;
  const needsReExtract =
    extractionStatus === 'skipped' ||
    extractionStatus === 'failed' ||
    (extractionStatus === null && !hasExtractionRow);

  if (!needsReExtract) {
    return {
      docId,
      parseStatus: parsed.parseStatus,
      extractionStatus: extractionStatus ?? undefined,
    };
  }

  // 3. Re-check the map AFTER the awaits: a concurrent caller may have started
  //    a re-extraction while we were reading status/rows.
  const started = extractionFlights.get(docId);
  if (started) return started;

  // 4. Re-extract (single-flighted; same body as processDocument step 11).
  const run = (async () => {
    const blockModel = await loadDocument(ctx, docId, userId);
    if (!blockModel) {
      // No block model -> nothing to extract; leave the status as-is.
      return { docId, parseStatus: parsed.parseStatus, extractionStatus: extractionStatus ?? undefined };
    }
    if (!opts.extraction) {
      return { docId, parseStatus: parsed.parseStatus, extractionStatus: extractionStatus ?? undefined };
    }
    try {
      const outcome = await runAutoExtraction({
        ctx,
        docId,
        blockModel,
        userId,
        deps: buildAutoExtractionDeps({ ctx, extraction: opts.extraction, userId }),
      });
      if (outcome.status !== 'ok') {
        console.error(`[ensureDocumentExtracted] auto-extraction ${outcome.status}:`, outcome.reason ?? 'no reason');
      }
    } catch (e) {
      console.error('[ensureDocumentExtracted] auto-extraction failed:', (e as Error).message);
    }
    // Read the final status (runAutoExtraction stamped ok/skipped/failed).
    const finalStatus = await getExtractionStatus(ctx, docId, userId);
    return {
      docId,
      parseStatus: parsed.parseStatus,
      extractionStatus: finalStatus ?? undefined,
    };
  })().finally(() => {
    extractionFlights.delete(docId);
  });
  extractionFlights.set(docId, run);
  return run;
}

export function buildIngestDocumentTool(deps: ToolDeps) {
  return tool({
    description:
      '录入一份原始单据(合同/发票/提单/装箱单)。解析文件为结构化 BlockModel 并持久化, ' +
      '内置分类器自动判定单据类型(docType 为可选提示, 分类器会确认或纠正)并打自动标签, ' +
      '返回 docId、分类结果(classifiedDocType / confidence / source)与标签。不抽取业务字段(用 extract_fields)。',
    inputSchema: z.object({
      sourceUri: z.string().min(1).describe('本地文件路径 (PDF/TXT/DOCX); scanned 还需配套 <sourceUri>.mineru.json'),
      docType: z.enum(['合同', '发票', '提单', '装箱单', '其他']).optional()
        .describe('可选的单据类型提示; 分类器会确认或纠正。省略时由分类器决定'),
      modality: z.enum(['digital', 'scanned']),
    }),
    execute: async ({ sourceUri, docType, modality }) => {
      const result = await ingestFile({
        ctx: deps.ctx,
        sourcePath: sourceUri,
        docType: docType as DocType | undefined,
        modality: modality as Modality,
        classifier: deps.classifier,
        embedder: deps.embedder,
        userId: deps.userId,
        extraction: deps.extraction,
        tagger: deps.tagger,
      });
      // Vectorization outcome is now persisted inside ingestFile (Bug fix), so
      // present_document_review reads it back via getReviewSnapshot — no in-memory
      // cache to populate (which was lost on restart / never written by uploads).
      return result;
    },
  });
}

export function buildExtractFieldsTool(deps: ToolDeps) {
  return tool({
    description:
      '从已录入单据(docId)中抽取业务字段。强制原文 span 接地: 每个值必须可在 BlockModel 原文中定位, 否则不自动接受。返回带置信度的字段集 + 是否需人工复核(needsReview)。',
    inputSchema: z.object({
      docId: z.string().min(1),
      docType: z.enum(['合同', '发票', '提单', '装箱单', '其他']),
    }),
    execute: async ({ docId, docType }) => {
      const blockModel = await loadDocument(deps.ctx, docId, deps.userId);
      if (!blockModel) return { status: 'error' as const, reason: 'document_not_found' };
      if (!deps.extraction) {
        return { status: 'error' as const, reason: 'extraction_model_not_configured' };
      }
      const result = await extractGroundedFields(deps.extraction, { blockModel, docType: docType as DocType });
      const fieldMeta: Record<string, { strength: SpanMatchStrength; confidence: number }> = {};
      const fields: Record<string, { value: string | number; sourceSpans: SourceSpan[] }> = {};
      for (const f of result.fields) {
        fields[f.name] = { value: f.value, sourceSpans: f.sourceSpans };
        fieldMeta[f.name] = { strength: f.strength, confidence: f.confidence };
      }
      ensureFk(deps.ctx);
      // Zero-hallucination directives:
      //  - empty LLM output (no fields) is surfaced as needsReview + reason, never a silent empty success.
      const needsReview = result.needsReview || result.fields.length === 0;
      const extractionId = await saveExtraction(
        deps.ctx,
        {
          documentId: docId,
          docType: docType as DocType,
          fields,
          fieldMeta,
          overallConfidence: result.overallConfidence,
          needsReview,
          proposedRelationships: result.proposedRelationships,
        },
        deps.userId,
      );
      // Bounded summary for the model trajectory. Full evidence (citedText,
      // sourceSpans) stays persisted via saveExtraction and is retrievable on
      // demand via inspect_extraction(extractionId, fieldName). The field VALUE
      // is the only document-derived string leaf exposed here, so wrap it in
      // <external_content> (injection defense: output-tagged).
      const summaryFields = result.fields.map((f) => ({
        name: f.name,
        value: typeof f.value === 'string' ? tagExternal(f.value) : f.value,
        confidence: f.confidence,
        needsReview: f.needsReview,
        autoAccepted: f.autoAccepted,
      }));

      return {
        extractionId,
        fields: summaryFields,
        overallConfidence: result.overallConfidence,
        needsReview,
        missingRequired: result.missingRequired,
        reason: result.fields.length === 0 ? 'no_fields_extracted' : undefined,
      };
    },
  });
}

/**
 * inspect_extraction — L1 perception tool.
 * On-demand evidence drill-down for a SINGLE already-extracted field.
 * Scope boundary: only fields that extract_fields already produced (given by
 * extractionId). NOT a general text-retrieval tool (use recall_documents for
 * arbitrary text). citedText is recomputed from persisted sourceSpans + the
 * loaded BlockModel via validateSpan, so the span validator stays the single
 * source of truth (citedText is never stored separately).
 */
export function buildInspectExtractionTool(deps: ToolDeps) {
  return tool({
    description:
      '查看某个已抽取字段的证据（原文片段 citedText 与 sourceSpans）。' +
      '仅限 extract_fields 已经抽取出的字段（用其返回的 extractionId）。' +
      '不要用它做任意文本检索（那应该用 recall_documents）。' +
      '使用场景：用户想看某字段值在原文哪里、或对抽取结果存疑需要取证时。',
    inputSchema: z.object({
      extractionId: z.string().min(1).describe('extract_fields 返回的 extractionId'),
      fieldName: z.string().min(1).describe('要查看证据的字段名，取自 extract_fields 返回 fields[].name'),
    }),
    execute: async ({ extractionId, fieldName }) => {
      const row = await loadExtraction(deps.ctx, extractionId, deps.userId);
      if (!row) return { status: 'error' as const, reason: 'extraction_not_found' as const };

      const field = row.fields[fieldName];
      if (!field) {
        return {
          status: 'error' as const,
          reason: 'field_not_found' as const,
          availableFields: Object.keys(row.fields),
        };
      }

      const blockModel = await loadDocument(deps.ctx, row.documentId, deps.userId);
      if (!blockModel) return { status: 'error' as const, reason: 'document_not_found' as const };

      // Recompute citedText from persisted spans + BlockModel (DRY): the span
      // validator stays the single source of truth. citedText is never stored.
      const meta = row.fieldMeta[fieldName];
      let citedText: string | null = null;
      let strength: SpanMatchStrength = meta?.strength ?? 'none';
      for (const span of field.sourceSpans) {
        const v = validateSpan(String(field.value), span, blockModel.blocks);
        if (v.citedText) {
          citedText = v.citedText;
          strength = v.strength;
          break;
        }
      }

      return {
        status: 'ok' as const,
        extractionId,
        fieldName,
        value: typeof field.value === 'string' ? tagExternal(field.value) : field.value,
        citedText: citedText ? tagExternal(citedText) : null,
        sourceSpans: field.sourceSpans,
        confidence: meta?.confidence ?? 0,
        strength,
      };
    },
  });
}

/**
 * tag_document — L2 explicit-tagging tool.
 * Adds user/agent-supplied labels to an EXISTING document, any time post-ingest.
 * Distinct from auto-tags (an ingest byproduct, source 'auto') and from graph
 * edges (link_entities, Step 4). Idempotent per (doc, tag, source='explicit'):
 * re-adding the same tag is a no-op. needsApproval (L2) because it mutates
 * business state (the agent must have user consent to label a document).
 */
export function buildTagDocumentTool(deps: ToolDeps) {
  return tool({
    description:
      '为已录入的单据打显式标签(用户/代理人工标注)。可在录入后任意时刻调用。' +
      '与 ingest 时自动生成的标签(来源 auto)不同, 这些标签来源为 explicit。' +
      '图关系(买方/卖方/引用)暂不支持, 将在后续工具中提供。' +
      '使用场景: 用户说"给这份合同打上 重要 / 客户A 标签"时。',
    inputSchema: z.object({
      docId: z.string().min(1).describe('目标单据 docId (来自 ingest_document 返回)'),
      tags: z.array(z.string().min(1)).min(1).describe('要添加的标签数组, 至少一个'),
    }),
    execute: async ({ docId, tags }) => {
      const blockModel = await loadDocument(deps.ctx, docId, deps.userId);
      if (!blockModel) return { status: 'error' as const, reason: 'document_not_found' as const };
      if (tags.length === 0) return { status: 'error' as const, reason: 'no_tags_provided' as const };

      ensureFk(deps.ctx);
      // Compute addedTags by diffing against existing explicit tags for this doc.
      const before = await listDocumentTags(deps.ctx, docId, deps.userId);
      const hadExplicit = new Set(
        before.filter((r) => r.source === 'explicit').map((r) => r.tag),
      );
      const addedTags = tags.filter((t) => !hadExplicit.has(t));
      await saveDocumentTags(deps.ctx, docId, tags, 'explicit', deps.userId);
      const after = await listDocumentTags(deps.ctx, docId, deps.userId);
      return {
        status: 'ok' as const,
        docId,
        addedTags,
        totalTags: after.length,
      };
    },
  });
}

export function buildBindDocumentTool(deps: ToolDeps) {
  return tool({
    description:
      '将已录入并抽取的单据绑定到业务实体(合同号)。L2 操作: 调用方需附带人工授权(needsApproval)。每条绑定记录来源 span 与置信度, 写入审计。',
    inputSchema: z.object({
      documentId: z.string().min(1),
      contractNo: z.string().min(1),
      relation: z.string().min(1).describe('关系类型, 1a 用 primary; 1c 扩展 logistics_for_contract 等'),
      confidence: z.number().min(0).max(1),
      sourceSpan: z.object({
        blockId: z.string(), start: z.number().int(), end: z.number().int(),
      }).describe('证明该绑定的原文 span'),
    }),
    execute: async ({ documentId, contractNo, relation, confidence, sourceSpan }) => {
      ensureFk(deps.ctx);
      const blockModel = await loadDocument(deps.ctx, documentId, deps.userId);
      if (!blockModel) return { ok: false as const, reason: 'document_not_found' };
      const bindingId = await saveBinding(
        deps.ctx,
        {
          documentId, contractNo, relation,
          sourceRefs: [sourceSpan], confidence, createdBy: 'trader-agent',
        },
        deps.userId,
      );
      // T8 deviation (per cross-task directive): bind extends the existing
      // link_document — also reflect the binding in the in-memory contract graph.
      const linkRes = linkDocumentToContract(contractNo, documentId);
      return { ok: true as const, bindingId, contractNo, documentId, linkedToContract: linkRes.ok };
    },
  });
}

/**
 * present_document_review — L1 presentation-first tool.
 * After ingest + extract, the model calls this to surface the post-ingest
 * "five-dimension review card" to the user: docType + classification confidence,
 * structured fields (with per-field confidence + needsReview), proposed
 * relationships, auto/explicit tags, and the vectorization status from ingest.
 * The assembled payload is what the frontend renders as a DocumentReviewCard.
 * This tool does NOT mutate data — it reads and presents. Registration into the
 * role registry / permission gate / contract happens in Task 8.
 */
export function buildPresentDocumentReviewTool(deps: ToolDeps) {
  return tool({
    description:
      '录入+抽取完成后向用户呈现「五维复核卡」: 业务类型、结构化字段(含置信度/需复核)、' +
      '待确认关系、文本TAG、向量化入库状态。一次单据录入成功后必须调用, 供用户逐项确认或纠正。' +
      '本工具仅用于展示与触发复核, 不改变已落库数据。',
    inputSchema: z.object({
      docId: z.string().min(1).describe('已录入单据的 docId'),
    }),
    execute: async ({ docId }) => {
      const snap = await getReviewSnapshot(deps.ctx, docId, deps.userId);
      if (!snap) return { status: 'error' as const, reason: 'document_not_found' };
      // Vectorization outcome now comes from the persisted documents row (Bug
      // fix: previously read an in-memory Map that the /api/files upload path
      // never populated and that was lost on restart — always showed 'unknown').
      return {
        docId: snap.docId,
        docType: snap.docType,
        classificationConfidence: snap.classificationConfidence,
        fields: snap.fields,
        overallConfidence: snap.overallConfidence,
        proposedRelationships: snap.proposedRelationships,
        tags: snap.tags,
        chunkTags: snap.chunkTags,
        chunkTagDetails: snap.chunkTagDetails,
        vectorization: snap.vectorization,
        reviewStatus: snap.reviewStatus,
      };
    },
  });
}

/**
 * update_document_fields - L2 correction tool.
 * After the user corrects fields on the review card (Task 9 UI), the model
 * calls this with { docId, corrections:[{name,value}] }. It loads the latest
 * extraction (full fields + fieldMeta), merges the corrections (un-corrected
 * fieldMeta is preserved -- confidence/span grounding survives; corrected
 * fields are overridden with confidence 1.0, human-confirmed, strength 'none'
 * and emptied sourceSpans since the value no longer derives from a source
 * span), writes back via updateExtractionFields, flips reviewStatus to
 * 'corrected', and returns the refreshed snapshot. L2 = soft gate: it only
 * runs after the user confirms a correction (the needsApproval literal is
 * stamped at registration in Task 8, mirroring bind_document -- NOT inlined
 * here so this builder stays registration-agnostic).
 */
export function buildUpdateDocumentFieldsTool(deps: ToolDeps) {
  return tool({
    description:
      '用户在复核卡上纠正字段后应用更正: 将纠正值合并到已抽取字段(保留未更正字段的置信度/原文span接地信息), ' +
      '更正字段置信度置1.0(人工确认)并标记 reviewStatus=corrected。需用户确认才执行(L2)。',
    inputSchema: z.object({
      docId: z.string().min(1),
      corrections: z.array(z.object({
        name: z.string().min(1),
        value: z.union([z.string(), z.number()]),
      })).min(1),
    }),
    execute: async ({ docId, corrections }) => {
      const exists = await getReviewSnapshot(deps.ctx, docId, deps.userId);
      if (!exists) return { status: 'error' as const, reason: 'document_not_found' };
      // Merge + write delegated to the shared applyDocumentCorrections (Feature:
      // in-card correction HITL route reuses the same logic). Returns null when
      // no extraction exists for the doc. Preserves the prior tool contract
      // (extraction_not_found) without duplicating the merge code here.
      const snapshot = await applyDocumentCorrections(deps.ctx, docId, corrections, deps.userId);
      if (!snapshot) return { status: 'error' as const, reason: 'extraction_not_found' };
      return {
        ok: true as const,
        docId,
        reviewStatus: 'corrected' as const,
        correctedFields: corrections.map((c) => c.name),
        snapshot,
      };
    },
  });
}
