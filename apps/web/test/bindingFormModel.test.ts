import { describe, expect, it } from 'vitest';
import {
  buildProjectOptions, contractDisableReason, deriveRelation, filterContracts, needsFilter, UNASSIGNED_KEY,
} from '../src/lib/bindingFormModel';
import type { TemplateContext } from '../src/api/templateContext';

const ctx = (over: Partial<TemplateContext> = {}): TemplateContext => ({
  documentId: 'DOC-1', docType: '收货单', typeChain: ['收货单', '运输凭证', '履约凭证'],
  bindsRelation: '凭证', settlesVocab: null, allowedContractTypes: ['物流'],
  projects: [], unassignedContracts: [], ...over,
});

describe('deriveRelation', () => {
  it('方向编码类型(收货单)单词直取', () => {
    expect(deriveRelation(ctx({ settlesVocab: ['收货'] }))).toMatchObject({ word: '收货', needsChoice: false, source: 'settles' });
  });
  it('发票多词表 -> needsChoice(收票/开票)', () => {
    const d = deriveRelation(ctx({ docType: '发票', settlesVocab: ['收票', '开票'] }));
    expect(d.needsChoice).toBe(true);
    expect(d.word).toBe('');
    expect(d.vocab).toEqual(['收票', '开票']);
  });
  it('settlesVocab null -> bindsRelation(合同->引用)', () => {
    expect(deriveRelation(ctx({ docType: '合同', bindsRelation: '引用', settlesVocab: null })))
      .toMatchObject({ word: '引用', source: 'binds', needsChoice: false });
  });
});

describe('buildProjectOptions', () => {
  it('未挂项目组拼在末尾', () => {
    const opt = buildProjectOptions(ctx({
      projects: [{ code: 'PRJ-1', name: '焦煤', contracts: [{ contractNo: 'HT-1', contractType: null, allowed: true }] }],
      unassignedContracts: [{ contractNo: 'HT-9', contractType: null, allowed: true }],
    }));
    expect(opt.map((o) => o.key)).toEqual(['PRJ-1', UNASSIGNED_KEY]);
    expect(opt[1]!.label).toBe('未挂项目');
    expect(opt[1]!.isUnassigned).toBe(true);
  });
  it('未挂组为空时不出现; 空项目保留', () => {
    const opt = buildProjectOptions(ctx({ projects: [{ code: 'P1', name: '空项目', contracts: [] }] }));
    expect(opt.map((o) => o.key)).toEqual(['P1']);
  });
});

describe('contractDisableReason', () => {
  const opts = { docType: '收货单', isExecutionDoc: true, established: true };
  it('模板不允许 -> 规则文案(含合同类型)', () => {
    const r = contractDisableReason({ contractNo: 'HT-2', contractType: '租赁', allowed: false }, opts);
    expect(r).toContain('租赁');
    expect(r).toContain('收货单');
  });
  it('执行类单据未挂合同文件 -> 门禁文案', () => {
    expect(contractDisableReason({ contractNo: 'HT-1', contractType: '物流', allowed: true }, { ...opts, established: false }))
      .toContain('未挂合同文件');
  });
  it('合同文件本身(docType=合同)不受挂靠门禁', () => {
    expect(contractDisableReason({ contractNo: 'HT-1', contractType: null, allowed: true },
      { docType: '合同', isExecutionDoc: false, established: false })).toBeNull();
  });
});

describe('filterContracts / needsFilter', () => {
  const list = Array.from({ length: 12 }, (_, i) => ({ contractNo: `HT-2024-${String(i).padStart(3, '0')}`, contractType: null, allowed: true }));
  it('>10 出过滤框; 大小写不敏感子串', () => {
    expect(needsFilter(list.slice(0, 10))).toBe(false);
    expect(needsFilter(list)).toBe(true);
    expect(filterContracts(list, 'ht-2024-00')).toHaveLength(10);
    expect(filterContracts(list, '999')).toEqual([]);
    expect(filterContracts(list, '  ')).toHaveLength(12); // 纯空白视为不过滤
  });
});