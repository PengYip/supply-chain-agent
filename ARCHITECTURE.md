# 大宗商品供应链贸易 AI 智能助手 — 架构说明

> 本文档记录产品架构决策与演进路线。代码已落地为 npm workspaces 双包：`apps/web`（Vite + React 19 前端）+ `apps/server`（Hono + AI SDK 6 后端，含 Harness 与数据管道）。本文档以 2026-08 全面评审后的代码实况为准校订；仍属规划（未实现）的内容均显式标注「未实现」。
>
> 历史注：早期「前端原型 + server/」根目录布局已废弃，旧路径示例（根 `src/`、`server/`）一律读作 `apps/web/src/`、`apps/server/src/`。

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

## 2. 系统架构总览（已全部落地，双层单体）

```
┌─────────────────────────────────────────────────────────┐
│  apps/web（已实现 · Vite + React 19 + TS）                │
│  8 视图：chat / projects / graph / bindings / flows      │
│         / eval / favorites / parties（hash 路由）        │
│  纯渲染层：自研 SSE 管道消费后端事件流，不管理 loop       │
└─────────────────────────────────────────────────────────┘
            ↕  REST（/api/*，Better Auth 会话）+ SSE
┌─────────────────────────────────────────────────────────┐
│  apps/server（已实现 · Hono 单进程 :3001，单体分层）      │
│  • routes/ 16 组业务路由（chat/files/review/graph/…）     │
│  • harness/ 18 文件：agent + runManager + runSession     │
│    （后台运行时：消费 streamText 流、逐 chunk SSE 下发）  │
│    + permissionGate + roleToolRegistry + sessionStore    │
│    （SQLite/Postgres 双实现）+ auditRecorder + 注入防御   │
│  • pipeline/ 27 文件：摄取→解析→分块→打标→嵌入→抽取      │
│    →台账→图同步；tools/ + pipeline/tools/ 内联 AI SDK 工具│
│  • eval/ 评测运行器（agent 级 + 管线级，spawn 子进程）     │
└─────────────────────────────────────────────────────────┘
     ↕  Postgres+pgvector（管道库）/ SQLite（会话库）/ MinIO
        / Neo4j（实体图，投影视图）/ DeepSeek·Qwen / Langfuse
```

**关键边界（与早期设计不同）**：loop 完全在后端 `runSession` 内消费（`result.toUIMessageStream` 逐 chunk 经 SSE 下发，`sessionEvents` 先落回放缓冲再 fan-out）；前端是纯渲染层。原计划的 **MCP Server 数据层未建**——业务工具为 AI SDK 内联实现（`tools/` + `pipeline/tools/`），经 `buildGatedTools` 组合注入 `streamText`。审计与 SessionStore 均已落库（SQLite/Postgres 双实现）。

---

## 3. 核心抽象：项目 = 合同执行上下文

借鉴 WorkBuddy 的「项目」模型，落地为本产品的组织原则：

- **项目（Project）= 一份合同的执行上下文**，捆绑该合同的规则/角色/SOP/连接器/文档库。**已落地基础层**：`routes/projects.ts` + 前端 `ProjectsView`（创建/成员归属/rollup 统计/图同步故障隔离，memberships 为 SSOT）。
- **任务（Task）= 项目内的一次行动**（查合同/对账/挂提单/付款审批等）。
- **项目配置五元**（借鉴 WorkBuddy，**未实现**，仅设计储备）：
  - **指令** — 项目级护栏规则（如"金额变更需双人审批"）
  - **专家** — 角色助理人设（trader/risk/finance/management）
  - **连接器** — 数据接入（ERP/仓储/资金/行情，分只读查询 vs 写操作审批）
  - **技能** — 组合 SOP（如"三单匹配对账"）
  - **资料库** — 业务文档底座（4 层，见 §7）
- **配置注入策略**（借鉴 WorkBuddy，**未实现**）：项目配置 auto-inject 到该项目下的所有任务，pinned-priority（项目级置顶，但不硬隔离——全量工具池仍可达）。

---

## 4. Agent Harness 内核选型

### 推荐：Vercel AI SDK 6 + 自研薄 Harness（路径 A）

**选型结论**：

| 候选 | 结论 | 理由 |
|---|---|---|
| **Vercel AI SDK 6** | **采用（已落地）** | `stopWhen`/`prepareStep` 能力完整；v6 用 per-tool `needsApproval` 支持软门（`toolApproval` 是 v7 选项，v6 无效，见附录 D）；React 生态最完整；纯库零平台锁定 |
| Mastra | 退路 | 自托管 durable HITL 最强 + 原生工具权限引擎（allow/ask/deny）；但 RBAC 需 EE license，框架 opinionated |
| LangGraph.js | 模式借鉴 | `interrupt`+checkpointer 是 durable HITL 金标准；吸收其暂停/恢复/回放语义 |
| Dify 1.x | 排除 | 内核 Python（违反 TS 栈）+ UX 自主度几乎为零 + 多岗位=多应用 |
| Inkeep Agent Kit | 排除 | ELv2 许可 + 无 approval-gate 能力 |

### 关键风险（已识别）

**AI SDK 的 durable 硬门依赖 Vercel Workflows 托管平台**。`WorkflowAgent`+`needsApproval` 跨进程重启存活需要 Vercel 平台——**私有化部署下此能力断了**。`ToolLoopAgent` 纯内存，进程重启审批状态全丢。

**解法**：自建 `SessionStore`（落库 `UIMessage[]` + 任务状态 + 审批单号），硬门暂停点持久化，外部审批回灌后从存储恢复续跑。吸收 LangGraph `interrupt`/`Command({resume})` 与 Mastra `suspend`/`resume` 语义。

### 4 个自补薄层（已全部落地，实为 18 文件，见 `apps/server/src/harness/`）

```
streamText + 后台运行时（非 ToolLoopAgent；loop 在后端 runSession 内消费）
   │
   ├─ 1. RoleToolRegistry    岗位(trader) → 工具子集；静态 BASE 表
   │                          + getToolsForRole(deps) 组装 DbContext 依赖工具
   │                          （prepareStep/activeTools 每步窄化：未实现，
   │                            目前一次性注入全量工具集，见 registry 内注释）
   │
   ├─ 2. PermissionGate      静态注册表 + buildGatedTools 组合：
   │                          L1 直接执行 / L2 挂 per-tool needsApproval 软门 /
   │                          L3 无系统内工具，经 escalate_to_human 工单
   │
   ├─ 3. AuditRecorder       withAudit 单一咽喉包装全部工具 execute；
   │                          错误转结构化 result；内存 + console.log
   │                          （落库与脱敏：待建，见 V2 注释）
   │
   └─ 4. SessionStore        SQLite/Postgres 双实现；审批单与消息持久化，
                              进程重启后审批状态存活，回调从存储重建续跑
                              （已验证替代 WorkflowAgent 平台依赖）
```

另有超出原设计的横切层：runManager（单飞行槽 + 连接解耦后台运行）、sessionEvents（SSE 回放缓冲 + fan-out）、injectionDefense（路径穿越/注入防御）、errorClassification、compression、contextContract（工具契约断言）、statusAggregator、titleGen。

---

## 5. 权限模型（L1/L2/L3）

工具按副作用风险分三级，决定是否需要人在回路：

| 等级 | 语义 | 触发机制 | 实际工具（permissionGate.ts 注册表） |
|---|---|---|---|
| **L1 只读自动** | 无副作用查询 | 自动执行，不询问 | query_contract / query_orders / cross_check / recall_documents / execute_code / ingest_document / extract_fields / inspect_extraction / present_document_review / graph_find_entity / graph_query / list_binding_proposals / query_execution_flows / project_rollup / escalate_to_human / verify_document_fields |
| **L2 写需确认** | 内部写操作 | 软门：per-tool `needsApproval`（v6），前端 SoftGateCard 确认后经 `/api/approval/callback` 回灌续跑 | bind_document / tag_document / update_document_fields / create_entity / link_entities |
| **L3 双人审批** | 资金/合同不可逆 | 硬门：系统内不提供资金类工具，经 escalate_to_human（L1）落库工单转人工复核，前端 HumanReviewCard approve/deny 后续跑 | （无系统内工具） |

**硬约束（现状）**：
- L3 必须职责分离（发起人 ≠ 审批人）——工单已持久化，职责分离校验待接真实身份体系
- L3 审批双通道（IM 通知 + 飞书原生审批回写）：**未实现**，当前仅应用内 HTTP 回调（`/api/approval/callback`）
- 审批回灌后续跑，不重启会话（HITL 是上下文，非打断）——已实现且进程重启后状态存活（SQLite/PG 持久化 + 启动 busy→interrupted 自愈）

**已知缺口**：permissionGate 对未注册工具默认 L1（fail-open），且契约断言不校验 risk.level 与权限表一致——新工具漏注册即静默放行，待改 fail-closed（2026-08 评审 P1）。

### 岗位工具集（现状：仅 trader 一岗真实生效）

`Role = 'trader'`（roleToolRegistry.ts），注册 21 个工具名。原四岗位五元映射（护栏/专家/技能/连接器/资料库）与 `ROLE_TOOLKITS` mock 已随旧前端原型删除，risk/finance/management 岗位待建：

| 岗位 | 重心 | 状态 |
|---|---|---|
| trader 贸易员 | 执行（合同/订单/文档/对账/图谱） | ✅ 唯一已实现岗位 |
| risk 风控专员 | 监控（敞口/盯市/授信） | 未实现 |
| finance 财务 | 资金（三单匹配/发票/收付款） | 未实现 |
| management 管理层 | 决策（KPI/异常/协同） | 未实现 |

---

## 6. HITL 协议（介入形态与实现现状）

原设计 5 形态，「模式选择」与「计划确认」随旧前端原型（三模式/Plan 卡片）废弃，未重新实现；其余 3 形态为真实链路：

| 形态 | 触发条件 | UI 落点 | 实现现状 |
|---|---|---|---|
| 模式选择（查/想/做三模式） | 用户主动选自主度 | （原 ModeSelector） | ❌ 未实现（mock 已删；自主度刻度待重设计） |
| 计划确认 | 复杂副作用前先出计划 | （原 Plan 卡片） | ❌ 未实现（软门由 L2 确认卡承担） |
| 写确认软门 | L2 工具调用 | SoftGateCard（RealMessageItem）：工具名+参数+确认/取消 → `/api/approval/callback` 回灌续跑 | ✅ 真实链路，409 幂等/单飞防护 |
| 硬审批门（不确定回退） | 模型置信低/数据缺失/L3 工单 | escalate_to_human 落库工单 + HumanReviewCard（approve/deny + note） | ✅ 真实链路（简化版；原「黄色卡+4 actions」未保留） |
| 单据核验 | 抽取字段低置信 | present_document_review + DocumentReviewCard（逐字段修正，update_document_fields L2 回写） | ✅ 真实链路（无「重OCR」入口；T4 verify_document_fields 仍读 seed mock） |

**典型 HITL 全流程（真实链路）**：上传文档 → 按需解析（digital/MinerU/VLM 三分流）→ 抽取回写台账 → 低置信字段 DocumentReviewCard 核验/修正（L2 回写）→ 绑定建议 list_binding_proposals → bind_document（L2 软门确认）→ 不确定时 escalate_to_human 工单 → HumanReviewCard 审批 → 回调续跑。原 mock 版 T1-T6 demo（`HITL_DEMO_FLOW`）已随旧原型删除。

---

## 7. 业务文档底座（4 层）

| 层 | 内容 | 接入方式（实际） |
|---|---|---|
| 原件 | 合同 PDF / 提单扫描件 / 发票影像 | MinIO（`users/<uid>/` 前缀）+ INGEST_ROOT 展平存储 |
| 结构化抽取 | 解析后的字段化数据 | extract_fields 工具（带置信度，回写 contract_ledger；digital/MinerU/VLM 三分流解析） |
| 业务绑定 | 凭证绑定到合同/订单 | bind_document(L2) + binding_proposals 建议流 + 前端绑定工作台人工核验 |
| 检索 | RAG 知识库 | recall_documents：FTS5 + sqlite-vec 混合召回 + RRF 融合（分块打标过滤，可插拔 embedder） |

**两条数据机制并行**（借鉴 WorkBuddy）：
- **文档知识检索 RAG** — 已实现：上传→MinIO→按需解析→分块→打标→嵌入，`recall_documents` 工具做 FTS5 + sqlite-vec 混合召回 + RRF 融合（可插拔 embedder，未配 Ollama 时用确定性测试嵌入器）
- **业务数据实时工具调用** — 已实现为 AI SDK 内联工具（非 MCP）：台账优先（ledger-first），如 `query_contract` 先查 contract_ledger、未命中回退 seed 演示数据；`query_execution_flows` 六向流水真实物化

**数字零幻觉硬约束**（我们比 WorkBuddy 更严）：业务数字必须来自实时工具调用，禁止来自 RAG 或 LLM 编造。每个数字带来源/时间戳/凭证号。

---

## 8. 后端数据服务（已建，形态与原计划不同：内联工具而非 MCP）

### 工具清单（实际，按业务域）

**读工具（L1，16 个）**：query_contract（台账优先）/ query_orders / cross_check / query_execution_flows / project_rollup / list_binding_proposals / graph_find_entity / graph_query / recall_documents / execute_code（CubeSandbox 隔离执行）/ ingest_document / extract_fields / inspect_extraction / present_document_review / escalate_to_human / verify_document_fields

**写工具（L2，5 个）**：bind_document / tag_document / update_document_fields / create_entity / link_entities

**数据源现状**：合同台账（contract_ledger）与执行流水（execution_flows）为真实 DB 源；query_orders / cross_check / verify_document_fields 仍读 `data/seed.ts` 演示种子（半 mock，待退役）；仓储/行情/风控敞口工具未建。

### 工作量分解（6 桶，历史估算，保留供后续域扩展参考）

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

### Thin Slice 起点（历史规划，已超额完成）

当时建议先打通一条线验证可行性（已验证）：
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

### 审计（必须自补，WorkBuddy 不足）

- 操作日志字段：操作类型 / 内容 / 端 / 人 / IP / 时间（秒级）
- **自补目标**：`trace_id` 关联链 / 操作回放 / 证据链（参数脱敏 + 审批单号 + 回滚 + 错误码）
- 变更 Git-diff 视图 / 审计时间线 / 操作回放的前端 UI：**未实现**（原 ResultPanel mock 已随旧原型删除；当前审计仅 auditRecorder 内存/日志 + Langfuse 运维视角，业务侧时间线待建）
- auditRecorder 落库 + 参数脱敏：**待建**（当前内存 + stdout，2026-08 评审 P0/P1）

### 凭据管理（直接抄 WorkBuddy，未实现，规划储备）

- 加密存储 → 运行时代理层解密注入请求头
- `secrets` 支持 `${VAR_NAME}` 环境引用，不写入沙箱文件
- 个人授权票据仅本地不上云
- 网关按认证方式（OAuth 2.1 / API Key）自动注入

### 可观测层（Langfuse OTel）— 已实现

Agent loop 全链路追踪，与 auditRecorder 通过 `auditTraceId` join：

- **路径**：AI SDK 6 原生 telemetry（OTel）→ `@langfuse/otel` 的 `LangfuseSpanProcessor` → 自托管 Langfuse（`http://10.10.0.2:3010`）
- **包**：`@langfuse/otel` + `@opentelemetry/sdk-node`（注意：`@langfuse/vercel-ai-sdk` 是 v7-only，v6 不能装）
- **自动捕获**（零手动埋点）：`invoke_agent` root → 每 step → `execute_tool` 嵌套 span 树（天然=agent loop 树）、LLM input/output/token/延迟、工具 args/result/耗时/错误、finishReason
- **业务 join**：streamText `experimental_telemetry.metadata.auditTraceId` 与 auditRecorder 每请求生成的 trace_id 一致 → Langfuse trace ↔ 业务审计日志可双向关联
- **配置**：`apps/server/src/instrumentation.ts`（NodeSDK + LangfuseSpanProcessor，`sdk.start()`），在 `apps/server/src/index.ts` **第一行** `import './instrumentation.js'`（OTel 必须在 AI SDK 加载前 init）；`.env` 加 `LANGFUSE_BASE_URL` / `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY`。I/O 字段桥接见 `apps/server/src/telemetry/genAiEnricher.ts`（GenAiSemConvEnricher，详见附录 D）
- **实测**：trace 已确认落地（`GET /api/public/traces` 返回 invoke_agent root span 5.5s + 5 嵌套观测 + input/outputTokens + auditTraceId 元数据匹配）

---

## 10. 演进路线

| 阶段 | 目标 | 关键交付 | 状态 |
|---|---|---|---|
| **原型验证** | UX 与产品概念验证 | 3-pane / HITL T1-T6 / 项目层 / 岗位工具集 mock | 已完成，mock 原型已删除 |
| **MVP 内核** | 真实后端闭环 | Harness（权限门+持久化 HITL+审计咽喉+后台运行时）/ 文档摄取管线（解析→分块→嵌入→抽取→台账）/ 绑定工作台 / Neo4j 实体图 / 项目层 / eval 双层体系 / Better Auth 多用户隔离 / 双库（SQLite+Postgres） | ✅ 已完成（远超原 Thin Slice 范围） |
| **MVP 收尾** | 安全与可追溯补齐 | 审计落库+脱敏 / 前端审计时间线 / seed 退役 / 飞书真实回灌 / 权限 fail-closed | 进行中（详见 2026-08 评审 P0/P1 清单） |
| **Production** | 4 岗位全域 | 8 域工具 + RBAC + 多租户 + 监控 | 未开始 |

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

### 11.2 组件清单（现状校订）

**前端层**（已起出原型范围）：8 视图 hash 路由（chat / projects / graph / bindings / flows / eval / favorites / parties）+ 自研 SSE 消息管道（重连对账/去重/双发守卫）+ HITL 卡片（SoftGateCard / HumanReviewCard / DocumentReviewCard）。原 3-pane mock、Plan 卡、审计时间线 mock 已删。

**Agent Harness 层**（已建成，实为 18 文件）：见 §4——streamText + runManager/runSession 后台运行时 + permissionGate/roleToolRegistry + sessionStore（SQLite/Postgres 双实现）+ auditRecorder + 注入防御/错误分类/压缩等横切层。

**后端数据服务层**（已建成，形态调整：Hono 单体而非 MCP Server）：16 组路由 + 21 个内联工具（§8 清单）+ 文档摄取管线（digital/MinerU/VLM 三分流解析→分块→打标→嵌入→抽取回写台账）+ Neo4j 图投影同步 + eval 运行器 + Postgres/SQLite 双库 + MinIO 文件 + Better Auth 鉴权。

### 11.3 项目结构（实际，npm workspaces）

```
supply-chain-agent-prototype/
├── apps/
│   ├── web/                    # 前端 @sca/web（Vite + React 19 + TS + Tailwind）
│   │   └── src/{components,hooks,api,lib,utils}
│   └── server/                 # 后端 @sca/server（Hono + AI SDK 6）
│       ├── src/
│       │   ├── index.ts        # 入口（第一行 import instrumentation；路由挂载 SSOT）
│       │   ├── instrumentation.ts / env.ts
│       │   ├── routes/         # 16 组业务路由
│       │   ├── harness/        # 18 文件（agent/runManager/runSession/…）
│       │   ├── pipeline/       # 文档管道 + db/（双库 client/repositories）+ tools/
│       │   ├── graph/          # Neo4j 投影同步 + 图工具
│       │   ├── domain/         # 合同类型/资金方向/贸易语义
│       │   ├── tools/          # 静态工具（queries/hitl）
│       │   ├── lib/            # auth / auth-middleware / minio
│       │   ├── data/           # seed.ts（演示种子，待退役）
│       │   └── telemetry/      # genAiEnricher（Langfuse I/O 桥接）
│       ├── test/               # vitest（115 个测试文件）
│       ├── eval/               # 评测（agent 级 + 管线级）
│       └── drizzle.config.ts
├── docker-compose.yml      # 本机 dev 用（Postgres + pgvector）
├── ecosystem.config.cjs     # PM2（sca-server，单实例）
├── .github/workflows/       # CI + CD（自托管 runner，push main 部署）
├── .env                     # 项目根共享 env（后端读这里）
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
- 内存播种 `apps/server/src/data/seed.ts`（合同 HT-2024-001 柴油采购 ¥2,860,000 / 华盛集团 + 4 笔订单 + 库存；ORD-0883/0884 缺发票号）
- 3 读工具 `apps/server/src/tools/queries.ts`：queryContract / queryOrders / crossCheck（AI SDK 6 `tool()`）
- `apps/server/src/harness/roleToolRegistry.ts`（trader → 3 工具）+ `auditRecorder.ts`（结构化 JSON 日志）
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
- 飞书审批连接器（回灌打通）——**仍未实现**，当前仅应用内 HTTP 回调（/api/approval/callback）
- T3 escalate_to_human + T4 verify_document_fields 已实现（`apps/server/src/tools/hitl.ts`，L1），HITL T1-T6 后端全流程可测
  - T3（不确定回退）：模型遇数据冲突/置信低/缺失→调 escalate_to_human→返 ESC-xxx 工单（不编造）
  - T4（OCR 核验）：调 verify_document_fields→返 per-field 置信度 + needsReview（低置信字段如实告知；仍读 seed mock OCR，待接真管线）
  - 实测：T3 金额冲突→ESC 工单 ✓ / T4 提单字段核验→49X0@0.61 needsReview ✓ / 零幻觉回归 ✓
  - 仅剩飞书真实回灌（需凭据）—— 后端 mock round-trip 已全通

**阶段 3+：MVP 内核之后已落地的追加模块**（原蓝图未列，现状校订）：
- **SSE 后台运行时**：chat 发起即返回，runSession 后台消费流、sessionEvents 回放缓冲 + fan-out，/api/sessions/:id/status + /events 实时状态
- **文档摄取管线**：上传→MinIO+stub→按需解析（digital 适配器 / MinerU 扫描件 / VLM 三分流）→分类→分块→打标→嵌入（sqlite-vec）→抽取回写台账；绑定建议（binding_proposals）与绑定工作台
- **实体图投影**：Neo4j（memberships 为 SSOT，图同步故障隔离、幂等 MERGE）+ graph_query/graph_find_entity/create_entity/link_entities 工具
- **项目层与 rollup**：projects 路由 + 前端视图 + project_rollup 工具
- **eval 双层体系**：管线级（字段准确率/span 接地率/HITL p&r）+ agent 级（driver/用户模拟/judge/verifier/rubric）+ 前端 eval 工作台
- **多用户与数据隔离**：Better Auth（emailAndPassword）+ attachSession/requireAuth + 全路由 userId 域过滤
- **双库**：管道库 Postgres+pgvector（drizzle-kit）/ 会话库 SQLite，均含幂等迁移
- **执行流水六向物化**：executionFlow + query_execution_flows 工具 + 前端 FlowsView

**阶段 4：MVP 收尾**（~2-3 周，进行中）
- 凭据管理 + 数据脱敏中间件 —— 未实现
- 审计时间线接真 AuditRecorder —— 未实现（auditRecorder 待落库+脱敏）
- Docker Compose 私有化交付包 —— dev 用已有（docker-compose.yml），生产用 PM2+自托管 Runner CI/CD
- 压测 + 安全审查 —— 安全审查已完成（2026-08 全面评审，P0/P1 清单见评审报告）

---

## 附录 A：技术栈

| 层 | 技术 | 说明 |
|---|---|---|
| 前端 | Vite + React 19 + TS + Tailwind + lucide-react | 已落地（apps/web，8 视图 hash 路由，无 react-router） |
| Agent Harness | Vercel AI SDK 6：streamText + stopWhen + per-tool needsApproval（v6） | 自研 18 文件 harness（apps/server/src/harness） |
| 后端 Web 框架 | Hono + @hono/node-server | TS 原生、轻、Web 标准；生产同源服务前端静态文件 |
| 后端 ORM | Drizzle ORM（Postgres 路径）+ 原始幂等 DDL（SQLite 路径） | 双轨并存（已知三轨漂移风险，见评审 P1） |
| MCP | （未采用） | 工具为 AI SDK 内联实现；MCP 封装仍是可选演进方向 |
| **模型（开发期）** | **DeepSeek**（`@ai-sdk/deepseek`，见 `.env`） | createDeepSeek(...).chat(env.OPENAI_MODEL)，默认 deepseek-v4-flash |
| **模型（私有化生产）** | **Qwen**（本地部署，OpenAI 兼容） | 数据不出域；切换仅改 env |
| 持久化 | 会话库 SQLite（默认）/ 管道库 Postgres 16 + pgvector | 双库并存；MinIO 文件、Neo4j 实体图投影 |
| 飞书审批 | 飞书审批 OpenAPI + webhook | **未实现**，当前应用内 HTTP 回调模拟 |
| 部署 | PM2（sca-server 单实例）+ 自托管 GitHub Runner CI/CD；Docker Compose 仅本机 dev | push main 自动部署 + SHA 自校验 |
| 可观测 | OTel + Langfuse（自托管）+ auditRecorder（内存/日志，待落库） | 见 §9 |

### LLM 配置约定（本项目默认）

- 配置文件：项目根 `.env`（已 gitignore；后端读根 .env，非 apps/server/.env）
- 环境变量：`OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL`（`apps/server/src/env.ts` zod 契约为 SSOT）
- 切换模型（DeepSeek↔Qwen）只改 `.env`，不动代码
- AI SDK 接入：`createDeepSeek({ apiKey, baseURL }).chat(model)`（agent.ts；经 `.chat()` 走 Chat Completions，避免 DeepSeek Responses API 的 tool-call id 损坏，见附录 D）

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
| **Langfuse Input/Output 字段空（属性名不匹配）** | 期望 AI SDK 6 的 `ai.prompt.messages`/`ai.response.text` 自动映射到 Langfuse Input/Output | Langfuse 3.68 只读 `langfuse.observation.input/output`（最高优先级）/ `gen_ai.prompt` / `gen_ai.completion`；AI SDK 6 发的是 `ai.*` 属性 → 内容在 span 属性里但 UI 字段 null（token 数正常） | 必须加 `GenAiSemConvEnricher` SpanProcessor（`apps/server/src/telemetry/genAiEnricher.ts`）在 `LangfuseSpanProcessor` 导出前桥接 `ai.*`→`langfuse.observation.*`；包装链 `new GenAiSemConvEnricher(new LangfuseSpanProcessor())`。坑中坑：`gen_ai.input.messages`/`gen_ai.output.messages` 也不映射（实证测过），只有 `langfuse.observation.*` + `gen_ai.prompt`/`gen_ai.completion` 生效。`recordInputs`/`recordOutputs` 默认就是 true（非解决手段）。工具调用观察的 I/O 同样要桥接（`ai.toolCall.args`→input, `ai.toolCall.result`→output） |
| **流完成后持久化响应** | `result.response` 当 Promise 用 `.catch` | `result.response` 是 **PromiseLike 不是 Promise**（无 `.catch`） | 流完成后持久化常见坑；须双参 `.then(onFulfilled, onRejected)`，不能链 `.catch` |
| **L2 续跑消息类型** | 直接构造 tool-approval-response part | part 在 tool 消息 content 中运行时存在但 **未在 ToolContent TS 类型建模** | 需 `as unknown as ModelMessage` 类型转换；构造 `{role:'tool',content:[{type:'tool-approval-response',approvalId,toolCallId,approved,reason}]}` 后 resumeSession |
| **resume 级别** | 持久化每条 UIMessage | 持久化 `result.response.messages`（回合聚合 assistant+tool 消息） | `result.response.messages` 才是正确的 resume 级别；前序消息已在存储，传入 UIMessages 调用前 append 新回合的聚合结果 |
| **L3 vs L2 续跑复杂度** | 假设两者对称 | L3 是简洁路径（普通用户回合即可）；L2 需精确 approvalId 匹配 part | L3 续跑 = addAuthorizedTicket + append user 指令 + resumeSession（模型自然重调工具见 authorized_tickets 命中）；L2 续跑需精确 approvalId，**前端依赖前务必端到端验证** |

**护栏 system prompt（已生效，防幻觉）**：
> 所有业务数字必须来自工具调用结果，不得自行编造。如果工具未返回数据，明确告知用户数据不可得。

实测：DeepSeek 工具调用可靠，能智能选择工具子集（如多轮中按需跳过 cross_check），零幻觉（假合同号 → notFound → 如实说明）。
