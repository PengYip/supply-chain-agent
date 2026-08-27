# 选择性向量化入库 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 只有模板树上根为「合同」或「立项书」的单据类型才向量化入库；其余类型录入时跳过嵌入、五维卡纠错时回溯（补嵌入/清向量）。

**Architecture:** 新增纯函数策略模块 + 三处录入点内联门禁；纠错路由调用新的容错 reconcile 函数完成补嵌入或清向量；前端用响应中的 vectorization 回填五维卡。

**Tech Stack:** TypeScript / Hono / vitest / better-sqlite3(+vec0) / pgvector / React 19。

## Global Constraints

- 无 emoji（仓库约定）；无多余注释。
- 分类先于向量化的现有顺序不可打破；chunk 落库、FTS5、Lane B 标签、自动抽取均不受门禁影响。
- reconcile 永不抛出；与图同步同款 warn-only。
- 验证顺序 build → lint → test。命令均为 root 执行：`npm run build`、`npm run lint`、`npm test --workspace apps/server -- <file>`。
- Postgres 分支实现但集成测试按既有 skip 规则跳过。

---

### Task 1: 策略模块 vectorPolicy.ts

**Files:**
- Create: `apps/server/src/pipeline/vectorPolicy.ts`
- Test: `apps/server/test/pipeline/vectorPolicy.test.ts`

**Interfaces:**
- Produces: `VECTORIZE_ROOT_TYPES: readonly ['合同','立项书']`; `SKIP_REASON_NOT_VECTORIZABLE: string`; `isVectorizableDocType(docType: string, types: TemplateTypeRow[]): boolean`

- [x] **Step 1: 失败测试**

```ts
// apps/server/test/pipeline/vectorPolicy.test.ts
import { describe, it, expect } from 'vitest';
import { isVectorizableDocType } from '../../src/pipeline/vectorPolicy.js';
import type { TemplateTypeRow } from '../../src/pipeline/db/repositories.js';

function row(name: string, parentId: string | null): TemplateTypeRow {
  return {
    id: `dt-${name}`, kind: 'doc_type', name, parentId,
    props: {}, isActive: true,
  };
}

const TREE = [
  row('合同', null),
  row('补充合同', 'dt-合同'),
  row('立项书', null),
  row('项目申请书', 'dt-立项书'),
  row('履约凭证', null),
  row('运输凭证', 'dt-履约凭证'),
];

describe('isVectorizableDocType', () => {
  it('根粗类直接判定', () => {
    expect(isVectorizableDocType('合同', TREE)).toBe(true);
    expect(isVectorizableDocType('立项书', TREE)).toBe(true);
    expect(isVectorizableDocType('履约凭证', TREE)).toBe(false);
    expect(isVectorizableDocType('其他', TREE)).toBe(false);
  });
  it('细类沿 parent 链上溯到粗类', () => {
    expect(isVectorizableDocType('补充合同', TREE)).toBe(true);
    expect(isVectorizableDocType('项目申请书', TREE)).toBe(true);
    expect(isVectorizableDocType('运输凭证', TREE)).toBe(false);
  });
  it('类型不在树中回退字面匹配', () => {
    expect(isVectorizableDocType('合同', [])).toBe(true);
    expect(isVectorizableDocType('立项书', [])).toBe(true);
    expect(isVectorizableDocType('运输凭证', [])).toBe(false);
  });
});
```

- [x] **Step 2: 运行确认失败** — `npm test --workspace apps/server -- test/pipeline/vectorPolicy.test.ts` → FAIL (模块不存在)

- [x] **Step 3: 最小实现**

```ts
// apps/server/src/pipeline/vectorPolicy.ts
// 选择性向量化策略(spec docs/superpowers/specs/2026-08-27-selective-vectorization-design.md):
// 只有模板树顶层为「合同」/「立项书」的类型进入向量库, 其余类型 FTS5 关键词召回兜底。
import type { TemplateTypeRow } from './db/repositories.js';

export const VECTORIZE_ROOT_TYPES = ['合同', '立项书'] as const;

export const SKIP_REASON_NOT_VECTORIZABLE = '仅合同/立项书类型向量化入库';

export function isVectorizableDocType(docType: string, types: TemplateTypeRow[]): boolean {
  const byName = new Map(types.filter((t) => t.kind === 'doc_type').map((t) => [t.name, t]));
  let cur = docType;
  let resolved = false;
  for (let guard = 0; guard < 16 && !resolved; guard++) {
    if (byName.has(cur)) {
      resolved = true;
      break;
    }
    break; // first iteration only decides membership; loop below walks parents
  }
  if (!byName.has(docType)) {
    return (VECTORIZE_ROOT_TYPES as readonly string[]).includes(docType);
  }
  let node = byName.get(docType)!;
  for (let guard = 0; guard < 16 && node.parentId; guard++) {
    const parent = types.find((t) => t.id === node.parentId);
    if (!parent) break;
    node = parent;
  }
  return (VECTORIZE_ROOT_TYPES as readonly string[]).includes(node.name);
}
```

(执行时简化第一个无用循环——保留向上走链 + 字面回退即可。)

- [x] **Step 4: 测试通过** — 同 Step 2 命令 → PASS

- [x] **Step 5: Commit** `feat: vectorPolicy 类型向量化策略谓词`

### Task 2: 录入三处门禁 + 空块过滤

**Files:**
- Modify: `apps/server/src/pipeline/tools/documentEntry.ts`（三处嵌入块）
- Test: `apps/server/test/pipeline/ingest-vectorization.test.ts`（追加）

**Interfaces:**
- Consumes: Task 1 的 `isVectorizableDocType` / `SKIP_REASON_NOT_VECTORIZABLE`
- Produces: 行为契约——不可向量化类型 `{status:'skipped', mode:embedder?.kind??'none', chunkCount:n, reason:SKIP_REASON}` 且不调 embedder

- [x] **Step 1: 失败测试（追加到 ingest-vectorization.test.ts）**

```ts
it('非向量化类型(hint 其他)不触发嵌入, status=skipped + 约定 reason', async () => {
  enableVec(ctx.sqlite);
  const calls: string[][] = [];
  const spy: Embedder = { dim: 1024, kind: 'spy', embed: async (t) => { calls.push(t); return []; } };
  const ingest = buildIngestDocumentTool({ ctx, embedder: spy });
  const res = await ingest.execute({ sourceUri: fixture('送货单 送货数量 100'), docType: '其他', modality: 'digital' }, execOpts);
  expect(res.vectorization.status).toBe('skipped');
  expect(res.vectorization.reason).toContain('仅合同');
  expect(calls.length).toBe(0);
});
```

- [x] **Step 2: 运行确认失败**；**Step 3: 实现**——documentEntry.ts：
  - 导入 `isVectorizableDocType, SKIP_REASON_NOT_VECTORIZABLE`；
  - 三处 `if (embedder)` 改为 `if (embedder && isVectorizableDocType(blockModel.docType, await listTemplateTypes(ctx)))`（voucher 路径 docType 取局部 `docType`；processDocument 用 `opts.` 前缀与 ctx 参数名适配）。else-if 分支落 `{status:'skipped', mode:embedder.kind, chunkCount, reason:SKIP_REASON}`；
  - 空块过滤：将 `chunks.map(c=>c.text)` 改为先构造 `const embeddable = chunkRowIds.map((id,i)=>({chunkRowId:id!, text:chunks[i]!.text})).filter(x=>x.text.trim())`，空则 `{status:'skipped', mode:embedder.kind, chunkCount, reason:'无有效文本块'}`，否则 `embed(embeddable.map(x=>x.text))` 并按 embeddable 配对 `saveChunkVectors`。

- [x] **Step 4: PASS；Step 5: Commit** `feat: 录入路径按单据类型门禁向量化`

### Task 3: DB 助手 listChunksByDocument / clearChunkVectorsForDocument

**Files:**
- Modify: `apps/server/src/pipeline/db/repositories.ts`(+postgres-repositories.ts)、`apps/server/src/pipeline/db/vecStore.ts`
- Test: `apps/server/test/pipeline/vectorReconcile.test.ts`（Task 4 一并覆盖）

- [x] **Step 1: 实现**：
```ts
// repositories.ts (sqlite 分支; pg 同构 $1/rows)
export interface ChunkRowLite { id: number; text: string }
export async function listChunksByDocument(ctx: DbContext, documentId: string): Promise<ChunkRowLite[]> {
  if (ctx.backend === 'postgres') return listChunksByDocumentPg(ctx, documentId);
  return ctx.sqlite.prepare(
    'SELECT id, chunk_text FROM doc_chunk WHERE document_id = ? ORDER BY chunk_index',
  ).all(documentId).map((r: any) => ({ id: Number(r.id), text: String(r.chunk_text) }));
}

// vecStore.ts 分发器
export async function clearChunkVectorsForDocument(ctx: DbContext, documentId: string): Promise<void> {
  if (ctx.backend === 'postgres') {
    await ctx.pool.query('UPDATE doc_chunk SET embedding = NULL WHERE document_id = $1', [documentId]);
    return;
  }
  ctx.sqlite.prepare(
    'DELETE FROM doc_chunk_vec WHERE id IN (SELECT id FROM doc_chunk WHERE document_id = ?)',
  ).run(documentId);
}
```
- [x] **Step 2: build 通过（tsc 类型闭环）；Commit** `feat: 向量回溯所需 DB 助手`

### Task 4: vectorReconcile + PATCH /type 接线

**Files:**
- Create: `apps/server/src/pipeline/vectorReconcile.ts`
- Modify: `apps/server/src/routes/review.ts`
- Test: `apps/server/test/pipeline/vectorReconcile.test.ts` + `test/routes/reviewType.test.ts` 追加

**Interfaces:**
- Consumes: Task 1/3 全部导出、`saveChunkVectors`/`isVecReady`(vecStore)、`setDocumentVectorization`/`listChunksByDocument`(repositories)、`defaultEmbedder()`(ingestModel)
- Produces: `reconcileVectorizationAfterDocTypeChange(ctx, docId, newDocType, embedder|undefined, userId?) -> Promise<DocumentVectorization>`；PATCH 200 响应新增 `vectorization` 字段

- [x] **Step 1: 失败测试 vectorReconcile.test.ts**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate, type SqliteDbContext } from '../../src/pipeline/db/client.js';
import { enableVec, saveChunkVectors, clearChunkVectorsForDocument } from '../../src/pipeline/db/vecStore.js';
import { saveChunks } from '../../src/pipeline/db/repositories.js';
import { reconcileVectorizationAfterDocTypeChange } from '../../src/pipeline/vectorReconcile.js';
import { DeterministicEmbedder } from '../../src/pipeline/embedder.js';

let ctx: SqliteDbContext;
beforeEach(() => { ctx = createDb(':memory:'); migrate(ctx.sqlite); });

async function seededDoc() {
  // documents 行需存在(FK): 用 updateDocumentMeta 不行(要求已存), 直接 INSERT 最小行
  ctx.sqlite.prepare("INSERT INTO documents (id, doc_type, modality, source_uri, block_model) VALUES (?, '运输凭证', 'digital', '', '{}')").run('doc-r1');
  const ids = await saveChunks(ctx, 'doc-r1', [{ text: '运单号 YD001', index: 0 }]);
  return ids[0]!;
}

describe('reconcileVectorizationAfterDocTypeChange', () => {
  it('纠正为可向量化类型: 补嵌入 + meta ok', async () => {
    const cap = enableVec(ctx.sqlite);
    await seededDoc();
    const meta = await reconcileVectorizationAfterDocTypeChange(ctx, 'doc-r1', '合同', new DeterministicEmbedder());
    expect(meta.status).toBe(cap.ok ? 'ok' : 'skipped');
  });
  it('纠正为不可向量化类型: 清空向量 + meta skipped(约定 reason)', async () => {
    const cap = enableVec(ctx.sqlite);
    const chunkId = await seededDoc();
    if (cap.ok) await saveChunkVectors(ctx, [{ chunkRowId: chunkId, vec: new Array(1024).fill(0.1) }]);
    const meta = await reconcileVectorizationAfterDocTypeChange(ctx, 'doc-r1', '运输凭证', new DeterministicEmbedder());
    expect(meta.status).toBe('skipped');
    expect(meta.reason).toContain('仅合同');
  });
});
```

documents 表最小列以实际 DDL 为准（NOT NULL 列有 doc_type/modality/block_model/source_uri/id；如缺 created_at 有默认）。执行时按 client.ts 实际 DDL 校准。

- [x] **Step 2: FAIL；Step 3: 实现 vectorReconcile.ts**

```ts
import type { Embedder } from './embedder.js';
import type { DbContext } from './db/client.js';
import type { DocumentVectorization } from './db/repositories.js';
import { listChunksByDocument, listTemplateTypes, setDocumentVectorization } from './db/repositories.js';
import { isVecReady, saveChunkVectors, clearChunkVectorsForDocument } from './db/vecStore.js';
import { isVectorizableDocType, SKIP_REASON_NOT_VECTORIZABLE } from './vectorPolicy.js';

export async function reconcileVectorizationAfterDocTypeChange(
  ctx: DbContext, docId: string, newDocType: string,
  embedder: Embedder | undefined, userId?: string,
): Promise<DocumentVectorization> {
  try {
    const types = await listTemplateTypes(ctx);
    const chunks = await listChunksByDocument(ctx, docId);
    const baseMode = embedder?.kind ?? 'none';
    if (!isVectorizableDocType(newDocType, types)) {
      await clearChunkVectorsForDocument(ctx, docId);
      const meta: DocumentVectorization = { status: 'skipped', mode: baseMode, chunkCount: chunks.length, reason: SKIP_REASON_NOT_VECTORIZABLE };
      await setDocumentVectorization(ctx, docId, meta, userId);
      return meta;
    }
    if (!embedder || !(await isVecReady(ctx))) {
      const meta: DocumentVectorization = { status: 'skipped', mode: baseMode, chunkCount: chunks.length, reason: 'vec_store_not_ready' };
      await setDocumentVectorization(ctx, docId, meta, userId);
      return meta;
    }
    const embeddable = chunks.filter((c) => c.text.trim().length > 0);
    if (embeddable.length === 0) {
      const meta: DocumentVectorization = { status: 'skipped', mode: baseMode, chunkCount: 0, reason: '无有效文本块' };
      await setDocumentVectorization(ctx, docId, meta, userId);
      return meta;
    }
    const vecs = await embedder.embed(embeddable.map((c) => c.text));
    await saveChunkVectors(ctx, embeddable.map((c, i) => ({ chunkRowId: c.id, vec: vecs[i] ?? [] })));
    const meta: DocumentVectorization = { status: 'ok', mode: embedder.kind, chunkCount: embeddable.length };
    await setDocumentVectorization(ctx, docId, meta, userId);
    return meta;
  } catch (e) {
    console.warn('[vectorReconcile] 回溯失败:', e instanceof Error ? e.message : String(e));
    return { status: 'failed', mode: embedder?.kind ?? 'none', chunkCount: 0, reason: e instanceof Error ? e.message : String(e) };
  }
}
```

- [x] **Step 4: 路由接线** review.ts PATCH '/:docId/type'：flows refresh 之后插入（warn-only 包裹）：

```ts
import { defaultEmbedder } from '../pipeline/ingestModel.js';          // 合并进既有 buildIngestDeps import 行所在语句
import { reconcileVectorizationAfterDocTypeChange } from '../pipeline/vectorReconcile.js';
...
let vectorization;
try {
  vectorization = await reconcileVectorizationAfterDocTypeChange(ctx(), docId, docType, defaultEmbedder(), user.id);
} catch (e) {
  console.warn('[review] 向量回溯失败:', e instanceof Error ? e.message : String(e));
}
return c.json({ ok: true, docType, refreshedFlows: materialized, skipped, vectorization });
```

JSDoc 更新 Response 一行为 `200 { ok, docType, refreshedFlows, skipped?, vectorization }`。

- [x] **Step 5: PASS + Commit** `feat: 纠错类型后向量回溯 reconcile + 路由接线`

### Task 5: 前端状态回填

**Files:**
- Modify: `apps/web/src/api/review.ts`（updateDocumentType 返回类型加 `vectorization?`）
- Modify: `apps/web/src/components/DocumentReviewCard.tsx`（纠错成功回调回填第 5 维）

- [x] **Step 1**: api 返回类型加 `vectorization?: { status: 'ok'|'skipped'|'failed'|'unknown'; mode: string; chunkCount: number; reason?: string }`。
- [x] **Step 2**: 纠错提交成功分支里若 `data.vectorization` 存在则 setState 合并入 card payload 的 vectorization 字段（具体变量名以现场代码为准）。
- [x] **Step 3**: `npm run build` 通过；**Commit** `feat: 五维卡纠错后回填向量化状态`

### Task 6: 全量验证

- [x] `npm run build`（root，web+server 全绿）
- [x] `npm run lint`
- [x] `npm test --workspace apps/server`（全量）
- [x] 最终 commit + push origin PengYip/业务逻辑优化

## Self-Review 记录
- Spec 覆盖：门禁(Task2)/策略(Task1)/回溯(Task4)/前端(Task5)/空块过滤(Task2、Task4 内含) ✓
- 类型一致性：DocumentVectorization 与 VectorizationStatus 形状相同(status/mode/chunkCount/reason) ✓
- 已知风险：documents 最小 INSERT 列以 DDL 为准；router JSDoc 同步更新 ✓
