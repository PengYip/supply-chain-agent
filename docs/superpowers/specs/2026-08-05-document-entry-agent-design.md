# 原始单据录入 Agent — 设计文档（Spec）

> 状态：待评审 | 作者：产品+工程 | 日期：2026-08-05
> 借鉴：知乎《LLM Wiki / Graphify / 企业合同知识库》一文对文档处理的工程化思路。
> 约束对齐：`ARCHITECTURE.md` 五大原则（数据不出域 / 可控优先 / 工具优先·数字零幻觉 / 渐进自主 / 可解释可追溯）。

---

## 1. 背景与目标

产品团队决定第一阶段聚焦「原始单据录入 Agent」形成 MVP。目标：把业务原件（合同 / 物流单据 / 收付款单据 / 发票）通过 Agent 录入成结构化业务数据，并与既有业务实体（合同/订单/结算）绑定，支撑后续「单据处理 / 状态追踪 / 轻量对账」场景。

**借鉴文章的核心结论（落地指导）**：

1. 企业级单据处理**不能只靠模型自由生成**，必须有**受控 schema 兜底**。
2. 真正难的不是单篇文档，而是**文档之间的关系**（对应本项目的"四流合一"）。
3. 生产级方案五要素：**受控 schema + 结构化字段 + 原文引用 + 置信度可复核 + 可复跑评测**。
4. 关系层只解决跨文档问题，且**每条关系必须带来源**，禁止模型自由发明。

这四点与本项目既有铁律「工具优先 / 数字零幻觉」**完全一致**，本设计是其在录入场景的工程化落地。

## 2. 范围

### 2.1 MVP 范围（IN）

- **单据类型**：合同（业务起点，1a 锚点）+ 发票（1b，验证主干可复制性）
- **输入形态**：电子件（PDF/Word，文本可直抽）+ 扫描件/影像（需 OCR）**双模态**
- **能力闭环**：原件 → 解析/OCR → 受控 schema 抽取（置信度+原文引用）→ HITL 核验 → 业务绑定 → 审计落库
- **关系层（1c 最小）**：合同 ↔ 物流单据 ↔ 发票 ↔ 收付款 的最小四流关系集 + 一致性校验 demo

### 2.2 不做（OUT，推 V2）

- 物流 / 收付款 单据的完整 schema 抽取（1b 只做发票；另两类留接口，1c 只做关系挂接）
- 全量四流合一对账（1c 只做最小 demo）
- RAG 知识库检索（属 `ARCHITECTURE.md §7` 第 4 层，独立于录入，另立专项）
- 多租户 / RBAC 配置后台（沿用现有 trader 单角色）
- 偏好/记忆层（已否决 mem0，见 `ARCHITECTURE.md §11.4`）

### 2.3 三段式分解

| 阶段 | 范围 | 风险定位 |
|---|---|---|
| **1a 主干 + 合同锚点** | 建一条可复用流水线，只跑通合同 | **最高**（OCR / schema / 接地 / 置信度全在此定型） |
| **1b 横向复制** | 在同一主干上加发票 schema + 抽取器 | 低（主干已定型） |
| **1c 关系层最小集** | 四流关系枚举 + 一致性校验 demo | 中 |

> 关键判断：**1a 是全部可行性风险所在**。1a 跑通后，1b/1c 是工程量问题。

## 3. 选型决策

### 3.1 抽取核心路线：路线 2 混合接地流水线（已确认）

确定性层（OCR/解析）产出 ground truth → LLM 受约束抽取且**强制 span 引用** → 置信度 → HITL。

否决「路线 1 纯 Agent 工具调用」理由：数字来自 LLM，**结构上违反"数字零幻觉"铁律**，无原文坐标引用，正是文章警告的"只靠模型自由发挥"。

### 3.2 待用户确认的细化决策（spec 评审时定）

| 项 | 建议默认 | 理由 |
|---|---|---|
| OCR 引擎 | **MinerU**（本地 CPU，PDF 版面/表格还原能力强，团队熟悉；环境已有 `mineru-pdf` skill） | 数据不出域 → 排除一切云 OCR；1a 做 MinerU 接入 + 准确率验证 spike |
| 持久化起步 | **SQLite（WAL）+ Drizzle ORM** 定义 schema | 与现有 `SessionStore`（better-sqlite3 WAL）一致；Drizzle 保证后续平滑迁 Postgres（`§11.5` 已有 SQLite 实践） |
| schema 字段 | 以本文 §6 为起点 | 1a 须用真实/合成样例校准字段集 |
| 1a 范围 | 保持，不进一步砍 | OCR spike 标为关键路径风险，spike 失败则回退简化 |

## 4. 总体架构：5 段流水线（全部长在现有 harness 上）

```
原件 ──► ①ingest_document(L1) ──► BlockModel(归一化文档块 = ground truth)
            （电子件文本抽取 / 扫描件私有 OCR）
   │
   └─► ②extract_fields(L1) ──► 受控 schema 字段[]，每值带 sourceSpans + confidence
            （LLM 受约束抽取 + span 接地校验器：无引用→拒绝→escalate）
   │
   ├─► ③verify_document_fields(T4·复用) ──► 低置信字段 HITL 核验卡
   ├─► escalate_to_human(T3·复用) ──► 无解/冲突 → 工单 ESC-xxx
   │
   └─► ④bind_document(L2) ──► 绑定到 合同/订单/结算（写，需确认）
            全程 ⑤AuditRecorder 落库 + trace_id
```

**复用既有代码**（零改动或扩展）：

- `server/src/harness/agent.ts` `runStream` / `buildGatedTools` — 新工具直接挂入 `roleToolRegistry.trader`
- `server/src/harness/permissionGate.ts` — L1/L2/L3 分级（ingest/extract=L1，bind=L2）
- `server/src/harness/auditRecorder.ts` — 全量工具调用落库
- `server/src/harness/sessionStore.ts` — SQLite WAL + 硬门暂停/恢复
- `server/src/tools/hitl.ts` — T3 `escalate_to_human` / T4 `verify_document_fields` **零改动复用**
- `server/src/tools/writes.ts` — `link_document` 模式扩展为 `bind_document`

**不是另起一套系统**，是对现有 harness 的工具层扩展。

## 5. BlockModel —— 确定性层产出的 ground truth

OCR/解析的归一化产物，是 LLM 必须引用的唯一事实来源（满足零幻觉）。

```ts
interface BlockModel {
  docId: string;
  docType: 'contract' | 'invoice' | 'logistics' | 'payment';
  modality: 'digital' | 'scanned';
  blocks: Block[];
}

interface Block {
  id: string;                              // 供 span 引用
  type: 'text' | 'kv' | 'table_row' | 'figure';
  text: string;                            // 块文本（table_row = 序列化单元格）
  page: number;
  bbox: [number, number, number, number];  // [x, y, w, h]；电子件可仅 page
  ocrConfidence: number;                   // 扫描件=OCR置信度；电子件=1.0
  children?: Block[];                      // 表格层级
}
```

- **电子件**：`pdf.js` / `pdf-parse`（PDF）+ `docx` 解析 → blocks（带 page，ocrConfidence=1.0）
- **扫描件/影像**：私有 OCR（**MinerU**，本地）→ blocks（带 bbox + 逐块置信度）+ 表格还原
- **原件存储**：本地 FS（MVP）；生产目标 MinIO/S3 兼容（`§7` 第 1 层 对象存储）

## 6. 受控 schema（每类单据一个 zod，禁止自由生成）

每个抽取出的字段值**必须**带 `sourceSpans: blockId[]`，无 span 即视为不可接地（触发 T3）。

### 6.1 合同 schema（1a 锚点，字段为起点，须样例校准）

合同号 / 甲乙方 / 标的 / 金额 / 币种 / 签订日 / 生效日 / 付款节点[] / 质保期 / 违约金条款 / 收付款条款

### 6.2 发票 schema（1b）

发票号 / 开票日 / 购方 / 销方 / 金额合计 / 税额 / 价税合计 / 明细行[{货物, 数量, 单价, 金额, 税率}]

> 发票为国家统一格式 → 1b 可对关键字段（发票号/金额合计/税额）走 **OCR 模板/规则直抽**，非结构化字段走 LLM。这是"路线 2 主干 + 规则混用"的自然落点，不破坏 span 接地（规则直抽同样标注 blockId 来源）。

## 7. 工具清单与签名（extend `server/src/tools/`）

所有工具沿用 AI SDK 6 `tool({ inputSchema, execute })` 模式，`execute` 内调 `auditRecorder.recordToolCall`。

| 工具 | 级别 | 入参 | 出参 | 说明 |
|---|---|---|---|---|
| `ingest_document` | L1 | `{fileRef, docType, modality?}` | `{docId, blockModel, modality, stats}` | 派发解析/OCR，存原件 + BlockModel |
| `extract_fields` | L1 | `{docId, docType}` | `{fields:[{name,value,sourceSpans,confidence}], status}` | LLM 受约束抽取 + **span 接地校验器** |
| `bind_document` | L2 | `{docId, targetType, targetId}` | `{bindingId, ...}` | 扩展 `link_document`，写需确认 |
| `verify_document_fields` | T4·复用 | 现有签名 | per-field confidence+needsReview | 零改动 |
| `escalate_to_human` | T3·复用 | 现有签名 | ESC-xxx 工单 | 零改动 |

`roleToolRegistry.trader` 增加 `ingest_document` / `extract_fields` / `bind_document` 三个。

## 8. span 接地校验器 —— 零幻觉的硬执行点

`extract_fields` 的 `execute` 内，对每个 LLM 产出的字段值做接地校验：

1. 值必须携带 `sourceSpans`（blockId[]）。
2. 值必须能在 cited block 的 `text` 里定位：精确匹配 = 1.0 / 模糊匹配（编辑距离/包含）= 0.5–0.9 / 无匹配 = 0。
3. 无 span 或零匹配 → 该字段标 `ungrounded` → 触发 T3 `escalate_to_human`。

这把"禁止编造"从 system prompt 的**软约束**变成**工具内硬校验**（与现有"工具未返回→如实说不可得"一脉相承）。

## 9. 置信度模型 + HITL 阈值

```
fieldConfidence = w1·blockOcrConfidence + w2·spanMatchStrength + w3·llmConsistency
```

- `spanMatchStrength`：值在 cited block 文本里的匹配度（见 §8）
- `llmConsistency`：可选，多次采样一致性（MVP 可先置 1.0，1a 后期再加）
- 阈值**复用 `hitl.ts` 常量** 0.9 / 0.7：
  - ≥ 0.9 autoAccept
  - 0.7–0.9 needsReview（弹 T4 卡）
  - < 0.7 escalate 或强制复核
- **关键字段加严**：金额 / 发票号 / 合同号 等设更高阈值（如 ≥ 0.95 才 autoAccept）

## 10. 持久化（Drizzle + SQLite→Postgres）

现有 `seed.ts` 为内存版。录入 Agent 需真实审计轨迹，新增三表（起步 SQLite，与 SessionStore 一致；Drizzle schema 保证平滑迁 Postgres）：

| 表 | 关键字段 |
|---|---|
| `documents` | docId, docType, modality, storageRef, blockModel(JSON), ingestedAt |
| `extractions` | docId, docType, fields(JSON: spans+confidence), status, version, extractedAt |
| `bindings` | sourceDocId, targetType, targetId, relationshipType, confidence, sourceRefs(JSON), createdAt |

复用现有 `sessions` / audit 表。文件位置：`server/src/db/`（Drizzle schema + 迁移）。

## 11. 四流合一关系层（1c · 最小）

受控关系枚举（**禁止 LLM 自由发明**，文章最强警告）：

```
contract        ↔ logistics_doc(提单) : logistics_for_contract
logistics_doc   ↔ invoice            : invoice_for_shipment
invoice         ↔ payment           : payment_against_invoice
（+ 金额/数量一致性 cross_check，复用现有 cross_check 模式）
```

每条关系 = 一个 L2 写（`bind_document` / `create_relationship`），**带 sourceRefs（哪些字段/块支撑此关系）+ confidence**。MVP 做最小集即可 demo"四单匹配对账"价值。

## 12. 评测 / 审计层（文章最强调、本项目目前缺）

每类单据一套**合成样例集**（仿文章 30 份合同，脱敏）+ 字段级 ground truth + 故意埋的"低置信/错误"陷阱。可复跑脚本：

| 指标 | 说明 |
|---|---|
| 字段抽取准确率 | 按 schema 字段逐项对 ground truth |
| span 接地率 | 有合法引用的字段占比（零幻觉直证） |
| 引用准确率 | cited block 是否真支撑该值 |
| HITL 触发精度/召回 | T4/T3 该不该弹 |
| 成本/时延 | ingest / extract 各自 token 与耗时 |

样例集位置：`samples/`（合同 + 发票各一套）。

## 13. 阶段拆解与工作量（1人估算，含 spike）

| 阶段 | 任务 | 估时 | 风险 |
|---|---|---|---|
| **1a** | MinerU 接入 spike + BlockModel + ingest_document + extract_fields(合同) + span 校验器 + 置信度 + 接 T4/T3 + bind_document + 三表持久化 + 合同评测集 | 15–22 人日 | 高（关键路径=MinerU 接入与准确率） |
| **1b** | 发票 schema + 发票抽取器（规则+LLM 混用）+ 发票评测集 → 验证主干可复制性 | 5–8 人日 | 低 |
| **1c** | 关系枚举 + create_relationship(L2) + 最小 cross_check + 四流合一 demo | 5–8 人日 | 中 |
| **合计** | | **25–38 人日**（1人）/ 2 人并行约 4–6 周 | |

主导风险变量：MinerU 在扫描合同/发票上的版面与表格识别准确率。spike 失败则 1a 回退（如限定电子件优先、扫描件降级为人工辅助）。

## 14. 风险登记

| 风险 | 影响 | 缓解 |
|---|---|---|
| OCR 版面/表格识别不足 | 1a 阻塞 | MinerU 接入 spike 先行验证；最坏回退电子件优先、扫描件降级为人工辅助 |
| LLM 受约束抽取仍漂移 | 零幻觉破防 | span 接地硬校验 + 关键字段高阈值 + T3 兜底 |
| 合同 schema 字段过度复杂 | 1a 膨胀 | 字段集砍到最小可录；复杂条款留 V2 |
| 持久化迁移成本 | 后期返工 | Drizzle ORM 起 schema，迁 Postgres 仅改 driver |

## 15. 成功标准（Done When）

1. **1a**：给定一份合同（电子件 + 扫描件各一），Agent 能 ingest → 抽取合同 schema 字段（每个值带合法 span + 置信度）→ 低置信字段弹 T4 → 绑定到合同实体（L2 确认）；零幻觉（无 span 字段必走 T3）；全链路审计可追。
2. **1b**：同一主干接入发票，发票关键字段（发票号/金额/税额）抽取准确率达标（评测集）；证明主干可复制。
3. **1c**：四流最小关系集能挂接并做一次金额/数量一致性 cross_check demo。
4. **全程**：所有业务数字可追到原文 span（bbox+page），审计时间线完整。

---

## 附录：与 `ARCHITECTURE.md` 的对齐

- §7 文档底座 4 层：本设计 = 第 1 层（原件 OCR）+ 第 2 层（结构化抽取）+ 第 3 层（业务绑定）；第 4 层（RAG 检索）独立专项，不在本 MVP。
- §5 权限模型：ingest/extract=L1 自动；bind=L2 软门确认；关系挂接=L2；资金类（payment）保持 L3 不变。
- §6 HITL：复用 T3（不确定回退）+ T4（单据核验），已有 mock。
- §9 私有化合规：OCR 本地化、数据不出域、审计字段全保留。
