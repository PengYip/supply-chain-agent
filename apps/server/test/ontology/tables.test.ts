import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';

let ctx: DbContext;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
});

const EDGE_COLS = ['id', 'relation', 'from_type', 'from_id', 'to_type', 'to_id',
  'params', 'valid_at', 'invalid_at', 'ingested_at', 'created_by', 'user_id'];
const FACT_COLS = ['id', 'entity_type', 'payload', 'valid_at', 'invalid_at',
  'ingested_at', 'created_by', 'user_id', 'document_id'];

function tableCols(table: string): string[] {
  return (ctx.sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .map((c) => c.name);
}

describe('ontology tables (SQLite lane)', () => {
  it('ontology_edges columns mirror the spec exactly', () => {
    expect(tableCols('ontology_edges')).toEqual(EDGE_COLS);
  });

  it('trade_facts columns mirror the spec exactly', () => {
    expect(tableCols('trade_facts')).toEqual(FACT_COLS);
  });

  it('migrate is idempotent (spec: 幂等建表)', () => {
    expect(() => migrate(ctx.sqlite)).not.toThrow(); // 二次迁移不报错
    ctx.sqlite.prepare(
      `INSERT INTO ontology_edges (id, relation, from_type, from_id, to_type, to_id,
         params, valid_at, created_by) VALUES ('OE-1','WRITE_OFF','PaymentEvent','TF-1',
         'InvoiceEvent','TF-2','{}','2026-06-15T00:00:00.000Z','test')`,
    ).run();
    expect(() => migrate(ctx.sqlite)).not.toThrow(); // 有数据后迁移仍幂等
  });

  it('ingested_at defaults to UTC ISO (lexicographic == chronological)', () => {
    ctx.sqlite.prepare(
      `INSERT INTO trade_facts (id, entity_type, payload, valid_at, created_by)
       VALUES ('TF-1','InvoiceEvent','{}','2026-06-15T00:00:00.000Z','test')`,
    ).run();
    const row = ctx.sqlite.prepare('SELECT ingested_at FROM trade_facts WHERE id = ?').get('TF-1') as { ingested_at: string };
    expect(row.ingested_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/); // T 分隔, 非 datetime('now') 空格格式
  });

  it('as-of comparisons work on the TEXT time columns', () => {
    ctx.sqlite.prepare(
      `INSERT INTO trade_facts (id, entity_type, payload, valid_at, invalid_at, created_by)
       VALUES ('TF-1','InvoiceEvent','{}','2026-06-15T00:00:00.000Z','2026-06-15T00:00:00.000Z','test')`,
    ).run();
    // invalid_at = valid_at: 任一 t >= 6/15 时该行被 asOfBusinessTime 排除(invalid_at > t 为假)
    const hit = ctx.sqlite.prepare(
      `SELECT COUNT(*) AS n FROM trade_facts
       WHERE valid_at <= ? AND (invalid_at IS NULL OR invalid_at > ?)`,
    ).get('2026-06-30T00:00:00.000Z', '2026-06-30T00:00:00.000Z') as { n: number };
    expect(hit.n).toBe(0);
  });
});
