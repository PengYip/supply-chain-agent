import { describe, it, expect } from 'vitest';
import {
  REL_ROLE_BY_FIELD,
  COMMODITY_FIELDS,
  CONTRACT_FIELDS,
  EXECUTES_DOCTYPES,
  bindingRelationFor,
  CHUNK_TAG_TAXONOMY,
  getTaxonomy,
} from '../../src/domain/tradeSemantics.js';

describe('tradeSemantics (L1 行业词汇表)', () => {
  describe('REL_ROLE_BY_FIELD', () => {
    it('maps 甲方/乙方 to 买方/卖方', () => {
      expect(REL_ROLE_BY_FIELD['甲方']).toBe('买方');
      expect(REL_ROLE_BY_FIELD['乙方']).toBe('卖方');
    });

    it('contains 发货人/收货人/承运人 with identity values', () => {
      for (const key of ['发货人', '收货人', '承运人']) {
        expect(REL_ROLE_BY_FIELD[key]).toBe(key);
      }
    });
  });

  it('CONTRACT_FIELDS contains exactly 合同号 and 合同编号', () => {
    expect(CONTRACT_FIELDS.size).toBe(2);
    expect(CONTRACT_FIELDS.has('合同号')).toBe(true);
    expect(CONTRACT_FIELDS.has('合同编号')).toBe(true);
  });

  it('COMMODITY_FIELDS contains exactly 标的物 and 商品', () => {
    expect(COMMODITY_FIELDS.size).toBe(2);
    expect(COMMODITY_FIELDS.has('标的物')).toBe(true);
    expect(COMMODITY_FIELDS.has('商品')).toBe(true);
  });

  it('EXECUTES_DOCTYPES contains exactly 发票/提单/装箱单', () => {
    expect(EXECUTES_DOCTYPES.size).toBe(3);
    expect(EXECUTES_DOCTYPES.has('发票')).toBe(true);
    expect(EXECUTES_DOCTYPES.has('提单')).toBe(true);
    expect(EXECUTES_DOCTYPES.has('装箱单')).toBe(true);
  });

  describe('bindingRelationFor', () => {
    it('maps voucher types to binding relation semantics', () => {
      expect(bindingRelationFor('货转单')).toBe('货权转移');
      expect(bindingRelationFor('付款凭证')).toBe('付款');
      expect(bindingRelationFor('化验报告')).toBe('质检');
      expect(bindingRelationFor('其他')).toBe('凭证');
    });
  });

  describe('CHUNK_TAG_TAXONOMY / getTaxonomy', () => {
    it('covers all 8 docType keys', () => {
      expect(Object.keys(CHUNK_TAG_TAXONOMY).length).toBe(8);
    });

    it('returns 13 tags for 合同', () => {
      expect(getTaxonomy('合同').length).toBe(13);
    });

    it('returns empty arrays for 货转单 and 其他', () => {
      expect(getTaxonomy('货转单')).toEqual([]);
      expect(getTaxonomy('其他')).toEqual([]);
    });
  });
});