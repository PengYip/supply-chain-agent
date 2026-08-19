// domain/flowDirection 单测: 本公司主体判定与四流方向推导的纯函数行为。
import { describe, it, expect } from 'vitest';
import {
  normalizeCompanyName,
  parseSelfPartyNames,
  resolveSelfSide,
  moneyDirectionFor,
  goodsDirectionFor,
  invoiceDirectionFor,
} from '../../src/domain/flowDirection.js';

describe('normalizeCompanyName', () => {
  it('去除半角/全角空白并大写拉丁字母', () => {
    expect(normalizeCompanyName(' HuaNeng Power ')).toBe('HUANENGPOWER');
    expect(normalizeCompanyName('华能　电厂')).toBe('华能电厂');
  });
});

describe('parseSelfPartyNames', () => {
  it('按逗号切分并过滤空段', () => {
    expect(parseSelfPartyNames('华能电厂, 神华集团,')).toEqual(['华能电厂', '神华集团']);
  });
  it('undefined 返回空数组', () => {
    expect(parseSelfPartyNames(undefined)).toEqual([]);
  });
});

describe('resolveSelfSide', () => {
  const names = ['华能电厂'];

  it('名单为空返回 null', () => {
    expect(resolveSelfSide([], { buyer: '华能电厂' })).toBeNull();
  });
  it('buyer 侧命中返回 buyer', () => {
    expect(resolveSelfSide(names, { buyer: '华能电厂', seller: '神华集团' })).toBe('buyer');
  });
  it('seller 侧命中返回 seller', () => {
    expect(resolveSelfSide(names, { buyer: '神华集团', seller: '华能电厂' })).toBe('seller');
  });
  it('写法变体(全角空格)仍命中', () => {
    expect(resolveSelfSide(names, { buyer: '华能　电厂' })).toBe('buyer');
  });
  it('两侧都未命中返回 null', () => {
    expect(resolveSelfSide(names, { buyer: '甲公司', seller: '乙公司' })).toBeNull();
  });
  it('两侧同时命中(数据异常)返回 null 而不是猜', () => {
    expect(resolveSelfSide(names, { buyer: '华能电厂', seller: '华能电厂' })).toBeNull();
  });
});

describe('三流方向映射', () => {
  it('资金流: 付款人(buyer)为 out, 收款人(seller)为 in', () => {
    expect(moneyDirectionFor('buyer')).toBe('out');
    expect(moneyDirectionFor('seller')).toBe('in');
  });
  it('货物流: 买方(buyer)收货 in, 卖方(seller)发货 out', () => {
    expect(goodsDirectionFor('buyer')).toBe('in');
    expect(goodsDirectionFor('seller')).toBe('out');
  });
  it('发票流: 受票方(buyer)进项 in, 开票方(seller)销项 out', () => {
    expect(invoiceDirectionFor('buyer')).toBe('in');
    expect(invoiceDirectionFor('seller')).toBe('out');
  });
});
