// apps/server/test/ontology/goodsSeed.test.ts
// 冷启动种子核心逻辑（spec §12，两层薄种子）：幂等键=normalizeSpec(name)+
// normalizeSpec(spec)，重复执行不增殖；写入必经 insertTradeFact 边界（createdBy='seed'，
// 非法 payload 逐条拒绝并报告）；--dry-run 零写入。
import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import { asOfSystemTime } from '../../src/ontology/asof.js';
import { listTradeFactsAsOf } from '../../src/ontology/repo.js';
import { seedGoodsMasterData, seedIdempotencyKey } from '../../src/ontology/goodsSeed.js';

let ctx: DbContext;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
});

const LIST = [
  { name: '螺纹钢', unit: '吨', attributes: { '品类族': '建筑钢材' } },
  { name: '螺纹钢', spec: 'HRB400E Φ12mm 9m定尺', unit: '吨', attributes: { '牌号': 'HRB400E', '直径': '12mm' } },
  { name: '冻牛肉', unit: '公斤', attributes: { '品类族': '冻品' } },
];

describe('seedGoodsMasterData (spec §12 冷启动种子)', () => {
  it('逐条经写入边界落库：createdBy=seed、共享域(user_id 空)、payload 原样', async () => {
    const res = await seedGoodsMasterData({ ctx, items: LIST, userId: '' });
    expect(res.total).toBe(3);
    expect(res.inserted).toBe(3);
    expect(res.skipped).toBe(0);
    expect(res.failed).toEqual([]);
    const rows = await listTradeFactsAsOf(ctx, asOfSystemTime('9999-12-31T23:59:59.999Z'), { entityType: 'TradeGoods' });
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.createdBy === 'seed')).toBe(true);
    expect(rows.every((r) => r.userId === '')).toBe(true);
    const rebar = rows.find((r) => r.payload['spec'] === 'HRB400E Φ12mm 9m定尺')!;
    expect(rebar.payload['attributes']).toEqual({ '牌号': 'HRB400E', '直径': '12mm' });
  });

  it('幂等：同清单跑两遍行数不变（第二遍全 skipped）', async () => {
    await seedGoodsMasterData({ ctx, items: LIST, userId: '' });
    const again = await seedGoodsMasterData({ ctx, items: LIST, userId: '' });
    expect(again.inserted).toBe(0);
    expect(again.skipped).toBe(3);
    const rows = await listTradeFactsAsOf(ctx, asOfSystemTime('9999-12-31T23:59:59.999Z'), { entityType: 'TradeGoods' });
    expect(rows).toHaveLength(3);
  });

  it('归一幂等：异写规格（全半角/乘号/空格/大小写）不增殖', async () => {
    await seedGoodsMasterData({ ctx, items: [{ name: '螺纹钢', spec: 'HRB400E Φ12mm 9m定尺' }], userId: '' });
    const again = await seedGoodsMasterData({ ctx, items: [{ name: '螺纹钢', spec: 'hrb400e φ12mm  9m 定尺' }], userId: '' });
    expect(again.inserted).toBe(0);
    expect(again.skipped).toBe(1);
  });

  it('写入边界生效：非法 payload 逐条拒绝并报告，合法项不受影响', async () => {
    const res = await seedGoodsMasterData({
      ctx,
      items: [
        { name: '合法品', unit: '吨' },
        // attributes 值非标量（嵌套对象）-> union(string,number) 拒绝
        {
          name: '非标量值', commodityCode: 'X',
          attributes: { '牌号': { nested: true } } as never,
        } as never,
        // attributes 超 32 条 -> superRefine 拒绝
        {
          name: '超限袋', commodityCode: 'X',
          attributes: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, 'v'])),
        } as never,
      ],
      userId: '',
    });
    expect(res.inserted).toBe(1);
    expect(res.failed).toHaveLength(2);
    expect(res.failed.every((f) => f.error.length > 0)).toBe(true);
    const rows = await listTradeFactsAsOf(ctx, asOfSystemTime('9999-12-31T23:59:59.999Z'), { entityType: 'TradeGoods' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload['name']).toBe('合法品');
  });

  it('缺 commodityCode 的条目以归一键合成占位码（spec §12 清单样例不含编码仍可种子）', async () => {
    const res = await seedGoodsMasterData({ ctx, items: [{ name: '螺纹钢', unit: '吨' }], userId: '' });
    expect(res.inserted).toBe(1);
    const rows = await listTradeFactsAsOf(ctx, asOfSystemTime('9999-12-31T23:59:59.999Z'), { entityType: 'TradeGoods' });
    expect(rows).toHaveLength(1);
    expect(typeof rows[0]!.payload['commodityCode']).toBe('string');
    expect(rows[0]!.payload['commodityCode']).toContain('螺纹钢'.toLowerCase());
  });

  it('dry-run 零写入：只统计将写入的行', async () => {
    const res = await seedGoodsMasterData({ ctx, items: LIST, userId: '', dryRun: true });
    expect(res.inserted).toBe(3);
    expect(res.failed).toEqual([]);
    expect(res.samples.length).toBeGreaterThan(0);
    const rows = await listTradeFactsAsOf(ctx, asOfSystemTime('9999-12-31T23:59:59.999Z'), { entityType: 'TradeGoods' });
    expect(rows).toHaveLength(0);
  });

  it('seedIdempotencyKey：同形异写同键，不同规格不同键', () => {
    expect(seedIdempotencyKey('螺纹钢', 'HRB400E Φ12mm')).toBe(seedIdempotencyKey('螺纹钢', 'hrb400e φ12mm'));
    expect(seedIdempotencyKey('螺纹钢')).toBe(seedIdempotencyKey('螺纹钢', ''));
    expect(seedIdempotencyKey('螺纹钢', 'Φ12')).not.toBe(seedIdempotencyKey('螺纹钢', 'Φ14'));
  });
});
