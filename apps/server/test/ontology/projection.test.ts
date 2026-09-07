// apps/server/test/ontology/projection.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import { listProjectedEntities } from '../../src/ontology/projection.js';

let ctx: DbContext;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
});

const insertContract = (id: string, contractNo: string, contractType: string | null) => {
  ctx.sqlite.prepare(
    `INSERT INTO contract_ledger (id, contract_no, display_contract_no, doc_type, document_id,
        title, fields, field_meta, overall_confidence, needs_review, user_id, contract_type)
     VALUES (?, ?, ?, '合同', 'doc-1', '', '{}', '{}', 1, 0, 'u1', ?)`,
  ).run(id, contractNo, contractNo, contractType);
};

describe('projection: TradeContract <- contract_ledger (read-only)', () => {
  it('maps registry vocabulary fields + label + source', async () => {
    insertContract('C1', 'HT-2026-001', '采购');
    const res = await listProjectedEntities(ctx, 'TradeContract', {}, 'u1');
    expect(res.total).toBe(1);
    const e = res.items[0]!;
    expect(e.id).toBe('C1');
    expect(e.source).toBe('contract_ledger');
    expect(e.label).toBe('HT-2026-001');
    expect(e.fields['contractNo']).toBe('HT-2026-001');
    expect(e.fields['contractType']).toBe('采购');
    expect(e.ingestedAt).toBeTruthy();
  });

  it('nullable contract_type omitted from fields (rendered empty by UI)', async () => {
    insertContract('C2', 'HT-2026-002', null);
    const res = await listProjectedEntities(ctx, 'TradeContract', {}, 'u1');
    expect(res.items[0]!.fields).not.toHaveProperty('contractType');
  });

  it('user scoping: other-user rows invisible, shared (empty user_id) visible', async () => {
    insertContract('C3', 'HT-2026-003', '采购');
    ctx.sqlite.prepare(
      `INSERT INTO contract_ledger (id, contract_no, display_contract_no, doc_type, document_id,
          title, fields, field_meta, overall_confidence, needs_review, user_id, contract_type)
       VALUES ('C4', 'HT-2026-004', 'HT-2026-004', '合同', 'doc-2', '', '{}', '{}', 1, 0, 'u2', '销售')`,
    ).run();
    ctx.sqlite.prepare(
      `INSERT INTO contract_ledger (id, contract_no, display_contract_no, doc_type, document_id,
          title, fields, field_meta, overall_confidence, needs_review, user_id, contract_type)
       VALUES ('C5', 'HT-2026-005', 'HT-2026-005', '合同', 'doc-3', '', '{}', '{}', 1, 0, '', '采购')`,
    ).run();
    const res = await listProjectedEntities(ctx, 'TradeContract', {}, 'u1');
    expect(res.items.map((e) => e.id).sort()).toEqual(['C3', 'C5']);
  });

  it('q filter + pagination', async () => {
    for (let i = 1; i <= 25; i += 1) {
      insertContract(`C${i}`, `HT-2026-${String(i).padStart(3, '0')}`, '采购');
    }
    const page2 = await listProjectedEntities(ctx, 'TradeContract', { page: 2, pageSize: 20 }, 'u1');
    expect(page2.items).toHaveLength(5);
    expect(page2.total).toBe(25);
    const q = await listProjectedEntities(ctx, 'TradeContract', { q: 'HT-2026-003' }, 'u1');
    expect(q.total).toBe(1);
  });

  it('types without a source return an empty page, not error (acceptance 4)', async () => {
    const res = await listProjectedEntities(ctx, 'TradeGoods', {}, 'u1');
    expect(res).toEqual({ items: [], total: 0, page: 1, pageSize: 20 });
  });
});
