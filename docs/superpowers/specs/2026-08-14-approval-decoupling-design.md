# 阶段4:Approval 解耦 — 设计文档

日期:2026-08-14
状态:已评审通过(brainstorm 逐节确认)
前置:阶段1 后台静默 Session 运行时已合并 main(c779455)

## 1. 背景与目标

阶段1 把 chat 路径迁到了后台运行时(RunManager 单飞行 + runSession 后台执行 +
SSE 事件总线),但 HITL 审批回调 `POST /api/approval/callback` 仍是旧架构:

- 同步流返回(`toUIMessageStreamResponse` 当 HTTP 响应体),连接断开即中断;
- 绕过 RunManager,resume run 与 chat run 无互斥(ora-1 review I-1 风险);
- 是 `setSessionContext` 旧单槽的最后一个使用者,阻塞 ALS 清理;
- resume 输出不进 SSE 总线,其他设备看不到续写(多端不一致);
- L2 deny 只改 DB 不跑模型,对话停在 approval-requested 状态不闭环。

目标:L2/L3 审批回调全迁后台运行时,与 `/api/chat` 契约完全对称;清偿
legacy 单槽债务;resume 输出经 SSE 多端可见。

## 2. 技术前提(lib-1 源码验证结论,ai@6.0.246)

以下结论均经 `node_modules/ai/dist/index.mjs` 行号级验证,是本设计的决定性输入:

- **Q1**:L2 工具命中 `needsApproval` 时,流发 `tool-approval-request` 后**正常
  finish**(finishReason 沿用 provider 的 `'tool-calls'`,无特殊值;execute 被跳过、
  无 tool-result → 循环终止条件不满足 → `closeStream`)。**流不占槽位**:callback
  到达时 RunManager 槽位已释放、status 已回 idle。
- **Q2**:SDK 无服务端 sendApproval API。官方 resume = **新开一次 streamText**,
  历史中附加 transient `role:'tool'` + `tool-approval-response` 消息;启动时
  SDK 自动按 approvalId/toolCallId 配对,approved 的立即重执行工具,denied 的
  自动生成 `execution-denied` tool-result 喂给模型。审批痕迹不发给 provider。
  现有 approvalCallback.ts 的 resume 输入形态**就是官方模式,方向正确**。
- **Q3**:L3(execute 返回 `{status:'blocked',ticketId}`)与 SDK 审批语义无关,
  是普通 tool-result,循环正常 continue。L3 的 resume 只能靠追加 user instruction
  + 全量重跑驱动。
- **Q4**:approval 点 onFinish 正常触发,带 `state:'approval-requested'` part 的
  assistant UIMessage 已持久化;`convertToModelMessages` 能把它转回 SDK 可匹配
  的形态,与 `tool-approval-response` 配对闭环。**可恢复性成立**。

推论:阶段4 要解决的是**互斥**,不是"唤醒"——不存在可唤醒的挂起 run。

## 3. 已定决策

| 决策点 | 结论 |
|---|---|
| 范围 | 只做 approval 解耦。Postgres 三表补齐、approval 状态事件化另行立项 |
| L2 deny | 也 resume(SDK execution-denied 语义),对话闭环 |
| L3 deny | 也 resume(追加 user instruction 告知被拒) |
| busy 互斥 | callback 遇 busy 返回 409,与服务端排队/abort 均不做 |
| 总体方案 | 方案 A:callback 全迁后台运行时,同步流删除 |

## 4. API 契约

`POST /api/approval/callback`(requireAuth,请求体不变)

```
{ ticketId?: string, approvalId?: string, approved: boolean, reason?: string }
```

响应:

- `200 { ok: true, status: 'approved' | 'denied', sessionId, runId }`,
  header `x-session-id: <sessionId>`。approve 与 deny 都启动 resume run。
- `409 { error: 'session_busy', activeRunId, approvalResolved: boolean }`:
  预检 busy(见 5.4)返回时 `approvalResolved:false`(未动 DB);startSessionRun
  冲突的窄竞态窗口返回时 `approvalResolved:true`(DB 已翻转但 resume 未跑)。
  前端按 `approvalResolved` 区分提示文案。
- `404 { error: 'ticket not found' | 'approval not found', ... }`、
  `401`、`403`(ownership)语义全部保留。
- 删除:同步 UIMessageStream 响应体。resume 输出全部经 SSE 总线
  (`run.started` / `message.part` / `run.finished` / `run.error`)广播。

## 5. 后端设计

### 5.1 callback 路由重写(approvalCallback.ts)

删除 `resumeSession` 同步流函数。新流程(两条路径共用骨架):

```
parse + validate → getPending(ticketId|approvalId) → ownership 校验
→ 预检 busy: isRunning(sessionId) → 409 (approvalResolved:false)
→ 组装 resume 输入(此时才有 await,见 5.4):
    uiMessages = loadSession(sessionId).messages
    base = await convertToModelMessages(uiMessages)
→ L2: extra = [transient role:'tool' + tool-approval-response
              { approvalId, toolCallId: pending.tool_call_id ?? approvalId,
                approved, reason: reason ?? (approved ? '用户已确认' : '用户已拒绝') }]   // 不持久化
  L3 approve: appendMessages(user instruction)   // 沿用现有文案逻辑
              (escalate_to_human 通用文案 / create_payment 传 authorizedTicketId)
  L3 deny:    appendMessages(user instruction: 票据已被拒绝,告知用户并停止该操作)
→ resolveApproval(id, approved?'approved':'denied')   // DB 状态先行,同步
→ addAuthorizedTicket(仅 L3 approve)
→ startSessionRun(sessionId, user.id, role, (signal) =>
    runSession({ sessionId, messages: [...base, ...extra], role, auditTraceId,
                 abortSignal: signal, isFirstTurn: false }))
→ 成功: 200 { ok:true, status, sessionId, runId }
  conflict: 409 { error:'session_busy', activeRunId, approvalResolved:true }
```

审计日志事件(`approval_authorized` / `approval_l2_resolved`)保留。

### 5.2 runSession 零改动

runSession 已接受调用方组装好的 `messages: ModelMessage[]`,其内部
L2 pending 记录、onFinish 持久化、message.part emit、title-gen 门控
(isFirstTurn=false 跳过)对 resume run 自动生效。**不改其签名**。

userId 线程化(顺带清偿旧 TODO):`startSessionRun(sessionId, user.id, ...)`
直接传 handler 里的认证 user.id,取代旧 resumeSession 不带 userId 的
unscoped 状态统计。

### 5.3 持久化语义:新 messageId 干净追加

resume run **不传 originalMessages 续写**。onFinish 落地的 assistant 消息
用新 id 追加;历史保留旧 approval-requested 消息(它是前端审批卡片的渲染
依据)。理由:

- 旧同步路径复用旧消息 id → appendMessages 产生同 id 双条记录,前端
  pipeline(按 msgId replace)与快照(按条返回)都会重复/闪烁;
- 模型上下文重建不依赖消息 id,依赖 Q4 验证的 part 级配对闭环;
- 前端新 runId → run.started → startPipeline → 按 msgId append,天然支持。

### 5.4 busy 竞态处理(accepted risk)

预检 `isRunning()` 与 `startSessionRun` 之间存在 `await
convertToModelMessages` 让出的窄窗口,另一 chat POST 可能在此抢到槽位。
此时 DB 已翻转(resolveApproval 已执行)但 resume 未启动,返回
`409 approvalResolved:true`。后果有界:审批状态已保存,下次用户消息自然
恢复对话(L2 approve 的工具执行丢失,模型会重新发起 approval request)。
服务端排队机制明确不做(deferred,见 9)。

### 5.5 删除 legacy 单槽

approvalCallback.ts 迁移后,`setSessionContext` 使用者归零:

- 删 `sessionContext.ts` 的 `currentSessionId` / `setSessionContext` /
  `getSessionContext`(后者已是 dead export);
- `getSessionId()` 简化为纯 ALS 读取(`sessionALS.getStore()?.sessionId`),
  不再降级;缺失时返回 undefined 的行为保持;
- 工具读取点(hitl.ts / writes.ts / auditRecorder.ts)已统一走
  `getSessionId()`,零改动;
- 更新文件头注释(旧 CAVEAT 描述已过时)。

## 6. 前端设计

`RealChatView.postApproval`(唯一改动点):

- 删 `readUIMessageStream` 合并逻辑与相关 import(若仅此处使用);
- 改为纯 `fetch POST /api/approval/callback`:200 → 什么都不做(SSE
  `run.started` 自动驱动新 pipeline 渲染续写,审批卡片在流出
  `tool-output` part 后按现有逻辑消失);409 → 错误横幅,文案按
  `approvalResolved` 区分("审批已记录,会话忙,稍后重发消息恢复" vs
  "会话忙,请稍后重试");网络错误 → 沿用现有横幅机制;
- loading 重入守卫(967e9b7 已加)保留。

## 7. 数据流(resume run)

```
用户在 A 设备点批准/拒绝 → POST /api/approval/callback
  → resolveApproval(DB) → startSessionRun(runSession) → 200 {runId}
  → runSession: streamText(全量历史 + transient approval-response)
       for await toUIMessageStream:
         emit message.part → sessionEvents → SSE → 各设备 EventSource
       onFinish: appendMessages(新 id assistant 消息)
       result.response.then: recordL2PendingFromResponse(resume 中再请求的 L2)
  → RunManager finally: status idle + run.finished
B 设备(另一浏览器/tab)同 SSE 订阅,实时看到续写 — 多端一致。
```

## 8. 测试与验收

后端 vitest(fake streaming model,复用 V2 shape fixture):

1. L2 approve resume:pending → callback → 200 {runId} → run 结束后持久化
   含 tool-result 的新 assistant 消息(新 messageId,非旧消息 id);
2. L2 deny resume:resume run 跑完,新 assistant 消息落地(SDK 收到
   execution-denied);
3. L3 approve:instruction 追加 + run 启动;escalate_to_human 与
   create_payment 文案分支各自断言;
4. L3 deny:instruction(拒绝告知)追加 + run 启动;
5. busy 409:run 进行中 callback → 409 {error:'session_busy',
   approvalResolved:false};
6. resolveApproval 先于 run:200 路径 DB 状态先翻转;
7. legacy 单槽删除:getSessionContext/setSessionContext 导出消失(tsc 报错
   即证),现有 ALS 测试全绿,grep 零残留。

验收(整体):

- build → lint → test 全绿;
- agent-browser 手动验收:L2 审批 → 卡片消失 → 续写流式渲染 → 会话
  历史无重复消息;deny 同验;busy 期间审批返回 409 横幅;
- 回归:chat 路径、abort、SSE 订阅/断开不受影响。

## 9. 风险与 Deferral

- **窄竞态窗口**(5.4):accepted risk,响应内 `approvalResolved` 标记兜底;
  服务端排队 deferred。
- **approval 状态事件化**(pending 变更推 SSE):前端轮询已够用,deferred。
- **Postgres 三表补齐**(sessions/session_events 等):独立立项。
- **阶段2 事件溯源**(session_events 落库+seq,rejoin 补 part):下一阶段。
- resume run 与 chat run 在 SSE 总线上不可区分(无 run 来源标记):当前
  前端不区分消费,deferred 到有需求时加 `run.source` 字段。
