# 业务图谱模板 Phase 2 后端（v2 类型激活 + 抽取路由 + 工具 + 终审遗留）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 Phase 2 后端：分类器层级化（两阶段先粗后细 + 候选词表模板生成）、v2 类型激活（方向编码类型上岗、提单/装箱单并入货转单、amends L2 工具、立项书 binds→Project）、抽取路由 props 驱动、template_overview L1 工具、graphCommit 守卫评估、终审遗留三项。前端双下拉是**后续独立计划**（消费 P1 T7 的 context API），不在本计划内。

**Architecture:** 模板层（关系库 SSOT）继续作为唯一权威；本计划把"类型即数据"从登记推进到**上岗**：分类器从模板表动态取候选词表（去硬编码）、v2 类型规则激活（种子 ensure* upsert）、抽取提示词由 template_types.props 组装、Agent 工具（template_overview L1 / link_amends L2）注册进 roleToolRegistry。行为变化是 P2 预期（v2 激活），但每个行为变化任务必须带存量数据兼容/迁移策略（幂等）。

**Tech Stack:** TypeScript (strict ESM, `.js` import 后缀)、better-sqlite3 + drizzle（SQLite 路径）、node-postgres（PG 路径）、Hono 路由、vitest、AI SDK 6（generateObject / tool）。

**Spec:** `docs/superpowers/specs/2026-08-26-graph-template-design.md`
**代码锚点:** `.superpowers/sdd/p2-anchors.md`（18 节，file:line 以此为准）

## Global Constraints

- P1 全部约束延续：完成顺序强制 build → lint → test（`npm run build` / `npm run lint` / `npm test`，仓库根）；代码禁 emoji；SQLite raw idempotent DDL + PG drizzle 双落点；仓储层双后端分派（`repositories.ts` 分派 + `postgres-repositories.ts` Pg 版）；图写入永不阻塞业务主流程；模板三表无 user_id（全局本体）。
- **classifier 改造必须保留失败 fallback 路径**：两阶段复用同一 generateObject 基础设施；细类失败回退粗类、粗类失败回退 hint（现 fallback 'hint' 语义不变）。
- **迁移必须幂等可重入**：存量数据迁移（提单/装箱单→货转单）用 UPDATE 幂等语句，重复执行无副作用；不回溯已写边（铁律一致）。
- **模板规则激活走种子 ensure\* upsert**：不写手工 SQL UPDATE；`ensureEdgeRule` 的 `ON CONFLICT(id) DO UPDATE SET is_active = excluded.is_active` 会自动把 active:false→true 的种子行更新为激活态。
- 行为变化是 P2 预期，但每个行为变化任务必须带测试证明：新类型上岗后旧 8 类行为不变（回归门禁）。
- 测试样板：`test/pipeline/classifier.test.ts` 的 stubModel 模式（§18）——`fakeLanguageModel` 只有 doStream，generateObject 测试用 stubModel（doGenerate 返回 JSON）。

---

### Task 1: classifier 层级化（两阶段先粗后细 + 候选词表模板生成 + z.enum 动态校验）

**Files:**
- Modify: `apps/server/src/pipeline/types.ts`（DocType 联合扩展至 v2 种子集）
- Modify: `apps/server/src/pipeline/classifier.ts`（两阶段 + buildClassifierVocab + 动态 schema + 去 CLASSIFIER_PROMPT 硬编码）
- Modify: `apps/server/src/pipeline/tools/documentEntry.ts`（两处 classifyDocument 调用传 vocab）
- Modify: `apps/server/src/routes/bindings.ts:66`（docTypes 改模板派生）
- Modify: `apps/server/src/routes/review.ts:254`（PATCH /type 校验改模板派生）
- Test: `apps/server/test/pipeline/classifierHierarchy.test.ts`

**Interfaces:**
- Consumes: `listTemplateTypes(ctx)`（P1 T2）、`TemplateTypeRow`。
- Produces:
  - `export interface ClassifierVocab { coarse: string[]; fineByCoarse: Record<string, string[]> }`
  - `export function buildClassifierVocab(types: TemplateTypeRow[]): ClassifierVocab` — 粗类 = 顶层四类（合同/立项书/履约凭证/其他）；细类 = 各粗类的全部后代（含中间层与叶子，从 template_types 动态取）
  - `classifyDocument(deps, input)` — input 加 `vocab?: ClassifierVocab`；两阶段 generateObject；细类失败回退粗类、粗类失败回退 hint
  - `DocType` 联合扩展至 v2 种子集（24 类）

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/test/pipeline/classifierHierarchy.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate } from '../../src/pipeline/db/client.js';
import { ensureTemplateSeed } from '../../src/pipeline/templateSeed.js';
import { listTemplateTypes } from '../../src/pipeline/db/repositories.js';
import { buildClassifierVocab, classifyDocument } from '../../src/pipeline/classifier.js';
import type { Block, DocType } from '../../src/pipeline/types.js';

// stubModel 序列版(§18 模式扩展): 每次 doGenerate 依次返回 returnObjects 中的对象;
// 元素为 Error 时该次调用抛出(模拟细类/粗类失败)。
function stubModelSequence(returnObjects: Array<unknown | Error>) {
  let i = 0;
  return {
    specificationVersion: 'v2' as const,
    provider: 'fake', modelId: 'fake-model', supportedUrls: {} as Record<string, RegExp[]>,
    async doGenerate() {
      const obj = returnObjects[Math.min(i, returnObjects.length - 1)];
      i++;
      if (obj instanceof Error) throw obj;
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(obj) }],
        finishReason: 'stop' as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [] as unknown[],
      };
    },
    async doStream() { throw new Error('doStream not used by classifyDocument'); },
  } as any;
}

const blocks = (text: string): Block[] => [
  { id: 'b0', type: 'text', text, page: 1, bbox: null, ocrConfidence: 1 },
];

const ctx = createDb();
beforeEach(async () => { migrate(ctx.sqlite); await ensureTemplateSeed(ctx); });

describe('buildClassifierVocab', () => {
  it('粗类=顶层四类, 细类=履约凭证全部后代', async () => {
    const types = await listTemplateTypes(ctx);
    const vocab = buildClassifierVocab(types);
    expect(vocab.coarse).toEqual(expect.arrayContaining(['合同', '立项书', '履约凭证', '其他']));
    expect(vocab.fineByCoarse['履约凭证']).toContain('收货单');
    expect(vocab.fineByCoarse['履约凭证']).toContain('发票');
    expect(vocab.fineByCoarse['合同']).toContain('补充合同');
  });
});

describe('classifyDocument 两阶段', () => {
  it('粗类命中后细类精化', async () => {
    const model = stubModelSequence([{ docType: '履约凭证', confidence: 0.9 }, { docType: '收货单', confidence: 0.85 }]);
    const res = await classifyDocument({ model }, { blocks: blocks('收货单...'), hint: '其他' });
    expect(res.docType).toBe('收货单');
    expect(res.source).toBe('classified');
  });
  it('细类失败回退粗类', async () => {
    const model = stubModelSequence([{ docType: '履约凭证', confidence: 0.9 }, new Error('boom')]);
    const res = await classifyDocument({ model }, { blocks: blocks('...'), hint: '其他' });
    expect(res.docType).toBe('履约凭证');
    expect(res.source).toBe('classified');
  });
  it('粗类失败回退 hint', async () => {
    const model = stubModelSequence([new Error('boom')]);
    const res = await classifyDocument({ model }, { blocks: blocks('...'), hint: '发票' });
    expect(res.docType).toBe('发票');
    expect(res.source).toBe('fallback');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/pipeline/classifierHierarchy.test.ts`
Expected: FAIL（buildClassifierVocab 未导出 / classifyDocument 无 vocab 参数）

- [ ] **Step 3: types.ts 扩展 DocType 联合至 v2 种子集**

```ts
// apps/server/src/pipeline/types.ts:4 替换
export type DocType =
  | '合同' | '补充合同' | '立项书' | '履约凭证'
  | '结算单' | '质检报告' | '化验报告' | '货转单' | '提单' | '装箱单'
  | '运输凭证' | '收货单' | '发货单' | '汽运磅单' | '火运大票' | '派船通知单'
  | '资金凭证' | '付款单' | '付款凭证'
  | '发票凭证' | '发票' | '进项票' | '销项票'
  | '其他';
```

（`DOC_TYPES` 旧 8 类仍 `satisfies readonly DocType[]`，向后兼容。）

- [ ] **Step 4: classifier.ts 实现两阶段 + buildClassifierVocab**

```ts
// apps/server/src/pipeline/classifier.ts — 替换 DOC_TYPES 之后到 classifyDocument 的段落
import { generateObject, type LanguageModel } from 'ai';
import { z } from 'zod';
import type { Block, DocType } from './types.js';
import type { TemplateTypeRow } from './db/repositories.js';

/** Injected small-model handle (same seam as ExtractionDeps). */
export interface ClassifierDeps {
  model: LanguageModel;
}

/** 两阶段候选词表: 粗类(顶层四类) + 各粗类的细类候选(模板表动态派生)。 */
export interface ClassifierVocab {
  coarse: string[];
  fineByCoarse: Record<string, string[]>;
}

export interface ClassifierInput {
  blocks: Block[];
  /** Caller-supplied best guess; used verbatim when no model is wired or the
   *  LLM call fails. Defaults to '其他' when undefined. */
  hint?: DocType;
  /** 模板派生词表(缺省用内置粗类 + 空细类, 保持单阶段兼容)。 */
  vocab?: ClassifierVocab;
}

export interface ClassifierResult {
  docType: DocType;
  confidence: number;
  /** 'classified' = LLM decided; 'hint' = no model, used the hint; 'fallback' =
   *  LLM errored / unparseable, fell back to the hint at confidence 0. */
  source: 'classified' | 'hint' | 'fallback';
}

/** 八类单据词汇表(legacy SSOT, 向后兼容; P2 起分类器候选词表由模板表生成)。 */
export const DOC_TYPES = ['合同', '发票', '提单', '装箱单', '货转单', '化验报告', '付款凭证', '其他'] as const satisfies readonly DocType[];

/** 粗类 = 顶层四类(spec §3.1 v2 树顶层)。 */
const DEFAULT_COARSE = ['合同', '立项书', '履约凭证', '其他'];

/** 从模板类型树派生两阶段词表: 粗类固定四类, 细类 = 各粗类的全部后代(含中间层)。 */
export function buildClassifierVocab(types: TemplateTypeRow[]): ClassifierVocab {
  const byId = new Map(types.map((t) => [t.id, t]));
  const docTypes = types.filter((t) => t.kind === 'doc_type');
  const childrenOf = (id: string | null) => docTypes.filter((t) => t.parentId === id).map((t) => t.name);
  const descendants = (name: string): string[] => {
    const out: string[] = [];
    const stack = [...childrenOf(byId.get(`dt-${name}`)?.id ?? null)];
    while (stack.length) {
      const n = stack.pop()!;
      out.push(n);
      stack.push(...childrenOf(byId.get(`dt-${n}`)?.id ?? null));
    }
    return out;
  };
  const fineByCoarse: Record<string, string[]> = {};
  for (const c of DEFAULT_COARSE) {
    const fine = descendants(c);
    if (fine.length) fineByCoarse[c] = fine;
  }
  return { coarse: DEFAULT_COARSE, fineByCoarse };
}

function buildCoarsePrompt(coarse: string[]): string {
  return [
    '你是供应链单据分类器。只依据给定原文判断这份单据属于哪个粗类。',
    `粗类取值: ${coarse.join(' / ')}。`,
    'confidence 是自评置信度 (0..1); 不确定就给较低值。',
    '严禁凭空臆造原文中不存在的单据类型信号。',
    '严格以 JSON 格式输出, 不要包含任何注释或解释文字。',
    '输出结构: {"docType": "履约凭证", "confidence": 0.9}',
  ].join('\n');
}

function buildFinePrompt(coarse: string, fine: string[]): string {
  return [
    `这份单据已判定为「${coarse}」。请进一步判定其细类。`,
    `细类取值: ${fine.join(' / ')}。`,
    'confidence 是自评置信度 (0..1); 不确定就给较低值。',
    '严禁凭空臆造原文中不存在的单据类型信号。',
    '严格以 JSON 格式输出, 不要包含任何注释或解释文字。',
    '输出结构: {"docType": "收货单", "confidence": 0.85}',
  ].join('\n');
}

const MAX_CLASSIFY_CHARS = 2000;

/** Bounded blocks->prompt: join block texts, cap at MAX_CLASSIFY_CHARS. */
function blocksToPrompt(blocks: Block[]): string {
  const text = blocks.map((b) => b.text).join('\n').slice(0, MAX_CLASSIFY_CHARS);
  return `原文片段:\n${text}`;
}

/**
 * 两阶段分类: 粗类(合同/立项书/履约凭证/其他) -> 细类(模板表动态候选)。
 * 细类失败回退粗类; 粗类失败回退 hint(现 fallback 语义不变)。
 */
export async function classifyDocument(
  deps: ClassifierDeps,
  input: ClassifierInput,
): Promise<ClassifierResult> {
  const hint: DocType = input.hint ?? '其他';
  const vocab = input.vocab ?? { coarse: DEFAULT_COARSE, fineByCoarse: {} };
  try {
    const coarseSchema = z.object({
      docType: z.enum(vocab.coarse as [string, ...string[]]),
      confidence: z.number().min(0).max(1),
    });
    const coarse = await generateObject({
      model: deps.model,
      schema: coarseSchema,
      system: buildCoarsePrompt(vocab.coarse),
      prompt: blocksToPrompt(input.blocks),
      providerOptions: { openai: { structuredOutputs: false } },
    });
    const fineCandidates = vocab.fineByCoarse[coarse.object.docType] ?? [];
    if (fineCandidates.length === 0) {
      return { docType: coarse.object.docType as DocType, confidence: coarse.object.confidence, source: 'classified' };
    }
    try {
      const fineSchema = z.object({
        docType: z.enum(fineCandidates as [string, ...string[]]),
        confidence: z.number().min(0).max(1),
      });
      const fine = await generateObject({
        model: deps.model,
        schema: fineSchema,
        system: buildFinePrompt(coarse.object.docType, fineCandidates),
        prompt: blocksToPrompt(input.blocks),
        providerOptions: { openai: { structuredOutputs: false } },
      });
      return { docType: fine.object.docType as DocType, confidence: fine.object.confidence, source: 'classified' };
    } catch {
      // 细类失败 -> 回退粗类(仍是 LLM 判定, source 保持 'classified')。
      return { docType: coarse.object.docType as DocType, confidence: coarse.object.confidence, source: 'classified' };
    }
  } catch {
    return { docType: hint, confidence: 0, source: 'fallback' };
  }
}

/** Offline degrade path (unchanged): hint verbatim at confidence 0, source 'hint'. */
export function classifyDocumentWithoutModel(input: ClassifierInput): ClassifierResult {
  return { docType: input.hint ?? '其他', confidence: 0, source: 'hint' };
}
```

- [ ] **Step 5: documentEntry.ts 两处调用传 vocab**

`documentEntry.ts:574` 与 `:846` 的 classifyDocument 调用前加载模板词表：

```ts
// documentEntry.ts:571-575 替换(两处同款)
  const types = await listTemplateTypes(ctx);
  const vocab = buildClassifierVocab(types);
  const cls = classifier
    ? await classifyDocument(classifier, { blocks: blockModel.blocks, hint: docType, vocab })
    : classifyDocumentWithoutModel({ blocks: blockModel.blocks, hint: docType });
```

（import 增加 `listTemplateTypes` from `../db/repositories.js`、`buildClassifierVocab` from `../classifier.js`。）

- [ ] **Step 6: bindings.ts:66 与 review.ts:254 消费方改模板派生**

`bindings.ts:66` `docTypes: [...DOC_TYPES]` 替换为模板派生（docType 列表 = 激活的 doc_type 类型名）：

```ts
// bindings.ts GET /overview 内(已有 ctx() 与 listTemplateTypes 可 import)
  const templateTypes = await listTemplateTypes(ctx());
  const docTypes = templateTypes.filter((t) => t.kind === 'doc_type' && t.isActive).map((t) => t.name);
  return c.json({ documents, docTypes });
```

`review.ts:254` PATCH /type 校验替换为模板派生（以 review.ts 既有 ctx 获取方式为准）：

```ts
  const templateTypes = await listTemplateTypes(db);
  const valid = templateTypes.some((t) => t.kind === 'doc_type' && t.isActive && t.name === docType);
  if (!valid) return c.json({ error: `未知单据类型: ${docType}` }, 400);
```

（`DOC_TYPES` import 若不再使用则删除；`listTemplateTypes` 从 `../pipeline/db/repositories.js` import。）

- [ ] **Step 7: 跑新测试 + 全量回归**

Run: `npm test --workspace apps/server -- test/pipeline/classifierHierarchy.test.ts && npm run build && npm test`
Expected: 全 PASS（旧 classifier.test.ts 单阶段用例仍绿 = 兼容验证点）

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/pipeline/types.ts apps/server/src/pipeline/classifier.ts apps/server/src/pipeline/tools/documentEntry.ts apps/server/src/routes/bindings.ts apps/server/src/routes/review.ts apps/server/test/pipeline/classifierHierarchy.test.ts
git commit -m "feat(template): classifier两阶段层级化+候选词表模板生成"
```

---

### Task 2: 提单/装箱单并入货转单（别名迁移）

**Files:**
- Modify: `apps/server/src/pipeline/db/repositories.ts`（ensureTemplateType 加 props 支持）
- Modify: `apps/server/src/pipeline/db/postgres-repositories.ts`（ensureTemplateTypePg 同款）
- Modify: `apps/server/src/pipeline/templateSeed.ts`（提单/装箱单加 props.aliasOf；新增幂等迁移函数）
- Modify: `apps/server/src/index.ts`（启动接线迁移）
- Modify: `apps/server/src/pipeline/classifier.ts`（buildClassifierVocab 排除 alias 类型）
- Test: `apps/server/test/pipeline/docTypeAliasMigration.test.ts`

**Interfaces:**
- Consumes: `ensureTemplateType`（P1 T2）、`buildClassifierVocab`（Task 1）。
- Produces:
  - `ensureTemplateType(ctx, input)` — input 加 `props?: Record<string, unknown>`，upsert 时更新 props
  - `migrateDocTypeAliases(ctx: DbContext): Promise<number>` — 幂等迁移 documents/extractions/classifications 的 提单/装箱单 → 货转单，返回迁移行数
  - `buildClassifierVocab` — 排除 `props.aliasOf` 标记的类型（提单/装箱单不进细类候选）

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/test/pipeline/docTypeAliasMigration.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate } from '../../src/pipeline/db/client.js';
import { ensureTemplateSeed, migrateDocTypeAliases } from '../../src/pipeline/templateSeed.js';
import { ensureTemplateType, listTemplateTypes } from '../../src/pipeline/db/repositories.js';
import { createDocumentStub } from '../../src/pipeline/db/repositories.js';
import { buildClassifierVocab } from '../../src/pipeline/classifier.js';

const ctx = createDb();
beforeEach(async () => { migrate(ctx.sqlite); await ensureTemplateSeed(ctx); });

describe('docType alias migration', () => {
  it('ensureTemplateType 支持 props upsert', async () => {
    await ensureTemplateType(ctx, { id: 'dt-提单', kind: 'doc_type', name: '提单', parentId: 'dt-货转单', props: { aliasOf: '货转单' } });
    const types = await listTemplateTypes(ctx);
    const tidan = types.find((t) => t.name === '提单')!;
    expect(tidan.props.aliasOf).toBe('货转单');
  });

  it('buildClassifierVocab 排除 alias 类型(提单/装箱单不进细类)', async () => {
    await ensureTemplateType(ctx, { id: 'dt-提单', kind: 'doc_type', name: '提单', parentId: 'dt-货转单', props: { aliasOf: '货转单' } });
    await ensureTemplateType(ctx, { id: 'dt-装箱单', kind: 'doc_type', name: '装箱单', parentId: 'dt-货转单', props: { aliasOf: '货转单' } });
    const types = await listTemplateTypes(ctx);
    const vocab = buildClassifierVocab(types);
    expect(vocab.fineByCoarse['履约凭证']).not.toContain('提单');
    expect(vocab.fineByCoarse['履约凭证']).not.toContain('装箱单');
    expect(vocab.fineByCoarse['履约凭证']).toContain('货转单');
  });

  it('存量 documents 幂等迁移 提单/装箱单 -> 货转单', async () => {
    await createDocumentStub(ctx, { sourceUri: 'file:///t.pdf', docType: '提单' });
    await createDocumentStub(ctx, { sourceUri: 'file:///z.pdf', docType: '装箱单' });
    const n1 = await migrateDocTypeAliases(ctx);
    expect(n1).toBeGreaterThanOrEqual(2);
    const n2 = await migrateDocTypeAliases(ctx); // 幂等: 二次执行 0 行
    expect(n2).toBe(0);
    const rows = ctx.sqlite.prepare("SELECT doc_type FROM documents WHERE doc_type IN ('提单','装箱单')").all();
    expect(rows).toHaveLength(0);
    const huozhuan = ctx.sqlite.prepare("SELECT COUNT(*) AS c FROM documents WHERE doc_type = '货转单'").get() as { c: number };
    expect(huozhuan.c).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/pipeline/docTypeAliasMigration.test.ts`
Expected: FAIL（ensureTemplateType 无 props 参数 / migrateDocTypeAliases 未导出）

- [ ] **Step 3: ensureTemplateType 加 props 支持（双后端）**

`repositories.ts`（P1 T2 的 ensureTemplateType 替换）：

```ts
export async function ensureTemplateType(
  ctx: DbContext, input: { id: string; kind: string; name: string; parentId?: string | null; props?: Record<string, unknown> },
): Promise<void> {
  if (ctx.backend === 'postgres') return ensureTemplateTypePg(ctx, input);
  ctx.sqlite.prepare(
    `INSERT INTO template_types (id, kind, name, parent_id, props) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET parent_id = excluded.parent_id, props = excluded.props`,
  ).run(input.id, input.kind, input.name, input.parentId ?? null, JSON.stringify(input.props ?? {}));
}
```

`postgres-repositories.ts` 同款（`ensureTemplateTypePg`，`$5` 为 props JSON 串）。

- [ ] **Step 4: templateSeed.ts 加 alias props + 幂等迁移函数**

`DOC_TYPE_SEED` 中提单/装箱单条目加 props（其余不动）：

```ts
  { name: '提单', parent: '货转单', props: { aliasOf: '货转单' } },
  { name: '装箱单', parent: '货转单', props: { aliasOf: '货转单' } },
```

`DOC_TYPE_SEED` 类型扩展为 `Array<{ name: string; parent?: string; props?: Record<string, unknown> }>`，`ensureTemplateSeed` 的 ensureTemplateType 调用透传 `props: t.props`。

文件末尾追加迁移函数：

```ts
/** 存量数据幂等迁移(spec §3.1): 提单/装箱单并入货转单(别名)。重复执行无副作用。 */
export async function migrateDocTypeAliases(ctx: DbContext): Promise<number> {
  const aliasMap: Array<[string, string]> = [['提单', '货转单'], ['装箱单', '货转单']];
  let total = 0;
  for (const [from, to] of aliasMap) {
    for (const tbl of ['documents', 'extractions', 'classifications']) {
      const res = ctx.sqlite.prepare(`UPDATE ${tbl} SET doc_type = ? WHERE doc_type = ?`).run(to, from);
      total += res.changes;
    }
  }
  return total;
}
```

（PG 版：`migrateDocTypeAliasesPg` 用参数化 UPDATE，`repositories.ts` 分派 `if (ctx.backend === 'postgres') return migrateDocTypeAliasesPg(ctx);`。）

- [ ] **Step 5: buildClassifierVocab 排除 alias 类型**

`classifier.ts` 的 `buildClassifierVocab` 中 `descendants` 收集时过滤 `props.aliasOf` 标记的类型：

```ts
  const docTypes = types.filter((t) => t.kind === 'doc_type' && !t.props.aliasOf);
```

（`TemplateTypeRow.props` 为 `Record<string, unknown>`，`t.props.aliasOf` 存在即视为别名。）

- [ ] **Step 6: index.ts 启动接线（ensureTemplateSeed 之后）**

```ts
  // 存量 docType 别名迁移(幂等): 提单/装箱单 -> 货转单。失败仅告警不阻塞启动。
  try {
    await migrateDocTypeAliases(getDbContext());
  } catch (e) {
    console.warn('[templateSeed] docType 别名迁移失败(不阻塞启动):', (e as Error).message);
  }
```

- [ ] **Step 7: 跑新测试 + 全量回归**

Run: `npm test --workspace apps/server -- test/pipeline/docTypeAliasMigration.test.ts && npm run build && npm test`
Expected: 全 PASS

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/pipeline/db/repositories.ts apps/server/src/pipeline/db/postgres-repositories.ts apps/server/src/pipeline/templateSeed.ts apps/server/src/pipeline/classifier.ts apps/server/src/index.ts apps/server/test/pipeline/docTypeAliasMigration.test.ts
git commit -m "feat(template): 提单/装箱单并入货转单(别名迁移)"
```

---

### Task 3: 方向编码类型激活（settles 交叉验证）

**Files:**
- Modify: `apps/server/src/pipeline/templateSeed.ts`（激活 er-settle-shouhuo/fahuodan/jinxiang/xiaoxiang）
- Modify: `apps/server/src/routes/bindings.ts`（syncSettlesAfterFlow 交叉验证 + 方向编码类型 settles 边落库）
- Test: `apps/server/test/pipeline/directionTypes.test.ts`

**Interfaces:**
- Consumes: `matchEdgeRule`/`ancestorChain`（P1 T4）、`listTemplateTypes`/`listActiveEdgeRules`、`syncSettlesEdgeWithMeta`（bindings.ts 内部）、`settlesRelationFor`。
- Produces:
  - 种子 er-settle-shouhuo/fahuodan/jinxiang/xiaoxiang 激活（active:true）
  - `syncSettlesAfterFlow` 内交叉验证：派生 relation 不在该 docType 激活 settles 词表 → warn + 跳过
  - 方向编码类型（单方向 settles 规则）确认/创建绑定后直接落 settles 边（类型方向路径）

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/test/pipeline/directionTypes.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate } from '../../src/pipeline/db/client.js';
import { ensureTemplateSeed } from '../../src/pipeline/templateSeed.js';
import { listActiveEdgeRules } from '../../src/pipeline/db/repositories.js';

const ctx = createDb();
beforeEach(async () => { migrate(ctx.sqlite); await ensureTemplateSeed(ctx); });

describe('direction-encoded types', () => {
  it('种子激活后 收货单/发货单/进项票/销项票 settles 规则生效', async () => {
    const rules = await listActiveEdgeRules(ctx);
    const byId = new Map((await import('../../src/pipeline/db/repositories.js')).then((m) => m.listTemplateTypes(ctx)).then((ts) => ts.map((t) => [t.id, t.name])));
    const active = rules.filter((r) => r.edgeType === 'settles' && r.isActive);
    const srcNames = active.map((r) => byId.get(r.sourceTypeId));
    expect(srcNames).toContain('收货单');
    expect(srcNames).toContain('发货单');
    expect(srcNames).toContain('进项票');
    expect(srcNames).toContain('销项票');
    const shouhuo = active.find((r) => byId.get(r.sourceTypeId) === '收货单');
    expect(shouhuo?.allowedVocab).toEqual(['收货']);
  });
});
```

（路由层交叉验证与类型方向 settles 落库的测试：以 `test/routes/bindingsGuard.test.ts` 脚手架为模板，新增用例——收货单文档确认绑定后 settles 边带 relation='收货'；付款凭证派生 relation 与词表一致照常同步。断言目标：方向编码类型落 settles 边 / 交叉验证不阻断合法组合。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/pipeline/directionTypes.test.ts`
Expected: FAIL（er-settle-* 仍 active:false）

- [ ] **Step 3: templateSeed.ts 激活四条方向编码 settles 规则**

`EDGE_RULE_SEED` 中四条规则去掉 `active: false`（ensureEdgeRule upsert 自动更新为激活）：

```ts
  { id: 'er-settle-shouhuo', src: '收货单', edge: 'settles', vocab: ['收货'] },
  { id: 'er-settle-fahuodan', src: '发货单', edge: 'settles', vocab: ['发货'] },
  { id: 'er-settle-jinxiang', src: '进项票', edge: 'settles', vocab: ['收票'] },
  { id: 'er-settle-xiaoxiang', src: '销项票', edge: 'settles', vocab: ['开票'] },
```

- [ ] **Step 4: syncSettlesAfterFlow 交叉验证 + 方向编码类型 settles 落库**

`bindings.ts` 的 `syncSettlesAfterFlow`（p2-anchors §9 :595-611）替换为：

```ts
/** 方向编码类型: 类型自带 settles 方向(单方向词表), 确认后直接落 settles 边。 */
async function syncSettlesByType(
  db: DbContext, userId: string,
  input: { documentId: string; contractNo: string; confidence: number },
): Promise<void> {
  let meta: Awaited<ReturnType<typeof getDocumentMeta>> = null;
  try { meta = await getDocumentMeta(db, input.documentId, userId); } catch { return; }
  if (!meta?.docType) return;
  const [types, rules] = await Promise.all([listTemplateTypes(db), listActiveEdgeRules(db)]);
  const byId = new Map(types.map((t) => [t.id, t]));
  const chain = ancestorChain(byId.get(`dt-${meta.docType}`)?.id ?? null, byId);
  const rule = matchEdgeRule({ rules, sourceChain: chain, targetChain: [''], edgeType: 'settles' });
  if (!rule || rule.allowedVocab.length !== 1) return; // 仅单方向类型走此路径
  const relation = rule.allowedVocab[0];
  const direction = (relation === '收款' || relation === '收货' || relation === '收票') ? 'in' : 'out';
  const sync = await syncSettlesEdgeWithMeta(db, userId, {
    docId: input.documentId, contractNo: input.contractNo, relation,
    direction: direction as 'in' | 'out', confidence: input.confidence,
  });
  if (sync.outcome === 'failed') {
    console.warn('[settlesGraphSync] settles 边同步失败:', sync.reason);
  }
}

async function syncSettlesAfterFlow(
  db: DbContext,
  userId: string,
  input: { documentId: string; contractNo: string; confidence: number },
  settled: NonNullable<Awaited<ReturnType<typeof materializeExecutionFlow>>>,
) {
  const relation = settlesRelationFor(settled.flowType, settled.direction);
  if (!relation) return;
  // 交叉验证(spec v2): 类型自带 settles 方向 × flowType×direction 派生。
  // 派生 relation 不在该 docType 激活 settles 词表内 -> 类型方向与派生矛盾, 跳过。
  let meta: Awaited<ReturnType<typeof getDocumentMeta>> = null;
  try { meta = await getDocumentMeta(db, input.documentId, userId); } catch { /* 缺 meta 放行 */ }
  if (meta?.docType) {
    const [types, rules] = await Promise.all([listTemplateTypes(db), listActiveEdgeRules(db)]);
    const byId = new Map(types.map((t) => [t.id, t]));
    const chain = ancestorChain(byId.get(`dt-${meta.docType}`)?.id ?? null, byId);
    const rule = matchEdgeRule({ rules, sourceChain: chain, targetChain: [''], edgeType: 'settles' });
    if (rule && rule.allowedVocab.length > 0 && !rule.allowedVocab.includes(relation)) {
      console.warn(`[templateGuard] settles 交叉验证不通过(跳过): doc=${input.documentId} relation=${relation} 不在 ${meta.docType} 词表 ${rule.allowedVocab.join('/')}`);
      return;
    }
  }
  const sync = await syncSettlesEdgeWithMeta(db, userId, {
    docId: input.documentId, contractNo: input.contractNo, relation,
    direction: settled.direction as 'in' | 'out', amount: settled.amount,
    confidence: input.confidence,
  });
  if (sync.outcome === 'failed') {
    console.warn('[settlesGraphSync] settles 边同步失败:', sync.reason);
  }
}
```

`confirmOne` 与 `POST /` 的确认/创建成功路径（materializeExecutionFlow 之后）追加 `await syncSettlesByType(db, userId, { documentId, contractNo, confidence });`（与 syncSettlesAfterFlow 并列，方向编码类型走此路径）。

（import 增加 `listTemplateTypes`/`listActiveEdgeRules` from `../pipeline/db/repositories.js`、`ancestorChain`/`matchEdgeRule` from `../pipeline/templateGuard.js`。）

- [ ] **Step 5: 跑新测试 + 全量回归**

Run: `npm test --workspace apps/server -- test/pipeline/directionTypes.test.ts && npm run build && npm test`
Expected: 全 PASS（旧 8 类 settles 词表含双向, 交叉验证不阻断 = 行为零变化验证点）

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/pipeline/templateSeed.ts apps/server/src/routes/bindings.ts apps/server/test/pipeline/directionTypes.test.ts
git commit -m "feat(template): 方向编码类型激活+settles交叉验证"
```

---

### Task 4: amends 边激活（L2 工具 + 注册）

**Files:**
- Modify: `apps/server/src/pipeline/graphLinkSync.ts`（GraphLinkKind += 'amends'；normalizeKey；srcKind += 'Document'）
- Modify: `apps/server/src/pipeline/tools/graphLinkTools.ts`（buildLinkAmendsTool）
- Modify: `apps/server/src/routes/graph.ts`（LINK_KINDS += amends；linkCreateSchema kind enum）
- Modify: `apps/server/src/harness/roleToolRegistry.ts`（注册 link_amends + TRADER_CTX_TOOL_NAMES）
- Modify: `apps/server/src/harness/permissionGate.ts`（registerPermission('link_amends', 'L2')）
- Modify: `apps/server/src/harness/contextContract.ts`（link_amends 契约条目）
- Modify: `apps/server/src/pipeline/templateSeed.ts`（激活 er-amend-buchong）
- Test: `apps/server/test/pipeline/graphLinkAmends.test.ts`

**Interfaces:**
- Consumes: `upsertLinkAndSync`（graphLinkTools.ts:25）、`syncGraphLinkEdge`（graphLinkSync.ts:65）、`GRAPH_TRADE_EDGES`。
- Produces:
  - `GraphLinkKind = 'correlates' | 'relates' | 'amends'`
  - `buildLinkAmendsTool(deps: GraphLinkToolDeps)` — L2 needsApproval；input `{ docId, baseContractNo, note? }`；落 graph_links kind='amends' srcKind='Document' dstKind='Contract'
  - 种子 er-amend-buchong 激活

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/test/pipeline/graphLinkAmends.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { syncGraphLinkEdge, type GraphLinkSyncIo } from '../../src/pipeline/graphLinkSync.js';
import { buildLinkAmendsTool } from '../../src/pipeline/tools/graphLinkTools.js';
import { createDb, migrate } from '../../src/pipeline/db/client.js';
import { ensureTemplateSeed } from '../../src/pipeline/templateSeed.js';
import { listActiveEdgeRules } from '../../src/pipeline/db/repositories.js';

function makeIo() {
  const nodes = new Map<string, string>();
  const edges = new Set<string>();
  let seq = 0;
  const id = (kind: string, name: string) => {
    const key = `${kind}:${name}`;
    if (!nodes.has(key)) nodes.set(key, `e${seq++}`);
    return { elementId: nodes.get(key)! };
  };
  const io: GraphLinkSyncIo = {
    createEntity: async (i) => id(i.kind, i.name),
    mergeEdge: async (i) => { edges.add(`${i.srcId}|${i.kind}|${i.dstId}`); return {}; },
    removeEdge: async (i) => { const k = `${i.srcId}|${i.kind}|${i.dstId}`; if (!edges.has(k)) return 0; edges.delete(k); return 1; },
    findEntityByName: async (kind, name) => nodes.get(`${kind}:${name}`) ? { elementId: nodes.get(`${kind}:${name}`)! } : null,
  };
  return { io, nodes, edges };
}

const prevPwd = process.env.NEO4J_PASSWORD;
beforeEach(() => { process.env.NEO4J_PASSWORD = 'test'; });
afterEach(() => {
  if (prevPwd === undefined) delete process.env.NEO4J_PASSWORD;
  else process.env.NEO4J_PASSWORD = prevPwd;
});

describe('amends edge', () => {
  it('syncGraphLinkEdge amends: Document(补充合同) -> Contract(基础合同)', async () => {
    const { io, edges } = makeIo();
    const r = await syncGraphLinkEdge({
      kind: 'amends', srcKind: 'Document', srcKey: 'DOC-1',
      dstKind: 'Contract', dstKey: 'HT-2024-001',
      props: {}, confirmationSource: 'agent', confidence: 0.8,
    }, io);
    expect(r.outcome).toBe('ok');
    expect([...edges][0]).toContain('amends');
  });

  it('buildLinkAmendsTool 落 graph_links + 图同步', async () => {
    const ctx = createDb();
    migrate(ctx.sqlite);
    await ensureTemplateSeed(ctx);
    const tool = buildLinkAmendsTool({ ctx, userId: 'u1' });
    const res = await tool.execute({ docId: 'DOC-1', baseContractNo: 'HT-2024-001' });
    expect(res.status).toBe('ok');
    expect(res.graphSync).toBe('skipped'); // 无真实 Neo4j
  });

  it('种子 er-amend-buchong 已激活', async () => {
    const ctx = createDb();
    migrate(ctx.sqlite);
    await ensureTemplateSeed(ctx);
    const rules = await listActiveEdgeRules(ctx);
    expect(rules.some((r) => r.id === 'er-amend-buchong' && r.isActive)).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/pipeline/graphLinkAmends.test.ts`
Expected: FAIL（GraphLinkKind 无 amends / buildLinkAmendsTool 未导出 / 种子未激活）

- [ ] **Step 3: graphLinkSync.ts 扩展 amends**

```ts
// :18 替换
export type GraphLinkKind = 'correlates' | 'relates' | 'amends';

// :46-48 normalizeKey 替换(amends 与 correlates 同款: 合同号双归一; src 为 docId 原样)
function normalizeKey(kind: GraphLinkKind, key: string): string {
  if (kind === 'relates') return normalizeProjectCode(key);
  return normalizeName(normalizeContractNo(key));
}

// :50-59 SyncGraphLinkEdgeInput 的 srcKind/dstKind 联合扩展
  srcKind: 'Contract' | 'Project' | 'Document';
  dstKind: 'Contract' | 'Project' | 'Document';

// :79 边类型映射替换
      kind: input.kind === 'correlates' ? CORRELATES_EDGE : input.kind === 'relates' ? RELATES_EDGE : 'amends',
```

（`GRAPH_TRADE_EDGES` 加 `amends: 'amends'` 常量，tradeSemantics.ts:161-167。）

- [ ] **Step 4: graphLinkTools.ts 加 buildLinkAmendsTool**

```ts
/** link_amends — L2 工具: 补充合同文档 -> 基础合同 amends 边(修订关系)。 */
export function buildLinkAmendsTool(deps: GraphLinkToolDeps) {
  return tool({
    description:
      '登记补充合同对基础合同的修订关系(amends)。什么时候用: 用户说"这份补充合同是对合同X的补充修订"时调用。' +
      'L2 操作: 调用需附带人工授权(needsApproval)。幂等: 同一对(补充合同文档, 基础合同)重复提交只更新属性。',
    inputSchema: z.object({
      docId: z.string().min(1).describe('补充合同文档 id(已入库的补充合同文件)'),
      baseContractNo: z.string().min(1).describe('被修订的基础合同号(台账规范化形式)'),
      note: z.string().max(500).optional().describe('修订说明'),
    }),
    execute: async ({ docId, baseContractNo, note }) => {
      const props: Record<string, unknown> = {};
      if (note !== undefined) props.note = note;
      const { linkId, graphSync } = await upsertLinkAndSync(deps, {
        kind: 'amends',
        srcKind: 'Document', srcKey: docId,
        dstKind: 'Contract', dstKey: baseContractNo,
        props,
      });
      return { status: 'ok' as const, linkId, graphSync };
    },
  });
}
```

（`upsertLinkAndSync` 的 srcKind/dstKind 类型同步扩展为 `'Contract' | 'Project' | 'Document'`。）

- [ ] **Step 5: routes/graph.ts LINK_KINDS + linkCreateSchema**

```ts
// :299-302 LINK_KINDS 追加
  amends: { srcKind: 'Document', dstKind: 'Contract' },

// :314 linkCreateSchema kind enum 追加
  kind: z.enum(['correlates', 'relates', 'amends']),
```

（`GraphLinkKind` 类型随之扩展；`srcKind`/`dstKind` 校验若存在则同步扩展。）

- [ ] **Step 6: 注册（roleToolRegistry + permissionGate + contextContract + TRADER_CTX_TOOL_NAMES）**

`roleToolRegistry.ts`：
- `TRADER_CTX_TOOL_NAMES`（:407）追加 `'link_amends'`
- `getToolsForRole` 的 trader ctx 块（:450 附近）追加：

```ts
        { ...buildLinkAmendsTool({ ctx, userId }), name: 'link_amends', needsApproval: true },
```

`permissionGate.ts`（:1415 附近）追加：

```ts
registerPermission('link_amends', 'L2'); // 2026-08-26 模板: 补充合同修订关系(amends)
```

`contextContract.ts`（:140 附近）追加：

```ts
  link_amends: {
    output: 'raw', budget: 'full', signal: 'env',
    persist: 'business', risk: { level: 'L2', injection: 'safe' },
  },
```

- [ ] **Step 7: templateSeed.ts 激活 er-amend-buchong**

`EDGE_RULE_SEED` 中 `{ id: 'er-amend-buchong', src: '补充合同', edge: 'amends', vocab: [], active: false }` 去掉 `active: false`。

- [ ] **Step 8: 跑新测试 + 全量回归**

Run: `npm test --workspace apps/server -- test/pipeline/graphLinkAmends.test.ts && npm run build && npm test`
Expected: 全 PASS

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/pipeline/graphLinkSync.ts apps/server/src/pipeline/tools/graphLinkTools.ts apps/server/src/routes/graph.ts apps/server/src/harness/roleToolRegistry.ts apps/server/src/harness/permissionGate.ts apps/server/src/harness/contextContract.ts apps/server/src/pipeline/templateSeed.ts apps/server/src/domain/tradeSemantics.ts apps/server/test/pipeline/graphLinkAmends.test.ts
git commit -m "feat(template): amends边激活(L2工具+注册)"
```

---

### Task 5: 立项书 binds→Project（target kind 泛化）

**Files:**
- Modify: `apps/server/src/pipeline/db/client.ts`（bindings 表加 target_kind 列，SQLite DDL + PG 段）
- Modify: `apps/server/src/pipeline/db/schema.ts` + `postgres-schema.ts`（bindings 表 targetKind 列）
- Modify: `apps/server/src/pipeline/db/repositories.ts` + `postgres-repositories.ts`（saveBinding/findBindingById 等 targetKind 透传）
- Modify: `apps/server/src/pipeline/bindingGraphSync.ts`（syncBindingEdge dstKind 泛化）
- Modify: `apps/server/src/routes/bindings.ts`（createSchema 扩展 + 门禁 targetKind 判定 + sync 传 dstKind）
- Modify: `apps/server/src/pipeline/templateSeed.ts`（立项书 props.bindsTargetKind + 激活 er-bind-lixiang）
- Test: `apps/server/test/pipeline/projectBinding.test.ts`

**Interfaces:**
- Consumes: `saveBinding`/`findBindingById`（P1）、`syncBindingEdge`（P1）、`getDocumentMeta`。
- Produces:
  - bindings 表 `target_kind TEXT NOT NULL DEFAULT 'Contract'`（'Contract' | 'Project'）
  - `syncBindingEdge` input 加 `dstKind?: 'Contract' | 'Project'`（缺省 'Contract'）；Project 时 dst 节点 = Project(name=normalizeProjectCode(contractNo))
  - 种子 er-bind-lixiang 激活 + 立项书 props.bindsTargetKind='Project'

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/test/pipeline/projectBinding.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDb, migrate } from '../../src/pipeline/db/client.js';
import { ensureTemplateSeed } from '../../src/pipeline/templateSeed.js';
import { saveBinding, findBindingById, listTemplateTypes } from '../../src/pipeline/db/repositories.js';
import { syncBindingEdge, type BindingGraphSyncIo } from '../../src/pipeline/bindingGraphSync.js';

function makeIo() {
  const nodes = new Map<string, string>();
  const edges = new Set<string>();
  let seq = 0;
  const id = (kind: string, name: string) => {
    const key = `${kind}:${name}`;
    if (!nodes.has(key)) nodes.set(key, `e${seq++}`);
    return { elementId: nodes.get(key)! };
  };
  const io: BindingGraphSyncIo = {
    createEntity: async (i) => id(i.kind, i.name),
    mergeEdge: async (i) => { edges.add(`${i.srcId}|${i.kind}|${i.dstId}`); return {}; },
    removeEdge: async (i) => { const k = `${i.srcId}|${i.kind}|${i.dstId}`; if (!edges.has(k)) return 0; edges.delete(k); return 1; },
    findEntityByName: async (kind, name) => nodes.get(`${kind}:${name}`) ? { elementId: nodes.get(`${kind}:${name}`)! } : null,
  };
  return { io, nodes, edges };
}

const prevPwd = process.env.NEO4J_PASSWORD;
beforeEach(() => { process.env.NEO4J_PASSWORD = 'test'; });
afterEach(() => {
  if (prevPwd === undefined) delete process.env.NEO4J_PASSWORD;
  else process.env.NEO4J_PASSWORD = prevPwd;
});

describe('project binding (立项书 binds->Project)', () => {
  it('saveBinding 落 target_kind=Project 且读回', async () => {
    const ctx = createDb();
    migrate(ctx.sqlite);
    await ensureTemplateSeed(ctx);
    const id = await saveBinding(ctx, {
      documentId: 'DOC-1', contractNo: 'PRJ-1', relation: '立项',
      sourceRefs: [], confidence: 1, createdBy: 'agent',
      status: 'confirmed', confirmationSource: 'human', targetKind: 'Project',
    }, 'u1');
    const row = await findBindingById(ctx, id, 'u1');
    expect(row?.targetKind).toBe('Project');
  });

  it('syncBindingEdge dstKind=Project 落 Project 节点', async () => {
    const { io, nodes, edges } = makeIo();
    const r = await syncBindingEdge({
      docId: 'DOC-1', docType: '立项书', contractNo: 'PRJ-1',
      relation: '立项', bindingId: 'B1', confidence: 1, dstKind: 'Project',
    }, io);
    expect(r.outcome).toBe('ok');
    expect(nodes.has('Project:PRJ-1')).toBe(true);
    expect([...edges][0]).toContain('binds');
  });

  it('种子 er-bind-lixiang 已激活 + 立项书 props.bindsTargetKind=Project', async () => {
    const ctx = createDb();
    migrate(ctx.sqlite);
    await ensureTemplateSeed(ctx);
    const types = await listTemplateTypes(ctx);
    const lixiang = types.find((t) => t.name === '立项书')!;
    expect(lixiang.props.bindsTargetKind).toBe('Project');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/pipeline/projectBinding.test.ts`
Expected: FAIL（target_kind 列不存在 / syncBindingEdge 无 dstKind / 种子未激活）

- [ ] **Step 3: bindings 表加 target_kind 列（SQLite DDL + PG 段 + drizzle 双 schema）**

`client.ts` migrate() 的 bindings CREATE 加列 + 存量库 guarded ALTER：

```sql
      target_kind TEXT NOT NULL DEFAULT 'Contract',
```

```ts
  // 立项书 binds->Project(spec 2026-08-26 §3.1): 存量 dev 库补列, 同 guarded ALTER 模式。
  {
    const cols = sqlite.prepare('PRAGMA table_info(bindings)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'target_kind')) {
      try { sqlite.exec("ALTER TABLE bindings ADD COLUMN target_kind TEXT NOT NULL DEFAULT 'Contract'"); } catch { /* concurrent */ }
    }
  }
```

`migratePostgres` statements 追加 `ALTER TABLE bindings ADD COLUMN IF NOT EXISTS target_kind TEXT NOT NULL DEFAULT 'Contract'`。`schema.ts`/`postgres-schema.ts` 的 bindings 表加 `targetKind: text('target_kind').notNull().default('Contract')`。

- [ ] **Step 4: repositories 双后端 targetKind 透传**

`saveBinding` input 加 `targetKind?: 'Contract' | 'Project'`（缺省 'Contract'），INSERT 列加 target_kind；`findBindingById`/`listBindingsForUser` 等 SELECT 加 target_kind 并映射 `targetKind`。`postgres-repositories.ts` 同款。`BindingRow` 接口加 `targetKind: 'Contract' | 'Project'`。

- [ ] **Step 5: bindingGraphSync.ts dstKind 泛化**

```ts
// syncBindingEdge input 加 dstKind
  input: { docId: string; docType?: string; sourceUri?: string | null; contractNo: string; relation: string; bindingId: string; confidence: number; templateVersion?: number; dstKind?: 'Contract' | 'Project' },

// :747-748 ensureNode 泛化
    const dstKind = input.dstKind ?? 'Contract';
    const dstName = dstKind === 'Project'
      ? normalizeProjectCode(input.contractNo)
      : normalizeName(input.contractNo);
    if (!dstName) return { outcome: 'failed', reason: 'dst key normalized to empty' };
    const dstNode = await ensureNode(io, dstKind, dstName,
      () => io.createEntity({ kind: dstKind, name: dstName, props: { rawName: input.contractNo } }));
```

（import `normalizeProjectCode` from `./db/repositories.js`。）

- [ ] **Step 6: bindings.ts createSchema + 门禁 targetKind 判定 + sync 传 dstKind**

```ts
// createSchema 扩展
const createSchema = z.object({
  documentId: z.string().min(1),
  contractNo: z.string().min(1),
  relation: z.string().min(1),
  note: z.string().optional(),
  targetKind: z.enum(['Contract', 'Project']).optional(),
});

// POST / 内: 目标类型判定(模板 props 驱动, 缺省 Contract)
  const srcMeta = await getDocumentMeta(db, documentId, user.id);
  const targetKind = (srcMeta?.docType === '立项书') ? 'Project' : (parsed.data.targetKind ?? 'Contract');

// saveBinding 调用传 targetKind; syncBindingEdgeWithMeta 调用传 dstKind: targetKind
```

`syncBindingEdgeWithMeta` input 加 `dstKind?: 'Contract' | 'Project'` 并透传 `syncBindingEdge`。

- [ ] **Step 7: templateSeed.ts 立项书 props + 激活 er-bind-lixiang**

```ts
  { name: '立项书', props: { bindsTargetKind: 'Project' } },
```

`EDGE_RULE_SEED` 中 `{ id: 'er-bind-lixiang', src: '立项书', edge: 'binds', vocab: ['立项'], active: false }` 去掉 `active: false`。

- [ ] **Step 8: 跑新测试 + 全量回归**

Run: `npm test --workspace apps/server -- test/pipeline/projectBinding.test.ts && npm run build && npm test`
Expected: 全 PASS（旧 Contract 绑定行为不变 = 回归验证点）

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/pipeline/db/client.ts apps/server/src/pipeline/db/schema.ts apps/server/src/pipeline/db/postgres-schema.ts apps/server/src/pipeline/db/repositories.ts apps/server/src/pipeline/db/postgres-repositories.ts apps/server/src/pipeline/bindingGraphSync.ts apps/server/src/routes/bindings.ts apps/server/src/pipeline/templateSeed.ts apps/server/test/pipeline/projectBinding.test.ts
git commit -m "feat(template): 立项书binds→Project目标泛化"
```

---

### Task 6: 抽取路由 props 驱动

**Files:**
- Modify: `apps/server/src/pipeline/extraction.ts`（ExtractionInput 加 requiredFields/fieldHints；提示词动态组装）
- Modify: `apps/server/src/pipeline/templateSeed.ts`（合同类型 props 存 requiredFields/fieldHints）
- Modify: `apps/server/src/pipeline/tools/documentEntry.ts:1158`（extractGroundedFields 调用传 props）
- Modify: `apps/server/src/pipeline/autoExtraction.ts:218`（同款）
- Test: `apps/server/test/pipeline/extractionProps.test.ts`

**Interfaces:**
- Consumes: `listTemplateTypes`（P1 T2）、`extractGroundedFields`（P1）。
- Produces:
  - `ExtractionInput` 加 `requiredFields?: string[]`、`fieldHints?: Record<string, string>`
  - `extractGroundedFields` 提示词按 props 动态组装（字段清单 + 必填提示）
  - 种子合同类型 props：`{ requiredFields: [...], fieldHints: {...} }`（从现有 REQUIRED_CONTRACT_FIELDS 机械搬移）
  - 锚点字段别名（PARTY_FIELD_ALIASES）本任务**保持硬编码**（只做 prompt 组装，不做字段 schema 驱动）

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/test/pipeline/extractionProps.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate } from '../../src/pipeline/db/client.js';
import { ensureTemplateSeed } from '../../src/pipeline/templateSeed.js';
import { listTemplateTypes } from '../../src/pipeline/db/repositories.js';
import { extractGroundedFields } from '../../src/pipeline/extraction.js';
import type { BlockModel } from '../../src/pipeline/types.js';

function stubModel(returnObject: unknown) {
  return {
    specificationVersion: 'v2' as const,
    provider: 'fake', modelId: 'fake-model', supportedUrls: {} as Record<string, RegExp[]>,
    async doGenerate() {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(returnObject) }],
        finishReason: 'stop' as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [] as unknown[],
      };
    },
    async doStream() { throw new Error('doStream not used'); },
  } as any;
}

const blockModel = (docType: string): BlockModel => ({
  docId: 'DOC-1', docType, modality: 'digital',
  blocks: [{ id: 'b0', type: 'text', text: '合同号 HT-2024-001', page: 1, bbox: null, ocrConfidence: 1 }],
  sourceUri: 'file:///c.pdf', createdAt: '2026-08-26T00:00:00Z',
});

const ctx = createDb();
beforeEach(async () => { migrate(ctx.sqlite); await ensureTemplateSeed(ctx); });

describe('extraction props', () => {
  it('种子合同类型 props 含 requiredFields/fieldHints', async () => {
    const types = await listTemplateTypes(ctx);
    const hetong = types.find((t) => t.name === '合同')!;
    expect(Array.isArray(hetong.props.requiredFields)).toBe(true);
    expect(hetong.props.requiredFields).toContain('合同号');
  });

  it('extractGroundedFields 接受 requiredFields/fieldHints 且缺省行为不变', async () => {
    const model = stubModel({ fields: { 合同号: { value: 'HT-2024-001', sourceSpans: [{ blockId: 'b0', start: 3, end: 15 }] } }, llmConsistency: 0.9 });
    const r1 = await extractGroundedFields({ model }, { blockModel: blockModel('合同') });
    const r2 = await extractGroundedFields({ model }, {
      blockModel: blockModel('合同'),
      requiredFields: ['合同号'], fieldHints: { 合同号: '合同编号' },
    });
    expect(r1.fields.length).toBeGreaterThanOrEqual(1);
    expect(r2.fields.length).toBeGreaterThanOrEqual(1);
    expect(r2.missingRequired).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/pipeline/extractionProps.test.ts`
Expected: FAIL（种子合同 props 无 requiredFields / ExtractionInput 无新字段）

- [ ] **Step 3: templateSeed.ts 合同类型 props**

`DOC_TYPE_SEED` 中 `{ name: '合同' }` 改为：

```ts
  { name: '合同', props: { requiredFields: ['合同号', '甲方', '乙方', '数量', '金额', '签订日'], fieldHints: { 合同号: '合同编号/合同号', 甲方: '买方/甲方', 乙方: '卖方/乙方' } } },
```

（requiredFields 从 extraction.ts 现有 `REQUIRED_CONTRACT_FIELDS` 机械搬移——实现时以该常量实际值为准。）

- [ ] **Step 4: extraction.ts ExtractionInput + 提示词动态组装**

```ts
// :28-31 ExtractionInput 扩展
export interface ExtractionInput {
  blockModel: BlockModel;
  docType: DocType;
  /** 模板 props 驱动: 必填字段清单(缺省 [] = 现状合同特判)。 */
  requiredFields?: string[];
  /** 模板 props 驱动: 字段提示(别名/取值说明), 拼进提示词。 */
  fieldHints?: Record<string, string>;
}
```

`extractGroundedFields` 内提示词组装（`system` 由 GROUNDED_EXTRACTION_PROMPT + 动态段拼接）：

```ts
  const required = input.requiredFields ?? (input.docType === '合同' ? (REQUIRED_CONTRACT_FIELDS as readonly string[]) : []);
  const hints = input.fieldHints ?? {};
  const dynamicPrompt = [
    ...(required.length ? [`必填字段: ${required.join('、')}。缺失时在 missingRequired 中列出。`] : []),
    ...(Object.keys(hints).length ? [`字段提示: ${Object.entries(hints).map(([k, v]) => `${k}(${v})`).join('; ')}。`] : []),
  ].join('\n');
  const system = dynamicPrompt ? `${GROUNDED_EXTRACTION_PROMPT}\n${dynamicPrompt}` : GROUNDED_EXTRACTION_PROMPT;
```

（`required` 变量替换现有 `:165-168` 的硬编码特判；`missingRequired` 计算逻辑不变。）

- [ ] **Step 5: 两处调用方传 props**

`documentEntry.ts:1158` 与 `autoExtraction.ts:218` 的 extractGroundedFields 调用前加载模板 props：

```ts
  const templateTypes = await listTemplateTypes(ctx);
  const typeRow = templateTypes.find((t) => t.kind === 'doc_type' && t.name === docType);
  const result = await extractGroundedFields(deps.extraction, {
    blockModel, docType: docType as DocType,
    requiredFields: Array.isArray(typeRow?.props.requiredFields) ? (typeRow.props.requiredFields as string[]) : undefined,
    fieldHints: typeof typeRow?.props.fieldHints === 'object' ? (typeRow.props.fieldHints as Record<string, string>) : undefined,
  });
```

（import `listTemplateTypes` from `../db/repositories.js`。）

- [ ] **Step 6: 跑新测试 + 全量回归**

Run: `npm test --workspace apps/server -- test/pipeline/extractionProps.test.ts && npm run build && npm test`
Expected: 全 PASS（缺省行为不变 = 回归验证点）

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/pipeline/extraction.ts apps/server/src/pipeline/templateSeed.ts apps/server/src/pipeline/tools/documentEntry.ts apps/server/src/pipeline/autoExtraction.ts apps/server/test/pipeline/extractionProps.test.ts
git commit -m "feat(template): 抽取路由props驱动提示词"
```

---

### Task 7: template_overview L1 工具

**Files:**
- Create: `apps/server/src/pipeline/tools/templateOverviewTool.ts`
- Modify: `apps/server/src/harness/roleToolRegistry.ts`（注册 template_overview + TRADER_CTX_TOOL_NAMES）
- Modify: `apps/server/src/harness/permissionGate.ts`（registerPermission('template_overview', 'L1')）
- Modify: `apps/server/src/harness/contextContract.ts`（template_overview 契约条目）
- Test: `apps/server/test/pipeline/templateOverviewTool.test.ts`

**Interfaces:**
- Consumes: `listTemplateTypes`/`listActiveEdgeRules`（P1 T2）、`ancestorChain`/`matchEdgeRule`（P1 T4）、`ToolDeps`（documentEntry.ts 样板）。
- Produces: `buildTemplateOverviewTool(deps: ToolDeps)` — L1 只读；input `{ docType?: string }`；输出类型层级 + 允许挂接合同类型与词表（对齐 P1 T7 context API 语义）。

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/test/pipeline/templateOverviewTool.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate } from '../../src/pipeline/db/client.js';
import { ensureTemplateSeed } from '../../src/pipeline/templateSeed.js';
import { buildTemplateOverviewTool } from '../../src/pipeline/tools/templateOverviewTool.js';

const ctx = createDb();
beforeEach(async () => { migrate(ctx.sqlite); await ensureTemplateSeed(ctx); });

describe('template_overview tool', () => {
  it('无 docType: 返回全类型层级', async () => {
    const tool = buildTemplateOverviewTool({ ctx, userId: 'u1' });
    const res = await tool.execute({});
    expect(res.typeCount).toBeGreaterThanOrEqual(24);
    expect(res.coarse).toEqual(expect.arrayContaining(['合同', '立项书', '履约凭证', '其他']));
  });

  it('docType=收货单: 返回类型链 + settles 词表 + 允许合同类型', async () => {
    const tool = buildTemplateOverviewTool({ ctx, userId: 'u1' });
    const res = await tool.execute({ docType: '收货单' });
    expect(res.typeChain).toContain('收货单');
    expect(res.typeChain).toContain('履约凭证');
    expect(res.settlesVocab).toEqual(['收货']);
    expect(res.allowedContractTypes.length).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/pipeline/templateOverviewTool.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 templateOverviewTool.ts**

```ts
// 模板概览工具(spec 2026-08-26 §4.4): L1 只读, 本体成为 Agent 可用知识。
import { tool } from 'ai';
import { z } from 'zod';
import type { DbContext } from '../db/client.js';
import { listActiveEdgeRules, listTemplateTypes } from '../db/repositories.js';
import { ancestorChain, matchEdgeRule } from '../templateGuard.js';

export interface TemplateOverviewToolDeps {
  ctx: DbContext;
  userId?: string;
}

const CONTRACT_TYPE_NAMES = ['采购', '销售', '物流', '租赁', '服务', '其他'];

export function buildTemplateOverviewTool(deps: TemplateOverviewToolDeps) {
  return tool({
    description:
      '查询模板层: 单据类型层级、某单据类型允许挂接的合同类型与边词表。' +
      '用途: 用户问"收货单能挂什么合同""发票能连什么边"或需要了解类型体系时调用。' +
      'L1 只读, 无需授权。docType 缺省返回全类型层级概览。',
    inputSchema: z.object({
      docType: z.string().optional().describe('单据类型名(如 收货单/发票); 缺省返回全层级'),
    }),
    execute: async ({ docType }) => {
      const [types, rules] = await Promise.all([listTemplateTypes(deps.ctx), listActiveEdgeRules(deps.ctx)]);
      const byId = new Map(types.map((t) => [t.id, t]));
      const nameOf = (id: string) => byId.get(id)?.name ?? null;
      const docTypes = types.filter((t) => t.kind === 'doc_type');
      const coarse = docTypes.filter((t) => !t.parentId).map((t) => t.name);
      if (!docType) {
        return {
          typeCount: docTypes.length,
          coarse,
          types: docTypes.map((t) => ({ name: t.name, parent: t.parentId ? nameOf(t.parentId) : null, active: t.isActive })),
        };
      }
      const docTypeId = byId.get(`dt-${docType}`)?.id ?? null;
      const sourceChain = ancestorChain(docTypeId, byId);
      const typeChain = sourceChain.map((id) => nameOf(id)!).filter(Boolean);
      const settlesRule = matchEdgeRule({ rules, sourceChain, targetChain: [''], edgeType: 'settles' });
      const allowedContractTypes = CONTRACT_TYPE_NAMES.filter((ct) => {
        const chain = ancestorChain(byId.get(`ct-${ct}`)?.id ?? null, byId);
        return matchEdgeRule({ rules, sourceChain, targetChain: chain, edgeType: 'binds' }) !== null;
      });
      return {
        docType, typeChain, settlesVocab: settlesRule ? settlesRule.allowedVocab : null,
        allowedContractTypes,
      };
    },
  });
}
```

- [ ] **Step 4: 注册（roleToolRegistry + permissionGate + contextContract + TRADER_CTX_TOOL_NAMES）**

`roleToolRegistry.ts`：
- `TRADER_CTX_TOOL_NAMES`（:407）追加 `'template_overview'`
- `getToolsForRole` 的 trader ctx 块追加：

```ts
        // template_overview is L1 (2026-08-26 模板): 类型层级/允许挂接合同类型与词表。
        { ...buildTemplateOverviewTool({ ctx, userId }), name: 'template_overview' },
```

`permissionGate.ts` 追加：

```ts
registerPermission('template_overview', 'L1'); // 2026-08-26 模板: 类型层级/允许挂接查询(只读)
```

`contextContract.ts` 追加：

```ts
  template_overview: {
    output: 'raw', budget: 'full', signal: 'env',
    persist: 'business', risk: { level: 'L1', injection: 'safe' },
  },
```

- [ ] **Step 5: 跑新测试 + 全量回归**

Run: `npm test --workspace apps/server -- test/pipeline/templateOverviewTool.test.ts && npm run build && npm test`
Expected: 全 PASS

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/pipeline/tools/templateOverviewTool.ts apps/server/src/harness/roleToolRegistry.ts apps/server/src/harness/permissionGate.ts apps/server/src/harness/contextContract.ts apps/server/test/pipeline/templateOverviewTool.test.ts
git commit -m "feat(template): template_overview L1工具"
```

---

### Task 8: graphCommit 守卫评估（登记不激活）

**Files:**
- Modify: `apps/server/src/pipeline/templateSeed.ts`（登记 party/commodity/references 规则, active:false）
- Test: `apps/server/test/pipeline/graphCommitGuardEval.test.ts`

**Interfaces:**
- Consumes: `validateEdge`（P1 T4）、`commitDocumentGraph`（graphCommit.ts:836）。
- Produces: 评估结论（本 Phase 不激活）+ 登记规则 + 现状行为文档化测试。

**评估判据（写入本任务结论）：**
- party/commodity/references/executes 边**无合同终点**（连 Party/Commodity 节点），类型兼容性守卫的"起点类型 × 终点合同类型"语义不适用——守卫模型需扩展为"起点类型 × 终点实体 kind"，超出 Phase 2 范围。
- 这些边由抽取字段**确定性派生**（deriveProposedRelationships/deriveProposedEdges），非用户主动选择——守卫的"拒绝非法组合"价值低（派生逻辑本身即白名单）。
- 激活需先把 deriveProposedEdges 的语义机械翻译进种子规则（与 P1 对 binds/settles 的翻译同款），且需定义终点 kind 校验——留待 Phase 3（manage_template 存在后）统一做。
- **结论：本 Phase 只登记规则（active:false）+ 文档化现状行为，不接入 GUARDED_EDGE_TYPES。**

- [ ] **Step 1: 写失败测试（文档化现状行为）**

```ts
// apps/server/test/pipeline/graphCommitGuardEval.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate } from '../../src/pipeline/db/client.js';
import { ensureTemplateSeed } from '../../src/pipeline/templateSeed.js';
import { listActiveEdgeRules } from '../../src/pipeline/db/repositories.js';
import { validateEdge } from '../../src/pipeline/templateGuard.js';

const ctx = createDb();
beforeEach(async () => { migrate(ctx.sqlite); await ensureTemplateSeed(ctx); });

describe('graphCommit guard evaluation (Phase 2: 登记不激活)', () => {
  it('party/commodity/references/executes 不在守卫范围(现状放行)', async () => {
    const r = await validateEdge(ctx, { docType: '发票', edgeType: 'party' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ruleId).toBe('unguarded');
  });

  it('executes 规则已登记但未激活', async () => {
    const rules = await listActiveEdgeRules(ctx);
    expect(rules.some((r) => r.id === 'er-exec-fapiao')).toBe(false);
    const all = ctx.sqlite.prepare("SELECT id, is_active FROM template_edge_rules WHERE edge_type = 'executes'").all() as Array<{ id: string; is_active: number }>;
    expect(all.length).toBeGreaterThanOrEqual(3);
    expect(all.every((r) => r.is_active === 0)).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/pipeline/graphCommitGuardEval.test.ts`
Expected: FAIL（party/commodity/references 规则未登记——现状只有 executes 三条）

- [ ] **Step 3: templateSeed.ts 登记 party/commodity/references 规则（active:false）**

`EDGE_RULE_SEED` 追加（语义来源注释指向被翻译的硬编码）：

```ts
  // ---- graphCommit 派生边(spec §3.2 Phase 1 校验范围外, Phase 2 评估后登记不激活) ----
  // party/commodity/references 由 deriveProposedRelationships/deriveProposedEdges 确定性派生,
  // 无合同终点, 守卫模型不适用; 登记留痕, 激活待 Phase 3(manage_template 后)。
  { id: 'er-party-fapiao', src: '发票', edge: 'party', vocab: [], active: false },
  { id: 'er-commodity-fapiao', src: '发票', edge: 'commodity', vocab: [], active: false },
  { id: 'er-references-hetong', src: '合同', edge: 'references', vocab: [], active: false },
```

- [ ] **Step 4: 跑新测试 + 全量回归**

Run: `npm test --workspace apps/server -- test/pipeline/graphCommitGuardEval.test.ts && npm run build && npm test`
Expected: 全 PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/pipeline/templateSeed.ts apps/server/test/pipeline/graphCommitGuardEval.test.ts
git commit -m "feat(template): graphCommit守卫评估(登记不激活)"
```

---

### Task 9: 终审遗留三项（settles 白名单顺序 / anchorWeights 接线 / confirmed 重试补 version）

**Files:**
- Modify: `apps/server/src/routes/bindings.ts`（confirmed 重试路径补 templateVersion；settles 白名单顺序验证）
- Modify: `apps/server/src/pipeline/bindingCandidates.ts`（anchorWeights 接线）
- Modify: `apps/server/src/pipeline/tools/documentEntry.ts`（anchorWeights 接线）
- Test: `apps/server/test/pipeline/leftoverFixes.test.ts`

**Interfaces:**
- Consumes: `generateBindingProposals`（P1 T5，第三参 weights）、`matchEdgeRule`/`ancestorChain`（P1 T4）、`templateGate`（P1 T6）。
- Produces:
  - ① settles 白名单顺序保证：`syncSettlesAfterFlow` 内 FLOW_TYPE_BY_DOC_TYPE 映射（materializeExecutionFlow 已做）先于守卫——验证守卫读的 docType 来自抽取行（映射后），不误用输入 docType
  - ② anchorWeights 接线：调用 `generateBindingProposals` 前 `matchEdgeRule` 读 binds 规则 anchorWeights 传第三参，null 回退缺省
  - ③ confirmed 重试路径补 templateVersion：`POST /` existing confirmed 分支（bindings.ts:661-664）跑 templateGate 并传 gate.templateVersion

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/test/pipeline/leftoverFixes.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate } from '../../src/pipeline/db/client.js';
import { ensureTemplateSeed } from '../../src/pipeline/templateSeed.js';
import { ensureEdgeRule, listActiveEdgeRules, listTemplateTypes } from '../../src/pipeline/db/repositories.js';
import { buildBindingCandidates } from '../../src/pipeline/bindingCandidates.js';
import { generateBindingProposals } from '../../src/pipeline/bindingProposal.js';

const ctx = createDb();
beforeEach(async () => { migrate(ctx.sqlite); await ensureTemplateSeed(ctx); });

describe('leftover fixes', () => {
  it('anchorWeights 接线: 规则权重传入 generateBindingProposals', async () => {
    // 给 付款凭证 binds 规则设 anchorWeights(金额权重高)
    await ensureEdgeRule(ctx, {
      id: 'er-bind-fukuan', sourceTypeId: 'dt-付款凭证', edgeType: 'binds',
      allowedVocab: ['付款'], isActive: true, anchorWeights: { party: 0.2, time: 0.1, amount: 0.7, qty: 0 },
    });
    // 直接验证 generateBindingProposals 第三参生效(与 P1 T5 同款断言)
    const anchors = { buyer: 'A公司', seller: 'B公司', date: '2026-01-10', amount: 500 };
    const ledger = [
      { contractNo: 'HT-1', fields: { 买方: { value: 'A公司', sourceSpans: [] }, 卖方: { value: 'B公司', sourceSpans: [] }, 签订日: { value: '2026-01-10', sourceSpans: [] }, 合同金额: { value: 100, sourceSpans: [] } } },
      { contractNo: 'HT-2', fields: { 买方: { value: 'A公司', sourceSpans: [] }, 卖方: { value: 'C公司', sourceSpans: [] }, 签订日: { value: '2025-12-01', sourceSpans: [] }, 合同金额: { value: 500, sourceSpans: [] } } },
    ];
    const r = generateBindingProposals(anchors as never, ledger as never, { party: 0.2, time: 0.1, amount: 0.7, qty: 0 });
    expect(r[0]?.contractNo).toBe('HT-2');
  });

  it('buildBindingCandidates 读规则 anchorWeights(经注入断言)', async () => {
    // 夹具: 付款凭证文档 + 抽取行 + 台账; 规则 anchorWeights 金额高 -> 候选 top1 变化
    // (以 bindingCandidates 既有测试脚手架为模板, 断言候选排序反映权重)
  });
});
```

（③ confirmed 重试补 version 的测试：以 `test/routes/bindingsGuard.test.ts` 脚手架为模板——confirmed 行 graph_status=failed 后 POST / 重试，断言 syncBindingEdge 入参含 templateVersion。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/pipeline/leftoverFixes.test.ts`
Expected: FAIL（buildBindingCandidates 未读 anchorWeights / 重试路径无 templateVersion）

- [ ] **Step 3: ② anchorWeights 接线（bindingCandidates.ts + documentEntry.ts）**

`bindingCandidates.ts:559-560` 替换：

```ts
  const [types, rules] = await Promise.all([listTemplateTypes(ctx), listActiveEdgeRules(ctx)]);
  const byId = new Map(types.map((t) => [t.id, t]));
  const chain = ancestorChain(byId.get(`dt-${extraction.docType}`)?.id ?? null, byId);
  const rule = matchEdgeRule({ rules, sourceChain: chain, targetChain: [''], edgeType: 'binds' });
  const weights = rule?.anchorWeights ?? undefined;
  const proposals = generateBindingProposals(anchors, ledger, weights);
```

`documentEntry.ts:523` 同款（`generateBindingProposals(anchors, ledger, weights)`，weights 由 docType 的 binds 规则 anchorWeights 读出）。

（import `listTemplateTypes`/`listActiveEdgeRules` from `../db/repositories.js`、`ancestorChain`/`matchEdgeRule` from `../templateGuard.js`。）

- [ ] **Step 4: ③ confirmed 重试路径补 templateVersion（bindings.ts:661-664）**

```ts
    if (existing.status === 'confirmed') {
      const gate = await templateGate(db, user.id, { documentId, contractNo, relation: existing.relation });
      const sync = await syncBindingEdgeWithMeta(db, user.id, {
        docId: documentId, contractNo, relation: existing.relation,
        bindingId: existing.id, confidence: existing.confidence,
        templateVersion: gate.ok ? (gate.templateVersion ?? undefined) : undefined,
      });
      const gs = await graphStatusFor(sync.outcome, sync.reason);
      await setBindingGraphStatus(db, existing.id, gs, user.id);
      return c.json({ ok: true, bindingId: existing.id, existing: true, graphSync: sync.outcome, ...(sync.reason ? { graphReason: sync.reason } : {}) });
    }
```

（`templateGate` 为 P1 T6 内部辅助，已在本文件。）

- [ ] **Step 5: ① settles 白名单顺序验证（bindings.ts syncSettlesAfterFlow）**

验证 `syncSettlesAfterFlow` 的守卫读的 docType 来自 `getDocumentMeta`（抽取行 docType = FLOW_TYPE_BY_DOC_TYPE 映射后的类型），而非调用方传入的原始 docType——Task 3 的交叉验证实现已满足（守卫在 `settled` 物化之后、用 meta.docType）。本步骤为**验证 + 注释**：在 syncSettlesAfterFlow 交叉验证块加注释说明顺序保证：

```ts
  // 顺序保证(终审遗留①): materializeExecutionFlow 已按 FLOW_TYPE_BY_DOC_TYPE 映射
  // 产出 settled(白名单外返回 null 不走到这里); 此处守卫读 meta.docType(抽取行,
  // 即映射后的类型), 与派生 relation 交叉验证——映射先于守卫。
```

- [ ] **Step 6: 跑新测试 + 全量回归**

Run: `npm test --workspace apps/server -- test/pipeline/leftoverFixes.test.ts && npm run build && npm test`
Expected: 全 PASS

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/routes/bindings.ts apps/server/src/pipeline/bindingCandidates.ts apps/server/src/pipeline/tools/documentEntry.ts apps/server/test/pipeline/leftoverFixes.test.ts
git commit -m "fix(template): 终审遗留三项(settles顺序/anchorWeights/重试version)"
```

---

## 收尾

- [ ] **最终门禁**: 仓库根 `npm run build && npm run lint && npm test` 全绿后，按 AGENTS.md 约定 push（本分支为讨论分支 `PengYip/业务图谱模版关系讨论`，不 push main）。
- [ ] **后续计划（不在本计划内）**: 前端双下拉改造（CandidatePanel 手动绑定表单 → 项目下拉 + 合同下拉 + relation 只读派生展示，消费 P1 T7 context API；歧义时第三步澄清）→ 独立计划，建议执行时 @designer 参与交互评审。Phase 3（模板管理 API 完整化 + manage_template L2 + 版本审计 + 管理 UI）另行计划。

## Self-Review 记录

- **Spec 覆盖**: §3.1 v2 类型决策表（T1 层级化、T2 别名迁移、T3 方向编码、T5 立项书、T4 amends）、§3.2 边类型六种（T4 amends、T8 登记 party/commodity/references/executes）、§4.2 抽取路由（T6）、§4.3 守卫接入（T3 settles 交叉验证、T8 评估）、§4.4 工具（T7 template_overview L1、T4 link_amends L2）、§7 分期（Phase 2 全部后端项）。✓
- **依赖顺序**: T1（层级化）先行；T2/T3 依赖 T1（分类器产出新类型）；T4/T5 依赖 P1 图同步/守卫基础设施；T6 依赖 T1（细类）+ P1 模板表；T7/T8 依赖 P1 守卫；T9 收尾（依赖 P1 + T3）。✓
- **行为变化与兼容**: 每个行为变化任务带幂等迁移（T2）或回归验证点（T3 旧 8 类双向词表不阻断、T5 旧 Contract 绑定不变、T6 缺省行为不变）。✓
- **类型一致性**: DocType 扩展（T1）与 DOC_TYPES legacy 兼容；GraphLinkKind 扩展（T4）与 correlates/relates 兼容；bindings.target_kind 缺省 'Contract'（T5）与存量行兼容。✓
- **占位符**: T3/T9 的路由层测试以既有脚手架为模板 + 固定断言目标（可执行指令）；T6 requiredFields 以 extraction.ts 现有 REQUIRED_CONTRACT_FIELDS 实际值为准。✓

## 开放问题（需裁决后执行）

1. **DocType 联合扩展范围（T1）**：分类器将产出 v2 新类型（收货单等），当前 `DocType` 联合仅 8 类。计划采用：扩展 types.ts 的 DocType 至 v2 种子集（24 类），`DOC_TYPES` legacy 8 类保留 `satisfies`。备选：分类器返回 `string` 弱化类型。**建议：扩展联合**（诚实类型，documents.doc_type 本就是 TEXT）。
2. **细类候选范围（T1）**：`buildClassifierVocab` 的细类 = 粗类的**全部后代**（含中间层如 运输凭证/资金凭证/发票凭证）还是**仅叶子**？计划采用全部后代（中间层是合法分类，模型选最具体）。**建议：全部后代**。
3. **方向编码类型 settles 边落库路径（T3）**：收货单等不在 FLOW_TYPE_BY_DOC_TYPE，materializeExecutionFlow 返回 null，现状无 settles 边。计划新增 `syncSettlesByType`（确认/创建绑定后按单方向规则落 settles 边）。**建议：采纳**（否则方向编码类型"上岗"无实际效果）；direction 映射（收款/收货/收票=in，其余=out）需确认。
4. **amends 边 srcKind（T4）**：补充合同是 doc_type，amends 边为 Document(补充合同) → Contract(基础合同)，需把 graph_links 的 srcKind 联合扩展为 `'Contract' | 'Project' | 'Document'`。**建议：采纳**（与 binds 的 Document→Contract 同构）。
5. **立项书 targetKind 判定（T5）**：路由层如何知道 立项书 → Project？计划采用 template_types.props.bindsTargetKind='Project'（模板驱动）+ createSchema 可选 targetKind 覆盖。**建议：采纳**（模板驱动，符合"类型即数据"）。
6. **graphCommit 守卫（T8）**：评估结论为**本 Phase 不激活**（party/commodity/references/executes 无合同终点、确定性派生、守卫模型不适用），只登记规则留痕。**建议：确认不激活**，激活条件（终点 kind 校验 + deriveProposedEdges 语义翻译）写入任务结论。
7. **settles 交叉验证的硬/软语义（T3）**：交叉验证不通过时**跳过 settles 边 + warn**（硬跳过）还是仅 warn 照常落边？计划采用硬跳过（类型方向与派生矛盾说明数据异常）。**建议：硬跳过**（与"宁可空缺不猜"铁律一致）。

## 裁决记录（2026-08-26，协调者）

七项开放问题全部**按建议采纳**：#1 扩展 DocType 联合至 v2 种子集；#2 细类候选=全部后代；#3 新增 syncSettlesByType，direction 映射 收款/收货/收票=in、付款/发货/开票=out（与用户 v2 方向编码 收/发、进/销 决策同源）；#4 amends srcKind 扩展 'Document'；#5 targetKind 走 props.bindsTargetKind；#6 graphCommit 守卫本 Phase 不激活（评估结论+激活判据留痕，符合 spec「P2 起再评估」）；#7 交叉验证硬跳过。执行时不再重议。