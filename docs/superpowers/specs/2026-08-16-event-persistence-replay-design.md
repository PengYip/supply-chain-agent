# Event Persistence + Reconnect Replay Design (Phase 2)

Status: draft for review
Branch: feat/event-persistence (from main c15628e)
Date: 2026-08-16

## 1. Background & Problem

Phase 1 replaced opencode-style event sourcing with REST snapshots + live SSE.
Known gap (spec §7 of background-session-runtime, accepted as phase-2 work):
while a client is disconnected (tab refresh mid-run, network drop, switching
sessions during an in-flight run and returning before it finishes), any
`message.part` events emitted in the gap are lost. The snapshot endpoint only
kicks in when the client explicitly fetches it; the SSE reconnect starts from
"now", so streamed deltas already consumed by the run but not yet observed by
this client never arrive over the wire.

Goal: persist session events with a monotonic per-session seq and replay the
gap on SSE reconnect (standard `Last-Event-ID` protocol), so a reconnecting
client observes every part of an in-flight run exactly once, in order.

Non-goals (explicitly out of scope):
- Full event sourcing (deriving message snapshots from the event stream).
  `session_messages` remains the history SSOT; events are a replay buffer.
- Postgres schema for `session_events` — deferred to the Postgres migration
  project (same decision as phase 4). The harness sessionStore is
  SQLite-only today; SQLite failure modes are handled by the guards in §4.6.
- Cross-process replay (multi-instance deployment). Single Node process, same
  as the in-memory bus and RunManager today.

## 2. Verified Current State (source-read 2026-08-16)

- `apps/server/src/harness/sessionEvents.ts` (38 lines): in-memory bus.
  `emit()` fans out to subscribers only; no persistence. Header comment
  already reserves phase 2 for `event` table + monotonic seq.
- `apps/server/src/routes/sessions.ts:112-157` (`GET /:id/events`): sends an
  initial `session.status` snapshot (no id line), then forwards bus events as
  `data: <json>\n\n`, 10s heartbeat comment, cleanup on `req.raw.signal`
  abort. No replay path.
- `apps/server/src/harness/runManager.ts` (75 lines): emits
  `run.started`, `session.status busy`, then per-run lifecycle events; in
  `finally` emits `run.finished|aborted|error` + `session.status idle`.
- `runSession.ts` emits one `message.part` per UIMessageChunk of
  `toUIMessageStream` (the only high-volume event type).
- `sessionStore.ts` uses synchronous better-sqlite3 with per-table
  `MAX(seq)+1` allocation (see `appendMessages`) — single-threaded, no
  interleaving. DDL is idempotent `CREATE TABLE IF NOT EXISTS` /
  PRAGMA-guarded `ALTER`.

## 3. Design Decisions (user-approved)

1. Scope: persistence + reconnect replay (messages table stays SSOT).
2. Retention: prune per-session events when the run finalizes — the replay
   buffer only needs to outlive in-flight runs; completed runs are covered by
   the snapshot path. Keeps the table bounded without a cron job.
3. Replay protocol: native SSE `id:`/`Last-Event-ID` (browser EventSource
   handles resend automatically; no custom query params).

## 4. Component Design

### 4.1 Storage: `session_events` table (SQLite, harness sessionStore)

```sql
CREATE TABLE IF NOT EXISTS session_events (
  session_id  TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  type        TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
);
```

- No FOREIGN KEY on session_id: this table is a transient buffer, not SSOT,
  and emit call sites (tests included) may reference session ids without a
  backing `sessions` row. FK enforcement would turn buffer writes into
  hard failures for no benefit.
- DDL added to the existing idempotent block in `sessionStore.ts`
  (same pattern as `session_messages` / `pending_approvals`).

New functions in `sessionStore.ts`:

```ts
export function appendSessionEvent(sessionId: string, type: string, payload: Record<string, unknown>): number
// seq = MAX(seq)+1 for the session (better-sqlite3 sync, same allocation
// pattern as appendMessages). Returns the assigned seq.

export function listSessionEventsSince(sessionId: string, sinceSeq: number): Array<{ seq: number; type: string; payload: Record<string, unknown> }>

export function pruneSessionEvents(sessionId: string): void
// DELETE FROM session_events WHERE session_id = ?
```

### 4.2 Persistence seam: `sessionEvents.emit()`

`emit()` becomes the single write-through point:

```ts
export function emit(event: SessionEvent): void {
  let seq: number | undefined;
  try {
    seq = appendSessionEvent(event.sessionId, event.type, event as Record<string, unknown>);
  } catch (err) {
    // Buffer write is best-effort: live subscribers must not lose the event
    // because persistence failed (e.g. Postgres backend without the table).
    console.error('[sessionEvents] persist failed:', ...);
  }
  fanOut({ ...event, seq });  // subscribers see seq when available
}
```

- Import direction: `sessionEvents.ts` → `sessionStore.ts`. sessionStore does
  not import sessionEvents — no cycle.
- `SessionEvent` type gains an optional `seq?: number`.
- The SSE initial status snapshot (built in the route handler, not via emit)
  keeps having no seq — it is a point-in-time snapshot, not a log entry, and
  must not advance the browser's lastEventId.

### 4.3 SSE channel: id lines + replay on `Last-Event-ID`

`GET /:id/events`:

- Every forwarded bus event is written as:
  `id: <seq>\ndata: <json>\n\n` (id line omitted when `seq` is undefined —
  persistence-degraded mode; reconnect replay is then simply unavailable,
  live behavior unchanged).
- On connect, read `Last-Event-ID` header. If absent or not a non-negative
  integer: current behavior (snapshot + live).
- If present (`sinceSeq`), connect in three phases inside the same handler:
  1. Subscribe in **buffer mode**: incoming events queue into an array.
  2. `listSessionEventsSince(id, sinceSeq)` from the DB; send each with its
     id line; track `maxSent = max(sinceSeq, ...replayed seqs)`.
  3. Drain the buffer: send entries with `seq > maxSent`, skipping
     `seq <= maxSent` (duplicates of the DB replay — this closes the
     query-vs-subscribe race window). Then flip the subscriber into direct
     send mode for the rest of the connection.
- Ordering guarantee: per-session seq is allocated synchronously at emit
  under the single-threaded event loop; DB replay + seq-filtered drain
  yields a gap-free, duplicate-free stream.

### 4.4 Retention: prune on run finalization

`runManager.ts` `finally` block appends, after `emit(session.status idle)`:

```ts
pruneSessionEvents(sessionId);
```

- Rationale: by the time the run finalizes, `run.finished|aborted|error` +
  `session.status idle` have been emitted AND persisted, then the whole log
  is dropped. A client reconnecting after finalization gets the idle
  snapshot and (correctly) no replay; any tail it missed is recovered by the
  existing snapshot-refresh path (`useSessionMessages` refreshSnapshot on
  terminal status).
- Edge: subscriber disconnects mid-run and reconnects after prune — snapshot
  covers it. No data is user-visible-lost because the assistant message is
  persisted by `runSession.onFinish` before `run.finished` fires.

### 4.5 Frontend (minimal)

- Native EventSource already stores the last received `id:` and resends it
  as `Last-Event-ID` on **automatic reconnect**. No URL/param changes.
- **Mechanism split (shipped behavior)**: `Last-Event-ID` gap replay engages
  only on an automatic reconnect of the SAME EventSource (transient network
  drop). A **page refresh creates a fresh EventSource with no lastEventId**
  (browsers do not persist it across page loads), so the server replay path
  does NOT engage on refresh — completeness on refresh rides on the live
  tail (the run is usually still streaming) plus the idle-snapshot reconcile
  below.
- `useSessionEvents`/`useSessionMessages` need no protocol change: replayed
  `message.part` events arrive in order with the same shape; the existing
  per-run chunk pipeline (lazy-start on first part for a known runId) merges
  them identically to live parts.
- One reconciliation addition in `useSessionMessages`: when the SSE
  (re)connect snapshot says `idle` while local state is `busy` (run finished
  while disconnected, events pruned), trigger the existing
  `refreshSnapshot()` so the final assistant message appears. This mirrors
  the phase-1 "terminal status refresh" fix, closes the prune-race hole, and
  is also what makes the page-refresh path complete (refresh → run finishes
  → idle snapshot → refreshSnapshot pulls the persisted final message).

### 4.6 Persistence-failure degradation (SQLite failure modes)

Note: the "Postgres backend" trigger named in the original draft cannot occur
today — the harness `sessionStore` is unconditionally synchronous
better-sqlite3 (`sessionStore.ts:5,19`); `DB_BACKEND` routes the pipeline db
(`pipeline/db/dbBackend.ts`), not this store. The guards below are therefore
not about Postgres but remain worthwhile hardening for real SQLite failure
modes (disk full, corrupted DB file, locked WAL): if `appendSessionEvent`
throws, emit's try/catch logs and continues without seq → SSE omits id lines
→ replay unavailable, live streaming unaffected. Documented limitation until
the Postgres migration project adds the table. (SQLite remains the default
runtime today.)

## 5. Acceptance Criteria

1. Integration test (fake streaming model, real RunManager + runSession):
   subscribe, receive N parts, disconnect, let the run emit more parts,
   reconnect with `Last-Event-ID` = last seen seq → client receives exactly
   the missed parts, in order, no duplicates.
2. `session_events` rows for a session are gone after the run finalizes
   (prune verified in the same test).
3. Connect without `Last-Event-ID` behaves exactly as before (snapshot +
   live only) — existing SSE tests stay green unchanged.
4. Emit persists every event type (run.*, session.status, message.part) with
   monotonically increasing per-session seq.
5. build → lint → test green (CI-equivalent: `DATABASE_URL= npm test`).
6. Manual E2E: refresh the tab mid-run → final message complete, no
   duplicated bubbles; DB ground truth shows one assistant row. Note the
   refresh outcome is delivered via the §4.5 split's second mechanism
   (live-tail + idle-snapshot reconcile), not the `Last-Event-ID` replay —
   a fresh EventSource has no lastEventId. The replay path is exercised by
   auto-reconnect (network drop) and covered by the integration test
   (criterion 1).

## 6. Risks & Edges

- Write amplification: one sync INSERT per emitted event (message.part can
  be tens-to-hundreds per run). better-sqlite3 sync inserts are ~µs; WAL is
  enabled. Accepted; batch write is a later optimization if profiling says
  so.
- Replay-vs-live race: closed by buffer-mode subscribe before the DB query +
  seq-filtered drain (§4.3).
- Browser tab closed during replay burst: `writer.write` rejections are
  already swallowed by the existing `.catch(() => {})`; cleanup on signal
  abort unchanged.
- seq exhaustion/reset: per-session seq starts at 1 after prune. **Cross-
  generation caveat (shipped behavior)**: a client holding a stale larger
  `Last-Event-ID` from run N does NOT "simply get an empty replay" — if it
  reconnects during run N+1 (e.g. a network blip that outlives run N's
  finalization and a new run's start), the server serves new-generation rows
  with `seq > staleId` while skipping run N+1's head (seqs 1..staleId): a
  non-empty replay of the wrong generation. Damage is bounded: the frontend
  lazy pipeline joins mid-stream (missed head is transient) and the terminal
  `refreshSnapshot()` heals the message list from `session_messages` SSOT.
  Accepted; phase 3 may add a generation epoch or never-reset seq to make
  stale ids unambiguous.

## 7. Testing Strategy

- Unit (`test/harness/sessionEvents.persist.test.ts`): append assigns
  monotonic seq; listSince boundary (exclusive); prune clears; emit fan-out
  still isolates throwing subscribers; emit survives persistence failure
  (stubbed throw) and forwards without seq.
- Route-level (`test/harness/sseReplay.test.ts`): Last-Event-ID header →
  replay order + id lines; duplicate filtering across the replay/drain
  boundary; absent header unchanged; invalid header treated as absent.
- Integration (`test/harness/eventReplay.integration.test.ts`): acceptance
  criterion 1-2 end-to-end with fake model.
- Manual E2E via agent-browser (acceptance criterion 6).
