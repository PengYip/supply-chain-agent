# 后台静默 Session 运行时 — 阶段 1 后端实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `/api/chat` 触发的 agent run 在后端独立运行(连接断开不中断),并通过 `GET /api/sessions/:id/events` SSE 实时广播 run 生命周期/part 事件,前端可订阅观测。

**Architecture:** 借鉴 opencode 的"后端长生命周期 run + session 级事件广播"。`runStream`(现有,已封装 streamText)加 `abortSignal`/`onFinish` seam;新 `runSession` 复用它并消费 `result.fullStream`(替代 `toUIMessageStreamResponse` 当响应体),逐 part emit 到内存事件总线;`RunManager` 以服务级 Map 管理每 session 的 run 句柄(单飞行 + abort),脱离请求生命周期;`AsyncLocalStorage` 取代 `sessionContext` 单槽变量。

**Tech Stack:** Hono、AI SDK 6(`streamText`/`fullStream`/`stepCountIs`)、better-sqlite3、Node `AsyncLocalStorage`、`EventSource`(SSE)。测试:vitest。

## 范围说明

本计划覆盖**阶段 1 后端(Task 1-8)**。前端(从 `useChat` 迁移到 EventSource 订阅)计划将在后端契约 + R1 验证通过后单独编写——前端依赖实际 SSE 事件 schema,分开更稳。本计划的后端可用 vitest 集成测试 + 手动 curl SSE 独立验证。

## Global Constraints

- AI SDK 6(不是 5/7):工具 schema 字段 `inputSchema`;loop 停止用 `stopWhen: stepCountIs(N)`;序列化用 `toUIMessageStreamResponse`;telemetry 选项 `experimental_telemetry`。详见 `ARCHITECTURE.md` Appendix D。
- 代码中**不要加 emoji**(repo 约定)。
- SQLite 是默认运行时,session 三表只用 better-sqlite3 原生 DDL(幂等,见 `harness/sessionStore.ts`),Postgres session 表补齐是阶段 4,本计划不碰。
- 测试命令:`npm test --workspace apps/server -- <path>`;构建 `npm run build`;lint `npm run lint`。CI 要求 build→lint→test 全绿。
- `OPENAI_API_KEY` 在测试中为 dummy(env.ts zod 解析但测试不发请求)。测试通过注入 fake `model` seam(`RunStreamOpts.model`)避免网络。
- 提交规范:每个 Task 末尾 commit;只 stage 本 Task 相关文件,不卷入工作区其他无关改动。

## File Structure

**Create:**
- `apps/server/src/harness/sessionEvents.ts` — 内存事件总线(emit/subscribe,按 sessionId 扇出)
- `apps/server/src/harness/runManager.ts` — run 生命周期管理(服务级 Map,单飞行,abort,状态写库)
- `apps/server/src/harness/runSession.ts` — 后台 run 执行器(消费 fullStream + emit + 持久化)
- `apps/server/src/harness/__tests__/sessionEvents.test.ts`
- `apps/server/src/harness/__tests__/runManager.test.ts`
- `apps/server/src/harness/__tests__/runSession.test.ts`
- `apps/server/test/fakeLanguageModel.ts` — AI SDK 6 fake LanguageModelV1(注入 runStream 的 model seam)
- `apps/server/src/harness/__tests__/sessionContext.test.ts`
- `apps/server/test/harness/sessionStatus.test.ts`(数据层集成测试)

**Modify:**
- `apps/server/src/harness/sessionStore.ts` — DDL 加 status 列 + status 函数 + 启动恢复
- `apps/server/src/harness/sessionContext.ts` — 单槽 → AsyncLocalStorage
- `apps/server/src/harness/agent.ts` — `RunStreamOpts` 加 `abortSignal?`/`onFinish?`,透传给 streamText
- `apps/server/src/routes/sessions.ts` — list 返回项加 status;加 `GET /:id/events`(SSE);加 `POST /:id/abort`
- `apps/server/src/routes/chat.ts` — `POST /chat` 改为 fire-and-forget 返回 `{runId}`
- `apps/server/src/index.ts` — 路由已挂 `/api/sessions`,events/abort 在 sessionsRoute 内无需改 index.ts(除非新增独立 route)

---

## Task 1: sessions 表 status 字段 + status 函数 + 启动恢复

**Files:**
- Modify: `apps/server/src/harness/sessionStore.ts`(DDL ~行 22-68;新增函数;启动恢复挂 `migrateOnStartup` 同层)
- Test: `apps/server/test/harness/sessionStatus.test.ts`

**Interfaces:**
- Consumes: 现有 `sessions` 表(`id, role, created_at, updated_at, metadata_json, user_id`);现有幂等 ALTER 模式(见 `user_id` ALTER ~行 61-68)。
- Produces:
  - `type SessionStatus = 'idle' | 'busy' | 'interrupted'`
  - `setSessionStatus(id: string, status: SessionStatus, runId?: string): void`
  - `getSessionStatus(id: string): { status: SessionStatus; runId?: string; startedAt?: string } | null`
  - `listSessionsForUser` 返回项加 `status: SessionStatus`
  - `resetBusyOnStartup(): void` —— `UPDATE sessions SET status='interrupted' WHERE status='busy'`

- [ ] **Step 1: 写失败测试**

创建 `apps/server/test/harness/sessionStatus.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createSession,
  setSessionStatus,
  getSessionStatus,
  listSessionsForUser,
  resetBusyOnStartup,
} from '../../src/harness/sessionStore.js';

describe('session status', () => {
  it('new session defaults to idle', () => {
    const s = createSession('trader', 'u1');
    expect(getSessionStatus(s.id)?.status).toBe('idle');
  });

  it('setSessionStatus busy records runId and startedAt', () => {
    const s = createSession('trader', 'u1');
    setSessionStatus(s.id, 'busy', 'run-123');
    const st = getSessionStatus(s.id);
    expect(st?.status).toBe('busy');
    expect(st?.runId).toBe('run-123');
    expect(st?.startedAt).toBeTruthy();
  });

  it('setSessionStatus back to idle clears runId', () => {
    const s = createSession('trader', 'u1');
    setSessionStatus(s.id, 'busy', 'run-1');
    setSessionStatus(s.id, 'idle');
    const st = getSessionStatus(s.id);
    expect(st?.status).toBe('idle');
    expect(st?.runId).toBeUndefined();
  });

  it('listSessionsForUser includes status', () => {
    const s = createSession('trader', 'u2');
    setSessionStatus(s.id, 'busy', 'run-9');
    const rows = listSessionsForUser('u2');
    const row = rows.find((r) => r.id === s.id);
    expect(row?.status).toBe('busy');
  });

  it('resetBusyOnStartup turns busy into interrupted', () => {
    const s = createSession('trader', 'u3');
    setSessionStatus(s.id, 'busy', 'run-x');
    resetBusyOnStartup();
    expect(getSessionStatus(s.id)?.status).toBe('interrupted');
  });

  it('resetBusyOnStartup leaves idle sessions untouched', () => {
    const s = createSession('trader', 'u3');
    resetBusyOnStartup();
    expect(getSessionStatus(s.id)?.status).toBe('idle');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test --workspace apps/server -- test/harness/sessionStatus.test.ts`
Expected: FAIL — `setSessionStatus`/`getSessionStatus`/`resetBusyOnStartup` 未导出(或 status 列不存在报错)。

- [ ] **Step 3: 实现 DDL + 函数**

在 `sessionStore.ts` 现有 DDL 块(`CREATE TABLE sessions` 之后、`session_messages` 之前)追加幂等 ALTER,放在现有 `user_id` ALTER 旁边:

```ts
// Phase: background runtime. status tracks whether a run is in-flight;
// run_id/current_run_started_at identify the active run. Idempotent ALTER
// mirrors the user_id pattern above (safe on fresh + legacy DBs).
db.exec(`
  ALTER TABLE sessions ADD COLUMN status TEXT NOT NULL DEFAULT 'idle';
  ALTER TABLE sessions ADD COLUMN run_id TEXT;
  ALTER TABLE sessions ADD COLUMN current_run_started_at TEXT;
`);
```

> 包在与 `user_id` ALTER 相同的 try/catch 容错里(列已存在则忽略 —— 现有代码已有此模式,沿用)。

在 `sessionStore.ts` 导出类型与函数:

```ts
export type SessionStatus = 'idle' | 'busy' | 'interrupted';

export function setSessionStatus(id: string, status: SessionStatus, runId?: string): void {
  const startedAt = status === 'busy' ? new Date().toISOString() : null;
  db.prepare(
    `UPDATE sessions
       SET status = @status,
           run_id = @runId,
           current_run_started_at = @startedAt,
           updated_at = @now
     WHERE id = @id`,
  ).run({ status, runId: runId ?? null, startedAt, now: new Date().toISOString(), id });
}

export function getSessionStatus(
  id: string,
): { status: SessionStatus; runId?: string; startedAt?: string } | null {
  const row = db
    .prepare('SELECT status, run_id, current_run_started_at FROM sessions WHERE id = ?')
    .get(id) as { status: SessionStatus; run_id: string | null; current_run_started_at: string | null } | undefined;
  if (!row) return null;
  return {
    status: row.status,
    runId: row.run_id ?? undefined,
    startedAt: row.current_run_started_at ?? undefined,
  };
}

export function resetBusyOnStartup(): void {
  db.prepare(`UPDATE sessions SET status = 'interrupted' WHERE status = 'busy'`).run();
}
```

修改 `listSessionsForUser`(现有函数 ~行 230):SELECT 加 `status`,返回项加 `status: row.status as SessionStatus`。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test --workspace apps/server -- test/harness/sessionStatus.test.ts`
Expected: PASS(全部 6 个用例)。

- [ ] **Step 5: 在启动序列接入 resetBusyOnStartup**

在 `apps/server/src/index.ts` 的 boot IIFE(~行 127-128,`await migrateOnStartup()` 之后)加:

```ts
import { resetBusyOnStartup } from './harness/sessionStore.js';
// ...在 boot IIFE 内, migrateOnStartup() 之后:
resetBusyOnStartup();
```

(import 加到 index.ts 顶部 import 区。)

- [ ] **Step 6: 构建 + lint + 提交**

Run: `npm run build && npm run lint`
Expected: 全绿。

```bash
git add apps/server/src/harness/sessionStore.ts apps/server/src/index.ts apps/server/test/harness/sessionStatus.test.ts
git commit -m "feat(session): add status/run_id columns + status functions + startup reset"
```

---

## Task 2: sessionContext 单槽 → AsyncLocalStorage

**Files:**
- Modify: `apps/server/src/harness/sessionContext.ts`(全文重写,现 20 行)
- Modify: `apps/server/src/routes/chat.ts`(替换 `setSessionContext(sessionId)` 调用)
- Modify: 所有 `getSessionContext()` / `setSessionContext()` 调用点(Step 1 grep 出)
- Test: `apps/server/src/harness/__tests__/sessionContext.test.ts`

**Interfaces:**
- Produces:
  - `type SessionCtx = { sessionId: string; userId?: string; runId?: string; role: string }`
  - `runSessionContext<T>(ctx: SessionCtx, fn: () => T): T` —— `AsyncLocalStorage.run` 包裹
  - `getSessionContext(): SessionCtx` —— 读 ALS store,缺失抛 `Error('session context not set')`
  - `getSessionId(): string | null` —— 便捷方法(兼容旧的"只要 id"调用点),无 ctx 返回 null
- Consumes: Node `async_hooks.AsyncLocalStorage`

- [ ] **Step 1: grep 所有调用点**

Run: `grep -rn "getSessionContext\|setSessionContext" apps/server/src apps/server/test`
记录每个调用点。预期:`chat.ts:118 setSessionContext(sessionId)`;若干工具的 `getSessionContext()` 读取(返回 string,需改读 `.sessionId` 或用 `getSessionId()`)。

- [ ] **Step 2: 写失败测试**

创建 `apps/server/src/harness/__tests__/sessionContext.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { runSessionContext, getSessionContext, getSessionId } from '../sessionContext.js';

describe('sessionContext (AsyncLocalStorage)', () => {
  it('getSessionContext throws outside a context', () => {
    expect(() => getSessionContext()).toThrow(/not set/i);
  });

  it('getSessionId returns null outside a context', () => {
    expect(getSessionId()).toBeNull();
  });

  it('runSessionContext sets context for the call', () => {
    runSessionContext({ sessionId: 's1', role: 'trader' }, () => {
      expect(getSessionContext().sessionId).toBe('s1');
      expect(getSessionId()).toBe('s1');
    });
  });

  it('context isolates across nested async runs', async () => {
    await runSessionContext({ sessionId: 'outer', role: 'trader' }, async () => {
      expect(getSessionId()).toBe('outer');
      await runSessionContext({ sessionId: 'inner', role: 'trader' }, async () => {
        expect(getSessionId()).toBe('inner');
      });
      expect(getSessionId()).toBe('outer');
    });
  });

  it('context does not leak across concurrent async chains', async () => {
    const out: string[] = [];
    await Promise.all([
      runSessionContext({ sessionId: 'a', role: 'trader' }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        out.push(getSessionId() ?? 'none');
      }),
      runSessionContext({ sessionId: 'b', role: 'trader' }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        out.push(getSessionId() ?? 'none');
      }),
    ]);
    expect(out.sort()).toEqual(['a', 'b']);
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npm test --workspace apps/server -- src/harness/__tests__/sessionContext.test.ts`
Expected: FAIL — 新 API 不存在。

- [ ] **Step 4: 重写 sessionContext.ts**

```ts
// Request/run-scoped session context for tool execute functions.
//
// AI SDK 6 tool `execute` has no slot for arbitrary request context. We use
// AsyncLocalStorage so concurrent background runs each carry their own
// {sessionId, userId, runId, role} without a module-level single-slot variable.
//
// A run is wrapped via runSessionContext(); tools read getSessionContext() /
// getSessionId() from inside the run's async chain.

import { AsyncLocalStorage } from 'node:async_hooks';

export type SessionCtx = {
  sessionId: string;
  userId?: string;
  runId?: string;
  role: string;
};

const sessionALS = new AsyncLocalStorage<SessionCtx>();

export function runSessionContext<T>(ctx: SessionCtx, fn: () => T): T {
  return sessionALS.run(ctx, fn);
}

export function getSessionContext(): SessionCtx {
  const ctx = sessionALS.getStore();
  if (!ctx) throw new Error('session context not set');
  return ctx;
}

export function getSessionId(): string | null {
  return sessionALS.getStore()?.sessionId ?? null;
}
```

- [ ] **Step 5: 迁移所有调用点**

对 Step 1 grep 出的每个调用点:
- `setSessionContext(id)` 调用:删除。这些会被 Task 4 的 `RunManager.startSessionRun` 通过 `runSessionContext` 包裹替代(chat.ts 的改造在 Task 7)。本 Task 先删除 chat.ts:118 的 `setSessionContext(sessionId)`,临时改为:在 chat.ts 内用 `runSessionContext({sessionId, userId, role: agentRole}, () => ...)` 包裹(过渡,Task 7 会重构)。
- `getSessionContext()` 读取(返回 string 的旧用法):改为 `getSessionId()` 或 `getSessionContext().sessionId`。逐个按语义改。

- [ ] **Step 6: 运行测试确认通过**

Run: `npm test --workspace apps/server -- src/harness/__tests__/sessionContext.test.ts`
Expected: PASS。

- [ ] **Step 7: 全量测试 + 构建 + lint**

Run: `npm test --workspace apps/server && npm run build && npm run lint`
Expected: 全绿(迁移后无调用点残留旧的 setSessionContext)。

- [ ] **Step 8: 提交**

```bash
git add apps/server/src/harness/sessionContext.ts apps/server/src/routes/chat.ts apps/server/src
git commit -m "refactor(session): replace single-slot context with AsyncLocalStorage"
```

---

## Task 3: sessionEvents 内存事件总线

**Files:**
- Create: `apps/server/src/harness/sessionEvents.ts`
- Test: `apps/server/src/harness/__tests__/sessionEvents.test.ts`

**Interfaces:**
- Produces:
  - `type SessionEvent = { type: string; sessionId: string; [key: string]: unknown }`
  - `emit(event: SessionEvent): void` —— 扇出到该 sessionId 的所有订阅者
  - `subscribe(sessionId: string, fn: (e: SessionEvent) => void): () => void` —— 返回 unsubscribe
  - `subscriberCount(sessionId: string): number`(测试用)

- [ ] **Step 1: 写失败测试**

创建 `apps/server/src/harness/__tests__/sessionEvents.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { emit, subscribe, subscriberCount } from '../sessionEvents.js';

describe('sessionEvents', () => {
  it('emit delivers to subscribers of that session', () => {
    const received: unknown[] = [];
    const unsub = subscribe('s1', (e) => received.push(e));
    emit({ type: 'run.started', sessionId: 's1', runId: 'r1' });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ type: 'run.started', runId: 'r1' });
    unsub();
  });

  it('emit does not deliver to other sessions', () => {
    const received: unknown[] = [];
    subscribe('s1', (e) => received.push(e));
    emit({ type: 'run.started', sessionId: 's2', runId: 'r2' });
    expect(received).toHaveLength(0);
  });

  it('unsubscribe stops delivery', () => {
    const received: unknown[] = [];
    const unsub = subscribe('s1', (e) => received.push(e));
    unsub();
    emit({ type: 'run.started', sessionId: 's1' });
    expect(received).toHaveLength(0);
  });

  it('multiple subscribers each receive', () => {
    let a = 0, b = 0;
    subscribe('s1', () => a++);
    subscribe('s1', () => b++);
    emit({ type: 'x', sessionId: 's1' });
    expect(a).toBe(1);
    expect(b).toBe(1);
  });

  it('subscriberCount reports active subscribers', () => {
    expect(subscriberCount('s1')).toBe(0);
    const u1 = subscribe('s1', () => {});
    expect(subscriberCount('s1')).toBe(1);
    const u2 = subscribe('s1', () => {});
    expect(subscriberCount('s1')).toBe(2);
    u1();
    expect(subscriberCount('s1')).toBe(1);
    u2();
    expect(subscriberCount('s1')).toBe(0);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test --workspace apps/server -- src/harness/__tests__/sessionEvents.test.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现事件总线**

创建 `apps/server/src/harness/sessionEvents.ts`:

```ts
// In-memory session event bus (phase 1: no persistence).
// Phase 2 will also write each event to an `event` table with a monotonic seq.

export type SessionEvent = { type: string; sessionId: string; [key: string]: unknown };

const subscribers = new Map<string, Set<(e: SessionEvent) => void>>();

export function subscribe(sessionId: string, fn: (e: SessionEvent) => void): () => void {
  let set = subscribers.get(sessionId);
  if (!set) {
    set = new Set();
    subscribers.set(sessionId, set);
  }
  set.add(fn);
  return () => {
    const s = subscribers.get(sessionId);
    if (!s) return;
    s.delete(fn);
    if (s.size === 0) subscribers.delete(sessionId);
  };
}

export function emit(event: SessionEvent): void {
  const set = subscribers.get(event.sessionId);
  if (!set) return;
  for (const fn of set) {
    try {
      fn(event);
    } catch (err) {
      // A subscriber throwing must not break other subscribers or the run.
      console.error('[sessionEvents] subscriber threw:', err instanceof Error ? err.message : err);
    }
  }
}

export function subscriberCount(sessionId: string): number {
  return subscribers.get(sessionId)?.size ?? 0;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test --workspace apps/server -- src/harness/__tests__/sessionEvents.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/harness/sessionEvents.ts apps/server/src/harness/__tests__/sessionEvents.test.ts
git commit -m "feat(session): add in-memory session event bus"
```

---

## Task 4: RunManager(单飞行 + abort + 状态迁移)

**Files:**
- Create: `apps/server/src/harness/runManager.ts`
- Test: `apps/server/src/harness/__tests__/runManager.test.ts`

**Interfaces:**
- Consumes: Task 1 `setSessionStatus`/`getSessionStatus`;Task 2 `runSessionContext`;Task 3 `emit`。
- Produces:
  - `type StartResult = { runId: string } | { conflict: true }`
  - `startSessionRun(sessionId: string, userId: string | undefined, role: string, fn: (signal: AbortSignal) => Promise<void>): StartResult`
  - `abortSessionRun(sessionId: string): boolean`
  - `isRunning(sessionId: string): boolean`

- [ ] **Step 1: 写失败测试**

创建 `apps/server/src/harness/__tests__/runManager.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { startSessionRun, abortSessionRun, isRunning } from '../runManager.js';

describe('runManager', () => {
  it('startSessionRun returns a runId and marks running', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const r = startSessionRun('s1', undefined, 'trader', async () => { await gate; });
    expect('runId' in r).toBe(true);
    expect(isRunning('s1')).toBe(true);
    release();
    await new Promise((r) => setTimeout(r, 5));
    expect(isRunning('s1')).toBe(false);
  });

  it('second startSessionRun on same session while busy returns conflict', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    startSessionRun('s2', undefined, 'trader', async () => { await gate; });
    const r2 = startSessionRun('s2', undefined, 'trader', async () => {});
    expect('conflict' in r2 && r2.conflict).toBe(true);
    release();
    await new Promise((r) => setTimeout(r, 5));
  });

  it('different sessions run concurrently', async () => {
    let releaseA!: () => void;
    let releaseB!: () => void;
    const ga = new Promise<void>((r) => (releaseA = r));
    const gb = new Promise<void>((r) => (releaseB = r));
    startSessionRun('a', undefined, 'trader', async () => { await ga; });
    startSessionRun('b', undefined, 'trader', async () => { await gb; });
    expect(isRunning('a')).toBe(true);
    expect(isRunning('b')).toBe(true);
    releaseA();
    releaseB();
    await new Promise((r) => setTimeout(r, 5));
  });

  it('abortSessionRun aborts the signal', async () => {
    let aborted = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const r = startSessionRun('s3', undefined, 'trader', async (signal) => {
      signal.addEventListener('abort', () => { aborted = true; });
      try { await gate; } catch { /* gate won't reject */ }
    });
    expect('runId' in r).toBe(true);
    const ok = abortSessionRun('s3');
    expect(ok).toBe(true);
    expect(aborted).toBe(true);
    release();
    await new Promise((r) => setTimeout(r, 5));
  });

  it('abortSessionRun on idle session returns false', () => {
    expect(abortSessionRun('nope')).toBe(false);
  });

  it('fn error does not leave session marked running', async () => {
    startSessionRun('s4', undefined, 'trader', async () => { throw new Error('boom'); });
    await new Promise((r) => setTimeout(r, 5));
    expect(isRunning('s4')).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test --workspace apps/server -- src/harness/__tests__/runManager.test.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现 RunManager**

创建 `apps/server/src/harness/runManager.ts`:

```ts
// Per-session background run manager. Run handles live in a process-wide Map
// (service-scoped lifetime), NOT the request scope — this is what lets a run
// keep running after the HTTP request that started it has returned.
//
// Single-flight per session (busy => conflict, aligning with opencode BusyError);
// different sessions run concurrently.

import { randomUUID } from 'node:crypto';
import { setSessionStatus } from './sessionStore.js';
import { runSessionContext } from './sessionContext.js';
import { emit } from './sessionEvents.js';

type RunHandle = {
  runId: string;
  controller: AbortController;
  done: Promise<void>;
};

const runs = new Map<string, RunHandle>();

export type StartResult = { runId: string } | { conflict: true };

export function startSessionRun(
  sessionId: string,
  userId: string | undefined,
  role: string,
  fn: (signal: AbortSignal) => Promise<void>,
): StartResult {
  const existing = runs.get(sessionId);
  if (existing) {
    // Single-flight: a run is still in-flight for this session.
    return { conflict: true };
  }
  const runId = randomUUID();
  const controller = new AbortController();
  setSessionStatus(sessionId, 'busy', runId);
  emit({ type: 'run.started', sessionId, runId, at: new Date().toISOString() });

  const ctx = { sessionId, userId, runId, role };
  const done = runSessionContext(ctx, async () => {
    try {
      await fn(controller.signal);
      emit({ type: 'run.finished', sessionId, runId });
    } catch (err) {
      if (controller.signal.aborted) {
        emit({ type: 'run.aborted', sessionId, runId });
      } else {
        console.error('[runManager] run failed:', err instanceof Error ? err.message : err);
        emit({ type: 'run.error', sessionId, runId, message: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      setSessionStatus(sessionId, 'idle');
      emit({ type: 'session.status', sessionId, status: 'idle' });
      runs.delete(sessionId);
    }
  });

  runs.set(sessionId, { runId, controller, done });
  return { runId };
}

export function abortSessionRun(sessionId: string): boolean {
  const handle = runs.get(sessionId);
  if (!handle) return false;
  handle.controller.abort();
  return true;
}

export function isRunning(sessionId: string): boolean {
  return runs.has(sessionId);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test --workspace apps/server -- src/harness/__tests__/runManager.test.ts`
Expected: PASS(全部 6 用例)。

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/harness/runManager.ts apps/server/src/harness/__tests__/runManager.test.ts
git commit -m "feat(session): add RunManager for single-flight background runs"
```

---

## Task 5: runStream 加 abortSignal/onFinish seam + runSession 执行器(R1 验证)

> **R1(技术前提)在此验证**:用注入的 fake model 确认"后台消费 `result.fullStream` + `onFinish` 能完整推进生成"。若 Step 4 的验证测试失败,STOP —— 整个连接解耦方案需重新评估。

**Files:**
- Modify: `apps/server/src/harness/agent.ts`(`RunStreamOpts` 加 `abortSignal?`/`onFinish?`,透传 streamText)
- Create: `apps/server/src/harness/runSession.ts`
- Create: `apps/server/test/fakeLanguageModel.ts`
- Test: `apps/server/src/harness/__tests__/runSession.test.ts`

**Interfaces:**
- Consumes: `runStream`(现有,加 seam);Task 1 `appendMessages`/`setSessionStatus`;Task 3 `emit`;`convertToModelMessages`(现有)。
- Produces:
  - `RunStreamOpts` 新增 `abortSignal?: AbortSignal`、`onFinish?: (result: { responseMessage: UIMessage }) => void`(透传 streamText)
  - `runSession(opts: { sessionId: string; userId?: string; role: Role; messages: ModelMessage[]; auditTraceId: string; abortSignal: AbortSignal; model?: LanguageModel }): Promise<void>`

- [ ] **Step 1: 写 fake LanguageModelV1**

创建 `apps/server/test/fakeLanguageModel.ts`:

```ts
import type { LanguageModelV1, LanguageModelV1CallOptions, LanguageModelV1StreamPart } from 'ai';

// Minimal fake LanguageModelV1 that streams a fixed sequence of parts then a
// finish chunk. Injected via RunStreamOpts.model so runSession/runStream tests
// need no network or API key.
export function fakeStreamingModel(
  textChunks: string[] = ['hello'],
): LanguageModelV1 {
  return {
    specificationVersion: 'v1',
    provider: 'fake',
    modelId: 'fake-model',
    async doStream({ prompt }: LanguageModelV1CallOptions): Promise<{
      stream: ReadableStream<LanguageModelV1StreamPart>;
    }> {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<LanguageModelV1StreamPart>({
        start(controller) {
          for (const chunk of textChunks) {
            controller.enqueue({
              type: 'text-delta',
              textDelta: chunk,
            } as LanguageModelV1StreamPart);
          }
          controller.enqueue({
            type: 'finish',
            finishReason: 'stop',
            usage: { promptTokens: 1, completionTokens: 1 },
          } as LanguageModelV1StreamPart);
          controller.close();
        },
      });
      // Reference prompt to satisfy linters that the param is intentional; the
      // fake ignores the actual prompt (canned output).
      void prompt;
      return { stream };
    },
    async doGenerate() {
      throw new Error('fakeStreamingModel does not implement doGenerate');
    },
  };
}
```

- [ ] **Step 2: 写失败测试(R1 验证 + runSession 编排)**

创建 `apps/server/src/harness/__tests__/runSession.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { ModelMessage } from 'ai';
import { runSession } from '../runSession.js';
import { fakeStreamingModel } from '../../test/fakeLanguageModel.js';
import { subscribe } from '../sessionEvents.js';
import { getSessionStatus, createSession, loadSession } from '../sessionStore.js';

describe('runSession', () => {
  it('consumes fullStream, emits message.part events, persists on finish (R1)', async () => {
    const s = createSession('trader', 'u1');
    const parts: unknown[] = [];
    subscribe(s.id, (e) => {
      if (e.type === 'message.part') parts.push(e);
    });
    const messages: ModelMessage[] = [{ role: 'user', content: 'hi' }];

    await runSession({
      sessionId: s.id,
      userId: 'u1',
      role: 'trader',
      messages,
      auditTraceId: 't1',
      abortSignal: new AbortController().signal,
      model: fakeStreamingModel(['hel', 'lo']),
    });

    // R1 core assertion: fullStream was consumed and parts emitted.
    expect(parts.length).toBeGreaterThan(0);
    // assistant message persisted (onFinish fired).
    const loaded = loadSession(s.id);
    const assistant = (loaded?.messages ?? []).find((m: any) => m.role === 'assistant');
    expect(assistant).toBeTruthy();
    // status back to idle.
    expect(getSessionStatus(s.id)?.status).toBe('idle');
  });

  it('abort signal stops the run and leaves status idle', async () => {
    const s = createSession('trader', 'u2');
    const controller = new AbortController();
    const messages: ModelMessage[] = [{ role: 'user', content: 'hi' }];
    // Abort immediately; runSession should reject/stop without throwing out.
    await runSession({
      sessionId: s.id,
      userId: 'u2',
      role: 'trader',
      messages,
      auditTraceId: 't2',
      abortSignal: controller.signal,
      model: fakeStreamingModel(['x']),
    }).catch(() => {});
    controller.abort();
    expect(getSessionStatus(s.id)?.status).toBe('idle');
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npm test --workspace apps/server -- src/harness/__tests__/runSession.test.ts`
Expected: FAIL — `runSession` 未导出;`runStream` 尚未透传 onFinish/abortSignal。

- [ ] **Step 4: 给 runStream 加 seam(agent.ts)**

修改 `apps/server/src/harness/agent.ts`:

`RunStreamOpts` 接口(~行 188)加两个字段:
```ts
  /** Background-runtime seam: abort signal forwarded to streamText. */
  abortSignal?: AbortSignal;
  /** Background-runtime seam: onFinish forwarded to streamText. */
  onFinish?: (result: { responseMessage: import('ai').UIMessage }) => void;
```

在 `streamText({...})` 配置块(~行 358-402)内,`prepareStep` 之后追加:
```ts
    // Background-runtime seams (phase 1). When run via runSession (background),
    // abortSignal lets RunManager abort the run; onFinish lets runSession persist
    // the assistant message without binding to an HTTP response stream.
    ...(abortSignal ? { abortSignal } : {}),
    ...(onFinish
      ? {
          onFinish: async ({ responseMessage }) => {
            try {
              await onFinish({ responseMessage });
            } catch (err) {
              console.error('[agent] onFinish seam failed:', err instanceof Error ? err.message : err);
            }
          },
        }
      : {}),
```

并在 `runStream` 解构参数处(~行 311)加 `abortSignal, onFinish`:
```ts
export async function runStream({ messages, role, auditTraceId, model, deps, userId, sessionId, abortSignal, onFinish }: RunStreamOpts) {
```

- [ ] **Step 5: 实现 runSession**

创建 `apps/server/src/harness/runSession.ts`:

```ts
// Background run executor. Reuses runStream (which encapsulates the full
// streamText config) but, instead of returning result.toUIMessageStreamResponse
// as an HTTP body, CONSUMES result.fullStream: each part is emitted to the
// session event bus, and onFinish persists the assistant UIMessage. This is the
// connection-decoupling core — nothing here binds to an HTTP response.

import type { ModelMessage, LanguageModel, UIMessage } from 'ai';
import { randomUUID } from 'node:crypto';
import { runStream } from './agent.js';
import { appendMessages, setSessionStatus } from './sessionStore.js';
import { emit } from './sessionEvents.js';
import type { Role } from './roleToolRegistry.js';

export interface RunSessionOpts {
  sessionId: string;
  userId?: string;
  role: Role;
  messages: ModelMessage[];
  auditTraceId: string;
  abortSignal: AbortSignal;
  model?: LanguageModel; // test seam
}

export async function runSession(opts: RunSessionOpts): Promise<void> {
  const { sessionId, role, messages, auditTraceId, abortSignal, userId, model } = opts;
  setSessionStatus(sessionId, 'busy', randomUUID());

  const result = await runStream({
    messages,
    role,
    auditTraceId,
    sessionId,
    userId,
    model,
    abortSignal,
    onFinish: ({ responseMessage }) => {
      appendMessages(sessionId, [responseMessage as UIMessage]);
    },
  });

  // R1: consume fullStream so generation progresses in the background and each
  // part is broadcast to subscribers. Not binding to a response body.
  for await (const part of result.fullStream) {
    emit({ type: 'message.part', sessionId, part });
  }
}
```

- [ ] **Step 6: 运行测试确认通过(R1 gate)**

Run: `npm test --workspace apps/server -- src/harness/__tests__/runSession.test.ts`
Expected: PASS。

> **如果 R1 用例(consumes fullStream...persists on finish)失败**:STOP,不要继续后续 Task。失败说明 AI SDK 6 后台消费 fullStream 不推进生成或 onFinish 不触发 —— 需重新评估(可能需消费 `result.text`/`result.response` 替代,或 streamText 的 lazy 行为不同)。请 @librarian 核对 AI SDK 6 streamText 后台消费语义。

- [ ] **Step 7: 构建 + lint + 提交**

Run: `npm run build && npm run lint`
Expected: 全绿。

```bash
git add apps/server/src/harness/agent.ts apps/server/src/harness/runSession.ts apps/server/test/fakeLanguageModel.ts apps/server/src/harness/__tests__/runSession.test.ts
git commit -m "feat(session): runStream abort/onFinish seam + background runSession executor"
```

---

## Task 6: SSE 通道 GET /api/sessions/:id/events

**Files:**
- Modify: `apps/server/src/routes/sessions.ts`(加 events 路由)
- Test: 手动 curl 验证 + 现有 sessions 测试不回归

**Interfaces:**
- Consumes: Task 3 `subscribe`/`emit`;`sessionBelongsTo`;`getSessionStatus`(首事件快照)。
- Produces: `GET /api/sessions/:id/events` → `text/event-stream`,10s 心跳,事件为 `data: <JSON>\n\n`。

- [ ] **Step 1: 加 events 路由**

在 `apps/server/src/routes/sessions.ts` 末尾追加(在 `delete /:id` 之后):

```ts
import { subscribe } from '../harness/sessionEvents.js';
import { getSessionStatus } from '../harness/sessionStore.js';

// SSE event stream for a session. Subscribes to the in-memory event bus and
// fans out events to the client. Disconnecting (close) unsubscribes; the
// background run is unaffected (runs live in RunManager, not this request).
sessionsRoute.get('/:id/events', (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const id = c.req.param('id');
  if (!sessionBelongsTo(id, user.id)) {
    return c.json({ error: 'not found' }, 404);
  }

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const send = (obj: unknown) => writer.write(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));

  // First event: current status snapshot.
  const st = getSessionStatus(id);
  send({ type: 'session.status', sessionId: id, status: st?.status ?? 'idle', runId: st?.runId });

  const unsub = subscribe(id, (e) => {
    void send(e);
  });

  // 10s heartbeat (keeps the connection alive; matches opencode cadence).
  const heartbeat = setInterval(() => {
    void writer.write(encoder.encode(`: heartbeat\n\n`)).catch(() => {});
  }, 10000);

  // Cleanup when the client disconnects.
  (async () => {
    for await (const _chunk of readable as unknown as AsyncIterable<unknown>) {
      // We don't read client input on SSE; drain to nowhere. (EventSource is
      // unidirectional.) Loop ends when the client closes.
    }
  })().catch(() => {});

  c.executionCtx = c.executionCtx; // no-op to satisfy type; Hono provides cleanup via stream
  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
});
```

> **注意 SSE 连接清理**:Hono 在 Node 下需在客户端断开时调用 `unsub()` + `clearInterval(heartbeat)`。由于 `c.req.raw` 的 abort 信号才是可靠的断开检测,改用 req signal。将上面的 IIFE 替换为:
```ts
  c.req.raw.signal?.addEventListener('abort', () => {
    unsub();
    clearInterval(heartbeat);
    void writer.close().catch(() => {});
  });
```
(实现时以此 signal-abort 清理为准;删掉 drain IIFE。)

- [ ] **Step 2: 手动验证(需 server 运行)**

启动后端:`npm run dev:server`(另一终端)。
Run:
```bash
curl -N -b cookies.txt http://localhost:3001/api/sessions/<id>/events
```
Expected: 立即收到一条 `data: {"type":"session.status",...}`,随后每 10s 一行 `: heartbeat`。无报错。

- [ ] **Step 3: 构建确保类型正确**

Run: `npm run build && npm run lint`
Expected: 全绿。若 TS 报 `c.executionCtx` 等不存在的属性,删除那行 no-op(仅为占位说明,实际不需要)。

- [ ] **Step 4: 提交**

```bash
git add apps/server/src/routes/sessions.ts
git commit -m "feat(session): add SSE event stream GET /api/sessions/:id/events"
```

---

## Task 7: chat.ts 契约变更(fire-and-forget)+ abort 端点

**Files:**
- Modify: `apps/server/src/routes/chat.ts`(`POST /chat` 改为启动后台 run + 返回 `{runId}`)
- Modify: `apps/server/src/routes/sessions.ts`(加 `POST /:id/abort`)
- Test: 现有 chat 测试若有需同步更新(见 Step)

**Interfaces:**
- Consumes: Task 4 `startSessionRun`;Task 5 `runSession`;`appendMessages`(用户消息持久化,保留)。
- Produces:
  - `POST /api/chat` → `200 { sessionId: string; runId: string; status: 'busy' }` 或 `409 { error: 'session_busy'; activeRunId?: string }`
  - `POST /api/sessions/:id/abort` → `200 { ok: true; aborted: boolean }`

- [ ] **Step 1: 改 chat.ts 的 POST /chat**

在 `apps/server/src/routes/chat.ts`,把 Step 行 167-237 的 `try { const result = await runStream(...)...return new Response(...) }` 块替换为:

```ts
  try {
    // Background runtime: start a detached run via RunManager and return
    // immediately. The run consumes fullStream + persists via onFinish +
    // emits to the session event bus (GET /api/sessions/:id/events). The HTTP
    // response no longer carries the stream — connection disconnects do NOT
    // abort the run.
    const start = startSessionRun(sessionId, userId ?? undefined, agentRole, (signal) =>
      runSession({
        sessionId,
        userId: userId ?? undefined,
        role: agentRole,
        messages: streamMessages,
        auditTraceId,
        abortSignal: signal,
      }),
    );
    if ('conflict' in start) {
      const st = getSessionStatus(sessionId);
      return c.json({ error: 'session_busy', activeRunId: st?.runId }, 409);
    }
    return c.json({ sessionId, runId: start.runId, status: 'busy' }, { status: 200, headers: { 'x-session-id': sessionId } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[chat] setup error:', msg);
    return c.json({ error: 'Chat run failed', detail: msg }, 500);
  }
```

chat.ts 顶部 import:
```ts
import { startSessionRun } from '../harness/runManager.js';
import { runSession } from '../harness/runSession.js';
import { getSessionStatus } from '../harness/sessionStore.js';
```

删除不再使用的 import:`runStream`、`recordL2PendingFromResponse` 引用若仅在被替换块用则移除(保留仍被使用的)。注意:**title 生成与 L2 pending 记录原本挂在 `result.response.then`** —— 后台化后这两者需迁入 `runSession` 或保留为 fire-and-forget。本 Task 范围内:把 `recordL2PendingFromResponse` 和首轮 title 生成的逻辑移入 `runSession` 的 onFinish 之后的 `result.response.then(...)`(在 runSession 内消费 response)。在 runSession 的 fullStream 循环后追加:

```ts
  // Preserve L2 pending recording + first-turn title gen (previously in chat.ts
  // result.response.then). result.response is a PromiseLike (no .catch).
  result.response.then(
    async (r) => {
      try { recordL2PendingFromResponse(sessionId, r.messages); } catch (e) { console.error('[runSession] L2 record:', e); }
    },
    () => { /* stream errors surfaced via fullStream */ },
  );
```
(在 runSession.ts import `recordL2PendingFromResponse` from `./agent.js`。title 生成逻辑可暂留 chat 路径或一并迁入 —— 实现时按现状最小迁移,title-gen 仍 fire-and-forget 调 `generateSessionTitle`。)

- [ ] **Step 2: 加 abort 端点**

在 `apps/server/src/routes/sessions.ts` 加(需 admin/trader,与 delete 一致):

```ts
import { abortSessionRun } from '../harness/runManager.js';

sessionsRoute.post('/:id/abort', requireRole('admin', 'trader'), (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const id = c.req.param('id');
  if (!sessionBelongsTo(id, user.id)) return c.json({ error: 'not found' }, 404);
  const aborted = abortSessionRun(id);
  return c.json({ ok: true, aborted });
});
```

- [ ] **Step 3: 更新/添加集成测试**

若 `apps/server/test/` 下有 chat 路由测试断言"返回 SSE 流",改为断言返回 `200 {runId, status:'busy'}`。新增一个集成测试验证:
- POST /chat 返回 runId + status busy
- 同 session busy 时再 POST 返回 409
- GET /api/sessions/:id 收到 status busy(反映在 list 端点)

若注入 fake model 到 runSession 困难(路由层),改为:mock `runSession` 模块(vi.mock)在路由测试中,仅验证契约。在 `apps/server/test/routes/chat.background.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
vi.mock('../../src/harness/runSession.js', () => ({
  runSession: vi.fn(async () => { await new Promise((r) => setTimeout(r, 50)); }),
}));
// ... 构造请求测 POST /api/chat 返回 {runId, status:'busy'} 与 409 单飞行
```
(具体请求构造参照现有 chat 路由测试的鉴权 stub 模式;若 repo 无路由层测试基建,本 Task 用手动 curl 验证并记录在 commit message。)

- [ ] **Step 4: 构建 + lint + 全量测试**

Run: `npm run build && npm run lint && npm test --workspace apps/server`
Expected: 全绿。

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/routes/chat.ts apps/server/src/routes/sessions.ts apps/server/src/harness/runSession.ts apps/server/test
git commit -m "feat(chat): fire-and-forget POST /chat + abort endpoint (connection-decoupled)"
```

---

## Task 8: list 端点带 status + 全链路集成验证

**Files:**
- Modify: `apps/server/src/routes/sessions.ts`(list 返回项加 status,若 Task 1 未在路由层暴露)
- Test: `apps/server/test/harness/backgroundRuntime.integration.test.ts`

**Interfaces:**
- Consumes: 全部前序 Task。
- Produces: `GET /api/sessions` 返回项含 `status`;一个端到端集成测试证明后台运行。

- [ ] **Step 1: 确认 list 返回 status**

检查 `apps/server/src/routes/sessions.ts` 的 `GET /`(行 30-37):返回项映射加 `status: r.status`(`listSessionsForUser` 在 Task 1 已返回 status)。

```ts
sessions: rows.map((r) => ({ id: r.id, role: r.role, createdAt: r.createdAt, title: r.title, status: r.status })),
```

- [ ] **Step 2: 写端到端集成测试**

创建 `apps/server/test/harness/backgroundRuntime.integration.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createSession, loadSession, getSessionStatus } from '../../src/harness/sessionStore.js';
import { startSessionRun } from '../../src/harness/runManager.js';
import { subscribe } from '../../src/harness/sessionEvents.js';

describe('background runtime integration', () => {
  it('run survives subscriber disconnect: run persists + finishes + persists message', async () => {
    const s = createSession('trader', 'u1');
    let partCount = 0;
    const unsub = subscribe(s.id, (e) => { if (e.type === 'message.part') partCount++; });

    // Simulate: start run, then "disconnect" (unsubscribe) mid-run.
    const start = startSessionRun(s.id, 'u1', 'trader', async (signal) => {
      // pretend to do work
      await new Promise((r) => setTimeout(r, 10));
      expect(getSessionStatus(s.id)?.status).toBe('busy');
    });
    expect('runId' in start).toBe(true);
    unsub(); // disconnect — run must continue
    await new Promise((r) => setTimeout(r, 30));
    expect(getSessionStatus(s.id)?.status).toBe('idle');
  });

  it('two sessions run concurrently without cross-talk', async () => {
    const a = createSession('trader', 'u1');
    const b = createSession('trader', 'u1');
    startSessionRun(a.id, 'u1', 'trader', async () => { await new Promise((r) => setTimeout(r, 10)); });
    startSessionRun(b.id, 'u1', 'trader', async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(getSessionStatus(a.id)?.status).toBe('busy');
    expect(getSessionStatus(b.id)?.status).toBe('busy');
    await new Promise((r) => setTimeout(r, 30));
    expect(getSessionStatus(a.id)?.status).toBe('idle');
    expect(getSessionStatus(b.id)?.status).toBe('idle');
  });
});
```

- [ ] **Step 3: 运行 + 构建 + lint + 全量测试**

Run: `npm test --workspace apps/server && npm run build && npm run lint`
Expected: 全绿。

- [ ] **Step 4: 提交**

```bash
git add apps/server/src/routes/sessions.ts apps/server/test/harness/backgroundRuntime.integration.test.ts
git commit -m "test(session): background runtime integration + list status field"
```

---

## Self-Review(plan 自审)

**Spec 覆盖**:
- §6.1 数据层(status 字段 + 函数 + 启动恢复)→ Task 1 ✓
- §6.2 RunManager(单飞行/abort/状态)→ Task 4 ✓
- §6.3 runSession(连接解耦核心)→ Task 5 ✓
- §6.4 事件总线 → Task 3 ✓
- §6.5 AsyncLocalStorage → Task 2 ✓
- §6.6 SSE 通道 → Task 6 ✓
- §6.7 API 契约(chat fire-and-forget + abort)→ Task 7 ✓
- §6.8 前端 → 明确推迟到独立 plan(本计划范围说明已声明)✓
- §6.9 HITL approval → 阶段 4(spec 已声明)✓
- 验收标准:1/2/3(切换/关页/刷新 run 继续)→ Task 8 集成测试 + 手动验证;4(409 单飞行)→ Task 4/7;5(并发无串扰)→ Task 8;6(abort)→ Task 4/7;7(重启恢复)→ Task 1 resetBusyOnStartup;8(列表徽标 status)→ Task 1/8 ✓
- §9 R1(AI SDK 6 fullStream 后台消费)→ Task 5 Step 6 显式 gate ✓

**Placeholder 扫描**:无 TBD/TODO;Task 6 Step 1 的 `c.executionCtx` 占位已注明删除;Task 7 Step 3 的路由测试依现有基建,给了 vi.mock 方案 + 手动 fallback。

**类型一致性**:`SessionStatus`、`StartResult`、`SessionEvent`、`RunSessionOpts` 在各 Task 间名称一致;`setSessionStatus`/`getSessionStatus`/`startSessionRun`/`runSession`/`emit`/`subscribe` 签名贯穿一致。

**风险提示**:Task 5 Step 6 是硬 gate —— R1 失败则停止。Task 7 的 L2 pending/title-gen 迁移需仔细(从 chat.ts `result.response.then` 迁入 runSession),实现时对照现有行 180-206 逐项搬移。

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-13-background-session-runtime-phase1-backend.md`. 执行方式两选一:

1. **Subagent-Driven(推荐)** — 每个 Task 派一个 fresh subagent,Task 间 review,快速迭代(尤其适合 Task 5 R1 gate 需要人工判断)。
2. **Inline Execution** — 本会话内用 executing-plans 批量执行,带 checkpoint review。

哪种?
