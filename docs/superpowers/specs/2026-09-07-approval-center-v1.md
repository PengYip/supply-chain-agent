# 审批中心 v1 — 设计规格（Spec）

日期：2026-09-07
状态：定稿，已实施并合并 main（2026-09-07，CI/CD 绿；实施计划见 docs/superpowers/plans/2026-09-07-approval-center-v1.md）
适用仓库：D:\Users\yepeng\supply-chain-agent-prototype（npm workspaces）

## 1. 背景与目标

现有 HITL 审批散落在对话流里：L2 在消息内嵌 ApproveDeny 卡片、L3 是 blocked 工单卡片，均无跨会话视图、无决策人/理由留痕、无执行副作用记录。本任务新建**自建审批中心 v1**：跨会话审批工作台（待办/已办、详情、带理由的批准/拒绝、副作用审计、跳转会话），并预留**外部审批（飞书审批）适配接口**。

## 2. 核心设计原则

1. **通用工作流壳**：审批中心不感知具体业务实体/工具。票据 payload = `pending_approvals.input_json` 透传渲染。新增实体、边、工具（如 create_entity/link_entities）时审批中心**零改动**——这是硬性验收项。
2. **pending_approvals 是票据 SSOT**：扩列，不新建表。
3. **双后端同构**：SQLite raw DDL 与 Postgres drizzle 列对列镜像，JSON 存 TEXT（沿用 sessionStoreSqlite.ts:69-72 注释确立的约定）。
4. **一条决策路径**：新页面与聊天卡片共用既有 `POST /api/approval/callback`。

## 3. 范围

**IN（v1）**
- `pending_approvals` 扩列：decided_by / decided_at / reason / side_effect_results
- 新端点：`GET /api/approval/list`、`GET /api/approval/:id`
- callback 落库决策人与理由
- ApprovalChannel 适配层 seam（local 实现；飞书仅留接口与 env 开关）
- appendSideEffect 存储 helper + L2 批准后工具执行自动记录副作用
- 前端：导航「审批中心」入口、列表页（tab + 10s 轮询）、详情抽屉（payload/理由/副作用/会话跳转）、状态栏待办数链接

**OUT（v1，明确不做）**
- 飞书审批实际对接（仅 seam + env）
- 多人审批/会签/审批角色矩阵（owner-only）
- 票据过期/超时机制
- L3 副作用自动捕获（L3 会话内叙事即记录，字段留空）
- 审批中心实时推送（轮询足够）
- ontology.ts 落地（独立任务，与本 spec 解耦）

## 4. 现状基线（2026-09-07 代码摸底）

- 路由：仅 `POST /api/approval/callback`（apps/server/src/routes/approvalCallback.ts:48），requireAuth 于 index.ts:117 全覆盖 /api/approval/*。
- 存储：`pending_approvals`（id, session_id, level, tool_name, tool_call_id, input_json, ticket_id, approval_id, status, created_at），L2 键 approval_id、L3 键 ticket_id（ESC-xxx）；facade 在 src/harness/sessionStore.ts，双后端 sessionStoreSqlite.ts:530 / sessionStorePostgres.ts:164（createAgentSessionStore）。
- `sessions.user_id` 可空（DDL :80）；跨会话归属过滤沿用全库 3-way OR 惯例（user_id = ? OR user_id IS NULL，见 pipeline/db/repositories.ts 注释）。
- L2 流：needsApproval 工具 → SDK approval-requested → recordL2PendingFromResponse（agent.ts:291）→ 卡片 → callback → 瞬态 tool-approval-response 续跑（SDK continuation re-pair 同一 toolCallId 重新 execute）。
- L3 流：escalate_to_human（tools/hitl.ts:43）→ blocked ticket → callback → 持久用户指令 + 全量重跑。
- 前端：hash 路由 `#/<view>?session=<id>`，nav registry components/shell/navigation.ts:42-52（无 approval 视图）；审批 UI 内嵌 RealChatView.tsx；HumanAgentStatusBar 显示 pending 数。

## 5. 数据模型变更

```sql
ALTER TABLE pending_approvals
  ADD COLUMN decided_by TEXT,          -- 决策人 user id
  ADD COLUMN decided_at TEXT,          -- ISO 时间
  ADD COLUMN reason TEXT,              -- 批准/拒绝理由（可空）
  ADD COLUMN side_effect_results TEXT; -- JSON 数组，见下
```

side_effect_results 元素结构：
```ts
interface SideEffect { target: string; action: string; ok: boolean; detail: string; at: string }
// 示例: { target: 'toolCall:call_abc', action: 'bind_document', ok: true,
//         detail: '{"contractNo":"XYXD-2209-094","documentId":"doc_1"}', at: '2026-09-07T10:00:00Z' }
```

- SQLite：PRAGMA table_info 守卫的幂等 ALTER（照抄 sessionStoreSqlite.ts:126-129 Phase-2 user_id 迁移模式）。
- Postgres：`ADD COLUMN IF NOT EXISTS`（ensureSessionTables 内）。

## 6. API

### 6.1 GET /api/approval/list?status=pending|approved|denied|all&limit=50
- 归属过滤：`JOIN sessions s ON s.id = pa.session_id WHERE (s.user_id = ? OR s.user_id IS NULL)`。
- 返回 `{ items: Array<PendingApprovalRow & { sideEffects: SideEffect[] | null }> }`，created_at DESC。
- status=all 或缺省 → 全部状态。

### 6.2 GET /api/approval/:id
- 404：不存在**或**非本人可见（他人票据返回 404 防枚举）。
- 返回整行 + sideEffects 解析结果。

### 6.3 POST /api/approval/callback（既有端点扩展）
- 行为不变（404/403/409 语义原样），仅在 resolveApproval 落 decided_by=c.user.id、decided_at=now、reason=body.reason。

## 7. ApprovalChannel 适配层（外部审批预留）

```ts
// src/harness/approvalChannel.ts
export interface ApprovalChannel {
  readonly name: string;
  onTicketCreated(row: PendingApprovalRow): Promise<void>;
  onTicketResolved(row: PendingApprovalRow): Promise<void>;
}
```

- env：`APPROVAL_CHANNEL`（zod optional，default 'local'；未知值降级 local 并 warn）。
- LocalChannel：logger.info 记录，无外部行为。
- 挂点（fire-and-forget + catch log）：recordPendingApproval 之后（agent.ts L2 路径、tools/hitl.ts L3 路径）、resolveApproval 之后（approvalCallback.ts）。
- 飞书审批后续接入 = 新增 LarkChannel 实现该接口 + env 切换，callback 端点天然兼容外部回调语义（ticketId/approvalId 二选一已支持）。

## 8. 副作用记录

- sessionStore 新增 `appendSideEffect(toolCallId: string, effect: SideEffect): Promise<void>`：按 tool_call_id 定位行，读-改-写 side_effect_results（无行则 no-op）。
- L2 自动记录：buildGatedTools（agent.ts:160）对 needsApproval 工具包 execute——批准后 SDK 才会执行 execute（deny 走 execution-denied 不进 execute），故 execute 被调即已批准；执行完用 options.toolCallId 记一条副作用。
- L3 v1 不自动记录。

## 9. 前端信息架构

- 导航新增 ViewId `approvals`（navigation.ts registry + App.tsx 分发 case）。
- ApprovalCenterView：tab（待处理/已办/全部）+ 列表（level 徽章 L2/L3、工具名、状态、时间、所属会话）+ 10s 轮询；行点击开详情抽屉。
- ApprovalDetailDrawer：payload KV 渲染（input_json 逐键，长值截断）、理由输入、批准/拒绝（复用 callback 端点）、sideEffects 时间线、「打开会话」链接 `#/chat?session=<id>`。
- HumanAgentStatusBar 待办数改为可点击，跳 `#/approvals`。
- 双向打通（最小版）：审批中心→会话（本版）；实体 chip 反向跳台账留待台账任务。

## 10. 验收标准

1. 对话触发 L2（如 bind_document）→ 审批中心待办出现 → 填理由批准 → 会话续跑 → 详情页含 decided_by/reason/side_effect_results。
2. L3 escalate 工单在审批中心可批可拒，拒绝后会话收到拒绝叙事。
3. 已办 tab 显示历史决策（含理由与决策人）。
4. 跨会话聚合正确：他人会话票据在列表不可见、详情 404。
5. 新增一个假工具（带 needsApproval）不改审批中心任何代码即可走完整流程（人工验证 payload 透传渲染）。
6. `npm run build && npm run lint && npm test` 全绿；PG 集成路径列镜像一致（可选跑 DB_BACKEND=postgres）。

## 11. 开放问题（v2 候选）

- 审批角色矩阵与代理审批人
- 票据 TTL 与过期清理
- 飞书审批字段映射（approvalCode ↔ ticketId、回调验签）
- L3 副作用自动捕获（Temporal 或 runSession 钩子）
- sessions.user_id IS NULL（legacy）会话票据在 list 可见（3-way OR），但详情走 `sessionBelongsTo` owner-only 校验可能 404——两端不一致，v2 决定是否统一（收紧 list 或放宽 detail）

v1 实施终审移交（2026-09-07，defer-with-ledger）：

- resolveApproval 两参重调会清空 decided_by/decided_at/reason——生产调用方已恒传 decision，v2 加写一次守卫或条件更新
- L2 工具 execute 抛错不留副作用痕迹（append 仅在 resolve 后，ok:false 不可达）——v2 加 catch-path append（ok:false + 错误摘要）
- notifyApprovalResolved 收到的是 resolve 前的合成行（decided_* 为 null）——接入 LarkChannel 前需改为 resolve 后回读新行
- 前端 tab 缺「全部」（API 已支持 status=all）；drawer 404 错误文案前缀重复（"加载失败： 加载失败"）；tab 切换无 AbortController（10s 轮询自愈）
