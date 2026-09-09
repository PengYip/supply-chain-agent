# 企业主体身份与层级 实施计划（counterparty-subject-identity）

> **For agentic workers:** 按 superpowers:executing-plans 逐任务执行；每个任务先写失败测试再实现。验证顺序 `npm run build && npm run lint && npm test`（仓库根）。

**Goal:** 落地 spec `docs/superpowers/specs/2026-09-09-counterparty-subject-identity.md`——Counterparty 主体锚（uscc）、PARENT_OF 带参关系、主体变更（supersede）入口、台账归一聚合与名称史。

**Architecture:** 零 DDL——uscc 进 trade_facts.payload、PARENT_OF 进本体注册表（ontology_edges 既有列全兼容）。改动集中在：注册表单文件（`ontology/index.ts`）、repo 新增换代函数（`ontology/repo.ts`）、REST 变更端点（`routes/ontology.ts`）、台账归一投影（`ontology/projection.ts`）、link_ontology 词表（`ontology/linkTools.ts`）、前端 DTO/抽屉/标签。

**Tech Stack:** TypeScript 严格 / zod ^3 / better-sqlite3 + node-postgres 双后端 / vitest。

**Spec:** `docs/superpowers/specs/2026-09-09-counterparty-subject-identity.md`

## Global Constraints

- 零 emoji；零 DDL（spec §3）；不新增 agent 工具（PARENT_OF 走 link_ontology 既有词表机制，变更走 REST 直写——**不触碰 tool-inventory.json**）
- 双后端任何新写路径都要有 dispatch（仿 `insertOntologyEdgesBatch` 事务范式）
- 本项改动全部在 ontology 模块 + routes/ontology + web api/components，不碰 pipeline
- 分支惯例：`PengYip/counterparty-subject-identity`，验证绿后 push 分支并合 main
- 开工第一步：`git fetch origin main && git merge origin/main`（本计划基于 2026-09-09 的 main 摸底，行号可能漂移，以函数/文件名为锚）

## 摸底结论（2026-09-09 recon）

- 注册表 SSOT：`apps/server/src/ontology/index.ts`——Counterparty schema 在 `ONTOLOGY_ENTITIES`；关系在 `ONTOLOGY_RELATIONS`（现 8 类型/14 对）；`ontologySchemaJson()` 带 `version: '2026-09-07'` 常量。
- 既有断言锚点：`test/ontology/registry.test.ts`（11 实体名单、关系 `toHaveLength(8)`、pairs `toHaveLength(14)`、闭枚举）；`test/harness/toolsRoutes.test.ts`（inventory version 断言，本项不动 inventory）。
- 主数据入口：`routes/ontology.ts` POST /master-data（直写先例，createdBy='manual'）；zod 输入在 `ontology/masterData.ts`（`CreateMasterDataInputSchema`，字段全可选+端点预检 entitySchema strict）。
- 事务范式：`ontology/repo.ts` `insertOntologyEdgesBatch`（校验期零连接 + BEGIN/COMMIT + ROLLBACK）。
- 归一投影挂点：`ontology/projection.ts` `collectEntities`（按 type 分源）、`getProjectedEntityDetail`（三分支）、`listEntityRelations`（cap 50）；列表 SOURCE_ROW_CAP=500。
- link_ontology 词表：`ontology/linkTools.ts` `LINKABLE_RELATIONS`（6 元 enum）。
- 前端：`apps/web/src/api/ontology.ts`（EntityDetailResult/ProjectedEntity DTO）、`components/entities/EntityDetailDrawer.tsx`（时间线/关系区）、`components/graph/businessTypes.ts`（EDGE_LABELS）。

## 设计决策（编号对应 spec §8，此处只列实施含义）

1. uscc 必填只约束**写入边界**（entitySchema strict）；读路径容忍缺失（旧事实 fields 缺 uscc 渲染空）。
2. supersede = INSERT 新事实 + UPDATE 旧行 invalid_at，一个事务；不做 RENAMED_FROM。
3. 列表归一只对 Counterparty 做（分组键 payload.uscc）；其他实体路径零改动。
4. 详情 relations = 组内全部事实端点的边 union（更名前建的边不丢）；timeline = 组内名称史（含失效行）。
5. PARENT_OF 走 link_ontology：只改 LINKABLE_RELATIONS enum + 注册表，工具代码零改动（校验链注册表驱动）。

---

### Task 1: 注册表——uscc 锚 + PARENT_OF 关系

**Files:**
- Edit: `apps/server/src/ontology/index.ts`
- Edit: `apps/server/test/ontology/registry.test.ts`

**Interfaces（产出，后续任务依赖）:**
- `ONTOLOGY_ENTITIES.Counterparty` = `{ uscc: min(1), name: min(1), role: string, address?, bankAccount?, bankName?, legalRepresentative?, registeredCapital?, establishedDate?, businessScope? }`（uscc 在首字段，describe 注明主体归一锚；附加属性 v1 全可选 string，见 spec §3 附加属性表与三条边界）
- `ONTOLOGY_ENTITIES.TradeGoods` 增 `attributes?: z.record(z.string().min(1).max(40), z.union([z.string(), z.number()]))`——写入边界再叠加 superRefine：条数 ≤32（spec §3 受控袋软约束；品类模板门禁属 v2，本期不做）
- `ONTOLOGY_RELATIONS` 增第 9 个：`{ name: 'PARENT_OF', pairs: [{from:'Counterparty',to:'Counterparty'}], params: z.object({ ratio: z.number().min(0).max(1).optional(), note: z.string().optional() }).strict() }`
- `ontologySchemaJson().version` 更新（如 '2026-09-09'）

**Steps:**
- [ ] 失败测试：registry.test 断言 Counterparty.shape.uscc 存在且 required；附加属性字段存在且 optional；TradeGoods.attributes 袋（合法键值过 / 键超 40 字拒 / 值为对象拒 / 超 32 条拒）；ONTOLOGY_RELATIONS toHaveLength(9)、pairs 15、PARENT_OF pair 白名单（isRelationPairAllowed('PARENT_OF','Counterparty','Counterparty') true / 反向同名对 true / Counterparty→InvoiceEvent false）；version 断言更新
- [ ] 实现：改 index.ts 两处 + version 常量（TradeGoods 袋的 superRefine 放 entitySchema('TradeGoods') 分支，保持 ONTOLOGY_ENTITIES 纯 object 惯例——与事件金额规则同模式）
- [ ] 全量 `npm test --workspace apps/server`——预期暴露连带断言（governance/ontologyEntities/schema DTO 快照若有），逐一按 spec §9 清单同步
- [ ] 表单投影验证：masterDataFormSchemaJson 自动带出 Counterparty 附加属性（fieldKind string 直接过）——主数据抽屉注册字段零改动即渲染（注册表驱动红利，测试断言之）；TradeGoods.attributes 不进字段投影（record 不受 fieldKind 支持，录入走 Task 6 键值编辑区——设计如此）

### Task 2: repo——supersedeTradeFact 换代函数

**Files:**
- Edit: `apps/server/src/ontology/repo.ts`
- Edit: `apps/server/test/ontology/repo.test.ts`

**Interfaces:**
```ts
export interface SupersedeTradeFactInput {
  prevFactId: string;
  next: TradeFactInput;            // 新事实（payload 已含同 uscc）
  validAt?: string | Date;         // 缺省 = now
}
export async function supersedeTradeFact(
  ctx: DbContext, input: SupersedeTradeFactInput, userId?: string,
): Promise<{ newId: string; prevInvalidAt: string }>;
// 语义（调用方前置校验之外，本函数内再次强制）:
//   prev 存在且可见(userId 口径同 getTradeFactById) / prev.entityType === next.entityType
//   / prev.payload.uscc === next.payload.uscc / prev.invalid_at IS NULL
//   任一不满足 throw（路由转 4xx）
// 事务: INSERT next + UPDATE trade_facts SET invalid_at = ? WHERE id = prev
//   （PG pool.connect BEGIN/COMMIT；SQLite ctx.sqlite.transaction）——失败整批回滚
```

**Steps:**
- [ ] 失败测试（repo.test）：happy path（旧行失效+新行生效、双时间轴值正确）；uscc 不一致 throw 且零写入；prev 已失效 throw；其他用户不可见 throw
- [ ] 实现双后端 dispatch（范式对齐 insertOntologyEdgesBatch：先全部校验再开事务）

### Task 3: REST 变更端点——POST /api/ontology/master-data/change

**Files:**
- Edit: `apps/server/src/ontology/masterData.ts`（输入 schema + 表单投影如需）
- Edit: `apps/server/src/routes/ontology.ts`
- Edit: `apps/server/test/routes/ontologyEntities.test.ts`（或新增 routes 用例文件）

**Interfaces:**
```ts
// masterData.ts
export const ChangeMasterDataInputSchema = z.object({
  prevFactId: z.string().min(1),
  payload: z.object({ uscc: min1, name: min1, role: z.string().optional() }).strict(),
  validAt: z.string().min(1).optional(),   // 缺省=登记时刻
});
// routes/ontology.ts POST /master-data/change（requireAuth 既有中间件覆盖）
//   校验链: zod strict -> payload 过 entitySchema('Counterparty') strict（字段级报错）
//   -> supersedeTradeFact -> 201 { newId, prevFactId, invalidAt }
//   失败映射: 前置校验类 400（detail 原因），未知 500
```

**Steps:**
- [ ] 失败测试：happy path（更名后 listProjectedEntities 显示新名、formerNames 含旧名、旧行 invalid_at=validAt）；uscc 不一致 400；prev 不存在 404/400；未登录 401
- [ ] 实现；web `api/ontology.ts` 增 `changeMasterData()`（POST，字段级错误映射沿 MasterDataValidationError 范式）

### Task 4: link_ontology 词表 + PARENT_OF

**Files:**
- Edit: `apps/server/src/ontology/linkTools.ts`（LINKABLE_RELATIONS + 'PARENT_OF'；description 补一句母子公司话术示例）
- Edit: `apps/server/test/ontology/linkTools.test.ts`

**Steps:**
- [ ] 失败测试：词表含 PARENT_OF；对端 Counterparty 主数据事实建边 ok；ratio 参数落库；Counterparty→InvoiceEvent 拒绝
- [ ] 实现（enum + description 两行）
- [ ] 边界确认：relation/fromId/toId 均在 SHARED_TOOL_FIELD_NAMES（既有），toolOntologyMap 门禁零改动——跑 `test/ontology/toolOntologyMap.test.ts` + `test/harness/toolInventory.test.ts` 确认

### Task 4b: graphSync 属性袋展平（TradeGoods.attributes 投影前置）

**Files:**
- Edit: `apps/server/src/ontology/graphSync.ts`
- Edit: `apps/server/test/ontology/graphSync.test.ts`

**背景（spec §3 隐藏技术约束）:** Neo4j 节点 props 不接受嵌套对象——payload.attributes 是嵌套 record，graphSync 现有 `...payload` 整包展平会把投影直接打挂。

**Steps:**
- [ ] 失败测试：带 attributes 的 TradeGoods 事实投影后，节点 props 出现 `attr.<键>` 扁平属性（如 `attr.牌号='Q235B'`）且 props 无嵌套 `attributes` 键；无 attributes 的事实 props 零变化
- [ ] 实现：graphSync 组 props 时拆出 payload.attributes → 逐键 `props['attr.'+k]=v`（值已是标量）；其余 payload 照旧展平
- [ ] 确认 EVIDENCE/关系边投影不受影响（边 props 来自 ontology_edges.params，恒标量）

### Task 5: 台账归一投影 + 名称史

**Files:**
- Edit: `apps/server/src/ontology/projection.ts`
- Edit: `apps/server/test/ontology/projection.test.ts`

**Interfaces:**
```ts
// collectEntities('Counterparty') 改为聚合口径:
//   读全部 as-of now 事实 + 同 uscc 的失效历史(listTradeFactsAsOf 只给有效行;
//   需 repo 增只读 helper: listTradeFactHistoryByUscc? —— 简化: 复用
//   listTradeFactsAsOf(asOfSystemTime(now)) 取含失效全集, 内存按 (uscc,失效) 分组)
// ProjectedEntity(Counterparty 组):
//   id=现行事实id, label=现行名, fields.formerNames=[旧名...],
//   meta.uscc=uscc, source='trade_facts'
// getProjectedEntityDetail(Counterparty):
//   entity=现行事实; timeline=组内全部事实(valid_at 升序, 失效行 fields 标注)
//   netAmount=null; relations=组内全部事实端点的边 union(cap 50)
```

**Steps:**
- [ ] repo 增只读 helper：`listTradeFactHistory(ctx, { entityType, uscc }, userId)`（含失效行，valid_at 升序；SQLite/PG 双 dispatch——仅 SELECT）
- [ ] 失败测试（projection.test）：更名后列表 1 组（label=新名、formerNames 含旧名）；q 搜旧名命中该组；详情 timeline 含两行且失效行可辨；更名前建的边出现在 relations；无 uscc 存量行保持独立
- [ ] 实现聚合（注意 SOURCE_ROW_CAP 语义不变：行数上限仍 500，聚合在内存做）
- [ ] 边界文案：详情抽屉空态文案更新（spec 决策 #6）

### Task 6: 前端呈现

**Files:**
- Edit: `apps/web/src/api/ontology.ts`（ProjectedEntity 增可选 `invalidAt`——timeline 失效行标注用；`changeMasterData()` API client；EntityRelationDTO 不变）
- Edit: `apps/web/src/components/entities/EntityDetailDrawer.tsx`（timeline 行：失效/曾用名标注；字段表 uscc 自然出现；**「扩展属性」区**渲染 fields.attributes 键值对）
- Edit: `apps/web/src/components/entities/EntitiesView.tsx`（Counterparty 行副标题显示曾用名；**「变更」入口**——详情/行操作打开主数据抽屉的 change 模式：预填现行值、提交走 POST /master-data/change。变更端点必须有 UI 入口，否则只能 curl）
- Edit: `apps/web/src/components/graph/businessTypes.ts`（EDGE_LABELS + `PARENT_OF: '母子公司'`；样式灰虚线，同辅助关系族）
- Edit: `apps/web/src/components/entities/MasterDataDrawer.tsx` 相关（uscc 与 Counterparty 附加属性字段由 schema 投影自动出现——验证即可；TradeGoods 增**「自定义属性」键值编辑区**（增删行，键/值输入，提交并入 payload.attributes）；change 模式复用同抽屉，提交目标/预填不同）

**Steps:**
- [ ] 详情抽屉时间线行增加"曾用名"徽标（timeline 行带失效标记时）
- [ ] 台账 Counterparty 行副标题显示曾用名（EntitiesView 现有 label 渲染旁，读取 fields.formerNames）
- [ ] 台账/详情「变更主体信息」入口（change 模式抽屉）：预填现行 uscc/name/role/附加属性，提交后刷新列表
- [ ] `bankAccount` 展示脱敏（`6222****5678` 式，台账字段表/表单回显统一走一个 mask helper）
- [ ] MasterDataDrawer「自定义属性」键值编辑区（TradeGoods）：增删行、键/值输入、超 32 条前端截停；详情抽屉「扩展属性」区渲染
- [ ] web 测试：EventRegisterDrawer/MasterDataDrawer 既有用例补 uscc 字段（schema 投影新增必填会导致表单快照/提交用例需带 uscc）；change 模式提交用例；键值编辑区用例

### Task 7: 收尾验证 + 合并

- [ ] `npm run build && npm run lint && npm test` 全绿
- [ ] spec「实施记录」回填；`git push origin HEAD:<branch>` + `git push origin HEAD:main`（CI/CD 绿才算完成）
- [ ] dev 冒烟：主数据登记（uscc 必填）→ 对话 link_ontology 建母子公司边 → 变更端点更名 → 台账归一/名称史/穿透 PARENT_OF 逐项过一遍（spec 验收路径）

## 分期与规模预估

单 PR 可完成（Task 1-7 顺序执行，估 0.5-1 天）。Task 5（归一投影）是唯一有设计余地的任务，若聚合口径与 spec §5 有偏差，以 spec 为准回改。

## Phase 2（独立排期，本期不实施）：Agent 辅助商品主数据匹配/注册

设计定稿见 spec §11。开工前置：Phase 1 全部落地（attributes 袋是自动注册的承载前提）。任务拆解（届时按此细化）：

- **Task A1**：`match_goods` L1 工具——输入 documentId 或品名/规格文本，四通道打分（商品码精确 → 归一键精确 → pgvector 向量召回+reranker → LLM 判定兜底），返回候选+分数+证据。先登记 tool-inventory.json（五道门：inventory/registry/gate/contract/scenario）。
- **Task A2**：`register_goods` L2 工具——预填注册（name/spec/commodityCode/attributes 从单据抽取），走 insertTradeFact 写入边界 + 审批中心；attributes 受控约束照常生效。
- **Task A3**：文档确认流挂候选提议（复用绑定工作台"候选+确认"模式；高置信自动关联记 confidence/confirmationSource）。
- **Task A4**：别名反馈闭环（确认→attributes 落别名；纠正→负样本）+ 定期"未匹配商品清单"物化报告。
- 估期：A1+A2 约半天；A3+A4 约一天。
