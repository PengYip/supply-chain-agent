# 业务图谱模板：类型本体层与模板驱动绑定设计（方案 B：模板即数据）

- **Status**: Design approved (2026-08-26, awaiting spec review)
- **Date**: 2026-08-26
- **Augments**: `2026-08-17-graph-relations-design.md`（文档中心图模型）、
  `2026-08-25-graph-erp-mapping-design.md`（ERP 业务原语映射，Phase 1-3 已实施）
- **Grounding**: 用户需求（单据类型本体层级 + 模板驱动绑定路径）；
  explorer 代码勘察（docType 判定/绑定工作台/派生边现状）；
  librarian 业界调研（Neo4j 建模指南、Palantir Foundry Ontology、文档 AI 模板、
  SAP VBFA、UN/CEFACT，出处见文末）。

---

## 1. 问题与目标

**现状（勘察确认）**：

- 图模型已稳定：Document/Party/Contract/Commodity/Project/Quota 六种节点 +
  12 种边；文档直接连业务实体（binds/settles/executes/party/commodity/references）。
- "每类单据应该连什么边"的规则**散落硬编码在 4 处**：
  `deriveProposedEdges`（extraction.ts:152-196）、`FLOW_TYPE_BY_DOC_TYPE`、
  `SETTLES_RELATION_BY_FLOW`（tradeSemantics.ts / executionFlow.ts:61-65）、
  `bindingRelationByVoucherType`（tradeSemantics.ts:50-85）。无任何声明式模板。
- 绑定操作"没有确定的路径"：工作台候选全库扫描、锚点权重全局一套
  （bindingProposal.ts:368-444），起点终点与允许边型对用户不可见。

**用户原始设想**（讨论记录）：

1. 单据类型与文档文件都作为节点；
2. 合同类型放合同实体节点属性上；
3. 实体连类型节点，文档不与文档直连；并希望"几十上百张运输单据连到
   '运输单据'类型节点、类型节点再连合同"以中转。

**业界证据裁决**（librarian 调研）：Neo4j 官方建模指南将"全部实例连到一个
类型节点"列为**超级节点反模式**（读写双损）；SAP VBFA / UN/CEFACT /
Palantir 一致采用"文档直接连业务实体、类型为属性或独立元数据层"。
用户设想中"类型连类型、模板定路径"的正确落点是**独立的模板层**
（Palantir Ontology 模式：类型层与实例数据分离，类型层驱动写入校验与操作）。

**目标**：

1. 建立可演化的**类型本体层级**（单据类型/合同类型，含继承）；
2. 模板**声明式定义边规则**（起点类型 x 终点类型 x 允许边型与词表 x 锚点权重），
   绑定工作台由此获得确定的起点/终点/边型；
3. 写入必经模板校验（人机共用同一通道，Agent 无法绕过）；
4. 新增单据类型零代码接入（抽取配置随类型走）。

**锁定决策**：

| 决策 | 选择 | 理由 |
|---|---|---|
| 实例层是否经类型节点中转 | **否**，保持 Document 直连业务实体 | 超级节点反模式；settles 六向语义/跨合同聚合必须挂在实例边上 |
| 类型本体放哪 | **关系库 SSOT**（模板即数据，方案 B） | 运行时可演化；对齐仓库 SSOT->投影铁律 |
| 模板校验方式 | 自研 templateGuard（非 SHACL） | SHACL+neosemantics 引入 RDF 全家桶，当前过度工程；留作远期替换 |
| 行为基线 | 种子翻译阶段**行为零变化** | 现有 4 处硬编码机械搬入种子行，测试全绿为门禁 |
| 模板变更影响范围 | 只影响后续写入，不回溯 | 与"派生边不追删"铁律一致；边上带 templateVersion 追溯 |

---

## 2. 架构：双层结构

```
模板层（关系库 SSOT，运行时可编辑）             实例层（现有 Neo4j 图，直连不变）
┌──────────────────────────────────┐
│ template_types    类型层级本体      │          (D:运输单据)-[:settles{收货}]->(C:物流合同)
│ template_edge_rules 边规则          │                       ↑ 写入前经 templateGuard
│ template_versions  变更审计         │
└──────────────────────────────────┘
   ↓ 消费方：绑定工作台 / 抽取路由 / 写入校验 / Agent 工具
```

- 模板层是唯一权威；Neo4j 只存实例边（可选 Phase 4 投影 `T_` 前缀类型节点
  供联合查询，默认不做）。
- 图写入永不阻塞业务主流程的铁律不变；模板校验失败对**用户主动操作**
  （绑定确认）即时拒绝并返回可读原因，对**后台派生**（graphSync）记
  graph_status 失败项可重试。

## 3. 模板层数据模型（三张表）

SQLite 默认（raw idempotent DDL）+ Postgres（drizzle-kit 迁移），双轨与现有
pipeline 表一致。

### 3.1 `template_types` — 类型注册表（本体层级）

| 列 | 说明 |
|---|---|
| `id` | 主键 |
| `kind` | `doc_type` \| `contract_type` |
| `name` | 类型名（中文，如 运输单据/采购合同）；kind 内唯一 |
| `parent_id` | 自引用，形成层级（如 发票 ⊂ 履约凭证、采购合同 ⊂ 买卖合同） |
| `props` | JSON：抽取配置（字段 schema、校验规则、prompt 模板、置信度阈值） |
| `is_active` | 软禁用开关 |
| `created_at / updated_at` | 时间戳 |

种子：classifier 八类 DOC_TYPES（classifier.ts:28）+ Contract 六类
contractType（采购/销售/物流/租赁/服务/其他）全部收编，附最小层级
（履约凭证 ⊃ {发票, 物流单据...}，买卖合同 ⊃ {采购合同, 销售合同}）。

**继承语义**：边规则匹配沿 parent 链向上泛化——子类型无自身规则时继承
祖先规则；自身有则覆盖（**最具体优先**）。

### 3.2 `template_edge_rules` — 边规则（路径确定性的核心）

| 列 | 说明 |
|---|---|
| `id` | 主键 |
| `source_type_id` | 起点（通常是 doc_type） |
| `target_type_id` | 终点（通常是 contract_type，可扩展其他 kind） |
| `edge_type` | binds \| settles \| party \| commodity \| references \| executes |
| `allowed_vocab` | JSON 数组：该组合允许的词表（如 settles 六向中的 {收货,发货}） |
| `anchor_weights` | JSON：锚点权重覆盖（合同号/对手方/日期/金额/数量） |
| `is_active` | 开关 |
| `version` | 所属模板版本 |

种子示例：`(运输单据)->(物流合同) settles {收货,发货}`；
`(收款凭证)->(买卖合同) settles {收款}`；
`(发票)->(买卖合同) settles {收票,开票}`。
翻译自 `bindingRelationByVoucherType` + `SETTLES_RELATION_BY_FLOW` +
`FLOW_TYPE_BY_DOC_TYPE` + `deriveProposedEdges`，语义不变。

**兜底规则**：种子含一条 `(*)->(任意合同类型)` 的兜底规则（对应现状
"其他->凭证"的默认行为），保证 Phase 1 工作台按规则过滤后候选集不缩，
"行为零变化"门禁可达成。

**Phase 1 校验范围**：templateGuard 只拦 **binds/settles**（有合同锚点的边）。
party/commodity/references/executes 的派生规则随种子**登记**进表但**不启用**
校验（这些边无合同终点、现状派生逻辑照旧），Phase 2 起再评估启用。

### 3.3 `template_versions` — 变更审计（轻量）

`version / changed_by / change_summary / changed_at`。实例边上写
`templateVersion`，追溯"当时按哪版模板写入"。

## 4. 消费方接线

### 4.1 绑定工作台（routes/bindings.ts + 前端）

- **起点确定**：docType（classifier 判定，复核卡可修正）-> 查类型及祖先链，
  工作台显示"运输单据（⊂ 履约凭证）"。
- **终点收敛**：候选合同按激活边规则过滤为允许的合同类型实例，不再全库扫描。
- **边型/词表收敛**：binds.relation / settles.relation 下拉只列 allowed_vocab。
- **锚点权重参数化**：bindingProposal.ts 硬编码 WEIGHTS
  （0.5/0.25/0.15/0.1）改为读规则的 anchor_weights，缺省回退全局默认。
- **门禁**：保留现有"非合同文件绑定前目标合同须已挂合同文件"
  （bindings.ts:293-302）；新增模板校验——无激活规则匹配的组合拒绝绑定确认，
  返回可读原因。

### 4.2 抽取路由（classifier -> extraction，Instabase 模式）

classifier 定型后，从 template_types.props 取该类型字段 schema + prompt 模板 +
校验规则组装抽取提示词；分类提示词的八类词汇表也由表生成。新增单据类型配好
props 即获得专属抽取，不改代码。

### 4.3 写入校验（templateGuard）

新增 `pipeline/templateGuard.ts`：

```
validateEdge(docType, contractType, edgeType, relation?)
  -> { ok: true, ruleId, version }
  -> { ok: false, reason }   // 无规则 / 词表外 / 类型软禁用
```

- Phase 1 调用点：`bindingGraphSync.ts`（binds/settles 同步）、
  `executionFlow.ts`（派生 settles）。`graphCommit.ts` 写入的
  party/commodity/references/executes 边待 Phase 2 规则启用后接入。
- 用户主动操作（绑定确认）：校验失败即时拒绝；后台派生：记失败项可重试
  （fault-isolated，与既有风格一致）。

### 4.4 Agent 工具

| 工具 | 权限 | 说明 |
|---|---|---|
| `template_overview` | L1（新增） | 查询模板层：类型层级、某单据类型允许挂接的合同类型与词表——本体成为 Agent 可用知识 |
| `bind_document` | L2（已有） | 提交即过 templateGuard，Agent 无法绕过 |
| `manage_template` | L2（新增，Phase 3） | 新增/调整类型与规则，走 needsApproval 审批流 |

## 5. 模板维护与 HITL

- REST `/api/templates`：类型层级 CRUD、边规则 CRUD、版本列表（管理 UI
  Phase 3 再做，先只有 API + Agent 工具）。
- 变更不回溯：已写边保持写入时版本；不追删（铁律一致）。
- 删除保护：类型被激活规则或文档实例引用时只能软禁用（is_active=false）。
- 权限：模板变更全部 L2（人对 AI 共用同一通道与校验，对齐 Palantir action type）。

## 6. 验证计划

- **单测**：
  - 种子模板加载完整性（4 处硬编码语义全覆盖）；
  - 类型继承匹配（子覆盖/父继承/最具体优先/环检测）；
  - templateGuard 各分支（无规则/词表外/软禁用/通过带 ruleId+version）；
  - bindingProposal 权重改读规则后的回归（默认权重等价性）。
- **集成**（NEO4J_PASSWORD + 可达实例时）：上传运输单据 -> 工作台只列允许
  合同类型 -> 确认 -> 图上 settles 边带正确 relation 与 templateVersion；
  非法组合（收款凭证 -> 物流合同）被拒绝且原因可读。
- **门禁**：Phase 1 结束时现有测试全绿（行为零变化）。

## 7. 分期落地

| Phase | 内容 | 价值点 |
|---|---|---|
| 1 | 三张表 + 种子翻译 + templateGuard + 工作台终点/词表收敛 | 路径确定、非法绑定被挡 |
| 2 | 抽取路由（props 驱动提示词）+ template_overview L1 | 新类型零代码接入抽取 |
| 3 | 模板管理 API 完整化 + manage_template L2 + 版本审计 + 管理 UI | 运行时本体演化 |
| 4（可选） | 类型层投影 Neo4j T_ 节点 | 图内联合查询，有需求再做 |

## 8. 范围外（YAGNI）

- SHACL/neosemantics 校验（远期可替换 templateGuard 的校验内核）；
- 实例层类型中转节点 / Document-Document 直连边（业界反模式 + 现模型已覆盖）；
- 已写边的批量回填或按新模板重校验；
- 模板层的分支/草稿/审批工作流（单一 active 版本 + L2 审批已满足当前规模）；
- embedding 语义匹配绑定候选（锚点+权重已够，留待有实测需求时评估）。

## 9. 涉及文件（实现时的改动面）

| 文件 | 改动 |
|---|---|
| `apps/server/src/pipeline/db/`（schema + repositories） | 三张表 DDL/迁移 + 存取 |
| `apps/server/src/pipeline/templateSeed.ts` | 新增：4 处硬编码 -> 种子行 |
| `apps/server/src/pipeline/templateGuard.ts` | 新增：validateEdge + 继承匹配 |
| `apps/server/src/pipeline/bindingProposal.ts` | 权重读规则（默认回退） |
| `apps/server/src/routes/bindings.ts` | 候选过滤 + 确认门禁 |
| `apps/server/src/pipeline/{bindingGraphSync,executionFlow}.ts` | Phase 1 写边前过 templateGuard |
| `apps/server/src/pipeline/graphCommit.ts` | Phase 2 规则启用后接入 templateGuard |
| `apps/server/src/routes/templates.ts` | 新增：模板 CRUD API |
| `apps/server/src/graph/tools.ts` / `harness/roleToolRegistry.ts` | template_overview(L1)、manage_template(L2, Phase 3) |
| `apps/server/src/pipeline/{classifier,extraction}.ts` | Phase 2：提示词由模板生成 |
| `apps/web/`（绑定工作台） | 类型显示、终点分组、词表下拉 |
| 测试 | `test/pipeline/template*.test.ts`、bindings 集成用例 |

## 10. 调研出处

1. [neo4j-modeling-skill](https://github.com/neo4j-contrib/neo4j-skills/blob/main/neo4j-modeling-skill/SKILL.md)
2. [Graph Modeling: All About Super Nodes](https://medium.com/neo4j/graph-modeling-all-about-super-nodes-d6ad7e11015b)
3. [Neosemantics SHACL Validation](https://neo4j.com/labs/neosemantics/4.3/validation/)
4. [Palantir Ontology Overview](https://palantir.com/docs/foundry/ontology/overview/)
5. [Palantir Action Types](https://palantir.com/docs/foundry/action-types/overview/)
6. [Instabase Document Schema](https://docs.instabase.com/automate/document-schema)
7. [Sensible Validating Extractions](https://docs.sensible.so/docs/validate-extractions)
8. [Azure Document Intelligence Custom Models](https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/train/custom-model)
9. [UN/CEFACT Web Vocabulary](https://vocab-bsp-a246f0.opensource.unicc.org/docs/ontology/)
