# Phase 3 — Model-facing Agent Status Bar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Inject a model-facing `<agent_status>` user-role message at the trajectory tail on every model call (code-maintained from in-memory harness state), and rename/optimize the existing human-facing frontend status widget so the two mechanisms are not conflated.

**Architecture:** A new pure module `agentStatus.ts` formats a snapshot into a delimited user-role `ModelMessage`. The harness aggregates the snapshot from existing sources (audit recorder for per-tool counts, sessionStore for pending approvals, documents/extractions tables for progress) and appends the status message to the `messages` array inside `runStream` immediately before `streamText`. Because the message is never written to session storage, "replace-per-turn" is automatic. The frontend changes are mechanical: rename the hook + component + type, slow the poll to 5s, and stop polling when no turn is active.

**Tech Stack:** TypeScript, AI SDK 6 (`ModelMessage` from `ai`), Hono backend, React 19 + Vite frontend, vitest, better-sqlite3 (default DB), oxlint.

## Global Constraints

- **AI SDK 6, not 5/7.** `runStream` calls `streamText({ model, system: SYSTEM_PROMPT, messages, tools, stopWhen, ... })`. `messages` is a `ModelMessage[]` already converted in the route layer via the async `convertToModelMessages`. The injected status message is `{ role: 'user', content: string }` (a valid `ModelMessage`). It MUST be `user` role (not `system`) so the constant `SYSTEM_PROMPT` prefix + conversation prefix stay cached (KV cache preserved).
- **Replace-per-turn is automatic.** The status message is appended to the per-turn `messages` array only; it is NOT persisted. Session storage (`appendMessages`) only stores `r.messages` (the real conversation). Do not persist the status message anywhere.
- **Concurrency.** Thread `sessionId` explicitly into `runStream` via `RunStreamOpts`. Do NOT read the ambient `getSessionContext()` inside `runStream` — it is a single-slot module variable, unsafe under concurrent requests.
- **Injection defense.** The status content is trusted (code-generated counts), but because it is a `user`-role message the model could misread as instruction, wrap it in `<agent_status>` delimiters with a fixed Chinese non-instruction preamble. This mirrors the existing `tagExternal` `<external_content>` posture.
- **No emoji** anywhere in code or comments (repo convention).
- **Backend = `apps/server/`; frontend = `apps/web/`.** The root `server/` directory is empty/stale — ignore it. A pre-existing `server/src/routes/chat.ts` LSP error is out of scope.
- **DB convention.** New repo read functions are SQLite-only: `if (ctx.backend === 'postgres') throw new Error('...: postgres backend not yet implemented')`. All reads use the userId 3-way OR legacy filter: `user_id = ? OR user_id = '' OR user_id IS NULL`, with `?` bound to `effectiveUserId(userId)`.
- **Verification order before claiming done:** build → lint → test (matches CI / AGENTS.md). Build is `npm run build` (both workspaces). Lint is `npm run lint` (oxlint). Tests are `npm test` (server vitest); set `OPENAI_API_KEY=ci-dummy-key` because `env.ts` zod-parses at import and unit tests never call the API.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `apps/server/src/harness/agentStatus.ts` (NEW) | Pure: `AgentStatusSnapshot` + `ToolCallCount` types; `formatAgentStatusBody`, `buildStatusMessage`, `appendStatusMessage` | T1 |
| `apps/server/test/harness/agentStatus.test.ts` (NEW) | Unit tests for the pure formatters | T1 |
| `apps/server/src/harness/statusAggregator.ts` (MODIFY) | Add `getToolCallCounts(sessionId, recorder?)` (model-facing per-tool counts, distinct from existing bySignal tally) | T2 |
| `apps/server/src/pipeline/db/repositories.ts` (MODIFY) | Add `countDocuments(ctx, userId?)` + `countExtractionsNeedingReview(ctx, userId?)` (raw SQL, pg-throws) | T2 |
| `apps/server/test/harness/statusAggregator.test.ts` (MODIFY) | Add `getToolCallCounts` cases | T2 |
| `apps/server/test/pipeline/db/repositories.test.ts` (MODIFY) | Add count cases with seeded rows | T2 |
| `apps/server/src/harness/agent.ts` (MODIFY) | Add `buildAgentStatusSnapshot` + `RunStreamOpts.sessionId?`; inject status message before `streamText` | T3 |
| `apps/server/src/routes/chat.ts` (MODIFY) | Pass `sessionId` into the `runStream` call | T3 |
| `apps/server/src/routes/approvalCallback.ts` (MODIFY) | Pass `sessionId` (+ owner `userId`) into the `runStream` call | T3 |
| `apps/server/test/harness/agentStatusInjection.test.ts` (NEW) | Unit test `buildAgentStatusSnapshot` aggregation | T3 |
| `apps/web/src/hooks/useAgentStatus.ts` → `useHumanAgentStatus.ts` (RENAME+MODIFY) | Rename; `POLL_INTERVAL_MS` 3000→5000; add `active?` param; stop polling when inactive | T4 |
| `apps/web/src/components/AgentStatusBar.tsx` → `HumanAgentStatusBar.tsx` (RENAME+MODIFY) | Rename component + props type | T4 |
| `apps/web/src/components/RealChatView.tsx` (MODIFY) | Update imports/usages; pass `active={isStreaming}` | T4 |

**Cross-task interface contract (memorize):**
- `AgentStatusSnapshot` (T1) = `{ toolCounts: ToolCallCount[]; totalCalls: number; pendingApprovals: number; docsIngested: number; extractionsPendingReview: number }`.
- `ToolCallCount` (T1) = `{ tool: string; count: number }`.
- `getToolCallCounts(sessionId, recorder?)` (T2) returns `ToolCallCount[]` — T3 imports it.
- `countDocuments(ctx, userId?)` / `countExtractionsNeedingReview(ctx, userId?)` (T2) return `number` — T3 imports them.
- `buildStatusMessage(snapshot)` / `appendStatusMessage(messages, snapshot|null)` (T1) return a `ModelMessage` / `ModelMessage[]` — T3 imports them.

---

### Task 1: Pure status formatter module

**Files:**
- Create: `apps/server/src/harness/agentStatus.ts`
- Test: `apps/server/test/harness/agentStatus.test.ts`

**Interfaces:**
- Produces: `ToolCallCount`, `AgentStatusSnapshot` (types); `formatAgentStatusBody(snapshot)`, `buildStatusMessage(snapshot)`, `appendStatusMessage(messages, snapshot)`.

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/harness/agentStatus.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  formatAgentStatusBody,
  buildStatusMessage,
  appendStatusMessage,
  type AgentStatusSnapshot,
} from '../../../src/harness/agentStatus';

const snapshot: AgentStatusSnapshot = {
  toolCounts: [
    { tool: 'ingest_document', count: 2 },
    { tool: 'extract_fields', count: 1 },
  ],
  totalCalls: 3,
  pendingApprovals: 1,
  docsIngested: 5,
  extractionsPendingReview: 2,
};

describe('formatAgentStatusBody', () => {
  it('renders each tool count in first-seen order with the total', () => {
    const body = formatAgentStatusBody(snapshot);
    expect(body).toContain('- ingest_document: 2');
    expect(body).toContain('- extract_fields: 1');
    expect(body).toContain('总计: 3 次');
    expect(body.indexOf('ingest_document')).toBeLessThan(body.indexOf('extract_fields'));
  });

  it('renders pending approvals, docs ingested, and pending review counts', () => {
    const body = formatAgentStatusBody(snapshot);
    expect(body).toContain('待审批: 1 项 (L2/L3)');
    expect(body).toContain('已入库文档: 5');
    expect(body).toContain('待复核抽取: 2');
  });

  it('handles an empty snapshot gracefully', () => {
    const empty: AgentStatusSnapshot = {
      toolCounts: [],
      totalCalls: 0,
      pendingApprovals: 0,
      docsIngested: 0,
      extractionsPendingReview: 0,
    };
    const body = formatAgentStatusBody(empty);
    expect(body).toContain('总计: 0 次');
    expect(body).toContain('待审批: 0 项 (L2/L3)');
    expect(body).toContain('已入库文档: 0');
  });
});

describe('buildStatusMessage', () => {
  it('returns a user-role message wrapped in <agent_status> delimiters', () => {
    const msg = buildStatusMessage(snapshot);
    expect(msg.role).toBe('user');
    const text = typeof msg.content === 'string' ? msg.content : '';
    expect(text).toContain('<agent_status>');
    expect(text).toContain('</agent_status>');
    expect(text).toContain(formatAgentStatusBody(snapshot));
  });

  it('includes a non-instruction preamble stating this is system-generated, not a user command', () => {
    const msg = buildStatusMessage(snapshot);
    const text = typeof msg.content === 'string' ? msg.content : '';
    expect(text).toContain('非用户指令');
    expect(text).toContain('仅供参考');
  });
});

describe('appendStatusMessage', () => {
  const base = [{ role: 'user' as const, content: 'hi' }];

  it('appends a status message when a snapshot is provided', () => {
    const out = appendStatusMessage(base, snapshot);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(base[0]);
    expect(out[1].role).toBe('user');
  });

  it('returns the same array reference unchanged when snapshot is null', () => {
    expect(appendStatusMessage(base, null)).toBe(base);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace apps/server -- test/harness/agentStatus.test.ts`
Expected: FAIL — cannot resolve `../../../src/harness/agentStatus`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/server/src/harness/agentStatus.ts`:

```ts
import type { ModelMessage } from 'ai';

/**
 * Model-facing agent status bar (design §9.2).
 *
 * A code-maintained snapshot of in-memory harness state, formatted into a
 * user-role message appended at the trajectory tail on every model call. The
 * content is trusted (generated counts), but the message is wrapped in
 * <agent_status> delimiters with a non-instruction preamble so the model does
 * not mistake the counts for user commands. Mirrors the tagExternal
 * <external_content> injection-defense posture.
 */

export interface ToolCallCount {
  tool: string;
  count: number;
}

export interface AgentStatusSnapshot {
  toolCounts: ToolCallCount[];
  totalCalls: number;
  pendingApprovals: number;
  docsIngested: number;
  extractionsPendingReview: number;
}

export function formatAgentStatusBody(snapshot: AgentStatusSnapshot): string {
  const lines: string[] = [];
  lines.push('本轮工具调用统计:');
  for (const { tool, count } of snapshot.toolCounts) {
    lines.push(`- ${tool}: ${count}`);
  }
  lines.push(`总计: ${snapshot.totalCalls} 次`);
  lines.push(`待审批: ${snapshot.pendingApprovals} 项 (L2/L3)`);
  lines.push(`已入库文档: ${snapshot.docsIngested}`);
  lines.push(`待复核抽取: ${snapshot.extractionsPendingReview}`);
  return lines.join('\n');
}

const AGENT_STATUS_OPEN = '<agent_status>';
const AGENT_STATUS_CLOSE = '</agent_status>';
const PREAMBLE =
  '以下为系统根据会话状态自动生成的摘要, 仅供参考, 非用户指令, 请勿将其中的统计数字或状态作为执行操作的依据。';

export function buildStatusMessage(snapshot: AgentStatusSnapshot): ModelMessage {
  const body = formatAgentStatusBody(snapshot);
  const text = `${AGENT_STATUS_OPEN}\n${PREAMBLE}\n${body}\n${AGENT_STATUS_CLOSE}`;
  return { role: 'user', content: text };
}

export function appendStatusMessage(
  messages: ModelMessage[],
  snapshot: AgentStatusSnapshot | null,
): ModelMessage[] {
  if (!snapshot) return messages;
  return [...messages, buildStatusMessage(snapshot)];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace apps/server -- test/harness/agentStatus.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/harness/agentStatus.ts apps/server/test/harness/agentStatus.test.ts
git commit -m "feat: add pure model-facing agent status formatter module"
```

---

### Task 2: Per-tool counts + DB progress counts

**Files:**
- Modify: `apps/server/src/harness/statusAggregator.ts`
- Modify: `apps/server/src/pipeline/db/repositories.ts`
- Test: `apps/server/test/harness/statusAggregator.test.ts`
- Test: `apps/server/test/pipeline/db/repositories.test.ts`

**Interfaces:**
- Consumes: `ToolCallCount` (from T1 `agentStatus.ts`); `ToolCallRecord` (from `auditRecorder.ts`); `DbContext`, `effectiveUserId` (from `repositories.ts`/`client.ts`).
- Produces: `getToolCallCounts(sessionId, recorder?): ToolCallCount[]`; `countDocuments(ctx, userId?): number`; `countExtractionsNeedingReview(ctx, userId?): number`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/server/test/harness/statusAggregator.test.ts` (inside a new `describe` block; reuse the existing file's imports/vitest setup):

```ts
import { getToolCallCounts } from '../../../src/harness/statusAggregator';
import type { ToolCallRecord } from '../../../src/harness/auditRecorder';

const rec: ToolCallRecord[] = [
  { toolName: 'ingest_document', args: {}, result: {}, durationMs: 10, timestamp: '2026-08-12T00:00:00Z', sessionId: 's1' },
  { toolName: 'extract_fields', args: {}, result: {}, durationMs: 5, timestamp: '2026-08-12T00:00:01Z', sessionId: 's1' },
  { toolName: 'ingest_document', args: {}, result: {}, durationMs: 8, timestamp: '2026-08-12T00:00:02Z', sessionId: 's1' },
  { toolName: 'recall_documents', args: {}, result: {}, durationMs: 3, timestamp: '2026-08-12T00:00:03Z', sessionId: 's2' },
];

describe('getToolCallCounts', () => {
  it('groups tool calls by toolName in first-seen order, scoped by session', () => {
    expect(getToolCallCounts('s1', { records: rec })).toEqual([
      { tool: 'ingest_document', count: 2 },
      { tool: 'extract_fields', count: 1 },
    ]);
  });

  it('ignores records from other sessions', () => {
    expect(getToolCallCounts('s2', { records: rec })).toEqual([
      { tool: 'recall_documents', count: 1 },
    ]);
  });

  it('returns an empty array for an unknown session', () => {
    expect(getToolCallCounts('unknown', { records: rec })).toEqual([]);
  });
});
```

Append to `apps/server/test/pipeline/db/repositories.test.ts` (new `describe`; follow the existing file's `beforeEach` DB setup — `createDb(':memory:')` + `migrate(ctx.sqlite)` — or use the self-contained seeding below):

```ts
import { createDb, migrate } from '../../../../src/pipeline/db/client';
import { countDocuments, countExtractionsNeedingReview } from '../../../../src/pipeline/db/repositories';
import type { DbContext } from '../../../../src/pipeline/db/client';

describe('countDocuments / countExtractionsNeedingReview', () => {
  let ctx: DbContext;
  beforeEach(() => {
    ctx = createDb(':memory:');
    migrate(ctx.sqlite);
    ctx.sqlite
      .prepare(
        "INSERT INTO documents (id, doc_type, modality, source_uri, block_model, user_id, created_at) VALUES ('d1','合同','digital','s','{}','alice',datetime('now'))",
      )
      .run();
    ctx.sqlite
      .prepare(
        "INSERT INTO documents (id, doc_type, modality, source_uri, block_model, user_id, created_at) VALUES ('d2','发票','digital','s','{}','',datetime('now'))",
      )
      .run();
    ctx.sqlite
      .prepare(
        "INSERT INTO extractions (id, document_id, doc_type, fields, field_meta, overall_confidence, needs_review, user_id, created_at) VALUES ('e1','d1','合同','[]','{}',0.8,1,'alice',datetime('now'))",
      )
      .run();
    ctx.sqlite
      .prepare(
        "INSERT INTO extractions (id, document_id, doc_type, fields, field_meta, overall_confidence, needs_review, user_id, created_at) VALUES ('e2','d2','发票','[]','{}',0.9,0,'',datetime('now'))",
      )
      .run();
  });

  it('counts documents scoped by userId plus legacy rows', () => {
    expect(countDocuments(ctx, 'alice')).toBe(2); // d1 (alice) + d2 (legacy '')
  });

  it('counts extractions needing review scoped by userId plus legacy rows', () => {
    expect(countExtractionsNeedingReview(ctx, 'alice')).toBe(1); // only e1 (needs_review=1)
  });

  it('with no userId counts only legacy rows', () => {
    expect(countDocuments(ctx)).toBe(1); // only d2 (user_id='')
    expect(countExtractionsNeedingReview(ctx)).toBe(0); // e2 legacy but needs_review=0
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test --workspace apps/server -- test/harness/statusAggregator.test.ts test/pipeline/db/repositories.test.ts`
Expected: FAIL — `getToolCallCounts`, `countDocuments`, `countExtractionsNeedingReview` are not exported.

- [ ] **Step 3: Implement `getToolCallCounts`**

In `apps/server/src/harness/statusAggregator.ts`, add an import of `ToolCallCount` from `./agentStatus` and of `ToolCallRecord` from `./auditRecorder` (if not already imported), then add:

```ts
export function getToolCallCounts(
  sessionId: string,
  recorder: { records: ToolCallRecord[] } = auditRecorder,
): ToolCallCount[] {
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const r of recorder.records) {
    if (r.sessionId !== sessionId) continue;
    if (!counts.has(r.toolName)) order.push(r.toolName);
    counts.set(r.toolName, (counts.get(r.toolName) ?? 0) + 1);
  }
  return order.map((tool) => ({ tool, count: counts.get(tool) as number }));
}
```

- [ ] **Step 4: Implement the repository counts**

In `apps/server/src/pipeline/db/repositories.ts`, add (near the sibling SQLite reader functions; reuse the existing `effectiveUserId` helper):

```ts
export function countDocuments(ctx: DbContext, userId?: string): number {
  if (ctx.backend === 'postgres') {
    throw new Error('countDocuments: postgres backend not yet implemented');
  }
  const uid = effectiveUserId(userId);
  const row = ctx.sqlite
    .prepare(
      "SELECT COUNT(*) AS n FROM documents WHERE user_id = ? OR user_id = '' OR user_id IS NULL",
    )
    .get(uid) as { n: number } | undefined;
  return row?.n ?? 0;
}

export function countExtractionsNeedingReview(ctx: DbContext, userId?: string): number {
  if (ctx.backend === 'postgres') {
    throw new Error('countExtractionsNeedingReview: postgres backend not yet implemented');
  }
  const uid = effectiveUserId(userId);
  const row = ctx.sqlite
    .prepare(
      "SELECT COUNT(*) AS n FROM extractions WHERE needs_review = 1 AND (user_id = ? OR user_id = '' OR user_id IS NULL)",
    )
    .get(uid) as { n: number } | undefined;
  return row?.n ?? 0;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test --workspace apps/server -- test/harness/statusAggregator.test.ts test/pipeline/db/repositories.test.ts`
Expected: PASS — all new cases green, no regressions in the existing cases of either file.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/harness/statusAggregator.ts apps/server/src/pipeline/db/repositories.ts \
        apps/server/test/harness/statusAggregator.test.ts apps/server/test/pipeline/db/repositories.test.ts
git commit -m "feat: add per-tool counts and document/extraction progress counts"
```

---

### Task 3: Wire the status snapshot into `runStream`

**Files:**
- Modify: `apps/server/src/harness/agent.ts`
- Modify: `apps/server/src/routes/chat.ts`
- Modify: `apps/server/src/routes/approvalCallback.ts`
- Test: `apps/server/test/harness/agentStatusInjection.test.ts`

**Interfaces:**
- Consumes: `buildStatusMessage`/`appendStatusMessage`/`AgentStatusSnapshot` (T1); `getToolCallCounts` (T2); `countDocuments`/`countExtractionsNeedingReview` (T2); `countPendingApprovals` (existing, from `./sessionStore`); `auditRecorder` (existing); `DbContext`/`getHarnessDbContext` (existing).
- Produces: `buildAgentStatusSnapshot({ sessionId, userId, ctx, recorder? }): AgentStatusSnapshot`; `RunStreamOpts` gains `sessionId?: string`.

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/harness/agentStatusInjection.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createDb, migrate } from '../../../src/pipeline/db/client';
import type { DbContext } from '../../../src/pipeline/db/client';
import { buildAgentStatusSnapshot } from '../../../src/harness/agent';
import type { ToolCallRecord } from '../../../src/harness/auditRecorder';

describe('buildAgentStatusSnapshot', () => {
  let ctx: DbContext;
  beforeEach(() => {
    ctx = createDb(':memory:');
    migrate(ctx.sqlite);
    ctx.sqlite
      .prepare(
        "INSERT INTO documents (id, doc_type, modality, source_uri, block_model, user_id, created_at) VALUES ('d1','合同','digital','s','{}','alice',datetime('now'))",
      )
      .run();
    ctx.sqlite
      .prepare(
        "INSERT INTO extractions (id, document_id, doc_type, fields, field_meta, overall_confidence, needs_review, user_id, created_at) VALUES ('e1','d1','合同','[]','{}',0.8,1,'alice',datetime('now'))",
      )
      .run();
  });

  it('aggregates per-tool counts, pending approvals, and DB progress counts', () => {
    const records: ToolCallRecord[] = [
      { toolName: 'ingest_document', args: {}, result: {}, durationMs: 1, timestamp: 't', sessionId: 's1' },
      { toolName: 'ingest_document', args: {}, result: {}, durationMs: 1, timestamp: 't', sessionId: 's1' },
    ];
    const snap = buildAgentStatusSnapshot({ sessionId: 's1', userId: 'alice', ctx, recorder: { records } });
    expect(snap.toolCounts).toEqual([{ tool: 'ingest_document', count: 2 }]);
    expect(snap.totalCalls).toBe(2);
    expect(snap.docsIngested).toBe(1);
    expect(snap.extractionsPendingReview).toBe(1);
  });

  it('reports zero pending approvals for an unknown session', () => {
    const snap = buildAgentStatusSnapshot({
      sessionId: 'never-existed',
      userId: 'alice',
      ctx,
      recorder: { records: [] },
    });
    expect(snap.pendingApprovals).toBe(0);
    expect(snap.totalCalls).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace apps/server -- test/harness/agentStatusInjection.test.ts`
Expected: FAIL — `buildAgentStatusSnapshot` is not exported from `agent.ts`.

- [ ] **Step 3: Add the snapshot builder + `sessionId` to `RunStreamOpts` + inject the message**

In `apps/server/src/harness/agent.ts`:

(a) Add imports near the existing harness imports:
```ts
import { appendStatusMessage, type AgentStatusSnapshot } from './agentStatus';
import { getToolCallCounts } from './statusAggregator';
import { countPendingApprovals } from './sessionStore';
import { countDocuments, countExtractionsNeedingReview } from '../pipeline/db/repositories';
```

(b) Add the snapshot builder (place it above `runStream`):
```ts
export interface BuildAgentStatusSnapshotOpts {
  sessionId: string;
  userId?: string;
  ctx: DbContext;
  recorder?: { records: import('./auditRecorder').ToolCallRecord[] };
}

export function buildAgentStatusSnapshot({
  sessionId,
  userId,
  ctx,
  recorder = auditRecorder,
}: BuildAgentStatusSnapshotOpts): AgentStatusSnapshot {
  const toolCounts = getToolCallCounts(sessionId, recorder);
  const totalCalls = toolCounts.reduce((sum, t) => sum + t.count, 0);
  return {
    toolCounts,
    totalCalls,
    pendingApprovals: countPendingApprovals(sessionId),
    docsIngested: countDocuments(ctx, userId),
    extractionsPendingReview: countExtractionsNeedingReview(ctx, userId),
  };
}
```
(If `DbContext` is not already imported in `agent.ts`, import it from `../pipeline/db/client` alongside the existing `getHarnessDbContext` usage; `getHarnessDbContext()` already returns it so the type is in scope — use whichever import shape the file already has.)

(c) Add `sessionId?: string` to the `RunStreamOpts` interface.

(d) Inside `runStream`, refactor the tools+deps line and inject the status message before `streamText`. Replace the existing single `const tools = buildGatedTools(role, deps ?? { ctx: getHarnessDbContext(), ... })` line with:
```ts
const harnessDeps = deps ?? {
  ctx: getHarnessDbContext(),
  extraction: { model: resolvedModel },
  classifier: { model: resolvedModel },
  embedder: defaultEmbedder(),
  userId,
};
const ctx = harnessDeps.ctx;
const tools = buildGatedTools(role, harnessDeps);
```
(Preserve the exact existing default-deps field names — `extraction`/`classifier`/`embedder`/`userId`; only extract `ctx` into its own binding. If `defaultEmbedder` is imported differently in the current file, keep the existing spelling.)

Then, immediately before the `streamText({...})` call, build the per-turn messages:
```ts
const snapshot = sessionId ? buildAgentStatusSnapshot({ sessionId, userId, ctx }) : null;
const messagesForModel = appendStatusMessage(messages, snapshot);
```
and change the `streamText` argument from `messages,` to `messages: messagesForModel,`. Leave `system: SYSTEM_PROMPT`, `tools`, `stopWhen`, `experimental_telemetry`, `prepareStep`, and `experimental_onToolCallFinish` exactly as they are.

- [ ] **Step 4: Pass `sessionId` from both callers**

In `apps/server/src/routes/chat.ts`, add `sessionId` to the `runStream({...})` call (sessionId is already in scope at that point):
```ts
runStream({ messages: streamMessages, role: agentRole, auditTraceId, sessionId, userId: userId ?? undefined });
```

In `apps/server/src/routes/approvalCallback.ts`, `resumeSession` receives `sessionId` as its parameter; pass it into `runStream` along with the session owner's userId:
```ts
runStream({ messages, role, auditTraceId, sessionId, userId });
```
(Load the owner userId from `sessionStore.loadSession(sessionId)` if that row carries it; if the session row has no userId field, pass `userId: undefined` — unscoped counts. Preserve the existing `runStream` option spellings; only add the two fields.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test --workspace apps/server -- test/harness/agentStatusInjection.test.ts test/harness/agentStatus.test.ts`
Expected: PASS. Then run the full server suite to confirm no regressions:
Run: `OPENAI_API_KEY=ci-dummy-key npm test`
Expected: all green (prior count + the new cases).

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/harness/agent.ts apps/server/src/routes/chat.ts apps/server/src/routes/approvalCallback.ts \
        apps/server/test/harness/agentStatusInjection.test.ts
git commit -m "feat: inject model-facing <agent_status> message at trajectory tail"
```

---

### Task 4: Frontend widget rename + poll optimization

**Files:**
- Rename + Modify: `apps/web/src/hooks/useAgentStatus.ts` → `apps/web/src/hooks/useHumanAgentStatus.ts`
- Rename + Modify: `apps/web/src/components/AgentStatusBar.tsx` → `apps/web/src/components/HumanAgentStatusBar.tsx`
- Modify: `apps/web/src/components/RealChatView.tsx`

**Interfaces:**
- Consumes: the existing `/api/sessions/:id/status` endpoint and `AgentStatus` JSON shape (UNCHANGED — server-side untouched).
- Produces: `useHumanAgentStatus(sessionId, active?)` + `HumanAgentStatusBar` component + `HumanAgentStatusState` type.

**Note on testing:** there is no frontend test runner in this repo; verification for this task is `npm run build` (tsc + vite) and `npm run lint`. The changes are mechanical (rename + one constant + one gating param) and the server-side status shape is unchanged.

- [ ] **Step 1: Rename the hook and change its internals**

Rename `apps/web/src/hooks/useAgentStatus.ts` to `apps/web/src/hooks/useHumanAgentStatus.ts`. Inside it:
- Rename the exported type `AgentStatusState` → `HumanAgentStatusState`.
- Rename the exported function `useAgentStatus` → `useHumanAgentStatus`.
- Change `const POLL_INTERVAL_MS = 3000` → `const POLL_INTERVAL_MS = 5000`.
- Add an optional second parameter `active = true` and treat `(!sessionId || !active)` as the idle/stop-polling condition (do not fetch and do not re-arm the interval when inactive). Keep the existing `sessionId` null → idle behavior.

```ts
export function useHumanAgentStatus(
  sessionId: string | null,
  active = true,
): HumanAgentStatusState {
  // existing implementation, but gate the fetch + interval on (sessionId && active)
  // ...
}
```

- [ ] **Step 2: Rename the component**

Rename `apps/web/src/components/AgentStatusBar.tsx` to `apps/web/src/components/HumanAgentStatusBar.tsx`. Inside it:
- Rename the exported component `AgentStatusBar` → `HumanAgentStatusBar`.
- Rename the props type `AgentStatusBarProps` → `HumanAgentStatusBarProps`, and change its `status` field type from `AgentStatusState` to `HumanAgentStatusState` (imported from the renamed hook).
- Update the internal import `from '../hooks/useAgentStatus'` → `from '../hooks/useHumanAgentStatus'`.
- Keep all rendering logic (totalCalls / bySignal labels / last tool / pending-approvals badge / idle-error labels) byte-for-byte unchanged.

- [ ] **Step 3: Update the call site**

In `apps/web/src/components/RealChatView.tsx`:
- Update imports: `useAgentStatus` → `useHumanAgentStatus` (from `'../hooks/useHumanAgentStatus'`); `AgentStatusBar` → `HumanAgentStatusBar` (from `'../components/HumanAgentStatusBar'`).
- Change the hook call to pass the active-turn signal (the file already computes `isStreaming = status === 'submitted' || status === 'streaming'` from `useChat`):
```ts
const agentStatus = useHumanAgentStatus(liveSessionId, isStreaming);
```
- Change the JSX usage:
```tsx
<HumanAgentStatusBar sessionId={liveSessionId} status={agentStatus} />
```

- [ ] **Step 4: Build + lint to verify**

Run: `npm run build`
Expected: both workspaces build (web `tsc -b && vite build`, server `tsc`); no new type errors from the rename.

Run: `npm run lint`
Expected: exit 0; no new warnings (the rename must not leave any dangling `useAgentStatus`/`AgentStatusBar` references).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/hooks/useHumanAgentStatus.ts apps/web/src/components/HumanAgentStatusBar.tsx \
        apps/web/src/components/RealChatView.tsx
git rm apps/web/src/hooks/useAgentStatus.ts apps/web/src/components/AgentStatusBar.tsx
git commit -m "feat: rename human status widget + slow poll to 5s + stop when turn inactive"
```

---

## Final verification

After all four tasks land, in this order (AGENTS.md):

- [ ] **Build:** `npm run build` — both workspaces succeed.
- [ ] **Lint:** `npm run lint` — exit 0; no new warnings beyond the pre-existing 4 unused-vars (documentEntry.ts:3 randomUUID, eval/run.ts require, postgres-repositories.ts DocType + SpanMatchStrength).
- [ ] **Test:** `OPENAI_API_KEY=ci-dummy-key npm test` — full server suite green (prior 125 passed | 11 skipped, plus the new harness/repositories cases).

## Notes / out-of-scope (do not implement in Phase 3)

- **entities-created count** is intentionally omitted — the entities/graph layer does not exist yet (Phase 4 = §7). The snapshot has no `entitiesCreated` field.
- **Validation-classify** (§6 optional, post-extract) is not part of §9.
- **L2 approval lag:** approvals are recorded post-stream, so a pre-stream status message can only report prior-turn pending approvals. This is inherent and acceptable; do not try to make the current turn's L2 approvals visible to the current turn's model.
- **Per-turn (not per-session) tool counts** would require adding a `traceId` to `ToolCallRecord`; the design only requires "from the withAudit log," so session-scoped counts suffice. Leave the audit record shape unchanged.
