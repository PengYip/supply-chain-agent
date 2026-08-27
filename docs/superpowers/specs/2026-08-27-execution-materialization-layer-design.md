# 通用履约物化层 Phase 1 设计（方案A：代码内注册表）

日期: 2026-08-27
状态: 已批准（用户全权委托, 方案A）
上游讨论: 发货单/铁路凭证绑定后无流水（根因: 白名单晚于绑定确认 + 无回填机制 + 铁路类无主体锚点被双重排除）

## 1. 目标与非目标

### 目标
0. **范围收束(用户确认 2026-08-27)**: 需要通用物化的是**物流单据**——物流单据差异性最大
   (商品/单位/格式千差万别); 资金来往与发票开具样式统一, 沿用既有封闭格式与字段路径,
   不为它们引入量纲机制。适配表中的发票/资金条目仅是既有行为的表驱动统一, 不扩机制。

1. **统一流水行**: 任何履约凭证 confirmed 绑定后物化结构统一的执行流水, 数量建模为
   `{原值, 原始单位, 量纲, 规范值}`, 与商品无关（煤炭吨 / 贵金属克千克 / 牛肉箱）。
2. **单位注册表**: `domain/units.ts` 纯数据 + 纯函数, 首批 吨/千克/公斤/克/箱/件/车。
   遇到新单位 = 注册表加一行, 机制不变。
3. **类型适配收敛**: 散在 `FLOW_TYPE_BY_DOC_TYPE` + `buildGoodsDocAnchors` +
   `buildAnchorsFromFields` 的类型知识合并为一张声明式适配表（tradeSemantics, L1 词汇归宿）。
   新单据类型接入 = 适配表加一行。
4. **方向三级判定**: 主体锚点（自主体名单命中买/卖方）→ 合同类型兜底（台账 contract_type）
   → 类型自带方向（方向编码类型）。判不出 = 跳过不猜（现状语义）。
5. **覆盖扩围**: 货物流 +收货单/发货单/汽运磅单/火运大票/派船通知单（货转单已有）;
   发票流 +进项票/销项票; 资金流付款凭证保持。
6. **历史回填**: 一次性脚本对全部 confirmed 绑定重跑 refresh, 补齐上线前遗漏的流水。
7. **合同执行进度**: query_execution_flows 返回进度块（基准=台账合同数量+单位,
   量纲不一致时如实报 mismatch, 不硬换算）。

### 非目标（明确排除）
- 付款单（申请非支付证据）、结算单（合同级汇总, 语义待定）——后续单独评估。
- 提单/装箱单（货转单别名, 待 Phase 2 并入类型树后再接）。
- 模板表驱动配置（方案B 演进路径, 本期适配表设计为纯数据便于日后搬家）。
- 币种建模与汇率换算（amount 保持原样）。
- 单位模糊匹配/别名学习（注册表只做归一化后精确匹配）。
- 前端改动（query 输出为增量字段, 向后兼容）。

## 2. 数据模型

### execution_flows 新增列（SQLite + Postgres 双端）
| 列 | 类型 | 语义 |
|---|---|---|
| quantity_value | REAL NULL | 抽取字段原始数值 |
| quantity_unit | TEXT NULL | 原始单位（字段原文名, 如 克/箱） |
| quantity_dimension | TEXT NULL | 'mass' \| 'count'; 未知单位 → NULL（不猜） |
| quantity_canonical | REAL NULL | mass → 千克; count → 原值（计数单位各自成池, 不跨单位合并） |

保留 quantity_ton/unit 向后兼容: quantity_ton = dimension=mass 时 canonical/1000, 否则 NULL;
unit 继续存原始单位名。现有读者（summarize）不破坏。

迁移: SQLite 走 client.ts 既有 guarded ALTER 模式（PRAGMA table_info 守卫）;
Postgres 走 client.ts PG DDL 的 `ADD COLUMN IF NOT EXISTS` + postgres-schema.ts drizzle 定义同步。

## 3. domain/units.ts（单位注册表）

```ts
export type QuantityDimension = 'mass' | 'count';
export interface UnitDef { readonly dimension: QuantityDimension; readonly factorToKg: number }
// mass: canonical=kg（吨=1000, 千克/公斤=1, 克=0.001）; count: factor 恒 1, 各单位自成聚合池
export const UNIT_REGISTRY: Readonly<Record<string, UnitDef>>;
export function resolveUnit(name: string): UnitDef | null;          // trim 后精确匹配, 不猜
export function canonicalizeQuantity(value: number, unit: string): {
  dimension: QuantityDimension; canonical: number;
} | null;                                                            // 未知单位返回 null
```

## 4. 类型适配表（tradeSemantics.ts 新增 FLOW_ADAPTERS）

```ts
export interface FlowAdapter {
  readonly flowFamily: '资金流' | '货物流' | '发票流';
  readonly qtyFields: ReadonlyArray<readonly [string] | [string, string]>; // [字段名, 单位提示?]
  readonly unitFields: readonly string[];   // 如 ['单位','重量单位']
  readonly dateFields: readonly string[];
  readonly amountFields: readonly string[];
  readonly codedDirection?: 'in' | 'out';   // 第三级兜底, 仅方向编码类型有
}
```

首批登记（均为文本结构化字段路径; 图片凭证 货转单/付款凭证/化验报告 维持
extractAnchors 专用路径, 只沿用 FLOW_TYPE 映射）:

| docType | 流族 | 数量字段（优先序） | 日期字段 | 金额字段 | codedDirection |
|---|---|---|---|---|---|
| 收货单 | 货物流 | 发运数量, [数量_吨,吨], 数量 | 收货日期, 到货日期, 发货日期, 日期 | 含税总价 | in |
| 发货单 | 货物流 | 同上 | 发货日期, 收货日期, 到货日期, 日期 | 含税总价 | out |
| 汽运磅单 | 货物流 | 合计净重, 净重, 合计毛重, 毛重, [重量_吨,吨], [数量_吨,吨], 数量 | 称量日期, 发货日期, 日期 | — | — |
| 火运大票 | 货物流 | 同汽运磅单 | 同汽运磅单 | — | — |
| 派船通知单 | 货物流 | 数量, [数量_吨,吨], [重量_吨,吨] | 通知日期, 发货日期, 日期 | — | — |
| 进项票 | 发票流 | 数量 | 开票日期, 日期 | 价税合计, 价税合计小写_元, 合计金额, 金额 | in |
| 销项票 | 发票流 | 同上 | 同上 | 同上 | out |
| 发票 | 发票流 | 同上 | 同上 | 同上 | —（主体判定） |

单位读取: qtyFields 命中后依次查 unitFields; 字段名带 `_吨` 后缀 = 单位即吨（命名即单位,
与台账 scoreQty 词表一致的既有契约）。单位不在注册表 → dimension/canonical 为 NULL, 原值照存。

## 5. 方向判定链（executionFlow.ts）

```
1. 主体锚点: resolveSelfSide(有效名单, anchors) 命中 → xxxDirectionFor(side, flowFamily)
2. 合同类型: findContractLedgerByNo(contractNo).contractType
   采购 → 货物流 in / 资金流 out / 发票流 in
   销售 → 货物流 out / 资金流 in / 发票流 out
3. 类型自带: adapter.codedDirection
4. 全部判不出 → null, 安静跳过（skipReason='direction-undeterminable' 语义不变）
```

dev 实测交叉验证: 发货单 DOC-mtb032yu（买方=湖北国贸=自主主体）走第 1 级 → in/收货
（我方是买方, 货进来, 正确; 类型 codedDirection 不覆盖主体证据）。
铁路凭证 DOC-mtb4vyd3（无买卖方字段, 合同为采购）走第 2 级 → in/收货。

## 6. 覆盖映射（FLOW_TYPE 最终集）

- 资金流: 付款凭证
- 货物流: 货转单, 收货单, 发货单, 汽运磅单, 火运大票, 派船通知单
- 发票流: 发票, 进项票, 销项票
- 其余（合同/立项书/化验报告/付款单/结算单/提单/装箱单/其他）不物化, 维持 null

## 7. 模板边规则（templateSeed.ts）

新增激活 settles 规则（词表对齐 货转单 先例——类型不带方向, 流派生关系两向都放行,
交叉验证不误杀）:
- er-settle-qiyun: 汽运磅单 → settles ['收货','发货']
- er-settle-huoyun: 火运大票 → settles ['收货','发货']
- er-settle-paichuan: 派船通知单 → settles ['收货','发货']
（进项票/销项票/收货单/发货单 的方向编码规则已存在, 不动。）

## 8. 锚点派生重构（bindingProposal.ts）

- `buildAnchorsFromFields`/`buildGoodsDocAnchors`/`GOODS_FIELD_DOCS` 收敛为
  `deriveAnchorsFromAdapter(docType, fields)`: 有 FLOW_ADAPTERS 条目走适配表;
  无条目的未知类型维持现通用兜底（合同号/主体别名/日期/金额/数量, 行为不变）。
- VoucherAnchors 增加 `quantity?: { value; unit?; dimension: 'mass'|'count'|null; canonical: number|null }`;
  quantityTon/quantityUnit 继续由 quantity 投影填充（mass → canonical/1000）, 兼容旧消费方。
- `anchorsForExtraction` 分派: 图片凭证 → extractAnchors（不变）; 其余 → deriveAnchorsFromAdapter。

## 9. 聚合与执行进度

- summarizeExecutionFlows 增量输出: 每组 total_mass_kg（dimension='mass' 的 canonical 求和）;
  count 池不跨单位合并, 在工具层按 unit 分池统计。
- query_execution_flows 返回新增 `executionProgress` 块（纯函数计算, 输入=流水行 + 台账行）:
  - basis: 台账 fields 的 数量+单位 canonicalize（缺 → null + reason='no-contract-basis'）
  - delivered: { massKg, countPools: Record<单位, 数量> }
  - progress: basis 与 delivered 量纲一致 → delivered/basis; 不一致 → null +
    reason='dimension-mismatch'; count 基准按同单位池对齐, 池不存在 → progress=0
- 汇总数字零幻觉原则不变: 换算只在注册表系数可查时进行。

## 10. 历史回填

`npm run backfill:flows --workspace apps/server`（tsx scripts/backfillFlows.ts）:
- 取全部 status=confirmed 的绑定, 按 (user_id, document_id) 分组, 逐组调
  refreshExecutionFlowsForDocument（先撤后物化, 幂等, 与复核修正同一条防漂移路径）。
- 输出逐文档 {retracted, materialized, skipped[]} 汇总; 失败只告警不中断。
- 上线顺序: 部署新代码 → 跑一次回填 → dev 库验证 DOC-mtb032yu（发货单→货物流 in
  收货 3357.46）与 DOC-mtb4vyd3（铁路→货物流 in, 合计净重, 合同类型兜底）。

## 11. 测试与验收

- units: 注册表解析/换算/未知单位 null（克→kg、吨→kg、箱→count 池、'磅'未注册 → null）。
- 适配表: 全部覆盖类型有条目; 字段优先序; `_吨` 后缀命名即单位。
- 锚点: 发货单 dev 实测形状（发运数量无单位字段 → unit/dimension NULL）; 磅单
  合计净重+重量单位=吨 → mass; 贵金属样例 克 → canonical。
- 方向链: 主体命中 / 合同类型兜底 / coded / 全缺跳过, 四级用例。
- 白名单: 火运大票现在物化; 付款单/结算单仍不物化。
- 进度: mass 对齐 / 量纲不一致 mismatch / 无基准 / count 池对齐。
- 回归: 现有 executionFlow/bindingProposal 测试全绿; build→lint→test 必须过。

## 12. Phase 2 演进路径（记录, 不实施）

适配表 + 单位注册表均为纯数据, 搬进 template_types.props 后即可"新类型=插配置"（方案B）;
付款单/结算单/提单/装箱单接入另行评审。
