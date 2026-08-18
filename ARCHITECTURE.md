# 大宗商品供应链贸易 AI 智能助手 — 架构说明

> 本文档记录产品架构决策与演进路线，作为后续开发的蓝图。原型已落地（见 `src/`），生产内核与后端服务按本文档推进。

---

## 1. 产品定位与核心原则

**定位**：私有化部署的企业级 AI Agent，服务于大宗商品（能源/化工/有色金属）供应链贸易公司。核心价值主张 = **业务语义行动层**——Agent 通过调用结构化业务工具完成任务，而非自由生成文本。

**五大原则**（不可妥协）：

| 原则 | 含义 | 工程映射 |
|---|---|---|
| 数据不出域 | 所有数据在客户内网处理 | 私有化部署 + 本地模型（Qwen 等）+ 工具层脱敏 |
| 可控优先 | 写操作必须经审批 | L1/L2/L3 权限分级 + 硬门审批回灌 |
| 工具优先 | 数字必须来自工具调用，禁止 LLM 编造 | 编排层硬约束：数字带来源/时间戳/凭证号 |
| 渐进自主 | Copilot → Autonomous 渐进 | 三模式（查一查/想一想/做一做）= 自主度刻度 |
| 可解释可追溯 | 每个决策点可审计 | 审计时间线 + 变更 Git-diff + 操作回放 |

**MVP 范围**：聚焦 trader（贸易员）角色，三类场景——单据处理 / 状态追踪 / 轻量对账。

**八大业务域**：合同 / 订单 / 仓储库存 / 结算资金 / 发票 / 客商 / 行情 / 风控。

---

## 2. 系统架构总览（三层）

```
┌─────────────────────────────────────────────────────────┐
│  前端原型层（已实现 · Vite + React 19 + TS）              │
│  3-pane Workspace / HITL 卡片 / 审计时间线 / 岗位工具集   │
│  负责：UX 自主度、对话流可视化、HITL 决策点交互            │
└─────────────────────────────────────────────────────────┘
                          ↕  (streamText / useChat / toolApproval)
┌─────────────────────────────────────────────────────────┐
│  Agent Harness 层（待建 · Vercel AI SDK 6 自研薄层）      │
│  ToolLoopAgent + 4 薄模块（见 §4）                        │
│  负责：loop 控制、岗位工具注入、权限 gate、HITL 协议、审计 │
└─────────────────────────────────────────────────────────┘
                          ↕  (MCP 协议 / tool calls)
┌─────────────────────────────────────────────────────────┐
│  后端数据服务层（待建 · Node/TS + MCP Server）            │
│  业务工具（read/write）+ 外部系统集成 + 持久化 + 审计落库  │
│  负责：真实业务数据接入、写操作落地、审批回灌、凭据管理    │
└─────────────────────────────────────────────────────────┘
```

**关键边界**：前端 Harness 管 loop 与 UX；后端服务管数据与集成。AuditRecorder + SessionStore 落在后端服务（持久化），RoleToolRegistry + PermissionGate 落在 Harness 进程侧。

---

## 3. 核心抽象：项目 = 合同执行上下文

借鉴 WorkBuddy 的「项目」模型，落地为本产品的组织原则：

- **项目（Project）= 一份合同的执行上下文**，捆绑该合同的规则/角色/SOP/连接器/文档库。
- **任务（Task）= 项目内的一次行动**（查合同/对账/挂提单/付款审批等）。
- **项目配置五元**（借鉴 WorkBuddy，已 mock）：
  - **指令** — 项目级护栏规则（如"金额变更需双人审批"）
  - **专家** — 角色助理人设（trader/risk/finance/management）
  - **连接器** — 数据接入（ERP/仓储/资金/行情，分只读查询 vs 写操作审批）
  - **技能** — 组合 SOP（如"三单匹配对账"）
  - **资料库** — 业务文档底座（4 层，见 §7）
- **配置注入策略**（借鉴 WorkBuddy）：项目配置 auto-inject 到该项目下的所有任务，pinned-priority（项目级置顶，但不硬隔离——全量工具池仍可达）。

---

## 4. Agent Harness 内核选型

### 推荐：Vercel AI SDK 6 + 自研薄 Harness（路径 A）

**选型结论**：

| 候选 | 结论 | 理由 |
|---|---|---|
| **Vercel AI SDK 6** | **采用** | `prepareStep`+`activeTools` 一等公民；`toolApproval` 原生支持软硬门；React 生态最完整；纯库零平台锁定 |
| Mastra | 退路 | 自托管 durable HITL 最强 + 原生工具权限引擎（allow/ask/deny）；但 RBAC 需 EE license，框架 opinionated |
| LangGraph.js | 模式借鉴 | `interrupt`+checkpointer 是 durable HITL 金标准；吸收其暂停/恢复/回放语义 |
| Dify 1.x | 排除 | 内核 Python（违反 TS 栈）+ UX 自主度几乎为零 + 多岗位=多应用 |
| Inkeep Agent Kit | 排除 | ELv2 许可 + 无 approval-gate 能力 |

### 关键风险（已识别）

**AI SDK 的 durable 硬门依赖 Vercel Workflows 托管平台**。`WorkflowAgent`+`needsApproval` 跨进程重启存活需要 Vercel 平台——**私有化部署下此能力断了**。`ToolLoopAgent` 纯内存，进程重启审批状态全丢。

**解法**：自建 `SessionStore`（落库 `UIMessage[]` + 任务状态 + 审批单号），硬门暂停点持久化，外部审批回灌后从存储恢复续跑。吸收 LangGraph `interrupt`/`Command({resume})` 与 Mastra `suspend`/`resume` 语义。

### 4 个自补薄层（约 1.5-2 人月）

```
ToolLoopAgent (loop + prepareStep activeTools + toolApproval)
   │
   ├─ 1. RoleToolRegistry    岗位(trader/risk/...) → 工具子集
   │                          prepareStep 每步按当前岗位注入 activeTools
   │
   ├─ 2. PermissionGate      在 toolApproval 回调内实现 L1/L2/L3 决策
   │                          L1 auto-approve / L2 'user-approval' / L3 转外部审批
   │                          借鉴 Mastra allow/ask/deny + 会话级 grants
   │
   ├─ 3. AuditRecorder       onToolExecutionStart/End + onStepEnd 全量落库
   │                          参数/返回/耗时/token/trace_id（参数脱敏）
   │
   └─ 4. SessionStore        自存 UIMessage[] + 任务状态 + 审批单
                              支持转交/恢复/回放（替代 WorkflowAgent 平台依赖）
```

---

## 5. 权限模型（L1/L2/L3）

工具按副作用风险分三级，决定是否需要人在回路：

| 等级 | 语义 | 触发机制 | 示例工具 |
|---|---|---|---|
| **L1 只读自动** | 无副作用查询 | 自动执行，不询问 | query_contract / query_orders / query_inventory / query_exposure |
| **L2 写需确认** | 内部写操作 | 软门：想一想 Plan 确认 | link_document / record_fund_flow / create_reconciliation_draft / advance_contract_stage |
| **L3 双人审批** | 资金/合同不可逆 | 硬门：系统内不提供资金类工具，经 escalate_to_human 工单转人工复核后续跑 | （无系统内工具；外部审批模拟已移除） |

**硬约束**：
- L3 必须职责分离（发起人 ≠ 审批人）
- L3 审批双通道：IM 通知 + 飞书原生审批回写对话
- 审批回灌后续跑，不重启会话（HITL 是上下文，非打断）

### 岗位工具集（已 mock，见 `src/data/mock.ts` ROLE_TOOLKITS）

四岗位五元映射（护栏/专家/技能/连接器/资料库）：

| 岗位 | 重心 | 典型 L3 工具 |
|---|---|---|
| trader 贸易员 | 执行（合同/订单/发货/对账） | 合同变更 |
| risk 风控专员 | 监控（敞口/盯市/授信） | 强平 / 授信调整 |
| finance 财务 | 资金（三单匹配/发票/收付款） | 付款 / 退款 |
| management 管理层 | 决策（KPI/异常/协同） | 战略调整 |

---

## 6. HITL 协议（5 介入形态）

| 形态 | 触发条件 | UI 落点 | 已实现 |
|---|---|---|---|
| 模式选择 | 用户主动选自主度 | ModeSelector（查/想/做） | 是 |
| 计划确认 | 想一想模式 + 复杂副作用 | Plan 卡片 [确认执行]/[修改]/[取消] | 是 |
| 硬审批门 | L3 工具调用 | ApprovalCard + 职责分离提示 | 是 |
| 不确定回退 | 模型置信低 / 数据缺失 | 黄色 uncertainty 卡 + 4 actions | 是 |
| 单据核验 | OCR 字段歧义 | 字段比对卡（置信度 + [确认]/[修正]/[重OCR]） | 是 |

**典型 HITL 全流程**（已 mock 为 T1-T6 demo，见 `HITL_DEMO_FLOW`）：
合同查询(T1 只读) → 对账 Plan(T2 软门) → 差异不确定(T3 回退) → 提单核验(T4 字段比对) → 付款审批(T5 硬门) → 审批回灌续跑(T6 阶段推进)。

---

## 7. 业务文档底座（4 层）

| 层 | 内容 | 接入方式 |
|---|---|---|
| 原件 | 合同 PDF / 提单扫描件 / 发票影像 | 对象存储 + OCR |
| 结构化抽取 | OCR 后的字段化数据 | 工具调用（带置信度） |
| 业务绑定 | 字段绑定到合同/订单/结算单 | 工具调用 + 人工核验 |
| 检索 | RAG 知识库 | 项目资料库（5GB，借鉴 WorkBuddy） |

**两条数据机制并行**（借鉴 WorkBuddy）：
- **项目资料库 RAG** — 静态文档知识注入（5GB）
- **MCP 连接器** — 实时业务数据工具调用（动态）

**数字零幻觉硬约束**（我们比 WorkBuddy 更严）：业务数字必须来自实时工具调用，禁止来自 RAG 或 LLM 编造。每个数字带来源/时间戳/凭证号。

---

## 8. 后端数据服务（待建）

### 工具清单（按业务域）

**读工具（L1）**：query_contract / query_orders / query_inventory / query_settlement / query_invoice / query_counterparty / query_market_price / query_exposure / cross_check

**写工具（L2/L3）**：link_document(L2) / record_fund_flow(L2) / create_reconciliation_draft(L2) / advance_contract_stage(L2)

### 工作量分解（6 桶）

| 桶 | 内容 | 估时（1人） |
|---|---|---|
| A. 读工具 | 5 域 × (源对接 + 工具封装 + 测试) | 15-25 人日 |
| B. 写工具 | 5 个 × (写入 + 审批集成 + 审计 + 回滚) | 15-25 人日 |
| C. 外部集成 | 飞书审批 MCP / 发票验真 / 行情源 | 10-15 人日 |
| D. MCP 封装 + Harness 后端 | MCP server + SessionStore + AuditRecorder + 凭据 | 14-22 人日 |
| E. RBAC + 多租户 | 工具级权限 + SSO/LDAP | 8-12 人日 |
| F. 私有化交付 | Docker + 监控 + 部署脚本 | 4-6 人日 |

### 三档交付

| 档位 | 范围 | 1人 | 2-3人并行 |
|---|---|---|---|
| Thin Slice | 3-5 读工具 + 最小持久化 | 30-45 人日 | 3-5 周 |
| MVP | trader 全场景（5读+5写+飞书审批+审计） | 60-80 人日 | 2-3 月 |
| Production | 8 域 + RBAC + 私有化交付 | 100-140 人日 | 4-6 月 |

**主导风险变量**：源 ERP/仓储/资金系统的 API 成熟度。有 OpenAPI → 上表成立；DB 直连 + 反查 schema → ×1.5-2；无 API 需 RPA → ×2-3。

### Thin Slice 起点（建议）

先打通一条线验证可行性：
1. 选 **query_contract + query_orders + cross_check** 三个读工具
2. 接一个真实源（临时建合同+订单视图表亦可）
3. MCP 封装最小化（3 工具）
4. 前端原型把现有 mock 换成真调用

验证三件事：① 真数据接入可行 ② Agent loop 调真工具不幻觉 ③ 私有化部署链路通。

---

## 9. 私有化与合规

### 数据不出域

- 全栈私有化部署（前端 + Harness + 后端服务 + 模型）
- 本地模型（Qwen 等），无外部 API 调用
- 工具层控制注入上下文的字段粒度，必要时只注入聚合值（如只给总额，不给明细）

### 凭据管理（直接抄 WorkBuddy）

- 加密存储 → 运行时代理层解密注入请求头
- `secrets` 支持 `${VAR_NAME}` 环境引用，不写入沙箱文件
- 个人授权票据仅本地不上云
- 网关按认证方式（OAuth 2.1 / API Key）自动注入

### 审计（必须自补，WorkBuddy 不足）

- 操作日志字段：操作类型 / 内容 / 端 / 人 / IP / 时间（秒级）
- **自补**：`trace_id` 关联链 / 操作回放 / 证据链（参数脱敏 + 审批单号 + 回滚 + 错误码）
- 变更 Git-diff 视图（已实现于 ResultPanel「变更」tab）
- 审计时间线（已实现于 ResultPanel「审计」tab）

### 可观测层（Langfuse OTel）— 已实现

Agent loop 全链路追踪，与 auditRecorder 通过 `auditTraceId` join：

- **路径**：AI SDK 6 原生 telemetry（OTel）→ `@langfuse/otel` 的 `LangfuseSpanProcessor` → 自托管 Langfuse（`http://10.10.0.2:3010`）
- **包**：`@langfuse/otel` + `@opentelemetry/sdk-node`（注意：`@langfuse/vercel-ai-sdk` 是 v7-only，v6 不能装）
- **自动捕获**（零手动埋点）：`invoke_agent` root → 每 step → `execute_tool` 嵌套 span 树（天然=agent loop 树）、LLM input/output/token/延迟、工具 args/result/耗时/错误、finishReason
- **业务 join**：streamText `experimental_telemetry.metadata.auditTraceId` 与 auditRecorder 每请求生成的 trace_id 一致 → Langfuse trace ↔ 业务审计日志可双向关联
- **配置**：`server/src/instrumentation.ts`（NodeSDK + LangfuseSpanProcessor，`sdk.start()`），在 `server/src/index.ts` **第一行** `import './instrumentation.js'`（OTel 必须在 AI SDK 加载前 init）；`.env` 加 `LANGFUSE_BASE_URL` / `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY`
- **实测**：trace 已确认落地（`GET /api/public/traces` 返回 invoke_agent root span 5.5s + 5 嵌套观测 + input/outputTokens + auditTraceId 元数据匹配）

---

## 10. 演进路线

| 阶段 | 目标 | 关键交付 |
|---|---|---|
| **已完成** | 原型验证 UX 与产品概念 | 3-pane / HITL T1-T6 / 项目层 / 岗位工具集 / Top5 UI |
| **Thin Slice** | 真数据打通一条线 | 3 读工具 MCP + 前端真调用 |
| **MVP** | trader 全场景闭环 | 5读+5写 + 飞书审批回灌 + 审计落库 + 私有化部署 |
| **Production** | 4 岗位全域 | 8 域 + RBAC + 多租户 + 监控 |

---

## 11. MVP 实施蓝图（开发起点）

> 本节是 §10「Thin Slice → MVP」的落地细化，作为编码起点。**纪律：砍到能跑通核心价值的最小集**。

### 11.1 MVP 边界

| 维度 | IN（MVP 做） | OUT（推 V2） |
|---|---|---|
| 角色 | trader 单角色 | risk/finance/management |
| 场景 | 单据处理 + 状态追踪 + 轻量对账 | 全 8 域 / 盯市 / 战略决策 |
| 业务域 | 合同 / 订单 / 仓储 / 结算 / 客商（5 域） | 行情 / 发票验真 / 风控模型 |
| 工具 | 3-5 读 + 2-3 写（demo 审批） | 全 13 工具 |
| HITL | 软门(Plan) + 硬门(付款审批) | 不确定回退 / OCR 核验（已有 mock，真后端可后接） |
| 多租户 | 单租户 | RBAC / SSO / 岗位工具集配置后台 |
| 记忆层 | **不引入**（已否决 mem0） | 自建偏好层（V2 储备，见 11.4） |

核心价值主张必须 demo 出来：工具优先（数字带来源）/ 可控优先（L2L3 审批）/ 可追溯（审计时间线）/ HITL（人在回路续跑）。

### 11.2 组件清单

**前端层**（已有原型，~1-2 周改 mock→真调用）：3-pane Workspace / HITL 卡片（Plan/Approval/uncertainty/OCR）/ 审计时间线 + 变更 Git-diff / 岗位工具集视图。

**Agent Harness 层**（待建，~1.5-2 人月）：AI SDK 6 ToolLoopAgent + 4 薄层（RoleToolRegistry / PermissionGate / AuditRecorder / SessionStore）。其中 SessionStore 最重（替代 Vercel Workflows 平台依赖，自建硬门暂停持久化 + 回灌续跑）。

**后端数据服务层**（待建，~2-3 月并行）：Hono + MCP Server + 4 读工具（query_contract/query_orders/query_inventory/cross_check）+ 3 写工具（create_payment L3 / link_document L2 / advance_contract_stage L2）+ 飞书审批连接器 + 凭据管理 + Postgres。

### 11.3 项目结构（MVP 起步）

```
supply-chain-agent-prototype/
├── src/                    # 前端（已有 Vite + React）
├── server/                 # 后端（新建）
│   ├── src/
│   │   ├── index.ts        # Hono server 入口
│   │   ├── routes/chat.ts  # /api/chat (AI SDK streamText + ToolLoopAgent)
│   │   ├── harness/        # 4 薄层
│   │   │   ├── roleToolRegistry.ts
│   │   │   ├── permissionGate.ts
│   │   │   ├── auditRecorder.ts
│   │   │   └── sessionStore.ts
│   │   ├── tools/          # 业务工具（内联起步，后封装 MCP）
│   │   ├── db/             # Drizzle schema + 迁移
│   │   └── env.ts          # 环境变量加载
│   ├── drizzle.config.ts
│   └── package.json
├── docker-compose.yml      # Postgres + 后端
├── .env                    # 已建（DeepSeek + DB 凭据）
└── ARCHITECTURE.md
```

### 11.4 记忆层决策（已评估未引入）

**结论：MVP 不引入 mem0，V2 自建偏好层。**

理由链：① mem0 与 4 薄层零重叠，是可选第 5 层非必需；② 业务事实走业务表 + MCP，交互偏好用结构化偏好表可覆盖；③ mem0 的 LLM 自由抽取与"数字零幻觉"结构性冲突（抽取出的记忆无 ground-truth，LLM 可能把记忆里的数字当事实引用，绕过"数字必须来自工具调用"铁律）；④ TS OSS 成熟度滞后 + 图记忆在 TS OSS 未明确覆盖。

**V2 自建偏好层（储备）**：pgvector + 本地 Qwen 固定模板抽取（禁数字）+ 结构化偏好表（软覆盖 valid_to）+ 规则注入。约 0.5-1 人月。机制比 mem0 更贴 B 端场景（量小、结构化、强可解释），且避开零幻觉冲突。

### 11.5 落地阶段（降序风险）

**阶段 1：后端骨架 + DeepSeek 连通**（~1 周） — ✅ **已完成**
- `server/` 目录 + Hono + AI SDK 6 + env 加载（zod 校验）
- `/api/chat` 端点用 `streamText` + `toUIMessageStreamResponse`（AI SDK 6 API，非 v5 的 `toDataStreamResponse`）
- `/api/health` 健康检查；Vite 代理 `/api` → `localhost:3001`
- 根 `package.json` 加 `dev:server` / `dev:all`（concurrently）
- **实测**：`deepseek-v4-flash` 可用（无需回退）；tsc 零错误；`/api/chat` 真实 token-by-token 流式；DeepSeek 自报身份验证通过
- 依赖：hono@4.13 / @hono/node-server@2 / ai@6.0.241 / @ai-sdk/openai@2.0.117 / zod@3.25 / dotenv@16 / tsx@4.23 / typescript@5.9

**阶段 2a：Thin Slice 真数据打通（后端）** — ✅ **已完成**（内存数据版）
- 内存播种 `server/src/data/seed.ts`（合同 HT-2024-001 柴油采购 ¥2,860,000 / 华盛集团 + 4 笔订单 + 库存；ORD-0883/0884 缺发票号）
- 3 读工具 `server/src/tools/queries.ts`：queryContract / queryOrders / crossCheck（AI SDK 6 `tool()`）
- `server/src/harness/roleToolRegistry.ts`（trader → 3 工具）+ `auditRecorder.ts`（结构化 JSON 日志）
- **实测**：DeepSeek 可靠调用工具 + 多工具智能编排（按需跳过 cross_check）+ **零幻觉确认**（HT-9999 假合同 → notFound → 如实说"数据不可得"不编造）
- Postgres+Drizzle 推迟（内存版已验证核心闭环）

**阶段 2c：前端接线（真实 DeepSeek + 工具调用渲染）** — ✅ **已完成**
- 前端装 `ai@6` + `@ai-sdk/react@4`（v6 拆分了 React hooks 包，见附录 D）
- `useChat` + `DefaultChatTransport` → `/api/chat`，body 带 `{ role: 'trader' }`
- 新增 `RealChatView.tsx` / `RealMessageItem.tsx` / `realChatUtils.ts`：聚合 UIMessage `parts`（text/tool-call/tool-result）渲染成步骤链，复用 deepSea/ToolSteps 美学
- TaskSidebar 顶部「演示模式/真实模式」toggle，**mock 演示完全保留**（HITL T1-T6/项目层零改动）
- 实测：查合同/查订单/假合同零幻觉三条全过；演示模式回归正常

**阶段 3：MVP 核心**（~2 月，2-3 人并行）
- **阶段 3a：写工具 + PermissionGate** — ✅ **已完成**
  - `permissionGate.ts`（L1/L2/L3 注册表，7 工具预注册）+ `tools/writes.ts`（link_document L2 / create_payment L3）
  - AI SDK 6 用 per-tool `needsApproval` 实现 L2 软门（emit `tool-approval-request`，不调用 execute，loop 停止）
  - L3 用 execute 自阻塞模式（返回 `{status:'blocked',ticketId}`）—— v6 needsApproval 不给模型叙述机会，L3 语言反馈必须走 execute
  - 实测：L1 自动 / L2 软门拦 execute / L3 硬门 blocked 输出 + 飞书审批叙述 / 零幻觉回归 全过
- **阶段 3b：前端 approval UI 接线** — ✅ **已完成**
  - `realChatUtils.ts`：新增 `approval-request` 渲染段（识别 `p.state==='approval-requested'` + `p.approval.id`）；`ToolCallStep.blocked` 字段识别 L3 `status:'blocked'`
  - `RealMessageItem.tsx`：`SoftGateCard`（L2 写操作确认卡：工具名+参数+确认执行/取消）+ `BlockedCard`（L3 外部审批卡：工单号+状态+原因+提示）
  - `RealChatView.tsx`：`addToolApprovalResponse` + `sendAutomaticallyWhen`（只在已回应所有审批或有需客户端继续的工具输出时自动续）+ onApprove/onDenie
  - build 816KB/gzip228KB 零错误；运行时需本地 dev:all（挂提单→确认卡→挂接成功；发起付款→外部审批卡 PAY-pending-xxx）
- SessionStore（硬门暂停持久化 + 恢复续跑）— ✅ **已完成**（SQLite WAL）
  - `harness/sessionStore.ts`（better-sqlite3 + WAL，4 表 sessions/session_messages/pending_approvals/authorized_tickets）+ `sessionContext.ts` + `agent.ts`（共享 runStream）+ `routes/approvalCallback.ts`（POST /api/approval/callback mock 飞书）
  - chat.ts：x-session-id header 复用/新建 session，load 前序消息，流完成后持久化响应
  - L3 续跑（A 方案=授权票据集）：create_payment 无票据→blocked+ticketId；callback→addAuthorizedTicket+append 指令→模型重调 create_payment(authorizedTicketId)→真执行
  - L2 续跑：append `{role:'tool',content:[{type:'tool-approval-response',approvalId,approved}]}`→resumeSession
  - 实测全过：curl **L2/L3 双向 round-trip 均 work**（L2 link_document→approval-request→callback→resume→executed CHG-xxx；L3 create_payment→blocked+ticketId→callback→resume→executed PAY-xxx）+ **进程重启状态存活**（杀进程→重启→同 session-id 问付款单号→模型从 SQLite 回溯正确回答）+ 零幻觉回归
  - 浏览器可视化：前端「模拟审批通过」调试按钮（RealChatView，POST /api/approval/callback），L3 round-trip 浏览器可验
- 飞书审批连接器（回灌打通）
- T3 escalate_to_human + T4 verify_document_fields 已实现（`server/src/tools/hitl.ts`，L1），HITL T1-T6 后端全流程可测
  - T3（不确定回退）：模型遇数据冲突/置信低/缺失→调 escalate_to_human→返 ESC-xxx 工单（不编造）
  - T4（OCR 核验）：调 verify_document_fields→返 per-field 置信度 + needsReview（低置信字段如实告知）
  - 实测：T3 金额冲突→ESC 工单 ✓ / T4 提单字段核验→49X0@0.61 needsReview ✓ / 零幻觉回归 ✓
  - 仅剩飞书真实回灌（需凭据）—— 后端 mock round-trip 已全通

**阶段 4：MVP 收尾**（~2-3 周）
- 凭据管理 + 数据脱敏中间件
- 审计时间线接真 AuditRecorder
- Docker Compose 私有化交付包
- 压测 + 安全审查

---

## 附录 A：技术栈

| 层 | 技术 | 说明 |
|---|---|---|
| 前端 | Vite 8 + React 19 + TS + Tailwind 3.4 + react-router-dom 7 + lucide-react | 已落地（原型） |
| Agent Harness | Vercel AI SDK 6（ToolLoopAgent + prepareStep + toolApproval） | 自研 4 薄层 |
| 后端 Web 框架 | Hono + @hono/node-server | TS 原生、轻、Web 标准 |
| 后端 ORM | Drizzle ORM | TS 原生、schema 即代码、Postgres 一等支持 |
| MCP | @modelcontextprotocol/sdk | 工具协议封装（Thin Slice 可先用内联工具，后封装 MCP） |
| **模型（开发期）** | **DeepSeek**（OpenAI 兼容，见 `.env`） | base_url=https://api.deepseek.com，model=deepseek-v4-flash |
| **模型（私有化生产）** | **Qwen**（本地部署，OpenAI 兼容） | 数据不出域；切换仅改 env |
| 持久化 | Postgres 16（+ pgvector 扩展，V2 启用） | 业务表 + SessionStore + AuditRecorder 共用单库 |
| 飞书审批 | 飞书审批 OpenAPI + webhook | L3 硬门回灌 |
| 部署 | Docker Compose（私有化）/ Vercel（前端原型） | MVP 单机起步 |
| 可观测 | pino 结构化日志 + Postgres audit 表 | MVP 先靠日志，V2 加 Prometheus |

### LLM 配置约定（本项目默认）

- 配置文件：项目根 `.env`（已 gitignore）
- 环境变量：`OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL`（AI SDK 6 默认读这套）
- 切换模型（DeepSeek↔Qwen）只改 `.env`，不动代码
- AI SDK 接入：`openai(model, { baseURL: process.env.OPENAI_BASE_URL })`

## 附录 B：可复用资源

- **WorkBuddy 研究报告**（lib-1 / ses_03a4b8a59ffet0I72npOIvkG0t）：项目模型、连接器、权限模式、凭据管理、MCP 集成
- **框架选型报告**（lib-1 同会话）：AI SDK / Mastra / LangGraph.js / Dify / Inkeep 能力矩阵 + 官方源 URL 清单
- **UI 借鉴分析**（obs-1 / ses_039fcc089ffeu3PndGmzQT658P）：RiskMetricCard / AuditTimeline / 字段级数据不可得 / ToolTag / 审批弹窗打磨

## 附录 C：官方文档源（选型依据）

- Vercel AI SDK: https://ai-sdk.dev/docs/agents/loop-control , https://ai-sdk.dev/docs/agents/building-agents
- AI SDK Tool Approvals: https://github.com/vercel/ai/blob/main/content/docs/03-agents/06-tool-approvals.mdx
- WorkflowAgent（durable + 平台依赖）: https://ai-sdk.dev/docs/agents/workflow-agent
- Mastra Agent Approval: https://mastra.ai/docs/agents/agent-approval
- Mastra Workflows HITL: https://mastra.ai/docs/workflows/suspend-and-resume
- Mastra AgentController Tool approvals: https://mastra.ai/docs/agent-controller/tool-approvals
- LangGraph.js Interrupts: https://docs.langchain.com/oss/javascript/langgraph/interrupts
- WorkBuddy Connector/MCP/Project: https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/

## 附录 D：AI SDK 6 实战踩坑（阶段 2 实测，必读）

> 这些是 v5→v6 的破坏性变更，文档示例多数还停留在 v5。后续所有后端工具/Harness 工作必须遵守。

| 项 | v5（旧，已失效） | v6（正确） | 后果 |
|---|---|---|---|
| **工具参数字段** | `tool({ parameters: z.object({...}) })` | `tool({ inputSchema: z.object({...}) })` | 用 `parameters` 会导致 `contractNo: any` + execute 匹配错误重载 |
| **工具循环停止条件** | `streamText({ maxSteps: 5 })` | `streamText({ stopWhen: stepCountIs(5) })` | `maxSteps` 在 v6 已移除；`stepCountIs` 是 `StopCondition` 工厂 |
| **响应序列化** | `result.toDataStreamResponse()` | `result.toUIMessageStreamResponse({ onError })` | v5 方法在 v6 不存在；前端 `useChat`/`DefaultChatTransport` 需要 UI-message 流 |
| **DeepSeek provider 路径** | `openai(model)` （默认 Responses API） | `openai.chat(model)` （Chat Completions API） | DeepSeek 兼容 Responses API 时工具调用 ID 关联错乱，报 `No tool call found for tool output with call_id ...`；切 `.chat()` 彻底解决，顺便消除 v2-compat 警告 |
| **前端消息格式** | 后端 zod `{ role, content: string }` | 后端须接 UIMessage `{ id, role, parts: [...] }` | AI SDK 6 `useChat` 发的是 UIMessage parts 格式，**不是**老 `{role, content:string}`；后端 zod 若按老格式校验会报 `messages: ["Required"]`（zod flatten 把数组元素错误折叠成顶层 Required，有误导性） |
| **UIMessage → model messages** | 直接把前端 messages 塞 streamText | `await convertToModelMessages(messages)` 再传 streamText | v6 `convertToModelMessages` 是 **async**（返回 Promise，须 await）；v5 的 `convertToCoreMessages` 已移除；后端 schema 放宽到 `z.array(z.any()).min(1)`，真实校验交给 convertToModelMessages |
| **React hooks 包位置** | `import { useChat } from 'ai/react'` | `import { useChat } from '@ai-sdk/react'`（需单独装 `@ai-sdk/react`） | v6 把 React hooks 从 `ai` 主包拆到独立包；`ai/react` 在 v6 已不存在，前端必须额外装 `@ai-sdk/react` |
| **工具审批属性** | `toolApproval` 选项（v7 语法） | per-tool `needsApproval` 属性（v6） | **docs.ai-sdk.dev 默认是 v7 文档**；v6 用 `tool({...,needsApproval:true})` 或 `{...tool,needsApproval:true}`；设 `toolApproval` 选项在 v6 无效 |
| **needsApproval 类型坑** | 直接在 `tool({needsApproval})` 内写 | 通过 `Record<string,Tool>` 类型 `{...tool,needsApproval:true}` 附加 | `needsApproval` 未在 `@ai-sdk/provider-utils` 的 `Tool` d.ts 声明，但 `ToolSet` Pick 它且运行时读取；直接写在 tool() 内 tsc 报错，展开附加类型安全 |
| **tool-approval-request part 形状** | 读 `part.toolCall.toolName` | 按 toolCallId 从同 assistant message 的 sibling `tool-call` part join | `response.messages` 中 tool-approval-request part **仅含 `{approvalId, toolCallId, signature?}`，无 toolCall**；只有 `result.content` 的 `ToolApprovalRequestOutput` 才有 `toolCall`。L2 pending 记录、toolName 推导须 join sibling，否则 toolName='unknown' → pending 不写 → callback 404 |
| **needsApproval 行为** | 调用 execute 后返回 | emit `tool-approval-request` chunk，**不调用 execute**，loop 停止（finishReason:'tool-calls'），无第二轮模型叙述 | 恢复需第二次调用追加 `{role:'tool',content:[{type:'tool-approval-response',approvalId,approved,reason}]}`；L3 若要模型语言反馈必须用 execute 自阻塞模式而非 needsApproval |
| **AI SDK 6 telemetry 选项名** | `telemetry`（v7） | `experimental_telemetry`（v6） | docs.ai-sdk.dev 默认 v7 文档；v6 streamText 选项是 `experimental_telemetry`；metadata 值须 OTel `AttributeValue` 原语（string/number/boolean/数组），不能嵌对象 |
| **Langfuse v6 集成包** | `@langfuse/vercel-ai-sdk` | `@langfuse/otel` 的 `LangfuseSpanProcessor` | `@langfuse/vercel-ai-sdk` 官方原文"For AI SDK ≤ 6, this package is not needed"——v7-only；v6 走 AI SDK 原生 OTel → `@langfuse/otel` + `@opentelemetry/sdk-node`，零手动埋点自动捕获 agent loop span 树 |
| **instrumentation.ts env-load 顺序** | 假设 process.env 已就绪 | instrumentation.ts 内部先 `dotenv.config({path:'../../.env'})` 再 `new LangfuseSpanProcessor()` | OTel 必须在 AI SDK 加载前 init（index.ts 第一行 import），但 LangfuseSpanProcessor 构造时读 `LANGFUSE_*`，此刻 env.ts 还没跑 dotenv → 报 "No public key provided" 警告且不导出；instrumentation.ts 必须自己先加载根 .env |
| **Langfuse Input/Output 字段空（属性名不匹配）** | 期望 AI SDK 6 的 `ai.prompt.messages`/`ai.response.text` 自动映射到 Langfuse Input/Output | Langfuse 3.68 只读 `langfuse.observation.input/output`（最高优先级）/ `gen_ai.prompt` / `gen_ai.completion`；AI SDK 6 发的是 `ai.*` 属性 → 内容在 span 属性里但 UI 字段 null（token 数正常） | 必须加 `GenAiSemConvEnricher` SpanProcessor（`server/src/telemetry/genAiEnricher.ts`）在 `LangfuseSpanProcessor` 导出前桥接 `ai.*`→`langfuse.observation.*`；包装链 `new GenAiSemConvEnricher(new LangfuseSpanProcessor())`。坑中坑：`gen_ai.input.messages`/`gen_ai.output.messages` 也不映射（实证测过），只有 `langfuse.observation.*` + `gen_ai.prompt`/`gen_ai.completion` 生效。`recordInputs`/`recordOutputs` 默认就是 true（非解决手段）。工具调用观察的 I/O 同样要桥接（`ai.toolCall.args`→input, `ai.toolCall.result`→output） |
| **流完成后持久化响应** | `result.response` 当 Promise 用 `.catch` | `result.response` 是 **PromiseLike 不是 Promise**（无 `.catch`） | 流完成后持久化常见坑；须双参 `.then(onFulfilled, onRejected)`，不能链 `.catch` |
| **L2 续跑消息类型** | 直接构造 tool-approval-response part | part 在 tool 消息 content 中运行时存在但 **未在 ToolContent TS 类型建模** | 需 `as unknown as ModelMessage` 类型转换；构造 `{role:'tool',content:[{type:'tool-approval-response',approvalId,toolCallId,approved,reason}]}` 后 resumeSession |
| **resume 级别** | 持久化每条 UIMessage | 持久化 `result.response.messages`（回合聚合 assistant+tool 消息） | `result.response.messages` 才是正确的 resume 级别；前序消息已在存储，传入 UIMessages 调用前 append 新回合的聚合结果 |
| **L3 vs L2 续跑复杂度** | 假设两者对称 | L3 是简洁路径（普通用户回合即可）；L2 需精确 approvalId 匹配 part | L3 续跑 = addAuthorizedTicket + append user 指令 + resumeSession（模型自然重调工具见 authorized_tickets 命中）；L2 续跑需精确 approvalId，**前端依赖前务必端到端验证** |

**护栏 system prompt（已生效，防幻觉）**：
> 所有业务数字必须来自工具调用结果，不得自行编造。如果工具未返回数据，明确告知用户数据不可得。

实测：DeepSeek 工具调用可靠，能智能选择工具子集（如多轮中按需跳过 cross_check），零幻觉（假合同号 → notFound → 如实说明）。
