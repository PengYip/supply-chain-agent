import { describe, expect, it } from 'vitest';
import { normalizeTemplateContext } from '../src/api/templateContext';

const PAYLOAD = {
  documentId: 'DOC-1', docType: '收货单',
  typeChain: ['收货单', '运输凭证', '履约凭证'],
  bindsRelation: '凭证', settlesVocab: ['收货'],
  allowedContractTypes: ['物流', '采购', '销售', '其他'],
  projects: [{ code: 'PRJ-1', name: '焦煤采购', contracts: [
    { contractNo: 'HT-1', contractType: '物流', allowed: true },
    { contractNo: 'HT-2', contractType: '租赁', allowed: false },
  ]}],
  unassignedContracts: [{ contractNo: 'HT-9', contractType: null, allowed: true }],
};

describe('normalizeTemplateContext', () => {
  it('完整载荷原样归一化', () => {
    const c = normalizeTemplateContext(PAYLOAD)!;
    expect(c.docType).toBe('收货单');
    expect(c.settlesVocab).toEqual(['收货']);
    expect(c.projects[0]!.contracts[1]).toEqual({ contractNo: 'HT-2', contractType: '租赁', allowed: false });
    expect(c.bindsTargetKind).toBeUndefined();
  });
  it('settlesVocab null 保留为 null(区别于空数组)', () => {
    const c = normalizeTemplateContext({ ...PAYLOAD, settlesVocab: null })!;
    expect(c.settlesVocab).toBeNull();
  });
  it('bindsTargetKind 透传 Project', () => {
    const c = normalizeTemplateContext({ ...PAYLOAD, bindsTargetKind: 'Project' })!;
    expect(c.bindsTargetKind).toBe('Project');
  });
  it('缺 documentId / 非对象 -> null 丢弃', () => {
    expect(normalizeTemplateContext({})).toBeNull();
    expect(normalizeTemplateContext({ documentId: '' })).toBeNull();
  });
  it('contracts 非数组或元素缺 contractNo -> 过滤; allowed 非布尔 -> false', () => {
    const c = normalizeTemplateContext({ ...PAYLOAD,
      projects: [{ code: 'P', name: 'n', contracts: [{ contractType: '物流' }, 'bad', { contractNo: 'HT-3', contractType: '物流' }] }] })!;
    expect(c.projects[0]!.contracts).toEqual([{ contractNo: 'HT-3', contractType: '物流', allowed: false }]);
  });
  it('typeChain 非字符串数组 -> 空数组兜底', () => {
    const c = normalizeTemplateContext({ ...PAYLOAD, typeChain: '收货单' })!;
    expect(c.typeChain).toEqual([]);
  });
});