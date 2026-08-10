# Postgres + pgvector Migration Runbook

**Status: DISK-GATED PREP.** The artifacts are committed and ready; the migration cannot run yet because the **C: drive is at 100%** (Docker Desktop, its WSL distros, and image/layer caches live on C: by default). Once ~15-20GB is freed on C: (or Docker's data root is relocated to D:), this is a one-command migration.

This runbook is **additive**: until step 5 (flip `DB_BACKEND` + rewire `getDbContext`), the runtime stays on SQLite and all 87 tests keep passing. Nothing here is imported by the runtime today.

---

## Artifacts in place

| File | Purpose |
| --- | --- |
| `docker-compose.yml` (repo root) | `pgvector/pgvector:pg16` service, data volume on `D:/pgdata`, healthcheck, `sca` user/db. |
| `server/src/pipeline/db/postgres-schema.ts` | Drizzle `pg-core` target schema: mirrors SQLite `documents/extractions/bindings/doc_chunk` + adds `doc_contract`, `document_relation`, and `doc_chunk.embedding vector(1024)` + `fts_vector tsvector`. |
| `server/src/pipeline/db/dbBackend.ts` | `DB_BACKEND` switch + `getDbContext()` dispatcher. **Not wired into `agent.ts`**; the `postgres` branch throws until provisioned. |
| `server/drizzle.config.ts` | drizzle-kit config for the Postgres path (outside `src/`, so it does not enter `tsc`). |

**Zero new runtime npm deps.** `drizzle-orm/pg-core` ships with the already-installed `drizzle-orm`; the `vector(1024)` and `tsvector` column types are declared via `customType` (no `drizzle-orm/vector` install). `drizzle-kit` is already present.

---

## Step 0 - Free disk space on C: (prerequisite)

Pick any combination until C: has ~15-20GB free:

```bash
npm cache clean --force
uv cache clean
docker system prune -a --volumes   # WARNING: removes all unused images/volumes
# Windows: run cleanmgr (Disk Cleanup) incl. "Previous Windows installations"
```

**Or relocate Docker Desktop's data root to D:** (keeps C: clean long-term):

```powershell
wsl --shutdown
wsl --export docker-desktop D:\docker-backup\docker-desktop.tar
wsl --unregister docker-desktop
wsl --import docker-desktop D:\docker-data\docker-desktop D:\docker-backup\docker-desktop.tar
# Repeat for docker-desktop-data if present.
```

Restart Docker Desktop and confirm `docker run hello-world` works before continuing.

---

## Step 1 - Start Postgres + pgvector

From the repo root:

```bash
mkdir -p D:/pgdata          # volume target (keeps DB files off C:)
docker compose up -d
```

Wait for healthy:

```bash
docker compose ps           # expect STATUS: Up (healthy)
docker exec sca-postgres pg_isready -U sca -d sca
# Verify the pgvector extension is available:
docker exec sca-postgres psql -U sca -d sca -c "SELECT * FROM pg_available_extensions WHERE name = 'vector';"
```

Create the extension in the target DB (run once):

```bash
docker exec sca-postgres psql -U sca -d sca -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

---

## Step 2 - Point the backend at Postgres

```bash
export DB_BACKEND=postgres
export DATABASE_URL=postgresql://sca:sca_dev_password@localhost:5432/sca
```

`dbBackend.ts` reads these; until step 5 it still throws in the `postgres` branch on purpose (so a half-configured backend cannot silently boot).

---

## Step 3 - Generate + apply the schema migration

```bash
cd server
npx drizzle-kit generate    # emits SQL from postgres-schema.ts into ./drizzle/postgres
```

drizzle-kit cannot express three things; **layer them as raw SQL** in a new file under `./drizzle/postgres/` (e.g. `0001_pgvector_fts.sql`) and apply with `psql` (or fold into `drizzle-kit migrate`):

```sql
-- HNSW cosine index for vector KNN (replaces sqlite-vec vec0 KNN).
CREATE INDEX IF NOT EXISTS doc_chunk_embedding_hnsw_idx
  ON doc_chunk USING hnsw (embedding vector_cosine_ops);

-- Generated tsvector + GIN index for Postgres FTS (replaces SQLite FTS5).
ALTER TABLE doc_chunk
  ADD COLUMN fts_vector_gen tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', chunk_text)) STORED;
CREATE INDEX IF NOT EXISTS doc_chunk_fts_gin_idx
  ON doc_chunk USING gin (fts_vector_gen);
```

Then apply everything:

```bash
npx drizzle-kit migrate
```

> **Divergence note (intentional):** the SQLite path uses raw idempotent DDL in `src/pipeline/db/client.ts` (no drizzle-kit). The Postgres path uses drizzle-kit `generate`/`migrate`. Both are kept; they do not conflict because only one backend is active at a time.

---

## Step 4 - Port repositories + vector store to pg-core

This is the substantive code work (deferred until disk is cleared). Concretely:

- `repositories.ts`: swap `drizzle-orm/better-sqlite3` for `drizzle-orm/node-postgres`; `JSON.stringify`/`parse` on `TEXT` columns becomes native `JSONB`; `real` confidence becomes `numeric`.
- `vecStore.ts`: replace sqlite-vec `vec0` KNN (`... MATCH ? ORDER BY distance`) with pgvector cosine KNN: `SELECT id, embedding <=> $1 AS distance FROM doc_chunk ORDER BY embedding <=> $1 LIMIT $k` (`<=>` = cosine distance). Drop the load-extension ladder (pgvector is a `CREATE EXTENSION`, not a loadable).
- `client.ts` migrate(): the FTS5 + `doc_chunk_fts` DDL is SQLite-only; the Postgres equivalent is the generated tsvector + GIN index above.
- `recall.ts`: the `searchChunks` FTS path becomes a `tsvector` `@@ plainto_tsquery` query; the RRF hybrid logic is backend-agnostic and stays as-is.

Keep both code paths selectable via `DB_BACKEND` (the dispatcher in `dbBackend.ts` is the seam). The hybrid RRF + injection-defense wrapping are backend-neutral and need no changes.

---

## Step 5 - Flip the runtime + run tests

Wire the dispatcher into the harness (one line in `agent.ts`):

```diff
- import { createDb, migrate, type DbContext } from '../pipeline/db/client.js';
+ import { getDbContext, type DbContext } from '../pipeline/db/dbBackend.js';
...
- harnessCtx = createDb('pipeline.db'); migrate(harnessCtx.sqlite);
+ harnessCtx = getDbContext({ sqlitePath: 'pipeline.db' });
```

(`getDbContext` returns the SQLite path verbatim when `DB_BACKEND=sqlite`, so this is a safe no-op until you actually set `DB_BACKEND=postgres`.)

Run the suite with the D: temp/cache redirect (C: stays full during the transition too):

```bash
cd server
TMPDIR=D:/tmp TMP=D:/tmp TEMP=D:/tmp npm_config_cache=D:/npm-cache \
  npx vitest run
```

All existing tests must stay green. Note: the FTS-specific recall tests (`strategy:'fts'`) will assert against Postgres tsvector ranking rather than SQLite FTS5 bm25; the bm25 score field becomes a ts_rank analogue. Update those assertions as part of step 4.

---

## Step 6 - Data migration (optional)

If `pipeline.db` already holds production data:

```bash
# Export each SQLite table to CSV, then \copy into Postgres via psql.
docker cp pipeline.db sca-postgres:/tmp/   # or keep sqlite3 CLI local
sqlite3 pipeline.db ".mode csv" ".headers on" ".output documents.csv" "SELECT * FROM documents;"
# repeat for extractions, bindings, doc_chunk
docker exec -i sca-postgres psql -U sca -d sca -c "\copy documents FROM '/tmp/documents.csv' CSV HEADER;"
```

Re-embed `doc_chunk` rows into pgvector (the deterministic embedder is fine for a dry run; use bge-m3 via `OLLAMA_BASE_URL` for real vectors):

```sql
-- after wiring the embedder into a one-shot script:
UPDATE doc_chunk SET embedding = '<1024-dim vector literal>' WHERE id = ?;
```

`doc_contract.file_hash` makes contract re-ingest idempotent (same file -> skip); `document_relation` edges are rebuilt by the relation-extraction pipeline, not copied.

---

## Rollback

Set `DB_BACKEND=sqlite` (or unset it) and revert the `agent.ts` one-liner. The SQLite runtime, schema, and all tests are untouched by this prep work, so rollback is immediate and lossless (Postgres data remains in `D:/pgdata` for re-inspection).
