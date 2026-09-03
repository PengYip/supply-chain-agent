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

export interface DisableOptions { docType: string; isExecutionDoc: boolean; inLedger: boolean; }

/**
 * 模板规则不允许 / 执行类单据选了台账外合同 -> 中文原因; 可选返回 null。
 * P3 hotfix: 建立判据由「有绑定历史」放宽为「台账行存在」——旧判据鸡生蛋死锁
 * (新合同从未被绑 -> 下拉灰掉, 而进绑定集合恰恰需要先发生一次绑定)。双下拉的
 * 合同候选本身派生自台账(T7 context API), 该分支现仅为 context 与台账脱窗时的
 * 防御兜底; allowed=false 的模板组合禁用保持不变。
 */
export function contractDisableReason(c: TemplateContractRef, opts: DisableOptions): string | null {
  if (!c.allowed) {
    return `模板规则：${opts.docType} 不可挂「${c.contractType ?? '未知类型'}」合同`;
  }
  if (opts.isExecutionDoc && !opts.inLedger) {
    return '合同台账暂无该合同，请先完成合同文件解析抽取入库';
  }
  return null;
}

/** 台账行 -> established 合同号集合(P3 hotfix 语义: 行存在即建立)。空号跳过。 */
export function collectEstablishedContractNos(rows: Array<{ contractNo: string }>): Set<string> {
  const s = new Set<string>();
  for (const r of rows) {
    if (r.contractNo) s.add(r.contractNo);
  }
  return s;
}

/**
 * Tier-a(auto_rule)内联一键确认的 relation 派生: 优先用规则驱动的
 * context.bindsRelation(templates.ts 以激活 binds 规则词表首词派生, 规则缺失时
 * 即 bindingRelationFor 兜底); context 不匹配当前文档/缺失 -> 回退 '凭证'
 * (er-bind-fallback 词表首词, 服务端 relation 软校验恒通过)。
 */
export function quickConfirmRelation(context: TemplateContext | null, documentId: string): string {
  if (context && context.documentId === documentId && context.bindsRelation) {
    return context.bindsRelation;
  }
  return '凭证';
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

/** 手动输入编号的首步校验: 只做提交值规范化。 */
export function validateManualContractNo(
  input: string,
  opts: { isExecutionDoc: boolean; inLedger: boolean },
): { contractNo: string; error: string | null } {
  const contractNo = input.trim();
  if (!contractNo) return { contractNo, error: '请输入合同编号' };
  if (opts.isExecutionDoc && !opts.inLedger) {
    return { contractNo, error: '合同台账暂无该合同，请先完成合同文件解析抽取入库' };
  }
  return { contractNo, error: null };
}
