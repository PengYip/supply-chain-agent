# Post-Ingest Document Review (Human Confirmation) Step

- **Status**: Design (awaiting review)
- **Date**: 2026-08-13
- **Augments**: `2026-08-12-doc-ingestion-tool-redesign-design.md` — adds the HITL
  confirmation layer on top of the redesigned tool layer; refines that spec's
  §7.6(A) entity-creation from *auto-create, model-unaware* →
  *propose → human-confirm → commit*.
- **Grounding**: 《深入理解 AI Agent》 ch4 (execution-tool layered safety;
  Proposer-Reviewer pattern; ex-post verification feedback loop).

---

## 1. Problem & goal

After `ingest_document` + `extract_fields` succeed, the system **immediately
persists** document + classification + fields + tags + vectors with **no human
checkpoint**. The user has no way to confirm:

1. business type (业务类型) is correct;
2. extracted structured fields (合同号/数量/金额 …) are accurate;
3. relationships (关系) are established;
4. text tags (文本TAG) are right;
5. vectorization (向量化入库) actually completed.

Today all five are only **model-narrated** in reply text, and vectorization
failure is **silently swallowed** (`documentEntry.ts:102-115` wraps embed+save
and on failure only does `console.warn` → degrades to FTS5). The ingest return
object has **no vectorization-status field** (`documentEntry.ts:130-138`), so
even the model cannot honestly report it.

**Goal**: add a post-ingest human-review confirmation step that surfaces all
five dimensions in one card, lets the user confirm or correct each, and keeps
every correction audited through existing tool-call machinery.

---

## 2. Locked decisions (from brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| Review timing | **Post-persist** (ingest still auto-commits; review is ex-post) | Smallest change; matches "录入后复核" semantics |
| Reviewer power | **Confirm + direct correction** (applied as update writes) | User wants to fix inaccuracies, not just flag |
| Blocking | **Soft** — `reviewStatus` recorded, downstream NOT blocked | YAGNI; can harden later if quality demands |
| Scope | Review step + callback bug fix; upload↔ingest disconnect deferred | Focused; disconnect is a separate root-cause fix |
| Approach | **Consolidated review card** + corrections via agent L2 tools | Five-dimension unified view + auditable writes + bounded surface |
| Relationships | **Extend extract to propose entity relationships** (graph-aligned) | Aligns with doc-ingestion redesign §7; refines §7.6(A) to propose-then-confirm |

---

## 3. Architecture

```
ingest_document (L1, persists, sets reviewStatus='pending',
                 returns NEW vectorization status field)
  -> extract_fields (L1, persists,
                 returns fields + NEW proposedRelationships)
  -> present_document_review (L1, NEW, presentation-first)
        |  emits one consolidated 5-dimension review payload
        v
  DocumentReviewCard (frontend, toolName-keyed render branch)
        |  per-dimension: confirm / correct
        v
  corrections -> injected agent instruction (reuse callback resume pipeline)
        -> applied via EXISTING L2 tools:
             tag_document / create_entity / link_entities
             + NEW update_document_fields (L2)
        -> reviewStatus: pending -> confirmed | corrected
```

- **Non-blocking**: `reviewStatus` is advisory. Downstream tools
  (`recall_documents`, `create_payment`, …) are unaffected.
- The correction round-trip reuses the **same** callback-resume pipeline fixed
  in Phase A (§10), so the two halves of this work share one mechanism.

---

## 4. Mechanism 1 — `present_document_review` (first presentation-first tool)

The repo has **no presentation-only tool and no custom UI-part emitter** today
(verified). The lowest-risk path (mirrors the existing L2/L3 card mechanism):

- The tool returns a structured `output` like any tool; it flows into the
  UIMessage stream as a `tool-${name}` part and is persisted with the message
  (same path every tool output already takes — `chat.ts:208-232`).
- Frontend adds a **`toolName === 'present_document_review'`** render branch
  (in `realChatUtils.ts:buildRenderItems` + `RealMessageItem.tsx`), rendering a
  new `DocumentReviewCard`. We do **not** introduce a custom `DataUIPart`
  (no server-side emitter precedent; higher risk).
- Follows the `escalate_to_human` `blocked`-card precedent: model calls it, UI
  renders from `output`, model narrates minimally.
- **Guaranteed appearance**: add a line to the `agent.ts` SYSTEM_PROMPT —
  "after a successful `ingest_document` + `extract_fields` of a business
  document, you MUST call `present_document_review`" — alongside the existing
  "honestly surface needsReview" instruction (`agent.ts:39-41`).

### Review payload shape (tool output)

```
{
  docId, docType, classificationConfidence,
  fields: [{ name, value, confidence, needsReview }],
  overallConfidence,
  proposedRelationships: [{ kind: 'Party'|'Commodity'|'Contract', role?, name, sourceSpan, confidence }], // §6
  tags: [...],                          // auto-tags from documents row
  vectorization: { status, mode, chunkCount, reason? },  // §5
  reviewStatus: 'pending'
}
```

The tool **assembles** this from existing rows: `documents` (docType, tags,
reviewStatus), `extractions` (fields + proposed_relationships), and the ingest
return's vectorization status. On assembly failure it returns
`{status:'error', reason}` and the card renders "复核数据不完整" without crashing
the loop.

---

## 5. Mechanism 2 — surface vectorization status (fix silent degradation)

Today vector failure is swallowed. Change `ingestFile` to capture the outcome:

- Wrap embed+save (`documentEntry.ts:102-115`) in try/catch; record result into
  a new return field:
  `vectorization: { status: 'ok'|'skipped'|'failed',
                    mode: 'ollama-bge-m3'|'deterministic'|'none',
                    chunkCount, reason? }`.
- This also fixes the ingest-return-object gap (`documentEntry.ts:130-138`)
  so the model can honestly report入库 status.
- The review card shows it **read-only, non-blocking** (FTS5 remains the
  recall fallback regardless).

---

## 6. Mechanism 3 — relationships dimension (aligned with the graph redesign)

`extract_fields` currently emits **flat fields only, no relationships**
(`extraction.ts:120-124`; verified). The doc-ingestion redesign §7.6(A) intends
extraction to auto-create Party/Commodity/Contract entities + edges → outbox →
Neo4j, *model-unaware*. This spec **refines** that: extraction **proposes** the
candidates; a human **confirms**; only then are they committed to the graph.

- **Derivation** (cheap, reuses existing extraction): from already-extracted
  甲方/乙方/标的物 fields, synthesize candidate entities:
  - Party (`role: '买方'|'卖方'`, `name`, `sourceSpan`, `confidence`)
  - Commodity (`name`, `sourceSpan`, `confidence`)
- Store them in a new `extractions.proposed_relationships` JSON column,
  confidence scored by the existing `attachConfidence` machinery.
- Review card shows them as **待确认关系**. Confirm →
  `create_entity` (Party/Commodity, dedup by kind+name) +
  `link_entities` (doc↔party edges: `buyer_of`/`seller_of`, doc↔commodity
  `covers`). Reject → dropped (marked dismissed).

This is the HITL gate the redesign's "model-unaware auto-create" lacked, and it
directly answers the user's "关系是否建立完成" review question.

> **Graph layer — verified functional (pre-review check).** The relationships-commit
> path uses the real graph layer (`graph/tools.ts` → `graph/repo.ts` → Neo4j),
> fully implemented. Boot probes Neo4j when `NEO4J_PASSWORD` is set
> (`index.ts:110-117`); tools are always registered and error per-call only if
> Neo4j is unreachable (server still boots — graph is off the request critical
> path). Prod target verified Neo4j 5.26.10. Dev needs `NEO4J_PASSWORD` + a
> reachable Neo4j (docker-compose). So §6's primary path is viable as designed;
> the legacy `bind_document` fallback is only a dev-env convenience, not an
> architecture gap. (See §14.)

---

## 7. Mechanism 4 — correction round-trip (reuse callback pipeline)

- Each dimension offers **确认** / **纠正**.
- A correction submits a structured payload; it is turned into an injected
  user instruction and applied by the agent via existing L2 tools, exactly like
  the L3 resume path writes an instruction (`approvalCallback.ts:169-180`):
  - field/docType corrections → **new `update_document_fields` (L2)**
  - tag corrections → `tag_document` (L2)
  - relationship confirm/create → `create_entity` / `link_entities` (L2)
- Every write goes through `withAudit` (`agent.ts:61-90`) → audit covered, no
  separate review-audit table needed.
- `reviewStatus` transitions: all-confirmed → `confirmed`; any correction →
  `corrected` (timestamp + user via `reviewedAt`/`reviewedBy`).

---

## 8. Data model & migration

### `documents` — add 3 columns (advisory review state)

`reviewStatus TEXT` (`pending|confirmed|corrected`; set `pending` at ingest),
`reviewedAt TEXT`, `reviewedBy TEXT`.

### `extractions` — add 1 column

`proposed_relationships JSON` (the §6 待确认 entities).

### Four sync points each (established pattern, verified)

1. SQLite raw DDL — `pipeline/db/client.ts` CREATE TABLE (fresh DBs).
2. SQLite guarded ALTER — `client.ts:141-167` idempotent `PRAGMA table_info` →
   `ALTER TABLE ... ADD COLUMN` (mirrors `user_id`/`minio_key`).
3. Drizzle mirror — `pipeline/db/schema.ts`.
4. Postgres — `postgres-schema.ts` pgTable **plus** the `statements` array in
   `migratePostgres` (`client.ts:186+`); drizzle-kit migration alone does NOT
   apply at runtime startup (gotcha).

No new tables. Audit = `withAudit`. reviewStatus = documents column.

---

## 9. Frontend

- `apps/web/src/utils/realChatUtils.ts` — add a `toolName` branch so a
  `present_document_review` part yields a `review` render segment carrying the
  payload.
- New `apps/web/src/components/DocumentReviewCard.tsx` — five sections
  (业务类型 / 结构化字段(+低置信标注) / 关系(待确认) / 文本TAG / 向量化入库),
  each with 确认 / 纠正 affordances.
- `RealMessageItem.tsx` — render `DocumentReviewCard` for the `review` segment
  (alongside existing `SoftGateCard` / `BlockedCard`).
- Correction submission resumes the agent loop with an injected instruction
  (the same resume **primitive** the approval callback uses) and is applied by
  the agent via L2 tools — so writes stay agent-mediated and audited. The exact
  transport (reuse `/api/approval/callback`'s resume path vs a sibling resume
  entry) is an implementation choice resolved in the plan; **no new direct-write
  endpoint**.

---

## 10. Phase A — callback bug fix (same pipeline as corrections)

Symptom: clicking 模拟审批通过 throws "后端未返回 UIMessageStream" because
`approvalCallback.ts` returns `c.json` on several branches while the frontend
hard-asserts `text/event-stream` (`RealChatView.tsx:226-228`).

Fix: convert **all** JSON branches to return a UIMessageStream (errors/denials
as text parts) — `:123, :128, :143, :154, :160, :195, :203`. Also confirm
`escalate_to_human` ESC tickets are actually persisted (`hitl.ts:49-57`) so a
narrated-but-not-executed ticket is detected rather than 404-ing.

---

## 11. Error handling

- `present_document_review` assembly failure → `{status:'error', reason}`, card
  renders "复核数据不完整", loop continues.
- Vectorization failure → `status:'failed'|'skipped'` in payload (non-blocking).
- Correction L2 tool failure → standard tool-error, model narrates,
  `reviewStatus` stays `pending`.
- Callback branches all return a stream (Phase A).
- Model occasionally not calling `present_document_review` (prompt not
  followed) → acceptable degradation (data persisted, just no card); no
  hard enforcement in v1.

---

## 12. Testing

- **Unit (`test/pipeline/`)**:
  - `extraction.ts` proposed-relationship derivation (甲方/乙方/标的物 →
    Party/Commodity) + confidence.
  - `present_document_review` payload assembly (5 dimensions from
    documents + extractions + vector status).
  - `ingestFile` vectorization-status capture (ok / skipped / failed).
  - `update_document_fields` sets `reviewStatus`.
- **Integration (`test/harness/`)**:
  - ingest → extract → present_document_review → payload-shape assertion.
  - confirm → `reviewStatus='confirmed'`; correct field →
    `update_document_fields` → `'corrected'`.
  - callback denied/error branches now return `text/event-stream`
    (Phase A regression).
- **Eval**: add case "ingest 合同 → 复核卡出现 → 五维齐全" to `eval/run.ts`.
- **Manual**: the 模拟审批通过 button no longer throws.

---

## 13. Scope & non-goals

**In scope**
- `present_document_review` tool + `DocumentReviewCard`.
- Vectorization-status field in ingest return.
- `extract_fields` proposed relationships (§6) + `extractions` column.
- `update_document_fields` (L2) + `documents.reviewStatus/reviewedAt/reviewedBy`.
- SYSTEM_PROMPT instruction to always present review after ingest+extract.
- Phase A callback bug fix.

**Out of scope (separate increments)**
- Upload↔ingest MinIO/INGEST_ROOT disconnect (the original ingest-failure root
  cause) — separate fix.
- Hard gate (block downstream tools until reviewed).
- Re-extraction trigger (one-click re-run of `extract_fields`).
- Richer entity extraction (line items, doc↔doc graph auto-build beyond
  甲方/乙方/标的物).
- Custom `DataUIPart` part types.

---

## 14. Open questions (resolve during plan / implementation)

- **Neo4j wiring — RESOLVED (pre-review verification)**: `graph/repo.ts` is
  fully implemented against Neo4j; boot probes it when `NEO4J_PASSWORD` is set
  (`index.ts:110-117`), tools are always registered, and they error per-call
  only if Neo4j is down (non-fatal). Prod is verified (Neo4j 5.26.10 on
  ubuntu-server); dev requires `NEO4J_PASSWORD` + a reachable local Neo4j. →
  The §6 relationships-commit path (`create_entity`/`link_entities`) is viable
  as designed; no defer needed in prod. Remaining dev-env item: confirm a local
  Neo4j (docker-compose service) for dev/prod parity (prior redesign §7.4).
- **Relationship dismissal persistence**: do rejected proposed-relationships
  need to be remembered (avoid re-proposing on re-extract), or is ephemeral OK?
- Whether to surface `reviewStatus` in the planned model-facing Agent status
  bar (doc-ingestion redesign §9.2 lists "extractions pending review") —
  natural composition point, but that status bar is itself not yet built.

---

## 15. File change list (for the implementation plan)

**Server**
- `pipeline/tools/documentEntry.ts` — ingestFile vectorization status;
  `present_document_review`; `update_document_fields`.
- `pipeline/extraction.ts` — proposed-relationship derivation + confidence.
- `pipeline/db/client.ts` — `documents` + `extractions` columns
  (DDL + guarded ALTER + Postgres `statements`).
- `pipeline/db/schema.ts` — drizzle mirror.
- `pipeline/db/postgres-schema.ts` — pgTable columns.
- `pipeline/db/*-repositories.ts` — save/read new columns.
- `harness/roleToolRegistry.ts` — register `present_document_review` (L1),
  `update_document_fields` (L2).
- `harness/permissionGate.ts` — L1/L2 mapping for the new tools.
- `harness/agent.ts` — SYSTEM_PROMPT instruction.
- `routes/approvalCallback.ts` — Phase A: all branches return a stream.

**Web**
- `utils/realChatUtils.ts` — `toolName` render branch.
- `components/DocumentReviewCard.tsx` — new.
- `components/RealMessageItem.tsx` — render the review segment.

**Tests**
- `test/pipeline/` — extraction relationships, review assembly, vector status.
- `test/harness/` — `update_document_fields`, callback stream regression.
