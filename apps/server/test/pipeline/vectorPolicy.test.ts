import { describe, it, expect } from 'vitest';
import { isVectorizableDocType } from '../../src/pipeline/vectorPolicy.js';
import type { TemplateTypeRow } from '../../src/pipeline/db/repositories.js';

function row(name: string, parentId: string | null): TemplateTypeRow {
  return {
    id: `dt-${name}`, kind: 'doc_type', name, parentId,
    props: {}, isActive: true,
  };
}

const TREE = [
  row('合同', null),
  row('补充合同', 'dt-合同'),
  row('立项书', null),
  row('项目申请书', 'dt-立项书'),
  row('履约凭证', null),
  row('运输凭证', 'dt-履约凭证'),
];

describe('isVectorizableDocType', () => {
  it('根粗类直接判定', () => {
    expect(isVectorizableDocType('合同', TREE)).toBe(true);
    expect(isVectorizableDocType('立项书', TREE)).toBe(true);
    expect(isVectorizableDocType('履约凭证', TREE)).toBe(false);
    expect(isVectorizableDocType('其他', TREE)).toBe(false);
  });
  it('细类沿 parent 链上溯到粗类', () => {
    expect(isVectorizableDocType('补充合同', TREE)).toBe(true);
    expect(isVectorizableDocType('项目申请书', TREE)).toBe(true);
    expect(isVectorizableDocType('运输凭证', TREE)).toBe(false);
  });
  it('类型不在树中回退字面匹配', () => {
    expect(isVectorizableDocType('合同', [])).toBe(true);
    expect(isVectorizableDocType('立项书', [])).toBe(true);
    expect(isVectorizableDocType('运输凭证', [])).toBe(false);
  });
});
