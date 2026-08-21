// migrate-agent-db.ts -- one-shot data migration: SQLite agent.db -> Postgres.
//
// Copies the 5 harness session-store tables (sessions / session_messages /
// pending_approvals / session_events / session_favorites) from the SQLite file
// into the Postgres database named by DATABASE_URL. The Postgres tables are
// created idempotently first (ensureSessionTables from
// src/harness/sessionStorePostgres.ts -- the runtime DDL), so this script is
// safe to run against an EMPTY database (zero-downtime ordering: PG side is
// provisioned BEFORE the new code is deployed).
//
// Idempotent + non-destructive by design:
//   - every INSERT uses ON CONFLICT ... DO NOTHING -- rows already present in
//     PG (from an earlier run or live traffic after the flip) are NEVER
//     overwritten, so re-running is always safe;
//   - the script NEVER issues DELETE / TRUNCATE / DROP -- source of truth on
//     conflicts is the PG side.
//
// The legacy `authorized_tickets` table found in old dev agent.db files is
// INTENTIONALLY NOT migrated (no code references it).
//
// Usage (from apps/server):
//   DATABASE_URL=postgresql://sca:...@host:5433/sca_test \
//     npx tsx scripts/migrate-agent-db.ts [--sqlite path/to/agent.db]
//
// The SQLite path defaults to ./data/agent.db (the runtime location). The
// source is opened READ-ONLY; nothing in the SQLite file is modified.

import Database from 'better-sqlite3';
import { Pool } from 'pg';
import { ensureSessionTables } from '../src/harness/sessionStorePostgres.js';

// ---- CLI ----

function parseSqliteArg(): string {
  const i = process.argv.indexOf('--sqlite');
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]!;
  return 'data/agent.db';
}

const SQLITE_PATH = parseSqliteArg();
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error(
    '[migrate-agent-db] DATABASE_URL is required (the Postgres target). ' +
      'Refusing to fall back to any default for a WRITE migration -- set it ' +
      'explicitly, e.g. DATABASE_URL=postgresql://sca:...@host:5433/sca.',
  );
  process.exit(1);
}

// ---- source: SQLite (read-only) ----

const sqlite = new Database(SQLITE_PATH, { readonly: true });

/**
 * Column names present on a SQLite table (defensive: very old agent.db files
 * predate the status/run_id/current_run_started_at ALTERs on `sessions`, and a
 * fresh empty DB may even lack whole tables -- both must not crash the run).
 */
function sqliteColumns(table: string): Set<string> {
  const rows = sqlite
    .prepare(`PRAGMA table_info(${table})`)
    .all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

/** SELECT a table with per-column fallbacks for missing legacy columns. */
function readTable(spec: TableSpec): Array<Record<string, unknown>> {
  const present = sqliteColumns(spec.table);
  if (present.size === 0) return []; // table absent in this (older) file
  const projection = spec.columns.map(([sq]) => {
    if (present.has(sq)) return sq;
    // e.g. status -> "'idle' AS status" so legacy rows migrate with the same
    // defaults the runtime guarded-ALTERs applied on the SQLite side.
    const fb = spec.fallbacks?.[sq];
    return fb ?? `NULL AS ${sq}`;
  });
  const order =
    spec.table === 'session_messages' || spec.table === 'session_events'
      ? ' ORDER BY session_id, seq'
      : '';
  const stmt = sqlite.prepare(`SELECT ${projection.join(', ')} FROM ${spec.table}${order}`);
  // Rows come back keyed by the sqlite column name; re-key to the pg column
  // name so copyTable can index uniformly (they are identical today except by
  // convention, but keep the mapping explicit).
  const rows = stmt.all() as Array<Record<string, unknown>>;
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [sq, pg] of spec.columns) out[pg] = row[sq] ?? null;
    return out;
  });
}

interface TableSpec {
  table: string;
  /** (sqlite column, pg column) pairs in insertion order. */
  columns: Array<[string, string]>;
  /** Fallback SELECT expression when the column is missing on old files. */
  fallbacks?: Record<string, string>;
  /** Postgres conflict target for ON CONFLICT DO NOTHING (the table PK). */
  conflict: string;
}

const TABLES: TableSpec[] = [
  {
    // Insert FIRST: the other tables' FKs reference sessions(id).
    table: 'sessions',
    columns: [
      ['id', 'id'],
      ['role', 'role'],
      ['created_at', 'created_at'],
      ['updated_at', 'updated_at'],
      ['metadata_json', 'metadata_json'],
      ['user_id', 'user_id'],
      ['status', 'status'],
      ['run_id', 'run_id'],
      ['current_run_started_at', 'current_run_started_at'],
    ],
    // Legacy rows created before the background-runtime ALTERs read as NULL
    // in SQLite only when the column exists but was never set; when the whole
    // column is absent (very old file) default the same value the ALTER did.
    fallbacks: { status: `'idle' AS status` },
    conflict: '(id)',
  },
  {
    table: 'session_messages',
    columns: [
      ['session_id', 'session_id'],
      ['seq', 'seq'],
      ['model_message_json', 'model_message_json'],
    ],
    conflict: '(session_id, seq)',
  },
  {
    table: 'pending_approvals',
    columns: [
      ['id', 'id'],
      ['session_id', 'session_id'],
      ['level', 'level'],
      ['tool_name', 'tool_name'],
      ['tool_call_id', 'tool_call_id'],
      ['input_json', 'input_json'],
      ['ticket_id', 'ticket_id'],
      ['approval_id', 'approval_id'],
      ['status', 'status'],
      ['created_at', 'created_at'],
    ],
    conflict: '(id)',
  },
  {
    table: 'session_events',
    columns: [
      ['session_id', 'session_id'],
      ['seq', 'seq'],
      ['type', 'type'],
      ['payload_json', 'payload_json'],
      ['created_at', 'created_at'],
    ],
    conflict: '(session_id, seq)',
  },
  {
    table: 'session_favorites',
    columns: [
      ['session_id', 'session_id'],
      ['user_id', 'user_id'],
      ['user_email', 'user_email'],
      ['note', 'note'],
      ['created_at', 'created_at'],
      ['updated_at', 'updated_at'],
    ],
    conflict: '(session_id, user_id)',
  },
];

// ---- target: Postgres ----

const pool = new Pool({ connectionString: DATABASE_URL, max: 2 });

/** Chunked INSERT ... ON CONFLICT DO NOTHING. Returns rows actually inserted. */
async function copyTable(spec: TableSpec, rows: Array<Record<string, unknown>>): Promise<number> {
  if (rows.length === 0) return 0;
  const pgCols = spec.columns.map(([, pg]) => pg);
  const CHUNK = 200;
  let inserted = 0;
  for (let off = 0; off < rows.length; off += CHUNK) {
    const chunk = rows.slice(off, off + CHUNK);
    const params: unknown[] = [];
    const tuples = chunk.map((row) => {
      const placeholders = spec.columns.map(([, pg]) => {
        params.push(row[pg] ?? null);
        return `$${params.length}`;
      });
      return `(${placeholders.join(', ')})`;
    });
    const sql =
      `INSERT INTO ${spec.table} (${pgCols.join(', ')}) VALUES ${tuples.join(', ')} ` +
      `ON CONFLICT ${spec.conflict} DO NOTHING`;
    const res = await pool.query(sql, params);
    inserted += res.rowCount ?? 0;
  }
  return inserted;
}

async function main(): Promise<void> {
  console.log(`[migrate-agent-db] source : ${SQLITE_PATH} (read-only)`);
  console.log(
    '[migrate-agent-db] target :',
    DATABASE_URL.replace(/\/\/[^@]*@/, '//***@'),
  );

  // Provision first (idempotent DDL shared with the runtime backend) so an
  // empty target database works -- deploy ordering is code-last.
  await ensureSessionTables(pool);

  let totalSrc = 0;
  let totalIns = 0;
  console.log('[migrate-agent-db] ---- per-table stats ----');
  for (const spec of TABLES) {
    const rows = readTable(spec);
    const inserted = await copyTable(spec, rows);
    totalSrc += rows.length;
    totalIns += inserted;
    const skipped = rows.length - inserted;
    console.log(
      `  ${spec.table.padEnd(20)} source=${String(rows.length).padStart(6)}  ` +
        `inserted=${String(inserted).padStart(6)}  ` +
        `skipped(conflict)=${String(skipped).padStart(6)}`,
    );
  }
  console.log(
    `[migrate-agent-db] done: ${totalIns}/${totalSrc} rows copied ` +
      `(skipped rows already existed in PG and were left untouched).`,
  );
}

main()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[migrate-agent-db] FAILED:', err instanceof Error ? err.message : err);
    void pool.end().finally(() => process.exit(1));
  });
