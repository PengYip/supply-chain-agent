# 贸易台账 v1（trade-ledger）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 本体实体的浏览界面——新增 ViewId `entities`（实体台账）+ 只读投影 API（`GET /api/ontology/schema`、`/api/ontology/entities/:type[/:id]`），支持 as-of 双时间轴切换与红冲净额轧差展示，行内「问 Agent」跳对话。

**Architecture:** server 侧新增 `routes/ontology.ts`（requireAuth 只读 REST 面）+ `ontology/projection.ts`（源表→本体实体的只读投影，绝不写源表）；schema 端点直接复用注册表 `ontologySchemaJson()`（本次补实体中文标签与 ownFields）。前端新 `entities` 视图：类型列表/列表列全部由 schema 端点驱动（注册表加字段→前端零改动）。chat 侧支持 `#/chat?session=new&ask=<摘要>` 注入首条消息。

**Tech Stack:** Hono + zod（server）；React 19 + Tailwind + hash 路由（web，无 TanStack Query，api/*.ts 模块 + useState）。

**Spec:** `docs/superpowers/specs/2026-09-07-frontend-p0-p2-roadmap.md` Item 3 节（本计划只覆盖 Item 3；IN/OUT/验收以该节为准）

## Global Constraints（路线图 §3.4 逐条）

- 验证顺序 `npm run build && npm run lint && npm test`（仓库根）。
- 代码零 emoji；TS 严格模式过 tsc。
- 双后端列对列镜像；SQLite 幂等迁移 / Postgres `ADD COLUMN IF NOT EXISTS`——**本期零 DDL 变更**（不新增表/列），约束自动满足；投影 SQL 必须双分支（SQLite `?` / PG 经 `numberPlaceholders` 转 `$n`，照抄 `repo.ts` 模式）。
- 本期**不新增 agent 工具**（只读 REST API 不进工具注册表），`docs/tool-inventory.json` 不动；若实施中动了工具面即偏离计划。
- AI SDK 6 陷阱以 AGENTS.md「AI SDK 6」节为准（本期不触碰 harness/流式，理论无涉）。
- 认证 `requireAuth`；测试模式 `appAs(userId)` + `app.request`（照抄 `approvalListRoutes.test.ts`；需换 DB 的路由测试照抄 `test/routes/contractsSearch.test.ts` 的 `ctxHolder` + `vi.mock(dbBackend)` 模式）。
- 分支惯例：feature 分支 `PengYip/trade-ledger` 开发，验证绿后 merge 回 main 并 push（触发 CI+CD 到 10.10.0.2）。
- UI：视觉与交互对齐既有视图惯例（卡片 `rounded-lg border border-line bg-white`、色彩 token `ink/ink-soft/surface/line/danger`、`PageHeader`/`PanelRail` 复用）；视觉规范不属于计划范围，实现时含明显视觉设计的部分可走 designer 评审。

## 摸底结论（2026-09-07，基线 HEAD = df9ef10）

Item 1（审批中心）与 Item 2（本体基座）均已合并 main。定向 recon 的关键事实（本计划贴出的代码即此基线）：

1. **注册表** `apps/server/src/ontology/index.ts`（291 行）：11 实体 / 8 关系 14 连接对；`ontologySchemaJson()` 返回 `{version, enums, entities:[{name, fields, meaning}], relations:[...]}`，**无中文标签、无 ownFields**（`fields` = 自有 ∪ 双时间轴 ∪ 溯源的并集）→ Task 2 补。注册表只允许 import zod（`registry.test.ts:98-105` 断言，加代码时勿引其他依赖）。
2. **本体数据面**：`repo.ts` 的 `insertTradeFact/insertOntologyEdge`（写入边界 zod 校验）、`listTradeFactsAsOf/listOntologyEdgesAsOf`（AsOfPredicate + `(user_id = ? OR user_id = '')` 用户隔离）；`asof.ts` 的 `asOfBusinessTime(t)` = `valid_at <= t AND (invalid_at IS NULL OR invalid_at > t)`、`asOfSystemTime(t)` = `ingested_at <= t`。红冲 = 逆向负数净额轧差，**不失效原票**（docx §6.2，repo.test.ts Q1/Q2/Q3 已有单测基线）。
3. **M-1 遗留决策点（本期裁决，见 Task 3）**：`insertTradeFact` 现在 `entitySchema(...).parse(input.payload)` **校验后丢弃 parse 结果、原样持久化 raw payload**；zod 默认剥离未知键 ⇒ 注册表外字段可静默入库。`insertOntologyEdge` 的 params 同样 parse 后丢结果（关系 schema 已 strict，问题仅缺规范化）。**当前 `insertTradeFact` 在 src 内零生产调用方**（仅测试），收紧写入边界零迁移成本——终审认定的唯一合适时机。
4. **源表**（双后端列已核对，`pipeline/db/client.ts`）：
   - `contract_ledger`：`id, contract_no, display_contract_no, doc_type, document_id, title, fields(jsonb), field_meta, overall_confidence, needs_review, user_id, contract_type, created_at, updated_at`（不在 drizzle schema，双后端都走 raw SQL）。
   - `documents`：`id, doc_type, modality, source_uri, block_model, minio_key, user_id, created_at, review_status, reviewed_at, reviewed_by, parse_status, review_action, vectorization_meta, graph_status, extraction_status, batch_role, parse_stage, stage_started_at`。**无金额/数量列**。
   - `trade_facts` / `ontology_edges`：Item 2 新建，双时间轴三列 UTC ISO（SQLite TEXT 字典序=时间序）。
5. **路由基线**：无任何 `/api/ontology` 路由（新增）。挂载照抄 index.ts L113-129/L131-187：`app.use('/api/ontology/*', requireAuth)` + `app.route('/api/ontology', ontologyRoute)`。handler 形态照抄 `routes/contracts.ts`（防御性 401 + zod safeParse + `{error, detail}` 错误体 + `{items}` 风格响应）。
6. **收发单据映射**：pipeline `bindingProposal.ts:399` 有 `GOODS_FIELD_DOCS = new Set(['收货单','发货单'])`（方向编码货物单据白名单）；doc_type 词汇还有 发票/付款凭证/结算凭证等，但**只有收发两类在本期投影范围**（spec：「单据/收发依据←documents」）。
7. **web 基线**：`navigation.ts` ViewId 联合 11 项（审批中心 id 为复数 `approvals`，L47）；`App.tsx:113-115` 读 `route.params.session`，视图分发在 L304-342 三元链；`ChatWorkspace.tsx:208` 渲染 `<RealChatView sessionId={activeSessionId} {...chat} />`；`useSessionMessages.ts:242-259` 的 `sendMessage(text)` 在 `sessionId == null` 时**自动建会话并发首条消息**（`onSessionCreated` 回抛 App → selectSession）——`ask` 注入正用此机制；`session=new` 语义目前不存在（需 Task 11 新增）。`parseHash/formatHash` 支持任意 query 参数（`route.params.docId` 先例）。
8. **UI 惯例**：无共享 Table/Badge/Empty/Loading 原语（各视图内联 Tailwind）；`PageHeader`/`PanelRail` 可复用；分页照抄 `AuditView.tsx:397-426` 本地 Pagination 形态；红冲红标用 `text-danger` token。
9. **脚本**：`apps/server/scripts/*.ts`（tsconfig.scripts.json 已 include，`tsx` 直跑，`import 'dotenv/config'` + `getDbContext()`）。

### 投影映射表（v1 决策，写死在 projection.ts 头注释）

| 实体类型 | 源 | 说明 |
|---|---|---|
| TradeContract | `contract_ledger` | contractNo←contract_no、title←title、contractType←contract_type、currency←fields.币种/currency 探测 |
| GoodsReceiptEvent | `documents`(doc_type='收货单') ∪ `trade_facts` | 单据=收发依据；documents 无金额列 → 事件字段留空渲染（列仍由注册表生成） |
| GoodsDeliveryEvent | `documents`(doc_type='发货单') ∪ `trade_facts` | 同上 |
| Settlement/Invoice/Payment/Collection/ServiceCost Event | `trade_facts` | 列表口径=最新口径（asOfBusinessTime(now)） |
| TradeGoods / Counterparty / OrgUnit | 无源 | 空态页「待本体基座灌数」（验收 4） |

### as-of 语义决策（详情页）

- 事件实体（trade_facts 源）支持 `asOf=business|system&at=<ISO>`：**详情时间线 = 本行 + REVERSE_ORIGIN 边双向传递闭包**（同为 as-of 过滤），`netAmount` = 时间线金额合计。
- 红冲两答案（验收 2）：`system@7/31` → 时间线仅原票（红冲票 8/5 才 ingested）净额 100 万（当时口径）；`business@now` → 原票+红冲票净额 0（最新口径，已冲平）。类型级 80 万口径（含重开票）已由 Item 2 的 repo.test.ts Q1-Q3 覆盖，不在详情页复现。
- 合同/单据源无双时间轴列 → 详情返回 `timeline: []`、`netAmount: null`，前端禁用切换并提示「仅事件实体支持时间切片」。

### M-1 裁决（Task 3 落地）

**采用 `.strict()` + 持久化 parse 后的规范值**（facts payload 与 edges params 同步收口）：

- strict = 快速失败：注册表外字段直接拒绝（不静默剥离——静默丢弃违反「禁止静默转换输入」原则，会掩盖上游 bug）。
- 持久化 parse 结果 = DB 不变量：`payload 字段 ⊆ 注册表词汇`，台账 API 才能放心把 payload 直供 schema 驱动的 UI。
- 时机：表是 Item 2 刚建、src 内无生产写入方，收紧零迁移成本；Item 3 之后 UI 与未来 pipeline 写入方都依赖此边界。

---

### Task 1: 前置检查 + 分支准备

**Files:** 无代码改动。

**Interfaces:** 无。

- [ ] **Step 1: 基线同步**

Run:
```bash
git fetch origin
git log --oneline -3
git status
```
Expected: HEAD 在 `df9ef10` 或其后人（Item 2 本体基座 + Item 1 审批中心已含）。若落后 origin/main，先 `git merge origin/main` 再继续；有冲突则停下人工处理。

- [ ] **Step 2: 建 feature 分支**

```bash
git checkout -b PengYip/trade-ledger origin/main
```

- [ ] **Step 3: 前置检查（写码前暴露不确定签名）**

Run 并逐条确认（与下述预期不符时，以实际代码为准修订后续任务的贴码）：
```bash
grep -rn "entitySchema" apps/server/src            # 预期仅 ontology/index.ts(定义) + repo.ts(调用)，无其他消费方
grep -n "strict" apps/server/test/ontology/*.ts    # 预期仅关系 params 相关断言，无实体 payload 的 strict 断言
grep -n "ChatWorkspace" apps/web/src/App.tsx       # 记录当前 props 传参形态（Task 11 在此加 initialAsk）
grep -n "interface.*Props" apps/web/src/components/chat/ChatWorkspace.tsx apps/web/src/components/RealChatView.tsx | head -20
grep -n "sendMessage" apps/web/src/hooks/useSessionMessages.ts | head -5   # 确认 sendMessage(text, opts) 签名
grep -rn "export function ApprovalDetailDrawer" apps/web/src/components/approval/  # Task 12 抽屉类名惯例参照
```

- [ ] **Step 4: 空跑验证基线绿**

Run: `npm run build && npm run lint && npm test`
Expected: 全绿（不绿先修基线，不属本计划）。

---

### Task 2: 注册表补实体中文标签 + ownFields

**Files:**
- Modify: `apps/server/src/ontology/index.ts`（ONTOLOGY_ENTITIES 后新增 ENTITY_LABELS；ontologySchemaJson 实体项加 label/ownFields）
- Test: `apps/server/test/ontology/registry.test.ts`

**Interfaces:**
- Produces: `ENTITY_LABELS: Record<OntologyEntityName, string>`；schema JSON 实体项 `{name, label, ownFields, fields, meaning}`（`fields` 语义不变仍为全集并集；`ownFields` = 实体自有字段，台账列表列生成用）。

- [ ] **Step 1: 写失败测试（registry.test.ts 既有 describe 内追加用例；文件顶部 import 花括号补 `ENTITY_LABELS`）**

```ts
it('entity labels + ownFields for the Item 3 ledger UI', () => {
  expect(Object.keys(ENTITY_LABELS).sort()).toEqual([...ENTITY_NAMES].sort());
  for (const label of Object.values(ENTITY_LABELS)) {
    expect(typeof label).toBe('string');
    expect(label.length).toBeGreaterThan(0);
  }
  const json = JSON.parse(JSON.stringify(ontologySchemaJson()));
  const invoice = json.entities.find((e: { name: string }) => e.name === 'InvoiceEvent');
  expect(invoice.label).toBe('发票事件');
  expect(invoice.ownFields).toContain('invoiceNo');
  expect(invoice.ownFields).not.toContain('validAt'); // 时间轴字段在 fields 全集，不在 ownFields
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/ontology/registry.test.ts`
Expected: FAIL（ENTITY_LABELS 未导出）

- [ ] **Step 3: 实现（index.ts）**

```ts
// ONTOLOGY_ENTITIES / ENTITY_NAMES（L104）之后新增（保持只 import zod 的约束）：
/** 实体中文标签（台账导航/治理 UI 用；新增实体必须补标签，registry 测试断言全覆盖）。 */
export const ENTITY_LABELS: Record<OntologyEntityName, string> = {
  TradeContract: '贸易合同',
  TradeGoods: '商品',
  Counterparty: '交易对手',
  OrgUnit: '内部组织',
  GoodsReceiptEvent: '收货事件',
  GoodsDeliveryEvent: '发货事件',
  SettlementEvent: '结算事件',
  InvoiceEvent: '发票事件',
  PaymentEvent: '付款事件',
  CollectionEvent: '收款事件',
  ServiceCostEvent: '服务费事件',
};
```

`ontologySchemaJson()`（L278-282）的 entities 映射改为：

```ts
    entities: ENTITY_NAMES.map((n) => ({
      name: n,
      label: ENTITY_LABELS[n],
      ownFields: Object.keys(ONTOLOGY_ENTITIES[n]!.shape),
      fields: [...entityFieldNames(n)],
      meaning: MEANING_URIS[n] ?? null,
    })),
```

- [ ] **Step 4: 跑测试确认通过 + 全量回归 + commit**

Run: `npm test --workspace apps/server -- test/ontology/registry.test.ts && npm run build && npm run lint && npm test`
Expected: PASS + 全绿（既有 `ontologySchemaJson` 断言不受影响——只加键不改旧键）

```bash
git add apps/server/src/ontology/index.ts apps/server/test/ontology/registry.test.ts
git commit -m "feat(ontology): entity labels + ownFields in registry schema projection (Item 3)"
```

---

### Task 3: M-1 裁决落地——写入边界收口（strict + 规范值持久化）

**Files:**
- Modify: `apps/server/src/ontology/index.ts`（entitySchema 加 .strict()）
- Modify: `apps/server/src/ontology/repo.ts`（insertTradeFact/insertOntologyEdge 持久化 parse 结果）
- Test: `apps/server/test/ontology/repo.test.ts`

**Interfaces:**
- Produces: `entitySchema(name)` 语义变更为 strict（注册表外字段抛 ZodError）；DB 不变量 `payload/params 字段 ⊆ 注册表词汇`。消费方签名不变。

- [ ] **Step 1: 写失败测试（repo.test.ts 末尾追加 describe）**

```ts
describe('M-1 canonical persistence (strict write boundary)', () => {
  it('rejects payload fields outside the registry vocabulary (strict, no silent strip)', async () => {
    await expect(insertTradeFact(ctx, {
      entityType: 'InvoiceEvent',
      payload: { ...INVOICE(100, '正向'), bogus: 'x' },
      validAt: '2026-06-15', createdBy: 'test',
    })).rejects.toThrow();
  });

  it('persists exactly the parsed canonical payload (DB fields ⊆ registry vocabulary)', async () => {
    const id = await insertTradeFact(ctx, {
      entityType: 'InvoiceEvent', payload: INVOICE(100, '正向'),
      validAt: '2026-06-15', createdBy: 'test',
    });
    const rows = await listTradeFactsAsOf(ctx, asOfBusinessTime('2026-09-07T00:00:00.000Z'), {});
    const row = rows.find((r) => r.id === id)!;
    expect(row).toBeTruthy();
    expect(Object.keys(row.payload).sort())
      .toEqual(['amount', 'currency', 'eventBizType', 'invoiceNo', 'invoiceType']);
  });

  it('edges persist canonical params', async () => {
    await insertOntologyEdge(ctx, {
      relation: 'WRITE_OFF', fromType: 'PaymentEvent', fromId: 'TF-P1',
      toType: 'InvoiceEvent', toId: 'TF-I1', params: { amount: 500, batch: 'B1' },
      validAt: '2026-06-20', createdBy: 'test',
    });
    const edges = await listOntologyEdgesAsOf(ctx, asOfBusinessTime('2026-09-07T00:00:00.000Z'), {});
    expect(edges).toHaveLength(1);
    expect(edges[0]!.params).toEqual({ amount: 500, batch: 'B1' });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/ontology/repo.test.ts`
Expected: 第 1 个用例 FAIL（extra 字段目前被静默接受）

- [ ] **Step 3: 实现**

`index.ts` 的 `entitySchema`（L146-149）替换为：

```ts
/** 写入边界用的完整 schema：词汇 + 语义规则。静态实体直接返回原 schema。
 *  M-1 裁决(2026-09-07)：strict——注册表外字段快速失败(不静默剥离)；
 *  仓储持久化 parse 后的规范值，DB 内 payload 字段恒 ⊆ 注册表词汇。 */
export function entitySchema(name: OntologyEntityName): z.ZodTypeAny {
  const base = ONTOLOGY_ENTITIES[name].strict();
  return EVENT_ENTITY_NAMES.includes(name) ? base.superRefine(eventAmountRule) : base;
}
```

`repo.ts` 的 `insertTradeFact`：L72 的 `entitySchema(input.entityType).parse(input.payload);` 改为：

```ts
  // 写入边界: 注册表词汇 + 语义规则(entitySchema 含事件金额方向 refinement)。
  // M-1: 持久化 parse 后的规范值(strict 下非法键已 throw，不会走到静默剥离)。
  const canonical = entitySchema(input.entityType).parse(input.payload);
```

其 PG 分支（L84）与 SQLite 分支（L92）的 `JSON.stringify(input.payload)` 均改为 `JSON.stringify(canonical)`（两处）。

`insertOntologyEdge`：L152 的 `def.params.parse(input.params ?? {});` 改为：

```ts
  const canonicalParams = def.params.parse(input.params ?? {});
```

两个分支的 `JSON.stringify(input.params ?? {})`（L166/L174）均改为 `JSON.stringify(canonicalParams)`（两处）。

- [ ] **Step 4: 跑测试确认通过 + 全量回归（重点：Item 2 既有红冲/边测试不回归）**

Run: `npm test --workspace apps/server -- test/ontology/repo.test.ts && npm run build && npm run lint && npm test`
Expected: PASS + 全绿（repo.test.ts 既有 fixture 均传精确字段，不受 strict 影响）

```bash
git add apps/server/src/ontology/index.ts apps/server/src/ontology/repo.ts apps/server/test/ontology/repo.test.ts
git commit -m "feat(ontology): M-1 strict write boundary + canonical payload persistence"
```

---

### Task 4: `GET /api/ontology/schema` 路由

**Files:**
- Create: `apps/server/src/routes/ontology.ts`
- Modify: `apps/server/src/index.ts`（requireAuth 挂载 + route 挂载 + import）
- Test: `apps/server/test/routes/ontologySchema.test.ts`

**Interfaces:**
- Consumes: `ontologySchemaJson()`（Task 2 已含 label/ownFields）。
- Produces: `ontologyRoute: Hono<AuthEnv>`；`GET /api/ontology/schema` → 200 `{version, enums, entities, relations}`；后续 Task 7/8 在同一 route 文件追加 `/entities` 两端点。

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/test/routes/ontologySchema.test.ts
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import type { AuthEnv } from '../../src/lib/auth-middleware.js';
import { ontologyRoute } from '../../src/routes/ontology.js';

function appAs(userId: string) {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { id: userId, email: 't@t', role: 'trader' } as never);
    await next();
  });
  app.route('/api/ontology', ontologyRoute);
  return app;
}

describe('GET /api/ontology/schema', () => {
  it('401 without session', async () => {
    const app = new Hono<AuthEnv>();
    app.route('/api/ontology', ontologyRoute);
    const res = await app.request('http://test/api/ontology/schema');
    expect(res.status).toBe(401);
  });

  it('returns the registry projection with labels', async () => {
    const res = await appAs('u1').request('http://test/api/ontology/schema');
    expect(res.status).toBe(200);
    const json = (await res.json()) as { entities: Array<{ name: string; label: string; ownFields: string[] }> };
    expect(json.entities).toHaveLength(11);
    const contract = json.entities.find((e) => e.name === 'TradeContract')!;
    expect(contract.label).toBe('贸易合同');
    expect(contract.ownFields).toContain('contractNo');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/routes/ontologySchema.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现路由文件 + 挂载**

```ts
// apps/server/src/routes/ontology.ts
// 本体只读 REST 面(roadmap Item 3)：/schema + /entities 列表/详情。
// 挂载：index.ts `app.use('/api/ontology/*', requireAuth)` + `app.route('/api/ontology', ontologyRoute)`。
// 只读：本文件与 projection 层绝不写任何源表。
import { Hono } from 'hono';
import type { AuthEnv } from '../lib/auth-middleware.js';
import { ontologySchemaJson } from '../ontology/index.js';

export const ontologyRoute = new Hono<AuthEnv>();

ontologyRoute.use('*', async (c, next) => {
  if (!c.get('user')) return c.json({ error: 'unauthorized' }, 401);
  await next();
});

/** GET /schema — 注册表纯 JSON 投影(台账列生成/类型列表的数据源)。 */
ontologyRoute.get('/schema', (c) => c.json(ontologySchemaJson()));
```

`index.ts` 三处（照抄 contracts 惯例）：

```ts
// 顶部 routes import 区（跟随既有排列）追加：
import { ontologyRoute } from './routes/ontology.js';

// L129 templates 挂载行之后追加：
app.use('/api/ontology/*', requireAuth);

// contracts 挂载(L164)之后追加：
// 本体台账(roadmap Item 3)：schema/实体列表/详情，只读投影。
app.route('/api/ontology', ontologyRoute);
```

- [ ] **Step 4: 跑测试确认通过 + commit**

Run: `npm test --workspace apps/server -- test/routes/ontologySchema.test.ts && npm run build && npm run lint`
Expected: PASS + 构建/静态检查绿

```bash
git add apps/server/src/routes/ontology.ts apps/server/src/index.ts apps/server/test/routes/ontologySchema.test.ts
git commit -m "feat(ontology): GET /api/ontology/schema registry projection route"
```

---

### Task 5: 投影层 I——TradeContract ← contract_ledger

**Files:**
- Create: `apps/server/src/ontology/projection.ts`
- Test: `apps/server/test/ontology/projection.test.ts`
- Modify: `apps/server/test/pipeline/postgres.integration.test.ts`（追加 PG lane 用例，skip 守卫照抄文件既有写法）

**Interfaces:**
- Consumes: `effectiveUserId`（pipeline/db/repositories.js）、`numberPlaceholders`（asof.js）。
- Produces: `ProjectedEntity`、`EntityListResult`、`listProjectedEntities(ctx, type, {page?, pageSize?, q?}, userId?)`（Task 6 扩展事件源后签名不变）。

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/test/ontology/projection.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import { listProjectedEntities } from '../../src/ontology/projection.js';

let ctx: DbContext;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
});

const insertContract = (id: string, contractNo: string, contractType: string | null) => {
  ctx.sqlite.prepare(
    `INSERT INTO contract_ledger (id, contract_no, display_contract_no, doc_type, document_id,
        title, fields, field_meta, overall_confidence, needs_review, user_id, contract_type)
     VALUES (?, ?, ?, '合同', 'doc-1', '', '{}', '{}', 1, 0, 'u1', ?)`,
  ).run(id, contractNo, contractNo, contractType);
};

describe('projection: TradeContract <- contract_ledger (read-only)', () => {
  it('maps registry vocabulary fields + label + source', async () => {
    insertContract('C1', 'HT-2026-001', '采购');
    const res = await listProjectedEntities(ctx, 'TradeContract', {}, 'u1');
    expect(res.total).toBe(1);
    const e = res.items[0]!;
    expect(e.id).toBe('C1');
    expect(e.source).toBe('contract_ledger');
    expect(e.label).toBe('HT-2026-001');
    expect(e.fields['contractNo']).toBe('HT-2026-001');
    expect(e.fields['contractType']).toBe('采购');
    expect(e.ingestedAt).toBeTruthy();
  });

  it('nullable contract_type omitted from fields (rendered empty by UI)', async () => {
    insertContract('C2', 'HT-2026-002', null);
    const res = await listProjectedEntities(ctx, 'TradeContract', {}, 'u1');
    expect(res.items[0]!.fields).not.toHaveProperty('contractType');
  });

  it('user scoping: other-user rows invisible, shared (empty user_id) visible', async () => {
    insertContract('C3', 'HT-2026-003', '采购');
    ctx.sqlite.prepare(
      `INSERT INTO contract_ledger (id, contract_no, display_contract_no, doc_type, document_id,
          title, fields, field_meta, overall_confidence, needs_review, user_id, contract_type)
       VALUES ('C4', 'HT-2026-004', 'HT-2026-004', '合同', 'doc-2', '', '{}', '{}', 1, 0, 'u2', '销售')`,
    ).run();
    ctx.sqlite.prepare(
      `INSERT INTO contract_ledger (id, contract_no, display_contract_no, doc_type, document_id,
          title, fields, field_meta, overall_confidence, needs_review, user_id, contract_type)
       VALUES ('C5', 'HT-2026-005', 'HT-2026-005', '合同', 'doc-3', '', '{}', '{}', 1, 0, '', '采购')`,
    ).run();
    const res = await listProjectedEntities(ctx, 'TradeContract', {}, 'u1');
    expect(res.items.map((e) => e.id).sort()).toEqual(['C3', 'C5']);
  });

  it('q filter + pagination', async () => {
    for (let i = 1; i <= 25; i += 1) {
      insertContract(`C${i}`, `HT-2026-${String(i).padStart(3, '0')}`, '采购');
    }
    const page2 = await listProjectedEntities(ctx, 'TradeContract', { page: 2, pageSize: 20 }, 'u1');
    expect(page2.items).toHaveLength(5);
    expect(page2.total).toBe(25);
    const q = await listProjectedEntities(ctx, 'TradeContract', { q: 'HT-2026-003' }, 'u1');
    expect(q.total).toBe(1);
  });

  it('types without a source return an empty page, not error (acceptance 4)', async () => {
    const res = await listProjectedEntities(ctx, 'TradeGoods', {}, 'u1');
    expect(res).toEqual({ items: [], total: 0, page: 1, pageSize: 20 });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/ontology/projection.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 projection.ts（首版：类型骨架 + 合同源）**

```ts
// apps/server/src/ontology/projection.ts
// 台账只读投影(roadmap 2026-09-07 Item 3)。铁律：本模块只含 SELECT，绝不写
// contract_ledger/documents/trade_facts 任何源表(验收 3，代码审查确认无写路径)。
// 映射 v1(理由见计划「摸底结论」)：
//   TradeContract                 <- contract_ledger
//   Goods{Receipt,Delivery}Event  <- documents(doc_type 收货单/发货单) ∪ trade_facts
//   其余 5 事件实体                <- trade_facts(列表口径=最新口径 asOfBusinessTime(now))
//   TradeGoods/Counterparty/OrgUnit <- 无源，空态(「待本体基座灌数」)
import type { DbContext, PostgresDbContext } from '../pipeline/db/client.js';
import { effectiveUserId } from '../pipeline/db/repositories.js';
import { asOfBusinessTime, numberPlaceholders } from './asof.js';
import type { OntologyEntityName } from './index.js';

export type ProjectionSource = 'contract_ledger' | 'documents' | 'trade_facts';

export interface ProjectedEntity {
  id: string;
  entityType: OntologyEntityName;
  /** 展示名(第一列，非注册表驱动)：合同号/单据类型/业务键(invoiceNo 等) */
  label: string;
  /** 注册表词汇内的字段(尽力映射；源缺失的字段不出现，前端渲染空) */
  fields: Record<string, unknown>;
  /** 溯源展示(documents 行携带 sourceUri/reviewStatus；其余源省略) */
  meta?: Record<string, string | null>;
  source: ProjectionSource;
  validAt: string | null;
  ingestedAt: string | null;
}

export interface EntityListResult {
  items: ProjectedEntity[];
  total: number;
  page: number;
  pageSize: number;
}

/** 单源扫描上限(内存过滤/合并/分页的前提，超出取最新 created_at)。 */
const SOURCE_ROW_CAP = 500;

/** 旧表 user_id 历史可空，防御性三路(对齐 repositories.searchContractLedger)。 */
const USER_SCOPE_LEGACY = "(user_id = ? OR user_id = '' OR user_id IS NULL)";

const parseJsonObj = (raw: unknown): Record<string, unknown> => {
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
  }
  return (raw ?? {}) as Record<string, unknown>;
};

/** SQLite datetime('now') 产出 'YYYY-MM-DD HH:MM:SS'；归一为字典序=时间序形态。 */
function normalizeLegacyDt(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  const s = String(v);
  return s.includes(' ') ? `${s.replace(' ', 'T')}Z` : s;
}

// ---------------------------------------------------------------------------
// TradeContract <- contract_ledger
// ---------------------------------------------------------------------------

function mapContractRow(r: Record<string, unknown>): ProjectedEntity {
  const extracted = parseJsonObj(r['fields']);
  const currencyProbe = extracted['币种'] ?? extracted['currency'];
  const contractNo = String(r['contract_no'] ?? '');
  return {
    id: String(r['id']),
    entityType: 'TradeContract',
    label: contractNo || String(r['id']),
    fields: {
      contractNo,
      ...(r['title'] != null && r['title'] !== '' ? { title: String(r['title']) } : {}),
      ...(r['contract_type'] != null ? { contractType: String(r['contract_type']) } : {}),
      ...(typeof currencyProbe === 'string' && currencyProbe !== '' ? { currency: currencyProbe } : {}),
    },
    source: 'contract_ledger',
    validAt: null,
    ingestedAt: normalizeLegacyDt(r['created_at']),
  };
}

async function listContracts(ctx: DbContext, uid: string): Promise<ProjectedEntity[]> {
  const sql = `SELECT id, contract_no, title, contract_type, fields, created_at
                 FROM contract_ledger WHERE ${USER_SCOPE_LEGACY}
                ORDER BY created_at DESC, id LIMIT ${SOURCE_ROW_CAP}`;
  if (ctx.backend === 'postgres') {
    const res = await (ctx as PostgresDbContext).pool.query(numberPlaceholders(sql), [uid]);
    return (res.rows as Array<Record<string, unknown>>).map(mapContractRow);
  }
  const rows = ctx.sqlite.prepare(sql).all(uid) as Array<Record<string, unknown>>;
  return rows.map(mapContractRow);
}

// ---------------------------------------------------------------------------
// 统一入口：源收集 -> q 过滤 -> 排序 -> 内存分页
// ---------------------------------------------------------------------------

async function collectEntities(ctx: DbContext, type: OntologyEntityName, uid: string): Promise<ProjectedEntity[]> {
  if (type === 'TradeContract') return listContracts(ctx, uid);
  // Task 6 扩展：收发 ∪ documents、事件 <- trade_facts
  return [];
}

export async function listProjectedEntities(
  ctx: DbContext,
  type: OntologyEntityName,
  opts: { page?: number; pageSize?: number; q?: string } = {},
  userId?: string,
): Promise<EntityListResult> {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 20));
  const uid = effectiveUserId(userId);
  const rows = await collectEntities(ctx, type, uid);
  const q = opts.q?.trim().toLowerCase() ?? '';
  const filtered = q
    ? rows.filter((e) => e.label.toLowerCase().includes(q)
      || JSON.stringify(e.fields).toLowerCase().includes(q))
    : rows;
  filtered.sort((a, b) => (b.ingestedAt ?? '').localeCompare(a.ingestedAt ?? '') || b.id.localeCompare(a.id));
  const start = (page - 1) * pageSize;
  return { items: filtered.slice(start, start + pageSize), total: filtered.length, page, pageSize };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test --workspace apps/server -- test/ontology/projection.test.ts`
Expected: PASS（5 用例全绿）

- [ ] **Step 5: PG 集成 lane（可选步骤，无 PG 环境时 CI 自动 skip）**

前置检查：打开 `apps/server/test/pipeline/postgres.integration.test.ts` L1-40 与 L570-595（Item 2 本体 lane），记录 describe/skip 变量名、ctx/夹具命名与 beforeEach TRUNCATE 清单。在该文件本体 lane 后追加（变量/夹具名以文件实际为准等价嵌入；TRUNCATE 清单若未含 `contract_ledger` 则补进 beforeEach 防测试间污染）：

```ts
  // ---- 台账投影(2026-09-07 Item 3)：只读投影 PG lane ------------------------
  it('projection maps contract_ledger on postgres', async () => {
    await pgPool.query(
      `INSERT INTO contract_ledger (id, contract_no, display_contract_no, doc_type, document_id,
          title, fields, field_meta, overall_confidence, needs_review, user_id, contract_type)
       VALUES ('PGC1', 'HT-PG-001', 'HT-PG-001', '合同', 'doc-pg', 't',
           '{"币种":"CNY"}'::jsonb, '{}'::jsonb, 1, false, $1, '采购')`,
      [pgUserId],
    );
    const res = await listProjectedEntities(pgCtx, 'TradeContract', {}, pgUserId);
    expect(res.total).toBe(1);
    expect(res.items[0]!.fields['contractNo']).toBe('HT-PG-001');
    expect(res.items[0]!.fields['currency']).toBe('CNY');
  });
```

（顶部 import 追加 `listProjectedEntities`。）

Run: `DB_BACKEND=postgres DATABASE_URL=<指向独立 sca_test 库，绝不可指向共享 dev 库> npm test --workspace apps/server -- test/pipeline/postgres.integration.test.ts`
Expected: PASS

- [ ] **Step 6: 全量回归 + commit**

Run: `npm run build && npm run lint && npm test`
Expected: 全绿

```bash
git add apps/server/src/ontology/projection.ts apps/server/test/ontology/projection.test.ts apps/server/test/pipeline/postgres.integration.test.ts
git commit -m "feat(ontology): read-only projection layer - TradeContract from contract_ledger"
```

---

### Task 6: 投影层 II——事件 ← trade_facts + 收发 ∪ documents

**Files:**
- Modify: `apps/server/src/ontology/projection.ts`
- Test: `apps/server/test/ontology/projection.test.ts`

**Interfaces:**
- Consumes: `listTradeFactsAsOf`、`TradeFactRow`（repo.js）。
- Produces: `listProjectedEntities` 行为扩展——7 事件类型可列出（收发两类含 documents 源），静态实体保持空态。签名不变。

- [ ] **Step 1: 写失败测试（projection.test.ts 追加；import 行补 `insertTradeFact`）**

```ts
const insertDoc = (id: string, docType: string) => {
  ctx.sqlite.prepare(
    `INSERT INTO documents (id, doc_type, modality, source_uri, block_model, user_id, review_status, parse_status)
     VALUES (?, ?, 'text', '/ingest/x.pdf', 'raw', 'u1', 'pending', 'uploaded')`,
  ).run(id, docType);
};

describe('projection: events <- trade_facts + receipt/delivery docs', () => {
  it('InvoiceEvent rows come from trade_facts with payload as fields, business key as label', async () => {
    await insertTradeFact(ctx, {
      entityType: 'InvoiceEvent',
      payload: { invoiceNo: 'INV-9', invoiceType: '销项', eventBizType: '正向', amount: 1000, currency: 'CNY' },
      validAt: '2026-06-15', createdBy: 'test',
    }, 'u1');
    const res = await listProjectedEntities(ctx, 'InvoiceEvent', {}, 'u1');
    expect(res.total).toBe(1);
    expect(res.items[0]!.label).toBe('INV-9');
    expect(res.items[0]!.fields['amount']).toBe(1000);
    expect(res.items[0]!.source).toBe('trade_facts');
    expect(res.items[0]!.validAt).toBeTruthy();
  });

  it('GoodsReceiptEvent unions documents(收货单) + trade_facts rows', async () => {
    insertDoc('D1', '收货单');
    insertDoc('D2', '发货单'); // 发货单不属于收货事件的源
    insertDoc('D3', '发票');   // 非收发白名单
    await insertTradeFact(ctx, {
      entityType: 'GoodsReceiptEvent',
      payload: { eventBizType: '正向', amount: 500, currency: 'CNY' },
      validAt: '2026-06-15', createdBy: 'test',
    }, 'u1');
    const res = await listProjectedEntities(ctx, 'GoodsReceiptEvent', {}, 'u1');
    expect(res.total).toBe(2);
    const docRow = res.items.find((e) => e.id === 'D1')!;
    expect(docRow.source).toBe('documents');
    expect(docRow.meta?.['sourceUri']).toBe('/ingest/x.pdf');
    expect(docRow.fields).toEqual({}); // documents 无事件字段 -> 留空渲染
    expect(res.items.some((e) => e.id === 'D2')).toBe(false);
    expect(res.items.some((e) => e.id === 'D3')).toBe(false);
  });

  it('list uses latest-business view: facts not yet valid or already invalidated are hidden', async () => {
    await insertTradeFact(ctx, {
      entityType: 'PaymentEvent',
      payload: { eventBizType: '正向', amount: 100, currency: 'CNY', payType: '预付' },
      validAt: '2099-01-01', createdBy: 'test',
    }, 'u1');
    await insertTradeFact(ctx, {
      entityType: 'CollectionEvent',
      payload: { eventBizType: '正向', amount: 200, currency: 'CNY' },
      validAt: '2026-06-01', invalidAt: '2026-06-02', createdBy: 'test',
    }, 'u1');
    expect((await listProjectedEntities(ctx, 'PaymentEvent', {}, 'u1')).total).toBe(0);
    expect((await listProjectedEntities(ctx, 'CollectionEvent', {}, 'u1')).total).toBe(0);
  });

  it('fact rows respect user scoping', async () => {
    await insertTradeFact(ctx, {
      entityType: 'InvoiceEvent',
      payload: { invoiceNo: 'INV-10', invoiceType: '销项', eventBizType: '正向', amount: 1, currency: 'CNY' },
      validAt: '2026-06-15', createdBy: 'test',
    }, 'u2');
    expect((await listProjectedEntities(ctx, 'InvoiceEvent', {}, 'u1')).total).toBe(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/ontology/projection.test.ts`
Expected: 新用例 FAIL（collectEntities 尚无事件分支）

- [ ] **Step 3: 实现（projection.ts）**

import 区补：

```ts
import { listTradeFactsAsOf, type TradeFactRow } from './repo.js';
```

`collectEntities` 之前追加：

```ts
// ---------------------------------------------------------------------------
// 收发依据 <- documents。doc_type 白名单与 pipeline bindingProposal.GOODS_FIELD_DOCS
// (收货单/发货单)对齐；本地声明避免 ontology -> pipeline 的反向依赖。
// ---------------------------------------------------------------------------
const DOC_TYPE_BY_EVENT: Record<'GoodsReceiptEvent' | 'GoodsDeliveryEvent', string> = {
  GoodsReceiptEvent: '收货单',
  GoodsDeliveryEvent: '发货单',
};

function mapDocRow(
  entityType: 'GoodsReceiptEvent' | 'GoodsDeliveryEvent',
  r: Record<string, unknown>,
): ProjectedEntity {
  const docType = String(r['doc_type'] ?? '');
  const id = String(r['id']);
  // documents 表无金额/数量列：事件自有字段源缺失 -> 不出现，列表列渲染空。
  return {
    id,
    entityType,
    label: `${docType} ${id.slice(0, 8)}`,
    fields: {},
    meta: {
      sourceUri: r['source_uri'] == null ? null : String(r['source_uri']),
      reviewStatus: r['review_status'] == null ? null : String(r['review_status']),
    },
    source: 'documents',
    validAt: null,
    ingestedAt: normalizeLegacyDt(r['created_at']),
  };
}

async function listReceiptDeliveryDocs(
  ctx: DbContext, type: 'GoodsReceiptEvent' | 'GoodsDeliveryEvent', uid: string,
): Promise<ProjectedEntity[]> {
  const sql = `SELECT id, doc_type, source_uri, review_status, created_at
                 FROM documents WHERE doc_type = ? AND ${USER_SCOPE_LEGACY}
                ORDER BY created_at DESC, id LIMIT ${SOURCE_ROW_CAP}`;
  if (ctx.backend === 'postgres') {
    const res = await (ctx as PostgresDbContext).pool.query(
      numberPlaceholders(sql), [DOC_TYPE_BY_EVENT[type], uid]);
    return (res.rows as Array<Record<string, unknown>>).map((r) => mapDocRow(type, r));
  }
  const rows = ctx.sqlite.prepare(sql)
    .all(DOC_TYPE_BY_EVENT[type], uid) as Array<Record<string, unknown>>;
  return rows.map((r) => mapDocRow(type, r));
}

// ---------------------------------------------------------------------------
// 事件 <- trade_facts(列表口径 = 最新口径：asOfBusinessTime(now))
// ---------------------------------------------------------------------------

const EVENT_TYPES: readonly OntologyEntityName[] = [
  'GoodsReceiptEvent', 'GoodsDeliveryEvent', 'SettlementEvent', 'InvoiceEvent',
  'PaymentEvent', 'CollectionEvent', 'ServiceCostEvent',
];

const BUSINESS_KEY_FIELDS = ['invoiceNo', 'contractNo', 'name', 'costType'] as const;

function businessKeyOf(p: Record<string, unknown>): string | null {
  for (const k of BUSINESS_KEY_FIELDS) {
    const v = p[k];
    if (typeof v === 'string' && v !== '') return v;
  }
  return null;
}

function factToEntity(row: TradeFactRow): ProjectedEntity {
  return {
    id: row.id,
    entityType: row.entityType as OntologyEntityName,
    label: businessKeyOf(row.payload) ?? row.id,
    fields: row.payload,
    source: 'trade_facts',
    validAt: row.validAt,
    ingestedAt: row.ingestedAt,
  };
}

async function listFacts(ctx: DbContext, type: OntologyEntityName, uid: string): Promise<ProjectedEntity[]> {
  const rows = await listTradeFactsAsOf(
    ctx, asOfBusinessTime(new Date().toISOString()), { entityType: type }, uid);
  return rows.map(factToEntity);
}
```

`collectEntities` 替换为：

```ts
async function collectEntities(ctx: DbContext, type: OntologyEntityName, uid: string): Promise<ProjectedEntity[]> {
  if (type === 'TradeContract') return listContracts(ctx, uid);
  if (type === 'GoodsReceiptEvent' || type === 'GoodsDeliveryEvent') {
    const [docs, facts] = await Promise.all([
      listReceiptDeliveryDocs(ctx, type, uid),
      listFacts(ctx, type, uid),
    ]);
    return [...docs, ...facts];
  }
  if ((EVENT_TYPES as readonly string[]).includes(type)) return listFacts(ctx, type, uid);
  return []; // TradeGoods/Counterparty/OrgUnit：无源空态(待本体基座灌数)
}
```

- [ ] **Step 4: 跑测试确认通过 + 全量回归 + commit**

Run: `npm test --workspace apps/server -- test/ontology/projection.test.ts && npm run build && npm run lint && npm test`
Expected: PASS + 全绿

```bash
git add apps/server/src/ontology/projection.ts apps/server/test/ontology/projection.test.ts
git commit -m "feat(ontology): project events from trade_facts + receipt/delivery docs union"
```

---

### Task 7: `GET /api/ontology/entities/:type` 列表路由

**Files:**
- Modify: `apps/server/src/routes/ontology.ts`
- Test: `apps/server/test/routes/ontologyEntities.test.ts`

**Interfaces:**
- Consumes: `listProjectedEntities`（Task 5/6）、`OntologyEntityNameSchema`（注册表）。
- Produces: `GET /api/ontology/entities/:type?page=&pageSize=&q=` → 200 `EntityListResult`；非注册表 type → 400 `{error:'unknown entity type'}`；未认证 401。

- [ ] **Step 1: 写失败测试（ctxHolder 模式照抄 contractsSearch.test.ts）**

```ts
// apps/server/test/routes/ontologyEntities.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import type { AuthEnv } from '../../src/lib/auth-middleware.js';

const { ctxHolder } = vi.hoisted(() => ({ ctxHolder: { current: null as DbContext | null } }));
vi.mock('../../src/pipeline/db/dbBackend.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/pipeline/db/dbBackend.js')>();
  return { ...mod, getDbContext: () => ctxHolder.current };
});
const { ontologyRoute } = await import('../../src/routes/ontology.js');
const { insertTradeFact } = await import('../../src/ontology/repo.js');

function appAs(userId: string) {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { id: userId, email: 't@t', role: 'trader' } as never);
    await next();
  });
  app.route('/api/ontology', ontologyRoute);
  return app;
}

let ctx: DbContext;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
  ctxHolder.current = ctx;
});

describe('GET /api/ontology/entities/:type', () => {
  it('401 without session', async () => {
    const app = new Hono<AuthEnv>();
    app.route('/api/ontology', ontologyRoute);
    const res = await app.request('http://test/api/ontology/entities/TradeContract');
    expect(res.status).toBe(401);
  });

  it('400 for type outside the registry whitelist', async () => {
    const res = await appAs('u1').request('http://test/api/ontology/entities/Nope');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('unknown entity type');
  });

  it('400 for invalid pagination params', async () => {
    const res = await appAs('u1').request('http://test/api/ontology/entities/TradeContract?page=0');
    expect(res.status).toBe(400);
  });

  it('lists trade_facts entities scoped to the user', async () => {
    await insertTradeFact(ctx, {
      entityType: 'InvoiceEvent',
      payload: { invoiceNo: 'INV-1', invoiceType: '销项', eventBizType: '正向', amount: 10, currency: 'CNY' },
      validAt: '2026-06-15', createdBy: 'test',
    }, 'u1');
    const res = await appAs('u1').request('http://test/api/ontology/entities/InvoiceEvent?page=1&pageSize=10');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ label: string }>; total: number; page: number; pageSize: number };
    expect(body.total).toBe(1);
    expect(body.items[0]!.label).toBe('INV-1');
    expect(body.pageSize).toBe(10);
  });

  it('empty source type returns empty page, not error (acceptance 4)', async () => {
    const res = await appAs('u1').request('http://test/api/ontology/entities/TradeGoods');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; total: number };
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/routes/ontologyEntities.test.ts`
Expected: FAIL（路由不存在，404）

- [ ] **Step 3: 实现（routes/ontology.ts 追加）**

import 区补：

```ts
import { z } from 'zod';
import { getDbContext } from '../pipeline/db/dbBackend.js';
import { OntologyEntityNameSchema } from '../ontology/index.js';
import { listProjectedEntities } from '../ontology/projection.js';

function errDetail(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
```

追加路由：

```ts
const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().trim().max(100).optional(),
});

/** GET /entities/:type — 只读投影列表(type 白名单=注册表 11 实体)。 */
ontologyRoute.get('/entities/:type', async (c) => {
  const user = c.get('user')!;
  const parsedType = OntologyEntityNameSchema.safeParse(c.req.param('type'));
  if (!parsedType.success) {
    return c.json({ error: 'unknown entity type', detail: 'type 必须是本体注册表 11 实体之一' }, 400);
  }
  const parsed = listQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json(
      { error: 'invalid query params', detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) },
      400,
    );
  }
  try {
    const result = await listProjectedEntities(getDbContext(), parsedType.data, parsed.data, user.id);
    return c.json(result);
  } catch (e) {
    console.error('[ontology] entities list failed:', errDetail(e));
    return c.json({ error: 'list failed', detail: errDetail(e) }, 500);
  }
});
```

- [ ] **Step 4: 跑测试确认通过 + commit**

Run: `npm test --workspace apps/server -- test/routes/ontologyEntities.test.ts && npm run build && npm run lint`
Expected: PASS

```bash
git add apps/server/src/routes/ontology.ts apps/server/test/routes/ontologyEntities.test.ts
git commit -m "feat(ontology): GET /api/ontology/entities/:type list route"
```

---

### Task 8: `GET /api/ontology/entities/:type/:id` 详情路由（as-of + REVERSE_ORIGIN 轧差时间线）

**Files:**
- Modify: `apps/server/src/ontology/repo.ts`（新增 `getTradeFactById` + 行映射提纯）
- Modify: `apps/server/src/ontology/projection.ts`（`getProjectedEntityDetail`）
- Modify: `apps/server/src/routes/ontology.ts`（详情路由）
- Test: `apps/server/test/ontology/repo.test.ts`、`apps/server/test/ontology/projection.test.ts`、`apps/server/test/routes/ontologyEntities.test.ts`

**Interfaces:**
- Produces:
  - `getTradeFactById(ctx, id, userId?): Promise<TradeFactRow | null>`（repo.js）
  - `EntityDetail = { entity: ProjectedEntity; timeline: ProjectedEntity[]; netAmount: number | null; asOf: { mode: 'business' | 'system'; at: string } }`
  - `getProjectedEntityDetail(ctx, type, id, { mode?, at? }, userId?): Promise<EntityDetail | null>`（projection.ts）
  - 路由：`GET /api/ontology/entities/:type/:id?asOf=business|system&at=<ISO>`；默认 `business@now`；at 非法 → 400；不存在/他人数据 → 404。

- [ ] **Step 1: 写失败测试（repo 层，repo.test.ts 追加；import 补 `getTradeFactById`）**

```ts
describe('getTradeFactById', () => {
  it('round-trips a fact with user scoping', async () => {
    const id = await insertTradeFact(ctx, {
      entityType: 'InvoiceEvent', payload: INVOICE(100, '正向'),
      validAt: '2026-06-15', createdBy: 'test',
    }, 'u1');
    const hit = await getTradeFactById(ctx, id, 'u1');
    expect(hit?.payload['amount']).toBe(100);
    expect(await getTradeFactById(ctx, id, 'u2')).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/ontology/repo.test.ts`
Expected: FAIL（未导出）

- [ ] **Step 3: 实现 repo.ts——行映射提纯 + getTradeFactById**

在 `listTradeFactsAsOf` 之前新增共享映射函数，并把 `listTradeFactsAsOf` 内 PG/SQLite 两处内联映射改为调用它（结构不变，改完跑既有测试防回归）：

```ts
function factRowFrom(r: Record<string, unknown>, pg: boolean): TradeFactRow {
  const iso = (v: unknown): string | null =>
    v == null ? null : pg ? new Date(v as string).toISOString() : v as string;
  return {
    id: r['id'] as string,
    entityType: r['entity_type'] as string,
    payload: parseJson(r['payload']),
    validAt: iso(r['valid_at']) as string,
    invalidAt: iso(r['invalid_at']),
    ingestedAt: iso(r['ingested_at']) as string,
    createdBy: r['created_by'] as string,
    userId: r['user_id'] as string,
  };
}

/** 按 id 单行读取(台账详情定位用)；用户隔离与 list 一致。 */
export async function getTradeFactById(
  ctx: DbContext, id: string, userId?: string,
): Promise<TradeFactRow | null> {
  const uid = effectiveUserId(userId);
  const where = "id = ? AND (user_id = ? OR user_id = '')";
  if (ctx.backend === 'postgres') {
    const pg = ctx as PostgresDbContext;
    const res = await pg.pool.query(
      `SELECT ${FACT_COLS} FROM trade_facts WHERE ${numberPlaceholders(where)}`,
      [id, uid],
    );
    const row = (res.rows as Array<Record<string, unknown>>)[0];
    return row ? factRowFrom(row, true) : null;
  }
  const row = ctx.sqlite.prepare(
    `SELECT ${FACT_COLS} FROM trade_facts WHERE ${where}`,
  ).get(id, uid) as Record<string, unknown> | undefined;
  return row ? factRowFrom(row, false) : null;
}
```

- [ ] **Step 4: 跑 repo 测试确认通过**

Run: `npm test --workspace apps/server -- test/ontology/repo.test.ts`
Expected: PASS（含既有用例——映射提纯无回归）

- [ ] **Step 5: 写失败测试（projection 层 detail + 红冲两答案，projection.test.ts 追加；import 补 `getProjectedEntityDetail`、`insertOntologyEdge`）**

```ts
describe('projection: entity detail as-of + REVERSE_ORIGIN netting', () => {
  let originalId: string;
  let reversalId: string;
  beforeEach(async () => {
    originalId = await insertTradeFact(ctx, {
      entityType: 'InvoiceEvent',
      payload: { invoiceNo: 'INV-1', invoiceType: '销项', eventBizType: '正向', amount: 1_000_000, currency: 'CNY' },
      validAt: '2026-06-15', ingestedAt: '2026-06-16', createdBy: 'demo',
    }, 'u1');
    reversalId = await insertTradeFact(ctx, {
      entityType: 'InvoiceEvent',
      payload: { invoiceNo: 'INV-1', invoiceType: '销项', eventBizType: '逆向', amount: -1_000_000, currency: 'CNY' },
      validAt: '2026-06-15', ingestedAt: '2026-08-05', createdBy: 'demo',
    }, 'u1');
    await insertOntologyEdge(ctx, {
      relation: 'REVERSE_ORIGIN', fromType: 'InvoiceEvent', fromId: reversalId,
      toType: 'InvoiceEvent', toId: originalId, params: { amount: 1_000_000 },
      validAt: '2026-06-15', ingestedAt: '2026-08-05', createdBy: 'demo',
    }, 'u1');
  });

  it('system@7/31 (当时口径): only the original fact was known -> net 1,000,000', async () => {
    const d = await getProjectedEntityDetail(ctx, 'InvoiceEvent', originalId,
      { mode: 'system', at: '2026-07-31T23:59:59.000Z' }, 'u1');
    expect(d!.timeline).toHaveLength(1);
    expect(d!.netAmount).toBe(1_000_000);
  });

  it('business@now (最新口径): original + reversal -> net 0', async () => {
    const d = await getProjectedEntityDetail(ctx, 'InvoiceEvent', originalId,
      { mode: 'business' }, 'u1');
    expect(d!.timeline.map((e) => e.id).sort()).toEqual([originalId, reversalId].sort());
    expect(d!.netAmount).toBe(0);
  });

  it('user scoping: other user gets null', async () => {
    expect(await getProjectedEntityDetail(ctx, 'InvoiceEvent', originalId, {}, 'u2')).toBeNull();
  });

  it('contract detail has no timeline (dual timeline only on facts)', async () => {
    ctx.sqlite.prepare(
      `INSERT INTO contract_ledger (id, contract_no, display_contract_no, doc_type, document_id,
          title, fields, field_meta, overall_confidence, needs_review, user_id, contract_type)
       VALUES ('C1', 'HT-1', 'HT-1', '合同', 'd1', '', '{}', '{}', 1, 0, 'u1', '采购')`,
    ).run();
    const d = await getProjectedEntityDetail(ctx, 'TradeContract', 'C1', {}, 'u1');
    expect(d!.entity.fields['contractNo']).toBe('HT-1');
    expect(d!.timeline).toEqual([]);
    expect(d!.netAmount).toBeNull();
  });
});
```

- [ ] **Step 6: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/ontology/projection.test.ts`
Expected: 新用例 FAIL（getProjectedEntityDetail 未实现）

- [ ] **Step 7: 实现 projection.ts 详情（文件末尾追加）**

import 区补（`listTradeFactsAsOf/type TradeFactRow` Task 6 已引入，不重复）：

```ts
import { asOfSystemTime, normalizeIsoUtc, type AsOfPredicate } from './asof.js';
import { getTradeFactById, listOntologyEdgesAsOf } from './repo.js';
```

（`asOfBusinessTime/numberPlaceholders` 已在。）

```ts
// ---------------------------------------------------------------------------
// 详情 + as-of 时间线(仅事件实体/trade_facts 源具备双时间轴)
// ---------------------------------------------------------------------------

export type AsOfMode = 'business' | 'system';

export interface EntityDetail {
  /** 本行本身(不做 as-of 过滤；as-of 只影响 timeline/netAmount) */
  entity: ProjectedEntity;
  /** 本行 + REVERSE_ORIGIN 边双向传递闭包，as-of 过滤，validAt 升序 */
  timeline: ProjectedEntity[];
  /** 时间线金额合计(无金额实体为 null)——红冲负数自动轧差(docx 6.2) */
  netAmount: number | null;
  asOf: { mode: AsOfMode; at: string };
}

/** 红冲溯源闭包(docx 5.4)：root + REVERSE_ORIGIN 边双向可达 facts，全部经同一 as-of 谓词过滤。 */
async function reverseOriginCluster(
  ctx: DbContext, rootId: string, pred: AsOfPredicate, uid: string,
): Promise<TradeFactRow[]> {
  const edges = await listOntologyEdgesAsOf(ctx, pred, { relation: 'REVERSE_ORIGIN' }, uid);
  const seen = new Set<string>([rootId]);
  let frontier = [rootId];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const e of edges) {
      if (frontier.includes(e.fromId) && !seen.has(e.toId)) { seen.add(e.toId); next.push(e.toId); }
      if (frontier.includes(e.toId) && !seen.has(e.fromId)) { seen.add(e.fromId); next.push(e.fromId); }
    }
    frontier = next;
  }
  const facts = await listTradeFactsAsOf(ctx, pred, {}, uid);
  return facts.filter((f) => seen.has(f.id));
}

async function findContractRowById(
  ctx: DbContext, id: string, uid: string,
): Promise<ProjectedEntity | null> {
  const sql = `SELECT id, contract_no, title, contract_type, fields, created_at
                 FROM contract_ledger WHERE id = ? AND ${USER_SCOPE_LEGACY}`;
  if (ctx.backend === 'postgres') {
    const res = await (ctx as PostgresDbContext).pool.query(numberPlaceholders(sql), [id, uid]);
    const row = (res.rows as Array<Record<string, unknown>>)[0];
    return row ? mapContractRow(row) : null;
  }
  const row = ctx.sqlite.prepare(sql).get(id, uid) as Record<string, unknown> | undefined;
  return row ? mapContractRow(row) : null;
}

async function findDocRowById(
  ctx: DbContext, id: string, type: 'GoodsReceiptEvent' | 'GoodsDeliveryEvent', uid: string,
): Promise<ProjectedEntity | null> {
  const sql = `SELECT id, doc_type, source_uri, review_status, created_at
                 FROM documents WHERE id = ? AND ${USER_SCOPE_LEGACY}`;
  if (ctx.backend === 'postgres') {
    const res = await (ctx as PostgresDbContext).pool.query(numberPlaceholders(sql), [id, uid]);
    const row = (res.rows as Array<Record<string, unknown>>)[0];
    return row ? mapDocRow(type, row) : null;
  }
  const row = ctx.sqlite.prepare(sql).get(id, uid) as Record<string, unknown> | undefined;
  return row ? mapDocRow(type, row) : null;
}

export async function getProjectedEntityDetail(
  ctx: DbContext,
  type: OntologyEntityName,
  id: string,
  opts: { mode?: AsOfMode; at?: string } = {},
  userId?: string,
): Promise<EntityDetail | null> {
  const uid = effectiveUserId(userId);
  const mode: AsOfMode = opts.mode ?? 'business';
  const at = normalizeIsoUtc(opts.at ?? new Date()); // 非法输入 throw -> 路由转 400
  const pred = mode === 'system' ? asOfSystemTime(at) : asOfBusinessTime(at);
  const asOf = { mode, at };

  if (type === 'TradeContract') {
    const entity = await findContractRowById(ctx, id, uid);
    return entity ? { entity, timeline: [], netAmount: null, asOf } : null;
  }

  // 事件实体：trade_facts 优先；收发两类再探 documents(收发依据单据行)
  const fact = await getTradeFactById(ctx, id, uid);
  if (fact) {
    const cluster = await reverseOriginCluster(ctx, id, pred, uid);
    const timeline = [...cluster]
      .sort((a, b) => a.validAt.localeCompare(b.validAt) || a.ingestedAt.localeCompare(b.ingestedAt))
      .map(factToEntity);
    const amounts = cluster
      .map((f) => f.payload['amount'])
      .filter((v): v is number => typeof v === 'number');
    return {
      entity: factToEntity(fact),
      timeline,
      netAmount: amounts.length > 0 ? amounts.reduce((a, b) => a + b, 0) : null,
      asOf,
    };
  }
  if (type === 'GoodsReceiptEvent' || type === 'GoodsDeliveryEvent') {
    const entity = await findDocRowById(ctx, id, type, uid);
    return entity ? { entity, timeline: [], netAmount: null, asOf } : null;
  }
  return null;
}
```

- [ ] **Step 8: 写失败测试（路由级，ontologyEntities.test.ts 追加；import 补 `insertOntologyEdge`）**

```ts
describe('GET /api/ontology/entities/:type/:id (as-of detail)', () => {
  it('red-flush two answers via API (acceptance 2)', async () => {
    const originalId = await insertTradeFact(ctx, {
      entityType: 'InvoiceEvent',
      payload: { invoiceNo: 'INV-1', invoiceType: '销项', eventBizType: '正向', amount: 1_000_000, currency: 'CNY' },
      validAt: '2026-06-15', ingestedAt: '2026-06-16', createdBy: 'demo',
    }, 'u1');
    const reversalId = await insertTradeFact(ctx, {
      entityType: 'InvoiceEvent',
      payload: { invoiceNo: 'INV-1', invoiceType: '销项', eventBizType: '逆向', amount: -1_000_000, currency: 'CNY' },
      validAt: '2026-06-15', ingestedAt: '2026-08-05', createdBy: 'demo',
    }, 'u1');
    await insertOntologyEdge(ctx, {
      relation: 'REVERSE_ORIGIN', fromType: 'InvoiceEvent', fromId: reversalId,
      toType: 'InvoiceEvent', toId: originalId, params: { amount: 1_000_000 },
      validAt: '2026-06-15', ingestedAt: '2026-08-05', createdBy: 'demo',
    }, 'u1');

    const app = appAs('u1');
    const thenRes = await app.request(
      `http://test/api/ontology/entities/InvoiceEvent/${originalId}?asOf=system&at=2026-07-31T23:59:59.000Z`);
    expect(thenRes.status).toBe(200);
    const then = (await thenRes.json()) as { netAmount: number; timeline: unknown[] };
    expect(then.netAmount).toBe(1_000_000);
    expect(then.timeline).toHaveLength(1);

    const nowRes = await app.request(
      `http://test/api/ontology/entities/InvoiceEvent/${originalId}`);
    const now = (await nowRes.json()) as { netAmount: number; timeline: unknown[] };
    expect(now.netAmount).toBe(0);
    expect(now.timeline).toHaveLength(2);
  });

  it('404 unknown id; 400 invalid at', async () => {
    const app = appAs('u1');
    const notFound = await app.request('http://test/api/ontology/entities/InvoiceEvent/TF-x');
    expect(notFound.status).toBe(404);
    const listRes = await app.request('http://test/api/ontology/entities/InvoiceEvent');
    const { items } = (await listRes.json()) as { items: Array<{ id: string }> };
    const bad = await app.request(
      `http://test/api/ontology/entities/InvoiceEvent/${items[0]!.id}?at=not-a-date`);
    expect(bad.status).toBe(400);
  });
});
```

（第二个用例先插一条 InvoiceEvent 再取列表首个 id；seed 逻辑与第一用例相同，可抽局部 helper。）

- [ ] **Step 9: 跑测试确认失败 → 实现路由（routes/ontology.ts 追加；import 补 `getProjectedEntityDetail`）**

```ts
const detailQuerySchema = z.object({
  asOf: z.enum(['business', 'system']).default('business'),
  at: z.string().optional(),
});

/** GET /entities/:type/:id — 详情 + as-of 时间切片(红冲轧差时间线)。 */
ontologyRoute.get('/entities/:type/:id', async (c) => {
  const user = c.get('user')!;
  const parsedType = OntologyEntityNameSchema.safeParse(c.req.param('type'));
  if (!parsedType.success) {
    return c.json({ error: 'unknown entity type', detail: 'type 必须是本体注册表 11 实体之一' }, 400);
  }
  const parsed = detailQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json(
      { error: 'invalid query params', detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) },
      400,
    );
  }
  try {
    const detail = await getProjectedEntityDetail(
      getDbContext(), parsedType.data, c.req.param('id'),
      { mode: parsed.data.asOf, at: parsed.data.at }, user.id,
    );
    if (!detail) return c.json({ error: 'not found' }, 404);
    return c.json(detail);
  } catch (e) {
    // normalizeIsoUtc 对非法 at 抛 'asof: invalid datetime' -> 400
    if (e instanceof Error && e.message.startsWith('asof:')) {
      return c.json({ error: 'invalid at', detail: e.message }, 400);
    }
    console.error('[ontology] entity detail failed:', errDetail(e));
    return c.json({ error: 'detail failed', detail: errDetail(e) }, 500);
  }
});
```

- [ ] **Step 10: 跑测试确认通过 + 全量回归 + commit**

Run: `npm test --workspace apps/server -- test/ontology/projection.test.ts test/routes/ontologyEntities.test.ts && npm run build && npm run lint && npm test`
Expected: PASS + 全绿

```bash
git add apps/server/src/ontology/repo.ts apps/server/src/ontology/projection.ts apps/server/src/routes/ontology.ts \
  apps/server/test/ontology/repo.test.ts apps/server/test/ontology/projection.test.ts apps/server/test/routes/ontologyEntities.test.ts
git commit -m "feat(ontology): entity detail API with as-of slice + REVERSE_ORIGIN netting timeline"
```

---

### Task 9: 前端 I——导航 + 实体台账骨架（类型列表 + 空态）

**Files:**
- Modify: `apps/web/src/components/shell/navigation.ts`（ViewId + NAV_ITEMS）
- Modify: `apps/web/src/App.tsx`（视图分发）
- Create: `apps/web/src/api/ontology.ts`
- Create: `apps/web/src/components/entities/EntitiesView.tsx`

**Interfaces:**
- Consumes: `GET /api/ontology/schema`（Task 4）。
- Produces: hash 路由 `#/entities`；`fetchOntologySchema(): Promise<OntologySchemaDTO>`；`EntitiesView`（Task 10/12 在其内扩展列表与详情）。

（web 无单测设施——与审批中心计划一致：以 `npm run build` 的 tsc + 手动 dev 验证为准。）

- [ ] **Step 1: navigation.ts 改动**

```ts
// lucide-react import 增加 Boxes:
//   Boxes,
// ViewId 联合 'ledger' 之后插入 'entities'
// NAV_ITEMS 'ledger' 行(L49)之后插入:
  { id: 'entities', label: '实体台账', description: '本体实体浏览（合同 / 收发依据 / 事件，as-of 时间切片）', icon: Boxes, group: 'work', enabled: true },
```

- [ ] **Step 2: api/ontology.ts（schema 拉取，request 助手形态对齐 api/projects.ts）**

```ts
// apps/web/src/api/ontology.ts
export interface OntologyEntitySchemaDTO {
  name: string;
  label: string;
  ownFields: string[];
  fields: string[];
  meaning: string | null;
}

export interface OntologySchemaDTO {
  version: string;
  enums: Record<string, string[]>;
  entities: OntologyEntitySchemaDTO[];
  relations: Array<{
    name: string;
    description: string;
    pairs: Array<{ from: string; to: string }>;
    params: string[];
    meaning: string | null;
  }>;
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

export function fetchOntologySchema(): Promise<OntologySchemaDTO> {
  return request<OntologySchemaDTO>('/api/ontology/schema');
}
```

- [ ] **Step 3: EntitiesView.tsx 骨架（左类型列表 + 右空态；布局参照 ProjectLedgerView 的 master-detail）**

```tsx
// apps/web/src/components/entities/EntitiesView.tsx
import { useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { fetchOntologySchema, type OntologyEntitySchemaDTO } from '../../api/ontology';

/** 实体台账(roadmap Item 3)：类型列表由注册表 schema 驱动，空源类型显示空态不报错。 */
export function EntitiesView() {
  const [schema, setSchema] = useState<OntologyEntitySchemaDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchOntologySchema()
      .then((s) => { if (alive) setSchema(s.entities); })
      .catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, []);

  const active = schema?.find((e) => e.name === selected) ?? null;

  return (
    <div className="flex h-full min-w-0 bg-surface/40">
      <aside className="h-full w-64 shrink-0 overflow-y-auto border-r border-line bg-white">
        <div className="px-4 pb-2 pt-4 text-xs font-medium text-ink-soft">实体类型（本体注册表）</div>
        {error && <div className="px-4 py-2 text-sm text-danger">{error}</div>}
        {!error && schema === null && <div className="px-4 py-2 text-sm text-ink-soft">加载中...</div>}
        {schema?.map((e) => (
          <button
            key={e.name}
            type="button"
            onClick={() => setSelected(e.name)}
            className={clsx(
              'block w-full px-4 py-2 text-left text-sm transition-colors',
              selected === e.name
                ? 'bg-surface font-medium text-ink'
                : 'text-ink-soft hover:bg-surface/60 hover:text-ink',
            )}
          >
            {e.label}
          </button>
        ))}
      </aside>
      <div className="min-w-0 flex-1 overflow-y-auto px-5 py-4">
        {active ? (
          <div className="rounded-lg border border-line bg-white p-6 text-center text-sm text-ink-soft">
            「{active.label}」列表加载中...（Task 10 接入数据）
          </div>
        ) : (
          <div className="rounded-lg border border-line bg-white p-6 text-center text-sm text-ink-soft">
            从左侧选择实体类型
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: App.tsx 分发（三元链 'ledger' 分支之后插入）**

```tsx
) : view === 'entities' ? (
  <EntitiesView />
```

顶部 import 补 `import { EntitiesView } from './components/entities/EntitiesView';`（跟随既有视图 import 排列）。

- [ ] **Step 5: 验证 + commit**

Run: `npm run build && npm run lint`
Expected: 绿（tsc 过）

手动验证（dev：`npm run dev:all`，若已在跑勿重复起前端）：登录 → 导航出现「实体台账」→ 进入显示 11 类型，右侧空态文案正常。

```bash
git add apps/web/src/components/shell/navigation.ts apps/web/src/App.tsx apps/web/src/api/ontology.ts apps/web/src/components/entities/EntitiesView.tsx
git commit -m "feat(web): entities ledger view skeleton with registry-driven type list"
```

---

### Task 10: 前端 II——动态列列表 + 分页 + 「问 Agent」

**Files:**
- Modify: `apps/web/src/api/ontology.ts`（listEntities）
- Modify: `apps/web/src/components/entities/EntitiesView.tsx`

**Interfaces:**
- Consumes: `GET /api/ontology/entities/:type`（Task 7）；`useHashRoute` 的 `navigate`（hooks/useHashRoute.ts）。
- Produces: `listEntities(type, {page?, pageSize?, q?}): Promise<EntityListResult>`；行内「问 Agent」→ `navigate('chat', { session: 'new', ask })`（消费端 Task 11 落地）。

- [ ] **Step 1: api/ontology.ts 追加**

```ts
export interface ProjectedEntity {
  id: string;
  entityType: string;
  label: string;
  fields: Record<string, unknown>;
  meta?: Record<string, string | null>;
  source: 'contract_ledger' | 'documents' | 'trade_facts';
  validAt: string | null;
  ingestedAt: string | null;
}

export interface EntityListResult {
  items: ProjectedEntity[];
  total: number;
  page: number;
  pageSize: number;
}

export function listEntities(
  type: string,
  opts: { page?: number; pageSize?: number; q?: string } = {},
): Promise<EntityListResult> {
  const params = new URLSearchParams();
  if (opts.page) params.set('page', String(opts.page));
  if (opts.pageSize) params.set('pageSize', String(opts.pageSize));
  if (opts.q) params.set('q', opts.q);
  const qs = params.toString();
  return request<EntityListResult>(`/api/ontology/entities/${encodeURIComponent(type)}${qs ? `?${qs}` : ''}`);
}
```

- [ ] **Step 2: EntitiesView 接入列表数据**

import 区补：

```tsx
import { useCallback, useEffect, useState } from 'react';
import { useHashRoute } from '../../hooks/useHashRoute';
import { listEntities, type ProjectedEntity } from '../../api/ontology';
```

组件内新增（保留既有 schema/selected 状态）：

```tsx
const PAGE_SIZE = 20; // 模块级常量

  const { navigate } = useHashRoute();
  const [rows, setRows] = useState<ProjectedEntity[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!selected) return;
    setLoading(true);
    setListError(null);
    try {
      const res = await listEntities(selected, { page, pageSize: PAGE_SIZE, q: q.trim() || undefined });
      setRows(res.items);
      setTotal(res.total);
    } catch (e) {
      setListError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [selected, page, q]);

  useEffect(() => { setPage(1); }, [selected, q]);
  useEffect(() => { void load(); }, [load]);
```

「问 Agent」helper（模块级或组件内）：

```tsx
  const askAgent = (row: ProjectedEntity) => {
    if (!active) return;
    const fieldSummary = Object.entries(row.fields)
      .filter(([, v]) => v != null && v !== '')
      .map(([k, v]) => `${k}=${String(v)}`)
      .join('，');
    const ask = fieldSummary
      ? `请帮我核对${active.label}「${row.label}」：${fieldSummary}`
      : `请帮我查看${active.label}「${row.label}」的相关信息`;
    navigate('chat', { session: 'new', ask });
  };
```

- [ ] **Step 3: 右栏列表渲染（列 = ownFields 动态生成——注册表加字段自动多列，前端零改动 = 验收 1）**

替换 Task 9 的占位卡片 `{active ? (...) : (...)}` 为：

```tsx
        {active ? (
          <div className="max-w-5xl space-y-4">
            <div className="flex items-center gap-2">
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={`搜索${active.label}（标识 / 字段值）`}
                className="h-8 w-64 rounded border border-line bg-white px-2 text-sm text-ink placeholder:text-ink-soft/60 focus:outline-none focus:ring-1 focus:ring-primary/40"
              />
              {loading && <span className="text-xs text-ink-soft">加载中...</span>}
              {listError && <span className="text-xs text-danger">{listError}</span>}
              <span className="ml-auto text-xs text-ink-soft">共 {total} 条</span>
            </div>
            <div className="overflow-x-auto rounded-lg border border-line bg-white">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs text-ink-soft">
                    <th className="px-3 py-2 font-medium">标识</th>
                    {active.ownFields.map((f) => (
                      <th key={f} className="px-3 py-2 font-medium">{f}</th>
                    ))}
                    <th className="px-3 py-2 font-medium">来源</th>
                    <th className="px-3 py-2 font-medium" aria-label="操作" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const negative = typeof row.fields['amount'] === 'number' && (row.fields['amount'] as number) < 0;
                    return (
                      <tr key={row.id} className="border-b border-line/60 last:border-b-0 hover:bg-surface/40">
                        <td className="px-3 py-2 font-medium text-ink">{row.label}</td>
                        {active.ownFields.map((f) => {
                          const v = row.fields[f];
                          const isNegAmount = f === 'amount' && negative;
                          return (
                            <td key={f} className={clsx('px-3 py-2 tabular-nums', isNegAmount ? 'text-danger' : 'text-ink')}>
                              {v == null || v === '' ? '—' : String(v)}
                            </td>
                          );
                        })}
                        <td className="px-3 py-2 text-xs text-ink-soft">{row.source}</td>
                        <td className="px-3 py-2 text-right">
                          <button
                            type="button"
                            onClick={() => askAgent(row)}
                            className="rounded border border-line px-2 py-0.5 text-xs text-ink-soft transition-colors hover:border-primary/40 hover:text-primary"
                          >
                            问 Agent
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                  {!loading && rows.length === 0 && (
                    <tr>
                      <td colSpan={active.ownFields.length + 3} className="px-3 py-8 text-center text-sm text-ink-soft">
                        待本体基座灌数（该类型暂无数据源）
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {/* 分页：照抄 AuditView 本地 Pagination 形态 */}
            <div className="flex items-center justify-end gap-2 text-sm">
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="rounded border border-line px-2 py-1 text-xs text-ink-soft disabled:opacity-40"
              >
                上一页
              </button>
              <span className="text-xs text-ink-soft">
                第 {page} / {Math.max(1, Math.ceil(total / PAGE_SIZE))} 页
              </span>
              <button
                type="button"
                disabled={page >= Math.ceil(total / PAGE_SIZE)}
                onClick={() => setPage((p) => p + 1)}
                className="rounded border border-line px-2 py-1 text-xs text-ink-soft disabled:opacity-40"
              >
                下一页
              </button>
            </div>
          </div>
        ) : (
          <div className="rounded-lg border border-line bg-white p-6 text-center text-sm text-ink-soft">
            从左侧选择实体类型
          </div>
        )}
```

- [ ] **Step 4: 验证 + commit**

Run: `npm run build && npm run lint`
Expected: 绿

手动验证：选「贸易合同」列出 contract_ledger 投影行；选「商品」显示空态文案；点「问 Agent」hash 变为 `#/chat?session=new&ask=...`（发送行为 Task 11 前【尚不触发】，只验证跳转）。

```bash
git add apps/web/src/api/ontology.ts apps/web/src/components/entities/EntitiesView.tsx
git commit -m "feat(web): registry-driven entity list with pagination and ask-agent jump"
```

---

### Task 11: 前端 III——chat `ask` 参数注入首条消息

**Files:**
- Modify: `apps/web/src/App.tsx`（`session=new` 归一 + 传 `initialAsk`）
- Modify: `apps/web/src/components/chat/ChatWorkspace.tsx`（props 透传）
- Modify: `apps/web/src/components/RealChatView.tsx`（消费 initialAsk，一次性注入）

**Interfaces:**
- Consumes: `useSessionMessages.sendMessage(text)`（sessionId 为 null 时自动建会话并发送，`useSessionMessages.ts:242-259`）。
- Produces: `#/chat?session=new&ask=<urlencoded>` 打开 chat 即以 ask 文本为首条消息创建新会话；`session=new` 归一为「无活动会话」。

- [ ] **Step 1: 前置检查**

Run: 打开 `apps/web/src/App.tsx` L300-320 记录 ChatWorkspace 的真实 props 传参与 `onSessionCreated` 接线；打开 `ChatWorkspace.tsx` props interface 与 `RealChatView.tsx` props interface（L232-249 附近），确认 prop 追加点。下述代码以实际 interface 名/位置为准等价嵌入。

- [ ] **Step 2: App.tsx——`session=new` 归一（L115 替换）**

```tsx
  // 'new' 是「从台账/外部跳入待新建」哨兵：归一为无活动会话，首条消息由 ask 注入。
  const activeSessionId =
    route.params.session && route.params.session !== 'new' ? route.params.session : null;
```

ChatWorkspace 调用处追加 prop：

```tsx
    <ChatWorkspace
      activeSessionId={activeSessionId}
      initialAsk={view === 'chat' ? route.params.ask ?? null : null}
      onSelectSession={selectSession}
      sessionsApi={sessionsApi}
      chat={{ ... }}   // 既有 props 原样保留
    />
```

- [ ] **Step 3: ChatWorkspace.tsx——props 透传**

props interface 追加 `initialAsk?: string | null;`，解构后传入：

```tsx
        <RealChatView sessionId={activeSessionId} initialAsk={initialAsk} {...chat} />
```

（L208 原行 `<RealChatView sessionId={activeSessionId} {...chat} />` 替换。）

- [ ] **Step 4: RealChatView.tsx——一次性注入 effect**

props interface 追加 `initialAsk?: string | null;` 并解构。组件内（`sendMessage` 来自 `useSessionMessages`，L370-372 附近解构处之后）：

```tsx
  // 台账「问 Agent」跳入(#/chat?session=new&ask=...)：无活动会话时注入首条消息。
  // ref 守卫保证只消费一次（StrictMode 双执行 / hash 抖动不重发）；
  // 发送成功后 onSessionCreated -> selectSession 会把 hash 换成 session=<id>，ask 自然清除。
  const askConsumedRef = useRef(false);
  useEffect(() => {
    if (!initialAsk || askConsumedRef.current) return;
    if (sessionId != null) return;
    askConsumedRef.current = true;
    void sendMessage(initialAsk);
  }, [initialAsk, sessionId, sendMessage]);
```

（`useRef` 已在该文件 import 列表内——若无需补。）

- [ ] **Step 5: 验证 + commit**

Run: `npm run build && npm run lint`
Expected: 绿

手动验证：在实体台账点任一行「问 Agent」→ 跳到 chat，自动新建会话并发出首条消息（含实体摘要），会话切换后 hash 变为 `session=<id>`；直接打开 `#/chat`（无 ask）行为与之前完全一致。

```bash
git add apps/web/src/App.tsx apps/web/src/components/chat/ChatWorkspace.tsx apps/web/src/components/RealChatView.tsx
git commit -m "feat(web): ask param injects first message into a new chat session"
```

---

### Task 12: 前端 IV——详情抽屉（as-of 切换 + 红冲红标时间线）

**Files:**
- Modify: `apps/web/src/api/ontology.ts`（getEntityDetail）
- Modify: `apps/web/src/components/entities/EntitiesView.tsx`（行点击开抽屉）
- Create: `apps/web/src/components/entities/EntityDetailDrawer.tsx`

**Interfaces:**
- Consumes: `GET /api/ontology/entities/:type/:id`（Task 8）。
- Produces: `getEntityDetail(type, id, { asOf?, at? }): Promise<EntityDetailResult>`；`EntityDetailDrawer`（props：`{ type, typeLabel, ownFields, entityId, onClose }`）。

- [ ] **Step 1: 前置检查**

Run: 打开 `apps/web/src/components/approval/ApprovalDetailDrawer.tsx` 记录抽屉容器的类名惯例（遮罩/右侧面板宽度/滚动），下述容器类名以其为准微调。

- [ ] **Step 2: api/ontology.ts 追加**

```ts
export interface EntityDetailResult {
  entity: ProjectedEntity;
  timeline: ProjectedEntity[];
  netAmount: number | null;
  asOf: { mode: 'business' | 'system'; at: string };
}

export function getEntityDetail(
  type: string,
  id: string,
  opts: { asOf?: 'business' | 'system'; at?: string } = {},
): Promise<EntityDetailResult> {
  const params = new URLSearchParams();
  if (opts.asOf) params.set('asOf', opts.asOf);
  if (opts.at) params.set('at', opts.at);
  const qs = params.toString();
  return request<EntityDetailResult>(
    `/api/ontology/entities/${encodeURIComponent(type)}/${encodeURIComponent(id)}${qs ? `?${qs}` : ''}`);
}
```

- [ ] **Step 3: EntityDetailDrawer.tsx**

```tsx
// apps/web/src/components/entities/EntityDetailDrawer.tsx
import { useCallback, useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { getEntityDetail, type EntityDetailResult } from '../../api/ontology';

interface Props {
  type: string;
  typeLabel: string;
  ownFields: string[];
  entityId: string;
  onClose: () => void;
}

/** 实体详情：字段表 + as-of 时间线(红冲负数红标) + 净额轧差。仅事件实体有时间线。 */
export function EntityDetailDrawer({ type, typeLabel, ownFields, entityId, onClose }: Props) {
  // asOf 语义(技术备忘 §4)：最新口径=business@now；当时口径=system@<日期>(月报复现)。
  const [mode, setMode] = useState<'business' | 'system'>('business');
  const [at, setAt] = useState('');
  const [detail, setDetail] = useState<EntityDetailResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getEntityDetail(type, entityId,
        mode === 'system' ? { asOf: 'system', at: at || new Date().toISOString() } : {});
      setDetail(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [type, entityId, mode, at]);

  useEffect(() => { void load(); }, [load]);

  const hasTimeline = detail != null && detail.timeline.length > 0;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" role="dialog" aria-modal="true">
      <div className="h-full w-[520px] max-w-[90vw] overflow-y-auto bg-white shadow-lg">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <div>
            <div className="text-sm font-medium text-ink">{typeLabel}详情</div>
            <div className="mt-0.5 text-xs text-ink-soft">{detail?.entity.label ?? entityId}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="rounded p-1 text-ink-soft transition-colors hover:bg-surface hover:text-ink"
          >
            关闭
          </button>
        </div>

        {/* as-of 切换 */}
        <div className="flex items-center gap-2 border-b border-line px-4 py-2">
          <div className="flex rounded border border-line text-xs">
            <button
              type="button"
              onClick={() => setMode('business')}
              className={clsx('px-2 py-1', mode === 'business' ? 'bg-surface font-medium text-ink' : 'text-ink-soft')}
            >
              最新口径
            </button>
            <button
              type="button"
              onClick={() => setMode('system')}
              className={clsx('px-2 py-1', mode === 'system' ? 'bg-surface font-medium text-ink' : 'text-ink-soft')}
            >
              当时口径
            </button>
          </div>
          {mode === 'system' && (
            <input
              type="date"
              value={at ? at.slice(0, 10) : ''}
              onChange={(e) => setAt(e.target.value ? `${e.target.value}T23:59:59.000Z` : '')}
              className="h-7 rounded border border-line px-2 text-xs text-ink"
              aria-label="时间点"
            />
          )}
          {loading && <span className="text-xs text-ink-soft">加载中...</span>}
          {error && <span className="text-xs text-danger">{error}</span>}
        </div>

        {/* 字段表 */}
        {detail && (
          <div className="border-b border-line px-4 py-3">
            <div className="mb-2 text-xs font-medium text-ink-soft">字段（注册表口径）</div>
            <table className="w-full text-sm">
              <tbody>
                {ownFields.map((f) => (
                  <tr key={f} className="border-b border-line/40 last:border-b-0">
                    <td className="w-32 py-1.5 text-xs text-ink-soft">{f}</td>
                    <td className="py-1.5 tabular-nums text-ink">
                      {detail.entity.fields[f] == null || detail.entity.fields[f] === ''
                        ? '—'
                        : String(detail.entity.fields[f])}
                    </td>
                  </tr>
                ))}
                <tr className="border-t border-line/40">
                  <td className="py-1.5 text-xs text-ink-soft">ingestedAt</td>
                  <td className="py-1.5 text-xs text-ink-soft">{detail.entity.ingestedAt ?? '—'}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}

        {/* 时间线 + 净额 */}
        {detail && (
          <div className="px-4 py-3">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-xs font-medium text-ink-soft">时间线（as-of 切片，红冲负数红标）</div>
              {detail.netAmount != null && (
                <div className="text-sm">
                  净额：
                  <span className={clsx('font-medium tabular-nums', detail.netAmount < 0 ? 'text-danger' : 'text-ink')}>
                    {detail.netAmount.toLocaleString()}
                  </span>
                </div>
              )}
            </div>
            {hasTimeline ? (
              <div className="space-y-1">
                {detail.timeline.map((row) => {
                  const amount = row.fields['amount'];
                  const negative = typeof amount === 'number' && amount < 0;
                  const reverse = row.fields['eventBizType'] === '逆向';
                  return (
                    <div
                      key={row.id}
                      className={clsx(
                        'flex items-center gap-2 rounded border px-2 py-1.5 text-sm',
                        negative || reverse
                          ? 'border-danger/30 bg-danger/5'
                          : 'border-line bg-white',
                      )}
                    >
                      <span className={clsx('font-medium', negative ? 'text-danger' : 'text-ink')}>{row.label}</span>
                      {reverse && (
                        <span className="rounded border border-danger/30 bg-danger/10 px-1 text-xs text-danger">逆向</span>
                      )}
                      {typeof amount === 'number' && (
                        <span className={clsx('ml-auto tabular-nums', negative ? 'text-danger' : 'text-ink')}>
                          {amount.toLocaleString()}
                        </span>
                      )}
                      <span className="text-xs text-ink-soft">{row.validAt?.slice(0, 10) ?? ''}</span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="rounded border border-line bg-surface/40 px-3 py-4 text-center text-xs text-ink-soft">
                仅事件实体（本体事实源）支持时间切片；合同 / 单据投影无双时间轴。
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: EntitiesView 行点击开抽屉**

import 补 `EntityDetailDrawer`；组件内加 `const [detailId, setDetailId] = useState<string | null>(null);`；列表行 `<tr ... onClick={() => setDetailId(row.id)} className={clsx('cursor-pointer', ...)}`（「问 Agent」按钮加 `onClick={(e) => { e.stopPropagation(); askAgent(row); }}` 防穿透）；组件 return 末尾条件渲染：

```tsx
      {detailId && active && (
        <EntityDetailDrawer
          type={active.name}
          typeLabel={active.label}
          ownFields={active.ownFields}
          entityId={detailId}
          onClose={() => setDetailId(null)}
        />
      )}
```

- [ ] **Step 5: 验证 + commit**

Run: `npm run build && npm run lint && npm test`
Expected: 绿

手动验证（配合 Task 13 种子数据）：发票详情默认「最新口径」净额 0（原票+红冲票两行，红冲行红标）；切「当时口径」+ 日期 2026-07-31 → 净额 1,000,000 且时间线仅原票一行；合同详情显示时间线占位提示。

```bash
git add apps/web/src/api/ontology.ts apps/web/src/components/entities/EntitiesView.tsx apps/web/src/components/entities/EntityDetailDrawer.tsx
git commit -m "feat(web): entity detail drawer with as-of toggle and red-flush timeline"
```

---

### Task 13: 种子脚本 + 手动验收 runbook + 终验合并

**Files:**
- Create: `apps/server/scripts/seedTradeLedgerDemo.ts`

**Interfaces:**
- Consumes: `insertTradeFact/insertOntologyEdge`（repo.js）、`getDbContext`（dbBackend.js）。
- Produces: 验收 2 的演示数据（幂等，createdBy 标记探测）。

- [ ] **Step 1: 种子脚本**

```ts
// apps/server/scripts/seedTradeLedgerDemo.ts
// 台账红冲演示数据(roadmap Item 3 验收 2)：
//   6/15 收票 100 万(6/16 入库)；8/5 红冲 -100 万(追溯 6/15 生效) + REVERSE_ORIGIN 边。
//   红冲不失效原票：逆向负数自动轧差(docx 6.2)。
// 幂等：createdBy 标记探测，已存在即跳过。RUN(项目根)：
//   npx tsx apps/server/scripts/seedTradeLedgerDemo.ts --dry-run   # 预览
//   npx tsx apps/server/scripts/seedTradeLedgerDemo.ts            # 写入
// 注意：写入的是 .env 指向的库(10.10.0.2 为 PG)；本地默认 SQLite 文件。
import 'dotenv/config';
import { getDbContext } from '../src/pipeline/db/dbBackend.js';
import { insertTradeFact, insertOntologyEdge } from '../src/ontology/repo.js';

const MARKER = 'demo-trade-ledger';
const INVOICE = (amount: number, eventBizType: '正向' | '逆向') => ({
  invoiceNo: 'INV-1', invoiceType: '销项', eventBizType, amount, currency: 'CNY',
});

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const ctx = getDbContext();
  const existing = ctx.backend === 'postgres'
    ? (await (ctx as { pool: { query: (sql: string) => Promise<{ rows: Array<{ n: string }> }> } })
        .pool.query("SELECT COUNT(*)::text AS n FROM trade_facts WHERE created_by = 'demo-trade-ledger'")).rows[0]!.n
    : String((ctx as { sqlite: { prepare: (sql: string) => { get: () => { n: number } } } })
        .sqlite.prepare("SELECT COUNT(*) AS n FROM trade_facts WHERE created_by = 'demo-trade-ledger'").get().n);
  if (existing !== '0') {
    console.log(`demo facts already seeded (${existing} rows), skip.`);
    return;
  }

  const original = {
    entityType: 'InvoiceEvent' as const,
    payload: INVOICE(1_000_000, '正向'),
    validAt: '2026-06-15', ingestedAt: '2026-06-16', createdBy: MARKER,
  };
  const reversal = {
    entityType: 'InvoiceEvent' as const,
    payload: INVOICE(-1_000_000, '逆向'),
    validAt: '2026-06-15', ingestedAt: '2026-08-05', createdBy: MARKER,
  };
  console.log(dryRun ? '[dry-run] would insert:' : 'inserting:', original, reversal);
  if (dryRun) return;

  const originalId = await insertTradeFact(ctx, original, 'demo-user');
  const reversalId = await insertTradeFact(ctx, reversal, 'demo-user');
  await insertOntologyEdge(ctx, {
    relation: 'REVERSE_ORIGIN', fromType: 'InvoiceEvent', fromId: reversalId,
    toType: 'InvoiceEvent', toId: originalId, params: { amount: 1_000_000 },
    validAt: '2026-06-15', ingestedAt: '2026-08-05', createdBy: MARKER,
  }, 'demo-user');
  console.log('original =', originalId, ' reversal =', reversalId);
  console.log('验收 2 两个答案：');
  console.log(`  当时口径: curl -b <auth> 'http://localhost:3001/api/ontology/entities/InvoiceEvent/${originalId}?asOf=system&at=2026-07-31T23:59:59.000Z'  # netAmount = 1000000`);
  console.log(`  最新口径: curl -b <auth> 'http://localhost:3001/api/ontology/entities/InvoiceEvent/${originalId}'  # netAmount = 0`);
}

void main().catch((e) => { console.error(e); process.exit(1); });
```

（脚本以严格 TS 过 `tsc -p tsconfig.scripts.json`；`ctx` 联合类型的窄化写法若报错，按 `repo.ts` 的 `if (ctx.backend === 'postgres')` 早返回模式改写——两种形态任选其一，以编译过为准。）

- [ ] **Step 2: 手动验收 runbook（四条验收逐一）**

Run（dev 环境）：
1. **验收 1（零改动多列）**：临时在 `ONTOLOGY_ENTITIES.TradeContract` 加一个字段（如 `memo: z.string().optional()`）→ `npm run dev:server` 重启 → 实体台账选「贸易合同」→ 列表自动多出 `memo` 列（值为 —）→ **还原该临时改动**。
2. **验收 2（红冲两答案）**：跑种子脚本 → 台账选「发票事件」→ 点 INV-1 行 → 默认「最新口径」净额 0、时间线两行（红冲行红标）→ 切「当时口径」日期 2026-07-31 → 净额 1,000,000、时间线仅原票。
3. **验收 3（只读投影）**：`grep -nE "INSERT|UPDATE|DELETE" apps/server/src/ontology/projection.ts apps/server/src/routes/ontology.ts` → Expected: 无匹配（种子脚本不在 src，不属投影面）。
4. **验收 4（空态）**：选「商品 / 交易对手 / 内部组织」→ 空态文案「待本体基座灌数」，无报错（网络面板 200）。
5. **双向打通**：任一行「问 Agent」→ chat 新会话首条消息为实体摘要。

- [ ] **Step 3: 终验**

Run: `npm run build && npm run lint && npm test`
Expected: 全绿

- [ ] **Step 4: commit + 合并 main**

```bash
git add apps/server/scripts/seedTradeLedgerDemo.ts
git commit -m "feat(ontology): trade-ledger demo seed script (acceptance 2 fixture)"
git fetch origin main
git merge origin/main   # 有冲突先解决并重新跑终验
npm run build && npm run lint && npm test   # merge 触碰代码时复验
git push origin HEAD:PengYip/trade-ledger
git push origin HEAD:main   # 触发 CI + CD 到 10.10.0.2
```

部署后抽查（10.10.0.2）：`ssh ubuntu-server "curl -s localhost:3001/api/health"` 健康；浏览器打开 `http://10.10.0.2:3001/#/entities` 验证台账（注意：dev 库的种子数据需在 10.10.0.2 上跑脚本灌入，先 `export PATH=$HOME/.nvm/versions/node/v24.19.0/bin:$PATH`）。

---

## 计划自审记录（writing-plans Self-Review）

1. **Spec 覆盖**：IN 逐条→ schema 端点（Task 4，复用 ontologySchemaJson）；两实体 API（Task 7/8）；只读投影三源（Task 5/6，映射表见摸底结论）；前端新 ViewId/类型列表/动态列/as-of 切换（Task 9/10/12）；问 Agent 双向打通（Task 10/11）；红冲红标（Task 12 + 列表负数红标 Task 10）。OUT 边界：无实体编辑/表单（仅只读+跳对话）、无复杂检索（仅 q 模糊）、无导出——均未越界。验收 1-4 分别落 Task 13 runbook 步骤 1-4。
2. **占位符扫描**：无 TBD/TODO；两处显式「以实际代码为准」的前置检查（Task 8 Step 5 的 PG 集成文件夹具名、Task 11/12 Step 1 的组件 props/抽屉类名）与 Task 13 脚本的联合类型窄化备注——均为审批中心计划同款的「既有签名适配」写法，非占位。
3. **类型一致性**：`ProjectedEntity/EntityListResult/EntityDetail` 在 server（projection.ts）与 web（api/ontology.ts）字段一致（web 侧 entityType 放宽为 string，DTO 边界合理）；`getTradeFactById` 签名在 Task 8 Interfaces 与实现一致；`listEntities/getEntityDetail` 请求参数与服务端 zod schema（page/pageSize≤100/q≤100、asOf/at）对齐；`session=new` 与 `ask` 参数名在 Task 10（发起）与 Task 11（消费）一致。

