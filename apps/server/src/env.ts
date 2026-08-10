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
