# 核销工作台 writeoff-workbench 实施计划（前端路线图 Item 5）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 预付冲抵（付款/收款 ↔ 结算）与票款核销（收付 ↔ 发票）的精确操作面：两侧列表勾选 + 金额分配 + 守恒校验，提交后作为 L2 工具调用走审批中心，批准后落 `ontology_edges` 带参边。

**Architecture:** 前端新 ViewId `writeoff`（registry 驱动模式发现）→ `POST /api/writeoff/submit`（zod + 计划级守恒预检，快速失败）→ 复用 chat 后台运行管道（createSession + 逐字指令 + runSession）→ 模型调用 `create_writeoff`/`create_offset`（per-tool `needsApproval: true`，AI SDK 6）→ `recordL2PendingFromResponse` 落审批单 → 审批中心批准/拒绝 → callback 恢复轮次重执行工具 → `insertOntologyEdge` ×N + 自动 side_effect 审计。读侧余额聚合（trade_facts 总额 − WRITE_OFF/OFFSET_SETTLE 边累计）全部进新文件，不动 `listOntologyEdgesAsOf` 与 `projection.ts`。

**Tech Stack:** Hono + zod（服务端路由/校验）、Vercel AI SDK 6 `tool()`（inputSchema / needsApproval）、React 19 + Tailwind（前端）、vitest（双测试模式：ctxHolder+vi.mock(dbBackend) 路由模式；appAs+app.request+vi.mock(runSession) 审批流模式）。

**Spec:** `docs/superpowers/specs/2026-09-07-frontend-p0-p2-roadmap.md` §Item 5（writeoff-workbench）。基线：origin/main `8ebfe3a`（Item 1 审批中心 / Item 2 本体基座 / Item 3 贸易台账均已合并）。

## Global Constraints

- 验证顺序：`npm run build && npm run lint && npm test`（仓库根执行，全部通过才算完成）。
- 代码零 emoji；TS 严格模式过 tsc。
- **AI SDK 6**（不是 5/7）：工具 schema 字段是 `inputSchema`；L2 审批用 per-tool `needsApproval: true`（v7 的 `toolApproval` 在本仓库静默无效）。详见 AGENTS.md「AI SDK 6」节与 ARCHITECTURE.md Appendix D。
- 新增工具必须**先**登记 `docs/tool-inventory.json`（whenToUse/boundary/rationale），**再**上注册表；CI 双射门禁 `test/harness/toolInventory.test.ts` 会拦（bijection + 元数据 + toolOntologyMap 词汇门禁）。
- 工具输入新字段必须先落本体注册表词汇（实体 schema 或 `SHARED_TOOL_FIELD_NAMES`，`src/ontology/index.ts`）。
- 认证 `requireAuth`；测试模式：路由用 `ctxHolder` + `vi.mock(dbBackend)`（照抄 `test/routes/ontologyEntities.test.ts`），审批/运行流用 `appAs(userId)` + `app.request` + `vi.mock(runSession)`（照抄 `test/harness/approvalCallbackBackground.test.ts`）。
- **并行协调（Item 4 链路穿透同时在另一分支开发）**：
  - 对 `navigation.ts` / `App.tsx` 只做**追加式**编辑（ViewId 联合类型追加一个字面量、NAV_ITEMS 追加一项、分发三元链追加一个分支），不改共享函数签名。
  - `routes/ontology.ts` / `repo.ts` / `projection.ts` **本计划一律不改**——读侧聚合、校验、工具全部进新文件。
  - 谁先完成谁先合 main；后合方 `git fetch origin main` → merge → 重跑 build→lint→test → push。
- 分支惯例：feature 分支 `PengYip/writeoff-workbench`（基于 origin/main）开发，验证绿后 merge 回 main 并 push（触发 CI+CD 到 10.10.0.2）。
- 视觉对齐 bindings/ledger 惯例（卡片圆角/灰阶）；视觉细化不属于本计划范围。

## 与 Item 4（lineage-traverse）的文件分区交叉检查

Item 4 计划（`docs/superpowers/plans/2026-09-07-lineage-traverse.md`）的 Modify 清单：
`projection.ts`、`neighbors.ts`(新)、`routes/ontology.ts`、`scripts/seedLineageTraverseDemo.ts`(新)、`api/ontology.ts`、`graph/businessTypes.ts`、`graph/OntologyExplorer.tsx`(新)、`GraphView.tsx`、`GraphCanvas.tsx`、`graph/focus.ts`、`App.tsx`、`EntitiesView.tsx`、`EntityDetailDrawer.tsx`。

本计划 Modify 清单：`ontology/index.ts`（SHARED 词汇追加）、`scenarios.ts`、`permissionGate.ts`、`roleToolRegistry.ts`、`contextContract.ts`、`docs/tool-inventory.json`、`test/harness/toolInventory.test.ts`、`routes/index.ts 挂载区`（即 `src/index.ts`）、`navigation.ts`、`App.tsx`。

**重叠仅 `App.tsx` 一个文件**（+ `navigation.ts` 若 Item 4 后续也加视图——其当前计划未改 navigation.ts）。`App.tsx` 双方都在视图分发三元链 `: null}` 前追加分支，合并时产生文本冲突属预期，解决规则：**保留双方分支**（Item 4 的 `entities` 分支与本次的 `writeoff` 分支都保留，顺序随意）。其余文件零重叠。

---

### Task 1: 前置检查 + 分支准备

**Files:**
- Create: （无代码文件；本任务产出分支与计划提交）

**Interfaces:**
- Consumes: origin/main 基线 `8ebfe3a`
- Produces: 分支 `PengYip/writeoff-workbench`（含本计划文档的首个 commit）

- [ ] **Step 1: 前置检查——确认基线与并行分支状态**

```bash
git fetch origin main
git log --oneline -3 origin/main
git log --oneline -2 HEAD
git branch --show-current
git status --short
```

预期：origin/main 顶端为 `8ebfe3a`（或更新——若 Item 4 已先合入，记录其合入的文件，对照上方交叉检查表确认无新增重叠）。当前工作树干净。

再验证关键签名仍与计划一致（若漂移，停下按实际签名修订后续任务再继续）：

```bash
grep -n "export async function insertOntologyEdge" apps/server/src/ontology/repo.ts
grep -n "export async function listOntologyEdgesAsOf" apps/server/src/ontology/repo.ts
grep -n "SHARED_TOOL_FIELD_NAMES = " -A 6 apps/server/src/ontology/index.ts
grep -n "SETTLEMENT_RE = " apps/server/src/harness/scenarios.ts
grep -n "confirm_settlement" apps/server/src/harness/roleToolRegistry.ts
```

- [ ] **Step 2: 从 origin/main 建分支**

当前 worktree（架构设计）在 `PengYip/lineage-traverse`（其上仅有 Item 4 计划文档 commit，已安全保存在 git）。直接切换：

注意（2026-09-07 执行时更新）：实施开始时发现共享 worktree「架构设计」已被 Item 4 代理占用（`neighbors.ts` 修改中、HEAD 推进到 68098ee），checkout 被未提交变更拦截。**实际操作改为新建独立 worktree**：

```bash
git worktree add "D:/Users/yepeng/orca/workspaces/supply-chain-agent-prototype/核销工作台" -b PengYip/writeoff-workbench origin/main
```

本计划后续所有命令、文件路径均以该 worktree 为根执行；后续任务对「仓库根」的引用一律指 `D:/Users/yepeng/orca/workspaces/supply-chain-agent-prototype/核销工作台`。

- [ ] **Step 3: 基线验证**

```bash
npm install
npm run build && npm run lint && npm test
```

预期：三者全绿（与 CI 同序）。若基线即红，停止并上报，不要在红基线上开工。

- [ ] **Step 4: 提交计划文档**

```bash
git add docs/superpowers/plans/2026-09-07-writeoff-workbench.md
git commit -m "docs: writeoff-workbench 实施计划（前端路线图 Item 5）"
```

---

### Task 2: 注册表词汇扩展（工具输入字落的落点）

**Files:**
- Modify: `apps/server/src/ontology/index.ts:129-134`（`SHARED_TOOL_FIELD_NAMES` 追加）
- Test: `apps/server/test/ontology/writeoffVocab.test.ts`（新建）

**Interfaces:**
- Consumes: `SHARED_TOOL_FIELD_NAMES`（`src/ontology/index.ts`）、`toolFieldsViolations`（`src/ontology/toolOntologyMap.ts`）
- Produces: 共享词汇含 `items` / `amount` / `partial` / `batch`，供 Task 6 的 `create_writeoff` / `create_offset` inputSchema 顶层字段通过 CI 词汇门禁。

**设计说明（为什么是这几个词）**：工具形态为「一次提交 = 一次工具调用 = 一张审批单」：inputSchema 顶层是 `items: Array<{srcId, dstId, amount, partial?, batch?}>`，整单守恒校验（部分核销、多发票合并付款两个验收用例都要求服务端看到完整计划）。`srcId`/`dstId` 已在共享词汇；`items` 是结构容器词（与 `props` 同类）；`amount`/`partial`/`batch` 是 OFFSET_SETTLE/WRITE_OFF 关系 params 的既有词汇（注册表关系层已用），提升到共享词汇表供工具输入消费。

- [ ] **Step 1: 写失败测试**

```typescript
// apps/server/test/ontology/writeoffVocab.test.ts
import { describe, it, expect } from 'vitest';
import { SHARED_TOOL_FIELD_NAMES } from '../../src/ontology/index.js';
import { toolFieldsViolations } from '../../src/ontology/toolOntologyMap.js';

// writeoff 工具输入词汇落点（roadmap Item 5）：items 结构容器 + 关系 params 词汇。
// 门禁真实断言在 toolInventory.test.ts（对已挂载工具跑 toolFieldsViolations），
// 这里提前锁定词汇表内容，防止后续误删。
describe('writeoff tool vocabulary', () => {
  it('SHARED_TOOL_FIELD_NAMES contains items/amount/partial/batch', () => {
    const shared = new Set<string>(SHARED_TOOL_FIELD_NAMES);
    for (const name of ['items', 'amount', 'partial', 'batch']) {
      expect(shared.has(name), `shared vocabulary must contain "${name}"`).toBe(true);
    }
  });

  it('simulated create_writeoff top-level fields pass the vocabulary gate', () => {
    const fields = ['items', 'amount', 'partial', 'batch', 'srcId', 'dstId'];
    expect(toolFieldsViolations('__probe_writeoff__', fields)).toEqual([]);
  });
});
```

注意：`toolFieldsViolations` 对未映射工具恒返回 `[]`，所以第二个用例只有在 Task 6 把 `__probe` 类工具映射进 `toolOntologyMap` 后才有区分度——本任务先以第一个用例为红绿依据（当前 `SHARED_TOOL_FIELD_NAMES` 无这四个词，用例 1 红）。

- [ ] **Step 2: 跑测试确认失败**

```bash
npm test --workspace apps/server -- test/ontology/writeoffVocab.test.ts
```

预期：FAIL——`shared vocabulary must contain "items"`。

- [ ] **Step 3: 最小实现（追加式编辑）**

`apps/server/src/ontology/index.ts` 中（保持既有行不动，在数组末尾 `...DUAL_TIMELINE_FIELDS, ...PROVENANCE_FIELDS,` 之后追加一行）：

```typescript
// 工具输入共享词汇（结构/溯源字段, Task 4 CI 门禁用）。新工具字段先进本表或实体 schema。
export const SHARED_TOOL_FIELD_NAMES = [
  'id', 'kind', 'name', 'props',
  'srcId', 'dstId', 'documentId', 'contractNo', 'relation',
  'confidence', 'sourceSpan',
  ...DUAL_TIMELINE_FIELDS, ...PROVENANCE_FIELDS,
  // 核销工作台工具（create_writeoff/create_offset, 2026-09-07 Item 5）:
  // items=整单分配计划容器; amount/partial/batch=OFFSET_SETTLE/WRITE_OFF 关系 params 词汇。
  'items', 'amount', 'partial', 'batch',
] as const;
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npm test --workspace apps/server -- test/ontology/writeoffVocab.test.ts
```

预期：PASS。

- [ ] **Step 5: 全量回归 + 提交**

```bash
npm run build && npm run lint && npm test
git add apps/server/src/ontology/index.ts apps/server/test/ontology/writeoffVocab.test.ts
git commit -m "feat(ontology): writeoff 工具输入词汇落共享词汇表（items/amount/partial/batch）"
```

---

### Task 3: 读侧聚合——余额与模式发现（ontology/writeoff.ts）

**Files:**
- Create: `apps/server/src/ontology/writeoff.ts`
- Test: `apps/server/test/ontology/writeoff.test.ts`（新建）

**Interfaces:**
- Consumes: `listTradeFactsAsOf(ctx, pred, {entityType}, userId?)`、`listOntologyEdgesAsOf(ctx, pred, {relation}, userId?)`（`src/ontology/repo.ts`，只调用不修改）；`asOfBusinessTime(t)`（`src/ontology/asof.ts`）；`ONTOLOGY_RELATIONS`（`src/ontology/index.ts`）
- Produces（Task 5/6/7 依赖，签名逐字）:
  - `interface WriteoffBalanceRow { id: string; entityType: string; label: string; currency: string | null; amount: number; applied: number; remaining: number; validAt: string | null; status: 'none' | 'partial' | 'full' }`
  - `interface WriteoffMode { relation: string; description: string; srcTypes: string[]; dstTypes: string[]; funds: WriteoffBalanceRow[]; targets: WriteoffBalanceRow[] }`
  - `function writeoffModeRelations(): string[]` —— 模式发现规则：`ONTOLOGY_RELATIONS` 中 params 含 `amount` 且某连接对 from ∈ {PaymentEvent, CollectionEvent} 的关系（当前 = WRITE_OFF、OFFSET_SETTLE；新增同类关系自动进模式）
  - `async function listWriteoffBalances(ctx: DbContext, userId?: string): Promise<WriteoffBalanceRow[]>`
  - `async function getWriteoffOverview(ctx: DbContext, userId?: string): Promise<{ asOf: string; modes: WriteoffMode[] }>`

**语义（v1 口径，写进代码注释）**：行余额 = 单行事实金额 − 该行作为端点的全部核销类边 params.amount 之和（as-of 业务时间现在）。红冲/退款是**独立负数行**（REVERSE_ORIGIN 配对），不与本行轧差——净额视角属台账详情（Item 3 已做），工作台按行操作。`status`：`remaining <= 0.005` → full；`applied > 0.005` → partial；否则 none。浮点容差 0.005。

- [ ] **Step 1: 写失败测试**

```typescript
// apps/server/test/ontology/writeoff.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import { insertTradeFact, insertOntologyEdge } from '../../src/ontology/repo.js';
import {
  writeoffModeRelations, listWriteoffBalances, getWriteoffOverview,
} from '../../src/ontology/writeoff.js';

let ctx: DbContext;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
});

// 种子：付款 200（u1）+ 发票 A 60 / B 50 + 结算 S 80；已有核销边 p->A 40。
async function seed(u = 'u1') {
  const p = await insertTradeFact(ctx, {
    entityType: 'PaymentEvent',
    payload: { eventBizType: '正向', amount: 200, currency: 'CNY', payType: '预付' },
    validAt: '2026-06-01', createdBy: 'demo',
  }, u);
  const invA = await insertTradeFact(ctx, {
    entityType: 'InvoiceEvent',
    payload: { eventBizType: '正向', amount: 60, currency: 'CNY', invoiceNo: 'INV-A', invoiceType: '进项' },
    validAt: '2026-06-02', createdBy: 'demo',
  }, u);
  const invB = await insertTradeFact(ctx, {
    entityType: 'InvoiceEvent',
    payload: { eventBizType: '正向', amount: 50, currency: 'CNY', invoiceNo: 'INV-B', invoiceType: '进项' },
    validAt: '2026-06-03', createdBy: 'demo',
  }, u);
  const stl = await insertTradeFact(ctx, {
    entityType: 'SettlementEvent',
    payload: { eventBizType: '正向', amount: 80, currency: 'CNY' },
    validAt: '2026-06-04', createdBy: 'demo',
  }, u);
  await insertOntologyEdge(ctx, {
    relation: 'WRITE_OFF', fromType: 'PaymentEvent', fromId: p, toType: 'InvoiceEvent', toId: invA,
    params: { amount: 40, partial: true }, validAt: '2026-07-01', createdBy: 'demo',
  }, u);
  return { p, invA, invB, stl };
}

describe('writeoffModeRelations', () => {
  it('模式发现：带 amount 参数且资金侧发起的关系（映射驱动）', () => {
    expect(writeoffModeRelations()).toEqual(['OFFSET_SETTLE', 'WRITE_OFF']);
  });
});

describe('listWriteoffBalances', () => {
  it('余额 = 金额 − 核销类边累计；状态 none/partial/full', async () => {
    await seed();
    const rows = await listWriteoffBalances(ctx, 'u1');
    const byId = new Map(rows.map((r) => [r.id, r]));
    const p = rows.find((r) => r.entityType === 'PaymentEvent')!;
    expect(p.amount).toBe(200);
    expect(p.applied).toBe(40);
    expect(p.remaining).toBe(160);
    expect(p.status).toBe('partial');
    const a = byId.get((await seed.definedIds?.()) ?? '')!; // 占位防误用，见下
    void a;
  });

  it('发票行：A 已核 40/60 partial，B 未核 none；再补 20 后 B partial', async () => {
    const { invB, p } = await seed();
    const before = (await listWriteoffBalances(ctx, 'u1')).find((r) => r.id === invB)!;
    expect(before.status).toBe('none');
    expect(before.remaining).toBe(50);
    await insertOntologyEdge(ctx, {
      relation: 'WRITE_OFF', fromType: 'PaymentEvent', fromId: p, toType: 'InvoiceEvent', toId: invB,
      params: { amount: 50 }, validAt: '2026-07-02', createdBy: 'demo',
    }, 'u1');
    const after = (await listWriteoffBalances(ctx, 'u1')).find((r) => r.id === invB)!;
    expect(after.applied).toBe(50);
    expect(after.status).toBe('full');
  });

  it('用户隔离：u2 看不到 u1 的行', async () => {
    await seed('u1');
    const rows = await listWriteoffBalances(ctx, 'u2');
    expect(rows).toEqual([]);
  });
});

describe('getWriteoffOverview', () => {
  it('两模式各就各位：funds=资金行, targets=发票/结算行', async () => {
    await seed();
    const ov = await getWriteoffOverview(ctx, 'u1');
    expect(ov.modes.map((m) => m.relation)).toEqual(['OFFSET_SETTLE', 'WRITE_OFF']);
    const wo = ov.modes.find((m) => m.relation === 'WRITE_OFF')!;
    expect(wo.srcTypes).toEqual(['PaymentEvent', 'CollectionEvent']);
    expect(wo.dstTypes).toEqual(['InvoiceEvent']);
    expect(wo.funds.map((f) => f.entityType)).toEqual(['PaymentEvent']);
    expect(wo.targets.map((t) => t.label)).toContain('INV-A');
    const os = ov.modes.find((m) => m.relation === 'OFFSET_SETTLE')!;
    expect(os.dstTypes).toEqual(['SettlementEvent']);
    expect(os.targets.map((t) => t.entityType)).toEqual(['SettlementEvent']);
  });
});
```

注意：第一个用例里有一行占位注释（`seed.definedIds`）——实现时**删除那三行**，直接改为对付款行断言（保留上文已写的断言即可）。测试文件最终形态不应含占位代码。

- [ ] **Step 2: 跑测试确认失败**

```bash
npm test --workspace apps/server -- test/ontology/writeoff.test.ts
```

预期：FAIL——`Cannot find module '../../src/ontology/writeoff.js'`。

- [ ] **Step 3: 实现 `apps/server/src/ontology/writeoff.ts`**

```typescript
// 核销工作台读侧（roadmap Item 5）：余额聚合 + 模式发现。
// 独立文件，不改动 repo.ts / projection.ts（与 Item 4 并行开发的分区约定）。
// v1 口径：行余额 = 事实金额 − 该行作为端点的核销类边 amount 累计（业务时间 as-of 现在）。
// 红冲/退款是独立负数行，不轧差进本行；净额视角属台账详情（Item 3）。
import type { DbContext } from '../pipeline/db/client.js';
import {
  listTradeFactsAsOf, listOntologyEdgesAsOf, type TradeFactRow,
} from './repo.js';
import { asOfBusinessTime } from './asof.js';
import { ONTOLOGY_RELATIONS, ENTITY_LABELS } from './index.js';

/** 资金侧实体（模式发现的种子口径：from ∈ 资金侧且 params 带 amount 的关系 = 核销类）。 */
const FUND_ENTITY_TYPES: ReadonlySet<string> = new Set(['PaymentEvent', 'CollectionEvent']);
/** 余额聚合纳入的实体（资金 + 发票 + 结算）。 */
const BALANCE_ENTITY_TYPES: ReadonlySet<string> = new Set([
  'PaymentEvent', 'CollectionEvent', 'InvoiceEvent', 'SettlementEvent',
]);
const EPSILON = 0.005;

export interface WriteoffBalanceRow {
  id: string;
  entityType: string;
  label: string;
  currency: string | null;
  amount: number;
  applied: number;
  remaining: number;
  validAt: string | null;
  status: 'none' | 'partial' | 'full';
}

export interface WriteoffMode {
  relation: string;
  description: string;
  srcTypes: string[];
  dstTypes: string[];
  funds: WriteoffBalanceRow[];
  targets: WriteoffBalanceRow[];
}

/** 核销类关系发现（映射驱动）：params 含 amount 且存在资金侧发起连接对。 */
export function writeoffModeRelations(): string[] {
  return ONTOLOGY_RELATIONS
    .filter((r) => 'amount' in r.params.shape)
    .filter((r) => r.pairs.some((p) => FUND_ENTITY_TYPES.has(p.from)))
    .map((r) => r.name);
}

/** 行主标签：发票号优先，其次实体中文标签 + 短 id。 */
function factLabel(fact: TradeFactRow): string {
  const payload = fact.payload as Record<string, unknown>;
  const invoiceNo = payload['invoiceNo'];
  if (typeof invoiceNo === 'string' && invoiceNo) return invoiceNo;
  return `${ENTITY_LABELS[fact.entityType as keyof typeof ENTITY_LABELS] ?? fact.entityType} ${fact.id.slice(-6)}`;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** 全量余额行（资金/发票/结算），applied = 核销类边 amount 按端点累计。 */
export async function listWriteoffBalances(
  ctx: DbContext, userId?: string,
): Promise<WriteoffBalanceRow[]> {
  const now = new Date().toISOString();
  const pred = asOfBusinessTime(now);
  const relations = writeoffModeRelations();

  const facts: TradeFactRow[] = [];
  for (const entityType of BALANCE_ENTITY_TYPES) {
    facts.push(...await listTradeFactsAsOf(ctx, pred, { entityType }, userId));
  }

  // 端点 -> 累计核销额（from 与 to 端点都计：资金在 from，发票/结算在 to）。
  const appliedById = new Map<string, number>();
  for (const relation of relations) {
    const edges = await listOntologyEdgesAsOf(ctx, pred, { relation }, userId);
    for (const e of edges) {
      const amount = num(e.params['amount']) ?? 0;
      for (const endpoint of [e.fromId, e.toId]) {
        appliedById.set(endpoint, (appliedById.get(endpoint) ?? 0) + amount);
      }
    }
  }

  return facts.map((f) => {
    const amount = num((f.payload as Record<string, unknown>)['amount']) ?? 0;
    const applied = appliedById.get(f.id) ?? 0;
    const remaining = amount - applied;
    const status: WriteoffBalanceRow['status'] =
      remaining <= EPSILON ? 'full' : applied > EPSILON ? 'partial' : 'none';
    return {
      id: f.id,
      entityType: f.entityType,
      label: factLabel(f),
      currency: (typeof (f.payload as Record<string, unknown>)['currency'] === 'string'
        ? ((f.payload as Record<string, unknown>)['currency'] as string) : null),
      amount, applied, remaining,
      validAt: f.validAt ?? null,
      status,
    };
  });
}

/** 工作台总览：按发现的关系分模式，两侧列表就位。 */
export async function getWriteoffOverview(
  ctx: DbContext, userId?: string,
): Promise<{ asOf: string; modes: WriteoffMode[] }> {
  const rows = await listWriteoffBalances(ctx, userId);
  const modes: WriteoffMode[] = writeoffModeRelations().map((name) => {
    const def = ONTOLOGY_RELATIONS.find((r) => r.name === name)!;
    const srcTypes = [...new Set(def.pairs.map((p) => p.from))];
    const dstTypes = [...new Set(def.pairs.map((p) => p.to))];
    return {
      relation: name,
      description: def.description,
      srcTypes,
      dstTypes,
      funds: rows.filter((r) => srcTypes.includes(r.entityType)),
      targets: rows.filter((r) => dstTypes.includes(r.entityType)),
    };
  });
  return { asOf: new Date().toISOString(), modes };
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npm test --workspace apps/server -- test/ontology/writeoff.test.ts
```

预期：PASS（记得先删掉第一个用例中的三行占位）。

- [ ] **Step 5: 全量回归 + 提交**

```bash
npm run build && npm run lint && npm test
git add apps/server/src/ontology/writeoff.ts apps/server/test/ontology/writeoff.test.ts
git commit -m "feat(ontology): writeoff 读侧聚合——余额/状态/模式发现（独立文件）"
```

---

### Task 4: 守恒校验服务层（validateAllocationPlan）

**Files:**
- Modify: `apps/server/src/ontology/writeoff.ts`（文件末尾追加）
- Test: `apps/server/test/ontology/writeoff.test.ts`（追加 describe）

**Interfaces:**
- Consumes: Task 3 的 `listWriteoffBalances`；`isRelationPairAllowed`（`src/ontology/index.ts`）
- Produces（Task 6 工具 execute 与 Task 7 提交路由共同依赖，签名逐字）:
  - `interface AllocationItem { srcId: string; dstId: string; amount: number; partial?: boolean; batch?: string }`
  - `interface AllocationViolation { itemIndex: number; code: 'non_positive' | 'unknown_fact' | 'pair_not_allowed' | 'src_over_remaining' | 'dst_over_remaining'; detail: string }`
  - `async function validateAllocationPlan(ctx: DbContext, relation: string, items: AllocationItem[], userId?: string): Promise<AllocationViolation[]>`（空数组 = 通过）

**校验规则（spec 金额校验 + 守恒）**：
1. `amount` 必须为正（non_positive；zod 已拦格式，这里兜底）。
2. src/dst 必须是已知事实行（unknown_fact）。
3. `isRelationPairAllowed(relation, srcType, dstType)`（pair_not_allowed）。
4. **同一计划内按 src 累计** ≤ 该资金行 remaining（src_over_remaining）——多发票合并付款守恒。
5. **同一计划内按 dst 累计** ≤ 该目标行 remaining（dst_over_remaining）——冲抵不超结算额/发票余额。

- [ ] **Step 1: 写失败测试（在 writeoff.test.ts 末尾追加）**

```typescript
import { validateAllocationPlan } from '../../src/ontology/writeoff.js';

describe('validateAllocationPlan（守恒校验）', () => {
  it('部分核销：60/100 通过', async () => {
    const { p, invA } = await seed();
    const v = await validateAllocationPlan(ctx, 'WRITE_OFF',
      [{ srcId: p, dstId: invA, amount: 40 }], 'u1');
    expect(v).toEqual([]);
  });

  it('多发票合并付款：Σ分配 ≤ 资金余额 通过；超了报 src_over_remaining', async () => {
    const { p, invA, invB } = await seed(); // p remaining 160（已核 40）
    const ok = await validateAllocationPlan(ctx, 'WRITE_OFF', [
      { srcId: p, dstId: invA, amount: 20 },
      { srcId: p, dstId: invB, amount: 50 },
    ], 'u1');
    expect(ok).toEqual([]);
    // invA remaining 20: 20+? ；资金侧 160+1 超额
    const over = await validateAllocationPlan(ctx, 'WRITE_OFF', [
      { srcId: p, dstId: invA, amount: 20 },
      { srcId: p, dstId: invB, amount: 50 },
      { srcId: p, dstId: invB, amount: 91 },
    ], 'u1');
    expect(over.map((x) => x.code)).toContain('src_over_remaining');
  });

  it('dst 超余额：发票 A 仅剩 20，分配 70 报 dst_over_remaining', async () => {
    const { p, invA } = await seed();
    const v = await validateAllocationPlan(ctx, 'WRITE_OFF',
      [{ srcId: p, dstId: invA, amount: 70 }], 'u1');
    expect(v.map((x) => x.code)).toEqual(['dst_over_remaining']);
  });

  it('冲抵不超结算额：OFFSET_SETTLE 对 Settlement 校验；错向连接报 pair_not_allowed', async () => {
    const { p, stl, invA } = await seed();
    const ok = await validateAllocationPlan(ctx, 'OFFSET_SETTLE',
      [{ srcId: p, dstId: stl, amount: 80 }], 'u1');
    expect(ok).toEqual([]);
    const bad = await validateAllocationPlan(ctx, 'OFFSET_SETTLE',
      [{ srcId: p, dstId: invA, amount: 10 }], 'u1');
    expect(bad.map((x) => x.code)).toEqual(['pair_not_allowed']);
  });

  it('未知事实/非正数/跨用户隔离', async () => {
    const { p, invA } = await seed();
    expect((await validateAllocationPlan(ctx, 'WRITE_OFF',
      [{ srcId: p, dstId: invA, amount: 0 }], 'u1')).map((x) => x.code)).toEqual(['non_positive']);
    expect((await validateAllocationPlan(ctx, 'WRITE_OFF',
      [{ srcId: 'TF-nope', dstId: invA, amount: 5 }], 'u1')).map((x) => x.code)).toEqual(['unknown_fact']);
    // u2 看不见 u1 的事实行 -> unknown_fact（隔离即校验）
    expect((await validateAllocationPlan(ctx, 'WRITE_OFF',
      [{ srcId: p, dstId: invA, amount: 5 }], 'u2')).map((x) => x.code)).toEqual(['unknown_fact', 'unknown_fact']);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npm test --workspace apps/server -- test/ontology/writeoff.test.ts
```

预期：FAIL——`validateAllocationPlan` 未导出。

- [ ] **Step 3: 实现（writeoff.ts 末尾追加）**

```typescript
import { isRelationPairAllowed } from './index.js'; // 合并进文件顶部既有 import

export interface AllocationItem {
  srcId: string;
  dstId: string;
  amount: number;
  partial?: boolean;
  batch?: string;
}

export interface AllocationViolation {
  itemIndex: number;
  code: 'non_positive' | 'unknown_fact' | 'pair_not_allowed' | 'src_over_remaining' | 'dst_over_remaining';
  detail: string;
}

/** 整单守恒校验：提交路由（预检）与工具 execute（权威）共用。
 *  规则见计划 Task 4：正数 -> 事实存在 -> 连接对合法 -> 同单按 src/dst 累计不超各自 remaining。 */
export async function validateAllocationPlan(
  ctx: DbContext, relation: string, items: AllocationItem[], userId?: string,
): Promise<AllocationViolation[]> {
  const violations: AllocationViolation[] = [];
  const rows = await listWriteoffBalances(ctx, userId);
  const byId = new Map(rows.map((r) => [r.id, r]));

  const srcUsed = new Map<string, number>();
  const dstUsed = new Map<string, number>();

  items.forEach((item, i) => {
    if (!(item.amount > 0)) {
      violations.push({ itemIndex: i, code: 'non_positive', detail: `分配额必须为正数, got ${item.amount}` });
    }
    const src = byId.get(item.srcId);
    const dst = byId.get(item.dstId);
    if (!src) violations.push({ itemIndex: i, code: 'unknown_fact', detail: `资金行 ${item.srcId} 不存在或不属于当前用户` });
    if (!dst) violations.push({ itemIndex: i, code: 'unknown_fact', detail: `目标行 ${item.dstId} 不存在或不属于当前用户` });
    if (src && dst && !isRelationPairAllowed(relation, src.entityType, dst.entityType)) {
      violations.push({
        itemIndex: i, code: 'pair_not_allowed',
        detail: `${relation} 不允许 ${src.entityType} -> ${dst.entityType}`,
      });
    }
    if (src) {
      const used = (srcUsed.get(item.srcId) ?? 0) + item.amount;
      srcUsed.set(item.srcId, used);
      if (used > src.remaining + EPSILON) {
        violations.push({
          itemIndex: i, code: 'src_over_remaining',
          detail: `资金行 ${src.label} 累计分配 ${used} 超余额 ${src.remaining}`,
        });
      }
    }
    if (dst) {
      const used = (dstUsed.get(item.dstId) ?? 0) + item.amount;
      dstUsed.set(item.dstId, used);
      if (used > dst.remaining + EPSILON) {
        violations.push({
          itemIndex: i, code: 'dst_over_remaining',
          detail: `目标行 ${dst.label} 累计分配 ${used} 超余额 ${dst.remaining}`,
        });
      }
    }
  });
  return violations;
}
```

（实现时把 `isRelationPairAllowed` 加进文件顶部对 `./index.js` 的既有 import，不要出现两个 import 语句。）

- [ ] **Step 4: 跑测试确认通过**

```bash
npm test --workspace apps/server -- test/ontology/writeoff.test.ts
```

预期：PASS。

- [ ] **Step 5: 全量回归 + 提交**

```bash
npm run build && npm run lint && npm test
git add apps/server/src/ontology/writeoff.ts apps/server/test/ontology/writeoff.test.ts
git commit -m "feat(ontology): writeoff 整单守恒校验（部分核销/多发票合并付款规则）"
```

---

### Task 5: 只读路由 `GET /api/writeoff/overview` + 挂载

**Files:**
- Create: `apps/server/src/routes/writeoff.ts`
- Modify: `apps/server/src/index.ts:132` 附近（requireAuth 区追加一行）、`apps/server/src/index.ts:170` 附近（route 挂载区追加一行 + 顶部 import）
- Test: `apps/server/test/routes/writeoffRoutes.test.ts`（新建）

**Interfaces:**
- Consumes: `getWriteoffOverview`（Task 3）、`AuthEnv`（`src/lib/auth-middleware.js`）、`getDbContext`（`src/pipeline/db/dbBackend.js`）
- Produces: `export const writeoffRoute = new Hono<AuthEnv>()`（GET `/overview` 返回 `{ asOf, modes }`，401 无会话）——Task 7 在同文件追加 POST `/submit`

- [ ] **Step 1: 写失败测试（ctxHolder 模式，照抄 ontologyEntities.test.ts）**

```typescript
// apps/server/test/routes/writeoffRoutes.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import type { AuthEnv } from '../../src/lib/auth-middleware.js';

const { ctxHolder } = vi.hoisted(() => ({ ctxHolder: { current: null as DbContext | null } }));
vi.mock('../../src/pipeline/db/dbBackend.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/pipeline/db/dbBackend.js')>();
  return { ...mod, getDbContext: () => ctxHolder.current };
});
const { writeoffRoute } = await import('../../src/routes/writeoff.js');
const { insertTradeFact, insertOntologyEdge } = await import('../../src/ontology/repo.js');

function appAs(userId: string) {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { id: userId, email: 't@t', role: 'trader' } as never);
    await next();
  });
  app.route('/api/writeoff', writeoffRoute);
  return app;
}

let ctx: DbContext;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
  ctxHolder.current = ctx;
});

describe('GET /api/writeoff/overview', () => {
  it('401 without session', async () => {
    const app = new Hono<AuthEnv>();
    app.route('/api/writeoff', writeoffRoute);
    const res = await app.request('http://test/api/writeoff/overview');
    expect(res.status).toBe(401);
  });

  it('返回模式与两侧余额行', async () => {
    const p = await insertTradeFact(ctx, {
      entityType: 'PaymentEvent',
      payload: { eventBizType: '正向', amount: 100, currency: 'CNY', payType: '尾款' },
      validAt: '2026-06-01', createdBy: 'demo',
    }, 'u1');
    const inv = await insertTradeFact(ctx, {
      entityType: 'InvoiceEvent',
      payload: { eventBizType: '正向', amount: 100, currency: 'CNY', invoiceNo: 'INV-X', invoiceType: '进项' },
      validAt: '2026-06-02', createdBy: 'demo',
    }, 'u1');
    await insertOntologyEdge(ctx, {
      relation: 'WRITE_OFF', fromType: 'PaymentEvent', fromId: p, toType: 'InvoiceEvent', toId: inv,
      params: { amount: 30, partial: true }, validAt: '2026-07-01', createdBy: 'demo',
    }, 'u1');
    const res = await appAs('u1').request('http://test/api/writeoff/overview');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      modes: Array<{
        relation: string; funds: Array<{ remaining: number; status: string }>;
        targets: Array<{ label: string; applied: number }>;
      }>;
    };
    const wo = body.modes.find((m) => m.relation === 'WRITE_OFF')!;
    expect(wo.funds[0]!.remaining).toBe(70);
    expect(wo.funds[0]!.status).toBe('partial');
    expect(wo.targets[0]!.label).toBe('INV-X');
    expect(wo.targets[0]!.applied).toBe(30);
  });

  it('空数据不报错（空模式列表行）', async () => {
    const res = await appAs('u1').request('http://test/api/writeoff/overview');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { modes: unknown[] };
    expect(body.modes.map((m) => (m as { relation: string }).relation)).toEqual(['OFFSET_SETTLE', 'WRITE_OFF']);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npm test --workspace apps/server -- test/routes/writeoffRoutes.test.ts
```

预期：FAIL——模块 `../../src/routes/writeoff.js` 不存在。

- [ ] **Step 3: 实现 `apps/server/src/routes/writeoff.ts`（本任务先只含 GET）**

```typescript
// 核销工作台路由（roadmap Item 5）：GET /overview 只读聚合。
// 挂载：index.ts `app.use('/api/writeoff/*', requireAuth)` + `app.route('/api/writeoff', writeoffRoute)`。
// 独立文件（与 Item 4 并行分区约定：不改 routes/ontology.ts）。
import { Hono } from 'hono';
import type { AuthEnv } from '../lib/auth-middleware.js';
import { getDbContext } from '../pipeline/db/dbBackend.js';
import { getWriteoffOverview } from '../ontology/writeoff.js';

export const writeoffRoute = new Hono<AuthEnv>();

writeoffRoute.use('*', async (c, next) => {
  if (!c.get('user')) return c.json({ error: 'unauthorized' }, 401);
  await next();
});

writeoffRoute.get('/overview', async (c) => {
  const user = c.get('user')!;
  try {
    const overview = await getWriteoffOverview(getDbContext(), user.id);
    return c.json(overview);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error('[writeoff] overview failed:', detail);
    return c.json({ error: 'overview failed', detail }, 500);
  }
});
```

`apps/server/src/index.ts` 三处追加式编辑（对照 ontology 的既有两行照抄）：

顶部 import 区（`import { ontologyRoute } ...` 之后加一行）：
```typescript
import { writeoffRoute } from './routes/writeoff.js';
```
requireAuth 区（`app.use('/api/ontology/*', requireAuth);` 之后加一行）：
```typescript
app.use('/api/writeoff/*', requireAuth);
```
挂载区（`app.route('/api/ontology', ontologyRoute);` 之后加一行）：
```typescript
app.route('/api/writeoff', writeoffRoute);
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npm test --workspace apps/server -- test/routes/writeoffRoutes.test.ts
```

预期：PASS。

- [ ] **Step 5: 全量回归 + 提交**

```bash
npm run build && npm run lint && npm test
git add apps/server/src/routes/writeoff.ts apps/server/src/index.ts apps/server/test/routes/writeoffRoutes.test.ts
git commit -m "feat(writeoff): GET /api/writeoff/overview 只读聚合路由（requireAuth 挂载）"
```

---

### Task 6: L2 工具面——inventory 登记 + 工具实现 + 五处注册表接线

**Files:**
- Modify: `docs/tool-inventory.json`（`confirm_settlement` 条目后追加两条）
- Create: `apps/server/src/ontology/writeoffTools.ts`
- Modify: `apps/server/src/harness/permissionGate.ts`（L2 注册区追加两行）
- Modify: `apps/server/src/harness/contextContract.ts`（TOOL_CONTEXT_CONTRACTS 追加两条）
- Modify: `apps/server/src/harness/roleToolRegistry.ts`（import + TRADER_CTX_TOOL_NAMES 追加 + ctx 块追加两次 push）
- Modify: `apps/server/src/harness/scenarios.ts`（SETTLEMENT 数组追加 + SETTLEMENT_RE 扩词）
- Modify: `apps/server/src/ontology/toolOntologyMap.ts`（映射追加两条）
- Modify: `apps/server/test/harness/toolInventory.test.ts:153`（`exactly 3 tools` → `exactly 5 tools`）
- Test: `apps/server/test/ontology/writeoffTools.test.ts`（新建）

**Interfaces:**
- Consumes: `tool()`（ai，v6 `inputSchema`）；`insertOntologyEdge`（repo.ts）；`validateAllocationPlan` / `AllocationItem`（Task 4）；`getTradeFactById`（repo.ts）；`DbContext`
- Produces:
  - `buildCreateWriteoffTool(deps: { ctx: DbContext; userId?: string })` / `buildCreateOffsetTool(deps)` —— tool 名 `create_writeoff` / `create_offset`
  - 工具返回：成功 `{ status: 'ok', relation, edges: Array<{ edgeId, srcId, dstId, amount }>, totalAmount }`；校验失败 `{ status: 'invalid', violations: AllocationViolation[] }`
- **场景坑（本任务为什么动 scenarios.ts）**：`RunSessionOpts` 无 scenario 透传，`runStream` 用 `detectScenario(最后一条用户消息)` 窄化 activeTools。提交指令与审批恢复轮次的最后一条用户消息都是我们的固定指令文本——必须让 `核销|冲抵|票款` 命中 SETTLEMENT_RE，且两工具必须进 SETTLEMENT 集，否则**恢复轮次看不见工具、批准后无法重执行**。SETTLEMENT 现为 8 个（CORE 5 + 3），加 2 = 10 ≤ cap 11。

- [ ] **Step 1: 先登记 tool-inventory.json（流程第一步，CI 门禁顺序）**

在 `confirm_settlement` 条目的 `}` 后追加（注意上一条末尾补逗号）：

```json
    {
      "name": "create_writeoff",
      "layer": "执行",
      "level": "L2",
      "status": "active",
      "mount": "always",
      "whenToUse": "票款核销工作台提交后执行：收付资金与发票之间建立 WRITE_OFF 带参边（多对多/部分金额/分批），一次调用携带整单分配计划。",
      "boundary": "L2 需审批中心批准后才落边；items 必须逐字来自工作台提交，禁止模型自行改数；服务端整单守恒校验失败即拒绝落库；不做自动核销建议、不跨币种。",
      "rationale": "自由数字输入不适合对话承载（roadmap Item 5），工作台结构化输入 + L2 工具审计写入是核销唯一入口；整单提交保证守恒校验原子性。"
    },
    {
      "name": "create_offset",
      "layer": "执行",
      "level": "L2",
      "status": "active",
      "mount": "always",
      "whenToUse": "预付冲抵工作台提交后执行：付款/收款与结算之间建立 OFFSET_SETTLE 带参边，一次调用携带整单分配计划。",
      "boundary": "L2 需审批中心批准后才落边；冲抵额不超结算余额（服务端校验）；items 逐字来自工作台提交，禁止模型改数。",
      "rationale": "与 create_writeoff 同族（冲抵语义），独立工具保持关系语义显式、审计单据可读。"
    }
```

- [ ] **Step 2: 写失败测试（工具 execute 行为）**

```typescript
// apps/server/test/ontology/writeoffTools.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import { insertTradeFact, insertOntologyEdge, listOntologyEdgesAsOf } from '../../src/ontology/repo.js';
import { asOfBusinessTime } from '../../src/ontology/asof.js';
import { buildCreateWriteoffTool, buildCreateOffsetTool } from '../../src/ontology/writeoffTools.js';

let ctx: DbContext;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
});

async function seed(u = 'u1') {
  const p = await insertTradeFact(ctx, {
    entityType: 'PaymentEvent',
    payload: { eventBizType: '正向', amount: 200, currency: 'CNY', payType: '预付' },
    validAt: '2026-06-01', createdBy: 'demo',
  }, u);
  const invA = await insertTradeFact(ctx, {
    entityType: 'InvoiceEvent',
    payload: { eventBizType: '正向', amount: 60, currency: 'CNY', invoiceNo: 'INV-A', invoiceType: '进项' },
    validAt: '2026-06-02', createdBy: 'demo',
  }, u);
  const invB = await insertTradeFact(ctx, {
    entityType: 'InvoiceEvent',
    payload: { eventBizType: '正向', amount: 50, currency: 'CNY', invoiceNo: 'INV-B', invoiceType: '进项' },
    validAt: '2026-06-03', createdBy: 'demo',
  }, u);
  return { p, invA, invB };
}

describe('create_writeoff execute', () => {
  it('整单落边：params 含 amount/partial/batch，createdBy=工具名，user_id 隔离', async () => {
    const { p, invA, invB } = await seed();
    const t = buildCreateWriteoffTool({ ctx, userId: 'u1' });
    const out = await t.execute!({
      items: [
        { srcId: p, dstId: invA, amount: 60 },
        { srcId: p, dstId: invB, amount: 40, partial: true, batch: 'B-2026-01' },
      ],
    }, { toolCallId: 'call_test_1', messages: [] } as never);
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    expect(out.totalAmount).toBe(100);
    expect(out.edges).toHaveLength(2);
    const edges = await listOntologyEdgesAsOf(ctx, asOfBusinessTime(new Date().toISOString()), { relation: 'WRITE_OFF' }, 'u1');
    expect(edges).toHaveLength(2);
    const eb = edges.find((e) => e.toId === invB)!;
    expect(eb.params).toEqual({ amount: 40, partial: true, batch: 'B-2026-01' });
    expect(eb.createdBy).toBe('create_writeoff');
  });

  it('守恒失败：整单拒绝、零边产生（多发票合并付款超资金余额）', async () => {
    const { p, invA, invB } = await seed();
    const t = buildCreateWriteoffTool({ ctx, userId: 'u1' });
    const out = await t.execute!({
      items: [
        { srcId: p, dstId: invA, amount: 60 },
        { srcId: p, dstId: invB, amount: 50 },
        { srcId: p, dstId: invA, amount: 91 },
      ],
    }, { toolCallId: 'call_test_2', messages: [] } as never);
    expect(out.status).toBe('invalid');
    if (out.status !== 'invalid') return;
    expect(out.violations.map((v: { code: string }) => v.code)).toContain('src_over_remaining');
    const edges = await listOntologyEdgesAsOf(ctx, asOfBusinessTime(new Date().toISOString()), { relation: 'WRITE_OFF' }, 'u1');
    expect(edges).toEqual([]);
  });

  it('inputSchema 拒绝非正数（zod 层）', async () => {
    const t = buildCreateWriteoffTool({ ctx, userId: 'u1' });
    const parsed = t.inputSchema.safeParse({ items: [{ srcId: 'a', dstId: 'b', amount: -5 }] });
    expect(parsed.success).toBe(false);
  });
});

describe('create_offset execute', () => {
  it('OFFSET_SETTLE 落边 + 错向连接被 pair 白名单拒绝', async () => {
    const { p, invA } = await seed();
    const stl = await insertTradeFact(ctx, {
      entityType: 'SettlementEvent',
      payload: { eventBizType: '正向', amount: 80, currency: 'CNY' },
      validAt: '2026-06-04', createdBy: 'demo',
    }, 'u1');
    const t = buildCreateOffsetTool({ ctx, userId: 'u1' });
    const ok = await t.execute!({ items: [{ srcId: p, dstId: stl, amount: 80 }] },
      { toolCallId: 'call_test_3', messages: [] } as never);
    expect(ok.status).toBe('ok');
    // Payment -> Invoice 对 OFFSET_SETTLE 非法连接对
    const bad = await t.execute!({ items: [{ srcId: p, dstId: invA, amount: 10 }] },
      { toolCallId: 'call_test_4', messages: [] } as never);
    expect(bad.status).toBe('invalid');
    if (bad.status !== 'invalid') return;
    expect(bad.violations.map((v: { code: string }) => v.code)).toContain('pair_not_allowed');
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

```bash
npm test --workspace apps/server -- test/ontology/writeoffTools.test.ts
```

预期：FAIL——`writeoffTools.js` 不存在。

- [ ] **Step 4: 实现 `apps/server/src/ontology/writeoffTools.ts`**

```typescript
// 核销工作台 L2 工具（roadmap Item 5）：create_writeoff / create_offset。
// 一次调用 = 一张审批单 = 整单守恒校验后落 N 条带参边。
// numbers 铁律：items 逐字来自工作台提交（提交路由指令强制），execute 端
// validateAllocationPlan 是权威校验（余额/守恒以 DB 为准），失败整单拒绝零边产生。
// 批准后 execute 自动落 side_effect_results 审计（harness/agent.ts L2 gated wrapper，
// 审批中心 Task 7 已落地），本文件无需自理审计。
import { tool } from 'ai';
import { z } from 'zod';
import type { DbContext } from '../pipeline/db/client.js';
import { insertOntologyEdge, getTradeFactById } from './repo.js';
import { validateAllocationPlan, type AllocationItem, type AllocationViolation } from './writeoff.js';

const itemSchema = z.object({
  srcId: z.string().min(1).describe('资金行 id（PaymentEvent/CollectionEvent 事实 id，工作台提交原样传递）'),
  dstId: z.string().min(1).describe('目标行 id（InvoiceEvent 或 SettlementEvent 事实 id，原样传递）'),
  amount: z.number().positive().describe('分配金额（正数；累计不超两端余额）'),
  partial: z.boolean().optional().describe('部分核销标记（金额小于资金行余额时为 true）'),
  batch: z.string().optional().describe('批次标识（分批核销时由工作台生成）'),
});

export function buildCreateWriteoffTool(deps: { ctx: DbContext; userId?: string }) {
  return tool({
    description:
      '票款核销：在收付资金与发票之间建立 WRITE_OFF 带参边（多对多/部分金额/分批）。' +
      '仅在工作台提交指令中调用，items 数组必须逐字传递指令中的 JSON，禁止修改/四舍五入/拆并任何数字。' +
      '服务端按 DB 余额做整单守恒校验，任一条超额则整单拒绝、零边产生。',
    inputSchema: z.object({
      items: z.array(itemSchema).min(1).max(50).describe('整单分配计划（srcId/dstId/amount 逐字来自工作台提交）'),
    }),
    execute: async ({ items }) => {
      return executeWriteoffEdges(deps, 'WRITE_OFF', 'create_writeoff', items);
    },
  });
}

export function buildCreateOffsetTool(deps: { ctx: DbContext; userId?: string }) {
  return tool({
    description:
      '预付冲抵：在付款/收款与结算之间建立 OFFSET_SETTLE 带参边。' +
      '仅在工作台提交指令中调用，items 必须逐字传递，冲抵额累计不超结算余额（服务端校验）。',
    inputSchema: z.object({
      items: z.array(itemSchema).min(1).max(50).describe('整单冲抵计划（逐字来自工作台提交）'),
    }),
    execute: async ({ items }) => {
      return executeWriteoffEdges(deps, 'OFFSET_SETTLE', 'create_offset', items);
    },
  });
}

async function executeWriteoffEdges(
  deps: { ctx: DbContext; userId?: string },
  relation: 'WRITE_OFF' | 'OFFSET_SETTLE',
  toolName: 'create_writeoff' | 'create_offset',
  items: AllocationItem[],
): Promise<
  | { status: 'ok'; relation: string; edges: Array<{ edgeId: string; srcId: string; dstId: string; amount: number }>; totalAmount: number }
  | { status: 'invalid'; violations: AllocationViolation[] }
> {
  const violations = await validateAllocationPlan(deps.ctx, relation, items, deps.userId);
  if (violations.length > 0) return { status: 'invalid', violations };

  const edges: Array<{ edgeId: string; srcId: string; dstId: string; amount: number }> = [];
  let totalAmount = 0;
  const now = new Date();
  for (const item of items) {
    // 事实行存在性已由 validateAllocationPlan 保证；这里取 entityType 供连接对写入。
    const src = await getTradeFactById(deps.ctx, item.srcId, deps.userId);
    const dst = await getTradeFactById(deps.ctx, item.dstId, deps.userId);
    if (!src || !dst) {
      return { status: 'invalid', violations: [{ itemIndex: items.indexOf(item), code: 'unknown_fact', detail: '事实行在写入时消失' }] };
    }
    const params: Record<string, unknown> = { amount: item.amount };
    if (item.partial !== undefined) params['partial'] = item.partial;
    if (item.batch !== undefined) params['batch'] = item.batch;
    const edgeId = await insertOntologyEdge(deps.ctx, {
      relation,
      fromType: src.entityType as never,
      fromId: item.srcId,
      toType: dst.entityType as never,
      toId: item.dstId,
      params,
      validAt: now,
      createdBy: toolName,
    }, deps.userId);
    edges.push({ edgeId, srcId: item.srcId, dstId: item.dstId, amount: item.amount });
    totalAmount += item.amount;
  }
  return { status: 'ok', relation, edges, totalAmount };
}
```

- [ ] **Step 5: 五处注册表接线（全部追加式）**

5a. `apps/server/src/harness/permissionGate.ts`（L2 注册区末尾、`gather_settlement_evidence` 行附近之后追加）：
```typescript
registerPermission('create_writeoff', 'L2'); // 2026-09-07 Item 5: 票款核销落边（工作台提交，需审批）
registerPermission('create_offset', 'L2'); // 2026-09-07 Item 5: 预付冲抵落边（工作台提交，需审批）
```

5b. `apps/server/src/harness/contextContract.ts`（TOOL_CONTEXT_CONTRACTS 末尾追加）：
```typescript
  // 2026-09-07 Item 5 核销工作台: 工作台结构化输入(可信数字, 非文档派生文本) ->
  // output 'raw' / injection 'safe'; 返回短 handle 列表 -> budget 'full'。
  // 落 ontology_edges SSOT -> signal 'env', persist 'business'。L2 软门控。
  create_writeoff: {
    output: 'raw', budget: 'full', signal: 'env',
    persist: 'business', risk: { level: 'L2', injection: 'safe' },
  },
  create_offset: {
    output: 'raw', budget: 'full', signal: 'env',
    persist: 'business', risk: { level: 'L2', injection: 'safe' },
  },
```

5c. `apps/server/src/harness/roleToolRegistry.ts`：
- 顶部 import 区追加：`import { buildCreateWriteoffTool, buildCreateOffsetTool } from '../ontology/writeoffTools.js';`
- `TRADER_CTX_TOOL_NAMES` 数组末尾追加 `'create_writeoff', 'create_offset'`
- `if (deps?.ctx)` 块内（`manage_quota` push 之后、块结束前）追加：
```typescript
      // writeoff tools are L2 (2026-09-07 Item 5): 核销工作台提交经 Agent 落带参边,
      // needsApproval 走审批中心; execute 内做整单守恒校验。
      base.push(
        { ...buildCreateWriteoffTool({ ctx, userId }), name: 'create_writeoff', needsApproval: true },
        { ...buildCreateOffsetTool({ ctx, userId }), name: 'create_offset', needsApproval: true },
      );
```

5d. `apps/server/src/harness/scenarios.ts`：
- `SETTLEMENT` 数组追加 `'create_writeoff', 'create_offset'`（8 → 10，cap 11 内）
- `SETTLEMENT_RE` 扩词（**提交指令与审批恢复都靠它命中 settlement 场景**）：
```typescript
const SETTLEMENT_RE = /结算|扣款|额度|对账|质保金|煤款结算|结算单|暂估|货值|核销|冲抵|票款/;
```

5e. `apps/server/src/ontology/toolOntologyMap.ts`（映射追加，`bind_document` 之后）：
```typescript
  create_writeoff: {
    entities: ['PaymentEvent', 'CollectionEvent', 'InvoiceEvent', 'SettlementEvent'],
    note: '核销工作台(2026-09-07 Item 5): items 容器+关系 params 词汇(amount/partial/batch)属共享词汇; srcId/dstId 属共享引用词汇',
  },
  create_offset: {
    entities: ['PaymentEvent', 'CollectionEvent', 'SettlementEvent'],
    note: '预付冲抵工作台: 词汇口径同 create_writeoff',
  },
```

- [ ] **Step 6: 更新门禁测试计数**

`apps/server/test/harness/toolInventory.test.ts:153`：
```typescript
    expect(Object.keys(toolOntologyMap).length, 'demo mapping: exactly 5 tools').toBe(5);
```

- [ ] **Step 7: 跑本任务测试 + 门禁测试**

```bash
npm test --workspace apps/server -- test/ontology/writeoffTools.test.ts test/harness/toolInventory.test.ts test/ontology/writeoffVocab.test.ts
```

预期：全 PASS（bijection：inventory 两条新目 ↔ registry 两个新挂载；词汇门禁：items/amount/partial/batch ∈ 共享词汇；场景 cap：SETTLEMENT 10 ≤ 11）。

- [ ] **Step 8: 全量回归 + 提交**

```bash
npm run build && npm run lint && npm test
git add docs/tool-inventory.json apps/server/src/ontology/writeoffTools.ts apps/server/src/harness/permissionGate.ts apps/server/src/harness/contextContract.ts apps/server/src/harness/roleToolRegistry.ts apps/server/src/harness/scenarios.ts apps/server/src/ontology/toolOntologyMap.ts apps/server/test/harness/toolInventory.test.ts apps/server/test/ontology/writeoffTools.test.ts
git commit -m "feat(writeoff): create_writeoff/create_offset L2 工具——inventory 先行登记 + 五处注册表接线 + 整单守恒 execute"
```

---

### Task 7: 提交路由 `POST /api/writeoff/submit`（走 chat 后台管道 + L2 审批）

**Files:**
- Modify: `apps/server/src/routes/writeoff.ts`（追加 POST + 指令构造器）
- Test: `apps/server/test/routes/writeoffRoutes.test.ts`（追加 describe）

**Interfaces:**
- Consumes: `validateAllocationPlan` / `AllocationItem`（Task 4）；`createSession` / `setSessionTitle` / `appendMessages`（`harness/sessionStore.js`）；`startSessionRun`（`harness/runManager.js`）；`runSession`（`harness/runSession.js`，测试中 vi.mock）；`randomUUID`
- Produces:
  - `buildWriteoffInstruction(relation: 'WRITE_OFF' | 'OFFSET_SETTLE', items: AllocationItem[]): string`（导出供测试；指令含逐字 JSON + 场景关键词 + 工具名）
  - `POST /api/writeoff/submit` body `{ relation, items }` → 200 `{ sessionId, runId, status: 'busy' }`；400（zod / 守恒 violations）；401

**流程语义**：提交路由**不直接落边**——它做计划级预检后，创建一个后台会话，注入逐字指令，模型调用 `create_writeoff`/`create_offset`（needsApproval）→ `recordL2PendingFromResponse` 生成审批单 → 审批中心批准 → callback 恢复（settlement 场景，工具可见）→ execute 权威校验 + 落边 + side_effect 审计。拒绝路径：execution-denied 工具结果，无边产生（验收 2）。

- [ ] **Step 1: 写失败测试（runSession mock + ctxHolder 双 mock，照抄 approvalCallbackBackground.test.ts）**

在 `writeoffRoutes.test.ts` 顶部（既有 ctxHolder mock 之后）追加：

```typescript
vi.mock('../../src/harness/runSession.js', () => ({
  runSession: vi.fn(async () => {}),
}));
const { createSession, loadSession } = await import('../../src/harness/sessionStore.js');
const { runSession } = await import('../../src/harness/runSession.js');
const { buildWriteoffInstruction } = await import('../../src/routes/writeoff.js');
```

（`import { vi } from 'vitest'` 已有；确认顶部 describe 之前插入。）文件末尾追加：

```typescript
import { buildWriteoffInstruction as _bwi } from '../../src/routes/writeoff.js';
void _bwi;

describe('buildWriteoffInstruction', () => {
  it('含逐字 JSON、工具名与场景关键词（settlement 命中）', () => {
    const items = [{ srcId: 'TF-p1', dstId: 'TF-i1', amount: 60, partial: true }];
    const text = buildWriteoffInstruction('WRITE_OFF', items);
    expect(text).toContain('create_writeoff');
    expect(text).toContain(JSON.stringify(items));
    expect(text).toContain('核销');
    expect(text).toContain('禁止修改');
  });
});

describe('POST /api/writeoff/submit', () => {
  const post = (app: Hono<AuthEnv>, body: unknown) =>
    app.request('http://test/api/writeoff/submit', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });

  it('401 without session', async () => {
    const app = new Hono<AuthEnv>();
    app.route('/api/writeoff', writeoffRoute);
    const res = await post(app, { relation: 'WRITE_OFF', items: [] });
    expect(res.status).toBe(401);
  });

  it('400 zod：空 items / 非法 relation', async () => {
    const app = appAs('u1');
    expect((await post(app, { relation: 'WRITE_OFF', items: [] })).status).toBe(400);
    expect((await post(app, { relation: 'NOPE', items: [{ srcId: 'a', dstId: 'b', amount: 1 }] })).status).toBe(400);
  });

  it('400 守恒预检：超额返回 violations，不建会话不启 run', async () => {
    const p = await insertTradeFact(ctx, {
      entityType: 'PaymentEvent',
      payload: { eventBizType: '正向', amount: 100, currency: 'CNY', payType: '预付' },
      validAt: '2026-06-01', createdBy: 'demo',
    }, 'u1');
    const inv = await insertTradeFact(ctx, {
      entityType: 'InvoiceEvent',
      payload: { eventBizType: '正向', amount: 60, currency: 'CNY', invoiceNo: 'INV-C', invoiceType: '进项' },
      validAt: '2026-06-02', createdBy: 'demo',
    }, 'u1');
    (runSession as ReturnType<typeof vi.fn>).mockClear();
    const res = await post(appAs('u1'), {
      relation: 'WRITE_OFF',
      items: [{ srcId: p, dstId: inv, amount: 70 }],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; violations: Array<{ code: string }> };
    expect(body.error).toBe('allocation_violations');
    expect(body.violations.map((v) => v.code)).toContain('dst_over_remaining');
    expect(runSession).not.toHaveBeenCalled();
  });

  it('200：建会话+注标题+追加逐字指令+启动后台 run', async () => {
    const p = await insertTradeFact(ctx, {
      entityType: 'PaymentEvent',
      payload: { eventBizType: '正向', amount: 100, currency: 'CNY', payType: '尾款' },
      validAt: '2026-06-01', createdBy: 'demo',
    }, 'u1');
    const inv = await insertTradeFact(ctx, {
      entityType: 'InvoiceEvent',
      payload: { eventBizType: '正向', amount: 60, currency: 'CNY', invoiceNo: 'INV-D', invoiceType: '进项' },
      validAt: '2026-06-02', createdBy: 'demo',
    }, 'u1');
    (runSession as ReturnType<typeof vi.fn>).mockClear();
    const res = await post(appAs('u1'), {
      relation: 'WRITE_OFF',
      items: [{ srcId: p, dstId: inv, amount: 60 }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessionId: string; runId: string; status: string };
    expect(body.status).toBe('busy');
    expect(body.sessionId).toBeTruthy();
    // run 以提交用户身份启动
    expect(runSession).toHaveBeenCalledTimes(1);
    const opts = (runSession as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      userId?: string; messages: Array<{ role: string; content: unknown }>;
    };
    expect(opts.userId).toBe('u1');
    const text = JSON.stringify(opts.messages);
    expect(text).toContain('create_writeoff');
    expect(text).toContain('"amount":60');
    // 会话标题已设 + 指令作为首条消息持久化
    const session = await loadSession(body.sessionId);
    expect(session?.title).toContain('核销');
    const persisted = JSON.stringify(session?.messages ?? []);
    expect(persisted).toContain('create_writeoff');
  });
});
```

注意：文件顶部追加的 `import { buildWriteoffInstruction as _bwi }` 是为了让 TS 在实现前不报导入错——**实现完成后删除该行与 `void _bwi;`**，统一使用 describe 前解构导入的那个。

- [ ] **Step 2: 跑测试确认失败**

```bash
npm test --workspace apps/server -- test/routes/writeoffRoutes.test.ts
```

预期：FAIL——`buildWriteoffInstruction` 未导出 / POST 404。

- [ ] **Step 3: 实现（writeoff.ts 追加）**

```typescript
// ---- POST /submit：工作台提交 -> chat 后台管道 -> L2 审批（不直接落边） ----
import { randomUUID } from 'node:crypto';
import { type ModelMessage } from 'ai';
import { createSession, setSessionTitle, appendMessages } from '../harness/sessionStore.js';
import { startSessionRun } from '../harness/runManager.js';
import { runSession } from '../harness/runSession.js';
import { validateAllocationPlan, type AllocationItem, type AllocationViolation } from '../ontology/writeoff.js';

const SubmitSchema = z.object({
  relation: z.enum(['WRITE_OFF', 'OFFSET_SETTLE']),
  items: z.array(z.object({
    srcId: z.string().min(1),
    dstId: z.string().min(1),
    amount: z.number().positive(),
    partial: z.boolean().optional(),
    batch: z.string().optional(),
  })).min(1).max(50),
});

/** 固定指令模板：逐字 JSON + 场景关键词（核销/冲抵/票款/结算 -> settlement，审批恢复轮次
 *  的工具可见性依赖此命中，见 scenarios.ts SETTLEMENT_RE）+ 禁改数字纪律。 */
export function buildWriteoffInstruction(
  relation: 'WRITE_OFF' | 'OFFSET_SETTLE',
  items: AllocationItem[],
): string {
  const toolName = relation === 'WRITE_OFF' ? 'create_writeoff' : 'create_offset';
  const actionLabel = relation === 'WRITE_OFF' ? '票款核销' : '预付冲抵（冲抵结算）';
  return [
    `[核销工作台提交·${actionLabel}] 用户已在工作台完成勾选与金额分配（结算域操作）。`,
    `请立即调用 ${toolName} 工具，items 参数使用以下 JSON 数组（逐字传递，禁止修改、四舍五入、拆分或合并任何条目与数字）：`,
    JSON.stringify(items),
    `调用成功后，用一两句话向用户复述${actionLabel}结果（合计金额与影响的单据），并提醒等待审批中心批准。`,
    '若工具返回校验错误（status=invalid），原样转述 violations 给用户并停止；禁止自行调整数字后重试。',
  ].join('\n');
}

writeoffRoute.post('/submit', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);

  let json: unknown;
  try { json = await c.req.json(); } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const parsed = SubmitSchema.safeParse(json);
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', detail: parsed.error.flatten() }, 400);
  }
  const { relation, items } = parsed.data;

  // 计划级守恒预检（快速失败，省一次 LLM 轮次；权威校验在工具 execute）。
  const violations: AllocationViolation[] =
    await validateAllocationPlan(getDbContext(), relation, items, user.id);
  if (violations.length > 0) {
    return c.json({ error: 'allocation_violations', violations }, 400);
  }

  // 建 backstage 会话：标题先行，指令作为首条消息持久化，随后后台 run。
  const session = await createSession('trader', user.id);
  await setSessionTitle(session.id, `核销提交 ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`);
  const instruction = buildWriteoffInstruction(relation, items);
  const instructionUIMsg = {
    id: randomUUID(),
    role: 'user' as const,
    parts: [{ type: 'text' as const, text: instruction }],
  };
  await appendMessages(session.id, [instructionUIMsg]);

  const auditTraceId = randomUUID();
  console.log(JSON.stringify({ event: 'writeoff_submit', traceId: auditTraceId, sessionId: session.id, relation, itemCount: items.length }));

  const messages: ModelMessage[] = [{ role: 'user', content: instruction }];
  const start = await startSessionRun(session.id, user.id, 'trader', (signal) =>
    runSession({
      sessionId: session.id,
      userId: user.id,
      role: 'trader',
      messages,
      auditTraceId,
      abortSignal: signal,
      // 标题已手动设置，跳过首轮 title-gen。
      isFirstTurn: false,
    }),
  );
  if ('conflict' in start) {
    return c.json({ error: 'session_busy', activeRunId: null }, 409);
  }
  return c.json({ sessionId: session.id, runId: start.runId, status: 'busy' },
    { status: 200, headers: { 'x-session-id': session.id } });
});
```

（实现时把 `z` 的 import 加进文件顶部；`AuthEnv` 等既有 import 保持。）

- [ ] **Step 4: 跑测试确认通过**

```bash
npm test --workspace apps/server -- test/routes/writeoffRoutes.test.ts
```

预期：PASS（记得删掉占位 import）。

- [ ] **Step 5: 全量回归 + 提交**

```bash
npm run build && npm run lint && npm test
git add apps/server/src/routes/writeoff.ts apps/server/test/routes/writeoffRoutes.test.ts
git commit -m "feat(writeoff): POST /api/writeoff/submit——守恒预检 + 后台会话逐字指令 + L2 审批链"
```

---

### Task 8: 前端——ViewId `writeoff` + 工作台界面

**Files:**
- Create: `apps/web/src/api/writeoff.ts`
- Create: `apps/web/src/components/writeoff/WriteoffView.tsx`
- Modify: `apps/web/src/components/shell/navigation.ts`（ViewId 追加 + NAV_ITEMS 追加）
- Modify: `apps/web/src/App.tsx`（import + 分发分支追加）

**Interfaces:**
- Consumes: `GET /api/writeoff/overview` / `POST /api/writeoff/submit`（Task 5/7）；`fetchOntologySchema`（`api/ontology.ts`，模式参数标签用；v1 可不拉——overview 已带 description，见下）；hash 路由 `navigate('approvals')` / `#/chat?session=new&ask=`（App 既有约定）
- Produces: `WriteoffView`（App.tsx 分发用，无 props）

**UI 结构（对齐 bindings 惯例：卡片圆角、灰阶、PanelRail 不必须）**：
1. 顶部模式切换（overview.modes 驱动，显示 relation 中文名：WRITE_OFF=票款核销、OFFSET_SETTLE=预付冲抵——**从 description 派生而非硬编码字段**；新增同类关系自动多一个 tab，验收 4）。
2. 左列「待核销资金」/ 右列「待核销发票·结算」：行 = 复选框 + label + `余额/金额` + `已核 xx` 徽标（status: none/partial/full → 未核/部分核/已核完；full 行禁选）。行尾「问 Agent」链接。
3. 选中 ≥1 两侧后渲染分配矩阵：每个（资金, 目标）交叉格一个数字输入（空/0 = 跳过），行脚显示 Σ分配 vs 资金余额、列脚 Σ分配 vs 目标余额，超限红字（前端预检镜像服务端规则）。
4. 提交按钮（合计守恒无红才可点）→ POST submit → 成功面板：合计、条数、「前往审批中心」（`#/approvals`）与「查看会话」（`#/chat?session=<id>`）链接 + 刷新 overview。

- [ ] **Step 1: 实现 `apps/web/src/api/writeoff.ts`（照抄 api/ontology.ts 的 request 模式）**

```typescript
export interface WriteoffBalanceRow {
  id: string;
  entityType: string;
  label: string;
  currency: string | null;
  amount: number;
  applied: number;
  remaining: number;
  validAt: string | null;
  status: 'none' | 'partial' | 'full';
}

export interface WriteoffMode {
  relation: string;
  description: string;
  srcTypes: string[];
  dstTypes: string[];
  funds: WriteoffBalanceRow[];
  targets: WriteoffBalanceRow[];
}

export interface WriteoffOverview {
  asOf: string;
  modes: WriteoffMode[];
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: 'include', ...init });
  } catch {
    throw new Error('网络错误，请稍后重试');
  }
  if (!res.ok) {
    let message = `请求失败（${res.status}）`;
    try {
      const data = (await res.json()) as { error?: string; detail?: unknown; violations?: Array<{ detail: string }> };
      if (data?.violations?.length) {
        message = `校验失败：${data.violations.map((v) => v.detail).join('；')}`;
      } else if (data?.error) {
        message = data.detail ? `${data.error}：${String(data.detail).slice(0, 200)}` : data.error;
      }
    } catch { /* 非 JSON 响应 */ }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export function fetchWriteoffOverview(): Promise<WriteoffOverview> {
  return request<WriteoffOverview>('/api/writeoff/overview');
}

export interface SubmitResult {
  sessionId: string;
  runId: string;
  status: string;
}

export function submitWriteoff(
  relation: string,
  items: Array<{ srcId: string; dstId: string; amount: number; partial?: boolean; batch?: string }>,
): Promise<SubmitResult> {
  return request<SubmitResult>('/api/writeoff/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ relation, items }),
  });
}
```

- [ ] **Step 2: 实现 `apps/web/src/components/writeoff/WriteoffView.tsx`**

```tsx
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowLeftRight, CheckCircle2, RefreshCw } from 'lucide-react';
import {
  fetchWriteoffOverview, submitWriteoff,
  type WriteoffBalanceRow, type WriteoffMode, type SubmitResult,
} from '../../api/writeoff';

/** 模式短名（从 relation 名派生；新增同类关系走 fallback = relation 本名，零改动验收）。 */
function modeShortLabel(mode: WriteoffMode): string {
  if (mode.relation === 'WRITE_OFF') return '票款核销';
  if (mode.relation === 'OFFSET_SETTLE') return '预付冲抵';
  return mode.relation;
}

function targetColumnLabel(mode: WriteoffMode): string {
  return mode.dstTypes.includes('SettlementEvent') ? '待冲抵结算' : '待核销发票';
}

const STATUS_BADGE: Record<WriteoffBalanceRow['status'], { text: string; cls: string }> = {
  none: { text: '未核', cls: 'bg-gray-100 text-gray-500' },
  partial: { text: '部分核', cls: 'bg-amber-100 text-amber-700' },
  full: { text: '已核完', cls: 'bg-emerald-100 text-emerald-700' },
};

const fmt = (n: number) => n.toLocaleString('zh-CN', { maximumFractionDigits: 2 });

interface Cell { amount: string }

export function WriteoffView() {
  const [modes, setModes] = useState<WriteoffMode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [relation, setRelation] = useState<string | null>(null);
  const [selectedFunds, setSelectedFunds] = useState<Set<string>>(new Set());
  const [selectedTargets, setSelectedTargets] = useState<Set<string>>(new Set());
  const [cells, setCells] = useState<Record<string, Cell>>({});
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<SubmitResult | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const ov = await fetchWriteoffOverview();
      setModes(ov.modes);
      setRelation((prev) => prev && ov.modes.some((m) => m.relation === prev)
        ? prev : (ov.modes[0]?.relation ?? null));
      setSelectedFunds(new Set());
      setSelectedTargets(new Set());
      setCells({});
      setResult(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const mode = useMemo(() => modes.find((m) => m.relation === relation) ?? null, [modes, relation]);

  const toggle = (setter: React.Dispatch<React.SetStateAction<Set<string>>>, id: string) =>
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  const activeFunds = useMemo(
    () => mode?.funds.filter((f) => selectedFunds.has(f.id)) ?? [], [mode, selectedFunds]);
  const activeTargets = useMemo(
    () => mode?.targets.filter((t) => selectedTargets.has(t.id)) ?? [], [mode, selectedTargets]);

  const cellKey = (fundId: string, targetId: string) => `${fundId}::${targetId}`;
  const cellAmount = (fundId: string, targetId: string): number => {
    const raw = cells[cellKey(fundId, targetId)]?.amount?.trim();
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) ? n : 0;
  };

  // 前端守恒预检（镜像服务端规则）：行/列累计与正数性。
  const fundTotals = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of activeFunds) {
      m.set(f.id, activeTargets.reduce((s, t) => s + cellAmount(f.id, t.id), 0));
    }
    return m;
  }, [activeFunds, activeTargets, cells]);
  const targetTotals = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of activeTargets) {
      m.set(t.id, activeFunds.reduce((s, f) => s + cellAmount(f.id, t.id), 0));
    }
    return m;
  }, [activeFunds, activeTargets, cells]);

  const invalidCells = useMemo(() => {
    const bad: string[] = [];
    for (const f of activeFunds) {
      for (const t of activeTargets) {
        const v = cellAmount(f.id, t.id);
        if (v < 0) bad.push(cellKey(f.id, t.id));
      }
    }
    return bad;
  }, [activeFunds, activeTargets, cells]);

  const fundOver = (f: WriteoffBalanceRow) => (fundTotals.get(f.id) ?? 0) > f.remaining + 0.005;
  const targetOver = (t: WriteoffBalanceRow) => (targetTotals.get(t.id) ?? 0) > t.remaining + 0.005;
  const hasAllocation = [...fundTotals.values()].some((v) => v > 0);
  const canSubmit = !!mode && hasAllocation
    && invalidCells.length === 0
    && !activeFunds.some(fundOver) && !activeTargets.some(targetOver)
    && !submitting;

  const onSubmit = async () => {
    if (!mode) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const items = activeFunds.flatMap((f) =>
        activeTargets
          .map((t) => ({ f, t, amount: cellAmount(f.id, t.id) }))
          .filter(({ amount }) => amount > 0)
          .map(({ t, amount }) => ({
            srcId: f.id, dstId: t.id, amount,
            partial: amount < f.remaining - 0.005 ? true : undefined,
            batch: items0Batch(mode.relation),
          })));
      const res = await submitWriteoff(mode.relation, items);
      setResult(res);
      void refresh();
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  if (loading && modes.length === 0) {
    return <div className="p-6 text-sm text-gray-500">加载核销工作台数据...</div>;
  }
  if (error) {
    return (
      <div className="p-6">
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>
        <button className="mt-3 rounded-md border px-3 py-1.5 text-sm" onClick={() => void refresh()}>
          重试
        </button>
      </div>
    );
  }
  if (modes.length === 0) {
    return <div className="p-6 text-sm text-gray-500">本体注册表中暂无核销类关系（params 含 amount 且资金侧发起）。</div>;
  }

  return (
    <div className="flex h-full flex-col p-6">
      <div className="mb-4 flex items-center gap-3">
        <ArrowLeftRight className="h-5 w-5 text-gray-400" />
        <h1 className="text-base font-semibold">核销工作台</h1>
        <div className="ml-auto flex items-center gap-2">
          <a className="text-xs text-blue-600 hover:underline" href="#/approvals">前往审批中心</a>
          <button className="rounded-md border px-2 py-1 text-xs text-gray-600 hover:bg-gray-50" onClick={() => void refresh()}>
            <RefreshCw className="mr-1 inline h-3 w-3" />刷新
          </button>
        </div>
      </div>

      {modes.length > 1 && (
        <div className="mb-4 flex gap-2">
          {modes.map((m) => (
            <button
              key={m.relation}
              className={`rounded-md border px-3 py-1.5 text-sm ${m.relation === relation ? 'border-blue-500 bg-blue-50 text-blue-700' : 'text-gray-600 hover:bg-gray-50'}`}
              onClick={() => { setRelation(m.relation); setSelectedFunds(new Set()); setSelectedTargets(new Set()); setCells({}); setResult(null); }}
            >
              {modeShortLabel(m)}
            </button>
          ))}
        </div>
      )}

      {result && (
        <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
          <div className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4" />已提交，等待审批中心批准后落边。</div>
          <div className="mt-1 flex gap-3 text-xs">
            <a className="text-blue-600 hover:underline" href="#/approvals">前往审批</a>
            <a className="text-blue-600 hover:underline" href={`#/chat?session=${result.sessionId}`}>查看会话</a>
          </div>
        </div>
      )}
      {submitError && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{submitError}
        </div>
      )}

      {mode && (
        <div className="grid min-h-0 flex-1 grid-cols-2 gap-4">
          <section className="rounded-lg border">
            <header className="border-b px-3 py-2 text-sm font-medium">待核销资金（{mode.srcTypes.length} 类）</header>
            <ul className="max-h-64 overflow-auto p-2 text-sm">
              {mode.funds.map((f) => (
                <li key={f.id} className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-gray-50">
                  <input
                    type="checkbox"
                    disabled={f.status === 'full'}
                    checked={selectedFunds.has(f.id)}
                    onChange={() => toggle(setSelectedFunds, f.id)}
                  />
                  <span className="min-w-0 flex-1 truncate" title={f.id}>{f.label}</span>
                  <span className={`rounded px-1.5 py-0.5 text-xs ${STATUS_BADGE[f.status].cls}`}>{STATUS_BADGE[f.status].text}</span>
                  <span className="tabular-nums text-gray-700">余 {fmt(f.remaining)}</span>
                  <a className="text-xs text-blue-600 hover:underline"
                     href={`#/chat?session=new&ask=${encodeURIComponent(`请分析资金流水 ${f.label}（${f.id}）的核销情况`)}`}>问 Agent</a>
                </li>
              ))}
              {mode.funds.length === 0 && <li className="px-2 py-4 text-gray-400">暂无待核销资金（待本体基座灌数）</li>}
            </ul>
          </section>
          <section className="rounded-lg border">
            <header className="border-b px-3 py-2 text-sm font-medium">{targetColumnLabel(mode)}</header>
            <ul className="max-h-64 overflow-auto p-2 text-sm">
              {mode.targets.map((t) => (
                <li key={t.id} className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-gray-50">
                  <input
                    type="checkbox"
                    disabled={t.status === 'full'}
                    checked={selectedTargets.has(t.id)}
                    onChange={() => toggle(setSelectedTargets, t.id)}
                  />
                  <span className="min-w-0 flex-1 truncate" title={t.id}>{t.label}</span>
                  <span className={`rounded px-1.5 py-0.5 text-xs ${STATUS_BADGE[t.status].cls}`}>{STATUS_BADGE[t.status].text}</span>
                  <span className="tabular-nums text-gray-700">余 {fmt(t.remaining)}</span>
                  <a className="text-xs text-blue-600 hover:underline"
                     href={`#/chat?session=new&ask=${encodeURIComponent(`请分析 ${t.label}（${t.id}）的核销/冲抵情况`)}`}>问 Agent</a>
                </li>
              ))}
              {mode.targets.length === 0 && <li className="px-2 py-4 text-gray-400">暂无待核销目标（待本体基座灌数）</li>}
            </ul>
          </section>
        </div>
      )}

      {mode && activeFunds.length > 0 && activeTargets.length > 0 && (
        <section className="mt-4 rounded-lg border">
          <header className="border-b px-3 py-2 text-sm font-medium">金额分配（每格 ≤ 两端余额；行/列合计守恒）</header>
          <div className="overflow-auto p-2">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th className="px-2 py-1 text-left font-medium text-gray-500">资金 \ 目标</th>
                  {activeTargets.map((t) => (
                    <th key={t.id} className="px-2 py-1 text-right font-medium text-gray-600">
                      {t.label}
                      <span className={`ml-1 text-xs ${targetOver(t) ? 'text-red-600' : 'text-gray-400'}`}>
                        (余 {fmt(t.remaining)})
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {activeFunds.map((f) => (
                  <tr key={f.id}>
                    <td className="px-2 py-1 text-gray-700">
                      {f.label}
                      <span className={`ml-1 text-xs ${fundOver(f) ? 'text-red-600' : 'text-gray-400'}`}>(余 {fmt(f.remaining)})</span>
                    </td>
                    {activeTargets.map((t) => {
                      const key = cellKey(f.id, t.id);
                      const bad = invalidCells.includes(key) || false;
                      return (
                        <td key={key} className="px-1 py-1">
                          <input
                            inputMode="decimal"
                            className={`w-24 rounded border px-2 py-1 text-right tabular-nums ${bad ? 'border-red-400' : 'border-gray-300'}`}
                            placeholder="0"
                            value={cells[key]?.amount ?? ''}
                            onChange={(e) => setCells((prev) => ({ ...prev, [key]: { amount: e.target.value } }))}
                          />
                        </td>
                      );
                    })}
                    <td className={`px-2 py-1 text-right text-xs tabular-nums ${fundOver(f) ? 'text-red-600 font-medium' : 'text-gray-500'}`}>
                      Σ {fmt(fundTotals.get(f.id) ?? 0)} / {fmt(f.remaining)}
                    </td>
                  </tr>
                ))}
                <tr>
                  <td className="px-2 py-1 text-xs text-gray-500">列合计 / 目标余额</td>
                  {activeTargets.map((t) => (
                    <td key={t.id} className={`px-2 py-1 text-right text-xs tabular-nums ${targetOver(t) ? 'text-red-600 font-medium' : 'text-gray-500'}`}>
                      {fmt(targetTotals.get(t.id) ?? 0)} / {fmt(t.remaining)}
                    </td>
                  ))}
                  <td />
                </tr>
              </tbody>
            </table>
          </div>
          <footer className="flex items-center gap-3 border-t px-3 py-2">
            <button
              className="rounded-md bg-blue-600 px-4 py-1.5 text-sm text-white disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!canSubmit}
              onClick={() => void onSubmit()}
            >
              {submitting ? '提交中...' : '提交审批'}
            </button>
            <span className="text-xs text-gray-500">
              提交后将生成 L2 审批单，批准后落核销边；拒绝则不产生任何边。
            </span>
          </footer>
        </section>
      )}
    </div>
  );
}

/** v1 批次号：关系缩写 + 日期（用户可后续在工作台扩展编辑，OUT of v1）。 */
function items0Batch(relation: string): string {
  return `${relation === 'WRITE_OFF' ? 'WO' : 'OS'}-${new Date().toISOString().slice(0, 10)}`;
}
```

（实现时若 lint 报未用 import，按 oxlint 提示删减；不要引入新依赖。）

- [ ] **Step 3: navigation.ts 追加（两处）**

ViewId 联合类型（`| 'parties'` 之后追加一个字面量，**不动其他行**）：
```typescript
export type ViewId =
  | 'chat'
  | 'approvals'
  | 'projects'
  | 'ledger'
  | 'entities'
  | 'graph'
  | 'bindings'
  | 'writeoff'
  | 'review'
  | 'eval'
  | 'audit'
  | 'favorites'
  | 'parties';
```
（即仅在原联合中 `'bindings'` 行后插入 `| 'writeoff'`。）

lucide import 区追加 `ArrowLeftRight,`；NAV_ITEMS 在 bindings 项之后追加：
```typescript
  { id: 'writeoff', label: '核销', description: '票款核销与预付冲抵（多对多 / 部分金额 / 分批）', icon: ArrowLeftRight, group: 'work', enabled: true },
```

- [ ] **Step 4: App.tsx 追加（两处）**

顶部组件 import 区（其他视图 import 旁）追加：
```typescript
import { WriteoffView } from './components/writeoff/WriteoffView';
```
视图分发三元链，在 `view === 'bindings' ? (...) :` 分支之后（`view === 'parties'` 之前）插入一个分支：
```tsx
      ) : view === 'writeoff' ? (
        <WriteoffView />
      ) : view === 'parties' ? (
```
（即把原 `) : view === 'parties' ? (` 行前插入三行；不改任何既有分支。）

- [ ] **Step 5: 验证（web 无测试基建，以构建为准）**

```bash
npm run build && npm run lint && npm test
```

预期：全绿（tsc 严格模式 + oxlint + 服务端测试不受影响）。`npm run dev` 手工冒烟（可选，注意勿起第二个前端 dev server）：`#/writeoff` 出现核销导航项与空态/数据态；两列勾选 + 矩阵编辑 + 守恒红字 + 提交后审批中心出现 L2 单（需服务端已配模型；无模型环境下以路由测试为准）。

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/api/writeoff.ts apps/web/src/components/writeoff/WriteoffView.tsx apps/web/src/components/shell/navigation.ts apps/web/src/App.tsx
git commit -m "feat(web): 核销工作台视图——模式驱动两列勾选 + 分配矩阵 + 守恒校验 + L2 提交"
```

---

### Task 9: 终验 + 合并 runbook（与 Item 4 的并行合并协议）

**Files:**
- Create: （无；本任务是验证与合并操作）

**Interfaces:**
- Consumes: Task 1-8 全部产出
- Produces: `PengYip/writeoff-workbench` 合入 main 并 push（触发 CI+CD 到 10.10.0.2）

- [ ] **Step 1: 验收清单逐条核对（对照 spec Item 5 验收）**

1. 全流程闭环：工作台勾选→分配→提交（POST /submit 200 + 审批单生成）→审批中心批准（POST /api/approval/callback approved）→ execute 落边（writeoffTools.test 已证 execute 落边；穿透图橙色/绿色边展示属 Item 4 的 EDGE_STYLE_OVERRIDES，边数据已就位）。
2. 拒绝路径：审批 deny → SDK execution-denied 工具结果 → 无边产生（机制既有；writeoffTools 守恒失败零边测试佐证原子性）。
3. 守恒校验单测：部分核销（60/100）、多发票合并付款（Σ ≤ 资金余额 / 超额拒绝）——writeoff.test.ts 两个 describe 已覆盖。
4. 新增核销类关系零改动：`writeoffModeRelations()` 数据驱动发现 + 前端模式 tab 动态渲染（modeShortLabel fallback relation 本名）；提交工具按方法论需 inventory 登记（这是设计使然，计划头已注明）。

- [ ] **Step 2: 全量验证（CI 同序）**

```bash
npm run build && npm run lint && npm test
```

预期：全绿。

- [ ] **Step 3: 合并协议（后合方流程；若 Item 4 尚未合入则本分支即先合方，直接跳 Step 4）**

```bash
git fetch origin main
git log --oneline -5 origin/main
git merge origin/main
```

预期：可能仅在 `App.tsx`（双方都在分发链 `: null}` 前追加分支）出现文本冲突。解决规则：**保留双方分支**（Item 4 的 entities/图谱相关分支与本次 `writeoff` 分支同时保留）。若 `navigation.ts` 也冲突（Item 4 若也加了视图）：ViewId 联合与 NAV_ITEMS 均为追加语义，两边字面量都保留。其余文件零重叠不应冲突。

- [ ] **Step 4: 合并后重跑验证 + 推送**

```bash
npm run build && npm run lint && npm test
git push origin HEAD:PengYip/writeoff-workbench
git push origin HEAD:main
```

预期：CI（install→build→lint→test）绿后 CD 自动部署 10.10.0.2（pm2 reload sca-server）。

- [ ] **Step 5: 部署后冒烟（可选但推荐）**

```bash
ssh ubuntu-server "pm2 logs sca-server --lines 20 --nostream"
```

在 `http://10.10.0.2:3001/#/writeoff` 打开工作台确认空态/数据态正常（真实数据在 sca-pgvector 的 trade_facts / ontology_edges）。

---

## Self-Review 记录

- **Spec 覆盖**：两侧列表/勾选/分配/守恒（Task 3/4/8）✓；提交走 L2 工具+审批中心（Task 6/7）✓；状态视图已核/未核/部分核（Task 3 status + Task 8 徽标）✓；服务端金额校验+单测两用例（Task 4）✓；新 ViewId writeoff（Task 8）✓；验收 4 映射驱动（Task 3 模式发现 + Task 8 动态 tab）✓。OUT 项（自动建议/跨币种/批量导入）未涉 ✓。
- **占位扫描**：Task 3 测试中一处占位注释已显式标注「实现时删除」；Task 7 测试的临时 import 同样标注删除——除此无 TBD/占位。
- **类型一致性**：`WriteoffBalanceRow`/`AllocationItem`/`AllocationViolation`/`buildWriteoffInstruction` 在 Task 3/4/6/7/8 间签名一致；工具 execute 返回联合类型在测试中以 `out.status` 判别后窄化。
- **已知取舍**：提交链路含一次 LLM 轮次（复用既有审批/审计/恢复机制的最短路径）；数字保真由「逐字指令纪律 + execute 以 DB 为准的权威校验」双保险。若后续要求零 LLM，可在审批通道扩展 headless 会话（另立计划）。
