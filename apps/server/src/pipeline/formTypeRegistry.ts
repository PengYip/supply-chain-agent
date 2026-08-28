// 表单类型 -> 业务类型映射(spec 2026-08-28 §3): 映射是数据(doc_type.props.formTypes),
// 不是代码。VLM 分类器只输出表单类型; route(document/voucher)与业务类型都从这里
// 派生。业务类型调整=改模板表 props, 分类器与提取代码不动。
import type { DocType } from './types.js';
import type { TemplateTypeRow } from './db/repositories.js';

/** document 路由的粗类(需全文, 走 OCR 分支); 其余一切 voucher。 */
export const DOCUMENT_ROUTE_DOCTYPES: ReadonlySet<string> = new Set(['合同', '立项书', '补充合同']);

export interface FormTypeIndex {
  routeOf(formType: string): 'document' | 'voucher' | 'unknown';
  docTypeOf(formType: string): DocType | undefined;
}

function formTypesOf(t: TemplateTypeRow): string[] {
  if (t.kind !== 'doc_type' || !t.isActive) return [];
  if (!Array.isArray(t.props.formTypes)) return [];
  return (t.props.formTypes as unknown[]).filter((f): f is string => typeof f === 'string' && f.length > 0);
}

/** 全树 formTypes 并集(注入 VLM 分类 prompt 的候选清单)。仅活跃类型。 */
export function collectFormTypes(types: TemplateTypeRow[]): string[] {
  const out = new Set<string>();
  for (const t of types) for (const f of formTypesOf(t)) out.add(f);
  return [...out];
}

export function buildFormTypeIndex(types: TemplateTypeRow[]): FormTypeIndex {
  const formToDocType = new Map<string, DocType>();
  for (const t of types) {
    // 非活跃类型不参与路由(与 collectFormTypes 一致): 置灰类型的表单仍归并到活跃映射。
    for (const f of formTypesOf(t)) {
      if (!formToDocType.has(f)) formToDocType.set(f, t.name as DocType);
    }
  }
  return {
    routeOf(formType) {
      const dt = formToDocType.get(formType);
      if (!dt) return 'unknown';
      return DOCUMENT_ROUTE_DOCTYPES.has(dt) ? 'document' : 'voucher';
    },
    docTypeOf(formType) {
      return formToDocType.get(formType);
    },
  };
}
