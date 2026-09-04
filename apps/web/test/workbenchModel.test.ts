// apps/web/test/workbenchModel.test.ts
// 集中复核客户端纯逻辑测试(Task 8): 勾稽镜像 / 合计漂移 / 可确认判定 / 列定义。
// 规则镜像 apps/server/src/pipeline/reviewChecks.ts, 两处注释互指。
import { describe, it, expect } from 'vitest';
import {
  checkRow,
  checkTotal,
  cellTone,
  isUnitConfirmable,
  TABLE_COLUMNS,
} from '../src/components/review-workbench/workbenchModel';
import type { WorkbenchUnit } from '../src/api/reviewWorkbench';

describe('checkRow(镜像 reviewChecks)', () => {
  it('毛皮净勾稽失败 -> error 标红三列', () => {
    const issues = checkRow({ 毛重_吨: 40, 皮重_吨: 15, 净重_吨: 24 }, '汽运磅单');
    expect(cellTone(issues, '净重_吨')).toBe('error');
    expect(cellTone(issues, '车号')).toBeNull();
  });

  it('缺失 -> warning', () => {
    const issues = checkRow({ 毛重_吨: null, 皮重_吨: 1, 净重_吨: 1 }, '汽运磅单');
    expect(cellTone(issues, '毛重_吨')).toBe('warning');
  });
});

describe('checkTotal(编辑后合计漂移)', () => {
  it('改行后与存量总净重不符 -> fail', () => {
    const t = checkTotal([{ 净重_吨: 25.3 }, { 净重_吨: 31 }], 55.3);
    expect(t.pass).toBe(false);
    expect(t.actual).toBe(56.3);
  });
});

describe('isUnitConfirmable', () => {
  const unit = { reviewStatus: 'pending', rows: [{}, {}, {}] } as unknown as WorkbenchUnit;

  it('全部行已核 -> 可确认', () => {
    expect(isUnitConfirmable(unit, 3, 3)).toBe(true);
  });
  it('行未核完 -> 不可确认', () => {
    expect(isUnitConfirmable(unit, 2, 3)).toBe(false);
  });
  it('已 confirmed -> 不可重复确认', () => {
    const done = { ...unit, reviewStatus: 'confirmed' } as WorkbenchUnit;
    expect(isUnitConfirmable(done, 3, 3)).toBe(false);
  });
  it('corrected 状态仍可确认(改完再确认)', () => {
    const edited = { ...unit, reviewStatus: 'corrected' } as WorkbenchUnit;
    expect(isUnitConfirmable(edited, 3, 3)).toBe(true);
  });
  it('无行单据 -> 恒不可确认', () => {
    const empty = { reviewStatus: 'pending', rows: [] } as unknown as WorkbenchUnit;
    expect(isUnitConfirmable(empty, 0, 0)).toBe(false);
  });
});

describe('TABLE_COLUMNS', () => {
  it('两类票种列定义与 schema 行字段一致', () => {
    expect(TABLE_COLUMNS['汽运磅单']).toContain('净重_吨');
    expect(TABLE_COLUMNS['轨道衡称重单']).toContain('盈亏_吨');
  });
});