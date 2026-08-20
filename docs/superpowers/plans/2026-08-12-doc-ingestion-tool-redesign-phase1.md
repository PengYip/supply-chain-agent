# Document-Ingestion Tool Layer Redesign — Phase 1 (Plan A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract low-risk foundational refactors that make the document-ingestion tool layer composable and context-lean: a pure `parseDocument` primitive, a bounded `extract_fields` return contract, a new `inspect_extraction` evidence drill-down tool, and bounded `execute_code` output.

**Architecture:** Phase 1 changes no infrastructure and adds no new datastores. It (1) separates parsing from persistence so later phases can reuse parsing, (2) stops dumping full cited text into the model trajectory by default while keeping evidence retrievable on demand, (3) exposes that retrieval as an L1 perception tool, and (4) caps a currently-unbounded tool output. All four are independently testable and ship as discrete commits.

**Tech Stack:** TypeScript, Hono + Vercel AI SDK 6 (`tool` with `inputSchema`), vitest, SQLite (raw idempotent DDL via `db/client.ts`), zod, oxlint.

## Global Constraints

- **AI SDK 6, NOT 5 or 7**: tool schemas use the `inputSchema` field (never `parameters`); this codebase does NOT use `toDataStreamResponse` or `maxSteps`. Match existing patterns in `apps/server/src/pipeline/tools/*.ts` verbatim.
- **No emoji in code** (repo-wide convention). Chinese is allowed in user-facing strings and descriptions.
- **Test stack**: vitest. Run a single file with `npm test --workspace apps/server -- <path>`. Run all server tests with `npm test`.
- **Required order before claiming a task done**: `npm run build` then `npm run lint` then `npm test` (matches CI).
- **DB in tests**: `createDb(':memory:')` then `migrate(ctx.sqlite)`. Fixture files go under `env.INGEST_ROOT`. Unit tests import `env.ts` which zod-parses at import time; CI uses `OPENAI_API_KEY=ci-dummy-key` and tests never call the real model (use the `stubModel` pattern).
- **SQLite default**: raw idempotent DDL in `db/client.ts`; no drizzle-kit. Postgres path may `throw` for new read functions (note in code); follow the existing `loadDocument` pattern.
- **Injection defense**: any external/extracted text returned to the model is wrapped with `tagExternal(...)`. Numeric values are passed through unwrapped.
- **Commit style**: conventional commits (`feat:`, `refactor:`, `test:`). Frequent commits, one logical change each.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `apps/server/src/pipeline/parseDocument.ts` | Pure parse primitive: file → BlockModel (adapter select + digital→scanned fallback + zero-block guard). NO persistence. | **Create** |
| `apps/server/src/pipeline/tools/documentEntry.ts` | Tool wrappers (`ingest_document`, `extract_fields`, `bind_document`) + `ingestFile()` orchestrator. `ingestFile` now calls `parseDocument`; `extract_fields` return becomes bounded summary; new `inspect_extraction` tool added here. | **Modify** |
| `apps/server/src/pipeline/db/repositories.ts` | Persistence layer. Add `loadExtraction(...)` mirroring `loadDocument`. | **Modify** |
| `apps/server/src/pipeline/tools/executeCode.ts` | CubeSandbox Python tool. Add output cap + truncation marker. | **Modify** |
| `apps/server/src/harness/roleToolRegistry.ts` | Role→toolset map. Register `inspect_extraction`. | **Modify** |
| `apps/server/src/harness/permissionGate.ts` | L1/L2/L3 SoT. Register `inspect_extraction` = L1. | **Modify** |
| `apps/server/src/harness/contextContract.ts` | Per-tool context contract (fail-fast first turn). Register `inspect_extraction` contract. | **Modify** |
| `apps/server/test/pipeline/parseDocument.test.ts` | Tests for the parse primitive (no DB). | **Create** |
| `apps/server/test/pipeline/tools/documentEntry.test.ts` | Extend with extract_fields bounded-return + inspect_extraction tests. | **Modify** |
| `apps/server/test/pipeline/tools/executeCode.test.ts` | Tests for output cap. (Create if absent; otherwise extend.) | **Create/Modify** |

**Why split `parseDocument` into its own file**: it is reused by `ingestFile` (this plan) and later by `read_document` (Phase 2+) and external-fetch ingestion (Phase 6). A focused file with one responsibility (parse, no persist) is easier to test and reason about than logic buried inside the 235-line `documentEntry.ts`.

---

## Task 1: Extract `parseDocument` primitive

Separate parsing from persistence. Today the parse logic (adapter selection + digital→scanned fallback + zero-block guard) is inlined in `ingestFile()` (`documentEntry.ts:70-95`). Extract it into a named, pure, testable function that does NOT touch the DB.

**Files:**
- Create: `apps/server/src/pipeline/parseDocument.ts`
- Create: `apps/server/test/pipeline/parseDocument.test.ts`
- Modify: `apps/server/src/pipeline/tools/documentEntry.ts` (`ingestFile` body, ~lines 70-95)

**Interfaces:**
- Consumes: `ingestWithDigital(safePath, docType, docId)` and `ingestWithMinerU(safePath, docType, docId)` from the existing adapters (unchanged); types `DocType`, `Modality`, `BlockModel` from `pipeline/types.ts`.
- Produces: `parseDocument(opts: ParseDocumentInput): Promise<BlockModel>` — used by `ingestFile` in this task and by later phases.

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/pipeline/parseDocument.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { env } from '../../../src/env.js';
import { parseDocument } from '../../../src/pipeline/parseDocument.js';

describe('parseDocument (pure primitive)', () => {
  let dir: string;
  beforeEach(() => {
    dir = join(env.INGEST_ROOT, `pd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(dir, { recursive: true });
  });

  it('parses a digital txt file into a BlockModel without DB', async () => {
    const f = join(dir, 'note.txt');
    writeFileSync(f, '第一行内容\n第二行内容\n');
    const model = await parseDocument({
      sourcePath: f,
      docType: '其他',
      docId: 'DOC-test-1',
      modality: 'digital',
    });
    expect(model.docId).toBe('DOC-test-1');
    expect(model.modality).toBe('digital');
    expect(model.blocks.length).toBeGreaterThan(0);
    expect(model.blocks.some((b) => b.text.includes('第一行内容'))).toBe(true);
  });

  it('throws on zero blocks for a non-PDF digital file (no OCR fallback)', async () => {
    const f = join(dir, 'empty.txt');
    writeFileSync(f, '');
    await expect(
      parseDocument({ sourcePath: f, docType: '其他', docId: 'DOC-test-2', modality: 'digital' }),
    ).rejects.toThrow(/0 个内容块/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace apps/server -- test/pipeline/parseDocument.test.ts`
Expected: FAIL — `Cannot find module '../../../src/pipeline/parseDocument.js'` (module does not exist yet).

- [ ] **Step 3: Create `parseDocument.ts` with the extracted logic**

Create `apps/server/src/pipeline/parseDocument.ts`:

```ts
import type { BlockModel, DocType, Modality } from './types.js';
import { ingestWithDigital } from './digitalAdapter.js';
import { ingestWithMinerU } from './mineruAdapter.js';

export interface ParseDocumentInput {
  /** Absolute path inside INGEST_ROOT (caller enforces the allowlist). */
  sourcePath: string;
  docType: DocType;
  docId: string;
  modality: Modality;
}

/**
 * Pure parse primitive: file -> BlockModel. Adapter is auto-selected by
 * modality, with a digital->scanned (MinerU OCR) auto-fallback for PDFs that
 * yield zero blocks (no text layer). Does NOT persist anything; the caller is
 * responsible for saving the returned BlockModel.
 *
 * Reused by ingest_file today and by read_document / external-fetch ingestion
 * in later phases.
 */
export async function parseDocument(opts: ParseDocumentInput): Promise<BlockModel> {
  const { sourcePath, docType, docId, modality } = opts;

  let blockModel =
    modality === 'scanned'
      ? await ingestWithMinerU(sourcePath, docType, docId)
      : await ingestWithDigital(sourcePath, docType, docId);

  // Digital PDFs with no text layer: retry as scanned via MinerU OCR.
  if (
    blockModel.blocks.length === 0 &&
    modality !== 'scanned' &&
    /\.pdf$/i.test(sourcePath)
  ) {
    console.warn('[parse] digital yielded 0 blocks for PDF; retrying as scanned via MinerU OCR');
    try {
      const mineruModel = await ingestWithMinerU(sourcePath, docType, docId);
      if (mineruModel.blocks.length > 0) blockModel = mineruModel;
    } catch (e) {
      console.warn('[parse] MinerU OCR fallback failed:', (e as Error).message);
    }
  }

  if (blockModel.blocks.length === 0) {
    throw new Error(
      modality === 'scanned'
        ? '文件解析得到 0 个内容块。MinerU OCR 可能失败，请检查 .mineru.json 或 MinerU 服务配置。'
        : '文件解析得到 0 个内容块。该文件可能是扫描件(无文字层)，MinerU OCR 也未能提取内容。',
    );
  }
  return blockModel;
}
```

- [ ] **Step 4: Refactor `ingestFile()` to call `parseDocument`**

In `apps/server/src/pipeline/tools/documentEntry.ts`, replace the parse block inside `ingestFile()` (the adapter-select + fallback + zero-block-throw, currently ~lines 70-95) with a call to the new primitive. Add the import at the top with the other pipeline imports:

```ts
import { parseDocument } from '../parseDocument.js';
```

The body of `ingestFile()` becomes (keep the existing `assertWithinRoot`, `newDocId`, and the persist/chunk/embed tail unchanged):

```ts
export async function ingestFile(opts: IngestOptions): Promise<{ docId: string; blockCount: number; modality: Modality }> {
  const { ctx, sourcePath, docType, modality, embedder, userId } = opts;
  ensureFk(ctx);
  const safePath = assertWithinRoot(sourcePath);
  const docId = newDocId();

  // Parse (pure, no DB) — extracted into parseDocument primitive.
  const blockModel = await parseDocument({ sourcePath: safePath, docType, docId, modality });

  // Persist + index (unchanged tail).
  await saveDocument(ctx, blockModel, userId);
  const chunks = chunkBlockModel(blockModel);
  const chunkRowIds = await saveChunks(ctx, docId, chunks);
  if (embedder && isVecReady(ctx)) {
    const vectors = await Promise.all(chunks.map((c) => embedder.embed(c.text)));
    await saveChunkVectors(ctx, chunkRowIds, vectors);
  }
  return { docId, blockCount: blockModel.blocks.length, modality: blockModel.modality };
}
```

Note: `assertWithinRoot` stays in `ingestFile` (it is the persistence entry's defense). `parseDocument` is deliberately pure and trusts the caller-supplied path. Remove now-unused direct imports of `ingestWithDigital`/`ingestWithMinerU` from `documentEntry.ts` if nothing else in the file uses them (they are still used by `parseDocument.ts`). Leave them if grep finds other call sites.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test --workspace apps/server -- test/pipeline/parseDocument.test.ts test/pipeline/tools/documentEntry.test.ts`
Expected: both PASS. The existing `documentEntry.test.ts` ingest/bind/path-rejection tests must still pass unchanged (the refactor is behavior-preserving).

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/pipeline/parseDocument.ts apps/server/src/pipeline/tools/documentEntry.ts apps/server/test/pipeline/parseDocument.test.ts
git commit -m "refactor: extract parseDocument primitive from ingestFile"
```

---

## Task 2: Refactor `extract_fields` return contract to bounded summary

Stop putting full per-field `citedText` + `sourceSpans` into the model trajectory by default. The evidence stays persisted (via `saveExtraction`); the default return becomes a small per-field summary. The DB write path is unchanged — only the tool's return value changes.

**Files:**
- Modify: `apps/server/src/pipeline/tools/documentEntry.ts` (`buildExtractFieldsTool` execute return, ~lines 191-199)
- Modify: `apps/server/test/pipeline/tools/documentEntry.test.ts` (add bounded-return assertion)

**Interfaces:**
- Consumes: `extractGroundedFields(...)` → `ExtractionResult` (unchanged), `saveExtraction(...)` (unchanged).
- Produces: new default return shape `{ extractionId, fields: Array<{name, value, confidence, needsReview, autoAccepted}>, overallConfidence, missingRequired }`. The full evidence remains reachable via `inspect_extraction` (Task 3).

- [ ] **Step 1: Write the failing test**

Append to `apps/server/test/pipeline/tools/documentEntry.test.ts` (inside the existing `describe`, reusing the `beforeEach` that sets up `ctx`, `dir`, and `stubModel`):

```ts
import { writeFileSafe } from '../../../src/pipeline/tools/documentEntry.js'; // adjust if not exported; see note

it('extract_fields returns a bounded summary without citedText/sourceSpans', async () => {
  // Ingest a doc first.
  const f = join(dir, 'contract.txt');
  writeFileSync(f, '合同号：HT-2024-001\n买方：示例公司\n卖方：另一方公司\n');
  const ingest = buildIngestDocumentTool({ ctx, userId });
  const ing = await ingest.execute(
    { sourceUri: f, docType: '合同', modality: 'digital' },
    { messages: [], toolCallId: 't', abortSignal: undefined } as any,
  );
  const docId = (ing as any).docId;

  // extract_fields with a stub model (returns no real fields, but exercises the return shape).
  const extract = buildExtractFieldsTool({ ctx, extraction: { model: stubModel } as any, userId });
  const out: any = await extract.execute(
    { docId, docType: '合同' },
    { messages: [], toolCallId: 't', abortSignal: undefined } as any,
  );

  // Bounded summary contract.
  expect(typeof out.extractionId).toBe('string');
  expect(Array.isArray(out.fields)).toBe(true);
  for (const fld of out.fields) {
    expect(fld).toHaveProperty('name');
    expect(fld).toHaveProperty('value');
    expect(fld).toHaveProperty('confidence');
    expect(fld).toHaveProperty('needsReview');
    expect(fld).toHaveProperty('autoAccepted');
    // Evidence must NOT be in the default return.
    expect(fld).not.toHaveProperty('citedText');
    expect(fld).not.toHaveProperty('sourceSpans');
  }
  expect(out).toHaveProperty('overallConfidence');
  expect(out).toHaveProperty('missingRequired');
});
```

Note on imports: add `buildExtractFieldsTool` and `buildIngestDocumentTool` to the test file's imports from `../../../src/pipeline/tools/documentEntry.js` (match whatever the existing test already imports; if `buildIngestDocumentTool` is not imported yet, add it). Remove the `writeFileSafe` import line above — it is a placeholder; the test writes the fixture directly with `writeFileSync` as shown.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace apps/server -- test/pipeline/tools/documentEntry.test.ts`
Expected: FAIL — the assertion `expect(fld).not.toHaveProperty('citedText')` fails because today's return includes `citedText` and `sourceSpans` on every field.

- [ ] **Step 3: Change the `buildExtractFieldsTool` return**

In `apps/server/src/pipeline/tools/documentEntry.ts`, inside `buildExtractFieldsTool`'s `execute`, replace the final return block (currently ~lines 191-199, which returns `taggedFields` including `citedText`/`sourceSpans`/`strength`/`pendingManual`/`reason`) with a bounded summary:

```ts
// Bounded summary for the model trajectory. Full evidence (citedText,
// sourceSpans) stays persisted via saveExtraction and is retrievable on
// demand via inspect_extraction(extractionId, fieldName).
const summaryFields = result.fields.map((f) => ({
  name: f.name,
  value: typeof f.value === 'string' ? tagExternal(f.value) : f.value,
  confidence: f.confidence,
  needsReview: f.needsReview,
  autoAccepted: f.autoAccepted,
}));

return {
  extractionId,
  fields: summaryFields,
  overallConfidence: result.overallConfidence,
  needsReview,
  missingRequired: result.missingRequired,
  reason: result.fields.length === 0 ? 'no_fields_extracted' : undefined,
};
```

Leave everything above this return (the `loadDocument` guard, the `extractGroundedFields` call, the `fields`/`fieldMeta` record building, `ensureFk`, `needsReview`, and the `saveExtraction` call) unchanged. The `taggedFields` variable and the `pendingManual` computation become unused after this change — delete them to keep the file clean (oxlint will flag unused vars).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test --workspace apps/server -- test/pipeline/tools/documentEntry.test.ts`
Expected: PASS — the new bounded-return test passes and the existing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/pipeline/tools/documentEntry.ts apps/server/test/pipeline/tools/documentEntry.test.ts
git commit -m "refactor: bound extract_fields default return to per-field summary"
```

---

## Task 3: Add `loadExtraction` repository function + `inspect_extraction` L1 tool

`citedText` is no longer in the default `extract_fields` return (Task 2). Provide an on-demand evidence drill-down. `loadExtraction` does not exist today (grep-confirmed); add it. `inspect_extraction` recomputes `citedText` from the persisted `sourceSpans` + the loaded `BlockModel` via the existing `validateSpan` (DRY: the span validator stays the single source of truth; `citedText` is never stored separately).

**Files:**
- Modify: `apps/server/src/pipeline/db/repositories.ts` (add `loadExtraction`)
- Modify: `apps/server/src/pipeline/tools/documentEntry.ts` (add `buildInspectExtractionTool`)
- Modify: `apps/server/src/harness/roleToolRegistry.ts` (register the tool)
- Modify: `apps/server/src/harness/permissionGate.ts` (register L1)
- Modify: `apps/server/src/harness/contextContract.ts` (register contract)
- Modify: `apps/server/test/pipeline/tools/documentEntry.test.ts` (add inspect test)

**Interfaces:**
- Consumes: `ExtractionInput` field shape (from `repositories.ts:33-40`), `loadDocument(ctx, docId, userId)` (existing), `validateSpan(value, span, blocks)` from `spanValidator.ts` (existing), `tagExternal` from `injectionDefense.js`.
- Produces:
  - `loadExtraction(ctx, extractionId, userId?): Promise<ExtractionRow | null>` where `ExtractionRow = { id, documentId, docType, fields, fieldMeta, overallConfidence, needsReview }`.
  - `buildInspectExtractionTool(deps: ToolDeps)` → AI SDK 6 tool with `inputSchema: { extractionId: string, fieldName: string }` returning `{ status, extractionId, fieldName, value, citedText, sourceSpans, confidence, strength }` on success or `{ status:'error', reason }` on miss.

- [ ] **Step 1: Write the failing test**

Append to `apps/server/test/pipeline/tools/documentEntry.test.ts`:

```ts
it('inspect_extraction returns persisted-field evidence on demand', async () => {
  // Seed an extraction row directly so the test does not depend on the LLM.
  const { saveExtraction } = await import('../../../src/pipeline/db/repositories.js');
  const f = join(dir, 'inv.txt');
  writeFileSync(f, '发票号：INV-001\n金额：10000\n');
  const ingest = buildIngestDocumentTool({ ctx, userId });
  const ing: any = await ingest.execute(
    { sourceUri: f, docType: '发票', modality: 'digital' },
    { messages: [], toolCallId: 't', abortSignal: undefined } as any,
  );

  const extractionId = await saveExtraction(ctx, {
    documentId: ing.docId,
    docType: '发票',
    fields: { 发票号: { value: 'INV-001', sourceSpans: [] } },
    fieldMeta: { 发票号: { strength: 'exact', confidence: 0.95 } },
    overallConfidence: 0.95,
    needsReview: false,
  }, userId);

  const inspect = buildInspectExtractionTool({ ctx, userId });
  const out: any = await inspect.execute(
    { extractionId, fieldName: '发票号' },
    { messages: [], toolCallId: 't', abortSignal: undefined } as any,
  );

  expect(out.status).toBe('ok');
  expect(out.fieldName).toBe('发票号');
  expect(out.value).toBe('INV-001');
  expect(out.confidence).toBe(0.95);
  expect(Array.isArray(out.sourceSpans)).toBe(true);
});

it('inspect_extraction errors on unknown field and lists available fields', async () => {
  const { saveExtraction } = await import('../../../src/pipeline/db/repositories.js');
  const f = join(dir, 'c.txt');
  writeFileSync(f, 'x\n');
  const ingest = buildIngestDocumentTool({ ctx, userId });
  const ing: any = await ingest.execute(
    { sourceUri: f, docType: '其他', modality: 'digital' },
    { messages: [], toolCallId: 't', abortSignal: undefined } as any,
  );
  const extractionId = await saveExtraction(ctx, {
    documentId: ing.docId,
    docType: '其他',
    fields: { a: { value: '1', sourceSpans: [] } },
    fieldMeta: { a: { strength: 'none', confidence: 0.1 } },
    overallConfidence: 0.1,
    needsReview: true,
  }, userId);

  const inspect = buildInspectExtractionTool({ ctx, userId });
  const out: any = await inspect.execute(
    { extractionId, fieldName: 'nope' },
    { messages: [], toolCallId: 't', abortSignal: undefined } as any,
  );
  expect(out.status).toBe('error');
  expect(out.reason).toBe('field_not_found');
  expect(out.availableFields).toEqual(['a']);
});
```

Add `buildInspectExtractionTool` to the test file's imports from `documentEntry.js`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace apps/server -- test/pipeline/tools/documentEntry.test.ts`
Expected: FAIL — `buildInspectExtractionTool` is not exported; `loadExtraction` does not exist.

- [ ] **Step 3: Add `loadExtraction` to `repositories.ts`**

In `apps/server/src/pipeline/db/repositories.ts`, add the `ExtractionRow` type and the function near `loadDocument` (~line 96). Use the same userId-legacy filter pattern as `loadDocument`:

```ts
export interface ExtractionRow {
  id: string;
  documentId: string;
  docType: DocType;
  fields: Record<string, { value: string | number; sourceSpans: SourceSpan[] }>;
  fieldMeta: Record<string, { strength: SpanMatchStrength; confidence: number }>;
  overallConfidence: number;
  needsReview: boolean;
}

export async function loadExtraction(
  ctx: DbContext,
  extractionId: string,
  userId?: string,
): Promise<ExtractionRow | null> {
  if (ctx.backend === 'postgres') {
    throw new Error('loadExtraction: postgres path not implemented yet');
  }
  const uid = effectiveUserId(userId);
  const filter = uid
    ? and(
        eq(extractions.id, extractionId),
        or(eq(extractions.userId, uid), eq(extractions.userId, ''), isNull(extractions.userId)),
      )
    : eq(extractions.id, extractionId);
  const row = ctx.db.select().from(extractions).where(filter).all()[0];
  if (!row) return null;
  return {
    id: row.id,
    documentId: row.documentId,
    docType: row.docType as DocType,
    fields: JSON.parse(row.fields as string),
    fieldMeta: JSON.parse(row.fieldMeta as string),
    overallConfidence: row.overallConfidence,
    needsReview: !!row.needsReview,
  };
}
```

Ensure `extractions`, `and`, `or`, `eq`, `isNull`, `DocType`, `SourceSpan`, `SpanMatchStrength`, `DbContext`, `effectiveUserId` are all already imported/defined in this file (they are — `saveExtraction` uses the same symbols). If `SpanMatchStrength` is not imported, add `import type { SpanMatchStrength } from '../spanValidator.js';`.

- [ ] **Step 4: Add `buildInspectExtractionTool` to `documentEntry.ts`**

In `apps/server/src/pipeline/tools/documentEntry.ts`, add imports for `loadExtraction` and `validateSpan`:

```ts
import { loadExtraction } from '../db/repositories.js';
import { validateSpan } from '../spanValidator.js';
```

Then add the tool factory (place it after `buildExtractFieldsTool`):

```ts
/**
 * inspect_extraction — L1 perception tool.
 * On-demand evidence drill-down for a SINGLE already-extracted field.
 * Scope boundary: only fields that extract_fields already produced (given by
 * extractionId). NOT a general text-retrieval tool (use recall_documents for
 * arbitrary text). citedText is recomputed from persisted sourceSpans + the
 * loaded BlockModel via validateSpan, so the span validator stays the single
 * source of truth (citedText is never stored separately).
 */
export function buildInspectExtractionTool(deps: ToolDeps) {
  return tool({
    description:
      '查看某个已抽取字段的证据（原文片段 citedText 与 sourceSpans）。' +
      '仅限 extract_fields 已经抽取出的字段（用其返回的 extractionId）。' +
      '不要用它做任意文本检索（那应该用 recall_documents）。' +
      '使用场景：用户想看某字段值在原文哪里、或对抽取结果存疑需要取证时。',
    inputSchema: z.object({
      extractionId: z.string().min(1).describe('extract_fields 返回的 extractionId'),
      fieldName: z.string().min(1).describe('要查看证据的字段名，取自 extract_fields 返回 fields[].name'),
    }),
    execute: async ({ extractionId, fieldName }) => {
      const row = await loadExtraction(deps.ctx, extractionId, deps.userId);
      if (!row) return { status: 'error' as const, reason: 'extraction_not_found' as const };

      const field = row.fields[fieldName];
      if (!field) {
        return {
          status: 'error' as const,
          reason: 'field_not_found' as const,
          availableFields: Object.keys(row.fields),
        };
      }

      const blockModel = await loadDocument(deps.ctx, row.documentId, deps.userId);
      if (!blockModel) return { status: 'error' as const, reason: 'document_not_found' as const };

      // Recompute citedText from persisted spans + BlockModel (DRY).
      const meta = row.fieldMeta[fieldName];
      let citedText: string | null = null;
      let strength: SpanMatchStrength = meta?.strength ?? 'none';
      for (const span of field.sourceSpans) {
        const v = validateSpan(String(field.value), span, blockModel.blocks);
        if (v.citedText) {
          citedText = v.citedText;
          strength = v.strength;
          break;
        }
      }

      return {
        status: 'ok' as const,
        extractionId,
        fieldName,
        value: typeof field.value === 'string' ? tagExternal(field.value) : field.value,
        citedText: citedText ? tagExternal(citedText) : null,
        sourceSpans: field.sourceSpans,
        confidence: meta?.confidence ?? 0,
        strength,
      };
    },
  });
}
```

Note: confirm `validateSpan`'s return shape from `spanValidator.ts` — it returns `{ citedText: string | null, strength: SpanMatchStrength, ... }`. If the actual export name or shape differs (e.g. `validateSpan` returns a richer object), match the existing call in `extraction.ts:attachConfidence` verbatim. `SpanMatchStrength` type is already imported at the top of `documentEntry.ts`.

- [ ] **Step 5: Register the tool in `roleToolRegistry.ts`**

In `apps/server/src/harness/roleToolRegistry.ts`:

1. Add `'inspect_extraction'` to `TRADER_CTX_TOOL_NAMES` (line ~68):
```ts
const TRADER_CTX_TOOL_NAMES = [
  'ingest_document',
  'extract_fields',
  'bind_document',
  'recall_documents',
  'execute_code',
  'inspect_extraction',
] as const;
```

2. In `getToolsForRole`, inside the `if (role === 'trader' && deps?.ctx)` block, add (import `buildInspectExtractionTool` from `../pipeline/tools/documentEntry.js`):
```ts
const inspect = buildInspectExtractionTool({ ctx, userId: deps.userId });
(inspect as GatedTool).name = 'inspect_extraction';
tools.push(inspect as GatedTool);
```

- [ ] **Step 6: Register permission in `permissionGate.ts`**

In `apps/server/src/harness/permissionGate.ts`, in the registrations block (~lines 48-65), add:
```ts
registerPermission('inspect_extraction', 'L1');
```

- [ ] **Step 7: Register contract in `contextContract.ts`**

In `apps/server/src/harness/contextContract.ts`, in `TOOL_CONTEXT_CONTRACTS` (~lines 66-129), add:
```ts
TOOL_CONTEXT_CONTRACTS['inspect_extraction'] = {
  output: 'tagged',
  budget: 'summary',
  signal: 'counter',
  persist: 'business',
  risk: { level: 'L1', injection: 'external' },
};
```
(Reasoning: it returns external-sourced citedText wrapped via tagExternal → `tagged`/`external`; bounded single-field evidence → `summary`; read-only lookup → `L1`; persisted business data → `business`.)

- [ ] **Step 8: Run tests to verify they pass**

Run: `npm test --workspace apps/server -- test/pipeline/tools/documentEntry.test.ts`
Expected: PASS — both new inspect tests pass, all prior tests pass.

Then run the harness contract assertion (it runs on first turn in app, but exercise it in the existing harness test if one exists):
Run: `npm test --workspace apps/server`
Expected: full server suite PASS. If `assertAllToolsContracted` fails listing `inspect_extraction`, the contract registration in Step 7 was missed.

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/pipeline/db/repositories.ts apps/server/src/pipeline/tools/documentEntry.ts apps/server/src/harness/roleToolRegistry.ts apps/server/src/harness/permissionGate.ts apps/server/src/harness/contextContract.ts apps/server/test/pipeline/tools/documentEntry.test.ts
git commit -m "feat: add inspect_extraction L1 tool + loadExtraction for on-demand field evidence"
```

---

## Task 4: Bound `execute_code` output

`execute_code` currently aggregates all stdout/stderr into unbounded strings and returns an unbounded `results` array (grep-confirmed: no cap at `executeCode.ts:187-218`). Bound all three with explicit truncation markers so a runaway script cannot blow up the model trajectory.

**Files:**
- Modify: `apps/server/src/pipeline/tools/executeCode.ts` (aggregation + return, ~lines 187-218)
- Create/Modify: `apps/server/test/pipeline/tools/executeCode.test.ts`

**Interfaces:**
- Consumes: the sandbox NDJSON stream (unchanged).
- Produces: same return shape, but `stdout`/`stderr` capped at `MAX_OUTPUT_CHARS` (8000) with a `[truncated: ...]` marker when exceeded; `results` capped to the first `MAX_RESULTS` (20) entries, each `text` capped at `MAX_RESULT_CHARS` (4000).

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/pipeline/tools/executeCode.test.ts` (the tool shells out to CubeSandbox, which is unavailable in CI; test the pure truncation helper directly):

```ts
import { describe, it, expect } from 'vitest';
// The helper is exported from the tool module for direct unit testing.
import { truncateWithMarker, MAX_OUTPUT_CHARS } from '../../../src/pipeline/tools/executeCode.js';

describe('execute_code output bounding', () => {
  it('leaves short strings unchanged', () => {
    expect(truncateWithMarker('hello')).toBe('hello');
  });

  it('truncates long strings with an explicit marker', () => {
    const big = 'x'.repeat(MAX_OUTPUT_CHARS * 3);
    const out = truncateWithMarker(big);
    expect(out.length).toBeLessThan(big.length);
    expect(out).toContain('[truncated:');
    expect(out.startsWith('x')).toBe(true);
  });

  it('does not truncate at exactly the cap', () => {
    const exact = 'y'.repeat(MAX_OUTPUT_CHARS);
    expect(truncateWithMarker(exact)).toBe(exact);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace apps/server -- test/pipeline/tools/executeCode.test.ts`
Expected: FAIL — `truncateWithMarker` / `MAX_OUTPUT_CHARS` are not exported.

- [ ] **Step 3: Add the cap helper and apply it**

In `apps/server/src/pipeline/tools/executeCode.ts`, near the top (after imports), add:

```ts
export const MAX_OUTPUT_CHARS = 8000;
export const MAX_RESULT_CHARS = 4000;
export const MAX_RESULTS = 20;

/**
 * Cap a string to MAX_OUTPUT_CHARS and append an explicit truncation marker so
 * the model can see that output was dropped (never silently truncate).
 */
export function truncateWithMarker(s: string, cap: number = MAX_OUTPUT_CHARS): string {
  if (s.length <= cap) return s;
  return s.slice(0, cap) + `\n[truncated: ${s.length} chars total, showing first ${cap}]`;
}
```

Then in the `execute` aggregation/return block (~lines 187-218), wrap the aggregated stdout/stderr and cap the results array. Concretely, where stdout/stderr are built (the `.map((m) => m.text).join('')` lines), pass the result through `truncateWithMarker`:

```ts
const stdout = truncateWithMarker(
  messages.filter((m) => m.type === 'stdout').map((m) => m.text).join(''),
);
const stderr = truncateWithMarker(
  messages.filter((m) => m.type === 'stderr').map((m) => m.text).join(''),
);
const allResults = messages.filter((m) => m.type === 'result');
const results = allResults.slice(0, MAX_RESULTS).map((m) => ({
  text: truncateWithMarker(m.text, MAX_RESULT_CHARS),
  is_main_result: !!m.is_main_result,
}));
const resultsDropped = allResults.length - results.length;
```

In the return object, keep the existing shape but add a `resultsDropped` field when results were capped:

```ts
return {
  status: 'success' as const,
  executionCount,
  stdout: tagExternal(stdout),
  stderr: tagExternal(stderr),
  results,
  resultsDropped: resultsDropped > 0 ? resultsDropped : undefined,
  error: null,
};
```

Apply the same `truncateWithMarker` to the error branch (`error.value` and each `traceback` entry) if the error block also returns unbounded external text.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test --workspace apps/server -- test/pipeline/tools/executeCode.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/pipeline/tools/executeCode.ts apps/server/test/pipeline/tools/executeCode.test.ts
git commit -m "feat: bound execute_code stdout/stderr/results with truncation markers"
```

---

## Final verification (after all 4 tasks)

- [ ] **Step 1: Build**

Run: `npm run build`
Expected: both workspaces build (web `tsc -b && vite build`, server `tsc`) with no errors.

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: oxlint passes. Watch for unused-variable warnings from the Task 2 cleanup (`taggedFields`, `pendingManual`) — delete them if flagged.

- [ ] **Step 3: Full test suite**

Run: `npm test`
Expected: full server vitest suite PASS. The 11 Postgres integration tests skip unless `DB_BACKEND=postgres`.

- [ ] **Step 4: Sanity smoke (manual, optional)**

Start the backend (`npm run dev:server`) and via the chat UI: upload a doc, ask the agent to extract fields, confirm the `extract_fields` return is a short summary (no inline cited text), then ask it to inspect a field and confirm evidence comes back. This exercises the wired registry/permission/contract end-to-end.

---

## Notes for the implementer

- **AI SDK 6 trap**: every `tool({...})` uses `inputSchema`, never `parameters`. Do not "modernize" to v7 syntax.
- **Postgres stubs**: `loadExtraction` throws on the postgres path (Phase 1 is SQLite-only). That is intentional and matches the disk-gated Postgres rollout; a Phase-4 task will implement the pg twin alongside the graph work.
- **`validateSpan` shape**: before finalizing Task 3 Step 4, open `spanValidator.ts` and confirm the return type has `{ citedText, strength }`. Match the call already used in `extraction.ts:attachConfidence` exactly.
- **Removing legacy imports**: after Task 1, if `ingestWithDigital`/`ingestWithMinerU` are no longer referenced in `documentEntry.ts`, remove them from its imports (they remain imported by `parseDocument.ts`).
- **Out of scope for this plan**: classification, tagging, the graph layer, the model status bar, product features, external ingestion. Those are Plans B–F.
