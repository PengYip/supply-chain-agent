# Neo4j 图关系落地设计（确认后写入 · 文档为中心）

- **Status**: Design (awaiting review)
- **Date**: 2026-08-17
- **Augments**: `2026-08-13-post-ingest-review-design.md` — adds the **commit-to-graph**
  layer on top of the review step: 确认后的实体与关系确定性写入 Neo4j，取代现状
  "proposedRelationships 只展示不落地"。
- **Grounding**: 用户需求（文件内实体关系 + 文件间关系 + 自然语言驱动交互）；
  《深入理解 AI Agent》 ch4（执行-验证闭环、幂等与取消、可观测性）。

---

## 1. 问题与目标

当前状态（已勘察确认）：

- 抽取层产出三类实体提议（Party 甲方/乙方/买方/卖方、Commodity 标的物/商品、
  Contract 合同号），只持久化到 `extractions.proposed_relationships` 并在复核卡展示；
  **无任何边提议、无任何 Neo4j 写入路径**。
- Neo4j 图层（`graph/repo.ts` + `graph/tools.ts`）已存在：`create_entity`（MERGE
  kind+name 去重）、`link_entities`（有向边）、`graph_query`（elementId 起步的有界遍历），
  全部注册为 L2、仅 Agent 手动调用；`graph_query` 无"按名称找实体"入口。
- 文件间关系：`bind_document` 只写 `doc_bindings` 表 + 内存图（seed.ts），不写 Neo4j。

**目标**：

1. 文件内实体与边（合同→甲方/乙方/商品）确认后写入图库；
2. 文件间关系（发票是合同执行的结果；合同间背靠背）在图库中明确表达；
3. 用户以自然语言驱动 Agent 对实体关系进行查询与维护。

**锁定决策**（brainstorming 已确认）：

| 决策 | 选择 | 理由 |
|---|---|---|
| 写入时机 | **确认后写入**（复核卡确认 → 后端原子写图） | 与"给人确认之后完成"语义一致，图上数据可信 |
| 图模型 | **文档为中心**（Document 节点 + 实体节点挂出） | 可追溯、与录入流程天然对齐 |
| 文件间关系 | **自动提议 + 手动补充** | 合同号共享自动提议；Agent 手动补任意关系 |
| NL 交互 | **问答 + 关系维护**（不加前端图可视化） | 对话内完成查询与维护 |
| 落地方式 | **后端确定性写图**（非 Agent 逐个调工具） | 幂等、可重试、确定性强 |
| 名称归一化 | **基础归一化**（trim/去常见后缀/空白归一） | 提高同名收敛率，无风险 |

---

## 2. 图模型（Neo4j）

### 2.1 节点

Neo4j label/relType 受 `assertToken`（`/^[A-Za-z_][A-Za-z0-9_]*$/`）约束，
**中文不能作 label** —— label 用英文，中文进 props。

| Label | 唯一性 | 核心 props |
|---|---|---|
| `Document` | 每文件一个（按 `docId` 幂等） | `docId, docType(中文), filename, ingestedAt, reviewStatus` |
| `Party` | MERGE `(Party {name})` | `name`（归一化后） |
| `Commodity` | MERGE `(Commodity {name})` | `name`（归一化后） |
| `Contract` | MERGE `(Contract {name})` | `name` = 合同号（归一化后） |

**Contract 节点是所有相关单据的聚合枢纽**：发票/提单先录入时挂到 Contract 实体；
合同文档后录入并入同一实体——无需重写已有边，回答"这份合同产生了哪些单据"只需
一次遍历。

### 2.2 边（受控词表）

每条边 props：`confidence, sourceSpan?, createdAt, source: 'auto'|'manual'`。

| 类别 | 边 | 含义 |
|---|---|---|
| 文件内 | `(Document)-[:party {role}]->(Party)` | role ∈ 买方/卖方/发货人/收货人/承运人 |
| 文件内 | `(Document)-[:commodity]->(Commodity)` | 标的物/商品 |
| 文件内 | `(Document)-[:references]->(Contract)` | 单据引用该合同（合同文档及带合同号的单证） |
| 文件间 | `(Document)-[:executes]->(Contract)` | docType∈{发票,提单,装箱单} 且带合同号 → "该单据是合同执行的结果" |
| 文件间 | `(Document)-[:back_to_back {role}]->(Document)` | 合同间背靠背，role ∈ purchase/sales；**手动补充**（Agent L2） |

Document→Document 直接边（`back_to_back` 等）走手动/业务特例路径，方向按业务语义
（采购→销售），查询用 `direction:'both'` 双向命中。

### 2.3 复杂关系覆盖说明（用户验证）

- **多合同共享供货商**：同名 Party 收敛为一个节点，多个合同文档的 `party` 边汇聚其上；
  查询"XX 供应商有哪些合同"= `graph_find_entity(Party)` → in 遍历 `party` 边。
- **合同间背靠背**：`(采购合同)-[:back_to_back {role:'purchase'}]->(销售合同)`，
  Agent L2 建边；`direction:'both'` 支持双向问答。

---

## 3. 抽取与提议（自动，不动解析）

### 3.1 扩展实体角色

`pipeline/extraction.ts` `REL_ROLE_BY_FIELD` 增加：

```
发货人: '发货人', 收货人: '收货人', 承运人: '承运人'
```

（提单/装箱单场景；现有 甲方→买方/乙方→卖方/买方/卖方 保留。）

### 3.2 边提议（确定性派生，不依赖 LLM 额外输出）

在 `deriveProposedRelationships` 基础上，按持久化字段**确定性派生边**：

| 规则 | 产出边 |
|---|---|
| 实体提议存在 | `party`/`commodity`（Document→实体） |
| 抽取到合同号字段 | `references`（Document→Contract） |
| docType∈{发票,提单,装箱单} 且有合同号 | `executes`（Document→Contract） |

派生函数为纯函数（`deriveProposedEdges(fields, docType)`），可单测。

### 3.3 复核卡展示

现有 `proposedRelationships` 维度升级为"待确认实体与关系"两维：

- 实体行：`kind / name / role? / confidence`
- 关系行：`type(party|commodity|references|executes) / src(Document) / dst / confidence`

前端 `DocumentReviewCard.tsx` 的"待确认关系"区块扩展渲染；确认按钮复用现有
`submitReview(docId, {confirm:true})`。

---

## 4. 确认后写入（后端原子，幂等）

`routes/review.ts` `POST /:docId/review` 的 `confirm:true` 分支扩展：

1. 读最新 extraction（fields + proposedRelationships + docType）；
2. `deriveProposedEdges` 派生边集；
3. 调新增 `graph/graphWriter.ts` 写 Neo4j：
   - MERGE Document 节点（docId）
   - MERGE Party/Commodity/Contract 实体（**名称先归一化**，见 §5）
   - CREATE 边（同 `(src,type,dst)` 去重，幂等可重试）
   - 单条失败只记失败项，不整体失败（fault-isolated，与既有风格一致）
4. 持久化 `documents.graph_status`（`ok|failed|partial` + nodeCount/edgeCount/writtenAt
   + 失败项列表）→ 复核卡新增"图入库状态"维度；
5. **图不可达不阻塞确认**：NEO4J_PASSWORD 未配/服务挂 → reviewStatus 照常
   `confirmed`，graph_status=`failed` 并在卡片提示（与 index.ts boot 仅警告的设计一致）。

写入必须是**可重复执行**的：重复确认同一文档不产生重复节点/边。

---

## 5. 名称归一化

新增 `graph/normalize.ts` 纯函数 `normalizeName(name)`：

- trim + 内部连续空白归一（含全角空格）
- 去除常见后缀：`有限公司`、`股份有限公司`、`有限责任公司`、`集团`、`集团有限公司` 等
  （匹配时先归一内部空白再剥离；注意与 Contract 合同号场景互斥——合同号不含这些后缀）

写入实体前统一经 `normalizeName`；`proposed_relationships` 持久化保留原文，
图上用归一化后名称。若归一化后为空 → 跳过该实体（记失败项）。

---

## 6. Agent 自然语言交互

### 6.1 新工具 `graph_find_entity`（L1 只读）

补上"按名称找实体"入口（现状 `graph_query` 只能 elementId 起步）：

```
inputSchema: { kind?: 'Party'|'Commodity'|'Contract'|'Document', name: string, exact?: boolean }
```

按 kind+name 查，默认 name 包含匹配（contains），`exact:true` 时精确匹配；
返回匹配的 `elementId/kind/name` 列表（上限 10）。注册为 L1 只读（查询类，无副作用）。

### 6.2 工具组合

| 用户意图 | Agent 调用链 |
|---|---|
| "这份合同关联了哪些单据/实体？" | `graph_find_entity(Contract, 合同号)` → `graph_query(subject)` |
| "XX 供应商有哪些合同？" | `graph_find_entity(Party, "XX")` → `graph_query(subject, direction:'in')` |
| "把这张发票挂到 XX 合同下" | `link_entities(src, dst, 'executes')`（L2 确认） |
| "这份采购合同和那份销售合同背靠背" | `link_entities(src, dst, 'back_to_back', {role})`（L2 确认） |

### 6.3 系统提示词

`harness/agent.ts` SYSTEM_PROMPT 增加"图关系交互"指引段：

- 查询类问题优先 `graph_find_entity` + `graph_query`；
- 维护类关系创建/修正优先复用边词表（party/commodity/references/executes/
  back_to_back），用户未指定类型时给出建议并说明语义；
- 图不可达时如实告知，不编造图数据。

---

## 7. 验证计划

- **单测**：
  - `deriveProposedEdges` 各规则（references/executes 触发与不触发）
  - `normalizeName`（trim/全角空格/后缀剥离/合同号不受影响）
  - `graphWriter` 幂等（重复确认不产生重复边/节点）、单条失败容错
  - `review.ts` confirm 写图成功 / 图不可达不阻塞 / 失败项记录
  - `graph_find_entity` 精确与模糊查询
- **集成**（设 NEO4J_PASSWORD + 可达实例时）：录入合同+发票 → 确认 →
  图上出现 Document/Party/Commodity/Contract 节点与 party/commodity/references/
  executes 边；`graph_query` 能返回"合同→发票"关系。
- **E2E**：对话"XX 合同关联了哪些单据"→ Agent 定位 Contract 并返回结果。

---

## 8. 范围外（YAGNI）

- 前端图可视化浏览页（用户明确不做）
- 跨文档关系的自动推导 pass（背靠背/共享供应商的自动识别留待后续；v1 靠 Agent L2 手动补充）
- 历史数据回填 Neo4j（后续可加 backfill 脚本）
- 别名表 / embedding 实体解析（名称归一化已覆盖基础场景）

---

## 9. 涉及文件（实现时的改动面）

| 文件 | 改动 |
|---|---|
| `apps/server/src/pipeline/extraction.ts` | REL_ROLE_BY_FIELD 扩展 + `deriveProposedEdges` |
| `apps/server/src/graph/normalize.ts` | 新增：`normalizeName` |
| `apps/server/src/graph/graphWriter.ts` | 新增：确定性写图（Document/实体/边，幂等容错） |
| `apps/server/src/graph/tools.ts` | 新增 `buildGraphFindEntityTool` |
| `apps/server/src/harness/roleToolRegistry.ts` | 注册 graph_find_entity（L1） |
| `apps/server/src/routes/review.ts` | confirm 分支写图 + graph_status 持久化 |
| `apps/server/src/pipeline/db/repositories.ts` | `DocumentVectorization` 旁新增 graph_status 存取 |
| `apps/server/src/harness/agent.ts` | SYSTEM_PROMPT 图交互指引段 |
| `apps/web/src/components/DocumentReviewCard.tsx` | 实体/关系两维展示 + 图入库状态维度 |
| 测试 | `test/graph/`、`test/pipeline/`、`test/routes/` 新增用例 |
