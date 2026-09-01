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
| Backfill embeddings | `npm run backfill:embeddings --workspace apps/server -- --dry-run` first, then without `--dry-run`; on ubuntu-server prepend the nvm PATH export (`export PATH=$HOME/.nvm/versions/node/v24.19.0/bin:$PATH`) |

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

### Dev environment lives on 10.10.0.2

The dev deployment runs on a LAN host: **`10.10.0.2:3001`** (`ssh ubuntu-server`,
hostname `ubuntu`). Deployment dir `~/supply-chain-agent`, PM2 process
`sca-server` (reload via `pm2 reload sca-server`; pushes to `main` trigger CI+CD
which reloads it).

Access cheat-sheet (verify before trusting local files):

- **Pipeline DB = Postgres** in docker container `sca-pgvector` (port 5433,
  user `sca`, db `sca`, creds in the remote `.env`). Query via
  `ssh ubuntu-server "docker exec sca-pgvector psql -U sca -d sca -c '...'"`
  (Chinese output works fine). Harness session DB is still SQLite:
  `~/supply-chain-agent/apps/server/data/agent.db`.
  Remote `.env`: `DB_BACKEND=postgres`, `MINIO_ENDPOINT=localhost:9000`.
- **MinIO** in container `minio_docker`, bucket `sca-files`, objects keyed
  `users/<user_id>/<uuid>-<filename>` (folder uploads insert a path segment,
  e.g. `users/<user_id>/合同/...`). The container image lacks `find` and a full
  shell — use `sh -c 'ls ...'`.
- **Uploaded files** are flattened to `INGEST_ROOT` =
  `/home/ubuntu/supply-chain-agent/ingest-root` as
  `<key with / replaced by _>.<ext>`; `documents.source_uri` points there and
  parsing reads from that path.
- **Node version:** unified on Node 24 LTS (Krypton, `.nvmrc` = 24.19.0;
  2026-08-21, previously node 20 / 18 mix). The remote nvm default alias is
  24.19.0, but **non-interactive ssh shells don't load nvm** and fall back to
  system node 18 — run remote node scripts with an explicit PATH:
  `export PATH=$HOME/.nvm/versions/node/v24.19.0/bin:$PATH`. `better-sqlite3`
  is ^12 (has node-24 prebuilds); pm2 daemon was restarted under node 24
  (cluster-mode children follow the daemon's node binary — `pm2 reload` alone
  does NOT switch node versions).
- The `pipeline.db` / `agent.db` copies under the local repo are **not** the
  dev data — when debugging against real uploads/documents, inspect the DB and
  MinIO buckets on 10.10.0.2, not local files.
- A server responding on `localhost:3001` is a local instance; verify which
  deployment you are actually hitting before concluding anything from its data.
- PG 集成测试（`apps/server/test/pipeline/postgres.integration.test.ts`）的
  beforeEach 会 TRUNCATE `documents` 等业务表；在 10.10.0.2 上跑测试必须用
  独立的 `sca_test` 库，绝不可将 `DATABASE_URL` 指向共享开发库 `sca`
  （2026-08-17 曾因此清空开发数据）。
- **GitHub 出入站走 mihomo 代理**（2026-09-01 起）：runner 服务的 env 强制
  `http(s)_proxy=http://127.0.0.1:7890`（mihomo，PM2 托管，`pm2 restart mihomo`，
  随 pm2 开机自启）；控制 API 在 `127.0.0.1:9091`（9090 被 langfuse-minio 的
  docker 端口映射占用，别用）。节点列表由 `proxy-providers` 每日自动从订阅刷新
  （本地缓存 `~/mihomo/providers/airport.yaml`，断网也能冷启动）；AUTO 组
  每 300s 按 `https://api.github.com` 测速自动选最快节点，provider health-check
  用 HTTPS（HTTP 探活会被 443 黑洞的僵尸节点骗过 —— 2026-08-31 CI 连环超时的根因）。
  CI 超时/失败先查选中节点：`curl -s http://127.0.0.1:9091/proxies/AUTO`；
  强制重测：`curl -X GET 'http://127.0.0.1:9091/group/AUTO/delay?url=https%3A%2F%2Fapi.github.com&timeout=5000'`。
  git 无自带代理配置（曾指向 PC 的 172.18.15.20:7897，已删 —— PC 关机会导致
  CI git 步骤全挂），统一走 env → mihomo。

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
GitHub, hence `nvm use 24`). Steps: `npm install` (**not** `npm ci`, per repo
convention), `build`, `lint`, `test`. `OPENAI_API_KEY=ci-dummy-key` is injected
because `env.ts` zod-parses at import time and unit tests never call the API.

The 11 Postgres integration tests **skip** unless `DB_BACKEND=postgres` is set
with DB creds (no pgvector service container in CI today).

### CD — push to `main` deploys to ubuntu-server over the self-hosted runner

The `deploy` job (`needs: ci`, gated on `push` to `main`) runs on the same
self-hosted runner and performs the deploy directly on the ubuntu-server.
Concrete flow (`git clone git@github.com:PengYip/supply-chain-agent.git`):

1. `nvm use 24`; ensure `pm2` is installed globally (`~/.npm-global`).
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

Prerequisites on the server (not set up by CI): nvm + Node 24 LTS (24.19.0),
an SSH/git key authorized as a deploy key for `PengYip/supply-chain-agent`,
and pm2 (daemon running under node 24). There is
**no Vercel deploy** — the Hono server on `:3001` serves `apps/web/dist` as
static files in production, so always build the web app before deploying the
server.

## Workflow conventions

- **Commit + push after edits by default.** When a change is complete and
  verified (build -> lint -> test green), commit without waiting to be asked.
  A push to `main` triggers CI
  (`npm install` -> `build` -> `lint` -> `test`) and, on success, the CD job
  deploys to the ubuntu-server over the self-hosted runner (see `## Deploy`).
  Never push broken code -- a red CI blocks the deploy job and leaves `main`
  in a bad state.
- **Merge finished work back into main.** Day-to-day work happens on feature /
  worktree branches (e.g. `PengYip/UI-UX优化`), not directly on `main`. Once a
  change is verified (build -> lint -> test green), push the branch AND merge
  it into `main`: `git fetch origin main` -> `git merge origin/main` (resolve,
  then re-verify if the merge touched code) -> `git push origin HEAD:<branch>`
  followed by `git push origin HEAD:main`. Merged-but-unpushed work never
  reaches the dev deployment at 10.10.0.2, so "没有生效" usually means this
  step was skipped, not that the fix failed.
- Stage only the files relevant to the current change; do not sweep in
  unrelated untracked files (e.g. stray docs/plans).

## Tool design methodology

Tools are governed by a verifiable methodology (2026-08-28, distilled from
ai-agent-book ch4 + the Pi/Codex minimal-tool reference designs):

- **SSOT inventory**: `docs/tool-inventory.json` — every mounted tool needs an
  entry with `whenToUse` / `boundary` / `rationale`; removed tools go on a
  blacklist that must never reappear; approved merges are recorded under
  `merges.plans` before implementation.
- **CI gate**: `apps/server/test/harness/toolInventory.test.ts` asserts a
  bijection between the registry and the inventory, plus metadata completeness.
  Adding a tool without an inventory entry fails CI — the surface cannot grow
  silently.
- **Env gating**: deployment-bound tools mount only behind an explicit flag
  (e.g. `execute_code` needs `CUBE_SANDBOX_ENABLED=true`; unset = the tool does
  not exist, not a runtime error).
- **Process**: 砍死 -> 并相似 -> 挂场景 -> Skill 化。 Full write-up and the
  five description-writing rules: `docs/tool-design-methodology.md`.

When changing the tool surface, edit the inventory first, then the registry,
then run the inventory test.

## When docs conflict with code

Trust executable sources (`package.json`, `tsconfig.json`, CI, `env.ts`,
`index.ts`, drizzle config) over prose. `ARCHITECTURE.md` is reliable for
architecture and the AI SDK 6 notes; its file paths are not. If you find a doc
claim you cannot verify from code, treat it as suspect.
