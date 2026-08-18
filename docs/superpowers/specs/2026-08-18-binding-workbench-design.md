# 绑定工作台设计（Binding Workbench）

日期: 2026-08-18
状态: 已获用户逐节确认（后端 / 前端 / 收尾三节）

## 1. 背景与问题

文档绑定（单据 -> 合同）目前只有对话式交互：用户在聊天中让 Agent 调
`list_binding_proposals`（L1）看建议，再经 `bind_document`（L2）+ SoftGateCard
审批流确认。交互困难、低效，且无法直观回答三个问题：

1. 哪些文档未绑定？
2. 哪些已绑定？
3. 未绑定文档有哪些系统建议的绑定？

现状侦察要点（详见 exp-3）：

- bindings 表已有完整状态机原语（confirmed/proposed/rejected +
  confirmation_source/proposed_by/evidence），`rejected` 有状态无调用方。
- 建议生成 `generateBindingProposals`（bindingProposal.ts）是纯函数，但只在
  图片凭证（货转单/付款凭证/化验报告）入库分支内联调用；发票/提单从不生成。
- `bind_document` 确认后只调 `linkDocumentToContract` 改内存 seed，不写图、
  不写台账。
- 无任何 bindings REST 路由，前端无法直接拉取。
- 图谱边类型仅 party/commodity/references/executes（抽取级"提及"语义），
  无人工确认的"绑定"语义边。

## 2. 目标与非目标

### 目标

- 独立导航页"绑定工作台"：未绑定/已绑定文档一目了然，系统建议带评分证据。
- 操作能力：确认建议 / 拒绝建议 / 手动创建绑定 / 批量确认 / 解除已有绑定。
- 系统建议按需生成：对任意已抽取未绑定文档，实时跑
  `generateBindingProposals` x contract_ledger，纯计算不落库。
- 确认/手动绑定同步写图谱边 `Document-[binds]->Contract`；解绑删边；图谱页
  可视化 binds 边（与抽取级 references/executes 视觉区分）。

### 非目标（明确不做）

- 不改对话式 bind_document 工具及其审批链路（保持现状；与工作台共享
  repositories 层保证数据一致）。
- 不做全量同步（contract_ledger 关联回写等，方案比选时被否）。
- 不新增数据库唯一约束（存量可能有重复行，建 UNIQUE INDEX 有迁移风险；
  继续靠 findBindingByDocAndContract 先查后写防重）。
- 前端不新增测试基建（沿用 web 无测试的现状）。

## 3. 方案比选结论

采用**方案 A：薄 REST + 表格型工作台**。工作台页面直连后端 REST（写操作
页面内二次确认弹窗），不经对话 Agent、不走 /api/approval/callback 的 SDK
重跑链路。审计依赖 bindings 表既有字段（confirmation_source='human'、
created_by、proposed_by）+ 状态机痕迹（rejected 行保留审计链）。

否决：方案 B（写走 Agent 工具，交互回到聊天确认老路）；方案 C（读写混合
双入口，复杂度最高）。

## 4. 澄清决策记录

| # | 问题 | 决策 |
|---|------|------|
| 1 | 绑定对象 | 单据 -> 合同，沿用现有 bindings 模型 |
| 2 | 操作范围 | 确认/拒绝建议 + 手动创建 + 批量确认 + 解除绑定（全选） |
| 3 | 建议生成范围 | 全部文档按需生成（含弱候选展示，不自动落库） |
| 4 | 确认后持久化 | bindings 表 + 同步写图谱边（binds） |
| 5 | 页面入口 | 独立导航页（与图谱/评估并列） |

## 5. 后端设计

### 5.1 REST 端点（新增 `apps/server/src/routes/bindings.ts`，requireAuth）

读：

| 端点 | 语义 |
|------|------|
| GET /api/bindings/overview | 每文档绑定状态总览：{docId, 文件名, docType, createdAt, bindings[]}，前端按未绑定/已绑定分组 |
| GET /api/bindings/proposals | 现有 status=proposed 行（join documents 取 docType/文件名） |
| GET /api/bindings/candidates?documentId= | 按需生成：对该文档跑 generateBindingProposals x contract_ledger，纯计算不落库；返回全部候选（含 <0.75 弱候选，按分排序，含四维评分证据） |
| GET /api/bindings/contracts | 合同台账列表（手动绑定选合同用） |

写（页面直连，前端二次确认弹窗）：

| 端点 | 语义 |
|------|------|
| POST /api/bindings/confirm {bindingId} | proposed -> confirmed（updateBindingStatus 'human'）+ 图谱边；若已非 proposed 返回 409 |
| POST /api/bindings/reject {bindingId} | proposed -> rejected（补上缺失的 rejected 调用方） |
| POST /api/bindings {documentId, contractNo, relation} | 手动建绑定（saveBinding confirmed/human/agent）+ 图谱边 |
| POST /api/bindings/unbind {bindingId} | confirmed -> rejected（复用状态保留审计痕迹）+ 删图谱边 |
| POST /api/bindings/batch-confirm {bindingIds[]} | 顺序执行返回逐条结果，部分成功不回滚 |

### 5.2 图谱同步服务（新增 `apps/server/src/pipeline/bindingGraphSync.ts`）

- 确认/手动建：MERGE Contract 节点（幂等，归一化名）+ MERGE
  `Document-[binds]->Contract` 边，props: {bindingId, relation,
  confirmationSource}。与抽取级 references/executes（提及）语义区分。
- 解绑：删边（repo.ts 新增 removeEdge，按 src/type/dst 匹配）——仅当同一
  (document, contract) 对没有其他 confirmed 绑定时才删（防重复行场景误删
  共享边；先查 bindings 再删）。
- 同步状态持久化：bindings 表经 ALTER 新增 graph_status 列（JSON，模式同
  documents.graph_status：'ok'|'skipped'|'failed' + 失败原因），写端点在
  业务落库后更新；overview 返回该字段驱动前端"图谱未同步"角标与重试。
- 图谱不可用（NEO4J_PASSWORD 未设 / 连接失败）**不阻塞**业务写入；响应携带
  `graphSync: 'ok'|'skipped'|'failed'` 字段。
- 前端图谱页（graph/kinds.ts）新增 binds 边样式（区别色 + "绑定"标签）。

## 6. 前端设计

### 6.1 入口与结构

- App.tsx 导航新增"绑定"图标（lucide Link2），view state machine 加
  'bindings'，与图谱/评估并列。
- 三栏布局（复用图谱页骨架 + deepSea 设计语言，含 PanelRail 可折叠）：
  - 左栏：文档列表，未绑定(N) / 已绑定(M) 分组，docType 徽章 + 日期。
  - 中栏：选中文档的候选合同列表（评分进度条 + route 徽章 + 证据可展开）；
    底部"手动创建绑定"入口；批量多选 checkbox。
  - 右栏：详情/操作区——候选的锚点 vs 台账字段对照表（逐项匹配标记）、
    四维评分明细、确认/拒绝；已绑定文档的绑定条目 + 解绑。

### 6.2 交互流

- 点未绑定文档 -> 中栏自动拉 candidates（已有 proposals + 按需生成合并，
  按分排序），弱候选灰显。
- 确认/拒绝：行内按钮 -> 二次确认弹窗（含影响说明）-> 乐观更新 + 失败回滚。
- 批量确认：多选 + 底部按钮，仅 auto_rule 高分项默认选中。
- 手动绑定：合同下拉（台账搜索）+ 关系类型下拉（常用值：货权转移/付款/
  质检/凭证，对应 bindingRelationFor 映射；支持自定义）+ 置信度说明。
- 解绑：已绑定文档详情内"解除"按钮。
- 图谱联动：binds 边渲染；绑定详情可跳图谱页（以 Contract 节点为中心）。

### 6.3 数据获取

新 hook `useBindings`（useFiles/useGraph 模式：fetch + useCallback +
useEffect），无全局状态库。

## 7. 错误处理与边界

- 写操作失败：乐观更新回滚 + toast 错误（保留服务端错误详情）。
- 图谱同步失败：业务不回滚，bindings.graph_status 持久化失败状态，绑定
  条目显示"图谱未同步"角标 + 详情面板"重试同步"（幂等 MERGE 重跑，成功后
  更新 graph_status）。
- 候选生成：无锚点文档中栏提示"缺少可匹配字段，建议手动绑定"。
- 并发冲突：重复确认同一建议 -> 409，前端刷新列表。
- 重复绑定同一合同：confirm 前查已有 confirmed 行，幂等返回成功。
- unbind 后重绑：rejected 行保留，新建 confirmed 行（审计链完整）。
- 台账为空：手动绑定表单提示先上传合同。
- 批量部分失败：逐条结果返回，前端标注失败项。

## 8. 测试策略

- 后端 vitest 集成测试（参考 test/routes/ 现有模式）：五个写端点的状态机
  流转、409 幂等语义、candidates 纯计算正确性、图谱同步 skipped（无
  NEO4J_PASSWORD）不阻塞业务。
- 前端：不新增测试基建（现状沿用）。
- 手动验收（dev 环境）：上传凭证 -> 工作台看建议 -> 确认 -> 图谱页见
  binds 边 -> 解绑删边，全链路走通。

## 9. 实现拆分（writing-plans 细化）

- Lane 1（后端）：routes/bindings.ts + bindingGraphSync.ts + repo.ts
  removeEdge + 图谱 kinds 边样式常量（前后端契约先行）。
- Lane 2（前端）：BindingsView 页面 + useBindings hook + 导航入口。
- 两 lane 契约（端点形状/响应字段）先冻结，后并行。

## 10. 已知限制与后续工作

- 对话式 bind_document 工具确认的绑定不写图谱边（内存 seed 遗留行为保留），
  与工作台行为不一致；后续可让工具复用 bindingGraphSync 统一。
- bindings 无唯一约束，先查后写在并发下理论可重复；如成为实际问题再做
  数据迁移 + UNIQUE INDEX。
- rejected 行会随时间累积，暂无清理策略。
