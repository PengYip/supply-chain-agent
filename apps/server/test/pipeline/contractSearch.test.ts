import { describe, it, expect } from 'vitest';
import {
  extractLedgerParty, matchContractQuery, rankContractSearch, type ContractSearchItem,
} from '../../src/pipeline/contractSearch.js';
import type { ContractLedgerEntry } from '../../src/pipeline/contractLedger.js';

function entry(over: Partial<ContractLedgerEntry> = {}): ContractLedgerEntry {
  return {
    contractNo: 'CJXC-CTCL-JY-2024-131-01', displayContractNo: 'ｃｊｘｃ－ctcl－jy－2024-131-01',
    docType: '合同', documentId: 'D1', title: '动力煤采购合同', contractType: null,
    fields: {
      合同号: { value: 'ｃｊｘｃ－ctcl－jy－2024-131-01', sourceSpans: [] },
      买方: { value: '浙江浙能富兴燃料有限公司', sourceSpans: [] },
      卖方: { value: '山西焦煤集团', sourceSpans: [] },
    },
    fieldMeta: {}, overallConfidence: 0.9, needsReview: false, userId: 'u1',
    ...over,
  };
}

describe('extractLedgerParty', () => {
  it('买方优先 买方 键, 回退 甲方; 卖方优先 卖方 键, 回退 乙方', () => {
    expect(extractLedgerParty(entry(), 'buyer')).toBe('浙江浙能富兴燃料有限公司');
    expect(extractLedgerParty(entry(), 'seller')).toBe('山西焦煤集团');
    const e2 = entry({ fields: { 甲方: { value: 'A公司', sourceSpans: [] }, 乙方: { value: 'B公司', sourceSpans: [] } } });
    expect(extractLedgerParty(e2, 'buyer')).toBe('A公司');
    expect(extractLedgerParty(e2, 'seller')).toBe('B公司');
  });
  it('无匹配键或空串 -> null', () => {
    expect(extractLedgerParty(entry({ fields: {} }), 'buyer')).toBeNull();
    expect(extractLedgerParty(entry({ fields: { 买方: { value: '  ', sourceSpans: [] } } }), 'buyer')).toBeNull();
  });
});

describe('matchContractQuery', () => {
  it('归一化合同号精确/前缀/包含 -> contractNo 1 / 0.95 / 0.9', () => {
    expect(matchContractQuery('cjxc-ctcl-jy-2024-131-01', entry())?.score).toBe(1);
    expect(matchContractQuery('CJXC-CTCL', entry())).toEqual({ field: 'contractNo', score: 0.95 });
    expect(matchContractQuery('2024-131', entry())).toEqual({ field: 'contractNo', score: 0.9 });
  });
  it('全角输入归一化后精确命中', () => {
    expect(matchContractQuery('ｃｊｘｃ－ｃｔｃｌ－ｊｙ－2024-131-01', entry())?.score).toBe(1);
  });
  it('displayContractNo 原文包含 -> contractNo 0.85', () => {
    // 查询含归一化会剥离的中文, 归一化路径不命中, 走 displayContractNo 原文包含。
    const e = entry({ displayContractNo: 'CJXC-CTCL-JY-2024-131-01 动力煤采购合同' });
    expect(matchContractQuery('动力煤采购合同', e)).toEqual({ field: 'contractNo', score: 0.85 });
  });
  it('买方模糊(包含) -> buyer 0.9; 卖方 -> seller', () => {
    expect(matchContractQuery('浙能富兴', entry())).toEqual({ field: 'buyer', score: 0.9 });
    expect(matchContractQuery('焦煤集团', entry())).toEqual({ field: 'seller', score: 0.9 });
  });
  it('标题包含 -> title 0.6', () => {
    expect(matchContractQuery('动力煤', entry())).toEqual({ field: 'title', score: 0.6 });
  });
  it('不匹配 -> null; 空 q -> null', () => {
    expect(matchContractQuery('完全不相关词组', entry())).toBeNull();
    expect(matchContractQuery('   ', entry())).toBeNull();
  });
});

describe('rankContractSearch', () => {
  it('按分数降序 + 截断 limit + 字段优先级(contractNo 高于 buyer)', () => {
    const a = entry(); // contractNo 前缀命中 0.95
    const b = entry({ contractNo: 'ZZ-OTHER-1', displayContractNo: 'ZZ-OTHER-1', fields: { 买方: { value: 'CJXC浙能富兴燃料', sourceSpans: [] } } }); // buyer 0.9
    const out = rankContractSearch('CJXC', [b, a], 10);
    expect(out[0]?.contractNo).toBe(a.contractNo);
    expect(out).toHaveLength(2);
    expect(out[1]?.matchedField).toBe('buyer');
    expect(rankContractSearch('CJXC', [b, a], 1)).toHaveLength(1);
  });
  it('buyer/seller 进入返回项', () => {
    const out = rankContractSearch('浙能富兴', [entry()], 10);
    expect(out[0]?.buyer).toBe('浙江浙能富兴燃料有限公司');
    expect(out[0]?.seller).toBe('山西焦煤集团');
  });
});
