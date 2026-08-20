# Document-Ingestion Tool Layer Redesign

- **Status**: Design (awaiting review)
- **Date**: 2026-08-12
- **Supersedes / augments**: `2026-08-05-document-entry-agent-design.md`, `2026-08-05-document-entry-agent-phase1b-design.md` (prior iterations; this is a first-principles redesign of the tool layer)
- **Grounding**: 《深入理解 AI Agent》ch2 (context engineering / Agent status bar) + ch4 (tool design)

---

## 1. Overview

This redesign rebuilds the document-ingestion **Agent tool layer** from first principles rather than stacking features. The core idea: **L1 generic primitives first, then pluggable L2 business tools**. The model should perceive a small set of business-semantic tools; the stable, reusable mechanics live underneath as primitives that are only exposed to the model when standalone perception is genuinely needed.

### Goals

- A coherent, two-layer tool layer where each tool has one clear purpose, a crisp "when to use / when not to use" description, and bounded context output.
- Eliminate context redundancy at the root (structured-extraction no longer dumps full cited text into the model trajectory).
- Make document **relations** a first-class, queryable artifact (heterogeneous entity graph) instead of a relational `contractNo` string.
- Add a model-facing **Agent status bar** so the model reads aggregate state cheaply instead of recomputing it from raw trajectory.
- Cover adjacent product gaps that belong to the document lifecycle (real file delete with cascade, upload size limit, session auto-title, message copy).

### Non-goals (out of scope, listed in section 12)

Favorites/pin, a model-facing `read_document` tool (deferred), an agent-initiated delete tool, MCP-based external ingestion (conditional Phase 2), real OCR (current mock stays).

---

## 2. Design principles

### 2.1 Two-layer framework

| Layer | Characteristics | Examples |
|---|---|---|
| **L1 generic primitives** | Stable params, cross-scene reuse, no business semantics, read-only / low-risk. Not necessarily model-visible — expose as a tool **only** when the model needs standalone perception. | `parseDocument`, chunker, embedder, classifier, `recall_documents`, `inspect_extraction`, `execute_code` |
| **L2 business tools** | Carry business semantics, orchestrate L1 primitives, carry permission/audit, may need idempotency. | `ingest_document`, `extract_fields`, `tag_document`, `create_entity`, `link_entities`, `graph_query` |

**Decision rule**: L1 = stable params + cross-scene reuse + no business meaning + read-only/low-risk. L2 = business semantics + multi-step orchestration + needs permission/audit/idempotency.

### 2.2 Book-grounded rules applied throughout

From ch4 (tool design):
- **Granularity**: integrate by functional similarity + use-case overlap (e.g. unify per-format extractors into one `parseDocument` + format param).
- **Generality**: generic > specialized, unless a clear safety/permission/performance reason forces specialization (e.g. production DB writes).
- **Description art**: "when to use" > "what it can do"; boundaries (can't-do) > capabilities; concrete param examples; 1–5 real call examples. When the model picks the wrong tool, **check the description first, not the model**.
- **Param fidelity**: no silent input transformation, no silent param injection — the model-perceived world must equal the tool-operated world.
- **Perception tools**: bounded output, pagination, offset/limit, explicit truncation, drill-down. Read-only enables cache + parallel.
- **Execution tools**: layered safety (input validation → permission → Proposer-Reviewer approval / ex-post verification), auto-verification feedback loop, long-output truncate+persist, sandbox isolation, idempotency.
- **ACI principle**: a tool maps to an agent goal, not a backend API. Storage choice is orthogonal to the agent-facing contract.

From ch2 (context engineering / Agent status bar):
- Context is the agent's eyes; code can pre-compute aggregate state so the model does not recompute it.
- Status bar = a **user-role message appended to trajectory tail** (not system — preserves KV cache), code-maintained (never an LLM summarizer), treated as a lossy projection whose accuracy is a first-class production metric.
- Two halves of one principle: keep model context **lean** (bounded extraction returns) **and** let the model know aggregate state **cheaply** (status bar).

---

## 3. Tool layer — consolidated picture

### 3.1 L1 generic primitives

| Primitive | Status | Model-visible? | Purpose |
|---|---|---|---|
| `parseDocument(fileUri)` → `BlockModel[]` | **NEW** (extracted from `ingestFile`) | No (internal) | Pure function: parse file → blocks; adapter auto-selected by format (digital pdf-parse/txt/md; scanned MinerU with digital→scanned auto-fallback) |
| `chunker(blocks)` → chunks | Existing (`chunking.ts`, target ~500 chars) | No (internal) | Greedy block merge into chunks |
| `embedder(text)` → vector | Existing (`embedder.ts`: Deterministic / Ollama bge-m3 1024-dim) | No (internal) | Vector embedding |
| `classifier(parsedText)` → `{docType, confidence}` | **NEW** internal stage | No (internal) | LLM small-model classification; routing-classify (pre-extract) + validation-classify (post-extract) |
| `recall_documents` | Existing, unchanged (`recall.ts`) | **Yes (L1 tool)** | FTS5/vector/hybrid RRF; bounded (snippet ≤200 chars, ≤50 hits) |
| `inspect_extraction(extractionId, fieldName?)` | **NEW** | **Yes (L1 tool)** | On-demand single-field evidence drill-down; narrow scope: only already-extracted fields |
| `read_document(docId, {offset, limit})` | **DEFERRED** (not day-1) | Yes when exposed | On-demand raw-doc reading with pagination + compression threshold |
| `execute_code` | Existing (`executeCode.ts`, CubeSandbox) | **Yes (L1 tool)** | Python sandbox; **flag: stdout/stderr currently unbounded — bound in plan** |

### 3.2 L2 business tools

| Tool | Status | Permission | Purpose |
|---|---|---|---|
| `ingest_document` | **Refactored** (was L1, stays L1) | L1 | Coarse orchestration: parse → classify → extract → auto-tag → chunk → embed → store. Returns bounded `{docId, blockCount, modality, classifiedDocType, confidence}`. Model triggers once; internals hidden |
| `extract_fields` | **Refactored** return contract | L1 | Grounded field extraction. **Default return = bounded summary** per field `{name, value, confidence, needsReview, autoAccepted}` + `overallConfidence` + `missingRequired` + `extractionId`. Evidence persisted to storage, NOT in context by default |
| `tag_document(docId, tags)` | **NEW** | L2 | Explicit (user/agent) labels, post-ingest, any time. Distinct from auto-tags (ingest byproduct) |
| `create_entity(kind, props)` | **NEW** | L2 | Create non-Document entities (Party/Commodity/Contract). Dedupe by kind+name (idempotent: hit → return existing id). Pre-check/propose same-name matches before create (Proposer pattern) |
| `link_entities(src, dst, kind, props, confidence)` | **NEW** | L2 | Create graph edge between **existing** entities only (no implicit auto-create). Generic: handles all edge kinds via open `kind` + `props` |
| `graph_query(subject, {depth, edgeKinds?, direction?})` → `{nodes, edges}` | **NEW** | L2 (read) | Bounded traversal, default depth=2 (covers ~80% of scenarios). Returns node summaries + edge props, no raw text |

### 3.3 Deprecated / superseded

| Existing | Disposition | Reason |
|---|---|---|
| `bind_document` (L2, doc→contract via `contractNo`) | **Superseded** by `create_entity` + `link_entities` | Was relational string; now a graph edge with full props |
| `link_document` (L2, in-memory graph) | **Superseded** by `graph_query` / `link_entities` against Neo4j | Legacy in-memory twin; replaced by persistent graph |
| `verify_document_fields` (L1, mock OCR) | **Keep as-is** (flagged mock) | Stays until real OCR is a requirement; out of scope here |

---

## 4. Step 1 — Parsing

- **`parseDocument(fileUri) → BlockModel[]`** becomes an **L1 pure-function primitive**: file URI in, blocks out, adapter auto-selected by format. It is extracted out of today's monolithic `ingestFile()` (`documentEntry.ts:60-114`) so it is independently testable and reusable.
- **`ingest_document`** is refactored to **compose** `parseDocument` + chunk + embed + store (and, after Steps 3/5, also classify + auto-tag).
- **`read_document`** (perception tool, offset/limit + above-threshold compression) is **exposed on demand**, NOT day-1. Two-phase rollout:
  1. Extract `parseDocument` primitive — low-risk refactor, immediately verifiable.
  2. Expose `read_document` only when a concrete "model needs to read raw doc" scenario emerges.
- **Rationale**: aligns with the book `read_document` pattern + progressive disclosure; avoids premature tool-token cost and miscalls.

### Two orthogonal consumption paths (do not conflate)

- **(a) Ingest / HITL evidence path**: `inspect_extraction` (already-extracted field → evidence).
- **(b) Business-execution decision path**: `recall_documents` + `read_document` (arbitrary text) + `graph_query` (relations) + `extract_fields` summary (structured) + `execute_code` (comparison).

`inspect_extraction` is narrow (only already-extracted fields) and **must not** become a second recall tool.

---

## 5. Step 2 — Structured extraction

- **`extract_fields` default return = bounded summary**: per field `{name, value, confidence, needsReview, autoAccepted}` + `overallConfidence` + `missingRequired` + `extractionId`.
- **Evidence** (`citedText`, `sourceSpans`) is **persisted to storage, not placed in context by default**. This solves context redundancy at the root — today the tool returns unbounded per-field `<external_content>` cited text.
- **`inspect_extraction(extractionId, fieldName?)`** = L1 perception tool for on-demand, single-field evidence drill-down. Narrow scope: only already-extracted fields.
- Internal span-validation (`spanValidator.ts`) and confidence-scoring (`confidence.ts`, weighted 0.4/0.4/0.2; REVIEW 0.7 / AUTO 0.9 / KEY 0.95) logic is **invisible to the model** — only the decision outcome is exposed.

**Rationale**: book perception-tool rules — structured candidates not full text; explicit truncation; long output persisted + drill-down.

---

## 6. Step 3 — Document classification

Today there is **no classification tool** — `docType` is user-supplied at upload (`files.ts:116`). This redesign adds classification as an **internal stage of `ingest_document`**, with an **LLM small model** as the mechanism.

### Breaking the circular dependency

A naive design loops: extraction needs `docType` to pick a schema, but "classify from extracted results" needs extraction to have run. The fix splits classification into two phases with different purposes:

| Phase | Timing | Input | Purpose |
|---|---|---|---|
| **Routing-classify** (required) | After parse, before extract | Parsed text/blocks only | Pick which extraction schema to run |
| **Validation-classify** (optional) | After extract | Extracted fields | Consistency check (e.g. extracted an invoice number but docType says contract → flag/autocorrect) |

### Decisions (locked)

- **Form A**: classification is an **internal stage** in `ingest_document` (parse → classify → extract → store). The model does not explicitly call a classify tool. The classified `docType` + `confidence` are **exposed in the `ingest_document` return value** so the model/user can detect low-confidence and correct.
- **Mechanism**: **LLM small model** (flexible, adapts to new doc types without rule changes). Rule-keyword and schema-fit rejected (brittle / expensive).
- The classifier is an **L1 internal primitive**, not a model-visible tool (avoids extra round-trips; matches "shield the ingestion details").

---

## 7. Step 4 — Relation graph

### 7.1 Scope

A **heterogeneous entity graph** for the whole commodity-trading domain — not document-to-document only.

- **Node kinds** (illustrative, open): Document / Party / Commodity / Contract / Order / Payment / Account ...
- **Edge kinds** (open, all carry `props` + `confidence` + `sourceSpan`):
  - doc-doc: `references` / `accompanied_by` / `supersedes`
  - doc-party: `buyer_of` / `seller_of` / `issued_by` / `shipped_by`
  - doc-commodity: `covers`
  - party-party: `subsidiary_of` / `related_party` / `beneficiary_of`
  - party-commodity: `trades`
  - contract → order → payment
  - doc-contract: `plays_role(role: framework|monthly|supplement|confirmation)`

### 7.2 Contract = first-class aggregation node

A contract is not a `contractNo` string. Multiple documents (框架/月度/补充/确认单) hang off **one** Contract node via `plays_role` edges. This fills a real gap — the current `bind_document` only stores `contractNo`.

**Key distinction (orthogonal)**: `docType` = intrinsic doc category (合同/发票/提单); `plays_role` edge `role` prop = the doc's role *within* a contract (framework/monthly/supplement/confirmation). A 月度合同 has `docType=合同`, `role=monthly`.

Rare contract-contract edges (`parent_contract` / `amends` / `related_deal`, e.g. 年度总框架 → 子框架) use `link_entities(src=Contract, dst=Contract)`.

### 7.3 Open schema

Node/edge `kind` is an **open string, not a closed enum**. New kinds (仓单/质检单/保险单 docs; 担保方/承运方 parties; 对冲/背靠背 edges) can be added any time with **no migration**. Neo4j's labeled-property model is isomorphic to this (open labels, arbitrary props), which reaffirms the storage choice.

An optional **registry** is **metadata only, never a gate**: it enriches known kinds (model description, UI display, special logic like Contract aggregation) but never blocks creation of new kinds. Progressive disclosure applied to the schema.

### 7.4 Storage and consistency

| Dimension | Decision |
|---|---|
| Storage | **Neo4j** (existing instance on ubuntu-server, dedicated capacity). Labeled-property graph isomorphic to open schema |
| Dev | **docker compose local Neo4j** (add to `docker-compose.yml`) for dev/prod parity |
| Double-write | **Outbox pattern**: Postgres is system-of-record; an outbox table is written in the same transaction; an independent drain process moves events to Neo4j; eventual consistency |
| Upgrade-to-standalone trigger | Graph-algorithm need (anti-fraud / community detection / path-finding) OR node count > 10M. Until then, stay on the existing Neo4j instance |

**Principle held**: storage choice is orthogonal to the agent-facing tool — `graph_query`'s contract is identical whether backed by recursive CTE, Cypher, or Neo4j.

### 7.5 Tools

- **`create_entity(kind, props)`** — L2 write. Creates non-Document entities. Dedupes by kind+name (hit → return existing id, idempotent). Pre-checks/proposes existing same-name matches before create (Proposer pattern). L2 (reversible / delete-node, lower-risk than payments, not L3). Open props.
- **`link_entities(src, dst, kind, props, confidence)`** — L2 write. Connects **existing entities only** (no implicit auto-create). Generic: one param shape (`src/dst/kind/props`) handles all edge kinds (book integration principle).
- **`graph_query(subject, {depth, edgeKinds?, direction?}) → {nodes, edges}`** — L2 read. Bounded return; default depth=2; no raw text (node summary + edge props only).

### 7.6 Entity sources

- **(A) Extraction byproduct (~90%)**: `extract_fields` auto-creates Party/Commodity/Contract nodes + edges → outbox → Neo4j. Model-unaware.
- **(B) `create_entity` tool (explicit)**: for non-document facts the agent discovers (e.g. "ABC 是 XYZ 的子公司").

---

## 8. Step 5 — Tagging + vector ingest

- **`ingest_document` stays ONE coarse orchestration tool**: parse → classify → extract → auto-tag → chunk → embed → store. The model triggers once and never sees internals (book granularity principle: these stages always co-occur → integrate).
- L1 primitives (`parseDocument` / chunker / embedder / classifier) are **internal functions**, reusable by other paths (`recall`, `read_document`).
- **Three "tag" sources, separated**:
  - **Auto-derived tags** (from docType / extracted fields / content) → internal to `ingest_document`, persisted, included in the return summary.
  - **Explicit (user/agent) tags** → separate **`tag_document(docId, tags)` L2 tool**, post-ingest, any time.
  - **Graph edges** → `link_entities` (Step 4), not part of tagging.

---

## 9. Topic 2 — Model-facing Agent status bar + frontend widget

### 9.1 The gap

Grepping `apps/server/src` confirms **zero** model-facing status injection today. The only "AgentStatusBar" is a human-facing React widget (`useAgentStatus.ts`, 3s poll) — a **category error** versus the book's mechanism. The backend `streamText` (`agent.ts:230`) injects no user-role status message.

### 9.2 (a) Model-facing Agent status bar — NEW deliverable

The harness injects an `<agent_status>` **user-role message at the trajectory tail** on each model call (not system — preserves KV cache). Content is **code-maintained from in-memory harness state** (never an LLM summarizer):

- per-tool call counts (from the `withAudit` log)
- pending L2/L3 approvals (from the approval queue)
- current TODO / key progress (docs ingested / extractions pending review / entities created)

**Update strategy = Impl 1 (replace-per-turn)**: remove the old status message and append a fresh one each turn. The invalidated suffix is one round; the whole prefix stays reusable. This avoids the stale-status accumulation of Impl 2 (persistent append).

**Accuracy is a first-class production metric**: the model believes the status bar unconditionally, so status-bar poisoning is a real risk. Reuse the existing `tagExternal` / injection-defense posture to defend it.

### 9.3 (b) Frontend human widget — keep + rename + optimize

- Keep `useAgentStatus` poll + the React component (humans need to see "agent working / pending approval to act on").
- **Rename** to avoid conflation with the book's model-facing mechanism.
- Slow the poll to **5s**; stop polling when there is no active session/turn.

---

## 10. Topic 3 — Product features (in this design)

| Feature | Scope | Notes |
|---|---|---|
| **Message copy button** | Frontend | `navigator.clipboard` on message text; trivial, high UX value |
| **Upload size limit** | Client + server | Configurable `maxSize` (default ~25MB), enforced both sides; safety guard against giant files choking ingest |
| **File delete (real DELETE)** | Backend cascade + UI | Removes file from MinIO + DB + FTS + vector index + **graph edges via Neo4j outbox**. Ties to Step 4. Human UI action only — **no agent delete tool** (destructive, YAGNI until a clear business scenario) |
| **Session auto-title** | Backend + UI | After the first exchange, one LLM shot generates a title (fallback: truncated first user message). `SessionInfo` gains a `title` field; sidebar shows title instead of "角色：trader" |

**Deferred to a separate small spec**: file favorite, session favorite (YAGNI for now;大宗文件量未必大到需要 pin). Sessions sort stays newest-first (server already returns that); if favorites are added later, sort becomes `(favorite, time)`.

---

## 11. Topic 4 — External cloud-doc ingestion

Research (lib-1) concluded: official `lark-openapi-mcp` is Beta and explicitly cannot upload/download, and `@ai-sdk/mcp` ↔ ai@6 compatibility is unverified. The official **`lark-cli`** (Go) already covers the full read/download surface (lark-doc / lark-drive / lark-wiki skills + raw `api GET` + `--page-all` pagination + OS keychain auth). Existing `ingestFile()` + `assertWithinRoot()` + `tagExternal()` are all reusable.

### 11.1 Decisions (locked)

- **Form = internal `fetch_lark_doc` tool (Phase 1, no MCP)**: add an internal tool to `roleToolRegistry` that shells out to `lark-cli lark-doc read` / `lark-drive download`, writes the file into `INGEST_ROOT`, and returns a local path. The agent then calls the **existing `ingest_document`**. ~1K tokens, zero new infrastructure, full reuse.
- **Provenance = download snapshot (A)**: fetch once → persist file + `{content, hash, version, fetched_at}` provenance metadata. `recall_documents` then searches external docs like local ones; offline-resilient; enterprise-compliance provable snapshot. Trade-off: requires a revocation/retention purge policy (enterprise data hygiene, not over-engineering).
- **Phase 2 (conditional, NOT now)**: a thin 2–4 tool MCP stdio wrapper over `lark-cli` via `@ai-sdk/mcp`, only if multiple external sources appear. Requires verifying ai@6 compatibility first (Appendix D).
- **Not recommended**: official `lark-mcp` as primary.

### 11.2 Verification items for the implementation plan (not design gates)

1. `@ai-sdk/mcp` ↔ ai@6 version compatibility (lockfile shows v7-era via frontend; server on ai@6.0.241) — **only needed for Phase 2**.
2. `lark-cli` headless auth refresh under PM2 (interactive login won't work; confirm device-code + keychain persistence).
3. Binary attachment coverage (lark-drive download for pdf/xlsx; scanned → MinerU path).
4. OpenAPI quota throttling for batch ingestion (`--page-all` amplifies call volume).

### 11.3 Items needing user input (carry into plan as open questions)

- Team `lark-cli` skills location (not in repo — confirm built-in vs custom + exact command surface).
- Revocation / retention policy ownership.

---

## 12. Out of scope

- **`read_document` tool exposure** — deferred until a concrete scenario emerges (Step 1 phase 2).
- **Agent-initiated `delete_document` tool** — destructive, no clear business scenario yet.
- **MCP-based external ingestion (Phase 2)** — conditional on multiple external sources.
- **File / session favorites** — separate small spec.
- **Real OCR** — `verify_document_fields` stays a mock until OCR is a real requirement.
- **Graph algorithms** — no anti-fraud / community-detection / path-finding need identified; upgrade trigger is explicit (graph-algo need OR node count > 10M).

---

## 13. Rollout phasing (risk-ordered)

1. **Low-risk refactors first** (immediately verifiable, no new infra): extract `parseDocument` primitive; refactor `extract_fields` return contract + add `inspect_extraction`; bound `execute_code` output.
2. **Classification + tagging** (internal stages, model-visible only via return values): classifier LLM small model; auto-tag; `tag_document` tool.
3. **Model-facing Agent status bar** (harness-only change, no new infra): `<agent_status>` injection, Impl 1.
4. **Graph layer** (new infra: Neo4j dev docker + outbox): `create_entity` / `link_entities` / `graph_query`; extraction byproduct → outbox; supersede `bind_document` / `link_document`.
5. **Product features**: message copy, upload limit, file delete cascade, session auto-title; frontend widget rename + 5s poll.
6. **External ingestion (Phase 1)**: `fetch_lark_doc` internal tool + snapshot provenance.

---

## 14. Open questions (resolve during plan / implementation)

- ai@6 compatibility verification for any MCP work (Phase 2 only).
- `lark-cli` headless auth under PM2.
- Binary attachment coverage for lark-drive downloads.
- Revocation / retention policy ownership for snapshot provenance.
- Team `lark-cli` skill surface confirmation.
- Whether to bound `execute_code` stdout/stderr in this redesign or a follow-up.
