// 批量拆分器 Phase 2: 两遍读数共识纯函数测试(设计 2026-09-01 §5.3)。
// 原型实测的分歧形态: 单号 10384417 vs 10394417、净重 34250 vs 54520;
// 以及不应误报的形态: kg/吨 千倍换算、多编号字段部分命中、任一侧缺读数。
import { describe, it, expect } from 'vitest';
import {
  compareReadings,
  normalizeReadingId,
  readingLeaves,
  unitCandidateScore,
} from '../../src/pipeline/batchConsensus.js';

describe('normalizeReadingId', () => {
  it('去掉非字母数字噪声(空格/连字符/前缀)', () => {
    expect(normalizeReadingId('103 84417')).toBe('10384417');
    expect(normalizeReadingId('No. HX-2026-081')).toBe('NOHX2026081');
    expect(normalizeReadingId('hx_2026_081')).toBe('HX2026081');
  });
});

describe('readingLeaves', () => {
  it('展开一层数组行(明细行)为 容器N.字段 叶子', () => {
    const leaves = readingLeaves({
      编号: 'A-1',
      明细行: [
        { 编号: '10384417', 净重_吨: 34.25 },
        { 编号: '10384418', 净重_吨: 35.1 },
      ],
    });
    expect(leaves).toContainEqual({ key: '编号', container: '编号', field: '编号', value: 'A-1' });
    expect(leaves).toContainEqual({ key: '明细行1.编号', container: '明细行', field: '编号', value: '10384417' });
    expect(leaves).toContainEqual({ key: '明细行2.净重_吨', container: '明细行', field: '净重_吨', value: 35.1 });
  });
});

describe('compareReadings: 单号共识', () => {
  it('读数一致 -> 无分歧', () => {
    const r = compareReadings(
      { identifier: 'HX-2026-081', evidence: '检测报告 报告编号 HX-2026-081' },
      { 报告编号: 'HX-2026-081', 出具机构: '华新' },
    );
    expect(r.mismatches).toHaveLength(0);
  });

  it('格式噪声(空格/前缀)不影响一致判定', () => {
    const r = compareReadings(
      { identifier: '103 84417', evidence: '汽车衡计量单' },
      { 明细行: [{ 编号: 'No.10384417', 净重_吨: 34.25 }] },
    );
    expect(r.mismatches).toHaveLength(0);
  });

  it('原型分歧形态: 10384417 vs 10394417 -> 分歧(不可自动入台账)', () => {
    const r = compareReadings(
      { identifier: '10384417', evidence: '汽车衡计量单 编号10384417' },
      { 明细行: [{ 编号: '10394417', 净重_吨: 54.52 }] },
    );
    expect(r.mismatches).toHaveLength(1);
    expect(r.mismatches[0]!.message).toContain('10384417');
    expect(r.mismatches[0]!.message).toContain('10394417');
    expect(r.mismatches[0]!.fields).toContain('明细行');
  });

  it('多个编号字段部分命中即共识(报告编号命中, 样品编号不同不误报)', () => {
    const r = compareReadings(
      { identifier: 'HX-2026-081', evidence: '检测报告' },
      { 报告编号: 'HX-2026-081', 样品编号: 'Y-2026-77', 检测日期: '2026-08-28' },
    );
    expect(r.mismatches).toHaveLength(0);
  });

  it('抽取遍缺单号字段(全 null)不产生分歧(覆盖缺口非读数冲突)', () => {
    const r = compareReadings(
      { identifier: '10384417', evidence: '汽车衡计量单' },
      { 明细行: [{ 编号: null, 净重_吨: 34.25 }] },
    );
    expect(r.mismatches).toHaveLength(0);
  });

  it('检测遍无编号不产生分歧', () => {
    const r = compareReadings(
      { identifier: null, evidence: '检测报告' },
      { 报告编号: 'HX-A' },
    );
    expect(r.mismatches).toHaveLength(0);
  });
});

describe('compareReadings: 重量共识', () => {
  it('原型分歧形态: 净重 34250 vs 54520 -> 分歧', () => {
    const r = compareReadings(
      { identifier: null, evidence: '磅单 净重34250 车号皖K12345' },
      { 明细行: [{ 净重_吨: 54.52 }] },
    );
    expect(r.mismatches).toHaveLength(1);
    expect(r.mismatches[0]!.message).toContain('34250');
    expect(r.mismatches[0]!.message).toContain('54.52');
  });

  it('kg/吨 千倍换算视为一致(净重34250kg vs 34.25吨)', () => {
    const r = compareReadings(
      { identifier: null, evidence: '磅单 净重34250kg' },
      { 明细行: [{ 净重_吨: 34.25 }] },
    );
    expect(r.mismatches).toHaveLength(0);
  });

  it('evidence 无重量标签时不比对(数字串如日期/电话不误报)', () => {
    const r = compareReadings(
      { identifier: null, evidence: '化验报表 2026-08-28 电话0510-1234567' },
      { 重量_吨: 1664.92 },
    );
    expect(r.mismatches).toHaveLength(0);
  });

  it('字符串数字读数参与比对(千分位归一)', () => {
    const r = compareReadings(
      { identifier: null, evidence: '总净重: 1,664.92' },
      { 总净重_吨: '1664.92' },
    );
    expect(r.mismatches).toHaveLength(0);
  });

  it('毛重时间/皮重时间(时间字段)不参与重量共识(下游收货证明实测回归)', () => {
    const r = compareReadings(
      { identifier: 'Q012606080025', evidence: '过磅单 计量编号 Q012606080025 毛重63.160 皮重16.830 实重46.330' },
      {
        明细行: [{
          编号: 'Q012606080025',
          毛重_吨: 63.16,
          皮重_吨: 16.83,
          净重_吨: 46.33,
          毛重时间: '2026-06-08 19:23:12',
          皮重时间: '2026-06-08 19:48:58',
        }],
      },
    );
    expect(r.mismatches).toHaveLength(0);
  });

  it('实重(evidence)与净重_吨(字段)视为同一标签', () => {
    const r = compareReadings(
      { identifier: null, evidence: '过磅单 实重49.870' },
      { 明细行: [{ 净重_吨: 49.87 }] },
    );
    expect(r.mismatches).toHaveLength(0);
    const bad = compareReadings(
      { identifier: null, evidence: '过磅单 实重49.870' },
      { 明细行: [{ 净重_吨: 51.2 }] },
    );
    expect(bad.mismatches).toHaveLength(1);
  });
});

describe('unitCandidateScore(旋回双候选择优)', () => {
  it('共识命中的候选大幅胜出(即使自报置信度更低)', () => {
    const match = unitCandidateScore({
      fields: { 报告编号: 'HX-A', 检测日期: '2026-08-28' },
      fieldConfidences: { 报告编号: 0.6 },
      mismatchCount: 0,
    });
    const mismatch = unitCandidateScore({
      fields: { 报告编号: 'HX-B', 检测日期: '2026-08-28' },
      fieldConfidences: { 报告编号: 0.99, 检测日期: 0.99 },
      mismatchCount: 1,
    });
    expect(match).toBeGreaterThan(mismatch);
  });

  it('双方均共识时按字段置信度/覆盖度择优', () => {
    const rich = unitCandidateScore({
      fields: { a: 1, b: 2, c: 3 },
      fieldConfidences: { a: 0.9, b: 0.9, c: 0.9 },
      mismatchCount: 0,
    });
    const poor = unitCandidateScore({
      fields: { a: 1 },
      fieldConfidences: { a: 0.5 },
      mismatchCount: 0,
    });
    expect(rich).toBeGreaterThan(poor);
  });

  it('检测方向先验: 与检测方向一致的候选 +2.5(共识噪声 mismatch 翻不动)', () => {
    // 宣威事故形态: 检测候选 mismatch(数字噪声)但方向正确, 反向候选共识命中。
    const detected = unitCandidateScore({
      fields: { 报告编号: 'HX-B', 检测日期: '2026-08-28' },
      fieldConfidences: { 报告编号: 0.99, 检测日期: 0.99 },
      mismatchCount: 1,
      rotations: [90],
      detectedRotation: 90,
    });
    const reverse = unitCandidateScore({
      fields: { 报告编号: 'HX-A', 检测日期: '2026-08-28' },
      fieldConfidences: { 报告编号: 0.87, 检测日期: 0.9 },
      mismatchCount: 0,
      rotations: [270],
      detectedRotation: 90,
    });
    expect(detected).toBeGreaterThan(reverse);
  });

  it('检测方向先验可被强证据推翻(共识命中 + 高置信)', () => {
    const detected = unitCandidateScore({
      fields: { 报告编号: 'HX-B', 检测日期: '2026-08-28' },
      fieldConfidences: { 报告编号: 0.1, 检测日期: 0.1 },
      mismatchCount: 1,
      rotations: [90],
      detectedRotation: 90,
    });
    const reverse = unitCandidateScore({
      fields: { 报告编号: 'HX-A', 检测日期: '2026-08-28' },
      fieldConfidences: { 报告编号: 0.99, 检测日期: 0.99 },
      mismatchCount: 0,
      rotations: [270],
      detectedRotation: 90,
    });
    expect(reverse).toBeGreaterThan(detected);
  });

  it('未传旋转参数时先验为 0(向后兼容, 行为与旧版一致)', () => {
    const a = unitCandidateScore({
      fields: { 报告编号: 'HX-A' },
      fieldConfidences: { 报告编号: 0.9 },
      mismatchCount: 0,
    });
    const b = unitCandidateScore({
      fields: { 报告编号: 'HX-A' },
      fieldConfidences: { 报告编号: 0.9 },
      mismatchCount: 0,
      rotations: [90],
      detectedRotation: 90,
    });
    expect(b - a).toBeCloseTo(2.5, 5);
  });
});
