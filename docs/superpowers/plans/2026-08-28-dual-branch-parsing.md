# 双分支文档解析管线实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 图像原生凭证（照片/扫描 PDF/照片拼合 PDF）走 VLM 端到端提取（跳过 OCR），合同类保留 OCR+文本管线；分类词表对齐模板树（表单类型→业务类型映射），重量凭证服务端聚合总净重。

**Architecture:** 在 `processDocument` 的 OCR 兜底点插入 VLM 门控：PDF 无文字层时先渲染第 1 页做 VLM 表单分类，voucher 路由走渲染页多图提取（重量类逐页提取+服务端聚合），document 路由与分类失败/低置信一律回落现有 MinerU OCR 路径。凭证落库复用 `runVoucherPipeline`。

**Tech Stack:** TypeScript (AI SDK 6 repo), `pdf-to-img`(纯 JS PDF 渲染), `pdf-lib`(devDep, 测试夹具), 原生 fetch OpenAI 兼容 /chat/completions（同现有 vlmAdapter），vitest。

**Spec:** `docs/superpowers/specs/2026-08-28-dual-branch-parsing-design.md`

## Global Constraints

- 不用 emoji；注释用现有仓库的中文简注风格。
- AI SDK 6 语义约束适用于本仓（本计划新模型调用走原生 fetch，与 `vlmAdapter.ts` 同模式，不涉 AI SDK 封装差异）。
- 依赖只加 `pdf-to-img`（dependencies）与 `pdf-lib`（devDependencies），装在 `apps/server` workspace。
- 现有行为零回归：VLM 未配置时系统行为 = 现状（全部 OCR）；jpg/png 图片凭证现有路径不变。
- 重量凭证总净重 = 服务端确定性求和，绝不取模型输出的合计值。
- 误判安全方向：分类失败/低置信/未知表单 → OCR 分支。
- 完成判定：`npm run build` → `npm run lint` → `npm test` 全绿（repo 根目录执行）。
- 测试一律 hermetic（fake VLM/夹具 PDF），不依赖真实 VLM 服务与 MinerU 二进制。

---

### Task 1: `pdfRender.ts` — PDF 页面渲染

**Files:**
- Create: `apps/server/src/pipeline/pdfRender.ts`
- Modify: `apps/server/package.json`（加依赖）
- Test: `apps/server/test/pipeline/pdfRender.test.ts`

**Interfaces:**
- Produces: `renderPdfPages(sourcePath: string, opts?: { dpi?: number }): Promise<RenderedPage[]>`，`RenderedPage = { page: number; mime: 'image/png'; buffer: Buffer }`（page 从 1 计）。

- [ ] **Step 1: 安装依赖**

```bash
npm install pdf-to-img --workspace apps/server
npm install -D pdf-lib --workspace apps/server
```

装完跑 `node -e "import('pdf-to-img').then(m=>console.log(Object.keys(m)))"` 确认导出含 `pdf`（若 API 与下述假设不符——预期 `const doc = await pdf(pathOrBuffer, {scale})` 返回异步可迭代 PNG Buffer 且有 `.length`——以实际导出微调 Step 3 实现与 Step 4 测试，接口 `renderPdfPages` 不变）。

- [ ] **Step 2: 写失败测试**（夹具 PDF 用 pdf-lib 在测试内生成，2 页各画一个大黑矩形）

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { PDFDocument, rgb } from 'pdf-lib';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderPdfPages } from '../../src/pipeline/pdfRender.js';

let pdfPath: string;
beforeAll(async () => {
  const doc = await PDFDocument.create();
  for (let i = 0; i < 2; i++) {
    const page = doc.addPage([595, 842]);
    page.drawRectangle({ x: 50, y: 50, width: 495, height: 742, color: rgb(0, 0, 0) });
  }
  pdfPath = join(mkdtempSync(join(tmpdir(), 'pdfrender-')), 'two-page.pdf');
  writeFileSync(pdfPath, await doc.save());
});

describe('renderPdfPages', () => {
  it('renders all pages as PNG buffers in order', async () => {
    const pages = await renderPdfPages(pdfPath);
    expect(pages).toHaveLength(2);
    expect(pages[0]!.page).toBe(1);
    expect(pages[1]!.page).toBe(2);
    for (const p of pages) {
      expect(p.mime).toBe('image/png');
      expect(p.buffer.length).toBeGreaterThan(1000);
      // PNG magic bytes
      expect(p.buffer.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    }
  });
  it('throws a clear error for a non-PDF file', async () => {
    await expect(renderPdfPages('no-such-file.txt')).rejects.toThrow(/pdf/i);
  });
});
```

- [ ] **Step 3: 跑测试确认失败** — `npm test --workspace apps/server -- test/pipeline/pdfRender.test.ts`，预期 FAIL（模块不存在）。

- [ ] **Step 4: 实现**

```ts
// PDF 页面渲染: pdf-to-img(纯 JS pdfjs)把每页渲成 PNG Buffer。
// 分类取第 1 页、凭证提取取全部页, 由调用方切片; 本模块只做页->图。
import { statSync } from 'node:fs';
import { pdf } from 'pdf-to-img';

export interface RenderedPage {
  /** 1-indexed */
  page: number;
  mime: 'image/png';
  buffer: Buffer;
}

/** DPI->pdf-to-img scale(基准 72dpi)。默认 150dpi: 分类与票据提取够用, 单页产物远小于 10MB 上限。 */
export function dpiToScale(dpi = 150): number {
  return dpi / 72;
}

export async function renderPdfPages(
  sourcePath: string,
  opts: { dpi?: number } = {},
): Promise<RenderedPage[]> {
  if (!/\.pdf$/i.test(sourcePath) || !statSync(sourcePath).isFile()) {
    throw new Error(`不是有效的 PDF 文件: ${sourcePath}`);
  }
  const doc = await pdf(sourcePath, { scale: dpiToScale(opts.dpi) });
  const out: RenderedPage[] = [];
  let page = 0;
  for await (const img of doc) {
    page += 1;
    out.push({ page, mime: 'image/png', buffer: Buffer.from(img) });
  }
  if (out.length === 0) throw new Error(`PDF 渲染得到 0 页: ${sourcePath}`);
  return out;
}
```

- [ ] **Step 5: 跑测试确认通过** — 同 Step 3 命令，预期 PASS。

- [ ] **Step 6: Commit** — `git add apps/server/src/pipeline/pdfRender.ts apps/server/test/pipeline/pdfRender.test.ts apps/server/package.json package-lock.json && git commit -m "feat(pipeline): pdfRender PDF 页面渲染适配器"`

### Task 2: `formTypeRegistry.ts` — 表单类型→业务类型映射

**Files:**
- Create: `apps/server/src/pipeline/formTypeRegistry.ts`
- Test: `apps/server/test/pipeline/formTypeRegistry.test.ts`

**Interfaces:**
- Consumes: `TemplateTypeRow`（`db/repositories.js`，含 `id/kind/name/parentId/props/isActive`）。
- Produces: `buildFormTypeIndex(types: TemplateTypeRow[]): FormTypeIndex`；`FormTypeIndex = { routeOf(formType): 'document'|'voucher'|'unknown'; docTypeOf(formType): DocType|undefined }`；以及常量 `DOCUMENT_ROUTE_DOCTYPES`。映射数据源：`doc_type.props.formTypes`（string[]）；`合同/立项书/补充合同` → document，其余 → voucher；未登记 → unknown。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest';
import { buildFormTypeIndex, DOCUMENT_ROUTE_DOCTYPES } from '../../src/pipeline/formTypeRegistry.js';
import type { TemplateTypeRow } from '../../src/pipeline/db/repositories.js';

function row(name: string, props?: Record<string, unknown>): TemplateTypeRow {
  return { id: `dt-${name}`, kind: 'doc_type', name, parentId: null, props: props ?? {}, isActive: true } as TemplateTypeRow;
}

describe('formTypeRegistry', () => {
  it('maps formTypes from template props to route and docType', () => {
    const idx = buildFormTypeIndex([
      row('合同', { formTypes: ['合同扫描件'] }),
      row('汽运磅单', { formTypes: ['汽车过磅单票据'] }),
      row('水尺计重单', { formTypes: ['水尺计重单'] }),
    ]);
    expect(idx.routeOf('合同扫描件')).toBe('document');
    expect(idx.docTypeOf('合同扫描件')).toBe('合同');
    expect(idx.routeOf('汽车过磅单票据')).toBe('voucher');
    expect(idx.docTypeOf('汽车过磅单票据')).toBe('汽运磅单');
  });
  it('unknown formType -> unknown route', () => {
    const idx = buildFormTypeIndex([]);
    expect(idx.routeOf('不认识的东西')).toBe('unknown');
    expect(idx.docTypeOf('不认识的东西')).toBeUndefined();
  });
  it('document route set is exactly 合同/立项书/补充合同', () => {
    expect([...DOCUMENT_ROUTE_DOCTYPES].sort()).toEqual(['补充合同', '合同', '立项书'].sort());
  });
});
```

- [ ] **Step 2: 跑测试确认失败** — `npm test --workspace apps/server -- test/pipeline/formTypeRegistry.test.ts`。

- [ ] **Step 3: 实现**

```ts
// 表单类型 -> 业务类型映射(spec 2026-08-28 §3): 映射是数据(doc_type.props.formTypes),
// 不是代码。VLM 分类器只输出表单类型; route/document 与业务类型都从这里派生。
// 业务类型调整=改模板表 props, 分类器与提取代码不动。
import type { DocType } from './types.js';
import type { TemplateTypeRow } from './db/repositories.js';

/** document 路由的粗类(需全文, 走 OCR 分支); 其余一切 voucher。 */
export const DOCUMENT_ROUTE_DOCTYPES: ReadonlySet<string> = new Set(['合同', '立项书', '补充合同']);

export interface FormTypeIndex {
  routeOf(formType: string): 'document' | 'voucher' | 'unknown';
  docTypeOf(formType: string): DocType | undefined;
}

/** 全树 formTypes 并集(注入 VLM 分类 prompt 的候选清单)。 */
export function collectFormTypes(types: TemplateTypeRow[]): string[] {
  const out = new Set<string>();
  for (const t of types) {
    if (t.kind !== 'doc_type' || !t.isActive || !Array.isArray(t.props.formTypes)) continue;
    for (const f of t.props.formTypes as unknown[]) if (typeof f === 'string' && f) out.add(f);
  }
  return [...out];
}

export function buildFormTypeIndex(types: TemplateTypeRow[]): FormTypeIndex {
  const formToDocType = new Map<string, DocType>();
  for (const t of types) {
    if (t.kind !== 'doc_type' || !Array.isArray(t.props.formTypes)) continue;
    for (const f of t.props.formTypes as unknown[]) {
      if (typeof f === 'string' && f && !formToDocType.has(f)) formToDocType.set(f, t.name as DocType);
    }
  }
  return {
    routeOf(formType) {
      const dt = formToDocType.get(formType);
      if (!dt) return 'unknown';
      return DOCUMENT_ROUTE_DOCTYPES.has(dt) ? 'document' : 'voucher';
    },
    docTypeOf(formType) {
      return formToDocType.get(formType);
    },
  };
}
```

（注：若 `TemplateTypeRow.props` 类型是 `Record<string, unknown>` 之外的形状，以实际定义为准调整 `t.props.formTypes` 访问。）

- [ ] **Step 4: 跑测试通过 + Commit** — `git add ... && git commit -m "feat(pipeline): formTypeRegistry 表单类型映射"`

### Task 3: `vlmClassifier.ts` — VLM 表单分类器

**Files:**
- Create: `apps/server/src/pipeline/vlmClassifier.ts`
- Test: `apps/server/test/pipeline/vlmClassifier.test.ts`

**Interfaces:**
- Consumes: `env.VLM_*`（env.ts 已有）；渲染页 `{mime, buffer}`。
- Produces: `classifyForm(input: { page: { mime: string; buffer: Buffer }, formTypes: string[] }, deps?: { call?: typeof vlmCall }): Promise<{ formType: string; confidence: number }>`；失败抛错（调用方决定回落 OCR）。` Confidence < CONFIDENCE_FLOOR(0.6) 或 formType 不在 formTypes 清单 → 返回 `{formType:'', confidence}` 交调用方按 unknown 处理`——不，简化：返回 raw 结果，判定逻辑在调用方（processDocument 集成处），本模块只做调用+解析+容错重试 1 次。

- [ ] **Step 1: 写失败测试**（fake `call` 注入，不打网络）

```ts
import { describe, it, expect, vi } from 'vitest';
import { classifyForm } from '../../src/pipeline/vlmClassifier.js';

const page = { mime: 'image/png', buffer: Buffer.from('fake') };

describe('classifyForm', () => {
  it('parses a well-formed VLM answer', async () => {
    const call = vi.fn().mockResolvedValue('{"formType":"汽车过磅单票据","confidence":0.92}');
    const r = await classifyForm({ page, formTypes: ['汽车过磅单票据', '合同扫描件'] }, { call });
    expect(r).toEqual({ formType: '汽车过磅单票据', confidence: 0.92 });
  });
  it('retries once with the error appended, then throws', async () => {
    const call = vi.fn().mockRejectedValueOnce(new Error('JSON 解析失败')).mockResolvedValueOnce('{"formType":"合同扫描件","confidence":0.8}');
    const r = await classifyForm({ page, formTypes: ['合同扫描件'] }, { call });
    expect(r.formType).toBe('合同扫描件');
    expect(call).toHaveBeenCalledTimes(2);
  });
  it('throws after two failures', async () => {
    const call = vi.fn().mockRejectedValue(new Error('boom'));
    await expect(classifyForm({ page, formTypes: ['x'] }, { call })).rejects.toThrow('boom');
    expect(call).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: 确认失败 → Step 3: 实现**

```ts
// VLM 表单分类器(spec 2026-08-28 §4): 渲染页 -> {formType, confidence}。
// 只输出表单类型; route/业务类型由 formTypeRegistry 派生。调用模式与
// vlmAdapter 相同(原生 fetch + response_format json_object, 失败回灌重试 1 次)。
import { env } from '../env.js';

export interface ClassifyPage {
  mime: string;
  buffer: Buffer;
}

export type VlmCall = (prompt: string, page: ClassifyPage) => Promise<string>;

export async function vlmCall(prompt: string, page: ClassifyPage): Promise<string> {
  if (!env.VLM_BASE_URL || !env.VLM_API_KEY) throw new Error('VLM 未配置，无法分类');
  const url = `${env.VLM_BASE_URL.replace(/\/+$/, '')}/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.VLM_API_KEY}` },
    body: JSON.stringify({
      model: env.VLM_MODEL,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:${page.mime};base64,${page.buffer.toString('base64')}` } },
        ],
      }],
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(env.VLM_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`VLM /chat/completions 失败 (${res.status} ${res.statusText})`);
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('VLM 返回空内容');
  return content;
}

export function buildFormClassifyPrompt(formTypes: string[]): string {
  return [
    '你是供应链单据表单类型识别器。只依据图片判断这份文件的表单类型(它长什么样, 与业务系统无关)。',
    `表单类型只允许输出以下${formTypes.length}个值之一: ${formTypes.join(' / ')}。`,
    '判别特征:',
    '- 汽车过磅单票据: 针打票据/小票, 抬头为电厂或公司名, 含 毛重/皮重/净重/车号 字段。',
    '- 轨道衡称重记录: 表格多行, 每行一节车厢(车型/车号/毛重/皮重/净重), 常带红色印章。',
    '- 水尺计重单: 英文表单(DRAFT SURVEY REPORT), 含 DISPLACEMENT/WEIGHT OF CARGO。',
    '- 合同扫描件: 条款文本为主, 多为 A4 多页, 常有骑缝章; 含 甲乙方/标的/金额条款。',
    '- 化验报告: 质检指标表格(全水/灰分/挥发分/发热量等)。',
    '- 银行回单: 付款人/收款人/金额/入账日期。',
    '- 无法判断时输出列表中最后一个值。',
    '严格以 JSON 输出: {"formType": "<清单中的一个>", "confidence": 0.0-1.0}',
  ].join('\n');
}

export interface FormClassifyResult {
  formType: string;
  confidence: number;
}

export async function classifyForm(
  input: { page: ClassifyPage; formTypes: string[] },
  deps: { call?: VlmCall } = {},
): Promise<FormClassifyResult> {
  const call = deps.call ?? vlmCall;
  const prompt = buildFormClassifyPrompt(input.formTypes);
  const once = async (p: string): Promise<FormClassifyResult> => {
    const content = await call(p, input.page);
    const parsed = JSON.parse(content) as { formType?: unknown; confidence?: unknown };
    if (typeof parsed.formType !== 'string' || !parsed.formType) throw new Error('VLM 分类输出缺 formType');
    const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0;
    return { formType: parsed.formType, confidence };
  };
  try {
    return await once(prompt);
  } catch (first) {
    const hint = first instanceof Error ? first.message : String(first);
    return once(`${prompt}\n\n上次输出无法使用(${hint})。必须严格输出规定 JSON。`);
  }
}
```

- [ ] **Step 4: 测试通过 + Commit** — `git commit -m "feat(pipeline): vlmClassifier VLM 表单分类器"`

### Task 4: 类型树扩展 — DocType/模板种子/formTypes props

**Files:**
- Modify: `apps/server/src/pipeline/types.ts:4-10`（DocType 联合加 `'重量凭证' | '水尺计重单'`）
- Modify: `apps/server/src/pipeline/templateSeed.ts`（DOC_TYPE_SEED 与 EDGE_RULE_SEED）
- Test: `apps/server/test/pipeline/templateSeed.test.ts`（追加断言）

**Interfaces:**
- Produces: DocType 含 `重量凭证`（中间节点）与 `水尺计重单`；种子 props：`汽运磅单.formTypes=['汽车过磅单票据']`、`轨道衡称重单.formTypes=['轨道衡称重记录']`、`水尺计重单.formTypes=['水尺计重单']`，并为其余凭证类型补 formTypes（合同`['合同扫描件']`、化验报告`['化验报告']`、付款凭证`['银行回单']`、货转单`['货权转移证明']`、结算单`['结算单']`、发票`['发票']`、收货单`['货物交接清单']`、派船通知单`['派船通知单']`、火运大票`['火运大票']`）。

- [ ] **Step 1: 先改测试** — 在 `templateSeed.test.ts` 追加：

```ts
it('v2.1: 重量凭证中间节点收编汽运磅单/轨道衡称重单, 新增水尺计重单', async () => {
  await ensureTemplateSeed(ctx);
  const rows = await listTemplateTypes(ctx);
  const byName = new Map(rows.filter((r) => r.kind === 'doc_type').map((r) => [r.name, r]));
  expect(byName.get('重量凭证')?.parentId).toBe('dt-履约凭证');
  expect(byName.get('汽运磅单')?.parentId).toBe('dt-重量凭证');
  expect(byName.get('轨道衡称重单')?.parentId).toBe('dt-重量凭证');
  expect(byName.get('水尺计重单')?.parentId).toBe('dt-重量凭证');
  expect(byName.get('汽运磅单')?.props.formTypes).toContain('汽车过磅单票据');
  expect(byName.get('水尺计重单')?.props.formTypes).toContain('水尺计重单');
});
```

（变量名 `ctx`/导入以该文件现有写法为准，模仿相邻用例。）

- [ ] **Step 2: 跑测试失败 → Step 3: 修改种子**

types.ts DocType：`| '履约凭证'` 后加 `| '重量凭证'`；`'轨道衡称重单'` 后加 `| '水尺计重单'`。

templateSeed.ts DOC_TYPE_SEED：
- `{ name: '重量凭证', parent: '履约凭证' },` 插在 `履约凭证` 行后。
- `汽运磅单`、`轨道衡称重单` 的 parent 改为 `'重量凭证'`；`汽运磅单` 加 `props: { formTypes: ['汽车过磅单票据'] }`，`轨道衡称重单` 加 `props: { formTypes: ['轨道衡称重记录'] }`。
- 新增 `{ name: '水尺计重单', parent: '重量凭证', props: { formTypes: ['水尺计重单'] } },`。
- 其余类型按 Global Constraints 清单补 `props: { formTypes: [...] }`（已有 props 的合同行把 formTypes 并进现有 props 对象）。
- EDGE_RULE_SEED 追加（登记不启用）：`{ id: 'er-settle-shuichi', src: '水尺计重单', edge: 'settles', vocab: ['收货', '发货'], active: false },` 与 `{ id: 'er-settle-zhongliang', src: '重量凭证', edge: 'settles', vocab: ['收货', '发货'], active: false },`。

- [ ] **Step 4: 全量测试**（防 docTypeAliasMigration / classifierHierarchy 回归）：`npm test --workspace apps/server -- test/pipeline/templateSeed.test.ts test/pipeline/docTypeAliasMigration.test.ts test/pipeline/classifierHierarchy.test.ts`，预期 PASS（若 buildClassifierVocab 的 descendants 因新中间层变化导致细类候选断言失败，更新对应断言——新层进候选是预期行为，与 运输凭证 先例一致）。

- [ ] **Step 5: Commit** — `git commit -m "feat(pipeline): 类型树 v2.1 重量凭证中间节点 + 水尺计重单 + formTypes props"`

### Task 5: 重量凭证 schema 族 — vouchers.ts 扩展

**Files:**
- Modify: `apps/server/src/pipeline/schemas/vouchers.ts`
- Test: `apps/server/test/pipeline/vouchers.test.ts`（追加）

**Interfaces:**
- Produces: `VoucherType` 扩为 `'货转单' | '化验报告' | '付款凭证' | '汽运磅单' | '轨道衡称重单' | '水尺计重单' | '其他'`；`VOUCHER_SCHEMAS` 增三个键；`validateVoucher` 增三组规则；`extractAnchors` 增三支（quantityTon 取聚合总净重）；新增 `WEIGHT_AGGREGATE_DOCTYPES: ReadonlySet<VoucherType>`（三种重量类型，多页聚合模式判定用）。
- Schema（与现有中文键惯例一致，必填 min(1)/数字，可空 nullable().optional()）：

```ts
// ---- 汽运磅单 (一页一车, 文档级由聚合器组装) -------------------------------

export const 汽运磅单行Schema = z.object({
  编号: z.string().nullable().optional(),
  卡号: z.string().nullable().optional(),
  车号: z.string().nullable().optional(),
  毛重_吨: z.number(),
  皮重_吨: z.number(),
  净重_吨: z.number(),
  毛重时间: z.string().nullable().optional(),
  皮重时间: z.string().nullable().optional(),
  称号: z.string().nullable().optional(),
});

export const 汽运磅单Schema = z.object({
  明细行: z.array(汽运磅单行Schema).min(1),
  总净重_吨: z.number(),
  页数: z.number().int().positive(),
  失败页: z.array(z.number().int().positive()),
});

// ---- 轨道衡称重单 (逐车厢行, 可跨多页) --------------------------------------

export const 轨道衡行Schema = z.object({
  车型: z.string().nullable().optional(),
  车号: z.string().nullable().optional(),
  毛重_吨: z.number(),
  皮重_吨: z.number(),
  净重_吨: z.number(),
  票重_吨: z.number().nullable().optional(),
  盈亏_吨: z.number().nullable().optional(),
});

export const 轨道衡称重单Schema = z.object({
  编号: z.string().nullable().optional(),
  称量日期: z.string().nullable().optional(),
  明细行: z.array(轨道衡行Schema).min(1),
  总净重_吨: z.number(),
  页数: z.number().int().positive(),
  失败页: z.array(z.number().int().positive()),
});

// ---- 水尺计重单 (单页表单) ---------------------------------------------------

export const 水尺计重单Schema = z.object({
  船名: z.string().min(1),
  航次: z.string().nullable().optional(),
  泊位: z.string().nullable().optional(),
  货名: z.string().nullable().optional(),
  卸货量_吨: z.number(),
  检测日期: z.string().nullable().optional(),
});
```

- validateVoucher 追加（warnings 风格，不硬失败）：

```ts
if (voucherType === '汽运磅单') {
  const rows = Array.isArray(fields['明细行']) ? fields['明细行'] : [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] as Record<string, unknown> | null;
    const g = r?.['毛重_吨'], t = r?.['皮重_吨'], n = r?.['净重_吨'];
    if (typeof g === 'number' && typeof t === 'number' && typeof n === 'number'
        && Math.abs(g - t - n) > 0.01) {
      warnings.push(`明细行${i + 1} 毛重${g} - 皮重${t} != 净重${n}`);
    }
  }
  const total = fields['总净重_吨'];
  if (typeof total === 'number' && Math.abs(sumRows(rows, '净重_吨') - total) > 0.01) {
    warnings.push(`明细行净重合计与总净重 ${total} 不一致`);
  }
}
if (voucherType === '轨道衡称重单') {
  const rows = Array.isArray(fields['明细行']) ? fields['明细行'] : [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] as Record<string, unknown> | null;
    const g = r?.['毛重_吨'], t = r?.['皮重_吨'], n = r?.['净重_吨'];
    if (typeof g === 'number' && typeof t === 'number' && typeof n === 'number'
        && Math.abs(g - t - n) > 0.01) {
      warnings.push(`第${i + 1}行 毛重${g} - 皮重${t} != 净重${n}`);
    }
    const tp = r?.['票重_吨'], yk = r?.['盈亏_吨'];
    if (typeof n === 'number' && typeof tp === 'number' && typeof yk === 'number'
        && Math.abs(n - tp - yk) > 0.05) {
      warnings.push(`第${i + 1}行 净重${n} - 票重${tp} != 盈亏${yk}`);
    }
  }
  const total = fields['总净重_吨'];
  if (typeof total === 'number' && Math.abs(sumRows(rows, '净重_吨') - total) > 0.01) {
    warnings.push(`明细行净重合计与总净重 ${total} 不一致`);
  }
}
```

- extractAnchors 三支：汽运磅单/轨道衡称重单 `quantityTon = anchorNum(fields['总净重_吨'])`, `date` 取 明细行首行毛重时间/称量日期（无则 undefined）；水尺计重单 `quantityTon = anchorNum(fields['卸货量_吨'])`, `date = 检测日期`。

- [ ] 步骤：先在 `vouchers.test.ts` 追加用例（行校验不一致出 warning、一致无 warning、schema parse 拒绝缺总净重、anchors 投影），确认失败 → 实现 → 通过 → `git commit -m "feat(pipeline): 重量凭证 schema 族(汽运磅单/轨道衡/水尺) + 交叉校验"`。

### Task 6: `vlmAdapter.ts` 泛化 — 多图提取 + 按类型 prompt 注册表

**Files:**
- Modify: `apps/server/src/pipeline/vlmAdapter.ts`
- Modify: `apps/server/src/pipeline/schemas/vouchers.ts`（追加 `VOUCHER_PROMPTS: Record<排除其他, string>`——每类型一段 schema 文本，格式沿用现 VLM_PROMPT 风格）
- Test: `apps/server/test/pipeline/vlmAdapter.test.ts`（追加）

**Interfaces:**
- Produces: `extractVoucherTyped(images: Array<{mime: string; buffer: Buffer}>, docType: 已知凭证类型, opts?: { validate?: (fields) => void }): Promise<{ fields: Record<string, unknown>; 字段置信度: Record<string, number> }>`——类型已由路由确定，prompt 用 `VOUCHER_PROMPTS[docType]` + `已知凭证类型: ${docType}`，不再让模型输出 voucherType；多图一次调用（image_url 数组）；失败回灌重试 1 次沿用。现有 `extractVoucher` 单图路径原样保留（jpg/png 现有流程不变）。
- 重量类逐页模式不走本函数（Task 7 的 pageRecords 每页单独调用本函数、单图、docType 行 schema）——统一复用 `extractVoucherTyped`：重量类传页级行 schema 的 prompt 段（`VOUCHER_PROMPTS['汽运磅单']` 写为"提取这一页过磅票的单车记录行"）。

- [ ] 步骤：测试（fake fetch 断言请求体 messages[0].content 含 N 个 image_url、prompt 含类型名；解析容错同现有）先行 → 实现 → 通过 → commit `feat(pipeline): vlmAdapter 多图按类型提取 extractVoucherTyped`。

### Task 7: `pageRecords.ts` — 逐页提取编排 + 聚合

**Files:**
- Create: `apps/server/src/pipeline/pageRecords.ts`
- Test: `apps/server/test/pipeline/pageRecords.test.ts`

**Interfaces:**
- Consumes: `renderPdfPages`（Task 1）、`extractVoucherTyped`（Task 6，注入 fake）。
- Produces:
  - `extractWeightDoc(pages: RenderedPage[], docType: '汽运磅单'|'轨道衡称重单'|'水尺计重单', opts?: { concurrency?: number; extractOne?: 页级提取注入 }): Promise<WeightDocResult>`；`WeightDocResult = { fields: Record<string, unknown>; warnings: string[]; okPages: number; failedPages: number[] }`。
  - 编排：逐页调 `extractOne({mime,buffer}, docType)`（缺省=extractVoucherTyped 单图），页结果 zod 行校验失败或抛错 → 重试 1 次 → 仍失败记入 failedPages（单页失败不扩散）。
  - 聚合（服务端确定性）：磅单=每 ok 页一行（页级行 schema 同 `汽运磅单行Schema`）；轨道衡=各页 rows 数组拼接；水尺=首个 ok 页整体字段。`总净重_吨 = Σ 行净重`（磅单/轨道衡）；`失败页`/`页数` 落 fields；全部页失败 → throw。
  - `mapLimit<T,R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]>`（保序有界并发，导出供测试）。

- [ ] Step 1 失败测试（fake extractOne：3 页中第 2 页两次都抛错、其余返回行；断言 明细行=2 行、总净重=Σ、失败页=[2]、并发不超限（用计数器+延迟断言峰值≤limit）、水尺取首个 ok 页）→ Step 2 实现 → Step 3 通过 → commit `feat(pipeline): pageRecords 逐页提取编排与总净重聚合`。

### Task 8: 路由集成 — processDocument 的 VLM 门控

**Files:**
- Modify: `apps/server/src/pipeline/tools/documentEntry.ts`（`parseWithOcrRetry` 调用点前后、`runVoucherPipeline`）
- Test: `apps/server/test/pipeline/voucherRouting.test.ts`（新文件，hermetic）

**Interfaces:**
- 修改点 A（`runVoucherPipeline`）：`VoucherIngestInput` 增可选 `pdfVoucher?: { docType: DocType; pages: RenderedPage[] }`——存在时跳过单图读取，走：重量类（`WEIGHT_AGGREGATE_DOCTYPES.has(docType)`）→ `extractWeightDoc` 组装 fields；其余 → `extractVoucherTyped(全部页, docType)`。后续 zod 校验/落库/chunk/绑定路径完全复用（docType 用路由给定的，不用 VLM 自报；分类置信度取 聚合 warnings 为空 ? 0.9 : 0.7）。
- 修改点 B（`processDocument`，OCR 兜底门控）：抽出原 step 3 的"OCR 兜底"为决策点——

```
digital 尝试(现有) -> blocks==0 且是 PDF 时:
  若 VLM 已配置(env 检查) 且可选渲染:
    renderPdfPages 第 1 页 -> classifyForm(formTypes=collectFormTypes(listTemplateTypes(ctx)))
    idx = buildFormTypeIndex(types); route = idx.routeOf(formType)
    route==='voucher' && idx.docTypeOf(formType) 已注册 VOUCHER_SCHEMAS
      -> 走 runVoucherPipeline({pdfVoucher:{docType, pages: 全部页}}), 返回 parsed
    否则(document/unknown/低置信<0.6/分类抛错/渲染抛错) -> 原样 MinerU OCR(现状)
  VLM 未配置 -> 原样 MinerU OCR(现状, 零回归)
```

- 显式 `modality==='scanned'` 的 PDF 同样先过此门控（把"digital 尝试"跳过，直接渲染分类）。
- 所有新分支 try/catch 包裹：任何 VLM 侧异常 console.warn + 回落 OCR——永不劣于现状。
- [ ] Step 1 写 `voucherRouting.test.ts`：注入 fake `vlm.classify`/`vlm.extractTyped`/`extractOne`（VlmDeps 扩展：`classify?`、`extractTyped?`、`extractOne?`，缺省真实实现；测试注入 fake），夹具 PDF（pdf-lib 生成，无文字层）断言：voucher 路由走 fake 提取且 docType=汽运磅单、document 路由落到 MinerU mock（`MINERU_BIN` 注入假脚本输出 `.mineru.json`，沿用 `mineruAdapter.test.ts` 现有 hermetic 模式）、分类抛错回落 OCR、VLM 未配置(env mock)直接 OCR。→ Step 2 实现接线 → Step 3 全测试通过 → commit `feat(pipeline): processDocument VLM 门控路由(voucher/document/回落)`。

### Task 9: 验收 — 评估脚本 + 全量验证 + push

**Files:**
- Create: `apps/server/eval/voucher-acceptance.ts`
- Modify: `apps/server/eval/`（如需登记 run 入口，跟随现有 eval 结构；不强行接入 npm run eval）

- [ ] Step 1: `voucher-acceptance.ts` — 遍历 `example/document-sample`（绝对路径经 env `SAMPLE_ROOT` 可覆盖），对每个文件执行与 processDocument 相同的路由纯函数部分（分类+路由判定；VLM 未配置时结构跳过并提示），输出每类指标表：路由结果、表单类型、（重量类）明细行数/总净重/失败页、耗时。**不依赖 DB**（路由与提取层纯函数直调）。`--extract` 旗标时真实调用 VLM 提取（有 VLM 配置才可用）。
- [ ] Step 2: hermetic 验收跑通（无 VLM env 时脚本打印 "VLM 未配置，跳过提取，仅结构校验" 且退出码 0）。
- [ ] Step 3: 全量验证（repo 根）：`npm run build && npm run lint && npm test`，全绿。
- [ ] Step 4: commit `feat(pipeline): 双分支解析验收脚本`；`git push origin HEAD:PengYip/文档解析`；合入 main：`git fetch origin main && git merge origin/main`（冲突则解决后重跑 build/lint/test）→ `git push origin HEAD:PengYip/文档解析 && git push origin HEAD:main`。

## Self-Review 记录

- 覆盖检查：spec §3 两层类型→T2/T4；§4 路由→T8；§5 组件→T1/T3/T6/T7；§5.1 重量 schema→T5；§5.2 批量约束→T7；§6 防护降级→T8；§7 落库→T8(复用 runVoucherPipeline)；§8 评估→T9；§9 待拍板项已在种子中以默认值落地（水尺挂重量凭证、交接清单→收货单），T9 push 前在 commit message 中注明。无缺口。
- 类型一致性：`RenderedPage`(T1) 被 T7/T8 消费；`extractVoucherTyped`(T6) 被 T7 的 extractOne 缺省实现消费；`WEIGHT_AGGREGATE_DOCTYPES`(T5) 被 T7/T8 消费；`buildFormTypeIndex/collectFormTypes`(T2) 被 T8 消费。
- 占位符扫描：无 TBD；T5/T6/T7 部分步骤为"测试先行→实现→通过"压缩式，代码主体已在计划内给出。
