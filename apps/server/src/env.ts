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
  // SiliconFlow hosted embeddings (OpenAI-compatible /v1/embeddings). When the
  // API key is set it takes priority over Ollama in defaultEmbedder(): no local
  // model install needed (GPU-free). Defaults match SiliconFlow's bge-m3 offer.
  SILICONFLOW_API_KEY: z.string().optional(),
  SILICONFLOW_BASE_URL: z.string().url().default('https://api.siliconflow.cn'),
  SILICONFLOW_EMBED_MODEL: z.string().default('BAAI/bge-m3'),
  // Rerank model served by the same key/host (precision stage over hybrid
  // recall candidates). Active only when SILICONFLOW_API_KEY is set.
  SILICONFLOW_RERANK_MODEL: z.string().default('BAAI/bge-reranker-v2-m3'),
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
  /** Per-upload size ceiling in bytes. Default 25 MiB. CI-safe permissive
   *  default (only OPENAI_API_KEY is required). Enforced in the /api/files
   *  upload route BEFORE buffering the body (413). */
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(25 * 1024 * 1024),
  /** Per-tool execute timeout in ms (book Ch5:314 fault recovery). Default 120s.
   *  Applied in buildGatedTools via withToolTimeout — a tool that exceeds it
   *  returns a STRUCTURED {status:'error', reason:'tool_timeout'} result (not a
   *  throw) so the model can adapt next turn. CI-safe permissive default. */
  TOOL_TIMEOUT_MS: z.coerce.number().int().positive().default(120000),
  /** Agent loop caps (2026-08: configurable after "stuck after tool call"
   * reports). AGENT_MAX_STEPS caps streamText steps per user turn (stopWhen
   * stepCountIs); on the last allowed step tools are disabled and the model
   * is forced to produce a text closing (OpenCode MAX_STEPS_PROMPT pattern).
   * AGENT_FAILURE_THRESHOLD is the circuit breaker threshold: consecutive
   * tool failures OR identical (tool,args) repeat calls that trip it stop the
   * loop early. */
  AGENT_MAX_STEPS: z.coerce.number().int().positive().default(20),
  AGENT_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(3),
  /** Conversation-level history compaction (Codex/Pi auto-compact pattern).
   * When a run's total token usage crosses CONTEXT_WINDOW - RESERVE, old
   * turns are LLM-summarized and the boundary is stored in session metadata;
   * later turns send [summary + recent tail] instead of full history.
   * Deliberately NO round cap -- context is capped by tokens, not rounds. */
  AGENT_CONTEXT_WINDOW_TOKENS: z.coerce.number().int().positive().default(65536),
  AGENT_COMPACT_RESERVE_TOKENS: z.coerce.number().int().positive().default(16384),
  /** How many trailing messages survive a compaction verbatim. */
  AGENT_COMPACT_KEEP_MESSAGES: z.coerce.number().int().min(0).default(20),
  // Neo4j graph store (Phase 4 §7). The ONLY graph store — dev/CI/prod all
  // connect to the ubuntu-server Neo4j over the network. PASSWORD defaults to
  // '' so env.ts zod-parses cleanly in CI (which only injects OPENAI_API_KEY)
  // and unit tests that import env.ts; getDriver() fail-fast-throws at runtime
  // if PASSWORD is empty. Live-graph tests gate on describe.skipIf(!NEO4J_PASSWORD).
  NEO4J_URL: z.string().default('bolt://localhost:7687'),
  NEO4J_USER: z.string().default('neo4j'),
  NEO4J_PASSWORD: z.string().default(''),
  // CubeSandbox code execution (execute_code tool). Points at a deployed
  // CubeSandbox instance whose cube-api speaks the E2B-compatible REST protocol.
  // Defaults target the dev cluster on ubuntu-server; override via .env for prod.
  CUBE_API_URL: z.string().url().default('http://172.18.10.150:3040'),
  CUBE_SANDBOX_DOMAIN: z.string().default('cube.app'),
  CUBE_TEMPLATE_ALIAS: z.string().default('sca-code'),
  // Comma-separated list of additional trusted origins for Better Auth.
  // Needed when the app is accessed from a different host/IP than BETTER_AUTH_URL.
  TRUSTED_ORIGINS: z.string().optional(),
  // 本公司主体名单(逗号分隔): 四流方向判定基准。资金流按付款人/收款人、货物流
  // 按买方/卖方、发票流按开票方/受票方, 锚点命中名单一侧即判定 收/付(进/销)。
  // 消费端 split(',') 后交给 domain/flowDirection.parseSelfPartyNames。
  // 未配置时方向语义关闭(执行流水不物化), 不影响既有链路。
  SELF_PARTY_NAMES: z.string().optional(),
  // 启动抽取回填(接线闭环): 每次启动重新跑历史上抽取 pending/skipped/failed/NULL
  // 的已解析文档(上限条数), 把合同台账回填齐。0 = 禁用。
  EXTRACTION_BACKFILL_LIMIT: z.coerce.number().int().min(0).default(20),
  // LLM-as-judge eval (apps/server/eval/agent). Independent judge endpoint so
  // the judge can be a different model family than the agent (book Ch6: multi-
  // source judging avoids correlated blind spots). All optional; unset values
  // fall back to the main OPENAI_* model config.
  EVAL_JUDGE_BASE_URL: z.string().url().optional(),
  EVAL_JUDGE_API_KEY: z.string().optional(),
  EVAL_JUDGE_MODEL: z.string().optional(),
  // VLM (vision-language model) for image voucher parsing (Phase A: 图片凭证
  // VLM 解析分支). All optional: when unset, image-voucher ingest fails with an
  // explicit error instead of crashing startup. Keys are never hardcoded.
  VLM_BASE_URL: z.string().url().optional(),
  VLM_API_KEY: z.string().optional(),
  VLM_MODEL: z.string().default('qwen3.8-max'),
  VLM_TIMEOUT_MS: z.coerce.number().int().positive().default(180000),
  // Scanned-document OCR backend for parseDocument. 'mineru' (default) shells
  // out to the local MinerU CLI (CPU); 'qianfan' calls Baidu Qianfan's hosted
  // PaddleOCR-VL endpoint (needs QIANFAN_API_KEY, checked at call time not
  // boot). Both honor the <file>.{mineru,paddleocr}.json hermetic sidecars.
  PARSE_BACKEND: z.enum(['mineru', 'qianfan']).default('mineru'),
  // Baidu Qianfan PaddleOCR-VL endpoint credentials/settings. The key is never
  // hardcoded; it only reaches the adapter when PARSE_BACKEND=qianfan.
  QIANFAN_API_KEY: z.string().optional(),
  QIANFAN_OCR_URL: z.string().url().default('https://qianfan.baidubce.com/v2/ocr/paddleocr'),
  QIANFAN_TIMEOUT_MS: z.coerce.number().int().positive().default(300000),
  // 批量拆分器(spec 2026-09-01, Phase 1): 一个物理文件 ≠ 一份业务单据。
  // BATCH_SPLIT_ENABLED 是灰度总开关(默认关闭 = 完全走旧路径, 零行为变化)。
  // 注意不能用 z.coerce.boolean(): 它会把字符串 "false" 强转为 true。
  BATCH_SPLIT_ENABLED: z
    .preprocess((v) => v === 'true' || v === '1' || v === true, z.boolean())
    .default(false),
  // 逐页 VLM 版面清点的并发数(原型实测: 串行 8 页约 9 分钟, 并发 4 时墙钟
  // 约等于最慢一页)。
  BATCH_SPLIT_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(4),
  // 参与拆分检测的最大 PDF 页数上限: 超过则跳过拆分走旧路径(保护延迟与
  // VLM 用量; 现实多单据拼版远小于该值)。
  BATCH_SPLIT_MAX_PAGES: z.coerce.number().int().min(1).default(50),
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
