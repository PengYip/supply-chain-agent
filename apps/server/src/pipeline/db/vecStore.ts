// Vector store for L4 semantic recall (Task 6 v2). Backend-neutral ASYNC surface
// over two implementations:
//   - SQLite: sqlite-vec vec0 virtual table (one 1024-dim embedding per chunk id),
//     cosine KNN via the vec0 MATCH operator.
//   - Postgres: pgvector vector(1024) column (doc_chunk.embedding), cosine KNN via
//     the `<=>` operator (HNSW index when present).
//
// The three public fns (isVecReady / saveChunkVectors / vectorKnn) take a
// DbContext and dispatch on ctx.backend; the SQLite-specific loader helpers
// (loadVecExtension / enableVec / ensureVecSchema / packVec) remain SQLite-only
// and are called only on the sqlite path (they take the raw better-sqlite3 handle).
//
// LOAD HARDENING (lib-2, mandatory): sqlite-vec is loaded per-connection. We
// try the convenient sqliteVec.load(db) first; on failure we fall back to
// db.loadExtension(getLoadablePath()), then to the .dll-suffix-STRIPPED path on
// win32 (SQLite appends the platform suffix itself; known 2026 failure mode),
// then to an explicit entry-point name ('sqlite3_vec_init'). Every path is
// asserted via vec_version() -- a silent load registers no functions, so the
// assertion is the source of truth, not the absence of a throw.
//
// GRACEFUL DEGRADATION: if every SQLite load path fails (e.g. air-gapped host
// missing the platform binary, or the npm package absent), every function here
// returns an empty/false result and recall_documents falls back to the FTS5
// strategy (see resolveStrategy in recall.ts). The agent never crashes on a
// missing extension; it just loses semantic recall. (Postgres: pgvector is
// always considered ready after provisioning -- isVecReady returns true.)

import type Database from 'better-sqlite3';
import type { DbContext } from './client.js';
import { createRequire } from 'node:module';
import {
  saveChunkVectorsPg,
  vectorKnnPg,
} from './postgres-repositories.js';

const requireModule = createRequire(import.meta.url);

/** Embedding dimensionality. Matches bge-m3 and the vec0 / vector(1024) column. */
export const VEC_DIM = 1024;

export interface VecCapability {
  ok: boolean;
  version: string | null;
}

export interface VectorRow {
  /** doc_chunk.id this vector corresponds to. */
  chunkRowId: number;
  vec: number[];
}

export interface VecKnnHit {
  chunkRowId: number;
  /** cosine distance (0 = identical, lower = closer). */
  distance: number;
}

/** Pack a (possibly short/long) number vector into a little-endian Float32 buffer. */
export function packVec(vec: number[]): Buffer {
  const arr = new Float32Array(VEC_DIM);
  const n = Math.min(vec.length, VEC_DIM);
  for (let i = 0; i < n; i++) arr[i] = vec[i] ?? 0;
  return Buffer.from(arr.buffer);
}

// ---- SQLite-vec-specific (loader + storage) --------------------------------

/** True iff sqlite-vec is loaded and functional on this connection. */
export function isVecReadySqlite(sqlite: Database.Database): boolean {
  try {
    const r = sqlite.prepare('SELECT vec_version() AS v').get() as { v?: unknown } | undefined;
    return !!r && typeof r.v === 'string' && r.v.length > 0;
  } catch {
    return false;
  }
}

function versionOf(sqlite: Database.Database): string | null {
  try {
    const r = sqlite.prepare('SELECT vec_version() AS v').get() as { v?: string } | undefined;
    return r && typeof r.v === 'string' && r.v.length > 0 ? r.v : null;
  } catch {
    return null;
  }
}

/**
 * Load the sqlite-vec extension with the full hardening ladder. Returns the
 * capability; never throws (a load failure is reported as ok:false so callers
 * can degrade gracefully).
 */
export function loadVecExtension(sqlite: Database.Database): VecCapability {
  if (isVecReadySqlite(sqlite)) return { ok: true, version: versionOf(sqlite) };

  let sqliteVec: {
    load?: (db: Database.Database) => void;
    getLoadablePath?: () => string;
  };
  try {
    sqliteVec = requireModule('sqlite-vec');
  } catch {
    return { ok: false, version: null };
  }

  const path = typeof sqliteVec.getLoadablePath === 'function' ? sqliteVec.getLoadablePath() : null;

  // Build the ordered ladder of load attempts. NOTE: better-sqlite3's
  // loadExtension(path) takes a SINGLE argument -- it does not expose SQLite's
  // entry-point parameter, so the entry-point ('sqlite3_vec_init') is handled by
  // sqliteVec.load(db) internally (rung #1). The raw loadExtension rungs rely on
  // the filename convention and are belt-and-suspenders for when load() is absent.
  const attempts: Array<() => void> = [];
  if (typeof sqliteVec.load === 'function') {
    attempts.push(() => sqliteVec.load!(sqlite));
  }
  if (path) {
    attempts.push(() => sqlite.loadExtension(path));
    if (process.platform === 'win32' && /\.dll$/i.test(path)) {
      // SQLite appends the platform binary suffix itself on some builds; a path
      // already ending in .dll can resolve to vec0.dll.dll. Strip and retry.
      const stripped = path.replace(/\.dll$/i, '');
      attempts.push(() => sqlite.loadExtension(stripped));
    }
  }

  for (const attempt of attempts) {
    try {
      attempt();
      if (isVecReadySqlite(sqlite)) return { ok: true, version: versionOf(sqlite) };
    } catch {
      // try next strategy
    }
  }
  return { ok: false, version: null };
}

/**
 * Create the doc_chunk_vec vec0 table if the extension is loaded. Idempotent.
 * Returns false (and creates nothing) when sqlite-vec is unavailable.
 */
export function ensureVecSchema(sqlite: Database.Database): boolean {
  if (!isVecReadySqlite(sqlite)) return false;
  try {
    sqlite.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS doc_chunk_vec USING vec0(id INTEGER PRIMARY KEY, embedding float[${VEC_DIM}])`,
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * One-call connection setup: load the extension + create the vec0 table. Safe to
 * call on every connection (idempotent). Returns the resulting capability.
 */
export function enableVec(sqlite: Database.Database): VecCapability {
  const cap = loadVecExtension(sqlite);
  if (!cap.ok) return cap;
  ensureVecSchema(sqlite);
  return cap;
}

/**
 * Upsert chunk vectors into doc_chunk_vec (SQLite). doc_chunk AUTOINCREMENT rowids
 * are never reused, but we DELETE-then-INSERT per id for explicit upsert
 * semantics (defensive against any future rowid reuse). Uses BigInt ids -- vec0
 * rejects plain JS numbers for the integer PK (better-sqlite3 binding quirk).
 */
export function saveChunkVectorsSqlite(sqlite: Database.Database, rows: VectorRow[]): number {
  if (!isVecReadySqlite(sqlite) || rows.length === 0) return 0;
  const del = sqlite.prepare('DELETE FROM doc_chunk_vec WHERE id = ?');
  const ins = sqlite.prepare('INSERT INTO doc_chunk_vec (id, embedding) VALUES (?, ?)');
  const tx = sqlite.transaction((rs: VectorRow[]) => {
    for (const r of rs) {
      del.run(BigInt(r.chunkRowId));
      ins.run(BigInt(r.chunkRowId), packVec(r.vec));
    }
  });
  try {
    tx(rows);
    return rows.length;
  } catch {
    return 0;
  }
}

/**
 * Cosine KNN over doc_chunk_vec (SQLite). Returns up to `k` nearest chunk
 * rowids, nearest first. Returns [] if sqlite-vec is unavailable (graceful
 * degradation). Note: KNN always returns the k nearest regardless of relevance
 * -- callers that need a "no match" semantic must use the FTS5 strategy or apply
 * a threshold.
 */
export function vectorKnnSqlite(sqlite: Database.Database, queryVec: number[], k: number): VecKnnHit[] {
  if (!isVecReadySqlite(sqlite)) return [];
  const safeK = k > 0 ? Math.floor(k) : 5;
  try {
    const rows = sqlite
      .prepare(
        'SELECT id AS chunkRowId, distance FROM doc_chunk_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?',
      )
      .all(packVec(queryVec), safeK) as Array<{ chunkRowId: number | bigint; distance: number }>;
    return rows.map((r) => ({
      chunkRowId: Number(r.chunkRowId),
      distance: Number(r.distance),
    }));
  } catch {
    return [];
  }
}

// ---- Backend-neutral ASYNC dispatchers -------------------------------------
//
// The public surface consumed by the tools (documentEntry / recall). Each
// dispatches on ctx.backend; the sqlite branch delegates to the *Sqlite impls
// above (wrapping the sync result in a Promise), the postgres branch delegates
// to the pgvector impls in postgres-repositories.ts.

/**
 * True iff the vector backend is ready: sqlite-vec loaded (sqlite) or pgvector
 * provisioned (postgres, assumed on). Async so the postgres branch could verify
 * without changing the signature.
 */
export async function isVecReady(ctx: DbContext): Promise<boolean> {
  if (ctx.backend === 'postgres') return true;
  return isVecReadySqlite(ctx.sqlite);
}

/**
 * Upsert chunk vectors (sqlite: vec0 table; postgres: doc_chunk.embedding).
 * Returns the number of rows written.
 */
export async function saveChunkVectors(ctx: DbContext, rows: VectorRow[]): Promise<number> {
  if (ctx.backend === 'postgres') return saveChunkVectorsPg(ctx, rows);
  return saveChunkVectorsSqlite(ctx.sqlite, rows);
}

/**
 * Cosine KNN over chunk vectors. Returns up to `k` nearest chunk rowids, nearest
 * first. Returns [] when the vector backend is unavailable (sqlite-vec missing)
 * or when no embeddings are stored yet.
 */
export async function vectorKnn(ctx: DbContext, queryVec: number[], k: number): Promise<VecKnnHit[]> {
  if (ctx.backend === 'postgres') return vectorKnnPg(ctx, queryVec, k);
  return vectorKnnSqlite(ctx.sqlite, queryVec, k);
}
