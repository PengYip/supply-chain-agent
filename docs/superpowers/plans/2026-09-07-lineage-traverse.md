# 链路穿透 v1（lineage-traverse）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 扩现有 graph 视图：新增邻接 API `GET /api/ontology/graph/neighbors`（本体边 BFS + Neo4j 文档血缘锚点层融合），前端 graph 视图内新增「本体穿透」模式——起点选择器、节点双击 lazy 展开、边按关系类型着色（wb4 语义）、边悬停显示参数；实体台账详情抽屉「在图中查看」跳入。

**Architecture:** server 侧新增 `ontology/neighbors.ts`（纯编排层，零裸 SQL，全部复用 repo/projection 既有读路径 + graph/repo 的 `graphQuery`/`findEntities`），路由挂进既有 `routes/ontology.ts`（requireAuth 免费继承）。前端不动默认文档图谱模式，GraphView 内加模式切换渲染新组件 `OntologyExplorer`（复用 GraphCanvas/@antv g6 与 EDGE_STYLE_OVERRIDES 着色机制）；跨视图跳入复用 `openInGraph` nonce 通道（GraphFocusTarget 扩为判别联合）。

**Tech Stack:** Hono + zod（server）；React 19 + Tailwind + @antv/g6 v5 + hash 路由（web）；neo4j-driver ^6.2.0（既有）。

**Spec:** `docs/superpowers/specs/2026-09-07-frontend-p0-p2-roadmap.md` Item 4 节（本计划只覆盖 Item 4；IN/OUT/验收以该节为准）

## Global Constraints（路线图 §3.4 逐条）

- 验证顺序 `npm run build && npm run lint && npm test`（仓库根）。
- 代码零 emoji；TS 严格模式过 tsc。
- 双后端列对列镜像；SQLite 幂等迁移 / Postgres `ADD COLUMN IF NOT EXISTS`——**本期零 DDL 变更**（不新增表/列），且 `neighbors.ts` 零裸 SQL（全部经 repo/projection 既有双分支读路径），约束自动满足；**无 PG 集成 lane 需要**（新代码不触裸 SQL，repo/projection 层双分支已被 Item 2/3 测试覆盖）。
- 本期**不新增 agent 工具**（只读 REST API 不进工具注册表；toolInventory.test.ts 断言的是 roleToolRegistry 双射，与 HTTP 路由无关——`/api/ontology/entities` 无 inventory 条目为先例），`docs/tool-inventory.json` 不动；若实施中动了工具面即偏离计划。
- AI SDK 6 陷阱以 AGENTS.md「AI SDK 6」节为准（本期不触碰 harness/流式，无涉）。
- 认证 `requireAuth`；测试模式 `appAs(userId)` + `app.request`（路由测试照抄 `test/routes/ontologyEntities.test.ts` 的 `ctxHolder` + `vi.mock(dbBackend)` 模式；Neo4j 侧无测试容器 → `vi.mock(graph/repo.js)` 模式，照抄 `test/routes/graphSchema.test.ts`）。
- 分支惯例：feature 分支 `PengYip/lineage-traverse` 开发，验证绿后 merge 回 main 并 push（触发 CI+CD 到 10.10.0.2）。
- UI：视觉与交互对齐既有视图惯例（卡片 `rounded-lg border border-line bg-white`、色彩 token `ink/ink-soft/surface/line/danger`、工具栏 toggle 形态参照 GraphView 既有 `showPlainEdges` 开关）；视觉规范不属于计划范围，实现时含明显视觉设计的部分可走 designer 评审。

## 摸底结论（2026-09-07，基线 HEAD = 8ebfe3a）

Item 1（审批中心）、Item 2（本体基座）、Item 3（贸易台账）均已合并 main。定向 recon 的关键事实（本计划贴出的代码即此基线）：

1. **本体边读路径**（`apps/server/src/ontology/repo.ts`，234 行）：
   - `listOntologyEdgesAsOf(ctx, pred, opts: { relation?: string } = {}, userId?)`（L199）是唯一边读路径——**只支持 relation 过滤，无按端点（from/to）查询**；用户隔离 `(user_id = ? OR user_id = '')`（`effectiveUserId`）；返回 `OntologyEdgeRow { id, relation, fromType, fromId, toType, toId, params, validAt, invalidAt, ingestedAt, createdBy, userId }`，`ORDER BY valid_at, id`。
   - `insertTradeFact(ctx, input, userId?)` 返回 `TF-<ts36>-<rand4>` id；`insertOntologyEdge(ctx, input, userId?)` 先 `relationDef`（未知关系 throw）→ `isRelationPairAllowed`（连接对不合法 throw，错误信息含合法对清单）→ params strict parse（zod ZodError）。
   - `getTradeFactById(ctx, id, userId?)`（L137）**不校验 entity_type**——按 id 直取。
2. **注册表**（`apps/server/src/ontology/index.ts`，310 行）：11 实体 / 8 关系 14 连接对。带参关系 params（均 strict）：`ALLOCATE_TO` `{amount, ratio?(0..1), method:AllocateMethod, batch?}` 3 对（ServiceCost/GoodsReceipt/GoodsDeliveryEvent→TradeContract）；`OFFSET_SETTLE` `{amount, batch?}` 2 对（Payment/CollectionEvent→SettlementEvent）；`WRITE_OFF` `{amount, partial?, batch?}` 2 对（Payment/CollectionEvent→InvoiceEvent）；`REVERSE_ORIGIN` `{amount, reason?}` 仅 InvoiceEvent→InvoiceEvent。无参：`FEEDS_INTO`（收发→结算 2 对）、`CORRESPONDS_TO`（结算/服务费→发票 2 对）、`TRIGGERS`（服务费→付款 1 对）、`PROVIDE`（对手→服务费 1 对）。`AllocateMethod = ['金额','数量','重量','定额']`。事件 payload 必填词汇：收/发 `{eventBizType, amount, currency}`、结算 `{eventBizType, amount, currency}`、发票 `+invoiceNo, invoiceType`、付款 `+payType`、收款 `{eventBizType, amount, currency}`、服务费 `+costType`；语义规则 逆向=负数/正向=正数（写入边界 superRefine）。
3. **表与索引**（`pipeline/db/client.ts` SQLite L464-494 / PG L1138-1167）：`ontology_edges` 已有 `(from_type, from_id, user_id)`、`(to_type, to_id, user_id)` 索引；无外键（边可指向任意 id，测试可插 'TF-1' 风格自由 id）。
4. **投影层**（`projection.ts`，319 行）：`findContractRowById`/`findDocRowById`/`factToEntity` 均**模块私有**；`findDocRowById` 的 SQL **不过滤 doc_type**（已知行为：详情 API type/id 不校验返回 200 的单据侧根源）；`reverseOriginCluster`（L233-249）= 全量边加载 + 内存图遍历的**既有先例**（本计划 BFS 照此风格）。`DOC_TYPE_BY_EVENT = { GoodsReceiptEvent:'收货单', GoodsDeliveryEvent:'发货单' }`（私有）。
5. **路由基线**（`routes/ontology.ts`，88 行）：`/schema`、`/entities/:type`、`/entities/:type/:id` 三路由；文件内自带 `use('*')` 401 守卫（L17-20）；挂载 `index.ts:132`（`app.use('/api/ontology/*', requireAuth)`）+ `index.ts:170`——**在同一路由文件追加路由即免费继承两级认证**；zod safeParse + `{error, detail}` 错误体风格。
6. **Neo4j 侧**：
   - `graphQuery(input: GraphQueryInput)`（`graph/repo.ts:409`）：`{ subjectId(elementId), depth?(≤5), edgeKinds?, direction?('both') }` → `GraphQueryResult { subject: GraphEntity, nodes: GraphEntity[], edges: GraphEdge[] }`；`GraphEntity { elementId, kind(labels[0]), name(props.name), props }`、`GraphEdge { elementId, type, srcId/dstId(均为 elementId), props, confidence }`。**repo 层支持 edgeKinds 过滤而 HTTP /query 路由未暴露**——邻接 API 直呼 repo 传参即可。
   - `findEntities({ kind?, name, exact?, limit?≤10 })`（`graph/repo.ts:245`）：`exact: true` 走 `WHERE n.name = $name`；name 为空返回 []。
   - 节点身份：`Document.name === docId`（`MERGE (n:Document {name: $docId})`，props 带 docId/docType/batchRole）；`Contract.name === normalizeName(contractNo)`（`graph/normalize.ts`）。容器节点刻意无 docType prop（2026-09-01 拍板）。
   - **CONTAINS 边只存在于容器 Document→单元 Document**（`batchLineageGraphSync` → `writeBatchLineageEdges`，props `{unitIndex, pages}`）；Contract→Document 走 executes/references 等抽取边。⇒ 合同锚点取 CONTAINS 邻接会得到空集，需按锚点类型区分策略（见 D7）。
   - 连接配置 `env.ts:85-88`：`NEO4J_URL/USER/PASSWORD`（默认 `bolt://localhost:7687`/`neo4j`/`''`）；未设 PASSWORD 时 `getDriver()` throw `'NEO4J_PASSWORD not set; graph tools unavailable'`，写路径全部 `if (!process.env.NEO4J_PASSWORD) return 'skipped'` 先行短路；dev(10.10.0.2) 已配置 Neo4j（容器 neo4j-db，5.26.10）。
   - 503 惯例：`routes/graph.ts` 的 `isGraphUnavailable(e)`（错误信息含 `NEO4J_PASSWORD not set` 或 Neo4jError）→ 503 `{error:'图谱服务未配置或不可用'}`。
7. **web 基线**：
   - `App.tsx:119-128` `openInGraph`（nonce 通道，nonce 不进 URL）；`focus.ts` 现为扁平 `{elementId, label, nonce}`；`GraphView.tsx:155-163` ref 守卫消费 focus → `query(elementId, label, false)`；`App.tsx:307-348` 三元链视图分发，`view === 'graph'` 渲染 `<GraphView focus={graphFocus} onOpenInBindings={openInBindings} />`。
   - 画布：`@antv/g6` v5（GraphCanvas.tsx，376 行）；props `{ subgraph, centerElementId, hiddenKinds, showPlainEdges, onHover, onNodeSelect, onEdgeSelect, onPaneSelect, onNodeDoubleClick }`；`useGraph.ts` 的 `GraphNode {elementId, kind, name, props}` / `GraphEdge {elementId, type, srcId, dstId, props, confidence}` / `Subgraph {subject, nodes, edges}`；未知 kind 落 `FALLBACK_STYLE` 灰。**双击节点 = 增量展开**语义已存在（`onNodeDoubleClick`）。`key={center?.id}` 重挂载画布（GraphView.tsx:436）。
   - 着色：`businessTypes.ts` `EDGE_STYLE_OVERRIDES: Record<string, {color, dashed}>`（现仅 `binds: {color:'#15803D', dashed:true}`）+ `EDGE_LABELS` 中文标签 + `KIND_STYLES`（Document/Party/Commodity/Contract/Project 五类 + FALLBACK）。GraphCanvas 建边时 `override?.color ?? (cls==='hierarchy' ? '#64748B' : '#CBD5E1')`——**扩展 OVERRIDES 即可让本体关系边上色，画布零改动**。**wb4 领域关系图在仓库中不存在任何实现/色值**（全仓库唯一出处是路线图 spec:94 的语义描述）⇒ 色值需新建（见 D3）。
   - 台账：`EntityDetailDrawer` props `{type, typeLabel, ownFields, entityId, onClose}`（有 type+entityId，**无 Neo4j elementId**）；`EntitiesView` 行点击开抽屉（L116），抽屉接线 L179-187；`api/ontology.ts` 的 `request()` + `listEntities(type,{page,pageSize,q})` 模式。
   - hash 路由：`navigate(view, params)`，`parseHash` 支持任意 query 参数；chat 的 `ask` 注入链（App→ChatWorkspace→RealChatView ref 守卫）是跨视图带参跳入的成熟先例。
8. **测试/脚本基线**：路由测试 `ctxHolder` + `vi.mock(dbBackend)` + 本文件内 `appAs`（各测试文件本地定义，无共享 helper）；夹具一律走 `insertTradeFact/insertOntologyEdge`（第三参 userId）；graph 侧 mock 先例 `test/routes/graphSchema.test.ts`（`vi.mock(graph/repo.js, importOriginal 展开 + 覆写)`）。`scripts/seedTradeLedgerDemo.ts` 只有红冲两答案用例（写入用户 `''` 共享域，marker 幂等，`npx tsx` 直跑）——**主链种子是全新工作**。tsx 在 devDependencies（^4.23.5）。

## 决策记录（计划时决策点，理由如下）

- **D1 模式：graph 视图内新增「本体穿透」模式，不并入默认模式。**
  理由：① 两套节点身份体系不同（默认模式以 Neo4j `elementId` 为中心，穿透模式以业务 `type+id` 为中心），合并需逐节点做 elementId↔业务键桥接，复杂度不成比例；② 路线图原则 3「现有视图不重做，新能力以新 ViewId 或数据源替换的方式进入」——模式切换即「数据源替换」形态；③ 默认模式的 CONTAINS 文档树语义保持零风险。工具栏二段 toggle（文档图谱/本体穿透），模式是 GraphView 内部 state 不进 ViewId。
- **D2 起点注入：扩展 `GraphFocusTarget` 为判别联合 + 复用 nonce 通道；台账抽屉加「在图中查看」按钮；审批详情跳入 deferred。**
  理由：nonce 通道已解决「重复触发同一目标」（URL 表达不了重复触发，App.tsx:119 注释原话）；hash 参数跳入会在重复点击同一实体时失效。审批详情跳入 deferred：审批 payload 中实体引用（工具 args）无标准化 type+id 结构，需工具参数 schema 梳理，单列后续项。
- **D3 wb4 颜色：仓库无 wb4 实现，按语义新建色值。**
  `ALLOCATE_TO` 蓝 `#2563EB` / `OFFSET_SETTLE` 绿 `#16A34A` / `WRITE_OFF` 橙 `#EA580C` / `REVERSE_ORIGIN` 红 `#DC2626` / 辅助（FEEDS_INTO/CORRESPONDS_TO/TRIGGERS/PROVIDE）灰 `#94A3B8` 虚线（与普通抽取边 `#CBD5E1` 实线区分）；文档血缘 `CONTAINS` 沿用层级灰 `#64748B` + 虚线（对齐既有 `binds` 虚线惯例）——验收 2「颜色/图例区分」由虚线+图例双保险。
- **D4 深度上限 3（默认 1）+ 响应规模截断双保险。**
  zod `depth: int 1..3`（/api/graph/query 允许 5，但合并端点一次跨两图，收紧到 3——主链演示够用）；另加节点 ≤200 / 边 ≤500 截断 + `truncated` 标记，更深的展开由前端逐跳 lazy 完成（验收 4）。
- **D5 Neo4j 不可用 → 优雅降级 `lineage.available:false`，不 503。**
  理由：503 语义只适合纯 Neo4j 端点（/api/graph/* 全部数据在 Neo4j）；合并端点的本体部分永远可用（SQLite/PG），部分可用是有意义的降级。血缘锚点未找到（合同无图节点等）→ `lineage.subjectFound:false`，本体邻接照常返回。
- **D6 本体邻接 = 最新业务口径全量边内存 BFS。**
  理由：repo 无按端点查询（索引虽在但需新 SQL + 双分支），`reverseOriginCluster` 已确立「全量边 + 内存遍历」先例；v1 边量级（工具/种子写入）远小于规模阈值。as-of 时间切片穿透 deferred（详情抽屉已具备两口径，图上不做时间旅行）。邻接节点解析为逐引用最佳努力（N≤200，量级小），批量 IN 查询优化 deferred。
- **D7 血缘融合 v1 仅锚点层，按锚点类型区分策略。**
  TradeContract 锚点 → `Contract` 图节点（`normalizeName(contractNo)` 精确解析）→ `graphQuery` **不加 edgeKinds**（取其文档邻域 executes/references 等，承载「合同→单据」主链可穿）；收/发单据锚点（documents 源实体，`Document.name === docId`）→ `graphQuery edgeKinds:['CONTAINS']`（纯批拆血缘：容器→单元）。事件实体（TF id）无图节点，不融合。跨空间逐跳展开（文档节点再穿本体边）deferred——两种身份体系边级互通需稳定桥表。
- **D8 锚点解析强制 type 匹配（在本端点内防住 type/id 不校验陷阱）。**
  事实解析校验 `fact.entityType === ref.type`；`findDocRowById` 补 `doc_type` 过滤（2 行 SQL 改动，台账详情端点同步受益且无既有测试回归）；`getProjectedEntityDetail` 的事实分支 type 校验**不在本期修**（会改变 /entities/:type/:id 既有 200 行为，属行为变更，单独裁决，注记 deferred）。锚点解析失败但存在邻接边时仍返回 200（`source:'unresolved'`），完全无邻接才 404。
- **D9 验收 1 的「2 跳可达发票/付款」由 ServiceCostEvent 桥承载。**
  注册表连接对下，TradeContract 到 InvoiceEvent/PaymentEvent 的唯一 ≤2 跳路径是 `ALLOCATE_TO(S→C) + CORRESPONDS_TO(S→I) + TRIGGERS(S→P)`；收发链（C←R—FEEDS_INTO→St—CORRESPONDS_TO→I）为 3 跳、付款经 WRITE_OFF 为 4 跳——种子两者都配（前者保验收 1，后者 + depth=3 演「主链一眼可穿」）。

### 响应契约（Task 2-4 共同产出，web 侧 DTO 镜像）

```text
GET /api/ontology/graph/neighbors?type=<entityType>&id=<id>&depth=1
{
  anchor: { type: string; id: string },
  anchorNode: { id, entityType, label, source: 'contract_ledger'|'documents'|'trade_facts'|'unresolved' },  // 锚点本身
  nodes: [同上形状, 不含锚点],                    // 本体邻接 + 血缘 Document 节点(source:'neo4j')
  edges: [{ id, relation, origin: 'ontology'|'lineage', fromType, fromId, toType, toId, params, validAt }],
  lineage: { available: boolean; subjectFound: boolean },
  truncated: boolean,
}
```

### OUT / deferred 清单（不属本期，防实施漂移）

as-of 时间切片穿透；跨空间逐跳展开（文档节点再穿本体边）；审批详情跳入（D2）；`getProjectedEntityDetail` 事实分支 type 校验修复（D8）；`reverseOriginCluster` 无界读取收敛（同源但与邻接无关）；邻接节点批量 IN 解析优化（D6）；全图渲染/路径算法/图编辑/Neo4j Bloom（spec OUT 原文）。

---

### Task 1: 前置检查 + 分支准备

**Files:** 无代码改动。

**Interfaces:** 无。

- [ ] **Step 1: 基线同步**

Run:
```bash
git fetch origin
git log --oneline -3
git status
```
Expected: HEAD 在 `8ebfe3a` 或其后人（Item 3 台账已含：entities 视图 / 抽屉 / 种子脚本）。若落后 origin/main，先 `git merge origin/main` 再继续；有冲突则停下人工处理。

- [ ] **Step 2: 建 feature 分支**

```bash
git checkout -b PengYip/lineage-traverse origin/main
```

- [ ] **Step 3: 前置检查（写码前暴露不确定签名；与预期不符时以实际代码为准修订后续任务的贴码）**

Run 并逐条确认：
```bash
grep -n "export async function findEntities\|export async function graphQuery\|export interface GraphQueryInput" apps/server/src/graph/repo.ts
# 预期: findEntities(FindEntitiesInput) / graphQuery(GraphQueryInput) 签名与摸底结论 6 一致
grep -n "export function normalizeName" apps/server/src/graph/normalize.ts
grep -n "findDocRowById\|DOC_TYPE_BY_EVENT\|factToEntity\|findContractRowById" apps/server/src/ontology/projection.ts
# 预期: 四者均存在且为模块私有(无 export)——Task 2 要加 export；记录 findDocRowById 的 SQL 行号
grep -n "InspectTarget" apps/web/src/hooks/useGraph.ts | head -5
# 记录 InspectTarget 类型形状(Task 7 边悬停要用)
grep -n "pointerenter" apps/web/src/components/graph/GraphCanvas.tsx
# 记录 node:pointerenter 的注册与 evt 取节点写法(Task 7 edge:pointerenter 照抄该形态)
grep -n "openInGraph\|GraphFocus" apps/web/src/App.tsx apps/web/src/components/graph/GraphView.tsx apps/web/src/components/bindings/BindingMiniGraph.tsx | head -20
# 记录 focus 通道全部触点(Task 8 改判别联合时逐处过一遍)
grep -n "showPlainEdges" apps/web/src/components/graph/GraphView.tsx | head -6
# 记录工具栏结构(Task 7 模式 toggle 插入点)
```

- [ ] **Step 4: 空跑验证基线绿**

Run: `npm run build && npm run lint && npm test`
Expected: 全绿（不绿先修基线，不属本计划）。

---

### Task 2: 邻接核心——本体边 BFS + 锚点/邻接解析（ontology/neighbors.ts）

**Files:**
- Modify: `apps/server/src/ontology/projection.ts`（导出 4 个私有成员 + `findDocRowById` 补 doc_type 过滤）
- Create: `apps/server/src/ontology/neighbors.ts`
- Test: `apps/server/test/ontology/neighbors.test.ts`

**Interfaces:**
- Consumes: `listOntologyEdgesAsOf`/`getTradeFactById`（repo.js）、`findContractRowById`/`findDocRowById`/`factToEntity`/`DOC_TYPE_BY_EVENT`（projection.js，本任务导出）、`effectiveUserId`（repositories.js）、`asOfBusinessTime`（asof.js）。
- Produces:
  - `NeighborRef { type: string; id: string }`、`NeighborNode { id; entityType; label; source: 'contract_ledger'|'documents'|'trade_facts'|'neo4j'|'unresolved'; props?: Record<string, unknown> }`（`neo4j` 由 Task 3 产出，类型一次到位）、`NeighborEdge { id; relation; origin: 'ontology'|'lineage'; fromType; fromId; toType; toId; params; validAt: string|null }`、`OntologyNeighbors { anchor: NeighborRef; anchorNode: NeighborNode; nodes: NeighborNode[]; edges: NeighborEdge[]; truncated: boolean }`
  - `MAX_NEIGHBOR_NODES = 200`、`MAX_NEIGHBOR_EDGES = 500`、`MAX_NEIGHBOR_DEPTH = 3`
  - `getOntologyNeighbors(ctx, input: { type: OntologyEntityName; id: string; depth: number }, userId?, opts?: { maxNodes?: number; maxEdges?: number }): Promise<OntologyNeighbors>`（Task 3 的 `getNeighbors` 在其上叠血缘）

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/test/ontology/neighbors.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import { getOntologyNeighbors } from '../../src/ontology/neighbors.js';
import { insertTradeFact, insertOntologyEdge } from '../../src/ontology/repo.js';

let ctx: DbContext;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
});

const insertContract = (id: string, contractNo: string) => {
  ctx.sqlite.prepare(
    `INSERT INTO contract_ledger (id, contract_no, display_contract_no, doc_type, document_id,
        title, fields, field_meta, overall_confidence, needs_review, user_id, contract_type)
     VALUES (?, ?, ?, '合同', 'doc-1', '', '{}', '{}', 1, 0, '', '采购')`,
  ).run(id, contractNo, contractNo);
};

/** 验收 1 的最小拓扑(D9)：C1 <-ALLOCATE_TO- S -CORRESPONDS_TO-> I；S -TRIGGERS-> P。 */
async function seedBridge() {
  insertContract('C1', 'HT-DEMO-001');
  const s = await insertTradeFact(ctx, {
    entityType: 'ServiceCostEvent',
    payload: { eventBizType: '正向', amount: 50_000, currency: 'CNY', costType: '物流' },
    validAt: '2026-06-01', createdBy: 'test',
  }, 'u1');
  const i = await insertTradeFact(ctx, {
    entityType: 'InvoiceEvent',
    payload: { invoiceNo: 'INV-L1', invoiceType: '销项', eventBizType: '正向', amount: 800_000, currency: 'CNY' },
    validAt: '2026-06-10', createdBy: 'test',
  }, 'u1');
  const p = await insertTradeFact(ctx, {
    entityType: 'PaymentEvent',
    payload: { eventBizType: '正向', amount: 300_000, currency: 'CNY', payType: '预付' },
    validAt: '2026-06-20', createdBy: 'test',
  }, 'u1');
  await insertOntologyEdge(ctx, {
    relation: 'ALLOCATE_TO', fromType: 'ServiceCostEvent', fromId: s,
    toType: 'TradeContract', toId: 'C1',
    params: { amount: 50_000, method: '金额' }, validAt: '2026-06-01', createdBy: 'test',
  }, 'u1');
  await insertOntologyEdge(ctx, {
    relation: 'CORRESPONDS_TO', fromType: 'ServiceCostEvent', fromId: s,
    toType: 'InvoiceEvent', toId: i, validAt: '2026-06-10', createdBy: 'test',
  }, 'u1');
  await insertOntologyEdge(ctx, {
    relation: 'TRIGGERS', fromType: 'ServiceCostEvent', fromId: s,
    toType: 'PaymentEvent', toId: p, validAt: '2026-06-20', createdBy: 'test',
  }, 'u1');
  return { s, i, p };
}

describe('getOntologyNeighbors (ontology BFS)', () => {
  it('acceptance 1: invoice + payment reachable within 2 hops from the contract, not 1', async () => {
    const { i, p } = await seedBridge();
    const d2 = await getOntologyNeighbors(ctx, { type: 'TradeContract', id: 'C1', depth: 2 }, 'u1');
    expect(d2.nodes.some((n) => n.entityType === 'InvoiceEvent' && n.id === i)).toBe(true);
    expect(d2.nodes.some((n) => n.entityType === 'PaymentEvent' && n.id === p)).toBe(true);
    const d1 = await getOntologyNeighbors(ctx, { type: 'TradeContract', id: 'C1', depth: 1 }, 'u1');
    const types1 = new Set(d1.nodes.map((n) => n.entityType));
    expect(types1.has('InvoiceEvent')).toBe(false);
    expect(types1.has('PaymentEvent')).toBe(false);
  });

  it('anchor resolves via contract_ledger with contractNo label; edges carry relation + params', async () => {
    await seedBridge();
    const res = await getOntologyNeighbors(ctx, { type: 'TradeContract', id: 'C1', depth: 1 }, 'u1');
    expect(res.anchorNode.label).toBe('HT-DEMO-001');
    expect(res.anchorNode.source).toBe('contract_ledger');
    expect(res.edges).toHaveLength(1);
    expect(res.edges[0]!.relation).toBe('ALLOCATE_TO');
    expect(res.edges[0]!.params).toEqual({ amount: 50_000, method: '金额' });
    expect(res.edges[0]!.origin).toBe('ontology');
  });

  it('fact neighbors resolve with business-key label; REVERSE_ORIGIN traverses bidirectionally', async () => {
    const i1 = await insertTradeFact(ctx, {
      entityType: 'InvoiceEvent',
      payload: { invoiceNo: 'INV-L1', invoiceType: '销项', eventBizType: '正向', amount: 800_000, currency: 'CNY' },
      validAt: '2026-06-10', createdBy: 'test',
    }, 'u1');
    const i2 = await insertTradeFact(ctx, {
      entityType: 'InvoiceEvent',
      payload: { invoiceNo: 'INV-L1', invoiceType: '销项', eventBizType: '逆向', amount: -800_000, currency: 'CNY' },
      validAt: '2026-06-10', ingestedAt: '2026-08-05', createdBy: 'test',
    }, 'u1');
    await insertOntologyEdge(ctx, {
      relation: 'REVERSE_ORIGIN', fromType: 'InvoiceEvent', fromId: i2,
      toType: 'InvoiceEvent', toId: i1, params: { amount: 800_000, reason: '开票信息有误' },
      validAt: '2026-06-10', ingestedAt: '2026-08-05', createdBy: 'test',
    }, 'u1');
    // 从红冲票出发(逆向方向)也能穿到原票
    const res = await getOntologyNeighbors(ctx, { type: 'InvoiceEvent', id: i2, depth: 1 }, 'u1');
    expect(res.anchorNode.label).toBe('INV-L1');
    expect(res.nodes.map((n) => n.id)).toEqual([i1]);
    expect(res.edges[0]!.relation).toBe('REVERSE_ORIGIN');
  });

  it('type mismatch resolves to unresolved, never wrong-typed data (D8)', async () => {
    const { i } = await seedBridge();
    // 发票事实 id 配上 PaymentEvent 类型 -> 不返回 InvoiceEvent 数据
    const res = await getOntologyNeighbors(ctx, { type: 'PaymentEvent', id: i, depth: 1 }, 'u1');
    expect(res.anchorNode.source).toBe('unresolved');
    expect(res.anchorNode.entityType).toBe('PaymentEvent');
    expect(res.edges).toHaveLength(0);
  });

  it('receipt entity doc id must match doc_type (findDocRowById fix)', async () => {
    ctx.sqlite.prepare(
      `INSERT INTO documents (id, doc_type, modality, source_uri, block_model, user_id, review_status, parse_status)
       VALUES ('D1', '发货单', 'text', '/ingest/x.pdf', 'raw', 'u1', 'pending', 'uploaded')`,
    ).run();
    // 收货类型锚点查到发货单 doc id -> 未解析
    const res = await getOntologyNeighbors(ctx, { type: 'GoodsReceiptEvent', id: 'D1', depth: 1 }, 'u1');
    expect(res.anchorNode.source).toBe('unresolved');
  });

  it('user scoping: other-user edges invisible; shared-domain contract still visible', async () => {
    await seedBridge();
    const res = await getOntologyNeighbors(ctx, { type: 'TradeContract', id: 'C1', depth: 2 }, 'u2');
    expect(res.edges).toHaveLength(0);
    expect(res.nodes).toHaveLength(0);
    // 共享域('' user_id)合同对 u2 可见
    expect(res.anchorNode.source).toBe('contract_ledger');
  });

  it('as-of: invalidated edges are excluded (latest business view)', async () => {
    insertContract('C1', 'HT-DEMO-001');
    const s = await insertTradeFact(ctx, {
      entityType: 'ServiceCostEvent',
      payload: { eventBizType: '正向', amount: 50_000, currency: 'CNY', costType: '物流' },
      validAt: '2026-06-01', createdBy: 'test',
    }, 'u1');
    await insertOntologyEdge(ctx, {
      relation: 'ALLOCATE_TO', fromType: 'ServiceCostEvent', fromId: s,
      toType: 'TradeContract', toId: 'C1',
      params: { amount: 50_000, method: '金额' },
      validAt: '2026-06-01', invalidAt: '2026-07-01', createdBy: 'test',
    }, 'u1');
    const res = await getOntologyNeighbors(ctx, { type: 'TradeContract', id: 'C1', depth: 1 }, 'u1');
    expect(res.edges).toHaveLength(0);
    expect(res.nodes).toHaveLength(0);
  });

  it('truncation caps nodes/edges with flag (D4)', async () => {
    await seedBridge();
    const res = await getOntologyNeighbors(
      ctx, { type: 'TradeContract', id: 'C1', depth: 2 }, 'u1', { maxNodes: 1, maxEdges: 0 });
    expect(res.nodes.length).toBeLessThanOrEqual(1);
    expect(res.edges).toHaveLength(0);
    expect(res.truncated).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/ontology/neighbors.test.ts`
Expected: FAIL（模块 `../../src/ontology/neighbors.js` 不存在）

- [ ] **Step 3: 实现 projection.ts 最小改动（导出 + doc_type 过滤）**

行号以 Task 1 前置检查记录为准：

3a. 把 `DOC_TYPE_BY_EVENT`、`findContractRowById`、`findDocRowById`、`factToEntity` 四个声明前加 `export`（各函数注释补一行「Item 4 起邻接穿透复用」）。

3b. `findDocRowById` 的 SQL 补 doc_type 过滤（D8——台账详情单据分支同步受益；Item 3 夹具均用匹配 doc_type，无回归）：

```ts
// 原： const sql = `SELECT id, doc_type, source_uri, review_status, created_at
//                    FROM documents WHERE id = ? AND ${USER_SCOPE_LEGACY}`;
const sql = `SELECT id, doc_type, source_uri, review_status, created_at
               FROM documents WHERE id = ? AND doc_type = ? AND ${USER_SCOPE_LEGACY}`;
```

两分支参数同步补 `DOC_TYPE_BY_EVENT[type]`：

```ts
  if (ctx.backend === 'postgres') {
    const res = await (ctx as PostgresDbContext).pool.query(
      numberPlaceholders(sql), [id, DOC_TYPE_BY_EVENT[type], uid]);
    const row = (res.rows as Array<Record<string, unknown>>)[0];
    return row ? mapDocRow(type, row) : null;
  }
  const row = ctx.sqlite.prepare(sql)
    .get(id, DOC_TYPE_BY_EVENT[type], uid) as Record<string, unknown> | undefined;
  return row ? mapDocRow(type, row) : null;
```

- [ ] **Step 4: 实现 neighbors.ts（首版：本体 BFS + 解析）**

```ts
// apps/server/src/ontology/neighbors.ts
// 链路穿透核心(roadmap Item 4)：本体边 BFS(ontology_edges) + 文档血缘(Neo4j)锚点层融合。
// 只读：本模块零裸 SQL——全部经 repo/projection 既有双后端读路径。
// 边读取口径 = 最新业务口径(asOfBusinessTime(now))，与台账列表一致；
// as-of 时间切片穿透 deferred(详情抽屉已具备两口径)。
import type { DbContext } from '../pipeline/db/client.js';
import { effectiveUserId } from '../pipeline/db/repositories.js';
import { asOfBusinessTime } from './asof.js';
import type { OntologyEntityName } from './index.js';
import { getTradeFactById, listOntologyEdgesAsOf } from './repo.js';
import {
  DOC_TYPE_BY_EVENT, factToEntity, findContractRowById, findDocRowById, type ProjectedEntity,
} from './projection.js';

export interface NeighborRef {
  type: string;
  id: string;
}

export interface NeighborNode {
  id: string;
  /** 注册表实体名 | 'Document'(血缘节点) */
  entityType: string;
  label: string;
  source: 'contract_ledger' | 'documents' | 'trade_facts' | 'neo4j' | 'unresolved';
  props?: Record<string, unknown>;
}

export interface NeighborEdge {
  id: string;
  relation: string;
  origin: 'ontology' | 'lineage';
  fromType: string;
  fromId: string;
  toType: string;
  toId: string;
  params: Record<string, unknown>;
  validAt: string | null;
}

export interface OntologyNeighbors {
  anchor: NeighborRef;
  anchorNode: NeighborNode;
  /** 邻接节点(不含锚点)；血缘 Document 节点(Task 3 起以 source:'neo4j' 并入) */
  nodes: NeighborNode[];
  edges: NeighborEdge[];
  truncated: boolean;
}

/** 防全图爆炸(验收 4)：深度上限(3)之外的响应规模双保险。 */
export const MAX_NEIGHBOR_NODES = 200;
export const MAX_NEIGHBOR_EDGES = 500;
export const MAX_NEIGHBOR_DEPTH = 3;

const refKey = (type: string, id: string) => `${type} ${id}`;

function toNode(e: ProjectedEntity): NeighborNode {
  return { id: e.id, entityType: e.entityType, label: e.label, source: e.source };
}

/** 最佳努力解析引用 -> 展示节点。三源顺序与台账详情一致(事实优先、收发再探单据、合同走台账)。
 *  与详情端点不同(D8)：强制 type 匹配——事实校验 entityType、单据校验 doc_type，
 *  不符按未解析处理(label=id)，绝不返回错型数据。 */
async function resolveBrief(ctx: DbContext, ref: NeighborRef, uid: string): Promise<NeighborNode> {
  if (ref.type === 'TradeContract') {
    const e = await findContractRowById(ctx, ref.id, uid);
    if (e) return toNode(e);
  } else {
    const fact = await getTradeFactById(ctx, ref.id, uid);
    if (fact && fact.entityType === ref.type) return toNode(factToEntity(fact));
    if (ref.type === 'GoodsReceiptEvent' || ref.type === 'GoodsDeliveryEvent') {
      const e = await findDocRowById(
        ctx, ref.id, ref.type as 'GoodsReceiptEvent' | 'GoodsDeliveryEvent', uid);
      if (e) return toNode(e);
    }
  }
  return { id: ref.id, entityType: ref.type, label: ref.id, source: 'unresolved' };
}

/** 本体边 BFS：全量边(最新业务口径, 用户隔离)加载后内存遍历——repo 无按端点查询，
 *  且 projection.reverseOriginCluster 已确立该先例(D6)。BFS 只收集节点，
 *  边集 = 两端均在可达集内的诱导边(语义显然正确)。 */
export async function getOntologyNeighbors(
  ctx: DbContext,
  input: { type: OntologyEntityName; id: string; depth: number },
  userId?: string,
  opts: { maxNodes?: number; maxEdges?: number } = {},
): Promise<OntologyNeighbors> {
  const uid = effectiveUserId(userId);
  const maxNodes = opts.maxNodes ?? MAX_NEIGHBOR_NODES;
  const maxEdges = opts.maxEdges ?? MAX_NEIGHBOR_EDGES;
  const depth = Math.min(Math.max(Math.trunc(input.depth) || 1, 1), MAX_NEIGHBOR_DEPTH);
  const anchor: NeighborRef = { type: input.type, id: input.id };

  const allEdges = await listOntologyEdgesAsOf(ctx, asOfBusinessTime(new Date().toISOString()), {}, uid);

  const seen = new Map<string, NeighborRef>([[refKey(anchor.type, anchor.id), anchor]]);
  let frontier: NeighborRef[] = [anchor];
  for (let hop = 0; hop < depth && frontier.length > 0; hop += 1) {
    const frontierKeys = new Set(frontier.map((r) => refKey(r.type, r.id)));
    const next: NeighborRef[] = [];
    for (const e of allEdges) {
      const fk = refKey(e.fromType, e.fromId);
      const tk = refKey(e.toType, e.toId);
      if (frontierKeys.has(fk) && !seen.has(tk)) {
        seen.set(tk, { type: e.toType, id: e.toId });
        next.push({ type: e.toType, id: e.toId });
      }
      if (frontierKeys.has(tk) && !seen.has(fk)) {
        seen.set(fk, { type: e.fromType, id: e.fromId });
        next.push({ type: e.fromType, id: e.fromId });
      }
    }
    frontier = next;
  }

  const induced = allEdges.filter(
    (e) => seen.has(refKey(e.fromType, e.fromId)) && seen.has(refKey(e.toType, e.toId)),
  );

  const truncated = induced.length > maxEdges || seen.size - 1 > maxNodes;
  const edgeOut: NeighborEdge[] = induced.slice(0, maxEdges).map((e) => ({
    id: e.id,
    relation: e.relation,
    origin: 'ontology' as const,
    fromType: e.fromType,
    fromId: e.fromId,
    toType: e.toType,
    toId: e.toId,
    params: e.params,
    validAt: e.validAt,
  }));

  const refs = [...seen.values()].slice(1, maxNodes + 1);
  const nodes: NeighborNode[] = [];
  for (const ref of refs) {
    nodes.push(await resolveBrief(ctx, ref, uid));
  }

  const anchorNode = await resolveBrief(ctx, anchor, uid);
  return { anchor, anchorNode, nodes, edges: edgeOut, truncated };
}
```

- [ ] **Step 5: 跑测试确认通过 + 既有投影/台账测试无回归 + commit**

Run: `npm test --workspace apps/server -- test/ontology/neighbors.test.ts test/ontology/projection.test.ts test/routes/ontologyEntities.test.ts && npm run build && npm run lint`
Expected: 新用例 PASS；projection/ontologyEntities 既有用例不回归（doc_type 过滤只影响错型查询路径）

```bash
git add apps/server/src/ontology/neighbors.ts apps/server/src/ontology/projection.ts apps/server/test/ontology/neighbors.test.ts
git commit -m "feat(ontology): neighbors BFS core with strict anchor type matching"
```

---

### Task 3: 血缘融合——Neo4j 锚点层邻接 + 优雅降级（getNeighbors）

**Files:**
- Modify: `apps/server/src/ontology/neighbors.ts`（追加血缘融合 + `getNeighbors` 总入口）
- Test: `apps/server/test/ontology/neighborsLineage.test.ts`

**Interfaces:**
- Consumes: `findEntities`/`graphQuery`/`GraphEntity`（graph/repo.js）、`normalizeName`（graph/normalize.js）、Task 2 的 `getOntologyNeighbors`。
- Produces: `LineageStatus { available: boolean; subjectFound: boolean }`；`NeighborsResult = OntologyNeighbors & { lineage: LineageStatus }`；`getNeighbors(ctx, input, userId?, opts?): Promise<NeighborsResult>`（Task 4 路由唯一入口）。血缘节点 `source:'neo4j'`、`entityType:'Document'` 并入 `nodes`；血缘边 `origin:'lineage'`、`relation`=图边类型（CONTAINS/executes/references...）并入 `edges`，端点 id = docId（合同锚点侧 = 台账合同 id）。

- [ ] **Step 1: 写失败测试（vi.mock graph/repo，照抄 graphSchema.test.ts 形态）**

```ts
// apps/server/test/ontology/neighborsLineage.test.ts
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';

const graphRepoMocks = vi.hoisted(() => ({
  findEntities: vi.fn(),
  graphQuery: vi.fn(),
}));
vi.mock('../../src/graph/repo.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/graph/repo.js')>();
  return { ...mod, ...graphRepoMocks };
});
const { getNeighbors } = await import('../../src/ontology/neighbors.js');
const { insertTradeFact, insertOntologyEdge } = await import('../../src/ontology/repo.js');

let ctx: DbContext;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
  graphRepoMocks.findEntities.mockReset();
  graphRepoMocks.graphQuery.mockReset();
  process.env.NEO4J_PASSWORD = 'test-set';
});
afterEach(() => {
  delete process.env.NEO4J_PASSWORD;
});

const insertContract = (id: string, contractNo: string) => {
  ctx.sqlite.prepare(
    `INSERT INTO contract_ledger (id, contract_no, display_contract_no, doc_type, document_id,
        title, fields, field_meta, overall_confidence, needs_review, user_id, contract_type)
     VALUES (?, ?, ?, '合同', 'doc-1', '', '{}', '{}', 1, 0, '', '采购')`,
  ).run(id, contractNo, contractNo);
};

const G_ENTITY = (elementId: string, name: string, props: Record<string, unknown> = {}) =>
  ({ elementId, kind: props['batchRole'] ? 'Document' : 'Contract', name, props });

describe('getNeighbors lineage merge (mocked graph)', () => {
  it('contract anchor merges Neo4j document neighborhood keyed by docId', async () => {
    insertContract('C1', 'HT-DEMO-001');
    // 合同锚点：无本体边，纯血缘(findEntities 命中与否由 normalizeName 查询决定，此处直接回一个命中)
    graphRepoMocks.findEntities.mockResolvedValue([
      G_ENTITY('e-contract', 'ht-demo-001'),
    ]);
    graphRepoMocks.graphQuery.mockResolvedValue({
      subject: G_ENTITY('e-contract', 'ht-demo-001'),
      nodes: [
        G_ENTITY('e-d1', 'doc-uuid-1', { docId: 'doc-uuid-1', docType: '发票' }),
        G_ENTITY('e-d2', 'doc-uuid-2', { docId: 'doc-uuid-2', docType: '收货单' }),
      ],
      edges: [
        { elementId: 're-1', type: 'references', srcId: 'e-contract', dstId: 'e-d1', props: {}, confidence: 0.9 },
        { elementId: 're-2', type: 'executes', srcId: 'e-contract', dstId: 'e-d2', props: {}, confidence: 0.8 },
      ],
    });

    const res = await getNeighbors(ctx, { type: 'TradeContract', id: 'C1', depth: 1 }, 'u1');
    expect(res.lineage).toEqual({ available: true, subjectFound: true });
    const docNodes = res.nodes.filter((n) => n.source === 'neo4j');
    expect(docNodes.map((n) => n.id).sort()).toEqual(['doc-uuid-1', 'doc-uuid-2']);
    expect(docNodes.every((n) => n.entityType === 'Document')).toBe(true);
    const lineageEdges = res.edges.filter((e) => e.origin === 'lineage');
    expect(lineageEdges).toHaveLength(2);
    const ref = lineageEdges.find((e) => e.relation === 'references')!;
    expect(ref.fromId).toBe('C1');           // 合同锚点侧映射回台账 id
    expect(ref.toId).toBe('doc-uuid-1');     // 文档侧映射回 docId
  });

  it('document anchor traverses CONTAINS lineage only (edgeKinds, D7)', async () => {
    ctx.sqlite.prepare(
      `INSERT INTO documents (id, doc_type, modality, source_uri, block_model, user_id, review_status, parse_status)
       VALUES ('D1', '收货单', 'text', '/ingest/x.pdf', 'raw', 'u1', 'pending', 'uploaded')`,
    ).run();
    graphRepoMocks.findEntities.mockResolvedValue([G_ENTITY('e-d1', 'D1', { docId: 'D1' })]);
    graphRepoMocks.graphQuery.mockResolvedValue({
      subject: G_ENTITY('e-d1', 'D1', { docId: 'D1' }),
      nodes: [G_ENTITY('e-u1', 'unit-1', { docId: 'unit-1', batchRole: 'unit' })],
      edges: [{ elementId: 'rc-1', type: 'CONTAINS', srcId: 'e-d1', dstId: 'e-u1',
        props: { unitIndex: 1, pages: 'p1-p3' }, confidence: 0 }],
    });

    const res = await getNeighbors(ctx, { type: 'GoodsReceiptEvent', id: 'D1', depth: 1 }, 'u1');
    expect(graphRepoMocks.graphQuery.mock.calls[0]![0]).toMatchObject({
      subjectId: 'e-d1', edgeKinds: ['CONTAINS'], direction: 'both',
    });
    expect(res.nodes.some((n) => n.id === 'unit-1' && n.label === '拆单单元')).toBe(true);
    const contains = res.edges.find((e) => e.relation === 'CONTAINS')!;
    expect(contains.params).toEqual({ unitIndex: 1, pages: 'p1-p3' });
  });

  it('event anchors never touch the graph (no TF counterpart)', async () => {
    const fid = await insertTradeFact(ctx, {
      entityType: 'InvoiceEvent',
      payload: { invoiceNo: 'INV-1', invoiceType: '销项', eventBizType: '正向', amount: 1, currency: 'CNY' },
      validAt: '2026-06-10', createdBy: 'test',
    }, 'u1');
    await getNeighbors(ctx, { type: 'InvoiceEvent', id: fid, depth: 1 }, 'u1');
    expect(graphRepoMocks.findEntities).not.toHaveBeenCalled();
    expect(graphRepoMocks.graphQuery).not.toHaveBeenCalled();
  });

  it('no graph subject -> subjectFound false, still available', async () => {
    insertContract('C1', 'HT-DEMO-001');
    graphRepoMocks.findEntities.mockResolvedValue([]);
    const res = await getNeighbors(ctx, { type: 'TradeContract', id: 'C1', depth: 1 }, 'u1');
    expect(res.lineage).toEqual({ available: true, subjectFound: false });
    expect(graphRepoMocks.graphQuery).not.toHaveBeenCalled();
  });

  it('NEO4J_PASSWORD unset -> graceful degradation, ontology part intact (D5)', async () => {
    delete process.env.NEO4J_PASSWORD;
    insertContract('C1', 'HT-DEMO-001');
    const s = await insertTradeFact(ctx, {
      entityType: 'ServiceCostEvent',
      payload: { eventBizType: '正向', amount: 50_000, currency: 'CNY', costType: '物流' },
      validAt: '2026-06-01', createdBy: 'test',
    }, 'u1');
    await insertOntologyEdge(ctx, {
      relation: 'ALLOCATE_TO', fromType: 'ServiceCostEvent', fromId: s,
      toType: 'TradeContract', toId: 'C1',
      params: { amount: 50_000, method: '金额' }, validAt: '2026-06-01', createdBy: 'test',
    }, 'u1');
    const res = await getNeighbors(ctx, { type: 'TradeContract', id: 'C1', depth: 1 }, 'u1');
    expect(res.lineage).toEqual({ available: false, subjectFound: false });
    expect(res.edges).toHaveLength(1);   // 本体部分照常
    expect(graphRepoMocks.findEntities).not.toHaveBeenCalled();
  });

  it('graph layer failure does not sink the ontology adjacency', async () => {
    insertContract('C1', 'HT-DEMO-001');
    graphRepoMocks.findEntities.mockRejectedValue(new Error('Neo4jError: connection refused'));
    const res = await getNeighbors(ctx, { type: 'TradeContract', id: 'C1', depth: 1 }, 'u1');
    expect(res.lineage.available).toBe(false);
    expect(res.anchorNode.source).toBe('contract_ledger');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/ontology/neighborsLineage.test.ts`
Expected: FAIL（`getNeighbors` 未导出）

- [ ] **Step 3: 实现（neighbors.ts 追加）**

import 区补：

```ts
import { findEntities, graphQuery, type GraphEntity } from '../graph/repo.js';
import { normalizeName } from '../graph/normalize.js';
```

文件末尾追加：

```ts
// ---------------------------------------------------------------------------
// 文档血缘(Neo4j)锚点层融合(D7)：
//   TradeContract 锚点 -> Contract 图节点(name=normalizeName(contractNo))，
//     graphQuery 不限 edgeKinds(取 executes/references 等文档邻域，承载主链可穿)；
//   收/发单据锚点 -> Document 图节点(name=docId)，edgeKinds=['CONTAINS'](批拆血缘)。
//   事件实体(TF id)无图节点，不融合。跨空间逐跳展开 deferred(需稳定桥表)。
// 降级(D5)：NEO4J_PASSWORD 未设或图故障 -> lineage.available=false，本体部分照常；
//   图锚点不存在 -> subjectFound=false(正常态，如演示合同无上传文档)。
// ---------------------------------------------------------------------------

export interface LineageStatus {
  /** Neo4j 可达且查询已执行(密码未设/连接失败 = false)。 */
  available: boolean;
  /** 锚点在图中找到对应节点。 */
  subjectFound: boolean;
}

export interface NeighborsResult extends OntologyNeighbors {
  lineage: LineageStatus;
}

async function lineageSubjectElementId(
  ctx: DbContext, type: OntologyEntityName, id: string, uid: string,
): Promise<{ elementId: string; edgeKinds?: string[] } | null> {
  if (type === 'TradeContract') {
    const contract = await findContractRowById(ctx, id, uid);
    const contractNo = String(contract?.fields['contractNo'] ?? '');
    if (!contract || !contractNo) return null;
    const hits = await findEntities({ kind: 'Contract', name: normalizeName(contractNo), exact: true });
    return hits[0] ? { elementId: hits[0].elementId } : null;   // 不限 edgeKinds
  }
  if (type === 'GoodsReceiptEvent' || type === 'GoodsDeliveryEvent') {
    const doc = await findDocRowById(ctx, id, type, uid);
    if (!doc) return null;
    const hits = await findEntities({ kind: 'Document', name: doc.id, exact: true });
    return hits[0] ? { elementId: hits[0].elementId, edgeKinds: ['CONTAINS'] } : null;
  }
  return null;
}

function docIdOfGraphNode(n: GraphEntity): string {
  const p = n.props?.['docId'];
  return typeof p === 'string' && p ? p : n.name;
}

function docLabel(n: GraphEntity): string {
  const dt = n.props?.['docType'];
  if (typeof dt === 'string' && dt) return dt;
  const role = n.props?.['batchRole'];
  if (role === 'container') return '单据组';
  if (role === 'unit') return '拆单单元';
  return n.name.slice(0, 12);
}

/** 邻接总入口(路由唯一消费方)：本体 BFS + 血缘锚点层融合。 */
export async function getNeighbors(
  ctx: DbContext,
  input: { type: OntologyEntityName; id: string; depth: number },
  userId?: string,
  opts: { maxNodes?: number; maxEdges?: number } = {},
): Promise<NeighborsResult> {
  const uid = effectiveUserId(userId);
  const result = await getOntologyNeighbors(ctx, input, uid, opts);
  const lineage: LineageStatus = { available: false, subjectFound: false };

  if (process.env.NEO4J_PASSWORD) {
    try {
      const subject = await lineageSubjectElementId(ctx, input.type, input.id, uid);
      if (subject) {
        const res = await graphQuery({
          subjectId: subject.elementId,
          depth: Math.min(Math.max(Math.trunc(input.depth) || 1, 1), MAX_NEIGHBOR_DEPTH),
          direction: 'both',
          ...(subject.edgeKinds ? { edgeKinds: subject.edgeKinds } : {}),
        });
        // elementId -> 业务 id 映射(合同锚点侧 = 台账 id, 文档侧 = docId)
        const infoByElementId = new Map<string, { id: string; type: string }>([
          [subject.elementId, { id: input.id, type: input.type }],
        ]);
        for (const n of res.nodes) {
          infoByElementId.set(n.elementId, { id: docIdOfGraphNode(n), type: 'Document' });
          result.nodes.push({
            id: docIdOfGraphNode(n),
            entityType: 'Document',
            label: docLabel(n),
            source: 'neo4j',
            props: {
              docType: n.props?.['docType'] ?? null,
              batchRole: n.props?.['batchRole'] ?? null,
            },
          });
        }
        for (const e of res.edges) {
          const from = infoByElementId.get(e.srcId);
          const to = infoByElementId.get(e.dstId);
          if (!from || !to) continue;   // 端点不在结果集(截断/异类)则弃边
          result.edges.push({
            id: `lineage ${e.elementId}`,
            relation: e.type,
            origin: 'lineage',
            fromType: from.type,
            fromId: from.id,
            toType: to.type,
            toId: to.id,
            params: e.props ?? {},
            validAt: null,
          });
        }
        lineage.subjectFound = true;
      }
      lineage.available = true;
    } catch (e) {
      // 血缘层故障不拖垮本体邻接(D5)：合并端点的部分可用是有意义的。
      console.warn('[ontology/neighbors] lineage merge skipped:',
        e instanceof Error ? e.message : e);
    }
  }
  return { ...result, lineage };
}
```

- [ ] **Step 4: 跑测试确认通过 + 全量回归 + commit**

Run: `npm test --workspace apps/server -- test/ontology/ && npm run build && npm run lint && npm test`
Expected: PASS + 全绿

```bash
git add apps/server/src/ontology/neighbors.ts apps/server/test/ontology/neighborsLineage.test.ts
git commit -m "feat(ontology): merge Neo4j lineage adjacency into neighbors with graceful degradation"
```

---

### Task 4: 路由 `GET /api/ontology/graph/neighbors`

**Files:**
- Modify: `apps/server/src/routes/ontology.ts`（追加路由）
- Test: `apps/server/test/routes/ontologyNeighbors.test.ts`

**Interfaces:**
- Consumes: `getNeighbors`（Task 3）、`OntologyEntityNameSchema`（注册表）、既有 `appAs`/`ctxHolder` 测试形态。
- Produces: `GET /api/ontology/graph/neighbors?type=<entityType>&id=<id>&depth=1..3` → 200 `NeighborsResult`；type 非注册表 → 400；depth 越界 → 400；未认证 → 401；锚点未解析且零邻接 → 404。

- [ ] **Step 1: 写失败测试（照抄 ontologyEntities.test.ts 全套形态）**

```ts
// apps/server/test/routes/ontologyNeighbors.test.ts
import { describe, it, expect, beforeEach, vi, beforeAll, afterAll } from 'vitest';
import { Hono } from 'hono';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import type { AuthEnv } from '../../src/lib/auth-middleware.js';

const { ctxHolder } = vi.hoisted(() => ({ ctxHolder: { current: null as DbContext | null } }));
vi.mock('../../src/pipeline/db/dbBackend.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/pipeline/db/dbBackend.js')>();
  return { ...mod, getDbContext: () => ctxHolder.current };
});
const { ontologyRoute } = await import('../../src/routes/ontology.js');
const { insertTradeFact, insertOntologyEdge } = await import('../../src/ontology/repo.js');

function appAs(userId: string) {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { id: userId, email: 't@t', role: 'trader' } as never);
    await next();
  });
  app.route('/api/ontology', ontologyRoute);
  return app;
}

// 路由测试与 Neo4j 解耦：强制走降级分支(D5)，lineage.available 恒 false
let savedPassword: string | undefined;
beforeAll(() => { savedPassword = process.env.NEO4J_PASSWORD; delete process.env.NEO4J_PASSWORD; });
afterAll(() => { if (savedPassword !== undefined) process.env.NEO4J_PASSWORD = savedPassword; });

let ctx: DbContext;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
  ctxHolder.current = ctx;
});

const insertContract = (id: string, contractNo: string) => {
  ctx.sqlite.prepare(
    `INSERT INTO contract_ledger (id, contract_no, display_contract_no, doc_type, document_id,
        title, fields, field_meta, overall_confidence, needs_review, user_id, contract_type)
     VALUES (?, ?, ?, '合同', 'doc-1', '', '{}', '{}', 1, 0, '', '采购')`,
  ).run(id, contractNo, contractNo);
};

async function seedBridge() {
  insertContract('C1', 'HT-DEMO-001');
  const s = await insertTradeFact(ctx, {
    entityType: 'ServiceCostEvent',
    payload: { eventBizType: '正向', amount: 50_000, currency: 'CNY', costType: '物流' },
    validAt: '2026-06-01', createdBy: 'test',
  }, 'u1');
  const i = await insertTradeFact(ctx, {
    entityType: 'InvoiceEvent',
    payload: { invoiceNo: 'INV-L1', invoiceType: '销项', eventBizType: '正向', amount: 800_000, currency: 'CNY' },
    validAt: '2026-06-10', createdBy: 'test',
  }, 'u1');
  const p = await insertTradeFact(ctx, {
    entityType: 'PaymentEvent',
    payload: { eventBizType: '正向', amount: 300_000, currency: 'CNY', payType: '预付' },
    validAt: '2026-06-20', createdBy: 'test',
  }, 'u1');
  await insertOntologyEdge(ctx, {
    relation: 'ALLOCATE_TO', fromType: 'ServiceCostEvent', fromId: s,
    toType: 'TradeContract', toId: 'C1',
    params: { amount: 50_000, method: '金额' }, validAt: '2026-06-01', createdBy: 'test',
  }, 'u1');
  await insertOntologyEdge(ctx, {
    relation: 'CORRESPONDS_TO', fromType: 'ServiceCostEvent', fromId: s,
    toType: 'InvoiceEvent', toId: i, validAt: '2026-06-10', createdBy: 'test',
  }, 'u1');
  await insertOntologyEdge(ctx, {
    relation: 'TRIGGERS', fromType: 'ServiceCostEvent', fromId: s,
    toType: 'PaymentEvent', toId: p, validAt: '2026-06-20', createdBy: 'test',
  }, 'u1');
  return { s, i, p };
}

describe('GET /api/ontology/graph/neighbors', () => {
  it('401 without session', async () => {
    const app = new Hono<AuthEnv>();
    app.route('/api/ontology', ontologyRoute);
    const res = await app.request(
      'http://test/api/ontology/graph/neighbors?type=TradeContract&id=C1');
    expect(res.status).toBe(401);
  });

  it('400 for type outside registry / depth over cap (acceptance 4)', async () => {
    const app = appAs('u1');
    const badType = await app.request(
      'http://test/api/ontology/graph/neighbors?type=Nope&id=x');
    expect(badType.status).toBe(400);
    await seedBridge();
    const badDepth = await app.request(
      'http://test/api/ontology/graph/neighbors?type=TradeContract&id=C1&depth=4');
    expect(badDepth.status).toBe(400);
  });

  it('404 when anchor resolves to nothing and no adjacency', async () => {
    const res = await appAs('u1').request(
      'http://test/api/ontology/graph/neighbors?type=TradeContract&id=C-nope&depth=1');
    expect(res.status).toBe(404);
  });

  it('returns merged shape with lineage degraded (acceptance 1 through the API)', async () => {
    const { i, p } = await seedBridge();
    const res = await appAs('u1').request(
      'http://test/api/ontology/graph/neighbors?type=TradeContract&id=C1&depth=2');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      anchorNode: { label: string; source: string };
      nodes: Array<{ id: string; entityType: string }>;
      edges: Array<{ relation: string; origin: string }>;
      lineage: { available: boolean; subjectFound: boolean };
      truncated: boolean;
    };
    expect(body.anchorNode.label).toBe('HT-DEMO-001');
    expect(body.nodes.some((n) => n.id === i && n.entityType === 'InvoiceEvent')).toBe(true);
    expect(body.nodes.some((n) => n.id === p && n.entityType === 'PaymentEvent')).toBe(true);
    expect(body.edges.every((e) => e.origin === 'ontology')).toBe(true);
    expect(body.lineage).toEqual({ available: false, subjectFound: false });
    expect(body.truncated).toBe(false);
  });

  it('user scoping through the route', async () => {
    await seedBridge();
    const res = await appAs('u2').request(
      'http://test/api/ontology/graph/neighbors?type=TradeContract&id=C1&depth=2');
    // 共享域合同可解析, 但 u1 的边不可见 -> 锚点可解析故 200, 零邻接
    expect(res.status).toBe(200);
    const body = (await res.json()) as { edges: unknown[] };
    expect(body.edges).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/routes/ontologyNeighbors.test.ts`
Expected: FAIL（路由不存在，全部 404）

- [ ] **Step 3: 实现（routes/ontology.ts 追加）**

import 区补：

```ts
import { getNeighbors } from '../ontology/neighbors.js';
```

文件末尾追加：

```ts
const neighborsQuerySchema = z.object({
  type: OntologyEntityNameSchema,
  id: z.string().trim().min(1).max(200),
  depth: z.coerce.number().int().min(1).max(3).default(1),
});

/** GET /graph/neighbors — 链路穿透(roadmap Item 4)：本体边 BFS + 文档血缘锚点层融合。
 *  depth 上限 3 + 节点/边截断(防全图爆炸)；血缘不可用时优雅降级(D5)。 */
ontologyRoute.get('/graph/neighbors', async (c) => {
  const user = c.get('user')!;
  const parsed = neighborsQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json(
      { error: 'invalid query params', detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) },
      400,
    );
  }
  try {
    const res = await getNeighbors(getDbContext(), parsed.data, user.id);
    // 锚点未解析且零邻接 -> 404；悬空锚点但有边(如 Counterparty + PROVIDE)仍返回(D8)
    if (res.anchorNode.source === 'unresolved' && res.edges.length === 0 && !res.lineage.subjectFound) {
      return c.json({ error: 'not found' }, 404);
    }
    return c.json(res);
  } catch (e) {
    console.error('[ontology] neighbors failed:', errDetail(e));
    return c.json({ error: 'neighbors failed', detail: errDetail(e) }, 500);
  }
});
```

- [ ] **Step 4: 跑测试确认通过 + commit**

Run: `npm test --workspace apps/server -- test/routes/ontologyNeighbors.test.ts && npm run build && npm run lint`
Expected: PASS

```bash
git add apps/server/src/routes/ontology.ts apps/server/test/routes/ontologyNeighbors.test.ts
git commit -m "feat(ontology): GET /api/ontology/graph/neighbors route"
```

---

### Task 5: 种子脚本（主链 + 服务费桥 + 红冲 + 核销/冲抵参数）

**Files:**
- Create: `apps/server/scripts/seedLineageTraverseDemo.ts`

**Interfaces:**
- Consumes: `insertTradeFact`/`insertOntologyEdge`（repo.js——M-1 strict 写入边界，连接对/params 不合法直接 throw，种子即写入边界验证）、`getDbContext`（dbBackend.js）。
- Produces: 验收 1/2 演示数据（幂等，`created_by = 'demo-lineage'` 标记探测）；合同行直插 `contract_ledger`（无写入 API，照抄 projection 测试的 INSERT 形态）。

- [ ] **Step 1: 种子脚本**

```ts
// apps/server/scripts/seedLineageTraverseDemo.ts
// 链路穿透演示数据(roadmap Item 4 验收 1/2)：
//   合同 C1；服务费桥(保 2 跳可达发票/付款, D9)：S -ALLOCATE_TO-> C1、
//   S -CORRESPONDS_TO-> I1、S -TRIGGERS-> P1；
//   完整主链(保 depth=3 一眼可穿)：R(收货) -ALLOCATE_TO-> C1、R -FEEDS_INTO-> St、
//   St -CORRESPONDS_TO-> I1；核销/冲抵带参：P1 -WRITE_OFF-> I1、P1 -OFFSET_SETTLE-> St；
//   红冲：I2 -REVERSE_ORIGIN-> I1(逆向负数)。
// 幂等：created_by 标记探测，已存在即跳过。RUN(项目根)：
//   npx tsx apps/server/scripts/seedLineageTraverseDemo.ts --dry-run   # 预览
//   npx tsx apps/server/scripts/seedLineageTraverseDemo.ts            # 写入
// 注意：写入的是 .env 指向的库(10.10.0.2 为 PG)；本地默认 SQLite。
// 事实/边一律走 insertTradeFact/insertOntologyEdge(M-1 strict 边界)；
// 合同行无写入 API，直插 contract_ledger(与 projection 测试同形态, user_id='' 共享域)。
import 'dotenv/config';
import { getDbContext } from '../src/pipeline/db/dbBackend.js';
import type { DbContext } from '../src/pipeline/db/client.js';
import type { TradeFactInput, OntologyEdgeInput } from '../src/ontology/repo.js';
import { insertTradeFact, insertOntologyEdge } from '../src/ontology/repo.js';

const MARKER = 'demo-lineage';
const CONTRACT_ID = 'C-DEMO-LIN';
const CONTRACT_NO = 'HT-DEMO-LIN-001';

async function countSeeded(ctx: DbContext): Promise<string> {
  if (ctx.backend === 'postgres') {
    const pg = ctx as { pool: { query: (sql: string) => Promise<{ rows: Array<{ n: string }> }> } };
    const res = await pg.pool.query(
      `SELECT COUNT(*)::text AS n FROM ontology_edges WHERE created_by = '${MARKER}'`);
    return res.rows[0]!.n;
  }
  const sqlite = ctx as { sqlite: { prepare: (sql: string) => { get: () => { n: number } } } };
  return String(sqlite
    .prepare(`SELECT COUNT(*) AS n FROM ontology_edges WHERE created_by = '${MARKER}'`).get().n);
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const ctx = getDbContext();
  const existing = await countSeeded(ctx);
  if (existing !== '0') {
    console.log(`demo lineage already seeded (${existing} edges), skip.`);
    return;
  }

  const plan = [
    `contract ${CONTRACT_ID} (${CONTRACT_NO})`,
    'R 收货 500,000 + ALLOCATE_TO->C1 + FEEDS_INTO->St',
    'St 结算 600,000 + CORRESPONDS_TO->I1',
    'I1 发票 800,000(正向)',
    'I2 红冲 -800,000 + REVERSE_ORIGIN->I1',
    'P1 付款 300,000(预付) + WRITE_OFF->I1 + OFFSET_SETTLE->St',
    'S 服务费 50,000 + ALLOCATE_TO->C1 + CORRESPONDS_TO->I1 + TRIGGERS->P1',
  ];
  console.log(dryRun ? '[dry-run] would insert:' : 'inserting:');
  for (const p of plan) console.log('  -', p);
  if (dryRun) return;

  // 合同行(共享域 user_id='')
  if (ctx.backend === 'postgres') {
    const pg = ctx as { pool: { query: (sql: string, vals: unknown[]) => Promise<unknown> } };
    await pg.pool.query(
      `INSERT INTO contract_ledger (id, contract_no, display_contract_no, doc_type, document_id,
          title, fields, field_meta, overall_confidence, needs_review, user_id, contract_type)
       VALUES ($1, $2, $2, '合同', 'doc-demo-lin', '链路穿透演示合同', '{}'::jsonb, '{}'::jsonb, 1, false, '', '采购')
       ON CONFLICT (id) DO NOTHING`,
      [CONTRACT_ID, CONTRACT_NO],
    );
  } else {
    const sqlite = ctx as { sqlite: { prepare: (sql: string) => { run: (...v: unknown[]) => unknown } } };
    sqlite.sqlite.prepare(
      `INSERT OR IGNORE INTO contract_ledger (id, contract_no, display_contract_no, doc_type, document_id,
          title, fields, field_meta, overall_confidence, needs_review, user_id, contract_type)
       VALUES (?, ?, ?, '合同', 'doc-demo-lin', '链路穿透演示合同', '{}', '{}', 1, 0, '', '采购')`,
    ).run(CONTRACT_ID, CONTRACT_NO, CONTRACT_NO);
  }

  const U = '';  // 共享域(与 seedTradeLedgerDemo 一致)
  const mk = (entityType: TradeFactInput['entityType'], payload: Record<string, unknown>, validAt: string) =>
    insertTradeFact(ctx, { entityType, payload, validAt, createdBy: MARKER } as TradeFactInput, U);

  const r = await mk('GoodsReceiptEvent',
    { eventBizType: '正向', amount: 500_000, currency: 'CNY', quantity: 100, unit: '吨' }, '2026-06-05');
  const st = await mk('SettlementEvent',
    { eventBizType: '正向', amount: 600_000, currency: 'CNY', settledQuantity: 100, unit: '吨' }, '2026-06-15');
  const i1 = await mk('InvoiceEvent',
    { invoiceNo: 'INV-LIN-1', invoiceType: '销项', eventBizType: '正向', amount: 800_000, currency: 'CNY' }, '2026-06-20');
  const i2 = await mk('InvoiceEvent',
    { invoiceNo: 'INV-LIN-1', invoiceType: '销项', eventBizType: '逆向', amount: -800_000, currency: 'CNY' }, '2026-06-20');
  const p1 = await mk('PaymentEvent',
    { eventBizType: '正向', amount: 300_000, currency: 'CNY', payType: '预付' }, '2026-06-25');
  const s = await mk('ServiceCostEvent',
    { eventBizType: '正向', amount: 50_000, currency: 'CNY', costType: '物流' }, '2026-06-01');

  const edge = (input: Omit<OntologyEdgeInput, 'createdBy'>) =>
    insertOntologyEdge(ctx, { ...input, createdBy: MARKER }, U);

  await edge({ relation: 'ALLOCATE_TO', fromType: 'GoodsReceiptEvent', fromId: r,
    toType: 'TradeContract', toId: CONTRACT_ID,
    params: { amount: 500_000, ratio: 0.625, method: '金额', batch: 'B-LIN-1' }, validAt: '2026-06-05' });
  await edge({ relation: 'FEEDS_INTO', fromType: 'GoodsReceiptEvent', fromId: r,
    toType: 'SettlementEvent', toId: st, validAt: '2026-06-15' });
  await edge({ relation: 'CORRESPONDS_TO', fromType: 'SettlementEvent', fromId: st,
    toType: 'InvoiceEvent', toId: i1, validAt: '2026-06-20' });
  await edge({ relation: 'REVERSE_ORIGIN', fromType: 'InvoiceEvent', fromId: i2,
    toType: 'InvoiceEvent', toId: i1,
    params: { amount: 800_000, reason: '开票信息有误' }, validAt: '2026-06-20', ingestedAt: '2026-08-05' });
  await edge({ relation: 'WRITE_OFF', fromType: 'PaymentEvent', fromId: p1,
    toType: 'InvoiceEvent', toId: i1,
    params: { amount: 300_000, partial: true, batch: 'WO-LIN-1' }, validAt: '2026-06-25' });
  await edge({ relation: 'OFFSET_SETTLE', fromType: 'PaymentEvent', fromId: p1,
    toType: 'SettlementEvent', toId: st,
    params: { amount: 200_000, batch: 'OS-LIN-1' }, validAt: '2026-06-25' });
  await edge({ relation: 'ALLOCATE_TO', fromType: 'ServiceCostEvent', fromId: s,
    toType: 'TradeContract', toId: CONTRACT_ID,
    params: { amount: 50_000, method: '定额' }, validAt: '2026-06-01' });
  await edge({ relation: 'CORRESPONDS_TO', fromType: 'ServiceCostEvent', fromId: s,
    toType: 'InvoiceEvent', toId: i1, validAt: '2026-06-20' });
  await edge({ relation: 'TRIGGERS', fromType: 'ServiceCostEvent', fromId: s,
    toType: 'PaymentEvent', toId: p1, validAt: '2026-06-25' });

  console.log(`contract = ${CONTRACT_ID} (${CONTRACT_NO})`);
  console.log('验收 1(2 跳可达发票/付款)：');
  console.log(`  curl -b <auth> 'http://localhost:3001/api/ontology/graph/neighbors?type=TradeContract&id=${CONTRACT_ID}&depth=2'`);
  console.log('验收 4(深度上限)：');
  console.log(`  curl -b <auth> '...&depth=4'  # 预期 400`);
}
void main().catch((e) => { console.error(e); process.exit(1); });
```

（严格 TS 过 `tsc -p tsconfig.scripts.json`；`TradeFactInput['entityType']` 即 `OntologyEntityName`——若 repo.ts 未导出 input 类型则直接 import `OntologyEntityName` 并内联字段类型；联合类型窄化写法若报错，按 `repo.ts` 的 `if (ctx.backend === 'postgres')` 早返回模式改写——以编译过为准。）

- [ ] **Step 2: dry-run 验证 + 本地写入冒烟（幂等）**

Run（项目根，本地默认 SQLite）:
```bash
npx tsx apps/server/scripts/seedLineageTraverseDemo.ts --dry-run
npx tsx apps/server/scripts/seedLineageTraverseDemo.ts
npx tsx apps/server/scripts/seedLineageTraverseDemo.ts   # 第二次应 skip
```
Expected: dry-run 打印 7 行计划；写入成功打印合同号与验收 curl；第二次 `already seeded ... skip.`

- [ ] **Step 3: commit**

```bash
git add apps/server/scripts/seedLineageTraverseDemo.ts
git commit -m "feat(ontology): lineage-traverse demo seed (main chain + service bridge + red flush)"
```

---

### Task 6: web——邻接 API client + 关系配色/标签/图例常量

**Files:**
- Modify: `apps/web/src/api/ontology.ts`（fetchOntologyNeighbors + DTO）
- Modify: `apps/web/src/components/graph/businessTypes.ts`（EDGE_STYLE_OVERRIDES/EDGE_LABELS 扩展 + 本体实体 KIND_STYLES + 图例数据）

**Interfaces:**
- Produces:
  - `NeighborsResultDTO`（与 Task 4 响应字段一致）；`fetchOntologyNeighbors(type, id, depth=1): Promise<NeighborsResultDTO>`
  - `EDGE_STYLE_OVERRIDES` 扩展 9 键（4 带参关系实色 + 4 辅助灰虚线 + CONTAINS 灰虚线）；`EDGE_LABELS` 扩展 9 键；`KIND_STYLES` 扩展 11 实体键（D3 色值）；`ONTOLOGY_EDGE_LEGEND`（图例数据源）

（web 无单测设施——与 Item 3 计划一致：以 `npm run build` 的 tsc + 手动 dev 验证为准。）

- [ ] **Step 1: api/ontology.ts 追加**

```ts
export interface NeighborNodeDTO {
  id: string;
  entityType: string;
  label: string;
  source: 'contract_ledger' | 'documents' | 'trade_facts' | 'neo4j' | 'unresolved';
  props?: Record<string, unknown>;
}

export interface NeighborEdgeDTO {
  id: string;
  relation: string;
  origin: 'ontology' | 'lineage';
  fromType: string;
  fromId: string;
  toType: string;
  toId: string;
  params: Record<string, unknown>;
  validAt: string | null;
}

export interface NeighborsResultDTO {
  anchor: { type: string; id: string };
  anchorNode: NeighborNodeDTO;
  nodes: NeighborNodeDTO[];
  edges: NeighborEdgeDTO[];
  lineage: { available: boolean; subjectFound: boolean };
  truncated: boolean;
}

export function fetchOntologyNeighbors(
  type: string, id: string, depth = 1,
): Promise<NeighborsResultDTO> {
  const params = new URLSearchParams({ type, id, depth: String(depth) });
  return request<NeighborsResultDTO>(`/api/ontology/graph/neighbors?${params.toString()}`);
}
```

- [ ] **Step 2: businessTypes.ts 扩展**

`EDGE_LABELS` 追加（既有 8 键不动）：

```ts
  ALLOCATE_TO: '分摊',
  OFFSET_SETTLE: '冲抵结算',
  WRITE_OFF: '核销',
  REVERSE_ORIGIN: '红冲溯源',
  FEEDS_INTO: '结算依据',
  CORRESPONDS_TO: '开票对应',
  TRIGGERS: '触发付款',
  PROVIDE: '提供服务',
  CONTAINS: '文档血缘',
```

`EDGE_STYLE_OVERRIDES` 追加（wb4 颜色语义，色值 D3 新建；GraphCanvas 建边已消费该表，画布零改动）：

```ts
  // 本体关系边(roadmap Item 4, wb4 语义色)：分摊蓝/冲抵绿/核销橙/红冲红实色；
  // 辅助关系灰虚线(与普通抽取边 #CBD5E1 实线区分)；CONTAINS 文档血缘沿层级灰+虚线。
  ALLOCATE_TO: { color: '#2563EB', dashed: false },
  OFFSET_SETTLE: { color: '#16A34A', dashed: false },
  WRITE_OFF: { color: '#EA580C', dashed: false },
  REVERSE_ORIGIN: { color: '#DC2626', dashed: false },
  FEEDS_INTO: { color: '#94A3B8', dashed: true },
  CORRESPONDS_TO: { color: '#94A3B8', dashed: true },
  TRIGGERS: { color: '#94A3B8', dashed: true },
  PROVIDE: { color: '#94A3B8', dashed: true },
  CONTAINS: { color: '#64748B', dashed: true },
```

`KIND_STYLES` 追加 11 实体键（展示 token：色板复用既有家族色、标签对齐注册表 ENTITY_LABELS；视觉微调走 designer 评审，语义不变）：

```ts
  // 本体实体节点(Item 4 穿透模式)——kind=注册表实体名, 未知 kind 的 FALLBACK 兜底不变
  TradeContract: { color: '#15803D', softBg: '#E9F4EC', softBorder: '#CBE5D3', label: '贸易合同' },
  TradeGoods: { color: '#D97706', softBg: '#FBF0DE', softBorder: '#F0D9B0', label: '商品' },
  Counterparty: { color: '#4A6D8C', softBg: '#EBF1F5', softBorder: '#CFDCE6', label: '交易对手' },
  OrgUnit: { color: '#64748B', softBg: '#F1F5F9', softBorder: '#E2E8F0', label: '内部组织' },
  GoodsReceiptEvent: { color: '#0E7490', softBg: '#F2FAFC', softBorder: '#B8DCE4', label: '收货事件' },
  GoodsDeliveryEvent: { color: '#0369A1', softBg: '#F3F9FD', softBorder: '#BAD9EE', label: '发货事件' },
  SettlementEvent: { color: '#6D5FC3', softBg: '#EEEBF8', softBorder: '#D8D0F0', label: '结算事件' },
  InvoiceEvent: { color: '#1D4ED8', softBg: '#F5F8FF', softBorder: '#C7D6E3', label: '发票事件' },
  PaymentEvent: { color: '#B45309', softBg: '#FFFBF3', softBorder: '#F0D9B0', label: '付款事件' },
  CollectionEvent: { color: '#15803D', softBg: '#F4FAF5', softBorder: '#CBE5D3', label: '收款事件' },
  ServiceCostEvent: { color: '#7C3AED', softBg: '#FAF7FF', softBorder: '#DDD0F0', label: '服务费事件' },
```

文件末尾追加图例数据源（穿透模式工具栏消费）：

```ts
/** 穿透模式边图例(roadmap Item 4)：色值/虚线与 EDGE_STYLE_OVERRIDES 严格一致。 */
export const ONTOLOGY_EDGE_LEGEND: ReadonlyArray<{ relation: string; color: string; dashed: boolean }> = [
  { relation: 'ALLOCATE_TO', color: '#2563EB', dashed: false },
  { relation: 'OFFSET_SETTLE', color: '#16A34A', dashed: false },
  { relation: 'WRITE_OFF', color: '#EA580C', dashed: false },
  { relation: 'REVERSE_ORIGIN', color: '#DC2626', dashed: false },
  { relation: 'FEEDS_INTO', color: '#94A3B8', dashed: true },
  { relation: 'CORRESPONDS_TO', color: '#94A3B8', dashed: true },
  { relation: 'TRIGGERS', color: '#94A3B8', dashed: true },
  { relation: 'PROVIDE', color: '#94A3B8', dashed: true },
  { relation: 'CONTAINS', color: '#64748B', dashed: true },
];
```

- [ ] **Step 3: 验证 + commit**

Run: `npm run build && npm run lint`
Expected: 绿

```bash
git add apps/web/src/api/ontology.ts apps/web/src/components/graph/businessTypes.ts
git commit -m "feat(web): ontology neighbor API client + wb4 relation colors and legend tokens"
```

---

### Task 7: web——graph 视图「本体穿透」模式（D1）

**Files:**
- Create: `apps/web/src/components/graph/OntologyExplorer.tsx`
- Modify: `apps/web/src/components/graph/GraphView.tsx`（模式状态 + 工具栏 toggle + 渲染分支 + focus 分流）
- Modify: `apps/web/src/components/graph/GraphCanvas.tsx`（edge:pointerenter/leave 悬停回调）

**Interfaces:**
- Consumes: `fetchOntologyNeighbors`/`listEntities`/`fetchOntologySchema`（api/ontology.ts）、`GraphCanvas` 及其 props、`ONTOLOGY_EDGE_LEGEND`/`edgeLabel`（businessTypes.ts）。
- Produces: `OntologyExplorer`（props：`initialAnchor?: { type: string; id: string; label: string; nonce: number } | null`）+ 导出 `formatEdgeParams`；GraphView 内 `mode: 'doc' | 'ontology'`；GraphCanvas 边悬停事件经既有 `onHover` 通道发出（`InspectTarget` 形状以前置检查为准）。

**实施顺序说明：** 本任务与 Task 8 有类型耦合（focus 判别联合）。推荐顺序：先做 Step 1-3（OntologyExplorer + GraphCanvas，无耦合），再做 Task 8 全部，最后回做 Step 4（GraphView 分支，此时联合已就位）。也可两任务合并实施，接口契约不变。

- [ ] **Step 1: 前置检查**

Run: 打开并记录（与预期不符时以实际代码为准修订 Step 2/3/4 贴码）：
```bash
grep -n "export interface InspectTarget\|export type InspectTarget" -A 6 apps/web/src/hooks/useGraph.ts
# 记录 InspectTarget 判别形状(node/edge 分支字段名)
grep -n "pointerenter" apps/web/src/components/graph/GraphCanvas.tsx
# 记录事件注册块行号与 evt -> GraphNode 的提取写法(edge 提取照抄该形态)
grep -n "showPlainEdges" apps/web/src/components/graph/GraphView.tsx | head -6
# 记录工具栏 state 与 JSX 结构(模式 toggle 插入点)
```

- [ ] **Step 2: OntologyExplorer.tsx**

```tsx
// apps/web/src/components/graph/OntologyExplorer.tsx
// 本体穿透模式(roadmap Item 4)：起点选择器 + 邻接画布 + 双击 lazy 展开 + 边参数悬停。
// 复用 GraphCanvas(g6)与 useGraph 的 GraphNode/GraphEdge 形状；DTO -> 画布数据映射时
// elementId 用 `<type>:<id>` 复合键(两套身份体系不冲突)，业务键放 props 供展开回读。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clsx } from 'clsx';
import {
  fetchOntologyNeighbors, listEntities, fetchOntologySchema,
  type NeighborsResultDTO, type NeighborNodeDTO, type NeighborEdgeDTO,
  type OntologyEntitySchemaDTO, type ProjectedEntity,
} from '../../api/ontology';
import type { GraphEdge, GraphNode, InspectTarget, Subgraph } from '../../hooks/useGraph';
import { GraphCanvas } from './GraphCanvas';
import { ONTOLOGY_EDGE_LEGEND, edgeLabel } from './businessTypes';

export interface OntologyAnchorJump {
  type: string;
  id: string;
  label: string;
  nonce: number;
}

interface Props {
  initialAnchor?: OntologyAnchorJump | null;
}

const nodeKey = (type: string, id: string) => `${type}:${id}`;

function toGraphNode(n: NeighborNodeDTO): GraphNode {
  return {
    elementId: nodeKey(n.entityType, n.id),
    kind: n.entityType,
    name: n.label,
    props: { ...(n.props ?? {}), __type: n.entityType, __id: n.id },
  };
}

function toGraphEdge(e: NeighborEdgeDTO): GraphEdge {
  return {
    elementId: e.id,
    type: e.relation,
    srcId: nodeKey(e.fromType, e.fromId),
    dstId: nodeKey(e.toType, e.toId),
    props: e.params,
    confidence: null,
  };
}

const EDGE_PARAM_LABELS: Record<string, string> = {
  amount: '金额', ratio: '比例', method: '方式', batch: '批次',
  partial: '部分核销', reason: '原因', unitIndex: '序号', pages: '页码',
};

/** 边参数摘要(spec: 金额/比例/方式)：hover 浮层与选中详情共用。 */
export function formatEdgeParams(params: Record<string, unknown> | null | undefined): string {
  if (!params) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v == null || v === '') continue;
    let text = String(v);
    if (k === 'ratio' && typeof v === 'number') text = `${Math.round(v * 100)}%`;
    if (k === 'amount' && typeof v === 'number') text = v.toLocaleString();
    if (k === 'partial') text = v ? '是' : '否';
    parts.push(`${EDGE_PARAM_LABELS[k] ?? k} ${text}`);
  }
  return parts.join(' / ');
}

/** 起点选择器 + 穿透画布。展开=对已见节点再取 depth=1 邻接并合并去重(逐步展开)。 */
export function OntologyExplorer({ initialAnchor }: Props) {
  const [entities, setEntities] = useState<OntologyEntitySchemaDTO[] | null>(null);
  const [selectedType, setSelectedType] = useState<string>('');
  const [q, setQ] = useState('');
  const [candidates, setCandidates] = useState<ProjectedEntity[]>([]);
  const [searching, setSearching] = useState(false);

  const [anchor, setAnchor] = useState<{ type: string; id: string; label: string } | null>(null);
  const [depth, setDepth] = useState(1);
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lineage, setLineage] = useState<NeighborsResultDTO['lineage'] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [selected, setSelected] = useState<InspectTarget | null>(null);
  const [hoverEdge, setHoverEdge] = useState<GraphEdge | null>(null);
  const expandedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;
    fetchOntologySchema()
      .then((s) => { if (alive) setEntities(s.entities); })
      .catch(() => { if (alive) setError('本体注册表加载失败'); });
    return () => { alive = false; };
  }, []);

  // 台账抽屉跳入(Task 8 通道)：nonce 变化即重置画布锚定
  useEffect(() => {
    if (!initialAnchor) return;
    setAnchor({ type: initialAnchor.type, id: initialAnchor.id, label: initialAnchor.label });
  }, [initialAnchor]);

  const load = useCallback(async (target: { type: string; id: string; label: string }, d: number) => {
    setLoading(true);
    setError(null);
    expandedRef.current = new Set([nodeKey(target.type, target.id)]);
    try {
      const res = await fetchOntologyNeighbors(target.type, target.id, d);
      // replace 语义：锚点节点 + 全量邻接重建画布
      const anchorNode = toGraphNode(res.anchorNode);
      const nodeMap = new Map<string, GraphNode>();
      nodeMap.set(anchorNode.elementId, anchorNode);
      for (const n of res.nodes) nodeMap.set(nodeKey(n.entityType, n.id), toGraphNode(n));
      setNodes([...nodeMap.values()]);
      setEdges(res.edges.map(toGraphEdge));
      setLineage(res.lineage);
      setTruncated(res.truncated);
      setAnchor(target);
      setSelected(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // anchor state 变化(选择器点选 / 抽屉跳入)触发加载
  useEffect(() => {
    if (anchor) void load(anchor, depth);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- depth 只在手动加载时读取,避免改深度自动刷新覆盖展开结果
  }, [anchor]);

  // 双击节点 = lazy 展开该节点 depth=1 邻接(与文档模式「双击增量展开」语义一致)
  const handleNodeDoubleClick = useCallback((node: GraphNode) => {
    const t = node.props?.['__type'];
    const id = node.props?.['__id'];
    if (typeof t !== 'string' || typeof id !== 'string') return;
    const key = nodeKey(t, id);
    if (expandedRef.current.has(key)) return;
    expandedRef.current.add(key);
    setLoading(true);
    fetchOntologyNeighbors(t, id, 1)
      .then((res) => {
        // merge 语义：保留既有节点，新增未见的节点与边
        setNodes((prev) => {
          const nodeMap = new Map(prev.map((n) => [n.elementId, n] as const));
          for (const n of res.nodes) {
            const gn = toGraphNode(n);
            if (!nodeMap.has(gn.elementId)) nodeMap.set(gn.elementId, gn);
          }
          return [...nodeMap.values()];
        });
        setEdges((prev) => {
          const ids = new Set(prev.map((e) => e.elementId));
          return [...prev, ...res.edges.filter((e) => !ids.has(e.id)).map(toGraphEdge)];
        });
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  const search = useCallback(async () => {
    if (!selectedType) return;
    setSearching(true);
    try {
      const res = await listEntities(selectedType, { q: q.trim() || undefined, pageSize: 10 });
      setCandidates(res.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSearching(false);
    }
  }, [selectedType, q]);

  const subgraph: Subgraph = useMemo(() => {
    const anchorNode = anchor ? toGraphNode({ ...anchorProps(anchor) }) : null;
    const subject = nodes[0] && anchorNode ? nodes.find((n) => n.elementId === anchorNode.elementId) ?? nodes[0] : null;
    return { subject, nodes, edges };
  }, [nodes, edges, anchor]);
  const anchorKey = anchor ? nodeKey(anchor.type, anchor.id) : null;

  const hoverParams = hoverEdge ? formatEdgeParams(hoverEdge.props ?? null) : '';

  return (
    <div className="flex h-full min-w-0 flex-col bg-surface/40">
      {/* 工具栏：起点选择器 + 深度 + 状态 */}
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-white px-3 py-2 text-sm">
        <select
          value={selectedType}
          onChange={(e) => { setSelectedType(e.target.value); setCandidates([]); }}
          className="h-8 rounded border border-line bg-white px-2 text-sm text-ink"
          aria-label="实体类型"
        >
          <option value="">选择实体类型</option>
          {entities?.map((e) => <option key={e.name} value={e.name}>{e.label}</option>)}
        </select>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void search(); }}
          placeholder="按标识 / 字段值搜索起点"
          className="h-8 w-56 rounded border border-line bg-white px-2 text-sm text-ink placeholder:text-ink-soft/60"
        />
        <button
          type="button"
          onClick={() => void search()}
          className="h-8 rounded border border-line px-3 text-xs text-ink-soft transition-colors hover:border-primary/40 hover:text-primary"
        >
          {searching ? '搜索中...' : '搜索'}
        </button>
        {candidates.length > 0 && (
          <div className="relative">
            <ul className="absolute z-20 mt-1 max-h-60 w-72 overflow-y-auto rounded border border-line bg-white shadow-lg">
              {candidates.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => { setCandidates([]); setAnchor({ type: selectedType, id: c.id, label: c.label }); }}
                    className="block w-full px-3 py-2 text-left text-sm text-ink hover:bg-surface/60"
                  >
                    <span className="font-medium">{c.label}</span>
                    <span className="ml-2 text-xs text-ink-soft">{c.id}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <label className="ml-2 flex items-center gap-1 text-xs text-ink-soft">
          初始深度
          <select
            value={depth}
            onChange={(e) => setDepth(Number(e.target.value))}
            className="h-7 rounded border border-line bg-white px-1 text-xs text-ink"
          >
            <option value={1}>1</option>
            <option value={2}>2</option>
            <option value={3}>3</option>
          </select>
        </label>
        {anchor && (
          <span className="rounded border border-line bg-surface px-2 py-1 text-xs text-ink">
            当前中心：<span className="font-medium">{anchor.label}</span>
            <span className="ml-1 text-ink-soft">{anchorKey}</span>
          </span>
        )}
        {loading && <span className="text-xs text-ink-soft">加载中...</span>}
        {error && <span className="text-xs text-danger">{error}</span>}
        {lineage && !lineage.available && (
          <span className="text-xs text-ink-soft" title="NEO4J_PASSWORD 未配置或图服务不可用">
            文档血缘不可用（仅本体邻接）
          </span>
        )}
        {truncated && <span className="text-xs text-ink-soft">结果已截断（缩小深度或逐跳展开）</span>}
      </div>

      {/* 边图例(验收 2：颜色/图例区分两类边) */}
      <div className="flex flex-wrap items-center gap-3 border-b border-line bg-white px-3 py-1.5 text-xs text-ink-soft">
        {ONTOLOGY_EDGE_LEGEND.map((l) => (
          <span key={l.relation} className="flex items-center gap-1">
            <span
              className="inline-block h-0 w-6 border-t-2"
              style={{ borderColor: l.color, borderTopStyle: l.dashed ? 'dashed' : 'solid' }}
            />
            {edgeLabel(l.relation)}
          </span>
        ))}
      </div>

      {/* 画布 + 悬停参数浮层 */}
      <div className="relative min-h-0 flex-1">
        {nodes.length > 0 ? (
          <GraphCanvas
            key={anchorKey ?? 'ontology'}
            subgraph={subgraph}
            centerElementId={anchorKey}
            hiddenKinds={new Set<string>()}
            showPlainEdges
            onHover={(t) => {
              if (t && t.kind === 'edge') setHoverEdge(t.edge);
              else setHoverEdge(null);
            }}
            onNodeSelect={(n) => setSelected({ kind: 'node', node: n } as InspectTarget)}
            onEdgeSelect={(e) => setSelected({ kind: 'edge', edge: e } as InspectTarget)}
            onPaneSelect={() => setSelected(null)}
            onNodeDoubleClick={handleNodeDoubleClick}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-ink-soft">
            选择实体类型并搜索起点，或从实体台账详情「在图中查看」跳入；双击节点逐步展开邻接。
          </div>
        )}
        {hoverEdge && hoverParams && (
          <div className="pointer-events-none absolute left-3 top-3 rounded border border-line bg-white/95 px-2 py-1 text-xs text-ink shadow">
            <span className="font-medium">{edgeLabel(hoverEdge.type)}</span>
            <span className="ml-2 text-ink-soft">{hoverParams}</span>
          </div>
        )}
      </div>

      {/* 选中详情(节点/边参数) */}
      {selected && (
        <div className="max-h-48 overflow-y-auto border-t border-line bg-white px-3 py-2 text-sm">
          {selected.kind === 'node' ? (
            <div>
              <div className="font-medium text-ink">{selected.node.name}</div>
              <div className="mt-0.5 text-xs text-ink-soft">
                {String(selected.node.props?.['__type'] ?? selected.node.kind)}
                {' / '}
                {String(selected.node.props?.['__id'] ?? selected.node.elementId)}
              </div>
            </div>
          ) : (
            <div>
              <div className="font-medium text-ink">{edgeLabel(selected.edge.type)}</div>
              <div className="mt-0.5 text-xs text-ink-soft">
                {formatEdgeParams(selected.edge.props ?? null) || '无参数'}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** subgraph.subject 的展示锚点(仅用于画布定位，不进 nodes)。 */
function anchorProps(anchor: { type: string; id: string; label: string }): NeighborNodeDTO {
  return { id: anchor.id, entityType: anchor.type, label: anchor.label, source: 'unresolved' };
}
```

（`InspectTarget` 判别字段名以 Step 1 前置检查为准等价替换 `t.kind === 'edge'` / `{kind:'node', node}` 构造；若 `InspectTarget` 无 node/edge 分支则定义本地联合类型 `type LocalTarget = { kind: 'node'; node: GraphNode } | { kind: 'edge'; edge: GraphEdge }` 替换。）

- [ ] **Step 3: GraphCanvas 边悬停（照抄 node:pointerenter 注册形态）**

在既有事件注册块（Step 1 记录的行号，`node:pointerenter`/`node:pointerleave` 之后）追加（evt→GraphEdge 的提取写法照抄该块内 evt→GraphNode 的提取）：

```ts
    // 边悬停(Item 4 穿透模式边参数浮层)：与节点悬停共用 onHover 通道
    graph.on('edge:pointerenter', (evt: IElementEvent) => {
      const raw = /* 照抄 node 分支的 evt 取模型写法，取 edge 模型(rawEdge) */;
      if (raw) onHover({ kind: 'edge', edge: raw } as InspectTarget);
    });
    graph.on('edge:pointerleave', () => onHover(null));
```

（GraphCanvas props 无需新增——`onHover: (t: InspectTarget | null) => void` 已是既有签名，只是此前只从节点侧触发。文档模式 DetailPanel 若对 edge target 无处理需兜底忽略，`kind==='edge'` 分支返回 null 即可——以 Step 1 记录的 onHover 消费端代码为准。）

- [ ] **Step 4: GraphView 模式切换（在 Task 8 类型扩展之后实施）**

4a. import 补：

```tsx
import { OntologyExplorer, type OntologyAnchorJump } from './OntologyExplorer';
```

4b. 组件 state 区补：

```tsx
  // 本体穿透模式(roadmap Item 4, D1)：与文档图谱模式互斥的独立数据源/身份体系。
  const [mode, setMode] = useState<'doc' | 'ontology'>('doc');
  const [ontologyJump, setOntologyJump] = useState<OntologyAnchorJump | null>(null);
```

4c. focus 消费 effect（原 L155-163 块，focus 已是 Task 8 的判别联合形态）改为分流：

```tsx
  const handledFocusNonceRef = useRef(-1);
  useEffect(() => {
    if (!focus || focus.nonce === handledFocusNonceRef.current) return;
    handledFocusNonceRef.current = focus.nonce;
    if ('entityType' in focus.target) {
      // 台账抽屉跳入：切本体穿透模式并以业务 type+id 锚定
      setMode('ontology');
      setOntologyJump({
        type: focus.target.entityType, id: focus.target.entityId,
        label: focus.target.label, nonce: focus.nonce,
      });
      return;
    }
    setMode('doc');
    setSelectedDoc(null);
    query(focus.target.elementId, focus.target.label, false);
  }, [focus, query]);
```

4d. 工具栏（`showPlainEdges` 开关行之前）插入模式 toggle：

```tsx
        <div className="flex items-center gap-1 rounded border border-line bg-white p-0.5 text-xs">
          <button
            type="button"
            onClick={() => setMode('doc')}
            className={clsx('rounded px-2 py-1', mode === 'doc' ? 'bg-surface font-medium text-ink' : 'text-ink-soft')}
          >
            文档图谱
          </button>
          <button
            type="button"
            onClick={() => setMode('ontology')}
            className={clsx('rounded px-2 py-1', mode === 'ontology' ? 'bg-surface font-medium text-ink' : 'text-ink-soft')}
          >
            本体穿透
          </button>
        </div>
```

4e. 主渲染区（画布 + DetailPanel + DocumentListPanel 的容器）包一层分支：

```tsx
      {mode === 'ontology' ? (
        <OntologyExplorer initialAnchor={ontologyJump} />
      ) : (
        /* 既有文档图谱主体 JSX 原样保留 */
      )}
```

（左栏 DocumentListPanel / ProjectSearchBar 在穿透模式下隐藏——分支边界以 Step 1 记录的 JSX 结构为准，原则：穿透模式独占主区，避免两套中心语义并存。）

- [ ] **Step 5: 验证 + commit**

Run: `npm run build && npm run lint && npm test`
Expected: 绿

手动验证（`npm run dev:all`，若已在跑勿重复起前端；本地先跑 Task 5 种子）：
1. graph 视图出现「文档图谱/本体穿透」toggle，默认文档图谱行为与之前完全一致；
2. 切「本体穿透」→ 选「贸易合同」→ 搜索 HT-DEMO-LIN-001 → 点结果、初始深度 2 → 画布以合同为中心，可见发票（蓝/灰 CORRESPONDS_TO 边）与付款（橙 WRITE_OFF、绿 OFFSET_SETTLE、灰虚线 TRIGGERS）；
3. 双击任一节点 → 邻接并入（不重置已有节点）；
4. 边悬停 → 左上浮层显示「核销 金额 300,000 / 批次 WO-LIN-1 / 部分核销 是」；
5. 红冲：展开深度覆盖红冲票时 REVERSE_ORIGIN 边为红色；
6. 图例条 9 项与边色一致。

```bash
git add apps/web/src/components/graph/OntologyExplorer.tsx apps/web/src/components/graph/GraphView.tsx apps/web/src/components/graph/GraphCanvas.tsx
git commit -m "feat(web): ontology lineage-traverse mode in graph view with lazy expand and edge params"
```

---

### Task 8: web——focus 通道判别联合 + 台账抽屉「在图中查看」（D2）

**Files:**
- Modify: `apps/web/src/components/graph/focus.ts`（GraphFocusTarget 判别联合）
- Modify: `apps/web/src/App.tsx`（GraphFocus 形态 + EntitiesView 传 openInGraph）
- Modify: `apps/web/src/components/graph/GraphView.tsx`（focus prop 消费随形态调整，与 Task 7 Step 4c 合并验证）
- Modify: `apps/web/src/components/entities/EntitiesView.tsx`（props 透传）
- Modify: `apps/web/src/components/entities/EntityDetailDrawer.tsx`（头部按钮）

**Interfaces:**
- Produces: `GraphFocusTarget = { elementId: string; label: string } | { entityType: string; entityId: string; label: string }`；`GraphFocus = { nonce: number; target: GraphFocusTarget }`；`EntityDetailDrawer` 新 prop `onViewInGraph?: (label: string) => void`；`EntitiesView` 新 prop `onOpenInGraph?: (t: GraphFocusTarget) => void`。

- [ ] **Step 1: 前置检查**

Run: `grep -rn "GraphFocusTarget\|openInGraph(" apps/web/src --include=*.tsx --include=*.ts | grep -v OntologyExplorer`
Expected: 触点 = focus.ts（定义）、App.tsx（openInGraph 构造 setGraphFocus + GraphView props）、GraphView.tsx（focus prop 消费）、BindingsView/BindingMiniGraph（生产方，传 `{elementId, label}`）。逐一确认判别联合改造后各触点编译路径（生产方不变，消费方只有 GraphView 一处分支）。

- [ ] **Step 2: focus.ts 判别联合**

```ts
/** 跨视图定位请求(roadmap Item 4 起)：文档图谱模式(elementId)或本体穿透模式(entityType+entityId)。 */
export type GraphFocusTarget =
  | { elementId: string; label: string }
  | { entityType: string; entityId: string; label: string };

export interface GraphFocus {
  /** 自增序号：重复定位同一目标也能触发图谱页的 effect。 */
  nonce: number;
  target: GraphFocusTarget;
}
```

App.tsx 的 `openInGraph`（原 L121-128）改为 `setGraphFocus({ nonce: ++graphFocusNonceRef.current, target })`（签名 `(target: GraphFocusTarget) => void` 不变，BindingsView 调用零改动）。

- [ ] **Step 3: EntityDetailDrawer 头部按钮**

props interface 追加：

```tsx
  /** 「在图中查看」回调(Item 4 穿透跳入)；入参为展示名(抽屉自己持有 detail 数据)。 */
  onViewInGraph?: (label: string) => void;
```

头部操作区（「关闭」按钮旁）追加：

```tsx
          {onViewInGraph && (
            <button
              type="button"
              onClick={() => onViewInGraph(detail?.entity.label ?? entityId)}
              className="rounded border border-line px-2 py-1 text-xs text-ink-soft transition-colors hover:border-primary/40 hover:text-primary"
            >
              在图中查看
            </button>
          )}
```

- [ ] **Step 4: EntitiesView 透传 + App 接线**

EntitiesView props 追加 `onOpenInGraph?: (t: GraphFocusTarget) => void;`（import `type { GraphFocusTarget } from '../graph/focus';`），抽屉接线处（L179-187）追加：

```tsx
          onViewInGraph={
            onOpenInGraph && active
              ? (label) => onOpenInGraph({ entityType: active.name, entityId: detailId, label })
              : undefined
          }
```

App.tsx 视图分发（`view === 'entities'` 分支）改为：

```tsx
  ) : view === 'entities' ? (
    <EntitiesView onOpenInGraph={openInGraph} />
```

- [ ] **Step 5: 验证 + commit**

Run: `npm run build && npm run lint && npm test`
Expected: 绿（BindingsView 生产方 `{elementId, label}` 联合第一支自动兼容；GraphView Step 4c 分支就位）

手动验证：实体台账 → 任一行开抽屉 → 「在图中查看」→ 跳 graph 视图且已切「本体穿透」模式、画布以该实体为中心；关闭抽屉重开同一实体再点按钮仍能重新触发（nonce）；绑定工作台跳图谱（文档模式）行为不变。

```bash
git add apps/web/src/components/graph/focus.ts apps/web/src/App.tsx apps/web/src/components/graph/GraphView.tsx \
  apps/web/src/components/entities/EntitiesView.tsx apps/web/src/components/entities/EntityDetailDrawer.tsx
git commit -m "feat(web): entity ledger drawer jumps into ontology traverse mode via focus channel"
```

---

### Task 9: 验收 runbook + 终验合并

**Files:** 无新代码（dev 库种子灌入 + 手动验收 + 合并）。

**Interfaces:** 无。

- [ ] **Step 1: 本地四条验收逐一**

1. **验收 1（2 跳可达发票/付款）**：本地已跑 Task 5 种子 →
   `curl -b <auth-cookie> 'http://localhost:3001/api/ontology/graph/neighbors?type=TradeContract&id=C-DEMO-LIN&depth=2'`
   Expected: `nodes` 含 `InvoiceEvent`(INV-LIN-1) 与 `PaymentEvent`；`depth=1` 不含（单测已覆盖，此处为端到端确认）。
2. **验收 2（两类边同图不冲突）**：dev（10.10.0.2，Neo4j 已配置）选一个**有上传文档的真实合同**（台账「贸易合同」任一行）→ 抽屉「在图中查看」→ 确认 CONTAINS/references 灰系虚线与本体关系彩色边同图、图例 9 项可区分；工具栏不显示「文档血缘不可用」降级提示。
3. **验收 3（P95 < 500ms）**：本地对种子锚点连打 30 次取 p95：
   ```bash
   for i in $(seq 1 30); do curl -s -o /dev/null -w "%{time_total}\n" -b <auth-cookie> \
     'http://localhost:3001/api/ontology/graph/neighbors?type=TradeContract&id=C-DEMO-LIN&depth=2'; done \
     | sort -n | awk '{a[NR]=$1} END {print "p95(ms):", a[int(NR*0.95)]*1000}'
   ```
   Expected: p95 < 500ms（超出则定位耗时在 SQL 全量边加载还是逐引用解析，考虑 D6 的批量 IN 优化——属后续项不阻塞验收）。
4. **验收 4（深度可控）**：`depth=4` → 400；`depth=3` → 200；UI 初始深度下拉只有 1-3。

- [ ] **Step 2: dev 环境灌种子 + 抽查**

```bash
ssh ubuntu-server   # export PATH=$HOME/.nvm/versions/node/v24.19.0/bin:$PATH 先行
cd ~/supply-chain-agent && git pull   # 或等 CD 自动部署
npx tsx apps/server/scripts/seedLineageTraverseDemo.ts --dry-run
npx tsx apps/server/scripts/seedLineageTraverseDemo.ts
```
浏览器 `http://10.10.0.2:3001/#/graph` → 本体穿透 → 合同 HT-DEMO-LIN-001 起点穿透验证（dev 为 PG + Neo4j，同时验证双后端与血缘融合真链路）。

- [ ] **Step 3: 终验**

Run: `npm run build && npm run lint && npm test`
Expected: 全绿

- [ ] **Step 4: commit（如有零星修正）+ 合并 main**

```bash
git fetch origin main
git merge origin/main   # 有冲突先解决并重新跑终验
npm run build && npm run lint && npm test   # merge 触碰代码时复验
git push origin HEAD:PengYip/lineage-traverse
git push origin HEAD:main   # 触发 CI + CD 到 10.10.0.2
```

部署后抽查：`ssh ubuntu-server "curl -s localhost:3001/api/health"` 健康。

---

## 计划自审记录（writing-plans Self-Review）

1. **Spec 覆盖**：IN 逐条——邻接 API `GET /api/ontology/graph/neighbors`（Task 2/3/4，合并 ontology_edges + Neo4j 血缘、边带 relation/params 摘要）；graph 视图「本体穿透」模式 + 起点选择器 + 台账跳入（Task 7/8，模式决策 D1）；节点点击 lazy 展开（Task 7 双击增量展开，沿用画布既有语义）；边按 wb4 色着色 + hover 参数（Task 6/7）；文档节点与业务实体同图（Task 3 血缘融合 + Task 7 同画布）。OUT 边界：全图渲染/路径算法/图编辑/Bloom 均未越界。验收 1-4 分别落 Task 9 Step 1.1-1.4（并有 Task 2/4 单测内锚）。
2. **占位符扫描**：无 TBD/TODO。显式「以实际代码为准」的前置检查 4 处（Task 1 Step 3 / Task 7 Step 1 / Task 8 Step 1 / GraphCanvas 边事件提取写法），均为审批中心计划同款的「既有签名适配」写法，非占位。
3. **类型一致性**：`NeighborNode/NeighborEdge/OntologyNeighbors/NeighborsResult` 在 Task 2/3（定义）、Task 4（路由）、Task 6（DTO 镜像，字段一一对应，web 侧放宽为 string 联合）三处一致；`source` 联合含 `'neo4j'` 一次到位（Task 2 类型、Task 3 产出、Task 6 DTO）；`getOntologyNeighbors`/`getNeighbors` 签名在 Interfaces 与实现一致；`fetchOntologyNeighbors`/`toGraphNode`/`toGraphEdge`/`formatEdgeParams` 在 Task 6/7/8 间命名一致；GraphFocus 判别联合在 Task 7 Step 4c（消费 `focus.target`）与 Task 8 Step 2（定义）一致，且已注明两任务实施顺序可调换。

---

## 实施状态（2026-09-08 补记）

全部 9 个 Task 已完成并合并 main（分支 `PengYip/lineage-traverse`，最终经 merge commit `969ba0e` 推送 main，CI/CD 绿，已部署 10.10.0.2）。实施期要点：终审（ora-2 fresh session）曾判 NOT_READY——B1 Critical（`e352e97` 的 Set 提升 + filter effect 短路导致双击展开死路径）与 B2 Important（Document 节点双击 400 + expandedRef 不可重试）已经 fix wave `f3dbc7a` 修复（GraphCanvas subgraph 变更 effect 增量渲染方案，保留相机/拖拽位置）并 scoped re-review 通过。人工验收清单（P95 实测 / UI 走查 / doc 模式 fast-follow 三小项）已交接用户。

