# 合同模板保底字段（抽取下限保证）设计

- 日期: 2026-08-28
- 分支: `PengYip/业务逻辑优化`
- 状态: 已确认（方案 B，用户拍板"可多不可少、缺失存空"）

## 背景与目标

现状：`extractGroundedFields`（`apps/server/src/pipeline/extraction.ts`）的输出 schema 是
开放 record（`z.record(字段名, {value, sourceSpans})`），字段名由模型自由决定；模板
`props.requiredFields` 只进提示词 + 缺失标记，无结构保证。

需求：合同解析后的结构化数据必须覆盖模板字段集——

- 模板是**下限**：抽取可以比模板多，不能比模板少；
- 合同原文没有的模板字段：**存空值**（不省略该字段）。

不变量：**抽取结果逐名包含全部模板字段；模型多抽的字段原样保留。**

## 语义定义

| 概念 | 定义 |
|---|---|
| 保底字段集 | 模板 `props.requiredFields`（语义更新）：必须逐名出现在抽取输出中；原文缺失时 `value: ''`、`sourceSpans: []` 落库 |
| missingRequired | 保底字段值为空串/纯空白（含补齐产生的空值）→ 列入并触发 `needsReview`；只标记复核，不阻断入库/台账回写 |
| overallConfidence（抽取层） | 仅对**非空值**字段求平均（空值保底字段不稀释置信度信号）；全空 → 0 |
| overallConfidence（台账层） | 保持原语义：全部 fieldMeta 平均。空值字段 confidence 低 → 台账 `needsReview=true`，是期望的完整性信号 |
| 合同号为空 | 不建台账行（现状结构约束，保持不变；复核卡人工补号后重抽可入台账） |

## 保底字段集（39 个，含锚点）

锚点字段（下游硬匹配，**不可改名**，加 `*` 标注）：
`合同号*`（台账入口）、`合同类型*`（类型派生）、`甲方*`/`乙方*`（Party 实体+绑定主体锚点）、
`标的物*`（Commodity 实体+标题回退）、`数量*`/`金额*`（绑定数量/金额锚点）、
`签订日*`（签订时间窗）、`生效日*`/`交货期*`（履约时间锚点）、`单位*`（数量计量）、
`项目编号*`（Project 实体）。

甲乙方子项**拍平**为独立字段（嵌套会破坏按名匹配的 Party 派生）：
`甲方地址`/`甲方电话`/`甲方联系人`/`甲方联系方式`，乙方同。

完整清单（SSOT 常量 `CONTRACT_TEMPLATE_FIELDS`，按 prompt 分组顺序）：

1. 主体与元信息：合同号*、合同名称、合同类型*、签订日*、生效日*、项目编号*
2. 当事人：甲方*、甲方地址、甲方电话、甲方联系人、甲方联系方式、乙方*、乙方地址、乙方电话、乙方联系人、乙方联系方式
3. 标的与价格：标的物*、质量标准、数量*、单位*、价格、金额*、币种
4. 结算：调价条款、结算规则、支付方式、开票信息
5. 物流交付：发货地、收货地、运输方式、交割方式、交货期*、履约期限、供货期限
6. 风险与其他：违约责任、货品争议解决、争议解决、通知与送达、其他约定

`CONTRACT_FIELD_HINTS`（别名/取值说明，节选）：合同号→"合同编号"；合同类型→"受控值: 采购/销售/物流/租赁/服务/其他"；甲方→"买方/需方"；乙方→"卖方/供方"；价格→"含税单价"；金额→"合同总金额/价税合计(元)"；数量→"纯数值，不含单位"；交货期→"合同交货期/交货日期"；违约责任→"违约金条款"；运输方式→"汽运/火运/船运/空运"；交割方式→"场地交货/到厂交货/自提"；币种→"CNY/USD/EUR，默认 CNY"。

## 方案（B：确定性补齐）

提示词引导 + 抽取后确定性补齐双保险。不采用闭式 schema（DeepSeek JSON-mode 拒绝
`response_format=json_schema`，且"可比模板多"本就需要放开 record，强约束无从谈起）。

### 变更点

1. **`apps/server/src/pipeline/schemas/contract.ts`**
   - 新增 `CONTRACT_TEMPLATE_FIELDS: readonly string[]`（39 字段 SSOT）与
     `CONTRACT_FIELD_HINTS: Readonly<Record<string, string>>`；
   - `REQUIRED_CONTRACT_FIELDS` 改为 `CONTRACT_TEMPLATE_FIELDS` 的兼容别名
     （类型从 `(keyof ContractFields)[]` 放宽为 `readonly string[]`；现仅 extraction.ts 引用）；
   - `ContractSchema`/`ContractFields` 为遗留类型文档，本次不动。

2. **`apps/server/src/pipeline/templateSeed.ts`**
   - 合同行 props 改为引用 SSOT：`requiredFields: [...CONTRACT_TEMPLATE_FIELDS]`、
     `fieldHints: CONTRACT_FIELD_HINTS`（消除两处清单漂移）。

3. **`apps/server/src/pipeline/extraction.ts`**
   - 提示词：动态段改为"保底字段必须逐个出现在输出中（优先级高于『不存在则不列』规则），
     原文缺失时 value 置空字符串、sourceSpans 置空数组；真实缺失同时列入 missingRequired"；
   - 新增导出纯函数 `padTemplateFields(fields, required)`：输出缺失的保底字段补
     `{ value: '', sourceSpans: [], strength: 'none', confidence: 0, needsReview: true, autoAccepted: false, citedText: null }`；
   - `missingRequired` = 保底字段中值为空/空白者（补齐后计算）；
   - `overallConfidence` 仅平均非空值字段。
   - 对全部 docType 生效（凡传了 requiredFields 的类型，语义统一为"模板=下限"）。

4. **下游（核查结论，无需改动）**
   - `deriveProposedRelationships/Edges`：空值跳过（`val` 判空）；
   - `bindingProposal`：`strField` 跳过空串；`numField` 空串→0→命中既有 `===0` 中性分支；
   - `buildLedgerEntryFromExtraction`：空字段原样入台账；合同号空 → 无台账行；
   - `graphWriter`：选择性 props 写入，不遍历 fields 全集；
   - 复核卡/`query_contract`：fields 透传，空字段自然展示、可人工补填。

5. **测试**
   - `extraction` 相关单测：补齐产生空字段；missingRequired 计入空值；overallConfidence 排除空值；模型多抽字段保留；
   - `templateSeed.test.ts`：新增断言合同 props 覆盖锚点字段（与 SSOT 一致）；
   - `contractLedger`：含空字段构建台账（合同号空 → null；非空 → 空字段随行）；
   - `bindingProposal`：空值数量/金额锚点 → 中性 0.5。

## 兼容与演化

- 种子是**新环境基线**；存量环境经 `/api/templates`（admin）演化。
  实现时核查 `ensureTemplateType` 的 upsert 是否覆盖 props：覆盖则重启自动生效；
  不覆盖则需对 10.10.0.2 手动 PATCH 模板（记入计划）。
- 模板继续经 `/api/templates` 调整字段集；本设计只改"下限保证"的执行机制，机制与具体字段解耦。

## 验收

- 新增/更新单测全绿；`npm run build`、`npm run lint`、`npm test` 全绿（CI 等价顺序）。
- 不变量由单测锁定：任意模型输出（含空输出）经抽取层后，保底字段逐名存在。
