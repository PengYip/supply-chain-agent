// apps/server/test/ontology/goodsMatch.test.ts
// match_goods L1 工具 + matchGoods 打分模块(spec 2026-09-09 §11 Phase 2 波次一):
// 三通道从硬到软——commodityCode 精确 -> 归一键精确 -> 名称包含;
// 候选去重/按分排序/上限 10; suggestion 决定 match/register 兜底分支。
// :memory: SQLite 真库, 沿 linkTools 测试范式。
import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import { insertTradeFact } from '../../src/ontology/repo.js';
import { matchGoods, buildMatchGoodsTool } from '../../src/ontology/goodsMatch.js';

let ctx: DbContext;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
});

const seedGoods = (
  payload: { name: string; commodityCode: string; spec?: string; unit?: string },
  userId = 'u1',
) => insertTradeFact(ctx, {
  entityType: 'TradeGoods', payload: payload as never, validAt: '2026-06-01', createdBy: 'test',
}, userId);

describe('matchGoods 打分模块', () => {
  it('通道1: commodityCode 精确命中 score=1.0', async () => {
    await seedGoods({ name: '螺纹钢', commodityCode: 'HRB400E', spec: 'HRB400E Φ12mm 9m定尺' });
    const r = await matchGoods(ctx, { name: '螺纹钢', commodityCode: 'HRB400E' }, 'u1');
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]).toMatchObject({ score: 1.0, evidence: 'commodityCode 精确' });
    expect(r.suggestion).toBe('match');
  });

  it('通道2: 归一键精确——归一异写 "3×120+1×70" vs "3*120+1*70" 命中(0.95)', async () => {
    await seedGoods({ name: 'YJV电力电缆', commodityCode: 'CABLE-001', spec: '3×120+1×70' });
    const r = await matchGoods(ctx, { name: 'YJV 电力电缆', spec: '3*120+1*70' }, 'u1');
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]).toMatchObject({ score: 0.95, evidence: '归一键精确' });
    expect(r.suggestion).toBe('match');
  });

  it('通道3: 名称包含(双向)命中 score=0.6, 不达阈值 -> suggestion=register', async () => {
    await seedGoods({ name: '热轧卷板', commodityCode: 'HR-001' });
    // "热轧板卷"与"热轧卷板"归一后互不包含(字序不同), 不命中——异写靠波次二向量召回
    const miss = await matchGoods(ctx, { name: '热轧板卷' }, 'u1');
    expect(miss.candidates).toEqual([]);
    expect(miss.suggestion).toBe('register');
    // 查询名包含行名: "热轧" ⊂ "热轧卷板"
    const hit = await matchGoods(ctx, { name: '热轧' }, 'u1');
    expect(hit.candidates).toHaveLength(1);
    expect(hit.candidates[0]).toMatchObject({ score: 0.6, evidence: '名称包含' });
    expect(hit.suggestion).toBe('register'); // 0.6 < 0.95 阈值
  });

  it('无候选 -> candidates 空数组 + suggestion=register', async () => {
    const r = await matchGoods(ctx, { name: '冻牛肉' }, 'u1');
    expect(r.candidates).toEqual([]);
    expect(r.suggestion).toBe('register');
  });

  it('候选去重(同事实取最高分通道)、按分降序、上限 10', async () => {
    // 同一事实同时命中 code 精确与名称包含 -> 只留一条, 取 code 精确 1.0
    await seedGoods({ name: '电解铜', commodityCode: 'CU-99.95' });
    const one = await matchGoods(ctx, { name: '电解', commodityCode: 'CU-99.95' }, 'u1');
    expect(one.candidates).toHaveLength(1);
    expect(one.candidates[0]!.score).toBe(1.0);

    for (let i = 0; i < 12; i += 1) {
      await seedGoods({ name: `合金钢${i}号`, commodityCode: `ALLOY-${String(i).padStart(2, '0')}` });
    }
    const many = await matchGoods(ctx, { name: '合金钢' }, 'u1'); // 12 行全部名称包含
    expect(many.candidates).toHaveLength(10); // cap
    for (let i = 1; i < many.candidates.length; i += 1) {
      expect(many.candidates[i - 1]!.score).toBeGreaterThanOrEqual(many.candidates[i]!.score);
    }
  });

  it('失效事实不参与匹配(as-of 业务时间现行口径)', async () => {
    const id = await seedGoods({ name: '废钢丝', commodityCode: 'SCRAP-1' });
    const { supersedeTradeFact } = await import('../../src/ontology/repo.js');
    await supersedeTradeFact(ctx, {
      prevFactId: id,
      next: {
        entityType: 'TradeGoods',
        payload: { name: '废钢丝(改)', commodityCode: 'SCRAP-2' },
        validAt: '2026-07-01',
        createdBy: 'test',
      },
    }, 'u1');
    const r = await matchGoods(ctx, { name: '废钢丝' }, 'u1');
    // 换代后的新行"废钢丝(改)"可经名称包含命中, 但已失效的旧行(id)绝不再出现
    expect(r.candidates.some((c) => c.id === id)).toBe(false);
    expect(r.candidates.every((c) => c.commodityCode !== 'SCRAP-1')).toBe(true);
  });

  it('用户隔离: 他用户商品不出现在候选', async () => {
    await seedGoods({ name: '电解铝', commodityCode: 'AL-1' }, 'someone-else');
    const r = await matchGoods(ctx, { name: '电解铝' }, 'u1');
    expect(r.candidates).toEqual([]);
  });
});

describe('match_goods 工具(L1)', () => {
  it('execute 返回候选+suggestion, 描述引导 register_goods 前必先匹配', async () => {
    await seedGoods({ name: '螺纹钢', commodityCode: 'HRB400E', spec: 'HRB400E Φ12mm 9m定尺' });
    const t = buildMatchGoodsTool({ ctx, userId: 'u1' });
    const out = await t.execute!({ name: '螺纹钢', spec: 'HRB400E Φ12mm 9m定尺' },
      { toolCallId: 'call_m1', messages: [] } as never);
    expect(out.suggestion).toBe('match');
    expect(out.candidates[0]).toMatchObject({ name: '螺纹钢', spec: 'HRB400E Φ12mm 9m定尺', score: 0.95 });
    expect(t.description).toContain('register_goods');
  });

  it('无候选时 suggestion=register 引导注册兜底', async () => {
    const t = buildMatchGoodsTool({ ctx, userId: 'u1' });
    const out = await t.execute!({ name: '冻牛肉' }, { toolCallId: 'call_m2', messages: [] } as never);
    expect(out.suggestion).toBe('register');
  });
});
