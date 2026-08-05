import 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

// env.ts lives at server/src/env.ts -- the project-root .env is two levels up.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootEnvPath = path.resolve(__dirname, '../../.env');

dotenv.config({ path: rootEnvPath });

const EnvSchema = z.object({
  OPENAI_API_KEY: z.string().min(1, 'OPENAI_API_KEY is required'),
  OPENAI_BASE_URL: z
    .string()
    .url()
    .default('https://api.deepseek.com'),
  OPENAI_MODEL: z.string().min(1).default('deepseek-v4-flash'),
  PORT: z.coerce.number().int().positive().default(3001),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('[env] Invalid environment configuration:');
  console.error(parsed.error.flatten().fieldErrors);
  throw new Error(
    'Missing or invalid environment variables. Ensure the project root .env defines OPENAI_API_KEY etc.',
  );
}

export const env = parsed.data;
