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

/**
 * 同主体（uscc）全部事实史（含失效行，valid_at 升序）——台账归一/名称史只读 helper
 * （spec 主体身份 §5；双后端仅 SELECT，用户隔离与 list 一致）。
 * uscc 存于 payload JSON：SQLite json_extract / PG ->> 双写法，缺 uscc 的行天然不命中。
 */
export async function listTradeFactHistory(
  ctx: DbContext,
  opts: { entityType: string; uscc: string },
  userId?: string,
): Promise<TradeFactRow[]> {
  const uid = effectiveUserId(userId);
  // uscc 存于 payload JSON：SQLite json_extract / PG ->> 双写法。
  const usccCond = ctx.backend === 'postgres'
    ? "payload->>'uscc' = ?"
    : "json_extract(payload, '$.uscc') = ?";
  const where = [`entity_type = ?`, "(user_id = ? OR user_id = '')", usccCond].join(' AND ');
  const params = [opts.entityType, uid, opts.uscc];

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
// supersede 换代(spec 主体身份 §4)：变更 = 同主体新事实 + 旧事实失效(一个事务)。
// ---------------------------------------------------------------------------

export interface SupersedeTradeFactInput {
  prevFactId: string;
  /** 新事实(payload 已含同主体 uscc)；经注册表 entitySchema strict 校验后落库。 */
  next: TradeFactInput;
  /** 换代生效时点(= 旧事实 invalid_at)；缺省 = next.validAt(调用方再缺省为登记时刻)。 */
  validAt?: string | Date;
}

/** trade_facts INSERT 参数(双后端同序，ingested_at 占位走 COALESCE 缺省)。 */
function insertFactParams(r: {
  newId: string; entityType: string; canonical: Record<string, unknown>;
  validAt: string; invalidAt: string | null; ingestedAt: string | null;
  createdBy: string; uid: string; documentId?: string | null;
}): unknown[] {
  return [
    r.newId, r.entityType, JSON.stringify(r.canonical), r.validAt, r.invalidAt,
    r.ingestedAt, r.createdBy, r.uid, r.documentId ?? null,
  ];
}

/**
 * 事务内两步：INSERT 新事实 + UPDATE 旧行 invalid_at——任一步失败整批回滚
 * (范式对齐 insertOntologyEdgesBatch：先全部校验再开事务)。
 * 函数内再次强制(调用方前置校验之外的兜底)：
 *   prev 存在且可见(userId 口径同 getTradeFactById) / prev.entityType === next.entityType
 *   / prev.payload.uscc === next.payload.uscc(防跨主体误换代) / prev 未被失效过。
 * 返回 { newId, prevInvalidAt }；前置不满足 throw（REST 层转 4xx）。
 */
export async function supersedeTradeFact(
  ctx: DbContext, input: SupersedeTradeFactInput, userId?: string,
): Promise<{ newId: string; prevInvalidAt: string }> {
  const uid = effectiveUserId(userId);
  const newId = rid('TF');
  const changeAt = normalizeIsoUtc(input.validAt ?? input.next.validAt);
  const validAt = normalizeIsoUtc(input.next.validAt);
  const invalidAt = input.next.invalidAt == null ? null : normalizeIsoUtc(input.next.invalidAt);
  const ingestedAt = input.next.ingestedAt == null ? null : normalizeIsoUtc(input.next.ingestedAt);

  const prev = await getTradeFactById(ctx, input.prevFactId, userId);
  if (!prev) throw new Error(`supersede: 旧事实不存在或不可见: ${input.prevFactId}`);
  if (prev.entityType !== input.next.entityType) {
    throw new Error(`supersede: entityType 不一致(prev=${prev.entityType}, next=${input.next.entityType})`);
  }
  // 校验期零 DB 写：新事实过注册表写入边界(strict + 语义规则)后再比 uscc。
  const canonical = entitySchema(input.next.entityType).parse(input.next.payload);
  if (prev.payload['uscc'] !== canonical['uscc']) {
    throw new Error(
      `supersede: uscc 不一致——不得跨主体换代` +
      `(prev=${String(prev.payload['uscc'] ?? '<缺失>')}, next=${String(canonical['uscc'] ?? '<缺失>')})`,
    );
  }
  if (prev.invalidAt != null) {
    throw new Error(`supersede: 旧事实已失效(invalid_at=${prev.invalidAt}), 不得二次换代`);
  }

  const FACT_UPDATE =
    `UPDATE trade_facts SET invalid_at = ? WHERE id = ? AND invalid_at IS NULL AND (user_id = ? OR user_id = '')`;
  const updateParams = [changeAt, input.prevFactId, uid];

  if (ctx.backend === 'postgres') {
    const pg = ctx as PostgresDbContext;
    const client = await pg.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO trade_facts (${FACT_COLS})
         VALUES ($1,$2,$3,$4,$5,COALESCE($6, NOW()),$7,$8,$9)`,
        insertFactParams({ newId, entityType: input.next.entityType, canonical, validAt, invalidAt, ingestedAt, createdBy: input.next.createdBy, uid, documentId: input.next.documentId }),
      );
      const updated = await client.query(FACT_UPDATE, updateParams);
      if (updated.rowCount !== 1) {
        throw new Error(`supersede: 旧事实失效更新未命中(可能已被并发换代): ${input.prevFactId}`);
      }
      await client.query('COMMIT');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* 连接已坏, 无可回滚 */ }
      throw err;
    } finally {
      client.release();
    }
  } else {
    // better-sqlite3 事务要求同步函数体; 单条插入/更新本就是同步 prepare/run。
    // 更新未命中时事务整体回滚(新事实不残留), 错误原样抛给上层转 4xx。
    ctx.sqlite.transaction(() => {
      ctx.sqlite.prepare(
        `INSERT INTO trade_facts (id, entity_type, payload, valid_at, invalid_at, ingested_at, created_by, user_id, document_id)
         VALUES (?, ?, ?, ?, ?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ','now')), ?, ?, ?)`,
      ).run(...insertFactParams({ newId, entityType: input.next.entityType, canonical, validAt, invalidAt, ingestedAt, createdBy: input.next.createdBy, uid, documentId: input.next.documentId }));
      const updated = ctx.sqlite.prepare(FACT_UPDATE).run(...updateParams);
      if (updated.changes !== 1) {
        throw new Error(`supersede: 旧事实失效更新未命中(可能已被并发换代): ${input.prevFactId}`);
      }
    })();
  }
  return { newId, prevInvalidAt: changeAt };
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
