# 图谱/绑定页合同搜索 + 图谱页重设计 — 设计文档

日期：2026-08-26
状态：已评审（渲染路线选 B：AntV G6 v5）
范围：`apps/web`（图谱页、绑定页、共享搜索组件）+ `apps/server`（contracts 搜索路由、graph schema 路由）

## 1. 背景与问题

- 图谱页（`#/graph`，`apps/web/src/components/graph/GraphView.tsx`）与绑定页（`#/bindings`，`apps/web/src/components/bindings/BindingsView.tsx`）均**无搜索功能**：图谱页只能从左侧文档列表点选起步；绑定页只有 docType 过滤 chips。
- 用户需要**基于合同的搜索**：合同编号、买方、卖方，支持模糊建议 + 下拉选项。
- 图谱页同时需要**节点类型过滤**（参考绑定页 docType chips）。
- 借此机会**重设计图谱页**：参考 Neo4j Browser/Bloom 的"搜索优先"交互模式，加入业务抽象层（Bloom Perspective 的轻量版）。

## 2. 关键现状事实（调研结论）

- 合同数据的 SSOT 是 `contract_ledger` 表（SQLite `pipeline/db/client.ts:208` 原生 DDL；PG 在 `client.ts:566` `migratePostgres`，**不在** `postgres-schema.ts`）。列：`contract_no`（归一化）、`display_contract_no`、`doc_type`、`document_id`、`title`、`fields`（JSON）、`field_meta`、`overall_confidence`、`needs_review`、`user_id` 等。
- **买方/卖方不是列**，在 `fields` JSON 的 `买方`/`甲方`（买方）与 `卖方`/`乙方`（卖方）键下。取值消费方：`projectGraphSync.ts:51-55`、`bindingProposal.ts:197-198`。
- 图谱后端 = Neo4j 5.26（`graph/repo.ts` 直连 driver）。Contract 节点 `name` = 归一化合同号；买方/卖方是独立 Party 节点（counterparty/participates 边），**不存**在 Contract 节点上。
- 已有可复用模糊匹配：`normalizeContractNo()`（`contractLedger.ts:42-54`）与 `matchEntity()`/`normalizeEntityName()`（`bindingProposal.ts:130-160`，精确 1.0 / 包含 0.9 / 字符重叠≥0.7→0.75）。
- 已有图谱定位通路：`GET /api/graph/resolve?docId=&contractNo=` + `GET /api/graph/query`（depth 受限）。
- 前端无组件库（Tailwind 手写），已有"文本过滤 + select"先例：`CandidatePanel.tsx:105-114,360-391`。
- 数据规模：当前百级，用户预期会增长 → 渲染器需要 WebGL 路线预留。

## 3. 方案选型（已决策）

**渲染器：AntV G6 v5**（替代 @xyflow/react），理由：
- 唯一自带 Legend/Toolbar/Minimap/Tooltip 等 19 个插件的 OSS 渲染器（MIT，5.0.x 活跃维护，WebGL 渲染，万级节点）。
- Legend 插件原生支持点击定位/过滤，直接满足节点类型过滤需求。
- behaviors：`focus-element`、`collapse-expand`、`brush-select`。
- 被否掉的备选：NVL（Neo4j 官方，许可证仅限 Aura/商业订阅，私有部署不可用）；Cosmograph（CC BY-NC 非商用）；sigma.js（性能强但 UI 全自建）；留在 React Flow（百级够用但用户预期增长且选中了重设计路线）。

**搜索数据源：contract_ledger（SQL），不是 Neo4j 全文索引**，理由：
- 买方/卖方在 ledger `fields` JSON 里，且绑定页本来就消费 ledger（docType/置信度/documentId）。
- 合同号是 ledger 与图谱的天然主键，图谱页选中后走已有 `resolve` 通路，零新图查询。
- 避免引入 Neo4j fulltext 索引维护（两套数据源同步问题）。规模增长后 PG 侧可加 pg_trgm GIN 索引（**预留，不在本期**）。

## 4. 架构设计

### 4.1 后端：统一合同搜索端点

**`GET /api/contracts/search?q=&limit=10`**（新 `apps/server/src/routes/contracts.ts`，`index.ts` 挂载 `/api/contracts` + `requireAuth`，照现有模式）

- 输入校验：zod，`q` 非空字符串（trim 后 ≥1 字符），`limit` 1–20 默认 10。
- 匹配逻辑（新 repo 函数 `searchContractLedger(q, limit, userId)`，SQLite 版 `repositories.ts` + PG 版 `postgres-repositories.ts`）：
  1. SQL 粗筛：`contract_no`/`display_contract_no`/`title` LIKE `%q%`（PG 用 `ILIKE`），`fields` 里买方/卖方四键的提取值 LIKE（SQLite `json_extract`，PG `fields->>'买方'`）。归一化合同号同时做前缀匹配（`normalizeContractNo(q)` 前缀）。候选集 SQL 层固定 `LIMIT 200`。
  2. JS 精排：对候选逐项计算 `matchedField`（contractNo/buyer/seller/title 优先级从高到低）与得分（`matchEntity` 评分规则），按分排序截断 limit。
- 响应：`{ items: Array<{ contractNo, displayContractNo, title, buyer, seller, docType, overallConfidence, matchedField }> }`。buyer/seller 为展示字符串（`买方`→`甲方` 回退，卖方同理），无则 null。
- 错误：500 走全局错误处理；空结果返回 `{items: []}`。

**`GET /api/graph/schema`**（加在 `routes/graph.ts`）：`CALL db.labels()` + 每 label 计数（`MATCH (n:Label) RETURN count(n)`，进程内缓存 TTL 60 秒），返回 `{ labels: Array<{ label, count }> }`。驱动前端图例数量徽标与过滤选项。

### 4.2 前端：业务抽象层（Bloom Perspective 轻量版）

**`apps/web/src/graph/businessTypes.ts`**：类型注册表

```ts
interface BusinessType {
  label: string            // Neo4j 原始 label
  displayName: string      // 业务名（中文）
  color: string
  icon?: string            // lucide 图标名
  searchableFields: string[] // Inspector/搜索摘要用
  defaultVisible: boolean
}
```

现有 `graph/kinds.ts` 的内容**迁移并入**此注册表后删除 kinds.ts，所有 import 改指向 businessTypes.ts（BindingMiniGraph 的引用一并更新，行为不变）。

### 4.3 前端：共享 SearchBar 组合框

**`apps/web/src/components/common/ContractSearchBar.tsx`**（手写 Tailwind，沿用 `inputCls` 约定）：

- 防抖 200ms → `GET /api/contracts/search` → 下拉按 matchedField 分组（合同编号/买方/卖方/标题），每项两行：合同号 + `买方 → 卖方` 摘要。
- 键盘 ↑↓ 选择、Enter 确认、Esc 关闭；点击外部关闭。
- 空查询不发请求；请求竞态取最后者（AbortController 或序号丢弃）。
- 接口失败：下拉显示"搜索暂不可用"，输入不丢。
- 回调：`onSelect(item: ContractSearchItem)` 由页面决定行为。

### 4.4 图谱页重设计（G6 v5）

- `GraphCanvas` 重写为 G6 v5（`@antv/g6` 直用：容器 ref + 命令式生命周期，**不引入 Graphin**）。props/事件契约保持稳定：`nodes/edges/onNodeClick/onNodeDoubleClick/focusNode(id)/fitView()`，便于未来换渲染器。
- 插件：Legend（节点类型过滤 + 点击定位，数据源 = businessTypes × schema 计数）、Minimap、Toolbar（fitView/清空）、Tooltip（悬浮显示 nodeDisplayName + 关键 props）。
- 交互：双击节点 = 增量展开（已有 depth=1 query 合并进图，Bloom 核心交互）；`focus-element` 行为支持搜索跳转定位。
- 顶部 SearchBar：选中合同 → `GET /api/graph/resolve?contractNo=` 定位节点 → depth=1 `query` 展开邻域 → focus + fitView。resolve 未命中时 toast 提示"该合同尚未入图"。
- 保留三栏骨架（DocumentListPanel | 画布 | DetailPanel→Inspector，沿用 PropsTable）与 depth/direction 工具栏。
- `BindingMiniGraph` 本期不动（仍用 @xyflow/react；@xyflow/react 依赖保留至下期迁移）。

### 4.5 绑定页接线（不重设计，只加搜索）

- 页面顶部加 ContractSearchBar：选中合同 → DocListPanel 过滤出绑定该合同的文档（客户端过滤 overview 数据的 `bindings[].contractNo`）并高亮定位；再次搜索/清空恢复。
- `CandidatePanel` 手工绑定表单的"搜索合同"输入 + `<select>` 对**替换为** ContractSearchBar：选中建议项即设置 contractNo。空查询聚焦时下拉展示从 `GET /api/bindings/contracts` 预载的前 N 条（默认 20），保留零输入浏览路径；原 `<select>` 删除。

## 5. 数据流总览

```
SearchBar(防抖200ms) ──► GET /api/contracts/search?q=
                             │ SQL LIKE 粗筛(ledger) + matchEntity 精排
                             ▼
                     分组下拉{合同编号|买方|卖方|标题}
              ┌──────────────┴──────────────┐
        绑定页选中                          图谱页选中
              │                              │
        过滤 DocListPanel             GET /api/graph/resolve?contractNo=
        (bindings[].contractNo)             │ 命中
              │                      GET /api/graph/query depth=1
              │                              │
              ▼                              ▼
        定位文档+高亮                 focus-element + fitView
                                             │ 双击任意节点
                                             ▼
                                    增量 depth=1 query 合并
```

节点类型过滤：Legend 插件点选 → 客户端设节点可见性，不重查。图例计数来自 `GET /api/graph/schema`（带缓存）。

## 6. 错误处理

- 搜索接口失败：下拉内降级提示，不阻塞页面其他功能。
- resolve 未命中（合同在 ledger 但未入图）：toast 明确说明，不上空白图。
- G6 初始化失败/容器尺寸为 0：保留现空态文案，console.error。
- schema 端点失败：图例退化为 businessTypes 静态配置（无计数）。

## 7. 测试策略

- **server（vitest）**：`searchContractLedger`（SQLite 内存库 + 种子 ledger 数据）：合同号精确/前缀/归一化匹配、买方含模糊（部分字符）、卖方、标题、limit 截断、空结果、matchedField 优先级。`contracts` 路由：zod 校验（空 q、limit 越界）、auth 401。`/api/graph/schema`：label 计数与缓存。
- **web**：`npm run build`（tsc -b）+ lint 通过；无组件测试基建，不新增。
- **手工验收**：绑定页搜中文买方名部分字符 → 下拉出现分组建议；图谱页选中 → 聚焦展开；Legend 点选类型隐藏/显示；双击展开。

## 8. 明确不做（YAGNI）

- 不做 Neo4j fulltext 索引、pg_trgm 索引（预留：repo 函数签名不变即可加）。
- 不做保存搜索短语（Bloom search phrases）——后续可加服务端表。
- 不做 BindingMiniGraph 的 G6 迁移（下期）。
- 不做多 Perspective/多角色注册表（单域单注册表）。
- 不引入组件库或 Graphin。

## 9. 实施顺序（供 writing-plans 细化）

1. server：`searchContractLedger`（SQLite+PG）+ `/api/contracts/search` 路由 + 测试
2. server：`/api/graph/schema` + 测试
3. web：`businessTypes.ts` 注册表 + `ContractSearchBar` 组件
4. web：绑定页接线（顶部搜索 + CandidatePanel 升级）
5. web：图谱页 G6 重写（GraphCanvas → 插件 → SearchBar 接线 → 双击展开）
6. build → lint → test → 手工验收 → 提交
