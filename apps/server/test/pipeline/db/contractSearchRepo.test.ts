import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate, type DbContext } from '../../../src/pipeline/db/client.js';
import { upsertContractLedgerEntry, searchContractLedger } from '../../../src/pipeline/db/repositories.js';
import type { ContractLedgerEntry } from '../../../src/pipeline/contractLedger.js';

let ctx: DbContext;
beforeEach(() => { ctx = createDb(':memory:'); migrate(ctx.sqlite); });

function mk(p: Partial<ContractLedgerEntry> & { contractNo: string }, userId = 'u1'): ContractLedgerEntry {
  return {
    displayContractNo: p.contractNo, docType: '合同', documentId: 'D', title: '',
    contractType: null, fields: { 合同号: { value: p.contractNo, sourceSpans: [] } },
    fieldMeta: {}, overallConfidence: 1, needsReview: false, userId, ...p,
  } as ContractLedgerEntry;
}

describe('searchContractLedger(SQLite)', () => {
  beforeEach(async () => {
    await upsertContractLedgerEntry(ctx, mk({
      contractNo: 'CJXC-2024-001',
      title: '动力煤采购合同',
      fields: {
        合同号: { value: 'CJXC-2024-001', sourceSpans: [] },
        买方: { value: '浙江浙能富兴燃料有限公司', sourceSpans: [] },
        卖方: { value: '山西焦煤集团', sourceSpans: [] },
      },
    }));
    await upsertContractLedgerEntry(ctx, mk({ contractNo: 'HT-2024-002', title: '焦炭销售合同' }));
  });

  it('合同号包含命中 + matchedField=contractNo', async () => {
    const items = await searchContractLedger(ctx, 'CJXC', 'u1', 10);
    expect(items).toHaveLength(1);
    expect(items[0]?.contractNo).toBe('CJXC-2024-001');
    expect(items[0]?.matchedField).toBe('contractNo');
  });

  it('买方中文名子串(模糊包含)命中 fields JSON 内的 买方 键', async () => {
    const items = await searchContractLedger(ctx, '浙能富兴', 'u1', 10);
    expect(items[0]?.contractNo).toBe('CJXC-2024-001');
    expect(items[0]?.matchedField).toBe('buyer');
    expect(items[0]?.buyer).toBe('浙江浙能富兴燃料有限公司');
  });

  it('卖方命中', async () => {
    const items = await searchContractLedger(ctx, '焦煤集团', 'u1', 10);
    expect(items[0]?.matchedField).toBe('seller');
  });

  it('标题命中', async () => {
    const items = await searchContractLedger(ctx, '焦炭销售', 'u1', 10);
    expect(items[0]?.contractNo).toBe('HT-2024-002');
    expect(items[0]?.matchedField).toBe('title');
  });

  it('user 隔离: 他人的台账不可见(legacy 空 user_id 行仍可见)', async () => {
    await upsertContractLedgerEntry(ctx, mk({ contractNo: 'OTHER-1' }, 'u2'));
    const items = await searchContractLedger(ctx, 'OTHER', 'u1', 10);
    expect(items).toHaveLength(0);
    const unscoped = await searchContractLedger(ctx, 'OTHER', undefined, 10);
    expect(unscoped).toHaveLength(1);
  });

  it('limit 截断与空结果', async () => {
    expect(await searchContractLedger(ctx, 'CJXC', 'u1', 0)).toEqual([]);
    expect(await searchContractLedger(ctx, '不存在词', 'u1', 10)).toEqual([]);
  });

  it('LIKE 通配符注入: % _ \\ 不匹配全部(转义端到端生效)', async () => {
    for (const q of ['%', '_', '\\']) {
      const items = await searchContractLedger(ctx, q, 'u1', 10);
      expect(items, `query=${JSON.stringify(q)}`).toEqual([]);
    }
  });

  it('全角中段合同号片段命中(粗筛 contains 放行到 JS 精排)', async () => {
    await upsertContractLedgerEntry(ctx, mk({ contractNo: 'CJXC-131-2024', title: '中段片段合同' }));
    // 全角中段片段 '１３１' 归一化为 '131', 命中 contract_no 中段 -> 0.9 分路径。
    const items = await searchContractLedger(ctx, '１３１', 'u1', 10);
    expect(items).toHaveLength(1);
    expect(items[0]?.contractNo).toBe('CJXC-131-2024');
    expect(items[0]?.matchedField).toBe('contractNo');
  });
});