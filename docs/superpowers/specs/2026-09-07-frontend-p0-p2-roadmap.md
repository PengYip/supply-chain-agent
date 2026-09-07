# 前端 P0-P2 总路线图（本体驱动工作台）

日期：2026-09-07
状态：路线图定稿。**本文档只定范围/验收/依赖，不含实施步骤**；每项的实施计划单独编写（写法见文末「计划编写约定」）。
执行状态（2026-09-08 更新）：**Item 1-7 已全部实施并合并 main**（审批中心 / 本体基座 / 贸易台账 / 链路穿透 / 核销工作台 / 治理后台 / 总览工作台，CI/CD 绿）。路线图 P0-P2 全部项完成。
适用仓库：D:\Users\yepeng\supply-chain-agent-prototype

---

## 0. 定位与全局原则

1. **对话仍是主入口**。菜单只为四类不适合对话的交互存在：等待处理的（待办）、浏览比较的（列表）、追溯理解的（链路）、精确复杂操作（多对多核销）。
2. **通用壳 + 本体驱动**：所有新界面不硬编码业务字段，列定义/枚举/关系类型一律从本体注册表（Item 2）或既有 SSOT 读取。新增实体/边/工具时界面零改动是各项的硬验收。
3. **现有视图不重做**：chat / projects（项目汇总）/ ledger（项目台账·凭证齐套率）/ graph（图谱）/ bindings（绑定工作台）/ eval / audit / favorites / parties 保持既有语义，新能力以新 ViewId 或数据源替换的方式进入。
4. **双向打通**：界面实体可点击进对话（带上下文），对话/审批可跳回界面。每项至少实现一个方向的打通。
5. 复用既有基础设施：requireAuth 认证、sessionStore/审批 callback 决策路径、tool-inventory CI 门禁、双后端（SQLite raw DDL / Postgres drizzle）列对列镜像。

## 1. 依赖图与建议顺序

```
Item1 审批中心(P0) ──独立，已有计划──> 可立即开工
Item2 本体基座(P0, 关键路径) ──> Item3 台账(P0) ──> Item4 穿透(P1)
                                  └──> Item5 核销工作台(P1, 还依赖 Item1)
Item2 ──> Item6 治理后台(P2)
Item1+2+3 ──> Item7 总览(P2)
```

- 两条并行线：Item1（前端+审批路由）与 Item2（后端本体+表）互不阻塞，可同时推进。
- 每完成一项，代码基线变化（尤其 Item2 会新增注册表与表），**下一项计划必须开工时重摸底再写**，不要提前批量写计划。

## 2. 现有视图基线（2026-09-07，出处 exp-1 摸底）

- 导航注册表：`apps/web/src/components/shell/navigation.ts`（ViewId + NAV_ITEMS，hash 路由 `#/<view>?session=<id>`，视图分发 `App.tsx:288-322`）
- 已有视图：chat 对话（含 L2 ApproveDeny 卡片、L3 工单卡片）/ projects 项目汇总 / ledger 项目台账（凭证齐套率视角）/ graph 实体关系可视化 / bindings 文档-合同绑定 / eval / audit LLM 用量 / favorites / parties
- 后端既有：`pending_approvals` 表（审批中心 v1 将扩列）、documents/contract_ledger/bindings 等 pipeline 表、Neo4j CONTAINS 文档血缘

---

## Item 1 审批中心（P0） — 已完成规划

- Spec：`docs/superpowers/specs/2026-09-07-approval-center-v1.md`
- Plan：`docs/superpowers/plans/2026-09-07-approval-center-v1.md`（10 任务，可直接实施）
- 本文不重复范围。后续 Item 5/6/7 复用其 API：`GET /api/approval/list`、`GET /api/approval/:id`、`POST /api/approval/callback`。

## Item 2 本体基座 ontology-foundation（P0 · 关键路径）

**定位**：把《本体建模技术备忘》第 3 节的领域模型（4 静态 + 7 事件实体、4+5 关系）落成代码级 SSOT，并为台账/穿透/核销提供数据表。不做这项，Item 3/4/5/6 都是空中楼阁。

**IN**
- `apps/server/src/ontology/index.ts`：zod 注册表——11 实体 schema、9 关系定义（from/to/params/描述）、枚举（PayType/EventBizType/AllocateMethod/商品码）、meaning URI 字符串映射、双时间轴 mixin（validAt/invalidAt/ingestedAt）。形态参照《本体建模技术备忘》§「手写 ontology.ts 示例」（工作区 架构设计\本体建模技术备忘.md）
- 带参边表（双后端）：`ontology_edges(id, relation, from_type, from_id, to_type, to_id, params_json, valid_at, invalid_at, ingested_at, created_by)`，幂等迁移
- 事件事实表 `trade_facts`（双后端）：本体事件实体的通用落地表（entity_type, payload_json, 三时间列），或按实体分表——**计划编写时决策并写明理由**（倾向：v1 通用表 + entity_type 判别，字段校验走 zod）
- as-of 查询 helper：`asOfBusinessTime(t)` / `asOfSystemTime(t)`（语义见技术备忘 §4 SQL）
- CI 扩展：toolInventory.test.ts 新增断言——已映射工具的 inputSchema 字段必须存在于注册表实体（映射表 `toolOntologyMap`）
- 映射示范：对 3 个既有 L2 工具（create_entity / link_entities / bind_document）接入映射
- AGENTS.md 增补「本体基座」一节（注册表位置、表、扩展方法）

**OUT**：Cube、Graphiti 依赖、全量词汇导入（meaning 只挂已确认的 OEO/FIBO 条目）、实体数据迁移（现有表数据不搬家，走 Item 3 的只读投影）

**验收**
1. 注册表单文件可被前端与 CI 消费；新增一个实体只改该文件
2. 边表/事实表双后端幂等建表；as-of 双查询语义有单测（红冲追溯场景）
3. CI 断言：给某工具 inputSchema 加一个注册表不存在的字段 → 测试红
4. `npm run build && npm run lint && npm test` 全绿

**依赖**：无前置。**被依赖**：Item 3/4/5/6。

## Item 3 贸易台账 v1 trade-ledger（P0）

**定位**：本体实体的浏览界面——七类事件实体 + 合同/对手方的列表、详情、双时间轴切换。现有 ledger（项目台账·凭证齐套率）保留不动，本项新增 ViewId `entities`（label「实体台账」）。

**IN**
- API：`GET /api/ontology/entities/:type`（分页/筛选，type 白名单来自注册表）、`GET /api/ontology/entities/:type/:id?asOf=business|system&at=<ISO>`（详情 + 时间切片）
- 数据源 v1 = 只读投影：合同←contract_ledger、单据/收发依据←documents、事件←trade_facts；其余实体类型空态页（显示"待本体基座灌数"）——投影 SQL 写在 server，不改源表
- 前端：新 ViewId `entities`；左侧实体类型列表（注册表驱动）；列表列定义从注册表字段生成（前端拉 `GET /api/ontology/schema`（新增，返回注册表 JSON）动态渲染）；详情页 as-of 切换（「当时口径/最新口径」toggle + 时间点选择）
- 双向打通：行内「问 Agent」按钮 → `#/chat?session=new&ask=<实体摘要>`（chat 侧支持 ask 参数注入首条消息）
- L3 红冲/补差事实在详情时间线视图中标色（逆向=负数金额红标）

**OUT**：实体编辑/新建（走对话+工具，不做表单编辑）、跨实体复杂检索、导出

**验收**
1. 注册表新增实体字段 → 台账列表自动多一列，前端零代码改动
2. 红冲场景：as-of 切换能复现「当时口径 vs 最新口径」两个答案（用测试数据脚本验证）
3. 只读投影不写源表（代码审查确认无写路径）
4. 空态类型不报错

**依赖**：Item 2。**被依赖**：Item 4/5/7。

## Item 4 链路穿透 v1 lineage-traverse（P1）

**定位**：扩现有 graph 视图：把本体关系边（分摊/冲抵/核销/红冲溯源 + 辅助）与文档血缘 CONTAINS 融合到一张可逐步展开的图。

**IN**
- API：`GET /api/ontology/graph/neighbors?type=<entityType>&id=<id>&depth=1`（合并 ontology_edges + Neo4j 血缘邻接，返回节点+边；边带 relation/params 摘要）
- 前端（graph 视图内新增「本体穿透」模式或并入默认模式，计划时决策）：起点选择器（实体类型+ID，支持从台账/审批详情跳入）；节点点击 lazy 展开邻接；边按关系类型着色——**沿用 wb4 领域关系图的颜色语义**：ALLOCATE_TO 蓝 / OFFSET_SETTLE 绿 / WRITE_OFF 橙 / REVERSE_ORIGIN 红 / 辅助灰；边 hover 显示参数（金额/比例/方式）
- 文档节点（documents）与业务实体节点同图：合同 → 收发货 → 结算 → 发票 → 付款主链一眼可穿

**OUT**：全图渲染、路径算法、图编辑、Neo4j Bloom 替代

**验收**
1. 从任一合同出发，2 跳内可达其发票与付款（测试数据验证）
2. 文档血缘边与本体关系边同图不冲突（颜色/图例区分）
3. 邻接查询 P95 < 500ms（本地数据集）
4. 深度展开可控（depth 上限防全图爆炸）

**依赖**：Item 2（边表）、复用 Neo4j 血缘。**被依赖**：无（Item 7 可选引用）。

## Item 5 核销工作台 writeoff-workbench（P1）

**定位**：预付冲抵（付款/收款 ↔ 结算）与票款核销（收付 ↔ 发票）的精确操作面——多对多、部分金额、分批，对话不适合承载的自由数字输入。

**IN**
- 前端新 ViewId `writeoff`：两侧列表（待核销资金 / 待核销发票或结算），勾选 + 金额分配编辑（每行分配额 ≤ 余额），合计守恒校验（分配和 = 提交额）
- 提交动作：生成带参边（OFFSET_SETTLE/WRITE_OFF，params: amount/partial/batch）→ **作为 L2 工具调用走审批中心**（新工具 `create_writeoff` / `create_offset`：按 tool-inventory 流程先登记 inventory 条目再实现，needsApproval: true）
- 状态视图：已核/未核/部分核（从边表聚合），穿透图与台账即时可见结果
- 金额校验规则（服务端）：分配额不为负、不超单据余额、冲抵不超结算额——规则写 zod/服务层并挂单测

**OUT**：自动核销建议、跨币种、批量导入

**验收**
1. 全流程闭环：勾选→分配→提交→审批中心批准→边落库→穿透图显示橙色/绿色边
2. 审批拒绝路径：无边产生、状态视图不变
3. 守恒校验单测（含部分核销、多发票合并付款两个用例）
4. 新增核销类关系类型时工作台零改动（映射驱动）

**依赖**：Item 2（边表/关系注册表）、Item 1（审批）。**被依赖**：Item 7。

## Item 6 治理后台 governance-admin（P2）

**定位**：只读治理视图，让本体、工具面、权限、审批审计各有出处可查。

**IN**
- 新 ViewId `governance`（admin 组），四个 tab：
  1. 本体：类/关系/枚举/meaning 渲染（数据源 `GET /api/ontology/schema`）
  2. 工具：tool-inventory 视图化（新增 `GET /api/tools/inventory` 读 docs/tool-inventory.json + 注册表状态对比）
  3. 权限矩阵：L1/L2/L3 × 工具（数据源 harness/permissionGate.ts 导出）
  4. 审批审计：审批中心 list API 扩展过滤（时间/决策人/工具/状态）
- 全部只读，无在线编辑

**OUT**：本体/权限在线编辑、多环境对比

**验收**：四个 tab 数据分别来自各自 SSOT（注册表/inventory/permissionGate/审批表），页面上标注数据出处；零硬编码业务字段

**依赖**：Item 2、Item 1。

## Item 7 总览工作台 overview-dashboard（P2）

**定位**：登录后门户——待办与异常优先，指标卡片次之。

**IN**
- 新 ViewId `overview`（置顶为默认落地视图或 nav 首项，计划时决策）：
  - 待审批卡片（审批 list API 计数）→ 点击跳审批中心
  - 异常规则 v1 两条：a) 超合同量收货（trade_facts 聚合 vs 合同量，服务端规则函数）；b) 无票付款拦截记录（审批中心 L3 历史里 reason 含付款类）
  - 指标卡片 v1：合同执行率、待核销金额（台账/边表聚合 API）；接口层预留 Cube 数据源位（`METRICS_SOURCE=local|cube` env，默认 local 聚合）
- 空数据/零依赖时的降级展示（各卡片独立 loading/error）

**OUT**：趋势图、BI 自助分析、Cube 实际接入

**验收**：构造异常数据 → 卡片出现并正确跳转；每个卡片的数据源可独立 mock 测试；默认视图切换不破坏既有直链 hash

**依赖**：Item 1/2/3（指标与异常数据）。

---

## 3. 计划编写约定（每项开工时适用）

1. **路径与命名**：spec 如需补写放 `docs/superpowers/specs/YYYY-MM-DD-<slug>.md`；计划放 `docs/superpowers/plans/YYYY-MM-DD-<slug>.md`，slug 用本文各项括号内的英文名（如 `ontology-foundation`）。
2. **写法**：superpowers writing-plans 约定——TDD、bite-size 步骤、每步带真实代码与运行命令、预期失败/通过、逐任务 commit；对不确定的既有签名用「前置检查」步骤显式暴露（照抄审批中心计划的做法）。
3. **开工前重摸底**：前序 Item 会改变代码基线（新表/注册表/路由），写计划前先跑一轮定向 recon（重点：本体注册表导出形态、navigation.ts 当前 ViewId、审批中心落地后的 API）。
4. **横切约束**（每份计划的 Global Constraints 必含）：
   - 验证顺序 `npm run build && npm run lint && npm test`（仓库根）
   - 代码零 emoji；TS 严格模式过 tsc
   - 双后端列对列镜像；SQLite 幂等迁移（PRAGMA 守卫）/ Postgres `ADD COLUMN IF NOT EXISTS`
   - 新增工具必须先登记 `docs/tool-inventory.json`（whenToUse/boundary/rationale）再上注册表，CI 双射门禁会拦
   - AI SDK 6 陷阱以 AGENTS.md「AI SDK 6」节为准（inputSchema / needsApproval / v6 序列化）
   - 认证 `requireAuth`；测试模式 `appAs(userId)` + `app.request`（照抄 approvalCallbackBackground.test.ts）
   - 分支惯例：feature 分支开发，验证绿后 merge 回 main 并 push（触发 CI+CD 到 10.10.0.2）
5. **UI 实现**：视觉与交互对齐既有视图惯例（卡片圆角/灰阶/导航语义参照 bindings 与 ledger）；含明显视觉设计的部分建议实现时走 designer 评审，但视觉规范不属于计划范围。
