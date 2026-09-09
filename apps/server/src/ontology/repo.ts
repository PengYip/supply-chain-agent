// 本体基座仓储(双后端 dispatch, 仿 pipeline/db/repositories.ts 模式)。
// 写入边界=注册表 zod 校验(entitySchema/relationDef/isRelationPairAllowed),
// 不要绕过本模块直写 ontology_edges/trade_facts。
import type { DbContext, PostgresDbContext } from '../pipeline/db/client.js';
import { effectiveUserId } from '../pipeline/db/repositories.js';
import {
  entitySchema, relationDef, isRelationPairAllowed,
  type OntologyEntityName,
} from './index.js';
import { normalizeIsoUtc, numberPlaceholders, type AsOfPredicate } from './asof.js';

const rid = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

// ---------------------------------------------------------------------------
// 输入/行类型
// ---------------------------------------------------------------------------

export interface TradeFactInput {
  entityType: OntologyEntityName;
  payload: Record<string, unknown>;
  validAt: string | Date;
  invalidAt?: string | Date | null;
  ingestedAt?: string | Date;
  createdBy: string;
  /** P3 凭证据源(2026-09-09): documents.id 溯源锚点; 可选, 图投影据此写 EVIDENCE 边。 */
  documentId?: string | null;
}

export interface OntologyEdgeInput {
  relation: string;
  fromType: OntologyEntityName;
  fromId: string;
  toType: OntologyEntityName;
  toId: string;
  params?: Record<string, unknown>;
  validAt: string | Date;
  invalidAt?: string | Date | null;
  ingestedAt?: string | Date;
  createdBy: string;
}

export interface TradeFactRow {
  id: string; entityType: string; payload: Record<string, unknown>;
  validAt: string; invalidAt: string | null; ingestedAt: string;
  createdBy: string; userId: string;
  /** documents.id 溯源锚点; NULL=无来源单据。 */
  documentId: string | null;
}

export interface OntologyEdgeRow {
  id: string; relation: string;
  fromType: string; fromId: string; toType: string; toId: string;
  params: Record<string, unknown>;
  validAt: string; invalidAt: string | null; ingestedAt: string;
  createdBy: string; userId: string;
}

const FACT_COLS = 'id, entity_type, payload, valid_at, invalid_at, ingested_at, created_by, user_id, document_id';
const EDGE_COLS = 'id, relation, from_type, from_id, to_type, to_id, params, valid_at, invalid_at, ingested_at, created_by, user_id';

const parseJson = (raw: unknown): Record<string, unknown> => {
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
  }
  return (raw ?? {}) as Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// trade_facts
// ---------------------------------------------------------------------------

export async function insertTradeFact(
  ctx: DbContext, input: TradeFactInput, userId?: string,
): Promise<string> {
  // 写入边界: 注册表词汇 + 语义规则(entitySchema 含事件金额方向 refinement)。
  // M-1: 持久化 parse 后的规范值(strict 下非法键已 throw，不会走到静默剥离)。
  const canonical = entitySchema(input.entityType).parse(input.payload);
  const id = rid('TF');
  const validAt = normalizeIsoUtc(input.validAt);
  const invalidAt = input.invalidAt == null ? null : normalizeIsoUtc(input.invalidAt);
  const ingestedAt = input.ingestedAt == null ? null : normalizeIsoUtc(input.ingestedAt);
  const uid = effectiveUserId(userId);

  if (ctx.backend === 'postgres') {
    const pg = ctx as PostgresDbContext;
    await pg.pool.query(
      `INSERT INTO trade_facts (${FACT_COLS})
       VALUES ($1,$2,$3,$4,$5,COALESCE($6, NOW()),$7,$8,$9)`,
      [id, input.entityType, JSON.stringify(canonical), validAt, invalidAt,
       ingestedAt, input.createdBy, uid, input.documentId ?? null],
    );
    return id;
  }
  ctx.sqlite.prepare(
    `INSERT INTO trade_facts (id, entity_type, payload, valid_at, invalid_at, ingested_at, created_by, user_id, document_id)
     VALUES (?, ?, ?, ?, ?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ','now')), ?, ?, ?)`,
  ).run(id, input.entityType, JSON.stringify(canonical), validAt, invalidAt,
    ingestedAt, input.createdBy, uid, input.documentId ?? null);
  return id;
}

function factRowFrom(r: Record<string, unknown>, pg: boolean): TradeFactRow {
  const iso = (v: unknown): string | null =>
    v == null ? null : pg ? new Date(v as string).toISOString() : v as string;
  return {
    id: r['id'] as string,
    entityType: r['entity_type'] as string,
    payload: parseJson(r['payload']),
    validAt: iso(r['valid_at']) as string,
    invalidAt: iso(r['invalid_at']),
    ingestedAt: iso(r['ingested_at']) as string,
    createdBy: r['created_by'] as string,
    userId: r['user_id'] as string,
    documentId: r['document_id'] == null ? null : String(r['document_id']),
  };
}

export async function listTradeFactsAsOf(
  ctx: DbContext, pred: AsOfPredicate, opts: { entityType?: string } = {}, userId?: string,
): Promise<TradeFactRow[]> {
  const uid = effectiveUserId(userId);
  const conds = [pred.sql, "(user_id = ? OR user_id = '')"];
  const params = [...pred.params, uid];
  if (opts.entityType) { conds.push('entity_type = ?'); params.push(opts.entityType); }
  const where = conds.join(' AND ');

  if (ctx.backend === 'postgres') {
    const pg = ctx as PostgresDbContext;
    const res = await pg.pool.query(
      `SELECT ${FACT_COLS} FROM trade_facts WHERE ${numberPlaceholders(where)} ORDER BY valid_at, id`,
      params,
    );
    return (res.rows as Array<Record<string, unknown>>).map((r) => factRowFrom(r, true));
  }
  const rows = ctx.sqlite.prepare(
    `SELECT ${FACT_COLS} FROM trade_facts WHERE ${where} ORDER BY valid_at, id`,
  ).all(...params) as Array<Record<string, unknown>>;
  return rows.map((r) => factRowFrom(r, false));
}

/** 按 id 单行读取(台账详情定位用)；用户隔离与 list 一致。 */
export async function getTradeFactById(
  ctx: DbContext, id: string, userId?: string,
): Promise<TradeFactRow | null> {
  const uid = effectiveUserId(userId);
  const where = "id = ? AND (user_id = ? OR user_id = '')";
  if (ctx.backend === 'postgres') {
    const pg = ctx as PostgresDbContext;
    const res = await pg.pool.query(
      `SELECT ${FACT_COLS} FROM trade_facts WHERE ${numberPlaceholders(where)}`,
      [id, uid],
    );
    const row = (res.rows as Array<Record<string, unknown>>)[0];
    return row ? factRowFrom(row, true) : null;
  }
  const row = ctx.sqlite.prepare(
    `SELECT ${FACT_COLS} FROM trade_facts WHERE ${where}`,
  ).get(id, uid) as Record<string, unknown> | undefined;
  return row ? factRowFrom(row, false) : null;
}

// ---------------------------------------------------------------------------
// ontology_edges
// ---------------------------------------------------------------------------

interface PreparedEdgeRow {
  id: string;
  relation: string;
  fromType: OntologyEntityName;
  fromId: string;
  toType: OntologyEntityName;
  toId: string;
  paramsJson: string;
  validAt: string;
  invalidAt: string | null;
  ingestedAt: string | null;
  createdBy: string;
  uid: string;
}

// 写入边界: 关系存在 + 连接对合法 + params 走关系的 strict schema
function prepareEdgeRow(input: OntologyEdgeInput, userId?: string): PreparedEdgeRow {
  const def = relationDef(input.relation);
  if (!isRelationPairAllowed(input.relation, input.fromType, input.toType)) {
    throw new Error(
      `ontology: relation "${input.relation}" does not allow ${input.fromType} -> ${input.toType}` +
      ` (allowed: ${def.pairs.map((p) => `${p.from}->${p.to}`).join(', ')})`);
  }
  const canonicalParams = def.params.parse(input.params ?? {});
  return {
    id: rid('OE'),
    relation: input.relation,
    fromType: input.fromType,
    fromId: input.fromId,
    toType: input.toType,
    toId: input.toId,
    paramsJson: JSON.stringify(canonicalParams),
    validAt: normalizeIsoUtc(input.validAt),
    invalidAt: input.invalidAt == null ? null : normalizeIsoUtc(input.invalidAt),
    ingestedAt: input.ingestedAt == null ? null : normalizeIsoUtc(input.ingestedAt),
    createdBy: input.createdBy,
    uid: effectiveUserId(userId),
  };
}

const PG_EDGE_INSERT = `INSERT INTO ontology_edges (${EDGE_COLS})
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10, NOW()),$11,$12)`;
const SQLITE_EDGE_INSERT = `INSERT INTO ontology_edges (id, relation, from_type, from_id, to_type, to_id, params,
      valid_at, invalid_at, ingested_at, created_by, user_id)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ','now')), ?, ?)`;

const edgeRowParams = (r: PreparedEdgeRow) => [
  r.id, r.relation, r.fromType, r.fromId, r.toType, r.toId,
  r.paramsJson, r.validAt, r.invalidAt, r.ingestedAt, r.createdBy, r.uid,
];

export async function insertOntologyEdge(
  ctx: DbContext, input: OntologyEdgeInput, userId?: string,
): Promise<string> {
  const row = prepareEdgeRow(input, userId);
  if (ctx.backend === 'postgres') {
    const pg = ctx as PostgresDbContext;
    await pg.pool.query(PG_EDGE_INSERT, edgeRowParams(row));
    return row.id;
  }
  ctx.sqlite.prepare(SQLITE_EDGE_INSERT).run(...edgeRowParams(row));
  return row.id;
}

/** 事务性批量落边: 全部行先过写入边界校验(校验期零连接占用), 再整批原子提交
 *  —— 任一条写入失败整批回滚、零边产生(核销"失败整单拒绝"语义的落地保证)。
 *  返回与输入顺序一致的边 id 数组。 */
export async function insertOntologyEdgesBatch(
  ctx: DbContext, inputs: OntologyEdgeInput[], userId?: string,
): Promise<string[]> {
  const rows = inputs.map((i) => prepareEdgeRow(i, userId));
  if (rows.length === 0) return [];
  if (ctx.backend === 'postgres') {
    const pg = ctx as PostgresDbContext;
    const client = await pg.pool.connect();
    try {
      await client.query('BEGIN');
      for (const r of rows) await client.query(PG_EDGE_INSERT, edgeRowParams(r));
      await client.query('COMMIT');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* 连接已坏, 无可回滚 */ }
      throw err;
    } finally {
      client.release();
    }
  } else {
    // better-sqlite3 事务要求同步函数体; 单条插入本就是同步 prepare/run。
    ctx.sqlite.transaction(() => {
      for (const r of rows) ctx.sqlite.prepare(SQLITE_EDGE_INSERT).run(...edgeRowParams(r));
    })();
  }
  return rows.map((r) => r.id);
}

export async function listOntologyEdgesAsOf(
  ctx: DbContext, pred: AsOfPredicate, opts: { relation?: string } = {}, userId?: string,
): Promise<OntologyEdgeRow[]> {
  const uid = effectiveUserId(userId);
  const conds = [pred.sql, "(user_id = ? OR user_id = '')"];
  const params = [...pred.params, uid];
  if (opts.relation) { conds.push('relation = ?'); params.push(opts.relation); }
  const where = conds.join(' AND ');

  const mapRow = (r: Record<string, unknown>, iso: (v: unknown) => string | null): OntologyEdgeRow => ({
    id: r['id'] as string,
    relation: r['relation'] as string,
    fromType: r['from_type'] as string, fromId: r['from_id'] as string,
    toType: r['to_type'] as string, toId: r['to_id'] as string,
    params: parseJson(r['params']),
    validAt: iso(r['valid_at']) as string,
    invalidAt: iso(r['invalid_at']),
    ingestedAt: iso(r['ingested_at']) as string,
    createdBy: r['created_by'] as string,
    userId: r['user_id'] as string,
  });

  if (ctx.backend === 'postgres') {
    const pg = ctx as PostgresDbContext;
    const res = await pg.pool.query(
      `SELECT ${EDGE_COLS} FROM ontology_edges WHERE ${numberPlaceholders(where)} ORDER BY valid_at, id`,
      params,
    );
    return (res.rows as Array<Record<string, unknown>>).map((r) => mapRow(r, (v) =>
      v == null ? null : new Date(v as string).toISOString()));
  }
  const rows = ctx.sqlite.prepare(
    `SELECT ${EDGE_COLS} FROM ontology_edges WHERE ${where} ORDER BY valid_at, id`,
  ).all(...params) as Array<Record<string, unknown>>;
  return rows.map((r) => mapRow(r, (v) => (v == null ? null : v as string)));
}
