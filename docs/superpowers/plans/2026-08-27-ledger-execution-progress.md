# 台账执行进度整合 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 下线执行流水独立页，把六向汇总/执行进度/时间线回放/逐笔明细整合进项目台账合同卡。

**Architecture:** 后端 rollup 扩展每合同 `execution` 块（复用 `computeExecutionProgress`，spec 2026-08-27-ledger-execution-progress-design.md §3）；前端新增纯函数库（时间轴累计/进度换算）+ 合同卡执行区块组件（lazy 拉逐笔）；删除 FlowsView/ExecutionFlowPanel。

**Tech Stack:** Vite + React 19 + TS + Tailwind（web）；Hono + better-sqlite3/drizzle（server）；vitest 双端。

## Global Constraints

- 不加 emoji（repo 全局约定）。
- AI SDK 6 约定不涉及本计划（无工具/streaming 改动）。
- 验证顺序：build -> lint -> test（CI 同序，根 `npm test` = server vitest + web vitest）。
- 提交信息风格：`feat(scope): 中文描述`（对齐近期 git log）。
- 待执行/进度如实呈现不封顶：负数显「超额 X」，百分比可超 100%。
- 资金/发票金额标注「未结算累计」；基准标注「合同额(参考)」。

---

### Task 1: 后端 rollup execution 块

**Files:**
- Modify: `apps/server/src/pipeline/projectRollup.ts`
- Test: `apps/server/test/pipeline/projectRollup.test.ts`

**Interfaces:**
- Consumes: `listExecutionFlows(ctx, contractNo, userId): Promise<ExecutionFlowRow[]>`（repositories.ts:2573）、`computeExecutionProgress(flows, ledgerFields): ExecutionProgress`（executionProgress.ts:23）。
- Produces: `RollupContract.execution: { summaries: ExecutionFlowSummary[]; progress: ExecutionProgress; flowCount: number }`。

- [ ] **Step 1: 写失败测试**（projectRollup.test.ts 追加）

```ts
// fixtures 顶部追加:
import { upsertExecutionFlow as _upsert } from '../../src/pipeline/db/repositories.js'; // 已有 upsertExecutionFlow 导入
function flowRow(
  contractNo: string, flowType: string, direction: 'in' | 'out',
  extra: Partial<Parameters<typeof upsertExecutionFlow>[1]> = {},
): import('../../src/pipeline/db/repositories.js').ExecutionFlowRow {
  return {
    id: `EF-${contractNo}-${flowType}-${direction}`,
    bindingId: `BD-${contractNo}`, documentId: `D-${contractNo}`, contractNo,
    flowType, direction, amount: null, quantityTon: null, unit: null,
    quantityValue: null, quantityDimension: null, quantityCanonical: null,
    docType: '发货单', voucherDate: null, confidence: 1, createdBy: 'u1',
    userId: null, createdAt: '2026-08-27T00:00:00.000Z', ...extra,
  } as never;
}

// buildRollup describe 内追加:
it('execution 块: 有基准 -> basis/progress; 无台账 -> no-contract-basis; 反向照常聚合', () => {
  const ledgers = new Map<string, ContractLedgerEntry | null>([
    ['HT-S1', ledger('HT-S1', { 金额: 100, 数量: 10000, 单位: '吨' })],
    ['HT-N1', null],
  ]);
  const r = buildRollup({
    project,
    memberships: [
      membership('HT-S1', '销售', 'confirmed'),
      membership('HT-N1', '采购', 'confirmed'),
    ],
    ledgers,
    flowSummaries: [flowSummary('HT-S1', '货物流', 'out', null, 6000)],
    flowRows: new Map([
      ['HT-S1', [flowRow('HT-S1', '货物流', 'out', {
        quantityTon: 6000, unit: '吨', quantityValue: 6000,
        quantityDimension: 'mass', quantityCanonical: 6_000_000,
      })]],
      ['HT-N1', []],
    ]),
    selfPartyNames: selfNames,
  });
  const s1 = r.contracts.find((c) => c.contractNo === 'HT-S1')!;
  expect(s1.execution.flowCount).toBe(1);
  expect(s1.execution.summaries).toHaveLength(1);
  expect(s1.execution.progress.basis).toEqual({ quantity: 10000, unit: '吨', dimension: 'mass', canonical: 10_000_000 });
  expect(s1.execution.progress.progress).toBeCloseTo(0.6);
  const n1 = r.contracts.find((c) => c.contractNo === 'HT-N1')!;
  expect(n1.execution.progress.basis).toBeNull();
  expect(n1.execution.progress.reason).toBe('no-contract-basis');
});
```

并给既有两个 describe 的 `buildRollup` 调用补 `flowRows: new Map()` 参数（编译要求）。

- [ ] **Step 2: 跑测试确认失败** — `npm test --workspace apps/server -- test/pipeline/projectRollup.test.ts`，预期 TS 编译错（缺 flowRows/execution）。
- [ ] **Step 3: 实现 projectRollup.ts**

```ts
// imports 增补:
import {
  findProjectByCode, findContractLedgerByNo, listMembershipsByProject,
  summarizeExecutionFlows, listExecutionFlows, normalizeProjectCode,
  type ProjectMembershipRow, type ExecutionFlowSummary, type ExecutionFlowRow,
} from './db/repositories.js';
import { computeExecutionProgress, type ExecutionProgress } from './executionProgress.js';

export interface ContractExecution {
  summaries: ExecutionFlowSummary[];
  progress: ExecutionProgress;
  flowCount: number;
}

// RollupContract 增加字段: execution: ContractExecution;

// buildRollup args 增加: flowRows: Map<string, ExecutionFlowRow[]>;
// 循环内 contracts.push 前计算:
const rows = args.flowRows.get(m.contractNo) ?? [];
// push 对象增加:
execution: {
  summaries: args.flowSummaries.filter((s) => s.contractNo === m.contractNo),
  progress: computeExecutionProgress(rows, entry?.fields ?? null),
  flowCount: rows.length,
},

// rollupProject: 增加 const flowRows = new Map<string, ExecutionFlowRow[]>();
// confirmed 循环内: flowRows.set(m.contractNo, await listExecutionFlows(ctx, m.contractNo, userId));
// buildRollup 调用传 flowRows。
```

- [ ] **Step 4: 跑测试通过**；全量 `npm test --workspace apps/server`。
- [ ] **Step 5: Commit** — `feat(pipeline): rollup 合同面附 execution 块(六向汇总+进度+笔数)`

### Task 2: 前端执行进度纯函数库

**Files:**
- Create: `apps/web/src/lib/executionProgress.ts`
- Test: `apps/web/test/executionProgress.test.ts`

**Interfaces:**
- Produces: `roleNaturalDirection(role, flowType)`, `timelineDates(rows)`, `cumulativeAsOf(rows, asOf): Map<string, DirAggregate>`, `executedInBasisUnit(progress)`, `pendingInBasisUnit(progress)`, `ExecutionProgressView`, `TimelineFlowRow`, `DirAggregate`。

- [ ] **Step 1: 写失败测试**（apps/web/test/executionProgress.test.ts，照 voucherCoverage.test.ts 的 vitest 风格）
- [ ] **Step 2: 跑 `npm test --workspace apps/web -- executionProgress` 确认失败**
- [ ] **Step 3: 实现**（完整代码见下）

```ts
/* ---------- 执行进度展示纯函数(项目台账视图, spec 2026-08-27) ---------- */

export interface ExecutionProgressView {
  basis: { quantity: number; unit: string; dimension: 'mass' | 'count'; canonical: number } | null;
  delivered: { massKg: number | null; countPools: Record<string, number> } | null;
  progress: number | null;
  reason?: 'no-contract-basis' | 'dimension-mismatch' | 'unit-pool-missing';
}

export interface TimelineFlowRow {
  flowType: string;
  direction: 'in' | 'out';
  amount: number | null;
  quantityTon: number | null;
  voucherDate: string | null;
}

export interface DirAggregate { entryCount: number; totalAmount: number | null; totalQuantityTon: number | null }

/** 合同角色 -> 该流自然方向; 采购=收货/付款/收票, 销售=发货/收款/开票; 其他=null(双向显示)。 */
export function roleNaturalDirection(role: string, flowType: '货物流' | '资金流' | '发票流'): 'in' | 'out' | null {
  if (role === '采购') return flowType === '资金流' ? 'out' : 'in';
  if (role === '销售') return flowType === '资金流' ? 'in' : 'out';
  return null;
}

/** 时间轴刻度: 升序去重的非空凭证日期; 无日期行不产生刻度(只在「最新」态计入)。 */
export function timelineDates(rows: TimelineFlowRow[]): string[] {
  return [...new Set(rows.map((r) => r.voucherDate).filter((d): d is string => d != null && d !== ''))].sort();
}

/** 截至某日累计: 只累计 voucherDate 非空且 <= asOf 的行; 无数据方向不出现在 Map。 */
export function cumulativeAsOf(rows: TimelineFlowRow[], asOf: string): Map<string, DirAggregate> {
  const map = new Map<string, DirAggregate>();
  for (const r of rows) {
    if (!r.voucherDate || r.voucherDate > asOf) continue;
    const key = `${r.flowType}-${r.direction}`;
    const cur = map.get(key) ?? { entryCount: 0, totalAmount: null, totalQuantityTon: null };
    cur.entryCount += 1;
    if (r.amount !== null) cur.totalAmount = (cur.totalAmount ?? 0) + r.amount;
    if (r.quantityTon !== null) cur.totalQuantityTon = (cur.totalQuantityTon ?? 0) + r.quantityTon;
    map.set(key, cur);
  }
  return map;
}

/** 已执行量换算到台账基准原单位; 无法对齐返回 null。 */
export function executedInBasisUnit(progress: ExecutionProgressView): number | null {
  if (!progress.basis || !progress.delivered) return null;
  if (progress.basis.dimension === 'mass') {
    if (progress.delivered.massKg === null || progress.basis.canonical <= 0) return null;
    return (progress.delivered.massKg * progress.basis.quantity) / progress.basis.canonical;
  }
  const pool = progress.delivered.countPools[progress.basis.unit];
  return pool === undefined ? null : pool;
}

/** 待执行 = 基准 - 已执行(原单位); 量纲/单位池不对齐 -> null; 可为负(超额), 如实呈现。 */
export function pendingInBasisUnit(progress: ExecutionProgressView): number | null {
  if (!progress.basis) return null;
  if (progress.reason === 'dimension-mismatch' || progress.reason === 'unit-pool-missing') return null;
  const executed = executedInBasisUnit(progress);
  if (executed === null) return progress.basis.quantity;
  return progress.basis.quantity - executed;
}
```

- [ ] **Step 4: 测试通过**
- [ ] **Step 5: Commit** — `feat(web): 执行进度纯函数(角色方向/时间轴累计/基准换算)`

### Task 3: 合同卡执行区块组件

**Files:**
- Create: `apps/web/src/components/ledger/ContractExecutionSection.tsx`（lazy 拉流水 + 时间轴 + 进度三行 + 逐笔明细表，FlowRow 自 ExecutionFlowPanel 迁入）
- Modify: `apps/web/src/api/projects.ts`（contracts 增加 execution 类型）、`apps/web/src/api/flows.ts`（FlowSummary 加 `totalMassKg?: number | null`）
- Modify: `apps/web/src/components/ledger/ProjectLedgerView.tsx`（ContractCard 常驻执行行 + 展开区挂 Section + onOpenParties/预览 modal）

**Interfaces:**
- Consumes: Task 1 的 rollup execution、Task 2 纯函数、`fetchExecutionFlows`（api/flows.ts:114）、`FileEntry`（hooks/useFiles）。
- Produces: `ContractExecutionSection(props: { contractNo; displayContractNo; role; contractAmount; execution; onPreviewFile; onOpenParties? })`。

- [ ] **Step 1: api/projects.ts** 合同类型追加:

```ts
execution: {
  summaries: Array<{
    contractNo: string; flowType: string; direction: 'in' | 'out';
    entryCount: number; totalAmount: number | null; totalQuantityTon: number | null;
    totalMassKg?: number | null; lastVoucherDate: string | null;
  }>;
  progress: import('../../lib/executionProgress').ExecutionProgressView;
  flowCount: number;
};
```

- [ ] **Step 2: ContractExecutionSection.tsx**（fetchExecutionFlows + requestIdRef 守卫照 ExecutionFlowPanel:162-183 模式；asOf state 默认 'latest'；latest 用 rollup summaries 建 Map，回放用 cumulativeAsOf；三行 货物/资金/发票：货物行已执行/待执行走 executedInBasisUnit/pendingInBasisUnit（无基准降级 summaries.totalQuantityTon + '—'），资金/发票行 pending = contractAmount - totalAmount、负数「超额 X」、徽章「未结算累计」；反向 entryCount>0 追加「另有反向 N 笔」；时间轴 `<input type="range" min=0 max={dates.length}>`，末位=最新；明细表 grid `grid-cols-[64px_1fr_1fr_92px_1fr_140px]` 照 ExecutionFlowPanel:95-147 迁入（溯源走 onPreviewFile，documentMinioKey 为空降级悬浮文本）；`selfPartiesConfigured === false` 渲染主体名单引导（照 ExecutionFlowPanel:254-269）。）
- [ ] **Step 3: ProjectLedgerView.tsx** — ContractCard 行 2 与行 3 之间插入紧凑执行行（`执行 62% · 发货 6,200/10,000吨 · 收款 300万/1,000万`，flowCount===0 时「暂无执行记录」；金额用 `(n/1e4)` 万格式化辅助）；展开区在凭证明细前渲染 ContractExecutionSection；组件根挂 FilePreviewModal + previewFile state；`onOpenParties` prop 透传。
- [ ] **Step 4: `npm run build --workspace apps/web` 通过**
- [ ] **Step 5: Commit** — `feat(web): 台账合同卡执行进度块(时间轴回放+逐笔明细整合)`

### Task 4: 移除执行流水独立页

**Files:**
- Modify: `apps/web/src/components/shell/navigation.ts`（删 flows 项 + ViewId 收窄 + 删 ArrowLeftRight import）
- Modify: `apps/web/src/App.tsx`（删 FlowsView import/case:233-234；ledger 分支加 `onOpenParties={openParties}`）
- Delete: `apps/web/src/components/flows/FlowsView.tsx`、`apps/web/src/components/flows/ExecutionFlowPanel.tsx`
- Modify: `apps/web/src/api/flows.ts`（删 fetchFlowContracts/FlowContractOption:157-217）

- [ ] **Step 1: 改 navigation.ts / App.tsx / 删文件 / 清理 api/flows.ts**
- [ ] **Step 2: 全局 grep `fetchFlowContracts|FlowsView|ExecutionFlowPanel|'flows'` 确认无残留引用**
- [ ] **Step 3: `npm run build` 全仓通过**
- [ ] **Step 4: Commit** — `refactor(web): 下线执行流水独立页(整合进项目台账)`

### Task 5: 全量验证 + 合并推送

- [ ] **Step 1: `npm run build` -> `npm run lint` -> `npm test` 全绿**
- [ ] **Step 2: push 分支; `git fetch origin main` -> `git merge origin/main`（若有代码冲突解决后重跑 Step 1）**
- [ ] **Step 3: `git push origin HEAD:PengYip/UI-UX优化` + `git push origin HEAD:main`**
