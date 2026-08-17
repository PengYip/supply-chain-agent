import { describe, it, expect } from 'vitest';
import { normalizeName } from '../../src/graph/normalize.js';

describe('normalizeName', () => {
  it('去除首尾与内部空白（含全角空格）', () => {
    expect(normalizeName('  中石化 ')).toBe('中石化');
    expect(normalizeName('中国\u3000石化')).toBe('中国石化');
    expect(normalizeName('HT 001')).toBe('HT001');
  });
  it('剥离公司后缀（可重复剥，最长优先）', () => {
    expect(normalizeName('中石化集团有限公司')).toBe('中石化');
    expect(normalizeName('中石化股份有限公司')).toBe('中石化');
    expect(normalizeName('中石化集团')).toBe('中石化');
    expect(normalizeName('中石化有限公司')).toBe('中石化');
  });
  it('后缀即全名时不剥（防空名）', () => {
    expect(normalizeName('集团')).toBe('集团');
    expect(normalizeName('有限公司')).toBe('有限公司');
  });
  it('空白输入返回空串', () => {
    expect(normalizeName('')).toBe('');
    expect(normalizeName('   ')).toBe('');
  });
  it('合同号（无后缀无空白）原样保留', () => {
    expect(normalizeName('HT-2024-001')).toBe('HT-2024-001');
  });
});
