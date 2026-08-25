# 图谱承载 ERP 业务原语（方案 A）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在既有 Neo4j 开放 schema 图层上落地方案 A：新增 Quota 节点与 correlates/relates/trades/settles/granted 五种边、确定性投影（trades/settles）、HITL 关联工作台（graph_links）、两层额度管控与 R1/R2/R3 守恒对账桥，分三期实施。

**Architecture:** SSOT→投影。关系库（SQLite/PG 双后端）是数值与状态权威；Neo4j 是关系投影视图；所有图写入走 NEO4J_PASSWORD 门禁 → skipped / 驱动错误 → failed 落库可重试，永不阻塞业务主流程。新边全部复用 `graph/repo.ts` 的幂等原语（createEntity/mergeEdge/removeEdge）。

**Tech Stack:** Hono + AI SDK 6（`inputSchema`/`needsApproval: true`）、better-sqlite3 原生 DDL（client.ts）+ drizzle-kit（postgres-schema.ts）、neo4j-driver 5.26 $($kind) 参数化、vitest。

## Global Constraints

- 无 emoji（repo 全局约定）；注释风格沿既有中文块注释。
- 图写入永不阻塞业务主流程：未配置 `NEO4J_PASSWORD` → `{outcome:'skipped'}`；异常 → `'failed'` 带 reason；io 一律可注入供单测。
- 节点命名约定（不可破坏，否则与 graphWriter/projectGraphSync 不收敛）：`Contract.name = normalizeName(合同号)`、`Project.name = 项目码`、`Party.name = normalizeName(公司名)`、`Commodity.name = normalizeName(品名)`、`Document.name = docId`、`Quota.name = quota:<id>`。
- AI SDK 6 工具字段是 `inputSchema`；L2 用 per-tool `needsApproval: true` 注册（roleToolRegistry 内展开），并在 permissionGate 登记。
- 双 DB 同步落：client.ts 原生 DDL + schema.ts(drizzle sqlite) + postgres-schema.ts + postgres-repositories.ts *Pg 变体；repositories.ts 统一入口按 `ctx.backend === 'postgres'` 分流。
- 每个任务结束跑该任务测试；每期收尾跑 `npm run build && npm run lint && npm test`（root）。**全程不 push，最后一次性 push。**
- 提交只 stage 本任务文件。

---

### Task 1: tradeSemantics 六向 settles 与额度受控词汇

**Files:**
- Modify: `apps/server/src/domain/tradeSemantics.ts`
- Test: `apps/server/test/domain/tradeSemantics.test.ts`

**Interfaces (Produces):**
```ts
export type SettlesRelation = '收款' | '付款' | '收货' | '发货' | '收票' | '开票';
export type FlowFamily = '资金流' | '货物流' | '发票流';
export const SETTLES_RELATION_BY_FLOW: Readonly<Record<FlowFamily, Readonly<Record<'in'|'out', SettlesRelation>>>>;
export function settlesRelationFor(flowType: string, direction: string): SettlesRelation | null;
export type QuotaScope = 'counterparty' | 'project';
export const QUOTA_SCOPES: readonly QuotaScope[];
export const GRAPH_TRADE_EDGES = { correlates:'correlates', relates:'relates', trades:'trades', settles:'settles', granted:'granted' } as const;
```

- [ ] **Step 1: 写失败测试** — 在 `test/domain/tradeSemantics.test.ts` 追加：

```ts
describe('settles/quota 受控词汇(spec 2026-08-25)', () => {
  it('settlesRelationFor: 六向映射', () => {
    expect(settlesRelationFor('资金流', 'in')).toBe('收款');
    expect(settlesRelationFor('资金流', 'out')).toBe('付款');
    expect(settlesRelationFor('货物流', 'in')).toBe('收货');
    expect(settlesRelationFor('货物流', 'out')).toBe('发货');
    expect(settlesRelationFor('发票流', 'in')).toBe('收票');
    expect(settlesRelationFor('发票流', 'out')).toBe('开票');
  });
  it('白名单外流族/未知方向 -> null(宁可空缺不猜)', () => {
    expect(settlesRelationFor('质检流', 'in')).toBeNull();
    expect(settlesRelationFor('资金流', 'sideways')).toBeNull();
  });
  it('QUOTA_SCOPES 受控值', () => {
    expect(QUOTA_SCOPES).toEqual(['counterparty', 'project']);
  });
  it('GRAPH_TRADE_EDGES 边名常量', () => {
    expect(GRAPH_TRADE_EDGES.correlates).toBe('correlates');
    expect(GRAPH_TRADE_EDGES.settles).toBe('settles');
  });
});
```
（import 行补 `settlesRelationFor, QUOTA_SCOPES, GRAPH_TRADE_EDGES`。）

- [ ] **Step 2:** `npm test --workspace apps/server -- test/domain/tradeSemantics.test.ts` → FAIL（函数不存在）
- [ ] **Step 3: 实现** — tradeSemantics.ts 文件末尾追加：

```ts
// ---------------------------------------------------------------------------
// 履约六向与图谱边词汇(spec 2026-08-25 方案A §3.3)。settles 边 relation 由
// execution_flows(flowType x direction)确定性派生; 新增流族必须先扩
// SETTLES_RELATION_BY_FLOW, 宁可返回 null 空缺也不猜方向语义。
// ---------------------------------------------------------------------------

/** 履约六向受控词表: settles 边 relation 的唯一取值域。 */
export type SettlesRelation = '收款' | '付款' | '收货' | '发货' | '收票' | '开票';
/** 执行流水流族(executionFlow.FLOW_TYPE_BY_DOC_TYPE 的值域)。 */
export type FlowFamily = '资金流' | '货物流' | '发票流';

/** (flowType, direction) -> 六向 relation。唯一派生规则, L1 归宿。 */
export const SETTLES_RELATION_BY_FLOW: Readonly<
  Record<FlowFamily, Readonly<Record<'in' | 'out', SettlesRelation>>>
> = {
  资金流: { in: '收款', out: '付款' },
  货物流: { in: '收货', out: '发货' },
  发票流: { in: '收票', out: '开票' },
};

/** 白名单外流族或未知方向返回 null(宁可空缺不猜)。 */
export function settlesRelationFor(flowType: string, direction: string): SettlesRelation | null {
  const family = SETTLES_RELATION_BY_FLOW[flowType as FlowFamily];
  if (!family) return null;
  return family[direction as 'in' | 'out'] ?? null;
}

/** 额度范围受控词表: counterparty=对手方授信(跨项目聚合), project=项目限额。 */
export type QuotaScope = 'counterparty' | 'project';
export const QUOTA_SCOPES: readonly QuotaScope[] = ['counterparty', 'project'];

/** 图谱新增边类型常量(spec §3.3), graph 模块与工具描述共享, 禁止散落字符串。 */
export const GRAPH_TRADE_EDGES = {
  correlates: 'correlates',
  relates: 'relates',
  trades: 'trades',
  settles: 'settles',
  granted: 'granted',
} as const;
```

- [ ] **Step 4:** 测试 PASS
- [ ] **Step 5: Commit**
```bash
git add apps/server/src/domain/tradeSemantics.ts apps/server/test/domain/tradeSemantics.test.ts
git commit -m "feat(domain): 履约六向 settles 与额度受控词汇"
```

---

### Task 2: settles 边投影（executionFlow 返回流信息 + settlesGraphSync + bindings 接线）

**Files:**
- Modify: `apps/server/src/pipeline/executionFlow.ts`（materializeExecutionFlow 返回值）
- Create: `apps/server/src/pipeline/settlesGraphSync.ts`
- Modify: `apps/server/src/routes/bindings.ts`（confirmOne / 手动创建 / unbind）
- Test: `apps/server/test/pipeline/settlesGraphSync.test.ts`

**Interfaces:**
- Consumes: Task 1 `settlesRelationFor`; `bindingGraphSync.ts` 的 io 模式。
- Produces:
```ts
// executionFlow.ts
export interface MaterializedFlow { flowId: string; flowType: string; direction: FlowDirection; amount: number | null; }
export async function materializeExecutionFlow(...): Promise<MaterializedFlow | null>;  // 返回类型变化, null 语义不变
// settlesGraphSync.ts
export const SETTLES_EDGE = 'settles';
export interface SyncSettlesEdgeInput { docId: string; docType?: string|null; sourceUri?: string|null; contractNo: string; relation: string; direction: 'in'|'out'; amount?: number|null; confidence: number; }
export async function syncSettlesEdge(input: SyncSettlesEdgeInput, io?): Promise<{ outcome:'ok'|'skipped'|'failed'; reason?: string }>;
export async function removeSettlesEdge(input:{docId:string; contractNo:string}, io?): Promise<{ outcome:'ok'|'skipped'|'failed'; reason?: string }>;
```

- [ ] **Step 1: 写失败测试** `test/pipeline/settlesGraphSync.test.ts`（fake io 抄 projectGraphSync.test.ts 的 makeIo 模式，NEO4J_PASSWORD 门禁用例同款 beforeEach/afterEach）：

```ts
import { describe, it, expect } from 'vitest';
import {
  syncSettlesEdge, SETTLES_EDGE, type SettlesGraphSyncIo,
} from '../../src/pipeline/settlesGraphSync.js';

function makeIo() {
  const nodes = new Map<string, string>();
  let seq = 0;
  const edges: Array<{ srcId: string; dstId: string; kind: string; props?: Record<string, unknown> }> = [];
  const idOf = (kind: string, name: string) => {
    const key = `${kind}:${name}`;
    if (!nodes.has(key)) nodes.set(key, `e${seq++}`);
    return { elementId: nodes.get(key)! };
  };
  const io: SettlesGraphSyncIo = {
    createEntity: async (i) => { void i; return idOf(i.kind, i.name); },
    mergeEdge: async (i) => { edges.push({ srcId: i.srcId, dstId: i.dstId, kind: i.kind, props: i.props }); return {}; },
    removeEdge: async () => 0,
    findEntityByName: async (kind, name) =>
      nodes.has(`${kind}:${name}`) ? { elementId: nodes.get(`${kind}:${name}`)! } : null,
  };
  return { io, edges };
}

const prevPwd = process.env.NEO4J_PASSWORD;

describe('syncSettlesEdge', () => {
  it('NEO4J_PASSWORD 未设 -> skipped 且不触 io', async () => {
    delete process.env.NEO4J_PASSWORD;
    const { io, edges } = makeIo();
    const r = await syncSettlesEdge({ docId: 'D1', contractNo: 'HT-1', relation: '付款', direction: 'out', confidence: 0.9 }, io);
    expect(r.outcome).toBe('skipped');
    expect(edges).toHaveLength(0);
  });

  it('ok: Document-[settles{relation,direction,amount}]->Contract', async () => {
    process.env.NEO4J_PASSWORD = 'test';
    const { io, edges } = makeIo();
    const r = await syncSettlesEdge({ docId: 'D1', contractNo: 'HT-1', relation: '付款', direction: 'out', amount: 120.5, confidence: 0.9 }, io);
    expect(r.outcome).toBe('ok');
    expect(edges).toHaveLength(1);
    expect(edges[0]!.kind).toBe(SETTLES_EDGE);
    expect(edges[0]!.props).toMatchObject({ relation: '付款', direction: 'out', amount: 120.5, source: 'workbench' });
  });

  it('amount 为 null 时不写 amount 属性', async () => {
    process.env.NEO4J_PASSWORD = 'test';
    const { io, edges } = makeIo();
    await syncSettlesEdge({ docId: 'D1', contractNo: 'HT-1', relation: '收货', direction: 'in', confidence: 0.8 }, io);
    expect(edges[0]!.props).not.toHaveProperty('amount');
  });

  it('relation 为空 -> failed 不触图', async () => {
    process.env.NEO4J_PASSWORD = 'test';
    const { io, edges } = makeIo();
    const r = await syncSettlesEdge({ docId: 'D1', contractNo: 'HT-1', relation: '', direction: 'in', confidence: 1 }, io);
    expect(r.outcome).toBe('failed');
    expect(edges).toHaveLength(0);
  });

  it('io 抛错 -> failed 不上抛', async () => {
    process.env.NEO4J_PASSWORD = 'test';
    const boom: SettlesGraphSyncIo = { ...makeIo().io, createEntity: async () => { throw new Error('driver down'); } };
    const r = await syncSettlesEdge({ docId: 'D1', contractNo: 'HT-1', relation: '收款', direction: 'in', confidence: 1 }, boom);
    expect(r.outcome).toBe('failed');
    expect(r.reason).toContain('driver down');
  });
});
```
afterEach 恢复 env（照抄现有测试的 prevPwd 模式）。

- [ ] **Step 2:** 运行 → FAIL（模块不存在）
- [ ] **Step 3: 实现 settlesGraphSync.ts**（结构逐句对齐 bindingGraphSync.ts）：

```ts
// settles 边投影(spec 2026-08-25 方案A §3.3): Document-[settles {relation,
// direction}]->Contract。relation 六向词来自 domain/tradeSemantics.
// settlesRelationFor, 由 execution_flows(flowType x direction)确定性派生;
// 白名单外/方向未知时上游根本不调用本模块。与 bindingGraphSync 同模式:
// NEO4J_PASSWORD 门禁 -> skipped; 驱动错误 -> failed; 永不抛出, 绝不阻塞绑定
// 确认主流程。io 可注入, 单测无需 Neo4j。
import { createEntity, mergeEdge, removeEdge, findEntities } from '../graph/repo.js';
import { normalizeName } from '../graph/normalize.js';

export type GraphSyncOutcome = 'ok' | 'skipped' | 'failed';
export interface SettlesSyncResult { outcome: GraphSyncOutcome; reason?: string }

export interface SettlesGraphSyncIo {
  createEntity(i: { kind: string; name: string; props?: Record<string, unknown> }): Promise<{ elementId: string }>;
  mergeEdge(i: { srcId: string; dstId: string; kind: string; props?: Record<string, unknown>; confidence?: number }): Promise<unknown>;
  removeEdge(i: { srcId: string; kind: string; dstId: string }): Promise<number>;
  findEntityByName(kind: string, name: string): Promise<{ elementId: string } | null>;
}

export const defaultSettlesGraphSyncIo: SettlesGraphSyncIo = {
  createEntity: (i) => createEntity(i),
  mergeEdge: (i) => mergeEdge(i),
  removeEdge: (i) => removeEdge(i),
  findEntityByName: async (kind, name) => {
    const hits = await findEntities({ kind, name, exact: true });
    return hits[0] ?? null;
  },
};

export const SETTLES_EDGE = 'settles';

async function ensureNode(
  io: SettlesGraphSyncIo, kind: string, name: string,
  createFallback: () => Promise<{ elementId: string }>,
): Promise<{ elementId: string }> {
  const found = await io.findEntityByName(kind, name);
  if (found) return found;
  return createFallback();
}

export interface SyncSettlesEdgeInput {
  docId: string;
  docType?: string | null;
  sourceUri?: string | null;
  contractNo: string;
  /** 六向受控词(tradeSemantics.settlesRelationFor 派生), 空 -> failed。 */
  relation: string;
  direction: 'in' | 'out';
  amount?: number | null;
  confidence: number;
}

export async function syncSettlesEdge(
  input: SyncSettlesEdgeInput,
  io: SettlesGraphSyncIo = defaultSettlesGraphSyncIo,
): Promise<SettlesSyncResult> {
  if (!process.env.NEO4J_PASSWORD) return { outcome: 'skipped', reason: 'NEO4J_PASSWORD not set' };
  try {
    const contractName = normalizeName(input.contractNo);
    if (!contractName) return { outcome: 'failed', reason: 'contractNo normalized to empty' };
    if (!input.relation) return { outcome: 'failed', reason: 'settles relation is empty' };
    // Document 节点走 createEntity(MERGE 幂等): ON MATCH SET 回填 docType/sourceUri,
    // 兜底节点缺属性时自愈(与 bindingGraphSync 2026-08-18 语义一致)。
    const docNode = await io.createEntity({
      kind: 'Document', name: input.docId,
      props: { docId: input.docId,
        ...(input.docType ? { docType: input.docType } : {}),
        ...(input.sourceUri ? { sourceUri: input.sourceUri } : {}) },
    });
    const contractNode = await ensureNode(io, 'Contract', contractName,
      () => io.createEntity({ kind: 'Contract', name: contractName, props: { rawName: input.contractNo } }));
    await io.mergeEdge({
      srcId: docNode.elementId, dstId: contractNode.elementId, kind: SETTLES_EDGE,
      confidence: input.confidence,
      props: {
        relation: input.relation, direction: input.direction, source: 'workbench',
        ...(input.amount != null ? { amount: input.amount } : {}),
      },
    });
    return { outcome: 'ok' };
  } catch (e) {
    return { outcome: 'failed', reason: e instanceof Error ? e.message : String(e) };
  }
}

export async function removeSettlesEdge(
  input: { docId: string; contractNo: string },
  io: SettlesGraphSyncIo = defaultSettlesGraphSyncIo,
): Promise<SettlesSyncResult> {
  if (!process.env.NEO4J_PASSWORD) return { outcome: 'skipped', reason: 'NEO4J_PASSWORD not set' };
  try {
    const contractName = normalizeName(input.contractNo);
    if (!contractName) return { outcome: 'failed', reason: 'contractNo normalized to empty' };
    const docNode = await io.findEntityByName('Document', input.docId);
    const contractNode = await io.findEntityByName('Contract', contractName);
    if (!docNode || !contractNode) return { outcome: 'ok', reason: 'nodes missing (nothing to remove)' };
    await io.removeEdge({ srcId: docNode.elementId, kind: SETTLES_EDGE, dstId: contractNode.elementId });
    return { outcome: 'ok' };
  } catch (e) {
    return { outcome: 'failed', reason: e instanceof Error ? e.message : String(e) };
  }
}
```

- [ ] **Step 4: executionFlow 返回流信息** — `MaterializedFlow` 接口 + 三处改动：
```ts
export interface MaterializedFlow {
  flowId: string;
  flowType: string;
  direction: FlowDirection;
  amount: number | null;
}
```
materializeExecutionFlow 签名 `Promise<MaterializedFlow | null>`，末尾改为：
```ts
  const flowId = await upsertExecutionFlow(/* 参数不变 */);
  return { flowId, flowType, direction, amount: anchors.amount ?? null };
```
refreshExecutionFlowsForDocument 中 `if (flowId) materialized += 1` 改为 `if (result) materialized += 1`（变量改名）。其余调用点（routes/bindings.ts 两处、review 相关若有）对返回值的使用均为真值判断或忽略——编译验证即可。

- [ ] **Step 5: bindings.ts 接线**：
  - import 增加 `syncSettlesEdge, removeSettlesEdge` 与 `settlesRelationFor`；
  - confirmOne：物化后追加 settles 同步（失败仅告警）：
```ts
  let settled: Awaited<ReturnType<typeof materializeExecutionFlow>> = null;
  try {
    settled = await materializeExecutionFlow(db, { documentId: row.documentId, contractNo: row.contractNo, bindingId: row.id, confidence: row.confidence, createdBy: 'human' }, userId);
  } catch (e) { console.warn('[executionFlow] 确认绑定物化执行流水失败:', (e as Error).message); }
  try {
    if (settled) {
      const relation = settlesRelationFor(settled.flowType, settled.direction);
      if (relation) {
        await syncSettlesEdgeWithMeta(db, userId, {
          docId: row.documentId, contractNo: row.contractNo, relation,
          direction: settled.direction as 'in' | 'out', amount: settled.amount, confidence: row.confidence,
        });
      }
    }
  } catch (e) { console.warn('[settlesGraphSync] settles 边同步失败:', (e as Error).message); }
```
  - 新 helper（紧邻 syncBindingEdgeWithMeta，复用其 meta 读取模式）：
```ts
async function syncSettlesEdgeWithMeta(
  db: DbContext, userId: string,
  input: { docId: string; contractNo: string; relation: string; direction: 'in' | 'out'; amount?: number | null; confidence: number },
) {
  let meta: Awaited<ReturnType<typeof getDocumentMeta>> = null;
  try { meta = await getDocumentMeta(db, input.docId, userId); } catch { /* 行读不到不阻断 */ }
  return syncSettlesEdge({
    ...input,
    ...(meta?.docType ? { docType: meta.docType } : {}),
    ...(meta?.sourceUri ? { sourceUri: meta.sourceUri } : {}),
  });
}
```
  - 手动创建路径（POST /）：同样在 materialize 后加 settles 同步（createdBy 用 user.id）。
  - unbind：`siblings.length === 0` 分支里在 removeBindingEdge 旁加 `await removeSettlesEdge({ docId: row.documentId, contractNo: row.contractNo })`（各自 try/catch 告警）。

- [ ] **Step 6:** `npm test --workspace apps/server -- test/pipeline/settlesGraphSync.test.ts test/routes/bindingsWrite.test.ts test/pipeline/executionFlow.test.ts test/pipeline/executionFlowRepo.test.ts` → PASS
- [ ] **Step 7: Commit**
```bash
git add apps/server/src/pipeline/settlesGraphSync.ts apps/server/src/pipeline/executionFlow.ts apps/server/src/routes/bindings.ts apps/server/test/pipeline/settlesGraphSync.test.ts
git commit -m "feat(graph): settles 六向履约凭证边投影"
```

---

### Task 3: trades 合同标的量价投影（projectGraphSync）

**Files:**
- Modify: `apps/server/src/pipeline/projectGraphSync.ts`
- Test: `apps/server/test/pipeline/projectGraphSync.test.ts`（追加用例）

**Interfaces:**
- Produces: `export const TRADES_EDGE = 'trades';`（模块内常量，边 props `{direction:'buy'|'sell', quantity?, unitPrice?, amount?}`）

- [ ] **Step 1: 失败测试**（追加到 projectGraphSync.test.ts；复用文件内 makeIo/seedLedger 风格）：

```ts
it('采购归属确认 -> trades 边 direction=buy 且带台账量价', async () => {
  const { io, edges } = makeIo();
  await upsertContractLedgerEntry(ctx, buildLedgerEntryFromExtraction({
    documentId: 'DOC-T', docType: '合同',
    fields: {
      合同号: { value: 'CG-1', sourceSpans: [] },
      甲方: { value: '我方贸易', sourceSpans: [] },
      乙方: { value: '某供应商', sourceSpans: [] },
      标的物: { value: '动力煤', sourceSpans: [] },
      数量: { value: '5,000', sourceSpans: [] },   // 千分位
      单价: { value: '650', sourceSpans: [] },
      金额: { value: '3250000', sourceSpans: [] },
    },
    fieldMeta: Object.fromEntries(['合同号','甲方','乙方','标的物','数量','单价','金额'].map(k => [k, { strength: 'exact', confidence: 0.9 }])),
  })!);
  addSelfParty(ctx, '我方贸易', 'tester');
  await syncProjectMembershipGraph(ctx, { contractNo: 'CG-1', projectCode: 'P1', projectName: '项目一', role: '采购', confidence: 0.9 }, io);
  const trades = edges.filter((e) => e.kind === 'trades');
  expect(trades).toHaveLength(1);
  expect(trades[0]!.props).toMatchObject({ direction: 'buy', quantity: 5000, unitPrice: 650, amount: 3250000 });
});

it('销售归属确认 -> direction=sell; 物流角色或缺标的物 -> 无 trades 边', async () => { ...对称断言... });
```

- [ ] **Step 2:** 运行 → FAIL
- [ ] **Step 3: 实现** — projectGraphSync.ts：

```ts
export const TRADES_EDGE = 'trades';

function fieldNum(v: unknown): number | null {
  if (v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[,，\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}
function commodityOf(entry: ContractLedgerEntry | null): string | null {
  if (!entry) return null;
  const raw = String(entry.fields['标的物']?.value ?? entry.fields['商品']?.value ?? '').trim();
  return raw ? normalizeName(raw) : null;
}

/**
 * trades 投影(spec §3.3): Contract-[trades {direction, quantity?, unitPrice?,
 * amount?}]->Commodity。把商品从文档层提升到合同层; 仅买卖角色投影, 物流/
 * 租赁/服务安静跳过; 缺标的物跳过。数字解析失败的字段省略属性(宁缺毋错)。
 */
async function syncTradesEdge(
  io: ProjectGraphSyncIo,
  contractElementId: string,
  role: string,
  entry: ContractLedgerEntry | null,
): Promise<void> {
  if (role !== '采购' && role !== '销售') return;
  const commodity = commodityOf(entry);
  if (!commodity) return;
  const commodityNode = await ensureNode(io, 'Commodity', commodity,
    () => io.createEntity({ kind: 'Commodity', name: commodity }));
  const quantity = fieldNum(entry!.fields['数量']?.value);
  const unitPrice = fieldNum(entry!.fields['单价']?.value);
  const amount = fieldNum(entry!.fields['金额']?.value);
  await io.mergeEdge({
    srcId: contractElementId, dstId: commodityNode.elementId, kind: TRADES_EDGE,
    props: {
      direction: role === '采购' ? 'buy' : 'sell',
      ...(quantity !== null ? { quantity } : {}),
      ...(unitPrice !== null ? { unitPrice } : {}),
      ...(amount !== null ? { amount } : {}),
    },
  });
}
```
在 syncProjectMembershipGraph 中 `const ledger = await findContractLedgerByNo(...)` 之后插入 `await syncTradesEdge(io, contractNode.elementId, input.role, ledger);`

- [ ] **Step 4:** 该文件测试全绿
- [ ] **Step 5: Commit**
```bash
git add apps/server/src/pipeline/projectGraphSync.ts apps/server/test/pipeline/projectGraphSync.test.ts
git commit -m "feat(graph): trades 合同标的量价投影"
```

---

### Task 4: graph_links 存储（双后端 DDL + repositories）

**Files:**
- Modify: `apps/server/src/pipeline/db/client.ts`（原生 DDL）
- Modify: `apps/server/src/pipeline/db/schema.ts`（drizzle sqlite 表）
- Modify: `apps/server/src/pipeline/db/postgres-schema.ts`
- Modify: `apps/server/src/pipeline/db/repositories.ts`
- Modify: `apps/server/src/pipeline/db/postgres-repositories.ts`
- Test: `apps/server/test/pipeline/db/graphLinks.repo.test.ts`

**Interfaces (Produces):**
```ts
export interface GraphLinkRow {
  id: string; kind: string;
  srcKind: string; srcKey: string; srcLabel: string;
  dstKind: string; dstKey: string; dstLabel: string;
  props: Record<string, unknown>;
  confidence: number;
  status: 'proposed' | 'confirmed' | 'rejected';
  confirmationSource: string | null;
  createdBy: string; userId: string; createdAt: string;
  graphStatus: BindingGraphStatus | null;
}
export async function saveGraphLink(ctx, input: {
  kind: string; srcKind: string; srcKey: string; srcLabel?: string;
  dstKind: string; dstKey: string; dstLabel?: string;
  props?: Record<string, unknown>; confidence?: number;
  status?: 'proposed' | 'confirmed'; confirmationSource?: string | null; createdBy: string;
}, userId?: string): Promise<string>;            // triple 冲突 -> 就地更新并复活行
export async function findGraphLinkById(ctx, id: string, userId?: string): Promise<GraphLinkRow | null>;
export async function findGraphLinkByTriple(ctx, q: { kind: string; srcKey: string; dstKey: string }, userId?: string): Promise<GraphLinkRow | null>;
export async function listGraphLinkProposals(ctx, userId?: string): Promise<GraphLinkRow[]>;
export async function listGraphLinks(ctx, userId?: string): Promise<GraphLinkRow[]>;   // createdAt DESC
export async function updateGraphLinkStatus(ctx, id: string, status: 'confirmed'|'rejected', confirmationSource: 'human'|'agent', userId?: string): Promise<boolean>;
export async function updateGraphLinkProps(ctx, id: string, patch: Record<string, unknown>, userId?: string): Promise<boolean>;   // JSON merge
export async function setGraphLinkGraphStatus(ctx, id: string, gs: BindingGraphStatus | null, userId?: string): Promise<void>;
```

- [ ] **Step 1: 失败测试** `test/pipeline/db/graphLinks.repo.test.ts`：

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate } from '../../../src/pipeline/db/client.js';
import {
  saveGraphLink, findGraphLinkById, findGraphLinkByTriple, listGraphLinkProposals,
  updateGraphLinkStatus, updateGraphLinkProps, setGraphLinkGraphStatus,
} from '../../../src/pipeline/db/repositories.js';

let ctx: ReturnType<typeof createDb>;
beforeEach(() => { ctx = createDb(':memory:'); migrate(ctx.sqlite); });

async function seed() {
  return saveGraphLink(ctx, {
    kind: 'correlates', srcKind: 'Contract', srcKey: 'CG-1', dstKind: 'Contract', dstKey: 'XS-1',
    props: { share: 1 }, confidence: 0.9, createdBy: 'agent',
  }, 'u1');
}

describe('graph_links repo', () => {
  it('save->find roundtrip; 默认 proposed', async () => {
    const id = await seed();
    const row = await findGraphLinkById(ctx, id, 'u1');
    expect(row?.status).toBe('proposed');
    expect(row?.props).toEqual({ share: 1 });
  });
  it('同 triple 再保存 -> 复活更新为 confirmed(human)', async () => {
    const first = await seed();
    const second = await saveGraphLink(ctx, {
      kind: 'correlates', srcKind: 'Contract', srcKey: 'CG-1', dstKind: 'Contract', dstKey: 'XS-1',
      props: { share: 0.5 }, status: 'confirmed', confirmationSource: 'human', createdBy: 'u1',
    }, 'u1');
    expect(second).toBe(first);
    const row = await findGraphLinkById(ctx, first, 'u1');
    expect(row?.status).toBe('confirmed');
    expect(row?.props).toEqual({ share: 0.5 });
  });
  it('confirm/reject 状态机 + proposals 过滤', async () => {
    const id = await seed();
    expect((await listGraphLinkProposals(ctx, 'u1'))).toHaveLength(1);
    await updateGraphLinkStatus(ctx, id, 'rejected', 'human', 'u1');
    expect(await findGraphLinkById(ctx, id, 'u1')?.status).toBe('rejected');
    expect(await updateGraphLinkStatus(ctx, id, 'confirmed', 'human', 'u1')).toBe(true);
  });
  it('props merge + graphStatus 落库', async () => {
    const id = await seed();
    await updateGraphLinkProps(ctx, id, { allocatedAmount: 100 }, 'u1');
    expect(await findGraphLinkById(ctx, id, 'u1')?.props).toEqual({ share: 1, allocatedAmount: 100 });
    await setGraphLinkGraphStatus(ctx, id, { status: 'skipped', reason: 'NEO4J_PASSWORD not set' }, 'u1');
    expect(await findGraphLinkById(ctx, id, 'u1')?.graphStatus?.status).toBe('skipped');
  });
  it('用户隔离: u2 看不到 u1 的行', async () => {
    const id = await seed();
    expect(await findGraphLinkById(ctx, id, 'u2')).toBeNull();
  });
});
```

- [ ] **Step 2:** 运行 → FAIL
- [ ] **Step 3a: client.ts DDL** — 在 execution_flows DDL 块之后追加（同一 execMulti 风格语句数组内）：

```sql
CREATE TABLE IF NOT EXISTS graph_links (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  src_kind TEXT NOT NULL,
  src_key TEXT NOT NULL,
  src_label TEXT NOT NULL DEFAULT '',
  dst_kind TEXT NOT NULL,
  dst_key TEXT NOT NULL,
  dst_label TEXT NOT NULL DEFAULT '',
  props TEXT NOT NULL DEFAULT '{}',
  confidence REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'proposed',
  confirmation_source TEXT,
  created_by TEXT NOT NULL,
  user_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  graph_status TEXT
)
```
```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_graph_links_triple ON graph_links(kind, src_key, dst_key, user_id)
CREATE INDEX IF NOT EXISTS idx_graph_links_user ON graph_links(user_id)
CREATE INDEX IF NOT EXISTS idx_graph_links_src ON graph_links(src_kind, src_key)
```
- [ ] **Step 3b: schema.ts** 追加 graphLinks drizzle 表（列一一对应，props/graphStatus 为 JSON 文本）。
- [ ] **Step 3c: postgres-schema.ts** 追加 pgTable `graphLinks`（同列；createdAt text notNull default sql`(now())`? 沿既有 Pg 表风格：text('created_at').notNull()，由仓库层写值——参照 executionFlows Pg 定义）。
- [ ] **Step 3d: repositories.ts** — 顶部 import 对应 *Pg 函数；实现统一入口（SQLite 用 better-sqlite3 prepare/run，rid('GL') 生成 id，JSON.parse/String 包装，parseGraphStatus 复用）。SQLite upsert：
```sql
INSERT INTO graph_links
  (id, kind, src_kind, src_key, src_label, dst_kind, dst_key, dst_label, props, confidence, status, confirmation_source, created_by, user_id)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(kind, src_key, dst_key, user_id) DO UPDATE SET
  src_label=excluded.src_label, dst_label=excluded.dst_label, props=excluded.props,
  confidence=excluded.confidence, status=excluded.status,
  confirmation_source=excluded.confirmation_source, created_by=excluded.created_by
```
（冲突时 RETURNING id 或先 SELECT 再 INSERT——沿用 upsertProjectMembershipPg 的 RETURNING 风格在 Pg 侧；SQLite 侧 `RETURNING id` better-sqlite3 支持 `.get()`。）
- [ ] **Step 3e: postgres-repositories.ts** — `*Pg` 七函数镜像（$1 占位 + pool.query，行映射 rowFromPg）。
- [ ] **Step 3f: drizzle 迁移生成**：`npx drizzle-kit generate --name graph_links_quotas` 会同时包含 T8 的 quotas——**本任务先只建 graph_links**，generate 放到 T8 一并做（避免两份迁移）；本任务 PG 侧仅改 schema 文件，迁移 SQL 在 T8 步骤生成。
- [ ] **Step 4:** repo 测试 PASS；`npx tsc --noEmit -p apps/server`（或 `npm run build --workspace apps/server`）通过
- [ ] **Step 5: Commit**
```bash
git add apps/server/src/pipeline/db/client.ts apps/server/src/pipeline/db/schema.ts apps/server/src/pipeline/db/postgres-schema.ts apps/server/src/pipeline/db/repositories.ts apps/server/src/pipeline/db/postgres-repositories.ts apps/server/test/pipeline/db/graphLinks.repo.test.ts
git commit -m "feat(db): graph_links 关联提案存储(双后端)"
```

---

### Task 5: graphLinkSync（correlates/relates 边同步）

**Files:**
- Create: `apps/server/src/pipeline/graphLinkSync.ts`
- Test: `apps/server/test/pipeline/graphLinkSync.test.ts`

**Interfaces:**
- Consumes: Task 4 无直接依赖；Task 1 `GRAPH_TRADE_EDGES`；`normalizeContractNo`（contractLedger）、`normalizeProjectCode`（repositories）。
- Produces:
```ts
export const CORRELATES_EDGE = 'correlates';
export const RELATES_EDGE = 'relates';
export type GraphLinkKind = 'correlates' | 'relates';
export interface GraphLinkSyncIo { /* 四函数, 同 ProjectGraphSyncIo 形状 */ }
export async function syncGraphLinkEdge(input: {
  kind: GraphLinkKind;
  srcKind: 'Contract' | 'Project'; srcKey: string;   // key 为原始显示键, 函数内部归一化
  dstKind: 'Contract' | 'Project'; dstKey: string;
  props: Record<string, unknown>;
  confirmationSource: 'human' | 'agent';
  confidence: number;
}, io?): Promise<{ outcome:'ok'|'skipped'|'failed'; reason?: string }>;
export async function removeGraphLinkEdge(input: { kind: GraphLinkKind; srcKind: 'Contract'|'Project'; srcKey: string; dstKind: 'Contract'|'Project'; dstKey: string }, io?): Promise<same>;
```
归一化规则：kind==='correlates' → `normalizeName(normalizeContractNo(key))`（与 projectGraphSync 的 Contract.name 收敛）；kind==='relates' → `normalizeProjectCode(key)`（Project.name = 项目码）。归一化结果为空串 → failed。

- [ ] **Step 1: 失败测试**（makeIo fake + 门禁用例 + correlates 合同两侧 + relates 项目侧 + 空键 failed + io 抛错 failed，断言边 kind 与 props 含 `confirmationSource`/`source:'link_workbench'`）。
- [ ] **Step 2:** 运行 → FAIL
- [ ] **Step 3: 实现**（结构 = bindingGraphSync 克隆 + 上述归一化；ensureNode 兜底 createEntity 只带 name）。
- [ ] **Step 4:** 测试 PASS
- [ ] **Step 5: Commit**
```bash
git add apps/server/src/pipeline/graphLinkSync.ts apps/server/test/pipeline/graphLinkSync.test.ts
git commit -m "feat(graph): correlates/relates 业务关联边同步"
```

---

### Task 6: /api/graph/links REST（提案→确认工作台 API）

**Files:**
- Modify: `apps/server/src/routes/graph.ts`（追加 links 子路由；更新文件头注释为"read + link workbench writes"）
- Test: `apps/server/test/routes/graphLinks.test.ts`

**Interfaces (Produces):**
| Method Path | Body | 行为 |
|---|---|---|
| GET `/links` | ?srcKind=&srcKey=&status= | 当前列表（默认排除 rejected） |
| GET `/links/proposals` | — | status=proposed |
| POST `/links` | `{kind:'correlates'|'relates', srcKey,dstKey,srcLabel?,dstLabel?,props?,confidence?,note?}` | 人工作台直建 confirmed(human)，best-effort 同步边 + graph_status 落库 |
| POST `/links/confirm` | `{id}` | proposed→confirmed(human)+同步 |
| POST `/links/reject` | `{id}` | proposed→rejected |
| POST `/links/remove` | `{id}` | confirmed→rejected+删边 |
| PATCH `/links/:id/props` | `{props:{share?,allocatedAmount?,allocatedQuantity?,type?,note?}}` | JSON merge；confirmed 行重同步边 |

校验细节：kind 枚举二选一；correlates 要求 srcKind/dstKind='Contract'，relates 要求 ='Project'（服务端强制，防 Agent/前端乱配）；props 仅接受白名单键 `share/type/note/allocatedAmount/allocatedQuantity`（zod .strip()）。409 状态机错误文案对齐 bindings 路由风格。

- [ ] **Step 1: 失败测试** — scaffold 抄 bindingsWrite.test.ts（vi.mock dbBackend + appAs(userId) 注入假 user，挂 `app.route('/api/graph', graphRoute)`；NEO4J_PASSWORD 删除走 skipped）。核心用例：
  1. POST /links 创建 → 200 `{linkId, graphSync:'skipped'}`，DB 行 status=confirmed/confirmationSource=human/graph_status.status=skipped；
  2. 同 triple 重发 → existing:true 幂等返回同 id；
  3. kind 与 srcKind 不匹配（correlates+Project）→ 400；
  4. confirm: proposed 行 → confirmed；重复 confirm → 409；
  5. reject → rejected；remove: confirmed→rejected；
  6. PATCH props 合法键合并、非法键被剥离（`{share:2,hack:1}` → props.hack undefined）；
  7. 用户隔离：u2 操作 u1 的 id → 404。
- [ ] **Step 2:** 运行 → FAIL
- [ ] **Step 3: 实现**（graph.ts 尾部追加；ctx() 复用文件内单例；每个端点先 `const user = c.get('user'); if (!user) return c.json({error:'unauthorized'},401);`；同步结果经 `setGraphLinkGraphStatus` 落库，outcome 映射同 bindings.graphStatusFor）。
- [ ] **Step 4:** 路由测试 + 既有 routes 测试全绿
- [ ] **Step 5: Commit**
```bash
git add apps/server/src/routes/graph.ts apps/server/test/routes/graphLinks.test.ts
git commit -m "feat(api): 图关联工作台 REST(/api/graph/links)"
```

---

### Task 7: link_contracts / link_projects L2 工具

**Files:**
- Create: `apps/server/src/pipeline/tools/graphLinkTools.ts`
- Modify: `apps/server/src/harness/roleToolRegistry.ts`（TRADER_CTX_TOOL_NAMES + getToolsForRole pushes with needsApproval:true）
- Modify: `apps/server/src/harness/permissionGate.ts`（注册 L2）
- Test: `apps/server/test/pipeline/tools/graphLinkTools.test.ts`

**Interfaces:**
```ts
export function buildLinkContractsTool(deps: { ctx: DbContext; userId?: string }): Tool;
// inputSchema: { purchaseContractNo: z.string().min(1).describe('采购合同号'), salesContractNo: ..., share: z.number().min(0).max(1).optional().describe('对应份额 0-1'), note: z.string().optional() }
// execute: saveGraphLink(kind='correlates', status:'confirmed', confirmationSource:'agent', createdBy:'agent', props:{...(share!=null?{share}:{}) , ...(note?{note}:{})}) + best-effort syncGraphLinkEdge; 返回 {status:'ok', linkId, purchaseContractNo: normalized, salesContractNo: normalized, graphSync}
export function buildLinkProjectsTool(deps): Tool;
// inputSchema: { srcProjectCode, dstProjectCode, type: z.string().optional().describe('关联类型, 如 同一生意拆分'), note?: string }
```
描述遵循工具设计哲学：写“什么时候用/不做什么”（如 “不做金额分摊录入——分摊请用工作台 PATCH /api/graph/links/:id/props”）。

permissionGate：`registerPermission('link_contracts','L2'); registerPermission('link_projects','L2');`

registry：`{ ...buildLinkContractsTool({ ctx, userId }), name:'link_contracts', needsApproval: true }` 同 projects；两个名字加入 TRADER_CTX_TOOL_NAMES。

- [ ] **Step 1: 失败测试**（:memory: db + delete NEO4J_PASSWORD → execute 返回 ok/linkId/graphSync:'skipped'，且 findGraphLinkByTriple 断言 confirmed/agent/props.share；再断言 permissionGate.isSoftGate('link_contracts')===true）
- [ ] **Step 2:** FAIL → **Step 3: 实现** → **Step 4:** PASS（含 roleToolRegistry 名单一致性：listToolNames('trader') 包含两新名——若现有测试快照工具数需同步更新，一并修）
- [ ] **Step 5: Commit**
```bash
git add apps/server/src/pipeline/tools/graphLinkTools.ts apps/server/src/harness/roleToolRegistry.ts apps/server/src/harness/permissionGate.ts apps/server/test/pipeline/tools/graphLinkTools.test.ts
git commit -m "feat(tools): link_contracts/link_projects 背靠背与项目关联 L2 工具"
```

---

### Task 8: quotas 存储 + granted 边 + 用量回写

**Files:**
- Modify: `apps/server/src/pipeline/db/client.ts`、`schema.ts`、`postgres-schema.ts`、`repositories.ts`、`postgres-repositories.ts`
- Create: `apps/server/src/pipeline/quotaGraphSync.ts`
- Modify: `apps/server/src/graph/repo.ts`（新增 updateNodeProps）
- Test: `apps/server/test/pipeline/db/quotas.repo.test.ts`、`apps/server/test/pipeline/quotaGraphSync.test.ts`

**Interfaces:**
```ts
// repos
export interface QuotaRow { id; scope:'counterparty'|'project'; ownerKey; ownerLabel; limitAmount:number; currency:string|null; period:string|null; usedAmount:number; computedAt:string|null; status:'active'|'inactive'; createdBy; userId; createdAt }
export async function saveQuota(ctx, input:{ scope; ownerKey; ownerLabel; limitAmount:number; currency?; period?; createdBy }, userId?): Promise<string>;
export async function findQuotaById(ctx, id, userId?): Promise<QuotaRow|null>;
export async function listQuotas(ctx, opts?:{ scope?; userId? }): Promise<QuotaRow[]>;       // 默认含 inactive? 否: 仅 active
export async function updateQuota(ctx, id, patch:{ limitAmount?; currency?; period?; status? }, userId?): Promise<boolean>;
export async function updateQuotaUsed(ctx, id, used:number, computedAt:string, userId?): Promise<boolean>;
// graph/repo.ts
export async function updateNodeProps(input:{ elementId:string; props:Record<string,unknown> }): Promise<void>;
// quotaGraphSync.ts
export const GRANTED_EDGE = 'granted';
export async function syncQuotaGraph(input:{ quotaId; scope:'counterparty'|'project'; ownerKey; ownerLabel; limitAmount:number; currency?; period? }, io?): Promise<{outcome;reason?}>;
//   owner 节点: counterparty -> Party(normalizeName(ownerKey)); project -> Project(normalizeProjectCode(ownerKey))
//   Quota 节点 name=`quota:${quotaId}`, props{quotaId,scope,limitAmount,currency,period,ownerLabel}
export async function removeQuotaGrantedEdge(input:{quotaId; scope; ownerKey}, io?): same;   // 只删 granted 边, Quota 节点保留作历史
export async function writeQuotaUsageToGraph(input:{ quotaId; used:number; remaining:number; overLimit:boolean }, io?): same;
//   findEntityByName('Quota', `quota:${id}`) -> updateNodeProps({used, remaining, overLimit, usageComputedAt})
```

DDL quotas（client.ts / schema.ts / postgres-schema.ts 三处镜像）：
```sql
CREATE TABLE IF NOT EXISTS quotas (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  owner_key TEXT NOT NULL,
  owner_label TEXT NOT NULL DEFAULT '',
  limit_amount REAL NOT NULL,
  currency TEXT,
  period TEXT,
  used_amount REAL NOT NULL DEFAULT 0,
  computed_at TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_by TEXT NOT NULL,
  user_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_quotas_owner ON quotas(scope, owner_key, user_id);
CREATE INDEX IF NOT EXISTS idx_quotas_user ON quotas(user_id);
```

- [ ] **Step 1: 失败测试**（quotas.repo：save/find/list/update/updateQuotaUsed/用户隔离；quotaGraphSync：门禁 skipped、granted 边两端正确（Party vs Project 分支）、usage 回写调 updateNodeProps（io 增加 updateNodeProps 可注入成员）、deactivate 后 removeGrantedEdge）
- [ ] **Step 2:** FAIL
- [ ] **Step 3:** 实现（repos 双后端分流同 Task 4 模式；updateNodeProps 用 `MATCH (n) WHERE elementId(n)=$elementId SET n += $props`）
- [ ] **Step 4:** 测试 PASS
- [ ] **Step 5: Commit**
```bash
git add apps/server/src/pipeline/db/client.ts apps/server/src/pipeline/db/schema.ts apps/server/src/pipeline/db/postgres-schema.ts apps/server/src/pipeline/db/repositories.ts apps/server/src/pipeline/db/postgres-repositories.ts apps/server/src/pipeline/quotaGraphSync.ts apps/server/src/graph/repo.ts apps/server/test/pipeline/db/quotas.repo.test.ts apps/server/test/pipeline/quotaGraphSync.test.ts
git commit -m "feat(quota): 额度存储/granted 边/用量回写投影"
```
- [ ] **Step 6:** 生成 PG 迁移（graph_links + quotas 一并）：`npx drizzle-kit generate --name graph_links_quotas`（cwd=apps/server；提交生成的 drizzle/postgres/*.sql）

---

### Task 9: reconciliation 对账桥（R1/R2/R3）

**Files:**
- Create: `apps/server/src/pipeline/reconciliation.ts`
- Test: `apps/server/test/pipeline/reconciliation.test.ts`

**Interfaces:**
```ts
export interface ReconcileAlert { level:'warn'|'info'; code:string; message:string }
export interface QuotaUsageRow { quotaId; scope; ownerKey; ownerLabel; limitAmount; currency:string|null; period:string|null; used:number; remaining:number; overLimit:boolean }
export interface ProjectReconcileRow { code; name; grossMargin:number; quantityGap:number; receivableOpen:number; payableOpen:number; checks:ReconcileAlert[] }
export interface ReconcileReport { generatedAt:string; quotas:QuotaUsageRow[]; projects:ProjectReconcileRow[]; alerts:ReconcileAlert[] }
export async function reconcileAll(ctx, userId?:string, io?:ReconcileGraphIo): Promise<ReconcileReport>;

export interface ReconcileGraphIo {
  writeQuotaUsage(i:{quotaId;used;remaining;overLimit}):Promise<void>;
  writeProjectRollup(i:{projectCode;grossMargin;quantityGap;receivableOpen;payableOpen}):Promise<void>;
}
// 默认实现: writeQuotaUsage -> quotaGraphSync.writeQuotaUsageToGraph(best-effort try/catch console.warn)
//           writeProjectRollup -> findEntityByName('Project', code) 存在才 updateNodeProps({...})
```
计算规则：
- counterparty 占用：遍历 `listContractLedgerEntries`，owner 归一化（normalizeCompanyName）命中台账买方(买方|甲方)或卖方(卖方|乙方)任一侧 → 计入该条 `金额`（解析同 rollup parseAmount，缺失跳过）。每条合同最多计一次。
- project 占用：`listMembershipsByProject(confirmed)` × 台账金额求和。
- 结果持久化：`updateQuotaUsed(quota.id, used, now)`；overLimit = remaining < 0 → alert `quota_over_limit`(warn)。
- 项目行：rollupProject 复用（R1 quantityGap = 货物流 inTon−outTon，容差 0.01 → info `qty_gap`；R2 直接取 receivableOpen/payableOpen，绝对值 > 0.01 → warn `receivable_open`/`payable_open`）；图回写 props `{balance:grossMargin, quantityGap, receivableOpen, payableOpen, reconciledAt}`。

- [ ] **Step 1: 失败测试**：seed 台账×3（甲乙两侧命中/金额缺失/跨项目 memberships）+ quotas 两条（一条超限）→ 断言 used 求和、remaining、overLimit、alerts codes、io 记录的写图调用参数；`delete process.env.NEO4J_PASSWORD` 时 io 默认实现安静跳过不抛。
- [ ] **Step 2:** FAIL → **Step 3: 实现** → **Step 4:** PASS
- [ ] **Step 5: Commit**
```bash
git add apps/server/src/pipeline/reconciliation.ts apps/server/test/pipeline/reconciliation.test.ts
git commit -m "feat(reconcile): R1/R2/R3 守恒对账桥与额度占用物化"
```

---

### Task 10: 额度/对账路由 + manage_quota/query_quota_usage 工具

**Files:**
- Create: `apps/server/src/routes/quotas.ts`、`apps/server/src/routes/reconciliation.ts`
- Create: `apps/server/src/pipeline/tools/quotaTools.ts`
- Modify: `apps/server/src/index.ts`（mount `/api/quotas`、`/api/reconcile`）、`roleToolRegistry.ts`、`permissionGate.ts`
- Test: `apps/server/test/routes/quotas.test.ts`、`apps/server/test/pipeline/tools/quotaTools.test.ts`

**Interfaces:**
| 端点 | 行为 |
|---|---|
| GET `/api/quotas` | 当前用户 active 额度列表（含 DB 已物化 used/computedAt） |
| POST `/api/quotas` | `{scope,ownerKey,ownerLabel,limitAmount,currency?,period?}` 创建 + best-effort syncQuotaGraph + 立即单条 reconcile（computeCounterparty/ProjectUsage 复用 reconciliation 导出的纯计算——从 reconciliation.ts 额外导出 `reconcileQuotaOne(ctx,row,io)` 供复用） |
| PATCH `/api/quotas/:id` | `{limitAmount?,currency?,period?}` 更新 + 重同步 Quota 节点 props + 重算用量 |
| POST `/api/quotas/:id/deactivate` | status→inactive + removeQuotaGrantedEdge |
| POST `/api/reconcile/run` | reconcileAll → 完整报告 JSON |

工具：
```ts
buildManageQuotaTool(deps): Tool   // L2 needsApproval
// inputSchema: { action: z.enum(['create','update_limit','deactivate']), scope?: QUOTA_SCOPES, ownerName?: string(对手方名), projectCode?: string, limitAmount?: z.number().positive(), currency?, period?, quotaId?: string }
// create 时 scope+owner 二选一必填(zod refine), limitAmount 必填; deactivate 需 quotaId
buildQueryQuotaUsageTool(deps): Tool   // L1 只读: listQuotas + 返回 used/remaining/overLimit(读 DB 已物化列), 支持可选 scope/ownerName/projectCode 过滤
```
permissionGate：`manage_quota`→L2、`query_quota_usage`→L1；registry 相应 push（manage_quota 带 needsApproval:true）；TRADER_CTX_TOOL_NAMES 增补两名。

- [ ] **Step 1: 失败测试**（路由 scaffold 同 Task 6；工具 execute 走 :memory: db + 无 Neo4j）
- [ ] **Step 2:** FAIL → **Step 3: 实现** → **Step 4:** PASS + `npm run build && npm run lint && npm test`（Phase 2 收尾全量门禁）
- [ ] **Step 5: Commit**
```bash
git add apps/server/src/routes/quotas.ts apps/server/src/routes/reconciliation.ts apps/server/src/pipeline/tools/quotaTools.ts apps/server/src/index.ts apps/server/src/harness/roleToolRegistry.ts apps/server/src/harness/permissionGate.ts apps/server/test/routes/quotas.test.ts apps/server/test/pipeline/tools/quotaTools.test.ts
git commit -m "feat(api): 额度管控与对账路由 + manage_quota/query_quota_usage 工具"
```

---

### Task 11: 分摊录入通道（allocatedAmount/allocatedQuantity）

**Files:**
- Modify: `apps/server/src/pipeline/tools/graphLinkTools.ts`（linkContracts inputSchema 增 `allocatedQuantity?: number` `allocatedAmount?: number`，写入 props）
- Test: 扩展 `apps/server/test/pipeline/tools/graphLinkTools.test.ts` + `apps/server/test/routes/graphLinks.test.ts`（PATCH props 已覆盖白名单四键中 allocated 两键的端到端）

说明：settles 边金额已随 T2 落 props.amount；correlates 分摊以 PATCH `/api/graph/links/:id/props`（T6）为 HITL 人工录入通道，Agent 侧由本任务补齐工具入参。

- [ ] **Step 1: 失败测试**（execute 带 allocatedAmount/allocatedQuantity → props 落库）
- [ ] **Step 2:** FAIL → **Step 3: 实现** → **Step 4:** PASS
- [ ] **Step 5: Commit**
```bash
git add apps/server/src/pipeline/tools/graphLinkTools.ts apps/server/test/pipeline/tools/graphLinkTools.test.ts
git commit -m "feat(tools): correlates 金额分摊入参(allocatedAmount/Quantity)"
```

---

### Task 12: 对账报表 API + spec 收尾

**Files:**
- Modify: `apps/server/src/routes/reconciliation.ts`（GET `/report` = reconcileAll 只读变体？否——报告即物化产物，直接复用 reconcileAll 并标注副作用）
- Modify: `docs/superpowers/specs/2026-08-25-graph-erp-mapping-design.md`（勾选 Phase 1–3 全部 checkbox 为 `[x]`，文末补一行实施记录：日期 + commit 范围 + "前端看板页消费 /api/reconcile/report 与 /api/graph/links，属后续 UI 任务"）
- Test: `apps/server/test/routes/quotas.test.ts` 补 report 用例

GET `/api/reconcile/report` 返回 `{generatedAt, quotas, projects, alerts}`（内部即 reconcileAll；文档注明该调用会刷新用量物化与图属性——幂等可重放）。

- [ ] **Step 1: 失败测试**（GET /report 200 结构齐全；无数据时 quotas=[] alerts=[] 不 500）
- [ ] **Step 2:** FAIL → **Step 3: 实现 + spec 勾选** → **Step 4:** PASS
- [ ] **Step 5: Commit**
```bash
git add apps/server/src/routes/reconciliation.ts docs/superpowers/specs/2026-08-25-graph-erp-mapping-design.md apps/server/test/routes/quotas.test.ts
git commit -m "feat(api): 对账报表 API(/api/reconcile/report) + spec 实施勾选"
```

---

## Final Gate（push 前必须全绿）

- [ ] `npm run build`（root）
- [ ] `npm run lint`
- [ ] `npm test`
- [ ] `git log --oneline` 确认 12 个提交干净、无无关文件混入
- [ ] `git push origin main`（唯一一次 push）

## Self-Review 结论

- Spec 覆盖：§3.1 Quota(T8)、§3.3 五种新边(T2/T3/T5/T8)、§4 四场景查询靠边+既有 graph_query(T2/T5)、§5 R1-R3(T9)、§6 写入路径三分类(T2/T3 自动、T7/T10 HITL、T9 物化)、§8 Phase1-3(T1-T12) —— 无缺口。
- 类型一致性：settles 用 `{outcome,reason}`（与 bindingGraphSync.BindingGraphSyncResult 同形）；graphLink/quota io 四函数形状与既有两个 Io 接口一致；updateNodeProps 是 repo.ts 唯一新图原语。
- 已知取舍：PG 迁移 SQL 在 T8 一次生成（含 T4 表）；前端看板页不在本期（API-first，spec 注明）。
