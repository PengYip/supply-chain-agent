# Event Persistence + Reconnect Replay Implementation Plan (Phase 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist session events with a monotonic per-session seq and replay the gap on SSE reconnect (`Last-Event-ID`), so a reconnecting client observes every part of an in-flight run exactly once, in order.

**Architecture:** `sessionEvents.emit()` becomes the single write-through seam (persist to new SQLite `session_events` table, then fan out with the assigned seq). The SSE route forwards events with `id: <seq>` lines and, on reconnect with `Last-Event-ID`, replays the persisted gap before flipping to live forwarding. `runManager` prunes the session's events when the run finalizes. Frontend needs only a reconnect reconciliation nudge.

**Tech Stack:** Node 20, Hono 4, better-sqlite3 (sync, WAL), native EventSource, vitest.

**Spec:** `docs/superpowers/specs/2026-08-16-event-persistence-replay-design.md` (29b3326)

## Global Constraints

- Work only in worktree `D:\Users\yepeng\supply-chain-bg-runtime`, branch `feat/event-persistence` (already checked out, base c15628e).
- AI SDK 6 (ai@6.0.246) — not v5/v7.
- No emoji in code.
- Focused test: `npm test --workspace apps/server -- test/harness/<file>`; CI-equivalent full: `DATABASE_URL= npm test --workspace apps/server`.
- Required order before claiming done: `npm run build` → `npm run lint` → tests.
- Lint baseline: pre-existing warnings only (currently 4: eval/agent/driver.ts:140, src/pipeline/db/postgres-repositories.ts:20, test/routes/evalRunCore.test.ts:42+83) — no NEW warnings from your change.
- The tests share the file DB `data/agent.db` (not isolated) — use unique session ids per test via a `uid()` helper; do NOT rely on table emptiness.
- Commit ONLY the files your task lists. Never `git add -A`.
- `session_messages` remains the history SSOT; `session_events` is a replay buffer (no FK on session_id by design).
- Frontend has no test framework — verification = `npm run build` + `npm run lint` + targeted grep.

---

### Task 1: `session_events` table + store functions

**Files:**
- Modify: `apps/server/src/harness/sessionStore.ts` (DDL block at lines 22-59; new functions near `appendMessages` at line 366)
- Test: `apps/server/test/harness/sessionEventsStore.test.ts` (new)

**Interfaces:**
- Produces (later tasks rely on these exact signatures):
  - `appendSessionEvent(sessionId: string, type: string, payload: Record<string, unknown>): number` — assigns and returns seq
  - `listSessionEventsSince(sessionId: string, sinceSeq: number): Array<{ seq: number; type: string; payload: Record<string, unknown> }>` — exclusive lower bound, ascending seq
  - `pruneSessionEvents(sessionId: string): void`

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/test/harness/sessionEventsStore.test.ts
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  appendSessionEvent,
  listSessionEventsSince,
  pruneSessionEvents,
} from '../src/harness/sessionStore.js';

const uid = () => `ev-store-${randomUUID().slice(0, 8)}`;

describe('session_events store', () => {
  it('assigns monotonically increasing seq starting at 1, per session', () => {
    const sid = uid();
    const s1 = appendSessionEvent(sid, 'run.started', { sessionId: sid, runId: 'r1' });
    const s2 = appendSessionEvent(sid, 'message.part', { sessionId: sid, part: { type: 'text-start' } });
    expect(s1).toBe(1);
    expect(s2).toBe(2);
  });

  it('independent sessions have independent seq counters', () => {
    const a = uid();
    const b = uid();
    appendSessionEvent(a, 'x', {});
    expect(appendSessionEvent(b, 'x', {})).toBe(1);
    expect(appendSessionEvent(a, 'x', {})).toBe(2);
  });

  it('listSessionEventsSince returns rows with seq > sinceSeq in ascending order', () => {
    const sid = uid();
    appendSessionEvent(sid, 'e1', { n: 1 });
    appendSessionEvent(sid, 'e2', { n: 2 });
    appendSessionEvent(sid, 'e3', { n: 3 });
    const rows = listSessionEventsSince(sid, 1);
    expect(rows.map((r) => r.type)).toEqual(['e2', 'e3']);
    expect(rows[0].payload).toEqual({ n: 2 });
  });

  it('listSessionEventsSince on empty/unknown session returns []', () => {
    expect(listSessionEventsSince(uid(), 0)).toEqual([]);
  });

  it('pruneSessionEvents clears all rows for the session only', () => {
    const a = uid();
    const b = uid();
    appendSessionEvent(a, 'e', {});
    appendSessionEvent(b, 'e', {});
    pruneSessionEvents(a);
    expect(listSessionEventsSince(a, 0)).toEqual([]);
    expect(listSessionEventsSince(b, 0).length).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace apps/server -- test/harness/sessionEventsStore.test.ts`
Expected: FAIL — the three functions are not exported (`is not a function`).

- [ ] **Step 3: Write minimal implementation**

In `sessionStore.ts`, add to the existing `db.exec(\`...\`)` DDL block, right after the `authorized_tickets` table (line 58, before the closing backtick):

```sql
CREATE TABLE IF NOT EXISTS session_events (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
);
```

(No FOREIGN KEY — this table is a transient replay buffer; emit call sites may reference session ids without a backing `sessions` row.)

Add near `appendMessages` (mirror its seq-allocation style; note events start at 1, messages at 0 — both via COALESCE):

```ts
// --- session event replay buffer (phase 2) ---
// Events are a reconnect replay buffer, not SSOT (session_messages is).
// No FK on session_id: buffer writes must not fail for sessions without a
// backing row (tests, degraded modes).

export interface SessionEventRow {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
}

export function appendSessionEvent(sessionId: string, type: string, payload: Record<string, unknown>): number {
  const row = db
    .prepare('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM session_events WHERE session_id = ?')
    .get(sessionId) as { max_seq: number };
  const seq = row.max_seq + 1;
  db.prepare(
    'INSERT INTO session_events (session_id, seq, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(sessionId, seq, type, JSON.stringify(payload), new Date().toISOString());
  return seq;
}

export function listSessionEventsSince(sessionId: string, sinceSeq: number): SessionEventRow[] {
  const rows = db
    .prepare('SELECT seq, type, payload_json FROM session_events WHERE session_id = ? AND seq > ? ORDER BY seq ASC')
    .all(sessionId, sinceSeq) as Array<{ seq: number; type: string; payload_json: string }>;
  return rows.map((r) => ({ seq: r.seq, type: r.type, payload: JSON.parse(r.payload_json) as Record<string, unknown> }));
}

export function pruneSessionEvents(sessionId: string): void {
  db.prepare('DELETE FROM session_events WHERE session_id = ?').run(sessionId);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace apps/server -- test/harness/sessionEventsStore.test.ts`
Expected: PASS 5/5.

- [ ] **Step 5: Regression + build + lint, then commit**

Run: `DATABASE_URL= npm test --workspace apps/server` (expect 72 files all green, count 403+18 skipped + 5 new), `npm run build`, `npm run lint` (baseline only).

```bash
git add apps/server/src/harness/sessionStore.ts apps/server/test/harness/sessionEventsStore.test.ts
git commit -m "feat(server): session_events replay buffer table and store functions"
```

---

### Task 2: `emit()` write-through — persist then fan out with seq

**Files:**
- Modify: `apps/server/src/harness/sessionEvents.ts` (38 lines, full rewrite of `emit` + type)
- Test: `apps/server/test/harness/sessionEvents.persist.test.ts` (new); possibly adjust `apps/server/test/harness/sessionEvents.test.ts` (phase-1 file)

**Interfaces:**
- Consumes: `appendSessionEvent(sessionId, type, payload): number` from Task 1.
- Produces: `SessionEvent` gains `seq?: number`; every event delivered to subscribers carries `seq` (when persistence succeeds). Emitted events are persisted regardless of subscriber count (this is the whole point — events emitted while nobody is listening must be replayable).

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/test/harness/sessionEvents.persist.test.ts
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listSessionEventsSince } from '../src/harness/sessionStore.js';
import { emit, subscribe } from '../src/harness/sessionEvents.js';

const uid = () => `ev-persist-${randomUUID().slice(0, 8)}`;

describe('emit write-through', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('persists every emit and delivers seq to subscribers', () => {
    const sid = uid();
    const seen: Array<{ type: string; seq?: number }> = [];
    const unsub = subscribe(sid, (e) => seen.push({ type: e.type, seq: e.seq }));
    emit({ type: 'run.started', sessionId: sid, runId: 'r1' });
    emit({ type: 'message.part', sessionId: sid, part: { type: 'text-start', id: 't1' } });
    unsub();
    expect(seen.length).toBe(2);
    expect(seen[0].seq).toBe(1);
    expect(seen[1].seq).toBe(2);
    const rows = listSessionEventsSince(sid, 0);
    expect(rows.map((r) => r.type)).toEqual(['run.started', 'message.part']);
    expect(rows[1].payload.part).toEqual({ type: 'text-start', id: 't1' });
  });

  it('persists even with zero subscribers (replay buffer must capture the gap)', () => {
    const sid = uid();
    emit({ type: 'run.started', sessionId: sid, runId: 'r2' });
    expect(listSessionEventsSince(sid, 0).length).toBe(1);
  });

  it('persistence failure degrades gracefully: subscriber still receives the event, without seq', async () => {
    vi.doMock('../src/harness/sessionStore.js', () => ({
      appendSessionEvent: () => {
        throw new Error('table missing');
      },
    }));
    const { emit: emitMocked } = await import('../src/harness/sessionEvents.js');
    const sid = uid();
    const seen: Array<Record<string, unknown>> = [];
    const unsub = subscribe(sid, (e) => seen.push(e as Record<string, unknown>));
    emitMocked({ type: 'run.started', sessionId: sid, runId: 'r3' });
    unsub();
    expect(seen.length).toBe(1);
    expect(seen[0].seq).toBeUndefined();
    vi.doUnmock('../src/harness/sessionStore.js');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace apps/server -- test/harness/sessionEvents.persist.test.ts`
Expected: FAIL — `e.seq` is undefined (emit does not persist), and nothing lands in `listSessionEventsSince`.

- [ ] **Step 3: Rewrite `sessionEvents.ts`**

```ts
// Session event bus with write-through persistence (phase 2).
// emit() assigns a monotonic per-session seq by persisting to the
// session_events replay buffer first, then fans out to live subscribers.
// The buffer only needs to outlive in-flight runs: runManager prunes it
// when the run finalizes (snapshot path covers completed runs).

import { appendSessionEvent } from './sessionStore.js';

export type SessionEvent = { type: string; sessionId: string; seq?: number; [key: string]: unknown };

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
  // Persist first (even with zero subscribers — the replay buffer must
  // capture events emitted while nobody is listening), best-effort: a
  // persistence failure (e.g. Postgres backend without the table) must not
  // drop the live event.
  let seq: number | undefined;
  try {
    seq = appendSessionEvent(event.sessionId, event.type, event as Record<string, unknown>);
  } catch (err) {
    console.error('[sessionEvents] persist failed:', err instanceof Error ? err.message : err);
  }
  const withSeq: SessionEvent = seq === undefined ? event : { ...event, seq };
  const set = subscribers.get(event.sessionId);
  if (!set) return;
  for (const fn of set) {
    try {
      fn(withSeq);
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

Import direction: `sessionEvents.ts` → `sessionStore.ts`. sessionStore imports nothing from the event layer — no cycle.

- [ ] **Step 4: Run tests to verify pass; fix phase-1 assertions if exact-equality broke**

Run: `npm test --workspace apps/server -- test/harness/sessionEvents.persist.test.ts test/harness/sessionEvents.test.ts`

If phase-1 `sessionEvents.test.ts` assertions use exact `toEqual` on the delivered event object, they will now see an extra `seq` field. Fix by asserting fields individually or `objectContaining` — do NOT weaken what is asserted beyond tolerating `seq`.

Also run `DATABASE_URL= npm test --workspace apps/server` — any other suite doing exact event-shape asserts (e.g. `sseEvents.test.ts`, `backgroundRuntime.integration.test.ts`) may need the same tolerance fix. Report every file you touched for this.

- [ ] **Step 5: Build + lint, then commit**

```bash
git add apps/server/src/harness/sessionEvents.ts apps/server/test/harness/sessionEvents.persist.test.ts
# plus any assertion-tolerance files from Step 4
git commit -m "feat(server): sessionEvents emit writes through to replay buffer with seq"
```

---

### Task 3: runManager prunes the replay buffer on run finalization

**Files:**
- Modify: `apps/server/src/harness/runManager.ts` (import line 8; `finally` block lines 55-59)
- Test: `apps/server/test/harness/runManager.test.ts` (append one case)

**Interfaces:**
- Consumes: `pruneSessionEvents(sessionId: string): void` from Task 1.
- Produces: no new exports. Behavior: after a run finalizes (any of finished/aborted/error), `session_events` rows for that session are gone.

- [ ] **Step 1: Write the failing test** (append to existing `runManager.test.ts`; follow its existing setup/uid conventions)

```ts
it('prunes the session_events replay buffer when the run finalizes', async () => {
  const sid = `rm-prune-${crypto.randomUUID().slice(0, 8)}`;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const start = startSessionRun(sid, 'u1', 'trader', async () => {
    await gate;
  });
  expect(start).not.toHaveProperty('conflict');
  // events emitted while the run is in flight are buffered
  emit({ type: 'message.part', sessionId: sid, part: { type: 'text-start', id: 't' } });
  expect(listSessionEventsSince(sid, 0).length).toBeGreaterThan(0);
  release();
  await waitForRunToFinalize(); // use the file's existing settle helper (e.g. polling isRunning(sid) === false, or awaiting the handle promise if exposed)
  expect(listSessionEventsSince(sid, 0)).toEqual([]);
});
```

Imports to add to the test file: `emit` from `../src/harness/sessionEvents.js`, `listSessionEventsSince` from `../src/harness/sessionStore.js`. Use the settle pattern already present in this file's other async cases (poll `isRunning` with a bounded loop is acceptable).

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace apps/server -- test/harness/runManager.test.ts`
Expected: FAIL — after finalization the rows are still there (no prune call yet).

- [ ] **Step 3: Implement**

`runManager.ts` line 8:

```ts
import { setSessionStatus, pruneSessionEvents } from './sessionStore.js';
```

`finally` block (lines 55-59) becomes:

```ts
    } finally {
      setSessionStatus(sessionId, 'idle');
      emit({ type: 'session.status', sessionId, status: 'idle' });
      // Replay buffer only needs to outlive in-flight runs. The idle event
      // above has been emitted (and persisted) before this prune, so a
      // client reconnecting after finalization gets the idle snapshot from
      // the route and (correctly) no replay; its missed tail is covered by
      // the snapshot-refresh path.
      pruneSessionEvents(sessionId);
      runs.delete(sessionId);
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace apps/server -- test/harness/runManager.test.ts`
Expected: PASS (existing cases + 1 new).

- [ ] **Step 5: Build + lint, then commit**

```bash
git add apps/server/src/harness/runManager.ts apps/server/test/harness/runManager.test.ts
git commit -m "feat(server): prune session event buffer when run finalizes"
```

---

### Task 4: SSE route — `id:` lines + `Last-Event-ID` replay

**Files:**
- Modify: `apps/server/src/routes/sessions.ts` (GET `/:id/events`, lines 109-157)
- Test: `apps/server/test/harness/sseReplay.test.ts` (new); possibly adjust `apps/server/test/harness/sseEvents.test.ts` stream-parsing helper

**Interfaces:**
- Consumes: `listSessionEventsSince(sessionId, sinceSeq): SessionEventRow[]` (Task 1); subscriber events now carry `seq` (Task 2).
- Produces: wire contract — every forwarded bus event is `id: <seq>\ndata: <json>\n\n` (id line omitted when `seq` undefined); reconnect requests carrying `Last-Event-ID: <n>` first receive the initial status snapshot (no id line), then all persisted events with `seq > n` (ascending, with id lines), then live events with `seq > maxReplayed`.

- [ ] **Step 1: Write the failing test**

Mirror the harness of `apps/server/test/harness/sseEvents.test.ts` (outer `Hono` app + auth context injection wrapping `sessionsRoute`, AbortController-driven disconnect, a read helper that splits the body stream on `\n\n`). Adapt the read helper to parse optional `id:` lines:

```ts
// helper — yields { id?: number; data: unknown } per SSE frame
async function* frames(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const idLine = frame.split('\n').find((l) => l.startsWith('id: '));
      const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
      if (!dataLine) continue; // heartbeat comment or keep-alive
      yield {
        id: idLine ? Number(idLine.slice(4)) : undefined,
        data: JSON.parse(dataLine.slice(6)),
      };
    }
  }
}
```

Test cases (all with real `sessionBelongsTo` — create a session first via `createSession('trader', <userId>)` matching the injected auth):

```ts
it('forwards live events with id lines once persistence assigns seq', /* connect without header, emit 2 events, expect frames[1].id === 1, frames[2].id === 2 and first frame is the snapshot without id */);

it('replays missed events on Last-Event-ID, in order, with id lines', /* seed: emit 4 events BEFORE connecting; connect with header 'Last-Event-ID: 2'; expect frames: snapshot (no id), then exactly events 3 and 4 with ids 3 and 4, then nothing more */);

it('treats an invalid Last-Event-ID as absent (no replay, live only)', /* header 'abc' → same behavior as no header */);

it('returns an empty replay for a stale larger Last-Event-ID', /* header '999' after emitting 2 events → snapshot only, no replay frames */);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace apps/server -- test/harness/sseReplay.test.ts`
Expected: FAIL — no `id:` lines today and no replay path.

- [ ] **Step 3: Implement in `sessions.ts`**

Replace the GET `/:id/events` handler body (keep auth/ownership checks identical):

```ts
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
  // Catch on every write: after cleanup closes the writer, a late write (or
  // a write racing the client disconnect) must reject silently.
  const sendRaw = (text: string) => writer.write(encoder.encode(text)).catch(() => {});
  const send = (obj: unknown, seq?: number) =>
    sendRaw(`${seq === undefined ? '' : `id: ${seq}\n`}data: ${JSON.stringify(obj)}\n\n`);

  // First event: current status snapshot. No id line — a snapshot is not a
  // log entry and must not advance the browser's lastEventId.
  const st = getSessionStatus(id);
  void send({ type: 'session.status', sessionId: id, status: st?.status ?? 'idle', runId: st?.runId ?? null });

  // Reconnect replay: the browser resends the last seen id as Last-Event-ID.
  const rawId = c.req.header('Last-Event-ID');
  const sinceSeq = rawId !== undefined && /^\d+$/.test(rawId) ? Number(rawId) : null;

  // Buffer-mode subscribe before replaying from the DB, then drain with a
  // seq filter — closes the replay-vs-live race. (better-sqlite3 replay is
  // synchronous so the buffer is empty in practice today; the pattern stays
  // correct if the store ever becomes async.)
  const buffer: SessionEvent[] = [];
  let buffering = sinceSeq !== null;
  const unsub = subscribe(id, (e) => {
    if (buffering) {
      buffer.push(e);
      return;
    }
    void send(e, e.seq);
  });

  if (sinceSeq !== null) {
    try {
      const missed = listSessionEventsSince(id, sinceSeq);
      let maxSent = sinceSeq;
      for (const row of missed) {
        void send({ ...row.payload, seq: row.seq }, row.seq);
        maxSent = Math.max(maxSent, row.seq);
      }
      buffering = false;
      for (const e of buffer) {
        if ((e.seq ?? Number.POSITIVE_INFINITY) > maxSent) void send(e, e.seq);
      }
    } catch {
      // Replay unavailable (degraded persistence) — fall through to live.
      buffering = false;
      for (const e of buffer) void send(e, e.seq);
    }
    buffer.length = 0;
  }

  const heartbeat = setInterval(() => {
    void writer.write(encoder.encode(`: heartbeat\n\n`)).catch(() => {});
  }, 10000);

  const cleanup = () => {
    unsub();
    clearInterval(heartbeat);
    void writer.close().catch(() => {});
  };
  c.req.raw.signal?.addEventListener('abort', cleanup);

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
});
```

Add imports at the top of `sessions.ts`: `listSessionEventsSince` from `'../harness/sessionStore.js'` (merge into the existing import from that module), and `type SessionEvent` from `'../harness/sessionEvents.js'` (extend the existing `subscribe` import).

- [ ] **Step 4: Run tests; fix phase-1 sseEvents parsing if needed**

Run: `npm test --workspace apps/server -- test/harness/sseReplay.test.ts test/harness/sseEvents.test.ts`

If `sseEvents.test.ts` parses frames assuming `data:` is the only line, adapt its parse helper to skip `id:` lines (assertions unchanged). Then full regression: `DATABASE_URL= npm test --workspace apps/server`.

- [ ] **Step 5: Build + lint, then commit**

```bash
git add apps/server/src/routes/sessions.ts apps/server/test/harness/sseReplay.test.ts
# plus sseEvents.test.ts if its helper needed the id-line tolerance
git commit -m "feat(server): SSE id lines and Last-Event-ID gap replay"
```

---

### Task 5: Integration — mid-run disconnect, reconnect completes the missed parts

**Files:**
- Test: `apps/server/test/harness/eventReplay.integration.test.ts` (new)

**Interfaces:**
- Consumes: everything from Tasks 1-4 (`startSessionRun`, `runSession` with fake model seam, the SSE route via the outer-Hono injection harness from `backgroundRuntime.integration.test.ts`, `listSessionEventsSince`).

- [ ] **Step 1: Write the test**

Model on `apps/server/test/harness/backgroundRuntime.integration.test.ts` (fake streaming model with chunk gates; outer Hono app with auth injection wrapping `sessionsRoute`; real sessionStore with unique session id).

Scenario (fake model emits text-start, delta 'a', delta 'b', delta 'c', text-end with a release gate between 'b' and 'c'):

```ts
it('a mid-run disconnect reconnects with Last-Event-ID and receives exactly the missed parts', async () => {
  // 1. create session (trader, injected user), build fake model whose doStream
  //    enqueues: text-start, delta 'a', delta 'b' — then awaits a gate — then
  //    delta 'c', text-end, finish('stop').
  // 2. startSessionRun(sid, userId, 'trader', (signal) => runSession({... model: fake, abortSignal: signal}))
  // 3. open SSE via app.request with an AbortController; read frames until the
  //    'b' part arrives (track its id line = lastSeen).
  // 4. abort the request (client disconnect). Run keeps going.
  // 5. release the gate; wait until the run finalizes (poll isRunning(sid) === false).
  //    NOTE: finalization prunes the buffer — so do NOT finalize before
  //    reconnecting. Assert instead: reconnect BEFORE releasing the gate.
  //    (Reorder: gate release happens after the reconnect assertions.)
  // 6. reconnect with header { 'Last-Event-ID': String(lastSeen) }.
  //    Expect frames: snapshot (busy — run still in flight), then delta 'c',
  //    text-end parts in order, each with id lines continuing from lastSeen+1,
  //    no duplicate 'a'/'b'.
  // 7. now release the gate; await finalization; assert listSessionEventsSince(sid, 0) === []
  //    (prune verified end-to-end).
});
```

The exact ordering (reconnect while gate still closed) is the point: replay serves **in-flight** runs. Write the assertions on parsed `data` JSON: snapshot `{type:'session.status', status:'busy'}`, then `{type:'message.part', part:{type:'text-delta', ...}}` frames whose text deltas are exactly `['c']`.

- [ ] **Step 2: Run to verify it fails**

If Tasks 1-4 are correct this should PASS immediately — it is the acceptance test (spec §5.1-5.2). If it FAILS, debug the seam (most likely suspect: id-line parsing in the test helper). TDD here means the test is the deliverable; a pass on first run is expected at this point in the chain. Record actual output either way.

- [ ] **Step 3: Regression + build + lint, then commit**

Run: `DATABASE_URL= npm test --workspace apps/server` (expect all green), `npm run build`, `npm run lint` (baseline).

```bash
git add apps/server/test/harness/eventReplay.integration.test.ts
git commit -m "test(server): mid-run disconnect replays missed parts on reconnect"
```

---

### Task 6: Frontend — reconnect reconciliation nudge

**Files:**
- Modify: `apps/web/src/hooks/useSessionEvents.ts` (handlers interface + `session.status` case)
- Modify: `apps/web/src/hooks/useSessionMessages.ts` (wire `onStatus`)

**Interfaces:**
- Produces: `SessionEventHandlers` gains optional `onStatus?: (status: SessionStatus) => void`, invoked on every `session.status` event including the connect snapshot.

- [ ] **Step 1: `useSessionEvents.ts`**

Add to `SessionEventHandlers`:

```ts
  /** Session status changed (event 'session.status', including the
   * point-in-time snapshot sent on every (re)connect). */
  onStatus?: (status: SessionStatus) => void
```

In `es.onmessage`, the `case 'session.status':` becomes:

```ts
        case 'session.status':
          setStatus((event.status as SessionStatus) ?? 'idle')
          handlersRef.current.onStatus?.((event.status as SessionStatus) ?? 'idle')
          break
```

- [ ] **Step 2: `useSessionMessages.ts` — wire reconciliation**

Inside the `useSessionEvents(sessionId, { ... })` call (before `onRunStart`):

```ts
    onStatus: (st) => {
      // Reconnect reconciliation: if a run finished while we were
      // disconnected, its events were pruned and no run.finished will ever
      // arrive on this connection — the idle snapshot is the only signal.
      // Close the stale pipeline and re-sync from the snapshot.
      if (st === 'idle' && pipelineRef.current) {
        closePipeline()
        refreshSnapshot()
      }
    },
```

No other frontend change: native EventSource already resends `Last-Event-ID` on automatic reconnect, and replayed `message.part` events flow through the existing per-run pipeline unchanged.

- [ ] **Step 3: Verify (build + lint + grep)**

Run: `npm run build` (web workspace builds via root), `npm run lint` (baseline).

```bash
grep -n 'onStatus' apps/web/src/hooks/useSessionEvents.ts apps/web/src/hooks/useSessionMessages.ts
```
Expected: handler declared + dispatched in useSessionEvents, consumed in useSessionMessages.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/hooks/useSessionEvents.ts apps/web/src/hooks/useSessionMessages.ts
git commit -m "feat(web): reconcile pipeline on idle snapshot after reconnect"
```

---

### Task 7: Manual E2E acceptance (agent-browser)

**Files:** none committed (verification task; findings go to the report).

- [ ] **Step 1: Start dev stack** — backend `npm run dev:server` (port 3001), frontend `npm run dev` (port 5173, do not start a second one). Worktree `.env` already has TRUSTED_ORIGINS/BETTER_AUTH_URL/DATABASE_URL. Test account `e2e@test.local` / `Test12345678`.

- [ ] **Step 2: Replay-on-refresh scenario** — send a message that streams a long reply; mid-stream, reload the tab (agent-browser `open` same URL). Expect: after reload the conversation shows user msg + full streaming reply continuing from where the reload happened (missed parts replayed); final message complete with NO duplicated bubbles. DB ground truth: `sqlite3 data/agent.db "SELECT seq, json_extract(model_message_json,'$.role') FROM session_messages WHERE session_id='<sid>'"` shows exactly one assistant row for the turn, and `SELECT COUNT(*) FROM session_events WHERE session_id='<sid>'` is 0 after the run finalizes.

- [ ] **Step 3: Switch-away-and-back scenario** — start a run in session A, switch to session B, return to A before the run finishes. Expect: missed parts replayed on re-subscribe, no duplicates.

- [ ] **Step 4: Prune-race scenario** — start a run, reload mid-stream, wait for the run to finish before the reload completes reconnect (or force: reload, wait 15s). Expect: idle snapshot reconciliation pulls the final assistant message (snapshot path), message list complete.

- [ ] **Step 5: Report** — write findings to `.superpowers/sdd/task-7-report.md` (pass/fail per scenario, evidence snippets). Stop dev servers and close agent-browser.

---

## Self-Review (completed during planning)

- Spec coverage: §4.1 → Task 1; §4.2 → Task 2; §4.3 → Task 4; §4.4 → Task 3; §4.5 → Task 6 (+replay arrives via Tasks 4/2 with zero protocol change); §4.6 → Task 2 Step 3 catch + Task 4 catch (degradation verified in unit test); §5.1/5.2 → Task 5; §5.3 → Tasks 1-4 keep existing SSE tests green; §5.4 → Task 2 unit tests; §5.5 → every task's build/lint/test step; §5.6 → Task 7.
- Type consistency: `SessionEventRow { seq; type; payload }` used identically in Tasks 1/4; `seq?: number` on `SessionEvent` in Tasks 2/4; `onStatus` signature matches between Tasks 6's two files.
- No placeholders; every code step shows complete code.
