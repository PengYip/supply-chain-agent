// 模板守卫(spec 2026-08-26 §4.3): 绑定写入前的类型兼容性校验。
// Phase 1: 硬校验 (docType, contractType, edgeType) 组合; relation 词表软校验。
// 未登记 docType 一律放行(legacy 兼容, 行为零变化基线)。
import type { DbContext } from './db/client.js';
import {
  listActiveEdgeRules, listTemplateTypes,
  type TemplateEdgeRuleRow, type TemplateTypeRow,
} from './db/repositories.js';

export type GuardResult =
  | { ok: true; ruleId: string; templateVersion: number; relationInVocab: boolean | null }
  | { ok: false; reason: string };

const GUARDED_EDGE_TYPES = new Set(['binds', 'settles']);

/** 自底向上祖先链(含自身), visited 集环安全。startId null 返回空链。 */
export function ancestorChain(startId: string | null, byId: Map<string, TemplateTypeRow>): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let cur = startId ? byId.get(startId) : undefined;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.push(cur.id);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return chain;
}

/**
 * 最具体优先匹配。specificity = 源链命中位置(0=精确) + 目标通配惩罚;
 * 源通配规则('' 在 sourceTypeId)排最后。
 */
export function matchEdgeRule(params: {
  rules: TemplateEdgeRuleRow[];
  sourceChain: string[];
  targetChain: string[];
  edgeType: string;
}): TemplateEdgeRuleRow | null {
  let best: TemplateEdgeRuleRow | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const r of params.rules) {
    if (r.edgeType !== params.edgeType) continue;
    const srcIsWildcard = r.sourceTypeId === '';
    const srcIdx = srcIsWildcard ? params.sourceChain.length : params.sourceChain.indexOf(r.sourceTypeId);
    if (!srcIsWildcard && srcIdx === -1) continue; // 未命中源链
    const tgtIsWildcard = r.targetTypeId === '';
    const tgtIdx = tgtIsWildcard ? params.targetChain.length : params.targetChain.indexOf(r.targetTypeId);
    if (!tgtIsWildcard && tgtIdx === -1) continue; // 目标未命中且非通配
    // 分数: 源精确度 + 目标精确度; 通配源最泛。
    const score = (srcIsWildcard ? params.sourceChain.length + 1 : srcIdx) + (tgtIsWildcard ? params.targetChain.length : tgtIdx);
    if (score < bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return best;
}

export async function validateEdge(
  ctx: DbContext,
  input: { docType: string; contractType?: string | null; edgeType: string; relation?: string },
): Promise<GuardResult> {
  if (!GUARDED_EDGE_TYPES.has(input.edgeType)) {
    return { ok: true, ruleId: 'unguarded', templateVersion: 0, relationInVocab: null };
  }
  const [types, rules] = await Promise.all([listTemplateTypes(ctx), listActiveEdgeRules(ctx)]);
  const byId = new Map(types.map((t) => [t.id, t]));
  // 未登记 docType: legacy 兼容放行(行为零变化)。
  if (!byId.has(`dt-${input.docType}`)) {
    return { ok: true, ruleId: 'passthrough', templateVersion: 0, relationInVocab: null };
  }
  const sourceChain = ancestorChain(byId.get(`dt-${input.docType}`)?.id ?? null, byId);
  const targetChain = input.contractType
    ? ancestorChain(byId.get(`ct-${input.contractType}`)?.id ?? null, byId)
    : [''];
  const rule = matchEdgeRule({ rules, sourceChain, targetChain: targetChain.length > 0 ? targetChain : [''], edgeType: input.edgeType });
  if (!rule) {
    return {
      ok: false,
      reason: `单据类型「${input.docType}」不允许建立 ${input.edgeType} 关系到「${input.contractType ?? '未知'}」类型合同（无激活模板规则）`,
    };
  }
  const relationInVocab = input.relation
    ? (rule.allowedVocab.length === 0 ? null : rule.allowedVocab.includes(input.relation))
    : null;
  return { ok: true, ruleId: rule.id, templateVersion: rule.templateVersion, relationInVocab };
}