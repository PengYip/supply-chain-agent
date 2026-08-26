import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, migrate } from '../../src/pipeline/db/client.js';
import {
  ensureEdgeRule, ensureTemplateType, findTemplateTypeByName,
  listActiveEdgeRules, listTemplateTypes,
} from '../../src/pipeline/db/repositories.js';

const ctx = createDb();
beforeEach(() => migrate(ctx.sqlite));

describe('template repo', () => {
  it('ensure 幂等: 重复灌入不报错不重复', async () => {
    await ensureTemplateType(ctx, { id: 'dt-发票', kind: 'doc_type', name: '发票' });
    await ensureTemplateType(ctx, { id: 'dt-发票', kind: 'doc_type', name: '发票' });
    const rows = await listTemplateTypes(ctx);
    expect(rows.filter((r) => r.name === '发票')).toHaveLength(1);
  });

  it('findTemplateTypeByName 精确命中', async () => {
    await ensureTemplateType(ctx, { id: 'ct-采购', kind: 'contract_type', name: '采购' });
    expect((await findTemplateTypeByName(ctx, 'contract_type', '采购'))?.id).toBe('ct-采购');
    expect(await findTemplateTypeByName(ctx, 'contract_type', '不存在')).toBeNull();
  });

  it('ensureEdgeRule 词表 JSON往返 + isActive 过滤', async () => {
    await ensureTemplateType(ctx, { id: 'dt-付款凭证', kind: 'doc_type', name: '付款凭证' });
    await ensureEdgeRule(ctx, { id: 'er-pay-settles', sourceTypeId: 'dt-付款凭证', edgeType: 'settles', allowedVocab: ['收款', '付款'] });
    await ensureEdgeRule(ctx, { id: 'er-inactive', sourceTypeId: 'dt-付款凭证', edgeType: 'binds', allowedVocab: ['凭证'], isActive: false });
    const rules = await listActiveEdgeRules(ctx);
    const pay = rules.find((r) => r.id === 'er-pay-settles');
    expect(pay?.allowedVocab).toEqual(['收款', '付款']);
    expect(rules.some((r) => r.id === 'er-inactive')).toBe(false);
  });
});
