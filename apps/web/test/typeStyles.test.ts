import { describe, expect, it } from 'vitest';
import { contractTypeStyle, docTypeStyle } from '../src/components/graph/businessTypes';

describe('docTypeStyle', () => {
  it('按关键词命中各文档色系', () => {
    expect(docTypeStyle('采购合同').label).toBe('合同');
    expect(docTypeStyle('增值税发票').color).toBe('#1D4ED8');
    expect(docTypeStyle('海运提单').label).toBe('提单');
    expect(docTypeStyle('检验报告3357').color).toBe('#BE185D');
  });
  it('空类型回退通用文档灰', () => {
    const s = docTypeStyle('');
    expect(s.color).toBe('#475569');
    expect(s.label).toBe('文档');
  });
  it('未收录类型稳定散列(同输入同输出)', () => {
    const a = docTypeStyle('某种新单据');
    const b = docTypeStyle('某种新单据');
    expect(a).toEqual(b);
    expect(a.label.length).toBeLessThanOrEqual(3);
  });
});

describe('contractTypeStyle', () => {
  it('props 显式类型优先', () => {
    const s = contractTypeStyle('HT-001', { contractType: '采购合同' });
    expect(s.label).toBe('采购');
    expect(s.color).toBe('#0E7490');
  });
  it('从名称匹配补充协议', () => {
    const s = contractTypeStyle('GMNH-JBKZ-20250303HNJM-补充协议', null);
    expect(s.label).toBe('补充');
    expect(s.color).toBe('#7C3AED');
  });
  it('无子类型回退基础合同绿', () => {
    const s = contractTypeStyle('HT-2026-001', null);
    expect(s.label).toBe('合同');
    expect(s.color).toBe('#15803D');
  });
});
