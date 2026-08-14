// In-card correction HITL endpoint (Feature).
//
// The user edits fields directly on the review card and submits; this executes
// the correction IMMEDIATELY (not model-mediated), reusing the SAME merge+write
// logic as the update_document_fields L2 tool (via applyDocumentCorrections, so
// the logic lives in ONE place). Also surfaces the previously-dead 'confirmed'
// review state via a { confirm: true } body.
//
// Mounted at /api/documents in index.ts, so the route below resolves to the
// final path: POST /api/documents/:docId/review. requireAuth-gated in index.ts
// (app.use('/api/documents/*', requireAuth)), so a user is always attached here.

import { Hono } from 'hono';
import type { AuthEnv } from '../lib/auth-middleware.js';
import { getDbContext } from '../pipeline/db/dbBackend.js';
import type { DbContext } from '../pipeline/db/client.js';
import {
  applyDocumentCorrections,
  getReviewSnapshot,
  setReviewStatus,
} from '../pipeline/db/repositories.js';
import { processDocument } from '../pipeline/tools/documentEntry.js';
import { defaultEmbedder } from './files.js';
import type { DocType, Modality } from '../pipeline/types.js';

export const reviewRoute = new Hono<AuthEnv>();

// Allowed docType hints (mirror of routes/files.ts). Used to validate the
// optional docType on POST /api/documents/:docId/process.
const ALLOWED_DOCTYPES: ReadonlySet<string> = new Set(['合同', '发票', '提单', '装箱单', '其他']);

// One DbContext reused across requests (same 'pipeline.db' file / DB as the
// agent + uploads, so corrections land where recall_documents / the review
// snapshot read them back). Same lazy-singleton shape as routes/files.ts.
let _ctx: DbContext | null = null;
function ctx(): DbContext {
  if (!_ctx) _ctx = getDbContext();
  return _ctx;
}

export interface CorrectionInput {
  name: string;
  value: string | number;
}

/**
 * POST /api/documents/:docId/review
 *
 * Apply human corrections directly from the review card (immediate execution,
 * no model round-trip), or confirm the extracted fields as-is.
 *
 * Request body (JSON):
 *   { corrections?: Array<{ name: string; value: string | number }>; confirm?: boolean }
 *
 * - corrections non-empty -> merge onto the latest extraction (corrected fields
 *   get confidence 1.0, strength 'none', cleared sourceSpans), flip
 *   reviewStatus to 'corrected', return the refreshed snapshot.
 * - confirm === true (and no corrections) -> flip reviewStatus to 'confirmed'
 *   (previously a dead state), return the snapshot.
 * - otherwise -> 400.
 *
 * Responses:
 *   200 { ok: true, docId, snapshot }
 *   400 { ok: false, error: 'provide corrections or confirm' }
 *   401 { error: 'unauthorized' }            (requireAuth, applied in index.ts)
 *   404 { ok: false, error: 'document_or_extraction_not_found' }
 *   500 { ok: false, error: <message> }
 */
reviewRoute.post('/:docId/review', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);

  let body: { corrections?: unknown; confirm?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'invalid JSON body' }, 400);
  }

  const docId = c.req.param('docId');

  // Validate corrections shape if present: each must be { name: string, value:
  // string|number }. Unknown/extra keys are ignored. Non-array -> 400.
  let corrections: CorrectionInput[] | null = null;
  if (Array.isArray(body.corrections)) {
    const parsed: CorrectionInput[] = [];
    for (const item of body.corrections) {
      if (!item || typeof item !== 'object') {
        return c.json({ ok: false, error: 'corrections[] entries must be { name, value } objects' }, 400);
      }
      const obj = item as Record<string, unknown>;
      const name = obj.name;
      const value = obj.value;
      if (typeof name !== 'string' || name.length === 0) {
        return c.json({ ok: false, error: 'each correction requires a non-empty name' }, 400);
      }
      if (typeof value !== 'string' && typeof value !== 'number') {
        return c.json({ ok: false, error: 'each correction value must be string or number' }, 400);
      }
      parsed.push({ name, value });
    }
    if (parsed.length > 0) corrections = parsed;
  }

  const confirm = body.confirm === true;

  try {
    let snapshot;
    if (corrections && corrections.length > 0) {
      // Immediate correction (not model-mediated). applyDocumentCorrections
      // returns null when no extraction exists for the doc (also covers a
      // missing doc) -> 404.
      snapshot = await applyDocumentCorrections(ctx(), docId, corrections, user.id);
      if (!snapshot) {
        return c.json({ ok: false, error: 'document_or_extraction_not_found' }, 404);
      }
    } else if (confirm) {
      // Confirm-as-is: flip reviewStatus to 'confirmed' (previously a dead
      // state — this makes it reachable) and return the unchanged snapshot.
      await setReviewStatus(ctx(), docId, 'confirmed', user.id);
      snapshot = await getReviewSnapshot(ctx(), docId, user.id);
      if (!snapshot) {
        return c.json({ ok: false, error: 'document_or_extraction_not_found' }, 404);
      }
    } else {
      return c.json({ ok: false, error: 'provide corrections or confirm' }, 400);
    }

    return c.json({ ok: true, docId, snapshot });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[review] correction failed:', msg);
    return c.json({ ok: false, error: msg }, 500);
  }
});

/**
 * POST /api/documents/:docId/process
 *
 * Model B: run the parse pipeline on an EXISTING upload stub
 * (parse_status='uploaded') on demand. Upload is storage-only; this is where
 * OCR / block extraction / chunking / indexing actually happen. Parse/OCR
 * failure becomes a STATE (parse_status='needs_ocr' / 'failed') in the response
 * body, NOT a thrown 500 — so the caller can react (e.g. prompt the user to
 * retry as 'scanned'). requireAuth-gated in index.ts (a user is always attached).
 *
 * Request body (JSON, all optional):
 *   { docType?: string; modality?: string }
 *   - docType: '合同'|'发票'|'提单'|'装箱单'|'其他' (default '其他')
 *   - modality: 'digital'|'scanned' (default 'digital')
 *
 * Responses (200):
 *   { ok: true, docId, parseStatus, blockCount, ... }
 *   parseStatus: 'parsed' | 'needs_ocr' | 'failed'
 *
 *   500 { ok: false, error: <message> }  (only for truly unexpected errors;
 *      processDocument itself returns states rather than throwing for OCR failure)
 */
reviewRoute.post('/:docId/process', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);

  let body: { docType?: unknown; modality?: unknown };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }

  const docId = c.req.param('docId');
  const docTypeStr = typeof body.docType === 'string' ? body.docType : '其他';
  const docType = (ALLOWED_DOCTYPES.has(docTypeStr) ? docTypeStr : '其他') as DocType;
  const modalityStr = typeof body.modality === 'string' ? body.modality : 'digital';
  const modality = (modalityStr === 'scanned' ? 'scanned' : 'digital') as Modality;

  try {
    const result = await processDocument(
      ctx(),
      docId,
      { docType, modality, embedder: defaultEmbedder() },
      user.id,
    );
    // result already carries docId, so spread it (docId, parseStatus, blockCount, ...).
    return c.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[review] process failed:', msg);
    return c.json({ ok: false, error: msg }, 500);
  }
});
