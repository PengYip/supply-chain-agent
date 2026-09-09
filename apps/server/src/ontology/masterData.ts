// 主数据登记（2026-09-08）：商品/交易对手/内部组织 3 类静态实体的表单入口共享后端。
// 直接端点写入（不走 agent 会话、不加 L2 工具）：主数据非资金事实，审批暂不要求；
// 唯一写入边界仍是 insertTradeFact（注册表 strict zod + createdBy='manual' 溯源），
// 禁止任何直写 SQL。字段词汇=注册表静态实体 schema（与事件登记 inputSchema 同构）。
import { z } from 'zod';
import {
  COMMODITY_CODES, ENTITY_DESCRIPTIONS, ENTITY_LABELS, ONTOLOGY_ENTITIES,
} from './index.js';
import { unwrapField, fieldKind } from './eventTools.js';

export const MASTER_DATA_TYPES = ['TradeGoods', 'Counterparty', 'OrgUnit'] as const;
export type MasterDataType = (typeof MASTER_DATA_TYPES)[number];

// inputSchema SSOT：端点与表单投影共用同一 zod（路由叠加 strict）；
// 各实体自己的必填约束由端点预检 entitySchema(strict) 权威执行，这里字段全可选（并集）。
// attributes（TradeGoods 受控袋）经此处透传，词汇边界（键长/值标量）与条数上限
// （superRefine）由端点预检 entitySchema('TradeGoods') 权威执行。
export const CreateMasterDataInputSchema = z.object({
  entityType: z.enum(MASTER_DATA_TYPES).describe('主数据类型（商品/交易对手/内部组织）'),
  validAt: z.string().min(1).optional().describe('业务生效时间 ISO 日期（如 2026-06-25）；缺省=登记时刻'),
  name: z.string().min(1).optional().describe('名称（商品名/企业名/内部组织名，三类实体均必填）'),
  commodityCode: z.string().min(1).optional().describe('商品码（仅商品必填）；v1 开放词汇自由填写，业务确认后收敛为闭枚举自动收紧'),
  spec: z.string().optional().describe('规格品位（仅商品，选填）'),
  unit: z.string().optional().describe('计量单位（仅商品，选填，如 吨）'),
  attributes: z.record(z.string().min(1), z.union([z.string(), z.number()]))
    .optional()
    .describe('自定义属性 KV 袋（仅商品，选填；受控约束见注册表）'),
  uscc: z.string().min(1).optional().describe('统一社会信用代码（仅交易对手必填；主体归一锚）'),
  role: z.string().optional().describe('角色（仅交易对手必填）：供应商/客户/服务商'),
  address: z.string().optional().describe('注册地址（仅交易对手，选填）'),
  bankAccount: z.string().optional().describe('收款账号（仅交易对手，选填；敏感信息前端脱敏展示）'),
  bankName: z.string().optional().describe('开户行（仅交易对手，选填）'),
  legalRepresentative: z.string().optional().describe('法定代表人（仅交易对手，选填）'),
  registeredCapital: z.string().optional().describe('注册资本（仅交易对手，选填）'),
  establishedDate: z.string().optional().describe('成立日期（仅交易对手，选填）'),
  businessScope: z.string().optional().describe('经营范围（仅交易对手，选填）'),
  code: z.string().optional().describe('组织编码（仅内部组织，选填）'),
});

// 变更换代输入（spec 主体身份 §4，2026-09-09）：主体变更=同主体新事实+旧事实失效。
// payload 直接复用注册表 Counterparty schema（SSOT，不复制字段定义；词汇/strict
// 权威校验由端点预检 entitySchema('Counterparty') 执行）——整包提交（决策 #7a：
// 一条事实=主体在时点上的属性快照，UI 预填现行值保证合并）。
export const ChangeMasterDataInputSchema = z.object({
  prevFactId: z.string().min(1).describe('被换代事实 id（台账详情可复制，TF- 开头）'),
  payload: ONTOLOGY_ENTITIES['Counterparty'].strict().describe('主体新属性快照（整包提交；uscc 必须与现行事实一致，防跨主体误换代；strict 拒绝注册表外键）'),
  validAt: z.string().min(1).optional().describe('变更生效时间 ISO 日期（如 2026-09-01）；缺省=登记时刻'),
});

/** 商品码门禁：词汇非空时强制 ∈ COMMODITY_CODES；空词汇（v1 开放，业务未确认）自由填写，
 *  转闭枚举后自动收紧。vocabulary 参数默认注册表词汇，测试可注入。 */
export function commodityCodeGateError(
  commodityCode: string,
  vocabulary: readonly string[] = COMMODITY_CODES,
): string | null {
  if (vocabulary.length === 0) return null;
  return vocabulary.includes(commodityCode)
    ? null
    : `商品码 ${commodityCode} 不在 COMMODITY_CODES 词汇内（允许：${vocabulary.join('/')}）`;
}

// ---------------------------------------------------------------------------
// 表单入口投影（GET /api/ontology/master-data/schema 数据源）：字段/必填/描述
// 全部反射自注册表静态实体 schema，web 不复制任何字段定义。
// ---------------------------------------------------------------------------

export interface MasterDataFormFieldDTO {
  name: string;
  kind: 'string' | 'number' | 'enum';
  required: boolean;
  description: string;
}

export interface MasterDataTypeFormDTO {
  name: MasterDataType;
  label: string;
  description: string;
  fields: MasterDataFormFieldDTO[];
}

export function masterDataFormSchemaJson(): { types: MasterDataTypeFormDTO[] } {
  return {
    types: MASTER_DATA_TYPES.map((t) => ({
      name: t,
      label: ENTITY_LABELS[t],
      description: ENTITY_DESCRIPTIONS[t],
      fields: Object.entries(ONTOLOGY_ENTITIES[t].shape)
        .map(([name, sch]) => {
          const { inner, required } = unwrapField(sch);
          const kind = fieldKind(inner);
          // spec 决策 #8: record 袋（TradeGoods.attributes）不进字段投影
          // （fieldKind 不支持 record），录入/展示由前端键值编辑区承载。
          if (!kind) return null;
          return {
            name,
            kind,
            required,
            description: inner.description ?? sch.description ?? '',
          };
        })
        .filter((f): f is MasterDataFormFieldDTO => f !== null),
    })),
  };
}
