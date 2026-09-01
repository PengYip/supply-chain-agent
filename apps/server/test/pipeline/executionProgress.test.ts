import { describe, it, expect } from 'vitest';
import { computeExecutionProgress } from '../../src/pipeline/executionProgress.js';

const mass = (canonical: number, docType?: string) => ({
  id: `fl-${canonical}-${docType ?? 'na'}`,
  quantityDimension: 'mass' as const,
  quantityCanonical: canonical,
  quantityValue: canonical,
  unit: '吨',
  ...(docType ? { docType } : {}),
});
const count = (unit: string, value: number, docType?: string) => ({
  id: `fl-c-${unit}-${value}-${docType ?? 'na'}`,
  quantityDimension: 'count' as const,
  quantityCanonical: value,
  quantityValue: value,
  unit,
  ...(docType ? { docType } : {}),
});
const wrap = (m: Record<string, string | number>) =>
  Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { value: v }]));

describe('computeExecutionProgress(spec 2026-08-27 §9)', () => {
  it('mass 对齐: 台账 3吨, 已发 1+0.5吨 -> 0.5', () => {
    const r = computeExecutionProgress([mass(1000), mass(500)], wrap({ 数量: 3, 单位: '吨' }));
    expect(r.basis).toEqual({ quantity: 3, unit: '吨', dimension: 'mass', canonical: 3000 });
    expect(r.delivered!.massKg).toBe(1500);
    expect(r.progress).toBeCloseTo(0.5);
  });

  it('贵金属: 台账 500克, 流水 0.25kg(=250克) -> 进度 0.5(千克规范口径跨单位可算)', () => {
    const r = computeExecutionProgress([mass(0.25)], wrap({ 数量: 500, 单位: '克' }));
    expect(r.basis!.canonical).toBe(0.5); // 500克 -> 0.5 kg
    expect(r.progress).toBeCloseTo(0.5);
  });

  it('量纲不一致: 台账吨 vs 流水箱 -> progress null + dimension-mismatch', () => {
    const r = computeExecutionProgress([count('箱', 120)], wrap({ 数量: 3, 单位: '吨' }));
    expect(r.progress).toBeNull();
    expect(r.reason).toBe('dimension-mismatch');
  });

  it('count 池对齐: 台账箱 对 箱池', () => {
    const r = computeExecutionProgress([count('箱', 30), count('箱', 20)], wrap({ 数量: 100, 单位: '箱' }));
    expect(r.progress).toBeCloseTo(0.5);
  });

  it('count 池缺失(台账件 vs 流水箱) -> progress null + unit-pool-missing', () => {
    const r = computeExecutionProgress([count('箱', 30)], wrap({ 数量: 100, 单位: '件' }));
    expect(r.progress).toBeNull();
    expect(r.reason).toBe('unit-pool-missing');
  });

  it('无台账基准 -> no-contract-basis', () => {
    const r = computeExecutionProgress([mass(1000)], null);
    expect(r.basis).toBeNull();
    expect(r.reason).toBe('no-contract-basis');
  });

  it('台账数量非数值/单位未注册 -> no-contract-basis(不猜)', () => {
    expect(computeExecutionProgress([], wrap({ 数量: '未知', 单位: '吨' })).reason).toBe('no-contract-basis');
    expect(computeExecutionProgress([], wrap({ 数量: 3, 单位: '磅' })).reason).toBe('no-contract-basis');
    expect(computeExecutionProgress([], wrap({ 单位: '吨' })).reason).toBe('no-contract-basis');
  });

  it('dev 实例: 数量字段内嵌单位 "20000吨±10%"(无独立单位字段) -> basis 20000吨', () => {
    const r = computeExecutionProgress([mass(3357460, '轨道衡称重单')], wrap({ 数量: '20000吨±10%' }));
    expect(r.basis).toEqual({ quantity: 20000, unit: '吨', dimension: 'mass', canonical: 20000000 });
    expect(r.progress).toBeCloseTo(3357460 / 20000000);
  });

  it('内嵌 count 单位 "1000箱" -> count 池口径', () => {
    const r = computeExecutionProgress([count('箱', 500)], wrap({ 数量: '1000箱' }));
    expect(r.basis).toEqual({ quantity: 1000, unit: '箱', dimension: 'count', canonical: 1000 });
    expect(r.progress).toBeCloseTo(0.5);
  });

  it('内嵌单位解析不出("约2000吨" 前缀非数字) -> no-contract-basis(不猜)', () => {
    expect(computeExecutionProgress([], wrap({ 数量: '约2000吨' })).reason).toBe('no-contract-basis');
  });

  it('基准为 0 -> progress null(避免除零)', () => {
    const r = computeExecutionProgress([mass(1000)], wrap({ 数量: 0, 单位: '吨' }));
    expect(r.progress).toBeNull();
  });
});

describe('computeExecutionProgress 节点权威聚合(spec 2026-08-27 §15)', () => {
  it('dev 实例: 发货单(预告)+轨道衡(实重)同批 3357.46t -> 不双计, massKg=3357460', () => {
    const flows = [mass(3357460, '发货单'), mass(3357460, '轨道衡称重单')];
    const r = computeExecutionProgress(flows, wrap({ 数量: 3357.46, 单位: '吨' }));
    expect(r.delivered!.massKg).toBe(3357460);
    expect(r.delivered!.nodes.noticeMassKg).toBe(3357460);
    expect(r.delivered!.nodes.actualMassKg).toBe(3357460);
    expect(r.progress).toBeCloseTo(1);
  });

  it('仅预告(发货单, 尚未过衡) -> 按预告计入', () => {
    const r = computeExecutionProgress([mass(1000, '发货单')], wrap({ 数量: 3, 单位: '吨' }));
    expect(r.delivered!.massKg).toBe(1000);
    expect(r.progress).toBeCloseTo(1 / 3);
  });

  it('实重 > 预告(数量浮动上浮) -> 取实重', () => {
    const r = computeExecutionProgress(
      [mass(1000, '发货单'), mass(1020, '汽运磅单')],
      wrap({ 数量: 3, 单位: '吨' }),
    );
    expect(r.delivered!.massKg).toBe(1020);
  });

  it('两批: 一批已过衡一批在途(预告总和 5357.46 > 实重 3357.46) -> 取预告总和(在途批次不丢)', () => {
    const flows = [
      mass(3357460, '发货单'),
      mass(3357460, '轨道衡称重单'),
      mass(2000000, '发货单'),
    ];
    const r = computeExecutionProgress(flows, wrap({ 数量: 6000, 单位: '吨' }));
    expect(r.delivered!.nodes.actualMassKg).toBe(3357460);
    expect(r.delivered!.nodes.noticeMassKg).toBe(5357460);
    expect(r.delivered!.massKg).toBe(5357460);
  });

  it('count 池同批双计: 发货单 10箱 + 收货单 10箱 -> 池值 10; 单侧预告 5箱另算池', () => {
    const r = computeExecutionProgress(
      [count('箱', 10, '发货单'), count('箱', 10, '收货单'), count('件', 5, '发货单')],
      wrap({ 数量: 10, 单位: '箱' }),
    );
    expect(r.delivered!.countPools['箱']).toBe(10);
    expect(r.delivered!.countPools['件']).toBe(5);
    expect(r.progress).toBeCloseTo(1);
  });

  it('未知 docType 缺省按实重(保守计入), 与旧行为等价', () => {
    const r = computeExecutionProgress([mass(1000), mass(500, '收货单')], wrap({ 数量: 3, 单位: '吨' }));
    expect(r.delivered!.massKg).toBe(1500);
  });

  it('空串数量(模板保底空值) -> no-contract-basis(等同缺失, 不产生 0 基准)', () => {
    const r = computeExecutionProgress([mass(1000)], wrap({ 数量: '', 单位: '吨' }));
    expect(r.basis).toBeNull();
    expect(r.reason).toBe('no-contract-basis');
    const r2 = computeExecutionProgress([mass(1000)], wrap({ 数量: '', 单位: '' }));
    expect(r2.basis).toBeNull();
    expect(r2.reason).toBe('no-contract-basis');
  });
});

// ---- 口径透明化(2026-09-01, additive): contributions + transportModes -------

describe('computeExecutionProgress 计入/排除明细(口径透明化)', () => {
  it('计入流水质量合计 == delivered.massKg, 全部 counted', () => {
    const r = computeExecutionProgress(
      [mass(1000, '轨道衡称重单'), mass(500, '汽运磅单')],
      wrap({ 数量: 3, 单位: '吨' }),
    );
    expect(r.delivered!.massKg).toBe(1500);
    const counted = r.contributions.filter((c) => c.counted);
    expect(counted).toHaveLength(2);
    expect(counted.reduce((s, c) => s + (c.massKg ?? 0), 0)).toBe(1500);
    expect(r.contributions.every((c) => c.counted || c.excludeReason)).toBe(true);
  });

  it('预告被实重覆盖: notice 流水 counted=false + excludeReason=covered-by-actual', () => {
    const r = computeExecutionProgress(
      [mass(1000, '发货单'), mass(1020, '汽运磅单')],
      wrap({ 数量: 3, 单位: '吨' }),
    );
    const notice = r.contributions.find((c) => c.tier === 'notice')!;
    expect(notice.counted).toBe(false);
    expect(notice.excludeReason).toBe('covered-by-actual');
    const counted = r.contributions.filter((c) => c.counted);
    expect(counted.reduce((s, c) => s + (c.massKg ?? 0), 0)).toBe(1020);
    expect(counted.reduce((s, c) => s + (c.massKg ?? 0), 0)).toBe(r.delivered!.massKg);
  });

  it('仅预告(实重缺位) -> notice counted(在途批次计入)', () => {
    const r = computeExecutionProgress([mass(1000, '发货单')], wrap({ 数量: 3, 单位: '吨' }));
    expect(r.contributions[0]!.counted).toBe(true);
    expect(r.contributions[0]!.excludeReason).toBeUndefined();
  });

  it('无效数量排除: 无规范值(no-canonical)/缺单位(no-unit)/无量纲(no-valid-quantity)', () => {
    const r = computeExecutionProgress(
      [
        { id: 'fl-m', quantityDimension: 'mass' as const, quantityCanonical: null, quantityValue: 12, unit: '磅' },
        { id: 'fl-c', quantityDimension: 'count' as const, quantityCanonical: null, quantityValue: 5, unit: null },
        { id: 'fl-x', quantityDimension: null, quantityCanonical: null, quantityValue: null, unit: null },
      ],
      wrap({ 数量: 3, 单位: '吨' }),
    );
    const byId = new Map(r.contributions.map((c) => [c.flowId, c]));
    expect(byId.get('fl-m')!.counted).toBe(false);
    expect(byId.get('fl-m')!.excludeReason).toBe('no-canonical');
    expect(byId.get('fl-c')!.counted).toBe(false);
    expect(byId.get('fl-c')!.excludeReason).toBe('no-unit');
    expect(byId.get('fl-x')!.counted).toBe(false);
    expect(byId.get('fl-x')!.excludeReason).toBe('no-valid-quantity');
  });

  it('count 池覆盖: 发货单箱10 被收货单箱10 覆盖 -> notice 排除, 计入池值 10', () => {
    const r = computeExecutionProgress(
      [count('箱', 10, '发货单'), count('箱', 10, '收货单')],
      wrap({ 数量: 10, 单位: '箱' }),
    );
    const notice = r.contributions.find((c) => c.tier === 'notice')!;
    expect(notice.counted).toBe(false);
    expect(notice.excludeReason).toBe('covered-by-actual');
    expect(r.contributions.filter((c) => c.counted)).toHaveLength(1);
  });

  it('空流水 -> contributions/transportModes 为空数组(非 null)', () => {
    const r = computeExecutionProgress([], wrap({ 数量: 3, 单位: '吨' }));
    expect(r.contributions).toEqual([]);
    expect(r.transportModes).toEqual([]);
  });
});

describe('computeExecutionProgress 按运输方式分组(口径透明化)', () => {
  it('火车/汽车/船舶/其他 分组: 条数+质量合计+docType 构成', () => {
    const r = computeExecutionProgress(
      [
        mass(1000, '火运大票'),
        mass(500, '轨道衡称重单'),
        mass(1200, '汽运磅单'),
        mass(300, '水尺计重单'),
        mass(200, '收货单'),
      ],
      wrap({ 数量: 10, 单位: '吨' }),
    );
    const byMode = new Map(r.transportModes.map((g) => [g.mode, g]));
    expect(byMode.get('火车')).toMatchObject({ flowCount: 2, massKg: 1500 });
    expect(byMode.get('火车')!.docTypes).toEqual({ 火运大票: 1, 轨道衡称重单: 1 });
    expect(byMode.get('汽车')).toMatchObject({ flowCount: 1, massKg: 1200 });
    expect(byMode.get('船舶')).toMatchObject({ flowCount: 1, massKg: 300 });
    expect(byMode.get('其他')).toMatchObject({ flowCount: 1, massKg: 200 });
    // 分组合计 == 全部计入合计。
    const groupMass = r.transportModes.reduce((s, g) => s + g.massKg, 0);
    expect(groupMass).toBe(r.delivered!.massKg);
    const groupCount = r.transportModes.reduce((s, g) => s + g.flowCount, 0);
    expect(groupCount).toBe(r.contributions.filter((c) => c.counted).length);
  });

  it('count 池计入按单位入组池; 被覆盖的 notice 不入组', () => {
    const r = computeExecutionProgress(
      [count('箱', 10, '发货单'), count('箱', 10, '收货单')],
      wrap({ 数量: 10, 单位: '箱' }),
    );
    expect(r.transportModes).toHaveLength(1);
    expect(r.transportModes[0]!.mode).toBe('其他'); // 收货单无运输方式映射
    expect(r.transportModes[0]!.countPools).toEqual({ 箱: 10 });
    expect(r.transportModes[0]!.flowCount).toBe(1);
  });
});
