# 本体业务闭环 Wave 7（合同类型消歧 + 遗留清偿）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。Steps 用 checkbox 跟踪。
> **压缩恢复锚点**：恢复时读本文件 + `docs/superpowers/specs/2026-09-20-ontology-business-loop-design.md`（Wave1-6 实施记录）+ `.superpowers/sdd/2026-09-21-ontology-business-loop-wave7/progress.md`；分支 PengYip/tools-grouping，基线 = origin/main 5366df1；评审席 councillor + oracle 终审、fixer/designer 会话见 Background Job Board。

**Goal:** 打通"购销合同"歧义的最后一公里——台账合同类型人工修正端点 + 修正后流水重建 + 前端消歧入口（火运乐化大票 DOC-muant2ur-u1d4 → XYRL-2022-225 验收出流水）；清偿 deriveContractType 映射链疑点、R16 Neo4j 脚本挂起、四项顺路小清理。

**Architecture:** 修正端点镜像两个既有先例——PATCH /api/documents/:docId/type 的响应契约（refreshedFlows/skipped 透传，review.ts:484）与 parties.ts backfillFlows 的按文档重建循环。台账 contract_type 是流水方向判定（executionFlow 三级链第 2 级）与勾稽 sideOf 的 SSOT 消费点，人工修正落台账行即可激活全下游，无需动注册表（指纹不变）。

**Spec:** 主 spec §Wave 6 实施记录"Wave 7 发现"节 + Wave 4 终审可推迟清单 + Wave 5 新发现清单。

## Global Constraints
- 验证顺序 `npm run build && npm run lint && npm test`；零 emoji；本体写入只经 repo 边界
- 本 wave 不动 `apps/server/src/ontology/index.ts`（注册表零变更 → 指纹不重生成）；若评审引入变更必须重生成 `test/ontology/registry-fingerprint.json`（win32 用 .ts 后缀，workdir apps/server）
- 授权状态：用户已授权全程自主（合并/推送/部署/运维自动执行）；**dev 共享库业务表绝不能 TRUNCATE**；破坏性 DB 操作先报量级
- dev 复测：账号 acceptance@test.local @ http://10.10.0.2:3001；API 测试一律 Node .mjs 脚本（UTF-8），不用 curl 直发中文 JSON
- 双后端镜像：新 repo 函数 SQLite（repositories.ts）+ PG（postgres-repositories.ts）两处都要

## Task 1: 映射链诊断（dev 实证，orchestrator 自做，产出定 Task 2 范围）

**Files:** 只读诊断（ssh dev psql + 本地读码），无提交；结论写进 progress.md 与 spec 素材。
- 链路事实（已侦察）：`deriveContractType`（contractType.ts:36）对"购销合同"**有意不映射**（tradeSemantics.ts:35 注释），侧别兜底 = 买方|甲方/卖方|乙方 锚点 × `effectiveSelfPartyNamesForDerivation`；台账 contract_type 在**录入时**派生（documentEntry.ts:256），PATCH /type 仅在 NULL 时重派生（repositories.ts:2645 / pg:1812）。
- 诊断项（dev，全 SELECT 只读）：
  a) XYRL-2022-225 台账行：`SELECT id, contract_type, created_at FROM contract_ledger WHERE contract_no='XYRL-2022-225'`（经 docker exec sca-pgvector psql）；
  b) 该合同文档最新抽取行 fields：合同类型/买方/卖方/甲方/乙方 值与 created_at——判定 fieldType/sideType 哪层落空；
  c) self_parties 名单 vs 抽取买卖方（`SELECT * FROM self_parties`）；
  d) 台账行 created_at vs 首条抽取行 created_at——验证"confirm 早于抽取完成"时序假说；
  e) confirm 路径读码：review.ts 确认单/批量是否重派生 contract_type（若不重派生且时序实证成立 → Task 2 追加 confirm 时 NULL 重派生小修，复用 rederive 函数）。
- **Gate**：结论三选一记入 progress.md——(A) 链路完好，纯歧义（Task 2 只做修正端点）；(B) 时序缺口（Task 2 追加 confirm 重派生）；(C) 映射 bug（现场定位后单独定修复）。

## Task 2: 合同类型人工修正端点 + 流水重建（后端 TDD，fixer + councillor 评审）

**Files:**
- Modify: `apps/server/src/routes/contracts.ts`（新增 PATCH /:contractNo/type）
- Modify: `apps/server/src/pipeline/db/repositories.ts` + `postgres-repositories.ts`（新增 `updateContractLedgerType(ctx, id, contractType)`；消费既有 `listBindingsForContract`（SQLite :832 / PG :199）、`findContractLedgerByNo`）
- Test: `apps/server/test/routes/contracts.test.ts`（无则新建，沿既有路由测试模式）

**Interfaces:**
- Consumes: `findContractLedgerByNo(ctx, contractNo, userId)`（既有）；`listBindingsForContract(ctx, contractNo)`（既有，返回 BindingRow[] 含 documentId/status）；`refreshExecutionFlowsForDocument(ctx, docId, userId)`、`materializeDocumentOntologySafe(ctx, docId, userId)`（既有）；`TRADE_VOCAB.contractTypes`（受控值白名单，tradeSemantics.ts）。
- Produces: `PATCH /api/contracts/:contractNo/type`，body `{ contractType: string }`；响应 `200 { ok, contractNo, contractType, refreshedFlows, failed, skipped }`（对齐 parties.ts POST 契约）；`400 invalid_body|invalid_contract_type`；`404 contract_not_found`。前端 Task 3 消费此契约。

- [ ] **Step 1 失败测试**：a) 合同存在 + 绑定一张 direction-undeterminable 跳过的大票文档 → PATCH `{contractType:'采购'}` → 200、台账行 contract_type='采购'、refreshedFlows=1、skipped 不含 direction-undeterminable；b) 受控值外（'购销合同'）→ 400 invalid_contract_type（**必须拒绝歧义值**，白名单= TRADE_VOCAB.contractTypes）；c) 未知合同号 → 404；d) 非 合同 粗类文档的台账行（如存在）行为=仍允许修正（台账行即修正对象，docType 不设限，测试固定该语义）。
- [ ] **Step 2 跑红**：`npm test --workspace apps/server -- test/routes/contracts.test.ts`
- [ ] **Step 3 实现**：repo 双后端 `UPDATE contract_ledger SET contract_type=? WHERE id=?`（返回是否命中）；路由按序：zod 解析 → 白名单校验 → findContractLedgerByNo → 404 → update → 遍历 `listBindingsForContract` 中 confirmed 绑定的去重 documentId → 逐文档 `refreshExecutionFlowsForDocument`（镜像 backfillFlows：refreshedFlows 计数、failed 按文档捕获、skipped 透传）→ 每成功文档 `void materializeDocumentOntologySafe`。修正后 contract_type 非空，PATCH /type 的重派生守卫（已有值的行不动）天然保护人工值不被覆盖——测试加一条断言：修正后调 PATCH /type 不清空该值。
- [ ] **Step 4 跑绿 + 全量**：build → lint → test
- [ ] **Step 5 Commit:** `feat(routes): contract-type manual correction endpoint with flow rebuild (business-loop wave7)`

## Task 3: 前端消歧入口（designer 通道 + web 冒烟测试）

**Files:**
- Modify: `apps/web/src/`（API client 函数 + 合同台账展示位；designer 自行定位消费 view——线索：flow-panel/合同台账/绑定下拉消费 listContractLedgerEntries 的组件）
- Test: 对应 view 的冒烟测试（沿 GapsPanel 5 冒烟模式）

- 要求：a) API client `patchContractType(contractNo, contractType)` 封装 Task 2 契约；b) 台账行 contract_type 空或需修正时提供修正入口（受控值选择器，禁填自由文本——歧义值进不来）；c) 成功反馈携带 refreshedFlows 语义（"已重建 N 张单据流水"）；d) 消歧引导文案接地气、不夸大（orchestrator 复核 copy）；e) 保持现有设计语言，不做大改版。
- 验收口径：乐化场景可用——打开台账 → XYRL-2022-225 修正类型 → 提示流水重建。
- **Commit:** `feat(web): contract-type correction entry in ledger view (business-loop wave7)`

## Task 4: Neo4j 脚本端图同步挂起诊断 + 修复（R16；诊断先行，fixer 实现）

**Files:**
- Modify: `apps/server/scripts/backfillOntology.ts`（图同步段收尾）
- 可能 Modify: `apps/server/src/graph/neo4j.ts`（若诊断指向驱动配置）
- Test: `apps/server/test/scripts/`（无既有模式则最小单测：看门狗超时路径返回诊断状态而非挂起；io 注入沿 graphSync.test 范式）

- 已知事实：驱动已配 connectionTimeout 5000 / acquisitionTimeout 10000（neo4j.ts:11-17）；脚本末尾 `await syncOntologyGraph({ctx, userId})`（backfillOntology.ts:193-205）在 dev 对 Neo4j 挂起，属主钩子路径（fire-and-forget）未见阻塞。
- 诊断步骤（dev，orchestrator 或 fixer 经 ssh）：a) 查 remote .env 的 NEO4J_URL/USER/PASSWORD 与 neo4j 容器端口映射；b) 脚本插桩跑一次（facts/edges 读取、逐节点 upsert 计数日志 + 每阶段耗时），60-120s 看门狗截停，定位挂点（TCP 连接 / Bolt 握手 / 首个 session.run / prune）；c) 同时验证服务器进程内钩子投影是否真的成功（Neo4j 里事实节点是否在长）——"钩子正常"可能只是未被观测。
- 修复（按诊断结果，最小面）：脚本侧加看门狗 Promise.race（超时记 `[backfill] graph sync timed out after Ns (non-fatal)` 并继续收尾）+ finally 里 `closeNeo4j()` 与 ctx/PG 资源收尾保证进程可退出；若根因是 URI scheme/网络层则修 env 并留档。
- **Commit:** `fix(scripts): backfill graph-sync watchdog + resource cleanup (business-loop wave7)`

## Task 5: 顺路清理四小项（fixer，串行单 lane；互不相干可按时间取舍）

**Files + 要求:**
- a) **loadLatest 确定性下沉**：`repositories.ts` SQLite 实现 ORDER BY 加 `rowid DESC` 平局键；`postgres-repositories.ts` `loadLatestExtractionByDocIdPg` 加 `id DESC`（若缺）。全部 8 个消费方（bindingCandidates/ontologyMaterialize/selfPartyCandidates×2/settlementTools×2/documentEntry/repositories:2910）自动继承；executionFlow.ts:65 的 wave5 交叉核对注释改为"防御性冗余"。测试：同秒两行抽取 → loadLatest 取新行（沿 wave5 复现用例）。
- b) **resolveByNo 缓存**：`ontology/gaps.ts:149` 加 byNo Map（镜像 resolveByEdge :140 惯例，命中缓存；行为不变，现有 gaps 测试为门）。
- c) **勾稽 ④⑥ 负值角标**：GapsPanel（web）对 应收未收/应付未付 项 amt<0 且非近零时渲染语义角标——④负→「预收」、⑥负→「超收」（措辞以 gaps.ts 实际公式复核，评审定稿；复用面板既有弱化态样式类）。web 测试：负值 fixture 出角标、正值不出。
- d) **inventory 文案**：`docs/tool-inventory.json` query_business 的 whenToUse/boundary 补 `entity=ontology 支持 page 分页（默认 1）`（先核对 queryBusiness.ts 实际参数名）；inventory 门禁测试为验收。
- **Commit（可拆可合）:** `chore(business-loop): wave7 sweep — deterministic loadLatest, gaps byNo cache, negative badges, inventory page doc`

## Task 6: 收口
- 全量 build → lint → test → 合并 origin/main → push（CI/CD 部署 10.10.0.2）。
- dev 验收（acceptance@test.local）：经新端点/UI 修正 XYRL-2022-225 合同类型 → 大票 DOC-muant2ur-u1d4 出流水（方向确定）→ 事实 + ALLOCATE_TO 边自动入谱 → 勾稽缺口面板数字更新；backfill:ontology 脚本端到端跑通不再挂起；钢材 11 单回归无异常。
- spec 回填 Wave 7 实施记录 + 遗留清单；progress.md 收官。

## 遗留不做（预计记入 spec Wave 7 节）
- JPG 图像件解析（图像管线专项）、未挂边事实进 tile① 口径重估、差异换代连带失效用户手工边的补登记 UX、FIFO 账本（D5）。
