import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import {
  documents, extractions, bindings, fileFolders, classifications, documentTags, selfParties,
  templateTypes, templateEdgeRules, templateVersions,
} from './schema.js';
// Type-only import: erased at emit, so SQLite-only hosts do not need pg installed
// to RUN; only the Postgres path (postgres-client.ts) does a real `import { Pool }`.
import type { Pool } from 'pg';

// ---- Backend-neutral DbContext ------------------------------------------------
//
// The repo/vecStore layer is async on BOTH backends (better-sqlite3 is sync but
// every repo fn returns a Promise; node-postgres is async-only). DbContext is a
// discriminated union on `backend`: narrow with `ctx.backend === 'sqlite'` to
// reach `.sqlite`/`.db`, or `=== 'postgres'` to reach `.pool`. createDb returns
// the concrete SqliteDbContext so the many SQLite callers (tests/eval/agent) keep
// direct `.sqlite` access without narrowing.

export interface SqliteDbContext {
  backend: 'sqlite';
  db: ReturnType<typeof drizzle>;
  sqlite: Database.Database;
}

export interface PostgresDbContext {
  backend: 'postgres';
  /** node-postgres connection pool. Lazy: connections open on first query. */
  pool: Pool;
}

export type DbContext = SqliteDbContext | PostgresDbContext;

export function createDb(path = ':memory:'): SqliteDbContext {
  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  const db = drizzle(sqlite, {
    schema: { documents, extractions, bindings, fileFolders, classifications, documentTags, selfParties, templateTypes, templateEdgeRules, templateVersions },
  });
  return { backend: 'sqlite', db, sqlite };
}

/** Idempotent raw-DDL migrate (MVP). For prod, generate via `drizzle-kit generate`. */
export function migrate(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      doc_type TEXT NOT NULL,
      modality TEXT NOT NULL,
      source_uri TEXT NOT NULL,
      block_model TEXT NOT NULL,
      minio_key TEXT,
      user_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      review_status TEXT NOT NULL DEFAULT 'pending',
      reviewed_at TEXT,
      reviewed_by TEXT,
      -- Model B parse lifecycle: 'uploaded' stub -> 'parsing' -> 'parsed' |
      -- 'needs_ocr' | 'failed'. Decouples upload (storage-only) from parsing.
      parse_status TEXT NOT NULL DEFAULT 'uploaded'
    );
    CREATE TABLE IF NOT EXISTS extractions (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES documents(id),
      doc_type TEXT NOT NULL,
      fields TEXT NOT NULL,
      field_meta TEXT NOT NULL,
      overall_confidence REAL NOT NULL,
      needs_review INTEGER NOT NULL DEFAULT 0,
      proposed_relationships TEXT,
      user_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS bindings (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES documents(id),
      contract_no TEXT NOT NULL,
      relation TEXT NOT NULL,
      source_refs TEXT NOT NULL,
      confidence REAL NOT NULL,
      created_by TEXT NOT NULL,
      user_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      -- Phase B bindings state machine (see schema.ts): 存量行默认 confirmed。
      status TEXT NOT NULL DEFAULT 'confirmed',
      confirmation_source TEXT,
      proposed_by TEXT,
      evidence TEXT,
      -- 立项书 binds->Project(spec 2026-08-26 §3.1): 绑定目标类型标记。
      target_kind TEXT NOT NULL DEFAULT 'Contract'
    );
    CREATE INDEX IF NOT EXISTS idx_bindings_contract ON bindings(contract_no);
    CREATE INDEX IF NOT EXISTS idx_extractions_doc ON extractions(document_id);
    CREATE INDEX IF NOT EXISTS idx_documents_user ON documents(user_id);
    CREATE INDEX IF NOT EXISTS idx_extractions_user ON extractions(user_id);
    CREATE INDEX IF NOT EXISTS idx_bindings_user ON bindings(user_id);

    -- 项目维度(spec 2026-08-20 §4.1): projects 是统计维度实体, code 归一大写;
    -- project_memberships 是合同<->项目归属的 SSOT, 图(Neo4j)只是投影视图。
    -- DDL 只在此处(raw SQL), 不进 drizzle schema.ts(与 contract_ledger 同例)。
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      user_id TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS projects_code_user_uq ON projects (code, user_id);

    CREATE TABLE IF NOT EXISTS project_memberships (
      id TEXT PRIMARY KEY,
      contract_no TEXT NOT NULL,
      project_code TEXT NOT NULL,
      role TEXT,
      status TEXT NOT NULL DEFAULT 'proposed',
      proposed_by TEXT NOT NULL DEFAULT 'system',
      confirmation_source TEXT,
      confidence REAL NOT NULL DEFAULT 0,
      created_by TEXT NOT NULL DEFAULT 'system',
      user_id TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      graph_status TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS project_memberships_uq
      ON project_memberships (contract_no, project_code, user_id);
    CREATE INDEX IF NOT EXISTS project_memberships_project_idx
      ON project_memberships (project_code, user_id);
    CREATE INDEX IF NOT EXISTS project_memberships_contract_idx
      ON project_memberships (contract_no, user_id);

    -- 自主体名单(Task A): 与 env.SELF_PARTY_NAMES 并集的 DB 侧名单。租户全局
    -- (无 user_id 过滤), created_by 仅审计; name 为原始名(raw), 去重按
    -- normalizeCompanyName 归一化形式(应用层判定, 见 addSelfParty)。
    CREATE TABLE IF NOT EXISTS self_parties (
      name TEXT PRIMARY KEY,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS classifications (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES documents(id),
      doc_type TEXT NOT NULL,
      confidence REAL NOT NULL,
      source TEXT NOT NULL,
      hint TEXT,
      user_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_classifications_doc ON classifications(document_id);
    CREATE INDEX IF NOT EXISTS idx_classifications_user ON classifications(user_id);

    CREATE TABLE IF NOT EXISTS document_tags (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES documents(id),
      tag TEXT NOT NULL,
      source TEXT NOT NULL,
      user_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_document_tags_doc ON document_tags(document_id);
    CREATE INDEX IF NOT EXISTS idx_document_tags_user ON document_tags(user_id);
    -- Structural idempotency backstop for saveDocumentTags. The app-layer
    -- pre-read + dedup is the primary guard in serial operation, so this index
    -- does not fire normally; it converts any future app-bug (or race) into a
    -- UNIQUE constraint violation instead of silent duplicate rows. Safe to add
    -- now because the table is brand-new (no existing rows to dedup).
    CREATE UNIQUE INDEX IF NOT EXISTS idx_document_tags_unique ON document_tags(document_id, tag, source, user_id);

    -- File manager (Phase 3+): virtual folders owned per-user. Files themselves
    -- live in MinIO; this table only records folder entries.
    CREATE TABLE IF NOT EXISTS file_folders (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      path TEXT NOT NULL,
      -- NULL = never manually ordered; sorts after all ranked rows.
      sort_order INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_file_folders_user ON file_folders(user_id);

    -- File manager manual ordering (drag-to-sort): per-user rank rows for file
    -- objects, keyed by MinIO object key. Ranks are lost when a file is moved/
    -- renamed (key changes) and orphaned ranks are harmless read-time noise.
    CREATE TABLE IF NOT EXISTS file_sort_orders (
      user_id TEXT NOT NULL,
      obj_key TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, obj_key)
    );

    -- L4 document recall index (Task 6 v1, SQLite/FTS5 path). Keyword BM25 recall
    -- over chunked document text. Postgres+pgvector and sqlite-vec/semantic paths
    -- are DEFERRED; this table + FTS5 is the zero-dep keyword layer.
    CREATE TABLE IF NOT EXISTS doc_chunk (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id TEXT NOT NULL REFERENCES documents(id),
      chunk_text TEXT NOT NULL,
      chunk_index INTEGER,
      -- Lane B: per-chunk semantic tags (JSON string[] | NULL). NULL when the
      -- tagger was unset, taxonomy empty (其他), or the tagger errored.
      tags TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_doc_chunk_doc ON doc_chunk(document_id);

    -- External-content FTS5 index: chunk_text lives once in doc_chunk, the FTS
    -- table holds only the BM25 index (content_rowid maps FTS rowid -> doc_chunk.id).
    -- Populated manually in saveChunks (single ingest write path), not via triggers.
    CREATE VIRTUAL TABLE IF NOT EXISTS doc_chunk_fts USING fts5(
      chunk_text,
      content='doc_chunk',
      content_rowid='id'
    );

    -- Contract ledger persistence layer (ingest extraction write-back): one row
    -- per normalized (contract_no, user_id). The UNIQUE index is the idempotency
    -- backstop for the ON CONFLICT upsert in upsertContractLedgerEntry -- re-
    -- extracting the same contract for the same user updates in place instead of
    -- duplicating rows.
    CREATE TABLE IF NOT EXISTS contract_ledger (
      id TEXT PRIMARY KEY,
      contract_no TEXT NOT NULL,
      display_contract_no TEXT NOT NULL,
      doc_type TEXT NOT NULL,
      document_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      fields TEXT NOT NULL,
      field_meta TEXT NOT NULL,
      overall_confidence REAL NOT NULL,
      needs_review INTEGER NOT NULL DEFAULT 0,
      user_id TEXT NOT NULL DEFAULT '',
      contract_type TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_contract_ledger_no_user ON contract_ledger(contract_no, user_id);

    -- Execution flows (六向执行流水): 合同绑定确认后物化的流水明细
    -- ('资金流' | '货物流' | '发票流' x 'in' | 'out')。UNIQUE(binding_id, user_id)
    -- 是 upsertExecutionFlow 幂等的兜底 -- 同一绑定重复物化就地更新而非重复行。
    -- user_id 可空但存储层写侧统一经 effectiveUserId 归一化为 ''(与 bindings 一致)。
    CREATE TABLE IF NOT EXISTS execution_flows (
      id TEXT PRIMARY KEY,
      binding_id TEXT NOT NULL,
      document_id TEXT NOT NULL,
      contract_no TEXT NOT NULL,
      flow_type TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
      amount REAL,
      quantity_ton REAL,
      unit TEXT,
      doc_type TEXT NOT NULL,
      voucher_date TEXT,
      extraction_id TEXT,
      confidence REAL NOT NULL DEFAULT 0,
      created_by TEXT NOT NULL,
      user_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_flows_binding ON execution_flows(binding_id, user_id);
    CREATE INDEX IF NOT EXISTS idx_execution_flows_contract ON execution_flows(contract_no, user_id);

    -- Graph links (spec 2026-08-25 方案A §3.3/§6): correlates(背靠背购销对应)与
    -- relates(项目级关联)的提案-确认 SSOT。图上的边只是本表确认后的投影。
    -- triple 唯一(kind+src_key+dst_key+user_id)支撑幂等 upsert; props 为 JSON
    -- 自由属性(share/type/note/allocated*, 白名单裁剪在路由层)。
    CREATE TABLE IF NOT EXISTS graph_links (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      src_kind TEXT NOT NULL,
      src_key TEXT NOT NULL,
      src_label TEXT NOT NULL DEFAULT '',
      dst_kind TEXT NOT NULL,
      dst_key TEXT NOT NULL,
      dst_label TEXT NOT NULL DEFAULT '',
      props TEXT NOT NULL DEFAULT '{}',
      confidence REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'proposed',
      confirmation_source TEXT,
      created_by TEXT NOT NULL,
      user_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      graph_status TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_graph_links_triple ON graph_links(kind, src_key, dst_key, user_id);
    CREATE INDEX IF NOT EXISTS idx_graph_links_user ON graph_links(user_id);
    CREATE INDEX IF NOT EXISTS idx_graph_links_src ON graph_links(src_kind, src_key);

    -- Quotas(spec 2026-08-25 方案A §3.1 Quota): 两层额度 SSOT——scope=counterparty
    -- (对手方授信, owner_key=归一化企业名)或 project(项目限额, owner_key=项目码)。
    -- used_amount/computed_at 为对账桥物化结果, 只经 updateQuotaUsed 写入;
    -- 图上 granted 边与 Quota 节点只是本表的投影。
    CREATE TABLE IF NOT EXISTS quotas (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      owner_key TEXT NOT NULL,
      owner_label TEXT NOT NULL DEFAULT '',
      limit_amount REAL NOT NULL,
      currency TEXT,
      period TEXT,
      used_amount REAL NOT NULL DEFAULT 0,
      computed_at TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_by TEXT NOT NULL,
      user_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_quotas_owner ON quotas(scope, owner_key, user_id);
    CREATE INDEX IF NOT EXISTS idx_quotas_user ON quotas(user_id);

    -- 业务图谱模板(spec 2026-08-26 §3): 模板层 SSOT, 全局本体无 user_id。
    -- target_type_id = '' 是通配(任意合同类型); allowed_vocab/anchor_weights 为 JSON。
    CREATE TABLE IF NOT EXISTS template_types (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      parent_id TEXT,
      props TEXT NOT NULL DEFAULT '{}',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS template_types_kind_name_uq ON template_types (kind, name);
    CREATE INDEX IF NOT EXISTS template_types_parent ON template_types (parent_id);

    CREATE TABLE IF NOT EXISTS template_edge_rules (
      id TEXT PRIMARY KEY,
      source_type_id TEXT NOT NULL,
      target_type_id TEXT NOT NULL DEFAULT '',
      edge_type TEXT NOT NULL,
      allowed_vocab TEXT NOT NULL DEFAULT '[]',
      anchor_weights TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      template_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS template_edge_rules_src ON template_edge_rules (source_type_id, edge_type);

    CREATE TABLE IF NOT EXISTS template_versions (
      version INTEGER PRIMARY KEY,
      changed_by TEXT NOT NULL,
      change_summary TEXT NOT NULL,
      changed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);

  // P4: 种子冲突策略列(managed-wins)。NULL=纯种子行(boot 可覆写);非空=DB 优先。
  // 存量 dev 库补列, 同 guarded ALTER 模式(CREATE TABLE IF NOT EXISTS 不加列;
  // try/catch 兜并发初始化 "duplicate column name" -- 见 sessionStore.ts 51ef03c)。
  for (const tbl of ['template_types', 'template_edge_rules']) {
    const cols = sqlite.prepare(`PRAGMA table_info(${tbl})`).all() as Array<{ name: string }>;
    const have = new Set(cols.map((c) => c.name));
    if (!have.has('managed_at')) {
      try { sqlite.exec(`ALTER TABLE ${tbl} ADD COLUMN managed_at TEXT`); } catch { /* concurrent */ }
    }
    if (!have.has('managed_by')) {
      try { sqlite.exec(`ALTER TABLE ${tbl} ADD COLUMN managed_by TEXT`); } catch { /* concurrent */ }
    }
  }

  // Phase 2 business-data isolation: add user_id to pre-existing dev databases.
  // CREATE TABLE IF NOT EXISTS does not add columns to an already-existing table,
  // so ALTER is needed for databases created before the user_id columns landed.
  // Guarded per-table (duplicate column -> SQLITE_ERROR) so re-running is safe.
  for (const tbl of ['documents', 'extractions', 'bindings']) {
    const cols = sqlite.prepare(`PRAGMA table_info(${tbl})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'user_id')) {
      try {
        sqlite.exec(`ALTER TABLE ${tbl} ADD COLUMN user_id TEXT NOT NULL DEFAULT ''`);
      } catch {
        // Column may have been added concurrently; safe to ignore.
      }
    }
  }

  // 执行流水溯源(移植自 CodeX-2): extraction_flows 先建的 dev 库补 extraction_id
  // 列。同一 guarded ALTER 模式。
  {
    const cols = sqlite.prepare('PRAGMA table_info(execution_flows)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'extraction_id')) {
      try { sqlite.exec('ALTER TABLE execution_flows ADD COLUMN extraction_id TEXT'); } catch { /* concurrent */ }
    }
  }

  // 数量单位独立建模(移植自 CodeX-2): 裸 '数量' 字段不带单位语义, unit 为 NULL。
  {
    const cols = sqlite.prepare('PRAGMA table_info(execution_flows)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'unit')) {
      try { sqlite.exec('ALTER TABLE execution_flows ADD COLUMN unit TEXT'); } catch { /* concurrent */ }
    }
  }

  // 文件管理拖拽排序: 存量 dev 库的 file_folders 补 sort_order 列（新建库已带列,
  // PRAGMA 守卫保证幂等）。file_sort_orders 表由上方 CREATE TABLE IF NOT EXISTS 覆盖。
  {
    const cols = sqlite.prepare('PRAGMA table_info(file_folders)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'sort_order')) {
      try { sqlite.exec('ALTER TABLE file_folders ADD COLUMN sort_order INTEGER'); } catch { /* concurrent */ }
    }
  }

  // Phase 3+: link documents back to their MinIO object key (uploads). Same
  // idempotent ALTER pattern as the user_id block above for pre-existing DBs.
  {
    const cols = sqlite.prepare('PRAGMA table_info(documents)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'minio_key')) {
      try {
        sqlite.exec('ALTER TABLE documents ADD COLUMN minio_key TEXT');
      } catch {
        // Column may have been added concurrently; safe to ignore.
      }
    }
  }

  // Post-ingest review (design 2026-08-13): advisory review status on documents,
  // + proposed relationships on extractions. Same guarded ALTER pattern as above.
  {
    const cols = sqlite.prepare('PRAGMA table_info(documents)').all() as Array<{ name: string }>;
    const have = new Set(cols.map((c) => c.name));
    if (!have.has('review_status')) {
      try { sqlite.exec("ALTER TABLE documents ADD COLUMN review_status TEXT NOT NULL DEFAULT 'pending'"); } catch { /* concurrent */ }
    }
    if (!have.has('reviewed_at')) {
      try { sqlite.exec('ALTER TABLE documents ADD COLUMN reviewed_at TEXT'); } catch { /* concurrent */ }
    }
    if (!have.has('reviewed_by')) {
      try { sqlite.exec('ALTER TABLE documents ADD COLUMN reviewed_by TEXT'); } catch { /* concurrent */ }
    }
    // Persisted vectorization outcome (Bug fix: was previously an in-memory Map
    // in documentEntry.ts, so it showed 'unknown' after upload or restart). Same
    // guarded ALTER pattern as the review_status block above.
    if (!have.has('vectorization_meta')) {
      try { sqlite.exec('ALTER TABLE documents ADD COLUMN vectorization_meta TEXT'); } catch { /* concurrent */ }
    }
    // Graph-relations design (2026-08-17 §4): 确认时 Neo4j 写入结果持久化
    // （ok/partial/failed/skipped + 计数）。与 vectorization_meta 同一 guarded ALTER 模式。
    if (!have.has('graph_status')) {
      try { sqlite.exec('ALTER TABLE documents ADD COLUMN graph_status TEXT'); } catch { /* concurrent */ }
    }
    // Lane A (2a): auto-extraction lifecycle status (pending/running/ok/skipped/
    // failed). NULL on legacy rows is treated as 'pending' (opt-in; no backfill).
    if (!have.has('extraction_status')) {
      try { sqlite.exec('ALTER TABLE documents ADD COLUMN extraction_status TEXT'); } catch { /* concurrent */ }
    }
    // Model B parse lifecycle column. Same guarded ALTER pattern as
    // review_status / vectorization_meta above (duplicate column -> SQLITE_ERROR).
    if (!have.has('parse_status')) {
      try { sqlite.exec("ALTER TABLE documents ADD COLUMN parse_status TEXT NOT NULL DEFAULT 'uploaded'"); } catch { /* concurrent */ }
    }
  }
  // Lane B: per-chunk semantic tags. Pre-existing dev DBs created doc_chunk
  // WITHOUT this column (CREATE TABLE IF NOT EXISTS adds no columns), so a
  // guarded ALTER is needed alongside the CREATE above. Same pattern as the
  // documents user_id / review_status blocks.
  {
    const cols = sqlite.prepare('PRAGMA table_info(doc_chunk)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'tags')) {
      try { sqlite.exec('ALTER TABLE doc_chunk ADD COLUMN tags TEXT'); } catch { /* concurrent */ }
    }
  }
  {
    const cols = sqlite.prepare('PRAGMA table_info(extractions)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'proposed_relationships')) {
      try { sqlite.exec('ALTER TABLE extractions ADD COLUMN proposed_relationships TEXT'); } catch { /* concurrent */ }
    }
  }

  // Phase B bindings state machine: pre-existing dev DBs created bindings WITHOUT
  // status/confirmation_source/proposed_by/evidence (CREATE TABLE IF NOT EXISTS
  // adds no columns). Same guarded ALTER pattern; try/catch each so concurrent
  // module init (separate vitest workers / processes sharing the same SQLite
  // file) cannot crash on "duplicate column name" -- see sessionStore.ts 51ef03c.
  {
    const cols = sqlite.prepare('PRAGMA table_info(bindings)').all() as Array<{ name: string }>;
    const has = (name: string): boolean => cols.some((c) => c.name === name);
    if (!has('status')) {
      try { sqlite.exec("ALTER TABLE bindings ADD COLUMN status TEXT NOT NULL DEFAULT 'confirmed'"); } catch { /* concurrent */ }
    }
    if (!has('confirmation_source')) {
      try { sqlite.exec('ALTER TABLE bindings ADD COLUMN confirmation_source TEXT'); } catch { /* concurrent */ }
    }
    if (!has('proposed_by')) {
      try { sqlite.exec('ALTER TABLE bindings ADD COLUMN proposed_by TEXT'); } catch { /* concurrent */ }
    }
    if (!has('evidence')) {
      try { sqlite.exec('ALTER TABLE bindings ADD COLUMN evidence TEXT'); } catch { /* concurrent */ }
    }
    // 绑定工作台: 确认后图谱同步结果(JSON(BindingGraphStatus))。
    if (!has('graph_status')) {
      try { sqlite.exec('ALTER TABLE bindings ADD COLUMN graph_status TEXT'); } catch { /* concurrent */ }
    }
    // 立项书 binds->Project(spec 2026-08-26 §3.1): 存量 dev 库补列, 同 guarded ALTER 模式。
    if (!has('target_kind')) {
      try { sqlite.exec("ALTER TABLE bindings ADD COLUMN target_kind TEXT NOT NULL DEFAULT 'Contract'"); } catch { /* concurrent */ }
    }
  }

  // 合同类型维度(主体视角: 采购/销售/物流/租赁/服务/其他, spec 2026-08-20 §3):
  // deriveContractType 在录入写回时派生落库; NULL = 未识别。存量 dev 库补列,
  // 同 guarded ALTER 模式(CREATE TABLE IF NOT EXISTS 不加列)。
  {
    const have = new Set(
      (sqlite.prepare('PRAGMA table_info(contract_ledger)').all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (!have.has('contract_type')) {
      try { sqlite.exec('ALTER TABLE contract_ledger ADD COLUMN contract_type TEXT'); } catch { /* concurrent */ }
    }
  }

  // Backfill created_at (+ user_id) on classifications/document_tags/extractions
  // for old prod DBs whose tables predate these columns. CREATE TABLE IF NOT
  // EXISTS adds no columns to an existing table, and these previously had no
  // in-place ALTER coverage — getReviewSnapshot's ORDER BY created_at surfaced
  // the gap. Nullable + expression default is valid for ADD COLUMN.
  for (const tbl of ['classifications', 'document_tags', 'extractions']) {
    const cols = sqlite.prepare(`PRAGMA table_info(${tbl})`).all() as Array<{ name: string }>;
    const have = new Set(cols.map((c) => c.name));
    if (!have.has('created_at')) {
      try { sqlite.exec(`ALTER TABLE ${tbl} ADD COLUMN created_at TEXT DEFAULT (datetime('now'))`); } catch { /* concurrent */ }
    }
    if ((tbl === 'classifications' || tbl === 'document_tags') && !have.has('user_id')) {
      try { sqlite.exec(`ALTER TABLE ${tbl} ADD COLUMN user_id TEXT NOT NULL DEFAULT ''`); } catch { /* concurrent */ }
    }
  }
}

/**
 * Phase 2 startup migration for Postgres: add `user_id` columns + indexes to the
 * documents/extractions/bindings tables when they were created by an older schema
 * (drizzle-kit created them WITHOUT user_id before Phase 2). Idempotent via
 * ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS -- safe to run on every
 * startup.
 *
 * Best-effort: wraps everything in try/catch and logs a warning on failure rather
 * than throwing, so the server still boots (a subsequent query needing user_id
 * then surfaces a clear column-missing error at runtime instead of crashing
 * startup). Statements run individually (not one multi-statement query) so this
 * is robust behind pgBouncer transaction mode and reports per-statement errors.
 *
 * Mirror of the SQLite ALTER loop in migrate(); the IF NOT EXISTS guard makes the
 * per-DBMS duplication unnecessary on the Postgres side.
 */
export async function migratePostgres(pool: Pool): Promise<void> {
  const statements = [
    // Naming fix: drizzle-kit generated the timestamp column as "createdAt"
    // (camelCase -- see postgres-schema.ts nowTs() pre-fix and
    // drizzle/postgres/0000_ancient_mentor.sql), but the raw SQL in
    // postgres-repositories.ts references `created_at` (snake_case, matching
    // the SQLite schema and auth-schema). The split broke `ORDER BY created_at`
    // in getReviewSnapshotPg / loadLatestExtractionByDocIdPg (Postgres error
    // 42703 "column created_at does not exist"). Rename the drizzle-migrated
    // tables' "createdAt" -> created_at. Idempotent: only renames when the
    // camelCase column exists and the snake_case one does not, so it is a
    // no-op on databases already renamed and on tables created by later DDL.
    // Runs every boot -- fixes the live DB on the next deploy without a manual
    // drizzle-kit migrate (which is out-of-band and not in the deploy path).
    `DO $$
    DECLARE t text;
    BEGIN
      FOREACH t IN ARRAY ARRAY['documents','extractions','bindings','doc_chunk'] LOOP
        IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = t AND column_name = 'createdAt'
          )
           AND NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = t AND column_name = 'created_at'
          ) THEN
          EXECUTE format('ALTER TABLE %I RENAME COLUMN "createdAt" TO created_at', t);
        END IF;
      END LOOP;
    END $$;`,
    `ALTER TABLE documents ADD COLUMN IF NOT EXISTS user_id TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE extractions ADD COLUMN IF NOT EXISTS user_id TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE bindings ADD COLUMN IF NOT EXISTS user_id TEXT NOT NULL DEFAULT ''`,
    // Phase B bindings state machine: status/confirmation_source/proposed_by/
    // evidence (see postgres-schema.ts). Idempotent; 存量行默认 confirmed 语义正确。
    `ALTER TABLE bindings ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'confirmed'`,
    `ALTER TABLE bindings ADD COLUMN IF NOT EXISTS confirmation_source TEXT`,
    `ALTER TABLE bindings ADD COLUMN IF NOT EXISTS proposed_by TEXT`,
    `ALTER TABLE bindings ADD COLUMN IF NOT EXISTS evidence TEXT`,
    // 绑定工作台: 确认后图谱同步结果(JSON(BindingGraphStatus))。
    `ALTER TABLE bindings ADD COLUMN IF NOT EXISTS graph_status TEXT`,
    // 立项书 binds->Project(spec 2026-08-26 §3.1): 绑定目标类型标记。
    `ALTER TABLE bindings ADD COLUMN IF NOT EXISTS target_kind TEXT NOT NULL DEFAULT 'Contract'`,
    `CREATE INDEX IF NOT EXISTS documents_user_id_idx ON documents(user_id)`,
    `CREATE INDEX IF NOT EXISTS extractions_user_id_idx ON extractions(user_id)`,
    `CREATE INDEX IF NOT EXISTS bindings_user_id_idx ON bindings(user_id)`,
    // Phase 3+: link documents back to their MinIO object key + the file manager
    // virtual-folder table. Idempotent like the user_id statements above.
    `ALTER TABLE documents ADD COLUMN IF NOT EXISTS minio_key TEXT`,
    `CREATE TABLE IF NOT EXISTS file_folders (
       id TEXT PRIMARY KEY,
       user_id TEXT NOT NULL,
       path TEXT NOT NULL,
       created_at timestamptz NOT NULL DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS idx_file_folders_user ON file_folders(user_id)`,
    // 文件管理拖拽排序: 文件夹顺序列 + 文件对象顺序表（与 SQLite 同构，幂等）。
    `ALTER TABLE file_folders ADD COLUMN IF NOT EXISTS sort_order INTEGER`,
    `CREATE TABLE IF NOT EXISTS file_sort_orders (
       user_id TEXT NOT NULL,
       obj_key TEXT NOT NULL,
       sort_order INTEGER NOT NULL DEFAULT 0,
       PRIMARY KEY (user_id, obj_key)
     )`,
    // classifications: mirror of the SQLite table in migrate(). numeric(5,4) for
    // confidence matches extractions.overall_confidence pg convention.
    `CREATE TABLE IF NOT EXISTS classifications (
       id TEXT PRIMARY KEY,
       document_id TEXT NOT NULL REFERENCES documents(id),
       doc_type TEXT NOT NULL,
       confidence numeric(5,4) NOT NULL,
       source TEXT NOT NULL,
       hint TEXT,
       user_id TEXT NOT NULL DEFAULT '',
       created_at timestamptz NOT NULL DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS idx_classifications_doc ON classifications(document_id)`,
    `CREATE INDEX IF NOT EXISTS idx_classifications_user ON classifications(user_id)`,
    // document_tags: mirror of the SQLite table in migrate().
    `CREATE TABLE IF NOT EXISTS document_tags (
       id TEXT PRIMARY KEY,
       document_id TEXT NOT NULL REFERENCES documents(id),
       tag TEXT NOT NULL,
       source TEXT NOT NULL,
       user_id TEXT NOT NULL DEFAULT '',
       created_at timestamptz NOT NULL DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS idx_document_tags_doc ON document_tags(document_id)`,
    `CREATE INDEX IF NOT EXISTS idx_document_tags_user ON document_tags(user_id)`,
    // Structural idempotency backstop for saveDocumentTags (see SQLite DDL comment).
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_document_tags_unique ON document_tags(document_id, tag, source, user_id)`,
    // Post-ingest review: advisory review status + proposed relationships.
    `ALTER TABLE documents ADD COLUMN IF NOT EXISTS review_status TEXT NOT NULL DEFAULT 'pending'`,
    `ALTER TABLE documents ADD COLUMN IF NOT EXISTS reviewed_at timestamptz`,
    `ALTER TABLE documents ADD COLUMN IF NOT EXISTS reviewed_by TEXT`,
    // Persisted vectorization outcome (Bug fix: previously an in-memory Map, lost
    // on restart and never written by the /api/files upload path).
    `ALTER TABLE documents ADD COLUMN IF NOT EXISTS vectorization_meta jsonb`,
    `ALTER TABLE documents ADD COLUMN IF NOT EXISTS graph_status jsonb`,
    `ALTER TABLE extractions ADD COLUMN IF NOT EXISTS proposed_relationships jsonb`,
    // Lane A (2a): auto-extraction lifecycle status. NULL = 'pending' (opt-in).
    `ALTER TABLE documents ADD COLUMN IF NOT EXISTS extraction_status TEXT`,
    // Lane B: per-chunk semantic tags (JSON string[] | NULL).
    `ALTER TABLE doc_chunk ADD COLUMN IF NOT EXISTS tags JSONB`,
    // Model B parse lifecycle column (mirror of the SQLite guarded ALTER above).
    `ALTER TABLE documents ADD COLUMN IF NOT EXISTS parse_status TEXT NOT NULL DEFAULT 'uploaded'`,
    // Contract ledger persistence layer (ingest extraction write-back). Mirror
    // of the SQLite contract_ledger; timestamptz / jsonb / boolean per the pg
    // convention (extractions parity). UNIQUE index backs the ON CONFLICT upsert.
    `CREATE TABLE IF NOT EXISTS contract_ledger (
       id TEXT PRIMARY KEY,
       contract_no TEXT NOT NULL,
       display_contract_no TEXT NOT NULL,
       doc_type TEXT NOT NULL,
       document_id TEXT NOT NULL,
       title TEXT NOT NULL DEFAULT '',
       fields jsonb NOT NULL,
       field_meta jsonb NOT NULL,
       overall_confidence numeric(5,4) NOT NULL,
       needs_review boolean NOT NULL DEFAULT false,
       user_id TEXT NOT NULL DEFAULT '',
       contract_type TEXT,
       created_at timestamptz NOT NULL DEFAULT NOW(),
       updated_at timestamptz NOT NULL DEFAULT NOW()
     )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_contract_ledger_no_user ON contract_ledger(contract_no, user_id)`,
    // 合同类型维度(spec 2026-08-20 §3): 存量库补列(SQLite 侧同款 guarded ALTER)。
    `ALTER TABLE contract_ledger ADD COLUMN IF NOT EXISTS contract_type TEXT`,
    // Execution flows (六向执行流水): mirror of the SQLite execution_flows.
    // amount/quantity_ton 用 double precision(对应 SQLite REAL), confidence 沿用
    // numeric(5,4) pg 惯例, created_at timestamptz。UNIQUE 索引支撑 ON CONFLICT upsert。
    `CREATE TABLE IF NOT EXISTS execution_flows (
       id TEXT PRIMARY KEY,
       binding_id TEXT NOT NULL,
       document_id TEXT NOT NULL,
       contract_no TEXT NOT NULL,
       flow_type TEXT NOT NULL,
       direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
       amount double precision,
       quantity_ton double precision,
       unit TEXT,
       doc_type TEXT NOT NULL,
       voucher_date TEXT,
       extraction_id TEXT,
       confidence numeric(5,4) NOT NULL DEFAULT 0,
       created_by TEXT NOT NULL,
       user_id TEXT,
       created_at timestamptz NOT NULL DEFAULT NOW()
     )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_flows_binding ON execution_flows(binding_id, user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_execution_flows_contract ON execution_flows(contract_no, user_id)`,
    // Traceability for pre-existing PG dev DBs (SQLite mirrors the guarded ALTER above).
    `ALTER TABLE execution_flows ADD COLUMN IF NOT EXISTS extraction_id TEXT`,
    // Unit as its own column (grafted from CodeX-2): bare '数量' fields carry no
    // unit semantics, so unit stays NULL rather than being guessed.
    `ALTER TABLE execution_flows ADD COLUMN IF NOT EXISTS unit TEXT`,
    // 自主体名单(Task A): pg mirror of the SQLite self_parties. name 为原始名
    // (PK), created_by 审计, created_at timestamptz。租户全局, 无 user_id。
    `CREATE TABLE IF NOT EXISTS self_parties (
       name TEXT PRIMARY KEY,
       created_by TEXT NOT NULL,
       created_at timestamptz NOT NULL DEFAULT NOW()
     )`,
    // 项目维度(spec 2026-08-20 §4.1): pg mirror of the SQLite projects /
    // project_memberships。confidence 用 double precision(SQLite REAL 对应),
    // 时间列 timestamptz。DDL 不进 drizzle schema.ts。
    `CREATE TABLE IF NOT EXISTS projects (
       id TEXT PRIMARY KEY,
       code TEXT NOT NULL,
       name TEXT NOT NULL,
       status TEXT NOT NULL DEFAULT 'active',
       user_id TEXT,
       created_at timestamptz NOT NULL DEFAULT NOW(),
       updated_at timestamptz NOT NULL DEFAULT NOW()
     )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS projects_code_user_uq ON projects (code, user_id)`,
    `CREATE TABLE IF NOT EXISTS project_memberships (
       id TEXT PRIMARY KEY,
       contract_no TEXT NOT NULL,
       project_code TEXT NOT NULL,
       role TEXT,
       status TEXT NOT NULL DEFAULT 'proposed',
       proposed_by TEXT NOT NULL DEFAULT 'system',
       confirmation_source TEXT,
       confidence double precision NOT NULL DEFAULT 0,
       created_by TEXT NOT NULL DEFAULT 'system',
       user_id TEXT,
       created_at timestamptz NOT NULL DEFAULT NOW(),
       graph_status jsonb
     )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS project_memberships_uq
       ON project_memberships (contract_no, project_code, user_id)`,
    `CREATE INDEX IF NOT EXISTS project_memberships_project_idx
       ON project_memberships (project_code, user_id)`,
    `CREATE INDEX IF NOT EXISTS project_memberships_contract_idx
       ON project_memberships (contract_no, user_id)`,
    // Graph links(spec 2026-08-25 方案A §3.3): pg mirror of the SQLite
    // graph_links。props/graph_status 为 TEXT(JSON 字符串)与 SQLite 对齐;
    // confidence numeric(5,4) 沿用 pg 惯例; triple 唯一支撑幂等 upsert。
    `CREATE TABLE IF NOT EXISTS graph_links (
       id TEXT PRIMARY KEY,
       kind TEXT NOT NULL,
       src_kind TEXT NOT NULL,
       src_key TEXT NOT NULL,
       src_label TEXT NOT NULL DEFAULT '',
       dst_kind TEXT NOT NULL,
       dst_key TEXT NOT NULL,
       dst_label TEXT NOT NULL DEFAULT '',
       props TEXT NOT NULL DEFAULT '{}',
       confidence numeric(5,4) NOT NULL DEFAULT 0,
       status TEXT NOT NULL DEFAULT 'proposed',
       confirmation_source TEXT,
       created_by TEXT NOT NULL,
       user_id TEXT NOT NULL DEFAULT '',
       created_at timestamptz NOT NULL DEFAULT NOW(),
       graph_status TEXT
     )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_graph_links_triple ON graph_links (kind, src_key, dst_key, user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_graph_links_user ON graph_links (user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_graph_links_src ON graph_links (src_kind, src_key)`,
    // Quotas(spec 2026-08-25 方案A §3.1): pg mirror of the SQLite quotas。
    // limit/used 用 double precision(SQLite REAL 对应); used/computed_at 只经
    // updateQuotaUsed 写入(对账桥物化)。
    `CREATE TABLE IF NOT EXISTS quotas (
       id TEXT PRIMARY KEY,
       scope TEXT NOT NULL,
       owner_key TEXT NOT NULL,
       owner_label TEXT NOT NULL DEFAULT '',
       limit_amount double precision NOT NULL,
       currency TEXT,
       period TEXT,
       used_amount double precision NOT NULL DEFAULT 0,
       computed_at TEXT,
       status TEXT NOT NULL DEFAULT 'active',
       created_by TEXT NOT NULL,
       user_id TEXT NOT NULL DEFAULT '',
       created_at timestamptz NOT NULL DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS idx_quotas_owner ON quotas (scope, owner_key, user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_quotas_user ON quotas (user_id)`,
    // 模板三表(spec 2026-08-26)。TEXT(JSON) 与 SQLite 对齐。
    `CREATE TABLE IF NOT EXISTS template_types (
       id TEXT PRIMARY KEY,
       kind TEXT NOT NULL,
       name TEXT NOT NULL,
       parent_id TEXT,
       props TEXT NOT NULL DEFAULT '{}',
       is_active INTEGER NOT NULL DEFAULT 1,
       created_at TEXT NOT NULL DEFAULT now(),
       updated_at TEXT NOT NULL DEFAULT now()
     )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS template_types_kind_name_uq ON template_types (kind, name)`,
    `CREATE INDEX IF NOT EXISTS template_types_parent ON template_types (parent_id)`,
    `CREATE TABLE IF NOT EXISTS template_edge_rules (
       id TEXT PRIMARY KEY,
       source_type_id TEXT NOT NULL,
       target_type_id TEXT NOT NULL DEFAULT '',
       edge_type TEXT NOT NULL,
       allowed_vocab TEXT NOT NULL DEFAULT '[]',
       anchor_weights TEXT,
       is_active INTEGER NOT NULL DEFAULT 1,
       template_version INTEGER NOT NULL DEFAULT 1,
       created_at TEXT NOT NULL DEFAULT now()
     )`,
    `CREATE INDEX IF NOT EXISTS template_edge_rules_src ON template_edge_rules (source_type_id, edge_type)`,
    `CREATE TABLE IF NOT EXISTS template_versions (
       version INTEGER PRIMARY KEY,
       changed_by TEXT NOT NULL,
       change_summary TEXT NOT NULL,
       changed_at TEXT NOT NULL DEFAULT now()
     )`,
    // P4: 种子冲突策略列(managed-wins)。NULL=纯种子行(boot 可覆写);非空=DB 优先。
    // 幂等(ADD COLUMN IF NOT EXISTS), 存量库补列(SQLite 侧同款 guarded ALTER)。
    `ALTER TABLE template_types ADD COLUMN IF NOT EXISTS managed_at timestamptz`,
    `ALTER TABLE template_types ADD COLUMN IF NOT EXISTS managed_by TEXT`,
    `ALTER TABLE template_edge_rules ADD COLUMN IF NOT EXISTS managed_at timestamptz`,
    `ALTER TABLE template_edge_rules ADD COLUMN IF NOT EXISTS managed_by TEXT`,
    // L4 FTS fix (2026-08-17): drizzle migration 0000 created doc_chunk.fts_vector
    // as a PLAIN tsvector column (no GENERATED), so it stays NULL forever and
    // every FTS query silently returns 0 hits. Recreate it as a GENERATED column
    // with CJK unigram preprocessing: a space is inserted after every char that
    // is not [0-9A-Za-z ], because to_tsvector('simple', ...) treats a contiguous
    // CJK run as ONE lexeme (multi-char Chinese queries never match otherwise).
    // The DO block drops the column UNLESS it is already a generated column with
    // the regexp_replace preprocessing (no-op on correctly-migrated DBs). ADD
    // COLUMN ... STORED rewrites the table once on the first boot -- fine at this
    // scale. Must stay in sync with toPgFtsQuery() in postgres-repositories.ts.
    `DO $$
    BEGIN
      IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'doc_chunk' AND column_name = 'fts_vector'
        )
         AND NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'doc_chunk' AND column_name = 'fts_vector'
            AND is_generated = 'ALWAYS' AND generation_expression LIKE '%regexp_replace%'
        ) THEN
        ALTER TABLE doc_chunk DROP COLUMN fts_vector;
      END IF;
    END $$;`,
    `ALTER TABLE doc_chunk ADD COLUMN IF NOT EXISTS fts_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple', regexp_replace(chunk_text, '([^0-9A-Za-z ])', '\\1 ', 'g'))) STORED`,
    `CREATE INDEX IF NOT EXISTS idx_doc_chunk_fts ON doc_chunk USING GIN (fts_vector)`,
  ];
  try {
    for (const sql of statements) {
      await pool.query(sql);
    }
  } catch (e) {
    console.warn(
      '[migratePostgres] schema migration failed (continuing; ' +
        'tables may pre-date these features or Postgres is unreachable):',
      e instanceof Error ? e.message : e,
    );
  }
}
