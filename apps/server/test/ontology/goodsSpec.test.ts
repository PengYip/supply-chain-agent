// apps/server/test/ontology/goodsSpec.test.ts
// normalizeSpec 规格归一函数(spec 决策 #9)：登记照存原文, Phase 2 匹配通道
// (归一键精确比对)依赖双方归一值相等——异写同规必归一, 不同规必不同。
import { describe, it, expect } from 'vitest';
import { normalizeSpec } from '../../src/ontology/goodsSpec.js';

describe('normalizeSpec (spec 决策 #9: 规格 v1 归一函数)', () => {
  it('乘号异写统一: x/X/*/× 归一为同一形态', () => {
    expect(normalizeSpec('3×120+1×70')).toBe(normalizeSpec('3*120+1*70'));
    expect(normalizeSpec('3x120+1x70')).toBe(normalizeSpec('3*120+1*70'));
    expect(normalizeSpec('3X120+1X70')).toBe(normalizeSpec('3*120+1*70'));
  });

  it('空白不敏感: 首尾/内部/全角空格全部去除', () => {
    expect(normalizeSpec(' 3*120 + 1*70 ')).toBe(normalizeSpec('3*120+1*70'));
    expect(normalizeSpec('HRB400E　Φ12mm')).toBe(normalizeSpec('HRB400EΦ12mm'));
  });

  it('全半角归一(NFKC): 全角字母数字符号折半角', () => {
    expect(normalizeSpec('３＊１２０')).toBe(normalizeSpec('3*120'));
    expect(normalizeSpec('ＹＪＶ')).toBe(normalizeSpec('YJV'));
  });

  it('大小写归一: 异写大小写同规', () => {
    expect(normalizeSpec('hrb400e')).toBe(normalizeSpec('HRB400E'));
    expect(normalizeSpec('YJV 4*185')).toBe(normalizeSpec('yjv4*185'));
  });

  it('中文原样保留(品类词不转写): 不同规格不误归一', () => {
    expect(normalizeSpec('9m定尺')).toBe(normalizeSpec('9m定尺'));
    expect(normalizeSpec('Φ12mm 9m定尺')).not.toBe(normalizeSpec('Φ14mm 9m定尺'));
    expect(normalizeSpec('热轧卷板 Q235B')).not.toBe(normalizeSpec('热轧卷板 Q355B'));
  });

  it('空/纯空白串归一为空串(幂等键的 spec 缺省位)', () => {
    expect(normalizeSpec('')).toBe('');
    expect(normalizeSpec('   ')).toBe('');
    expect(normalizeSpec('　')).toBe('');
  });

  it('归一幂等: f(f(x)) === f(x)', () => {
    const s = ' 3×120 + 1×70 HRB400E ';
    expect(normalizeSpec(normalizeSpec(s))).toBe(normalizeSpec(s));
  });
});
