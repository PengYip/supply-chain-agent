# 本体业务闭环 Wave 1（模型与版本基座）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为本体业务闭环打模型与版本地基：schema_version 行级血缘标记 + 注册表内容指纹 CI 门禁 + 硬编码清单注册表派生 + TradeProject 第 12 实体与 BELONGS_TO 等 5 个新关系 + D4 默认字段扩展集 + link_ontology 词表扩到 14 关系。

**Architecture:** 全部改动收敛在既有本体域三层：注册表单文件（`apps/server/src/ontology/index.ts`，纯 zod）扩词汇与版本常量；两张通用表（trade_facts/ontology_edges）经守卫迁移补 schema_version 列（双后端列对列镜像 + drizzle twin）；读写两侧（repo/projection/graphSync/linkTools/masterData）零新增文件、零新增路由、零新增工具。spec 决策 #1-#9 全部在本计划兑现。

**Tech Stack:** TypeScript 严格模式 / zod ^3.25.76（v3 classic API）/ better-sqlite3 / node-postgres / drizzle-orm（仅 PG schema 声明）/ vitest / tsx（指纹重生成）。

**Spec:** `docs/superpowers/specs/2026-09-20-ontology-business-loop-design.md`（本计划从其 §4 决策点 D1-D4 默认值、§5 设计决策、§6 测试验收论证；执行前先读 spec）。

---

## Global Constraints

（沿仓库惯例，逐字适用；每个任务的需求隐含本节）

- 验证顺序 `npm run build && npm run lint && npm test`（仓库根执行）；单测可先 `npm test --workspace apps/server -- test/ontology/<file>.test.ts`
- 代码零 emoji；TS 严格模式过 tsc
- 注册表文件 `apps/server/src/ontology/index.ts` **只 import zod**，禁止引入 node 内建（前端可消费约束，ontology-foundation 决策沿用）
- 双后端列对列镜像；SQLite 幂等迁移（`PRAGMA table_info` 守卫 ALTER）/ Postgres `ADD COLUMN IF NOT EXISTS`；drizzle twin 同步
- **本 Wave 不新增任何 agent 工具、不新增任何 HTTP 路由**——只扩 `link_ontology` 词表（tool-inventory.json 只改其条目文案）与 `MASTER_DATA_TYPES`（master-data 端点泛化分派，零路由改动，ontology.ts:63-104 已核实）
- `toolOntologyMap` CI 门禁：工具 inputSchema 新字段（quantity）必须先进 SHARED_TOOL_FIELD_NAMES
- 分支惯例：feature 分支开发，验证绿后 `git fetch origin main && git merge origin/main` → re-verify → `git push origin HEAD:<branch>` + `git push origin HEAD:main`（触发 CI+CD）
- 每 Task 触碰注册表后必须重生成指纹文件（命令见 Task 1 Step 4），否则指纹门禁测试红
- D1 **已裁决（2026-09-20）**：采用结算目标口径——Task 5 额外注册新关系名 `WRITE_OFF_SETTLEMENT`（不复用旧名改语义）；既有 WRITE_OFF 保留并存；核销工作台迁移归 Wave 4

## 摸底结论（2026-09-20，写计划前定向 recon）

- **SQLite 守卫 ALTER 先例**：`pipeline/db/client.ts:499-504`（trade_facts.document_id）——schema_version 照抄该模式；CREATE TABLE 块（client.ts:464-494）不含 document_id，新列同样只走 ALTER（对新旧库统一生效）。
- **PG 侧**：`migratePostgres` statements 数组（client.ts ~:689，document_id 用 `ADD COLUMN IF NOT EXISTS` 先例）；drizzle twin 在 `postgres-schema.ts:595-637`（两表定义+索引）。
- **repo.ts 写入链**：FACT_COLS/EDGE_COLS 常量（repo.ts:58-59）贯穿 INSERT/SELECT；insertTradeFact（:72-100）/ prepareEdgeRow（:316-338）/ insertOntologyEdgesBatch（:367-392）/ supersedeTradeFact + insertFactParams（:207-294）四处 INSERT 参数序列需同步加列。
- **graphSync.FACT_NODE_LABELS**：`ontology/graphSync.ts:35-40` 硬编码 10 label（`as const`）；prune 循环与 keepByLabel 均消费它。
- **projection.BUSINESS_KEY_FIELDS**：`ontology/projection.ts:185` 硬编码 `['invoiceNo','contractNo','name','costType']`，factToEntity（:196-209）消费。
- **masterData 泛化**：`MASTER_DATA_TYPES`（masterData.ts:11）驱动端点 enum + 表单反射投影（masterDataFormSchemaJson :81-104）；`POST /master-data` 路由 `{entityType, validAt, ...payload}` → `entitySchema` strict 预检 → insertTradeFact（ontology.ts:63-104），唯一按类型分支是 TradeGoods 商品码门禁（:83）——加 TradeProject 零路由改动。
- **linkTools**：`LINKABLE_RELATIONS` 9 关系（linkTools.ts:19-22）；起点必为事实行（:62-66），ALLOCATE_TO 的 to 侧有合同台账回退（:72-77）——合同起点解析按此先例泛化。
- **registry.test.ts** 断言实体名单/枚举/关系（ontology-foundation Task 1 建立），11→12 实体、11→16 关系、19→24 连接对需同步更新断言。
- **PG 集成测试**：`test/pipeline/postgres.integration.test.ts`（无 DB_BACKEND=postgres 时 skip，CI SQLite 车道不受影响）。

---

### Task 0: 前置检查（基线同步 + 冲突探查）

**Files:** 无代码改动。

**Interfaces:** 无。

- [ ] **Step 1: 同步基线并验证绿**

```bash
git fetch origin main
git merge origin/main
# 预期：无冲突；有冲突停下人工研判
npm run build && npm run lint && npm test
# 预期：全绿（约定要求的起点干净）
```

- [ ] **Step 2: 确认 spec 决策默认值未被推翻**

读 `docs/superpowers/specs/2026-09-20-ontology-business-loop-design.md` §4：D1-D4 若已有非默认裁决，先按裁决修订本计划对应任务再开工。

---

### Task 1: 注册表版本化机制（ONTOLOGY_SCHEMA_VERSION + 内容指纹门禁）

**Files:**
- Modify: `apps/server/src/ontology/index.ts`
- Create: `apps/server/test/ontology/registry-fingerprint.json`
- Test: `apps/server/test/ontology/registry.test.ts`（追加 describe）

**Interfaces:**
- Consumes: `ontologySchemaJson()`（index.ts:411 既有导出）。
- Produces（后续任务与 Wave 2 依赖）:
  - `ONTOLOGY_SCHEMA_VERSION: string`（常量，`'2026-09-20-loop-v2'`）
  - `registryContentFingerprint(): string`（fnv-1a 32 位十六进制；剔除 version 字段后的稳定序列化）
  - 指纹文件契约：`test/ontology/registry-fingerprint.json` = `{"version": string, "fingerprint": string}`
  - 重生成命令（后续任务复用）：`npx tsx -e "import { ONTOLOGY_SCHEMA_VERSION, registryContentFingerprint } from './src/ontology/index.js'; process.stdout.write(JSON.stringify({ version: ONTOLOGY_SCHEMA_VERSION, fingerprint: registryContentFingerprint() }, null, 2) + '\n')" > test/ontology/registry-fingerprint.json`（workdir `apps/server`）

- [ ] **Step 1: 写失败测试**（`test/ontology/registry.test.ts` 追加；import 区补 `readFileSync` from `node:fs`、`fileURLToPath` from `node:url`，并从 `'../../src/ontology/index.js'` 增 import `ONTOLOGY_SCHEMA_VERSION, registryContentFingerprint`）

```ts
const FINGERPRINT_PATH = fileURLToPath(new URL('./registry-fingerprint.json', import.meta.url));

describe('registry versioning (business-loop wave1)', () => {
  it('fingerprint file stays in sync with registry content and version', () => {
    const recorded = JSON.parse(readFileSync(FINGERPRINT_PATH, 'utf-8')) as {
      version: string; fingerprint: string;
    };
    expect(ONTOLOGY_SCHEMA_VERSION).toBe(recorded.version);
    expect(registryContentFingerprint()).toBe(recorded.fingerprint);
  });

  it('fingerprint is deterministic within a process', () => {
    expect(registryContentFingerprint()).toBe(registryContentFingerprint());
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/ontology/registry.test.ts`
Expected: FAIL（`registryContentFingerprint` 未导出 / 指纹文件不存在）

- [ ] **Step 3: 实现**（`index.ts` 两处改动）

3a. 枚举区之后（`MEANING_URIS` 声明下方）加版本常量：

```ts
// ---------------------------------------------------------------------------
// 模型版本（business-loop Wave 1，spec §5 决策 #1）：行级血缘标记。
// 语义性变更（新实体/新关系/枚举变动）必须升本常量；任何内容变更必须同步
// test/ontology/registry-fingerprint.json（重生成命令见 wave1 plan Task 1）。
// ---------------------------------------------------------------------------

export const ONTOLOGY_SCHEMA_VERSION = '2026-09-20-loop-v2';
```

3b. 文件末尾（`ontologySchemaJson` 之后）加指纹函数，并把 `ontologySchemaJson()` 内 `version: '2026-09-10-flowpanel'` 改为 `version: ONTOLOGY_SCHEMA_VERSION`：

```ts
// ---------------------------------------------------------------------------
// 内容指纹门禁（spec §5 决策 #2）：纯 TS fnv-1a + 稳定序列化，本文件保持
// 零 node 内建依赖。CI 断言指纹文件与注册表内容一致——改注册表不更新文件即红。
// ---------------------------------------------------------------------------

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  if (v !== null && typeof v === 'object') {
    const rec = v as Record<string, unknown>;
    return '{' + Object.keys(rec).sort()
      .map((k) => JSON.stringify(k) + ':' + stableStringify(rec[k])).join(',') + '}';
  }
  return JSON.stringify(v) ?? 'null';
}

function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** 注册表内容指纹：ontologySchemaJson() 剔除 version 后的稳定序列化哈希。 */
export function registryContentFingerprint(): string {
  const { version: _version, ...rest } = ontologySchemaJson() as Record<string, unknown>;
  return fnv1a(stableStringify(rest));
}
```

- [ ] **Step 4: 生成指纹文件**

```bash
npx tsx -e "import { ONTOLOGY_SCHEMA_VERSION, registryContentFingerprint } from './src/ontology/index.js'; process.stdout.write(JSON.stringify({ version: ONTOLOGY_SCHEMA_VERSION, fingerprint: registryContentFingerprint() }, null, 2) + '\n')" > test/ontology/registry-fingerprint.json
```

（workdir `apps/server`；生成后 cat 确认 JSON 合法）

- [ ] **Step 5: 跑测试确认通过**

Run: `npm test --workspace apps/server -- test/ontology/registry.test.ts`
Expected: PASS（含既有用例——version 字段替换不改变其余内容语义）

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/ontology/index.ts apps/server/test/ontology/registry.test.ts apps/server/test/ontology/registry-fingerprint.json
git commit -m "feat(ontology): registry schema version + content fingerprint gate (business-loop wave1)"
```

---

### Task 2: schema_version 落列（DDL 双后端 + repo 全链透传）

**Files:**
- Modify: `apps/server/src/pipeline/db/client.ts`（migrate 守卫 ALTER + migratePostgres statements）
- Modify: `apps/server/src/pipeline/db/postgres-schema.ts:595-637`（drizzle twin 两表）
- Modify: `apps/server/src/ontology/repo.ts`（Input/Row 类型 + 四处 INSERT + 行映射）
- Test: `apps/server/test/ontology/repo.test.ts`（追加 describe）；`apps/server/test/pipeline/postgres.integration.test.ts`（列断言）

**Interfaces:**
- Consumes: `ONTOLOGY_SCHEMA_VERSION`（Task 1）。
- Produces（Wave 2 回填依赖）:
  - `TradeFactInput.schemaVersion?: string` / `OntologyEdgeInput.schemaVersion?: string`（缺省=当前注册表版本；显式指定=历史版本回填盖章）
  - `TradeFactRow.schemaVersion: string | null` / `OntologyEdgeRow.schemaVersion: string | null`
  - 两表物理列 `schema_version TEXT`（nullable；存量行 NULL=2026-09-20 前写入，D8 清理后无存量）

- [ ] **Step 1: 写失败测试**（`repo.test.ts` 追加，沿本文件既有 `:memory:` + migrate 的 ctx 范式；import 区增 `ONTOLOGY_SCHEMA_VERSION`、`listOntologyEdgesAsOf`、`asOfSystemTime`（若未引入））

```ts
describe('schema_version stamping (business-loop wave1)', () => {
  it('stamps facts with current registry version by default', async () => {
    const id = await insertTradeFact(ctx, {
      entityType: 'ServiceCostEvent',
      payload: { eventBizType: '正向', amount: 100, currency: 'CNY', costType: '物流' },
      validAt: '2026-09-20T00:00:00Z', createdBy: 't',
    });
    const row = await getTradeFactById(ctx, id);
    expect(row?.schemaVersion).toBe(ONTOLOGY_SCHEMA_VERSION);
  });

  it('accepts explicit schemaVersion override (backfill historical version)', async () => {
    const id = await insertTradeFact(ctx, {
      entityType: 'ServiceCostEvent',
      payload: { eventBizType: '正向', amount: 100, currency: 'CNY', costType: '物流' },
      validAt: '2026-09-01T00:00:00Z', createdBy: 'backfill',
      schemaVersion: '2026-09-10-flowpanel',
    });
    const row = await getTradeFactById(ctx, id);
    expect(row?.schemaVersion).toBe('2026-09-10-flowpanel');
  });

  it('stamps edges with current registry version', async () => {
    const edgeId = await insertOntologyEdge(ctx, {
      relation: 'ALLOCATE_TO',
      fromType: 'ServiceCostEvent', fromId: 'TF-x',
      toType: 'TradeContract', toId: 'CL-1',
      params: { amount: 1, method: '金额' },
      validAt: '2026-09-20T00:00:00Z', createdBy: 't',
    });
    const edges = await listOntologyEdgesAsOf(
      ctx, asOfSystemTime('2026-09-21T00:00:00Z'), { relation: 'ALLOCATE_TO' });
    expect(edges.find((e) => e.id === edgeId)?.schemaVersion).toBe(ONTOLOGY_SCHEMA_VERSION);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/ontology/repo.test.ts`
Expected: FAIL（`schemaVersion` 属性不存在 / undefined ≠ 期望值）

- [ ] **Step 3: 实现 DDL**

3a. `client.ts` migrate 内，document_id 守卫块（:499-504）之后追加（同款模式）：

```ts
  // business-loop Wave 1(2026-09-20): 两表 schema_version 行级模型版本标记(spec 决策 #3)。
  // 沿 document_id 守卫 ALTER 模式(CREATE TABLE IF NOT EXISTS 不加列, 新旧库统一走此)。
  for (const tbl of ['ontology_edges', 'trade_facts']) {
    const cols = sqlite.prepare(`PRAGMA table_info(${tbl})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'schema_version')) {
      try { sqlite.exec(`ALTER TABLE ${tbl} ADD COLUMN schema_version TEXT`); } catch { /* concurrent */ }
    }
  }
```

3b. `client.ts` migratePostgres 的 statements 数组（沿 trade_facts.document_id 的 `ADD COLUMN IF NOT EXISTS` 先例）追加两条：

```ts
  'ALTER TABLE ontology_edges ADD COLUMN IF NOT EXISTS schema_version TEXT',
  'ALTER TABLE trade_facts ADD COLUMN IF NOT EXISTS schema_version TEXT',
```

3c. `postgres-schema.ts`：`ontologyEdges` 表对象在 `userId` 后加 `schemaVersion: text('schema_version'),`；`tradeFacts` 表对象在 `documentId` 后加同款行。

- [ ] **Step 4: 实现 repo.ts 全链透传**

4a. import 区增 `ONTOLOGY_SCHEMA_VERSION`（并入既有 `'./index.js'` import）。

4b. 列常量追加列：

```ts
const FACT_COLS = 'id, entity_type, payload, valid_at, invalid_at, ingested_at, created_by, user_id, document_id, schema_version';
const EDGE_COLS = 'id, relation, from_type, from_id, to_type, to_id, params, valid_at, invalid_at, ingested_at, created_by, user_id, schema_version';
```

4c. `TradeFactInput` / `OntologyEdgeInput` 各加：

```ts
  /** 行级模型版本(血缘标记, spec 决策 #3): 缺省=当前注册表版本, 回填可指定历史版本。 */
  schemaVersion?: string;
```

`TradeFactRow` / `OntologyEdgeRow` 各加 `schemaVersion: string | null;`。

4d. `insertTradeFact`：解构后求值 `const schemaVersion = input.schemaVersion ?? ONTOLOGY_SCHEMA_VERSION;`，PG INSERT 的 VALUES 追加 `$10`、参数数组末尾追加 `schemaVersion`；SQLite INSERT 追加一个 `?` 与同位参数。

4e. `factRowFrom` 追加映射：

```ts
    schemaVersion: r['schema_version'] == null ? null : String(r['schema_version']),
```

4f. `PreparedEdgeRow` 加 `schemaVersion: string;`；`prepareEdgeRow` 返回对象加 `schemaVersion: input.schemaVersion ?? ONTOLOGY_SCHEMA_VERSION,`；`PG_EDGE_INSERT` VALUES 追加 `$13`、`SQLITE_EDGE_INSERT` 追加 `?`、`edgeRowParams` 末尾追加 `r.schemaVersion`。

4g. `listOntologyEdgesAsOf` 的 `mapRow` 追加 `schemaVersion: r['schema_version'] == null ? null : String(r['schema_version']),`。

4h. `insertFactParams`（supersede 用 helper）：入参对象类型加 `schemaVersion: string;`，返回数组末尾追加 `r.schemaVersion`；`supersedeTradeFact` 内求值 `const schemaVersion = input.next.schemaVersion ?? ONTOLOGY_SCHEMA_VERSION;` 并传入两处 `insertFactParams({ ..., schemaVersion })` 调用。

- [ ] **Step 5: PG 集成测试列断言**（`postgres.integration.test.ts`，沿本文件既有 pg 连接获取方式；无 DB_BACKEND=postgres 自动 skip）

```ts
it('ontology tables carry schema_version column (business-loop wave1)', async () => {
  const res = await pgPool.query(
    `SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'schema_version'
        AND table_name IN ('trade_facts', 'ontology_edges')`);
  expect(res.rows.map((r: { table_name: string }) => r.table_name).sort())
    .toEqual(['ontology_edges', 'trade_facts']);
});
```

（`pgPool` 换成本文件既有的连接变量名）

- [ ] **Step 6: 跑测试确认通过**

Run: `npm test --workspace apps/server -- test/ontology/repo.test.ts`
Expected: PASS（含既有用例——supersede/批量路径回归绿）

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/pipeline/db/client.ts apps/server/src/pipeline/db/postgres-schema.ts apps/server/src/ontology/repo.ts apps/server/test/ontology/repo.test.ts apps/server/test/pipeline/postgres.integration.test.ts
git commit -m "feat(ontology): stamp schema_version on facts/edges across both backends (business-loop wave1)"
```

---

### Task 3: 硬编码清单注册表派生（FACT_NODE_LABELS / ENTITY_BUSINESS_KEYS）

**Files:**
- Modify: `apps/server/src/ontology/index.ts`（ENTITY_BUSINESS_KEYS）
- Modify: `apps/server/src/ontology/projection.ts:185-193`（businessKeyOf 注册表化并导出）
- Modify: `apps/server/src/ontology/graphSync.ts:33-40`（FACT_NODE_LABELS 派生）
- Test: `apps/server/test/ontology/graphSync.test.ts`（追加）；`apps/server/test/ontology/projection.test.ts`（若无既有文件则创建）

**Interfaces:**
- Produces:
  - `ENTITY_BUSINESS_KEYS: Readonly<Partial<Record<OntologyEntityName, readonly string[]>>>`（index.ts；Task 4 将补 TradeProject 条目）
  - `businessKeyOf(entityType: string, p: Record<string, unknown>): string | null`（projection.ts 导出；Wave 2 映射器复用）
  - `FACT_NODE_LABELS: readonly OntologyEntityName[]`（graphSync.ts；派生规则 = ENTITY_NAMES 去掉 TradeContract，spec 决策 #4）
- Consumes: `ENTITY_NAMES`（index.ts 既有导出）。

- [ ] **Step 1: 写失败测试**

1a. `graphSync.test.ts` 追加（import 区若无 `FACT_NODE_LABELS` 则补）：

```ts
it('FACT_NODE_LABELS derives from registry: all entities except TradeContract (wave1 decision 4)', () => {
  expect([...FACT_NODE_LABELS].sort()).toEqual([
    'CollectionEvent', 'Counterparty', 'GoodsDeliveryEvent', 'GoodsReceiptEvent',
    'InvoiceEvent', 'OrgUnit', 'PaymentEvent', 'ServiceCostEvent', 'SettlementEvent', 'TradeGoods',
  ]);
});
```

1b. `projection.test.ts`（无则创建，仅 import describe/it/expect 与被测函数）：

```ts
import { describe, it, expect } from 'vitest';
import { businessKeyOf } from '../../src/ontology/projection.js';

describe('businessKeyOf (registry-driven, wave1 decision 5)', () => {
  it('resolves first non-empty key per entity priority list', () => {
    expect(businessKeyOf('InvoiceEvent', { invoiceNo: 'INV-1', contractNo: 'C-1' })).toBe('INV-1');
    expect(businessKeyOf('InvoiceEvent', { contractNo: 'C-1' })).toBe('C-1');
    expect(businessKeyOf('ServiceCostEvent', { costType: '物流' })).toBe('物流');
    expect(businessKeyOf('TradeGoods', { name: '螺纹钢' })).toBe('螺纹钢');
  });
  it('returns null for entities without declared keys or empty payloads', () => {
    expect(businessKeyOf('PaymentEvent', { amount: 5 })).toBeNull();
    expect(businessKeyOf('SettlementEvent', { amount: 1, currency: 'CNY' })).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/ontology/graphSync.test.ts test/ontology/projection.test.ts`
Expected: FAIL（`businessKeyOf` 未导出；FACT_NODE_LABELS 排序内容因含 type 断言通过与否取决于实现——此时应为编译错/断言失败）

- [ ] **Step 3: 实现**

3a. `index.ts`（mixin 词汇区之后、语义规则区之前）：

```ts
/** 台账业务键（原 projection.BUSINESS_KEY_FIELDS 硬编码注册表化，business-loop
 *  Wave 1 spec 决策 #5）：按实体声明键优先级数组，依序取第一个非空字符串值。
 *  新增实体的业务键登记于此，不再改 projection 硬编码。 */
export const ENTITY_BUSINESS_KEYS: Readonly<
  Partial<Record<OntologyEntityName, readonly string[]>>
> = {
  TradeGoods: ['name'],
  Counterparty: ['name'],
  OrgUnit: ['name'],
  InvoiceEvent: ['invoiceNo', 'contractNo'],
  PaymentEvent: ['contractNo'],
  CollectionEvent: ['contractNo'],
  ServiceCostEvent: ['costType'],
};
```

3b. `projection.ts`：删除 `const BUSINESS_KEY_FIELDS = [...]`（:185），import 区并入 `ENTITY_BUSINESS_KEYS`（已 import `type OntologyEntityName`），替换 `businessKeyOf` 并导出：

```ts
/** 事实行业务键解析（注册表驱动，wave1 决策 #5）：ENTITY_BUSINESS_KEYS 按序取
 *  第一个非空字符串；无声明键的实体返回 null（台账回退显示行 id）。 */
export function businessKeyOf(entityType: string, p: Record<string, unknown>): string | null {
  const keys = ENTITY_BUSINESS_KEYS[entityType as OntologyEntityName];
  if (!keys) return null;
  for (const k of keys) {
    const v = p[k];
    if (typeof v === 'string' && v !== '') return v;
  }
  return null;
}
```

`factToEntity` 内 label 行改为 `label: businessKeyOf(row.entityType, row.payload) ?? row.id,`。

3c. `graphSync.ts`：import 区并入 `ENTITY_NAMES`（`'./index.js'`），替换 :33-40 为：

```ts
/** 建事实节点的实体 label（派生，spec business-loop 决策 #4）：全部实体除
 *  TradeContract（永远走 Contract 桥，不建节点）；收/发货的 documents 源伪事件
 *  保持 Document 表示。新增实体自动进本集合，不再改本文件。 */
export const FACT_NODE_LABELS: readonly OntologyEntityName[] =
  ENTITY_NAMES.filter((n) => n !== 'TradeContract');
```

（原 `type FactNodeLabel` 删除；其唯一使用处 `FACT_NODE_LABELS.includes(fact.entityType as FactNodeLabel)` 改为 `as OntologyEntityName`，import 类型。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test --workspace apps/server -- test/ontology/graphSync.test.ts test/ontology/projection.test.ts`
Expected: PASS（graphSync 既有 13 例不回归——派生集合与原硬编码逐项相等）

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/ontology/index.ts apps/server/src/ontology/projection.ts apps/server/src/ontology/graphSync.ts apps/server/test/ontology/graphSync.test.ts apps/server/test/ontology/projection.test.ts
git commit -m "refactor(ontology): derive FACT_NODE_LABELS and business keys from registry (business-loop wave1)"
```

---

### Task 4: TradeProject 第 12 实体 + BELONGS_TO + masterData 四类 + link_ontology 合同起点

**Files:**
- Modify: `apps/server/src/ontology/index.ts`（实体/标签/描述/业务键/BELONGS_TO）
- Modify: `apps/server/src/ontology/masterData.ts`（MASTER_DATA_TYPES + inputSchema 字段）
- Modify: `apps/server/src/ontology/linkTools.ts`（CONTRACT_FROM_RELATIONS + 词表 + 端点解析）
- Test: `registry.test.ts`、`masterData.test.ts`（无则创建）、`linkTools.test.ts`、`graphSync.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `ENTITY_BUSINESS_KEYS`、`FACT_NODE_LABELS` 派生。
- Produces:
  - `OntologyEntityName` 联合类型新增 `'TradeProject'`（12 实体：5 静态 + 7 事件）
  - `MASTER_DATA_TYPES = ['TradeGoods', 'Counterparty', 'OrgUnit', 'TradeProject']`
  - 关系 `BELONGS_TO`（TradeContract → TradeProject，无参）
  - `LINKABLE_RELATIONS` 含 `'BELONGS_TO'`（10 个）
  - `CONTRACT_FROM_RELATIONS: readonly string[]`（linkTools 模块常量，本任务 = `['BELONGS_TO']`，Task 5 扩）

- [ ] **Step 1: 写失败测试**

1a. `registry.test.ts`：把既有"11 实体"名单断言更新为 12（TradeProject 插在 OrgUnit 后），并追加：

```ts
it('TradeProject is static phase; projectNo/name required', () => {
  expect(entityPhase('TradeProject')).toBe('static');
  expect(() => entitySchema('TradeProject').parse({ projectNo: 'PRJ-2025-039', name: '动力煤年度采购' })).not.toThrow();
  expect(() => entitySchema('TradeProject').parse({ name: '缺编号' } as never)).toThrow();
});

it('BELONGS_TO allows contract -> project only', () => {
  expect(isRelationPairAllowed('BELONGS_TO', 'TradeContract', 'TradeProject')).toBe(true);
  expect(isRelationPairAllowed('BELONGS_TO', 'TradeProject', 'TradeContract')).toBe(false);
});
```

（若既有用例断言关系数/连接对数：11→12 类型、19→20 对，本步同步更新。）

1b. `masterData.test.ts`（无则创建，import `MASTER_DATA_TYPES, masterDataFormSchemaJson`）：

```ts
import { describe, it, expect } from 'vitest';
import { MASTER_DATA_TYPES, masterDataFormSchemaJson } from '../../src/ontology/masterData.js';

describe('master data 4 static types (wave1)', () => {
  it('covers TradeProject with projectNo required in form projection', () => {
    expect([...MASTER_DATA_TYPES]).toContain('TradeProject');
    const form = masterDataFormSchemaJson().types.find((t) => t.name === 'TradeProject');
    expect(form?.label).toBe('贸易项目');
    expect(form?.fields.find((f) => f.name === 'projectNo')?.required).toBe(true);
  });
});
```

1c. `linkTools.test.ts` 追加（沿本文件既有 ctx/工具直调范式；合同台账 fixture 若无 helper 则直写 SQL，列以 client.ts contract_ledger DDL 为准）：

```ts
it('BELONGS_TO: from = ledger contract row, to = TradeProject fact (wave1)', async () => {
  ctx.sqlite.prepare(
    `INSERT INTO contract_ledger (id, contract_no, title, contract_type, fields, created_at, user_id)
     VALUES ('CL-1', 'HT-LOOP-1', '测试合同', '采购', '{}', '2026-09-20T00:00:00Z', '')`,
  ).run();
  const projId = await insertTradeFact(ctx, {
    entityType: 'TradeProject', payload: { projectNo: 'PRJ-1', name: '测试项目' },
    validAt: '2026-09-20T00:00:00Z', createdBy: 't',
  });
  const res = await invokeLinkOntology(ctx, { relation: 'BELONGS_TO', fromId: 'CL-1', toId: projId });
  expect(res.status).toBe('ok');
});

it('BELONGS_TO rejects non-contract from id', async () => {
  const res = await invokeLinkOntology(ctx, { relation: 'BELONGS_TO', fromId: 'TF-不存在', toId: 'TF-x' });
  expect(res.status).toBe('invalid');
});
```

（`invokeLinkOntology` = 本文件既有工具调用封装的名字，按实际改名）

1d. `graphSync.test.ts` 追加：

```ts
it('derived labels include TradeProject without editing graphSync (wave1 decision 4)', () => {
  expect(FACT_NODE_LABELS).toContain('TradeProject');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/ontology/registry.test.ts test/ontology/masterData.test.ts test/ontology/linkTools.test.ts test/ontology/graphSync.test.ts`
Expected: FAIL（TradeProject 未注册 / BELONGS_TO 未知关系 / 词表无 BELONGS_TO）

- [ ] **Step 3: 实现**

3a. `index.ts`：
- `OntologyEntityNameSchema` 枚举 `'OrgUnit'` 后插入 `'TradeProject'`；
- `ONTOLOGY_ENTITIES` 在 `OrgUnit` 条目后加：

```ts
  TradeProject: z.object({
    projectNo: z.string().min(1).describe('项目编号(核算分组主键口径, 如 PRJ-2025-039)'),
    name: z.string().min(1).describe('项目名称'),
    projectType: z.string().optional().describe('项目类型(开放: 年度长协/批次自营/代采代销/套利)'),
    commodity: z.string().optional().describe('主营商品品类(开放; 收敛后与 TradeGoods 词汇对齐)'),
    direction: z.string().optional().describe('方向(开放: 采购/销售/双向)'),
    plannedAmount: z.number().optional().describe('预算金额'),
    currency: Currency.optional().describe('预算币种'),
  }),
```

- `ENTITY_LABELS` 加 `TradeProject: '贸易项目',`；`ENTITY_DESCRIPTIONS` 加：

```ts
  TradeProject: '核算分组/贸易批次（OrgUnit 项目化，原型 project 载体）；合同经 BELONGS_TO 归属，按项目聚合勾稽与报表的根节点。',
```

- `ENTITY_BUSINESS_KEYS` 加 `TradeProject: ['projectNo'],`；
- `ONTOLOGY_RELATIONS` 在 `PARENT_OF` 条目后加：

```ts
  {
    name: 'BELONGS_TO',
    description: '核算归属(business-loop Wave 1, 原型 belongs_to): 合同 BELONGS_TO 贸易项目; 资产树与按项目勾稽的骨架。',
    pairs: [{ from: 'TradeContract', to: 'TradeProject' }],
    params: NO_PARAMS,
  },
```

3b. `masterData.ts`：

```ts
export const MASTER_DATA_TYPES = ['TradeGoods', 'Counterparty', 'OrgUnit', 'TradeProject'] as const;
```

`CreateMasterDataInputSchema` 的 `entityType` describe 改为 `'主数据类型（商品/交易对手/内部组织/贸易项目）'`，对象内在 `code` 字段后追加：

```ts
  projectNo: z.string().min(1).optional().describe('项目编号（仅贸易项目必填，如 PRJ-2025-039）'),
  projectType: z.string().optional().describe('项目类型（仅贸易项目，选填：年度长协/批次自营/代采代销/套利）'),
  commodity: z.string().optional().describe('主营商品品类（仅贸易项目，选填）'),
  direction: z.string().optional().describe('方向（仅贸易项目，选填：采购/销售/双向）'),
  plannedAmount: z.number().optional().describe('预算金额（仅贸易项目，选填）'),
```

（文件头注释"3 类静态实体"同步改"4 类"；`POST /master-data` 路由零改动——已核实泛化分派。）

3c. `linkTools.ts`：
- 词表与常量：

```ts
export const LINKABLE_RELATIONS = [
  'ALLOCATE_TO', 'REVERSE_ORIGIN', 'FEEDS_INTO', 'CORRESPONDS_TO', 'TRIGGERS', 'PROVIDE',
  'PARENT_OF', 'DELIVERED_AS', 'TRADING_WITH', 'BELONGS_TO',
] as const;

/** 起点为合同台账行的关系（business-loop Wave 1）：BELONGS_TO（Task 5 扩
 *  TRADE_PAIR/MASTER_SUPPLEMENT）。合同实体活在 contract_ledger 投影，不在 trade_facts。 */
const CONTRACT_FROM_RELATIONS: readonly string[] = ['BELONGS_TO'];
```

- execute 第 1 步（起点解析）替换为：

```ts
        // 1. 起点：事实行；合同起点关系用台账合同行（TradeContract 投影源，
        //    ALLOCATE_TO 的 to 侧合同回退同款先例）。
        let fromType: string;
        let fromFact: Awaited<ReturnType<typeof getTradeFactById>> = null;
        if (CONTRACT_FROM_RELATIONS.includes(relation)) {
          const contract = await findContractRowById(deps.ctx, fromId, deps.userId ?? '');
          if (!contract) {
            return { status: 'invalid' as const, detail: `起点合同不存在或不可见: ${fromId}` };
          }
          fromType = 'TradeContract';
        } else {
          fromFact = await getTradeFactById(deps.ctx, fromId, deps.userId);
          if (!fromFact) {
            return { status: 'invalid' as const, detail: `起点事实不存在或不可见: ${fromId}` };
          }
          fromType = fromFact.entityType;
        }
```

- 第 2 步（终点解析）合同回退条件扩展：

```ts
        } else if (relation === 'ALLOCATE_TO' || CONTRACT_FROM_RELATIONS.includes(relation)) {
```

- 第 4 步 REVERSE_ORIGIN 校验内 `from.payload` 改 `fromFact?.payload`（REVERSE_ORIGIN 不在 CONTRACT_FROM_RELATIONS，走事实分支必非空）；
- 第 5 步 insert 的 `fromType: from.entityType as never` 改 `fromType: fromType as never`（用解析后的变量）；
- description 末段前追加例句：`'合同归属项目："HT-1 归属 PRJ-2025-039 项目" -> relation=BELONGS_TO, fromId=<台账合同行id>, toId=<项目事实id>（from 用台账合同行 id，不是 TF-）。'`，并把"9 类之一"改为"10 类之一"。

- [ ] **Step 4: 重生成指纹文件（注册表内容已变）**

```bash
npx tsx -e "import { ONTOLOGY_SCHEMA_VERSION, registryContentFingerprint } from './src/ontology/index.js'; process.stdout.write(JSON.stringify({ version: ONTOLOGY_SCHEMA_VERSION, fingerprint: registryContentFingerprint() }, null, 2) + '\n')" > test/ontology/registry-fingerprint.json
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npm test --workspace apps/server -- test/ontology/`
Expected: PASS（含指纹门禁、graphSync 派生含 TradeProject、linkTools 既有 7 例不回归）

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/ontology/index.ts apps/server/src/ontology/masterData.ts apps/server/src/ontology/linkTools.ts apps/server/test/ontology/
git commit -m "feat(ontology): TradeProject entity + BELONGS_TO relation + contract-anchored linking (business-loop wave1)"
```

---

### Task 5: 五个新关系（TRADE_PAIR / MASTER_SUPPLEMENT / STOCK_OFFSET / INVOICE_MATCH / WRITE_OFF_SETTLEMENT）+ link_ontology 词表 14

**Files:**
- Modify: `apps/server/src/ontology/index.ts`（5 关系 + SHARED_TOOL_FIELD_NAMES 加 quantity）
- Modify: `apps/server/src/ontology/linkTools.ts`（词表 14 + 合同端点扩展 + quantity 参数 + 自环守卫 + 描述）
- Modify: `docs/tool-inventory.json`（link_ontology 条目 whenToUse/boundary 更新）
- Test: `registry.test.ts`、`linkTools.test.ts`、`test/harness/toolInventory.test.ts`（回归）

**Interfaces:**
- Consumes: Task 4 的 `CONTRACT_FROM_RELATIONS` 机制。
- Produces:
  - 关系 `TRADE_PAIR`（TradeContract→TradeContract，params `{note?}`）/ `MASTER_SUPPLEMENT`（同前）/ `STOCK_OFFSET`（GoodsReceiptEvent→GoodsDeliveryEvent，params `{quantity, batch?}`）/ `INVOICE_MATCH`（InvoiceEvent→InvoiceEvent，params `{quantity, note?}`）/ `WRITE_OFF_SETTLEMENT`（D1 裁决：PaymentEvent|CollectionEvent→SettlementEvent，params `{amount, partial?, batch?}`）——**17 类型 / 26 连接对**
  - `SHARED_TOOL_FIELD_NAMES` 含 `'quantity'`
  - `LINKABLE_RELATIONS` 14 关系（WRITE_OFF_SETTLEMENT 与 WRITE_OFF/OFFSET_SETTLE 同属核销工作台领地，刻意不入对话词表；Wave 3 query_business 与 Wave 4 聚合按注册表口径引用）

- [ ] **Step 1: 写失败测试**

1a. `registry.test.ts` 追加（关系数/连接对断言更新 12→17 / 20→26）：

```ts
it('wave1 relations: pairs and params', () => {
  expect(isRelationPairAllowed('TRADE_PAIR', 'TradeContract', 'TradeContract')).toBe(true);
  expect(isRelationPairAllowed('MASTER_SUPPLEMENT', 'TradeContract', 'TradeContract')).toBe(true);
  expect(isRelationPairAllowed('STOCK_OFFSET', 'GoodsReceiptEvent', 'GoodsDeliveryEvent')).toBe(true);
  expect(isRelationPairAllowed('INVOICE_MATCH', 'InvoiceEvent', 'InvoiceEvent')).toBe(true);
  expect(isRelationPairAllowed('WRITE_OFF_SETTLEMENT', 'PaymentEvent', 'SettlementEvent')).toBe(true);
  expect(isRelationPairAllowed('WRITE_OFF_SETTLEMENT', 'CollectionEvent', 'SettlementEvent')).toBe(true);
  expect(() => relationDef('STOCK_OFFSET').params.parse({ quantity: 400 })).not.toThrow();
  expect(() => relationDef('STOCK_OFFSET').params.parse({ batch: 'B-1' } as never)).toThrow();
  expect(() => relationDef('INVOICE_MATCH').params.parse({ quantity: 200, note: '税负转嫁' })).not.toThrow();
  expect(() => relationDef('WRITE_OFF_SETTLEMENT').params.parse({ amount: 900000, partial: true })).not.toThrow();
});
```

1b. `linkTools.test.ts` 追加：

```ts
it('TRADE_PAIR links two ledger contract rows (wave1)', async () => {
  // 沿 Task 4 fixture：CL-1 已在；再插 CL-2
  ctx.sqlite.prepare(
    `INSERT INTO contract_ledger (id, contract_no, title, contract_type, fields, created_at, user_id)
     VALUES ('CL-2', 'HT-LOOP-2', '销售合同', '销售', '{}', '2026-09-20T00:00:00Z', '')`,
  ).run();
  const res = await invokeLinkOntology(ctx, { relation: 'TRADE_PAIR', fromId: 'CL-1', toId: 'CL-2', note: '背靠背' });
  expect(res.status).toBe('ok');
});

it('STOCK_OFFSET requires quantity (strict params)', async () => {
  const rcpt = await insertTradeFact(ctx, {
    entityType: 'GoodsReceiptEvent', payload: { eventBizType: '正向', quantity: 620, unit: '吨' },
    validAt: '2026-09-20T00:00:00Z', createdBy: 't',
  });
  const dlv = await insertTradeFact(ctx, {
    entityType: 'GoodsDeliveryEvent', payload: { eventBizType: '正向', quantity: 200, unit: '吨' },
    validAt: '2026-09-20T00:00:00Z', createdBy: 't',
  });
  const missing = await invokeLinkOntology(ctx, { relation: 'STOCK_OFFSET', fromId: rcpt, toId: dlv });
  expect(missing.status).toBe('invalid');
  expect(JSON.stringify(missing)).toContain('quantity');
  const ok = await invokeLinkOntology(ctx, { relation: 'STOCK_OFFSET', fromId: rcpt, toId: dlv, quantity: 200 });
  expect(ok.status).toBe('ok');
});

it('rejects self-loop edges (wave1)', async () => {
  const res = await invokeLinkOntology(ctx, { relation: 'TRADE_PAIR', fromId: 'CL-1', toId: 'CL-1' });
  expect(res.status).toBe('invalid');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/ontology/registry.test.ts test/ontology/linkTools.test.ts`
Expected: FAIL（4 关系未注册 / 词表无 TRADE_PAIR 等）

- [ ] **Step 3: 实现**

3a. `index.ts` `ONTOLOGY_RELATIONS` 末尾（`TRADING_WITH` 之后）追加：

```ts
  {
    name: 'TRADE_PAIR',
    description: '背靠背对冲(business-loop Wave 1, 原型 trade_pair): 采购合同与销售合同对冲/套利; 购销存勾稽(存货缺口)的范围约束。',
    pairs: [{ from: 'TradeContract', to: 'TradeContract' }],
    params: z.object({ note: z.string().optional().describe('备注(如 对冲/套利)') }).strict(),
  },
  {
    name: 'MASTER_SUPPLEMENT',
    description: '主合同-补充协议(business-loop Wave 1, 原型 master_supplement): 补充协议溯源主合同, 改价改量以协议事实承载。',
    pairs: [{ from: 'TradeContract', to: 'TradeContract' }],
    params: z.object({ note: z.string().optional().describe('备注') }).strict(),
  },
  {
    name: 'STOCK_OFFSET',
    description: '库存核减(business-loop Wave 1, 原型 stock_offset): 采购收货被销售发货核减, 按 商品+仓库 维度; params.quantity=本次核减数量。存货结存=Σ收货−Σ发货 的逐笔凭据。',
    pairs: [{ from: 'GoodsReceiptEvent', to: 'GoodsDeliveryEvent' }],
    params: z.object({
      quantity: z.number().describe('本次核减数量(吨)'),
      batch: z.string().optional().describe('批次'),
    }).strict(),
  },
  {
    name: 'INVOICE_MATCH',
    description: '票票配比(business-loop Wave 1, 原型 invoice_match): 进项发票与销项发票按商品数量配比(税负转嫁勾稽); 红字票以负数参与。',
    pairs: [{ from: 'InvoiceEvent', to: 'InvoiceEvent' }],
    params: z.object({
      quantity: z.number().describe('配比数量'),
      note: z.string().optional().describe('备注'),
    }).strict(),
  },
  {
    name: 'WRITE_OFF_SETTLEMENT',
    description: '结算目标核销(business-loop Wave 1, D1 裁决 2026-09-20 采原型口径): 付款/收款 → 结算 常规核销, 与 OFFSET_SETTLE(预付冲抵)端点相同语义不同; 既有 WRITE_OFF(→发票, 票款匹配)保留并存。核销工作台迁移归 Wave 4。',
    pairs: [
      { from: 'PaymentEvent', to: 'SettlementEvent' },
      { from: 'CollectionEvent', to: 'SettlementEvent' },
    ],
    params: z.object({
      amount: z.number().describe('核销金额'),
      partial: z.boolean().optional().describe('部分核销标记'),
      batch: z.string().optional().describe('批次'),
    }).strict(),
  },
```

3b. `index.ts` `SHARED_TOOL_FIELD_NAMES` 数组末尾（`'entityType'` 之后）追加：

```ts
  // 库存核减/票票配比关系参数（business-loop Wave 1）：STOCK_OFFSET/INVOICE_MATCH
  // 的 params 词汇（toolOntologyMap CI 门禁共享词表）。
  'quantity',
```

3c. `linkTools.ts`：
- `LINKABLE_RELATIONS` 追加 `'TRADE_PAIR', 'MASTER_SUPPLEMENT', 'STOCK_OFFSET', 'INVOICE_MATCH',`（共 14）；
- `CONTRACT_FROM_RELATIONS` 改为 `['BELONGS_TO', 'TRADE_PAIR', 'MASTER_SUPPLEMENT']`；
- inputSchema 在 `amount` 之前加：

```ts
      quantity: z.number().optional().describe('数量（STOCK_OFFSET 库存核减 / INVOICE_MATCH 票票配比必填，如 400 吨）'),
```

- execute 解构加 `quantity`；params 组装加 `if (quantity !== undefined) params['quantity'] = quantity;`；
- 连接对校验（第 3 步）之前加自环守卫：

```ts
        if (fromId === toId) {
          return { status: 'invalid' as const, detail: '起点与终点相同，拒绝自环边' };
        }
```

- description 更新：关系数"10 类"改"14 类"；追加例句 `'背靠背："HT-1 与 HT-2 是背靠背对冲" -> relation=TRADE_PAIR, fromId/toId=两个台账合同行 id；库存核减："这批发货核减 6 月收货 400 吨" -> relation=STOCK_OFFSET, quantity=400；票票配比："这张进项票配比那张销项票 200 吨" -> relation=INVOICE_MATCH, quantity=200；补充协议挂主合同 -> relation=MASTER_SUPPLEMENT。'`

3d. `docs/tool-inventory.json`：`link_ontology` 条目的 `whenToUse`/`boundary`（字段名以文件实际为准）补 5 类新关系与 quantity 参数说明；若条目有 version 字段则升 `2026-09-20`。

- [ ] **Step 4: 重生成指纹文件**

（同 Task 4 Step 4 命令）

- [ ] **Step 5: 跑测试确认通过（含治理门禁回归）**

Run: `npm test --workspace apps/server -- test/ontology/ test/harness/toolInventory.test.ts`
Expected: PASS（inventory bijection 不变——无新增工具；toolOntologyMap 词表因 quantity 已入共享表而绿）

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/ontology/index.ts apps/server/src/ontology/linkTools.ts docs/tool-inventory.json apps/server/test/ontology/
git commit -m "feat(ontology): trade-pair/master-supplement/stock-offset/invoice-match relations, link_ontology to 14 (business-loop wave1)"
```

---

### Task 6: 实体字段最小扩展集（D4 默认）

**Files:**
- Modify: `apps/server/src/ontology/index.ts`（TradeContract / GoodsReceipt / GoodsDelivery / SettlementEvent）
- Test: `registry.test.ts`（追加）

**Interfaces:**
- Produces（Wave 2 映射器目标词汇）:
  - `TradeContract`: +`direction`(必填，开放) `signDate?` `expireDate?` `buyerName?` `sellerName?` `contractAmount?`
  - `GoodsReceiptEvent` / `GoodsDeliveryEvent`: +`warehouse?`（STOCK_OFFSET 核减维度）
  - `SettlementEvent`: +`settlementType?`（周期/批次/最终/补差，开放）
- 说明：`create_trade_event` 对话工具词表**不**随动（工具字段是显式并集，新字段登记入口=表单与 Wave 2 映射器）；contract_ledger 投影读路径不 parse，不受 direction 必填影响。

- [ ] **Step 1: 写失败测试**（`registry.test.ts` 追加）

```ts
it('wave1 field extension set parses (spec D4 default)', () => {
  expect(() => entitySchema('TradeContract').parse({
    contractNo: 'HT-1', contractType: '采购', direction: '采购',
    signDate: '2025-07-15', buyerName: '甲公司', sellerName: '乙公司', contractAmount: 3860000,
  })).not.toThrow();
  expect(() => entitySchema('TradeContract').parse({ contractNo: 'HT-1', contractType: '采购' } as never)).toThrow();
  expect(() => entitySchema('GoodsReceiptEvent').parse({
    eventBizType: '正向', quantity: 620, unit: '吨', warehouse: '北仓',
  })).not.toThrow();
  expect(() => entitySchema('SettlementEvent').parse({
    eventBizType: '正向', amount: 100, currency: 'CNY', settlementType: '批次',
  })).not.toThrow();
});

it('strict still rejects unknown keys after extension', () => {
  expect(() => entitySchema('SettlementEvent').parse({
    eventBizType: '正向', amount: 1, currency: 'CNY', unknownField: 1,
  } as never)).toThrow();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/ontology/registry.test.ts`
Expected: FAIL（direction 等键未知被 strict 拒绝）

- [ ] **Step 3: 实现**（`index.ts` 三处）

3a. `TradeContract` 对象在 `contractType` 后追加：

```ts
    direction: z.string().describe('合同方向(开放: 采购/销售/代采; 原型 trade_direction 开放化)'),
    signDate: z.string().optional().describe('签约日期(ISO 日期)'),
    expireDate: z.string().optional().describe('到期日期(ISO 日期)'),
    buyerName: z.string().optional().describe('买方名称(开放文本; 主体归一后可对照 Counterparty)'),
    sellerName: z.string().optional().describe('卖方名称(开放文本)'),
    contractAmount: z.number().optional().describe('合同金额(勾稽锚点: 三单匹配/合同余额)'),
```

3b. `GoodsReceiptEvent` 与 `GoodsDeliveryEvent` 各在 `unit` 后追加：

```ts
    warehouse: z.string().optional().describe('仓库/堆场/目的港(STOCK_OFFSET 库存核减维度)'),
```

3c. `SettlementEvent` 在 `unit` 后追加：

```ts
    settlementType: z.string().optional().describe('结算类型(开放: 周期/批次/最终/补差)'),
```

- [ ] **Step 4: 重生成指纹文件 + 跑全量 ontology 测试**

Run: `npm test --workspace apps/server -- test/ontology/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/ontology/index.ts apps/server/test/ontology/registry.test.ts apps/server/test/ontology/registry-fingerprint.json
git commit -m "feat(ontology): wave1 field extension set for contracts/goods/settlements (business-loop wave1)"
```

---

### Task 7: 收口（全量验证 + D8 运维 + 合并 main）

**Files:** 无代码改动（运维 + 流程）。

**Interfaces:** 无。

- [ ] **Step 1: 全量验证**

```bash
npm run build && npm run lint && npm test
```

Expected: 全绿（server + web + lint 零错误）

- [ ] **Step 2: D8 运维——dev 库旧本体数据清理（先确认再清）**

```bash
ssh ubuntu-server "docker exec sca-pgvector psql -U sca -d sca -c 'SELECT count(*) FROM trade_facts; SELECT count(*) FROM ontology_edges;'"
# 人工确认数字与预期测试数据量级一致（D8：无审计价值）后：
ssh ubuntu-server "docker exec sca-pgvector psql -U sca -d sca -c 'TRUNCATE trade_facts, ontology_edges;'"
# 部署走 CD（合并 main 后自动）；如需手动验证迁移：
ssh ubuntu-server "export PATH=$HOME/.nvm/versions/node/v24.19.0/bin:$PATH && cd ~/supply-chain-agent && git fetch origin && git reset --hard origin/main && npm install && npm run build && pm2 reload sca-server"
```

本地 SQLite 测试数据自理（`apps/server/data/agent.db` 本就是非 vitest 本地暂存，AGENTS.md 口径）。

- [ ] **Step 3: 合并 main + push**

```bash
git fetch origin main
git merge origin/main   # 冲突则解决后重新跑 Step 1 验证
git push origin HEAD:<feature-branch>
git push origin HEAD:main
```

- [ ] **Step 4: 回填 spec 实施记录**

在 `docs/superpowers/specs/2026-09-20-ontology-business-loop-design.md` 末尾"实施记录"节追加 Wave 1 完成纪要（任务清单 + 关键 commit + 指纹版本号），并提交。

---

## Self-Review 结论（计划自检，执行者可忽略）

- Spec 覆盖：spec §3 Wave 1 七个子项 ↔ Task 1（指纹+版本）、Task 2（schema_version）、Task 3（派生）、Task 4（TradeProject+BELONGS_TO+masterData+linkTools）、Task 5（4 关系+词表+inventory）、Task 6（字段集）、Task 7（D8+收口）；断点 2/3/6/7 全部落在 Wave 1，断点 1/4/5 归 Wave 2-4（spec §3 已声明）。
- 类型一致性：`schemaVersion`（Input 可选/Row 可空）、`fromType` 局部变量化（linkTools）、`FACT_NODE_LABELS` 派生为 `readonly OntologyEntityName[]`——与既有 `as FactNodeLabel` 使用点兼容（Task 3 Step 3c 已注明改法）。
- 占位符扫描：无 TBD/TODO；所有代码步骤给全文；fixture 以"沿本文件既有范式 + 列以 DDL 为准"限定两处测试辅助（invokeLinkOntology 封装名、contract_ledger INSERT 列清单），执行者按实际微调属允许偏差。
