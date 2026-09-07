# 总览工作台 overview-dashboard 实施计划（roadmap Item 7, P2）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 登录后门户 ViewId `overview`——待审批卡片 + 两条异常规则卡片（超合同量收货 / 无票付款拦截）+ 两张指标卡片（合同执行率 / 待核销金额），每卡片独立 loading/error/空态，接口层预留 Cube 数据源位。

**Architecture:** 后端新只读聚合模块 `apps/server/src/overview/metrics.ts`：纯函数规则层（可独立单测）+ DB 装配层（全部走既有 SSOT 读路径：repo.ts / projection.ts / writeoff.ts / sessionStore），每卡片独立 try/catch 产出 `{status:'ok'|'error'}` 切片；新 HTTP 路由 `GET /api/overview`（requireAuth，不进 agent 工具注册表）；`METRICS_SOURCE=local|cube` env（默认 local，cube 仅返回预留位降级载荷不实际接入）。审批计数走 `countApprovals`（SessionStoreBackend 双后端镜像，SQLite/PG 同 WHERE 语义）+ `/api/approval/list` 响应附加 `total` 字段（向后兼容）。

**Tech Stack:** Hono + zod v3（后端）；Vite + React 19 + Tailwind（前端）；vitest（server + web）。

**Spec:** docs/superpowers/specs/2026-09-07-frontend-p0-p2-roadmap.md §Item 7（146-159 行）

## Global Constraints（照抄路线图 §3.4 + 任务硬约束）

- 验证顺序 `npm run build && npm run lint && npm test`（仓库根），全绿才算完成
- 代码零 emoji；TS 严格模式过 tsc
- 双后端列对列镜像；SQLite 幂等迁移（PRAGMA 守卫）/ Postgres `ADD COLUMN IF NOT EXISTS`（本项只读聚合，无新表新列）
- 新增 agent 工具必须先登记 `docs/tool-inventory.json`——本项**不新增 agent 工具**，`GET /api/overview` 是 HTTP 路由（先例：`/api/ontology/*`、`/api/tools/*` 无 inventory 条目），不进注册表
- AI SDK 6 陷阱以 AGENTS.md「AI SDK 6」节为准（本项不涉及工具/流式代码）
- 认证 `requireAuth`；测试模式 `appAs(userId)` + `app.request`（照抄 approvalListRoutes.test.ts）
- 分支惯例：feature 分支开发，验证绿后 merge 回 main 并 push（触发 CI+CD 到 10.10.0.2）
- 不扩范围（OUT：趋势图、BI 自助分析、Cube 实际接入）

## 开工前重摸底结论（2026-09-08 实测，分支 PengYip/overview-dashboard @ 9a6f57d）

1. **默认视图逻辑**：`apps/web/src/hooks/useHashRoute.ts:22`——`parseHash` 对空 hash / 未注册视图一律兜底 `'chat'`。改这一处即可把落地视图切到 `overview`：既有直链（`#/chat?session=x`、`#/approvals` 等）是显式 hash，走 `isRoutableView` 正常分支，**不受影响**（验收「默认视图切换不破坏既有直链 hash」由此保证，并新增 web 测试固化）。
2. **审批计数**：`GET /api/approval/list` 已支持 status/toolName/decidedBy/createdFrom/createdTo 过滤（Item 6），但无计数；`ApprovalListFilter` 与两后端 `listApprovals` 的动态 WHERE 构造可直接复用为 `countApprovals`。
3. **trade_facts 聚合读路径**：`ontology/repo.ts` 的 `listTradeFactsAsOf` / `listOntologyEdgesAsOf`（双后端、用户隔离、as-of 谓词）。收货事件 → 合同的挂接边 = `ALLOCATE_TO`（GoodsReceiptEvent -> TradeContract）；**TradeContract 端点 id 空间 = contract_ledger 行 id**（neighbors.ts:66-69 `resolveBrief` 以台账行 id 解析合同锚点，先例确立）。
4. **合同量键优先级先例**：`pipeline/bindingProposal.ts:316` `numField(fields, ['数量', '合同数量', '数量_吨'])`——contract_ledger.fields JSON 的合同数量读取键序照抄（读字段值不猜单位）。
5. **核销边表聚合读路径**：`ontology/writeoff.ts` 的 `listWriteoffBalances`——行 `remaining = amount - applied`（核销类边按端点累计），status ∈ none/partial/full。待核销金额 v1 口径 = 资金侧（PaymentEvent/CollectionEvent）status ≠ full 的 remaining 合计。
6. **env.ts 惯例**：zod EnvSchema 单处声明，注释说明语义与默认值；`APPROVAL_CHANNEL`（99 行）为同形态先例。`METRICS_SOURCE: z.enum(['local','cube']).default('local')` 照此办理。
7. **web 无 parseHash 测试**（grep 无命中），兜底切换无既有断言冲突；新增 useHashRoute 测试固化直链兼容。
8. contract_ledger DDL（pipeline/db/client.ts:223-238）：测试可直接裸 INSERT 种子（id/contract_no/display_contract_no/doc_type/document_id/title/fields/field_meta/overall_confidence/user_id/contract_type）。

## 范围决策（计划时定，写明理由）

- **overview 同时是 nav 首项 + 默认落地视图**。理由：roadmap 定位「登录后门户——待办与异常优先」；默认落地改动只在 `parseHash` 的兜底分支（空/非法 hash → overview），显式 hash 的直链语义零变化；nav 首项让已登录用户一键回门户。二者都以最小改动达成「不破坏既有直链」验收。
- **单聚合端点 + 卡片级错误切片**（而非每卡片一个路由）：`GET /api/overview` 返回 `cards: Record<CardKey, CardResult>`，每卡片服务端独立 try/catch——单数据源故障不拖垮整页（验收「各卡片独立 loading/error」「零依赖降级」在后端即成立）；前端卡片组件只吃自己的切片 props，「每个卡片数据源可独立 mock 测试」由纯 props + overviewModel 单测达成。
- **无票付款拦截口径**：`pending_approvals` 中 `level='L3'` 且 `reason` 含「付款」关键词的行（审批中心 L3 历史扫描，取最新 200 条内，响应注明上限）；关键词是规则语义常量，非业务字段硬编码。
- **超合同量收货口径**：GoodsReceiptEvent（正向，quantity>0）按 ALLOCATE_TO 边挂到 contract_ledger 合同，quantity 合计 > 合同数量（fields 键序 `['数量','合同数量','数量_吨']`，>0 才参与判定）即违规；逆向（负数）收货不轧差（与核销余额 v1 口径一致）。
- **合同执行率口径**：`合同总数（台账）` 与 `有 ≥1 条 ALLOCATE_TO 入边的合同数` 之比（无合同时 rate=null 显示空态）。v1 用边表存在性判定「已执行」，不做百分比进度模型（OUT 趋势/BI）。

---

### Task 1: countApprovals（双后端）+ /api/approval/list 响应附 total

**Files:**
- Modify: `apps/server/src/harness/sessionStore.ts`（接口 + facade）
- Modify: `apps/server/src/harness/sessionStoreSqlite.ts`（list/count 共享 WHERE）
- Modify: `apps/server/src/harness/sessionStorePostgres.ts`（同）
- Modify: `apps/server/src/routes/approvalCallback.ts`（list 响应加 total）
- Test: `apps/server/test/harness/approvalList.test.ts`、`apps/server/test/harness/approvalListRoutes.test.ts`（追加用例）

**Interfaces:**
- Produces: `countApprovals(filter: ApprovalListFilter): Promise<number>`（同 listApprovals 的所有权与过滤语义，忽略 limit）；`GET /api/approval/list` 响应从 `{items}` 变 `{items, total}`（additive，ApprovalCenterView 只读 items 不受影响）。Task 3 的待审批卡片消费 `total`。

- [ ] **Step 1: 写失败测试**

approvalList.test.ts 追加：

```ts
const { countApprovals } = await import('../../src/harness/sessionStore.js');

describe('countApprovals (roadmap Item 7)', () => {
  it('与 listApprovals 同语义计数，忽略 limit', async () => {
    const s = await createSession('trader', 'u1');
    await recordPendingApproval({ sessionId: s.id, level: 'L2', toolName: 'bind_document',
      toolCallId: `call_${uid('c')}`, input: {}, approvalId: `ap_${uid('a')}` });
    await recordPendingApproval({ sessionId: s.id, level: 'L3', toolName: 'escalate_to_human',
      toolCallId: `call_${uid('c')}`, input: {}, ticketId: `ESC-${uid('t')}` });
    const all = await listApprovals({ userId: 'u1' });
    expect(await countApprovals({ userId: 'u1' })).toBe(all.length);
    const binds = await listApprovals({ userId: 'u1', toolName: 'bind_document' });
    expect(await countApprovals({ userId: 'u1', toolName: 'bind_document' })).toBe(binds.length);
    expect(await countApprovals({ userId: 'u1', toolName: 'no_such_tool' })).toBe(0);
    // limit=1 不影响 count
    expect(await countApprovals({ userId: 'u1', limit: 1 })).toBe(all.length);
  });
});
```

approvalListRoutes.test.ts 的第一条用例追加断言（`200 返回本人 items...` 内）：

```ts
    expect(typeof body.total).toBe('number');
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/harness/approvalList.test.ts test/harness/approvalListRoutes.test.ts`
Expected: FAIL——countApprovals 未导出；body.total undefined

- [ ] **Step 3: 实现**

sessionStore.ts（接口 + facade，紧挨 listApprovals）：

```ts
  /** Cross-session approval count with the same ownership/filter semantics as
   *  listApprovals (limit ignored). Overview pending-approvals card (Item 7). */
  countApprovals(filter: ApprovalListFilter): Promise<number>;
```

```ts
export async function countApprovals(filter: ApprovalListFilter): Promise<number> {
  return (await getBackend()).countApprovals(filter);
}
```

sessionStoreSqlite.ts：把 listApprovals 内的条件构造提为文件内共享帮手，list 与 count 共用；count 实现紧随其后：

```ts
function approvalFilterConds({
  userId, status = 'all', toolName, decidedBy, createdFrom, createdTo,
}: ApprovalListFilter): { conds: string[]; params: unknown[] } {
  const conds: string[] = ['(s.user_id = ? OR s.user_id IS NULL)'];
  const params: unknown[] = [userId];
  if (status !== 'all') { conds.push('pa.status = ?'); params.push(status); }
  if (toolName) { conds.push('pa.tool_name = ?'); params.push(toolName); }
  if (decidedBy) { conds.push('pa.decided_by = ?'); params.push(decidedBy); }
  if (createdFrom) { conds.push('pa.created_at >= ?'); params.push(createdFrom); }
  if (createdTo) { conds.push('pa.created_at <= ?'); params.push(createdTo); }
  return { conds, params };
}

async function countApprovals(filter: ApprovalListFilter): Promise<number> {
  const { conds, params } = approvalFilterConds(filter);
  const row = db.prepare(
    `SELECT COUNT(*) AS n
       FROM pending_approvals pa
       JOIN sessions s ON s.id = pa.session_id
      WHERE ${conds.join(' AND ')}`,
  ).get(...params) as { n: number };
  return row.n;
}
```

（listApprovals 改为调用 approvalFilterConds，行为不变；导出对象加 `countApprovals`。）

sessionStorePostgres.ts：同样提取 `$n` 版帮手 + count：

```ts
    async countApprovals(filter: ApprovalListFilter): Promise<number> {
      await ensure();
      const { conds, params } = approvalFilterConds(filter);
      const { rows } = await pool.query<{ n: string }>(
        `SELECT COUNT(*) AS n
           FROM pending_approvals pa
           JOIN sessions s ON s.id = pa.session_id
          WHERE ${conds.join(' AND ')}`,
        params,
      );
      return Number(rows[0]?.n ?? 0);
    },
```

approvalCallback.ts 的 list handler：

```ts
  const items = await listApprovals({ userId: user.id, ...q.data });
  const total = await countApprovals({ userId: user.id, ...q.data });
  return c.json({ items: items.map((i) => ({ ...i, sideEffects: parseSideEffects(i.side_effect_results) })), total });
```

（import 行加 countApprovals。）

- [ ] **Step 4: 跑测试确认通过 + PG 侧 skip 不红**

Run: `npm test --workspace apps/server -- test/harness/approvalList.test.ts test/harness/approvalListRoutes.test.ts test/harness/sessionStore.postgres.integration.test.ts`
Expected: 前两者 PASS；PG 文件 skipped（未配 PG 时）

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/harness/sessionStore.ts apps/server/src/harness/sessionStoreSqlite.ts apps/server/src/harness/sessionStorePostgres.ts apps/server/src/routes/approvalCallback.ts apps/server/test/harness/approvalList.test.ts apps/server/test/harness/approvalListRoutes.test.ts
git commit -m "feat(server): approval count (both backends) + list response total for overview pending card"
```

---

### Task 2: 异常规则纯函数（TDD，无 DB）

**Files:**
- Create: `apps/server/src/overview/metrics.ts`（本任务只写纯函数层 + 类型）
- Test: `apps/server/test/overview/metrics.test.ts`（新建）

**Interfaces:**
- Produces（Task 3 装配层与 Task 5 前端类型共同依据）：

```ts
export interface OverReceiptAnomaly {
  contractId: string;      // contract_ledger 行 id
  contractNo: string;
  contractQty: number;
  receivedQty: number;     // 正向收货 quantity 合计
}
export interface PaymentBlockAnomaly {
  id: string;              // pending_approvals.id
  ticketId: string | null;
  reason: string | null;
  createdAt: string;
}
export type CardResult<T> = { status: 'ok'; data: T } | { status: 'error'; error: string };

// 纯函数：
export function isPaymentBlockReason(reason: string | null | undefined): boolean;
export function overReceiptViolations(
  contracts: Array<{ id: string; contractNo: string; qty: number | null }>,
  receipts: Array<{ id: string; quantity: number | null; bizType: string | null }>,
  allocEdges: Array<{ fromId: string; toType: string; toId: string }>,
): OverReceiptAnomaly[];
```

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/test/overview/metrics.test.ts
import { describe, it, expect } from 'vitest';
import { isPaymentBlockReason, overReceiptViolations } from '../../src/overview/metrics.js';

describe('isPaymentBlockReason', () => {
  it('reason 含「付款」判定为拦截记录；空/无关键词不判', () => {
    expect(isPaymentBlockReason('用户请求无票付款，需人工确认')).toBe(true);
    expect(isPaymentBlockReason('无票付款拦截')).toBe(true);
    expect(isPaymentBlockReason('绑定单据确认')).toBe(false);
    expect(isPaymentBlockReason(null)).toBe(false);
    expect(isPaymentBlockReason('')).toBe(false);
    expect(isPaymentBlockReason(undefined)).toBe(false);
  });
});

describe('overReceiptViolations', () => {
  const contracts = [
    { id: 'c1', contractNo: 'HT-1', qty: 100 },
    { id: 'c2', contractNo: 'HT-2', qty: 50 },
    { id: 'c3', contractNo: 'HT-3', qty: null },   // 合同数量缺失：不参与判定
    { id: 'c4', contractNo: 'HT-4', qty: 0 },      // 数量 0：不参与判定
  ];
  const receipts = [
    { id: 'r1', quantity: 60, bizType: '正向' },
    { id: 'r2', quantity: 50, bizType: '正向' },
    { id: 'r3', quantity: -10, bizType: '逆向' },  // 逆向不轧差
    { id: 'r4', quantity: null, bizType: '正向' }, // 无数量：跳过
  ];
  const edges = [
    { fromId: 'r1', toType: 'TradeContract', toId: 'c1' },
    { fromId: 'r2', toType: 'TradeContract', toId: 'c1' },
    { fromId: 'r3', toType: 'TradeContract', toId: 'c1' },
    { fromId: 'r1', toType: 'TradeContract', toId: 'c2' },
    { fromId: 'r4', toType: 'TradeContract', toId: 'c2' },
  ];

  it('超合同量收货：按合同聚合正向收货量，超量即违规', () => {
    const out = overReceiptViolations(contracts, receipts, edges);
    expect(out).toEqual([
      { contractId: 'c1', contractNo: 'HT-1', contractQty: 100, receivedQty: 110 },
    ]);
  });
  it('非 ALLOCATE_TO 目标类型的边不参与（类型过滤由调用方传入已过滤边，此处防御 toType）', () => {
    const out = overReceiptViolations(contracts, receipts, [
      { fromId: 'r1', toType: 'SettlementEvent', toId: 'c1' },
    ]);
    expect(out).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/overview/metrics.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现纯函数层**

```ts
// apps/server/src/overview/metrics.ts
// 总览工作台聚合层（roadmap Item 7, 2026-09-08）。只读：纯规则函数 + DB 装配，
// 全部走既有 SSOT 读路径（repo.ts / projection.ts / writeoff.ts / sessionStore），
// 本模块绝不写任何表。异常规则 v1 两条（路线图 Item 7）：
//   a) 超合同量收货: GoodsReceiptEvent(正向) 按 ALLOCATE_TO 边挂合同, quantity
//      合计 > 合同数量（contract_ledger.fields 键序与 bindingProposal.ts:316 同源,
//      读字段值不猜单位）; 逆向(负数)收货不轧差(与核销余额 v1 口径一致)。
//   b) 无票付款拦截: 审批中心 L3 历史 reason 含「付款」关键词(扫描最新 200 条)。
import type { DbContext } from '../pipeline/db/client.js';
import { asOfBusinessTime } from '../ontology/asof.js';
import { listTradeFactsAsOf, listOntologyEdgesAsOf, type TradeFactRow, type OntologyEdgeRow } from '../ontology/repo.js';
import { listWriteoffBalances } from '../ontology/writeoff.js';
import { listApprovals, countApprovals, type ApprovalListItem } from '../harness/sessionStore.js';
import { listContractEntities } from '../ontology/projection.js';

// ---- 异常规则 a: 超合同量收货 ---------------------------------------------

export interface OverReceiptAnomaly {
  contractId: string;
  contractNo: string;
  contractQty: number;
  receivedQty: number;
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

export function overReceiptViolations(
  contracts: Array<{ id: string; contractNo: string; qty: number | null }>,
  receipts: Array<{ id: string; quantity: number | null; bizType: string | null }>,
  allocEdges: Array<{ fromId: string; toType: string; toId: string }>,
): OverReceiptAnomaly[] {
  // 收货量合计（正向、有数量）按边端点归到合同。
  const receiptQty = new Map<string, number>();
  const receiptById = new Map(receipts.map((r) => [r.id, r]));
  for (const e of allocEdges) {
    if (e.toType !== 'TradeContract') continue;
    const r = receiptById.get(e.fromId);
    if (!r) continue;
    if (r.bizType !== '正向') continue;
    const q = num(r.quantity);
    if (q == null) continue;
    receiptQty.set(e.toId, (receiptQty.get(e.toId) ?? 0) + q);
  }
  const out: OverReceiptAnomaly[] = [];
  for (const c of contracts) {
    if (c.qty == null || c.qty <= 0) continue; // 合同数量缺失/0：不参与判定
    const received = receiptQty.get(c.id);
    if (received == null) continue;
    if (received > c.qty) {
      out.push({ contractId: c.id, contractNo: c.contractNo, contractQty: c.qty, receivedQty: received });
    }
  }
  return out;
}
```

```ts
// ---- 异常规则 b: 无票付款拦截 ---------------------------------------------

export interface PaymentBlockAnomaly {
  id: string;
  ticketId: string | null;
  reason: string | null;
  createdAt: string;
}

const PAYMENT_BLOCK_KEYWORD = '付款';

export function isPaymentBlockReason(reason: string | null | undefined): boolean {
  return typeof reason === 'string' && reason.includes(PAYMENT_BLOCK_KEYWORD);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test --workspace apps/server -- test/overview/metrics.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/overview/metrics.ts apps/server/test/overview/metrics.test.ts
git commit -m "feat(server): overview anomaly rule pure functions (over-receipt, payment-block)"
```

---

### Task 3: buildOverviewMetrics 装配层 + listContractEntities 导出

**Files:**
- Modify: `apps/server/src/ontology/projection.ts`（导出 listContractEntities 包装）
- Modify: `apps/server/src/overview/metrics.ts`（追加装配层）
- Test: `apps/server/test/overview/metrics.test.ts`（追加装配用例，种子数据走真实 sqlite ctx）

**Interfaces:**
- Consumes: `listTradeFactsAsOf`/`listOntologyEdgesAsOf`（repo）、`listWriteoffBalances`（writeoff）、`countApprovals`/`listApprovals`（sessionStore）、`listContractEntities`（projection 新导出）
- Produces:

```ts
export type MetricsSource = 'local' | 'cube';
export interface ExecutionRateMetric { total: number; executed: number; rate: number | null }
export interface PendingWriteoffMetric { amount: number; rows: number }
export interface OverviewCards {
  pendingApprovals: CardResult<{ count: number }>;
  overReceipt: CardResult<{ anomalies: OverReceiptAnomaly[]; scannedContracts: number }>;
  paymentBlocks: CardResult<{ records: PaymentBlockAnomaly[]; scanLimit: number }>;
  executionRate: CardResult<ExecutionRateMetric>;
  pendingWriteoff: CardResult<PendingWriteoffMetric>;
}
export interface OverviewPayload {
  source: MetricsSource;
  asOf: string;
  note: string | null;      // cube 预留位说明；local 为 null
  cards: OverviewCards | null;  // null = cube 预留位未接入
}
export function cubePlaceholderPayload(asOf: string): OverviewPayload;
export async function buildOverviewMetrics(ctx: DbContext, userId?: string): Promise<OverviewPayload>;
```

- [ ] **Step 1: 写失败测试（追加到 test/overview/metrics.test.ts）**

```ts
import { createDb, migrate } from '../../src/pipeline/db/client.js';
import { insertTradeFact, insertOntologyEdge } from '../../src/ontology/repo.js';
import { createSession, recordPendingApproval, resolveApproval } from '../../src/harness/sessionStore.js';
import { buildOverviewMetrics } from '../../src/overview/metrics.js';

const NOW = new Date().toISOString();

async function seedContract(ctx: ReturnType<typeof createDb>, id: string, contractNo: string, qty: number | null, userId: string) {
  ctx.sqlite.prepare(
    `INSERT INTO contract_ledger (id, contract_no, display_contract_no, doc_type, document_id,
       title, fields, field_meta, overall_confidence, needs_review, user_id, contract_type)
     VALUES (?, ?, ?, '合同', 'doc-x', ?, ?, '{}', 1, 0, ?, '采购')`,
  ).run(id, contractNo, contractNo, contractNo, JSON.stringify(qty == null ? {} : { '数量': qty }), userId);
}

describe('buildOverviewMetrics (local source)', () => {
  it('构造异常数据 -> 待审批计数/超量收货/无票付款拦截/执行率/待核销 各卡片出现', async () => {
    const ctx = createDb(':memory:');
    migrate(ctx.sqlite);
    const uid = 'ov-u1';

    // 合同：HT-1 数量 100（超量源），HT-2 数量 50（已执行未超量），HT-3 无数量
    await seedContract(ctx, 'c1', 'HT-1', 100, uid);
    await seedContract(ctx, 'c2', 'HT-2', 50, uid);
    await seedContract(ctx, 'c3', 'HT-3', null, uid);

    // 收货事实：r1(60 正向)->c1，r2(50 正向)->c1 => 110 > 100 违规；r3(40)->c2 正常
    const r1 = await insertTradeFact(ctx, { entityType: 'GoodsReceiptEvent',
      payload: { eventBizType: '正向', amount: 600, currency: 'CNY', quantity: 60 },
      validAt: NOW, createdBy: 'seed' }, uid);
    const r2 = await insertTradeFact(ctx, { entityType: 'GoodsReceiptEvent',
      payload: { eventBizType: '正向', amount: 500, currency: 'CNY', quantity: 50 },
      validAt: NOW, createdBy: 'seed' }, uid);
    const r3 = await insertTradeFact(ctx, { entityType: 'GoodsReceiptEvent',
      payload: { eventBizType: '正向', amount: 400, currency: 'CNY', quantity: 40 },
      validAt: NOW, createdBy: 'seed' }, uid);
    for (const [rid, cid] of [[r1, 'c1'], [r2, 'c1'], [r3, 'c2']] as const) {
      await insertOntologyEdge(ctx, { relation: 'ALLOCATE_TO', fromType: 'GoodsReceiptEvent',
        fromId: rid, toType: 'TradeContract', toId: cid, params: { amount: 1, method: '定额' },
        validAt: NOW, createdBy: 'seed' }, uid);
    }

    // 付款事实 + 部分核销：p1 金额 1000，核销 400 => 待核销 remaining 600
    const p1 = await insertTradeFact(ctx, { entityType: 'PaymentEvent',
      payload: { eventBizType: '正向', amount: 1000, currency: 'CNY', payType: '预付' },
      validAt: NOW, createdBy: 'seed' }, uid);
    const inv1 = await insertTradeFact(ctx, { entityType: 'InvoiceEvent',
      payload: { eventBizType: '正向', amount: 400, currency: 'CNY', invoiceNo: 'INV-1' },
      validAt: NOW, createdBy: 'seed' }, uid);
    await insertOntologyEdge(ctx, { relation: 'WRITE_OFF', fromType: 'PaymentEvent',
      fromId: p1, toType: 'InvoiceEvent', toId: inv1, params: { amount: 400 },
      validAt: NOW, createdBy: 'seed' }, uid);

    // 审批：1 条 pending + 1 条已决 L3（reason 含「付款」）
    const s = await createSession('trader', uid);
    await recordPendingApproval({ sessionId: s.id, level: 'L2', toolName: 'bind_document',
      toolCallId: 'call-ov-1', input: {}, approvalId: 'ap-ov-1' });
    await recordPendingApproval({ sessionId: s.id, level: 'L3', toolName: 'escalate_to_human',
      input: { issue: 'x' }, ticketId: 'ESC-OV-1' });
    await resolveApproval('ESC-OV-1', 'denied', { decidedBy: uid, reason: '无票付款，拦截' });

    const payload = await buildOverviewMetrics(ctx, uid);
    expect(payload.source).toBe('local');
    expect(payload.note).toBeNull();
    expect(payload.cards).not.toBeNull();

    expect(payload.cards!.pendingApprovals).toEqual({ status: 'ok', data: { count: 1 } });
    expect(payload.cards!.overReceipt).toEqual({ status: 'ok',
      data: { anomalies: [{ contractId: 'c1', contractNo: 'HT-1', contractQty: 100, receivedQty: 110 }], scannedContracts: 3 } });
    expect(payload.cards!.paymentBlocks.status).toBe('ok');
    if (payload.cards!.paymentBlocks.status === 'ok') {
      expect(payload.cards!.paymentBlocks.data.records).toHaveLength(1);
      expect(payload.cards!.paymentBlocks.data.records[0]!.ticketId).toBe('ESC-OV-1');
    }
    expect(payload.cards!.executionRate).toEqual({ status: 'ok', data: { total: 3, executed: 2, rate: 2 / 3 } });
    expect(payload.cards!.pendingWriteoff).toEqual({ status: 'ok', data: { amount: 600, rows: 1 } });
  });

  it('cube 数据源：返回预留位降级载荷（cards=null + note），不触发本地聚合', async () => {
    const { cubePlaceholderPayload } = await import('../../src/overview/metrics.js');
    const p = cubePlaceholderPayload(NOW);
    expect(p.source).toBe('cube');
    expect(p.cards).toBeNull();
    expect(p.note).toBeTruthy();
  });

  it('零数据：各卡片空态不报错（rate=null / 空数组 / 0）', async () => {
    const ctx = createDb(':memory:');
    migrate(ctx.sqlite);
    const payload = await buildOverviewMetrics(ctx, 'ov-empty');
    expect(payload.cards!.pendingApprovals).toEqual({ status: 'ok', data: { count: 0 } });
    expect(payload.cards!.overReceipt.status).toBe('ok');
    if (payload.cards!.overReceipt.status === 'ok') {
      expect(payload.cards!.overReceipt.data.anomalies).toEqual([]);
    }
    expect(payload.cards!.executionRate).toEqual({ status: 'ok', data: { total: 0, executed: 0, rate: null } });
    expect(payload.cards!.pendingWriteoff).toEqual({ status: 'ok', data: { amount: 0, rows: 0 } });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/overview/metrics.test.ts`
Expected: FAIL——buildOverviewMetrics / listContractEntities 不存在

- [ ] **Step 3: 实现**

projection.ts 追加导出（放在 listContracts 定义之后）：

```ts
/** 总览工作台（Item 7）合同总数/字段读取入口：同一 USER_SCOPE 与 SOURCE_ROW_CAP 口径。 */
export async function listContractEntities(ctx: DbContext, uid: string): Promise<ProjectedEntity[]> {
  return listContracts(ctx, uid);
}
```

metrics.ts 追加装配层（每卡片独立 try/catch）：

```ts
export type MetricsSource = 'local' | 'cube';
export type CardResult<T> = { status: 'ok'; data: T } | { status: 'error'; error: string };

export interface ExecutionRateMetric { total: number; executed: number; rate: number | null }
export interface PendingWriteoffMetric { amount: number; rows: number }
export interface OverviewCards {
  pendingApprovals: CardResult<{ count: number }>;
  overReceipt: CardResult<{ anomalies: OverReceiptAnomaly[]; scannedContracts: number }>;
  paymentBlocks: CardResult<{ records: PaymentBlockAnomaly[]; scanLimit: number }>;
  executionRate: CardResult<ExecutionRateMetric>;
  pendingWriteoff: CardResult<PendingWriteoffMetric>;
}
export interface OverviewPayload {
  source: MetricsSource;
  asOf: string;
  note: string | null;
  cards: OverviewCards | null;
}

/** METRICS_SOURCE=cube 时的预留位载荷（路线图 OUT：Cube 实际接入不做）。 */
export function cubePlaceholderPayload(asOf: string): OverviewPayload {
  return {
    source: 'cube',
    asOf,
    note: 'METRICS_SOURCE=cube：Cube 数据源位已预留、未接入，本地聚合未执行。',
    cards: null,
  };
}

async function safeCard<T>(fn: () => Promise<T>): Promise<CardResult<T>> {
  try {
    return { status: 'ok', data: await fn() };
  } catch (e) {
    return { status: 'error', error: e instanceof Error ? e.message : String(e) };
  }
}

/** 合同数量键序与 bindingProposal.ts:316 同源（读字段值，不猜单位）。 */
function contractQtyOf(fields: Record<string, unknown>): number | null {
  for (const key of ['数量', '合同数量', '数量_吨']) {
    const v = num(fields[key]);
    if (v != null) return v;
  }
  return null;
}

export const PAYMENT_BLOCK_SCAN_LIMIT = 200;

export async function buildOverviewMetrics(ctx: DbContext, userId?: string): Promise<OverviewPayload> {
  const asOf = new Date().toISOString();
  const pred = asOfBusinessTime(asOf);

  const pendingApprovals = await safeCard(async () => ({
    count: await countApprovals({ userId: userId!, status: 'pending' }),
  }));

  const overReceipt = await safeCard(async () => {
    const contracts = await listContractEntities(ctx, userId!);
    const receipts = await listTradeFactsAsOf(ctx, pred, { entityType: 'GoodsReceiptEvent' }, userId);
    const edges = await listOntologyEdgesAsOf(ctx, pred, { relation: 'ALLOCATE_TO' }, userId);
    const anomalies = overReceiptViolations(
      contracts.map((c) => ({
        id: c.id,
        contractNo: String(c.fields['contractNo'] ?? ''),
        qty: contractQtyOf(c.fields),
      })),
      receipts.map((r: TradeFactRow) => ({
        id: r.id,
        quantity: num((r.payload as Record<string, unknown>)['quantity']),
        bizType: (r.payload as Record<string, unknown>)['eventBizType'] as string | null,
      })),
      edges.map((e: OntologyEdgeRow) => ({ fromId: e.fromId, toType: e.toType, toId: e.toId })),
    );
    return { anomalies, scannedContracts: contracts.length };
  });

  const paymentBlocks = await safeCard(async () => {
    const rows: ApprovalListItem[] = await listApprovals({ userId: userId!, status: 'all', limit: PAYMENT_BLOCK_SCAN_LIMIT });
    const records: PaymentBlockAnomaly[] = rows
      .filter((r) => r.level === 'L3' && isPaymentBlockReason(r.reason))
      .map((r) => ({ id: r.id, ticketId: r.ticket_id, reason: r.reason, createdAt: r.created_at }));
    return { records, scanLimit: PAYMENT_BLOCK_SCAN_LIMIT };
  });

  const executionRate = await safeCard(async () => {
    const contracts = await listContractEntities(ctx, userId!);
    const edges = await listOntologyEdgesAsOf(ctx, pred, { relation: 'ALLOCATE_TO' }, userId);
    const executedIds = new Set(
      edges.filter((e) => e.toType === 'TradeContract').map((e) => e.toId),
    );
    const total = contracts.length;
    const executed = contracts.filter((c) => executedIds.has(c.id)).length;
    return { total, executed, rate: total > 0 ? executed / total : null };
  });

  const pendingWriteoff = await safeCard(async () => {
    const rows = await listWriteoffBalances(ctx, userId);
    const funds = rows.filter((r) =>
      (r.entityType === 'PaymentEvent' || r.entityType === 'CollectionEvent') && r.status !== 'full');
    return { amount: funds.reduce((acc, r) => acc + Math.max(0, r.remaining), 0), rows: funds.length };
  });

  return {
    source: 'local',
    asOf,
    note: null,
    cards: { pendingApprovals, overReceipt, paymentBlocks, executionRate, pendingWriteoff },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test --workspace apps/server -- test/overview/metrics.test.ts`
Expected: PASS（Task 2 纯函数用例 + Task 3 装配用例）

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/ontology/projection.ts apps/server/src/overview/metrics.ts apps/server/test/overview/metrics.test.ts
git commit -m "feat(server): overview metrics assembly with per-card error isolation"
```

---

### Task 4: GET /api/overview 路由 + METRICS_SOURCE env + 挂载

**Files:**
- Create: `apps/server/src/routes/overview.ts`
- Modify: `apps/server/src/env.ts`（EnvSchema 加 METRICS_SOURCE）
- Modify: `apps/server/src/index.ts`（挂载）
- Test: `apps/server/test/overview/overviewRoute.test.ts`（新建）

**Interfaces:**
- Consumes: Task 3 `buildOverviewMetrics` / `cubePlaceholderPayload`；`env.METRICS_SOURCE`
- Produces: `GET /api/overview`（requireAuth）→ `OverviewPayload`。HTTP 视图层，**不进 agent 工具注册表 / tool-inventory.json**。

- [ ] **Step 1: env 声明**

env.ts EnvSchema 内（APPROVAL_CHANNEL 附近）：

```ts
  // Overview dashboard (roadmap Item 7) metrics source. 'local' = in-process SQL
  // aggregation over ledger/edges/approvals; 'cube' is a RESERVED seam (returns
  // a degraded placeholder payload) -- no Cube integration in v1.
  METRICS_SOURCE: z.enum(['local', 'cube']).default('local'),
```

- [ ] **Step 2: 写失败测试**

```ts
// apps/server/test/overview/overviewRoute.test.ts
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import type { AuthEnv } from '../../src/lib/auth-middleware.js';

const { overviewRoute } = await import('../../src/routes/overview.js');

function appAs(userId: string) {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { id: userId, email: 't@t', role: 'trader' } as any);
    await next();
  });
  app.route('/api/overview', overviewRoute);
  return app;
}

describe('GET /api/overview', () => {
  it('200：local 聚合载荷，五卡片键齐备', async () => {
    const res = await appAs('u1').request('http://test/api/overview', { method: 'GET' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe('local');
    expect(typeof body.asOf).toBe('string');
    expect(Object.keys(body.cards).sort()).toEqual(
      ['executionRate', 'overReceipt', 'paymentBlocks', 'pendingApprovals', 'pendingWriteoff'],
    );
    for (const key of Object.keys(body.cards)) {
      expect(['ok', 'error']).toContain(body.cards[key].status);
    }
  });
});
```

- [ ] **Step 3: 实现路由**

```ts
// apps/server/src/routes/overview.ts
// 总览工作台只读聚合面（roadmap Item 7, 2026-09-08）。
// 挂载：index.ts `app.use('/api/overview/*', requireAuth)` + `app.route('/api/overview', overviewRoute)`。
// HTTP 视图层：不进 roleToolRegistry，也不进 docs/tool-inventory.json。
import { Hono } from 'hono';
import type { AuthEnv } from '../lib/auth-middleware.js';
import { env } from '../env.js';
import { buildOverviewMetrics, cubePlaceholderPayload } from '../overview/metrics.js';

export const overviewRoute = new Hono<AuthEnv>();

overviewRoute.use('*', async (c, next) => {
  if (!c.get('user')) return c.json({ error: 'unauthorized' }, 401);
  await next();
});

overviewRoute.get('/', async (c) => {
  const user = c.get('user')!;
  const asOf = new Date().toISOString();
  if (env.METRICS_SOURCE === 'cube') {
    return c.json(cubePlaceholderPayload(asOf)); // 预留位：不触发本地聚合
  }
  try {
    return c.json(await buildOverviewMetrics(user.id));
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error('[overview] metrics failed:', detail);
    return c.json({ error: 'overview failed', detail }, 500);
  }
});
```

index.ts 三处（照 writeoff 挂载模式）：

```ts
import { overviewRoute } from './routes/overview.js';
```

```ts
app.use('/api/overview/*', requireAuth);
```

```ts
app.route('/api/overview', overviewRoute);
```

- [ ] **Step 4: 跑路由测试确认通过 + server 全量回归**

Run: `npm test --workspace apps/server -- test/overview/overviewRoute.test.ts && npm test --workspace apps/server`
Expected: PASS；全量不红（/api/approval/list 响应加 total 为 additive）

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes/overview.ts apps/server/src/env.ts apps/server/src/index.ts apps/server/test/overview/overviewRoute.test.ts
git commit -m "feat(server): read-only GET /api/overview with METRICS_SOURCE env seam"
```

---

### Task 5: web API client + overviewModel + 测试

**Files:**
- Create: `apps/web/src/api/overview.ts`
- Create: `apps/web/src/components/overview/overviewModel.ts`
- Test: `apps/web/src/components/overview/overviewModel.test.ts`（新建）

**Interfaces:**
- Consumes: Task 4 载荷形状
- Produces:

```ts
// api/overview.ts
export type CardResult<T> = { status: 'ok'; data: T } | { status: 'error'; error: string };
export interface OverviewPayloadDTO { source: 'local' | 'cube'; asOf: string; note: string | null; cards: { pendingApprovals: CardResult<{ count: number }>; overReceipt: CardResult<{ anomalies: Array<{ contractId: string; contractNo: string; contractQty: number; receivedQty: number }>; scannedContracts: number }> | null... } | null }
export function fetchOverview(): Promise<OverviewPayloadDTO>
```

```ts
// overviewModel.ts（纯函数）
export function jumpTargetForCard(card: 'pendingApprovals' | 'paymentBlocks' | 'overReceipt' | 'pendingWriteoff' | 'executionRate'): ViewId
// -> 'approvals' | 'approvals' | 'entities' | 'writeoff' | 'ledger'
export function formatRate(rate: number | null): string  // null -> '--'
export function formatAmount(n: number): string          // 千分位
```

- [ ] **Step 1: 写失败测试**

```ts
// apps/web/src/components/overview/overviewModel.test.ts
import { describe, it, expect } from 'vitest';
import { jumpTargetForCard, formatRate, formatAmount } from './overviewModel';

describe('jumpTargetForCard', () => {
  it('卡片跳转目标映射（点击跳转验收）', () => {
    expect(jumpTargetForCard('pendingApprovals')).toBe('approvals');
    expect(jumpTargetForCard('paymentBlocks')).toBe('approvals');
    expect(jumpTargetForCard('overReceipt')).toBe('entities');
    expect(jumpTargetForCard('pendingWriteoff')).toBe('writeoff');
    expect(jumpTargetForCard('executionRate')).toBe('ledger');
  });
});

describe('format helpers', () => {
  it('rate null 显示 --；amount 千分位', () => {
    expect(formatRate(null)).toBe('--');
    expect(formatRate(0.75)).toBe('75%');
    expect(formatAmount(1234567.5)).toBe('1,234,567.5');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/web -- overviewModel`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现 client 与 model**

`api/overview.ts`（照 api/governance.ts 的 request 帮手形态；DTO 类型与 Task 3 `OverviewPayload` 逐字段同形）：

```ts
// apps/web/src/api/overview.ts
// 总览工作台数据源（roadmap Item 7）：GET /api/overview 聚合载荷。
export type CardResult<T> = { status: 'ok'; data: T } | { status: 'error'; error: string };

export interface OverReceiptAnomalyDTO {
  contractId: string; contractNo: string; contractQty: number; receivedQty: number;
}
export interface PaymentBlockRecordDTO {
  id: string; ticketId: string | null; reason: string | null; createdAt: string;
}

export interface OverviewCardsDTO {
  pendingApprovals: CardResult<{ count: number }>;
  overReceipt: CardResult<{ anomalies: OverReceiptAnomalyDTO[]; scannedContracts: number }>;
  paymentBlocks: CardResult<{ records: PaymentBlockRecordDTO[]; scanLimit: number }>;
  executionRate: CardResult<{ total: number; executed: number; rate: number | null }>;
  pendingWriteoff: CardResult<{ amount: number; rows: number }>;
}

export interface OverviewPayloadDTO {
  source: 'local' | 'cube';
  asOf: string;
  note: string | null;
  cards: OverviewCardsDTO | null;
}

async function request<T>(url: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: 'include' });
  } catch {
    throw new Error('网络错误，请稍后重试');
  }
  if (!res.ok) {
    let message = `请求失败（${res.status}）`;
    try {
      const data = (await res.json()) as { error?: string; detail?: string };
      if (data?.error) message = data.detail ? `${data.error}：${data.detail}` : data.error;
    } catch { /* 非 JSON 响应，保留状态码消息 */ }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export function fetchOverview(): Promise<OverviewPayloadDTO> {
  return request<OverviewPayloadDTO>('/api/overview');
}
```

`overviewModel.ts`：

```ts
// apps/web/src/components/overview/overviewModel.ts
// 总览卡片纯展示逻辑：跳转映射与格式化，全部由接口数据驱动。
import type { ViewId } from '../shell/navigation';

export type OverviewCardKey =
  | 'pendingApprovals' | 'overReceipt' | 'paymentBlocks' | 'executionRate' | 'pendingWriteoff';

export function jumpTargetForCard(card: OverviewCardKey): ViewId {
  switch (card) {
    case 'pendingApprovals':
    case 'paymentBlocks':
      return 'approvals';
    case 'overReceipt':
      return 'entities';
    case 'pendingWriteoff':
      return 'writeoff';
    case 'executionRate':
      return 'ledger';
  }
}

export function formatRate(rate: number | null): string {
  return rate == null ? '--' : `${Math.round(rate * 100)}%`;
}

export function formatAmount(n: number): string {
  return n.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}
```

- [ ] **Step 4: 跑 web 测试确认通过**

Run: `npm test --workspace apps/web -- overviewModel`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/api/overview.ts apps/web/src/components/overview/overviewModel.ts apps/web/src/components/overview/overviewModel.test.ts
git commit -m "feat(web): overview api client and card model"
```

---

### Task 6: ViewId overview + 默认落地视图切换 + OverviewView

**Files:**
- Modify: `apps/web/src/components/shell/navigation.ts`（ViewId + NAV_ITEMS 首项）
- Modify: `apps/web/src/hooks/useHashRoute.ts`（兜底 'chat' -> 'overview' + 注释）
- Create: `apps/web/src/components/overview/OverviewView.tsx`
- Create: `apps/web/src/hooks/useHashRoute.test.ts`（新建：直链兼容固化）
- Modify: `apps/web/src/App.tsx`（import + 分发分支）

**Interfaces:**
- Consumes: Task 5 client/model；`useHashRoute().navigate`
- Produces: `<OverviewView />`（无 props）；空 hash/非法 hash 落 overview

**默认落地决策实现**：`parseHash` 末行 `const view: ViewId = isRoutableView(path) ? path : 'overview';`——只动兜底；注释同步为「空 hash / 未注册视图兜底 overview（登录后门户；显式直链不受影响）」。

- [ ] **Step 1: 写失败测试（useHashRoute.test.ts，parseHash 为纯函数可直接测）**

```ts
// apps/web/src/hooks/useHashRoute.test.ts
import { describe, it, expect } from 'vitest';
import { parseHash, formatHash } from './useHashRoute';

describe('parseHash 默认视图（roadmap Item 7）', () => {
  it('空 hash / 未知路径兜底 overview', () => {
    expect(parseHash('').view).toBe('overview');
    expect(parseHash('#').view).toBe('overview');
    expect(parseHash('#/no-such-view').view).toBe('overview');
  });
  it('既有直链 hash 不受默认切换影响', () => {
    expect(parseHash('#/chat?session=s1').view).toBe('chat');
    expect(parseHash('#/chat?session=s1').params).toEqual({ session: 's1' });
    expect(parseHash('#/approvals').view).toBe('approvals');
    expect(parseHash('#/governance').view).toBe('governance');
    expect(parseHash('#/entities').view).toBe('entities');
  });
  it('parseHash 与 formatHash 互逆', () => {
    expect(parseHash(formatHash('overview')).view).toBe('overview');
    expect(parseHash(formatHash('chat', { session: 'x' })).params).toEqual({ session: 'x' });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/web -- useHashRoute`
Expected: FAIL——空 hash 兜底现为 'chat'

- [ ] **Step 3: 实现**

navigation.ts：ViewId 联合加 `'overview'`（首行）；NAV_ITEMS 首位插入（work 组）：

```ts
  { id: 'overview', label: '总览', description: '待办与异常优先的登录门户', icon: LayoutDashboard, group: 'work', enabled: true },
```

（lucide `LayoutDashboard` 加进 import。）

useHashRoute.ts：兜底改 overview，注释同步。

OverviewView.tsx：

```tsx
// apps/web/src/components/overview/OverviewView.tsx
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { clsx } from 'clsx';
import { fetchOverview, type CardResult, type OverviewPayloadDTO } from '../../api/overview';
import { useHashRoute } from '../../hooks/useHashRoute';
import { jumpTargetForCard, formatRate, formatAmount, type OverviewCardKey } from './overviewModel';

/** 总览工作台（roadmap Item 7）：待办与异常优先的登录门户。每卡片独立
 *  loading/error/空态；数据源 GET /api/overview（卡片级错误切片由服务端产出）。 */
export function OverviewView() {
  const [payload, setPayload] = useState<OverviewPayloadDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { navigate } = useHashRoute();

  useEffect(() => {
    let alive = true;
    fetchOverview()
      .then((p) => { if (alive) setPayload(p); })
      .catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, []);

  if (error) {
    return <div className="p-6"><div className="rounded-lg border border-line bg-white p-4 text-sm text-danger">{error}</div></div>;
  }
  if (!payload) {
    return <div className="p-6 text-sm text-ink-soft">加载中...</div>;
  }
  if (payload.cards == null) {
    // METRICS_SOURCE=cube 预留位降级
    return (
      <div className="p-6">
        <div className="rounded-lg border border-dashed border-line bg-white p-6 text-sm text-ink-soft">
          {payload.note ?? '指标数据源未接入'}
        </div>
      </div>
    );
  }

  const jump = (card: OverviewCardKey) => navigate(jumpTargetForCard(card));

  return (
    <div className="space-y-6 overflow-y-auto p-6">
      <div className="flex items-center gap-2 text-xs text-ink-soft">
        <span>数据口径：{payload.source === 'local' ? '本地聚合（台账/边表/审批表）' : 'Cube（预留位）'}</span>
        <span>as-of {new Date(payload.asOf).toLocaleString('zh-CN', { hour12: false })}</span>
      </div>

      <section className="space-y-2">
        <h3 className="text-sm font-medium text-ink">待办</h3>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
          <Card cardKey="pendingApprovals" result={payload.cards.pendingApprovals}
            title="待审批" onJump={jump}
            render={(d) => <ValueMain main={String(d.count)} unit="条待处理审批" />} />
        </div>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-medium text-ink">异常</h3>
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <Card cardKey="overReceipt" result={payload.cards.overReceipt} title="超合同量收货" onJump={jump}
            render={(d) => d.anomalies.length === 0
              ? <Empty text="无超量收货" />
              : <ul className="space-y-1 text-xs">
                  {d.anomalies.map((a) => (
                    <li key={a.contractId} className="flex items-center justify-between gap-2 rounded bg-surface/60 px-2 py-1">
                      <span className="font-mono text-ink">{a.contractNo}</span>
                      <span className="text-danger">收 {formatAmount(a.receivedQty)} / 合同 {formatAmount(a.contractQty)}</span>
                    </li>
                  ))}
                </ul>} />
          <Card cardKey="paymentBlocks" result={payload.cards.paymentBlocks} title="无票付款拦截" onJump={jump}
            render={(d) => d.records.length === 0
              ? <Empty text="无拦截记录" />
              : <ul className="space-y-1 text-xs">
                  {d.records.slice(0, 5).map((r) => (
                    <li key={r.id} className="truncate rounded bg-surface/60 px-2 py-1">
                      <span className="font-mono text-ink">{r.ticketId ?? r.id}</span>
                      <span className="ml-2 text-ink-soft">{r.reason ?? ''}</span>
                    </li>
                  ))}
                  {d.records.length > 5 && <li className="text-ink-soft">...共 {d.records.length} 条</li>}
                </ul>} />
        </div>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-medium text-ink">指标</h3>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Card cardKey="executionRate" result={payload.cards.executionRate} title="合同执行率" onJump={jump}
            render={(d) => <ValueMain main={formatRate(d.rate)} unit={`${d.executed} / ${d.total} 台账合同已有履约边`} />} />
          <Card cardKey="pendingWriteoff" result={payload.cards.pendingWriteoff} title="待核销金额" onJump={jump}
            render={(d) => <ValueMain main={formatAmount(d.amount)} unit={`${d.rows} 笔资金待核销`} />} />
        </div>
      </section>

      <p className="rounded border border-dashed border-line bg-white/60 px-3 py-2 text-xs text-ink-soft">
        数据出处：合同执行率/超量收货 <- contract_ledger + ontology_edges（ALLOCATE_TO）+ trade_facts；
        待核销金额 <- 核销余额聚合（ontology/writeoff.ts）；待审批/无票付款拦截 <- pending_approvals 审批表。
        经 GET /api/overview，METRICS_SOURCE={payload.source}。
      </p>
    </div>
  );
}

function Card<T>({ cardKey, result, title, render, onJump }: {
  cardKey: OverviewCardKey;
  result: CardResult<T>;
  title: string;
  render: (data: T) => ReactNode;
  onJump: (card: OverviewCardKey) => void;
}) {
  return (
    <button type="button" onClick={() => onJump(cardKey)}
      className="rounded-lg border border-line bg-white p-4 text-left transition-colors hover:border-primary/40">
      <div className="text-xs text-ink-soft">{title}</div>
      <div className="mt-2 min-h-10">
        {result.status === 'error'
          ? <span className="text-xs text-danger">{result.error}</span>
          : render(result.data)}
      </div>
      <div className="mt-1 text-xs text-ink-soft/60">点击查看 -&gt;</div>
    </button>
  );
}

function ValueMain({ main, unit }: { main: string; unit: string }) {
  return (
    <div>
      <div className="text-2xl font-semibold tabular-nums text-ink">{main}</div>
      <div className="mt-0.5 text-xs text-ink-soft">{unit}</div>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className={clsx('text-xs text-ink-soft')}>{text}</div>;
}
```

App.tsx：import + 视图链 `view === 'chat'` 分支之前插 `view === 'overview' ? <OverviewView />`：

```tsx
      {view === 'overview' ? (
        <OverviewView />
      ) : view === 'chat' ? (
```

- [ ] **Step 4: 构建 + lint + web 测试**

Run: `npm run build --workspace apps/web && npm run lint && npm test --workspace apps/web`
Expected: 全绿；lint 无新增 error（set-state-in-effect 为仓库既有 warning 基线）

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/shell/navigation.ts apps/web/src/hooks/useHashRoute.ts apps/web/src/hooks/useHashRoute.test.ts apps/web/src/components/overview/OverviewView.tsx apps/web/src/App.tsx
git commit -m "feat(web): overview dashboard view as landing portal (roadmap Item 7)"
```

---

### Task 7: 全量验证 + merge main + push

**Files:** 无新改动（验证 + 集成）

- [ ] **Step 1: 仓库根全量验证**

Run: `npm run build && npm run lint && npm test`
Expected: build、oxlint、server（1702+ 新增）与 web vitest 全绿

- [ ] **Step 2: 合回 main（仓库惯例）**

```bash
git fetch origin main
git merge origin/main   # 若 merge 触碰代码则重跑 Step 1
git push origin HEAD:PengYip/overview-dashboard
git push origin HEAD:main   # 触发 CI + CD
```

- [ ] **Step 3: 验收对照（自查）**

- 构造异常数据 -> 超量收货卡片出现（metrics.test.ts 断言）、无票付款拦截记录出现（reason 含「付款」）、点击跳转目标正确（overviewModel.test.ts 断言映射）
- 每个卡片数据源独立可 mock：服务端纯函数单测 + 前端卡片纯 props 渲染 + overviewModel 单测
- 默认视图切换不破坏既有直链 hash：useHashRoute.test.ts 固化（显式 hash 解析不变，仅空/非法兜底改 overview）
- 空数据/零依赖降级：零数据用例 + 卡片级 error 切片 + cube 预留位载荷
- `GET /api/overview` 未进 agent 工具注册表与 tool-inventory.json
