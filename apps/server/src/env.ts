import 'node:url';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

// env.ts lives at apps/server/src/env.ts -- the project-root .env is three levels up.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootEnvPath = path.resolve(__dirname, '../../../.env');

dotenv.config({ path: rootEnvPath });

const EnvSchema = z.object({
  OPENAI_API_KEY: z.string().min(1, 'OPENAI_API_KEY is required'),
  OPENAI_BASE_URL: z
    .string()
    .url()
    .default('https://api.deepseek.com'),
  OPENAI_MODEL: z.string().min(1).default('deepseek-v4-flash'),
  PORT: z.coerce.number().int().positive().default(3001),
  // Filesystem root that ingest_document is allowed to read from. Enforced by
  // the injection-defense path allowlist (assertWithinRoot) so an attacker
  // cannot point the tool at ../../etc/passwd or any absolute path outside it.
  // Defaults to <cwd>/ingest-root; resolved to an absolute path at parse time.
  INGEST_ROOT: z.string().default(path.resolve(process.cwd(), 'ingest-root')),
  // Ollama embeddings endpoint for the L4 vector recall layer (Task 6 v2).
  // When unset, recall_documents/ingest use the deterministic test embedder and
  // real bge-m3 embeddings are deferred to deployment (no model pull needed).
  OLLAMA_BASE_URL: z.string().url().optional(),
  OLLAMA_EMBED_MODEL: z.string().default('bge-m3'),
  // Better Auth (Phase 1). secret signs session cookies/JWTs; in production set
  // a strong random value via .env. baseURL is the canonical origin (same :3001
  // as the Hono server in prod; the dev Vite proxy forwards /api/auth/* too).
  BETTER_AUTH_SECRET: z.string().default('dev-only-better-auth-secret-change-me'),
  BETTER_AUTH_URL: z.string().url().default('http://localhost:3001'),
  // MinIO object store (Phase 3) for uploaded source documents. The upload route
  // stores files under users/<userId>/ and bridges them into the ingest pipeline.
  MINIO_ENDPOINT: z.string().default('localhost'),
  MINIO_PORT: z.coerce.number().int().positive().default(9000),
  MINIO_ACCESS_KEY: z.string().default('minio'),
  MINIO_SECRET_KEY: z.string().default('miniosecret'),
  MINIO_BUCKET: z.string().default('sca-files'),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('[env] Invalid environment configuration:');
  console.error(parsed.error.flatten().fieldErrors);
  throw new Error(
    'Missing or invalid environment variables. Ensure the project root .env defines OPENAI_API_KEY etc.',
  );
}

// Ensure the ingest root exists so ingest_document can read from it. Idempotent
// and cheap; safe to run at module load.
mkdirSync(parsed.data.INGEST_ROOT, { recursive: true });

export const env = parsed.data;
