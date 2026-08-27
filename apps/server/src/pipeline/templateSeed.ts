// 模板层种子(spec 2026-08-26 §3): 现状硬编码语义的机械翻译, 行为零变化。
// 修改这些行 = 修改绑定协议, 需带测试走。Phase 2 起模板经 /api/templates 演化。
import type { DbContext } from './db/client.js';
import { ensureEdgeRule, ensureTemplateType } from './db/repositories.js';

/** doc_type 种子——类型划分 v2(spec 2026-08-26 §3.1, 业务确认 2026-08-26)。
 *  Phase 1 登记全树(类型是被动注册表, 不影响行为); 新类型的边规则登记不启用。
 *  旧 8 类全部保留(分类器仍在用, 行为零变化); 提单/装箱单挂货转单下待 Phase 2 并入;
 *  化验报告→质检报告更名, 旧名保留; 发票保留为发票凭证的合法粗类。 */
const DOC_TYPE_SEED: Array<{ name: string; parent?: string; props?: Record<string, unknown> }> = [
  { name: '合同', props: { requiredFields: ['合同号', '甲方', '乙方', '标的物', '数量', '单位', '金额', '签订日'], fieldHints: { 合同号: '合同编号/合同号', 甲方: '买方/甲方', 乙方: '卖方/乙方' } } },
  { name: '补充合同', parent: '合同' },
  { name: '立项书', props: { bindsTargetKind: 'Project' } },
  { name: '履约凭证' },
  { name: '货转单', parent: '履约凭证' },
  { name: '提单', parent: '货转单', props: { aliasOf: '货转单' } },
  { name: '装箱单', parent: '货转单', props: { aliasOf: '货转单' } },
  { name: '质检报告', parent: '履约凭证' },
  { name: '化验报告', parent: '质检报告' },
  { name: '结算单', parent: '履约凭证' },
  { name: '运输凭证', parent: '履约凭证' },
  { name: '收货单', parent: '运输凭证' },
  { name: '发货单', parent: '运输凭证' },
  { name: '汽运磅单', parent: '运输凭证' },
  { name: '火运大票', parent: '运输凭证' },
  { name: '轨道衡称重单', parent: '运输凭证' },
  { name: '派船通知单', parent: '运输凭证' },
  { name: '资金凭证', parent: '履约凭证' },
  { name: '付款单', parent: '资金凭证' },
  { name: '付款凭证', parent: '资金凭证' },
  { name: '发票凭证', parent: '履约凭证' },
  { name: '发票', parent: '发票凭证' },
  { name: '进项票', parent: '发票凭证' },
  { name: '销项票', parent: '发票凭证' },
  { name: '其他', parent: '履约凭证' },
];

/** contract_type 种子(六类 + 买卖合同层级枢纽)。 */
const CONTRACT_TYPE_SEED: Array<{ name: string; parent?: string }> = [
  { name: '买卖合同' },
  { name: '采购', parent: '买卖合同' },
  { name: '销售', parent: '买卖合同' },
  { name: '物流' }, { name: '租赁' }, { name: '服务' }, { name: '其他' },
];

/** 边规则种子。src='' 源通配, tgt='' 目标通配。语义来源注释指向被翻译的硬编码。 */
const EDGE_RULE_SEED: Array<{
  id: string; src: string; tgt?: string; edge: string; vocab: string[]; active?: boolean;
}> = [
  // binds 词表 <- tradeSemantics.bindingRelationByVoucherType
  { id: 'er-bind-huozhuan', src: '货转单', edge: 'binds', vocab: ['货权转移'] },
  { id: 'er-bind-fukuan', src: '付款凭证', edge: 'binds', vocab: ['付款'] },
  { id: 'er-bind-huayan', src: '化验报告', edge: 'binds', vocab: ['质检'] },
  { id: 'er-bind-hetong', src: '合同', edge: 'binds', vocab: ['引用'] },
  { id: 'er-bind-qita', src: '其他', edge: 'binds', vocab: ['凭证'] },
  // settles 六向 <- executionFlow.FLOW_TYPE_BY_DOC_TYPE x tradeSemantics.SETTLES_RELATION_BY_FLOW
  { id: 'er-settle-fukuan', src: '付款凭证', edge: 'settles', vocab: ['收款', '付款'] },
  { id: 'er-settle-huozhuan', src: '货转单', edge: 'settles', vocab: ['收货', '发货'] },
  { id: 'er-settle-fapiao', src: '发票', edge: 'settles', vocab: ['收票', '开票'] },
  // 兜底(spec §3.2): 任意 -> 任意, 保证现状全部合法组合继续通过守卫
  { id: 'er-bind-fallback', src: '', edge: 'binds', vocab: ['凭证'] },
  // 登记不启用(spec §3.2 Phase 1 校验范围): executes <- tradeSemantics.executesDocTypes
  { id: 'er-exec-fapiao', src: '发票', edge: 'executes', vocab: [], active: false },
  { id: 'er-exec-tidan', src: '提单', edge: 'executes', vocab: [], active: false },
  { id: 'er-exec-zhuangxiang', src: '装箱单', edge: 'executes', vocab: [], active: false },
  // ---- graphCommit 派生边(spec §3.2 Phase 1 校验范围外, Phase 2 评估后登记不激活) ----
  // party/commodity/references 由 deriveProposedRelationships/deriveProposedEdges 确定性派生,
  // 无合同终点, 守卫模型不适用; 登记留痕, 激活待 Phase 3(manage_template 后)。
  { id: 'er-party-fapiao', src: '发票', edge: 'party', vocab: [], active: false },
  { id: 'er-commodity-fapiao', src: '发票', edge: 'commodity', vocab: [], active: false },
  { id: 'er-references-hetong', src: '合同', edge: 'references', vocab: [], active: false },
  // ---- v2 类型划分(spec 2026-08-26 §3.1): 方向编码类型已激活(T3), 其余登记不启用 ----
  // 方向编码类型(spec v2): settles 方向由类型自带, 与 flowType×direction 派生交叉验证
  { id: 'er-settle-shouhuo', src: '收货单', edge: 'settles', vocab: ['收货'] },
  { id: 'er-settle-fahuodan', src: '发货单', edge: 'settles', vocab: ['发货'] },
  { id: 'er-settle-jinxiang', src: '进项票', edge: 'settles', vocab: ['收票'] },
  { id: 'er-settle-xiaoxiang', src: '销项票', edge: 'settles', vocab: ['开票'] },
  // 通用履约物化层(spec 2026-08-27 §7): 运输三类型接入 settles。类型不带方向,
  // relation 由 flowType x direction 派生 -> 两向词表都放行(对齐货转单先例)。
  { id: 'er-settle-qiyun', src: '汽运磅单', edge: 'settles', vocab: ['收货', '发货'] },
  { id: 'er-settle-huoyun', src: '火运大票', edge: 'settles', vocab: ['收货', '发货'] },
  { id: 'er-settle-guidaocheng', src: '轨道衡称重单', edge: 'settles', vocab: ['收货', '发货'] },
  { id: 'er-settle-paichuan', src: '派船通知单', edge: 'settles', vocab: ['收货', '发货'] },
  // 付款单(申请单, 付款前): 登记不启用——不物化资金流(它不是支付证据)
  { id: 'er-bind-fukuandan', src: '付款单', edge: 'binds', vocab: ['付款申请'], active: false },
  // 结算单: 合同级结算凭证
  { id: 'er-bind-jiesuan', src: '结算单', edge: 'binds', vocab: ['结算'], active: false },
  // 质检报告(化验报告更名目标): 词表对齐旧 化验报告
  { id: 'er-bind-zhijian', src: '质检报告', edge: 'binds', vocab: ['质检'], active: false },
  // 补充合同: amends 修订关系(新边类型, Phase 2 激活 L2 工具)
  { id: 'er-amend-buchong', src: '补充合同', edge: 'amends', vocab: [] },
  // 立项书: binds 终点泛化到 Project(spec Phase 2 开绑定路径)
  { id: 'er-bind-lixiang', src: '立项书', edge: 'binds', vocab: ['立项'] },
];

/** 幂等灌入: 表空或部分存在都可重入(ensure* 均为 upsert)。 */
export async function ensureTemplateSeed(ctx: DbContext): Promise<void> {
  const typeId = (kind: 'dt' | 'ct', name: string) => `${kind}-${name}`;
  for (const t of DOC_TYPE_SEED) {
    await ensureTemplateType(ctx, {
      id: typeId('dt', t.name), kind: 'doc_type', name: t.name,
      parentId: t.parent ? typeId('dt', t.parent) : null,
      props: t.props,
    });
  }
  for (const t of CONTRACT_TYPE_SEED) {
    await ensureTemplateType(ctx, {
      id: typeId('ct', t.name), kind: 'contract_type', name: t.name,
      parentId: t.parent ? typeId('ct', t.parent) : null,
    });
  }
  for (const r of EDGE_RULE_SEED) {
    await ensureEdgeRule(ctx, {
      id: r.id,
      sourceTypeId: r.src ? typeId('dt', r.src) : '',
      targetTypeId: r.tgt ? typeId('ct', r.tgt) : '',
      edgeType: r.edge, allowedVocab: r.vocab, isActive: r.active !== false,
    });
  }
}
