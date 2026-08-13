# 后台静默 Session 运行时设计(方案 C,分阶段交付)

- 日期:2026-08-13
- 状态:待审阅
- 范围:阶段 1(完整可用的"后台静默运行"地基)
- 参考架构:opencode(`sst/opencode`,canonical `anomalyco/opencode`)的 session/agent/SSE 解耦模型

---

## 1. 背景与动机

当前 Agent 生命周期 = 单次 HTTP 响应流的生命周期。`/api/chat` 与 `/api/approval/callback`
都用 `runStream → toUIMessageStreamResponse → 把 SSE 当响应体返回`;客户端断开(abort/关页/刷新)
会经 hono/node-server 的 `writable.on('close') → reader.cancel → stitchableStream.cancel →
DeepSeek 请求中止` 这条隐式链中断生成。前端切 session 虽不主动 abort,但因 `RealChatView`
单实例 `useChat`(无 `id`、不重建、不调 `stop()`),旧流的输出会 `pushMessage` 进新 session 的
消息列表,造成**串扰**且**输入框锁死**。

目标:让 Agent 运行脱离 HTTP 请求生命周期,在后端独立跑(连接断开不中断),前端通过 session
级 SSE 实时观测;切换 session / 刷新页面后 agent 继续跑、重连可观测。对齐 opencode 的
"后端长生命周期 session + 事件广播 + 单向 SSE"模型。

## 2. 目标 / 非目标

### 目标(阶段 1)
1. `/api/chat` 触发的 agent run 在后端独立运行,前端连接断开(切 session / 刷新 / 关页)不中断。
2. `GET /api/sessions/:id/events`(SSE)实时转发该 session 的 part / status / run 生命周期事件。
3. session 运行态可观测:`sessions.status` 字段 + 列表端点带 status(列表 busy 徽标)。
4. 多 session 并发;单 session 单飞行。
5. 前端切换 session = 切换订阅的 sessionID,后端零感知;后台 session 在列表有指示。
6. 可中止:`POST /api/sessions/:id/abort`。
7. `sessionContext` 并发安全:单槽变量 → AsyncLocalStorage。

### 非目标(推迟到后续阶段)
- 事件落库 / 事件溯源(event 表 + seq)→ 阶段 2
- `/sync/history` 增量重放 + reconcile + 断线补数据 → 阶段 3
- HITL approval 回调的连接解耦(暂保留同步流)→ 阶段 4
- Postgres session 三表补齐 → 阶段 4
- 多设备/多客户端并发一致性

## 3. 现状要点(来自调研)

- `harness/sessionStore.ts`:文件 SQLite(`agent.db`),`sessions`/`session_messages`/
  `pending_approvals`/`authorized_tickets`;`appendMessages` 用 `MAX(seq)+1` 并发安全;
  `sessions` 表**无 status 字段**。
- `routes/chat.ts`:`x-session-id` 确定会话 → 先 `appendMessages` 用户消息 → `runStream` →
  `toUIMessageStreamResponse({ onFinish: appendMessages(sessionId,[responseMessage]) })`,
  assistant 消息在 onFinish 持久化。
- `harness/agent.ts`:`streamText({ model, system, messages, tools, stopWhen:[stepCountIs(5),...],
  experimental_telemetry, prepareStep })`,**未传 abortSignal**。
- `routes/approvalCallback.ts`:L2/L3 resume 也 `return await resumeSession(...)` 作为 SSE 响应返回
  (绑连接)。
- `routes/status.ts` + `harness/statusAggregator.ts`:`GET /api/sessions/:id/status` 来自进程内
  `auditRecorder`(内存,重启即丢),5s 轮询。
- `harness/sessionContext.ts`:模块级 `let currentSessionId`(单槽,注释自认不支持并发)。
- 前端 `RealChatView.tsx`:单实例 `useChat`(无 `id`)、`DefaultChatTransport` 带 `x-session-id`
  header、`sendAutomaticallyWhen` 自动续发;`useHumanAgentStatus` 5s 轮询。
- session 表**仅 SQLite 实现**,Postgres schema 缺这三张表。

## 4. 参考架构(opencode)要点

- Session 是后端持久化实体(SQLite);agent 循环以"每 session 一个 Effect fiber"挂在**服务级
  Scope**(非请求 Scope)——连接断开继续跑;停只能 `POST /session/:id/abort`。
- 通信:REST 触发 + **全局 SSE** 广播;前端共享一条流,事件按 directory 分发,切换 session 只切
  读哪个 sessionID,后端零感知;单 session 单飞行(`BusyError`),多 session 并发。
- 持久化 + 恢复:`event` 表(monotonic seq)+ SSE 自动重连 + `/sync/history` 增量重放 + REST 快照
  兜底(阶段 2/3 借鉴)。

> 本项目用 AI SDK 6(非 Effect),借鉴的是**架构模式**(连接解耦 + session 级事件订阅 + 切订阅
> 不切后端),不是代码。阶段 1 裁掉事件落库与 sync 重放,用"REST 全量快照 + SSE 实时增量"替代。

## 5. 阶段总览(校准后)

| 阶段 | 内容 | 验收 |
|---|---|---|
| **1(本 spec)** | run 任务化 + RunManager + ALS + status 字段 + SSE 通道 + 前端订阅改造 | 真后台静默运行 + 可观测 |
| 2 | `event` 表 + seq,消息/状态变更重构为落库事件 | 事件溯源 |
| 3 | `/sync/history` 增量重放 + reconcile + 重连恢复 | 断线补数据 |
| 4 | HITL approval 回调解耦 + Postgres session 三表补齐 | 全链路后台化 + 双 DB |

## 6. 阶段 1 详细设计

### 6.1 数据层(`sessionStore.ts`)

- 幂等 DDL(复用现有 `user_id` ALTER 模式):
  ```sql
  ALTER TABLE sessions ADD COLUMN status TEXT NOT NULL DEFAULT 'idle';
  ALTER TABLE sessions ADD COLUMN run_id TEXT;
  ALTER TABLE sessions ADD COLUMN current_run_started_at TEXT;
  ```
- status 取值:`'idle' | 'busy' | 'interrupted'`。
- 新增函数:
  - `setSessionStatus(id, status, runId?)`:UPDATE `status`/`run_id`/`current_run_started_at`,
    事务内 touch `updated_at`。
  - `getSessionStatus(id): { status, runId?, startedAt? } | null`。
- `listSessionsForUser` 返回项**新增 `status`** 字段(供列表 busy 徽标)。
- 启动恢复:`migrateOnStartup` 同层新增一次性 `UPDATE sessions SET status='interrupted'
  WHERE status='busy'`(streamText run 随进程死,不可恢复;前端据此提示"上次运行未完成")。

### 6.2 RunManager(新 `harness/runManager.ts`)

进程内单例,职责:run 生命周期 + 单飞行 + abort + 状态写库。

```
type RunHandle = { runId: string; controller: AbortController; done: Promise<void>; startedAt: string }
const runs = new Map<sessionId, RunHandle>()

startSessionRun(sessionId, userId, role, fn: (signal: AbortSignal) => Promise<void>): { runId } | { conflict: true }
  - 若 runs.has(sessionId) 且未 done → 返回 { conflict: true }(调用方返 409)
  - runId = randomUUID(); controller = new AbortController()
  - setSessionStatus(sessionId, 'busy', runId); emit run.started
  - void als.run({sessionId,userId,runId,role}, async () => {
      try { await fn(controller.signal) }           // fn 内部跑 runSession(见 §6.3)
      catch (e if abort) { setSessionStatus('idle'); emit run.aborted }
      catch (e) { setSessionStatus('idle'); emit run.error }
      finally { runs.delete(sessionId); emit run.finished; emit session.status idle }
    })
  - 立即返回 { runId }(不 await fn)

abort(sessionId): boolean
  - runs.get(sessionId)?.controller.abort(); 返回是否命中

isRunning(sessionId): boolean
```

- **并发模型**:单 session 单飞行(对齐 opencode BusyError);多 session 各自独立 Map 项并发。
- **作用域**:run 句柄存在模块级 Map(服务级生命周期),不随请求结束——这是"连接断开继续跑"的根。

### 6.3 后台 run 执行器(新 `harness/runSession.ts`,替代 chat.ts 内联的 runStream 调用)

范式转变:从"返回 SSE 响应流"→"后台消费 fullStream + 广播 + 持久化"。

```
runSession({ sessionId, userId, role, messages, contextFiles?, abortSignal }): Promise<void>
  - 组装 streamMessages(同现状:convertToModelMessages(prior) + newModel + 可选 system)
  - const result = streamText({
      model, system, messages: streamMessages, tools, stopWhen:[stepCountIs(5),...],
      abortSignal,                    // ← 新增,来自 RunManager.controller
      experimental_telemetry, prepareStep,
      onFinish: ({ responseMessage }) => appendMessages(sessionId, [responseMessage])
    })
  - for await (const part of result.fullStream) {
      emit(sessionId, { type:'message.part', part })   // 实时广播 part(含 tool-call/tool-result)
    }
  - run 结束:fullStream close(正常 onFinish 已持久化)
```

> **AI SDK 6 关键技术点(实现期首要验证)**:后台不绑定响应流、仅消费 `result.fullStream` +
> `onFinish` 时,streamText 是否完整推进生成?本设计的技术前提。验证方式见 §9 风险。若
> fullStream 不消费则不推进,本设计已显式消费;若 `toUIMessageStreamResponse` 的某些转换在纯
> fullStream 路径缺失(如 tool-approval part 的序列化),需在 §6.4 事件层补齐或回退到消费
> `result.response` 的 PromiseLike。参考 `ARCHITECTURE.md` Appendix D。

### 6.4 轻量事件总线(新 `harness/sessionEvents.ts`,阶段1仅内存)

```
const subs = new Map<sessionId, Set<(e)=>void>>()
emit(sessionId, event): void      // 扇出到所有订阅者(同步,事件小)
subscribe(sessionId, fn): () => void   // 返回 unsubscribe
```

事件 schema(阶段1,JSON over SSE data):
- `run.started` `{ sessionId, runId, at }`
- `message.part` `{ sessionId, part }` —— part 为 fullStream 原始 part
- `run.finished` `{ sessionId, runId }`
- `run.error` `{ sessionId, runId, message }`
- `run.aborted` `{ sessionId, runId }`
- `session.status` `{ sessionId, status }`

> 阶段 2 会把 emit 同步落 `event` 表(monotonic seq),阶段 1 只做内存实时广播。

### 6.5 AsyncLocalStorage(`harness/sessionContext.ts` 重构)

```
type Ctx = { sessionId: string; userId?: string; runId?: string; role: string }
const sessionALS = new AsyncLocalStorage<Ctx>()
setSessionContext(ctx, fn): 返回 als.run(ctx, fn)   // RunManager.startSessionRun 包裹用
getSessionContext(): Ctx  // 工具内调用,读 als.getStore();缺失抛错
```

- 旧的模块级 `let currentSessionId` 及其 setter 删除;所有 `currentSessionId` 读取点改为
  `getSessionContext().sessionId`(grep `currentSessionId` 全量替换)。
- L3 工具(create_payment 等)在 execute 内 `getSessionContext()` 自动获得正确 session 归属,
  解决并发串台。

### 6.6 SSE 通道(新 `routes/events.ts`,挂 `/api/sessions`)

```
GET /api/sessions/:id/events   (requireAuth + sessionBelongsTo 校验)
  - res header 'Content-Type: text/event-stream'; 'Cache-Control: no-cache'; 不缓冲
  - 首事件:emit 一条 session.status(当前 getSessionStatus 快照)
  - subscribe(id, (e) => res.write(`data: ${JSON.stringify(e)}\n\n`))
  - 10s 心跳(`: heartbeat\n\n`)
  - res.on('close') → unsubscribe
  - 注:useChat 的 SSE 语义不再使用,这是自定义事件流(前端用原生 EventSource)
```

### 6.7 API 契约变更(`routes/chat.ts` + `routes/sessions.ts`)

**破坏性变更**——`POST /api/chat`:
- 鉴权 + 确定 sessionId(同现状:`x-session-id` 复用或新建)
- `appendMessages(sessionId, userMessages)`(先持久化用户消息,同现状)
- `const r = runManager.startSessionRun(sessionId, userId, role, (signal) =>
    runSession({ sessionId, userId, role, messages: userMessages, contextFiles, abortSignal: signal }))`
- 若 `r.conflict` → 返回 409 `{ error: 'session_busy', activeRunId }`
- 否则 → 返回 200 `{ sessionId, runId, status: 'busy' }`(响应头仍带 `x-session-id`)
- **不再返回 SSE 流**。

新增 **`POST /api/sessions/:id/abort`**(requireAuth + 归属校验):
- `runManager.abort(id)` → 200 `{ ok: true, aborted }` 或 404/409。

### 6.8 前端重构(`apps/web/src`)

从"单实例 useChat 连接绑定"转向"乐观追加 + EventSource 订阅 + 切订阅"。

- 新 hook `useSessionEvents(sessionId)`:
  - `new EventSource('/api/sessions/' + sessionId + '/events')`
  - onmessage:按 event.type 还原,本地 messages store 增量 apply(`message.part` 追加/替换;
    `run.finished` 标记结束;`session.status` 更新 isStreaming)
  - 切 session:旧 EventSource.close()(后端 run 不受影响)+ 开新 session 的 EventSource
- `useSessionMessages(sessionId)`:
  - 首屏 `GET /api/sessions/:id` 拉全量 messages 快照
  - 发消息:`POST /api/chat` 拿 `{runId}`,**乐观追加** user message,等 SSE `message.part` 增量
- `RealChatView`:不再用 `useChat`;改用上面两个 hook;输入框在 `status==='busy'` 时禁用
- 会话列表项:`GET /api/sessions` 返回的 `status` 渲染 busy 徽标(后台运行中可见)
- 删除 `sendAutomaticallyWhen` 自动续发逻辑(后台 run 内部 stopWhen stepCountIs 已自包含多轮)
- `useHumanAgentStatus` 5s 轮询可保留作 tool-call 状态兜底,或后续阶段移除(阶段1不强求)

> **关键**:`useChat`/`DefaultChatTransport` 在 chat 主链路上弃用;RealChatView 改为事件驱动渲染。
> 这是最重的前端改动,实现计划需单列详拆。

### 6.9 范围边界:HITL approval

- 阶段 1 **暂不动** `/api/approval/callback` 与 `resumeSession`:它们仍返回同步 SSE 流。
- 但 `resumeSession` 内的 runStream 调用如需读 session 上下文,应改走 `getSessionContext()`
  (ALS),避免与后台 run 的单槽冲突——最小改动。
- approval 的完全连接解耦列入阶段 4。

## 7. 数据流(阶段 1)

```
发消息: 前端 POST /api/chat {messages} x-session-id
   → chat.ts: appendMessages(user) → runManager.startSessionRun(runSession) → 200 {runId}
   → (后端 run 脱离请求) runSession: streamText(abortSignal) → for await fullStream:
        emit message.part → sessionEvents → 各 SSE 订阅者 → 前端 EventSource 增量渲染
     onFinish: appendMessages(assistant) → setStatus idle → emit run.finished

切换 session: 前端 EventSource.close(旧) + EventSource(新) + GET /api/sessions/新 拉快照
   → 旧 session 的后端 run 继续(句柄在模块级 Map,与请求无关)
   → 旧 session 的 SSE 订阅已断,但其 run 完成后仍 appendMessages 持久化;切回时拉快照即见

刷新页面: 后端 run 继续;前端重连后 GET 快照 + 重订阅 SSE(阶段1 无 seq 重放,仅"新事件实时到"
   + 快照兜底;断线期间错过的 part 由阶段3 sync/history 补)

abort: 前端 POST /api/sessions/:id/abort → controller.abort → streamText 停 → run.aborted
```

## 8. 验收标准(阶段 1)

1. 在 session A 发消息触发 run,立即切到 session B:**A 的 run 在后端继续**(`status` 仍 busy,
   后端日志/DB 显示生成进行);切回 A 拉快照可见完整 assistant 回复。
2. session A run 进行中,**关闭浏览器标签**:后端 run 不中断(run.finished 后 assistant 消息已
   appendMessages);重开页面拉快照可见结果。
3. 刷新页面:后台 run 继续直到完成;重连后 `GET /api/sessions/:id/events` 收到后续实时事件。
4. 同一 session busy 时再次 `POST /api/chat` → 409 `session_busy`。
5. 两个不同 session 同时各自发消息 → 两个 run 并发,各自 SSE 独立,无串扰。
6. `POST /api/sessions/:id/abort` → run 停止,`run.aborted` 事件到前端,status 回 idle。
7. 服务重启后,原 busy 的 session status = `interrupted`(非 busy)。
8. 会话列表显示后台运行中 session 的 busy 徽标。
9. 现有 build → lint → test 全绿;新增阶段1的集成测试覆盖 1/4/5/6。

## 9. 风险与未决

- **R1(高)**:AI SDK 6 `streamText` 后台消费 `fullStream` + `onFinish`(不绑响应流)能否完整推进
  生成、tool-approval 等 part 是否齐全。**缓解**:实现第一步即写最小验证(裸 streamText +
  for await fullStream + onFinish 落库),确认后再铺开。必要时请 @librarian 核对 AI SDK 6 行为。
- **R2(中)**:`fullStream` 的 part 与原 `toUIMessageStreamResponse` 输出的差异(前端渲染依赖的
  part 形态)。**缓解**:对比两种流的 part 结构,在事件层做必要归一化。
- **R3(中)**:前端从 `useChat` 迁移到事件驱动 store 的工作量与回归风险。**缓解**:实现计划单独
  详拆前端,保留 `useHumanAgentStatus` 轮询作过渡兜底。
- **R4(低)**:单进程内 run 句柄为内存态,水平扩缩容/多实例下不共享(阶段1 单实例 PM2 部署,
  不涉及)。阶段 3+ 的事件落库 + sync 才解决多实例。
- **R5(低)**:`auditRecorder`/`statusAggregator` 与新 `sessions.status` 语义重叠。阶段1 两者
  共存(旧端点保留),后续阶段统一。

## 10. 测试策略

- 单元:RunManager 单飞行/abort/状态迁移;sessionContext ALS 隔离;sessionEvents emit/subscribe;
  sessionStore status DDL + setSessionStatus/重启恢复。
- 集成(vitest):chat 路由启动后台 run 并立即返回;切 session 后旧 run 持久化;abort 中止;
  并发两 session;409 单飞行。
- AI SDK 6 验证脚本(非测试,手动):裸 streamText 后台消费 fullStream,确认生成完整。
- 端到端(手动):前端切换/关页/刷新三场景对齐验收标准 1-3。

## 11. 受影响文件(预估)

后端新增:`harness/runManager.ts`、`harness/runSession.ts`、`harness/sessionEvents.ts`、
`routes/events.ts`。
后端修改:`harness/sessionStore.ts`(DDL+status 函数)、`harness/sessionContext.ts`(ALS 重构)、
`harness/agent.ts`(可选,若 runSession 内联 streamText 则不改)、`routes/chat.ts`(契约)、
`routes/sessions.ts`(list 带 status)、`index.ts`(挂 events 路由)。
前端修改:`components/RealChatView.tsx`、新 `hooks/useSessionEvents.ts`/`useSessionMessages.ts`、
`App.tsx`、`components/SessionSidebar.tsx`(徽标);弱化/移除 `useChat` 主链路依赖。
