# 本体图谱投影：trade_facts/ontology_edges → Neo4j（ontology-graph-sync）

日期: 2026-09-09
状态: 实施中（P1）
分支: `PengYip/ontology-graph-sync`
上游:
- `docs/贸易企业全链路数据本体建设落地方案（精准关系语义校准终版）.docx`（本体领域 SSOT）
- `docs/superpowers/plans/2026-09-07-ontology-foundation.md`（本体基座，已落地 main）
- `docs/superpowers/specs/2026-08-25-graph-erp-mapping-design.md`（方案 A：文档图谱三层分工）

## 1. 背景与问题

项目里有两套"图"：

1. **文档图谱**（已落地，Neo4j）：Document 为锚点，Party/Commodity/Contract/Project/Quota
   + 13 种边（graphWriter / 各 *GraphSync / graph_links 投影），SSOT 在关系库。
2. **本体图谱**（2026-09-07 基座落地，Postgres）：11 实体（4 静态 + 7 事件）zod 注册表 +
   `trade_facts`/`ontology_edges` 双后端表 + 台账/核销/穿透（neighbors）+ 3 个 L2 工具。

两图现状只在**查询时**结合：`ontology/neighbors.ts getNeighbors()` 把本体边 BFS（SQL）
与 Neo4j 血缘锚点层（TradeContract→Contract 桥、收发单据→Document 桥）在 API 响应里拼接。
其注释明确欠账："事件实体(TF id)无图节点，不融合。跨空间逐跳展开 deferred(需稳定桥表)"。

后果：核销/冲抵/红冲等事件语义不进图，Cypher 变长路径无法跨两空间跑；`graph_query`
agent 工具只能遍历文档空间；预付闭环、红冲链等跨空间问题答不了。

## 2. 方案：事件投影进 Neo4j，SSOT 留关系库

沿用仓库铁律（SSOT→投影、幂等 MERGE、图写入永不阻塞、NEO4J_PASSWORD 未设→skipped），
与 `graphWriter`/`settlesGraphSync` 同构。图承载**最新业务口径**（`asOfBusinessTime(now)`，
与台账列表一致），双时间轴切片/红冲净额轧差判定一律以 SQL 为准。

### 2.1 图 Schema 增量（纯增量，不动既有 6 类节点 / 13 种边）

| 图对象 | 落法 |
|---|---|
| trade_facts 行 | 节点：label=实体类型（7 事件 + 3 主数据 TradeGoods/Counterparty/OrgUnit），`name`=TF id（沿 name 唯一约束体系），props=payload 展平 + `userId/validAt/ingestedAt/createdBy` |
| ontology_edges 行 | 关系：type=关系名（ALLOCATE_TO 等 8 种），props=params + `edgeId/userId/validAt` |
| TradeContract 端点 | **不建事实节点**——桥到既有 `(:Contract {name: normalizeName(contract_no)})`（`lineageSubjectElementId` 同款桥接） |
| 收/发货单据源端点 | 桥到既有 `(:Document {name: docId})`（documents 源伪事件保持 Document 表示，不重复建节点） |
| EVIDENCE 边 | **v1 不做**——facts 暂无 documentId 溯源字段（PROVENANCE_FIELDS 无文档引用）；facts 增加文档锚点后作为 P2 接缝 |

事实节点 label 共 10 个（`FACT_NODE_LABELS`）。`Contract/Document` 桥端点由
`findEntities(exact)` 按归一化名解析；解析失败记入 `failures[]` 跳过该边（逐条容错，
同 graphWriter）。

### 2.2 收敛语义（MERGE + prune）

- 全量幂等投影 `syncOntologyGraph()`：facts/edges 各以 `SOURCE_ROW_CAP`(500) 为单表上限
  （沿 projection.ts 先例），超限置 `truncated`。
- **prune（收敛删除）**：对 10 个事实 label，`DETACH DELETE` 当前 as-of 集合之外的本用户
  事实节点（`n.userId = 行userId` 匹配；含共享 `''` 行）。`truncated` 时跳过 prune
  （防超限误删）。失效事实（invalid_at / 红冲净额模型的外层）随下次同步自然出图。
  铁律"派生边不追删"针对业务边语义；事实节点是投影本体，收敛删除即"最终结果语义"。
- 事实节点自带 `userId` prop：本体表有用户隔离而现有 Neo4j 节点没有——这是结合时
  最易漏的缝隙，投影必须携带，消费方（P2 穿透升级）按它过滤。

### 2.3 触发点（确认时投影 + 手动回填）

| 触发 | 路径 | 方式 |
|---|---|---|
| 事件登记 | `create_trade_event` L2 execute 成功后 | fire-and-forget（`syncOntologyGraphSafe`，永不阻塞、永不抛） |
| 核销/冲抵 | `create_writeoff` / `create_offset` 整单落边成功后 | 同上 |
| 主数据登记 | `POST /api/ontology/master-data` 直写成功后 | 同上 |
| 手动回填 | `POST /api/ontology/graph/sync`（requireAuth 已挂 /api/ontology/*） | await，返回投影结果（存量数据一次收敛） |

## 3. 结合后的能力（P2/P3 展望，本次不实现）

- P2：`neighbors.ts` 升级"单图优先"——Neo4j 可用时一次 `graphQuery` 拿本体+血缘+文档邻域，
  现有两空间融合降级为图不可用回退；事实消费方按 `userId` 过滤。
- P3：agent 跨空间多跳（graph_query 词表自然扩展到事件 label）；GraphRAG。

```cypher
// 预付闭环：预付 -> 冲抵 -> 结算（后续 P2 接 FEEDS_INTO/EVIDENCE 到单据）
MATCH (pay:PaymentEvent {payType:'预付'})-[:OFFSET_SETTLE]->(s:SettlementEvent)
RETURN pay, s LIMIT 5;

// 红冲溯源链
MATCH path = (red:InvoiceEvent)-[:REVERSE_ORIGIN*1..3]->(blue:InvoiceEvent) RETURN path;
```

## 4. 设计决策

1. **静态实体不建新节点**：TradeContract=既有 Contract（contract_no 同源键）、Counterparty
   主数据例外——它以 trade_facts 落库（master-data 端点），故建 `(:Counterparty {name:TF id})`
   事实节点；与既有 `(:Party)`（企业名归一空间）**并存不合并**（键空间不同：TF id vs 归一企业名），
   P2 再决定是否按名二次桥接。
2. **as-of 不进图**：只投影最新业务口径；双时间轴是 SQL 的语义优势，搬进图只会让 Cypher
   查询变成灾难（同方案 A"守恒判定以 SQL 为准"原则）。
3. **prune 以 userId + truncated 双守卫**：防跨用户误删、防超限误删。
4. **EVIDENCE 边缓做**：facts 无文档溯源字段，先不造；等 create_trade_event 增加
   documentId 溯源（P2）再补边，避免现在发明悬空桥。
5. **不新增 agent 工具**：投影对 `graph_query`/`graph_find_entity` 透明（open schema 自动
   可见），无需动 tool-inventory.json。

## 5. 测试与验收

- `test/ontology/graphSync.test.ts`：io 注入（createEntity/mergeEdge/findEntities fake，
  沿 graphWriter 测试范式）+ `:memory:` SQLite 真库（沿 neighbors 测试范式）。
  覆盖：skipped 门禁 / 节点 props 与 userId / fact-fact 边 / TradeContract 桥命中与脱靶 /
  单据源端点 / 幂等重跑不增殖 / prune 收敛与双守卫 / safe 包装吞错。
- CI 车道不依赖真实 Neo4j（io 注入）；PG 结构无变更（零 DDL）。

## 实施记录

2026-09-09 P1 完成（分支 `PengYip/ontology-graph-sync`）：

- `apps/server/src/ontology/graphSync.ts`：`syncOntologyGraph`（全量幂等投影：事实节点
  upsert → 关系投影（TradeContract/单据源桥端点解析）→ prune 收敛）+
  `syncOntologyGraphSafe`（fire-and-forget 包装）；io + 桥读取槽位可注入。
- `apps/server/src/graph/repo.ts`：新增 `pruneFactNodes`（label + userId(含共享 '')
  + keep 集 scoped DETACH DELETE，断言 label token 注入安全）。
- 钩子（落账成功后 fire-and-forget）：`eventTools.create_trade_event`、
  `writeoffTools.create_writeoff/create_offset`、`routes/ontology.ts POST /master-data`。
- `routes/ontology.ts`：新增 `POST /api/ontology/graph/sync` 手动全量回填。
- 测试 `apps/server/test/ontology/graphSync.test.ts` 13 例（skipped 门禁/节点 props/
  WRITE_OFF 边/Contract 桥命中与脱靶/单据源桥/幂等/prune 收敛+用户域+truncated 守卫/
  逐条容错/safe 吞错）。build/lint/test 全绿；无 DDL、无新工具（tool-inventory 不动）。
- P2/P3（未做）：neighbors 单图优先、EVIDENCE 边（待 facts 增加文档溯源字段）、
  agent 跨空间多跳与 GraphRAG。

## P2 实施记录（2026-09-09，前后端同步结合）

- **后端跨空间逐跳**（`ontology/neighbors.ts`）：血缘合并重构为 `mergeLineageNeighborhood`
  （文档节点键 + lineage 边 id 双去重累积器）；`getNeighbors` 在锚点层之外，对 BFS
  可达的 TradeContract / 收发单据源（documents 源，id=docId）节点逐个展开 depth=1
  文档血缘（`midNodeLineageSubject` 桥解析），节点上限守卫即停。原"跨空间逐跳展开
  deferred(需稳定桥表)"欠账就此还掉——本体走到合同，合同带出单据，一屏穿透。
  `LineageStatus` 增量字段 `bridgesExpanded`（桥展开计数，前端 DTO 可选透传）。
- **前端**（`apps/web`）：`api/ontology.ts` 新增 `syncOntologyGraph()`（POST
  /api/ontology/graph/sync）与 lineage DTO 增量字段；`OntologyExplorer` 工具栏新增
  「同步图谱」按钮（ok/partial/skipped 三态反馈，6s 自动消退）——投影不再只是
  curl 入口，用户在穿透视图一键回填；画布对血缘 Document 节点/lineage 边的渲染
  沿用既有 edgeLabel/EDGE_PARAM_LABELS（unitIndex/pages 已在映射内），跨空间
  节点零新增渲染逻辑。
- **测试**：`test/ontology/neighborsMultiAnchor.test.ts` 3 例（中途合同展开并桥接
  到 BFS 既有节点 / 桥脱靶静默降级 / maxNodes 守卫即停）；4 处既有 lineage 形状
  断言补 `bridgesExpanded: 0`。
- 事实实体(TF id)节点仍不展开文档血缘——facts 无文档溯源字段，等
  create_trade_event 增加 documentId 溯源后补 EVIDENCE 边（P3 接缝）。

## P3 实施记录（2026-09-09，凭证据源 EVIDENCE 全链）

- **数据模型**：`PROVENANCE_FIELDS` 增 `documentId`；`trade_facts.document_id` 双后端
  落列（SQLite CREATE + PRAGMA 守卫 ALTER；PG `ADD COLUMN IF NOT EXISTS` + drizzle
  twin）；`repo.ts` TradeFactInput/Row/insert/行映射全链透传。
- **写入面**：`create_trade_event` inputSchema 增可选 `documentId`（execute 解构摘出，
  溯源列不进 strict 实体 payload）；表单路由 `POST /api/trade-events` 预检同款解构
  （指令逐字透传给工具）。
- **图投影**：`graphSync` 事实节点 props 带 documentId + 新增 `EVIDENCE` 边
  `(:Document)-[:EVIDENCE]->(:事件节点)`；Document 图节点不存在（单据未确认）计
  `skippedEvidence`（正常态，确认后下次同步自动补边），不算 failures。prune 收敛时
  EVIDENCE 边随事件节点 DETACH 自动消亡，无悬空。
- **穿透**：`neighbors.ts` 锚点层与跨空间逐跳层均增事实分支——挂 documentId 的事实
  以自身图节点为 subject、`edgeKinds=['EVIDENCE']` 展开，一跳到原始单据；
  `mergeLineageNeighborhood` 重构为 kind 感知映射（Document=docId、其余=实体名），
  节点只并 Document（D7 单据邻域口径），边保留条件=两端落在 {主体} ∪ Document——
  顺带修掉 P2 前合同邻域 Party/Quota 被误标 Document 的隐性问题。
- **前端**：`EDGE_LABELS.EVIDENCE='凭证溯源'` + 灰虚线样式；`formatEdgeParams` 改
  白名单制（过滤 edgeId/userId/validAt 投影元数据噪音，新增 role 标签）；台账详情
  抽屉增「来源单据」行（meta.documentId）；`GraphSyncResultDTO.skippedEvidence`。
- **测试**：graphSync 2 例（EVIDENCE 边建立/未确认单据 skippedEvidence）、
  neighborsMultiAnchor 1 例（事实锚点 EVIDENCE 展开）、tables FACT_COLS 列断言更新、
  G_ENTITY mock kind 修正。全量 server 1779 / web 113 / lint 0 错误。

## P4 实施记录（2026-09-09，本体关系创建入口补全）

- **`link_ontology` L2 工具**（`ontology/linkTools.ts`）：覆盖此前无入口的 6 种关系
  （ALLOCATE_TO/REVERSE_ORIGIN/FEEDS_INTO/CORRESPONDS_TO/TRIGGERS/PROVIDE）。
  校验链=事实行存在 → 连接对白名单（relationDef/isRelationPairAllowed）→ params 走
  注册表关系 strict schema → insertOntologyEdge 唯一写入边界；REVERSE_ORIGIN 附加
  语义校验（红冲方逆向负数/原票正向）。WRITE_OFF/OFFSET_SETTLE 刻意不在词表
  （整单守恒归核销工作台，描述显式引导）。落边后 fire-and-forget 图投影。
- **治理登记全链**（新工具五道门）：tool-inventory.json 条目（inventory bijection 门禁）
  → roleToolRegistry 挂载（needsApproval）→ TRADER_CTX_TOOL_NAMES →
  permissionGate L2 → contextContract TOOL_CONTEXT_CONTRACTS → settlement 场景
  SCENARIO_TOOLS。policy.maxToolsMountedPerScenario 11→12（正式提帽，理由见
  inventory version 2026-09-09）。
- **详情关系区**：`projection.ts` EntityDetail 增 `relations[]`（本行为端点的边，
  双向、对端业务键标签、最新业务口径、上限 50），合同/事实/单据源三分支全接；
  前端 `EntityDetailDrawer` 增「本体关系」区块（edgeLabel + 方向箭头 + 对端 +
  参数摘要）——建好的边在台账即可核对，不必开穿透图。
- **测试**：linkTools 7 例（词表引导/分摊落边/红冲方向校验/连接对白名单/合同锚点
  缺失/strict params 整单拒绝/PROVIDE 主数据端点）+ projection 关系用例（双向+
  对端标签解析）。全套 server 1787 / web 113 / lint 0 错误。
- 至此 8 种本体关系全部具备产品创建入口（核销工作台 2 + link_ontology 6），
  验收指南中"六种关系需 SQL 种子"的边界声明作废。
