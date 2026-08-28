import { z } from 'zod';

export const PaymentMilestoneSchema = z.object({
  stage: z.string().min(1).describe('付款阶段名, 如 预付款/发货款/验收款/质保金'),
  ratio: z.number().min(0).max(1).describe('占合同金额比例 0..1'),
  amount: z.number().min(0).describe('该阶段金额(元)'),
});

export const ContractSchema = z.object({
  合同号: z.string().min(1),
  甲方: z.string().min(1).describe('采购方'),
  乙方: z.string().min(1).describe('销售方'),
  标的物: z.string().min(1),
  规格: z.string().optional(),
  数量: z.number().positive(),
  单位: z.string().min(1),
  金额: z.number().positive().describe('合同总金额(元)'),
  币种: z.enum(['CNY', 'USD', 'EUR']).default('CNY'),
  签订日: z.string().min(1).describe('YYYY-MM-DD'),
  生效日: z.string().optional(),
  交货地: z.string().optional(),
  付款节点: z.array(PaymentMilestoneSchema).default([]),
  质保期: z.string().optional(),
  违约金条款: z.string().optional(),
  收付款条款: z.string().optional(),
});

export type ContractFields = z.infer<typeof ContractSchema>;

/** 合同保底字段集(spec 2026-08-28): 模板下限。抽取输出必须逐名包含(原文缺失存空值)。
 *  锚点字段(台账入口/类型派生/图谱实体/绑定评分按名硬匹配)不可改名。
 *  模板演化经 /api/templates; 本常量是种子与新环境基线的 SSOT。 */
export const CONTRACT_TEMPLATE_FIELDS: readonly string[] = [
  // 主体与元信息
  '合同号', '合同名称', '合同类型', '签订日', '生效日', '项目编号',
  // 当事人(子项拍平, 保 Party 按名派生)
  '甲方', '甲方地址', '甲方电话', '甲方联系人', '甲方联系方式',
  '乙方', '乙方地址', '乙方电话', '乙方联系人', '乙方联系方式',
  // 标的与价格
  '标的物', '质量标准', '数量', '单位', '价格', '金额', '币种',
  // 结算
  '调价条款', '结算规则', '支付方式', '开票信息',
  // 物流交付
  '发货地', '收货地', '运输方式', '交割方式', '交货期', '履约期限', '供货期限',
  // 风险与其他
  '违约责任', '货品争议解决', '争议解决', '通知与送达', '其他约定',
];

export const CONTRACT_FIELD_HINTS: Readonly<Record<string, string>> = {
  合同号: '合同编号/合同号',
  合同类型: '受控值: 采购/销售/物流/租赁/服务/其他',
  甲方: '买方/需方',
  乙方: '卖方/供方',
  标的物: '商品/品名',
  数量: '纯数值, 不含单位',
  价格: '含税单价',
  金额: '合同总金额/价税合计(元)',
  币种: 'CNY/USD/EUR, 原文无则 CNY',
  交货期: '合同交货期/交货日期',
  运输方式: '汽运/火运/船运/空运',
  交割方式: '场地交货/到厂交货/自提',
  违约责任: '违约金条款',
  签订日: 'YYYY-MM-DD',
};

/** 兼容别名(extraction 无模板行时的 docType=合同 兜底) = 保底字段集。 */
export const REQUIRED_CONTRACT_FIELDS: readonly string[] = CONTRACT_TEMPLATE_FIELDS;
