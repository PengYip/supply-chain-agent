import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate } from '../../src/pipeline/db/client.js';
import { ensureTemplateSeed } from '../../src/pipeline/templateSeed.js';
import { buildTemplateOverviewTool } from '../../src/pipeline/tools/templateOverviewTool.js';

const ctx = createDb();
beforeEach(async () => { migrate(ctx.sqlite); await ensureTemplateSeed(ctx); });

describe('template_overview tool', () => {
  it('无 docType: 返回全类型层级', async () => {
    const tool = buildTemplateOverviewTool({ ctx, userId: 'u1' });
    const res = await tool.execute({});
    expect(res.typeCount).toBeGreaterThanOrEqual(24);
    expect(res.coarse).toEqual(expect.arrayContaining(['合同', '立项书', '履约凭证', '其他']));
  });

  it('docType=收货单: 返回类型链 + settles 词表 + 允许合同类型', async () => {
    const tool = buildTemplateOverviewTool({ ctx, userId: 'u1' });
    const res = await tool.execute({ docType: '收货单' });
    expect(res.typeChain).toContain('收货单');
    expect(res.typeChain).toContain('履约凭证');
    expect(res.settlesVocab).toEqual(['收货']);
    expect(res.allowedContractTypes.length).toBeGreaterThanOrEqual(1);
  });
});