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

/** Fields that MUST be present for a 合同 extraction to be considered complete. */
export const REQUIRED_CONTRACT_FIELDS: (keyof ContractFields)[] = [
  '合同号', '甲方', '乙方', '标的物', '数量', '单位', '金额', '签订日',
];
