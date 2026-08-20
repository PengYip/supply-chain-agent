# Phase 6 — §10/Ch2 Mechanism Hardening (Scope A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the three book-driven (《深入理解AI Agent》Ch5/Ch4) fault-recovery mechanisms the project lacks — a per-tool timeout, a repeat-call no-progress loop guard, and a retryable-error classification table — so the agent loop degrades gracefully instead of hanging or death-spiraling on pathological tool calls.

**Architecture:** All three live in the harness execute-wrapping layer (`withAudit`/`buildGatedTools` in `agent.ts`) and the loop-control layer (`FailureTracker`/`makeCircuitBreaker`/`streamText.stopWhen`/`experimental_onToolCallFinish` in `compression.ts` + `agent.ts`). No new dependencies. No storage changes. No frontend. Each task ships a structured-result convention piece: T1 makes timeouts return a structured result (book Ch5:314 — model adapts next turn, not a silent kill); T2 adds repeat-call fingerprint loop detection (book Ch5:186); T3 classifies caught execute errors into retryable/non-retryable structured results (book Ch5:184 "先分类再计数" + Ch5:196 "把错误变成模型的输入") and re-derives the failure signal from result shape so the existing consecutive-failure circuit breaker keeps working under the new structured-result convention.

**Tech Stack:** AI SDK 6 (`streamText`, `experimental_onToolCallFinish`, `stopWhen`, `StopCondition`, `stepCountIs`); Hono; better-sqlite3 (unaffected); DeepSeek (unaffected).

**Out of scope (deferred, per user scope-A choice):** context-compression LLM archival tier (Ch2 L4 via the existing `Summarizer` interface — the deterministic tiers already match Ch2 layers 1–2); Ch6 eval system implementation (analysis delivered separately at `docs/superpowers/specs/2026-08-12-eval-system-application-analysis.md`); silent-retry-with-backoff ladder (Ch5:190 — needs an HTTP-call layer this project largely lacks; the classification table from T3 is the foundation for a future retry tier); escalation-to-human on repeated failure (needs HITL UI work); session-level budget caps.

## Global Constraints

- **AI SDK 6, not 5/7.** Tool execute signature `(input, options) => Promise<result>`. `stopWhen` accepts `StopCondition[]` (use `stepCountIs` + `makeCircuitBreaker`). `experimental_onToolCallFinish` (v6 name, NOT v7's `onToolCallFinish`). `experimental_telemetry` (v6, NOT v7 `telemetry`). Serialize via `toUIMessageStreamResponse`.
- **No emoji** in code or comments (repo-wide).
- **AGENTS.md verification order:** `npm run build` (both workspaces) → `npm run lint` (oxlint) → `npm test` (`OPENAI_API_KEY=ci-dummy-key`). Root `server/` stale; the `server/src/routes/chat.ts` LSP error is pre-existing — ignore.
- **Vitest test imports need `.js` extension + correct depth.** From `apps/server/test/harness/*.test.ts` → `../../src/harness/<mod>.js`. The `task-brief` script produces WRONG extensionless paths — correct them.
- **Env permissive defaults.** `TOOL_TIMEOUT_MS` uses `z.coerce.number().int().positive().default(120000)` mirroring the MinIO block. CI injects only `OPENAI_API_KEY=ci-dummy-key`.
- **`withAudit` is the single choke point** (agent.ts:59-67): every tool's execute flows through it. Today it records on success and propagates on throw (no record on throw). T1 wraps timeout INSIDE withAudit; T3 adds try/catch INSIDE withAudit.
- **The existing circuit breaker MUST keep working.** Today `experimental_onToolCallFinish: ({success}) => failures.recordToolFinish(success)` derives `success` from the SDK's throw-vs-resolve signal. T3 converts throws → structured returns, which would make the SDK always report `success=true`. T3 therefore re-derives `success` from the result SHAPE (`status !== 'error'`) so the breaker still trips on consecutive error-shaped results. This interaction is load-bearing.
- **FailureTracker threshold = 3** already matches the book's production-derived "连续 3 次" (Ch5:200). Keep it.

---

## Task 1: Per-tool timeout wrapper (structured result)

**Files:**
- Modify: `apps/server/src/env.ts` (add `TOOL_TIMEOUT_MS`, ~after line 44)
- Modify: `apps/server/src/harness/agent.ts:59-89` (add `withToolTimeout` near `withAudit`; compose in `buildGatedTools`)
- Test: `apps/server/test/harness/toolTimeout.test.ts`

**Interfaces:**
- Consumes: `env.TOOL_TIMEOUT_MS` (this task defines it, default 120000ms).
- Produces: `withToolTimeout(execute, timeoutMs): Tool['execute']` — wraps an execute; on timeout returns a structured result `{ status:'error', reason:'tool_timeout', toolName, timeoutMs }` (book Ch5:314 — structured, not silent kill, so the model can adapt next turn) INSTEAD of throwing.

**Composition (load-bearing):** `buildGatedTools` wraps each tool as `withAudit(name, withToolTimeout(t.execute, env.TOOL_TIMEOUT_MS))` — timeout is INNERMOST (closest to the real execute), audit is OUTERMOST. So on timeout, `withToolTimeout` returns the structured result, `withAudit` receives it as the normal `result`, records it (audit visibility for timeouts — a regression vs today where a thrown timeout would emit no record), and returns it. The model sees a tool RESULT (not an error part).

- [ ] **Step 1: Write the failing test**

`apps/server/test/harness/toolTimeout.test.ts` (new). Import depth from `apps/server/test/harness/` → `../../src/harness/agent.js` (for `buildGatedTools`) + vitest.
```ts
import { describe, it, expect } from 'vitest'
import { buildGatedTools } from '../../src/harness/agent.js'
import { tool } from 'ai'
import type { Role } from '../../src/harness/roleToolRegistry.js'

// A tool whose execute sleeps longer than the timeout. We exercise it via the
// gated-tools wrapper, which composes withAudit(withToolTimeout(execute)).
describe('withToolTimeout (per-tool timeout wrapper)', () => {
  it('returns a structured tool_timeout result when execute exceeds the timeout', async () => {
    const slow = tool({
      description: 'slow test tool',
      inputSchema: { type: 'object', properties: {}, required: [] } as any,
      execute: async () => {
        await new Promise((r) => setTimeout(r, 200))
        return { ok: true }
      },
    })
    // Build a gated toolset containing `slow` at a very short timeout.
    // Approach: call buildGatedTools with a role whose registry includes `slow`,
    // OR — if buildGatedTools only reads the registry — wrap the tool directly
    // by exporting withToolTimeout and unit-testing it in isolation (preferred:
    // decouples from the role registry).
    const { withToolTimeout } = await import('../../src/harness/agent.js')
    const wrapped = withToolTimeout(slow.execute!, 50)
    const out = await wrapped({} as any, {} as any)
    expect(out).toMatchObject({
      status: 'error',
      reason: 'tool_timeout',
      timeoutMs: 50,
    })
  })

  it('passes the normal result through when execute finishes in time', async () => {
    const fast = tool({
      description: 'fast test tool',
      inputSchema: { type: 'object', properties: {}, required: [] } as any,
      execute: async () => ({ ok: true, value: 42 }),
    })
    const { withToolTimeout } = await import('../../src/harness/agent.js')
    const wrapped = withToolTimeout(fast.execute!, 1000)
    const out = await wrapped({} as any, {} as any)
    expect(out).toEqual({ ok: true, value: 42 })
  })
})
```
(If `withToolTimeout` is cleaner as a standalone export, export it. The test imports it directly — decoupled from the role registry. toolName is passed in buildGatedTools; the wrapper itself only needs timeoutMs, and toolName is attached at the call site OR omitted from the result. Adjust: `withToolTimeout(execute, timeoutMs, toolName?)` — toolName optional, included in the structured result when provided.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace apps/server -- test/harness/toolTimeout.test.ts`
Expected: FAIL — `withToolTimeout` is not exported.

- [ ] **Step 3: Add env + wrapper + compose in buildGatedTools**

`apps/server/src/env.ts` — add inside `EnvSchema` (after the MinIO block, ~line 44):
```ts
  /** Per-tool execute timeout in ms (book Ch5:314). Default 120s. */
  TOOL_TIMEOUT_MS: z.coerce.number().int().positive().default(120000),
```

`apps/server/src/harness/agent.ts` — add `withToolTimeout` near `withAudit` (after line 67), export it for unit testing:
```ts
/**
 * Per-tool timeout wrapper (book Ch5:314). Wraps an execute in a Promise.race
 * against a timeout. On timeout returns a STRUCTURED result — NOT a throw — so
 * the model sees the timeout as a tool result it can adapt to next turn (change
 * args, switch tool, give up) instead of a silent kill. The wrapper is INNERMOST
 * (composed inside withAudit) so withAudit records the structured timeout like
 * any other result. toolName is attached for the model's context.
 */
export function withToolTimeout(
  execute: Tool['execute'],
  timeoutMs: number,
  toolName?: string,
): Tool['execute'] {
  if (!execute) return execute
  return async (input: any, options: any) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        resolve({ status: 'error', reason: 'tool_timeout', toolName, timeoutMs })
      }, timeoutMs)
    })
    try {
      const result = await Promise.race([execute(input, options), timeout])
      return result
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}
```
Then in `buildGatedTools` (line 78), change the composition:
```ts
    // Before: const audited: Tool = { ...t, execute: withAudit(name, t.execute) };
    const audited: Tool = { ...t, execute: withAudit(name, withToolTimeout(t.execute, env.TOOL_TIMEOUT_MS, name)) };
```
(import `env` from `../env.js` at the top of `agent.ts` — it is almost certainly already imported; verify.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace apps/server -- test/harness/toolTimeout.test.ts` → PASS (both cases).

- [ ] **Step 5: Build + lint + full test**

Run: `npm run build` (both) → OK. Run: `npm run lint` → exit 0. Run: `npm test` → all green (no regressions; the existing 5-step loop tests still pass — the timeout is generous vs the fast stub models).

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/env.ts apps/server/src/harness/agent.ts apps/server/test/harness/toolTimeout.test.ts
git commit -m "feat: per-tool timeout wrapper returning structured tool_timeout result"
```

---

## Task 2: Repeat-call fingerprint + no-progress loop guard

**Files:**
- Modify: `apps/server/src/harness/compression.ts:310-352` (extend `FailureTracker` with fingerprint tracking + `isLooping`; export a stable-stringify helper)
- Modify: `apps/server/src/harness/agent.ts:295` (stopWhen adds `isLooping`) + `agent.ts:323-325` (onToolCallFinish computes fingerprint)
- Test: `apps/server/test/harness/loopDetector.test.ts`

**Interfaces:**
- Consumes: `experimental_onToolCallFinish` callback's toolCall info (toolName + input/args). **Verify the exact AI SDK 6 callback shape** — the current code destructures `{success}`; the SDK also passes `toolCall` (`{ type:'tool-call', toolCallId, toolName, input }`) and `toolResult`. fix-1 reads the actual SDK types / existing usage to extract toolName + input safely.
- Produces: extended `FailureTracker` with `recordToolCall(toolName, args)` + `isLooping` getter. `stopWhen` becomes `[stepCountIs(5), makeCircuitBreaker(() => failures.shouldStop || failures.isLooping)]`.

**Design:** A repeat-call fingerprint = `hash(toolName + stableStringify(args))`. When the SAME fingerprint recurs (the model re-calling a tool with identical args), that's a no-progress signal (book Ch5:186). Trip the loop guard when any single fingerprint count ≥ 3 (matches the failure-tracker threshold; "called the same tool with the same args 3 times" = stuck). `stableStringify` sorts object keys so `{a:1,b:2}` and `{b:2,a:1}` collide.

- [ ] **Step 1: Write the failing test**

`apps/server/test/harness/loopDetector.test.ts` (new):
```ts
import { describe, it, expect } from 'vitest'
import { createFailureTracker, stableStringify } from '../../src/harness/compression.js'

describe('FailureTracker repeat-call fingerprint', () => {
  it('stableStringify is key-order-independent', () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }))
    expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: 2 }))
  })

  it('isLooping flips true after the SAME (tool,args) is recorded 3 times', () => {
    const f = createFailureTracker(3)
    expect(f.isLooping).toBe(false)
    f.recordToolCall('ingest_document', { docId: 'd1' })
    f.recordToolCall('ingest_document', { docId: 'd1' })
    expect(f.isLooping).toBe(false) // 2 calls = 1 repeat, not yet a loop
    f.recordToolCall('ingest_document', { docId: 'd1' })
    expect(f.isLooping).toBe(true) // 3rd identical = stuck
  })

  it('different args do not trip the loop guard', () => {
    const f = createFailureTracker(3)
    f.recordToolCall('ingest_document', { docId: 'd1' })
    f.recordToolCall('ingest_document', { docId: 'd2' })
    f.recordToolCall('ingest_document', { docId: 'd3' })
    expect(f.isLooping).toBe(false)
  })

  it('different tools with same args do not trip (fingerprint includes toolName)', () => {
    const f = createFailureTracker(3)
    f.recordToolCall('ingest_document', { x: 1 })
    f.recordToolCall('extract_fields', { x: 1 })
    f.recordToolCall('ingest_document', { x: 1 })
    expect(f.isLooping).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace apps/server -- test/harness/loopDetector.test.ts`
Expected: FAIL — `isLooping` / `recordToolCall` / `stableStringify` not exported.

- [ ] **Step 3: Extend FailureTracker + export stableStringify**

`apps/server/src/harness/compression.ts` — export a stable stringify helper (module scope, above the FailureTracker section):
```ts
/**
 * Deterministic JSON stringification (sorted object keys) so two structurally
 * identical args produce the same fingerprint regardless of key insertion order.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.keys(v).sort().reduce((acc: Record<string, unknown>, k) => { acc[k] = (v as Record<string, unknown>)[k]; return acc }, {})
      : v,
  )
}
```
Extend the `FailureTracker` interface (compression.ts:318-322) and `createFailureTracker` (324-337):
```ts
export interface FailureTracker {
  recordToolFinish(success: boolean): void
  /** Record a tool call for repeat-call fingerprint loop detection (book Ch5:186). */
  recordToolCall(toolName: string, args: unknown): void
  readonly consecutiveFailures: number
  readonly shouldStop: boolean
  /** True when any single (toolName,args) fingerprint has been recorded >= threshold times. */
  readonly isLooping: boolean
}

export function createFailureTracker(threshold = 3): FailureTracker {
  let consecutiveFailures = 0
  const fpCounts = new Map<string, number>()
  let looping = false
  return {
    recordToolFinish(success: boolean): void {
      consecutiveFailures = success ? 0 : consecutiveFailures + 1
    },
    recordToolCall(toolName: string, args: unknown): void {
      const fp = `${toolName}::${stableStringify(args)}`
      const next = (fpCounts.get(fp) ?? 0) + 1
      fpCounts.set(fp, next)
      if (next >= threshold) looping = true
    },
    get consecutiveFailures(): number { return consecutiveFailures },
    get shouldStop(): boolean { return consecutiveFailures >= threshold },
    get isLooping(): boolean { return looping },
  }
}
```

- [ ] **Step 4: Wire fingerprint into onToolCallFinish + isLooping into stopWhen**

`apps/server/src/harness/agent.ts` — at the streamText call:
- Line 295, change `stopWhen`:
  ```ts
  stopWhen: [stepCountIs(5), makeCircuitBreaker(() => failures.shouldStop || failures.isLooping)],
  ```
- Lines 323-325, change `experimental_onToolCallFinish` to ALSO record the fingerprint. **First verify the exact AI SDK 6 callback shape** (fix-1 reads the SDK types / existing usage). The target:
  ```ts
  experimental_onToolCallFinish: ({ success, toolCall }) => {
    failures.recordToolFinish(success)
    // Repeat-call fingerprint (book Ch5:186): toolCall carries { toolName, input }.
    if (toolCall?.toolName) {
      failures.recordToolCall(toolCall.toolName, toolCall.input)
    }
  },
  ```
  (If the SDK does not pass `toolCall` here, derive it from the toolResult/toolCallId via the same mechanism `recordL2PendingFromResponse` uses, OR capture the last tool-call from a preceding hook. fix-1 determines the real shape and adjusts; the behavior contract — "every finished tool call records (toolName, args) into the fingerprint tracker" — is what matters.)

- [ ] **Step 5: Run test + build + lint + full test**

Run: `npm test --workspace apps/server -- test/harness/loopDetector.test.ts` → PASS (4 cases).
Run: `npm run build` → OK. Run: `npm run lint` → exit 0. Run: `npm test` → all green.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/harness/compression.ts apps/server/src/harness/agent.ts apps/server/test/harness/loopDetector.test.ts
git commit -m "feat: repeat-call fingerprint loop guard in FailureTracker + stopWhen"
```

---

## Task 3: Retryable-error classification + structured error results

**Files:**
- Create: `apps/server/src/harness/errorClassification.ts` (`classifyToolError`)
- Modify: `apps/server/src/harness/agent.ts:59-67` (`withAudit` catches throws → classifies → structured return) + `agent.ts:323-325` (re-derive `success` from result shape so the circuit breaker still trips)
- Test: `apps/server/test/harness/errorClassification.test.ts`

**Interfaces:**
- Consumes: thrown errors from execute (anything `execute` throws — zod errors, fetch errors, Neo4j errors, our own thrown business errors).
- Produces: `classifyToolError(err): { retryable: boolean; category: 'timeout'|'network'|'overload'|'invalid_args'|'permission'|'not_found'|'unknown'; message: string }`. `withAudit` returns `{ status:'error', reason:'tool_error', retryable, category, message }` on caught throws.

**Behavior shift (flagged, load-bearing):** Today a thrown execute error propagates as an AI SDK 6 tool-error part (model sees it, can re-call). After T3, `withAudit` CATCHES the throw and returns a structured result. This is the book's preferred "把错误变成模型的输入" (Ch5:196) pattern AND unifies with T1's timeout result shape. BUT it breaks the SDK's `success` signal in `experimental_onToolCallFinish` (resolve → success=true always). T3 therefore re-derives `success` from the result SHAPE: `success = !(result && typeof result === 'object' && (result as any).status === 'error')`. This keeps the existing consecutive-failure circuit breaker working under the structured-result convention.

- [ ] **Step 1: Write the failing test**

`apps/server/test/harness/errorClassification.test.ts` (new):
```ts
import { describe, it, expect } from 'vitest'
import { classifyToolError } from '../../src/harness/errorClassification.js'

describe('classifyToolError', () => {
  it('classifies timeout errors as retryable', () => {
    const r = classifyToolError(new Error('sandbox execute timed out after 30000ms'))
    expect(r.retryable).toBe(true)
    expect(r.category).toBe('timeout')
  })

  it('classifies network errors (ECONNRESET/ETIMEDOUT/fetch failed) as retryable', () => {
    const e = new Error('fetch failed') as any; e.code = 'ECONNRESET'
    expect(classifyToolError(e).retryable).toBe(true)
    expect(classifyToolError(e).category).toBe('network')
    const e2 = new Error('request failed') as any; e2.code = 'ETIMEDOUT'
    expect(classifyToolError(e2).category).toBe('network')
  })

  it('classifies overload (429/503) as retryable', () => {
    const e = new Error('Too Many Requests') as any; e.status = 429
    expect(classifyToolError(e).retryable).toBe(true)
    expect(classifyToolError(e).category).toBe('overload')
    const e2 = new Error('Service Unavailable') as any; e2.status = 503
    expect(classifyToolError(e2).category).toBe('overload')
  })

  it('classifies zod/schema validation as non-retryable invalid_args', () => {
    const e = new Error('Invalid input: expected string, received number') as any
    e.name = 'ZodError'
    expect(classifyToolError(e).retryable).toBe(false)
    expect(classifyToolError(e).category).toBe('invalid_args')
  })

  it('classifies permission (403/Unauthorized) as non-retryable permission', () => {
    const e = new Error('Forbidden') as any; e.status = 403
    expect(classifyToolError(e).retryable).toBe(false)
    expect(classifyToolError(e).category).toBe('permission')
  })

  it('classifies not-found as non-retryable', () => {
    const e = new Error('document not found') as any; e.status = 404
    expect(classifyToolError(e).retryable).toBe(false)
    expect(classifyToolError(e).category).toBe('not_found')
  })

  it('falls back to unknown (retryable=false) for unrecognized errors', () => {
    expect(classifyToolError(new Error('something weird'))).toMatchObject({
      retryable: false, category: 'unknown',
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace apps/server -- test/harness/errorClassification.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement classifyToolError**

`apps/server/src/harness/errorClassification.ts` (new):
```ts
/**
 * Retryable-error classification table (book Ch5:184 "先分类再计数" + Ch5:196
 * "把错误变成模型的输入"). Maps a thrown tool error to a {retryable, category}
 * verdict so the model can decide whether to retry (retryable=true: transient —
 * limit, network, overload) or change strategy (retryable=false: the same call
 * will fail identically — bad args, permission, not-found, business logic).
 *
 * Retryable categories: timeout, network (ECONNRESET/ETIMEDOUT/ENOTFOUND/fetch),
 * overload (429/503), transient provider/store errors.
 * Non-retryable: invalid_args (zod/schema), permission (403/auth), not_found,
 * unknown (conservative default — don't amplify a mystery error with retries).
 */
export type ErrorCategory =
  | 'timeout' | 'network' | 'overload'
  | 'invalid_args' | 'permission' | 'not_found' | 'unknown'

export interface ClassifiedError {
  retryable: boolean
  category: ErrorCategory
  message: string
}

const NETWORK_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'UND_ERR_SOCKET', 'FetchError'])
const TIMEOUT_RE = /timed? ?out|timeout|ETIMEDOUT/i
const OVERLOAD_RE = /429|too many requests|rate limit|overload|503|service unavailable|capacity/i
const PERM_RE = /forbidden|403|unauthorized|401|not allowed|permission/i
const NOTFOUND_RE = /not found|404|no such|does not exist|unknown/i
const ZOD_NAMES = new Set(['ZodError', 'ValidationError'])

export function classifyToolError(err: unknown): ClassifiedError {
  const e = err as { message?: string; code?: string | number; status?: number; name?: string } | undefined
  const message = (e?.message ?? String(err)).slice(0, 500)
  const code = e?.code
  const status = e?.status
  const name = e?.name ?? ''

  // 1. Explicit network error codes.
  if (typeof code === 'string' && NETWORK_CODES.has(code)) {
    return { retryable: true, category: 'network', message }
  }
  // 2. Timeout (message-based; our tool_timeout result is produced in withAudit,
  //    but native fetch/neo4j timeouts surface as thrown errors too).
  if (TIMEOUT_RE.test(message) || code === 'ETIMEDOUT') {
    return { retryable: true, category: 'timeout', message }
  }
  // 3. Overload / rate-limit (status or message).
  if (status === 429 || status === 503 || OVERLOAD_RE.test(message)) {
    return { retryable: true, category: 'overload', message }
  }
  // 4. Invalid args (schema/zod).
  if (ZOD_NAMES.has(name) || /invalid (input|args|params)|expected .+ received|validation failed/i.test(message)) {
    return { retryable: false, category: 'invalid_args', message }
  }
  // 5. Permission.
  if (status === 403 || status === 401 || PERM_RE.test(message)) {
    return { retryable: false, category: 'permission', message }
  }
  // 6. Not found.
  if (status === 404 || NOTFOUND_RE.test(message)) {
    return { retryable: false, category: 'not_found', message }
  }
  // 7. Conservative default: non-retryable (don't amplify a mystery error).
  return { retryable: false, category: 'unknown', message }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace apps/server -- test/harness/errorClassification.test.ts` → PASS (7 cases).

- [ ] **Step 5: Wire classifyToolError into withAudit + re-derive success in onToolCallFinish**

`apps/server/src/harness/agent.ts`:
- Import: `import { classifyToolError } from './errorClassification.js'` near the top.
- Modify `withAudit` (lines 59-67) to catch throws, classify, and return a structured result (and STILL record it for audit visibility):
  ```ts
  function withAudit(name: string, execute: Tool['execute']): Tool['execute'] {
    if (!execute) return execute
    return async (input: any, options: any) => {
      const start = Date.now()
      let result: any
      try {
        result = await execute(input, options)
      } catch (err) {
        // Book Ch5:196 "把错误变成模型的输入" + Ch5:184 classify-first. Surface the
        // error as a structured tool RESULT (not an SDK tool-error part) so the
        // model sees a uniform shape incl. whether retrying is worthwhile. The
        // consecutive-failure circuit breaker still trips because onToolCallFinish
        // re-derives success from result.status (see below).
        const classified = classifyToolError(err)
        result = { status: 'error', reason: 'tool_error', toolName: name, ...classified }
      }
      auditRecorder.recordToolCall({ toolName: name, args: input, result, durationMs: Date.now() - start })
      return result
    }
  }
  ```
- Modify `experimental_onToolCallFinish` (lines 323-325) to re-derive `success` from the result shape. **First verify the exact callback shape** (fix-1 reads the SDK types). The target: inspect `toolResult` for the error shape when the SDK reports success (because T3 no longer throws):
  ```ts
  experimental_onToolCallFinish: ({ success, toolCall, toolResult }) => {
    // After T3, execute resolves with a structured {status:'error'} result
    // instead of throwing. Re-derive the failure signal from the result shape so
    // the consecutive-failure circuit breaker still trips on tool errors.
    const isErrorShaped = toolResult && typeof toolResult === 'object' && (toolResult as any)?.status === 'error'
    failures.recordToolFinish(success && !isErrorShaped)
    if (toolCall?.toolName) {
      failures.recordToolCall(toolCall.toolName, toolCall.input)
    }
  },
  ```
  (If the SDK does not pass `toolResult`/`toolCall` here, fix-1 determines the real shape and derives the error flag from whichever field carries the tool's output. The contract: a tool result with `status === 'error'` counts as a failure for the breaker, and every finished tool call records its fingerprint.)

- [ ] **Step 6: Build + lint + full test**

Run: `npm run build` → OK. Run: `npm run lint` → exit 0. Run: `npm test` → all green. **Critical regression check:** the existing harness/e2e-loop tests that exercise tool failures must still trip the circuit breaker (i.e. the re-derived success signal works). If any test that relied on thrown-execute-errors-as-tool-error-parts breaks, that is expected behavior — update the assertion to expect the structured `{status:'error',reason:'tool_error'}` result instead.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/harness/errorClassification.ts apps/server/src/harness/agent.ts apps/server/test/harness/errorClassification.test.ts
git commit -m "feat: classify tool errors + surface as structured results (keep circuit breaker)"
```

---

## Final verification

After Task 3: `npm run build` (both workspaces) → `npm run lint` → `OPENAI_API_KEY=ci-dummy-key npm test`. Expect: build OK; lint exit 0 (only the 4 pre-existing warnings); all tests green.

**Whole-branch interaction check (reviewer focus):**
1. The structured-result convention (T1 timeout + T3 classified error) is uniform: every tool result the model sees is either a real payload or `{status:'error', reason:'tool_timeout'|'tool_error', ...}`.
2. The failure signal (T3) is correctly re-derived from result shape — the consecutive-failure circuit breaker (threshold 3) AND the loop fingerprint guard (T2) both still trip. `stopWhen: [stepCountIs(5), makeCircuitBreaker(() => failures.shouldStop || failures.isLooping)]`.
3. `withAudit` records EVERY result (success payload, structured timeout, structured error) — audit visibility is strictly better than today (today: thrown errors emit no record).
4. No tool is exempt from the timeout (120s default is generous vs the fast stub-model test calls; execute_code's internal 30s socket timeout fires first; Neo4j driver timeouts fire first). If a legitimately-long tool is found in review, add a per-tool override map — but v1 ships the uniform default.

## Self-review checks

1. **Spec coverage:** book Ch5 timeout (T1 ✓), Ch5 retry-classification + Ch5:186 fingerprint (T2+T3 ✓), Ch4 idempotency (existing — create_payment ticket pattern, not re-implemented). Ch2 compression LLM-tier explicitly deferred (user scope A). Ch6 eval explicitly deferred (separate analysis doc). ✓
2. **Placeholder scan:** no "TBD"/"handle edge cases"/"similar to" — each step has real code or real test assertions. The two "verify the exact SDK callback shape" notes are genuine known-unknowns the implementer resolves against the actual AI SDK 6 types (not placeholders — they name the contract that must hold).
3. **Type consistency:** `withToolTimeout(execute, timeoutMs, toolName?)` identical in test + impl + buildGatedTools call site. `classifyToolError(err): ClassifiedError` identical in module + test + withAudit call. `FailureTracker` extension (`recordToolCall`, `isLooping`) identical in impl + test + agent.ts usage. Structured-result shape `{status:'error', reason, ...}` consistent across T1 (tool_timeout) and T3 (tool_error).
