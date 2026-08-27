// 选择性向量化策略(spec docs/superpowers/specs/2026-08-27-selective-vectorization-design.md):
// 只有模板树顶层为「合同」/「立项书」的类型进入向量库, 其余类型 FTS5 关键词召回兜底。
import type { TemplateTypeRow } from './db/repositories.js';

export const VECTORIZE_ROOT_TYPES = ['合同', '立项书'] as const;

export const SKIP_REASON_NOT_VECTORIZABLE = '仅合同/立项书类型向量化入库';

/** 沿模板树 parentId 上溯到顶层粗类, 粗类属于 VECTORIZE_ROOT_TYPES 才向量化;
 *  类型不在模板表(离线/测试)时回退字面匹配根名。 */
export function isVectorizableDocType(docType: string, types: TemplateTypeRow[]): boolean {
  const roots = VECTORIZE_ROOT_TYPES as readonly string[];
  const byName = new Map(types.filter((t) => t.kind === 'doc_type').map((t) => [t.name, t]));
  let node = byName.get(docType);
  if (!node) return roots.includes(docType);
  for (let guard = 0; guard < 16 && node.parentId; guard++) {
    const parent = byName.get(types.find((t) => t.id === node!.parentId)?.name ?? '');
    if (!parent || parent === node) break;
    node = parent;
  }
  return roots.includes(node.name);
}
