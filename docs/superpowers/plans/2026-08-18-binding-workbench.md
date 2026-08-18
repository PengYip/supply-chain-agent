# 绑定工作台 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 独立"绑定工作台"页面——查看未绑定/已绑定文档、按需生成系统建议（含评分证据）、确认/拒绝/手动创建/批量确认/解绑，确认后同步写 Neo4j `binds` 边。

**Architecture:** 方案 A（spec docs/superpowers/specs/2026-08-18-binding-workbench-design.md）：薄 REST（`/api/bindings`，requireAuth，页面直连+前端二次确认）+ 图谱同步服务（`bindingGraphSync.ts`，io 注入，失败不阻塞）。后端 Lane（Task 1-6）先行冻结契约，前端 Lane（Task 7-8）随后。

**Tech Stack:** Hono + zod（server）；React 19 + Tailwind 自定义色板（web，无新依赖）；SQLite(drizzle/raw DDL) + Postgres 孪生 + Neo4j。

## Global Constraints

- 代码不出现 emoji（仓库约定）。
- AI SDK 6 相关坑见 AGENTS.md（本计划不触碰 harness，无需动 AI SDK）。
- SQLite 用幂等 DDL（PRAGMA table_info guarded ALTER，照 client.ts 既有模式），Postgres 用 `IF NOT EXISTS` ALTER + drizzle schema 同步；**不用 drizzle-kit**。
- 所有绑定查询沿用既有 user 可见性过滤模式：`uid ? or(eq(userId,uid), eq(userId,''), isNull(userId)) : 无过滤`（repositories.ts:634-641 范式）。
- 每个任务完成顺序：build → lint → test 全绿才 commit（`npm run build && npm run lint && npm test`）。
- 测试文件放 `apps/server/test/`，用 vitest，DB 用 `createDb(':memory:') + migrate(ctx.sqlite)`，路由测试照 `test/routes/review.test.ts` 的 vi.mock getDbContext 模式。
- 图同步永不阻塞业务写：NEO4J_PASSWORD 未设 → 'skipped'；驱动错误 → 'failed' + reason，业务结果照常返回。

---

### Task 1: DB 层 — bindings.graph_status 列 + findBindingById / listBindingsForUser / setBindingGraphStatus

**Files:**
- Modify: `apps/server/src/pipeline/db/schema.ts`（bindings 表定义，51-74 行区域）
- Modify: `apps/server/src/pipeline/db/postgres-schema.ts`（129-153 行区域）
- Modify: `apps/server/src/pipeline/db/client.ts`（bindings guarded ALTER，259-277 区域 + PG migrateOnStartup 346-352 区域）
- Modify: `apps/server/src/pipeline/db/repositories.ts`
- Modify: `apps/server/src/pipeline/db/postgres-repositories.ts`
- Test: `apps/server/test/pipeline/bindingGraphStatus.test.ts`（新建）

**Interfaces:**
- Produces（后续任务依赖的精确签名）:
  - `export interface BindingGraphStatus { status: 'ok' | 'skipped' | 'failed'; reason?: string; syncedAt?: string }`（repositories.ts）
  - `BindingRow` 增加字段 `graphStatus: BindingGraphStatus | null`
  - `export async function findBindingById(ctx: DbContext, bindingId: string, userId?: string): Promise<BindingRow | null>`
  - `export async function listBindingsForUser(ctx: DbContext, userId?: string): Promise<BindingRow[]>`（全状态，createdAt DESC）
  - `export async function setBindingGraphStatus(ctx: DbContext, bindingId: string, graphStatus: BindingGraphStatus, userId?: string): Promise<boolean>`
  - PG 孪生：`findBindingByIdPg` / `listBindingsForUserPg` / `setBindingGraphStatusPg`

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/test/pipeline/bindingGraphStatus.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import {
  saveBinding, findBindingById, listBindingsForUser, setBindingGraphStatus,
  type BindingGraphStatus,
} from '../../src/pipeline/db/repositories.js';

let ctx: DbContext;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
});

describe('binding graph_status + 查询函数 (SQLite)', () => {
  it('saveBinding 后 findBindingById 返回行, graphStatus 初始 null', async () => {
    const id = await saveBinding(ctx, {
      documentId: 'DOC-1', contractNo: 'HT-1', relation: '付款',
      sourceRefs: [], confidence: 0.9, createdBy: 'test',
      status: 'proposed', proposedBy: 'system', evidence: null,
    }, 'u1');
    const row = await findBindingById(ctx, id, 'u1');
    expect(row?.contractNo).toBe('HT-1');
    expect(row?.graphStatus).toBeNull();
  });

  it('setBindingGraphStatus 落库并可读回', async () => {
    const id = await saveBinding(ctx, {
      documentId: 'DOC-1', contractNo: 'HT-1', relation: '付款',
      sourceRefs: [], confidence: 0.9, createdBy: 'test', status: 'confirmed',
    }, 'u1');
    const gs: BindingGraphStatus = { status: 'failed', reason: 'boom', syncedAt: '2026-08-18T00:00:00Z' };
    expect(await setBindingGraphStatus(ctx, id, gs, 'u1')).toBe(true);
    const row = await findBindingById(ctx, id, 'u1');
    expect(row?.graphStatus).toEqual(gs);
  });

  it('listBindingsForUser 返回全状态行, legacy 空行可见, 其他用户不可见', async () => {
    await saveBinding(ctx, { documentId: 'DOC-1', contractNo: 'HT-1', relation: 'x', sourceRefs: [], confidence: 1, createdBy: 't', status: 'confirmed' }, 'u1');
    await saveBinding(ctx, { documentId: 'DOC-2', contractNo: 'HT-2', relation: 'x', sourceRefs: [], confidence: 1, createdBy: 't', status: 'proposed' }); // legacy user_id=''
    await saveBinding(ctx, { documentId: 'DOC-3', contractNo: 'HT-3', relation: 'x', sourceRefs: [], confidence: 1, createdBy: 't', status: 'rejected' }, 'u2');
    const rows = await listBindingsForUser(ctx, 'u1');
    expect(rows.map((r) => r.contractNo).sort()).toEqual(['HT-1', 'HT-2']);
  });

  it('findBindingById 用户隔离: 他人行不可见', async () => {
    const id = await saveBinding(ctx, {
      documentId: 'DOC-1', contractNo: 'HT-1', relation: 'x',
      sourceRefs: [], confidence: 1, createdBy: 't', status: 'confirmed',
    }, 'u2');
    expect(await findBindingById(ctx, id, 'u1')).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/pipeline/bindingGraphStatus.test.ts`
Expected: FAIL — `BindingGraphStatus` 未导出 / `findBindingById is not a function`

- [ ] **Step 3: 实现**

3a. `schema.ts` bindings 定义末尾加一列（evidence 之后）：

```ts
    /** JSON(BindingGraphStatus): 工作台确认后图谱同步结果。 */
    graphStatus: text('graph_status'),
```

3b. `postgres-schema.ts` bindings 定义末尾加：

```ts
    graphStatus: text('graph_status'),
```

（PG 用 text 存 JSON 字符串，与 SQLite 一致，避免两端映射差异。）

3c. `client.ts` SQLite guarded ALTER（bindings ALTER 块 259-277 内，照既有 `if (!have.has('evidence'))` 追加）：

```ts
    if (!have.has('graph_status')) {
      try { sqlite.exec('ALTER TABLE bindings ADD COLUMN graph_status TEXT'); } catch { /* concurrent */ }
    }
```

3d. `client.ts` PG migrateOnStartup 的 bindings 列区（346-352 区域）追加：

```ts
      await pg.exec('ALTER TABLE bindings ADD COLUMN IF NOT EXISTS graph_status TEXT');
```

3e. `repositories.ts`：
- BindingStatus 类型区（139-182）加：

```ts
/** 工作台图同步结果(落 bindings.graph_status, JSON)。 */
export interface BindingGraphStatus {
  status: 'ok' | 'skipped' | 'failed';
  reason?: string;
  syncedAt?: string;
}
```

- `BindingRow` 加字段 `graphStatus: BindingGraphStatus | null;`
- 新增三个函数（放在 updateBindingStatus 之后）。SQLite 分支（PG dispatch 第一行）：

```ts
function parseGraphStatus(raw: string | null): BindingGraphStatus | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as BindingGraphStatus; } catch { return null; }
}

export async function findBindingById(
  ctx: DbContext, bindingId: string, userId?: string,
): Promise<BindingRow | null> {
  if (ctx.backend === 'postgres') return findBindingByIdPg(ctx, bindingId, userId);
  const uid = effectiveUserId(userId);
  const filter = uid
    ? and(eq(bindings.id, bindingId), or(eq(bindings.userId, uid), eq(bindings.userId, ''), isNull(bindings.userId)))
    : eq(bindings.id, bindingId);
  const row = ctx.db.select().from(bindings).where(filter).all()[0];
  return row ? rowToBinding(row) : null;
}

/** 全状态绑定列表(工作台 overview 用), created_at DESC。 */
export async function listBindingsForUser(ctx: DbContext, userId?: string): Promise<BindingRow[]> {
  if (ctx.backend === 'postgres') return listBindingsForUserPg(ctx, userId);
  const uid = effectiveUserId(userId);
  const filter = uid ? or(eq(bindings.userId, uid), eq(bindings.userId, ''), isNull(bindings.userId)) : undefined;
  const rows = ctx.db.select().from(bindings).where(filter).orderBy(desc(bindings.createdAt)).all();
  return rows.map(rowToBinding);
}

export async function setBindingGraphStatus(
  ctx: DbContext, bindingId: string, graphStatus: BindingGraphStatus, userId?: string,
): Promise<boolean> {
  if (ctx.backend === 'postgres') return setBindingGraphStatusPg(ctx, bindingId, graphStatus, userId);
  const uid = effectiveUserId(userId);
  const filter = uid
    ? and(eq(bindings.id, bindingId), or(eq(bindings.userId, uid), eq(bindings.userId, ''), isNull(bindings.userId)))
    : eq(bindings.id, bindingId);
  const res = ctx.db.update(bindings)
    .set({ graphStatus: JSON.stringify(graphStatus) })
    .where(filter).run();
  return res.changes > 0;
}

/** bindings drizzle 行 -> BindingRow(所有读取函数共用, 含 graphStatus)。 */
function rowToBinding(r: (typeof bindings)['$inferSelect']): BindingRow {
  return {
    id: r.id, documentId: r.documentId, contractNo: r.contractNo, relation: r.relation,
    sourceRefs: JSON.parse(r.sourceRefs) as SourceSpan[],
    confidence: r.confidence, createdBy: r.createdBy,
    status: (r.status ?? 'confirmed') as BindingStatus,
    confirmationSource: (r.confirmationSource ?? null) as ConfirmationSource | null,
    proposedBy: (r.proposedBy ?? null) as BindingProposedBy | null,
    evidence: r.evidence ? (JSON.parse(r.evidence) as BindingEvidence) : null,
    graphStatus: parseGraphStatus(r.graphStatus ?? null),
  };
}
```

并把既有 `listBindingsForContract` / `findBindingByDocAndContract` / `listBindingProposals` 的行映射改为 `rowToBinding(...)` + 各自附加字段（docType/fileName），减少重复（graphStatus 顺带可读）。

3f. `postgres-repositories.ts` 加 PG 孪生（照 saveBindingPg 的手写 SQL 风格）：

```ts
export async function findBindingByIdPg(
  ctx: PostgresDbContext, bindingId: string, userId?: string,
): Promise<BindingRow | null> {
  const uid = effectiveUserId(userId);
  const rows = await ctx.pool.query(
    'SELECT * FROM bindings WHERE id = $1 AND ($2 = \'\' OR user_id = $2 OR user_id = \'\' OR user_id IS NULL)',
    [bindingId, uid],
  );
  return rows.rows[0] ? bindingRowFromPg(rows.rows[0]) : null;
}

export async function listBindingsForUserPg(ctx: PostgresDbContext, userId?: string): Promise<BindingRow[]> {
  const uid = effectiveUserId(userId);
  const rows = await ctx.pool.query(
    'SELECT * FROM bindings WHERE ($1 = \'\' OR user_id = $1 OR user_id = \'\' OR user_id IS NULL) ORDER BY created_at DESC',
    [uid],
  );
  return rows.rows.map(bindingRowFromPg);
}

export async function setBindingGraphStatusPg(
  ctx: PostgresDbContext, bindingId: string, graphStatus: BindingGraphStatus, userId?: string,
): Promise<boolean> {
  const uid = effectiveUserId(userId);
  const res = await ctx.pool.query(
    'UPDATE bindings SET graph_status = $3 WHERE id = $1 AND ($2 = \'\' OR user_id = $2 OR user_id = \'\' OR user_id IS NULL)',
    [bindingId, uid, JSON.stringify(graphStatus)],
  );
  return (res.rowCount ?? 0) > 0;
}
```

其中 `bindingRowFromPg` 照既有 PG 绑定行映射抽出的公共函数（`evidence: r.evidence as BindingEvidence | null` 保留，追加 `graphStatus: parseGraphStatus(r.graph_status ?? null)`——PG 端 graph_status 是 text，需本地再放一份 parseGraphStatus 或从 repositories 导入；从 repositories.ts 导入 `parseGraphStatus` 需 export，直接 export 它）。repositories.ts 里 `findBindingById`/`listBindingsForUser`/`setBindingGraphStatus` 顶部从 postgres-repositories import 三个孪生（照 listUserDocumentsPg 的 import 模式）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test --workspace apps/server -- test/pipeline/bindingGraphStatus.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: 全量验证 + 提交**

```bash
npm run build && npm run lint && npm test
git add apps/server/src/pipeline/db/schema.ts apps/server/src/pipeline/db/postgres-schema.ts apps/server/src/pipeline/db/client.ts apps/server/src/pipeline/db/repositories.ts apps/server/src/pipeline/db/postgres-repositories.ts apps/server/test/pipeline/bindingGraphStatus.test.ts
git commit -m "feat(db): bindings.graph_status 列 + findBindingById/listBindingsForUser/setBindingGraphStatus"
```

---

### Task 2: 锚点泛化 — buildAnchorsFromFields（发票/提单等通用文档 → VoucherAnchors）

**Files:**
- Modify: `apps/server/src/pipeline/bindingProposal.ts`
- Test: `apps/server/test/pipeline/bindingAnchors.test.ts`（新建）

**Interfaces:**
- Consumes: `VoucherAnchors`（`../schemas/vouchers.js`，字段 contractNo?/buyer?/seller?/date?/amount?/quantityTon?）；`extractAnchors(voucherType, fields)`（仅三类图片凭证）
- Produces: `export function buildAnchorsFromFields(docType: string, fields: Record<string, { value: string | number }>): VoucherAnchors`

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/test/pipeline/bindingAnchors.test.ts
import { describe, it, expect } from 'vitest';
import { buildAnchorsFromFields } from '../../src/pipeline/bindingProposal.js';

describe('buildAnchorsFromFields(非图片凭证文档)', () => {
  it('发票: 合同号/买方/卖方/金额/日期字段映射到锚点', () => {
    const a = buildAnchorsFromFields('发票', {
      合同号: { value: 'HT-2024-001' },
      买方: { value: '甲公司' },
      卖方: { value: '乙公司' },
      价税合计: { value: '12345.67' },
      开票日期: { value: '2024-08-01' },
    });
    expect(a).toEqual({
      contractNo: 'HT-2024-001', buyer: '甲公司', seller: '乙公司',
      date: '2024-08-01', amount: 12345.67,
    });
  });

  it('提单: 甲方/乙方(合同角色别名)与数量解析', () => {
    const a = buildAnchorsFromFields('提单', {
      合同编号: { value: 'CJXC-131' },
      甲方: { value: '买方公司' },
      乙方: { value: '卖方公司' },
      数量: { value: '150' },
    });
    expect(a.contractNo).toBe('CJXC-131');
    expect(a.buyer).toBe('买方公司');
    expect(a.seller).toBe('卖方公司');
    expect(a.quantityTon).toBe(150);
  });

  it('空字段/无法解析的数值 -> 对应锚点缺省', () => {
    const a = buildAnchorsFromFields('装箱单', { 备注: { value: '无' } });
    expect(a).toEqual({});
  });

  it('无可用字段返回空对象(调用方以此判定缺锚点)', () => {
    expect(buildAnchorsFromFields('其他', {})).toEqual({});
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/pipeline/bindingAnchors.test.ts`
Expected: FAIL — buildAnchorsFromFields 未导出

- [ ] **Step 3: 实现（bindingProposal.ts，generateBindingProposals 之前）**

```ts
import type { VoucherAnchors } from '../schemas/vouchers.js';

/** 首个非空字段值(转 string)。 */
function firstStr(fields: Record<string, { value: string | number }>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = fields[k]?.value;
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return undefined;
}

/** 首个可解析为有限数的字段。 */
function firstNum(fields: Record<string, { value: string | number }>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = fields[k]?.value;
    if (v === undefined || v === null || String(v).trim() === '') continue;
    const n = Number(String(v).replace(/[,\s]/g, ''));
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/**
 * 通用文档(发票/提单/装箱单等, 无专用 voucher schema)的抽取字段 -> 绑定锚点。
 * 字段名取自抽取器约定(extraction.ts REL_ROLE_BY_FIELD / KEY_FIELDS):
 * 三类图片凭证走 extractAnchors, 不要用本函数替代。
 */
export function buildAnchorsFromFields(
  _docType: string,
  fields: Record<string, { value: string | number }>,
): VoucherAnchors {
  const anchors: VoucherAnchors = {};
  const contractNo = firstStr(fields, ['合同号', '合同编号']);
  if (contractNo) anchors.contractNo = contractNo;
  const buyer = firstStr(fields, ['买方', '甲方', '收货人']);
  if (buyer) anchors.buyer = buyer;
  const seller = firstStr(fields, ['卖方', '乙方', '发货人']);
  if (seller) anchors.seller = seller;
  const date = firstStr(fields, ['日期', '开票日期', '签发日期', '签订日期']);
  if (date) anchors.date = date;
  const amount = firstNum(fields, ['金额', '价税合计', '合计金额']);
  if (amount !== undefined) anchors.amount = amount;
  const qty = firstNum(fields, ['数量', '重量_吨', '交货总量_吨']);
  if (qty !== undefined) anchors.quantityTon = qty;
  return anchors;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test --workspace apps/server -- test/pipeline/bindingAnchors.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: 全量验证 + 提交**

```bash
npm run build && npm run lint && npm test
git add apps/server/src/pipeline/bindingProposal.ts apps/server/test/pipeline/bindingAnchors.test.ts
git commit -m "feat(binding): buildAnchorsFromFields 通用文档锚点泛化"
```

---

### Task 3: 图谱同步服务 — repo.removeEdge + bindingGraphSync

**Files:**
- Modify: `apps/server/src/graph/repo.ts`（文件末尾追加 removeEdge）
- Create: `apps/server/src/pipeline/bindingGraphSync.ts`
- Test: `apps/server/test/pipeline/bindingGraphSync.test.ts`（新建）

**Interfaces:**
- Consumes: `createEntity(input: {kind;name;props?}): Promise<GraphEntity & {created:boolean}>`、`mergeEdge(input: {srcId;dstId;kind;props?;confidence?}): Promise<GraphEdge>`（repo.ts）；`normalizeName(raw)`（graph/normalize.js——**Contract 节点名必须用它归一化**，与 graphWriter 一致，否则 MERGE 出重复节点）
- Produces:

```ts
export type GraphSyncOutcome = 'ok' | 'skipped' | 'failed';
export interface BindingGraphSyncResult { outcome: GraphSyncOutcome; reason?: string }

export async function syncBindingEdge(input: {
  docId: string; docType?: string; contractNo: string;
  relation: string; bindingId: string; confidence: number;
}): Promise<BindingGraphSyncResult>

export async function removeBindingEdge(input: {
  docId: string; contractNo: string;
}): Promise<BindingGraphSyncResult>
```

- [ ] **Step 1: repo.ts 追加 removeEdge（真实 Neo4j IO，单测走 io 注入不碰它）**

```ts
export interface RemoveEdgeInput {
  srcId: string;
  kind: string;
  dstId: string;
}
/** 按 (src, type, dst) 删边, 返回删除条数(0 = 无匹配)。幂等。 */
export async function removeEdge(input: RemoveEdgeInput): Promise<number> {
  const session = getDriver().session({ defaultAccessMode: neo4j.session.WRITE });
  try {
    const cypher = `
      MATCH (a)-[r:$($kind)]->(b)
      WHERE elementId(a) = $srcId AND elementId(b) = $dstId
      DELETE r RETURN count(r) AS removed
    `;
    const result = await session.executeWrite((txc) =>
      txc.run(cypher, { srcId: input.srcId, dstId: input.dstId, kind: input.kind }),
    );
    const rec = result.records[0];
    return Number(rec?.get('removed') ?? 0);
  } finally {
    await session.close();
  }
}
```

- [ ] **Step 2: bindingGraphSync.ts 实现（io 注入, graphWriter 模式）**

```ts
// apps/server/src/pipeline/bindingGraphSync.ts
// 工作台绑定 -> Neo4j binds 边同步(spec 2026-08-18 §5.2)。业务写入永不
// 被图同步阻塞: 未配置 -> 'skipped'; 驱动错误 -> 'failed'(带 reason), 调用方
// 落 bindings.graph_status 供前端角标/重试。io 可注入, 单测无需 Neo4j。
import { createEntity, mergeEdge, removeEdge, findEntities } from '../graph/repo.js';
import { normalizeName } from '../graph/normalize.js';

export type GraphSyncOutcome = 'ok' | 'skipped' | 'failed';
export interface BindingGraphSyncResult { outcome: GraphSyncOutcome; reason?: string }

export interface BindingGraphSyncIo {
  createEntity(i: { kind: string; name: string; props?: Record<string, unknown> }): Promise<{ elementId: string }>;
  mergeEdge(i: { srcId: string; dstId: string; kind: string; props?: Record<string, unknown>; confidence?: number }): Promise<unknown>;
  removeEdge(i: { srcId: string; kind: string; dstId: string }): Promise<number>;
  findEntityByName(kind: string, name: string): Promise<{ elementId: string } | null>;
}

export const defaultBindingGraphSyncIo: BindingGraphSyncIo = {
  createEntity: (i) => createEntity(i),
  mergeEdge: (i) => mergeEdge(i),
  removeEdge: (i) => removeEdge(i),
  findEntityByName: async (kind, name) => {
    const hits = await findEntities({ kind, name, exact: true });
    return hits[0] ?? null;
  },
};

export const BINDS_EDGE = 'binds';

async function ensureNode(
  io: BindingGraphSyncIo, kind: string, name: string, props: Record<string, unknown>,
  createFallback: () => Promise<{ elementId: string }>,
): Promise<{ elementId: string }> {
  const found = await io.findEntityByName(kind, name);
  if (found) return found;
  return createFallback();
}

export async function syncBindingEdge(
  input: { docId: string; docType?: string; contractNo: string; relation: string; bindingId: string; confidence: number },
  io: BindingGraphSyncIo = defaultBindingGraphSyncIo,
): Promise<BindingGraphSyncResult> {
  if (!process.env.NEO4J_PASSWORD) return { outcome: 'skipped', reason: 'NEO4J_PASSWORD not set' };
  try {
    // 节点名与 graphWriter 一致: Document.name = docId; Contract.name = normalizeName(合同号)。
    const contractName = normalizeName(input.contractNo);
    if (!contractName) return { outcome: 'failed', reason: 'contractNo normalized to empty' };
    const docNode = await ensureNode(io, 'Document', input.docId,
      { docId: input.docId, ...(input.docType ? { docType: input.docType } : {}) },
      () => io.createEntity({ kind: 'Document', name: input.docId, props: { docId: input.docId } }));
    const contractNode = await ensureNode(io, 'Contract', contractName,
      { rawName: input.contractNo },
      () => io.createEntity({ kind: 'Contract', name: contractName, props: { rawName: input.contractNo } }));
    await io.mergeEdge({
      srcId: docNode.elementId,
      dstId: contractNode.elementId,
      kind: BINDS_EDGE,
      confidence: input.confidence,
      props: { bindingId: input.bindingId, relation: input.relation, source: 'workbench' },
    });
    return { outcome: 'ok' };
  } catch (e) {
    return { outcome: 'failed', reason: e instanceof Error ? e.message : String(e) };
  }
}

export async function removeBindingEdge(
  input: { docId: string; contractNo: string },
  io: BindingGraphSyncIo = defaultBindingGraphSyncIo,
): Promise<BindingGraphSyncResult> {
  if (!process.env.NEO4J_PASSWORD) return { outcome: 'skipped', reason: 'NEO4J_PASSWORD not set' };
  try {
    const contractName = normalizeName(input.contractNo);
    if (!contractName) return { outcome: 'failed', reason: 'contractNo normalized to empty' };
    const docNode = await io.findEntityByName('Document', input.docId);
    const contractNode = await io.findEntityByName('Contract', contractName);
    if (!docNode || !contractNode) return { outcome: 'ok', reason: 'nodes missing (nothing to remove)' };
    await io.removeEdge({ srcId: docNode.elementId, kind: BINDS_EDGE, dstId: contractNode.elementId });
    return { outcome: 'ok' };
  } catch (e) {
    return { outcome: 'failed', reason: e instanceof Error ? e.message : String(e) };
  }
}
```

注意：`findEntities` 的输入签名是 `{kind?, name?, exact?}`（repo.ts:218），上面调用匹配。

- [ ] **Step 3: 写测试**

```ts
// apps/server/test/pipeline/bindingGraphSync.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { syncBindingEdge, removeBindingEdge, type BindingGraphSyncIo } from '../../src/pipeline/bindingGraphSync.js';

function makeIo() {
  const nodes = new Map<string, string>(); // `${kind}:${name}` -> elementId
  const edges = new Set<string>(); // `${srcId}|binds|${dstId}`
  let seq = 0;
  const id = (kind: string, name: string) => {
    const key = `${kind}:${name}`;
    if (!nodes.has(key)) nodes.set(key, `e${seq++}`);
    return { elementId: nodes.get(key)! };
  };
  const io: BindingGraphSyncIo = {
    createEntity: async (i) => id(i.kind, i.name),
    mergeEdge: async (i) => { edges.add(`${i.srcId}|${i.kind}|${i.dstId}`); return {}; },
    removeEdge: async (i) => {
      const key = `${i.srcId}|${i.kind}|${i.dstId}`;
      if (!edges.has(key)) return 0;
      edges.delete(key);
      return 1;
    },
    findEntityByName: async (kind, name) => nodes.get(`${kind}:${name}`)
      ? { elementId: nodes.get(`${kind}:${name}`)! } : null,
  };
  return { io, nodes, edges };
}

const prevPwd = process.env.NEO4J_PASSWORD;
beforeEach(() => { process.env.NEO4J_PASSWORD = 'test'; });
afterEach(() => {
  if (prevPwd === undefined) delete process.env.NEO4J_PASSWORD;
  else process.env.NEO4J_PASSWORD = prevPwd;
});

describe('syncBindingEdge', () => {
  it('未配置 -> skipped', async () => {
    delete process.env.NEO4J_PASSWORD;
    const r = await syncBindingEdge({ docId: 'D1', contractNo: 'HT-1', relation: '付款', bindingId: 'B1', confidence: 1 });
    expect(r.outcome).toBe('skipped');
  });

  it('正常写入: Document/Contract 节点 + binds 边', async () => {
    const { io, edges } = makeIo();
    const r = await syncBindingEdge({ docId: 'D1', docType: '发票', contractNo: 'HT-1', relation: '付款', bindingId: 'B1', confidence: 0.9 }, io);
    expect(r.outcome).toBe('ok');
    expect(edges.size).toBe(1);
    expect([...edges][0]).toContain('binds');
  });

  it('已有 Contract 节点(如 HT-2024-001)复用不重建', async () => {
    const { io, nodes } = makeIo();
    nodes.set('Contract:HT-2024-001', 'existing-eid');
    const r = await syncBindingEdge({ docId: 'D1', contractNo: 'HT-2024-001', relation: 'x', bindingId: 'B1', confidence: 1 }, io);
    expect(r.outcome).toBe('ok');
    expect(nodes.get('Contract:HT-2024-001')).toBe('existing-eid');
  });

  it('io 抛错 -> failed + reason, 不抛出', async () => {
    const io = { ...makeIo().io, mergeEdge: async () => { throw new Error('boom'); } };
    const r = await syncBindingEdge({ docId: 'D1', contractNo: 'HT-1', relation: 'x', bindingId: 'B1', confidence: 1 }, io);
    expect(r.outcome).toBe('failed');
    expect(r.reason).toBe('boom');
  });
});

describe('removeBindingEdge', () => {
  it('同步后可解绑删边; 无边时也返回 ok', async () => {
    const { io, edges } = makeIo();
    await syncBindingEdge({ docId: 'D1', contractNo: 'HT-1', relation: 'x', bindingId: 'B1', confidence: 1 }, io);
    expect(edges.size).toBe(1);
    const r = await removeBindingEdge({ docId: 'D1', contractNo: 'HT-1' }, io);
    expect(r.outcome).toBe('ok');
    expect(edges.size).toBe(0);
    const again = await removeBindingEdge({ docId: 'D1', contractNo: 'HT-1' }, io);
    expect(again.outcome).toBe('ok');
  });
});
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test --workspace apps/server -- test/pipeline/bindingGraphSync.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: 全量验证 + 提交**

```bash
npm run build && npm run lint && npm test
git add apps/server/src/graph/repo.ts apps/server/src/pipeline/bindingGraphSync.ts apps/server/test/pipeline/bindingGraphSync.test.ts
git commit -m "feat(graph): bindingGraphSync 同步服务 + repo.removeEdge"
```

---

### Task 4: 候选编排 — buildBindingCandidates

**Files:**
- Modify: `apps/server/src/pipeline/bindingProposal.ts`（追加编排函数；或若文件已大可新建 `apps/server/src/pipeline/bindingCandidates.ts`——选择新建，保持 bindingProposal 纯函数职责）
- Create: `apps/server/src/pipeline/bindingCandidates.ts`
- Test: `apps/server/test/pipeline/bindingCandidates.test.ts`

**Interfaces:**
- Consumes: `loadLatestExtractionByDocId(ctx, docId, userId): Promise<ExtractionRow | null>`（repositories.ts:381）；`listContractLedgerEntries(ctx, userId)`；`listBindingsForUser(ctx, userId)`（Task 1）；`generateBindingProposals`、`buildAnchorsFromFields`（Task 2）；`extractAnchors(voucherType, fields)`（schemas/vouchers.ts，VoucherType = '货转单'|'付款凭证'|'化验报告'）
- Produces:

```ts
export interface BindingCandidate {
  contractNo: string;
  score: number;
  route: 'auto_rule' | 'human' | 'none';
  evidence: BindingEvidence;   // 从 bindingProposal.ts import
  existingBindingId: string | null; // 已有 proposed/confirmed 行则给 id
  ledger: { contractNo: string; displayContractNo: string; title: string; docType: string } | null;
}
export interface BindingCandidatesResult {
  hasExtraction: boolean;
  anchors: VoucherAnchors;
  candidates: BindingCandidate[]; // 按 score DESC
}
export async function buildBindingCandidates(
  ctx: DbContext, docId: string, userId?: string,
): Promise<BindingCandidatesResult>
```

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/test/pipeline/bindingCandidates.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import {
  createDocumentStub, saveExtraction, upsertContractLedgerEntry, saveBinding,
} from '../../src/pipeline/db/repositories.js';
import { buildBindingCandidates } from '../../src/pipeline/bindingCandidates.js';
import type { ContractLedgerEntry } from '../../src/pipeline/contractLedger.js';

let ctx: DbContext;
beforeEach(() => { ctx = createDb(':memory:'); migrate(ctx.sqlite); });

function ledger(no: string, fields: ContractLedgerEntry['fields']): ContractLedgerEntry {
  return {
    contractNo: no, displayContractNo: no, docType: '合同', documentId: 'DOC-C', title: '',
    fields, fieldMeta: {}, overallConfidence: 1, needsReview: false, userId: 'u1',
  };
}

describe('buildBindingCandidates', () => {
  it('无抽取 -> hasExtraction=false', async () => {
    await createDocumentStub(ctx, { sourceUri: 'file:///a.pdf', docType: '发票' });
    const r = await buildBindingCandidates(ctx, 'DOC-1', 'u1');
    expect(r.hasExtraction).toBe(false);
    expect(r.candidates).toEqual([]);
  });

  it('发票(通用锚点): 合同号精确命中 -> auto_rule 0.99 头名候选', async () => {
    const { docId } = await createDocumentStub(ctx, { sourceUri: 'file:///inv.pdf', docType: '发票' });
    await saveExtraction(ctx, {
      documentId: docId, docType: '发票',
      fields: { 合同号: { value: 'HT-A', sourceSpans: [] }, 买方: { value: '甲公司', sourceSpans: [] } },
      fieldMeta: {}, overallConfidence: 1, needsReview: false,
    } as never);
    await upsertContractLedgerEntry(ctx, ledger('HT-A', { 甲方: { value: '甲公司', sourceSpans: [] } }), 'u1');
    const r = await buildBindingCandidates(ctx, docId, 'u1');
    expect(r.hasExtraction).toBe(true);
    expect(r.candidates[0]?.route).toBe('auto_rule');
    expect(r.candidates[0]?.score).toBe(0.99);
    expect(r.candidates[0]?.ledger?.contractNo).toBe('HT-A');
  });

  it('已落库的 proposed 行 -> existingBindingId 指向它', async () => {
    const { docId } = await createDocumentStub(ctx, { sourceUri: 'file:///v.pdf', docType: '发票' });
    await saveExtraction(ctx, {
      documentId: docId, docType: '发票',
      fields: { 合同号: { value: 'HT-B', sourceSpans: [] } },
      fieldMeta: {}, overallConfidence: 1, needsReview: false,
    } as never);
    await upsertContractLedgerEntry(ctx, ledger('HT-B', {}), 'u1');
    const bindingId = await saveBinding(ctx, {
      documentId: docId, contractNo: 'HT-B', relation: '凭证',
      sourceRefs: [], confidence: 0.99, createdBy: 'system',
      status: 'proposed', proposedBy: 'system', evidence: null,
    }, 'u1');
    const r = await buildBindingCandidates(ctx, docId, 'u1');
    expect(r.candidates.find((c) => c.contractNo === 'HT-B')?.existingBindingId).toBe(bindingId);
  });

  it('无锚点字段 -> candidates 空, anchors 空(前端提示手动绑定)', async () => {
    const { docId } = await createDocumentStub(ctx, { sourceUri: 'file:///c.pdf', docType: '其他' });
    await saveExtraction(ctx, {
      documentId: docId, docType: '其他',
      fields: { 备注: { value: 'x', sourceSpans: [] } },
      fieldMeta: {}, overallConfidence: 1, needsReview: false,
    } as never);
    const r = await buildBindingCandidates(ctx, docId, 'u1');
    expect(r.anchors).toEqual({});
    expect(r.candidates).toEqual([]);
  });
});
```

（`saveExtraction`/`createDocumentStub`/`upsertContractLedgerEntry` 的精确参数形状以 repositories.ts 实测为准——执行时先读函数签名，测试数据只需满足必填字段；`as never` 仅绕过 docType 联合类型的宽松写法可换成真实字面量。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/pipeline/bindingCandidates.test.ts`
Expected: FAIL — bindingCandidates.js 不存在

- [ ] **Step 3: 实现 bindingCandidates.ts**

```ts
// apps/server/src/pipeline/bindingCandidates.ts
// 工作台候选绑定编排(spec §5.1 /candidates): 读最新抽取 -> 锚点(图片凭证走
// extractAnchors, 其余走 buildAnchorsFromFields) -> 台账全量喂给纯函数
// generateBindingProposals -> 纯计算, 不落库。弱候选(route 'none')一并返回。
import type { DbContext } from './db/client.js';
import {
  loadLatestExtractionByDocId, listContractLedgerEntries, listBindingsForUser,
} from './db/repositories.js';
import { generateBindingProposals, buildAnchorsFromFields, type BindingEvidence } from './bindingProposal.js';
import { extractAnchors, type VoucherAnchors } from './schemas/vouchers.js';
import type { ContractLedgerEntry } from './contractLedger.js';

const VOUCHER_TYPES = new Set(['货转单', '付款凭证', '化验报告']);

export interface BindingCandidate {
  contractNo: string;
  score: number;
  route: 'auto_rule' | 'human' | 'none';
  evidence: BindingEvidence;
  existingBindingId: string | null;
  ledger: { contractNo: string; displayContractNo: string; title: string; docType: string } | null;
}

export interface BindingCandidatesResult {
  hasExtraction: boolean;
  anchors: VoucherAnchors;
  candidates: BindingCandidate[];
}

export async function buildBindingCandidates(
  ctx: DbContext, docId: string, userId?: string,
): Promise<BindingCandidatesResult> {
  const extraction = await loadLatestExtractionByDocId(ctx, docId, userId);
  if (!extraction) return { hasExtraction: false, anchors: {}, candidates: [] };

  const fields = extraction.fields as Record<string, { value: string | number; sourceSpans: unknown[] }>;
  const anchors: VoucherAnchors = VOUCHER_TYPES.has(extraction.docType)
    ? extractAnchors(extraction.docType as '货转单' | '付款凭证' | '化验报告', fields)
    : buildAnchorsFromFields(extraction.docType, fields);

  const hasAnyAnchor = anchors.contractNo !== undefined || anchors.buyer !== undefined
    || anchors.seller !== undefined || anchors.amount !== undefined
    || anchors.quantityTon !== undefined || anchors.date !== undefined;
  if (!hasAnyAnchor) return { hasExtraction: true, anchors, candidates: [] };

  const ledger = await listContractLedgerEntries(ctx, userId);
  const proposals = generateBindingProposals(anchors, ledger as unknown as Parameters<typeof generateBindingProposals>[1]);
  const bindings = await listBindingsForUser(ctx, userId);
  const activeByKey = new Map<string, string>();
  for (const b of bindings) {
    if (b.documentId === docId && b.status !== 'rejected') activeByKey.set(b.contractNo, b.id);
  }
  const ledgerByNo = new Map<string, ContractLedgerEntry>();
  for (const l of ledger) ledgerByNo.set(l.contractNo, l);

  const candidates: BindingCandidate[] = proposals
    .map((p) => {
      const l = ledgerByNo.get(p.contractNo);
      return {
        contractNo: p.contractNo,
        score: p.score,
        route: p.route,
        evidence: p.evidence,
        existingBindingId: activeByKey.get(p.contractNo) ?? null,
        ledger: l ? { contractNo: l.contractNo, displayContractNo: l.displayContractNo, title: l.title, docType: l.docType } : null,
      };
    })
    .sort((a, b) => b.score - a.score);
  return { hasExtraction: true, anchors, candidates };
}
```

（若 `generateBindingProposals(anchors, ledger)` 的第二参类型 `LedgerEntryLike[]` 与 `ContractLedgerEntry[]` 结构兼容——fields 值类型含 sourceSpans，兼容——可去掉 `as unknown as` 强转；以 tsc 为准。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test --workspace apps/server -- test/pipeline/bindingCandidates.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: 全量验证 + 提交**

```bash
npm run build && npm run lint && npm test
git add apps/server/src/pipeline/bindingCandidates.ts apps/server/test/pipeline/bindingCandidates.test.ts
git commit -m "feat(binding): buildBindingCandidates 候选编排(按需生成, 不落库)"
```

---

### Task 5: 读端点 — GET /api/bindings/{overview,proposals,candidates,contracts}

**Files:**
- Create: `apps/server/src/routes/bindings.ts`
- Modify: `apps/server/src/index.ts`（import + `app.use('/api/bindings/*', requireAuth)` + `app.route('/api/bindings', bindingsRoute)`，照 graph 路由三行模式 index.ts:17/100/118）
- Modify: `apps/server/src/pipeline/db/repositories.ts` + `postgres-repositories.ts`：`listUserDocuments` SELECT 增列 doc_type/source_uri（返回 `{id, docType, sourceUri, createdAt}`；graph 路由只用 id/createdAt，扩形兼容）
- Test: `apps/server/test/routes/bindingsRead.test.ts`

**Interfaces:**
- Consumes: Task 1 `listBindingsForUser`/`findBindingById`、Task 4 `buildBindingCandidates`、`listBindingProposals`、`listContractLedgerEntries`
- Produces（前端 Task 8 契约，冻结）:
  - `GET /overview` → `{ documents: [{ docId, fileName, docType, createdAt, bindings: [{ bindingId, contractNo, relation, status, confidence, confirmationSource, graphStatus }] }] }`（fileName = sourceUri 末段，原始名前端再解析）
  - `GET /proposals` → `{ proposals: [{ bindingId, documentId, docType, fileName, contractNo, relation, confidence, evidence, graphStatus }] }`
  - `GET /candidates?documentId=` → `{ hasExtraction, anchors, candidates: BindingCandidate[] }`；documentId 缺失 → 400
  - `GET /contracts` → `{ contracts: [{ contractNo, displayContractNo, docType, title, overallConfidence }] }`

- [ ] **Step 1: 写失败测试（review.test.ts 的 vi.mock 模式）**

```ts
// apps/server/test/routes/bindingsRead.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { AuthEnv } from '../../src/lib/auth-middleware.js';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import {
  createDocumentStub, saveExtraction, saveBinding, upsertContractLedgerEntry,
} from '../../src/pipeline/db/repositories.js';
import type { ContractLedgerEntry } from '../../src/pipeline/contractLedger.js';

const { ctxHolder } = vi.hoisted(() => ({ ctxHolder: { current: null as DbContext | null } }));
vi.mock('../../src/pipeline/db/dbBackend.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/pipeline/db/dbBackend.js')>();
  return { ...mod, getDbContext: () => ctxHolder.current };
});
const { bindingsRoute } = await import('../../src/routes/bindings.js');

function appAs(userId: string) {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { id: userId, email: 't@t', role: 'trader' } as never);
    await next();
  });
  app.route('/api/bindings', bindingsRoute);
  return app;
}

let ctx: DbContext;
beforeEach(() => { ctx = createDb(':memory:'); migrate(ctx.sqlite); ctxHolder.current = ctx; });

describe('GET /api/bindings/overview', () => {
  it('返回文档绑定总览: 未绑定文档 bindings=[], 已绑定带 contractNo', async () => {
    const a = await createDocumentStub(ctx, { sourceUri: 'file:///a.pdf', docType: '发票' });
    const b = await createDocumentStub(ctx, { sourceUri: 'file:///b.pdf', docType: '合同' });
    await saveBinding(ctx, {
      documentId: a.docId, contractNo: 'HT-1', relation: '付款',
      sourceRefs: [], confidence: 1, createdBy: 'system', status: 'confirmed',
      confirmationSource: 'human',
    }, 'u1');
    const res = await appAs('u1').request('/api/bindings/overview');
    expect(res.status).toBe(200);
    const data = await res.json() as { documents: Array<{ docId: string; bindings: Array<{ contractNo: string }> }> };
    const byId = new Map(data.documents.map((d) => [d.docId, d]));
    expect(byId.get(a.docId)?.bindings[0]?.contractNo).toBe('HT-1');
    expect(byId.get(b.docId)?.bindings).toEqual([]);
  });

  it('未认证 -> 401', async () => {
    const app = new Hono<AuthEnv>();
    app.route('/api/bindings', bindingsRoute);
    const res = await app.request('/api/bindings/overview');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/bindings/candidates', () => {
  it('缺 documentId -> 400', async () => {
    const res = await appAs('u1').request('/api/bindings/candidates');
    expect(res.status).toBe(400);
  });

  it('按需生成候选(纯计算), auto_rule 0.99 头名', async () => {
    const { docId } = await createDocumentStub(ctx, { sourceUri: 'file:///inv.pdf', docType: '发票' });
    await saveExtraction(ctx, {
      documentId: docId, docType: '发票',
      fields: { 合同号: { value: 'HT-X', sourceSpans: [] } },
      fieldMeta: {}, overallConfidence: 1, needsReview: false,
    } as never);
    const entry: ContractLedgerEntry = {
      contractNo: 'HT-X', displayContractNo: 'HT-X', docType: '合同', documentId: docId,
      title: 'T', fields: {}, fieldMeta: {}, overallConfidence: 1, needsReview: false, userId: 'u1',
    };
    await upsertContractLedgerEntry(ctx, entry, 'u1');
    const res = await appAs('u1').request(`/api/bindings/candidates?documentId=${docId}`);
    expect(res.status).toBe(200);
    const data = await res.json() as { candidates: Array<{ route: string; score: number }> };
    expect(data.candidates[0]?.route).toBe('auto_rule');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/routes/bindingsRead.test.ts`
Expected: FAIL — bindings.js 不存在

- [ ] **Step 3: 实现 routes/bindings.ts（本任务只做读端点）**

```ts
// apps/server/src/routes/bindings.ts
// 绑定工作台 REST 面(spec 2026-08-18 §5.1)。挂在 /api/bindings(requireAuth,
// index.ts)。写操作页面直连 + 前端二次确认, 不走对话审批链路。
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../lib/auth-middleware.js';
import { getDbContext } from '../pipeline/db/dbBackend.js';
import type { DbContext } from '../pipeline/db/client.js';
import {
  listUserDocuments, listBindingsForUser, listBindingProposals, listContractLedgerEntries,
} from '../pipeline/db/repositories.js';
import { buildBindingCandidates } from '../pipeline/bindingCandidates.js';

export const bindingsRoute = new Hono<AuthEnv>();

function ctx(): DbContext { return getDbContext(); }

bindingsRoute.use('*', async (c, next) => {
  if (!c.get('user')) return c.json({ error: 'unauthorized' }, 401);
  await next();
});

/** GET /overview — 每文档绑定状态总览(前端按未绑定/已绑定分组)。 */
bindingsRoute.get('/overview', async (c) => {
  const user = c.get('user')!;
  const [docs, bindings] = await Promise.all([
    listUserDocuments(ctx(), user.id),
    listBindingsForUser(ctx(), user.id),
  ]);
  const byDoc = new Map<string, Array<Record<string, unknown>>>();
  for (const b of bindings) {
    if (b.status === 'rejected') continue;
    const list = byDoc.get(b.documentId) ?? [];
    list.push({
      bindingId: b.id, contractNo: b.contractNo, relation: b.relation,
      status: b.status, confidence: b.confidence,
      confirmationSource: b.confirmationSource, graphStatus: b.graphStatus,
    });
    byDoc.set(b.documentId, list);
  }
  const documents = docs.map((d) => ({
    docId: d.id,
    fileName: (d.sourceUri ?? '').split('/').pop() ?? d.sourceUri ?? '',
    docType: d.docType,
    createdAt: d.createdAt,
    bindings: byDoc.get(d.id) ?? [],
  }));
  return c.json({ documents });
});

/** GET /proposals — 现有 status=proposed 建议行。 */
bindingsRoute.get('/proposals', async (c) => {
  const user = c.get('user')!;
  const rows = await listBindingProposals(ctx(), user.id);
  return c.json({
    proposals: rows.map((r) => ({
      bindingId: r.id, documentId: r.documentId, docType: r.docType, fileName: r.fileName,
      contractNo: r.contractNo, relation: r.relation, confidence: r.confidence,
      evidence: r.evidence, graphStatus: r.graphStatus,
    })),
  });
});

const candidatesSchema = z.object({ documentId: z.string().min(1, 'documentId 必填') });

/** GET /candidates?documentId= — 按需生成候选(纯计算, 不落库)。 */
bindingsRoute.get('/candidates', async (c) => {
  const user = c.get('user')!;
  const parsed = candidatesSchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ error: 'invalid query params', detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) }, 400);
  }
  const res = await buildBindingCandidates(ctx(), parsed.data.documentId, user.id);
  return c.json(res);
});

/** GET /contracts — 合同台账(手动绑定下拉)。 */
bindingsRoute.get('/contracts', async (c) => {
  const user = c.get('user')!;
  const entries = await listContractLedgerEntries(ctx(), user.id);
  return c.json({
    contracts: entries.map((e) => ({
      contractNo: e.contractNo, displayContractNo: e.displayContractNo,
      docType: e.docType, title: e.title, overallConfidence: e.overallConfidence,
    })),
  });
});
```

`index.ts` 三行接线（照 graph 模式）：

```ts
import { bindingsRoute } from './routes/bindings.js';       // import 区
app.use('/api/bindings/*', requireAuth);                    // 100 行区
app.route('/api/bindings', bindingsRoute);                  // 挂载区(graph 挂载之后)
```

`listUserDocuments` SQLite 分支 SELECT 改为：

```ts
"SELECT id, doc_type, source_uri, created_at FROM documents WHERE (user_id = ? OR user_id = '' OR user_id IS NULL) ORDER BY created_at DESC"
```

返回 `Array<{ id: string; docType: string; sourceUri: string | null; createdAt: string }>`；PG 孪生同步（`SELECT id, doc_type, source_uri, created_at ...`，行映射 `docType: r.doc_type, sourceUri: r.source_uri`）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test --workspace apps/server -- test/routes/bindingsRead.test.ts`
Expected: PASS

- [ ] **Step 5: 全量验证 + 提交**

```bash
npm run build && npm run lint && npm test
git add apps/server/src/routes/bindings.ts apps/server/src/index.ts apps/server/src/pipeline/db/repositories.ts apps/server/src/pipeline/db/postgres-repositories.ts apps/server/test/routes/bindingsRead.test.ts
git commit -m "feat(bindings): 工作台读端点 overview/proposals/candidates/contracts"
```

---

### Task 6: 写端点 — confirm / reject / 手动创建 / unbind / batch-confirm + 图同步接线

**Files:**
- Modify: `apps/server/src/routes/bindings.ts`
- Test: `apps/server/test/routes/bindingsWrite.test.ts`

**Interfaces:**
- Consumes: `findBindingById`/`updateBindingStatus`/`saveBinding`/`findBindingByDocAndContract`/`listBindingsForContract`/`setBindingGraphStatus`；Task 3 `syncBindingEdge`/`removeBindingEdge`
- Produces（前端契约）:
  - `POST /confirm {bindingId}` → 200 `{ok:true, bindingId, graphSync:'ok'|'skipped'|'failed', graphReason?}`；404 不存在；409 已非 proposed
  - `POST /reject {bindingId}` → 200 `{ok:true}`；404/409 同上
  - `POST / {documentId, contractNo, relation, note?}` → 200 `{ok:true, bindingId, existing?:true, graphSync}`；已有非 rejected 同对行 → 幂等返回 existing:true
  - `POST /unbind {bindingId}` → 200 `{ok:true, graphSync}`；非 confirmed → 409
  - `POST /batch-confirm {bindingIds:string[]}` → 200 `{results:[{bindingId, ok:true, graphSync} | {bindingId, ok:false, error}]}`（部分成功不回滚）

- [ ] **Step 1: 写失败测试（骨架同 Task 5，vi.mock 同文件可复用 hoisted 模式；关键用例）**

```ts
// apps/server/test/routes/bindingsWrite.test.ts — 与 bindingsRead.test.ts 相同的
// vi.mock/appAs/beforeEach 骨架（照抄），追加写端点用例：
describe('POST /api/bindings/confirm|reject|unbind|batch-confirm', () => {
  async function seedProposed(): Promise<string> {
    const { docId } = await createDocumentStub(ctx, { sourceUri: 'file:///v.pdf', docType: '付款凭证' });
    return saveBinding(ctx, {
      documentId: docId, contractNo: 'HT-1', relation: '付款',
      sourceRefs: [], confidence: 0.9, createdBy: 'system',
      status: 'proposed', proposedBy: 'system', evidence: null,
    }, 'u1');
  }

  it('confirm: proposed->confirmed(human), 无 Neo4j -> graphSync=skipped 且 graph_status 落库', async () => {
    delete process.env.NEO4J_PASSWORD; // 测试环境本就无; 保险显式删
    const bindingId = await seedProposed();
    const res = await appAs('u1').request('/api/bindings/confirm', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bindingId }),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as { graphSync: string };
    expect(data.graphSync).toBe('skipped');
    const row = await findBindingById(ctx!, bindingId, 'u1');
    expect(row?.status).toBe('confirmed');
    expect(row?.confirmationSource).toBe('human');
    expect(row?.graphStatus?.status).toBe('skipped');
  });

  it('重复 confirm -> 409', async () => {
    const bindingId = await seedProposed();
    await appAs('u1').request('/api/bindings/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bindingId }) });
    const res = await appAs('u1').request('/api/bindings/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bindingId }) });
    expect(res.status).toBe(409);
  });

  it('reject: proposed->rejected', async () => {
    const bindingId = await seedProposed();
    const res = await appAs('u1').request('/api/bindings/reject', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bindingId }) });
    expect(res.status).toBe(200);
    expect((await findBindingById(ctx!, bindingId, 'u1'))?.status).toBe('rejected');
  });

  it('手动创建: 已有非 rejected 同对行 -> 幂等 existing:true', async () => {
    const { docId } = await createDocumentStub(ctx, { sourceUri: 'file:///m.pdf', docType: '发票' });
    const existingId = await saveBinding(ctx, { documentId: docId, contractNo: 'HT-2', relation: '凭证', sourceRefs: [], confidence: 0.8, createdBy: 'agent', status: 'confirmed', confirmationSource: 'human' }, 'u1');
    const res = await appAs('u1').request('/api/bindings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentId: docId, contractNo: 'HT-2', relation: '凭证' }),
    });
    const data = await res.json() as { existing?: boolean; bindingId: string };
    expect(data.existing).toBe(true);
    expect(data.bindingId).toBe(existingId);
  });

  it('unbind: confirmed->rejected', async () => {
    const bindingId = await seedProposed();
    await appAs('u1').request('/api/bindings/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bindingId }) });
    const res = await appAs('u1').request('/api/bindings/unbind', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bindingId }) });
    expect(res.status).toBe(200);
    expect((await findBindingById(ctx!, bindingId, 'u1'))?.status).toBe('rejected');
  });

  it('batch-confirm: 逐条结果, 失败项 ok:false 不影响他行', async () => {
    const id1 = await seedProposed();
    const res = await appAs('u1').request('/api/bindings/batch-confirm', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bindingIds: [id1, 'BD-not-exist'] }),
    });
    const data = await res.json() as { results: Array<{ bindingId: string; ok: boolean }> };
    expect(data.results.find((r) => r.bindingId === id1)?.ok).toBe(true);
    expect(data.results.find((r) => r.bindingId === 'BD-not-exist')?.ok).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/routes/bindingsWrite.test.ts`
Expected: FAIL — 路由不存在

- [ ] **Step 3: 实现（bindings.ts 追加）**

```ts
import {
  findBindingById, updateBindingStatus, saveBinding, findBindingByDocAndContract,
  listBindingsForContract, setBindingGraphStatus, type BindingGraphStatus,
} from '../pipeline/db/repositories.js';
import { syncBindingEdge, removeBindingEdge, type GraphSyncOutcome } from '../pipeline/bindingGraphSync.js';

const bindingIdSchema = z.object({ bindingId: z.string().min(1) });

async function graphStatusFor(outcome: GraphSyncOutcome, reason?: string): Promise<BindingGraphStatus> {
  return outcome === 'ok'
    ? { status: 'ok', syncedAt: new Date().toISOString() }
    : { status: outcome, ...(reason ? { reason } : {}), syncedAt: new Date().toISOString() };
}

/** confirm 单条(内部, batch 复用)。前置: 行存在且 status='proposed'。 */
async function confirmOne(db: DbContext, userId: string, bindingId: string) {
  const row = await findBindingById(db, bindingId, userId);
  if (!row) return { status: 404 as const, body: { error: 'binding not found', bindingId } };
  if (row.status !== 'proposed') return { status: 409 as const, body: { error: `binding status is ${row.status}, expected proposed`, bindingId } };
  const updated = await updateBindingStatus(db, bindingId, 'confirmed', 'human', userId);
  if (!updated) return { status: 409 as const, body: { error: 'concurrent state change', bindingId } };
  const sync = await syncBindingEdge({
    docId: row.documentId, contractNo: row.contractNo, relation: row.relation,
    bindingId: row.id, confidence: row.confidence,
  });
  const gs = await graphStatusFor(sync.outcome, sync.reason);
  await setBindingGraphStatus(db, bindingId, gs, userId);
  return { status: 200 as const, body: { ok: true, bindingId, graphSync: sync.outcome, ...(sync.reason ? { graphReason: sync.reason } : {}) } };
}

bindingsRoute.post('/confirm', async (c) => {
  const user = c.get('user')!;
  const parsed = bindingIdSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid body' }, 400);
  const r = await confirmOne(ctx(), user.id, parsed.data.bindingId);
  return c.json(r.body, r.status);
});

bindingsRoute.post('/reject', async (c) => {
  const user = c.get('user')!;
  const parsed = bindingIdSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid body' }, 400);
  const db = ctx();
  const row = await findBindingById(db, parsed.data.bindingId, user.id);
  if (!row) return c.json({ error: 'binding not found' }, 404);
  if (row.status !== 'proposed') return c.json({ error: `binding status is ${row.status}, expected proposed` }, 409);
  const ok = await updateBindingStatus(db, parsed.data.bindingId, 'rejected', 'human', user.id);
  if (!ok) return c.json({ error: 'concurrent state change' }, 409);
  return c.json({ ok: true, bindingId: parsed.data.bindingId });
});

const createSchema = z.object({
  documentId: z.string().min(1),
  contractNo: z.string().min(1),
  relation: z.string().min(1),
  note: z.string().optional(),
});

/** 手动创建绑定(upsert 语义, spec §7 幂等)。 */
bindingsRoute.post('/', async (c) => {
  const user = c.get('user')!;
  const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid body', detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) }, 400);
  const { documentId, contractNo, relation } = parsed.data;
  const db = ctx();
  const existing = await findBindingByDocAndContract(db, documentId, contractNo, user.id);
  if (existing && existing.status !== 'rejected') {
    return c.json({ ok: true, bindingId: existing.id, existing: true, graphSync: 'ok' });
  }
  const bindingId = await saveBinding(db, {
    documentId, contractNo, relation, sourceRefs: [],
    confidence: 1, createdBy: user.id,
    status: 'confirmed', confirmationSource: 'human', proposedBy: 'agent',
  }, user.id);
  const sync = await syncBindingEdge({ docId: documentId, contractNo, relation, bindingId, confidence: 1 });
  const gs = await graphStatusFor(sync.outcome, sync.reason);
  await setBindingGraphStatus(db, bindingId, gs, user.id);
  return c.json({ ok: true, bindingId, graphSync: sync.outcome, ...(sync.reason ? { graphReason: sync.reason } : {}) });
});

bindingsRoute.post('/unbind', async (c) => {
  const user = c.get('user')!;
  const parsed = bindingIdSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid body' }, 400);
  const db = ctx();
  const row = await findBindingById(db, parsed.data.bindingId, user.id);
  if (!row) return c.json({ error: 'binding not found' }, 404);
  if (row.status !== 'confirmed') return c.json({ error: `binding status is ${row.status}, expected confirmed` }, 409);
  const ok = await updateBindingStatus(db, row.id, 'rejected', 'human', user.id);
  if (!ok) return c.json({ error: 'concurrent state change' }, 409);
  // 共享边守卫(spec §5.2): 同 (doc, contract) 还有其他 confirmed 行 -> 不删边。
  const siblings = (await listBindingsForContract(db, row.contractNo))
    .filter((b) => b.documentId === row.documentId && b.id !== row.id && b.status === 'confirmed');
  let graphSync: GraphSyncOutcome = 'ok';
  if (siblings.length === 0) {
    const sync = await removeBindingEdge({ docId: row.documentId, contractNo: row.contractNo });
    graphSync = sync.outcome;
  }
  return c.json({ ok: true, bindingId: row.id, graphSync });
});

const batchSchema = z.object({ bindingIds: z.array(z.string().min(1)).min(1) });

bindingsRoute.post('/batch-confirm', async (c) => {
  const user = c.get('user')!;
  const parsed = batchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid body' }, 400);
  const db = ctx();
  const results: Array<{ bindingId: string; ok: true; graphSync: string } | { bindingId: string; ok: false; error: string }> = [];
  for (const bindingId of parsed.data.bindingIds) {
    const r = await confirmOne(db, user.id, bindingId);
    if (r.status === 200) results.push({ bindingId, ok: true, graphSync: String(r.body.graphSync) });
    else results.push({ bindingId, ok: false, error: String((r.body as { error: string }).error) });
  }
  return c.json({ results });
});
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test --workspace apps/server -- test/routes/bindingsWrite.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: 全量验证 + 提交**

```bash
npm run build && npm run lint && npm test
git add apps/server/src/routes/bindings.ts apps/server/test/routes/bindingsWrite.test.ts
git commit -m "feat(bindings): 工作台写端点 confirm/reject/create/unbind/batch + 图同步"
```

---

### Task 7: 前端 — binds 边样式（契约先行部分）

**Files:**
- Modify: `apps/web/src/components/graph/kinds.ts`
- Modify: `apps/web/src/components/graph/GraphCanvas.tsx`

**Interfaces:**
- Consumes: 后端 BINDS_EDGE = 'binds'（Task 3 常量，字符串字面量前端硬编码同一值）
- Produces: `EDGE_STYLE_OVERRIDES: Record<string, { color: string; label?: string; dashed: boolean }>`

- [ ] **Step 1: kinds.ts 追加边样式覆盖**

在 `EDGE_LABELS` 后追加：

```ts
export const EDGE_LABELS_BINDS = '绑定'; // 冗余常量可省; 直接并入下面 map

/** 边样式覆盖: binds(人工确认的绑定)与抽取级提及边视觉区分。 */
export const EDGE_STYLE_OVERRIDES: Record<string, { color: string; dashed: boolean }> = {
  binds: { color: '#15803D', dashed: true },
};
```

并把 `EDGE_LABELS` 加一行 `binds: '绑定',`。

- [ ] **Step 2: GraphCanvas.tsx 边样式接线**

`buildLayout` 内 `flowEdges` map 中，`stroke`/`markerEnd.color` 由覆盖驱动：

```ts
import { edgeLabel, kindStyle, EDGE_STYLE_OVERRIDES } from './kinds';

// buildLayout 内:
const override = EDGE_STYLE_OVERRIDES[edge.type];
const stroke = override?.color ?? EDGE_STROKE;
// style 追加 dashed:
style: { stroke, strokeWidth: 1.5, ...(override?.dashed ? { strokeDasharray: '6 4' } : {}) },
markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: stroke },
```

- [ ] **Step 3: 构建验证 + 提交**

```bash
npm run build && npm run lint
git add apps/web/src/components/graph/kinds.ts apps/web/src/components/graph/GraphCanvas.tsx
git commit -m "feat(graph): binds 绑定边样式(绿色虚线, 与提及边区分)"
```

---

### Task 8: 前端 — useBindings hook + BindingsView 三栏页面 + 导航入口

**Files:**
- Create: `apps/web/src/hooks/useBindings.ts`
- Create: `apps/web/src/components/bindings/BindingsView.tsx`
- Create: `apps/web/src/components/bindings/DocListPanel.tsx`
- Create: `apps/web/src/components/bindings/CandidatePanel.tsx`
- Create: `apps/web/src/components/bindings/DetailPanel.tsx`
- Modify: `apps/web/src/App.tsx`

**Interfaces:**
- Consumes: Task 5/6 冻结的 REST 契约；`prettyDocName`（graph/kinds.ts）；Tailwind 色板（deepSea/bgGray/textGray/borderGray/textDark/danger，同 tailwind.config.js 自定义色）；PanelRail 折叠模式（graph/GraphView.tsx 可参考）
- Produces: `useBindings()` hook + `BindingsView` 组件（App.tsx view='bindings' 渲染）

视觉与交互规格 = spec §6（三栏、分组、评分条、对照表、二次确认弹窗、乐观更新、批量多选、手动绑定表单、解绑、binds 角标）。本任务执行者须先读 spec §6-§7 与 graph/GraphView.tsx、graph/DocumentListPanel.tsx 作为风格基准。

- [ ] **Step 1: useBindings.ts（数据层，useGraph.ts 的 getJson 模式照抄）**

```ts
// apps/web/src/hooks/useBindings.ts
import { useState, useEffect, useCallback } from 'react';

/* 契约(与 server routes/bindings.ts 一致) */
export interface BindingListItem {
  bindingId: string; contractNo: string; relation: string;
  status: string; confidence: number;
  confirmationSource: string | null;
  graphStatus: { status: string; reason?: string } | null;
}
export interface OverviewDoc {
  docId: string; fileName: string; docType: string; createdAt: string;
  bindings: BindingListItem[];
}
export interface BindingCandidateItem {
  contractNo: string; score: number;
  route: 'auto_rule' | 'human' | 'none';
  evidence: { partyScore: number; timeScore: number; amountScore: number; qtyScore: number; details: string[] };
  existingBindingId: string | null;
  ledger: { contractNo: string; displayContractNo: string; title: string; docType: string } | null;
}
export interface Anchors { contractNo?: string; buyer?: string; seller?: string; date?: string; amount?: number; quantityTon?: number }
export interface ContractOption { contractNo: string; displayContractNo: string; docType: string; title: string; overallConfidence: number }
export interface ProposalItem {
  bindingId: string; documentId: string; docType: string; fileName: string;
  contractNo: string; relation: string; confidence: number;
  evidence: BindingCandidateItem['evidence'] | null;
  graphStatus: BindingListItem['graphStatus'];
}

/* getJson / asStr / asProps / asNum: 从 ../components 独立实现, 照 useGraph.ts:46-121 模式
   (fetch + credentials include + {ok,data} 信封兼容 + 错误消息中文化)。 */

export function useBindings() {
  const [overview, setOverview] = useState<OverviewDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<{ docId: string; hasExtraction: boolean; anchors: Anchors; list: BindingCandidateItem[] } | null>(null);
  const [candidatesLoading, setCandidatesLoading] = useState(false);
  const [contracts, setContracts] = useState<ContractOption[]>([]);

  const refreshOverview = useCallback(async () => { /* GET /api/bindings/overview -> setOverview/setLoading/setError */ }, []);
  useEffect(() => { void refreshOverview(); void loadContracts(); }, [refreshOverview]);

  const loadCandidates = useCallback(async (docId: string) => {
    setCandidatesLoading(true);
    try {
      const data = await getJson<{ hasExtraction: boolean; anchors: Anchors; candidates: BindingCandidateItem[] }>(`/api/bindings/candidates?documentId=${encodeURIComponent(docId)}`);
      setCandidates({ docId, hasExtraction: data.hasExtraction, anchors: data.anchors ?? {}, list: Array.isArray(data.candidates) ? data.candidates : [] });
    } catch (e) { setCandidates(null); setError(e instanceof Error ? e.message : '候选生成失败'); }
    finally { setCandidatesLoading(false); }
  }, []);
  const loadContracts = useCallback(async () => { /* GET /api/bindings/contracts -> setContracts */ }, []);

  const confirmBinding = useCallback(async (bindingId: string) => postJson('/api/bindings/confirm', { bindingId }), []);
  const rejectBinding = useCallback(async (bindingId: string) => postJson('/api/bindings/reject', { bindingId }), []);
  const createBinding = useCallback(async (p: { documentId: string; contractNo: string; relation: string; note?: string }) => postJson('/api/bindings', p), []);
  const unbindBinding = useCallback(async (bindingId: string) => postJson('/api/bindings/unbind', { bindingId }), []);
  const batchConfirm = useCallback(async (bindingIds: string[]) => postJson('/api/bindings/batch-confirm', { bindingIds }), []);

  return { overview, loading, error, refreshOverview, candidates, candidatesLoading, loadCandidates, contracts, confirmBinding, rejectBinding, createBinding, unbindBinding, batchConfirm };
}
```

`postJson`：POST JSON + 同 getJson 的错误处理，返回解析后的 body（写操作 4xx 时 throw Error(服务端 error 字段)）。

- [ ] **Step 2: 三栏组件（BindingsView 为壳, 三个子面板）**

结构骨架（视觉规格 spec §6.1，样式照 graph/ 三栏）：

```tsx
// BindingsView.tsx 骨架
export function BindingsView() {
  const b = useBindings();
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
  const [selected, setSelected] = useState<OverviewDoc | null>(null);
  // 选中文档变化 -> loadCandidates; overview 变化 -> 同步 selected
  // 顶栏: 标题'绑定工作台' + 统计徽章(未绑定 N · 待确认建议 M=proposals.length) + 刷新
  // 三栏: DocListPanel(未绑定/已绑定分组) | CandidatePanel(候选/建议/批量/手动入口) | DetailPanel(对照表/操作)
}
```

- `DocListPanel`：overview 分组渲染（bindings.length===0 → 未绑定组；>0 → 已绑定组），行 = docType 徽章 + `prettyDocName(fileName)` + 日期 + 已绑定数徽章；选中态样式照 graph/DocumentListPanel.tsx:70-89（inset 2px deepSea + bg #E8EEF4）。
- `CandidatePanel`：候选列表（score 进度条 + route 徽章：auto_rule 绿 '自动' / human 蓝 '建议' / none 灰 '弱候选'灰显）+ 顶部合并显示已有 proposals（GET /proposals，有 existingBindingId 的候选行内直接给确认/拒绝按钮）+ 底部批量条（checkbox 多选 + '确认所选'，仅 auto_route 默认选中）+ '手动创建绑定' 入口展开表单（contracts 下拉搜索 + relation 下拉 ['货权转移','付款','质检','凭证'] 允许自定义 + note 选填）。
- `DetailPanel`：选中候选的对照表——anchors vs candidate.ledger（有 ledger 时显示 title/displayContractNo，字段逐项：合同号/买方/卖方/金额/数量，两侧有值则展示，评分四维 partyScore/timeScore/amountScore/qtyScore 各一条进度条 + evidence.details 列表）；已绑定文档则列绑定条目（contractNo + relation + status 徽章 + graphStatus!=='ok' 时'图谱未同步'角标 + 重试按钮(重新 confirm 已 confirmed 行走幂等 createBinding 即可) + '解除'按钮）。
- 所有写操作：先二次确认弹窗（模态，标题 + 影响说明 + 取消/确认），成功后乐观更新本地 overview/candidates，失败回滚 + toast（页面右上角简易 toast，3s 自动消失）。
- 批量结果处理：`results` 中 ok:false 项在候选行标红错误文案。

- [ ] **Step 3: App.tsx 入口**

view 类型加 `'bindings'`，import `{ Link2 }`（lucide-react）与 BindingsView，导航按钮（Network 按钮后）：

```tsx
<button type="button" title="绑定" aria-label="绑定" onClick={() => setView('bindings')}
  className={clsx('w-9 h-9 rounded-lg flex items-center justify-center', view === 'bindings' ? 'bg-deepSea text-white' : 'text-textGray hover:bg-bgGray')}>
  <Link2 className="h-5 w-5" aria-hidden />
</button>
```

渲染分支（graph 分支前）：

```tsx
{view === 'bindings' ? (
  <div style={{ flex: 1, position: 'relative', minWidth: 0 }}>
    <BindingsView />
  </div>
) : view === 'graph' ? (
```

- [ ] **Step 4: 构建验证**

```bash
npm run build && npm run lint
```

Expected: 均绿（web tsc + vite）

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/hooks/useBindings.ts apps/web/src/components/bindings apps/web/src/App.tsx
git commit -m "feat(web): 绑定工作台页面(三栏/候选/批量/手动/解绑)"
```

---

### Task 9: 全链路验证 + 手动验收

**Files:** 无新文件（验证任务）

- [ ] **Step 1: 三连验证**

```bash
npm run build && npm run lint && npm test
```

Expected: build 绿 / lint 0 error / 全部测试通过（新增 4 个测试文件 + 既有）

- [ ] **Step 2: 本地起服务手动验收（spec §8 验收链路）**

`npm run dev:all`，登录后：
1. 左侧导航点'绑定' → 三栏工作台出现，文档按未绑定/已绑定分组
2. 选一个未绑定的已抽取文档 → 中栏出现候选（含评分与 route 徽章）
3. 确认一条候选 → 二次确认弹窗 → 行变为已绑定（左侧分组迁移）
4. 图谱页：选该文档为中心 → 看到绿色虚线'绑定'边连到 Contract 节点
5. 回工作台解绑 → 图谱页刷新后 binds 边消失
6. 手动创建绑定（选台账合同）→ 成功且图谱出现边

- [ ] **Step 3: 部署验证（push 触发 CI/CD）**

```bash
git push origin main
```

CD 部署到 10.10.0.2 后，在 dev 环境（10.10.0.2:3001）重复 Step 2 的 1-3 抽查。

---

## Self-Review 记录

- **Spec 覆盖**：§5.1 读端点→Task 5；写端点→Task 6；§5.2 图同步（MERGE/删边守卫/graph_status 持久化/不阻塞）→Task 1+3+6；候选按需生成含弱候选→Task 4；§6 前端三栏/交互/乐观更新/批量/手动/解绑/角标重试→Task 8；§7 错误处理（409/幂等/共享边守卫/批量部分失败/toast）→Task 6+8；§6.2 图谱联动 binds 样式→Task 7。非目标均未越界（未动 bind_document 工具、未加唯一约束）。
- **类型一致性**：BindingGraphStatus 在 Task 1 定义、Task 6 消费；BindingCandidate 在 Task 4 定义、Task 5 契约与 Task 8 前端镜像；BINDS_EDGE 常量 Task 3 产出、Task 7 前端硬编码同值 'binds'；findBindingById Task 1 产出、Task 6 消费。
- **已知执行期核对点**（非占位符，是允许的实现内核对）：saveExtraction/createDocumentStub 的精确入参形状（Task 4/5 测试数据）；generateBindingProposals 第二参类型兼容性（Task 4 Step 3 注释）；listUserDocuments 扩列对 graph 路由的向后兼容（只增字段不改名）。
