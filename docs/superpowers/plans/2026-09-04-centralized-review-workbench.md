# 集中复核工作台 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为多页拼版单据（汽运磅单/轨道衡称重单优先）建全页集中复核工作台：container 内按类型分组，明细行摊平成可编辑表格，左原文页右表格行页锚定，置信度驱动批量放行 + 键盘流。

**Architecture:** 后端在 `/api/documents` Hono 路由上新增 3 个端点（workbench 聚合快照 / review-batch 批量确认 / unit-preview page 参数），新增 `documents.review_action` 审计列与 `reviewChecks` 勾稽纯函数模块；前端新增 `#/review?docId=` 全页视图（两栏：原片页 + 虚拟滚动可编辑表格）。确认原子粒度 = 子单据（documents 行），行级"已核"为客户端状态。

**Tech Stack:** Hono + better-sqlite3（默认）/ Postgres+drizzle（pg twin 模式）；React 19 + Tailwind 3.4 + `@tanstack/react-virtual`（唯一新前端依赖）；vitest。

**Spec:** `docs/superpowers/specs/2026-09-04-centralized-review-workbench-design.md`（执行者应同时读 spec 与本计划）

## Global Constraints

- 代码中禁止 emoji（仓库约定）。
- 完成判据顺序：`npm run build` → `npm run lint` → `npm test`（仓库根执行，与 CI 同序）。
- 不新增必填环境变量；`REVIEW_AUTO_RELEASE_THRESHOLD` 可选带默认 0.975。
- DB 双写：SQLite 走 client.ts 幂等裸 DDL；Postgres 同步 `db/schema.ts` + `db/postgres-schema.ts` + client.ts pg DDL 列表 + postgres-repositories.ts pg twin（照抄 `batch_role` 列先例）。
- 服务端单测命令：`npm test --workspace apps/server -- test/<path>.test.ts`；web 测试 `npm test --workspace @sca/web`。
- 后端路由测试必须用 `vi.mock dbBackend` + hoisted ctxHolder 注入 `:memory:` DB 的既有模式（见 `apps/server/test/routes/reviewUnits.test.ts`；routes 模块内 ctx() 是单例，整个测试文件共用一个库）。
- 前端组件无测试基建，验证 = `npm run build --workspace @sca/web`（tsc -b）+ `npm run lint`；纯逻辑放独立模块用 vitest 测（`apps/web/test/*.test.ts` 先例）。
- 提交风格：`feat: ...` 中文摘要可（见 git log 先例），每个 Task 一次提交，只 stage 该 Task 相关文件。

---

### Task 1: 勾稽校验纯函数模块 reviewChecks.ts

**Files:**
- Create: `apps/server/src/pipeline/reviewChecks.ts`
- Test: `apps/server/test/pipeline/reviewChecks.test.ts`

**Interfaces:**
- Produces（Task 4 消费，签名必须一致）:
  - `WORKBENCH_TABLE_DOCTYPES: ReadonlySet<string>`（含 `'汽运磅单' | '轨道衡称重单'`）
  - `checkWeighRow(row: Record<string, string | number | null>, docType: '汽运磅单' | '轨道衡称重单'): RowIssue[]`
  - `checkWeighTotal(rows: Record<string, string | number | null>[], storedTotal: number | null | undefined): TotalCheck`
  - `RowIssue = { rule: string; severity: 'error' | 'warning'; columns: string[]; message: string }`
  - `TotalCheck = { expected: number | null; actual: number | null; tolerance: number; pass: boolean }`
  - 常量 `WEIGHT_TOLERANCE_T = 0.02`、`TOTAL_TOLERANCE_T = 0.05`

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/test/pipeline/reviewChecks.test.ts
import { describe, it, expect } from 'vitest';
import {
  checkWeighRow,
  checkWeighTotal,
  WORKBENCH_TABLE_DOCTYPES,
} from '../../src/pipeline/reviewChecks.js';

describe('checkWeighRow(汽运磅单)', () => {
  const okRow = { 毛重_吨: 40.5, 皮重_吨: 15.2, 净重_吨: 25.3, 页码: 1 };

  it('毛-皮=净 精确成立 -> 无 issue', () => {
    expect(checkWeighRow(okRow, '汽运磅单')).toEqual([]);
  });

  it('进位误差 <= 0.02 -> 通过', () => {
    expect(checkWeighRow({ ...okRow, 净重_吨: 25.29 }, '汽运磅单')).toEqual([]);
  });

  it('偏差 > 0.02 -> gross_minus_tare error 且三列标红', () => {
    const issues = checkWeighRow({ ...okRow, 净重_吨: 24.0 }, '汽运磅单');
    const bad = issues.find((i) => i.rule === 'gross_minus_tare')!;
    expect(bad.severity).toBe('error');
    expect(bad.columns).toEqual(['毛重_吨', '皮重_吨', '净重_吨']);
  });

  it('净重 <= 0 -> net_positive error', () => {
    const issues = checkWeighRow({ 毛重_吨: 40, 皮重_吨: 15, 净重_吨: 0 }, '汽运磅单');
    expect(issues.some((i) => i.rule === 'net_positive' && i.severity === 'error')).toBe(true);
  });

  it('毛/皮/净缺失 -> required_missing warning 且不再数值勾稽', () => {
    const issues = checkWeighRow(
      { 毛重_吨: null, 皮重_吨: 15, 净重_吨: 25, 页码: 3 },
      '汽运磅单',
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]!.rule).toBe('required_missing');
    expect(issues[0]!.severity).toBe('warning');
  });
});

describe('checkWeighRow(轨道衡称重单)', () => {
  it('盈亏 = 票重 - 净重 成立 -> 无 issue', () => {
    const row = { 毛重_吨: 80, 皮重_吨: 20, 净重_吨: 60, 票重_吨: 60.5, 盈亏_吨: 0.5, 页码: 2 };
    expect(checkWeighRow(row, '轨道衡称重单')).toEqual([]);
  });

  it('盈亏方向不符 -> surplus_check error', () => {
    const row = { 毛重_吨: 80, 皮重_吨: 20, 净重_吨: 60, 票重_吨: 60.5, 盈亏_吨: -0.5, 页码: 2 };
    expect(
      checkWeighRow(row, '轨道衡称重单').some((i) => i.rule === 'surplus_check'),
    ).toBe(true);
  });

  it('票重/盈亏缺失 -> 不做 surplus 勾稽(可空字段)', () => {
    expect(checkWeighRow({ 毛重_吨: 80, 皮重_吨: 20, 净重_吨: 60, 页码: 2 }, '轨道衡称重单')).toEqual([]);
  });
});

describe('checkWeighTotal', () => {
  it('Σ净重与存量一致(<=0.05) -> pass', () => {
    const t = checkWeighTotal([{ 净重_吨: 25.3, 页码: 1 }, { 净重_吨: 30.0, 页码: 2 }], 55.32);
    expect(t.pass).toBe(true);
    expect(t.actual).toBe(55.3);
    expect(t.tolerance).toBe(0.05);
  });

  it('编辑后漂移 -> fail', () => {
    expect(
      checkWeighTotal([{ 净重_吨: 25.3, 页码: 1 }, { 净重_吨: 31.0, 页码: 2 }], 55.3).pass,
    ).toBe(false);
  });

  it('无存量总净重 -> 恒 pass(expected=null)', () => {
    expect(checkWeighTotal([{ 净重_吨: 10, 页码: 1 }], null).pass).toBe(true);
  });
});

describe('WORKBENCH_TABLE_DOCTYPES', () => {
  it('含两类 schema 票据, 不含化验报告', () => {
    expect(WORKBENCH_TABLE_DOCTYPES.has('汽运磅单')).toBe(true);
    expect(WORKBENCH_TABLE_DOCTYPES.has('轨道衡称重单')).toBe(true);
    expect(WORKBENCH_TABLE_DOCTYPES.has('化验报告')).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/pipeline/reviewChecks.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// apps/server/src/pipeline/reviewChecks.ts
// 集中复核工作台勾稽校验(spec 2026-09-04 §7.4)。纯函数: workbench 组装与
// releaseEligible 判定共用; 前端 workbenchModel.ts 镜像同规则 —— 改容忍值/
// 规则时两处必须同步(双端无共享包, 以注释互指)。

export type WorkbenchWeighDocType = '汽运磅单' | '轨道衡称重单';

/** 进表格视图(kind='voucher-table')的票据类型。 */
export const WORKBENCH_TABLE_DOCTYPES: ReadonlySet<string> = new Set([
  '汽运磅单',
  '轨道衡称重单',
]);

export interface RowIssue {
  rule: string;
  severity: 'error' | 'warning';
  columns: string[];
  message: string;
}

/** 容忍值(吨)。镜像: apps/web/src/components/review-workbench/workbenchModel.ts */
export const WEIGHT_TOLERANCE_T = 0.02;
export const TOTAL_TOLERANCE_T = 0.05;

const GROSS = '毛重_吨';
const TARE = '皮重_吨';
const NET = '净重_吨';
const TICKET = '票重_吨';
const SURPLUS = '盈亏_吨';

export type WeighCheckRow = Record<string, string | number | null>;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** 行级勾稽: 毛-皮=净(±0.02) / 净重>0 / 轨道衡 盈亏=票重-净重(±0.02)。 */
export function checkWeighRow(
  row: WeighCheckRow,
  docType: WorkbenchWeighDocType,
): RowIssue[] {
  const issues: RowIssue[] = [];
  const gross = row[GROSS];
  const tare = row[TARE];
  const net = row[NET];
  if (typeof gross !== 'number' || typeof tare !== 'number' || typeof net !== 'number') {
    issues.push({
      rule: 'required_missing',
      severity: 'warning',
      columns: [GROSS, TARE, NET],
      message: '毛重/皮重/净重存在缺失, 无法勾稽',
    });
    return issues;
  }
  if (Math.abs(gross - tare - net) > WEIGHT_TOLERANCE_T) {
    issues.push({
      rule: 'gross_minus_tare',
      severity: 'error',
      columns: [GROSS, TARE, NET],
      message: `毛重-皮重=${round2(gross - tare)} 与净重=${net} 不符`,
    });
  }
  if (net <= 0) {
    issues.push({ rule: 'net_positive', severity: 'error', columns: [NET], message: '净重必须大于 0' });
  }
  if (docType === '轨道衡称重单') {
    const ticket = row[TICKET];
    const surplus = row[SURPLUS];
    // 盈亏方向暂定 票重-净重=盈亏(spec §13 开放问题); 真实样本核对后如需
    // 反向只改这一处(与前端镜像同步)。
    if (typeof ticket === 'number' && typeof surplus === 'number') {
      if (Math.abs(ticket - net - surplus) > WEIGHT_TOLERANCE_T) {
        issues.push({
          rule: 'surplus_check',
          severity: 'error',
          columns: [TICKET, NET, SURPLUS],
          message: `票重-净重=${round2(ticket - net)} 与盈亏=${surplus} 不符`,
        });
      }
    }
  }
  return issues;
}

export interface TotalCheck {
  expected: number | null;
  actual: number | null;
  tolerance: number;
  pass: boolean;
}

/** 单据级合计勾稽: Σ行净重 vs 存量总净重_吨(行编辑后漂移由此暴露)。 */
export function checkWeighTotal(
  rows: WeighCheckRow[],
  storedTotal: number | null | undefined,
): TotalCheck {
  let sum = 0;
  for (const r of rows) {
    if (typeof r[NET] === 'number') sum += r[NET] as number;
  }
  const expected = typeof storedTotal === 'number' ? storedTotal : null;
  return {
    expected,
    actual: Math.round(sum * 1000) / 1000,
    tolerance: TOTAL_TOLERANCE_T,
    pass: expected === null ? true : Math.abs(expected - sum) <= TOTAL_TOLERANCE_T,
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test --workspace apps/server -- test/pipeline/reviewChecks.test.ts`
Expected: PASS 全绿

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/pipeline/reviewChecks.ts apps/server/test/pipeline/reviewChecks.test.ts
git commit -m "feat: 集中复核勾稽校验纯函数模块(毛皮净/盈亏/合计)"
```

---

### Task 2: documents.review_action 列 + setReviewOutcome + 单确认写入点

**Files:**
- Modify: `apps/server/src/pipeline/db/client.ts`（SQLite 幂等 DDL ~line 541 `reviewed_by` 之后；pg DDL 列表 ~line 778 `reviewed_by` 之后）
- Modify: `apps/server/src/pipeline/db/schema.ts:29`（`reviewedBy` 之后）
- Modify: `apps/server/src/pipeline/db/postgres-schema.ts:95`（`reviewedBy` 之后）
- Modify: `apps/server/src/pipeline/db/repositories.ts:2387`（`setReviewStatus` 之后新增）
- Modify: `apps/server/src/pipeline/db/postgres-repositories.ts`（pg twin 区新增）
- Modify: `apps/server/src/routes/review.ts:153`（confirm 分支改用 setReviewOutcome）
- Test: `apps/server/test/pipeline/reviewOutcome.test.ts`

**Interfaces:**
- Produces（Task 5 消费）:
  - `type ReviewOutcomeAction = 'manual' | 'auto-release'`
  - `setReviewOutcome(ctx: DbContext, docId: string, status: ReviewStatus, action: ReviewOutcomeAction, userId?: string): Promise<void>`
  - `setReviewOutcomePg(...)`（postgres-repositories.ts 导出，repositories.ts 顶部 pg import 区加名）

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/test/pipeline/reviewOutcome.test.ts
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { Hono } from 'hono';
import type { AuthEnv } from '../../src/lib/auth-middleware.js';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import { createDocumentStub, saveExtraction } from '../../src/pipeline/db/repositories.js';

// 与 reviewUnits.test.ts 同款: 路由模块 ctx() 单例 -> 整文件共用一个内存库。
const { ctxHolder } = vi.hoisted(() => ({
  ctxHolder: { current: null as DbContext | null },
}));
vi.mock('../../src/pipeline/db/dbBackend.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/pipeline/db/dbBackend.js')>();
  return { ...mod, getDbContext: () => ctxHolder.current };
});

const { setReviewOutcome } = await import('../../src/pipeline/db/repositories.js');
const { reviewRoute } = await import('../../src/routes/review.js');

beforeAll(() => {
  const ctx = createDb(':memory:');
  migrate(ctx.sqlite);
  ctxHolder.current = ctx;
});

function rawDoc(docId: string) {
  return ctxHolder.current!.sqlite
    .prepare('SELECT review_status, review_action, reviewed_by FROM documents WHERE id = ?')
    .get(docId) as { review_status: string; review_action: string | null; reviewed_by: string };
}

describe('setReviewOutcome', () => {
  it('同时写 review_status + review_action + 审计字段', async () => {
    const { docId } = await createDocumentStub(ctxHolder.current!, {
      sourceUri: 'file:///a.pdf', userId: 'u1',
    });
    await setReviewOutcome(ctxHolder.current!, docId, 'confirmed', 'auto-release', 'u1');
    const row = rawDoc(docId);
    expect(row.review_status).toBe('confirmed');
    expect(row.review_action).toBe('auto-release');
    expect(row.reviewed_by).toBe('u1');
  });

  it('manual 动作照写', async () => {
    const { docId } = await createDocumentStub(ctxHolder.current!, {
      sourceUri: 'file:///b.pdf', userId: 'u1',
    });
    await setReviewOutcome(ctxHolder.current!, docId, 'confirmed', 'manual', 'u1');
    expect(rawDoc(docId).review_action).toBe('manual');
  });
});

describe('POST /api/documents/:docId/review 单确认写 manual', () => {
  function appAs(userId: string) {
    const app = new Hono<AuthEnv>();
    app.use('*', async (c, next) => {
      c.set('user', { id: userId, email: 't@t', role: 'trader' } as never);
      await next();
    });
    app.route('/api/documents', reviewRoute);
    return app;
  }

  it('confirm:true -> review_action=manual', async () => {
    const { docId } = await createDocumentStub(ctxHolder.current!, {
      sourceUri: 'file:///c.pdf', userId: 'u1',
    });
    await saveExtraction(ctxHolder.current!, {
      documentId: docId, docType: '汽运磅单',
      fields: { 结论: { value: 'ok', sourceSpans: [] } },
      fieldMeta: { 结论: { strength: 'none', confidence: 0.9 } },
      overallConfidence: 0.9, needsReview: false,
    });
    const res = await appAs('u1').request(`/api/documents/${docId}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    expect(res.status).toBe(200);
    expect(rawDoc(docId).review_action).toBe('manual');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/pipeline/reviewOutcome.test.ts`
Expected: FAIL（setReviewOutcome 不存在 / review_action 列不存在）

- [ ] **Step 3: 加 DB 列（4 处）**

client.ts SQLite 幂等 DDL（`reviewed_by` 那行之后）：

```ts
      try { sqlite.exec('ALTER TABLE documents ADD COLUMN review_action TEXT'); } catch { /* concurrent */ }
```

client.ts pg DDL 列表（`reviewed_by timestamptz` 那条之后）：

```ts
  `ALTER TABLE documents ADD COLUMN IF NOT EXISTS review_action TEXT`,
```

db/schema.ts documents 表（`reviewedBy: text('reviewed_by'),` 之后）：

```ts
    reviewAction: text('review_action'),
```

postgres-schema.ts documents 表（`reviewedBy: text('reviewed_by'),` 之后）：

```ts
    reviewAction: text('review_action'),
```

- [ ] **Step 4: 实现 setReviewOutcome 双端**

repositories.ts（setReviewStatus 之后）：

```ts
/** 确认动作类型(集中复核, spec 2026-09-04 §7.5): manual=人工确认,
 *  auto-release=置信度阈值批量放行。写 documents.review_action 审计列。 */
export type ReviewOutcomeAction = 'manual' | 'auto-release';

/** setReviewStatus 的增强版: 连带写 review_action。集中复核批量确认与单文档
 *  确认共用, 保持审计口径一致。 */
export async function setReviewOutcome(
  ctx: DbContext,
  docId: string,
  status: ReviewStatus,
  action: ReviewOutcomeAction,
  userId?: string,
): Promise<void> {
  if (ctx.backend === 'postgres') return setReviewOutcomePg(ctx, docId, status, action, userId);
  ctx.sqlite
    .prepare(
      "UPDATE documents SET review_status = ?, review_action = ?, reviewed_at = datetime('now'), reviewed_by = ? WHERE id = ?",
    )
    .run(status, action, effectiveUserId(userId), docId);
}
```

repositories.ts 顶部 postgres 静态 import 区加 `setReviewOutcomePg`。

postgres-repositories.ts（其他 pg twin 旁；`effectiveUserId` 该文件已在用，无需新 import；`ReviewStatus`/`ReviewOutcomeAction` 若未引入则补 type-only import）：

```ts
import type { ReviewOutcomeAction } from './repositories.js'; // 与现有 type import 并列

/** pg twin of setReviewOutcome: 确认时连写 review_action 审计列。 */
export async function setReviewOutcomePg(
  ctx: PostgresDbContext,
  docId: string,
  status: ReviewStatus,
  action: ReviewOutcomeAction,
  userId?: string,
): Promise<void> {
  await ctx.pool.query(
    'UPDATE documents SET review_status = $1, review_action = $2, reviewed_at = now(), reviewed_by = $3 WHERE id = $4',
    [status, action, effectiveUserId(userId), docId],
  );
}
```

（type-only 循环 import 编译期擦除，运行时安全。）

- [ ] **Step 5: 单确认分支改写**

review.ts confirm 分支（line 153）：

```ts
      await setReviewOutcome(ctx(), docId, 'confirmed', 'manual', user.id);
```

替换原 `await setReviewStatus(ctx(), docId, 'confirmed', user.id);`；顶部 import 把 `setReviewStatus` 换成 `setReviewOutcome`（该文件其他地方不再用 setReviewStatus 则从 import 列表移除）。

- [ ] **Step 6: 跑测试 + 回归**

Run: `npm test --workspace apps/server -- test/pipeline/reviewOutcome.test.ts test/routes/review.test.ts test/routes/reviewUnits.test.ts`
Expected: 全 PASS

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/pipeline/db/client.ts apps/server/src/pipeline/db/schema.ts apps/server/src/pipeline/db/postgres-schema.ts apps/server/src/pipeline/db/repositories.ts apps/server/src/pipeline/db/postgres-repositories.ts apps/server/src/routes/review.ts apps/server/test/pipeline/reviewOutcome.test.ts
git commit -m "feat: documents.review_action 审计列 + setReviewOutcome(manual/auto-release)"
```

---

### Task 3: repo 批量查询层（listLatestExtractionsByDocIds + BatchUnitSummary 增补）

**Files:**
- Modify: `apps/server/src/pipeline/db/repositories.ts`（`BatchUnitSummary` 接口 ~line 429-440；`loadLatestExtractionByDocId` 之后加批量版；`listContainerUnitSummaries` SQLite SQL ~1617-1628 与 `batchUnitSummaryFromRow` mapper 增补）
- Modify: `apps/server/src/pipeline/db/postgres-repositories.ts`（`listLatestExtractionsByDocIdsPg` 新增；`listContainerUnitSummariesPg` SQL 增补 ~line 3280-3302）
- Test: `apps/server/test/pipeline/listLatestExtractionsBatch.test.ts`

**Interfaces:**
- Produces（Task 4 消费）:
  - `listLatestExtractionsByDocIds(ctx: DbContext, docIds: string[], userId?: string): Promise<Map<string, ExtractionRow>>`（key=docId；空输入空 Map；user 过滤口径同 `loadLatestExtractionByDocId`）
  - `BatchUnitSummary` 增补（additive，旧消费方不受影响）：`pageStart: number | null`、`pageEnd: number | null`、`reviewAction: string | null`
  - `ExtractionRow`（已存在）：`{ id, documentId, docType, fields, fieldMeta, overallConfidence, needsReview }`

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/test/pipeline/listLatestExtractionsBatch.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import {
  createDocumentStub,
  saveExtraction,
  setDocumentBatchRole,
  saveDocumentUnits,
  setReviewOutcome,
  listLatestExtractionsByDocIds,
  listContainerUnitSummaries,
} from '../../src/pipeline/db/repositories.js';

let ctx: DbContext;
beforeAll(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
});

describe('listLatestExtractionsByDocIds', () => {
  it('批量取每文档最新一条 extraction', async () => {
    const { docId: d1 } = await createDocumentStub(ctx, { sourceUri: 'file:///1.pdf', userId: 'u1' });
    const { docId: d2 } = await createDocumentStub(ctx, { sourceUri: 'file:///2.pdf', userId: 'u1' });
    await saveExtraction(ctx, {
      documentId: d1, docType: '汽运磅单',
      fields: { 总净重_吨: { value: 10, sourceSpans: [] } },
      fieldMeta: {}, overallConfidence: 0.5, needsReview: true,
    });
    await saveExtraction(ctx, {
      documentId: d1, docType: '汽运磅单',
      fields: { 总净重_吨: { value: 20, sourceSpans: [] } },
      fieldMeta: {}, overallConfidence: 0.9, needsReview: false,
    });
    await saveExtraction(ctx, {
      documentId: d2, docType: '轨道衡称重单',
      fields: { 编号: { value: 'X1', sourceSpans: [] } },
      fieldMeta: {}, overallConfidence: 0.8, needsReview: false,
    });

    const map = await listLatestExtractionsByDocIds(ctx, [d1, d2], 'u1');
    expect(map.size).toBe(2);
    expect(map.get(d1)!.fields['总净重_吨']!.value).toBe(20); // 最新一条
    expect(map.get(d1)!.overallConfidence).toBe(0.9);
    expect(map.get(d2)!.docType).toBe('轨道衡称重单');
  });

  it('无 extraction 的文档不在结果里; 空输入返回空 Map', async () => {
    const { docId: empty } = await createDocumentStub(ctx, { sourceUri: 'file:///3.pdf', userId: 'u1' });
    expect((await listLatestExtractionsByDocIds(ctx, [empty], 'u1')).size).toBe(0);
    expect((await listLatestExtractionsByDocIds(ctx, [], 'u1')).size).toBe(0);
  });

  it('他人文档不可见', async () => {
    const { docId } = await createDocumentStub(ctx, { sourceUri: 'file:///4.pdf', userId: 'u1' });
    await saveExtraction(ctx, {
      documentId: docId, docType: '汽运磅单',
      fields: {}, fieldMeta: {}, overallConfidence: 0.1, needsReview: false,
    });
    expect((await listLatestExtractionsByDocIds(ctx, [docId], 'u2')).size).toBe(0);
  });
});

describe('listContainerUnitSummaries 增补字段', () => {
  it('带 pageStart/pageEnd/reviewAction(additive)', async () => {
    const { docId: child } = await createDocumentStub(ctx, { sourceUri: 'file:///c.pdf', userId: 'u1' });
    await setDocumentBatchRole(ctx, child, 'unit');
    const { docId: container } = await createDocumentStub(ctx, { sourceUri: 'file:///p.pdf', userId: 'u1' });
    await setDocumentBatchRole(ctx, container, 'container');
    const bbox = { x: 0, y: 0, w: 1, h: 1 };
    await saveDocumentUnits(ctx, [{
      parentDocumentId: container, childDocumentId: child, unitIndex: 1,
      docType: '汽运磅单', pageStart: 3, pageEnd: 5, rotationDeg: 0,
      bboxJson: JSON.stringify(bbox),
      manifest: { regions: [{ page: 3, bbox, rotationDeg: 0 }, { page: 5, bbox, rotationDeg: 0 }] },
    }]);
    await setReviewOutcome(ctx, child, 'confirmed', 'auto-release', 'u1');
    const units = await listContainerUnitSummaries(ctx, container);
    expect(units[0]!.pageStart).toBe(3);
    expect(units[0]!.pageEnd).toBe(5);
    expect(units[0]!.reviewAction).toBe('auto-release');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/pipeline/listLatestExtractionsBatch.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

repositories.ts — `BatchUnitSummary` 接口尾部（`needsReview: boolean;` 之后）：

```ts
  /** 集中复核工作台增补(spec 2026-09-04): unit 页区间与确认动作(可空,
   *  additive, 旧消费方不受影响)。 */
  pageStart: number | null;
  pageEnd: number | null;
  reviewAction: string | null;
```

`listContainerUnitSummaries` SQLite SQL 的 SELECT 列表加 `u.page_start, u.page_end, d.review_action`；`batchUnitSummaryFromRow` mapper（grep 定位）加：

```ts
    pageStart: row.page_start == null ? null : Number(row.page_start),
    pageEnd: row.page_end == null ? null : Number(row.page_end),
    reviewAction: row.review_action == null ? null : String(row.review_action),
```

`loadLatestExtractionByDocId` 之后新增：

```ts
/**
 * 批量版 loadLatestExtractionByDocId(集中复核工作台): 一次 IN 查询取每个
 * 文档的最新 extraction。user 过滤口径与单文档版一致(uid 非空才过滤,
 * user_id=''/NULL 老数据对任何调用方可见)。返回 Map<docId, ExtractionRow>。
 */
export async function listLatestExtractionsByDocIds(
  ctx: DbContext,
  docIds: string[],
  userId?: string,
): Promise<Map<string, ExtractionRow>> {
  if (ctx.backend === 'postgres') return listLatestExtractionsByDocIdsPg(ctx, docIds, userId);
  const ids = [...new Set(docIds.filter(Boolean))];
  const out = new Map<string, ExtractionRow>();
  if (ids.length === 0) return out;
  const uid = effectiveUserId(userId);
  const placeholders = ids.map(() => '?').join(', ');
  const newest = '(SELECT MAX(e2.rowid) FROM extractions e2 WHERE e2.document_id = e.document_id)';
  const base = `SELECT e.id, e.document_id, e.doc_type, e.fields, e.field_meta,
                       e.overall_confidence, e.needs_review
                FROM extractions e
                WHERE e.document_id IN (${placeholders}) AND e.rowid = ${newest}`;
  const sql = uid
    ? `${base} AND (e.user_id = ? OR e.user_id = '' OR e.user_id IS NULL)`
    : base;
  const rows = (uid
    ? ctx.sqlite.prepare(sql).all(...ids, uid)
    : ctx.sqlite.prepare(sql).all(...ids)) as Array<Record<string, unknown>>;
  for (const r of rows) {
    out.set(String(r.document_id), {
      id: String(r.id),
      documentId: String(r.document_id),
      docType: String(r.doc_type) as DocType,
      fields: JSON.parse(String(r.fields)),
      fieldMeta: JSON.parse(String(r.field_meta)),
      overallConfidence: Number(r.overall_confidence ?? 0),
      needsReview: !!r.needs_review,
    });
  }
  return out;
}
```

postgres-repositories.ts — `listContainerUnitSummariesPg` 的 SELECT 同样加 `u.page_start, u.page_end, d.review_action`（mapper `batchUnitSummaryFromRow` 共享，SQLite 侧改完即生效）；文件内新增：

```ts
/** pg twin of listLatestExtractionsByDocIds: DISTINCT ON 取每文档最新一条。 */
export async function listLatestExtractionsByDocIdsPg(
  ctx: PostgresDbContext,
  docIds: string[],
  userId?: string,
): Promise<Map<string, ExtractionRow>> {
  const ids = [...new Set(docIds.filter(Boolean))];
  const out = new Map<string, ExtractionRow>();
  if (ids.length === 0) return out;
  const uid = effectiveUserId(userId);
  const params: string[] = uid ? [uid] : [];
  const placeholders = ids.map((_, i) => `$${i + params.length + 1}`).join(', ');
  const userFilter = uid ? "AND (e.user_id = $1 OR e.user_id = '' OR e.user_id IS NULL)" : '';
  const res = await ctx.pool.query(
    `SELECT DISTINCT ON (e.document_id) e.id, e.document_id, e.doc_type, e.fields, e.field_meta,
            e.overall_confidence, e.needs_review
     FROM extractions e
     WHERE e.document_id IN (${placeholders}) ${userFilter}
     ORDER BY e.document_id, e.created_at DESC`,
    [...params, ...ids],
  );
  for (const r of res.rows as Array<Record<string, unknown>>) {
    out.set(String(r.document_id), {
      id: String(r.id),
      documentId: String(r.document_id),
      docType: String(r.doc_type) as DocType,
      fields: JSON.parse(String(r.fields)),
      fieldMeta: JSON.parse(String(r.field_meta)),
      overallConfidence: Number(r.overall_confidence ?? 0),
      needsReview: !!r.needs_review,
    });
  }
  return out;
}
```

（`ExtractionRow`/`DocType` type import 与该文件现有引用一致；repositories.ts 顶部 pg import 区加 `listLatestExtractionsByDocIdsPg`。）

- [ ] **Step 4: 跑测试 + 回归**

Run: `npm test --workspace apps/server -- test/pipeline/listLatestExtractionsBatch.test.ts test/routes/reviewUnits.test.ts`
Expected: 全 PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/pipeline/db/repositories.ts apps/server/src/pipeline/db/postgres-repositories.ts apps/server/test/pipeline/listLatestExtractionsBatch.test.ts
git commit -m "feat: 批量最新抽取查询 + unit 摘要页区间/确认动作增补(集中复核数据层)"
```

---

### Task 4: GET /:docId/review-workbench 聚合端点 + 放行阈值 env

**Files:**
- Modify: `apps/server/src/env.ts`（EnvSchema 末尾）
- Modify: `apps/server/src/routes/review.ts`（顶部 import + 文件尾部路由）
- Test: `apps/server/test/routes/reviewWorkbench.test.ts`

**Interfaces:**
- Consumes: Task 1 `checkWeighRow/checkWeighTotal/WORKBENCH_TABLE_DOCTYPES/RowIssue/TotalCheck`；Task 3 `listLatestExtractionsByDocIds` + 增补后 `listContainerUnitSummaries`
- Produces（前端 Task 7 API client 镜像此响应）: `200 { ok: true, data: { containerDocId, containerTitle, groups: Array<{ docType, kind: 'voucher-table'|'unit-list', units: WorkbenchUnitOut[] }> } }`，其中 WorkbenchUnitOut 含 `docId/title/unitIndex/reviewStatus/reviewAction/overallConfidence/needsReview/warnings/pageStart/pageEnd/releaseEligible/rows?/rowChecks?/totals?/totalCheck?`

- [ ] **Step 1: env 阈值项**

env.ts EnvSchema 末尾（`BATCH_SPLIT_MAX_PAGES` 之后）：

```ts
  // 集中复核工作台(spec 2026-09-04 §7.6): 一键放行的置信度阈值。
  // 语义 = 目标准确率(对齐 Rossum 默认 0.975); 只影响 releaseEligible 计算。
  REVIEW_AUTO_RELEASE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.975),
```

- [ ] **Step 2: 写失败测试**

```ts
// apps/server/test/routes/reviewWorkbench.test.ts
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { Hono } from 'hono';
import type { AuthEnv } from '../../src/lib/auth-middleware.js';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import {
  createDocumentStub,
  setDocumentBatchRole,
  saveDocumentUnits,
  saveExtraction,
} from '../../src/pipeline/db/repositories.js';

const { ctxHolder } = vi.hoisted(() => ({ ctxHolder: { current: null as DbContext | null } }));
vi.mock('../../src/pipeline/db/dbBackend.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/pipeline/db/dbBackend.js')>();
  return { ...mod, getDbContext: () => ctxHolder.current };
});

const { reviewRoute } = await import('../../src/routes/review.js');

beforeAll(() => {
  const ctx = createDb(':memory:');
  migrate(ctx.sqlite);
  ctxHolder.current = ctx;
});

function appAs(userId: string) {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { id: userId, email: 't@t', role: 'trader' } as never);
    await next();
  });
  app.route('/api/documents', reviewRoute);
  return app;
}

/** 混合 container: u1 汽运磅单(高置信全过) + u2 汽运磅单(needsReview+勾稽error)
 *  + u3 化验报告(unit-list 组)。 */
async function seedMixed(userId: string): Promise<string> {
  const src = 'file:///mixed.pdf';
  const mk = async (role: 'unit' | 'container') => {
    const { docId } = await createDocumentStub(ctxHolder.current!, { sourceUri: src, userId });
    await setDocumentBatchRole(ctxHolder.current!, docId, role);
    return docId;
  };
  const [u1, u2, u3, container] = [await mk('unit'), await mk('unit'), await mk('unit'), await mk('container')];
  await saveDocumentUnits(ctxHolder.current!, [
    { parentDocumentId: container, childDocumentId: u1, unitIndex: 1, docType: '汽运磅单', pageStart: 1, pageEnd: 2 },
    { parentDocumentId: container, childDocumentId: u2, unitIndex: 2, docType: '汽运磅单', pageStart: 3, pageEnd: 3 },
    { parentDocumentId: container, childDocumentId: u3, unitIndex: 3, docType: '化验报告', pageStart: 4, pageEnd: 4 },
  ]);
  const rowsOk = [
    { 编号: 'A1', 车号: '皖A111', 毛重_吨: 40.5, 皮重_吨: 15.2, 净重_吨: 25.3, 页码: 1 },
    { 编号: 'A2', 车号: '皖A222', 毛重_吨: 35.1, 皮重_吨: 12.0, 净重_吨: 23.1, 页码: 2 },
  ];
  const rowsBad = [
    { 编号: 'B1', 车号: '皖B333', 毛重_吨: 30.0, 皮重_吨: 10.0, 净重_吨: 18.0, 页码: 3 },
  ];
  await saveExtraction(ctxHolder.current!, {
    documentId: u1, docType: '汽运磅单',
    fields: {
      明细行: { value: JSON.stringify(rowsOk), sourceSpans: [] },
      总净重_吨: { value: 48.4, sourceSpans: [] },
      页数: { value: 2, sourceSpans: [] },
      失败页: { value: '[]', sourceSpans: [] },
    },
    fieldMeta: {}, overallConfidence: 0.99, needsReview: false,
  });
  await saveExtraction(ctxHolder.current!, {
    documentId: u2, docType: '汽运磅单',
    fields: {
      明细行: { value: JSON.stringify(rowsBad), sourceSpans: [] },
      总净重_吨: { value: 18.0, sourceSpans: [] },
      页数: { value: 1, sourceSpans: [] },
      失败页: { value: '[]', sourceSpans: [] },
    },
    fieldMeta: { _warnings: ['两遍读数分歧'] } as never,
    overallConfidence: 0.6, needsReview: true,
  });
  await saveExtraction(ctxHolder.current!, {
    documentId: u3, docType: '化验报告',
    fields: { 结论: { value: '合格', sourceSpans: [] } },
    fieldMeta: {}, overallConfidence: 0.9, needsReview: false,
  });
  return container;
}

describe('GET /api/documents/:docId/review-workbench', () => {
  it('混合类型: 分组/摊平/勾稽/releaseEligible', async () => {
    const docId = await seedMixed('u1');
    const res = await appAs('u1').request(`/api/documents/${docId}/review-workbench`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      data: {
        containerTitle: string;
        groups: Array<{
          docType: string;
          kind: string;
          units: Array<{
            docId: string; releaseEligible: boolean;
            rows?: Array<Record<string, unknown>>;
            rowChecks?: Array<{ issues: Array<{ rule: string; severity: string }> }>;
            totalCheck?: { pass: boolean };
          }>;
        }>;
      };
    };
    expect(body.ok).toBe(true);
    expect(body.data.containerTitle).toBe('mixed.pdf');
    const wb = body.data.groups.find((g) => g.docType === '汽运磅单')!;
    expect(wb.kind).toBe('voucher-table');
    expect(wb.units).toHaveLength(2);
    const [hi, lo] = wb.units;
    expect(hi!.rows).toHaveLength(2);
    expect(hi!.rows![0]!.页码).toBe(1);
    expect(hi!.rowChecks![0]!.issues).toEqual([]);
    expect(hi!.releaseEligible).toBe(true);
    expect(hi!.totalCheck!.pass).toBe(true);
    expect(lo!.releaseEligible).toBe(false);
    expect(
      lo!.rowChecks![0]!.issues.some((i) => i.rule === 'gross_minus_tare' && i.severity === 'error'),
    ).toBe(true);
    const q = body.data.groups.find((g) => g.docType === '化验报告')!;
    expect(q.kind).toBe('unit-list');
    expect(q.units[0]!.rows).toBeUndefined();
  });

  it('非 container / 他人文档 / 不存在 -> 404', async () => {
    const container = await seedMixed('u1');
    const { docId: plain } = await createDocumentStub(ctxHolder.current!, {
      sourceUri: 'file:///x.pdf', userId: 'u1',
    });
    expect((await appAs('u1').request(`/api/documents/${plain}/review-workbench`)).status).toBe(404);
    expect((await appAs('u2').request(`/api/documents/${container}/review-workbench`)).status).toBe(404);
    expect((await appAs('u1').request('/api/documents/DOC-nope/review-workbench')).status).toBe(404);
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/routes/reviewWorkbench.test.ts`
Expected: FAIL（路由不存在 404）

- [ ] **Step 4: 实现路由**

review.ts 顶部 import 增补（`listLatestExtractionsByDocIds` 并入 repositories import 块）：

```ts
import {
  checkWeighRow,
  checkWeighTotal,
  WORKBENCH_TABLE_DOCTYPES,
  type RowIssue,
  type TotalCheck,
} from '../pipeline/reviewChecks.js';
import { env } from '../env.js';
```

文件尾部：

```ts
// ---- 集中复核工作台(spec 2026-09-04) ---------------------------------------

interface WorkbenchUnitOut {
  docId: string;
  title: string;
  unitIndex: number;
  reviewStatus: 'pending' | 'confirmed' | 'corrected' | null;
  reviewAction: 'manual' | 'auto-release' | null;
  overallConfidence: number;
  needsReview: boolean;
  warnings: string[];
  pageStart: number | null;
  pageEnd: number | null;
  releaseEligible: boolean;
  rows?: Array<Record<string, string | number | null>>;
  rowChecks?: Array<{ issues: RowIssue[] }>;
  totals?: { 总净重_吨?: number | null; 页数?: number | null; 失败页?: number[] };
  totalCheck?: TotalCheck;
}

/** fields['明细行'] 是 JSON 字符串(表格型字段存储格式); 解析失败按无行处理。 */
function parseDetailRows(
  fields: Record<string, { value: string | number }>,
): Array<Record<string, string | number | null>> {
  const f = fields['明细行'];
  if (!f) return [];
  try {
    const parsed = typeof f.value === 'string' ? JSON.parse(f.value) : f.value;
    return Array.isArray(parsed) ? (parsed as Array<Record<string, string | number | null>>) : [];
  } catch {
    return [];
  }
}

function parseNumberField(
  fields: Record<string, { value: string | number }>,
  name: string,
): number | null {
  const v = fields[name]?.value;
  return typeof v === 'number' ? v : null;
}

/**
 * GET /api/documents/:docId/review-workbench
 *
 * 集中复核工作台聚合快照: container 子单据按类型分组; WORKBENCH_TABLE_DOCTYPES
 * 组摊平明细行为 rows(带页码) + 服务端勾稽 rowChecks, 其余类型给 unit 摘要。
 * releaseEligible 服务端计算: overall_confidence >= 阈值 且 !needs_review 且
 * 无 _warnings 且全行无 error 级 issue 且 reviewStatus='pending'。
 *
 * Responses:
 *   200 { ok: true, data: ReviewWorkbenchResponse }
 *   401 / 404(非 container/他人/不存在) / 500
 */
reviewRoute.get('/:docId/review-workbench', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const docId = c.req.param('docId');
  try {
    const roles = await getBatchRolesForDocuments(ctx(), [docId], user.id);
    if (roles.get(docId)?.batchRole !== 'container') {
      return c.json({ ok: false, error: 'document_or_extraction_not_found' }, 404);
    }
    const units = await listContainerUnitSummaries(ctx(), docId);
    const childIds = units.map((u) => u.docId).filter((d): d is string => !!d);
    const extractions = await listLatestExtractionsByDocIds(ctx(), childIds, user.id);
    const sourceUri = await getDocumentSourceUri(ctx(), docId, user.id);
    const containerTitle = sourceUri
      ? (sourceUri.split(/[\\/]/).filter(Boolean).pop() ?? sourceUri)
      : docId;

    const groupOrder: string[] = [];
    const groupsByType = new Map<string, WorkbenchUnitOut[]>();
    for (const u of units) {
      const docType = u.childDocType ?? u.detectedFormType ?? '未分类';
      if (!groupsByType.has(docType)) {
        groupsByType.set(docType, []);
        groupOrder.push(docType);
      }
      const ex = u.docId ? (extractions.get(u.docId) ?? null) : null;
      // field_meta 顶层 _warnings(getReviewSnapshot 同源口径): 老数据/无抽取恒 []。
      const metaWarnings = (ex?.fieldMeta as Record<string, unknown> | undefined)?.['_warnings'];
      const warnings = Array.isArray(metaWarnings)
        ? metaWarnings.filter((w): w is string => typeof w === 'string')
        : [];

      const unitOut: WorkbenchUnitOut = {
        docId: u.docId ?? '',
        title: `第 ${u.unitIndex} 份`,
        unitIndex: u.unitIndex,
        reviewStatus: u.reviewStatus,
        reviewAction: (u.reviewAction as 'manual' | 'auto-release' | null) ?? null,
        overallConfidence: ex ? ex.overallConfidence : 0,
        needsReview: ex ? ex.needsReview : true,
        warnings,
        pageStart: u.pageStart,
        pageEnd: u.pageEnd,
        releaseEligible: false,
      };

      let noErrorRows = true;
      if (ex && WORKBENCH_TABLE_DOCTYPES.has(docType)) {
        const rows = parseDetailRows(ex.fields);
        const failedRaw = ex.fields['失败页']?.value;
        let failedPages: number[] = [];
        try {
          const p = typeof failedRaw === 'string' ? JSON.parse(failedRaw) : failedRaw;
          if (Array.isArray(p)) failedPages = p.filter((n): n is number => typeof n === 'number');
        } catch { /* 损坏按无失败页 */ }
        const weighType = docType === '轨道衡称重单' ? '轨道衡称重单' as const : '汽运磅单' as const;
        const rowChecks = rows.map((r) => {
          const issues = checkWeighRow(r, weighType);
          if (issues.some((i) => i.severity === 'error')) noErrorRows = false;
          return { issues };
        });
        unitOut.rows = rows;
        unitOut.rowChecks = rowChecks;
        unitOut.totals = {
          总净重_吨: parseNumberField(ex.fields, '总净重_吨'),
          页数: parseNumberField(ex.fields, '页数'),
          失败页: failedPages,
        };
        unitOut.totalCheck = checkWeighTotal(rows, unitOut.totals.总净重_吨);
        if (!unitOut.totalCheck.pass) noErrorRows = false;
      }

      unitOut.releaseEligible =
        u.reviewStatus === 'pending' &&
        ex !== null &&
        ex.overallConfidence >= env.REVIEW_AUTO_RELEASE_THRESHOLD &&
        !ex.needsReview &&
        warnings.length === 0 &&
        noErrorRows;
      groupsByType.get(docType)!.push(unitOut);
    }

    return c.json({
      ok: true,
      data: {
        containerDocId: docId,
        containerTitle,
        groups: groupOrder.map((docType) => ({
          docType,
          kind: WORKBENCH_TABLE_DOCTYPES.has(docType)
            ? ('voucher-table' as const)
            : ('unit-list' as const),
          units: groupsByType.get(docType)!,
        })),
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[review] workbench fetch failed:', msg);
    return c.json({ ok: false, error: msg }, 500);
  }
});
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npm test --workspace apps/server -- test/routes/reviewWorkbench.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/env.ts apps/server/src/routes/review.ts apps/server/test/routes/reviewWorkbench.test.ts
git commit -m "feat: GET /api/documents/:docId/review-workbench 集中复核聚合端点"
```

---

### Task 5: containerLock 抽取 + POST /:docId/review-batch

**Files:**
- Create: `apps/server/src/lib/containerLock.ts`
- Modify: `apps/server/src/routes/batch.ts:59-87`（删本地实现改 import；`withContainerParamLock` 中间件保留）
- Modify: `apps/server/src/routes/review.ts`（顶部 requireRole 注册区 + 尾部新路由）
- Test: `apps/server/test/routes/reviewBatch.test.ts`

**Interfaces:**
- Consumes: Task 2 `setReviewOutcome`；batch.ts 现有 `withContainerLock` 实现（本任务抽到共享模块）
- Produces:
  - `withContainerLock<T>(docId: string, fn: () => Promise<T>): Promise<T>`（lib/containerLock.ts 导出，batch.ts 与 review.ts 共用）
  - `POST /api/documents/:docId/review-batch`：请求 `{ actions: Array<{ docId: string; confirm: true; action: 'manual' | 'auto-release' }> }`，响应 `{ ok: true, results: Array<{ docId: string; ok: boolean; error?: string }> }`

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/test/routes/reviewBatch.test.ts
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { Hono } from 'hono';
import type { AuthEnv } from '../../src/lib/auth-middleware.js';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import {
  createDocumentStub,
  setDocumentBatchRole,
  saveDocumentUnits,
} from '../../src/pipeline/db/repositories.js';

const { ctxHolder } = vi.hoisted(() => ({ ctxHolder: { current: null as DbContext | null } }));
vi.mock('../../src/pipeline/db/dbBackend.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/pipeline/db/dbBackend.js')>();
  return { ...mod, getDbContext: () => ctxHolder.current };
});

const { reviewRoute } = await import('../../src/routes/review.js');

beforeAll(() => {
  const ctx = createDb(':memory:');
  migrate(ctx.sqlite);
  ctxHolder.current = ctx;
});

function appAs(userId: string, role = 'trader') {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { id: userId, email: 't@t', role } as never);
    await next();
  });
  app.route('/api/documents', reviewRoute);
  return app;
}

function rawStatus(docId: string) {
  return ctxHolder.current!.sqlite
    .prepare('SELECT review_status, review_action FROM documents WHERE id = ?')
    .get(docId) as { review_status: string; review_action: string | null } | undefined;
}

async function seedContainer(userId: string): Promise<{ container: string; children: string[] }> {
  const src = 'file:///batch.pdf';
  const mk = async (role: 'unit' | 'container') => {
    const { docId } = await createDocumentStub(ctxHolder.current!, { sourceUri: src, userId });
    await setDocumentBatchRole(ctxHolder.current!, docId, role);
    return docId;
  };
  const [c1, c2, container] = [await mk('unit'), await mk('unit'), await mk('container')];
  await saveDocumentUnits(ctxHolder.current!, [
    { parentDocumentId: container, childDocumentId: c1, unitIndex: 1, docType: '汽运磅单' },
    { parentDocumentId: container, childDocumentId: c2, unitIndex: 2, docType: '汽运磅单' },
  ]);
  return { container, children: [c1, c2] };
}

function post(app: ReturnType<typeof appAs>, url: string, body: unknown) {
  return app.request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/documents/:docId/review-batch', () => {
  it('批量确认: 逐单据写 confirmed + review_action', async () => {
    const { container, children } = await seedContainer('u1');
    const res = await post(appAs('u1'), `/api/documents/${container}/review-batch`, {
      actions: [
        { docId: children[0], confirm: true, action: 'manual' },
        { docId: children[1], confirm: true, action: 'auto-release' },
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; results: Array<{ docId: string; ok: boolean }> };
    expect(body.ok).toBe(true);
    expect(body.results.every((r) => r.ok)).toBe(true);
    expect(rawStatus(children[0]!)).toEqual({ review_status: 'confirmed', review_action: 'manual' });
    expect(rawStatus(children[1]!)).toEqual({ review_status: 'confirmed', review_action: 'auto-release' });
  });

  it('非本 container 的 docId -> 该条失败, 其余成功(部分失败不回滚)', async () => {
    const { container, children } = await seedContainer('u1');
    const foreign = await seedContainer('u2');
    const res = await post(appAs('u1'), `/api/documents/${container}/review-batch`, {
      actions: [
        { docId: children[0]!, confirm: true, action: 'manual' },
        { docId: foreign.children[0]!, confirm: true, action: 'manual' },
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: Array<{ docId: string; ok: boolean; error?: string }> };
    expect(body.results.find((r) => r.docId === children[0])!.ok).toBe(true);
    const bad = body.results.find((r) => r.docId === foreign.children[0])!;
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('不属于');
    expect(rawStatus(children[0]!)!.review_status).toBe('confirmed');
  });

  it('幂等: 重复确认已 confirmed 的单据 -> ok', async () => {
    const { container, children } = await seedContainer('u1');
    const first = await post(appAs('u1'), `/api/documents/${container}/review-batch`, {
      actions: [{ docId: children[0], confirm: true, action: 'manual' }],
    });
    expect(first.status).toBe(200);
    const second = await post(appAs('u1'), `/api/documents/${container}/review-batch`, {
      actions: [{ docId: children[0], confirm: true, action: 'manual' }],
    });
    expect(second.status).toBe(200);
    expect(((await second.json()) as { results: Array<{ ok: boolean }> }).results[0]!.ok).toBe(true);
  });

  it('参数校验: 空 actions / 非法 action -> 400', async () => {
    const { container } = await seedContainer('u1');
    expect(
      (await post(appAs('u1'), `/api/documents/${container}/review-batch`, { actions: [] })).status,
    ).toBe(400);
    expect(
      (await post(appAs('u1'), `/api/documents/${container}/review-batch`, {
        actions: [{ docId: 'DOC-x', confirm: true, action: 'weird' }],
      })).status,
    ).toBe(400);
  });

  it('非 container -> 404; 他人 -> 404; viewer 角色 -> 403', async () => {
    const { container } = await seedContainer('u1');
    const { docId: plain } = await createDocumentStub(ctxHolder.current!, {
      sourceUri: 'file:///p.pdf', userId: 'u1',
    });
    const one = [{ docId: 'DOC-x', confirm: true, action: 'manual' }];
    expect((await post(appAs('u1'), `/api/documents/${plain}/review-batch`, { actions: one })).status).toBe(404);
    expect((await post(appAs('u2'), `/api/documents/${container}/review-batch`, { actions: one })).status).toBe(404);
    expect((await post(appAs('u1', 'viewer'), `/api/documents/${container}/review-batch`, { actions: one })).status).toBe(403);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/routes/reviewBatch.test.ts`
Expected: FAIL（路由不存在 404）

- [ ] **Step 3: 抽取 containerLock**

```ts
// apps/server/src/lib/containerLock.ts
// Per-container async mutex(batch.ts 原实现抽出共享, 集中复核 2026-09-04)。
// 单 Node 进程内串行化同一单据组的谱系/复核改写; 长耗时模型工作刻意在
// DB 事务之外, 路由变更至少按 container 串行避免交错覆写。
const containerLocks = new Map<string, Promise<unknown>>();

export async function withContainerLock<T>(docId: string, fn: () => Promise<T>): Promise<T> {
  const previous = containerLocks.get(docId) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(fn);
  // Map 里保留 ignored 分支: 单条失败不留 unhandled rejection, 后来者照常排队。
  const queued = run.catch(() => undefined);
  containerLocks.set(docId, queued);
  try {
    return await run;
  } finally {
    if (containerLocks.get(docId) === queued) containerLocks.delete(docId);
  }
}
```

batch.ts：删除本地 `containerLocks` + `withContainerLock`（line 64-80），顶部加 `import { withContainerLock } from '../lib/containerLock.js';`（`withContainerParamLock` 中间件不动）。

- [ ] **Step 4: 实现 review-batch 路由**

review.ts 顶部 requireRole 注册区（line 48-49 旁）加：

```ts
reviewRoute.post('/:docId/review-batch', requireRole('admin', 'trader'));
```

import 增补：`setReviewOutcome` 并入 repositories import 块；`import { withContainerLock } from '../lib/containerLock.js';`。文件尾部：

```ts
/**
 * POST /api/documents/:docId/review-batch
 *
 * 集中复核批量确认(spec 2026-09-04 §7.3): 整体包 withContainerLock, 逐单据
 * setReviewOutcome + commitDocumentGraph(per-doc 故障隔离, 图失败只告警不
 * 阻断)。部分失败不回滚 —— 逐条返回 ok/error, 前端标红重试(confirm 幂等)。
 * 只允许确认本 container 的子单据, 跨容器 docId 逐条拒绝。
 *
 * Request:  { actions: Array<{ docId, confirm: true, action: 'manual'|'auto-release' }> }
 * Responses:
 *   200 { ok: true, results: Array<{ docId, ok, error? }> }
 *   400 { ok: false, error }   空/畸形 actions
 *   401 / 403(requireRole) / 404(非 container/他人) / 500
 */
reviewRoute.post('/:docId/review-batch', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const containerDocId = c.req.param('docId');

  let body: { actions?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'invalid JSON body' }, 400);
  }
  const actionsRaw = Array.isArray(body.actions) ? body.actions : null;
  if (!actionsRaw || actionsRaw.length === 0) {
    return c.json({ ok: false, error: 'actions 不能为空' }, 400);
  }
  const actions: Array<{ docId: string; action: 'manual' | 'auto-release' }> = [];
  for (const item of actionsRaw) {
    if (!item || typeof item !== 'object') {
      return c.json({ ok: false, error: 'actions[] 条目必须是 { docId, confirm: true, action } 对象' }, 400);
    }
    const obj = item as Record<string, unknown>;
    if (obj.confirm !== true || typeof obj.docId !== 'string' || obj.docId.length === 0) {
      return c.json({ ok: false, error: 'actions[] 条目必须是 { docId, confirm: true, action } 对象' }, 400);
    }
    if (obj.action !== 'manual' && obj.action !== 'auto-release') {
      return c.json({ ok: false, error: "action 必须是 'manual' 或 'auto-release'" }, 400);
    }
    actions.push({ docId: obj.docId, action: obj.action });
  }

  try {
    const roles = await getBatchRolesForDocuments(ctx(), [containerDocId], user.id);
    if (roles.get(containerDocId)?.batchRole !== 'container') {
      return c.json({ ok: false, error: 'document_or_extraction_not_found' }, 404);
    }
    const units = await listContainerUnitSummaries(ctx(), containerDocId);
    const childIds = new Set(units.map((u) => u.docId).filter((d): d is string => !!d));

    const results = await withContainerLock(containerDocId, async () => {
      const out: Array<{ docId: string; ok: boolean; error?: string }> = [];
      for (const a of actions) {
        if (!childIds.has(a.docId)) {
          out.push({ docId: a.docId, ok: false, error: '不属于该单据组' });
          continue;
        }
        try {
          await setReviewOutcome(ctx(), a.docId, 'confirmed', a.action, user.id);
          // 图提交 per-doc 故障隔离: 失败只告警, 不影响确认状态与整批。
          try {
            await commitDocumentGraph(ctx(), a.docId, user.id);
          } catch (ge) {
            console.warn(
              '[review-batch] 图提交失败(不影响确认):', a.docId,
              ge instanceof Error ? ge.message : String(ge),
            );
          }
          out.push({ docId: a.docId, ok: true });
        } catch (e) {
          out.push({ docId: a.docId, ok: false, error: e instanceof Error ? e.message : String(e) });
        }
      }
      return out;
    });
    return c.json({ ok: true, results });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[review] review-batch failed:', msg);
    return c.json({ ok: false, error: msg }, 500);
  }
});
```

- [ ] **Step 5: 跑测试 + batch 回归**

Run: `npm test --workspace apps/server -- test/routes/reviewBatch.test.ts test/routes/batch.test.ts`
Expected: 全 PASS（抽锁重构无回归）

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/lib/containerLock.ts apps/server/src/routes/batch.ts apps/server/src/routes/review.ts apps/server/test/routes/reviewBatch.test.ts
git commit -m "feat: review-batch 批量确认端点 + containerLock 抽取共享"
```

---

### Task 6: unit-preview 可选 page 参数（单页裁切）

**Files:**
- Modify: `apps/server/src/routes/review.ts:277-315`（unit-preview handler）
- Test: `apps/server/test/routes/reviewUnitPreviewPage.test.ts`

**Interfaces:**
- Produces: `GET /api/documents/:docId/unit-preview?page=N` —— N 在 unit 页区间内返回单页裁切旋正 PNG；无参数行为不变（整 unit 纵拼）；N 越界/非正整数 → 400。LRU 键加 page 维度。

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/test/routes/reviewUnitPreviewPage.test.ts
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PDFDocument } from 'pdf-lib';
import { Hono } from 'hono';
import type { AuthEnv } from '../../src/lib/auth-middleware.js';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import {
  createDocumentStub,
  setDocumentBatchRole,
  saveDocumentUnits,
} from '../../src/pipeline/db/repositories.js';
import { buildPng } from '../pipeline/fixtures/png.js';

const { ctxHolder } = vi.hoisted(() => ({ ctxHolder: { current: null as DbContext | null } }));
vi.mock('../../src/pipeline/db/dbBackend.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/pipeline/db/dbBackend.js')>();
  return { ...mod, getDbContext: () => ctxHolder.current };
});

const { reviewRoute } = await import('../../src/routes/review.js');

beforeAll(() => {
  const ctx = createDb(':memory:');
  migrate(ctx.sqlite);
  ctxHolder.current = ctx;
});

let dir = '';
const CONTENT_PNG = buildPng(64, 64, (_x, y) => (y < 32 ? [0, 0, 0, 255] : [255, 255, 255, 255]));

async function makeTwoPagePdf(path: string): Promise<void> {
  const pdf = await PDFDocument.create();
  const img = await pdf.embedPng(CONTENT_PNG);
  for (let p = 0; p < 2; p++) {
    const page = pdf.addPage([200, 280]);
    page.drawImage(img, { x: 0, y: 0, width: 200, height: 280 });
  }
  writeFileSync(path, await pdf.save());
}

function appAs(userId: string) {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { id: userId, email: 't@t', role: 'trader' } as never);
    await next();
  });
  app.route('/api/documents', reviewRoute);
  return app;
}

/** 跨页 unit: manifest regions 覆盖页 1 和页 2。 */
async function seedTwoPageUnit(): Promise<string> {
  const pdfPath = join(dir, `pv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.pdf`);
  await makeTwoPagePdf(pdfPath);
  const { docId: container } = await createDocumentStub(ctxHolder.current!, { sourceUri: pdfPath, userId: 'u1' });
  const { docId: child } = await createDocumentStub(ctxHolder.current!, { sourceUri: pdfPath, userId: 'u1' });
  await setDocumentBatchRole(ctxHolder.current!, child, 'unit');
  const bbox = { x: 0.05, y: 0.05, w: 0.9, h: 0.9 };
  await saveDocumentUnits(ctxHolder.current!, [{
    parentDocumentId: container, childDocumentId: child, unitIndex: 1,
    docType: '汽运磅单', pageStart: 1, pageEnd: 2, rotationDeg: 0,
    bboxJson: JSON.stringify(bbox),
    manifest: {
      regions: [
        { page: 1, bbox, rotationDeg: 0 },
        { page: 2, bbox, rotationDeg: 0 },
      ],
    },
  }]);
  return child;
}

describe('GET /api/documents/:docId/unit-preview?page=N', () => {
  beforeEach(() => {
    dir = join(tmpdir(), `unitpvpage-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(dir, { recursive: true });
  });

  it('page=2 -> 200 单页 PNG', async () => {
    const child = await seedTwoPageUnit();
    const res = await appAs('u1').request(`/api/documents/${child}/unit-preview?page=2`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.length).toBeGreaterThan(0);
    expect(buf[0]).toBe(0x89);
  });

  it('page=3(越界) -> 400 中文原因', async () => {
    const child = await seedTwoPageUnit();
    const res = await appAs('u1').request(`/api/documents/${child}/unit-preview?page=3`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('不在');
  });

  it('page=abc -> 400', async () => {
    const child = await seedTwoPageUnit();
    expect((await appAs('u1').request(`/api/documents/${child}/unit-preview?page=abc`)).status).toBe(400);
  });

  it('无参数 -> 兼容旧整 unit 拼接行为', async () => {
    const child = await seedTwoPageUnit();
    const res = await appAs('u1').request(`/api/documents/${child}/unit-preview`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/routes/reviewUnitPreviewPage.test.ts`
Expected: FAIL（page=2 404；越界不是 400）

- [ ] **Step 3: 实现**

review.ts unit-preview handler：在 `const docId = c.req.param('docId');` 之后插入参数解析：

```ts
    // 集中复核工作台(spec 2026-09-04 §7.2): 可选 page 参数只裁该页(行->页
    // 锚定的原文视图)。非法/越界 -> 400(与 404 的"单据不存在"区分)。
    const pageParam = c.req.query('page');
    let page: number | null = null;
    if (pageParam !== undefined) {
      const n = Number(pageParam);
      if (!Number.isInteger(n) || n < 1) {
        return c.json({ ok: false, error: 'page 参数必须是正整数' }, 400);
      }
      page = n;
    }
```

渲染段替换（从 `const rotations = effectiveRotationsOf(unit);` 到 `return c.body(...)` 一段）：

```ts
    const rotations = effectiveRotationsOf(unit);
    const cacheKey = `${docId}:${rotations.join(',')}:${page ?? 'all'}`;
    const cached = previewCacheGet(cacheKey);
    if (cached) {
      return c.body(new Uint8Array(cached), 200, { 'Content-Type': 'image/png' });
    }
    const pages = await renderPdfPages(sourceUri, { first: unit.pageEnd ?? unit.pageStart ?? 1 });
    const detected = unitFromStoredRow(unit);
    let png: Buffer;
    if (page !== null) {
      // 单页视图: regions 与 rotations 按 manifest 顺序一一对应, 过滤到目标页。
      const idx = detected.regions.findIndex((r) => r.page === page);
      if (idx === -1) {
        return c.json({ ok: false, error: `页 ${page} 不在该单元页区间` }, 400);
      }
      const images = await renderUnitImages(
        pages,
        { ...detected, regions: [detected.regions[idx]!] },
        [rotations[idx] ?? 0],
      );
      png = images[0]!.buffer;
    } else {
      const images = await renderUnitImages(pages, detected, rotations);
      png = await stackImagesVertically(images);
    }
    previewCacheSet(cacheKey, png);
    return c.body(new Uint8Array(png), 200, { 'Content-Type': 'image/png' });
```

- [ ] **Step 4: 跑测试 + 旧预览回归**

Run: `npm test --workspace apps/server -- test/routes/reviewUnitPreviewPage.test.ts test/routes/reviewUnits.test.ts`
Expected: 全 PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes/review.ts apps/server/test/routes/reviewUnitPreviewPage.test.ts
git commit -m "feat: unit-preview 支持 page 参数单页裁切(集中复核行->页锚定)"
```

---

### Task 7: 前端路由注册 + API client + 工作台骨架

**Files:**
- Modify: `apps/web/src/components/shell/navigation.ts`
- Modify: `apps/web/src/App.tsx`（view 链加 review 分支）
- Create: `apps/web/src/api/reviewWorkbench.ts`
- Create: `apps/web/src/components/review-workbench/ReviewWorkbench.tsx`
- Create: `apps/web/src/components/review-workbench/UnitListGroup.tsx`

**Interfaces:**
- Consumes: Task 4 响应类型（镜像）；既有 `requestOpenReview`（`apps/web/src/lib/reviewModal.ts`）
- Produces（Task 8/9/10 消费）:
  - `api/reviewWorkbench.ts` 导出：`WorkbenchRowIssue` / `WorkbenchRow` / `WorkbenchUnit` / `WorkbenchGroup` / `WorkbenchData` / `ReviewBatchAction` / `ReviewBatchResult` / `fetchReviewWorkbench` / `submitReviewBatch` / `submitRowCorrections` / `unitPreviewPageUrl`
  - `ReviewWorkbench` 组件 props：`{ docId?: string }`

- [ ] **Step 1: navigation.ts**

ViewId 联合加 `'review'`；lucide import 加 `ClipboardCheck`；NAV_ITEMS `work` 组（bindings 条目之后）加：

```ts
  { id: 'review', label: '集中复核', description: '多页票据表格化批量核对', icon: ClipboardCheck, group: 'work', enabled: true },
```

（必须 `enabled: true`：`isRoutableView` 只放行 enabled 视图，否则 `#/review?docId=` 回退 chat。无 docId 时组件渲染空态引导。）

- [ ] **Step 2: api/reviewWorkbench.ts**

```ts
// apps/web/src/api/reviewWorkbench.ts
// 集中复核工作台 API client(spec 2026-09-04)。类型镜像服务端
// routes/review.ts 的 workbench 响应; envelope 解析与 api/review.ts 同款。
import { submitReview } from './review';

export interface WorkbenchRowIssue {
  rule: string;
  severity: 'error' | 'warning';
  columns: string[];
  message: string;
}

export type WorkbenchRow = Record<string, string | number | null>;

export interface WorkbenchUnit {
  docId: string;
  title: string;
  unitIndex: number;
  reviewStatus: 'pending' | 'confirmed' | 'corrected' | null;
  reviewAction: 'manual' | 'auto-release' | null;
  overallConfidence: number;
  needsReview: boolean;
  warnings: string[];
  pageStart: number | null;
  pageEnd: number | null;
  releaseEligible: boolean;
  rows?: WorkbenchRow[];
  rowChecks?: Array<{ issues: WorkbenchRowIssue[] }>;
  totals?: { 总净重_吨?: number | null; 页数?: number | null; 失败页?: number[] };
  totalCheck?: { expected: number | null; actual: number | null; tolerance: number; pass: boolean };
}

export interface WorkbenchGroup {
  docType: string;
  kind: 'voucher-table' | 'unit-list';
  units: WorkbenchUnit[];
}

export interface WorkbenchData {
  containerDocId: string;
  containerTitle: string;
  groups: WorkbenchGroup[];
}

export async function fetchReviewWorkbench(docId: string): Promise<WorkbenchData> {
  let res: Response;
  try {
    res = await fetch(`/api/documents/${encodeURIComponent(docId)}/review-workbench`, {
      method: 'GET',
      credentials: 'include',
    });
  } catch {
    throw new Error('网络错误，请稍后重试');
  }
  if (!res.ok) throw new Error(`请求失败（${res.status}）`);
  const body = (await res.json()) as { ok: boolean; data?: WorkbenchData; error?: string };
  if (!body || body.ok !== true || !body.data) throw new Error(body.error || '响应格式异常');
  return body.data;
}

export interface ReviewBatchAction {
  docId: string;
  confirm: true;
  action: 'manual' | 'auto-release';
}

export interface ReviewBatchResult {
  docId: string;
  ok: boolean;
  error?: string;
}

export async function submitReviewBatch(
  containerDocId: string,
  actions: ReviewBatchAction[],
): Promise<ReviewBatchResult[]> {
  let res: Response;
  try {
    res = await fetch(`/api/documents/${encodeURIComponent(containerDocId)}/review-batch`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actions }),
    });
  } catch {
    throw new Error('网络错误，请稍后重试');
  }
  if (!res.ok) throw new Error(`请求失败（${res.status}）`);
  const body = (await res.json()) as { ok: boolean; results?: ReviewBatchResult[]; error?: string };
  if (!body || body.ok !== true || !Array.isArray(body.results)) {
    throw new Error(body.error || '响应格式异常');
  }
  return body.results;
}

/** 行级编辑提交: 组装整个明细行数组走既有 corrections 契约(整字段 JSON 替换)。 */
export async function submitRowCorrections(docId: string, rows: WorkbenchRow[]): Promise<void> {
  await submitReview(docId, {
    corrections: [{ name: '明细行', value: JSON.stringify(rows) }],
  });
}

/** unit 原片 URL: page 省略 = 整 unit 纵拼(Task 6 单页裁切)。 */
export function unitPreviewPageUrl(docId: string, page?: number): string {
  const q = page != null ? `?page=${encodeURIComponent(page)}` : '';
  return `/api/documents/${encodeURIComponent(docId)}/unit-preview${q}`;
}
```

- [ ] **Step 3: UnitListGroup.tsx（非 schema 类型组）**

```tsx
// apps/web/src/components/review-workbench/UnitListGroup.tsx
// 非 schema 类型组(质检报告/化验报告等): 列表 + 打开既有单据复核卡。
// 工作台是统一入口, 不强改无行结构的类型(设计 2026-09-04 §6)。
import clsx from 'clsx';
import { FileText } from 'lucide-react';
import { requestOpenReview } from '../../lib/reviewModal';
import type { WorkbenchUnit } from '../../api/reviewWorkbench';

export function unitListBadge(u: WorkbenchUnit): { label: string; className: string } {
  if (u.reviewStatus === 'confirmed') {
    return {
      label: u.reviewAction === 'auto-release' ? '已放行' : '已确认',
      className: 'bg-success/10 text-success',
    };
  }
  if (u.reviewStatus === 'corrected') return { label: '已修改', className: 'bg-primary/10 text-primary' };
  return { label: '待复核', className: 'bg-warning/10 text-warning' };
}

export function UnitListGroup({ units }: { units: WorkbenchUnit[] }) {
  return (
    <div className="divide-y divide-line/40">
      {units.map((u) => {
        const badge = unitListBadge(u);
        return (
          <div key={u.docId || u.unitIndex} className="flex items-center gap-3 px-4 py-3 text-sm">
            <FileText className="h-4 w-4 shrink-0 text-ink-soft" aria-hidden />
            <span className="shrink-0 font-medium text-ink">{u.title}</span>
            <span className="min-w-0 flex-1 truncate text-xs text-ink-soft">
              {u.needsReview ? '建议人工复核' : `置信度 ${u.overallConfidence.toFixed(2)}`}
              {u.warnings.length > 0 ? ` · ${u.warnings[0]}` : ''}
            </span>
            <span className={clsx('shrink-0 rounded px-1.5 py-px text-[10px]', badge.className)}>
              {badge.label}
            </span>
            {u.docId && (
              <button
                type="button"
                onClick={() => requestOpenReview(u.docId)}
                className="shrink-0 cursor-pointer rounded px-2 py-px text-xs font-medium text-primary transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
              >
                复核
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: ReviewWorkbench.tsx 骨架**

本 Task 立骨架（拉取/分组 chips/进度/空态/错误态/两栏布局占位）；VoucherTable 与 OriginalPane 由 Task 8/9 填充。

```tsx
// apps/web/src/components/review-workbench/ReviewWorkbench.tsx
// 全页集中复核工作台(spec 2026-09-04): 左原文页 + 右类型分组可编辑表格。
// Task 7 骨架; Task 8 表格 / Task 9 原文栏 / Task 10 键盘流与批量操作。
import { useCallback, useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import { RotateCw } from 'lucide-react';
import { fetchReviewWorkbench, type WorkbenchData } from '../../api/reviewWorkbench';
import { UnitListGroup } from './UnitListGroup';

export function ReviewWorkbench({ docId }: { docId?: string }) {
  const [data, setData] = useState<WorkbenchData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeGroup, setActiveGroup] = useState(0);

  const load = useCallback(async (id: string) => {
    setLoading(true);
    setError(null);
    try {
      const d = await fetchReviewWorkbench(id);
      setData(d);
      const idx = d.groups.findIndex((g) => g.kind === 'voucher-table');
      setActiveGroup(idx >= 0 ? idx : 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (docId) void load(docId);
    else setData(null);
  }, [docId, load]);

  const progress = useMemo(() => {
    const units = data?.groups.flatMap((g) => g.units) ?? [];
    const pending = units.filter(
      (u) => u.reviewStatus === 'pending' || u.reviewStatus === 'corrected',
    ).length;
    const released = units.filter((u) => u.reviewAction === 'auto-release').length;
    const confirmed = units.filter(
      (u) => u.reviewStatus === 'confirmed' && u.reviewAction !== 'auto-release',
    ).length;
    return { total: units.length, pending, released, confirmed };
  }, [data]);

  if (!docId) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-10 text-sm text-ink-soft">
        <span>请从文件面板选择一个单据组，点击「集中复核」进入</span>
      </div>
    );
  }
  if (loading && !data) {
    return <div className="p-10 text-center text-sm text-ink-soft">加载中...</div>;
  }
  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-10 text-sm">
        <span className="text-danger">{error}</span>
        <button
          type="button"
          onClick={() => void load(docId)}
          className="inline-flex cursor-pointer items-center gap-1 rounded border border-line px-3 py-1.5 text-xs text-ink transition-colors hover:bg-surface"
        >
          <RotateCw className="h-3.5 w-3.5" aria-hidden />
          重试
        </button>
      </div>
    );
  }
  if (!data) return null;

  const group = data.groups[activeGroup];

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 顶栏: 标题 + 分组 chips + 进度(批量操作按钮 Task 10 加) */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
        <span className="max-w-[280px] truncate text-sm font-semibold text-ink" title={data.containerTitle}>
          {data.containerTitle}
        </span>
        <div className="flex flex-wrap items-center gap-1">
          {data.groups.map((g, i) => (
            <button
              key={g.docType}
              type="button"
              onClick={() => setActiveGroup(i)}
              className={clsx(
                'cursor-pointer whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary',
                i === activeGroup
                  ? 'border-primary bg-primary/10 font-medium text-primary'
                  : 'border-line bg-surface text-ink-soft hover:border-ink-soft/40 hover:text-ink',
              )}
            >
              {g.docType} {g.units.length}
            </button>
          ))}
        </div>
        <span className="ml-auto whitespace-nowrap text-xs text-ink-soft">
          待复核 {progress.pending} / 已放行 {progress.released} / 已确认 {progress.confirmed} / 共 {progress.total}
        </span>
      </div>

      {/* 两栏主体: 左原文(Task 9) + 右表格(Task 8) */}
      <div className="flex min-h-0 flex-1">
        <div className="hidden w-[38%] shrink-0 border-r border-line lg:block" data-original-pane>
          {/* Task 9: OriginalPane */}
        </div>
        <div className="min-w-0 flex-1" data-voucher-table>
          {group?.kind === 'unit-list' ? (
            <div className="h-full overflow-auto">
              <UnitListGroup units={group.units} />
            </div>
          ) : group ? (
            <div className="flex h-full items-center justify-center p-6 text-center text-sm text-ink-soft">
              {/* Task 8: VoucherTable */}
              {group.units.reduce((s, u) => s + (u.rows?.length ?? 0), 0)} 行明细，表格组件待接入
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export default ReviewWorkbench;
```

- [ ] **Step 5: App.tsx 接线**

顶部 import 加 `import { ReviewWorkbench } from './components/review-workbench/ReviewWorkbench';`；view 链（line 288-322，`view === 'audit'` 分支之后、`: null}` 之前）插入：

```tsx
      ) : view === 'review' ? (
        <ReviewWorkbench docId={route.params.docId} />
```

- [ ] **Step 6: 构建与 lint 验证**

Run: `npm run build --workspace @sca/web`
Expected: tsc + vite 构建通过
Run: `npm run lint`
Expected: oxlint 通过

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/shell/navigation.ts apps/web/src/App.tsx apps/web/src/api/reviewWorkbench.ts apps/web/src/components/review-workbench/ReviewWorkbench.tsx apps/web/src/components/review-workbench/UnitListGroup.tsx
git commit -m "feat(web): 集中复核工作台骨架(路由/分组/进度/空态)"
```

---

### Task 8: VoucherTable 可编辑表格（虚拟滚动 + 三色 + 勾选 + 行内编辑）

**Files:**
- Modify: `apps/web/package.json`（dependencies 加 `@tanstack/react-virtual`）
- Create: `apps/web/src/components/review-workbench/workbenchModel.ts`
- Create: `apps/web/src/components/review-workbench/UnitGroupHeader.tsx`
- Create: `apps/web/src/components/review-workbench/VoucherTable.tsx`
- Modify: `apps/web/src/components/review-workbench/ReviewWorkbench.tsx`（占位替换为 VoucherTable + 编辑状态）
- Test: `apps/web/test/workbenchModel.test.ts`

**Interfaces:**
- Consumes: Task 7 `WorkbenchRow/WorkbenchUnit/WorkbenchRowIssue/submitRowCorrections`
- Produces（Task 9/10 消费）:
  - `workbenchModel.ts` 导出：`TABLE_COLUMNS: Record<'汽运磅单' | '轨道衡称重单', string[]>`、`checkRow(row, docType): WorkbenchRowIssue[]`（服务端镜像）、`checkTotal(rows, storedTotal): { pass: boolean; expected: number | null; actual: number | null }`、`cellTone(issues, column): 'error' | 'warning' | null`、`isUnitConfirmable(unit, resolvedCount, rowCount): boolean`、type `WorkbenchTableDocType`
  - `VoucherTable` props：

```ts
{
  docType: WorkbenchTableDocType;
  units: WorkbenchUnit[];
  checkedRows: Set<string>;                 // key `${docId}#${rowIndex}`
  editedDocs: Set<string>;                  // 有成功更正提交的 docId
  onToggleRow: (key: string) => void;
  rowEdits: Record<string, WorkbenchRow[]>; // docId -> 编辑中的明细行数组
  onCellCommit: (unit: WorkbenchUnit, rowIndex: number, column: string, raw: string) => void;
  selected: { docId: string; rowIndex: number } | null;
  onSelect: (sel: { docId: string; rowIndex: number }) => void;
}
```

- [ ] **Step 1: 装依赖**

Run: `npm install @tanstack/react-virtual@^3.13.12 --workspace @sca/web`
Expected: package.json 出现依赖且安装成功

- [ ] **Step 2: 写纯逻辑失败测试**

```ts
// apps/web/test/workbenchModel.test.ts
import { describe, it, expect } from 'vitest';
import {
  checkRow,
  checkTotal,
  cellTone,
  isUnitConfirmable,
  TABLE_COLUMNS,
} from '../src/components/review-workbench/workbenchModel';
import type { WorkbenchUnit } from '../src/api/reviewWorkbench';

describe('checkRow(镜像 reviewChecks)', () => {
  it('毛皮净勾稽失败 -> error 标红三列', () => {
    const issues = checkRow({ 毛重_吨: 40, 皮重_吨: 15, 净重_吨: 24 }, '汽运磅单');
    expect(cellTone(issues, '净重_吨')).toBe('error');
    expect(cellTone(issues, '车号')).toBeNull();
  });

  it('缺失 -> warning', () => {
    const issues = checkRow({ 毛重_吨: null, 皮重_吨: 1, 净重_吨: 1 }, '汽运磅单');
    expect(cellTone(issues, '毛重_吨')).toBe('warning');
  });
});

describe('checkTotal(编辑后合计漂移)', () => {
  it('改行后与存量总净重不符 -> fail', () => {
    const t = checkTotal([{ 净重_吨: 25.3 }, { 净重_吨: 31 }], 55.3);
    expect(t.pass).toBe(false);
    expect(t.actual).toBe(56.3);
  });
});

describe('isUnitConfirmable', () => {
  const unit = { reviewStatus: 'pending', rows: [{}, {}, {}] } as unknown as WorkbenchUnit;

  it('全部行已核 -> 可确认', () => {
    expect(isUnitConfirmable(unit, 3, 3)).toBe(true);
  });
  it('行未核完 -> 不可确认', () => {
    expect(isUnitConfirmable(unit, 2, 3)).toBe(false);
  });
  it('已 confirmed -> 不可重复确认', () => {
    const done = { ...unit, reviewStatus: 'confirmed' } as WorkbenchUnit;
    expect(isUnitConfirmable(done, 3, 3)).toBe(false);
  });
  it('corrected 状态仍可确认(改完再确认)', () => {
    const edited = { ...unit, reviewStatus: 'corrected' } as WorkbenchUnit;
    expect(isUnitConfirmable(edited, 3, 3)).toBe(true);
  });
  it('无行单据 -> 恒不可确认', () => {
    const empty = { reviewStatus: 'pending', rows: [] } as unknown as WorkbenchUnit;
    expect(isUnitConfirmable(empty, 0, 0)).toBe(false);
  });
});

describe('TABLE_COLUMNS', () => {
  it('两类票种列定义与 schema 行字段一致', () => {
    expect(TABLE_COLUMNS['汽运磅单']).toContain('净重_吨');
    expect(TABLE_COLUMNS['轨道衡称重单']).toContain('盈亏_吨');
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npm test --workspace @sca/web -- test/workbenchModel.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 4: 实现 workbenchModel.ts**

```ts
// apps/web/src/components/review-workbench/workbenchModel.ts
// 集中复核客户端纯逻辑: 勾稽镜像(行编辑后即时反馈) + 可确认判定。
// 镜像声明: 规则与容忍值同 apps/server/src/pipeline/reviewChecks.ts,
// 改一处必须同步另一处(双端无共享包)。
import type { WorkbenchRow, WorkbenchRowIssue, WorkbenchUnit } from '../../api/reviewWorkbench';

export type WorkbenchTableDocType = '汽运磅单' | '轨道衡称重单';

export const TABLE_COLUMNS: Record<WorkbenchTableDocType, string[]> = {
  汽运磅单: ['编号', '卡号', '车号', '毛重_吨', '皮重_吨', '净重_吨', '毛重时间', '皮重时间', '称号'],
  轨道衡称重单: ['车型', '车号', '毛重_吨', '皮重_吨', '净重_吨', '票重_吨', '盈亏_吨'],
};

const WEIGHT_TOLERANCE_T = 0.02; // 镜像 reviewChecks.WEIGHT_TOLERANCE_T
const TOTAL_TOLERANCE_T = 0.05; // 镜像 reviewChecks.TOTAL_TOLERANCE_T

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** 行勾稽(服务端 checkWeighRow 镜像)。 */
export function checkRow(row: WorkbenchRow, docType: WorkbenchTableDocType): WorkbenchRowIssue[] {
  const issues: WorkbenchRowIssue[] = [];
  const gross = row['毛重_吨'];
  const tare = row['皮重_吨'];
  const net = row['净重_吨'];
  if (typeof gross !== 'number' || typeof tare !== 'number' || typeof net !== 'number') {
    issues.push({
      rule: 'required_missing',
      severity: 'warning',
      columns: ['毛重_吨', '皮重_吨', '净重_吨'],
      message: '毛重/皮重/净重存在缺失, 无法勾稽',
    });
    return issues;
  }
  if (Math.abs(gross - tare - net) > WEIGHT_TOLERANCE_T) {
    issues.push({
      rule: 'gross_minus_tare',
      severity: 'error',
      columns: ['毛重_吨', '皮重_吨', '净重_吨'],
      message: `毛重-皮重=${round2(gross - tare)} 与净重=${net} 不符`,
    });
  }
  if (net <= 0) {
    issues.push({ rule: 'net_positive', severity: 'error', columns: ['净重_吨'], message: '净重必须大于 0' });
  }
  if (docType === '轨道衡称重单') {
    const ticket = row['票重_吨'];
    const surplus = row['盈亏_吨'];
    if (typeof ticket === 'number' && typeof surplus === 'number') {
      if (Math.abs(ticket - net - surplus) > WEIGHT_TOLERANCE_T) {
        issues.push({
          rule: 'surplus_check',
          severity: 'error',
          columns: ['票重_吨', '净重_吨', '盈亏_吨'],
          message: `票重-净重=${round2(ticket - net)} 与盈亏=${surplus} 不符`,
        });
      }
    }
  }
  return issues;
}

/** 合计勾稽(服务端 checkWeighTotal 镜像)。 */
export function checkTotal(
  rows: WorkbenchRow[],
  storedTotal: number | null | undefined,
): { pass: boolean; expected: number | null; actual: number | null } {
  let sum = 0;
  for (const r of rows) {
    if (typeof r['净重_吨'] === 'number') sum += r['净重_吨'] as number;
  }
  const expected = typeof storedTotal === 'number' ? storedTotal : null;
  return {
    expected,
    actual: Math.round(sum * 1000) / 1000,
    pass: expected === null ? true : Math.abs(expected - sum) <= TOTAL_TOLERANCE_T,
  };
}

/** 单元格三色: error=红(勾稽失败), warning=黄(缺失), null=正常。 */
export function cellTone(issues: WorkbenchRowIssue[], column: string): 'error' | 'warning' | null {
  if (issues.some((i) => i.severity === 'error' && i.columns.includes(column))) return 'error';
  if (issues.some((i) => i.severity === 'warning' && i.columns.includes(column))) return 'warning';
  return null;
}

/** 可确认判定: pending/corrected 且行数>0 且全部行已核(checked/edited)。 */
export function isUnitConfirmable(
  unit: Pick<WorkbenchUnit, 'reviewStatus'> & { rows?: WorkbenchRow[] },
  resolvedCount: number,
  rowCount: number,
): boolean {
  if (unit.reviewStatus !== 'pending' && unit.reviewStatus !== 'corrected') return false;
  if (rowCount === 0) return false;
  return resolvedCount >= rowCount;
}
```

- [ ] **Step 5: 跑纯逻辑测试通过**

Run: `npm test --workspace @sca/web -- test/workbenchModel.test.ts`
Expected: PASS

- [ ] **Step 6: UnitGroupHeader.tsx**

```tsx
// apps/web/src/components/review-workbench/UnitGroupHeader.tsx
// unit 分组分隔行: 单据级信息(标题/页区间/状态徽标/置信度/合计勾稽/失败页)。
import clsx from 'clsx';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import type { WorkbenchRow, WorkbenchUnit } from '../../api/reviewWorkbench';
import { checkTotal, type WorkbenchTableDocType } from './workbenchModel';

export function statusBadge(u: WorkbenchUnit): { label: string; className: string } {
  if (u.reviewStatus === 'confirmed') {
    return u.reviewAction === 'auto-release'
      ? { label: '已放行', className: 'bg-success/10 text-success' }
      : { label: '已确认', className: 'bg-success/10 text-success' };
  }
  if (u.reviewStatus === 'corrected') return { label: '已修改待确认', className: 'bg-primary/10 text-primary' };
  return { label: '待复核', className: 'bg-warning/10 text-warning' };
}

export function UnitGroupHeader({
  unit,
  docType,
  currentRows,
  confirmable,
}: {
  unit: WorkbenchUnit;
  docType: WorkbenchTableDocType;
  /** 编辑中的行(与服务端 totals 漂移时客户端重算合计)。 */
  currentRows?: WorkbenchRow[];
  confirmable: boolean;
}) {
  void docType;
  const badge = statusBadge(unit);
  const rows = currentRows ?? unit.rows ?? [];
  const total = checkTotal(rows, unit.totals?.总净重_吨 ?? null);
  const pageRange =
    unit.pageStart != null && unit.pageEnd != null
      ? unit.pageStart === unit.pageEnd
        ? `第 ${unit.pageStart} 页`
        : `第 ${unit.pageStart}-${unit.pageEnd} 页`
      : '';
  return (
    <div className="flex flex-wrap items-center gap-2 border-y border-line/60 bg-surface/60 px-3 py-1.5 text-xs">
      <span className="font-semibold text-ink">{unit.title}</span>
      {pageRange && <span className="text-ink-soft">{pageRange}</span>}
      <span className={clsx('rounded px-1.5 py-px', badge.className)}>{badge.label}</span>
      <span className="text-ink-soft">置信度 {unit.overallConfidence.toFixed(2)}</span>
      {unit.totals?.总净重_吨 != null && (
        <span className={clsx(total.pass ? 'text-ink-soft' : 'font-medium text-danger')}>
          合计 {total.actual} 吨{total.expected != null && !total.pass ? `（存量 ${total.expected} 不符）` : ''}
        </span>
      )}
      {unit.totals?.失败页 && unit.totals.失败页.length > 0 && (
        <span className="inline-flex items-center gap-0.5 rounded bg-warning/10 px-1.5 py-px text-warning">
          <AlertTriangle className="h-3 w-3" aria-hidden />
          失败页 {unit.totals.失败页.join(',')}
        </span>
      )}
      {confirmable && (
        <span className="inline-flex items-center gap-0.5 rounded bg-primary/10 px-1.5 py-px text-primary">
          <CheckCircle2 className="h-3 w-3" aria-hidden />
          可确认
        </span>
      )}
    </div>
  );
}
```

- [ ] **Step 7: VoucherTable.tsx**

```tsx
// apps/web/src/components/review-workbench/VoucherTable.tsx
// 虚拟滚动可编辑表格: div 网格(行绝对定位, 与 <table> 语义冲突故不用 table),
// 定宽列 + 横向滚动; 单元格双击进入编辑, 失焦提交(明细行是整字段 JSON 替换
// 契约, 由父组件组装数组); 三色(客户端镜像勾稽); 行勾选"已核"。
import { useRef, useState } from 'react';
import clsx from 'clsx';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { WorkbenchRow, WorkbenchUnit } from '../../api/reviewWorkbench';
import { TABLE_COLUMNS, cellTone, checkRow, type WorkbenchTableDocType } from './workbenchModel';
import { UnitGroupHeader } from './UnitGroupHeader';

const NUMERIC_COLUMNS = new Set(['毛重_吨', '皮重_吨', '净重_吨', '票重_吨', '盈亏_吨']);
const COL_WIDTH: Record<string, number> = {};
for (const c of [...TABLE_COLUMNS['汽运磅单'], ...TABLE_COLUMNS['轨道衡称重单']]) {
  COL_WIDTH[c] = NUMERIC_COLUMNS.has(c) ? 92 : 132;
}
const PAGE_W = 64;
const CHECK_W = 48;
const CHECKS_W = 180;

type Item =
  | { kind: 'group'; unit: WorkbenchUnit }
  | { kind: 'row'; unit: WorkbenchUnit; rowIndex: number };

export function VoucherTable(props: {
  docType: WorkbenchTableDocType;
  units: WorkbenchUnit[];
  checkedRows: Set<string>;
  editedDocs: Set<string>;
  onToggleRow: (key: string) => void;
  rowEdits: Record<string, WorkbenchRow[]>;
  onCellCommit: (unit: WorkbenchUnit, rowIndex: number, column: string, raw: string) => void;
  selected: { docId: string; rowIndex: number } | null;
  onSelect: (sel: { docId: string; rowIndex: number }) => void;
}) {
  const { docType, units, checkedRows, editedDocs, onToggleRow, rowEdits, onCellCommit, selected, onSelect } = props;
  const columns = TABLE_COLUMNS[docType];
  const scrollRef = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState<{ docId: string; rowIndex: number; column: string } | null>(null);

  const rowsOf = (u: WorkbenchUnit): WorkbenchRow[] => rowEdits[u.docId] ?? u.rows ?? [];

  const items: Item[] = [];
  for (const u of units) {
    items.push({ kind: 'group', unit: u });
    rowsOf(u).forEach((_r, i) => items.push({ kind: 'row', unit: u, rowIndex: i }));
  }

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (items[i]!.kind === 'group' ? 40 : 34),
    overscan: 12,
  });

  const gridTemplate = `${CHECK_W}px ${PAGE_W}px ${columns.map((c) => `${COL_WIDTH[c] ?? 120}px`).join(' ')} ${CHECKS_W}px`;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* sticky 表头 */}
      <div className="shrink-0 overflow-x-auto border-b border-line bg-panel">
        <div className="grid min-w-max" style={{ gridTemplateColumns: gridTemplate }}>
          <div className="px-2 py-1.5 text-[11px] font-medium text-ink-soft">已核</div>
          <div className="px-2 py-1.5 text-[11px] font-medium text-ink-soft">页码</div>
          {columns.map((c) => (
            <div key={c} className="px-2 py-1.5 text-[11px] font-medium text-ink-soft">{c}</div>
          ))}
          <div className="px-2 py-1.5 text-[11px] font-medium text-ink-soft">勾稽</div>
        </div>
      </div>
      {/* 虚拟滚动体 */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative', minWidth: 'max-content' }}>
          {virtualizer.getVirtualItems().map((vi) => {
            const item = items[vi.index]!;
            if (item.kind === 'group') {
              const u = item.unit;
              const rs = rowsOf(u);
              const confirmable =
                rs.length > 0 &&
                (u.reviewStatus === 'pending' || u.reviewStatus === 'corrected') &&
                rs.every((_r, i) => checkedRows.has(`${u.docId}#${i}`));
              return (
                <div
                  key={`g-${u.docId}`}
                  style={{ position: 'absolute', top: vi.start, left: 0, right: 0, height: vi.size }}
                >
                  <UnitGroupHeader
                    unit={u}
                    docType={docType}
                    currentRows={rowEdits[u.docId]}
                    confirmable={confirmable}
                  />
                </div>
              );
            }
            const { unit: u, rowIndex } = item;
            const row = rowsOf(u)[rowIndex]!;
            // 客户端镜像勾稽(编辑后即时反馈) + 服务端结果合并去重
            const clientIssues = checkRow(row, docType);
            const serverIssues = u.rowChecks?.[rowIndex]?.issues ?? [];
            const allIssues = [
              ...clientIssues,
              ...serverIssues.filter((s) => !clientIssues.some((i) => i.rule === s.rule)),
            ];
            const rowKey = `${u.docId}#${rowIndex}`;
            const checked = checkedRows.has(rowKey);
            const isSel = selected?.docId === u.docId && selected?.rowIndex === rowIndex;
            const locked = u.reviewStatus === 'confirmed';
            return (
              <div
                key={`r-${u.docId}-${rowIndex}`}
                style={{ position: 'absolute', top: vi.start, left: 0, right: 0, height: vi.size }}
                onClick={() => onSelect({ docId: u.docId, rowIndex })}
                className={clsx(
                  'grid cursor-pointer items-stretch border-b border-line/30 text-xs',
                  isSel ? 'bg-primary/5' : 'hover:bg-surface',
                  locked && 'opacity-60',
                )}
                data-row-key={rowKey}
              >
                <div className="flex items-center justify-center">
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={locked}
                    onChange={() => onToggleRow(rowKey)}
                    className="h-3.5 w-3.5 cursor-pointer accent-[#35719C]"
                    aria-label={`已核 ${u.title} 第 ${rowIndex + 1} 行`}
                  />
                </div>
                <div className="flex items-center px-2 font-mono text-[11px] text-ink-soft">{row['页码'] ?? '-'}</div>
                {columns.map((col) => {
                  const tone = cellTone(allIssues, col);
                  const isEditing =
                    editing?.docId === u.docId && editing?.rowIndex === rowIndex && editing?.column === col;
                  const value = row[col];
                  return (
                    <div
                      key={col}
                      className={clsx(
                        'flex items-center px-2',
                        tone === 'error' && 'bg-danger/10 text-danger',
                        tone === 'warning' && 'bg-warning/10 text-warning',
                        editedDocs.has(u.docId) && tone === null && 'bg-primary/5',
                      )}
                      onDoubleClick={() => {
                        if (!locked) setEditing({ docId: u.docId, rowIndex, column: col });
                      }}
                    >
                      {isEditing ? (
                        <input
                          autoFocus
                          defaultValue={value == null ? '' : String(value)}
                          onBlur={(e) => {
                            setEditing(null);
                            if (e.target.value !== (value == null ? '' : String(value))) {
                              onCellCommit(u, rowIndex, col, e.target.value);
                            }
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              (e.target as HTMLInputElement).blur();
                            } else if (e.key === 'Escape') {
                              e.preventDefault();
                              setEditing(null);
                            }
                          }}
                          className="w-full rounded border border-primary bg-white px-1 py-px text-xs outline-none"
                        />
                      ) : (
                        <span className="w-full truncate" title={value == null ? '' : String(value)}>
                          {value == null ? '-' : String(value)}
                        </span>
                      )}
                    </div>
                  );
                })}
                <div className="flex items-center px-2 text-[11px]">
                  {allIssues.length === 0 ? (
                    <span className="text-success">通过</span>
                  ) : (
                    <span
                      className={clsx(
                        'truncate',
                        allIssues.some((i) => i.severity === 'error') ? 'text-danger' : 'text-warning',
                      )}
                      title={allIssues.map((i) => i.message).join('; ')}
                    >
                      {allIssues[0]!.message}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 8: ReviewWorkbench 接入 VoucherTable**

把 Task 7 的占位块（`{group.units.reduce(...)} 行明细，表格组件待接入` 外层 div）替换为 `<VoucherTable ... />`，并在 ReviewWorkbench 增补状态与处理函数：

```tsx
// 新增 import
import {
  submitRowCorrections,
  type WorkbenchRow,
} from '../../api/reviewWorkbench';
import { VoucherTable } from './VoucherTable';
import type { WorkbenchTableDocType } from './workbenchModel';

// 新增 state
const [checkedRows, setCheckedRows] = useState<Set<string>>(() => new Set());
const [editedDocs, setEditedDocs] = useState<Set<string>>(() => new Set());
const [rowEdits, setRowEdits] = useState<Record<string, WorkbenchRow[]>>({});
const [selected, setSelected] = useState<{ docId: string; rowIndex: number } | null>(null);
const [actionError, setActionError] = useState<string | null>(null);

// docId 切换时清空行级客户端状态(在 load 成功分支 setData 之后):
setCheckedRows(new Set());
setEditedDocs(new Set());
setRowEdits({});
setSelected(null);
setActionError(null);

const toggleRow = (key: string) => {
  setCheckedRows((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });
};

// 单元格提交: 更新 working copy -> 整数组 corrections 提交 -> 成功标记已改;
// 失败回退编辑前值并提示。
const handleCellCommit = async (
  unit: (typeof data.groups)[number]['units'][number],
  rowIndex: number,
  column: string,
  raw: string,
) => {
  const before = rowEdits[unit.docId] ?? unit.rows ?? [];
  const numeric = ['毛重_吨', '皮重_吨', '净重_吨', '票重_吨', '盈亏_吨'].includes(column);
  const parsed: string | number = numeric ? (raw.trim() === '' ? '' : Number(raw)) : raw;
  const next = before.map((r, i) => (i === rowIndex ? { ...r, [column]: parsed } : r));
  setRowEdits((prev) => ({ ...prev, [unit.docId]: next }));
  try {
    await submitRowCorrections(unit.docId, next);
    setEditedDocs((prev) => new Set(prev).add(unit.docId));
    setActionError(null);
  } catch (e) {
    setRowEdits((prev) => ({ ...prev, [unit.docId]: before }));
    setActionError(`更正失败(${unit.title} 第 ${rowIndex + 1} 行): ${e instanceof Error ? e.message : String(e)}`);
  }
};
```

voucher-table 分支渲染（`group.kind === 'voucher-table'` 时）：

```tsx
{group?.kind === 'unit-list' ? (
  /* 原样保留 Task 7 的 UnitListGroup 分支 */
) : group ? (
  <VoucherTable
    docType={group.docType as WorkbenchTableDocType}
    units={group.units}
    checkedRows={checkedRows}
    editedDocs={editedDocs}
    onToggleRow={toggleRow}
    rowEdits={rowEdits}
    onCellCommit={(u, i, c, v) => void handleCellCommit(u, i, c, v)}
    selected={selected}
    onSelect={setSelected}
  />
) : null}
```

注意：`group.docType` 理论上是 WORKBENCH_TABLE_DOCTYPES 之一（kind 判定同源）；若出现未知类型（服务端枚举扩展），`as` 断言后 TABLE_COLUMNS 查不到列会得到空列数组 —— 可接受（空表不崩），后续票种接入时补列定义。顶栏 `{actionError && <span className="text-danger">{actionError}</span>}` 显示更正失败信息。

- [ ] **Step 9: 构建 + lint + web 测试**

Run: `npm run build --workspace @sca/web` → 通过
Run: `npm run lint` → 通过
Run: `npm test --workspace @sca/web` → 全 PASS

- [ ] **Step 10: Commit**

```bash
git add apps/web/package.json apps/web/package-lock.json apps/web/src/components/review-workbench/workbenchModel.ts apps/web/src/components/review-workbench/UnitGroupHeader.tsx apps/web/src/components/review-workbench/VoucherTable.tsx apps/web/src/components/review-workbench/ReviewWorkbench.tsx apps/web/test/workbenchModel.test.ts
git commit -m "feat(web): 集中复核可编辑表格(虚拟滚动/三色勾稽/行内更正/已核勾选)"
```

---

### Task 9: OriginalPane 左栏原文 + 行→页锚定

**Files:**
- Create: `apps/web/src/components/review-workbench/OriginalPane.tsx`
- Modify: `apps/web/src/components/review-workbench/ReviewWorkbench.tsx`（占位替换）

**Interfaces:**
- Consumes: Task 7 `unitPreviewPageUrl` / `WorkbenchUnit`；Task 8 的 `selected` 状态（行选中携带 docId + rowIndex）
- Produces: `OriginalPane` props：

```ts
{
  unit: WorkbenchUnit | null;       // 选中行所属单据(取 selected.docId 反查)
  selectedPage: number | null;      // 选中行的 页码 值(无选中或行无页码 -> null)
}
```

- [ ] **Step 1: 实现 OriginalPane.tsx**

```tsx
// apps/web/src/components/review-workbench/OriginalPane.tsx
// 左栏原文区(行->页锚定, spec 2026-09-04 §6): 上方当前页大图(Task 6 单页
// 裁切端点), 下方缩略图条(该 unit 页区间); 点选行 -> 大图跳到该行 页码。
// 页码取自明细行注入的 页码 字段(pageRecords.ts 聚合), 无选中时显示第
// 一页; 手动点缩略图可临时覆盖(selectedPage 变化时重新跟随)。
import { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import { FileQuestion } from 'lucide-react';
import { unitPreviewPageUrl, type WorkbenchUnit } from '../../api/reviewWorkbench';

export function OriginalPane({
  unit,
  selectedPage,
}: {
  unit: WorkbenchUnit | null;
  selectedPage: number | null;
}) {
  const pages = useMemo(() => {
    if (!unit || unit.pageStart == null) return [];
    const end = unit.pageEnd ?? unit.pageStart;
    const out: number[] = [];
    for (let p = unit.pageStart; p <= end; p++) out.push(p);
    return out;
  }, [unit]);

  // selectedPage 变化即跟随(点行/方向键都走 selected); 手动点缩略图临时覆盖。
  const [manualPage, setManualPage] = useState<number | null>(null);
  useEffect(() => {
    setManualPage(null);
  }, [selectedPage, unit?.docId]);

  const current = manualPage ?? selectedPage ?? pages[0] ?? null;
  const imgUrl = unit && current != null ? unitPreviewPageUrl(unit.docId, current) : null;

  if (!unit || current == null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-xs text-ink-soft">
        <FileQuestion className="h-8 w-8 text-line" aria-hidden />
        <span>点击表格中的行，这里显示对应原片页</span>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-line px-3 py-1.5 text-xs text-ink-soft">
        <span className="truncate font-medium text-ink">{unit.title}</span>
        <span>第 {current} 页{unit.pageEnd != null && unit.pageEnd > (unit.pageStart ?? 1) ? ` / 共 ${unit.pageEnd - (unit.pageStart ?? 1) + 1} 页` : ''}</span>
      </div>
      {/* 大图: object-contain 适配, 加载失败显示占位 */}
      <div className="min-h-0 flex-1 overflow-auto bg-surface p-3">
        {imgUrl && (
          <img
            key={imgUrl}
            src={imgUrl}
            alt={`${unit.title} 第 ${current} 页原片`}
            loading="lazy"
            className="mx-auto max-w-full rounded border border-line bg-white shadow-sm"
          />
        )}
      </div>
      {/* 缩略图条 */}
      {pages.length > 1 && (
        <div className="flex shrink-0 gap-1.5 overflow-x-auto border-t border-line px-3 py-2">
          {pages.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setManualPage(p)}
              title={`查看第 ${p} 页`}
              className={clsx(
                'flex h-14 w-11 shrink-0 cursor-pointer items-center justify-center rounded border text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary',
                p === current
                  ? 'border-primary bg-primary/10 font-semibold text-primary'
                  : 'border-line bg-surface text-ink-soft hover:border-ink-soft/40',
              )}
            >
              {p}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: ReviewWorkbench 接入**

把左栏占位 `{/* Task 9: OriginalPane */}` 所在 div 内容替换：

```tsx
<OriginalPane unit={selectedUnit} selectedPage={selectedPage} />
```

ReviewWorkbench 增补派生值（state 来自 Task 8）：

```tsx
const selectedUnit = useMemo(() => {
  if (!selected || !data) return null;
  for (const g of data.groups) {
    const u = g.units.find((x) => x.docId === selected.docId);
    if (u) return u;
  }
  return null;
}, [data, selected]);

const selectedPage = useMemo(() => {
  if (!selectedUnit || !selected) return null;
  const rows = rowEdits[selectedUnit.docId] ?? selectedUnit.rows ?? [];
  const page = rows[selected.rowIndex]?.['页码'];
  return typeof page === 'number' ? page : null;
}, [selectedUnit, selected, rowEdits]);
```

import 加 `import { OriginalPane } from './OriginalPane';`。

- [ ] **Step 3: 构建 + lint**

Run: `npm run build --workspace @sca/web` → 通过
Run: `npm run lint` → 通过

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/review-workbench/OriginalPane.tsx apps/web/src/components/review-workbench/ReviewWorkbench.tsx
git commit -m "feat(web): 集中复核左栏原文页视图与行->页锚定"
```

---

### Task 10: 键盘流 + 批量操作（一键放行 / 确认已核 / 自动跳行）

**Files:**
- Create: `apps/web/src/components/review-workbench/useWorkbenchKeyboard.ts`
- Modify: `apps/web/src/components/review-workbench/ReviewWorkbench.tsx`（顶栏批量按钮 + 键盘接线）

**Interfaces:**
- Consumes: Task 7 `submitReviewBatch`；Task 8 `isUnitConfirmable`/`TABLE_COLUMNS`、checkedRows/rowEdits 状态；Task 9 `onSelect` 锚定
- Produces:
  - `useWorkbenchKeyboard(enabled: boolean, handlers: { onEnter(): void; onF8(backwards: boolean): void; onConfirmUnit(): void; onReleaseAll(): void }): void`
  - ReviewWorkbench 顶栏新增按钮：`确认已核(N)`（manual）、`一键放行(N)`（auto-release，两步确认）、`自动跳行` 开关（localStorage `sca.reviewAutoJump`）

- [ ] **Step 1: useWorkbenchKeyboard.ts**

```ts
// apps/web/src/components/review-workbench/useWorkbenchKeyboard.ts
// 键盘流(spec 2026-09-04 §9): Enter=下一行, F8/Shift+F8=上/下一个问题行,
// Ctrl+Enter=确认当前单据, Ctrl+Shift+Enter=一键放行。
// 输入控件内只放行 Escape(编辑态自己处理), 其余键不拦截。
import { useEffect } from 'react';

export interface WorkbenchKeyboardHandlers {
  onEnter: () => void;
  onF8: (backwards: boolean) => void;
  onConfirmUnit: () => void;
  onReleaseAll: () => void;
}

export function useWorkbenchKeyboard(enabled: boolean, handlers: WorkbenchKeyboardHandlers): void {
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inEditor =
        !!target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (e.key === 'Escape') return; // 编辑态/弹层自行消费
      if (inEditor) return;
      if (e.key === 'Enter' && e.ctrlKey && e.shiftKey) {
        e.preventDefault();
        handlers.onReleaseAll();
      } else if (e.key === 'Enter' && e.ctrlKey) {
        e.preventDefault();
        handlers.onConfirmUnit();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        handlers.onEnter();
      } else if (e.key === 'F8') {
        e.preventDefault();
        handlers.onF8(e.shiftKey);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [enabled, handlers]);
}
```

- [ ] **Step 2: ReviewWorkbench 批量操作与键盘接线**

新增 import：`submitReviewBatch`（并入 api import）、`useWorkbenchKeyboard`、`checkRow, isUnitConfirmable, TABLE_COLUMNS`（并入 workbenchModel import）。新增 state：

```tsx
const [autoJump, setAutoJump] = useState<boolean>(
  () => localStorage.getItem('sca.reviewAutoJump') === '1',
);
const [batchBusy, setBatchBusy] = useState(false);
const [releaseArmed, setReleaseArmed] = useState(false); // 一键放行两步确认
```

派生（当前 voucher-table 组内）：

```tsx
const flatRows = useMemo(() => {
  // 当前行序列: [docId, rowIndex, row, unit] 用于 Enter/F8 导航
  if (!group || group.kind !== 'voucher-table') return [];
  const out: Array<{ unit: typeof group.units[number]; rowIndex: number; row: Record<string, string | number | null> }> = [];
  for (const u of group.units) {
    const rows = rowEdits[u.docId] ?? u.rows ?? [];
    rows.forEach((r, i) => out.push({ unit: u, rowIndex: i, row: r }));
  }
  return out;
}, [group, rowEdits]);

const docTypeOfGroup = (group?.kind === 'voucher-table' ? group.docType : null) as WorkbenchTableDocType | null;

const isProblemRow = (item: (typeof flatRows)[number]) =>
  checkRow(item.row, docTypeOfGroup ?? '汽运磅单').some((i) => i.severity === 'error') ||
  item.unit.needsReview ||
  item.unit.warnings.length > 0;

const confirmableUnits = useMemo(() => {
  if (!group) return [];
  return group.units.filter((u) => {
    const rowCount = (rowEdits[u.docId] ?? u.rows ?? []).length;
    const resolved = (rowEdits[u.docId] ?? u.rows ?? []).filter(
      (_r, i) => checkedRows.has(`${u.docId}#${i}`),
    ).length;
    return isUnitConfirmable(u, resolved, rowCount);
  });
}, [group, checkedRows, rowEdits]);

const releasableUnits = useMemo(
  () => (data?.groups.flatMap((g) => g.units) ?? []).filter((u) => u.releaseEligible),
  [data],
);
```

批量动作（提交后整体 refetch，简单正确）：

```tsx
const runBatch = async (actions: Array<{ docId: string; confirm: true; action: 'manual' | 'auto-release' }>) => {
  if (actions.length === 0 || !docId) return;
  setBatchBusy(true);
  try {
    const results = await submitReviewBatch(docId, actions);
    const failed = results.filter((r) => !r.ok);
    if (failed.length > 0) {
      setActionError(`${failed.length} 份单据确认失败: ${failed.map((f) => f.error).join('; ')}`);
    } else {
      setActionError(null);
    }
    await load(docId);
  } catch (e) {
    setActionError(e instanceof Error ? e.message : String(e));
  } finally {
    setBatchBusy(false);
    setReleaseArmed(false);
  }
};
```

键盘 handlers（Enter 带自动跳行后的"已核"联动：勾选当前行再跳下一行是 Rossum 式连续流，仅在 autoJump 开时勾选）：

```tsx
const keyboardHandlers = useMemo(
  () => ({
    onEnter: () => {
      if (!selected || flatRows.length === 0) {
        const first = flatRows[0];
        if (first) onSelect({ docId: first.unit.docId, rowIndex: first.rowIndex });
        return;
      }
      const idx = flatRows.findIndex(
        (r) => r.unit.docId === selected.docId && r.rowIndex === selected.rowIndex,
      );
      if (autoJump && idx >= 0) {
        const key = `${selected.docId}#${selected.rowIndex}`;
        setCheckedRows((prev) => new Set(prev).add(key));
      }
      const next = flatRows[idx + 1] ?? flatRows[0];
      if (next) setSelected({ docId: next.unit.docId, rowIndex: next.rowIndex });
    },
    onF8: (backwards: boolean) => {
      const problems = flatRows.filter((r) => isProblemRow(r));
      if (problems.length === 0) return;
      let idx = 0;
      if (selected) {
        const cur = problems.findIndex(
          (r) => r.unit.docId === selected.docId && r.rowIndex === selected.rowIndex,
        );
        idx = backwards ? (cur <= 0 ? problems.length - 1 : cur - 1) : (cur + 1) % problems.length;
      }
      const target = problems[idx]!;
      setSelected({ docId: target.unit.docId, rowIndex: target.rowIndex });
    },
    onConfirmUnit: () => {
      if (selected) void runBatch([{ docId: selected.docId, confirm: true, action: 'manual' }]);
    },
    onReleaseAll: () => {
      if (releasableUnits.length > 0) setReleaseArmed(true);
    },
  }),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [selected, flatRows, autoJump, releasableUnits, docId],
);
useWorkbenchKeyboard(!!docId && !batchBusy, keyboardHandlers);
```

顶栏进度 span 之前插入批量操作区（含两步确认与开关）：

```tsx
<div className="flex items-center gap-1.5">
  <button
    type="button"
    disabled={batchBusy || confirmableUnits.length === 0}
    onClick={() => void runBatch(confirmableUnits.map((u) => ({ docId: u.docId, confirm: true, action: 'manual' as const })))}
    className="cursor-pointer whitespace-nowrap rounded border border-primary bg-primary px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-primary/90 disabled:cursor-default disabled:opacity-40"
    title="确认所有行都已核对的单据(Ctrl+Enter 确认当前单据)"
  >
    确认已核 ({confirmableUnits.length})
  </button>
  {!releaseArmed ? (
    <button
      type="button"
      disabled={batchBusy || releasableUnits.length === 0}
      onClick={() => setReleaseArmed(true)}
      className="cursor-pointer whitespace-nowrap rounded border border-success bg-success/10 px-2.5 py-1 text-xs font-medium text-success transition-colors hover:bg-success/20 disabled:cursor-default disabled:opacity-40"
      title={`放行 ${releasableUnits.length} 份高置信且勾稽全过的单据(Ctrl+Shift+Enter)`}
    >
      一键放行 ({releasableUnits.length})
    </button>
  ) : (
    <>
      <span className="whitespace-nowrap text-xs text-warning">
        将放行 {releasableUnits.length} 份单据？
      </span>
      <button
        type="button"
        disabled={batchBusy}
        onClick={() => void runBatch(releasableUnits.map((u) => ({ docId: u.docId, confirm: true, action: 'auto-release' as const })))}
        className="cursor-pointer whitespace-nowrap rounded bg-success px-2 py-1 text-xs font-medium text-white hover:bg-success/90"
      >
        确认放行
      </button>
      <button
        type="button"
        onClick={() => setReleaseArmed(false)}
        className="cursor-pointer whitespace-nowrap rounded border border-line px-2 py-1 text-xs text-ink-soft hover:bg-surface"
      >
        取消
      </button>
    </>
  )}
  <label className="flex cursor-pointer items-center gap-1 whitespace-nowrap text-xs text-ink-soft">
    <input
      type="checkbox"
      checked={autoJump}
      onChange={(e) => {
        setAutoJump(e.target.checked);
        localStorage.setItem('sca.reviewAutoJump', e.target.checked ? '1' : '0');
      }}
      className="h-3.5 w-3.5 accent-[#35719C]"
    />
    Enter 跳行自动已核
  </label>
</div>
```

- [ ] **Step 3: 构建 + lint + web 测试**

Run: `npm run build --workspace @sca/web` → 通过
Run: `npm run lint` → 通过
Run: `npm test --workspace @sca/web` → 全 PASS

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/review-workbench/useWorkbenchKeyboard.ts apps/web/src/components/review-workbench/ReviewWorkbench.tsx
git commit -m "feat(web): 集中复核键盘流与批量操作(放行/确认已核/自动跳行)"
```

---

### Task 11: FileTree 入口 + 全仓验证

**Files:**
- Modify: `apps/web/src/components/shell/FileTree.tsx`（TreeCallbacks 接口 + FileRow container 行按钮）
- Modify: `apps/web/src/components/shell/FileDrawer.tsx`（props 透传）
- Modify: `apps/web/src/App.tsx`（FileDrawer 传 onOpenWorkbench）

**Interfaces:**
- Consumes: Task 7 的 `#/review?docId=` 路由（App 层 `navigate('review', { docId })`）
- Produces: `TreeCallbacks.onOpenWorkbench?: (docId: string) => void`；FileDrawerProps 同名 prop；container 行「集中复核」按钮

- [ ] **Step 1: 回调接线（3 处）**

FileTree.tsx `TreeCallbacks` 接口（`onOpenBindings` 旁）加：

```ts
  /** 单据组行「集中复核」入口: 跳全页复核工作台(#/review?docId=)。 */
  onOpenWorkbench?: (docId: string) => void;
```

FileDrawer.tsx `FileDrawerProps` 加同名 prop，并在 `callbacks` 对象里透传（`onOpenBindings,` 旁加 `onOpenWorkbench,`；组件解构参数同步加）。

App.tsx FileDrawer 挂载处（`onOpenBindings={openBindingsForDoc}` 旁）加：

```tsx
          onOpenWorkbench={(docId) => navigate('review', { docId })}
```

- [ ] **Step 2: FileRow container 行按钮**

FileTree.tsx FileRow 内（`batchBadgeNode` 定义之后，grep `{batchBadgeNode}` 找到渲染位置），在其旁边追加：

```tsx
{containerDocId && cb.onOpenWorkbench && (
  <button
    type="button"
    onClick={(e) => {
      e.stopPropagation();
      cb.onOpenWorkbench!(containerDocId);
    }}
    title="打开集中复核工作台（按类型分组表格化批量核对）"
    className="cursor-pointer whitespace-nowrap rounded border border-[#A9BCCD] bg-[#F2F6FA] px-1.5 py-px text-[10px] text-[#35719C] transition-colors hover:border-[#5D8FB5] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
  >
    集中复核
  </button>
)}
```

（样式对齐单据组批量徽标的钢蓝虚线族，放同一行 flex 流内。）

- [ ] **Step 3: 构建 + lint + 全仓测试**

Run: `npm run build`
Expected: web + server 全部通过（含 tsc）
Run: `npm run lint`
Expected: oxlint 通过
Run: `npm test`
Expected: 全部 vitest 通过（新增 6 个测试文件 + 既有无回归）

- [ ] **Step 4: 手动冒烟清单（dev server 已在 :5173 时执行，不开新进程）**

1. 文件树单据组行出现「集中复核」按钮，点击进入 `#/review?docId=...`。
2. 混合类型文件：分组 chips 正确（汽运磅单 N / 化验报告 M）；磅单组渲染表格，化验报告组渲染列表且「复核」打开旧弹窗。
3. 点击表格行：左栏切到该行页码的原片；缩略图条可手动翻页。
4. 双击单元格编辑一个净重值使勾稽不平：对应三列标红、unit 头合计变红；刷新后仍红（更正已落库）。
5. 勾选某单据全部行 -> 「确认已核 (1)」亮起 -> 提交后该 unit 徽标变「已确认」，行变只读。
6. 「一键放行」两步确认 -> releasable 单据变「已放行」。
7. Enter/F8/Ctrl+Enter/Ctrl+Shift+Enter 键盘流各验一遍；Esc 退出编辑。
8. 旧链路回归：unit 行「复核」弹窗、单据确认（review_action=manual 落库）正常。

- [ ] **Step 5: Commit + 合并 main（仓库惯例）**

```bash
git add apps/web/src/components/shell/FileTree.tsx apps/web/src/components/shell/FileDrawer.tsx apps/web/src/App.tsx
git commit -m "feat(web): 文件树单据组集中复核入口 + 全链路接线"
```

全绿后按 AGENTS.md 惯例合并回 main（`git fetch origin main` → `git merge origin/main` → 重验 build/lint/test 若合并触及代码 → `git push origin HEAD:PengYip/UI-UX优化` → `git push origin HEAD:main`）。

---

## Self-Review（计划完成后已核对）

**Spec 覆盖**：§6 入口与布局→Task 7/9/11；§7.1 workbench 端点→Task 4；§7.2 unit-preview page→Task 6；§7.3 review-batch→Task 5；§7.4 reviewChecks→Task 1（+Task 8 前端镜像）；§7.5 DB review_action→Task 2；§7.6 阈值→Task 4 env + Task 10 UI；§8 状态机与复核流→Task 8/10（行级客户端状态 + 单据级确认）；§9 前端结构与键盘流→Task 7-10；§10 错误处理→Task 4/5/8/10；§11 测试→各 Task 步骤。无遗漏。

**类型一致性**：`RowIssue`/`TotalCheck`（server）与 `WorkbenchRowIssue`/totalCheck 形状（client）字段一致；`WorkbenchUnitOut`（server Task 4）与 `WorkbenchUnit`（client Task 7）字段一致；`setReviewOutcome`/`setReviewOutcomePg`/`listLatestExtractionsByDocIds(Pg)` 签名在 Task 2/3/5 间一致；VoucherTable props 与 ReviewWorkbench 传参一致。

**已知取舍**（执行者无需再决策）：服务端/客户端勾稽规则双实现以注释互指同步（无共享包）；批量提交后整体 refetch 而非局部合并（简单正确，N 为单文件级）；`group.docType as WorkbenchTableDocType` 断言依赖服务端 kind 同源判定，未知票种得到空列表不崩。






