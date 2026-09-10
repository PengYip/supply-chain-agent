// apps/server/test/ontology/goodsRegisterTool.test.ts
// register_goods L2 工具(spec 2026-09-09 §11 Phase 2 波次一): 商品主数据注册兜底。
// 写入必经 insertTradeFact(createdBy='register_goods'), 注册表 strict zod +
// attributes 受控袋(32 条/标量/键长)对 Agent 预填同样生效;
// 归一键重复仍允许(重名不同规格合法), detail 软提示不阻断。
import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import { getTradeFactById, insertTradeFact } from '../../src/ontology/repo.js';
import { buildRegisterGoodsTool } from '../../src/ontology/goodsRegisterTool.js';
import { normalizeSpec } from '../../src/ontology/goodsSpec.js';

let ctx: DbContext;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
});

const CALL = { toolCallId: 'call_rg', messages: [] } as never;

describe('register_goods execute', () => {
  it('注册落库: createdBy=register_goods, attributes 透传, 图投影不阻塞', async () => {
    const t = buildRegisterGoodsTool({ ctx, userId: 'u1' });
    const out = await t.execute!({
      name: '螺纹钢', commodityCode: 'HRB400E', spec: 'HRB400E Φ12mm 9m定尺',
      unit: '吨', attributes: { '牌号': 'HRB400E', '直径': '12mm', '件重': 12 },
      validAt: '2026-09-10',
    }, CALL);
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    const row = await getTradeFactById(ctx, out.id, 'u1');
    expect(row?.entityType).toBe('TradeGoods');
    expect(row?.createdBy).toBe('register_goods');
    expect(row?.payload).toMatchObject({
      name: '螺纹钢', commodityCode: 'HRB400E',
      spec: 'HRB400E Φ12mm 9m定尺', unit: '吨',
      attributes: { '牌号': 'HRB400E', '直径': '12mm', '件重': 12 },
    });
    expect(out.detail).toBeUndefined(); // 无重复, 不提示
  });

  it('attributes 超限(33 条)被注册表写入边界拒绝 -> invalid 零落库', async () => {
    const t = buildRegisterGoodsTool({ ctx, userId: 'u1' });
    const big: Record<string, string> = {};
    for (let i = 0; i < 33; i += 1) big[`键${i}`] = 'v';
    const out = await t.execute!({
      name: '冻牛肉', commodityCode: 'BEEF-1', attributes: big, validAt: '2026-09-10',
    }, CALL);
    expect(out.status).toBe('invalid');
    if (out.status !== 'invalid') return;
    expect(out.detail).toContain('32');
  });

  it('重复 name+spec(归一键同)仍允许落库, detail 软提示疑似重复', async () => {
    await insertTradeFact(ctx, {
      entityType: 'TradeGoods',
      payload: { name: '螺纹钢', commodityCode: 'HRB400E', spec: 'HRB400E Φ12mm 9m定尺' },
      validAt: '2026-06-01', createdBy: 'test',
    }, 'u1');
    const t = buildRegisterGoodsTool({ ctx, userId: 'u1' });
    // 归一异写: "HRB400E Φ12" vs "HRB400E Φ12mm 9m定尺" 归一键不同 -> 只撞名称包含,
    // 这里用完全相同规格触发归一键精确重复。
    const out = await t.execute!({
      name: '螺纹钢', commodityCode: 'HRB400E', spec: 'HRB400E Φ12mm 9m定尺',
      validAt: '2026-09-10',
    }, CALL);
    expect(out.status).toBe('ok'); // 软提示不阻断(重名不同规格合法)
    if (out.status !== 'ok') return;
    expect(out.detail).toContain('疑似重复');
    expect(out.detail).toContain('match_goods');
    const row = await getTradeFactById(ctx, out.id, 'u1');
    expect(row).toBeTruthy();
  });

  it('缺 commodityCode 以归一键合成占位码(goodsSeed 同款 v1 开放词汇惯例)', async () => {
    const t = buildRegisterGoodsTool({ ctx, userId: 'u1' });
    const out = await t.execute!({ name: '电解铜', spec: 'Cu99.95', validAt: '2026-09-10' }, CALL);
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    const row = await getTradeFactById(ctx, out.id, 'u1');
    expect(row?.payload['commodityCode']).toBe(`${normalizeSpec('电解铜')}-${normalizeSpec('Cu99.95')}`);
  });

  it('用户隔离: 注册事实归属调用用户', async () => {
    const t = buildRegisterGoodsTool({ ctx, userId: 'u1' });
    const out = await t.execute!({ name: '冻牛肉', commodityCode: 'BEEF-2', validAt: '2026-09-10' }, CALL);
    if (out.status !== 'ok') throw new Error('register failed');
    expect(await getTradeFactById(ctx, out.id, 'u2')).toBeFalsy();
  });
});
