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
  listFileFolders,
  createFileFolder,
  deleteFileFolder,
  deleteDocument,
  createDocumentStub,
  getDocumentParseStatus,
} from '../pipeline/db/repositories.js';
import type { DocType } from '../pipeline/types.js';

export const filesRoute = new Hono<AuthEnv>();
filesRoute.use('*', requireAuth);

// One DbContext reused across uploads (same 'pipeline.db' file / DB as the agent,
// so ingested docs are immediately queryable by recall_documents).
let _ctx: DbContext | null = null;
function ctx(): DbContext {
  if (!_ctx) _ctx = getDbContext();
  return _ctx;
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
 * Parse a MinIO object key into the display {name, directory} a file manager
 * needs. Key format: `users/<userId>/[<folder>/...]<uuid>-<filename>`.
 *   - name: the original filename (the `<uuid>-` prefix added at upload is a
 *     fixed 36-char UUID + '-', so it is stripped by slicing past index 37).
 *   - directory: the folder path between the user prefix and the filename,
 *     prefixed with '/'. '/' when the file lives at the user root.
 */
function parseFileKey(key: string, userId: string): { name: string; directory: string } | null {
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

    return c.json(
      {
        docId,
        filename: file.name,
        key,
        directory: directory ? '/' + directory : '/',
        parseStatus: 'uploaded',
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

/** List the current user's uploaded files + virtual folders. */
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
  const filesWithStatus = files.map((f) => ({
    ...f,
    parseStatus: f.docId ? (parseStatusByDoc.get(f.docId) ?? null) : null,
  }));

  // Virtual folders (presentational only; file objects live in MinIO regardless).
  const folders = await listFileFolders(ctx(), user.id);

  return c.json({ files: filesWithStatus, folders });
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
