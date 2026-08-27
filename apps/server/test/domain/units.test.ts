import { describe, it, expect } from 'vitest';
import { UNIT_REGISTRY, resolveUnit, canonicalizeQuantity } from '../../src/domain/units.js';

describe('UNIT_REGISTRY', () => {
  it('首批注册: 质量(吨/千克/公斤/克) + 计数(箱/件/车)', () => {
    expect(UNIT_REGISTRY['吨']).toEqual({ dimension: 'mass', factorToKg: 1000 });
    expect(UNIT_REGISTRY['千克']).toEqual({ dimension: 'mass', factorToKg: 1 });
    expect(UNIT_REGISTRY['公斤']).toEqual({ dimension: 'mass', factorToKg: 1 });
    expect(UNIT_REGISTRY['克']).toEqual({ dimension: 'mass', factorToKg: 0.001 });
    expect(UNIT_REGISTRY['箱']).toEqual({ dimension: 'count', factorToKg: 1 });
    expect(UNIT_REGISTRY['件']).toEqual({ dimension: 'count', factorToKg: 1 });
    expect(UNIT_REGISTRY['车']).toEqual({ dimension: 'count', factorToKg: 1 });
  });
});

describe('resolveUnit', () => {
  it('精确匹配(去除首尾空白)', () => {
    expect(resolveUnit(' 吨 ')).toEqual({ dimension: 'mass', factorToKg: 1000 });
  });
  it('未注册单位返回 null(不猜)', () => {
    expect(resolveUnit('磅')).toBeNull();
    expect(resolveUnit('')).toBeNull();
  });
});

describe('canonicalizeQuantity', () => {
  it('mass: 3吨 -> 3000 kg', () => {
    expect(canonicalizeQuantity(3, '吨')).toEqual({ dimension: 'mass', canonical: 3000 });
  });
  it('mass: 500克 -> 0.5 kg', () => {
    expect(canonicalizeQuantity(500, '克')).toEqual({ dimension: 'mass', canonical: 0.5 });
  });
  it('count: 120箱 -> count 池原值', () => {
    expect(canonicalizeQuantity(120, '箱')).toEqual({ dimension: 'count', canonical: 120 });
  });
  it('未知单位 -> null', () => {
    expect(canonicalizeQuantity(10, '磅')).toBeNull();
  });
});
