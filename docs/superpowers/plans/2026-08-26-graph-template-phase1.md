# 业务图谱模板 Phase 1（模板即数据：三表+种子+守卫+工作台上下文 API）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地模板层（template 三表 + 种子翻译 + templateGuard + 绑定门禁 + 工作台上下文 API），使"每类单据连什么边"由声明式模板驱动，绑定获得确定的起点/终点/边型。

**Architecture:** 模板存关系库（全局表，无 user_id——本体层非租户数据），代码内置种子幂等灌入；templateGuard 做类型兼容性硬校验 + 词表软校验（Phase 1 不阻断自由文本 relation，保证行为零变化基线）；绑定确认/创建前过守卫，边上落 templateVersion。本计划只做后端 + API；前端双下拉（CandidatePanel 改造）是**后续独立计划**，消费本计划 T7 的 context API。

**Tech Stack:** TypeScript (strict ESM, `.js` import 后缀)、better-sqlite3 + drizzle（SQLite 路径）、node-postgres（PG 路径）、Hono 路由、vitest。

**Spec:** `docs/superpowers/specs/2026-08-26-graph-template-design.md`

## Global Constraints

- 完成顺序强制：build → lint → test（`npm run build` / `npm run lint` / `npm test`，仓库根目录跑）。
- 代码中禁止 emoji。
- SQLite 用 raw idempotent DDL（`client.ts` 的 `migrate()`），不进 drizzle-kit；PG 用 drizzle schema + `postgres-schema.ts` 镜像 + `client.ts` PG 段 raw DDL（对照 graph_links 三处落点：client.ts:255/656、schema.ts:184、postgres-schema.ts:270）。
- 仓储层双后端：`repositories.ts` 中 `if (ctx.backend === 'postgres') return xxxPg(ctx, ...)` 分派 + `postgres-repositories.ts` Pg 版（对照 saveGraphLink repositories.ts:2828 / saveGraphLinkPg postgres-repositories.ts:2134）。
- 图写入永不阻塞业务主流程；守卫失败对用户主动操作即时拒绝（可读原因），对后台同步落 graph_status。
- 行为零变化基线：种子翻译后现有测试必须全绿；未登记 docType 一律放行（legacy 兼容）。
- 模板三表**无 user_id**（全局本体），与 graph_links（按 user 隔离）刻意不同——这是设计决策，不是遗漏。

---

### Task 1: 模板三表 DDL + drizzle schema

**Files:**
- Modify: `apps/server/src/pipeline/db/client.ts`（migrate() SQLite DDL + PG 段 DDL + createDb schema 注册）
- Modify: `apps/server/src/pipeline/db/schema.ts`（drizzle sqlite 表）
- Modify: `apps/server/src/pipeline/db/postgres-schema.ts`（drizzle pg 表）
- Test: `apps/server/test/pipeline/templateTables.test.ts`

**Interfaces:**
- Produces: 表 `template_types(id, kind, name, parent_id, props, is_active, created_at, updated_at)`、`template_edge_rules(id, source_type_id, target_type_id, edge_type, allowed_vocab, anchor_weights, is_active, template_version, created_at)`、`template_versions(version, changed_by, change_summary, changed_at)`。`target_type_id = ''` 表示通配"任意合同类型"。

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/test/pipeline/templateTables.test.ts
import { describe, expect, it } from 'vitest';
import { createDb, migrate } from '../../src/pipeline/db/client.js';

describe('template tables DDL', () => {
  it('migrate 后三张模板表存在', () => {
    const ctx = createDb();
    migrate(ctx.sqlite);
    const rows = ctx.sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'template_%' ORDER BY name",
    ).all() as { name: string }[];
    expect(rows.map((r) => r.name)).toEqual([
      'template_edge_rules', 'template_types', 'template_versions',
    ]);
  });

  it('template_types kind+name 唯一约束生效', () => {
    const ctx = createDb();
    migrate(ctx.sqlite);
    ctx.sqlite.prepare(
      "INSERT INTO template_types (id, kind, name) VALUES ('dt-x', 'doc_type', 'X单')",
    ).run();
    expect(() =>
      ctx.sqlite.prepare(
        "INSERT INTO template_types (id, kind, name) VALUES ('dt-x2', 'doc_type', 'X单')",
      ).run(),
    ).toThrow();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/pipeline/templateTables.test.ts`
Expected: FAIL（sqlite_master 查不到 template_% 表）

- [ ] **Step 3: SQLite DDL——在 `client.ts` `migrate()` 末尾（最后一个 CREATE 语句之后、函数闭合反引号之前）追加**

```sql
    -- 业务图谱模板(spec 2026-08-26 §3): 模板层 SSOT, 全局本体无 user_id。
    -- target_type_id = '' 是通配(任意合同类型); allowed_vocab/anchor_weights 为 JSON。
    CREATE TABLE IF NOT EXISTS template_types (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      parent_id TEXT,
      props TEXT NOT NULL DEFAULT '{}',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS template_types_kind_name_uq ON template_types (kind, name);
    CREATE INDEX IF NOT EXISTS template_types_parent ON template_types (parent_id);

    CREATE TABLE IF NOT EXISTS template_edge_rules (
      id TEXT PRIMARY KEY,
      source_type_id TEXT NOT NULL,
      target_type_id TEXT NOT NULL DEFAULT '',
      edge_type TEXT NOT NULL,
      allowed_vocab TEXT NOT NULL DEFAULT '[]',
      anchor_weights TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      template_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS template_edge_rules_src ON template_edge_rules (source_type_id, edge_type);

    CREATE TABLE IF NOT EXISTS template_versions (
      version INTEGER PRIMARY KEY,
      changed_by TEXT NOT NULL,
      change_summary TEXT NOT NULL,
      changed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
```

- [ ] **Step 4: PG 段 DDL——在 `client.ts` PG 迁移段（graph_links PG DDL ~line 656 同一 exec 序列）追加同构语句**

```ts
    // 模板三表(spec 2026-08-26)。TEXT(JSON) 与 SQLite 对齐。
    `CREATE TABLE IF NOT EXISTS template_types (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      parent_id TEXT,
      props TEXT NOT NULL DEFAULT '{}',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT now(),
      updated_at TEXT NOT NULL DEFAULT now()
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS template_types_kind_name_uq ON template_types (kind, name)`,
    `CREATE INDEX IF NOT EXISTS template_types_parent ON template_types (parent_id)`,
    `CREATE TABLE IF NOT EXISTS template_edge_rules (
      id TEXT PRIMARY KEY,
      source_type_id TEXT NOT NULL,
      target_type_id TEXT NOT NULL DEFAULT '',
      edge_type TEXT NOT NULL,
      allowed_vocab TEXT NOT NULL DEFAULT '[]',
      anchor_weights TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      template_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS template_edge_rules_src ON template_edge_rules (source_type_id, edge_type)`,
    `CREATE TABLE IF NOT EXISTS template_versions (
      version INTEGER PRIMARY KEY,
      changed_by TEXT NOT NULL,
      change_summary TEXT NOT NULL,
      changed_at TEXT NOT NULL DEFAULT now()
    )`,
```

（按该段既有语句的拼接方式融入，保持同一 `exec`/数组风格。）

- [ ] **Step 5: drizzle 表——`schema.ts` 末尾（graph_links 表定义之后）追加**

```ts
/** 模板类型注册表(spec 2026-08-26 §3.1): 全局本体, 无 user_id。 */
export const templateTypes = sqliteTable('template_types', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  name: text('name').notNull(),
  parentId: text('parent_id'),
  props: text('props').notNull().default('{}'),
  isActive: integer('is_active').notNull().default(1),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (t) => [
  uniqueIndex('template_types_kind_name_uq').on(t.kind, t.name),
  index('template_types_parent').on(t.parentId),
]);

/** 模板边规则(spec 2026-08-26 §3.2): target_type_id='' 通配任意合同类型。 */
export const templateEdgeRules = sqliteTable('template_edge_rules', {
  id: text('id').primaryKey(),
  sourceTypeId: text('source_type_id').notNull(),
  targetTypeId: text('target_type_id').notNull().default(''),
  edgeType: text('edge_type').notNull(),
  allowedVocab: text('allowed_vocab').notNull().default('[]'),
  anchorWeights: text('anchor_weights'),
  isActive: integer('is_active').notNull().default(1),
  templateVersion: integer('template_version').notNull().default(1),
  createdAt: text('created_at').notNull(),
}, (t) => [
  index('template_edge_rules_src').on(t.sourceTypeId, t.edgeType),
]);

/** 模板版本审计(spec 2026-08-26 §3.3)。 */
export const templateVersions = sqliteTable('template_versions', {
  version: integer('version').primaryKey(),
  changedBy: text('changed_by').notNull(),
  changeSummary: text('change_summary').notNull(),
  changedAt: text('changed_at').notNull(),
});
```

`postgres-schema.ts` 镜像同构（`pgTable`，对照 graph_links 的 pg 版写法，列名相同）。`client.ts` 顶部 import 与 `createDb` 的 schema 映射补上三表。

- [ ] **Step 6: 跑测试确认通过 + 全量回归**

Run: `npm test --workspace apps/server -- test/pipeline/templateTables.test.ts && npm run build`
Expected: PASS + build 成功

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/pipeline/db/client.ts apps/server/src/pipeline/db/schema.ts apps/server/src/pipeline/db/postgres-schema.ts apps/server/test/pipeline/templateTables.test.ts
git commit -m "feat(template): 模板三表 DDL与drizzle schema(SQLite+PG)"
```

---

### Task 2: 模板仓储层（双后端）

**Files:**
- Modify: `apps/server/src/pipeline/db/repositories.ts`（末尾追加）
- Modify: `apps/server/src/pipeline/db/postgres-repositories.ts`（末尾追加）
- Test: `apps/server/test/pipeline/templateRepo.test.ts`

**Interfaces:**
- Produces（后续任务依赖的精确签名）:
  - `interface TemplateTypeRow { id: string; kind: 'doc_type'|'contract_type'; name: string; parentId: string | null; props: Record<string, unknown>; isActive: boolean; }`
  - `interface TemplateEdgeRuleRow { id: string; sourceTypeId: string; targetTypeId: string; edgeType: string; allowedVocab: string[]; anchorWeights: { party: number; time: number; amount: number; qty: number } | null; isActive: boolean; templateVersion: number; }`
  - `listTemplateTypes(ctx: DbContext): Promise<TemplateTypeRow[]>`
  - `findTemplateTypeByName(ctx: DbContext, kind: string, name: string): Promise<TemplateTypeRow | null>`
  - `listActiveEdgeRules(ctx: DbContext): Promise<TemplateEdgeRuleRow[]>`
  - `ensureTemplateType(ctx, input: { id: string; kind: string; name: string; parentId?: string | null }): Promise<void>` — 幂等（按 id INSERT OR IGNORE，已存在则仅更新 parent_id）
  - `ensureEdgeRule(ctx, input: { id: string; sourceTypeId: string; targetTypeId?: string; edgeType: string; allowedVocab: string[]; isActive?: boolean }): Promise<void>` — 幂等同上

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/test/pipeline/templateRepo.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, migrate } from '../../src/pipeline/db/client.js';
import {
  ensureEdgeRule, ensureTemplateType, findTemplateTypeByName,
  listActiveEdgeRules, listTemplateTypes,
} from '../../src/pipeline/db/repositories.js';

const ctx = createDb();
beforeEach(() => migrate(ctx.sqlite));

describe('template repo', () => {
  it('ensure 幂等: 重复灌入不报错不重复', async () => {
    await ensureTemplateType(ctx, { id: 'dt-发票', kind: 'doc_type', name: '发票' });
    await ensureTemplateType(ctx, { id: 'dt-发票', kind: 'doc_type', name: '发票' });
    const rows = await listTemplateTypes(ctx);
    expect(rows.filter((r) => r.name === '发票')).toHaveLength(1);
  });

  it('findTemplateTypeByName 精确命中', async () => {
    await ensureTemplateType(ctx, { id: 'ct-采购', kind: 'contract_type', name: '采购' });
    expect((await findTemplateTypeByName(ctx, 'contract_type', '采购'))?.id).toBe('ct-采购');
    expect(await findTemplateTypeByName(ctx, 'contract_type', '不存在')).toBeNull();
  });

  it('ensureEdgeRule 词表 JSON往返 + isActive 过滤', async () => {
    await ensureTemplateType(ctx, { id: 'dt-付款凭证', kind: 'doc_type', name: '付款凭证' });
    await ensureEdgeRule(ctx, { id: 'er-pay-settles', sourceTypeId: 'dt-付款凭证', edgeType: 'settles', allowedVocab: ['收款', '付款'] });
    await ensureEdgeRule(ctx, { id: 'er-inactive', sourceTypeId: 'dt-付款凭证', edgeType: 'binds', allowedVocab: ['凭证'], isActive: false });
    const rules = await listActiveEdgeRules(ctx);
    const pay = rules.find((r) => r.id === 'er-pay-settles');
    expect(pay?.allowedVocab).toEqual(['收款', '付款']);
    expect(rules.some((r) => r.id === 'er-inactive')).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/pipeline/templateRepo.test.ts`
Expected: FAIL（函数未导出）

- [ ] **Step 3: repositories.ts 末尾实现（SQLite 分支 + PG 分派）**

```ts
// ---- 模板层仓储(spec 2026-08-26 §3) ----------------------------------------
// 全局本体无 user_id, 与 graph_links 的按 user 隔离刻意不同。

export interface TemplateTypeRow {
  id: string; kind: 'doc_type' | 'contract_type'; name: string;
  parentId: string | null; props: Record<string, unknown>; isActive: boolean;
}
export interface TemplateAnchorWeights { party: number; time: number; amount: number; qty: number }
export interface TemplateEdgeRuleRow {
  id: string; sourceTypeId: string; targetTypeId: string; edgeType: string;
  allowedVocab: string[]; anchorWeights: TemplateAnchorWeights | null;
  isActive: boolean; templateVersion: number;
}

const TEMPLATE_TYPE_COLS = 'id, kind, name, parent_id, props, is_active';
const TEMPLATE_RULE_COLS = 'id, source_type_id, target_type_id, edge_type, allowed_vocab, anchor_weights, is_active, template_version';

function templateTypeFromRow(r: Record<string, unknown>): TemplateTypeRow {
  let props: Record<string, unknown> = {};
  try { props = JSON.parse(String(r.props ?? '{}')) as Record<string, unknown>; } catch { /* 损坏按空 */ }
  return {
    id: String(r.id), kind: (r.kind === 'contract_type' ? 'contract_type' : 'doc_type'),
    name: String(r.name), parentId: r.parent_id ? String(r.parent_id) : null,
    props, isActive: Number(r.is_active) === 1,
  };
}

function templateRuleFromRow(r: Record<string, unknown>): TemplateEdgeRuleRow {
  let allowedVocab: string[] = [];
  try { allowedVocab = JSON.parse(String(r.allowed_vocab ?? '[]')) as string[]; } catch { /* 损坏按空 */ }
  let anchorWeights: TemplateAnchorWeights | null = null;
  if (r.anchor_weights) {
    try { anchorWeights = JSON.parse(String(r.anchor_weights)) as TemplateAnchorWeights; } catch { /* 忽略 */ }
  }
  return {
    id: String(r.id), sourceTypeId: String(r.source_type_id),
    targetTypeId: String(r.target_type_id ?? ''), edgeType: String(r.edge_type),
    allowedVocab, anchorWeights, isActive: Number(r.is_active) === 1,
    templateVersion: Number(r.template_version ?? 1),
  };
}

export async function listTemplateTypes(ctx: DbContext): Promise<TemplateTypeRow[]> {
  if (ctx.backend === 'postgres') return listTemplateTypesPg(ctx);
  const rows = ctx.sqlite.prepare(`SELECT ${TEMPLATE_TYPE_COLS} FROM template_types ORDER BY kind, name`).all() as Record<string, unknown>[];
  return rows.map(templateTypeFromRow);
}

export async function findTemplateTypeByName(ctx: DbContext, kind: string, name: string): Promise<TemplateTypeRow | null> {
  if (ctx.backend === 'postgres') return findTemplateTypeByNamePg(ctx, kind, name);
  const r = ctx.sqlite.prepare(
    `SELECT ${TEMPLATE_TYPE_COLS} FROM template_types WHERE kind = ? AND name = ?`,
  ).get(kind, name) as Record<string, unknown> | undefined;
  return r ? templateTypeFromRow(r) : null;
}

export async function listActiveEdgeRules(ctx: DbContext): Promise<TemplateEdgeRuleRow[]> {
  if (ctx.backend === 'postgres') return listActiveEdgeRulesPg(ctx);
  const rows = ctx.sqlite.prepare(
    `SELECT ${TEMPLATE_RULE_COLS} FROM template_edge_rules WHERE is_active = 1`,
  ).all() as Record<string, unknown>[];
  return rows.map(templateRuleFromRow);
}

export async function ensureTemplateType(
  ctx: DbContext, input: { id: string; kind: string; name: string; parentId?: string | null },
): Promise<void> {
  if (ctx.backend === 'postgres') return ensureTemplateTypePg(ctx, input);
  ctx.sqlite.prepare(
    `INSERT INTO template_types (id, kind, name, parent_id) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET parent_id = excluded.parent_id`,
  ).run(input.id, input.kind, input.name, input.parentId ?? null);
}

export async function ensureEdgeRule(
  ctx: DbContext, input: { id: string; sourceTypeId: string; targetTypeId?: string; edgeType: string; allowedVocab: string[]; isActive?: boolean },
): Promise<void> {
  if (ctx.backend === 'postgres') return ensureEdgeRulePg(ctx, input);
  ctx.sqlite.prepare(
    `INSERT INTO template_edge_rules (id, source_type_id, target_type_id, edge_type, allowed_vocab, is_active)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       target_type_id = excluded.target_type_id,
       allowed_vocab = excluded.allowed_vocab,
       is_active = excluded.is_active`,
  ).run(input.id, input.sourceTypeId, input.targetTypeId ?? '', input.edgeType,
    JSON.stringify(input.allowedVocab), input.isActive === false ? 0 : 1);
}
```

- [ ] **Step 4: postgres-repositories.ts 末尾实现 Pg 版**

```ts
// ---- 模板层仓储 Pg 版(列名与 SQLite 对齐) -----------------------------------
export async function listTemplateTypesPg(ctx: PostgresDbContext): Promise<TemplateTypeRow[]> {
  const { rows } = await ctx.pool.query(`SELECT id, kind, name, parent_id, props, is_active FROM template_types ORDER BY kind, name`);
  return rows.map((r: Record<string, unknown>) => ({
    id: String(r.id), kind: (r.kind === 'contract_type' ? 'contract_type' : 'doc_type'),
    name: String(r.name), parentId: r.parent_id ? String(r.parent_id) : null,
    props: typeof r.props === 'string' ? JSON.parse(r.props) as Record<string, unknown> : (r.props ?? {}),
    isActive: Number(r.is_active) === 1,
  }));
}

export async function findTemplateTypeByNamePg(ctx: PostgresDbContext, kind: string, name: string): Promise<TemplateTypeRow | null> {
  const { rows } = await ctx.pool.query(
    'SELECT id, kind, name, parent_id, props, is_active FROM template_types WHERE kind = $1 AND name = $2', [kind, name]);
  if (rows.length === 0) return null;
  const r = rows[0] as Record<string, unknown>;
  return {
    id: String(r.id), kind: (r.kind === 'contract_type' ? 'contract_type' : 'doc_type'),
    name: String(r.name), parentId: r.parent_id ? String(r.parent_id) : null,
    props: typeof r.props === 'string' ? JSON.parse(r.props) as Record<string, unknown> : (r.props ?? {}),
    isActive: Number(r.is_active) === 1,
  };
}

export async function listActiveEdgeRulesPg(ctx: PostgresDbContext): Promise<TemplateEdgeRuleRow[]> {
  const { rows } = await ctx.pool.query(
    'SELECT id, source_type_id, target_type_id, edge_type, allowed_vocab, anchor_weights, is_active, template_version FROM template_edge_rules WHERE is_active = 1');
  return rows.map((r: Record<string, unknown>) => ({
    id: String(r.id), sourceTypeId: String(r.source_type_id),
    targetTypeId: String(r.target_type_id ?? ''), edgeType: String(r.edge_type),
    allowedVocab: typeof r.allowed_vocab === 'string' ? JSON.parse(r.allowed_vocab) as string[] : (r.allowed_vocab ?? []),
    anchorWeights: r.anchor_weights
      ? (typeof r.anchor_weights === 'string' ? JSON.parse(r.anchor_weights) as TemplateAnchorWeights : r.anchor_weights as TemplateAnchorWeights)
      : null,
    isActive: Number(r.is_active) === 1, templateVersion: Number(r.template_version ?? 1),
  }));
}

export async function ensureTemplateTypePg(
  ctx: PostgresDbContext, input: { id: string; kind: string; name: string; parentId?: string | null },
): Promise<void> {
  await ctx.pool.query(
    `INSERT INTO template_types (id, kind, name, parent_id) VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET parent_id = excluded.parent_id`,
    [input.id, input.kind, input.name, input.parentId ?? null]);
}

export async function ensureEdgeRulePg(
  ctx: PostgresDbContext, input: { id: string; sourceTypeId: string; targetTypeId?: string; edgeType: string; allowedVocab: string[]; isActive?: boolean },
): Promise<void> {
  await ctx.pool.query(
    `INSERT INTO template_edge_rules (id, source_type_id, target_type_id, edge_type, allowed_vocab, is_active)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO UPDATE SET
       target_type_id = excluded.target_type_id,
       allowed_vocab = excluded.allowed_vocab,
       is_active = excluded.is_active`,
    [input.id, input.sourceTypeId, input.targetTypeId ?? '', input.edgeType,
     JSON.stringify(input.allowedVocab), input.isActive === false ? 0 : 1]);
}
```

注意 Pg 版的类型从 repositories.ts export（`TemplateTypeRow` 等），postgres-repositories.ts 已有从 repositories 导入类型的先例——跟随该文件既有 import 风格；若该文件不 import repositories.ts（避免环），则把三个 interface 移到 `repositories.ts` 顶部已有类型区，Pg 文件用 `import type` 引入（`import type` 无运行时环）。

- [ ] **Step 5: 跑测试确认通过**

Run: `npm test --workspace apps/server -- test/pipeline/templateRepo.test.ts`
Expected: PASS（3 个用例）

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/pipeline/db/repositories.ts apps/server/src/pipeline/db/postgres-repositories.ts apps/server/test/pipeline/templateRepo.test.ts
git commit -m "feat(template): 模板仓储层双后端(list/find/ensure幂等)"
```

---

### Task 3: 种子加载 templateSeed.ts + 启动接线

**Files:**
- Create: `apps/server/src/pipeline/templateSeed.ts`
- Modify: `apps/server/src/index.ts`（migrateOnStartup 之后 ~line 177）
- Test: `apps/server/test/pipeline/templateSeed.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `ensureTemplateType/ensureEdgeRule/findTemplateTypeByName`。
- Produces: `ensureTemplateSeed(ctx: DbContext): Promise<void>`（幂等，可重复调用）；种子类型 id 约定 `dt-<名>` / `ct-<名>`，规则 id `er-<slug>`。

**语义来源（翻译映射，行为零变化）：**
- 分类八类：`classifier.ts:28` DOC_TYPES。
- 合同六类：`tradeSemantics.ts:67` contractTypes。
- binds 词表：`tradeSemantics.ts:60-66` bindingRelationByVoucherType（货转单→货权转移、付款凭证→付款、化验报告→质检、其他→凭证）+ 合同→引用（bindings.ts:298 提示语）。
- settles 六向：`executionFlow.ts:61-65` FLOW_TYPE_BY_DOC_TYPE + `tradeSemantics.ts:141-147` SETTLES_RELATION_BY_FLOW。
- executes（发票/提单/装箱单，tradeSemantics.ts:59）登记为 **is_active=0**（spec §3.2：登记不启用）。
- 兜底规则：任意 doc_type → 通配 target，binds [凭证]（保证现有全部合法组合继续通过守卫）。

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/test/pipeline/templateSeed.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, migrate } from '../../src/pipeline/db/client.js';
import { ensureTemplateSeed } from '../../src/pipeline/templateSeed.js';
import { listActiveEdgeRules, listTemplateTypes } from '../../src/pipeline/db/repositories.js';

const ctx = createDb();
beforeEach(() => migrate(ctx.sqlite));

describe('template seed', () => {
  it('种子含分类八类+合同六类+层级枢纽', async () => {
    await ensureTemplateSeed(ctx);
    const types = await listTemplateTypes(ctx);
    const names = (k: string) => types.filter((t) => t.kind === k).map((t) => t.name);
    for (const dt of ['合同', '发票', '提单', '装箱单', '货转单', '化验报告', '付款凭证', '其他', '履约凭证']) {
      expect(names('doc_type')).toContain(dt);
    }
    for (const ct of ['采购', '销售', '物流', '租赁', '服务', '其他', '买卖合同']) {
      expect(names('contract_type')).toContain(ct);
    }
    // 层级(v2 树): 发票 ⊂ 发票凭证 ⊂ 履约凭证; 采购 ⊂ 买卖合同
    const fapiao = types.find((t) => t.name === '发票')!;
    const fapiaoPiao = types.find((t) => t.name === '发票凭证')!;
    const lvyue = types.find((t) => t.name === '履约凭证')!;
    expect(fapiao.parentId).toBe(fapiaoPiao.id);
    expect(fapiaoPiao.parentId).toBe(lvyue.id);
    // v2 方向编码类型已登记
    expect(names('doc_type')).toContain('收货单');
    expect(names('doc_type')).toContain('销项票');
    const caigou = types.find((t) => t.name === '采购')!;
    const maimai = types.find((t) => t.name === '买卖合同')!;
    expect(caigou.parentId).toBe(maimai.id);
  });

  it('种子规则覆盖现状硬编码语义 + 兜底通配', async () => {
    await ensureTemplateSeed(ctx);
    const rules = await listActiveEdgeRules(ctx);
    const by = (srcName: string, edge: string) => {
      const types = rules; // rules 引用 sourceTypeId, 需要名字映射
      return types;
    };
    void by;
    const typeById = new Map((await listTemplateTypes(ctx)).map((t) => [t.id, t.name]));
    const vocabOf = (src: string, edge: string) =>
      rules.filter((r) => typeById.get(r.sourceTypeId) === src && r.edgeType === edge)
        .map((r) => ({ target: r.targetTypeId === '' ? '*' : typeById.get(r.targetTypeId), vocab: r.allowedVocab }));
    expect(vocabOf('货转单', 'binds')).toContainEqual({ target: '*', vocab: ['货权转移'] });
    expect(vocabOf('付款凭证', 'settles')).toContainEqual({ target: '*', vocab: ['收款', '付款'] });
    expect(vocabOf('发票', 'settles')).toContainEqual({ target: '*', vocab: ['收票', '开票'] });
    expect(vocabOf('其他', 'binds')).toContainEqual({ target: '*', vocab: ['凭证'] });
    // 兜底: 合同类型"其他"作 source? 不——兜底是任意 doc -> 通配。检查存在通配兜底:
    const fallback = rules.find((r) => r.edgeType === 'binds' && r.targetTypeId === '' && r.sourceTypeId === '');
    expect(fallback?.allowedVocab).toEqual(['凭证']);
  });

  it('幂等: 连续两次灌入行数不变', async () => {
    await ensureTemplateSeed(ctx);
    const a = (await listTemplateTypes(ctx)).length + (await listActiveEdgeRules(ctx)).length;
    await ensureTemplateSeed(ctx);
    const b = (await listTemplateTypes(ctx)).length + (await listActiveEdgeRules(ctx)).length;
    expect(b).toBe(a);
  });
});
```

注意：第三个断言要求兜底规则的 `source_type_id = ''`（源通配）——比 Task 2 interface 的语义多一种通配（source 也可为 ''）。种子直接用 `ensureEdgeRule({ id, sourceTypeId: '', ... })` 写入；仓储层不做外键约束，允许空串。

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/pipeline/templateSeed.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 templateSeed.ts**

```ts
// 模板层种子(spec 2026-08-26 §3): 现状硬编码语义的机械翻译, 行为零变化。
// 修改这些行 = 修改绑定协议, 需带测试走。Phase 2 起模板经 /api/templates 演化。
import type { DbContext } from './db/client.js';
import { ensureEdgeRule, ensureTemplateType } from './db/repositories.js';

/** doc_type 种子——类型划分 v2(spec 2026-08-26 §3.1, 业务确认 2026-08-26)。
 *  Phase 1 登记全树(类型是被动注册表, 不影响行为); 新类型的边规则登记不启用。
 *  旧 8 类全部保留(分类器仍在用, 行为零变化); 提单/装箱单挂货转单下待 Phase 2 并入;
 *  化验报告→质检报告更名, 旧名保留; 发票保留为发票凭证的合法粗类。 */
const DOC_TYPE_SEED: Array<{ name: string; parent?: string }> = [
  { name: '合同' },
  { name: '补充合同', parent: '合同' },
  { name: '立项书' },
  { name: '履约凭证' },
  { name: '货转单', parent: '履约凭证' },
  { name: '提单', parent: '货转单' },
  { name: '装箱单', parent: '货转单' },
  { name: '质检报告', parent: '履约凭证' },
  { name: '化验报告', parent: '质检报告' },
  { name: '结算单', parent: '履约凭证' },
  { name: '运输凭证', parent: '履约凭证' },
  { name: '收货单', parent: '运输凭证' },
  { name: '发货单', parent: '运输凭证' },
  { name: '汽运磅单', parent: '运输凭证' },
  { name: '火运大票', parent: '运输凭证' },
  { name: '派船通知单', parent: '运输凭证' },
  { name: '资金凭证', parent: '履约凭证' },
  { name: '付款单', parent: '资金凭证' },
  { name: '付款凭证', parent: '资金凭证' },
  { name: '发票凭证', parent: '履约凭证' },
  { name: '发票', parent: '发票凭证' },
  { name: '进项票', parent: '发票凭证' },
  { name: '销项票', parent: '发票凭证' },
  { name: '其他', parent: '履约凭证' },
];

/** contract_type 种子(六类 + 买卖合同层级枢纽)。 */
const CONTRACT_TYPE_SEED: Array<{ name: string; parent?: string }> = [
  { name: '买卖合同' },
  { name: '采购', parent: '买卖合同' },
  { name: '销售', parent: '买卖合同' },
  { name: '物流' }, { name: '租赁' }, { name: '服务' }, { name: '其他' },
];

/** 边规则种子。src='' 源通配, tgt='' 目标通配。语义来源注释指向被翻译的硬编码。 */
const EDGE_RULE_SEED: Array<{
  id: string; src: string; tgt?: string; edge: string; vocab: string[]; active?: boolean;
}> = [
  // binds 词表 <- tradeSemantics.bindingRelationByVoucherType
  { id: 'er-bind-huozhuan', src: '货转单', edge: 'binds', vocab: ['货权转移'] },
  { id: 'er-bind-fukuan', src: '付款凭证', edge: 'binds', vocab: ['付款'] },
  { id: 'er-bind-huayan', src: '化验报告', edge: 'binds', vocab: ['质检'] },
  { id: 'er-bind-hetong', src: '合同', edge: 'binds', vocab: ['引用'] },
  { id: 'er-bind-qita', src: '其他', edge: 'binds', vocab: ['凭证'] },
  // settles 六向 <- executionFlow.FLOW_TYPE_BY_DOC_TYPE x tradeSemantics.SETTLES_RELATION_BY_FLOW
  { id: 'er-settle-fukuan', src: '付款凭证', edge: 'settles', vocab: ['收款', '付款'] },
  { id: 'er-settle-huozhuan', src: '货转单', edge: 'settles', vocab: ['收货', '发货'] },
  { id: 'er-settle-fapiao', src: '发票', edge: 'settles', vocab: ['收票', '开票'] },
  // 兜底(spec §3.2): 任意 -> 任意, 保证现状全部合法组合继续通过守卫
  { id: 'er-bind-fallback', src: '', edge: 'binds', vocab: ['凭证'] },
  // 登记不启用(spec §3.2 Phase 1 校验范围): executes <- tradeSemantics.executesDocTypes
  { id: 'er-exec-fapiao', src: '发票', edge: 'executes', vocab: [], active: false },
  { id: 'er-exec-tidan', src: '提单', edge: 'executes', vocab: [], active: false },
  { id: 'er-exec-zhuangxiang', src: '装箱单', edge: 'executes', vocab: [], active: false },
  // ---- v2 类型划分(spec 2026-08-26 §3.1): 登记+激活节奏见 spec Phase 2, 全部 active:false ----
  // 方向编码类型(spec v2): settles 方向由类型自带, 与 flowType×direction 派生交叉验证
  { id: 'er-settle-shouhuo', src: '收货单', edge: 'settles', vocab: ['收货'], active: false },
  { id: 'er-settle-fahuodan', src: '发货单', edge: 'settles', vocab: ['发货'], active: false },
  { id: 'er-settle-jinxiang', src: '进项票', edge: 'settles', vocab: ['收票'], active: false },
  { id: 'er-settle-xiaoxiang', src: '销项票', edge: 'settles', vocab: ['开票'], active: false },
  // 付款单(申请单, 付款前): 登记不启用——不物化资金流(它不是支付证据)
  { id: 'er-bind-fukuandan', src: '付款单', edge: 'binds', vocab: ['付款申请'], active: false },
  // 结算单: 合同级结算凭证
  { id: 'er-bind-jiesuan', src: '结算单', edge: 'binds', vocab: ['结算'], active: false },
  // 质检报告(化验报告更名目标): 词表对齐旧 化验报告
  { id: 'er-bind-zhijian', src: '质检报告', edge: 'binds', vocab: ['质检'], active: false },
  // 补充合同: amends 修订关系(新边类型, Phase 2 激活 L2 工具)
  { id: 'er-amend-buchong', src: '补充合同', edge: 'amends', vocab: [], active: false },
  // 立项书: binds 终点泛化到 Project(spec Phase 2 开绑定路径)
  { id: 'er-bind-lixiang', src: '立项书', edge: 'binds', vocab: ['立项'], active: false },
];

/** 幂等灌入: 表空或部分存在都可重入(ensure* 均为 upsert)。 */
export async function ensureTemplateSeed(ctx: DbContext): Promise<void> {
  const typeId = (kind: 'dt' | 'ct', name: string) => `${kind}-${name}`;
  for (const t of DOC_TYPE_SEED) {
    await ensureTemplateType(ctx, {
      id: typeId('dt', t.name), kind: 'doc_type', name: t.name,
      parentId: t.parent ? typeId('dt', t.parent) : null,
    });
  }
  for (const t of CONTRACT_TYPE_SEED) {
    await ensureTemplateType(ctx, {
      id: typeId('ct', t.name), kind: 'contract_type', name: t.name,
      parentId: t.parent ? typeId('ct', t.parent) : null,
    });
  }
  for (const r of EDGE_RULE_SEED) {
    await ensureEdgeRule(ctx, {
      id: r.id,
      sourceTypeId: r.src ? typeId('dt', r.src) : '',
      targetTypeId: r.tgt ? typeId('ct', r.tgt) : '',
      edgeType: r.edge, allowedVocab: r.vocab, isActive: r.active !== false,
    });
  }
}
```

- [ ] **Step 4: index.ts 接线（~line 177 `await migrateOnStartup();` 之后）**

```ts
  // 模板层种子(幂等): 模板三表 DDL 后灌入, 失败仅告警不阻塞启动。
  try {
    await ensureTemplateSeed(getDbContext());
  } catch (e) {
    console.warn('[templateSeed] 模板种子灌入失败(不阻塞启动):', (e as Error).message);
  }
```

（import 加 `ensureTemplateSeed`；确认 `getDbContext` 在该作用域已可用——index.ts:29 已 import。）

- [ ] **Step 5: 跑测试确认通过 + 全量回归**

Run: `npm test --workspace apps/server -- test/pipeline/templateSeed.test.ts && npm run build`
Expected: PASS + build 成功

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/pipeline/templateSeed.ts apps/server/src/index.ts apps/server/test/pipeline/templateSeed.test.ts
git commit -m "feat(template): 种子加载(4处硬编码语义机械翻译)+启动接线"
```

---

### Task 4: templateGuard（继承匹配 + validateEdge）

**Files:**
- Create: `apps/server/src/pipeline/templateGuard.ts`
- Test: `apps/server/test/pipeline/templateGuard.test.ts`

**Interfaces:**
- Consumes: Task 2/3 的 `listTemplateTypes/listActiveEdgeRules`、种子。
- Produces:
  - `export interface GuardResult { ok: true; ruleId: string; templateVersion: number; relationInVocab: boolean | null } | { ok: false; reason: string }`
  - `export function ancestorChain(startId: string | null, byId: Map<string, TemplateTypeRow>): string[]` — 自环安全（visited 集）
  - `export function matchEdgeRule(params: { rules: TemplateEdgeRuleRow[]; sourceChain: string[]; targetChain: string[]; edgeType: string }): TemplateEdgeRuleRow | null` — 最具体优先：源链深度浅者优先（精确>祖先>通配''），同深度非通配 target 优先于通配
  - `export async function validateEdge(ctx: DbContext, input: { docType: string; contractType?: string | null; edgeType: string; relation?: string }): Promise<GuardResult>`

**校验语义（Phase 1，spec §4.3）：**
1. docType 未登记 → `{ ok: true, ruleId: 'passthrough', templateVersion: 0, relationInVocab: null }`（legacy 兼容，行为零变化）。
2. 无激活规则匹配（源链+目标链均不命中且无源通配兜底）→ `{ ok: false, reason: '单据类型「X」不允许绑定到「Y」类合同（无激活模板规则）' }`。
3. relation 不在 allowed_vocab → **软校验**：`{ ok: true, ..., relationInVocab: false }`（Phase 1 不阻断自由文本；前端计划切换后改硬校验）。
4. edgeType 非 binds/settles → 放行 passthrough（Phase 1 守卫范围仅此两种）。

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/test/pipeline/templateGuard.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, migrate } from '../../src/pipeline/db/client.js';
import { ensureTemplateSeed } from '../../src/pipeline/templateSeed.js';
import {
  ensureEdgeRule, ensureTemplateType, listActiveEdgeRules, listTemplateTypes,
} from '../../src/pipeline/db/repositories.js';
import { ancestorChain, matchEdgeRule, validateEdge } from '../../src/pipeline/templateGuard.js';

const ctx = createDb();
beforeEach(async () => {
  migrate(ctx.sqlite);
  await ensureTemplateSeed(ctx);
});

describe('ancestorChain', () => {
  it('发票 -> 履约凭证 两级链', async () => {
    const types = await listTemplateTypes(ctx);
    const byId = new Map(types.map((t) => [t.id, t]));
    const fapiao = types.find((t) => t.name === '发票')!;
    expect(ancestorChain(fapiao.id, byId)).toHaveLength(2);
  });
  it('环安全: A->B->A 不死循环', async () => {
    await ensureTemplateType(ctx, { id: 'dt-A', kind: 'doc_type', name: 'A' });
    await ensureTemplateType(ctx, { id: 'dt-B', kind: 'doc_type', name: 'B', parentId: 'dt-A' });
    const db = ctx.sqlite;
    db.prepare("UPDATE template_types SET parent_id = 'dt-B' WHERE id = 'dt-A'").run();
    const types = await listTemplateTypes(ctx);
    const byId = new Map(types.map((t) => [t.id, t]));
    const chain = ancestorChain('dt-A', byId);
    expect(chain.length).toBeLessThanOrEqual(2);
  });
});

describe('matchEdgeRule 最具体优先', () => {
  it('子类型覆盖 > 通配兜底', async () => {
    // 铁路运单 ⊂ 履约凭证, 自身无规则 -> 命中通配兜底 er-bind-fallback
    await ensureTemplateType(ctx, { id: 'dt-铁路运单', kind: 'doc_type', name: '铁路运单', parentId: 'dt-履约凭证' });
    const types = await listTemplateTypes(ctx);
    const rules = await listActiveEdgeRules(ctx);
    const byId = new Map(types.map((t) => [t.id, t]));
    const chain = ancestorChain('dt-铁路运单', byId);
    const rule = matchEdgeRule({ rules, sourceChain: chain, targetChain: [''], edgeType: 'binds' });
    expect(rule?.id).toBe('er-bind-fallback');
  });
  it('精确规则优先于通配: 付款凭证 settles', async () => {
    const rules = await listActiveEdgeRules(ctx);
    const types = await listTemplateTypes(ctx);
    const byId = new Map(types.map((t) => [t.id, t]));
    const chain = ancestorChain(byId.get('dt-付款凭证')!.id, byId);
    const rule = matchEdgeRule({ rules, sourceChain: chain, targetChain: [''], edgeType: 'settles' });
    expect(rule?.id).toBe('er-settle-fukuan');
  });
});

describe('validateEdge', () => {
  it('未知 docType 放行(passthrough)', async () => {
    const r = await validateEdge(ctx, { docType: '神秘单据', edgeType: 'binds' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ruleId).toBe('passthrough');
  });
  it('付款凭证 binds 任意合同: 通过, relation 付款在词表内', async () => {
    const r = await validateEdge(ctx, { docType: '付款凭证', contractType: '采购', edgeType: 'binds', relation: '付款' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.relationInVocab).toBe(true);
  });
  it('自由文本 relation 软校验: 通过但 relationInVocab=false', async () => {
    const r = await validateEdge(ctx, { docType: '付款凭证', edgeType: 'binds', relation: '运费分摊' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.relationInVocab).toBe(false);
  });
  it('合同类型显式排除场景: 禁用规则后无兜底才拒绝', async () => {
    // 现种子有源通配兜底, 一切已登记 docType 都过; 验证无兜底路径:
    ctx.sqlite.prepare("UPDATE template_edge_rules SET is_active = 0 WHERE id = 'er-bind-fallback'").run();
    ctx.sqlite.prepare("UPDATE template_edge_rules SET is_active = 0 WHERE id LIKE 'er-bind-%'").run();
    const r = await validateEdge(ctx, { docType: '化验报告', contractType: '采购', edgeType: 'binds' });
    expect(r.ok).toBe(false);
  });
  it('非守卫范围 edgeType 放行', async () => {
    const r = await validateEdge(ctx, { docType: '发票', edgeType: 'party' });
    expect(r.ok).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/pipeline/templateGuard.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 templateGuard.ts**

```ts
// 模板守卫(spec 2026-08-26 §4.3): 绑定写入前的类型兼容性校验。
// Phase 1: 硬校验 (docType, contractType, edgeType) 组合; relation 词表软校验。
// 未登记 docType 一律放行(legacy 兼容, 行为零变化基线)。
import type { DbContext } from './db/client.js';
import {
  listActiveEdgeRules, listTemplateTypes,
  type TemplateEdgeRuleRow, type TemplateTypeRow,
} from './db/repositories.js';

export type GuardResult =
  | { ok: true; ruleId: string; templateVersion: number; relationInVocab: boolean | null }
  | { ok: false; reason: string };

const GUARDED_EDGE_TYPES = new Set(['binds', 'settles']);

/** 自底向上祖先链(含自身), visited 集环安全。startId null 返回空链。 */
export function ancestorChain(startId: string | null, byId: Map<string, TemplateTypeRow>): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let cur = startId ? byId.get(startId) : undefined;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.push(cur.id);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return chain;
}

/**
 * 最具体优先匹配。specificity = 源链命中位置(0=精确) + 目标通配惩罚;
 * 源通配规则('' 在 sourceTypeId)排最后。
 */
export function matchEdgeRule(params: {
  rules: TemplateEdgeRuleRow[];
  sourceChain: string[];
  targetChain: string[];
  edgeType: string;
}): TemplateEdgeRuleRow | null {
  let best: TemplateEdgeRuleRow | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const r of params.rules) {
    if (r.edgeType !== params.edgeType) continue;
    const srcIdx = r.sourceTypeId === '' ? params.sourceChain.length : params.sourceChain.indexOf(r.sourceTypeId);
    if (srcIdx === -1 || r.sourceTypeId === '') {
      if (r.sourceTypeId !== '') continue; // 未命中源链
    }
    const srcIsWildcard = r.sourceTypeId === '';
    const tgtIdx = r.targetTypeId === '' ? params.targetChain.length : params.targetChain.indexOf(r.targetTypeId);
    if (tgtIdx === -1) continue; // 目标未命中且非通配
    const tgtIsWildcard = r.targetTypeId === '';
    // 分数: 源精确度 + 目标精确度; 通配源最泛。
    const score = (srcIsWildcard ? params.sourceChain.length + 1 : srcIdx) + (tgtIsWildcard ? params.targetChain.length : tgtIdx);
    if (score < bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return best;
}

export async function validateEdge(
  ctx: DbContext,
  input: { docType: string; contractType?: string | null; edgeType: string; relation?: string },
): Promise<GuardResult> {
  if (!GUARDED_EDGE_TYPES.has(input.edgeType)) {
    return { ok: true, ruleId: 'unguarded', templateVersion: 0, relationInVocab: null };
  }
  const [types, rules] = await Promise.all([listTemplateTypes(ctx), listActiveEdgeRules(ctx)]);
  const byId = new Map(types.map((t) => [t.id, t]));
  const sourceChain = ancestorChain(byId.get(`dt-${input.docType}`)?.id ?? null, byId);
  const registered = byId.has(`dt-${input.docType}`);
  // 未登记 docType: legacy 兼容放行(行为零变化)。
  if (!registered && sourceChain.length === 0) {
    return { ok: true, ruleId: 'passthrough', templateVersion: 0, relationInVocab: null };
  }
  const targetChain = input.contractType
    ? ancestorChain(byId.get(`ct-${input.contractType}`)?.id ?? null, byId)
    : [''];
  const rule = matchEdgeRule({ rules, sourceChain, targetChain: targetChain.length > 0 ? targetChain : [''], edgeType: input.edgeType });
  if (!rule) {
    return {
      ok: false,
      reason: `单据类型「${input.docType}」不允许建立 ${input.edgeType} 关系到「${input.contractType ?? '未知'}」类型合同（无激活模板规则）`,
    };
  }
  const relationInVocab = input.relation
    ? (rule.allowedVocab.length === 0 ? null : rule.allowedVocab.includes(input.relation))
    : null;
  return { ok: true, ruleId: rule.id, templateVersion: rule.templateVersion, relationInVocab };
}
```

（`dt-`/`ct-` 前缀 id 约定与 Task 3 种子一致；`registered` 判断修正为：`byId.has('dt-' + input.docType)` 为 false 时直接 passthrough——实现时以测试为准调整这两行的冗余。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test --workspace apps/server -- test/pipeline/templateGuard.test.ts`
Expected: PASS（全部用例）

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/pipeline/templateGuard.ts apps/server/test/pipeline/templateGuard.test.ts
git commit -m "feat(template): templateGuard 继承匹配+validateEdge(类型硬校验/词表软校验)"
```

---

### Task 5: bindingProposal 锚点权重参数化

**Files:**
- Modify: `apps/server/src/pipeline/bindingProposal.ts:368-445`
- Test: `apps/server/test/pipeline/bindingProposalWeights.test.ts`

**Interfaces:**
- Produces: `export interface AnchorWeights { party: number; time: number; amount: number; qty: number }`；`generateBindingProposals(anchors, ledgerEntries, weights?: AnchorWeights)` 第三参缺省 `WEIGHTS`（现值 { party: 0.5, time: 0.25, amount: 0.15, qty: 0.1 } 不变）。
- T7 的 context API 将从 edge rule 的 `anchorWeights` 读出传入。

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/test/pipeline/bindingProposalWeights.test.ts
import { describe, expect, it } from 'vitest';
import { generateBindingProposals } from '../../src/pipeline/bindingProposal.js';

const anchors = { buyer: 'A公司', seller: 'B公司', date: '2026-01-10', amount: 100 };
const ledger = [
  { contractNo: 'HT-1', fields: { 买方: 'A公司', 卖方: 'B公司', 签订日期: '2026-01-10', 合同金额: 100 } },
  { contractNo: 'HT-2', fields: { 买方: 'A公司', 卖方: 'C公司', 签订日期: '2025-12-01', 合同金额: 500 } },
];

describe('generateBindingProposals weights', () => {
  it('缺省权重: 行为不变(top1=HT-1, route=human)', () => {
    const r = generateBindingProposals(anchors as never, ledger as never);
    expect(r[0]?.contractNo).toBe('HT-1');
    expect(r[0]?.route).toBe('human');
  });
  it('金额权重调高后 HT-2(金额500)反超', () => {
    const r = generateBindingProposals(anchors as never, ledger as never, { party: 0.2, time: 0.1, amount: 0.7, qty: 0 });
    expect(r[0]?.contractNo).toBe('HT-2');
  });
});
```

（anchors/ledger 的字段形状以 `bindingProposal.ts` 的 `VoucherAnchors/LedgerEntryLike` 实际定义为准——实现时若字段名不符，按真实类型修测试夹具，断言不变。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/pipeline/bindingProposalWeights.test.ts`
Expected: FAIL（第三参不存在，TS 编译/运行报错或第二断言不成立）

- [ ] **Step 3: 实现——bindingProposal.ts:368 起**

```ts
export interface AnchorWeights { party: number; time: number; amount: number; qty: number }

const WEIGHTS: AnchorWeights = { party: 0.5, time: 0.25, amount: 0.15, qty: 0.1 } as const;
```

`generateBindingProposals` 签名加第三参 `weights: AnchorWeights = WEIGHTS`，函数体内 `WEIGHTS.party` 等四处替换为 `weights.party`（:418-422）。其余不动（auto_rule 分支、阈值、排序不变）。

- [ ] **Step 4: 跑新测试 + 全量回归**

Run: `npm test --workspace apps/server -- test/pipeline/bindingProposalWeights.test.ts && npm test`
Expected: 全 PASS（行为零变化验证点）

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/pipeline/bindingProposal.ts apps/server/test/pipeline/bindingProposalWeights.test.ts
git commit -m "feat(template): 绑定评分锚点权重参数化(缺省行为不变)"
```

---

### Task 6: bindings 路由门禁 + templateVersion 落边

**Files:**
- Modify: `apps/server/src/routes/bindings.ts`（confirmOne :213-239 与 POST / :270-325）
- Modify: `apps/server/src/pipeline/bindingGraphSync.ts`（syncBindingEdge input 加 `templateVersion?: number`，props 透传）
- Test: `apps/server/test/routes/bindingsGuard.test.ts`

**Interfaces:**
- Consumes: Task 4 `validateEdge`；`findContractLedgerByNo(ctx, contractNo)`（repositories.ts:1914，返回行含合同类型字段——用其返回类型推断 contractType，字段名以实际为准，PG 版 findContractLedgerByNoPg:1542 同）；`getDocumentMeta(db, docId, userId)`（bindings.ts 已用）。
- Produces: confirm/create 拒绝响应 `{ error: <可读原因>, guard: 'template' }` 状态码 409；成功时 binds 边 props 多 `templateVersion`。

**门禁放置（两处，语义相同）：**
- `confirmOne`：在 `updateBindingStatus` **之前**校验（proposed 行放行前拦截，避免状态机半途拒绝）。
- `POST /`：在业务顺序门禁（:291-302 hasContractDocBinding）**之后**、`saveBinding` 之前校验（先满足现有顺序门禁，再加模板门禁）。
- 校验入参：`docType` = 文档 meta（getDocumentMeta，缺省 null→放行 passthrough）；`contractType` = 台账行的合同类型（无台账行/无类型 → undefined → 目标链按通配兜底）；`edgeType: 'binds'`；`relation` = 行内 relation（软校验仅日志，不阻断）。
- 后台同步（syncSettlesAfterFlow / executionFlow 派生 settles）**本任务不改**——路由层已拦住非法组合，settles 派生只处理已过门禁的绑定；spec 的 sync 层防御留待 Phase 2 规则全启用时统一接。

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/test/routes/bindingsGuard.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, migrate } from '../../src/pipeline/db/client.js';
import { ensureTemplateSeed } from '../../src/pipeline/templateSeed.js';
// 按仓库既有 route 测试的 app/ctx 注入方式构造 Hono app(参照 test/routes/ 现有
// bindings 或 review 测试的 setup)。此处以直接调 confirmOne 等价路径为例:
// 若 confirmOne 未导出, 通过 POST /api/bindings/confirm + POST /api/bindings 走
// supertest/fetch 风格(以现有 route 测试文件为模板)。

const ctx = createDb();
beforeEach(async () => {
  migrate(ctx.sqlite);
  await ensureTemplateSeed(ctx);
});

describe('bindings template guard', () => {
  it('禁用全部 binds 规则后, create 绑定被 409 拒绝且原因可读', async () => {
    ctx.sqlite.prepare("UPDATE template_edge_rules SET is_active = 0 WHERE edge_type = 'binds'").run();
    // ...构造 document(docType=化验报告) + ledger(采购合同), POST /api/bindings
    // expect res.status === 409, body.error 含 '不允许' 且 body.guard === 'template'
  });
  it('种子兜底在位时, 现有合法组合照常通过(行为零变化)', async () => {
    // ...同上夹具但不禁用规则: POST /api/bindings 成功, 绑定行落库
  });
  it('成功绑定的 binds 边带 templateVersion(经 io 注入断言)', async () => {
    // ...用可注入 io 捕获 mergeEdge props(参照 bindingGraphSync 测试模式)
    // expect props.templateVersion >= 1
  });
});
```

（三个用例的 app 构造与夹具：**以 `apps/server/test/routes/` 下现有 bindings/review 测试文件为模板**——实现者先读一个现有 route 测试照抄其 `createDb+app+auth` 脚手架，再把上面的断言填入。断言目标不变：409+guard 字段 / 兜底放行 / templateVersion 落边。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/routes/bindingsGuard.test.ts`
Expected: FAIL（无门禁，409 用例拿到 200）

- [ ] **Step 3: 实现——bindings.ts**

顶部 import 增加 `validateEdge`（from `../pipeline/templateGuard.js`）与 `findContractLedgerByNo`（若未引入）。新增内部辅助：

```ts
/** 模板门禁(spec 2026-08-26 §4.1/§4.3): 绑定落库前校验类型组合。
 *  文档 meta 缺失(已删)或 docType 未登记 -> passthrough(行为零变化)。
 *  relation 软校验: 词表外仅 console.warn, Phase 2 转硬。 */
async function templateGate(
  db: DbContext, userId: string,
  input: { documentId: string; contractNo: string },
): Promise<{ ok: true; templateVersion: number | null } | { ok: false; reason: string }> {
  let meta: Awaited<ReturnType<typeof getDocumentMeta>> = null;
  try { meta = await getDocumentMeta(db, input.documentId, userId); } catch { /* 缺 meta 放行 */ }
  if (!meta?.docType) return { ok: true, templateVersion: null };
  let contractType: string | null | undefined;
  try {
    const ledgerRow = await findContractLedgerByNo(db, input.contractNo);
    contractType = ledgerRow?.contractType ?? null;
  } catch { contractType = null; }
  const g = await validateEdge(db, { docType: meta.docType, contractType, edgeType: 'binds' });
  if (!g.ok) return { ok: false, reason: g.reason };
  if (g.relationInVocab === false) {
    console.warn(`[templateGuard] relation 在词表外(软校验, 不阻断): doc=${input.documentId} contract=${input.contractNo}`);
  }
  return { ok: true, templateVersion: g.templateVersion > 0 ? g.templateVersion : null };
}
```

（`ledgerRow?.contractType`——若台账行类型字段名不同（如 `contract_type`/`kind`），以 `findContractLedgerByNo` 返回类型为准替换。）

`confirmOne` 在 `:217 updateBindingStatus` 前插入：

```ts
  const gate = await templateGate(db, userId, { documentId: row.documentId, contractNo: row.contractNo });
  if (!gate.ok) {
    return { status: 409 as const, body: { error: gate.reason, guard: 'template' as const, bindingId } };
  }
```

`POST /` 在顺序门禁块（:302 `}` 之后）、`saveBinding` 之前插入同款（返回 `c.json({ error: gate.reason, guard: 'template' }, 409)`）。成功路径把 `gate.templateVersion` 传入 `syncBindingEdgeWithMeta` 的 input（confirmOne :232-235 与 POST / :321 两处的调用加字段）。

- [ ] **Step 4: bindingGraphSync.ts 透传 templateVersion**

`syncBindingEdge` input 类型加 `templateVersion?: number`；`:66 props` 对象追加 `...(input.templateVersion ? { templateVersion: input.templateVersion } : {})`。`syncBindingEdgeWithMeta`（bindings.ts:152-168）input 加可选字段并透传。

- [ ] **Step 5: 跑新测试 + 全量回归 + build**

Run: `npm test --workspace apps/server -- test/routes/bindingsGuard.test.ts && npm run build && npm test`
Expected: 全 PASS（兜底放行用例 = 行为零变化验证点）

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/routes/bindings.ts apps/server/src/pipeline/bindingGraphSync.ts apps/server/test/routes/bindingsGuard.test.ts
git commit -m "feat(template): 绑定确认/创建模板门禁+binds边落templateVersion"
```

---

### Task 7: /api/templates/context 工作台上下文 API

**Files:**
- Create: `apps/server/src/routes/templates.ts`
- Modify: `apps/server/src/index.ts`（挂载 `/api/templates`，requireAuth）
- Test: `apps/server/test/routes/templatesContext.test.ts`

**Interfaces:**
- Consumes: `listTemplateTypes/listActiveEdgeRules`（Task 2）、`ancestorChain/matchEdgeRule`（Task 4）、`getDocumentMeta`、`listProjects(ctx, userId?)` + `listMembershipsByProject(ctx, code, userId?, status?)`（projects.ts:9 已用）、`listContractLedgerEntries(ctx, ...)`、`bindingRelationFor(voucherType)`（tradeSemantics.ts:88）。
- Produces: `GET /api/templates/context?documentId=xxx` 响应（前端双下拉计划的唯一数据源）：

```ts
{
  documentId: string;
  docType: string;
  typeChain: string[];              // ['发票', '履约凭证'] 自底向上
  bindsRelation: string;            // bindingRelationFor(docType) 派生词(兜底'凭证')
  settlesVocab: string[] | null;    // null=该类型无 settles 规则(不物化流水)
  allowedContractTypes: string[];   // 激活 binds 规则可达的合同类型名(通配=全部六类)
  projects: Array<{
    code: string; name: string;
    contracts: Array<{ contractNo: string; contractType: string | null; allowed: boolean }>;
  }>;
  unassignedContracts: Array<{ contractNo: string; contractType: string | null; allowed: boolean }>; // 未挂项目的台账合同
}
```

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/test/routes/templatesContext.test.ts
// 脚手架照抄 test/routes/ 现有测试(createDb+migrate+ensureTemplateSeed+app)。
describe('GET /api/templates/context', () => {
  it('返回类型链+派生词+项目合同树', async () => {
    // 夹具: documents 行(docType=发票)、ledger 两合同(HT-A 采购/HT-B 销售)、
    // project P1 + confirmed membership(HT-A)。
    // GET /api/templates/context?documentId=...
    // expect body.typeChain = ['发票', '履约凭证']
    // expect body.bindsRelation = '凭证'            // 发票不在 bindingRelationByVoucherType -> fallback
    // expect body.settlesVocab = ['收票', '开票']
    // expect body.allowedContractTypes 含 '采购' 和 '销售'   // 通配兜底 -> 全部六类
    // expect body.projects[0].contracts[0].contractNo = 'HT-A'
    // expect body.unassignedContracts 含 HT-B
  });
  it('付款凭证: bindsRelation=付款, settlesVocab=[收款,付款]', async () => { /* 同上断言 */ });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/routes/templatesContext.test.ts`
Expected: FAIL（404，路由不存在）

- [ ] **Step 3: 实现 routes/templates.ts**

```ts
// 模板上下文 API(spec 2026-08-26 §4.1): 绑定工作台双下拉的数据源。
import { Hono } from 'hono';
import { getDbContext } from '../pipeline/db/dbBackend.js';
import {
  listActiveEdgeRules, listContractLedgerEntries, listTemplateTypes,
} from '../pipeline/db/repositories.js';
import { listMembershipsByProject, listProjects } from '../pipeline/db/repositories.js';
import { getDocumentMeta } from '../pipeline/db/repositories.js';
import { ancestorChain, matchEdgeRule } from '../pipeline/templateGuard.js';
import { bindingRelationFor } from '../domain/tradeSemantics.js';
import type { VoucherType } from '../pipeline/schemas/vouchers.js';

export const templatesRoute = new Hono();

const CONTRACT_TYPE_NAMES = ['采购', '销售', '物流', '租赁', '服务', '其他'];

templatesRoute.get('/context', async (c) => {
  const user = c.get('user')!;
  const documentId = c.req.query('documentId');
  if (!documentId) return c.json({ error: 'documentId 必填' }, 400);
  const ctx = getDbContext();

  const meta = await getDocumentMeta(ctx, documentId, user.id);
  if (!meta) return c.json({ error: 'document not found' }, 404);
  const docType = meta.docType;

  const [types, rules, projects, ledger] = await Promise.all([
    listTemplateTypes(ctx),
    listActiveEdgeRules(ctx),
    listProjects(ctx, user.id),
    listContractLedgerEntries(ctx, user.id),
  ]);
  const byId = new Map(types.map((t) => [t.id, t]));
  const nameOf = (id: string) => byId.get(id)?.name ?? null;

  const docTypeId = byId.get(`dt-${docType}`)?.id ?? null;
  const sourceChain = ancestorChain(docTypeId, byId);
  const typeChain = sourceChain.map((id) => nameOf(id)!).filter(Boolean);

  // binds 派生词: 现状 bindingRelationFor 语义(docType 不在映射 -> fallback)。
  const bindsRelation = bindingRelationFor(docType as VoucherType);

  // settles 词表: 匹配激活 settles 规则。
  const settlesRule = matchEdgeRule({ rules, sourceChain, targetChain: [''], edgeType: 'settles' });
  const settlesVocab = settlesRule ? settlesRule.allowedVocab : null;

  // 允许的合同类型: 对六个合同类型逐一试 binds 匹配, 命中即允许。
  const allowedContractTypes = CONTRACT_TYPE_NAMES.filter((ct) => {
    const chain = ancestorChain(byId.get(`ct-${ct}`)?.id ?? null, byId);
    return matchEdgeRule({ rules, sourceChain, targetChain: chain, edgeType: 'binds' }) !== null;
  });

  // 项目-合同树: memberships(confirmed) join 台账。
  const allowed = (ct: string | null) =>
    ct === null || allowedContractTypes.length === 0 || allowedContractTypes.includes(ct);
  const contractRow = (no: string, ct: string | null) =>
    ({ contractNo: no, contractType: ct, allowed: allowed(ct) });

  const assigned = new Set<string>();
  const projectBlocks = [];
  for (const p of projects) {
    const ms = await listMembershipsByProject(ctx, p.code, user.id, 'confirmed');
    const nos = ms.map((m) => m.contractNo);
    for (const n of nos) assigned.add(n);
    const contracts = ledger
      .filter((l) => assigned.has(l.contractNo))
      .map((l) => contractRow(l.contractNo, l.contractType ?? null));
    projectBlocks.push({ code: p.code, name: p.name, contracts });
  }
  const unassignedContracts = ledger
    .filter((l) => !assigned.has(l.contractNo))
    .map((l) => contractRow(l.contractNo, l.contractType ?? null));

  return c.json({
    documentId, docType, typeChain, bindsRelation, settlesVocab,
    allowedContractTypes, projects: projectBlocks, unassignedContracts,
  });
});
```

（import 合并为一条自 repositories.js；`listContractLedgerEntries` 返回行的合同类型字段名与 `l.contractNo` 以其真实返回类型为准——实现时对照 repositories.ts:1974。projects 循环内的 assigned 集合逻辑注意在 filter 前先累积当前项目 nos，上面代码已按此写。）

- [ ] **Step 4: index.ts 挂载（对照现有 `/api/projects` 挂载点，requireAuth 下）**

```ts
app.route('/api/templates', requireAuth, templatesRoute);
```

（import `templatesRoute` from `./routes/templates.js`；挂载方式与 index.ts 中 bindings/projects 路由完全一致——若仓库用 `app.use('/api/templates', requireAuth)` + `app.route()` 两步式，照抄现有写法。）

- [ ] **Step 5: 跑新测试 + 全量门禁**

Run: `npm test --workspace apps/server -- test/routes/templatesContext.test.ts && npm run build && npm run lint && npm test`
Expected: 全 PASS（build → lint → test 顺序，与 CI 一致）

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/routes/templates.ts apps/server/src/index.ts apps/server/test/routes/templatesContext.test.ts
git commit -m "feat(template): /api/templates/context 工作台双下拉上下文API"
```

---

## 收尾

- [ ] **最终门禁**: 仓库根 `npm run build && npm run lint && npm test` 全绿后，按 AGENTS.md 约定 push（本分支为讨论分支 `PengYip/业务图谱模版关系讨论`，不 push main）。
- [ ] **后续计划（不在本计划内）**: 前端双下拉改造（CandidatePanel 手动绑定表单 → 项目下拉 + 合同下拉 + relation 只读派生展示，消费 T7 context API；歧义时第三步澄清）→ 独立计划，建议执行时 @designer 参与交互评审。Phase 2（抽取路由 props 驱动 + template_overview L1 工具）另行计划。

## Self-Review 记录

- **Spec 覆盖**: §3 三表(T1-T2)、§3.2 种子+兜底+登记不启用(T3)、§4.3 守卫含 Phase 1 范围限定(T4)、§4.1 权重参数化(T5)与门禁(T6)、双下拉数据源(T7)、templateVersion(T6)。§4.2 抽取路由与 §4.4 Agent 工具为 Phase 2，明示范围外。✓
- **占位符**: T6 Step 1 与 T7 Step 1 的测试脚手架指示"照抄现有 route 测试模板 + 固定断言目标"，断言目标已写死，属可执行指令而非 TBD；两处 ledger 字段名标注"以真实返回类型为准"并给出核对行号。✓
- **类型一致性**: GuardResult/TemplateTypeRow/TemplateEdgeRuleRow/AnchorWeights 在 T2/T4/T5 间签名一致；`dt-`/`ct-` 前缀 id 约定 T3/T4/T7 一致；templateVersion 传递链 T4→T6→bindingGraphSync 一致。✓
