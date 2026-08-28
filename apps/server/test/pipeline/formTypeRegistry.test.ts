import { describe, it, expect } from 'vitest';
import { buildFormTypeIndex, collectFormTypes, DOCUMENT_ROUTE_DOCTYPES } from '../../src/pipeline/formTypeRegistry.js';
import type { TemplateTypeRow } from '../../src/pipeline/db/repositories.js';

function row(name: string, props?: Record<string, unknown>, isActive = true): TemplateTypeRow {
  return {
    id: `dt-${name}`, kind: 'doc_type', name,
    parentId: null, props: props ?? {}, isActive,
  };
}

describe('formTypeRegistry', () => {
  it('maps formTypes from template props to route and docType', () => {
    const idx = buildFormTypeIndex([
      row('合同', { formTypes: ['合同扫描件'] }),
      row('汽运磅单', { formTypes: ['汽车过磅单票据'] }),
      row('水尺计重单', { formTypes: ['水尺计重单'] }),
    ]);
    expect(idx.routeOf('合同扫描件')).toBe('document');
    expect(idx.docTypeOf('合同扫描件')).toBe('合同');
    expect(idx.routeOf('汽车过磅单票据')).toBe('voucher');
    expect(idx.docTypeOf('汽车过磅单票据')).toBe('汽运磅单');
    expect(idx.routeOf('水尺计重单')).toBe('voucher');
    expect(idx.docTypeOf('水尺计重单')).toBe('水尺计重单');
  });

  it('unknown formType -> unknown route', () => {
    const idx = buildFormTypeIndex([]);
    expect(idx.routeOf('不认识的东西')).toBe('unknown');
    expect(idx.docTypeOf('不认识的东西')).toBeUndefined();
  });

  it('document route set is exactly 合同/立项书/补充合同', () => {
    expect([...DOCUMENT_ROUTE_DOCTYPES].sort()).toEqual(['补充合同', '合同', '立项书'].sort());
  });

  it('skips inactive types and non-string entries; first registration wins', () => {
    const idx = buildFormTypeIndex([
      row('收货单', { formTypes: ['货物交接清单'] }, false),
      row('货转单', { formTypes: ['货物交接清单', 42] }),
    ]);
    expect(idx.docTypeOf('货物交接清单')).toBe('货转单');
    expect(collectFormTypes([row('a', { formTypes: ['x'] }, false), row('b', { formTypes: ['y'] })])).toEqual(['y']);
  });
});
