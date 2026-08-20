# Document-Ingestion Tool Layer Redesign — Phase 2 (Plan B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add document **classification** (LLM small-model, internal stage of `ingest_document`), **auto-tagging** (deterministic, internal stage), and an explicit **`tag_document` L2 tool** — the three items in design §13 rollout item 2 — so the model gets a classified `docType` + tags back from one ingest call and can label documents post-ingest.

**Architecture:** Phase 2 changes no infrastructure and adds no datastore. It inserts two new **L1 internal stages** into the existing `ingestFile()` orchestration (parse → **classify** → persist → chunk/embed → **auto-tag**), persists their outputs in two new SQLite tables (`classifications`, `document_tags`) that mirror the existing per-doc-fact convention (`extractions`, `bindings`), and exposes one new model-facing L2 tool (`tag_document`). Classification determines the effective `docType` (the caller-supplied `docType` becomes an optional *hint*); the classified `docType` + `confidence` + auto-tags are returned by `ingest_document` so the model/user can detect low confidence and correct. Validation-classify (§6, optional) is deliberately deferred. `extract_fields` stays a separate tool — folding extraction into ingest is NOT in this phase (§13 item 2 lists only classifier + auto-tag + tag_document).

**Tech Stack:** TypeScript, Hono + Vercel AI SDK 6 (`tool` with `inputSchema`, `generateObject` with JSON mode), vitest, SQLite (raw idempotent DDL via `db/client.ts`), drizzle-orm schema, zod, oxlint.

## Global Constraints

- **AI SDK 6, NOT 5 or 7**: tool schemas use the `inputSchema` field (never `parameters`); structured generation uses `generateObject({ model, schema, system, prompt, providerOptions: { openai: { structuredOutputs: false } } })` (DeepSeek rejects `json_schema` response_format — match `extraction.ts:107-118` verbatim). This codebase does NOT use `toDataStreamResponse` or `maxSteps`.
- **No emoji in code** (repo-wide convention). Chinese is allowed in user-facing strings, tool descriptions, and LLM prompts.
- **Test stack**: vitest. Run a single file with `npm test --workspace apps/server -- <path>`. Run all server tests with `npm test`.
- **Required order before claiming a task done**: `npm run build` then `npm run lint` then `npm test` (matches CI).
- **DB in tests**: `createDb(':memory:')` then `migrate(ctx.sqlite)`. Fixture files go under `env.INGEST_ROOT`. Unit tests import `env.ts` which zod-parses at import time; CI uses `OPENAI_API_KEY=ci-dummy-key` and tests never call the real model (reuse the `stubModel` pattern from `documentEntry.test.ts:26-55`).
- **SQLite default**: raw idempotent DDL in `db/client.ts` (the `migrate()` function); no drizzle-kit. Every new table/column uses the `CREATE TABLE IF NOT EXISTS` + guarded `ALTER TABLE` pattern already in `client.ts:39-137`. Add the new tables to the drizzle `schema.ts` too (the SQLite repo layer reads via drizzle for some tables; consistency).
- **Postgres path**: this phase is SQLite-only, matching Phase 1. New repository functions THROW on the postgres branch (`if (ctx.backend === 'postgres') throw new Error('...: postgres backend not yet implemented')`) — same as `loadExtraction` (`repositories.ts:119-121`). Do NOT add the new tables to `migratePostgres()` and do NOT touch `postgres-repositories.ts`.
- **userId isolation**: every new write stamps `effectiveUserId(userId)`; every new read filters with the legacy-tolerant `or(eq(t.userId, uid), eq(t.userId, ''), isNull(t.userId))` pattern when uid is non-empty (mirror `loadExtraction` `repositories.ts:122-129`).
- **Injection defense**: classification returns a `docType` from a CLOSED enum (not free text) and a numeric confidence — these are safe to return unwrapped (like `ingest_document`'s existing `output:'raw'` contract). Auto-tags are derived from a CLOSED keyword set, also safe. `tag_document` accepts agent/user free-text tags (treated as trusted agent input, like `bind_document`'s `contractNo` → injection `'safe'`, output `'raw'`).
- **Model handle reuse**: the classifier reuses the same DeepSeek handle as the agent loop (`resolvedModel` in `agent.ts:212-217`) — one client per turn, threaded via `HarnessDeps.classifier` exactly as `extraction` is threaded. In tests/offline, `classifier` is unset → `ingestFile` degrades to the hint `docType` with `source:'hint'`, confidence `1.0` (ingest still succeeds without any network).
- **Commit style**: conventional commits (`feat:`, `refactor:`, `test:`). Frequent commits, one logical change each.
- **docType contract change (locked decision)**: on `ingest_document`, `docType` becomes an OPTIONAL hint (`z.enum([...]).optional()`). Classification determines the effective `docType` written to the `documents` row and returned as `classifiedDocType`. This is the faithful reading of design §6 ("routing-classify picks which extraction schema to run"; "today docType is user-supplied at upload — this redesign adds classification"). The `/api/files` upload route (`files.ts:115-116`) is intentionally NOT changed this phase — it already passes a `docType` that becomes a hint automatically.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `apps/server/src/pipeline/classifier.ts` | L1 internal classifier primitive: parsed blocks (+ optional hint) → `{docType, confidence, source}`. LLM small model via `generateObject`; bounded input (~2000 chars); degrades to hint on no-model / LLM error. | **Create** |
| `apps/server/src/pipeline/tagging.ts` | L1 internal auto-tag primitive: `{docType, blocks}` → `string[]`. Deterministic keyword rules (no LLM); deduped + capped. | **Create** |
| `apps/server/src/pipeline/db/schema.ts` | Drizzle definitions for the new `classifications` + `documentTags` tables. | **Modify** |
| `apps/server/src/pipeline/db/client.ts` | Raw idempotent DDL (`migrate()`) for `classifications` + `document_tags` (+ indexes). | **Modify** |
| `apps/server/src/pipeline/db/repositories.ts` | `saveClassification`, `loadClassification`, `saveDocumentTags`, `listDocumentTags` (SQLite; throw on postgres). | **Modify** |
| `apps/server/src/pipeline/tools/documentEntry.ts` | `ingestFile`: insert classify + auto-tag stages, return classified info + tags. `buildIngestDocumentTool`: `docType` optional hint, pass `classifier` deps. Add `buildTagDocumentTool` (L2). `ToolDeps` + `IngestOptions` gain `classifier?`. | **Modify** |
| `apps/server/src/harness/roleToolRegistry.ts` | Register `tag_document` (L2, `needsApproval:true`); thread `classifier` into `buildIngestDocumentTool`; add `classifier?: ClassifierDeps` to `HarnessDeps`. | **Modify** |
| `apps/server/src/harness/permissionGate.ts` | `registerPermission('tag_document', 'L2')`. | **Modify** |
| `apps/server/src/harness/contextContract.ts` | Add `tag_document` contract; leave `ingest_document` contract as-is (return stays small + `raw`). | **Modify** |
| `apps/server/src/harness/agent.ts` | Wire `classifier: { model: resolvedModel }` into the `buildGatedTools` deps (one line, next to `extraction`). | **Modify** |
| `apps/server/test/pipeline/classifier.test.ts` | Tests for the classifier primitive (stub model + degrade paths). | **Create** |
| `apps/server/test/pipeline/tagging.test.ts` | Tests for the auto-tag primitive (deterministic rules). | **Create** |
| `apps/server/test/pipeline/tools/documentEntry.test.ts` | Extend: classification-determines-docType ingest test (stub classifier); auto-tags returned on ingest; `tag_document` adds explicit tags + rejects unknown doc. | **Modify** |

**Why two new files (`classifier.ts`, `tagging.ts`)**: both are L1 internal primitives reused only inside `ingestFile` today, but each has one clear responsibility and is independently testable without a DB — the same rationale that split `parseDocument.ts` out in Phase 1. Keeping them out of the already-271-line `documentEntry.ts` preserves focus.

**Why two new tables instead of columns on `documents`**: classification carries a confidence + a source + a timestamp (audit), and tags are multi-valued with a source discriminator (`auto` vs `explicit`). A column or a JSON blob would hide these from query/indexing. Dedicated tables mirror the existing `extractions` / `bindings` per-doc-fact convention exactly.

---

## Task 1: Classifier primitive (`classifyDocument`)

L1 internal stage: parsed blocks → `{ docType, confidence, source }`. No DB, no wiring. Mirrors `extraction.ts` (model injection via `ClassifierDeps`, `generateObject` with DeepSeek JSON mode). Degrades gracefully: no model → hint docType (`source:'hint'`); LLM error → hint docType (`source:'fallback'`, confidence 0).

**Files:**
- Create: `apps/server/src/pipeline/classifier.ts`
- Create: `apps/server/test/pipeline/classifier.test.ts`

**Interfaces:**
- Consumes: `Block`, `DocType` from `pipeline/types.js`; `generateObject`, `LanguageModel` from `'ai'`; `z` from `'zod'`.
- Produces:
  - `ClassifierDeps = { model: LanguageModel }`
  - `ClassifierInput = { blocks: Block[]; hint?: DocType }`
  - `ClassifierResult = { docType: DocType; confidence: number; source: 'classified' | 'hint' | 'fallback' }`
  - `classifyDocument(deps: ClassifierDeps, input: ClassifierInput): Promise<ClassifierResult>`

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/pipeline/classifier.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { Block, DocType } from '../../src/pipeline/types.js';
import { classifyDocument } from '../../src/pipeline/classifier.js';

// Reuse the stub-model seam from documentEntry.test.ts. Its doGenerate returns
// JSON that generateObject parses against the classifier zod schema.
function stubModel(returnObject: unknown) {
  return {
    specificationVersion: 'v2' as const,
    provider: 'fake',
    modelId: 'fake-model',
    supportedUrls: {} as Record<string, RegExp[]>,
    async doGenerate() {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(returnObject) }],
        finishReason: 'stop' as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [] as unknown[],
      };
    },
    async doStream() {
      throw new Error('doStream not used by classifyDocument');
    },
  } as any;
}

const blocks = (text: string): Block[] => [
  { id: 'b0', type: 'text', text, page: 1, bbox: null, ocrConfidence: 1 },
];

describe('classifyDocument', () => {
  it('returns the LLM-classified docType + confidence', async () => {
    const model = stubModel({ docType: '发票', confidence: 0.93 });
    const res = await classifyDocument(
      { model },
      { blocks: blocks('这是发票号码 INV-001 的文档'), hint: '其他' },
    );
    expect(res.docType).toBe('发票');
    expect(res.confidence).toBeCloseTo(0.93, 5);
    expect(res.source).toBe('classified');
  });

  it('clamps out-of-range confidence into 0..1', async () => {
    const model = stubModel({ docType: '合同', confidence: 1.4 });
    const res = await classifyDocument({ model }, { blocks: blocks('x'), hint: '其他' });
    expect(res.confidence).toBeLessThanOrEqual(1);
    expect(res.confidence).toBeGreaterThanOrEqual(0);
  });

  it('falls back to the hint docType when the LLM output is unparseable', async () => {
    const model = stubModel({ notTheShape: true }); // fails zod parse
    const res = await classifyDocument(
      { model },
      { blocks: blocks('文本'), hint: '合同' as DocType },
    );
    expect(res.docType).toBe('合同');
    expect(res.source).toBe('fallback');
    expect(res.confidence).toBe(0);
  });

  it('returns hint docType with source "hint" when the model is absent', async () => {
    // No ClassifierDeps passed in — simulate the offline-degrade path used by
    // ingestFile when no classifier model is wired.
    // classifyDocumentWithoutModel is the degrade helper exported alongside.
    const { classifyDocumentWithoutModel } = await import('../../src/pipeline/classifier.js');
    const res = classifyDocumentWithoutModel({ blocks: blocks('x'), hint: '提单' });
    expect(res.docType).toBe('提单');
    expect(res.source).toBe('hint');
    expect(res.confidence).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace apps/server -- test/pipeline/classifier.test.ts`
Expected: FAIL — `Cannot find module '../../src/pipeline/classifier.js'`.

- [ ] **Step 3: Create `classifier.ts`**

Create `apps/server/src/pipeline/classifier.ts`:

```ts
import { generateObject, type LanguageModel } from 'ai';
import { z } from 'zod';
import type { Block, DocType } from './types.js';

/** Injected small-model handle (same seam as ExtractionDeps). */
export interface ClassifierDeps {
  model: LanguageModel;
}

export interface ClassifierInput {
  blocks: Block[];
  /** Caller-supplied best guess; used verbatim when no model is wired or the
   *  LLM call fails. Defaults to '其他' when undefined. */
  hint?: DocType;
}

export interface ClassifierResult {
  docType: DocType;
  confidence: number;
  /** 'classified' = LLM decided; 'hint' = no model, used the hint; 'fallback' =
   *  LLM errored / unparseable, fell back to the hint at confidence 0. */
  source: 'classified' | 'hint' | 'fallback';
}

const DOC_TYPES = ['合同', '发票', '提单', '装箱单', '其他'] as const;
const ClassifierSchema = z.object({
  docType: z.enum(DOC_TYPES),
  confidence: z.number().min(0).max(1),
});

const CLASSIFIER_PROMPT = [
  '你是供应链单据分类器。只依据给定原文判断这份单据属于哪一类。',
  '类别取值固定为五种之一: 合同 / 发票 / 提单 / 装箱单 / 其他。',
  'confidence 是你对本次分类的自评置信度 (0..1); 不确定就给较低值。',
  '严禁凭空臆造原文中不存在的单据类型信号。',
  '严格以 JSON 格式输出, 不要包含任何注释或解释文字。',
  '输出结构: {"docType": "发票", "confidence": 0.93}',
].join('\n');

const MAX_CLASSIFY_CHARS = 2000;

/** Bounded blocks->prompt: join block texts, cap at MAX_CLASSIFY_CHARS. */
function blocksToPrompt(blocks: Block[]): string {
  const text = blocks.map((b) => b.text).join('\n').slice(0, MAX_CLASSIFY_CHARS);
  return `原文片段:\n${text}`;
}

const clamp = (n: number) => Math.max(0, Math.min(1, n));

/**
 * L1 internal classification stage. Routing-classify: parsed blocks -> docType.
 * Uses the injected small model via DeepSeek-compatible JSON mode
 * (structuredOutputs:false, same as extraction.ts). On LLM error or schema
 * mismatch, degrades to the hint docType at confidence 0 (source 'fallback') so
 * ingest never hard-fails on classification.
 */
export async function classifyDocument(
  deps: ClassifierDeps,
  input: ClassifierInput,
): Promise<ClassifierResult> {
  const hint: DocType = input.hint ?? '其他';
  try {
    const { object } = await generateObject({
      model: deps.model,
      schema: ClassifierSchema,
      system: CLASSIFIER_PROMPT,
      prompt: blocksToPrompt(input.blocks),
      // DeepSeek rejects response_format=json_schema; force JSON object mode +
      // schema-in-prompt (no-op for providers that ignore providerOptions.openai).
      providerOptions: { openai: { structuredOutputs: false } },
    });
    return { docType: object.docType, confidence: clamp(object.confidence), source: 'classified' };
  } catch {
    return { docType: hint, confidence: 0, source: 'fallback' };
  }
}

/**
 * Offline degrade path used by ingestFile when no classifier model is wired
 * (tests, dev without a model). Returns the hint docType verbatim at confidence
 * 1 with source 'hint' so downstream stages see a confident, usable docType.
 */
export function classifyDocumentWithoutModel(input: ClassifierInput): ClassifierResult {
  return { docType: input.hint ?? '其他', confidence: 1, source: 'hint' };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test --workspace apps/server -- test/pipeline/classifier.test.ts`
Expected: PASS — all four cases.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/pipeline/classifier.ts apps/server/test/pipeline/classifier.test.ts
git commit -m "feat: add classifyDocument LLM small-model classifier primitive"
```

---

## Task 2: Persist classification + wire routing-classify into `ingest_document`

Add the `classifications` table, the repository functions, and the classify stage in `ingestFile`. `ingest_document`'s `docType` becomes an optional hint; the classified `docType` is written to the `documents` row (via `blockModel.docType`) and returned with its confidence + source. `ToolDeps` / `IngestOptions` gain an optional `classifier`.

**Files:**
- Modify: `apps/server/src/pipeline/db/schema.ts` (add `classifications`)
- Modify: `apps/server/src/pipeline/db/client.ts` (`migrate()` DDL)
- Modify: `apps/server/src/pipeline/db/repositories.ts` (`saveClassification`, `loadClassification`)
- Modify: `apps/server/src/pipeline/tools/documentEntry.ts` (`ingestFile`, `buildIngestDocumentTool`, `ToolDeps`, `IngestOptions`)
- Modify: `apps/server/test/pipeline/tools/documentEntry.test.ts`

**Interfaces:**
- Consumes: `classifyDocument` / `classifyDocumentWithoutModel` / `ClassifierDeps` from Task 1; existing `parseDocument`, `saveDocument`, `ensureFk`.
- Produces:
  - `classifications` table: `{ id PK, document_id FK, doc_type, confidence REAL, source, hint, user_id, created_at }`.
  - `saveClassification(ctx, input, userId?) → Promise<string>`; `loadClassification(ctx, docId, userId?) → Promise<ClassificationRow | null>`.
  - `ingestFile` return gains `{ classifiedDocType, classificationConfidence, classificationSource }`; `IngestOptions` gains `classifier?: ClassifierDeps`; `docType` becomes optional.

- [ ] **Step 1: Write the failing test**

Append to `apps/server/test/pipeline/tools/documentEntry.test.ts` (inside the existing `describe`, reusing the `beforeEach` `ctx`/`dir` and the `stubModel` helper at top of file). Also add a `stubClassifierModel` local helper for the classify schema. Add imports at the top:

```ts
import {
  buildIngestDocumentTool, buildExtractFieldsTool, buildBindDocumentTool, buildInspectExtractionTool,
  buildTagDocumentTool,
} from '../../../src/pipeline/tools/documentEntry.js';
```

(Add `buildTagDocumentTool` now — Task 5 defines it; leaving it out would make Task 5's import edit larger. If this creates a temp unresolved import error before Task 5 lands, that is fine because the test below does not reference it. Oxlint does not fail the build on unused imports, but to keep the suite green between tasks, add the import in Task 5 instead. **For this task, do NOT add `buildTagDocumentTool` to the import** — add only the four already-imported names remain; the import line above is unchanged from the existing file. Disregard the import line shown; keep the existing import.)

Append the test:

```ts
// Stub model whose doGenerate returns classifier-schema JSON (docType + confidence).
const stubClassifierModel = {
  specificationVersion: 'v2' as const,
  provider: 'fake',
  modelId: 'fake-model',
  supportedUrls: {} as Record<string, RegExp[]>,
  async doGenerate() {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ docType: '合同', confidence: 0.88 }),
        },
      ],
      finishReason: 'stop' as const,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      warnings: [] as unknown[],
    };
  },
  async doStream() {
    throw new Error('doStream not used by classify');
  },
} as any;

it('ingest_document classifies docType and overrides the hint, persisting the result', async () => {
  const f = join(dir, 'contract.txt');
  writeFileSync(f, '合同号：HT-2024-001\n买方：示例公司\n卖方：另一方公司\n', 'utf-8');
  // Pass an intentionally-wrong hint ('其他'); the classifier should override to '合同'.
  const ingest = buildIngestDocumentTool({
    ctx,
    classifier: { model: stubClassifierModel } as any,
  });
  const res: any = await ingest.execute(
    { sourceUri: f, docType: '其他', modality: 'digital' },
    { messages: [], toolCallId: 't', abortSignal: undefined as any } as any,
  );
  expect(res.docId).toBeDefined();
  expect(res.classifiedDocType).toBe('合同');
  expect(res.classificationConfidence).toBeCloseTo(0.88, 5);
  expect(res.classificationSource).toBe('classified');

  // The classified docType is what the documents row stores.
  const { loadDocument, loadClassification } = await import(
    '../../../src/pipeline/db/repositories.js'
  );
  const model = await loadDocument(ctx, res.docId);
  expect(model?.docType).toBe('合同');
  const cls = await loadClassification(ctx, res.docId);
  expect(cls?.docType).toBe('合同');
  expect(cls?.confidence).toBeCloseTo(0.88, 5);
  expect(cls?.source).toBe('classified');
  expect(cls?.hint).toBe('其他');
});

it('ingest_document degrades to the hint docType when no classifier is wired', async () => {
  const f = join(dir, 'bill.txt');
  writeFileSync(f, '提单号：BL-9\n', 'utf-8');
  const ingest = buildIngestDocumentTool({ ctx }); // no classifier
  const res: any = await ingest.execute(
    // docType omitted -> hint defaults to '其他'
    { sourceUri: f, modality: 'digital' },
    { messages: [], toolCallId: 't', abortSignal: undefined as any } as any,
  );
  expect(res.classifiedDocType).toBe('其他');
  expect(res.classificationSource).toBe('hint');
  expect(res.classificationConfidence).toBe(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace apps/server -- test/pipeline/tools/documentEntry.test.ts`
Expected: FAIL — `buildIngestDocumentTool` does not accept `classifier`; `loadClassification` does not exist; `classifiedDocType` is `undefined`.

- [ ] **Step 3: Add the `classifications` table to `schema.ts`**

In `apps/server/src/pipeline/db/schema.ts`, after the `bindings` table definition (line ~61), add:

```ts
/**
 * Phase 2 classification: one row per document ingest. The classified docType is
 * ALSO written to documents.doc_type (so loadDocument reflects it); this row
 * carries the confidence + source + the caller's hint for audit. source:
 * 'classified' = LLM decided; 'hint' = no model; 'fallback' = LLM errored.
 */
export const classifications = sqliteTable(
  'classifications',
  {
    id: text('id').primaryKey(),
    documentId: text('document_id').notNull().references(() => documents.id),
    docType: text('doc_type').notNull(),
    confidence: real('confidence').notNull(),
    source: text('source').notNull(),
    hint: text('hint'),
    userId: text('user_id').notNull().default(''),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (t) => ({ docIdx: index('idx_classifications_doc').on(t.documentId) }),
);
```

- [ ] **Step 4: Add the raw DDL to `client.ts`**

In `apps/server/src/pipeline/db/client.ts`:

1. Update the drizzle `createDb` schema map (line ~34) to include the new table:
```ts
import { documents, extractions, bindings, fileFolders, classifications } from './schema.js';
// ...
const db = drizzle(sqlite, { schema: { documents, extractions, bindings, fileFolders, classifications } });
```

2. Inside the `migrate()` `sqlite.exec(...)` template (after the `bindings` block, before `file_folders`), add:
```sql
    CREATE TABLE IF NOT EXISTS classifications (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES documents(id),
      doc_type TEXT NOT NULL,
      confidence REAL NOT NULL,
      source TEXT NOT NULL,
      hint TEXT,
      user_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_classifications_doc ON classifications(document_id);
    CREATE INDEX IF NOT EXISTS idx_classifications_user ON classifications(user_id);
```

- [ ] **Step 5: Add `saveClassification` + `loadClassification` to `repositories.ts`**

In `apps/server/src/pipeline/db/repositories.ts`:

1. Add `classifications` to the schema import (line ~2):
```ts
import { documents, extractions, bindings, classifications } from './schema.js';
```

2. After `loadExtraction` (line ~140), add the types + functions (mirror the `loadExtraction` userId-legacy filter exactly):

```ts
export interface ClassificationInput {
  documentId: string;
  docType: DocType;
  confidence: number;
  source: 'classified' | 'hint' | 'fallback';
  hint?: DocType;
}

export interface ClassificationRow {
  id: string;
  documentId: string;
  docType: DocType;
  confidence: number;
  source: string;
  hint: DocType | null;
}

/** Persist one classification result for a document (one row per ingest). */
export async function saveClassification(
  ctx: DbContext,
  input: ClassificationInput,
  userId?: string,
): Promise<string> {
  if (ctx.backend === 'postgres') {
    throw new Error('saveClassification: postgres backend not yet implemented');
  }
  const id = rid('CL');
  ctx.db.insert(classifications).values({
    id,
    documentId: input.documentId,
    docType: input.docType,
    confidence: input.confidence,
    source: input.source,
    hint: input.hint ?? null,
    userId: effectiveUserId(userId),
  }).run();
  return id;
}

/**
 * Load the classification row for a document (most recent if multiple). Same
 * userId-legacy filter as loadExtraction (rows with user_id = '' / NULL stay
 * readable by any caller). Postgres path stubbed -- Phase 2 is SQLite-only.
 */
export async function loadClassification(
  ctx: DbContext,
  documentId: string,
  userId?: string,
): Promise<ClassificationRow | null> {
  if (ctx.backend === 'postgres') {
    throw new Error('loadClassification: postgres backend not yet implemented');
  }
  const uid = effectiveUserId(userId);
  const filter = uid
    ? and(
        eq(classifications.documentId, documentId),
        or(eq(classifications.userId, uid), eq(classifications.userId, ''), isNull(classifications.userId)),
      )
    : eq(classifications.documentId, documentId);
  const row = ctx.db
    .select()
    .from(classifications)
    .where(filter)
    .orderBy(classifications.createdAt)
    .all()
    .pop();
  if (!row) return null;
  return {
    id: row.id,
    documentId: row.documentId,
    docType: row.docType as DocType,
    confidence: row.confidence,
    source: row.source,
    hint: (row.hint as DocType | null) ?? null,
  };
}
```

(`rid` is already defined at `repositories.ts:61`; `effectiveUserId`, `and`, `or`, `eq`, `isNull`, `DocType` are all already imported.)

- [ ] **Step 6: Wire the classify stage into `ingestFile` + `buildIngestDocumentTool`**

In `apps/server/src/pipeline/tools/documentEntry.ts`:

1. Add imports near the top:
```ts
import { classifyDocument, classifyDocumentWithoutModel, type ClassifierDeps } from '../classifier.js';
import { saveClassification } from '../db/repositories.js';
```
(Add `saveClassification` to the existing `../db/repositories.js` import line rather than a second import line — merge it into the destructured import at line 5-7.)

2. Extend `ToolDeps` (line ~18) — add the optional classifier:
```ts
export interface ToolDeps {
  ctx: DbContext;
  extraction?: ExtractionDeps;
  /** Phase 2 routing-classify stage. When unset, ingest degrades to the
   *  caller-supplied docType hint (source 'hint', confidence 1). */
  classifier?: ClassifierDeps;
  embedder?: Embedder;
  userId?: string;
}
```

3. Extend `IngestOptions` (line ~49) — make `docType` optional + add `classifier`:
```ts
export interface IngestOptions {
  ctx: DbContext;
  sourcePath: string;
  /** Caller hint. Classification determines the effective docType when a
   *  classifier is wired; otherwise this hint is used directly. Defaults to '其他'. */
  docType?: DocType;
  modality: Modality;
  classifier?: ClassifierDeps;
  embedder?: Embedder;
  userId?: string;
}
```

4. Rewrite the `ingestFile` signature + the parse→persist head (lines 59-72). The new body inserts the classify stage right after parse, mutates `blockModel.docType` to the classified type, persists the classification row, and returns the enriched shape. Replace lines 59-90 entirely with:

```ts
export async function ingestFile(opts: IngestOptions): Promise<{
  docId: string;
  blockCount: number;
  modality: string;
  classifiedDocType: DocType;
  classificationConfidence: number;
  classificationSource: 'classified' | 'hint' | 'fallback';
}> {
  const { ctx, sourcePath, docType, modality, embedder, classifier, userId } = opts;
  ensureFk(ctx);
  // Path allowlist (injection defense): reject anything outside INGEST_ROOT.
  const safePath = assertWithinRoot(sourcePath);
  const docId = newDocId();
  // Parse (pure, no DB) — extracted into parseDocument primitive (Phase 1).
  const blockModel = await parseDocument({ sourcePath: safePath, docType: docType ?? '其他', docId, modality });

  // Classify (Phase 2 routing-classify): parsed blocks -> effective docType.
  // Degrades to the hint when no classifier is wired (tests / dev offline).
  const cls = classifier
    ? await classifyDocument(classifier, { blocks: blockModel.blocks, hint: docType })
    : classifyDocumentWithoutModel({ blocks: blockModel.blocks, hint: docType });
  // The classified docType is the source of truth from here on (design §6:
  // routing-classify picks the docType used downstream).
  blockModel.docType = cls.docType;

  await saveDocument(ctx, blockModel, userId);
  await saveClassification(
    ctx,
    { documentId: docId, docType: cls.docType, confidence: cls.confidence, source: cls.source, hint: docType },
    userId,
  );
  const chunks = chunkBlockModel(blockModel);
  const chunkRowIds = await saveChunks(ctx, docId, chunks);
  if (embedder && (await isVecReady(ctx))) {
    try {
      const vecs = await embedder.embed(chunks.map((c) => c.text));
      await saveChunkVectors(
        ctx,
        chunkRowIds.map((id, i) => ({ chunkRowId: id, vec: vecs[i] ?? [] })),
      );
    } catch (e) {
      console.warn(
        '[ingest] vector embedding skipped; FTS5 recall still available:',
        (e as Error).message,
      );
    }
  }
  return {
    docId,
    blockCount: blockModel.blocks.length,
    modality: blockModel.modality,
    classifiedDocType: cls.docType,
    classificationConfidence: cls.confidence,
    classificationSource: cls.source,
  };
}
```

5. Update `buildIngestDocumentTool` (lines 92-112) — `docType` becomes an optional hint, and `classifier` is threaded from `deps`:

```ts
export function buildIngestDocumentTool(deps: ToolDeps) {
  return tool({
    description:
      '录入一份原始单据(合同/发票/提单/装箱单)。解析文件为结构化 BlockModel 并持久化, ' +
      '内置分类器自动判定单据类型(docType 为可选提示, 分类器会确认或纠正)并打自动标签, ' +
      '返回 docId、分类结果(classifiedDocType / confidence / source)与标签。不抽取业务字段(用 extract_fields)。',
    inputSchema: z.object({
      sourceUri: z.string().min(1).describe('本地文件路径 (PDF/TXT/DOCX); scanned 还需配套 <sourceUri>.mineru.json'),
      docType: z.enum(['合同', '发票', '提单', '装箱单', '其他']).optional()
        .describe('可选的单据类型提示; 分类器会确认或纠正。省略时由分类器决定'),
      modality: z.enum(['digital', 'scanned']),
    }),
    execute: async ({ sourceUri, docType, modality }) => {
      return ingestFile({
        ctx: deps.ctx,
        sourcePath: sourceUri,
        docType: docType as DocType | undefined,
        modality: modality as Modality,
        classifier: deps.classifier,
        embedder: deps.embedder,
        userId: deps.userId,
      });
    },
  });
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm test --workspace apps/server -- test/pipeline/tools/documentEntry.test.ts`
Expected: PASS — both new classification tests pass; all prior tests still pass (the `docType` arg in older tests still works as a hint).

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/pipeline/db/schema.ts apps/server/src/pipeline/db/client.ts apps/server/src/pipeline/db/repositories.ts apps/server/src/pipeline/tools/documentEntry.ts apps/server/test/pipeline/tools/documentEntry.test.ts
git commit -m "feat: add classification stage + classifications table to ingest_document"
```

---

## Task 3: Auto-tag primitive (`deriveAutoTags`)

L1 internal stage: `{ docType, blocks }` → `string[]`. Deterministic keyword rules (no LLM). Deduped, capped at 8 tags.

**Files:**
- Create: `apps/server/src/pipeline/tagging.ts`
- Create: `apps/server/test/pipeline/tagging.test.ts`

**Interfaces:**
- Consumes: `Block`, `DocType` from `pipeline/types.js`.
- Produces: `deriveAutoTags(input: { docType: DocType; blocks: Block[] }): string[]`.

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/pipeline/tagging.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { Block, DocType } from '../../src/pipeline/types.js';
import { deriveAutoTags } from '../../src/pipeline/tagging.js';

const blk = (text: string): Block[] => [
  { id: 'b0', type: 'text', text, page: 1, bbox: null, ocrConfidence: 1 },
];

describe('deriveAutoTags', () => {
  it('always includes the docType as the first tag', () => {
    const tags = deriveAutoTags({ docType: '合同' as DocType, blocks: blk('任意内容') });
    expect(tags[0]).toBe('合同');
  });

  it('adds keyword-matched tags from the content', () => {
    const tags = deriveAutoTags({
      docType: '合同' as DocType,
      blocks: blk('本合同采用信用证结算，含 CIF 条款'),
    });
    expect(tags).toContain('合同');
    expect(tags).toContain('信用证');
    expect(tags).toContain('CIF');
  });

  it('dedupes and does not repeat the docType if also keyword-matched', () => {
    const tags = deriveAutoTags({
      docType: '发票' as DocType,
      blocks: blk('发票号 INV-001，发票金额 100'),
    });
    const dupes = tags.filter((t) => t === '发票');
    expect(dupes.length).toBe(1);
  });

  it('caps the tag list at 8 entries', () => {
    // Craft content that hits many keyword rules at once.
    const text = '信用证 CIF FOB 提单 装箱单 发票 合同 港口 重量 检验';
    const tags = deriveAutoTags({ docType: '其他' as DocType, blocks: blk(text) });
    expect(tags.length).toBeLessThanOrEqual(8);
  });

  it('returns at least the docType for empty content', () => {
    const tags = deriveAutoTags({ docType: '提单' as DocType, blocks: blk('') });
    expect(tags).toEqual(['提单']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace apps/server -- test/pipeline/tagging.test.ts`
Expected: FAIL — `Cannot find module '../../src/pipeline/tagging.js'`.

- [ ] **Step 3: Create `tagging.ts`**

Create `apps/server/src/pipeline/tagging.ts`:

```ts
import type { Block, DocType } from './types.js';

/**
 * L1 internal auto-tag stage. Derives a small, deterministic tag set from the
 * docType + content keywords. No LLM (cheap, reproducible). Tags are a CLOSED
 * set drawn from AUTO_TAG_KEYWORDS below, so they are safe to surface unwrapped
 * (no injection risk). Design §8: auto-tags are an internal byproduct of
 * ingest_document, persisted, and included in the return summary.
 */
const AUTO_TAG_KEYWORDS: ReadonlyArray<{ tag: string; keywords: string[] }> = [
  { tag: '信用证', keywords: ['信用证', 'L/C', 'LC'] },
  { tag: 'CIF', keywords: ['CIF', 'cif'] },
  { tag: 'FOB', keywords: ['FOB', 'fob'] },
  { tag: '电汇', keywords: ['电汇', 'T/T', 'TT'] },
  { tag: '提单', keywords: ['提单', 'B/L', 'Bill of Lading'] },
  { tag: '装箱单', keywords: ['装箱单', 'Packing List'] },
  { tag: '发票', keywords: ['发票', 'Invoice'] },
  { tag: '合同', keywords: ['合同', 'Contract'] },
  { tag: '港口', keywords: ['港口', '装运港', '目的港', 'PORT'] },
  { tag: '重量', keywords: ['重量', '吨', '公斤', 'kg', 'ton'] },
  { tag: '检验', keywords: ['检验', '质检', '商检', 'Inspection'] },
];

const MAX_AUTO_TAGS = 8;

export function deriveAutoTags(input: { docType: DocType; blocks: Block[] }): string[] {
  const text = input.blocks.map((b) => b.text).join('\n');
  const tags: string[] = [input.docType];
  for (const { tag, keywords } of AUTO_TAG_KEYWORDS) {
    if (tags.length >= MAX_AUTO_TAGS) break;
    if (keywords.some((k) => text.includes(k))) {
      if (!tags.includes(tag)) tags.push(tag);
    }
  }
  return tags.slice(0, MAX_AUTO_TAGS);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test --workspace apps/server -- test/pipeline/tagging.test.ts`
Expected: PASS — all five cases.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/pipeline/tagging.ts apps/server/test/pipeline/tagging.test.ts
git commit -m "feat: add deriveAutoTags deterministic auto-tag primitive"
```

---

## Task 4: Persist tags + wire auto-tag into `ingest_document`

Add the `document_tags` table + repository functions, then run `deriveAutoTags` at the tail of `ingestFile` and include the tags in the return.

**Files:**
- Modify: `apps/server/src/pipeline/db/schema.ts` (add `documentTags`)
- Modify: `apps/server/src/pipeline/db/client.ts` (`migrate()` DDL)
- Modify: `apps/server/src/pipeline/db/repositories.ts` (`saveDocumentTags`, `listDocumentTags`)
- Modify: `apps/server/src/pipeline/tools/documentEntry.ts` (`ingestFile` tail + return)
- Modify: `apps/server/test/pipeline/tools/documentEntry.test.ts`

**Interfaces:**
- Consumes: `deriveAutoTags` from Task 3.
- Produces:
  - `document_tags` table: `{ id PK, document_id FK, tag, source ('auto'|'explicit'), user_id, created_at }`.
  - `saveDocumentTags(ctx, documentId, tags, source, userId?) → Promise<void>`; `listDocumentTags(ctx, documentId, userId?) → Promise<{tag, source}[]>`.
  - `ingestFile` return gains `tags: string[]`.

- [ ] **Step 1: Write the failing test**

Append to `apps/server/test/pipeline/tools/documentEntry.test.ts`:

```ts
it('ingest_document persists + returns auto-derived tags', async () => {
  const f = join(dir, 'contract-lc.txt');
  writeFileSync(f, '合同号：HT-2024-001\n本合同采用信用证（L/C）结算，条款 CIF\n', 'utf-8');
  const ingest = buildIngestDocumentTool({ ctx }); // no classifier -> docType hint '其他'
  // Supply docType hint '合同' so auto-tag seeds with '合同' even without a classifier.
  const res: any = await ingest.execute(
    { sourceUri: f, docType: '合同', modality: 'digital' },
    { messages: [], toolCallId: 't', abortSignal: undefined as any } as any,
  );
  expect(Array.isArray(res.tags)).toBe(true);
  expect(res.tags.length).toBeGreaterThan(0);
  expect(res.tags).toContain('合同');
  expect(res.tags).toContain('信用证');

  const { listDocumentTags } = await import('../../../src/pipeline/db/repositories.js');
  const rows = await listDocumentTags(ctx, res.docId);
  const autoTags = rows.filter((r) => r.source === 'auto').map((r) => r.tag);
  expect(autoTags).toContain('合同');
  expect(autoTags).toContain('信用证');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace apps/server -- test/pipeline/tools/documentEntry.test.ts`
Expected: FAIL — `res.tags` is `undefined`; `listDocumentTags` does not exist.

- [ ] **Step 3: Add the `documentTags` table to `schema.ts`**

In `apps/server/src/pipeline/db/schema.ts`, after the `classifications` table (added in Task 2), add:

```ts
/**
 * Phase 2 tags. Two sources (design §8): 'auto' = derived inside ingest_document
 * (byproduct); 'explicit' = added via the tag_document L2 tool by user/agent.
 * Graph edges are NOT tags (they live in the graph layer, Step 4).
 */
export const documentTags = sqliteTable(
  'document_tags',
  {
    id: text('id').primaryKey(),
    documentId: text('document_id').notNull().references(() => documents.id),
    tag: text('tag').notNull(),
    source: text('source').notNull(), // 'auto' | 'explicit'
    userId: text('user_id').notNull().default(''),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (t) => ({
    docIdx: index('idx_document_tags_doc').on(t.documentId),
    userIdx: index('idx_document_tags_user').on(t.userId),
  }),
);
```

- [ ] **Step 4: Add the raw DDL to `client.ts`**

In `apps/server/src/pipeline/db/client.ts`:

1. Update the drizzle `createDb` schema map + import to include `documentTags`:
```ts
import { documents, extractions, bindings, fileFolders, classifications, documentTags } from './schema.js';
// ...
const db = drizzle(sqlite, { schema: { documents, extractions, bindings, fileFolders, classifications, documentTags } });
```

2. Inside `migrate()`'s `sqlite.exec(...)` (after the `classifications` DDL from Task 2), add:
```sql
    CREATE TABLE IF NOT EXISTS document_tags (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES documents(id),
      tag TEXT NOT NULL,
      source TEXT NOT NULL,
      user_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_document_tags_doc ON document_tags(document_id);
    CREATE INDEX IF NOT EXISTS idx_document_tags_user ON document_tags(user_id);
```

- [ ] **Step 5: Add `saveDocumentTags` + `listDocumentTags` to `repositories.ts`**

In `apps/server/src/pipeline/db/repositories.ts`:

1. Add `documentTags` to the schema import:
```ts
import { documents, extractions, bindings, classifications, documentTags } from './schema.js';
```

2. After `loadClassification` (added in Task 2), add:

```ts
export type DocumentTagSource = 'auto' | 'explicit';

export interface DocumentTagRow {
  tag: string;
  source: DocumentTagSource;
}

/**
 * Persist tag rows for a document with the given source. Idempotent per
 * (document, tag, source, user): a UNIQUE collision is skipped so re-ingesting
 * or re-calling tag_document with the same tag does not duplicate rows.
 */
export async function saveDocumentTags(
  ctx: DbContext,
  documentId: string,
  tags: string[],
  source: DocumentTagSource,
  userId?: string,
): Promise<void> {
  if (ctx.backend === 'postgres') {
    throw new Error('saveDocumentTags: postgres backend not yet implemented');
  }
  const uid = effectiveUserId(userId);
  // De-dup against existing rows with the same (document, tag, source, user).
  const existing = ctx.sqlite
    .prepare(
      `SELECT tag FROM document_tags
       WHERE document_id = ? AND source = ? AND (user_id = ? OR user_id = '')`,
    )
    .all(documentId, source, uid) as Array<{ tag: string }>;
  const have = new Set(existing.map((r) => r.tag));
  const tx = ctx.sqlite.transaction((rows: string[]) => {
    for (const tag of rows) {
      if (have.has(tag)) continue;
      const id = rid('TG');
      ctx.sqlite
        .prepare(
          `INSERT INTO document_tags (id, document_id, tag, source, user_id) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(id, documentId, tag, source, uid);
    }
  });
  tx(tags);
}

/**
 * List all tags for a document (both sources), tag ascending. Same userId-legacy
 * filter as loadExtraction. Postgres path stubbed -- Phase 2 is SQLite-only.
 */
export async function listDocumentTags(
  ctx: DbContext,
  documentId: string,
  userId?: string,
): Promise<DocumentTagRow[]> {
  if (ctx.backend === 'postgres') {
    throw new Error('listDocumentTags: postgres backend not yet implemented');
  }
  const uid = effectiveUserId(userId);
  const rows = uid
    ? ctx.sqlite
        .prepare(
          `SELECT tag, source FROM document_tags
           WHERE document_id = ? AND (user_id = ? OR user_id = '' OR user_id IS NULL)
           ORDER BY tag ASC`,
        )
        .all(documentId, uid) as Array<{ tag: string; source: string }>
    : ctx.sqlite
        .prepare(`SELECT tag, source FROM document_tags WHERE document_id = ? ORDER BY tag ASC`)
        .all(documentId) as Array<{ tag: string; source: string }>;
  return rows.map((r) => ({ tag: r.tag, source: r.source as DocumentTagSource }));
}
```

(`rid` is defined at `repositories.ts:61`; `effectiveUserId` is defined at line 29.)

- [ ] **Step 6: Wire auto-tag into `ingestFile` + return**

In `apps/server/src/pipeline/tools/documentEntry.ts`:

1. Add imports (merge `saveDocumentTags` into the existing `../db/repositories.js` destructure; add the tagging import):
```ts
import { deriveAutoTags } from '../tagging.js';
```
(and add `saveDocumentTags` to the repositories import destructure at lines 5-7).

2. In the `ingestFile` return block, compute + persist auto-tags just before returning. Insert this immediately before the `return { ... }` at the end of `ingestFile` (after the vector block), and add `tags` to the return:

```ts
  // Auto-tag (Phase 2): derive a small deterministic tag set from the effective
  // docType + content (design §8: auto-tags are an ingest byproduct, persisted
  // and included in the return summary). Explicit tags come from tag_document.
  const tags = deriveAutoTags({ docType: blockModel.docType, blocks: blockModel.blocks });
  await saveDocumentTags(ctx, docId, tags, 'auto', userId);

  return {
    docId,
    blockCount: blockModel.blocks.length,
    modality: blockModel.modality,
    classifiedDocType: cls.docType,
    classificationConfidence: cls.confidence,
    classificationSource: cls.source,
    tags,
  };
```

Update the `ingestFile` return TYPE annotation (the `Promise<{ ... }>` at the top of the function) to include `tags: string[]`.

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm test --workspace apps/server -- test/pipeline/tools/documentEntry.test.ts`
Expected: PASS — the auto-tags test passes; all prior tests still pass.

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/pipeline/db/schema.ts apps/server/src/pipeline/db/client.ts apps/server/src/pipeline/db/repositories.ts apps/server/src/pipeline/tools/documentEntry.ts apps/server/test/pipeline/tools/documentEntry.test.ts
git commit -m "feat: add auto-tag stage + document_tags table to ingest_document"
```

---

## Task 5: `tag_document` L2 tool + harness wiring (classifier deps live)

Add the explicit-tagging L2 tool, register it across the harness (registry / permission / contract), and wire `classifier` through `HarnessDeps` + `agent.ts` so classification actually runs in production. Until this task, `buildIngestDocumentTool` is constructed without `classifier` in the registry, so ingest degrades to the hint — this task makes the real model flow.

**Files:**
- Modify: `apps/server/src/pipeline/tools/documentEntry.ts` (add `buildTagDocumentTool`)
- Modify: `apps/server/src/harness/roleToolRegistry.ts` (register `tag_document`; thread `classifier`)
- Modify: `apps/server/src/harness/permissionGate.ts` (register `tag_document` = L2)
- Modify: `apps/server/src/harness/contextContract.ts` (add `tag_document` contract)
- Modify: `apps/server/src/harness/agent.ts` (wire `classifier` into deps)
- Modify: `apps/server/test/pipeline/tools/documentEntry.test.ts` (tag_document tests)

**Interfaces:**
- Consumes: `saveDocumentTags`, `listDocumentTags`, `loadDocument` from Task 4 + existing repos; `tagExternal` (not applied — tags are agent-supplied trusted input, like `bind_document.contractNo`).
- Produces: `buildTagDocumentTool(deps: ToolDeps)` → AI SDK 6 tool, `inputSchema: { docId, tags: string[] }`, `needsApproval: true` (L2), returns `{ status, docId, addedTags, totalTags }` or `{ status:'error', reason }`.

- [ ] **Step 1: Write the failing test**

Append to `apps/server/test/pipeline/tools/documentEntry.test.ts`. First extend the import line at the top to add `buildTagDocumentTool`:

```ts
import {
  buildIngestDocumentTool, buildExtractFieldsTool, buildBindDocumentTool, buildInspectExtractionTool,
  buildTagDocumentTool,
} from '../../../src/pipeline/tools/documentEntry.js';
```

Append the tests:

```ts
it('tag_document (L2) adds explicit tags to an existing document', async () => {
  const f = join(dir, 'c.txt');
  writeFileSync(f, '合同号: HT-2024-001\n', 'utf-8');
  const ingest = buildIngestDocumentTool({ ctx });
  const ing: any = await ingest.execute(
    { sourceUri: f, docType: '合同', modality: 'digital' },
    { messages: [], toolCallId: 't', abortSignal: undefined as any } as any,
  );

  const tag = buildTagDocumentTool({ ctx });
  const out: any = await tag.execute(
    { docId: ing.docId, tags: ['重要', '客户A'] },
    { messages: [], toolCallId: 't', abortSignal: undefined as any } as any,
  );
  expect(out.status).toBe('ok');
  expect(out.docId).toBe(ing.docId);
  expect(out.addedTags.sort()).toEqual(['客户A', '重要']);

  const { listDocumentTags } = await import('../../../src/pipeline/db/repositories.js');
  const rows = await listDocumentTags(ctx, ing.docId);
  const explicit = rows.filter((r) => r.source === 'explicit').map((r) => r.tag).sort();
  expect(explicit).toEqual(['客户A', '重要']);
  // totalTags counts every tag row (auto + explicit).
  expect(out.totalTags).toBe(rows.length);
});

it('tag_document errors on unknown docId', async () => {
  const tag = buildTagDocumentTool({ ctx });
  const out: any = await tag.execute(
    { docId: 'DOC-does-not-exist', tags: ['x'] },
    { messages: [], toolCallId: 't', abortSignal: undefined as any } as any,
  );
  expect(out.status).toBe('error');
  expect(out.reason).toBe('document_not_found');
});

it('tag_document is idempotent on repeated identical tags', async () => {
  const f = join(dir, 'c2.txt');
  writeFileSync(f, '发票号 INV-1\n', 'utf-8');
  const ingest = buildIngestDocumentTool({ ctx });
  const ing: any = await ingest.execute(
    { sourceUri: f, docType: '发票', modality: 'digital' },
    { messages: [], toolCallId: 't', abortSignal: undefined as any } as any,
  );
  const tag = buildTagDocumentTool({ ctx });
  await tag.execute(
    { docId: ing.docId, tags: ['重点'] },
    { messages: [], toolCallId: 't', abortSignal: undefined as any } as any,
  );
  const out: any = await tag.execute(
    { docId: ing.docId, tags: ['重点'] },
    { messages: [], toolCallId: 't', abortSignal: undefined as any } as any,
  );
  // Second call adds nothing new.
  expect(out.addedTags).toEqual([]);
});

it('tag_document rejects an empty tag list with a clear reason', async () => {
  const f = join(dir, 'c3.txt');
  writeFileSync(f, 'x\n', 'utf-8');
  const ingest = buildIngestDocumentTool({ ctx });
  const ing: any = await ingest.execute(
    { sourceUri: f, docType: '其他', modality: 'digital' },
    { messages: [], toolCallId: 't', abortSignal: undefined as any } as any,
  );
  const tag = buildTagDocumentTool({ ctx });
  const out: any = await tag.execute(
    { docId: ing.docId, tags: [] },
    { messages: [], toolCallId: 't', abortSignal: undefined as any } as any,
  );
  expect(out.status).toBe('error');
  expect(out.reason).toBe('no_tags_provided');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace apps/server -- test/pipeline/tools/documentEntry.test.ts`
Expected: FAIL — `buildTagDocumentTool` is not exported.

- [ ] **Step 3: Add `buildTagDocumentTool` to `documentEntry.ts`**

In `apps/server/src/pipeline/tools/documentEntry.ts`, add `listDocumentTags` to the repositories import destructure (lines 5-7), then add the tool factory after `buildInspectExtractionTool` (before `buildBindDocumentTool`):

```ts
/**
 * tag_document — L2 explicit-tagging tool.
 * Adds user/agent-supplied labels to an EXISTING document, any time post-ingest.
 * Distinct from auto-tags (an ingest byproduct, source 'auto') and from graph
 * edges (link_entities, Step 4). Idempotent per (doc, tag, source='explicit'):
 * re-adding the same tag is a no-op. needsApproval (L2) because it mutates
 * business state (the agent must have user consent to label a document).
 */
export function buildTagDocumentTool(deps: ToolDeps) {
  return tool({
    description:
      '为已录入的单据打显式标签(用户/代理人工标注)。可在录入后任意时刻调用。' +
      '与 ingest 时自动生成的标签(来源 auto)不同, 这些标签来源为 explicit。' +
      '图关系(买方/卖方/引用)不在此工具, 用 link_entities。' +
      '使用场景: 用户说"给这份合同打上 重要 / 客户A 标签"时。',
    inputSchema: z.object({
      docId: z.string().min(1).describe('目标单据 docId (来自 ingest_document 返回)'),
      tags: z.array(z.string().min(1)).min(1).describe('要添加的标签数组, 至少一个'),
    }),
    execute: async ({ docId, tags }) => {
      const blockModel = await loadDocument(deps.ctx, docId, deps.userId);
      if (!blockModel) return { status: 'error' as const, reason: 'document_not_found' as const };
      if (tags.length === 0) return { status: 'error' as const, reason: 'no_tags_provided' as const };

      ensureFk(deps.ctx);
      // Compute addedTags by diffing against existing explicit tags for this doc.
      const before = await listDocumentTags(deps.ctx, docId, deps.userId);
      const hadExplicit = new Set(
        before.filter((r) => r.source === 'explicit').map((r) => r.tag),
      );
      const addedTags = tags.filter((t) => !hadExplicit.has(t));
      await saveDocumentTags(deps.ctx, docId, tags, 'explicit', deps.userId);
      const after = await listDocumentTags(deps.ctx, docId, deps.userId);
      return {
        status: 'ok' as const,
        docId,
        addedTags,
        totalTags: after.length,
      };
    },
  });
}
```

(`loadDocument`, `saveDocumentTags`, `listDocumentTags`, `ensureFk` are all in scope: `loadDocument` is already imported at line 6; `saveDocumentTags` + `listDocumentTags` land via the import edits in this task + Task 4.)

- [ ] **Step 4: Register `tag_document` in `roleToolRegistry.ts`**

In `apps/server/src/harness/roleToolRegistry.ts`:

1. Add `buildTagDocumentTool` + `ClassifierDeps` to imports:
```ts
import {
  buildIngestDocumentTool, buildExtractFieldsTool, buildBindDocumentTool, buildInspectExtractionTool,
  buildTagDocumentTool,
} from '../pipeline/tools/documentEntry.js';
import type { ClassifierDeps } from '../pipeline/classifier.js';
```

2. Add `classifier?: ClassifierDeps` to `HarnessDeps` (line ~23):
```ts
export interface HarnessDeps {
  ctx: DbContext;
  extraction?: ExtractionDeps;
  /** Phase 2 routing-classify stage. Unset -> ingest degrades to the hint docType. */
  classifier?: ClassifierDeps;
  embedder?: Embedder;
  userId?: string;
}
```

3. Add `'tag_document'` to `TRADER_CTX_TOOL_NAMES` (line 68):
```ts
const TRADER_CTX_TOOL_NAMES = ['ingest_document', 'extract_fields', 'bind_document', 'recall_documents', 'execute_code', 'inspect_extraction', 'tag_document'] as const;
```

4. In `getToolsForRole`, inside the `if (role === 'trader' && deps?.ctx)` block, thread `classifier` into the ingest tool and append the tag_document tool. The ingest line (line 75) becomes:
```ts
      { ...buildIngestDocumentTool({ ctx, embedder, classifier, userId }), name: 'ingest_document' },
```
(destructure `classifier` from `deps` — add it to the existing `const { ctx, extraction, embedder, userId } = deps;` line at ~73.)

And append after the `buildInspectExtractionTool` push (after line 81), before `recall_documents`:
```ts
      // tag_document is L2: explicit user/agent labels, post-ingest, any time.
      // needsApproval = soft gate (v6): the agent must have user consent to label.
      { ...buildTagDocumentTool({ ctx, userId }), name: 'tag_document', needsApproval: true },
```

- [ ] **Step 5: Register permission in `permissionGate.ts`**

In `apps/server/src/harness/permissionGate.ts`, in the L2 block (after `bind_document`, line 62), add:
```ts
registerPermission('tag_document', 'L2'); // Phase 2: explicit document labeling
```

- [ ] **Step 6: Register contract in `contextContract.ts`**

In `apps/server/src/harness/contextContract.ts`, add to `TOOL_CONTEXT_CONTRACTS` (after the `bind_document` entry, ~line 115):
```ts
  tag_document: {
    // Explicit user/agent labels -> trusted agent input (like bind_document's
    // contractNo), so output 'raw' / injection 'safe'. Tags are short strings ->
    // budget 'full'. Mutates persistent doc state -> signal 'env', persist
    // 'business'. L2 write (soft gate).
    output: 'raw', budget: 'full', signal: 'env',
    persist: 'business', risk: { level: 'L2', injection: 'safe' },
  },
```

- [ ] **Step 7: Wire `classifier` into the harness in `agent.ts`**

In `apps/server/src/harness/agent.ts`, the `buildGatedTools` call (line 220-223) already builds `extraction: { model: resolvedModel }`. Add `classifier: { model: resolvedModel }` so classification reuses the same per-turn DeepSeek handle:

```ts
  const tools = buildGatedTools(
    role,
    deps ?? { ctx: getHarnessDbContext(), extraction: { model: resolvedModel }, classifier: { model: resolvedModel }, embedder: defaultEmbedder(), userId },
  );
```

(One-line addition next to `extraction`; the `??` default is what production hits when the caller passes no `deps`. `deps` injected by tests already controls its own model.)

- [ ] **Step 8: Run tests to verify they pass**

Run: `npm test --workspace apps/server -- test/pipeline/tools/documentEntry.test.ts`
Expected: PASS — all four tag_document tests pass; prior tests still pass.

Then run the full server suite to exercise the harness contract assertion:
Run: `npm test`
Expected: full suite PASS. If `assertAllToolsContracted` fails listing `tag_document`, the Step 6 contract registration was missed.

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/pipeline/tools/documentEntry.ts apps/server/src/harness/roleToolRegistry.ts apps/server/src/harness/permissionGate.ts apps/server/src/harness/contextContract.ts apps/server/src/harness/agent.ts apps/server/test/pipeline/tools/documentEntry.test.ts
git commit -m "feat: add tag_document L2 tool + wire classifier deps through harness"
```

---

## Final verification (after all 5 tasks)

- [ ] **Step 1: Build**

Run: `npm run build`
Expected: both workspaces build (web `tsc -b && vite build`, server `tsc`) with no errors.

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: oxlint passes. Watch for unused-variable warnings if any import was left dangling.

- [ ] **Step 3: Full test suite**

Run: `npm test`
Expected: full server vitest suite PASS. The 11 Postgres integration tests skip unless `DB_BACKEND=postgres`.

- [ ] **Step 4: Sanity smoke (manual, optional)**

Start the backend (`npm run dev:server`) and via the chat UI: upload a doc WITHOUT specifying docType, have the agent call `ingest_document`, confirm the return shows a `classifiedDocType` + `confidence` + `tags`; then ask it to `tag_document` with a custom label and confirm the label persists. This exercises the wired classifier + tag_document end-to-end against the real DeepSeek model.

---

## Notes for the implementer

- **AI SDK 6 trap**: every `tool({...})` uses `inputSchema`, never `parameters`. `generateObject` uses `providerOptions: { openai: { structuredOutputs: false } }` (DeepSeek JSON mode) — copy `extraction.ts:107-118` exactly. Do not "modernize" to v7 syntax.
- **Postgres stubs**: the four new repository functions (`saveClassification`, `loadClassification`, `saveDocumentTags`, `listDocumentTags`) throw on the postgres branch. That is intentional and matches the disk-gated Postgres rollout + Phase 1's `loadExtraction` precedent. A later phase implements the pg twins.
- **No `migratePostgres()` / `postgres-repositories.ts` changes** this phase — SQLite-only, matching Phase 1.
- **docType now optional**: older tests that pass `docType: '合同'` still work — it is treated as a hint. The classified docType overrides it when a classifier model is wired; without one (most unit tests), the hint is used as-is (`source: 'hint'`).
- **`/api/files` upload route is intentionally untouched**: `files.ts:140` passes a `docType` that becomes a hint automatically; the route response does not need to surface the classified type in Phase 2 (the agent sees it via the `ingest_document` tool, not the upload route).
- **Out of scope for this plan** (per design §13): folding `extract_fields` into `ingest_document`, validation-classify (§6 optional phase), the graph layer (Step 4), the model-facing Agent status bar (Topic 2), product features, external ingestion. Those are Plans C–F.
