// 双下拉绑定表单纯逻辑模型(无 React 依赖): relation 派生 / 项目合成 / 禁用原因 / 过滤。
import type { TemplateContext, TemplateContractRef } from '../api/templateContext';

export const UNASSIGNED_KEY = '__unassigned__';
export const FILTER_THRESHOLD = 10;

export interface ProjectOption {
  key: string;            // 项目 code 或 UNASSIGNED_KEY
  label: string;          // 项目名 / '未挂项目'
  contracts: TemplateContractRef[];
  isUnassigned: boolean;
}

/** projects 原序 + 末尾合成'未挂项目'组; 未挂组合同为 0 时不含该组。 */
export function buildProjectOptions(ctx: TemplateContext): ProjectOption[] {
  const options: ProjectOption[] = ctx.projects.map((p) => ({
    key: p.code,
    label: p.name,
    contracts: p.contracts,
    isUnassigned: false,
  }));
  if (ctx.unassignedContracts.length > 0) {
    options.push({
      key: UNASSIGNED_KEY,
      label: '未挂项目',
      contracts: ctx.unassignedContracts,
      isUnassigned: true,
    });
  }
  return options;
}

export interface RelationDerivation {
  word: string;                            // 提交用词; needsChoice 时为空串
  vocab: string[];                         // 候选词集
  source: 'settles' | 'binds';
  needsChoice: boolean;                    // vocab.length > 1 时需用户澄清方向
}

/** settlesVocab 非空 -> source settles(单词直取/多词 needsChoice); 否则 bindsRelation。 */
export function deriveRelation(ctx: TemplateContext): RelationDerivation {
  if (ctx.settlesVocab && ctx.settlesVocab.length > 0) {
    return {
      word: ctx.settlesVocab.length === 1 ? ctx.settlesVocab[0]! : '',
      vocab: ctx.settlesVocab,
      source: 'settles',
      needsChoice: ctx.settlesVocab.length > 1,
    };
  }
  return { word: ctx.bindsRelation, vocab: [ctx.bindsRelation], source: 'binds', needsChoice: false };
}

export interface DisableOptions { docType: string; isExecutionDoc: boolean; established: boolean; }

/** 模板规则不允许 / 执行类单据未挂合同文件 -> 中文原因; 可选返回 null。 */
export function contractDisableReason(c: TemplateContractRef, opts: DisableOptions): string | null {
  if (!c.allowed) {
    return `模板规则：${opts.docType} 不可挂「${c.contractType ?? '未知类型'}」合同`;
  }
  if (opts.isExecutionDoc && !opts.established) {
    return '未挂合同文件，执行类单据不可选';
  }
  return null;
}

/** 步骤二过滤: contractNo 大小写不敏感子串匹配(全角空格忽略, 简单 includes)。 */
export function filterContracts(list: TemplateContractRef[], query: string): TemplateContractRef[] {
  const q = query.replace(/\s/g, '').toLowerCase();
  if (!q) return list;
  return list.filter((c) => c.contractNo.toLowerCase().includes(q));
}

export function needsFilter(contracts: TemplateContractRef[]): boolean {
  return contracts.length > FILTER_THRESHOLD;
}