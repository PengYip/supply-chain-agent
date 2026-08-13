# AGENTS.md

Guidance for AI agents working in this repo. Read once before touching code.

## What this is

Privately-deployed enterprise AI agent for commodity supply-chain trading
(energy / chemicals / metals). Core value prop = a **business-semantic action
layer**: natural language maps to auditable tool calls, never free-form numbers.
Stack: Vite + React 19 frontend; Hono + Vercel AI SDK 6 backend; DeepSeek (dev)
/ Qwen (prod) models; SQLite (default) / Postgres+pgvector (prod target).

## Repo layout — trust this over ARCHITECTURE.md

npm workspaces under `apps/*`. **`ARCHITECTURE.md` and `docs/context-handoff.md`
predate the workspace move** — they describe a root `src/` (frontend) and
`server/` (backend) that no longer exist. The real layout:

- `apps/web/` — Vite + React 19 + TS + Tailwind frontend (`@sca/web`)
- `apps/server/` — Hono + AI SDK 6 backend (`@sca/server`), all server code
- `apps/server/src/index.ts` — Hono entrypoint (single source of truth for wiring)
- `apps/server/src/env.ts` — zod-validated env contract (SSOT for env vars)
- `apps/server/src/{harness,routes,tools,pipeline,lib,telemetry,data}/` — backend modules
- `apps/server/test/` — vitest tests (`test/harness/`, `test/pipeline/`)
- `apps/server/eval/` — eval harness (`npm run eval` runs `eval/run.ts`)
- `docs/` — runbooks (postgres migration) + context-handoff; `ARCHITECTURE.md` at root
- root `server/` — **empty, ignore it**

`ARCHITECTURE.md` is still authoritative for product principles, the L1/L2/L3
permission model, HITL shapes, and the AI SDK 6 migration notes (Appendix D).
Only its path examples are stale.

## Commands

Run from repo root unless noted.

| Task | Command |
|---|---|
| Install | `npm install` (root, bootstraps both workspaces) |
| Dev frontend only | `npm run dev` |
| Dev backend only (tsx watch) | `npm run dev:server` |
| Dev both (concurrently) | `npm run dev:all` |
| Build everything | `npm run build` (web `tsc -b && vite build`, server `tsc`) |
| Lint | `npm run lint` (oxlint, root) |
| All tests | `npm test` (runs server vitest) |
| Single test file | `npm test --workspace apps/server -- test/harness/foo.test.ts` |
| Tests watch mode | `npm run test:watch --workspace apps/server` |
| Eval harness | `npm run eval --workspace apps/server` (tsx eval/run.ts) |

Required order before claiming done: **build → lint → test** (matches CI).

Frontend dev server is on `:5173` and proxies `/api` → `localhost:3001`
(configured in `apps/web/vite.config.ts`). Do not start a second frontend dev
server if one is already running.

## Environment

The backend reads the **project-root `.env`** (shared with frontend), not
`apps/server/.env`. `apps/server/.env.example` is only a template.

`apps/server/src/env.ts` is the authoritative env contract (zod-validated at
boot). Required and notable vars:

- `OPENAI_API_KEY` — **required**, zod throws without it. CI sets a dummy key
  because unit tests import `env.ts` but never call the API.
- `OPENAI_BASE_URL` (default DeepSeek), `OPENAI_MODEL` (default
  `deepseek-v4-flash`; if you get "model not found", switch to `deepseek-chat`).
- `PORT` (default 3001), `INGEST_ROOT`, `TRUSTED_ORIGINS`.
- Better Auth: `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`.
- MinIO (file uploads): `MINIO_ENDPOINT/PORT/ACCESS_KEY/SECRET_KEY/BUCKET`.
- Embeddings (vector recall): `OLLAMA_BASE_URL` (optional; unset → deterministic
  test embedder, no model pull).
- Code sandbox: `CUBE_API_URL/CUBE_SANDBOX_DOMAIN/CUBE_TEMPLATE_ALIAS`.
- Langfuse (OTel): `LANGFUSE_BASE_URL/PUBLIC_KEY/SECRET_KEY`.
- Postgres path: `DATABASE_URL`, `DB_BACKEND=postgres` (also enables the 11
  Postgres integration tests, which otherwise skip).

Switching DeepSeek → Qwen is env-only; do not change code.

## Backend notes that bite if missed

- **Instrumentation first.** `apps/server/src/index.ts` imports
  `./instrumentation.js` as its very first line. OTel/Langfuse must init before
  the AI SDK loads — do not reorder.
- **Auth owns the API surface.** Better Auth handles `/api/auth/*`.
  `attachSession` runs on every request; `requireAuth` guards `/api/chat`,
  `/api/sessions`, `/api/approval`. `/api/health` stays public. Add new
  protected routes under those mounts or wire `requireAuth` explicitly.
- **Dual DB, intentionally different tooling.** SQLite is the default runtime
  and uses **raw idempotent DDL** in `src/pipeline/db/client.ts` (no
  drizzle-kit). The Postgres path uses **drizzle-kit** against
  `src/pipeline/db/postgres-schema.ts` + `src/lib/auth-schema.ts`, config in
  `apps/server/drizzle.config.ts` (lives outside `src/` so it stays out of
  `tsc`). `migrateOnStartup()` runs at boot and is a no-op on SQLite. See
  `docs/postgres-migration-runbook.md`. Postgres is currently disk-gated — see
  `docker-compose.yml` header.
- **Production serves same-origin.** In prod the Hono server on `:3001` also
  serves `apps/web/dist` as static files; no CORS needed. Build the web app
  before deploying the server.
- **No emoji in code** (repo-wide convention — do not introduce them).

## AI SDK 6 — the #1 source of bugs

This repo is on **AI SDK 6**, not 5 or 7. `docs.ai-sdk.dev` defaults to v7, so
most public examples are wrong for this codebase. Before writing any tool,
harness, or streaming code, read **`ARCHITECTURE.md` Appendix D** ("AI SDK 6
实战踩坑") — it catalogs every v5→v6 break with the verified-correct form.

Quick reference (details and rationale in Appendix D):

- Tool schema field is `inputSchema`, not `parameters`.
- Loop stop condition is `stopWhen: stepCountIs(N)`, not `maxSteps`.
- Serialize with `toUIMessageStreamResponse({ onError })`, not
  `toDataStreamResponse` (v5 method, does not exist in v6).
- Use `openai.chat(model, { baseURL })` for DeepSeek, not `openai(model)` —
  the Responses API mangles tool-call IDs.
- Convert messages with `await convertToModelMessages(messages)` (async), not
  the removed `convertToCoreMessages`.
- React hooks live in `@ai-sdk/react` (separate package), not `ai/react`.
- L2 approvals use per-tool `needsApproval: true` (v6); the `toolApproval`
  option is v7 and silently does nothing here. L3 hard-gate uses an
  execute-self-blocking pattern returning `{status:'blocked',ticketId}` because
  v6 `needsApproval` gives the model no chance to narrate.
- Telemetry option is `experimental_telemetry` (v6), not `telemetry` (v7).

Appendix D also covers Langfuse I/O field bridging (`GenAiSemconvEnricher`),
`result.response` being PromiseLike (no `.catch`), and L2 vs L3 resume
asymmetry. When in doubt, grep `apps/server/src` for the live pattern rather
than trusting docs.

## Deploy

### CI (`.github/workflows/ci.yml`)

Runs on a **self-hosted** runner (not GitHub-hosted — it cannot pull Node from
GitHub, hence `nvm use 20`). Steps: `npm install` (**not** `npm ci`, per repo
convention), `build`, `lint`, `test`. `OPENAI_API_KEY=ci-dummy-key` is injected
because `env.ts` zod-parses at import time and unit tests never call the API.

The 11 Postgres integration tests **skip** unless `DB_BACKEND=postgres` is set
with DB creds (no pgvector service container in CI today).

### CD — push to `main` deploys to ubuntu-server over the self-hosted runner

The `deploy` job (`needs: ci`, gated on `push` to `main`) runs on the same
self-hosted runner and performs the deploy directly on the ubuntu-server.
Concrete flow (`git clone git@github.com:PengYip/supply-chain-agent.git`):

1. `nvm use 20`; ensure `pm2` is installed globally (`~/.npm-global`).
2. Target dir: `~/supply-chain-agent`. First deploy **clones**; subsequent
   deploys `git fetch origin && git reset --hard origin/main` (destructive —
   local changes on the server are discarded).
3. `npm install && npm run build` on the server (builds web `dist` too, since
   prod serves the frontend same-origin).
4. `pm2 reload sca-server` (graceful) if already running, else
   `pm2 start ecosystem.config.cjs` on first deploy; then `pm2 save`.

Process: **PM2**, app name `sca-server`, entry `apps/server/dist/index.js`,
single instance, `max_memory_restart: 4G`, `autorestart` on (see
`ecosystem.config.cjs`). `NODE_ENV=production`.

Prerequisites on the server (not set up by CI): nvm + Node 20, an SSH/git key
authorized as a deploy key for `PengYip/supply-chain-agent`, and pm2. There is
**no Vercel deploy** — the Hono server on `:3001` serves `apps/web/dist` as
static files in production, so always build the web app before deploying the
server.

## Workflow conventions

- **Commit + push after edits by default.** When a change is complete and
  verified (build -> lint -> test green), commit and `git push origin main`
  without waiting to be asked. A push to `main` triggers CI
  (`npm install` -> `build` -> `lint` -> `test`) and, on success, the CD job
  deploys to the ubuntu-server over the self-hosted runner (see `## Deploy`).
  Never push broken code -- a red CI blocks the deploy job and leaves `main`
  in a bad state.
- Stage only the files relevant to the current change; do not sweep in
  unrelated untracked files (e.g. stray docs/plans).

## When docs conflict with code

Trust executable sources (`package.json`, `tsconfig.json`, CI, `env.ts`,
`index.ts`, drizzle config) over prose. `ARCHITECTURE.md` is reliable for
architecture and the AI SDK 6 notes; its file paths are not. If you find a doc
claim you cannot verify from code, treat it as suspect.
