// Phase 3+: file upload route + file manager. Authenticated users upload source
// documents; the file is stored in MinIO + a lightweight documents STUB row is
// created (parse_status='uploaded'). Model B: upload is STORAGE-ONLY — parsing
// (OCR / block extraction / chunking / indexing) runs on demand via
// POST /api/documents/:docId/process (triggered by 添加到对话), never at upload.
// List + presigned-GET are also scoped per user.
//
// File manager (Phase 3+):
//   - Upload accepts an optional `directory` field -> the MinIO key carries the
//     folder path: users/<userId>/<dir>/<uuid>-<filename>.
//   - After upload, documents.minio_key is stamped so the file list can attach a
//     docId to each listed object (with a source_uri LIKE fallback for legacy).
//   - PATCH /move relocates an object between folders (MinIO copy+remove + update
//     of documents.minio_key).
//   - POST /mkdir + DELETE /rmdir manage the user's virtual folder entries
//     (file_folders table). Folders are presentational -- the objects themselves
//     stay in MinIO regardless.
//
// Mounted at /api/files in index.ts. All routes require auth.

import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { Readable } from 'node:stream';
import type { AuthEnv } from '../lib/auth-middleware.js';
import { requireAuth } from '../lib/auth-middleware.js';
import { requireRole } from '../lib/auth-middleware.js';
import { minioClient, MINIO_BUCKET } from '../lib/minio.js';
import { env } from '../env.js';
import { getDbContext } from '../pipeline/db/dbBackend.js';
import type { DbContext } from '../pipeline/db/client.js';
import {
  setDocumentMinioKey,
  findDocIdsByMinioKeys,
  getBatchRolesForDocuments,
  listFileFolders,
  createFileFolder,
  deleteFileFolder,
  renameFileFoldersPrefix,
  listFileRanks,
  upsertFileRanks,
  deleteFileRank,
  setFolderSortOrders,
  deleteDocument,
  createDocumentStub,
  getDocumentParseStatus,
  getDocumentParseStages,
  getDocumentTypes,
  listDocumentIdsWithConfirmedBindings,
} from '../pipeline/db/repositories.js';
import type { DocType } from '../pipeline/types.js';
import { pdfHasTextLayer } from '../pipeline/digitalAdapter.js';
import { setModalityHint } from '../pipeline/modalityHints.js';

export const filesRoute = new Hono<AuthEnv>();
filesRoute.use('*', requireAuth);

// One DbContext per call -- getDbContext is itself a singleton in dbBackend
// (same 'pipeline.db' / DB as the agent, so ingested docs are immediately
// queryable by recall_documents). Per-call resolution keeps route modules
// testable against fresh per-test databases.
function ctx(): DbContext {
  return getDbContext();
}

const ALLOWED_DOCTYPES: ReadonlySet<string> = new Set(['合同', '发票', '提单', '装箱单', '其他']);

function strField(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}

/**
 * Normalize a user-supplied directory string: strip leading/trailing slashes and
 * collapse empty segments. Returns '' for the root. e.g. "/foo/bar/" -> "foo/bar".
 */
function normalizeDirectory(dir: string): string {
  return dir
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join('/');
}

/**
 * Pure guards for PATCH /folder-path (exported for unit tests).
 *  - empty `from` is meaningless; `to === from` is a no-op; moving a folder
 *    into its own subtree would orphan it. All three are rejected as 400.
 */
export function validateFolderPathChange(
  rawFrom: string,
  rawTo: string,
): { ok: true } | { ok: false; reason: 'empty_from' | 'same_path' | 'self_nested' } {
  const from = normalizeDirectory(rawFrom);
  const to = normalizeDirectory(rawTo);
  if (!from) return { ok: false, reason: 'empty_from' };
  if (to === from) return { ok: false, reason: 'same_path' };
  if (to.startsWith(`${from}/`)) return { ok: false, reason: 'self_nested' };
  return { ok: true };
}

/** path === from or lives inside the from subtree. */
export function isPathUnderFolder(path: string, from: string): boolean {
  return path === from || path.startsWith(`${from}/`);
}

/** Rewrite a MinIO object key `users/<uid>/<from>/...` onto the new folder prefix. */
export function rewriteKeyPrefix(key: string, userId: string, from: string, to: string): string {
  const prefix = `users/${userId}/${from}/`;
  if (!key.startsWith(prefix)) return key;
  return `users/${userId}/${to}/${key.slice(prefix.length)}`;
}

/**
 * Parse a MinIO object key into the display {name, directory} a file manager
 * needs. Key format: `users/<userId>/[<folder>/...]<uuid>-<filename>`.
 *   - name: the original filename (the `<uuid>-` prefix added at upload is a
 *     fixed 36-char UUID + '-', so it is stripped by slicing past index 37).
 *   - directory: the folder path between the user prefix and the filename,
 *     prefixed with '/'. '/' when the file lives at the user root.
 */
export function parseFileKey(key: string, userId: string): { name: string; directory: string } | null {
  const prefix = `users/${userId}/`;
  if (!key.startsWith(prefix)) return null;
  const rest = key.slice(prefix.length);
  const segments = rest.split('/');
  const lastSeg = segments.pop() ?? '';
  // Strip the `<uuid>-` prefix added at upload (randomUUID() is 36 chars + '-').
  const name = lastSeg.length > 37 ? lastSeg.slice(37) : lastSeg;
  const directory = segments.length > 0 ? '/' + segments.join('/') : '/';
  return { name, directory };
}

// MIME map for in-app streaming downloads. Extensions are derived from the final
// key segment, lowercased and matched without a leading dot. Anything unknown
// falls back to application/octet-stream (a safe default for blob URLs).
const EXTENSION_CONTENT_TYPES: Readonly<Record<string, string>> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ppt: 'application/vnd.ms-powerpoint',
  csv: 'text/csv',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  html: 'text/html',
  zip: 'application/zip',
};

/** Map a MinIO object key to a MIME type from its filename extension (the last
 *  dot in the final path segment, lowercase). Falls back to
 *  application/octet-stream when the key has no extension or it is unmapped. */
export function contentTypeForKey(key: string): string {
  const lastSeg = key.split('/').pop() ?? '';
  const dot = lastSeg.lastIndexOf('.');
  if (dot <= 0) return 'application/octet-stream';
  return (
    EXTENSION_CONTENT_TYPES[lastSeg.slice(dot + 1).toLowerCase()] ??
    'application/octet-stream'
  );
}

/** Pure predicate so the upload-size guard is unit-testable without allocating
 * a huge buffer. Returns true iff `size` strictly exceeds `limit`. */
export function exceedsUploadLimit(size: number, limit: number): boolean {
  return size > limit;
}

/** Upload a file -> MinIO -> INGEST_ROOT + create a storage-only documents stub. */
// Phase 4 RBAC: only admin/trader may upload files (viewer cannot).
filesRoute.post('/', requireRole('admin', 'trader'), async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);

  let body: Record<string, unknown>;
  try {
    body = (await c.req.parseBody()) as Record<string, unknown>;
  } catch {
    return c.json({ error: 'invalid multipart body' }, 400);
  }

  const file = body['file'];
  if (!(file instanceof File)) {
    return c.json({ error: 'no file provided (field "file")' }, 400);
  }

  // Reject oversized uploads BEFORE buffering the body (avoid allocating a
  // huge ArrayBuffer for a request we will refuse anyway).
  if (exceedsUploadLimit(file.size, env.MAX_UPLOAD_BYTES)) {
    return c.json(
      { error: 'file too large', limit: env.MAX_UPLOAD_BYTES, size: file.size },
      413,
    );
  }

  const docTypeStr = strField(body['docType'], '其他');
  const docType = (ALLOWED_DOCTYPES.has(docTypeStr) ? docTypeStr : '其他') as DocType;
  // modality is NOT consumed at upload time (Model B): parsing runs on demand
  // via POST /api/documents/:docId/process, which accepts modality then.
  const directory = normalizeDirectory(strField(body['directory'], ''));

  // Key carries the optional folder path so the file manager can render the tree
  // from object keys alone: users/<userId>/<dir>/<uuid>-<filename>.
  const dirPart = directory ? `${directory}/` : '';
  const key = `users/${user.id}/${dirPart}${randomUUID()}-${file.name}`;
  const buffer = Buffer.from(await file.arrayBuffer());
  // Flatten the slash-bearing key to a single filename (assertWithinRoot
  // requires the path to live directly under INGEST_ROOT). Declared outside the
  // try so the catch can clean it up on failure.
  const localPath = path.join(env.INGEST_ROOT, key.replace(/\//g, '_'));
  let minioStored = false;

  try {
    // 1. Store in MinIO.
    await minioClient.putObject(MINIO_BUCKET, key, buffer, buffer.length, {
      'Content-Type': file.type || 'application/octet-stream',
    });
    minioStored = true;

    // 2. Download into INGEST_ROOT so the parse path allowlist accepts it.
    await minioClient.fGetObject(MINIO_BUCKET, key, localPath);

    // 3. Model B: upload is STORAGE-ONLY. Create a lightweight documents stub
    //    (parse_status='uploaded') and return immediately. Parsing (OCR / block
    //    extraction) runs on demand via POST /api/documents/:docId/process, so an
    //    OCR failure on a scanned PDF never fails the upload. Stamp minio_key so
    //    the file list can attach this docId to the object without a LIKE scan.
    const { docId } = await createDocumentStub(ctx(), {
      sourceUri: localPath,
      minioKey: key,
      userId: user.id,
      filename: file.name,
      docType,
    });
    await setDocumentMinioKey(ctx(), docId, key);

    // Model C: predict digital vs scanned for PDFs NOW (cheap text-layer probe)
    // so /process can start with the right adapter. Probe failure is silent —
    // the response simply omits detectedModality and /process keeps its default.
    let detectedModality: 'digital' | 'scanned' | undefined;
    if (/\.pdf$/i.test(file.name)) {
      const hasText = await pdfHasTextLayer(buffer);
      if (hasText !== null) {
        detectedModality = hasText ? 'digital' : 'scanned';
        setModalityHint(docId, detectedModality);
      }
    }

    return c.json(
      {
        docId,
        filename: file.name,
        key,
        directory: directory ? '/' + directory : '/',
        // Echo the EFFECTIVE stored docType (after the ALLOWED_DOCTYPES fallback
        // above) so the client/model can narrate the same fact the stub holds.
        docType,
        parseStatus: 'uploaded',
        ...(detectedModality ? { detectedModality } : {}),
      },
      201,
    );
  } catch (e) {
    // Rollback: a failed upload must NOT leave an orphaned MinIO object, which
    // would appear in the file list with no docId and be un-addable to chat.
    // Best-effort cleanup -- never let cleanup errors mask the original failure.
    if (minioStored) {
      try { await minioClient.removeObject(MINIO_BUCKET, key); } catch { /* best-effort */ }
    }
    try { await fs.unlink(localPath); } catch { /* may not have been created */ }
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[files] upload failed:', msg);
    return c.json({ error: 'upload failed', detail: msg }, 500);
  }
});

/** List the current user's uploaded files + virtual folders. Each file carries
 *  `bound` (docId 是否有 confirmed 绑定) for the file-manager badge. */
// Phase 4 RBAC: admin/trader/viewer may list (read-only access for viewer).
filesRoute.get('/', requireRole('admin', 'trader', 'viewer'), async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const prefix = `users/${user.id}/`;
  const rawKeys: Array<{ key: string; size: number; lastModified?: string }> = [];
  const stream = minioClient.listObjectsV2(MINIO_BUCKET, prefix, true);
  try {
    for await (const obj of stream) {
      rawKeys.push({
        key: obj.name ?? '',
        size: obj.size ?? 0,
        lastModified: obj.lastModified?.toISOString(),
      });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: 'list failed', detail: msg }, 500);
  }

  // Attach docId to each object: batch-lookup by minio_key (with a source_uri
  // LIKE fallback for legacy rows). Lookup misses -> docId null.
  const docIdMap = await findDocIdsByMinioKeys(
    ctx(),
    rawKeys.map((f) => f.key),
    user.id,
  );
  const files = rawKeys.map((f) => {
    const parsed = parseFileKey(f.key, user.id);
    return {
      key: f.key,
      name: parsed?.name ?? f.key,
      size: f.size,
      lastModified: f.lastModified,
      docId: docIdMap.get(f.key) ?? null,
      directory: parsed?.directory ?? '/',
    };
  });

  // Model B (frontend contract): surface each file's parse lifecycle state.
  // null when the object has no document row (no docId). Per-doc reads are
  // fine here -- a user's file list is small and the lookup is indexed.
  const parseStatusByDoc = new Map<string, string | null>();
  await Promise.all(
    files.map(async (f) => {
      if (!f.docId) return;
      const status = await getDocumentParseStatus(ctx(), f.docId, user.id);
      parseStatusByDoc.set(f.docId, status ?? null);
    }),
  );
  // 阶段级解析进度(2026-09-01): parseStage ∈ detecting/ocr/extracting/indexing,
  // NULL=非解析中(终态/未开始); stageStartedAt 为阶段起始 ISO。批量一次查。
  const stagesByDoc = await getDocumentParseStages(
    ctx(),
    files.filter((f) => f.docId).map((f) => f.docId!),
    user.id,
  );
  // bound: docId 是否存在 ≥1 条 status='confirmed' 的绑定（仅有 proposed 不算）。
  const boundDocIds = new Set(await listDocumentIdsWithConfirmedBindings(ctx(), user.id));
  const filesWithStatus = files.map((f) => ({
    ...f,
    parseStatus: f.docId ? (parseStatusByDoc.get(f.docId) ?? null) : null,
    bound: f.docId ? boundDocIds.has(f.docId) : false,
    parseStage: f.docId ? (stagesByDoc.get(f.docId)?.parseStage ?? null) : null,
    stageStartedAt: f.docId ? (stagesByDoc.get(f.docId)?.stageStartedAt ?? null) : null,
  }));
  // Type tags only make sense once parsing has selected a concrete business
  // type. '其他' is the upload fallback and is omitted client-side so the tag
  // never implies recognition where none happened.
  const docTypes = await getDocumentTypes(
    ctx(),
    filesWithStatus.flatMap((f) => (f.docId && f.parseStatus === 'parsed' ? [f.docId] : [])),
    user.id,
  );
  // P3 谱系: container 文件条目带 unitCount(文件树展开 unit 层级用); 非 container
  // 恒 null, 前端以 batchRole === 'container' 判定。一次批量查询, 无逐文件读。
  const batchRoles = await getBatchRolesForDocuments(
    ctx(),
    filesWithStatus.filter((f) => f.docId).map((f) => f.docId!),
    user.id,
  );
  const filesWithMeta = filesWithStatus.map((f) => {
    const b = f.docId ? batchRoles.get(f.docId) : undefined;
    return {
      ...f,
      businessType:
        f.docId && f.parseStatus === 'parsed' ? (docTypes.get(f.docId) ?? null) : null,
      batchRole: b?.batchRole ?? null,
      unitCount: b?.batchRole === 'container' ? b.unitCount : null,
    };
  });

  // Virtual folders (presentational only; file objects live in MinIO regardless).
  // Already sorted by the repo (rank ASC, path ASC; unranked last).
  const folders = await listFileFolders(ctx(), user.id);

  // Apply manual drag-order ranks to files: ranked first in rank order, then
  // never-ranked rows by name. A user's rank table is tiny -- load it whole.
  const ranks = await listFileRanks(ctx(), user.id);
  const rankedKeys = [...ranks.keys()];
  const keyedFiles = new Map(filesWithMeta.map((f) => [f.key, f]));
  const orderedFiles: typeof filesWithMeta = [];
  for (const k of rankedKeys) {
    const f = keyedFiles.get(k);
    if (f) {
      orderedFiles.push(f);
      keyedFiles.delete(k);
    }
  }
  orderedFiles.push(...[...keyedFiles.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh')));

  return c.json({ files: orderedFiles, folders });
});

/** Persist a drag-to-sort result for one sibling group.
 *  Body {kind:'folders', paths:[fullPath,...]} -> sets each folder's rank to
 *  its array index. Body {kind:'files', keys:[minioKey,...]} -> upserts ranks
 *  keyed by object key. The client always sends the FULL group order, so the
 *  whole group becomes consistently ranked after any single drop. */
filesRoute.patch('/reorder', requireRole('admin', 'trader'), async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);

  let body: { kind?: unknown; paths?: unknown; keys?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }

  if (body.kind === 'folders') {
    if (!Array.isArray(body.paths)) return c.json({ error: 'paths must be an array' }, 400);
    const paths = body.paths.filter((p): p is string => typeof p === 'string').map((p) => normalizeDirectory(p));
    await setFolderSortOrders(ctx(), user.id, paths);
    return c.json({ ok: true });
  }

  if (body.kind === 'files') {
    if (!Array.isArray(body.keys)) return c.json({ error: 'keys must be an array' }, 400);
    const keys = body.keys.filter((k): k is string => typeof k === 'string');
    // Ownership: every key must live under this user's prefix.
    if (keys.some((k) => !k.startsWith(`users/${user.id}/`))) {
      return c.json({ error: 'forbidden' }, 403);
    }
    await upsertFileRanks(
      ctx(),
      user.id,
      keys.map((key, order) => ({ key, order })),
    );
    return c.json({ ok: true });
  }

  return c.json({ error: "kind must be 'folders' or 'files'" }, 400);
});

/** Move a file to a different directory (MinIO copy + remove + doc link update). */
filesRoute.patch('/move', requireRole('admin', 'trader'), async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);

  let body: { key?: unknown; directory?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }
  const key = typeof body.key === 'string' ? body.key : '';
  if (!key) return c.json({ error: 'missing key' }, 400);
  // Ownership: key must live under this user's prefix.
  if (!key.startsWith(`users/${user.id}/`)) {
    return c.json({ error: 'forbidden' }, 403);
  }
  const directory = normalizeDirectory(typeof body.directory === 'string' ? body.directory : '');

  // Reassemble: users/<userId>/<dir>/<original-last-segment>.
  const lastSeg = key.split('/').pop() ?? '';
  if (!lastSeg) return c.json({ error: 'invalid key' }, 400);
  const dirPart = directory ? `${directory}/` : '';
  const newKey = `users/${user.id}/${dirPart}${lastSeg}`;
  if (newKey === key) {
    return c.json({ key: newKey });
  }

  try {
    // 1. MinIO: copy to the new key, then remove the old object.
    await minioClient.copyObject(MINIO_BUCKET, newKey, `${MINIO_BUCKET}/${key}`);
    await minioClient.removeObject(MINIO_BUCKET, key);

    // 2. Re-link the document row to the new minio_key (if a doc was attached).
    const docIdMap = await findDocIdsByMinioKeys(ctx(), [key], user.id);
    const docId = docIdMap.get(key);
    if (docId) {
      await setDocumentMinioKey(ctx(), docId, newKey);
    }

    return c.json({ key: newKey });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[files] move failed:', msg);
    return c.json({ error: 'move failed', detail: msg }, 500);
  }
});

/** Create a virtual folder entry. Body: { path: "新文件夹" } -> 201. */
filesRoute.post('/mkdir', requireRole('admin', 'trader'), async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);

  let body: { path?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }
  const folderPath = normalizeDirectory(typeof body.path === 'string' ? body.path : '');
  if (!folderPath) return c.json({ error: 'missing path' }, 400);

  const id = await createFileFolder(ctx(), user.id, folderPath);
  return c.json({ id, path: folderPath }, 201);
});

/** Delete a virtual folder entry. ?path=新文件夹 -> 200. Files in the folder are
 *  left untouched in MinIO (the folder is presentational only). */
filesRoute.delete('/rmdir', requireRole('admin', 'trader'), async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);

  const rawPath = c.req.query('path') ?? '';
  const folderPath = normalizeDirectory(rawPath);
  if (!folderPath) return c.json({ error: 'missing path' }, 400);

  await deleteFileFolder(ctx(), user.id, folderPath);
  return c.json({ ok: true });
});

/**
 * Rename or relocate a virtual-folder subtree. Body: { from: "旧目录", to: "新家[/子]" }.
 * Rewrites every descendant path in file_folders and moves all MinIO objects
 * under users/<uid>/<from>/ onto the rewritten prefix. Documents re-link via
 * minio_key -> docId, and parse artifacts + graph bindings anchor on docId, so
 * they survive the move untouched. Mid-flight storage failures trigger a
 * best-effort reverse rollback -- same guarantee level as single-file /move.
 */
filesRoute.patch('/folder-path', requireRole('admin', 'trader'), async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);

  let body: { from?: unknown; to?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }
  const fromRaw = typeof body.from === 'string' ? body.from : '';
  const toRaw = typeof body.to === 'string' ? body.to : '';
  const guard = validateFolderPathChange(fromRaw, toRaw);
  if (!guard.ok) {
    return c.json({ error: 'invalid folder path change', reason: guard.reason }, 400);
  }
  const from = normalizeDirectory(fromRaw);
  const to = normalizeDirectory(toRaw);

  try {
    // 1. Conflict scan: an existing folder row would collide with a target.
    const allFolders = await listFileFolders(ctx(), user.id);
    const targetOf = (p: string) => to + p.slice(from.length);
    const existingTargets = new Set(
      allFolders.filter((f) => !isPathUnderFolder(f.path, from)).map((f) => f.path),
    );
    if (allFolders.some((f) => isPathUnderFolder(f.path, from) && existingTargets.has(targetOf(f.path)))) {
      return c.json({ error: 'target exists' }, 409);
    }

    // 2. Move MinIO objects: copy -> remove per object. Roll back what was done.
    const srcPrefix = `users/${user.id}/${from}/`;
    const done: Array<{ oldKey: string; newKey: string }> = [];
    try {
      const stream = minioClient.listObjectsV2(MINIO_BUCKET, srcPrefix, true);
      for await (const obj of stream) {
        const oldKey = obj.name ?? '';
        if (!oldKey.startsWith(srcPrefix)) continue;
        const newKey = rewriteKeyPrefix(oldKey, user.id, from, to);
        if (newKey === oldKey) continue;
        await minioClient.copyObject(MINIO_BUCKET, newKey, `${MINIO_BUCKET}/${oldKey}`);
        await minioClient.removeObject(MINIO_BUCKET, oldKey);
        done.push({ oldKey, newKey });
      }
    } catch (e) {
      // Reverse rollback of already-migrated objects (best-effort).
      for (const d of [...done].reverse()) {
        try {
          await minioClient.copyObject(MINIO_BUCKET, d.oldKey, `${MINIO_BUCKET}/${d.newKey}`);
          await minioClient.removeObject(MINIO_BUCKET, d.newKey);
        } catch {
          console.warn('[files] folder-path rollback step failed for', d.newKey);
        }
      }
      throw e;
    }

    // 3. Rewrite the virtual folder rows (single UPDATE, prefix math in SQL).
    const foldersRewritten = await renameFileFoldersPrefix(ctx(), user.id, from, to);

    // 4. Re-link document rows to their fresh keys (documents.minio_key still
    //    holds the OLD value here, so looking up by oldKey resolves correctly).
    for (const d of done) {
      const docIdMap = await findDocIdsByMinioKeys(ctx(), [d.oldKey], user.id);
      const docId = docIdMap.get(d.oldKey);
      if (docId) {
        await setDocumentMinioKey(ctx(), docId, d.newKey);
      }
    }

    return c.json({ ok: true, folders: foldersRewritten, objects: done.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[files] folder-path failed:', msg);
    return c.json({ error: 'folder-path failed', detail: msg }, 500);
  }
});

/** Delete a file: cascade-delete the DB document row + all dependents (chunks,
 *  fts, vec, extractions, classifications, bindings, document_tags) AND remove
 *  the MinIO object. Human-UI only (no agent tool). Ownership: the MinIO key
 *  must live under this user's prefix (mirror /move + /presign). The :key param
 *  carries the URL-encoded MinIO object key (slashes encoded so it is a single
 *  path segment). */
filesRoute.delete('/:key', requireRole('admin', 'trader'), async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const key = decodeURIComponent(c.req.param('key'));

  // Ownership guard: key must be under this user's prefix.
  if (!key.startsWith(`users/${user.id}/`)) {
    return c.json({ error: 'forbidden' }, 403);
  }

  // Resolve docId from the MinIO key (reuse the /move helper — it also handles
  // the source_uri LIKE fallback for legacy rows without a minio_key stamp).
  const docIdMap = await findDocIdsByMinioKeys(ctx(), [key], user.id);
  const docId = docIdMap.get(key);
  if (docId) {
    await deleteDocument(ctx(), docId, user.id);
  }
  // Always attempt the MinIO object removal (orphan cleanup even if no doc row).
  try {
    await minioClient.removeObject(MINIO_BUCKET, key);
  } catch (e) {
    // Log but don't 500 — the DB rows were already deleted (or never existed).
    console.warn('[files] minio removeObject failed for', key, (e as Error).message);
  }
  // Best-effort: drop any drag-order rank row left behind by the deleted object.
  try {
    await deleteFileRank(ctx(), user.id, key);
  } catch {
    // rank rows are cosmetic; never fail the delete over one.
  }
  return c.json({ ok: true, key, docId: docId ?? null });
});

/** Stream one of the current user's files through the app (in-app preview).
 *  Unlike GET /presign — which returns a 1h MinIO presigned URL that bypasses
 *  app authz (any holder of the bearer URL can read the object) — this route
 *  streams the object server-side under the session cookie, so an in-browser
 *  preview never depends on MinIO-presigned URLs. Same ownership model as
 *  /presign: key comes via query (?key=...) and must live under this user's
 *  prefix; any authenticated role may read (router-level requireAuth). */
filesRoute.get('/stream', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const key = c.req.query('key');
  if (!key) return c.json({ error: 'missing key' }, 400);
  // Ownership: key must live under this user's prefix.
  if (!key.startsWith(`users/${user.id}/`)) {
    return c.json({ error: 'forbidden' }, 403);
  }

  let obj;
  try {
    obj = await minioClient.getObject(MINIO_BUCKET, key);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[files] stream failed:', msg);
    return c.json({ error: 'stream failed', detail: msg }, 500);
  }

  // Derive the download filename from the key (strips the <uuid>- upload prefix
  // and any folder segments); fall back to the raw last segment if unparseable.
  const parsed = parseFileKey(key, user.id);
  const name = parsed?.name ?? key.split('/').pop() ?? key;

  // minio's getObject returns a Node Readable; bridge it to a WHATWG stream so
  // it can back a Response body directly (chunked, no full buffering).
  const webStream = Readable.toWeb(obj) as unknown as ReadableStream;
  return new Response(webStream, {
    headers: {
      'Content-Type': contentTypeForKey(key),
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(name)}`,
      'Cache-Control': 'no-store',
    },
  });
});

/** Presign a download URL for one of the current user's files. Key comes via
 *  query (?key=...) since object keys contain slashes (multi-segment path). */
filesRoute.get('/presign', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const key = c.req.query('key');
  if (!key) return c.json({ error: 'missing key' }, 400);
  // Ownership: key must live under this user's prefix.
  if (!key.startsWith(`users/${user.id}/`)) {
    return c.json({ error: 'forbidden' }, 403);
  }
  try {
    const url = await minioClient.presignedGetObject(MINIO_BUCKET, key, 3600);
    return c.json({ url });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: 'presign failed', detail: msg }, 500);
  }
});
