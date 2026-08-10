# 原始单据录入 Agent — Phase 1b (发票) 设计文档（Spec）

> 状态：待评审 | 日期：2026-08-05 | 基础：Phase 1a + H1/H3/H4/H2 已完成并合入 `main` @ `7a7ac37`
> 1a spec：`docs/superpowers/specs/2026-08-05-document-entry-agent-design.md`（§6.2 发票 schema，§13 1b phasing）
> 1a plan：`docs/superpowers/plans/2026-08-05-document-entry-agent.md`
> 发票 discovery 报告：`.superpowers/sdd/invoice-discovery-report.md`

---

## 1. 背景与目标

Phase 1a 已交付合同录入闭环（数字零幻觉硬约束、BlockModel 主干、MinerU/digital 适配器、span 校验、置信度、grounded 抽取、ingest/extract/bind 工具、harness 接线、eval）。Phase 1b 在同一主干上增量扩展**发票录入**：复用全部 1a pipeline，新增一个**发票规则引擎**层处理发票的高结构化字段（国家统一格式），明细行仍走 1a 的 LLM+span-grounding 路径。

**Phase 1b 借鉴文章思路的延续**：受控 schema + 结构化字段优先 + 原文引用 + 可复核 + 评测。对发票而言，受控更进一步——金额/身份类字段直接由**规则**抽取（不经过 LLM），从根上消除数字幻觉风险；LLM 只在规则不可靠处（明细行）介入，且仍带 span 接地。

## 2. 范围

### 2.1 IN（Phase 1b 做）
- **发票 schema**（zod）：§6.2 基础字段 + discovery 发现的真实字段。
- **发票规则引擎模块**：label-anchor（表头文本块）+ table-HTML regex/cell-parse（表格 HTML 内的合计/身份）+ 价税合计自校验（价税合计 = 金额合计 + 税额）。
- **docType 分支接入 `extract_fields`**：合同→1a LLM 路径；发票→规则引擎先行（合计/身份），明细行→LLM+span-grounding。
- **结算单（settlement）绑定目标**：1b 新增最小 settlement 绑定能力（`bind_document` 的 targetType 已含 `'settlement'`，但 settlement 记录尚不存在 → 1b 需补最小 settlement 记录/标识）。
- **发票 eval set + runner**：合成发票样例（clean + trap）+ 真实脱敏切片；价税合计自校验作为强断言。

### 2.2 OUT（推后）
- 物流 / 收付款 单据的完整 schema（1b 只做发票）。
- 全量四流合一对账（属 Phase 1c）。
- 发票验真（外部税务接口）——数据不出域，后续专项。

## 3. 设计决策（已锁定）

| # | 决策 | 选择 | 理由 |
|---|---|---|---|
| 1 | 发票抽取路线 | **混合：规则 + LLM** | 高结构化字段（合计/身份）走规则（零幻觉）；明细行列关联脆弱走 LLM+span-grounding |
| 2 | 工具结构 | **`extract_fields` 内 docType 分支** | 单一工具，docType 决定规则/LLM 切分；规则引擎是新的发票专用模块；复用 T8/T9 接线 |
| 3 | 发票绑定目标 | **结算单（settlement）** | 对齐三单匹配对账 SOP；1b 需新增最小 settlement 绑定能力（**范围新增**，见 §7） |
| 4 | 发票 schema 字段 | **§6.2 + discovery 字段** | 加 购/销方纳税人识别号、开票人、明细行每行税率 |

## 4. 发票 MinerU discovery 关键发现（驱动设计）

真实发票（`examples/发票_1.pdf`，本地 MinerU 3.4.4）：
- 与 H2 修复后的 MinerU shape 一致，**表格主导**：发票号/开票日是干净的 label-anchored 文本块；购/销方 + 明细 + 所有合计都在**一个大 `table` block**里，以 HTML 单元格形式存在。
- **规则可靠抽取（零 LLM）**：发票号、开票日、购方/销方（名称+纳税人识别号）、金额合计、税额合计、**价税合计（= 金额合计 + 税额，可自校验）**、开票人。
- **需 LLM+span-grounding**：明细行（MinerU HTML 把 数量/单价 粘在一起，多行货物名称用 rowspan → 列关联脆弱）。
- **无需改适配器**：H2 加固后的 `mineruAdapter.ts` 已正确解析该 shape；发票表格 HTML 作为 `Block.text` 流过。
- 明细行格式：在 `table_body` HTML `<tr>` 行内（非独立 block）；每行 金额/税率/税额 可 regex 命中，但列关联脆弱 → 天然的混合切分点。

## 5. 总体架构：docType 分支 + 规则引擎

```
原件 ──► ingest_document(L1) ──► BlockModel  （1a 不变；H2 适配器已支持发票 shape）
   │
   └─► extract_fields(L1) ─[docType 分支]─►
            合同 → 1a 路径：LLM 受约束抽取 + span 接地 + 置信度  （不变）
            发票 → ①规则引擎（label-anchor + table-HTML regex + 自校验）
                     产出：发票号/开票日/购销方/金额合计/税额合计/价税合计/开票人（零 LLM，每个值带来源 block/span）
                  ②明细行 → 1a LLM+span-grounding 路径（仅明细，HTML 列关联 fragile）
                  ③合并 + 缺失/低置信 → T4/T3 HITL
   │
   └─► bind_document(L2) ──► 绑定到 结算单（settlement）  （1b 新增 settlement 绑定）
```

**关键**：规则引擎是**新的发票专用模块**（`server/src/pipeline/rules/invoiceRules.ts`），产出的字段值同样带 `sourceSpans`（指向 BlockModel 的 block）+ 置信度（规则抽取通常置信度高，可设 ≥0.95 或直接 1.0 并标注 `extractionMethod:'rule'`）。明细行复用 T7 `extractGroundedFields`（仅对 table HTML block 做受限抽取 + span 接地）。

## 6. 发票 zod schema（§6.2 + discovery 字段）

```ts
// server/src/pipeline/schemas/invoice.ts （新建）
InvoiceSchema = {
  发票号: string,
  开票日: string (YYYY-MM-DD),
  购方: { 名称: string, 纳税人识别号: string },        // discovery: 加纳税人识别号
  销方: { 名称: string, 纳税人识别号: string },
  金额合计: number,
  税额合计: number,
  价税合计: number,                                    // 自校验：= 金额合计 + 税额合计
  开票人: string,                                      // discovery: 加开票人
  明细行: [{
    货物名称: string,
    数量: number,
    单价: number,
    金额: number,
    税率: number,                                      // discovery: 每行税率
  }],
}
```
> KEY_FIELDS（T6）已含 发票号/价税合计 → 关键字段门（≥0.95）适用。1b 视情况把 金额合计/税额合计 也纳入 KEY_FIELDS。

## 7. 结算单（settlement）绑定 —— 范围新增

1a `bind_document` 的 `targetType` 已含 `'contract'|'order'|'settlement'`，但 **settlement 记录尚不存在**（1a 只有合同/订单的内存 seed + bindings 表）。Phase 1b 需补**最小 settlement 绑定能力**：
- 选项 A（推荐）：`bindings` 表已存 `targetType='settlement', targetId=<结算单号>`，1b 仅需让 bind 接受 settlement targetId（字符串标识，如 `SET-2024-001`），**不**建完整 settlement 实体表（推 Phase 1c）。
- 选项 B：新增最小 `settlements` 表（结算单号/关联合同/金额/状态）。
- **本 spec 默认选 A**（最小增量，避免 1b 膨胀）；若 discovery/对账需要结算单实体，再升级到 B。

## 8. 规则引擎设计（`server/src/pipeline/rules/invoiceRules.ts`）

- **label-anchor（表头文本块）**：在 `type==='text'|'kv'` 的 block 里找标签（"发票号"/"开票日"/"开票人"）→ 取相邻 span/值。每个产出值带 `{blockId, start, end}` span。
- **table-HTML regex/cell-parse（table block）**：对 `Block.text`（HTML）做 regex/cell 解析，抽取 购/销方（名称+纳税人识别号）、金额合计、税额合计、价税合计。产出值带指向 table block 的 span（HTML 偏移）。
- **价税合计自校验**：`价税合计 ≈ 金额合计 + 税额合计`（容差 0.01）；不一致 → 该字段标低置信/needsReview（不编造）。
- **置信度**：规则命中且自校验通过 → 高置信（≥0.95 或 1.0）；regex 模糊/自校验失败 → 降置信或交 LLM/HITL。
- **输出**：与 T7 `ExtractedField` 同形（`{name, value, sourceSpans, strength, confidence, needsReview, autoAccepted, citedText}`），`strength` 对规则命中记为 `'exact'`（值即来自原文 block）。

## 9. 明细行 LLM+span-grounding 路径

- 仅对 table block 的 HTML 调 T7 `extractGroundedFields`，schema 限定为 `明细行[]`。
- LLM 必须为每个明细值给 sourceSpans（HTML 偏移）；span 接地校验（T5）+ 置信度（T6）+ 关键字段门照常。
- 明细 HTML 列关联脆弱是已知风险（discovery 标注）；低置信明细行 → needsReview/HITL，不编造。

## 10. 评测（eval）

- 合成发票样例：clean（结构良好）+ trap（价税合计自校验失败 / 明细列粘连）。
- 真实脱敏切片（discovery 已提供 redacted 结构）。
- 复用 1a eval runner 模式；指标：字段抽取准确率 / span 接地率 / 引用准确率 / **价税合计自校验通过率**（强断言）/ HITL 触发精度召回。
- 规则字段断言 `extractionMethod==='rule'`（验证零 LLM 路径）。

## 11. 阶段拆解（Phase 1b 任务草图，写 plan 时细化）

| 任务 | 内容 |
|---|---|
| 1b-T1 | 发票 zod schema（§6 + discovery 字段）+ 测试 |
| 1b-T2 | 发票规则引擎模块（label-anchor + table-HTML regex + 自校验）+ 测试（用 redacted 真实切片 fixture） |
| 1b-T3 | `extract_fields` docType 分支：发票→规则引擎先行 + 明细 LLM；合同路径不变；测试 |
| 1b-T4 | settlement 绑定（选项 A：bind_document 接受 settlement targetId）+ 测试 |
| 1b-T5 | 发票 eval set + runner（价税合计自校验断言）|
| 1b-T6 | harness/registry 接线确认（docType 分支已通过 extract_fields；bind settlement 目标）|

## 12. 成功标准（Done When）

1. 给定一份发票（电子件/扫描件），Agent 能 ingest → 规则引擎抽出合计/身份字段（零 LLM，每个值带 span + 置信度，价税合计自校验通过）→ 明细行走 LLM+span-grounding → 低置信/自校验失败弹 HITL → 绑定到结算单（L2 确认）。
2. 合同录入路径（1a）零回归（28/28 既有测试全绿）。
3. 发票关键字段（发票号/金额合计/税额合计/价税合计）抽取准确率达标（eval）；价税合计自校验通过率为强指标。
4. 全程：所有业务数字可追到原文 span；规则字段标注 `extractionMethod:'rule'`；审计时间线完整（H4 的 withAudit 自动覆盖新工具）。

## 13. 风险

| 风险 | 缓解 |
|---|---|
| 明细 HTML 列关联脆弱（rowspan/粘连） | 明细走 LLM+span-grounding；低置信→HITL，不编造 |
| 规则 regex 对版面差异过拟合 | 用真实脱敏切片做 fixture；regex 容错；失败降级到 LLM/HITL |
| settlement 实体不存在 | 选项 A 最小绑定（targetId 字符串）；完整实体推 1c |
| 1a 回归 | docType 分支隔离；既有 28 测试必须全绿 |

---

## 附录：与 1a 的对齐
- 复用：BlockModel(T1)、MinerU/digital 适配器(T2/H2,T3)、持久化(T4)、span 校验(T5)、置信度(T6)、grounded 抽取(T7)、ingest/extract/bind 工具(T8)、harness(T9)、withAudit(H4)。
- 新增：发票 zod schema、发票规则引擎模块、extract_fields 的 docType 分支、settlement 绑定。
- 数据不出域：本地 MinerU（H2 加固）；无云调用。
