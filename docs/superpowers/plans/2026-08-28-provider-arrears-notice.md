# 模型服务欠费提示 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 模型 API（DeepSeek/千问）欠费时，在对话流内显示专用中文卡片，告知用户"请联系管理员充值"。

**Architecture:** 服务端新增欠费分类器，`runManager` 捕获 run 失败时分类并给 `run.error` SSE 事件附加机器可读 `code` + 用户文案；前端把 error 从裸字符串升级为结构化对象，按 `code === 'provider_arrears'` 分发到专用卡片组件。设计文档：`docs/superpowers/specs/2026-08-28-provider-arrears-notice-design.md`。

**Tech Stack:** Hono + AI SDK 6（服务端），React 19 + Tailwind（前端），vitest（服务端测试）。

## Global Constraints

- 代码中禁止 emoji（repo 全局约定）。
- 验证顺序固定：build → lint → test（CI 同序）。命令全部从 repo 根目录跑。
- 单测命令：`npm test --workspace apps/server -- test/harness/<file>.test.ts`。
- 前端无测试设施，前端改动靠 `npm run build` + `npm run lint` 验证。
- 本仓库为 AI SDK 6（`inputSchema`/`stopWhen`/`toUIMessageStreamResponse` 等），本计划不直接写 SDK 调用，但不得引入 v5/v7 API。
- `run.error` 仅由 `apps/server/src/harness/runManager.ts` emit；老的重放缓冲事件无 `code` 字段，前端必须按 generic 处理。
- 提示文案为临时状态：不持久化到会话历史，不写入 LLM 上下文。

---

### Task 1: 服务端欠费分类器 `providerErrors.ts`（TDD）

**Files:**
- Create: `apps/server/src/harness/providerErrors.ts`
- Test: `apps/server/test/harness/providerErrors.test.ts`

**Interfaces:**
- Consumes: 无（纯函数，无依赖）。
- Produces: `classifyProviderError(err: unknown): ProviderErrorInfo`，其中
  `interface ProviderErrorInfo { code: 'provider_arrears' | null; userMessage: string | null }`。
  Task 2 在 runManager 中调用。

- [ ] **Step 1: Write the failing test**

创建 `apps/server/test/harness/providerErrors.test.ts`：

```typescript
import { describe, it, expect } from 'vitest';
import { classifyProviderError } from '../../src/harness/providerErrors.js';

describe('classifyProviderError', () => {
  it('DeepSeek-style 402 APICallError hits provider_arrears', () => {
    const e = new Error('Insufficient Balance') as any;
    e.name = 'APICallError';
    e.statusCode = 402;
    const r = classifyProviderError(e);
    expect(r.code).toBe('provider_arrears');
    expect(r.userMessage).toContain('欠费');
    expect(r.userMessage).toContain('管理员');
  });

  it('message wording "Insufficient Balance" hits even without statusCode', () => {
    const r = classifyProviderError(new Error('402: Insufficient Balance'));
    expect(r.code).toBe('provider_arrears');
  });

  it('DashScope Arrearage responseBody hits provider_arrears', () => {
    const e = new Error('Request failed') as any;
    e.responseBody = '{"error":{"code":"Arrearage","message":"账户已欠费"}}';
    expect(classifyProviderError(e).code).toBe('provider_arrears');
  });

  it('Chinese 欠费 message hits provider_arrears', () => {
    expect(classifyProviderError(new Error('调用失败：账户欠费，请充值')).code).toBe('provider_arrears');
  });

  it('OpenAI-style quota wording hits provider_arrears', () => {
    expect(
      classifyProviderError(new Error('You have exceeded your current quota, please check your plan and billing details.')).code,
    ).toBe('provider_arrears');
  });

  it('generic provider errors do NOT hit provider_arrears', () => {
    const e = new Error('Invalid request: model not found') as any;
    e.statusCode = 400;
    const r = classifyProviderError(e);
    expect(r.code).toBeNull();
    expect(r.userMessage).toBeNull();
  });

  it('network failure / plain string throw do NOT hit provider_arrears', () => {
    expect(classifyProviderError(new Error('fetch failed')).code).toBeNull();
    expect(classifyProviderError('boom').code).toBeNull();
    expect(classifyProviderError(undefined).code).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace apps/server -- test/harness/providerErrors.test.ts`
Expected: FAIL（模块不存在，Cannot find module `../../src/harness/providerErrors.js`）

- [ ] **Step 3: Write minimal implementation**

创建 `apps/server/src/harness/providerErrors.ts`：

```typescript
// Provider-level run-error classification for background runs. runManager
// calls classifyProviderError on a failed run and attaches the verdict to the
// run.error SSE event (code + user-facing message). The only verdict today is
// 'provider_arrears': DeepSeek returns HTTP 402 "Insufficient Balance"
// (AI SDK APICallError exposes statusCode/responseBody), while Qwen/DashScope
// OpenAI-compatible endpoints answer with an "Arrearage" error code or quota
// wording in the body. Extend with new codes here as new cases appear.

export interface ProviderErrorInfo {
  code: 'provider_arrears' | null;
  userMessage: string | null;
}

const ARREARS_RE = /insufficient balance|arrearage|欠费|余额不足|exceeded your current quota/i;
const ARREARS_USER_MESSAGE = 'AI 模型服务欠费，请联系管理员充值后重试。';

export function classifyProviderError(err: unknown): ProviderErrorInfo {
  const e = err as
    | { message?: string; statusCode?: number; status?: number; responseBody?: string }
    | undefined;
  const message = typeof e?.message === 'string' ? e.message : String(err ?? '');
  const body = typeof e?.responseBody === 'string' ? e.responseBody : '';
  const status = e?.statusCode ?? e?.status;
  if (status === 402 || ARREARS_RE.test(message) || ARREARS_RE.test(body)) {
    return { code: 'provider_arrears', userMessage: ARREARS_USER_MESSAGE };
  }
  return { code: null, userMessage: null };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace apps/server -- test/harness/providerErrors.test.ts`
Expected: PASS（7 个用例全绿）

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/harness/providerErrors.ts apps/server/test/harness/providerErrors.test.ts
git commit -m "feat: provider 欠费错误分类器"
```

---

### Task 2: `runManager` 接入分类，`run.error` 事件带 `code`

**Files:**
- Modify: `apps/server/src/harness/runManager.ts`（import 区 + catch 分支，约 70-76 行）
- Test: `apps/server/test/harness/runManager.test.ts`（追加 2 个用例）

**Interfaces:**
- Consumes: `classifyProviderError` from `./providerErrors.js`（Task 1）。
- Produces: SSE 事件 `{ type: 'run.error', sessionId, runId, message: string, code: 'provider_arrears' | 'run_failed', userMessage?: string }`。
  Task 3 的前端按 `event.code` / `event.userMessage` 消费。

- [ ] **Step 1: Write the failing tests**

在 `apps/server/test/harness/runManager.test.ts` 的 `describe('runManager', ...)` 内追加（顶部 import 区补 `subscribe`）：

```typescript
import { emit, subscribe } from '../../src/harness/sessionEvents.js';
```

```typescript
  it('attaches provider_arrears code to run.error for DeepSeek-style 402 failures', async () => {
    const sid = `rm-arrears-${crypto.randomUUID().slice(0, 8)}`;
    const seen: Array<Record<string, unknown>> = [];
    const unsub = subscribe(sid, (e) => {
      if (e.type === 'run.error') seen.push(e as Record<string, unknown>);
    });
    const err = new Error('Insufficient Balance') as any;
    err.name = 'APICallError';
    err.statusCode = 402;
    void startSessionRun(sid, undefined, 'trader', async () => { throw err; }).catch(() => {});
    await new Promise((r) => setTimeout(r, 10));
    unsub();
    expect(seen.length).toBe(1);
    expect(seen[0]!.code).toBe('provider_arrears');
    expect(String(seen[0]!.userMessage)).toContain('管理员');
    // 原始错误文本保留（排障用）
    expect(seen[0]!.message).toBe('Insufficient Balance');
  });

  it('generic failures keep run_failed code and no userMessage (backward compatible)', async () => {
    const sid = `rm-runfail-${crypto.randomUUID().slice(0, 8)}`;
    const seen: Array<Record<string, unknown>> = [];
    const unsub = subscribe(sid, (e) => {
      if (e.type === 'run.error') seen.push(e as Record<string, unknown>);
    });
    void startSessionRun(sid, undefined, 'trader', async () => { throw new Error('boom'); }).catch(() => {});
    await new Promise((r) => setTimeout(r, 10));
    unsub();
    expect(seen.length).toBe(1);
    expect(seen[0]!.code).toBe('run_failed');
    expect(seen[0]!.userMessage).toBeUndefined();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test --workspace apps/server -- test/harness/runManager.test.ts`
Expected: 新增 2 个用例 FAIL（`code` 字段为 undefined），既有 7 个用例仍 PASS

- [ ] **Step 3: Implement in runManager.ts**

在文件顶部 import 区（`import { emit } from './sessionEvents.js';` 之后）加：

```typescript
import { classifyProviderError } from './providerErrors.js';
```

把 catch 分支（当前 70-76 行）从：

```typescript
    } catch (err) {
      if (controller.signal.aborted) {
        await emit({ type: 'run.aborted', sessionId, runId });
      } else {
        console.error('[runManager] run failed:', err instanceof Error ? err.message : String(err));
        await emit({ type: 'run.error', sessionId, runId, message: err instanceof Error ? err.message : String(err) });
      }
    } finally {
```

改为：

```typescript
    } catch (err) {
      if (controller.signal.aborted) {
        await emit({ type: 'run.aborted', sessionId, runId });
      } else {
        const rawMessage = err instanceof Error ? err.message : String(err);
        console.error('[runManager] run failed:', rawMessage);
        // Provider 级失败分类（当前仅欠费）：run.error 附带机器可读 code 与
        // 用户文案；未命中归为 run_failed，事件形状向后兼容（多出字段而已）。
        const cls = classifyProviderError(err);
        await emit({
          type: 'run.error',
          sessionId,
          runId,
          message: rawMessage,
          code: cls.code ?? 'run_failed',
          userMessage: cls.userMessage ?? undefined,
        });
      }
    } finally {
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test --workspace apps/server -- test/harness/runManager.test.ts test/harness/providerErrors.test.ts`
Expected: PASS（全部用例绿）

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/harness/runManager.ts apps/server/test/harness/runManager.test.ts
git commit -m "feat: run.error 事件附带欠费分类 code 与用户文案"
```

---

### Task 3: 前端 `useSessionEvents` error 结构化

**Files:**
- Modify: `apps/web/src/hooks/useSessionEvents.ts`
- Modify: `apps/web/src/components/RealChatView.tsx:808`（仅类型适配，保持 generic 行为）

**Interfaces:**
- Consumes: Task 2 的 SSE 事件字段 `code` / `userMessage`（缺失时回退）。
- Produces: `interface SessionError { code?: string; message: string; userMessage?: string }`；
  `useSessionEvents` 返回值 `error: SessionError | null`；`onRunError?: (runId, error: SessionError) => void`。
  `useSessionMessages.ts` 经 `const { status, error } = useSessionEvents(...)` 自动获得新类型，
  无需改动（其内部 `onRunError` 回调忽略参数，保持原样）。Task 4 在 RealChatView 消费。

- [ ] **Step 1: 修改 useSessionEvents.ts**

五处改动（完整代码）：

(a) 在 `export interface SessionEventHandlers {` 之前新增类型：

```typescript
/** Structured run/connection error surfaced to the UI. `code` is the
 *  server-side verdict ('provider_arrears' = 模型欠费, 'run_failed' = 其他，
 *  缺省视为 run_failed); `userMessage` is the ready-to-show Chinese copy. */
export interface SessionError {
  code?: string
  message: string
  userMessage?: string
}
```

(b) `onRunError` 签名从

```typescript
  /** A background run errored (event type 'run.error'). */
  onRunError?: (runId: string | undefined, message: string) => void
```

改为

```typescript
  /** A background run errored (event type 'run.error'). */
  onRunError?: (runId: string | undefined, error: SessionError) => void
```

(c) `const [error, setError] = useState<string | null>(null)` 改为

```typescript
  const [error, setError] = useState<SessionError | null>(null)
```

(d) `switch` 里的 `case 'run.error':` 从

```typescript
        case 'run.error':
          handlersRef.current.onRunError?.(
            event.runId as string | undefined,
            (event.message as string) ?? 'unknown error',
          )
          setError((event.message as string) ?? 'run error')
          break
```

改为

```typescript
        case 'run.error': {
          // 老 runManager 版本（重放缓冲里的历史事件）没有 code/userMessage
          // 字段：一律回退 run_failed，UI 走 generic 路径。
          const err: SessionError = {
            code: typeof event.code === 'string' ? event.code : 'run_failed',
            message: (event.message as string) ?? 'run error',
            userMessage: typeof event.userMessage === 'string' ? event.userMessage : undefined,
          }
          handlersRef.current.onRunError?.(event.runId as string | undefined, err)
          setError(err)
          break
        }
```

(e) 同函数内 `es.onerror` 的 `setError('连接已断开')` 改为

```typescript
          setError({ message: '连接已断开' })
```

- [ ] **Step 2: RealChatView 类型适配（保持行为不变，保证 build 绿）**

`apps/web/src/components/RealChatView.tsx:808` 从

```tsx
          <ErrorMessage error={error ? new Error(error) : null} />
```

改为

```tsx
          <ErrorMessage error={error ? new Error(error.message) : null} />
```

说明：`error` 类型变为 `SessionError | null` 后，`new Error(error)` 无法编译。
此处先把 `.message` 取出来，行为与现状完全一致；欠费专用分发在 Task 4 完成。
顶栏状态徽章（`:661` `:666`）对 `error` 只做真值判断，对象为真值，行为不变。

- [ ] **Step 3: 类型检查验证**

Run: `npm run build`
Expected: PASS（`useSessionMessages` 的 error 类型经推断自动变为 `SessionError | null`，
唯一显式消费点 RealChatView:808 已在本任务适配）

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/hooks/useSessionEvents.ts apps/web/src/components/RealChatView.tsx
git commit -m "feat: 前端 session error 结构化（code + userMessage）"
```

---

### Task 4: 前端欠费卡片 `ArrearsNotice` + RealChatView 分发

**Files:**
- Modify: `apps/web/src/components/RealMessageItem.tsx`（文件末尾，`ErrorMessage` 之后新增组件）
- Modify: `apps/web/src/components/RealChatView.tsx:5`（import）与 `:808`（分发）

**Interfaces:**
- Consumes: Task 3 的 `SessionError`（`error.code === 'provider_arrears'` 判定，经
  `useSessionMessages` 返回的 `error` 推断获得）。
- Produces: `export const ArrearsNotice: React.FC`（无 props，文案自包含）。

- [ ] **Step 1: 在 RealMessageItem.tsx 末尾新增组件**

在 `export const ErrorMessage` 组件（约 546-558 行）之后追加：

```tsx
/** 模型服务欠费专用提示卡（run.error code='provider_arrears'）。临时 UI 状态：
 *  不持久化、不入会话历史；充值后重新发送消息即可恢复。视觉上与 ErrorMessage
 *  同位同类（danger 色系），但文案面向最终用户给出明确行动指引。 */
export const ArrearsNotice: React.FC = () => {
  return (
    <div className="flex gap-3 animate-slide-up">
      <div className="w-8 h-8 rounded-lg bg-danger/10 flex items-center justify-center shrink-0">
        <AlertCircle className="w-4 h-4 text-danger" />
      </div>
      <div className="max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed bg-white border border-danger/20 rounded-tl-sm">
        <div className="font-medium text-danger">AI 模型服务欠费</div>
        <p className="text-ink mt-1">
          模型服务商账户余额不足，本轮回复未能生成。请联系管理员为 DeepSeek / 千问账户充值，充值后重新发送消息即可继续对话。
        </p>
      </div>
    </div>
  )
}
```

（`AlertCircle` 已在该文件 import，无需新增。）

- [ ] **Step 2: RealChatView 分发**

`apps/web/src/components/RealChatView.tsx:5` 的 import 从

```typescript
import { RealMessageItem, ErrorMessage } from './RealMessageItem'
```

改为

```typescript
import { RealMessageItem, ErrorMessage, ArrearsNotice } from './RealMessageItem'
```

`:808`（Task 3 Step 2 改过的那一行）从

```tsx
          <ErrorMessage error={error ? new Error(error.message) : null} />
```

改为

```tsx
          {error?.code === 'provider_arrears'
            ? <ArrearsNotice />
            : <ErrorMessage error={error ? new Error(error.message) : null} />}
```

- [ ] **Step 3: Build + lint 验证（前端无测试设施）**

Run: `npm run build && npm run lint`
Expected: 全部 PASS

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/RealMessageItem.tsx apps/web/src/components/RealChatView.tsx
git commit -m "feat: 对话流内模型欠费提示卡片"
```

---

### Task 5: 全量验证 + 合回 main

**Files:** 无新改动（验证与合并）。

**Interfaces:** 无。

- [ ] **Step 1: 全量验证（CI 同序）**

Run: `npm run build && npm run lint && npm test`
Expected: 全部 PASS（含 `providerErrors.test.ts` 与 `runManager.test.ts` 新用例）

- [ ] **Step 2: 推分支并合回 main（repo 约定：push 到 main 触发 CI+CD）**

```bash
git push origin HEAD:PengYip/业务图谱模版关系讨论
git fetch origin main
git merge origin/main
npm run build && npm run lint && npm test
git push origin HEAD:main
```

merge 若带入代码冲突/变更，解决后重新跑一遍 build → lint → test 再推。
Expected: CI 绿，CD 自动部署到 10.10.0.2。
