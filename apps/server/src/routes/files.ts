// Phase 3: file upload route. Authenticated users upload source documents; the
// file is stored in MinIO under `users/<userId>/` (ownership by key prefix),
// downloaded into INGEST_ROOT, and run through the SAME ingest pipeline as the
// ingest_document tool (so recall_documents can find it). List + presigned-GET
// are also scoped per user.
//
// Mounted at /api/files in index.ts. All routes require auth.

import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { AuthEnv } from '../lib/auth-middleware.js';
import { requireAuth } from '../lib/auth-middleware.js';
import { requireRole } from '../lib/auth-middleware.js';
import { minioClient, MINIO_BUCKET } from '../lib/minio.js';
import { env } from '../env.js';
import { getDbContext } from '../pipeline/db/dbBackend.js';
import type { DbContext } from '../pipeline/db/client.js';
import { ingestFile } from '../pipeline/tools/documentEntry.js';
import type { DocType, Modality } from '../pipeline/types.js';
import { DeterministicEmbedder, OllamaEmbedder, type Embedder } from '../pipeline/embedder.js';

export const filesRoute = new Hono<AuthEnv>();
filesRoute.use('*', requireAuth);

// One DbContext reused across uploads (same 'pipeline.db' file / DB as the agent,
// so ingested docs are immediately queryable by recall_documents).
let _ctx: DbContext | null = null;
function ctx(): DbContext {
  if (!_ctx) _ctx = getDbContext();
  return _ctx;
}

// Match the agent's embedder choice so uploads get the same vector treatment.
function defaultEmbedder(): Embedder {
  return env.OLLAMA_BASE_URL
    ? new OllamaEmbedder({ baseUrl: env.OLLAMA_BASE_URL, model: env.OLLAMA_EMBED_MODEL })
    : new DeterministicEmbedder();
}

const ALLOWED_DOCTYPES: ReadonlySet<string> = new Set(['合同', '发票', '提单', '装箱单', '其他']);

function strField(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}

/** Upload a file -> MinIO -> INGEST_ROOT -> ingest pipeline. */
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

  const docTypeStr = strField(body['docType'], '其他');
  const docType = (ALLOWED_DOCTYPES.has(docTypeStr) ? docTypeStr : '其他') as DocType;
  const modalityStr = strField(body['modality'], 'digital');
  const modality = (modalityStr === 'scanned' ? 'scanned' : 'digital') as Modality;

  const key = `users/${user.id}/${randomUUID()}-${file.name}`;
  const buffer = Buffer.from(await file.arrayBuffer());

  try {
    // 1. Store in MinIO.
    await minioClient.putObject(MINIO_BUCKET, key, buffer, buffer.length, {
      'Content-Type': file.type || 'application/octet-stream',
    });

    // 2. Download into INGEST_ROOT so the ingest path allowlist accepts it.
    // Flatten the slash-bearing key to a single filename (assertWithinRoot
    // requires the path to live directly under INGEST_ROOT).
    const localPath = path.join(env.INGEST_ROOT, key.replace(/\//g, '_'));
    await minioClient.fGetObject(MINIO_BUCKET, key, localPath);

    // 3. Ingest: parse -> persist BlockModel -> chunk -> index (FTS5 + vectors).
    const result = await ingestFile({
      ctx: ctx(),
      sourcePath: localPath,
      docType,
      modality,
      embedder: defaultEmbedder(),
    });

    return c.json(
      {
        docId: result.docId,
        filename: file.name,
        key,
        blockCount: result.blockCount,
        modality: result.modality,
      },
      201,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[files] upload/ingest failed:', msg);
    return c.json({ error: 'upload or ingest failed', detail: msg }, 500);
  }
});

/** List the current user's uploaded files (metadata only). */
// Phase 4 RBAC: admin/trader/viewer may list (read-only access for viewer).
filesRoute.get('/', requireRole('admin', 'trader', 'viewer'), async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const prefix = `users/${user.id}/`;
  const files: Array<{ name: string; size: number; lastModified?: string }> = [];
  const stream = minioClient.listObjectsV2(MINIO_BUCKET, prefix, true);
  try {
    for await (const obj of stream) {
      files.push({
        name: obj.name ?? '',
        size: obj.size ?? 0,
        lastModified: obj.lastModified?.toISOString(),
      });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: 'list failed', detail: msg }, 500);
  }
  return c.json({ files });
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
