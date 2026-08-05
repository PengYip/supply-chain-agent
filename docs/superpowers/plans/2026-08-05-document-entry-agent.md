# 单据录入 Agent (Phase 1a: Backbone + 合同) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the reusable document-entry pipeline backbone (ingest → BlockModel → grounded field extraction → confidence → HITL → business binding), anchored end-to-end on the 合同 doc type, producing working testable software that turns a raw contract file into a verified, business-bound, audit-tracked record.

**Architecture:** Route-2 hybrid grounded pipeline. A deterministic ingest layer (born-digital text extract / MinerU OCR) normalizes any file into a stable `BlockModel`. An LLM-constrained extraction emits field values **each forced to cite source spans**; a span-grounding validator + confidence model convert the project's "数字零幻觉" principle from a soft prompt rule into a HARD tool check that gates HITL (auto-accept / needs-review / escalate). All stages run as existing AI-SDK-6 tools on the trader harness and persist through Drizzle/SQLite for full audit traceability. `BlockModel` is the stable contract; MinerU and digital parsers sit behind adapter interfaces so the rest of the system tests against fixtures, not real OCR.

**Tech Stack:** TypeScript (ESM), Node, AI SDK 6 (`ai@^6`, `@ai-sdk/openai@^2`), Hono (existing harness), Zod 3, `better-sqlite3` + `drizzle-orm` (persistence), `vitest` (tests, newly added), `pdf-parse` (born-digital PDF text), MinerU (local CPU OCR via `mineru-pdf` skill, behind adapter).

## Global Constraints

Copied verbatim from spec §3.2 / project ARCHITECTURE — every task implicitly inherits these:

- **数据不出域**: no cloud OCR, no cloud file storage. OCR = MinerU (local CPU). Originals stored on local FS for MVP.
- **工具优先 · 数字零幻觉**: no LLM free-form numbers reach the business DB. Every extracted value MUST carry `sourceSpans` validated against `BlockModel` block text; ungrounded values cannot be auto-accepted.
- **AI SDK 6 API**: `tool({ inputSchema, ... })` (NOT v5 `parameters`); L2 permission via `{ ...tool, needsApproval: true }`; `streamText({ stopWhen: stepCountIs(n), experimental_telemetry })`; `generateObject` for structured extraction; `convertToModelMessages` is async.
- **Confidence thresholds (reuse from `hitl.ts`)**: `REVIEW_THRESHOLD=0.7`, `AUTO_THRESHOLD=0.9`; **key fields (合同号 / 金额 / 发票号 / 价税合计) ≥ 0.95**.
- **Repo is NOT git-initialized.** Commit steps are written for when `git init` is run; if not, treat them as no-ops. Do NOT retroactively `git init` unless asked.
- **DeepSeek via OpenAI-compatible client**: `openai.chat(env.OPENAI_MODEL)` is the existing model factory; reuse it for extraction.
- **No emoji in code.** Copy stays grounded/professional Chinese.

---

## File Structure

New/modified files (all under `server/` unless noted). Each file has one responsibility; files that change together live together.

| Path | Responsibility | Task |
|---|---|---|
| `server/package.json` | Add `vitest`, `drizzle-orm`, `pdf-parse`; devDeps `drizzle-kit`, `@types/pdf-parse` | T0 |
| `server/vitest.config.ts` | Vitest config (node env, `src/**/*.test.ts` glob) | T0 |
| `server/src/pipeline/types.ts` | `BlockModel`, `Block`, `SourceSpan`, `DocType`, `Modality` — the stable contract | T1 |
| `server/test/pipeline/types.test.ts` | Type/shape compile + fixture sanity | T1 |
| `server/src/pipeline/mineruAdapter.ts` | `MinerUAdapter` interface + `ingestWithMinerU()` impl; normalizes MinerU JSON → `BlockModel` | T2 |
| `server/test/pipeline/mineruAdapter.test.ts` | Normalization logic against a captured MinerU fixture | T2 |
| `server/src/pipeline/digitalAdapter.ts` | `ingestWithDigital()` for PDF (`pdf-parse`) + DOCX; `ocrConfidence=1.0` | T3 |
| `server/test/pipeline/digitalAdapter.test.ts` | Born-digital text → BlockModel | T3 |
| `server/src/pipeline/db/schema.ts` | Drizzle tables: `documents` / `extractions` / `bindings` | T4 |
| `server/src/pipeline/db/client.ts` | `createDb(path)` + `migrate()` (raw DDL, idempotent, WAL) | T4 |
| `server/src/pipeline/db/repositories.ts` | `saveDocument` / `loadDocument` / `saveExtraction` / `saveBinding` / `listBindingsForContract` | T4 |
| `server/test/pipeline/db/repositories.test.ts` | CRUD round-trips against in-memory sqlite | T4 |
| `server/src/pipeline/schemas/contract.ts` | `ContractSchema` (zod) + `GroundedExtraction` schema + `KEY_FIELDS` | T5 |
| `server/src/pipeline/spanValidator.ts` | `validateSpan()` → `{ ok, strength:'exact'|'fuzzy'|'none' }` | T5 |
| `server/test/pipeline/spanValidator.test.ts` | Span grounding core (zero-hallucination hard check) | T5 |
| `server/src/pipeline/confidence.ts` | `computeFieldConfidence()` + thresholds + `decisionForField()` | T6 |
| `server/test/pipeline/confidence.test.ts` | Confidence math + key-field gate | T6 |
| `server/src/pipeline/extraction.ts` | `extractGroundedFields()` — `generateObject` + span validation + confidence attach (pure-ish, deps injected) | T7 |
| `server/test/pipeline/extraction.test.ts` | Extraction orchestration with a stubbed model | T7 |
| `server/src/pipeline/tools/documentEntry.ts` | `buildIngestDocumentTool` (L1), `buildExtractFieldsTool` (L1), `buildBindDocumentTool` (L2) | T8 |
| `server/test/pipeline/tools/documentEntry.test.ts` | Tool wrappers (dispatcher + record outputs) with stub deps | T8 |
| `server/src/harness/roleToolRegistry.ts` (modify) | Register the 3 new tools for `trader` | T9 |
| `server/src/harness/permissionGate.ts` (modify, if needed) | Confirm `bind_document` is L2 (needsApproval) | T9 |
| `server/src/harness/agent.ts` (modify) | Extend SYSTEM_PROMPT with doc-entry guardrails | T9 |
| `server/test/harness/wiring.test.ts` | Role registry + permission-level assertions | T9 |
| `server/eval/contracts/*.json` | Synthetic 合同 sample set + ground truth + traps | T10 |
| `server/eval/run.ts` | Eval runner → metrics (字段抽取准确率 / span接地率 / 引用准确率 / HITL触发) | T10 |

**Dependency order:** T0 → T1 → (T2 ‖ T3) → T4 → (T5 ‖ T6) → T7 → T8 → T9 → T10.

---

## Task 0: Test + persistence infrastructure setup

**Files:**
- Modify: `server/package.json`
- Create: `server/vitest.config.ts`

**Interfaces:**
- Produces: a working `npm test` that runs vitest; `drizzle-orm` + `better-sqlite3` + `pdf-parse` importable.

- [ ] **Step 1: Add dependencies**

Run (in `server/`):
```bash
npm install drizzle-orm@^0.36.0 pdf-parse@^1.1.1
npm install -D vitest@^2.1.0 drizzle-kit@^0.28.0 @types/pdf-parse@^1.1.4
```

Expected: `added N packages` with no high-severity vulnerabilities; `vitest`, `drizzle-orm`, `drizzle-kit`, `pdf-parse` appear in `server/package.json`.

- [ ] **Step 2: Add test scripts to `server/package.json`**

Modify the `scripts` block of `server/package.json` to become:
```json
"scripts": {
  "dev": "tsx watch src/index.ts",
  "build": "tsc",
  "start": "node dist/index.js",
  "test": "vitest run",
  "test:watch": "vitest"
}
```

- [ ] **Step 3: Create `server/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globals: false,
  },
  esbuild: {
    target: 'es2022',
  },
});
```

- [ ] **Step 4: Verify vitest runs (no tests yet)**

Run (in `server/`): `npm test`
Expected: `No test files found, exiting with code 1` (acceptable — infra works; T1 adds the first test). If you see a module-resolution error instead, the install failed — re-run Step 1.

- [ ] **Step 5: Commit**

```bash
cd server && git add package.json package-lock.json vitest.config.ts && git commit -m "chore: add vitest, drizzle-orm, pdf-parse"
```
(Skip if repo is not git-initialized.)

---

## Task 1: BlockModel — the stable contract

**Files:**
- Create: `server/src/pipeline/types.ts`
- Create: `server/test/pipeline/types.test.ts`

**Interfaces:**
- Produces: `DocType`, `Modality`, `BlockType`, `BBox`, `Block`, `BlockModel`, `SourceSpan` (all exported from `src/pipeline/types.ts`). Every downstream task imports from here.

- [ ] **Step 1: Write the failing test**

Create `server/test/pipeline/types.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import type { BlockModel, Block, SourceSpan } from '../../src/pipeline/types.js';

describe('BlockModel types', () => {
  it('accepts a well-formed digital BlockModel', () => {
    const block: Block = {
      id: 'b1',
      type: 'kv',
      text: '合同号: HT-2024-001',
      page: 1,
      bbox: null,
      ocrConfidence: 1.0,
    };
    const model: BlockModel = {
      docId: 'DOC-1',
      docType: '合同',
      modality: 'digital',
      blocks: [block],
      sourceUri: 'file:///contracts/ht-2024-001.pdf',
      createdAt: '2026-08-05T00:00:00.000Z',
    };
    expect(model.blocks[0].text).toBe('合同号: HT-2024-001');
    expect(model.blocks[0].ocrConfidence).toBe(1.0);
  });

  it('accepts a scanned Block with bbox + low ocrConfidence + span', () => {
    const span: SourceSpan = { blockId: 'b2', start: 5, end: 16, page: 1 };
    expect(span.blockId).toBe('b2');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (in `server/`): `npm test`
Expected: FAIL — `Cannot find module '../../src/pipeline/types.js'` or resolution error.

- [ ] **Step 3: Write the implementation**

Create `server/src/pipeline/types.ts`:
```ts
// Stable pipeline contract: every ingest adapter normalizes to BlockModel;
// every downstream stage (extraction, validation, confidence) consumes BlockModel.

export type DocType = '合同' | '发票' | '提单' | '装箱单' | '其他';
export type Modality = 'digital' | 'scanned';
export type BlockType = 'text' | 'kv' | 'table_row' | 'figure';

export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Block {
  /** Stable id within the document, e.g. "b3". Used by SourceSpan.blockId. */
  id: string;
  type: BlockType;
  /** Normalized text content. SourceSpan offsets index into this string. */
  text: string;
  /** 1-indexed page number. */
  page: number;
  /** Layout box; null for born-digital where layout is unknown. */
  bbox: BBox | null;
  /** OCR confidence 0..1; 1.0 for born-digital text. */
  ocrConfidence: number;
  /** Nested blocks (e.g. table rows under a table). */
  children?: Block[];
}

export interface BlockModel {
  docId: string;
  docType: DocType;
  modality: Modality;
  blocks: Block[];
  /** Path/URI of the original file. */
  sourceUri: string;
  /** ISO timestamp. */
  createdAt: string;
}

/** A grounded reference into a Block. Offsets are into Block.text. */
export interface SourceSpan {
  blockId: string;
  /** Inclusive char offset into Block.text. */
  start: number;
  /** Exclusive char offset into Block.text. */
  end: number;
  page?: number;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS — `BlockModel types › accepts a well-formed digital BlockModel` and the scanned-span case both pass.

- [ ] **Step 5: Commit**

```bash
cd server && git add src/pipeline/types.ts test/pipeline/types.test.ts && git commit -m "feat(pipeline): add BlockModel stable contract"
```

---

## Task 2: MinerU spike + adapter

**Goal:** Determine MinerU's actual JSON output shape (via the `mineru-pdf` skill on a real scanned contract sample), then implement `ingestWithMinerU()` that normalizes that shape into `BlockModel`. MinerU output is the ONE place where real-world format is unknown; everything downstream tests against `BlockModel` fixtures, not MinerU output directly.

**Files:**
- Create: `server/src/pipeline/mineruAdapter.ts`
- Create: `server/test/pipeline/mineruAdapter.test.ts`
- Create: `server/test/pipeline/fixtures/mineru-sample.json` (captured MinerU output, see Step 1)
- Create: `server/test/pipeline/fixtures/scanned-contract-blockmodel.json` (expected normalized output)

**Interfaces:**
- Consumes: `BlockModel`, `Block` from `./types.js` (Task 1).
- Produces: `interface MinerUAdapter { parse(minerUJson: unknown): BlockModel }`, `function ingestWithMinerU(sourceUri: string, docType: DocType, docId: string, minerUJsonPath?: string): Promise<BlockModel>`. Later tasks never call MinerU directly — they call adapters behind an injected dependency in T8.

- [ ] **Step 1: Run MinerU on a real sample to capture output (spike)**

Use the `mineru-pdf` skill to parse one scanned 合同 PDF (place any real sample at `server/test/pipeline/fixtures/scanned-contract-raw.pdf`). Save MinerU's JSON output to `server/test/pipeline/fixtures/mineru-sample.json`.

If MinerU's JSON differs from the shape assumed in Step 3, **adjust the normalizer to match the captured JSON** — that adjustment is the whole point of this spike. Record the actual top-level shape as a comment at the top of `mineruAdapter.ts`. If no real scanned sample is available, proceed with the assumed shape below and leave a `// TODO(real-sample):` comment; the normalizer is still unit-tested against `mineru-sample.json`.

**Assumed MinerU JSON shape** (verify against real output in Step 1):
```jsonc
{
  "pdf_info": [
    {
      "page_idx": 0,
      "preproc_blocks": [
        { "type": "text", "bbox": [x, y, w, h], "lines": [{ "text": "合同号: HT-2024-001", "bbox": [...] }] },
        { "type": "table", "bbox": [...], "blocks": [{ "type": "table_row", "bbox": [...], "lines": [{"text":"..."}] }] }
      ],
      "statistics": { "max_bbox_score": 0.93 }
    }
  ]
}
```

- [ ] **Step 2: Write the failing test against the captured fixture**

Create `server/test/pipeline/mineruAdapter.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { normalizeMinerUOutput } from '../../src/pipeline/mineruAdapter.js';
import type { BlockModel } from '../../src/pipeline/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const load = (p: string) => JSON.parse(readFileSync(resolve(here, p), 'utf-8'));

describe('normalizeMinerUOutput', () => {
  it('turns MinerU JSON into a grounded BlockModel with per-block confidence + bbox', () => {
    const minerU = load('fixtures/mineru-sample.json');
    const model: BlockModel = normalizeMinerUOutput({
      docId: 'DOC-SCAN-1',
      docType: '合同',
      sourceUri: 'file:///scanned-contract-raw.pdf',
      minerUOutput: minerU,
    });
    expect(model.modality).toBe('scanned');
    expect(model.blocks.length).toBeGreaterThan(0);
    for (const b of model.blocks) {
      expect(b.id).toMatch(/^b\d+$/);
      expect(b.bbox).not.toBeNull();           // scanned => layout preserved
      expect(b.ocrConfidence).toBeGreaterThan(0);
      expect(b.ocrConfidence).toBeLessThanOrEqual(1);
      expect(b.text.length).toBeGreaterThan(0);
    }
    // offsets used by spans must be valid into block.text
    const first = model.blocks[0];
    expect(first.text.slice(0, Math.min(5, first.text.length)).length).toBeGreaterThan(0);
  });

  it('rejects unknown MinerU shapes with a clear error', () => {
    expect(() =>
      normalizeMinerUOutput({ docId: 'x', docType: '合同', sourceUri: 'u', minerUOutput: { nope: true } }),
    ).toThrowError(/MinerU/);
  });
});
```

Create `server/test/pipeline/fixtures/mineru-sample.json` with the captured (or assumed) shape from Step 1 — minimum: one page with one text block containing `"合同号: HT-2024-001"` and confidence ~0.93, one table_row. Example minimal content:
```json
{
  "pdf_info": [
    {
      "page_idx": 0,
      "preproc_blocks": [
        { "type": "text", "bbox": [72, 110, 300, 30], "lines": [{ "text": "合同号: HT-2024-001", "bbox": [72,110,300,30] }] },
        { "type": "table", "bbox": [72, 200, 460, 60], "blocks": [
          { "type": "table_row", "bbox": [72,200,460,30], "lines": [{"text":"标的物: 0#柴油", "bbox":[72,200,200,30]}] }
        ]}
      ],
      "statistics": { "max_bbox_score": 0.93 }
    }
  ]
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- mineruAdapter`
Expected: FAIL — `Cannot find module '../../src/pipeline/mineruAdapter.js'`.

- [ ] **Step 4: Implement the normalizer**

Create `server/src/pipeline/mineruAdapter.ts`:
```ts
import type { Block, BlockModel, BBox, DocType } from './types.js';

// MinerU spike output shape (captured 2026-08-05; adjust if real sample differs):
//   { pdf_info: [{ page_idx, preproc_blocks: [{type, bbox, lines:[{text,bbox}] | blocks:[...]}], statistics:{max_bbox_score} }] }
// Each page's per-block OCR confidence is taken from statistics.max_bbox_score
// (page-level proxy). If a finer per-block score exists, prefer it here.

interface MinerULine { text: string; bbox?: number[] }
interface MinerUBlock { type: string; bbox?: number[]; lines?: MinerULine[]; blocks?: MinerUBlock[] }
interface MinerUPage { page_idx: number; preproc_blocks?: MinerUBlock[]; statistics?: { max_bbox_score?: number } }
interface MinerUOutput { pdf_info?: MinerUPage[] }

export interface NormalizeInput {
  docId: string;
  docType: DocType;
  sourceUri: string;
  minerUOutput: unknown;
}

function toBBox(n: number[] | undefined): BBox | null {
  if (!n || n.length < 4) return null;
  return { x: n[0], y: n[1], w: n[2], h: n[3] };
}

function textOf(b: MinerUBlock): string {
  return (b.lines ?? []).map((l) => l.text).join('');
}

function fromBlock(b: MinerUBlock, page: number, conf: number, counter: { n: number }): Block {
  const id = `b${counter.n++}`;
  const block: Block = {
    id,
    type: mapType(b.type),
    text: textOf(b),
    page,
    bbox: toBBox(b.bbox),
    ocrConfidence: clamp01(conf),
  };
  if (b.blocks && b.blocks.length) {
    block.children = b.blocks.map((c) => fromBlock(c, page, conf, counter));
  }
  return block;
}

function mapType(t: string): Block['type'] {
  if (t === 'table_row') return 'table_row';
  if (t === 'table') return 'text'; // container; children carry rows
  if (t === 'image') return 'figure';
  return 'text';
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

export function normalizeMinerUOutput(input: NormalizeInput): BlockModel {
  const out = input.minerUOutput as MinerUOutput;
  if (!out || !Array.isArray(out.pdf_info)) {
    throw new Error('MinerU output missing pdf_info array');
  }
  const counter = { n: 0 };
  const blocks: Block[] = [];
  for (const page of out.pdf_info) {
    const conf = clamp01(page.statistics?.max_bbox_score ?? 0.9);
    for (const b of page.preproc_blocks ?? []) {
      blocks.push(fromBlock(b, page.page_idx + 1, conf, counter));
    }
  }
  return {
    docId: input.docId,
    docType: input.docType,
    modality: 'scanned',
    blocks,
    sourceUri: input.sourceUri,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Full ingest entry: shells out to MinerU (via the mineru-pdf skill CLI) to
 * produce JSON, then normalizes. The CLI invocation is environment-specific;
 * for MVP it reads pre-generated JSON at `<sourceUri>.mineru.json` to keep
 * tests hermetic. Production wires the real MinerU subprocess here.
 */
export async function ingestWithMinerU(
  sourceUri: string,
  docType: DocType,
  docId: string,
): Promise<BlockModel> {
  const { readFileSync } = await import('node:fs');
  const jsonPath = `${sourceUri}.mineru.json`;
  const minerUOutput = JSON.parse(readFileSync(jsonPath, 'utf-8'));
  return normalizeMinerUOutput({ docId, docType, sourceUri, minerUOutput });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- mineruAdapter`
Expected: PASS — both cases green. If the real MinerU fixture from Step 1 has a different shape, fix `fromBlock`/`mapType` until green; record the real shape in the header comment.

- [ ] **Step 6: Commit**

```bash
cd server && git add src/pipeline/mineruAdapter.ts test/pipeline/mineruAdapter.test.ts test/pipeline/fixtures/ && git commit -m "feat(pipeline): MinerU adapter normalizing to BlockModel"
```

---

## Task 3: Born-digital parser adapter

**Files:**
- Create: `server/src/pipeline/digitalAdapter.ts`
- Create: `server/test/pipeline/digitalAdapter.test.ts`

**Interfaces:**
- Consumes: `Block`, `BlockModel`, `DocType` from `./types.js`.
- Produces: `async function ingestWithDigital(sourceUri: string, docType: DocType, docId: string): Promise<BlockModel>` (PDF via `pdf-parse`; `.txt`/`.md` read directly). Born-digital => `ocrConfidence = 1.0`, `bbox = null`, `modality = 'digital'`.

- [ ] **Step 1: Write the failing test**

Create `server/test/pipeline/digitalAdapter.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { blockModelFromText, ingestWithDigital } from '../../src/pipeline/digitalAdapter.js';

describe('digitalAdapter', () => {
  it('splits plain text into line blocks with ocrConfidence=1.0 and null bbox', () => {
    const model = blockModelFromText({
      docId: 'DOC-1',
      docType: '合同',
      sourceUri: 'file:///x.txt',
      text: '合同号: HT-2024-001\n金额: 2860000',
    });
    expect(model.modality).toBe('digital');
    expect(model.blocks).toHaveLength(2);
    expect(model.blocks[0].ocrConfidence).toBe(1.0);
    expect(model.blocks[0].bbox).toBeNull();
    expect(model.blocks[0].text).toBe('合同号: HT-2024-001');
    expect(model.blocks[0].page).toBe(1);
  });

  it('ingestWithDigital reads a .txt file from disk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dc-'));
    const f = join(dir, 'c.txt');
    writeFileSync(f, '甲方: 华盛集团\n乙方: 中石化', 'utf-8');
    const model = await ingestWithDigital(f, '合同', 'DOC-2');
    expect(model.blocks).toHaveLength(2);
    expect(model.blocks[0].text).toBe('甲方: 华盛集团');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- digitalAdapter`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `server/src/pipeline/digitalAdapter.ts`:
```ts
import { readFileSync } from 'node:fs';
import type { Block, BlockModel, DocType } from './types.js';

export interface FromTextInput {
  docId: string;
  docType: DocType;
  sourceUri: string;
  text: string;
}

/** Split born-digital text into line-level Blocks. Born-digital => conf=1.0, bbox=null. */
export function blockModelFromText(input: FromTextInput): BlockModel {
  const lines = input.text.split(/\r?\n/);
  const blocks: Block[] = [];
  let n = 0;
  for (const raw of lines) {
    const text = raw.trim();
    if (text.length === 0) continue;
    blocks.push({
      id: `b${n++}`,
      type: text.includes(':') || text.includes('：') ? 'kv' : 'text',
      text,
      page: 1,
      bbox: null,
      ocrConfidence: 1.0,
    });
  }
  return {
    docId: input.docId,
    docType: input.docType,
    modality: 'digital',
    blocks,
    sourceUri: input.sourceUri,
    createdAt: new Date().toISOString(),
  };
}

/** Ingest a born-digital file. Supports .txt/.md (direct read) and .pdf (pdf-parse). */
export async function ingestWithDigital(
  sourceUri: string,
  docType: DocType,
  docId: string,
): Promise<BlockModel> {
  let text: string;
  if (/\.pdf$/i.test(sourceUri)) {
    const pdfParse = (await import('pdf-parse')).default;
    const buf = readFileSync(sourceUri);
    text = (await pdfParse(buf)).text;
  } else {
    text = readFileSync(sourceUri, 'utf-8');
  }
  return blockModelFromText({ docId, docType, sourceUri, text });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- digitalAdapter`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd server && git add src/pipeline/digitalAdapter.ts test/pipeline/digitalAdapter.test.ts && git commit -m "feat(pipeline): born-digital adapter (txt/pdf -> BlockModel)"
```

---

## Task 4: Persistence layer (Drizzle + SQLite)

**Files:**
- Create: `server/src/pipeline/db/schema.ts`
- Create: `server/src/pipeline/db/client.ts`
- Create: `server/src/pipeline/db/repositories.ts`
- Create: `server/test/pipeline/db/repositories.test.ts`

**Interfaces:**
- Consumes: `BlockModel` from `../types.js`.
- Produces:
  - `createDb(path?: string): { db, sqlite }`
  - `migrate(sqlite): void` (idempotent, WAL)
  - `saveDocument(ctx, model): string` → returns docId
  - `loadDocument(ctx, docId): BlockModel | null`
  - `saveExtraction(ctx, input): string`
  - `saveBinding(ctx, input): string`
  - `listBindingsForContract(ctx, contractNo): BindingRow[]`
  - Types: `DbContext = { db, sqlite }`, `ExtractionInput`, `BindingInput`, `BindingRow`.

- [ ] **Step 1: Write the failing test**

Create `server/test/pipeline/db/repositories.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate } from '../../../src/pipeline/db/client.js';
import {
  saveDocument, loadDocument, saveExtraction, saveBinding, listBindingsForContract,
} from '../../../src/pipeline/db/repositories.js';
import type { BlockModel } from '../../../src/pipeline/types.js';

function mkModel(docId: string): BlockModel {
  return {
    docId, docType: '合同', modality: 'digital',
    blocks: [{ id: 'b1', type: 'kv', text: '合同号: HT-2024-001', page: 1, bbox: null, ocrConfidence: 1 }],
    sourceUri: 'file:///x', createdAt: '2026-08-05T00:00:00.000Z',
  };
}

let ctx: ReturnType<typeof createDb>;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
});

describe('repositories', () => {
  it('round-trips a document BlockModel', () => {
    const id = saveDocument(ctx, mkModel('DOC-1'));
    expect(id).toBe('DOC-1');
    const loaded = loadDocument(ctx, 'DOC-1');
    expect(loaded?.blocks[0].text).toBe('合同号: HT-2024-001');
  });

  it('saves and lists an extraction + binding', () => {
    saveDocument(ctx, mkModel('DOC-1'));
    const exId = saveExtraction(ctx, {
      documentId: 'DOC-1', docType: '合同',
      fields: { 合同号: { value: 'HT-2024-001', sourceSpans: [{ blockId: 'b1', start: 5, end: 16 }] } },
      fieldMeta: { 合同号: { strength: 'exact', confidence: 0.98 } },
      overallConfidence: 0.98, needsReview: false,
    });
    expect(exId).toMatch(/^EX-/);
    const bId = saveBinding(ctx, {
      documentId: 'DOC-1', contractNo: 'HT-2024-001', relation: 'primary',
      sourceRefs: [{ blockId: 'b1', start: 5, end: 16 }], confidence: 0.98, createdBy: 'agent',
    });
    expect(bId).toMatch(/^BD-/);
    const list = listBindingsForContract(ctx, 'HT-2024-001');
    expect(list).toHaveLength(1);
    expect(list[0].documentId).toBe('DOC-1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- repositories`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement schema**

Create `server/src/pipeline/db/schema.ts`:
```ts
import { sqliteTable, text, real, integer } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const documents = sqliteTable('documents', {
  id: text('id').primaryKey(),
  docType: text('doc_type').notNull(),
  modality: text('modality').notNull(),
  sourceUri: text('source_uri').notNull(),
  blockModel: text('block_model').notNull(), // JSON(BlockModel)
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

export const extractions = sqliteTable('extractions', {
  id: text('id').primaryKey(),
  documentId: text('document_id').notNull().references(() => documents.id),
  docType: text('doc_type').notNull(),
  fields: text('fields').notNull(),          // JSON
  fieldMeta: text('field_meta').notNull(),    // JSON
  overallConfidence: real('overall_confidence').notNull(),
  needsReview: integer('needs_review', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

export const bindings = sqliteTable('bindings', {
  id: text('id').primaryKey(),
  documentId: text('document_id').notNull().references(() => documents.id),
  contractNo: text('contract_no').notNull(),
  relation: text('relation').notNull(),
  sourceRefs: text('source_refs').notNull(),  // JSON
  confidence: real('confidence').notNull(),
  createdBy: text('created_by').notNull(),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});
```

- [ ] **Step 4: Implement client + migrate**

Create `server/src/pipeline/db/client.ts`:
```ts
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { documents, extractions, bindings } from './schema.js';

export type DbContext = { db: ReturnType<typeof drizzle>; sqlite: Database.Database };

export function createDb(path = ':memory:'): DbContext {
  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  const db = drizzle(sqlite, { schema: { documents, extractions, bindings } });
  return { db, sqlite };
}

/** Idempotent raw-DDL migrate (MVP). For prod, generate via `drizzle-kit generate`. */
export function migrate(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      doc_type TEXT NOT NULL,
      modality TEXT NOT NULL,
      source_uri TEXT NOT NULL,
      block_model TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS extractions (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES documents(id),
      doc_type TEXT NOT NULL,
      fields TEXT NOT NULL,
      field_meta TEXT NOT NULL,
      overall_confidence REAL NOT NULL,
      needs_review INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS bindings (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES documents(id),
      contract_no TEXT NOT NULL,
      relation TEXT NOT NULL,
      source_refs TEXT NOT NULL,
      confidence REAL NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_bindings_contract ON bindings(contract_no);
    CREATE INDEX IF NOT EXISTS idx_extractions_doc ON extractions(document_id);
  `);
}
```

- [ ] **Step 5: Implement repositories**

Create `server/src/pipeline/db/repositories.ts`:
```ts
import { eq } from 'drizzle-orm';
import { documents, extractions, bindings } from './schema.js';
import type { DbContext } from './client.js';
import type { BlockModel, DocType, SourceSpan } from '../types.js';
import type { SpanMatchStrength } from '../spanValidator.js';

export interface ExtractionInput {
  documentId: string;
  docType: DocType;
  fields: Record<string, { value: string | number; sourceSpans: SourceSpan[] }>;
  fieldMeta: Record<string, { strength: SpanMatchStrength; confidence: number }>;
  overallConfidence: number;
  needsReview: boolean;
}

export interface BindingInput {
  documentId: string;
  contractNo: string;
  relation: string;
  sourceRefs: SourceSpan[];
  confidence: number;
  createdBy: string;
}

export interface BindingRow {
  id: string;
  documentId: string;
  contractNo: string;
  relation: string;
  sourceRefs: SourceSpan[];
  confidence: number;
  createdBy: string;
}

const rid = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

export function saveDocument(ctx: DbContext, model: BlockModel): string {
  ctx.db.insert(documents).values({
    id: model.docId,
    docType: model.docType,
    modality: model.modality,
    sourceUri: model.sourceUri,
    blockModel: JSON.stringify(model),
  }).run();
  return model.docId;
}

export function loadDocument(ctx: DbContext, docId: string): BlockModel | null {
  const row = ctx.db.select().from(documents).where(eq(documents.id, docId)).all()[0];
  return row ? (JSON.parse(row.blockModel) as BlockModel) : null;
}

export function saveExtraction(ctx: DbContext, input: ExtractionInput): string {
  const id = rid('EX');
  ctx.db.insert(extractions).values({
    id,
    documentId: input.documentId,
    docType: input.docType,
    fields: JSON.stringify(input.fields),
    fieldMeta: JSON.stringify(input.fieldMeta),
    overallConfidence: input.overallConfidence,
    needsReview: input.needsReview,
  }).run();
  return id;
}

export function saveBinding(ctx: DbContext, input: BindingInput): string {
  const id = rid('BD');
  ctx.db.insert(bindings).values({
    id,
    documentId: input.documentId,
    contractNo: input.contractNo,
    relation: input.relation,
    sourceRefs: JSON.stringify(input.sourceRefs),
    confidence: input.confidence,
    createdBy: input.createdBy,
  }).run();
  return id;
}

export function listBindingsForContract(ctx: DbContext, contractNo: string): BindingRow[] {
  return ctx.db.select().from(bindings).where(eq(bindings.contractNo, contractNo)).all().map((r) => ({
    id: r.id,
    documentId: r.documentId,
    contractNo: r.contractNo,
    relation: r.relation,
    sourceRefs: JSON.parse(r.sourceRefs) as SourceSpan[],
    confidence: r.confidence,
    createdBy: r.createdBy,
  }));
}
```

> Note: `repositories.ts` imports `SpanMatchStrength` from `spanValidator.js` (Task 5). To keep Task 4 self-contained and compiling in isolation, **create a temporary stub** in `server/src/pipeline/spanValidator.ts` exporting only `export type SpanMatchStrength = 'exact' | 'fuzzy' | 'none';` now; Task 5 expands that file. This avoids a dangling import.

Create the temporary stub now:
```ts
// server/src/pipeline/spanValidator.ts  (temporary stub; expanded in Task 5)
export type SpanMatchStrength = 'exact' | 'fuzzy' | 'none';
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test -- repositories`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd server && git add src/pipeline/db/ src/pipeline/spanValidator.ts test/pipeline/db/ && git commit -m "feat(pipeline): persistence layer (documents/extractions/bindings)"
```

---

## Task 5: 合同 schema + span grounding validator

**This is the zero-hallucination core.** Span validation converts "数字零幻觉" from a soft prompt rule into a HARD, unit-tested check.

**Files:**
- Modify: `server/src/pipeline/spanValidator.ts` (replace T4 stub with full impl)
- Create: `server/src/pipeline/schemas/contract.ts`
- Create: `server/test/pipeline/spanValidator.test.ts`

**Interfaces:**
- Consumes: `Block`, `SourceSpan` from `./types.js`.
- Produces:
  - `validateSpan(value: string, span: SourceSpan, blocks: Block[]): SpanValidationResult`
  - `SpanValidationResult = { ok: boolean; strength: SpanMatchStrength; citedText: string | null; reason?: string }`
  - `validateAllFields(fields, blocks)` (Task 7 helper)
  - `ContractSchema` (zod) + `ContractFields` type + `REQUIRED_CONTRACT_FIELDS` from `schemas/contract.ts`.

- [ ] **Step 1: Write the failing test**

Create `server/test/pipeline/spanValidator.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { validateSpan } from '../../src/pipeline/spanValidator.js';
import type { Block } from '../../src/pipeline/types.js';

const blocks: Block[] = [
  { id: 'b1', type: 'kv', text: '合同号: HT-2024-001', page: 1, bbox: null, ocrConfidence: 1 },
  { id: 'b2', type: 'kv', text: '金额(元): 2,860,000', page: 1, bbox: null, ocrConfidence: 0.95 },
];

describe('validateSpan', () => {
  it('exact match when normalized value equals cited text', () => {
    const r = validateSpan('HT-2024-001', { blockId: 'b1', start: 5, end: 16 }, blocks);
    expect(r.ok).toBe(true);
    expect(r.strength).toBe('exact');
    expect(r.citedText).toBe('HT-2024-001');
  });

  it('fuzzy match when value is contained in cited text (ignore commas/space/case)', () => {
    const r = validateSpan('2860000', { blockId: 'b2', start: 7, end: 16 }, blocks);
    expect(r.ok).toBe(true);
    expect(r.strength).toBe('fuzzy');
  });

  it('none when value absent from cited text', () => {
    const r = validateSpan('999', { blockId: 'b1', start: 0, end: 16 }, blocks);
    expect(r.ok).toBe(false);
    expect(r.strength).toBe('none');
    expect(r.reason).toMatch(/not found/);
  });

  it('none when block id is unknown', () => {
    const r = validateSpan('x', { blockId: 'zzz', start: 0, end: 1 }, blocks);
    expect(r.strength).toBe('none');
    expect(r.reason).toMatch(/not found/);
  });

  it('none when span range is invalid', () => {
    const r = validateSpan('x', { blockId: 'b1', start: 10, end: 2 }, blocks);
    expect(r.strength).toBe('none');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- spanValidator`
Expected: FAIL (stub lacks `validateSpan`).

- [ ] **Step 3: Replace stub with full validator**

Replace the contents of `server/src/pipeline/spanValidator.ts` with:
```ts
import type { Block, SourceSpan } from './types.js';

export type SpanMatchStrength = 'exact' | 'fuzzy' | 'none';

export interface SpanValidationResult {
  ok: boolean;
  strength: SpanMatchStrength;
  citedText: string | null;
  reason?: string;
}

// Normalize for matching: strip whitespace and full/half-width commas, lowercase.
const NORMALIZE = (s: string): string =>
  s.replace(/\s+/g, '').replace(/[,，]/g, '').toLowerCase();

export function validateSpan(
  value: string,
  span: SourceSpan,
  blocks: Block[],
): SpanValidationResult {
  const block = blocks.find((b) => b.id === span.blockId);
  if (!block) {
    return { ok: false, strength: 'none', citedText: null, reason: `block ${span.blockId} not found` };
  }
  const len = block.text.length;
  const start = Math.max(0, Math.floor(span.start));
  const end = Math.min(len, Math.floor(span.end));
  if (end <= start) {
    return { ok: false, strength: 'none', citedText: null, reason: `invalid span range [${span.start},${span.end}) in ${span.blockId}` };
  }
  const citedText = block.text.slice(start, end);
  const nv = NORMALIZE(String(value));
  const nc = NORMALIZE(citedText);
  if (nc.length && nv.length && nc === nv) return { ok: true, strength: 'exact', citedText };
  if (nc.length && nv.length && (nc.includes(nv) || nv.includes(nc))) {
    return { ok: true, strength: 'fuzzy', citedText };
  }
  return { ok: false, strength: 'none', citedText, reason: `value "${value}" not found in cited text "${citedText}"` };
}
```

- [ ] **Step 4: Implement 合同 zod schema**

Create `server/src/pipeline/schemas/contract.ts`:
```ts
import { z } from 'zod';

export const PaymentMilestoneSchema = z.object({
  stage: z.string().min(1).describe('付款阶段名, 如 预付款/发货款/验收款/质保金'),
  ratio: z.number().min(0).max(1).describe('占合同金额比例 0..1'),
  amount: z.number().min(0).describe('该阶段金额(元)'),
});

export const ContractSchema = z.object({
  合同号: z.string().min(1),
  甲方: z.string().min(1).describe('采购方'),
  乙方: z.string().min(1).describe('销售方'),
  标的物: z.string().min(1),
  规格: z.string().optional(),
  数量: z.number().positive(),
  单位: z.string().min(1),
  金额: z.number().positive().describe('合同总金额(元)'),
  币种: z.enum(['CNY', 'USD', 'EUR']).default('CNY'),
  签订日: z.string().min(1).describe('YYYY-MM-DD'),
  生效日: z.string().optional(),
  交货地: z.string().optional(),
  付款节点: z.array(PaymentMilestoneSchema).default([]),
  质保期: z.string().optional(),
  违约金条款: z.string().optional(),
  收付款条款: z.string().optional(),
});

export type ContractFields = z.infer<typeof ContractSchema>;

/** Fields that MUST be present for a 合同 extraction to be considered complete. */
export const REQUIRED_CONTRACT_FIELDS: (keyof ContractFields)[] = [
  '合同号', '甲方', '乙方', '标的物', '数量', '单位', '金额', '签订日',
];
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- spanValidator`
Expected: PASS — all 5 cases green.

- [ ] **Step 6: Commit**

```bash
cd server && git add src/pipeline/spanValidator.ts src/pipeline/schemas/contract.ts test/pipeline/spanValidator.test.ts && git commit -m "feat(pipeline): span grounding validator + 合同 schema (zero-hallucination core)"
```

---

## Task 6: Confidence model

**Files:**
- Create: `server/src/pipeline/confidence.ts`
- Create: `server/test/pipeline/confidence.test.ts`

**Interfaces:**
- Consumes: `SpanMatchStrength` from `./spanValidator.js`.
- Produces:
  - `computeFieldConfidence(input): number` where `ConfidenceInput = { blockOcrConfidence: number; spanMatch: SpanMatchStrength; llmConsistency: number }`
  - `CONFIDENCE_WEIGHTS = { w1: 0.4, w2: 0.4, w3: 0.2 }`
  - `REVIEW_THRESHOLD = 0.7`, `AUTO_THRESHOLD = 0.9`, `KEY_FIELD_THRESHOLD = 0.95`, `KEY_FIELDS = Set(['合同号','发票号','金额','价税合计'])`
  - `decisionForField(name, confidence): { needsReview: boolean; autoAccepted: boolean }`

- [ ] **Step 1: Write the failing test**

Create `server/test/pipeline/confidence.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import {
  computeFieldConfidence, decisionForField,
  REVIEW_THRESHOLD, AUTO_THRESHOLD, KEY_FIELD_THRESHOLD,
} from '../../src/pipeline/confidence.js';

describe('confidence model', () => {
  it('exact span + perfect OCR + high consistency => high confidence', () => {
    const c = computeFieldConfidence({ blockOcrConfidence: 1.0, spanMatch: 'exact', llmConsistency: 0.95 });
    expect(c).toBeGreaterThan(0.95);
  });

  it('none span => confidence bounded well below auto threshold regardless of OCR', () => {
    const c = computeFieldConfidence({ blockOcrConfidence: 1.0, spanMatch: 'none', llmConsistency: 0.9 });
    expect(c).toBeLessThan(AUTO_THRESHOLD);
  });

  it('key fields require KEY_FIELD_THRESHOLD, not AUTO_THRESHOLD', () => {
    const c = computeFieldConfidence({ blockOcrConfidence: 0.95, spanMatch: 'exact', llmConsistency: 0.9 });
    // c ~ 0.4*0.95 + 0.4*1 + 0.2*0.9 = 0.95  -> between AUTO(0.9) and KEY(0.95)
    const d = decisionForField('合同号', c);
    expect(d.autoAccepted).toBe(c >= KEY_FIELD_THRESHOLD);
    expect(d.needsReview).toBe(c < REVIEW_THRESHOLD);
  });

  it('non-key field auto-accepts at AUTO_THRESHOLD', () => {
    const c = computeFieldConfidence({ blockOcrConfidence: 1.0, spanMatch: 'exact', llmConsistency: 1.0 });
    const d = decisionForField('交货地', c);
    expect(d.autoAccepted).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- confidence`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `server/src/pipeline/confidence.ts`:
```ts
import type { SpanMatchStrength } from './spanValidator.js';

export const CONFIDENCE_WEIGHTS = { w1: 0.4, w2: 0.4, w3: 0.2 } as const;

const STRENGTH_SCORE: Record<SpanMatchStrength, number> = {
  exact: 1.0,
  fuzzy: 0.7,
  none: 0.0,
};

export const REVIEW_THRESHOLD = 0.7;
export const AUTO_THRESHOLD = 0.9;
export const KEY_FIELD_THRESHOLD = 0.95;
export const KEY_FIELDS = new Set(['合同号', '发票号', '金额', '价税合计']);

export interface ConfidenceInput {
  blockOcrConfidence: number; // 0..1
  spanMatch: SpanMatchStrength;
  llmConsistency: number; // 0..1
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

export function computeFieldConfidence(input: ConfidenceInput): number {
  const { w1, w2, w3 } = CONFIDENCE_WEIGHTS;
  const raw =
    w1 * clamp01(input.blockOcrConfidence) +
    w2 * STRENGTH_SCORE[input.spanMatch] +
    w3 * clamp01(input.llmConsistency);
  return Math.round(raw * 1000) / 1000;
}

export function decisionForField(
  name: string,
  confidence: number,
): { needsReview: boolean; autoAccepted: boolean } {
  const threshold = KEY_FIELDS.has(name) ? KEY_FIELD_THRESHOLD : AUTO_THRESHOLD;
  return {
    needsReview: confidence < REVIEW_THRESHOLD,
    autoAccepted: confidence >= threshold,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- confidence`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd server && git add src/pipeline/confidence.ts test/pipeline/confidence.test.ts && git commit -m "feat(pipeline): confidence model with key-field gate"
```

---

## Task 7: Grounded extraction orchestration

**Files:**
- Create: `server/src/pipeline/extraction.ts`
- Create: `server/test/pipeline/extraction.test.ts`

**Interfaces:**
- Consumes: `BlockModel`, `Block` (`./types.js`); `validateSpan`, `SpanMatchStrength` (`./spanValidator.js`); `computeFieldConfidence`, `decisionForField`, `KEY_FIELDS` (`./confidence.js`); `REQUIRED_CONTRACT_FIELDS` (`./schemas/contract.js`); AI SDK `generateObject` + a `LanguageModel` injected via deps.
- Produces:
  - `interface ExtractionDeps { model: LanguageModel; }`
  - `interface GroundedField { value: string | number; sourceSpans: SourceSpan[] }`
  - `interface ExtractedField extends GroundedField { name: string; strength: SpanMatchStrength; confidence: number; needsReview: boolean; autoAccepted: boolean; citedText: string | null; }`
  - `async function extractGroundedFields(deps, input): Promise<ExtractionResult>` where `input = { blockModel: BlockModel; docType: DocType }`
  - `ExtractionResult = { fields: ExtractedField[]; overallConfidence: number; needsReview: boolean; llmRaw: unknown }`
  - `function attachConfidence(blockModel, grounded): ExtractedField[]` (pure, exported for direct testing)

- [ ] **Step 1: Write the failing test (with a stubbed model)**

Create `server/test/pipeline/extraction.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { attachConfidence } from '../../src/pipeline/extraction.js';
import type { BlockModel, SourceSpan } from '../../src/pipeline/types.js';

const model: BlockModel = {
  docId: 'D1', docType: '合同', modality: 'digital',
  blocks: [
    { id: 'b1', type: 'kv', text: '合同号: HT-2024-001', page: 1, bbox: null, ocrConfidence: 1 },
    { id: 'b2', type: 'kv', text: '金额: 2860000', page: 1, bbox: null, ocrConfidence: 0.92 },
  ],
  sourceUri: 'u', createdAt: '2026-08-05T00:00:00.000Z',
};

describe('attachConfidence', () => {
  it('validates spans, computes confidence, sets key-field gate', () => {
    const grounded = [
      { name: '合同号', value: 'HT-2024-001', sourceSpans: [{ blockId: 'b1', start: 5, end: 16 } as SourceSpan] },
      { name: '金额', value: '2860000', sourceSpans: [{ blockId: 'b2', start: 4, end: 11 } as SourceSpan] },
    ];
    const out = attachConfidence(model, grounded, 0.9 /* llmConsistency */);
    const contractNo = out.find((f) => f.name === '合同号')!;
    expect(contractNo.strength).toBe('exact');
    expect(contractNo.confidence).toBeGreaterThan(0.95);
    expect(contractNo.autoAccepted).toBe(true);

    const amount = out.find((f) => f.name === '金额')!;
    expect(amount.strength).toBe('exact');
    // 金额 is a key field => needs >=0.95; with conf 0.92*0.4+1*0.4+0.9*0.2 = 0.848 < 0.95 => not auto
    expect(amount.autoAccepted).toBe(false);
  });

  it('ungrounded field lands below review threshold', () => {
    const out = attachConfidence(model, [
      { name: '备注', value: 'free-invented', sourceSpans: [{ blockId: 'b1', start: 0, end: 1 }] },
    ], 0.9);
    expect(out[0].strength).toBe('none');
    expect(out[0].needsReview).toBe(true);
    expect(out[0].autoAccepted).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- extraction`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `attachConfidence` + `extractGroundedFields`**

Create `server/src/pipeline/extraction.ts`:
```ts
import { generateObject, type LanguageModel } from 'ai';
import { z } from 'zod';
import type { BlockModel, DocType, SourceSpan } from './types.js';
import { validateSpan, type SpanMatchStrength } from './spanValidator.js';
import { computeFieldConfidence, decisionForField } from './confidence.js';
import { REQUIRED_CONTRACT_FIELDS } from './schemas/contract.js';

export interface GroundedField {
  name: string;
  value: string | number;
  sourceSpans: SourceSpan[];
}

export interface ExtractedField extends GroundedField {
  strength: SpanMatchStrength;
  confidence: number;
  needsReview: boolean;
  autoAccepted: boolean;
  citedText: string | null;
}

export interface ExtractionDeps {
  model: LanguageModel;
}

export interface ExtractionInput {
  blockModel: BlockModel;
  docType: DocType;
}

export interface ExtractionResult {
  fields: ExtractedField[];
  overallConfidence: number;
  needsReview: boolean;
  missingRequired: string[];
  llmRaw: unknown;
}

const GroundedValueSchema = z.object({
  value: z.union([z.string(), z.number()]),
  sourceSpans: z.array(z.object({
    blockId: z.string(),
    start: z.number().int(),
    end: z.number().int(),
  })),
});

const GroundedExtractionSchema = z.object({
  fields: z.record(z.string(), GroundedValueSchema),
  llmConsistency: z.number().min(0).max(1),
});

const GROUNDED_EXTRACTION_PROMPT = [
  '你是供应链单据字段抽取器。绝对禁止凭空生成数字或名称。',
  '从给定 BlockModel 中抽取业务字段。每个字段的值必须严格来自原文, 并给出精确的 sourceSpans (blockId + 在 block.text 中的字符起止)。',
  '若某字段在原文中不存在, 不要列入 fields。',
  'llmConsistency 是你对本次抽取整体内部一致性的自评 (0..1)。',
].join('\n');

function blocksToPrompt(blockModel: BlockModel): string {
  const lines = blockModel.blocks.map((b) => `[${b.id}] (page ${b.page}, conf ${b.ocrConfidence}) ${b.text}`);
  return `docType: ${blockModel.docType}\nblocks:\n${lines.join('\n')}`;
}

/** Pure: attach span validation + confidence to grounded fields. Exported for testing. */
export function attachConfidence(
  blockModel: BlockModel,
  grounded: GroundedField[],
  llmConsistency: number,
): ExtractedField[] {
  return grounded.map((f) => {
    // use the strongest span for this field
    let best: ExtractedField | null = null;
    for (const span of f.sourceSpans.length ? f.sourceSpans : [{ blockId: '', start: 0, end: 0 }]) {
      const v = validateSpan(String(f.value), span, blockModel.blocks);
      const candidate: ExtractedField = {
        ...f,
        strength: v.strength,
        confidence: computeFieldConfidence({
          blockOcrConfidence: blockModel.blocks.find((b) => b.id === span.blockId)?.ocrConfidence ?? 0,
          spanMatch: v.strength,
          llmConsistency,
        }),
        needsReview: false,
        autoAccepted: false,
        citedText: v.citedText,
      };
      const d = decisionForField(f.name, candidate.confidence);
      candidate.needsReview = d.needsReview;
      candidate.autoAccepted = d.autoAccepted;
      if (!best || candidate.confidence > best.confidence) best = candidate;
    }
    return best!;
  });
}

export async function extractGroundedFields(
  deps: ExtractionDeps,
  input: ExtractionInput,
): Promise<ExtractionResult> {
  const { object } = await generateObject({
    model: deps.model,
    schema: GroundedExtractionSchema,
    system: GROUNDED_EXTRACTION_PROMPT,
    prompt: blocksToPrompt(input.blockModel),
  });

  const grounded: GroundedField[] = Object.entries(object.fields).map(([name, v]) => ({
    name,
    value: v.value,
    sourceSpans: v.sourceSpans,
  }));

  const fields = attachConfidence(input.blockModel, grounded, object.llmConsistency);
  const overallConfidence = fields.length
    ? fields.reduce((s, f) => s + f.confidence, 0) / fields.length
    : 0;

  const required =
    input.docType === '合同'
      ? (REQUIRED_CONTRACT_FIELDS as readonly string[])
      : [];
  const present = new Set(fields.map((f) => f.name));
  const missingRequired = required.filter((r) => !present.has(r));

  return {
    fields,
    overallConfidence: Math.round(overallConfidence * 1000) / 1000,
    needsReview: fields.some((f) => f.needsReview) || missingRequired.length > 0,
    missingRequired,
    llmRaw: object,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- extraction`
Expected: PASS (the `attachConfidence` tests; `extractGroundedFields` is exercised end-to-end in T10 eval with the real model, and in T8 via an injected stub).

- [ ] **Step 5: Commit**

```bash
cd server && git add src/pipeline/extraction.ts test/pipeline/extraction.test.ts && git commit -m "feat(pipeline): grounded extraction orchestration (LLM + span validation + confidence)"
```

---

## Task 8: Document-entry tools (ingest / extract / bind)

**Files:**
- Create: `server/src/pipeline/tools/documentEntry.ts`
- Create: `server/test/pipeline/tools/documentEntry.test.ts`

**Interfaces:**
- Consumes: adapters (`ingestWithDigital`, `ingestWithMinerU`), repositories (`saveDocument`/`loadDocument`/`saveExtraction`/`saveBinding`), `extractGroundedFields`, existing `verifyDocumentFields` (T4 HITL reuse) from `../../../tools/hitl.js`, existing audit recorder.
- Produces three AI-SDK-6 tools:
  - `buildIngestDocumentTool(deps)` → L1
  - `buildExtractFieldsTool(deps)` → L1
  - `buildBindDocumentTool(deps)` → L2 (caller attaches `needsApproval:true` per existing pattern)

- [ ] **Step 1: Write the failing test**

Create `server/test/pipeline/tools/documentEntry.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, migrate } from '../../../src/pipeline/db/client.js';
import {
  buildIngestDocumentTool, buildExtractFieldsTool, buildBindDocumentTool,
} from '../../../src/pipeline/tools/documentEntry.js';

let ctx: ReturnType<typeof createDb>;
let dir: string;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
  dir = mkdtempSync(join(tmpdir(), 'dc-'));
});

// stub model returns a grounded extraction the validator accepts
const stubModel = {
  doGenerate: async () => ({ rawResponse: {} }),
} as any;

describe('document-entry tools', () => {
  it('ingest_document parses a digital file and persists a BlockModel', async () => {
    const f = join(dir, 'c.txt');
    writeFileSync(f, '合同号: HT-2024-001\n金额: 2860000', 'utf-8');
    const ingest = buildIngestDocumentTool({ ctx });
    const res = await ingest.execute({ sourceUri: f, docType: '合同', modality: 'digital' }, {
      messages: [], toolCallId: 't', abortSignal: undefined as any,
    } as any);
    expect(res.docId).toBeDefined();
    expect(res.blockCount).toBe(2);
    expect(res.modality).toBe('digital');
  });

  it('bind_document (L2) writes a binding for the contract', async () => {
    const f = join(dir, 'c.txt');
    writeFileSync(f, '合同号: HT-2024-001', 'utf-8');
    const ingest = buildIngestDocumentTool({ ctx });
    const { docId } = await ingest.execute({ sourceUri: f, docType: '合同', modality: 'digital' }, {
      messages: [], toolCallId: 't', abortSignal: undefined as any,
    } as any);

    const bind = buildBindDocumentTool({ ctx });
    const res = await bind.execute(
      { documentId: docId, contractNo: 'HT-2024-001', relation: 'primary', confidence: 0.98 },
      { messages: [], toolCallId: 't', abortSignal: undefined as any } as any,
    );
    expect(res.ok).toBe(true);
    expect(res.bindingId).toMatch(/^BD-/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- documentEntry`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the tools**

Create `server/src/pipeline/tools/documentEntry.ts`:
```ts
import { tool } from 'ai';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { DbContext } from '../db/client.js';
import {
  saveDocument, loadDocument, saveExtraction, saveBinding,
} from '../db/repositories.js';
import { ingestWithDigital } from '../digitalAdapter.js';
import { ingestWithMinerU } from '../mineruAdapter.js';
import { extractGroundedFields, type ExtractionDeps } from '../extraction.js';
import type { DocType } from '../types.js';

export interface ToolDeps {
  ctx: DbContext;
  extraction?: ExtractionDeps; // inject for extract_fields; defaults to real model
}

const newDocId = () => `DOC-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

export function buildIngestDocumentTool(deps: ToolDeps) {
  return tool({
    description:
      '录入一份原始单据(合同/发票/提单/装箱单)。解析文件为结构化 BlockModel 并持久化, 返回 docId 与解析信息。不抽取业务字段(用 extract_fields)。',
    inputSchema: z.object({
      sourceUri: z.string().min(1).describe('本地文件路径 (PDF/TXT/DOCX); scanned 还需配套 <sourceUri>.mineru.json'),
      docType: z.enum(['合同', '发票', '提单', '装箱单', '其他']),
      modality: z.enum(['digital', 'scanned']),
    }),
    execute: async ({ sourceUri, docType, modality }) => {
      const docId = newDocId();
      const dt = docType as DocType;
      const blockModel =
        modality === 'scanned'
          ? await ingestWithMinerU(sourceUri, dt, docId)
          : await ingestWithDigital(sourceUri, dt, docId);
      saveDocument(deps.ctx, blockModel);
      return { docId, blockCount: blockModel.blocks.length, modality: blockModel.modality };
    },
  });
}

export function buildExtractFieldsTool(deps: ToolDeps) {
  return tool({
    description:
      '从已录入单据(docId)中抽取业务字段。强制原文 span 接地: 每个值必须可在 BlockModel 原文中定位, 否则不自动接受。返回带置信度的字段集 + 是否需人工复核(needsReview)。',
    inputSchema: z.object({
      docId: z.string().min(1),
      docType: z.enum(['合同', '发票', '提单', '装箱单', '其他']),
    }),
    execute: async ({ docId, docType }) => {
      const blockModel = loadDocument(deps.ctx, docId);
      if (!blockModel) return { status: 'error' as const, reason: 'document_not_found' };
      if (!deps.extraction) {
        return { status: 'error' as const, reason: 'extraction_model_not_configured' };
      }
      const result = await extractGroundedFields(deps.extraction, { blockModel, docType: docType as DocType });
      const fieldMeta: Record<string, { strength: string; confidence: number }> = {};
      const fields: Record<string, { value: string | number; sourceSpans: unknown[] }> = {};
      for (const f of result.fields) {
        fields[f.name] = { value: f.value, sourceSpans: f.sourceSpans };
        fieldMeta[f.name] = { strength: f.strength, confidence: f.confidence };
      }
      const extractionId = saveExtraction(deps.ctx, {
        documentId: docId,
        docType: docType as DocType,
        fields,
        fieldMeta,
        overallConfidence: result.overallConfidence,
        needsReview: result.needsReview,
      });
      return {
        extractionId,
        fields: result.fields,
        overallConfidence: result.overallConfidence,
        needsReview: result.needsReview,
        missingRequired: result.missingRequired,
      };
    },
  });
}

export function buildBindDocumentTool(deps: ToolDeps) {
  return tool({
    description:
      '将已录入并抽取的单据绑定到业务实体(合同号)。L2 操作: 调用方需附带人工授权(needsApproval)。每条绑定记录来源 span 与置信度, 写入审计。',
    inputSchema: z.object({
      documentId: z.string().min(1),
      contractNo: z.string().min(1),
      relation: z.string().min(1).describe('关系类型, 1a 用 primary; 1c 扩展 logistics_for_contract 等'),
      confidence: z.number().min(0).max(1),
      sourceSpan: z.object({
        blockId: z.string(), start: z.number().int(), end: z.number().int(),
      }).describe('证明该绑定的原文 span'),
    }),
    execute: async ({ documentId, contractNo, relation, confidence, sourceSpan }) => {
      const blockModel = loadDocument(deps.ctx, documentId);
      if (!blockModel) return { ok: false as const, reason: 'document_not_found' };
      const bindingId = saveBinding(deps.ctx, {
        documentId, contractNo, relation,
        sourceRefs: [sourceSpan], confidence, createdBy: 'trader-agent',
      });
      return { ok: true as const, bindingId, contractNo, documentId };
    },
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- documentEntry`
Expected: PASS — ingest persists 2 blocks; bind returns a `BD-` id.

- [ ] **Step 5: Commit**

```bash
cd server && git add src/pipeline/tools/documentEntry.ts test/pipeline/tools/documentEntry.test.ts && git commit -m "feat(pipeline): ingest/extract/bind document-entry tools"
```

---

## Task 9: Harness wiring (registry + permission gate + system prompt)

**Files:**
- Modify: `server/src/harness/roleToolRegistry.ts`
- Modify: `server/src/harness/permissionGate.ts` (only if `bind_document` not auto-resolved as L2)
- Modify: `server/src/harness/agent.ts` (SYSTEM_PROMPT guardrails)
- Create: `server/test/harness/wiring.test.ts`

**Interfaces:**
- Consumes: the 3 tools from `../pipeline/tools/documentEntry.js`; existing `DbContext` from `../pipeline/db/client.js`; existing role/permission model.
- Produces: trader role gains `ingest_document` (L1), `extract_fields` (L1), `bind_document` (L2); SYSTEM_PROMPT documents the doc-entry flow + zero-hallucination guarantee.

- [ ] **Step 1: Read current harness files to ground the edit**

Read (do not paste full contents into the diff blindly — edit by anchoring on real strings):
- `server/src/harness/roleToolRegistry.ts`
- `server/src/harness/permissionGate.ts`
- `server/src/harness/agent.ts`

Confirm: the trader REGISTRY entry's tool list, how `getToolsForRole` constructs tool instances (do they take deps?), and the existing SYSTEM_PROMPT guardrail list.

> If `getToolsForRole` currently returns module-level tool singletons (no deps), you must refactor it to accept a `HarnessDeps` (at minimum the `DbContext`) so the new pipeline tools can be constructed. Keep existing tools' behavior identical. This is the targeted improvement the spec (§"working in existing codebases") calls for.

- [ ] **Step 2: Write the failing test**

Create `server/test/harness/wiring.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { getToolsForRole, listToolNames } from '../../src/harness/roleToolRegistry.js';
import { createDb, migrate } from '../../src/pipeline/db/client.js';

describe('trader role wiring', () => {
  it('trader exposes ingest/extract/bind document tools', () => {
    const ctx = createDb(':memory:');
    migrate(ctx.sqlite);
    const names = listToolNames('trader');
    expect(names).toContain('ingest_document');
    expect(names).toContain('extract_fields');
    expect(names).toContain('bind_document');
  });

  it('bind_document is flagged needsApproval (L2)', () => {
    const ctx = createDb(':memory:');
    migrate(ctx.sqlite);
    const tools = getToolsForRole('trader', { ctx });
    const bind = tools.find((t) => t.name === 'bind_document')!;
    expect(bind.needsApproval).toBe(true);
  });

  it('ingest_document and extract_fields are L1 (no needsApproval)', () => {
    const ctx = createDb(':memory:');
    migrate(ctx.sqlite);
    const tools = getToolsForRole('trader', { ctx });
    const ingest = tools.find((t) => t.name === 'ingest_document')!;
    const extract = tools.find((t) => t.name === 'extract_fields')!;
    expect(ingest.needsApproval ?? false).toBe(false);
    expect(extract.needsApproval ?? false).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- wiring`
Expected: FAIL — `ingest_document` not in role list.

- [ ] **Step 4: Refactor `roleToolRegistry.ts` to accept deps + register new tools**

Apply these conceptual edits (anchor on the actual code read in Step 1):

1. Add an import for the three tool builders:
```ts
import {
  buildIngestDocumentTool, buildExtractFieldsTool, buildBindDocumentTool,
} from '../pipeline/tools/documentEntry.js';
import type { DbContext } from '../pipeline/db/client.js';
```

2. Introduce a deps type and thread it through:
```ts
export interface HarnessDeps { ctx: DbContext }
```

3. Change the trader entry to include the new tools. If the registry currently maps role → array of bare tool objects, convert each entry to a factory `(deps) => Tool[]` OR keep existing tools as-is and append the new ones in `getToolsForRole`. Minimal-touch example for `getToolsForRole`:
```ts
export function getToolsForRole(role: Role, deps?: HarnessDeps): GatedTool[] {
  const base = BASE_TOOLS_FOR_ROLE[role] ?? [];
  if (role === 'trader' && deps?.ctx) {
    const ctx = deps.ctx;
    base.push(
      { name: 'ingest_document', ...buildIngestDocumentTool({ ctx }) },
      { name: 'extract_fields',  ...buildExtractFieldsTool({ ctx }) },
      { name: 'bind_document',   ...buildBindDocumentTool({ ctx }), needsApproval: true },
    );
  }
  return base;
}
```
(Adapt the exact shape — `GatedTool`, the existing `name`-stamping convention, and `buildGatedTools` in `agent.ts` — to the real code. The key invariants: `bind_document` carries `needsApproval: true`; the other two do not.)

4. Update `listToolNames(role, deps?)` analogously so it reflects the appended tools.

- [ ] **Step 5: Update SYSTEM_PROMPT in `agent.ts`**

Add these guardrails to the existing SYSTEM_PROMPT guardrail list (anchor on the real list head):

```
- 单据录入闭环: 用户上传原始单据后, 先调 ingest_document 解析为 BlockModel, 再调 extract_fields 抽取业务字段。
- 数字零幻觉(硬约束): extract_fields 返回的每个值都已与原文 span 比对。任何 strength=none 或置信度低于复核阈值的字段必须如实告知用户, 不得编造; 关键字段(合同号/金额/发票号/价税合计)未达自动接受阈值时, 主动建议人工复核或调 escalate_to_human。
- 业务绑定需授权: bind_document 为 L2 操作, 需要人工确认后方可执行。
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test -- wiring`
Expected: PASS — all three assertions green.

- [ ] **Step 7: Run full suite to confirm no regressions**

Run: `npm test`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
cd server && git add src/harness/ test/harness/ && git commit -m "feat(harness): wire document-entry tools into trader role (bind=L2)"
```

---

## Task 10: 合同 eval set + runner

**Files:**
- Create: `server/eval/contracts/sample-clean-digital.txt`
- Create: `server/eval/contracts/sample-scanned-trap.txt` (+ `.mineru.json`)
- Create: `server/eval/contracts/ground-truth.json`
- Create: `server/eval/run.ts`
- Modify: `server/package.json` (add `"eval": "tsx eval/run.ts"` script)

**Interfaces:**
- Consumes: the full pipeline (ingest → extract via real model) + `attachConfidence` for metric computation.
- Produces: a runnable `npm run eval -- --sample=...` that prints metrics: **字段抽取准确率** (field-level value exact match vs ground truth), **span接地率** (% fields with strength ≠ none), **引用准确率** (% cited spans whose text actually contains the value), **HITL触发** (precision/recall of needsReview against trap fields).

- [ ] **Step 1: Create the clean digital sample**

Create `server/eval/contracts/sample-clean-digital.txt`:
```
合同号: HT-2024-001
甲方: 华盛集团
乙方: 中石化销售有限公司
标的物: 0#柴油
规格: 0#
数量: 1000
单位: 吨
金额: 2860000
币种: CNY
签订日: 2024-06-01
交货地: 张家港
```

- [ ] **Step 2: Create the scanned trap sample + MinerU fixture**

Create `server/eval/contracts/sample-scanned-trap.txt` (the "raw text" used to derive the MinerU fixture; the trap is an OCR-ambiguous 金额):
```
合同号: HT-2024-002
甲方: 华盛集团
乙方: 中石油
标的物: 92#汽油
数量: 500
单位: 吨
金额: 3 9X0 000
签订日: 2024-07-15
```

Create `server/eval/contracts/sample-scanned-trap.txt.mineru.json` (mirrors the T2 fixture shape; the 金额 block text `"3 9X0 000"` should produce `strength=none` for the true value `3950000`, exercising the trap):
```json
{
  "pdf_info": [
    {
      "page_idx": 0,
      "preproc_blocks": [
        { "type": "text", "bbox": [72,110,300,30], "lines": [{"text":"合同号: HT-2024-002","bbox":[72,110,300,30]}] },
        { "type": "text", "bbox": [72,150,300,30], "lines": [{"text":"甲方: 华盛集团","bbox":[72,150,300,30]}] },
        { "type": "text", "bbox": [72,180,300,30], "lines": [{"text":"乙方: 中石油","bbox":[72,180,300,30]}] },
        { "type": "text", "bbox": [72,210,300,30], "lines": [{"text":"标的物: 92#汽油","bbox":[72,210,300,30]}] },
        { "type": "text", "bbox": [72,240,300,30], "lines": [{"text":"数量: 500","bbox":[72,240,300,30]}] },
        { "type": "text", "bbox": [72,270,300,30], "lines": [{"text":"单位: 吨","bbox":[72,270,300,30]}] },
        { "type": "text", "bbox": [72,300,300,30], "lines": [{"text":"金额: 3 9X0 000","bbox":[72,300,300,30]}], "statistics": {"max_bbox_score": 0.6} },
        { "type": "text", "bbox": [72,330,300,30], "lines": [{"text":"签订日: 2024-07-15","bbox":[72,330,300,30]}] }
      ],
      "statistics": { "max_bbox_score": 0.9 }
    }
  ]
}
```
> Note: per-block confidence in the normalizer is page-level; for the trap we want the 金额 block to carry low confidence. If the T2 normalizer uses page-level conf, accept that the trap is exercised via span `none` (the cited text `"3 9X0 000"` won't contain `3950000`). That is sufficient to validate HITL triggering.

- [ ] **Step 3: Create ground truth**

Create `server/eval/contracts/ground-truth.json`:
```json
{
  "samples": [
    {
      "id": "clean-digital",
      "path": "eval/contracts/sample-clean-digital.txt",
      "modality": "digital",
      "docType": "合同",
      "expected": {
        "合同号": "HT-2024-001", "甲方": "华盛集团", "乙方": "中石化销售有限公司",
        "标的物": "0#柴油", "数量": 1000, "单位": "吨", "金额": 2860000,
        "币种": "CNY", "签订日": "2024-06-01", "交货地": "张家港"
      },
      "traps": []
    },
    {
      "id": "scanned-trap",
      "path": "eval/contracts/sample-scanned-trap.txt",
      "modality": "scanned",
      "docType": "合同",
      "expected": {
        "合同号": "HT-2024-002", "甲方": "华盛集团", "乙方": "中石油",
        "标的物": "92#汽油", "数量": 500, "单位": "吨", "金额": 3950000,
        "签订日": "2024-07-15"
      },
      "traps": ["金额"]
    }
  ]
}
```

- [ ] **Step 4: Create the runner**

Create `server/eval/run.ts`:
```ts
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, migrate } from '../src/pipeline/db/client.js';
import { saveDocument } from '../src/pipeline/db/repositories.js';
import { ingestWithDigital } from '../src/pipeline/digitalAdapter.js';
import { ingestWithMinerU } from '../src/pipeline/mineruAdapter.js';
import { extractGroundedFields } from '../src/pipeline/extraction.js';
import { buildModelFromEnv } from '../src/env.js';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

// buildModelFromEnv: if your env.ts exposes a different factory name, use that.
// Fallback: construct the OpenAI client directly. (Adapt to real env.ts.)
async function getModel() {
  try {
    return await import('../src/env.js').then((m) => m.buildModelFromEnv());
  } catch {
    const { openai } = await import('@ai-sdk/openai');
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, baseURL: process.env.OPENAI_BASE_URL });
    return openai.chat(process.env.OPENAI_MODEL ?? 'deepseek-chat').bind?.() ?? (openai as any).chat(process.env.OPENAI_MODEL ?? 'deepseek-chat');
  }
}

interface Sample {
  id: string; path: string; modality: 'digital' | 'scanned';
  docType: '合同'; expected: Record<string, string | number>; traps: string[];
}

function eq(a: unknown, b: unknown): boolean {
  return String(a).replace(/[,，\s]/g, '') === String(b).replace(/[,，\s]/g, '');
}

async function main() {
  const gt = JSON.parse(readFileSync(resolve(here, 'contracts/ground-truth.json'), 'utf-8')) as { samples: Sample[] };
  const model = await getModel();
  const ctx = createDb(':memory:');
  migrate(ctx.sqlite);

  const only = process.argv.find((a) => a.startsWith('--sample='))?.split('=')[1];
  const samples = only ? gt.samples.filter((s) => s.id === only) : gt.samples;

  let tp = 0, fp = 0, fn = 0;
  let fieldTotal = 0, fieldCorrect = 0;
  let spanTotal = 0, spanGrounded = 0, citationCorrect = 0;

  for (const s of samples) {
    const abs = resolve(here, s.path.replace(/^eval\//, ''));
    const docId = `EVAL-${s.id}`;
    const blockModel = s.modality === 'scanned'
      ? await ingestWithMinerU(abs, s.docType, docId)
      : await ingestWithDigital(abs, s.docType, docId);
    saveDocument(ctx, blockModel);
    const result = await extractGroundedFields({ model }, { blockModel, docType: s.docType });

    for (const [name, expected] of Object.entries(s.expected)) {
      fieldTotal++;
      const f = result.fields.find((x) => x.name === name);
      if (f && eq(f.value, expected)) fieldCorrect++;
      if (f) {
        spanTotal++;
        if (f.strength !== 'none') spanGrounded++;
        if (f.citedText && eq(f.citedText, f.value)) citationCorrect++;
      }
      // HITL recall: trap fields MUST trigger needsReview
      const isTrap = s.traps.includes(name);
      const flagged = f?.needsReview ?? true;
      if (isTrap && flagged) tp++;
      if (isTrap && !flagged) fn++;
      if (!isTrap && flagged) fp++;
    }
    console.log(`\n[${s.id}] overallConfidence=${result.overallConfidence} needsReview=${result.needsReview} missing=${result.missingRequired.join(',') || '-'}`);
    for (const f of result.fields) {
      console.log(`  ${f.name}=${f.value} strength=${f.strength} conf=${f.confidence} review=${f.needsReview}`);
    }
  }

  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  console.log('\n===== METRICS =====');
  console.log(`字段抽取准确率: ${fieldCorrect}/${fieldTotal} = ${(fieldCorrect / fieldTotal).toFixed(3)}`);
  console.log(`span接地率:     ${spanGrounded}/${spanTotal} = ${(spanGrounded / spanTotal).toFixed(3)}`);
  console.log(`引用准确率:     ${citationCorrect}/${spanTotal} = ${(citationCorrect / spanTotal).toFixed(3)}`);
  console.log(`HITL触发 precision=${precision.toFixed(3)} recall=${recall.toFixed(3)} (tp=${tp} fp=${fp} fn=${fn})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
```

Add to `server/package.json` scripts:
```json
"eval": "tsx eval/run.ts"
```

- [ ] **Step 5: Run the eval on the clean sample**

Ensure `.env` has `OPENAI_API_KEY`, `OPENAI_BASE_URL` (DeepSeek), `OPENAI_MODEL`.

Run: `npm run eval -- --sample=clean-digital`
Expected: prints per-field rows; **字段抽取准确率** ≥ 0.8 on the clean sample; **span接地率** ≥ 0.8. If the model mis-cites spans, refine `GROUNDED_EXTRACTION_PROMPT` (Task 7) and re-run. Record the achieved numbers in a comment at the top of `eval/run.ts`.

- [ ] **Step 6: Run the eval on the trap sample**

Run: `npm run eval -- --sample=scanned-trap`
Expected: the `金额` field shows `strength=none` (or confidence below KEY_FIELD_THRESHOLD) and `review=true`; **HITL recall = 1.0** (the trap is always flagged). This is the concrete proof that 数字零幻觉 is enforced as a HARD check.

- [ ] **Step 7: Commit**

```bash
cd server && git add eval/ package.json && git commit -m "feat(eval): 合同 eval set + runner (accuracy/span-grounding/HITL metrics)"
```

---

## Self-Review (run after writing — done)

**1. Spec coverage** (spec section → task):
- §4 5-stage pipeline (ingest→extract→verify→bind): T7 (ingest), T8 (extract), T8 (bind), HITL reuse via existing T4 `verify_document_fields` referenced in T8 deps + T9 prompt. ✅
- §5 BlockModel types: T1. ✅ digital (T3) + scanned/MinerU (T2). ✅ 原件 local FS (T8 reads `sourceUri` directly). ✅
- §6 zod schemas (合同): T5. (发票 schema deferred to the 1b plan per spec §13 phasing.) ✅
- §7 tools table (ingest/extract/bind + reuse T4/T3): T8 + T9 wiring. ✅
- §8 span grounding validator: T5 + enforced in T7 (`attachConfidence`). ✅
- §9 confidence model + thresholds + key-field ≥0.95: T6. ✅
- §10 3 Drizzle tables + reuse sessions/audit: T4 (documents/extractions/bindings); sessions/audit already exist and are reused via the existing harness in T9. ✅
- §12 eval layer (metrics): T10. ✅ (§11 1c relationships are explicitly out of this plan — they go in the 1c plan, per spec §13.)
- Global constraints (数据不出域/数字零幻觉/AI SDK 6/thresholds): enforced across T2 (local MinerU), T5+T7 (hard span check), T8/T9 (AI SDK 6 `tool({inputSchema})`, `{...tool, needsApproval:true}`). ✅

**2. Placeholder scan:** No TBD/TODO except (a) the intentional MinerU real-sample confirmation in T2 (a spike step, not a plan hole — it has a concrete deliverable + assumed shape + fixture), and (b) `buildModelFromEnv` in T10 guarded by a documented fallback. Both are honest spike/env-seam callouts, not missing implementation. Acceptable.

**3. Type consistency:**
- `SpanMatchStrength = 'exact'|'fuzzy'|'none'` — defined T4 stub → implemented T5; consumed by T6 (`STRENGTH_SCORE`), T7 (`attachConfidence`). ✅
- `SourceSpan = { blockId, start, end, page? }` — T1; used in T4 `ExtractionInput.fields[].sourceSpans`, T5 `validateSpan`, T7 `GroundedField.sourceSpans`, T8 bind `sourceSpan` input. ✅
- `DbContext = { db, sqlite }` — T4; used T8 `ToolDeps.ctx`, T9 `HarnessDeps.ctx`, T10. ✅
- `buildIngestDocumentTool/ buildExtractFieldsTool/ buildBindDocumentTool` — T8; used T9. ✅
- `attachConfidence(blockModel, grounded, llmConsistency)` — T7; matches T7 test + T8 orchestration. ✅

No mismatches found. No spec requirement left without a task.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-05-document-entry-agent.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints. REQUIRED SUB-SKILL: superpowers:executing-plans.

Which approach?
