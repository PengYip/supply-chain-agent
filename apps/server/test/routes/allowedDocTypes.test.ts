import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import { ensureTemplateSeed } from '../../src/pipeline/templateSeed.js';
import { DOC_TYPES } from '../../src/pipeline/classifier.js';

// 沿 review.test.ts mock 范式: review.ts 的 ctx() 走 dbBackend.getDbContext。
const { ctxHolder } = vi.hoisted(() => ({ ctxHolder: { current: null as DbContext | null } }));
vi.mock('../../src/pipeline/db/dbBackend.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/pipeline/db/dbBackend.js')>();
  return { ...mod, getDbContext: () => ctxHolder.current };
});
const { allowedDocTypes } = await import('../../src/routes/review.js');

let ctx: DbContext;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
  ctxHolder.current = ctx;
});

describe('allowedDocTypes (wave5 acceptance fix 2)', () => {
  it('模板树活跃类型 + 非别名 legacy 类(含 收货单/发货单/结算单), 别名类型被拒', async () => {
    await ensureTemplateSeed(ctx);
    const types = await allowedDocTypes(ctx);
    // 非别名 legacy 类(提单/装箱单 为 aliasOf 别名, 树中剔除)
    for (const legacy of ['合同', '发票', '货转单', '化验报告', '付款凭证', '其他']) {
      expect(types).toContain(legacy);
    }
    // 模板树活跃但不在 legacy 八类的 v2 类型必须放行(人工纠偏不被堵死)
    for (const t of ['收货单', '发货单', '结算单']) expect(types).toContain(t);
    // 别名类型(提单/装箱单)必须被拒——boot 迁移会翻回主类型(小修 4 语义保持)
    expect(types).not.toContain('提单');
    expect(types).not.toContain('装箱单');
  });

  it('DB 读失败退回 legacy 八类, 永不 500', async () => {
    const broken = { backend: 'sqlite', sqlite: { prepare: () => { throw new Error('boom'); } } } as never;
    const types = await allowedDocTypes(broken as DbContext);
    expect(types).toEqual([...DOC_TYPES]);
  });
});