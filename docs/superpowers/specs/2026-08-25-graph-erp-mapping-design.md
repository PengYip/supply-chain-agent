# 供应链贸易图谱：ERP 业务原语到知识图谱的映射设计（方案 A）

日期: 2026-08-25
状态: 已批准（方案 A），待实施
前置讨论: 传统结构化数据库对背靠背购销对应、多级贸易链穿透、凭证跨合同聚合等任意业务关系建模捉襟见肘；以 Neo4j 图谱承载关系语义，关系库守护精确数值。

## 1. 背景与目标

产品定位是用 Agent 替代原始 B 端 ERP 贸易业务管理系统。原始 ERP 的业务流程：

1. 为整体合同建立**项目**；
2. 项目下指定**供货商/客户**、**商品元数据**和**金融额度**；
3. 项目下建立**买卖合同**（采购/销售），约定供货商与客户之间的执行细则；
4. 合同签订后在履约层记录**物流、资金、发票**原始单据台账，形成报表。

传统关系库难以表达的三类关系（本次图谱化的核心动机）：

- **背靠背购销对应**：采购合同 ↔ 销售合同按批次对应，允许一对多/多对一；
- **多级贸易链穿透**：A→B→C→D 整条链上货权流转与风险敞口传导；
- **凭证跨合同聚合**：一张发票/一笔付款横跨多个合同，不是严格一一对应。

### 根本约束（守恒不变量）

合同之间允许错配，但**总量进出必须对得上**：

- R1 数量守恒：买卖商品的数量要对得上；
- R2 金额守恒：开票必须和付款对得上；
- 其他方面（合同间的精确对应）允许错配。

这决定了分工：**精确数字的对账在关系库算，松散的关系拓扑交给图**。

## 2. 架构定位：三层分工（方案 A 核心）

| 层 | 权威存储 | 承载内容 | 不承载 |
|---|---|---|---|
| 关系层 | Neo4j | 项目→合同→对手方→凭证的关系拓扑；correlates/trades/settles/relates 语义；额度拓扑 | 精确金额计算、报表口径聚合 |
| 数值层 | SQLite/Postgres | execution_flows 六向流水、contract_ledger 台账字段（现状保持） | 关系语义的唯一权威 |
| 对账桥 | 物化任务 | SQL 精确聚合结果回写图属性：Quota.used、Project.balance/gap | — |

铁律（沿既有架构约定）：SSOT→投影模式；图写入永不阻塞业务主流程；NEO4J_PASSWORD 未设→skipped；驱动错误→failed 并落 graph_status 可重试；派生边不追删，下次确认时重 MERGE 收敛。

## 3. 图 Schema 设计

### 3.1 节点（现有 5 种 + 新增 Quota）

| 节点类型 | 唯一键 | 核心属性 | 状态 |
|---|---|---|---|
| Project | code（项目编号） | name、balance（物化）、quantityGap/invoiceFundGap（物化） | 已有，扩展属性 |
| Party | name（归一化企业名） | rawName、role | 已有 |
| Contract | name（归一化合同号） | rawName、contractType（采购/销售/物流/租赁/服务/其他） | 已有 |
| Commodity | name（归一化品名） | rawName | 已有 |
| Document | docId | docType、sourceUri、contractType | 已有 |
| Quota | id（生成 ID，不用 name） | scope（counterparty/project）、limitAmount、currency、period、used（物化）、remaining（物化）、status | 新增 |

### 3.2 边——现有 7 种（不变）

| 边 | 方向 | 属性 | 写入时机 |
|---|---|---|---|
| party / commodity / references | Document→Party/Commodity/实体 | role | 文档确认（graphWriter） |
| executes | Document→Contract | — | 文档确认 |
| binds | Document→Contract | relation、bindingId、source=workbench | 绑定工作台确认（bindingGraphSync） |
| part_of | Contract→Project | role（合同类型） | 归属确认（projectGraphSync） |
| counterparty | Party→Contract | role（买方/卖方） | 台账甲乙方锚点派生 |
| participates | Party→Project | role（供应商/客户/主体） | 派生（采购→供应商、销售→客户） |

### 3.3 边——新增 5 种

| 边 | 方向 | 属性 | 语义 | 写入路径 |
|---|---|---|---|---|
| correlates | Contract(采购)→Contract(销售) | share、allocatedQuantity（Phase 3 预留）、allocatedAmount（Phase 3 预留）、confidence、confirmationSource | 背靠背购销对应；允许一对多/多对一 | Agent 提议或工作台操作 → L2 审批后写 |
| relates | Project↔Project | type、confidence | 项目级关联（同一生意拆多个执行主体等） | 同上（L2） |
| trades | Contract→Commodity | direction(buy/sell)、quantity、unit、unitPrice、amount | 合同标的与量价——把商品从文档层提升到合同层 | 合同抽取确认时确定性投影 |
| settles | Document→Contract | relation（收款/付款/收货/发货/收票/开票六向受控词表）、direction(in/out) | 履约凭证的六向资金/货权/票据语义（binds.relation 三值词汇的扩展） | 绑定确认 + 执行流水方向判定派生 |
| granted | Party/Project→Quota | — | 两层额度挂载（对手方授信 / 项目限额） | 额度创建（L2）；used 由对账桥物化 |

### 3.4 ERP 业务原语 → 图谱映射总表

| ERP 业务原语 | 图谱映射 | 说明 |
|---|---|---|
| 项目 | (:Project) | 容器节点，键=项目编号 |
| 供货商/客户 | (:Party) + counterparty/participates 边 | 角色由合同类型派生：采购→供应商、销售→客户 |
| 商品元数据 | (:Commodity) + trades 边属性 | 量价挂边不挂节点，一份商品被多张合同引用 |
| 金融额度 | (:Quota) + granted 边 | scope 区分对手方授信/项目限额两层 |
| 买卖合同 | (:Contract) contractType=采购/销售 + part_of | 合同间用 correlates 表达对应 |
| 合同上下游对应 | correlates 边（一对多/多对一/多级链） | 关系库最难表达的部分，图的核心价值 |
| 履约单据（物流/资金/发票） | (:Document) + binds/settles 边 | 一份凭证可连多张合同（跨合同聚合） |
| 台账/报表 | 不进图 | SQL 精确聚合，结果物化回图属性 |

## 4. 场景映射（问题 1 的答案）

1. **背靠背购销对应**：`(采购合同)-[:correlates {share}]->(销售合同)`。一张采购分两笔卖→两条出边；两张采购凑一张销售→两条入边。天然支持错配。
2. **多级贸易链穿透**：变长路径 `MATCH path=(c:Contract)-[:correlates*1..5]-(far:Contract)`，终端违约敞口 = 沿链反向聚合上游合同与 Party。
3. **凭证跨合同聚合**：一份 Document 发多条 binds/settles 边指向不同 Contract（现 bindings 表一行一个 (documentId, contractNo)，已天然支持）。Phase 3 在边上补 allocatedAmount 分摊。
4. **两层额度管控**：`(:Party)-[:granted]->(:Quota {scope:'counterparty'})` 与 `(:Project)-[:granted]->(:Quota {scope:'project'})`；占用 used 由对账桥物化；任一层超限告警。

## 5. 守恒校验（对账桥核心规则）

| 规则 | 内容 | 计算位置 | 结果落点 |
|---|---|---|---|
| R1 数量守恒 | 项目内按商品 Σ采购数量 ≈ Σ销售数量（容差可配） | SQL（trades 投影 + execution_flows） | Project.quantityGap（物化） |
| R2 开票↔收付平衡 | Σ销售开票 vs Σ收款；Σ采购收票 vs Σ付款 | SQL（execution_flows 六向流水） | Project.invoiceFundGap（物化） |
| R3 额度占用 | 对手方授信：名下全部项目占用之和 ≤ limitAmount；项目限额：项目内合同占用 ≤ limitAmount | SQL 聚合 | Quota.used / remaining（物化），超限告警 |

原则：图上聚合只做展示与导航（Cypher SUM 用于可视化），**守恒判定一律以 SQL 为准**（浮点精度与事务性）。

## 6. 写入路径与权限（HITL）

| 写入路径 | 触发时机 | 权限 | 典型对象 |
|---|---|---|---|
| 确定性投影 | 文档/绑定/归属确认时自动 | 后台旁路（永不阻塞主流程） | trades、settles、counterparty、participates |
| HITL 提议→确认 | Agent 提议或用户在工作台操作 | L2（needsApproval） | correlates、relates、Quota 创建/调整、granted |
| 对账物化 | 定时或流水变更触发 | 系统 | Quota.used、Project.balance/gap |

Agent 工具规划：

| 工具 | 权限 | 说明 |
|---|---|---|
| graph_query / graph_find_entity | L1（已有） | 只读遍历/按名查找 |
| link_contracts | L2（新增） | 建立 correlates 背靠背对应 |
| link_projects | L2（新增） | 建立 relates 项目关联 |
| manage_quota | L2（新增） | 创建/调整额度与挂载 |
| query_quota_usage | L1（新增） | 查额度占用（读图属性） |

词汇表扩展（domain/tradeSemantics.ts，L1 唯一归宿）：六向 settles relation 受控词表（收款/付款/收货/发货/收票/开票，复用 domain/flowDirection 方向判定）、quota scope 受控值。

## 7. 查询能力示例

```cypher
// 背靠背追溯：某采购合同对应的销售合同及份额
MATCH (buy:Contract)-[c:correlates]->(sell:Contract)
WHERE buy.name = $contractNo
RETURN sell.name, c.share;

// 多级链穿透：以某合同为起点穿透上下游 5 层
MATCH path = (start:Contract)-[:correlates*1..5]-(far:Contract)
WHERE start.name = $contractNo
RETURN [n IN nodes(path) | n.name] AS chain;

// 额度视图：对手方授信占用与余额（used 为物化属性）
MATCH (p:Party)-[:granted]->(q:Quota {scope:'counterparty'})
RETURN p.name, q.limitAmount, q.used, q.limitAmount - q.used AS remaining;
```

## 8. 分期落地计划

**Phase 1 — Schema 与确定性投影**
- [x] repo.ts：Quota label 唯一约束 + 新边 kind 白名单
- [x] tradeSemantics.ts：六向 settles 词汇 + quota scope 受控值
- [x] bindingGraphSync/projectGraphSync：trades/settles 投影写入
- [x] 工作台/API：correlates、relates 手动关联入口（提案→确认流，复用绑定工作台模式）
- [x] link_contracts/link_projects L2 工具

**Phase 2 — 额度与对账桥**
- [x] Quota CRUD + granted 边（manage_quota L2 工具 + API）
- [x] 占用物化任务（SQL 聚合 → Quota.used/remaining 回写）
- [x] R1/R2/R3 守恒校验与超限告警
- [x] query_quota_usage L1 工具

**Phase 3 — 分摊与报表**
- [x] correlates/settles 边上 allocatedAmount/allocatedQuantity 分摊录入（HITL）
- [x] 对账差额看板（R1/R2 报表视图）

## 9. 风险与已知取舍

- **双写一致性**：沿用 SSOT→投影 + graph_status 重试收敛；图不可用时业务不受阻（skipped）。
- **correlates 主观性**：背靠背对应由人/Agent 判断建立，非文档可抽取；保留 confidence 与 confirmationSource（human/auto_rule/agent）审计字段。
- **数值精度**：图上聚合仅作展示；守恒判定一律以 SQL 为准。
- **向后兼容**：全部为增量节点/边，不改既有 7 种边语义；老数据无需迁移。
- **键设计**：Quota 用生成 id 作唯一键，避免与 name 唯一约束体系冲突。

## 实施记录

2026-08-26 完成全部 Phase 1-3(T1-T12)。Phase 1: 48d919b..5635af5(词汇/settles/trades 投影/graph_links 存储/关联边同步/工作台 REST/L2 工具); Phase 2: a84bdbe..9e96f51(quotas 存储+granted 边+PG 迁移/对账桥/额度与对账路由/quota 工具); Phase 3: b6d1680..T12(分摊入参/报表 API)。前端看板页消费 /api/reconcile/report 与 /api/graph/links，属后续 UI 任务。
