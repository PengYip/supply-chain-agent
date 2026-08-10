// MinIO client (Phase 3). Object store for uploaded source documents. The upload
// route puts files under `users/<userId>/<uuid>-<name>` (ownership by key prefix)
// and bridges them into the ingest pipeline by downloading into INGEST_ROOT.
//
// `ensureBucket()` is called once at server startup (index.ts). It is best-effort:
// if MinIO is unreachable in dev, uploads will 5xx but the rest of the server
// (auth/chat/recall) still works.

import { Client } from 'minio';
import { env } from '../env.js';

export const minioClient = new Client({
  endPoint: env.MINIO_ENDPOINT,
  port: env.MINIO_PORT,
  accessKey: env.MINIO_ACCESS_KEY,
  secretKey: env.MINIO_SECRET_KEY,
  useSSL: false,
});

export const MINIO_BUCKET = env.MINIO_BUCKET;

/**
 * Idempotent: create the bucket if it does not exist. Safe to call on every
 * startup. Logs + returns (not throws) on failure so a missing MinIO never blocks
 * server boot -- only uploads will fail later.
 */
export async function ensureBucket(): Promise<void> {
  try {
    const exists = await minioClient.bucketExists(MINIO_BUCKET);
    if (!exists) {
      await minioClient.makeBucket(MINIO_BUCKET);
      console.log(`[minio] created bucket '${MINIO_BUCKET}'`);
    }
  } catch (e) {
    console.warn(
      '[minio] ensureBucket failed; uploads will be unavailable until MinIO is reachable:',
      (e as Error).message,
    );
  }
}
