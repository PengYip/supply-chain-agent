# 业务图谱模板 P4（运行时本体演化：manage_template L2 + 模板管理 REST + 种子冲突策略 + 小修包）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让模板层从"代码内置种子"演化为"运行时本体"——Agent 经 `manage_template`(L2 needsApproval) 与管理员经 `/api/templates` CRUD 可新增类型（props 驱动抽取与绑定目标）、改边词表、软禁用/激活；boot 种子幂等不再覆写已被管理的行（冲突策略先行设计）；附带四个存量小修。

**Architecture:** 三表已存在（template_types / template_edge_rules / template_versions，P1 建立）。新增列 `managed_at TEXT` + `managed_by TEXT` 作为种子冲突的判据（见下"种子冲突策略"）；所有管理写入经统一业务层 `src/pipeline/templateManage.ts`（L2 工具与 REST 路由共用，避免双份校验漂移），每次成功变更向 template_versions 插入递增版本。约束层不变：templateGuard 仍只硬校验 binds/settles 组合、relation 词表软校验；行为零变化基线 = 现有测试全绿 + 未触碰的种子行为逐字节等价。

**Tech Stack:** TypeScript (strict ESM, `.js` import 后缀)、better-sqlite3 + drizzle(SQLite) / node-postgres(PG) 双后端、Hono、AI SDK 6（tool + `needsApproval` v6 软门控）、vitest。

**Spec:** `docs/superpowers/specs/2026-08-26-graph-template-design.md` §4.4(manage_template L2) / §5(维护与 HITL、删除保护、变更不回溯)。
**格式参照:** `docs/superpowers/plans/2026-08-26-graph-template-phase1.md`。

## Global Constraints

- 完成顺序强制：build → lint → test（`npm run build` / `npm run lint` / `OPENAI_API_KEY=ci-dummy-key npm test`，仓库根目录）。
- 禁 emoji；ESM `.js` 后缀 import；仓储双后端分派（repositories.ts sqlite 分支 + postgres-repositories.ts `xxxPg`）。
- 行为零变化基线：每个 Task 结束跑一次聚焦测试 + 任务组结束跑全量；Task 1 的种子条件化必须证明"未管理行的旧覆写语义不变"。
- 变更不回溯铁律（spec §5）：已落图的边保持写入时 templateVersion，不做批量重校验。
- 权限：REST 变更端点 `requireAuth` + `requireRole('admin')`（读端点全登录用户）；Agent 工具侧 L2 `needsApproval: true`（人对 AI 同一校验通道，spec §5）。
- AI SDK 6 注意：工具 schema 字段是 `inputSchema` 不是 `parameters`；注册处挂 `needsApproval: true` 布尔形态（照 graphLinkTools/roleToolRegistry 先例）。

---

## 种子冲突策略（先于实现的设计裁定）

**问题**：P1 的 boot seed 用 `ensure*` upsert 回写三件事——`is_active`、`allowed_vocab/target`、`props/parent_id`。Phase 3 起 manage 操作（软禁用、改词表、激活登记项）会被下次重启的 boot seed 无脑翻回。实测场景：管理员把发货单 settles 规则置 active=false，重启后又变 active。

**裁定：DB 状态优先（managed-wins），以行级 `managed_at` 时间戳为界。**

1. 两张表各加两列：`managed_at TEXT`（SQLite）/ `timestamptz`（PG）与 `managed_by TEXT`。NULL = 该行从未被管理操作触碰，属"纯种子行"。
2. `ensureTemplateType` / `ensureEdgeRule` 的 `ON CONFLICT DO UPDATE` 增加 `WHERE <table>.managed_at IS NULL`：
   - 纯种子行：boot 继续覆写 parent/props/vocab/target/is_active（旧行为逐字节保留）；
   - 已管理行：boot 对该行完全跳过 UPDATE（新增的种子条目仍正常 INSERT）；
   - 边规则表原有的 `anchor_weights = COALESCE(excluded.anchor_weights, ...)` 小修防护随条件 WHERE 一并只在纯种子行生效——已管理行整行冻结，不受影响。
3. manage 的每一次成功写入（create 型入 / update / activate / deactivate）都原子地 SET `managed_at=datetime('now'), managed_by=<who>` 并 `bumpTemplateVersion`（INSERT INTO template_versions 取 MAX(version)+1，changed_by/change_summary 落审计）。
4. 显式不采用的两个替代方案（记录裁决理由）：
   - **seed_locked 布尔列**：无法表达"谁、何时"管的，审计不足；
   - **boot 时 diff 内存种子 vs DB 再合并**：把演化逻辑放进启动路径，启动变慢且每次加字段都要重写 diff，风险高。
5. 登记不启用(`active:false`)的种子项被 manage 激活后 => `managed_at` 非空 => boot 不再拉回 false；同理解除激活亦然。

---

### Task 1: managed_at/managed_by 列 + ensure* 条件更新 + bumpTemplateVersion

**Files:**
- Modify: `apps/server/src/pipeline/db/client.ts`（migrate() SQLite guarded ALTER ~:474 区域已有 contract_type 先例；PG 段 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`）
- Modify: `apps/server/src/pipeline/db/repositories.ts`（ensureTemplateType / ensureEdgeRule / bumpTemplateVersion）
- Modify: `apps/server/src/pipeline/db/postgres-repositories.ts`（ensureTemplateTypePg / ensureEdgeRulePg）
- Test: `apps/server/test/pipeline/templateRepo.test.ts`（追加 describe）

**Interfaces:**
- Produces:
  - 列：`template_types.managed_at TEXT NULL / managed_by TEXT NULL`；`template_edge_rules.managed_at / managed_by` 同构。
  - `bumpTemplateVersion(ctx, input: { changedBy: string; changeSummary: string }): Promise<number>` — 返回新版本号（MAX(version)+1；空表从 1 起）。

- [ ] **Step 1: 写失败测试**

```ts
// 追加到 apps/server/test/pipeline/templateRepo.test.ts
describe('seed 冲突策略(managed-wins)', () => {
  it('未管理行: seed 重跑仍覆写 vocab 与 isActive(旧行为不变)', async () => {
    await ensureTemplateType(ctx, { id: 'dt-货转单', kind: 'doc_type', name: '货转单' });
    await ensureEdgeRule(ctx, {
      id: 'er-x', sourceTypeId: 'dt-货转单', edgeType: 'binds',
      allowedVocab: ['旧词'], isActive: true,
    });
    // 管理员未碰过(managed_at NULL): 同 id 但不同内容的"seed"可继续覆写。
    await ensureEdgeRule(ctx, {
      id: 'er-x', sourceTypeId: 'dt-货转单', edgeType: 'binds',
      allowedVocab: ['新词'], isActive: false,
    });
    const rules = await ctx.sqlite
      .prepare('SELECT allowed_vocab AS v FROM template_edge_rules WHERE id = ?')
      .get('er-x') as { v: string };
    expect(rules.v).toBe(JSON.stringify(['新词']));
  });

  it('已管理行(isActive=0 软禁用): seed 重跑不复活', async () => {
    await ensureTemplateType(ctx, { id: 'dt-发货单', kind: 'doc_type', name: '发货单' });
    await ensureEdgeRule(ctx, {
      id: 'er-y', sourceTypeId: 'dt-发货单', edgeType: 'settles',
      allowedVocab: ['发货'], isActive: true,
    });
    // 管理操作: 直接 SQL 置 managed_at 模拟 markManaged(正式入口在 Task 2)。
    ctx.sqlite.prepare(
      "UPDATE template_edge_rules SET is_active = 0, managed_at = datetime('now'), managed_by = 'admin' WHERE id = ?",
    ).run('er-y');
    // boot seed 重跑同一内容(种子语义本想拉回 active=true):
    await ensureEdgeRule(ctx, {
      id: 'er-y', sourceTypeId: 'dt-发货单', edgeType: 'settles',
      allowedVocab: ['发货'], isActive: true,
    });
    const rules = await ctx.sqlite
      .prepare('SELECT is_active AS a, managed_by AS b FROM template_edge_rules WHERE id = ?')
      .get('er-y') as { a: number; b: string };
    expect(rules.a).toBe(0);
    expect(rules.b).toBe('admin');
  });

  it('已管理类型的 props: seed 重跑不覆盖 props 变更', async () => {
    await ensureTemplateType(ctx, { id: 'dt-Z', kind: 'doc_type', name: 'Z' });
    ctx.sqlite.prepare(
      "UPDATE template_types SET props = ?, managed_at = datetime('now'), managed_by = 'admin' WHERE id = ?",
    ).run(JSON.stringify({ requiredFields: ['合同号'] }), 'dt-Z');
    await ensureTemplateType(ctx, { id: 'dt-Z', kind: 'doc_type', name: 'Z', parentId: null });
    const row = ctx.sqlite.prepare('SELECT props AS p FROM template_types WHERE id = ?').get('dt-Z') as { p: string };
    expect(JSON.parse(row.p)).toEqual({ requiredFields: ['合同号'] });
  });

  it('bumpTemplateVersion: 递增并落 changed_by/change_summary', async () => {
    const v1 = await bumpTemplateVersion(ctx, { changedBy: 'u1', changeSummary: '首次调整' });
    const v2 = await bumpTemplateVersion(ctx, { changedBy: 'u1', changeSummary: '第二次' });
    expect(v1).toBe(1);
    expect(v2).toBe(2);
    const row = ctx.sqlite
      .prepare('SELECT changed_by, change_summary, version FROM template_versions ORDER BY version DESC LIMIT 1')
      .get() as { changed_by: string; change_summary: string; version: number };
    expect(row.version).toBe(2);
    expect(row.change_summary).toBe('第二次');
  });
});
```

import 区补 `bumpTemplateVersion`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/pipeline/templateRepo.test.ts`
Expected: FAIL（列不存在 -> SQL 报 no such column；bumpTemplateVersion 未导出）

- [ ] **Step 3: SQLite DDL——client.ts migrate() 内 template_* 建表语句之后追加 guarded ALTER（对照 :474 contract_type ALTER 先例）**

```sql
    -- P4: 种子冲突策略列(managed-wins)。NULL=纯种子行(boot 可覆写);非空=DB 优先。
    try { sqlite.exec("ALTER TABLE template_types ADD COLUMN managed_at TEXT"); } catch { /* concurrent */ }
    try { sqlite.exec("ALTER TABLE template_types ADD COLUMN managed_by TEXT"); } catch { /* concurrent */ }
    try { sqlite.exec("ALTER TABLE template_edge_rules ADD COLUMN managed_at TEXT"); } catch { /* concurrent */ }
    try { sqlite.exec("ALTER TABLE template_edge_rules ADD COLUMN managed_by TEXT"); } catch { /* concurrent */ }
```

PG 段（postgresEnsureSchema 数组内，template 三表 CREATE 之后）：

```ts
    `ALTER TABLE template_types ADD COLUMN IF NOT EXISTS managed_at timestamptz`,
    `ALTER TABLE template_types ADD COLUMN IF NOT EXISTS managed_by TEXT`,
    `ALTER TABLE template_edge_rules ADD COLUMN IF NOT EXISTS managed_at timestamptz`,
    `ALTER TABLE template_edge_rules ADD COLUMN IF NOT EXISTS managed_by TEXT`,
```

同时更新 pg drizzle schema（postgres-schema.ts）与 sqlite schema.ts 中两表的镜像列（照既有列风格；`managedAt: text('managed_at')` / pg `timestamptz`）。若 drizzle 层本次没有查询用到该列，也要补齐以保持镜像一致（architecture.guard 类测试可能断言镜像完整性）。

- [ ] **Step 4: repositories.ts 双 ensure 改条件更新（SQLite 分支）**

```ts
export async function ensureTemplateType(
  ctx: DbContext, input: { id: string; kind: string; name: string; parentId?: string | null },
): Promise<void> {
  if (ctx.backend === 'postgres') return ensureTemplateTypePg(ctx, input);
  ctx.sqlite.prepare(
    `INSERT INTO template_types (id, kind, name, parent_id) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET parent_id = excluded.parent_id,
       props = COALESCE(excluded.props, template_types.props)
     WHERE template_types.managed_at IS NULL`,
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
       is_active = excluded.is_active
     WHERE template_edge_rules.managed_at IS NULL`,
  ).run(input.id, input.sourceTypeId, input.targetTypeId ?? '', input.edgeType,
    JSON.stringify(input.allowedVocab), input.isActive === false ? 0 : 1);
}
```

注意两点：
1. 现 ensureTemplateType 还带 `props = excluded.props`（P2 加了 props 参数，调用方传 `JSON.stringify(input.props ?? {})`）——实现时保留现函数体的 props 处理，仅追加了 WHERE 子句；上面片段为示意，勿丢 props 逻辑。
2. ensureEdgeRule 的 anchor_weights COALESCE（小修 3）留在原位，无需改动；条件 WHERE 使已管理行连 anchor_weights 一并不再被触碰（可接受：manage 入口负责显式写权重）。

- [ ] **Step 5: bumpTemplateVersion（SQLite + PG）**

```ts
/**
 * 模板版本审计(spec §3.3/§5): 每次管理性变更递增一个版本号。
 * 单列自增无并发竞争面(管理操作低频且前台单实例 Hono), 不做事务锁。
 */
export async function bumpTemplateVersion(
  ctx: DbContext, input: { changedBy: string; changeSummary: string },
): Promise<number> {
  if (ctx.backend === 'postgres') return bumpTemplateVersionPg(ctx, input);
  const cur = ctx.sqlite.prepare('SELECT MAX(version) AS v FROM template_versions').get() as { v: number | null };
  const next = (cur.v ?? 0) + 1;
  ctx.sqlite.prepare(
    'INSERT INTO template_versions (version, changed_by, change_summary) VALUES (?, ?, ?)',
  ).run(next, input.changedBy, input.changeSummary);
  return next;
}
```

Pg twin（postgres-repositories.ts）：`SELECT COALESCE(MAX(version),0)+1` + INSERT RETURNING version。

- [ ] **Step 6: 聚焦测试绿 + build**

Run: `npm test --workspace apps/server -- test/pipeline/templateRepo.test.ts && npm run build && npm test --workspace apps/server -- test/pipeline/templateSeed.test.ts`
Expected: 全 PASS（尤其 templateSeed 幂等用例——未管理行语义不变的回归锚点）

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/pipeline/db/client.ts apps/server/src/pipeline/db/schema.ts apps/server/src/pipeline/db/postgres-schema.ts apps/server/src/pipeline/db/repositories.ts apps/server/src/pipeline/db/postgres-repositories.ts apps/server/test/pipeline/templateRepo.test.ts
git commit -m "feat(template): managed-wins 种子冲突策略+版本审计bumpTemplateVersion"
```

---

### Task 2: templateManage 业务层（create/update-vocab/activate/deactivate + 删除保护）

**Files:**
- Create: `apps/server/src/pipeline/templateManage.ts`
- Test: `apps/server/test/pipeline/templateManage.test.ts`

**Interfaces:**
- Consumes: Task 1 bumpTemplateVersion；现有 ensure*/listTemplateTypes/listActiveEdgeRules/listTemplateVersions（若无 listTemplateVersions 则 Task 2 一并补只读函数，REST GET versions 用）。
- Produces（工具与 REST 共用的唯一写入面，全部返回 discriminated union 以便两层各自映射 HTTP/工具错误）:

```ts
export type ManageResult<T> =
  | { ok: true; data: T; templateVersion: number }
  | { ok: false; reason: string; code: 'not_found' | 'duplicate' | 'protected' | 'invalid' };

export async function createTemplateType(ctx, actor: string, input: {
  kind: 'doc_type' | 'contract_type'; name: string;
  parentIdName?: string;                    // 以名字引父(与 dt-/ct- 约定解耦)
  props?: Record<string, unknown>;          // requiredFields/fieldHints/bindingsTargetKind 等自由 JSON
}): Promise<ManageResult<{ id: string }>>;

export async function updateTemplateTypeProps(ctx, actor: string, input: {
  typeId: string; parentIdName?: string | null; props?: Record<string, unknown>;
}): Promise<ManageResult<{ id: string }>>;

export async function updateEdgeRuleVocab(ctx, actor: string, input: {
  ruleId: string; allowedVocab: string[];
}): Promise<ManageResult<{ id: string }>>;

export async function setTemplateTypeActive(ctx, actor: string, input: {
  typeName: string; active: boolean;
}): Promise<ManageResult<{ id: string; inUseReasons?: string[] }>>;

export async function setEdgeRuleActive(ctx, actor: string, input: {
  ruleId: string; active: boolean;
}): Promise<ManageResult<{ id: string }>>;

// 硬删一律不存在(spec §5 删除保护); 此 helper 只为展示原因:
export async function typeUsageReasons(ctx, typeName: string): Promise<string[]>
// e.g. ['激活边规则 er-bind-hetong 引用', 'documents 表存在 12 个该类型文档']
```

语义要点：
- create 重名（kind+name 唯一索引）-> `code:'duplicate'`。
- 所有成功路径：SET `managed_at/managed_by` + `bumpTemplateVersion`（changeSummary 结构化，如 `type.deactivate 发货单`）。
- props 白名单过滤不强做（props 是自由 JSON，消费方自行取键）；但 `bindingsTargetKind` 若出现只能是 'Project'|'Contract'，否则 `code:'invalid'`（该键有行为语义，值得守）。

- [ ] **Step 1: 写失败测试**（内存库+migrate+ensureTemplateSeed 打底；用例清单）
  - create 正常/重名 duplicate/非法 bindingsTargetKind invalid；
  - create 后 listTemplateTypes 可见且 managed_by 落值、template_versions 有行；
  - updateEdgeRuleVocab 成功覆写词表且 boot ensureEdgeRule 同词表重灌**不**回滚（Task 1 条件生效链路集成点）；
  - setTemplateTypeActive(false)：行 is_active=0 且返回 inUseReasons（构造激活规则引用 + documents 存在该类型文档的场景）；
  - setTemplateTypeActive(true)：复活登记 inactive 种子规则所依赖的类型（如 激活 发货单 类型本身）；
  - setEdgeRuleActive(true/false) 双向，成功带版本号；
  - typeId/name 不存在 -> not_found。
  
- [ ] **Step 2: 跑测试确认失败**（模块不存在）

- [ ] **Step 3: 实现 templateManage.ts**（直接 SQL UPDATE 双段在 repo 层还是这里？裁定：这里有 TypeRow 需要 name<->id 映射与 usage 查询，SQL 直写 SQLite 用 `ctx.backend==='postgres'` 分派调用 postgres-repositories 的 Pg helper `markTemplateTypeManaged` 等——若嫌层多，允许在本文件用 ctx.sqlite/ctx.pool 写双分支（templateOverviewTool 之外的先例少，但 quotaTools 是先例）。选择：本文件内做双后端分支，理由=操作面窄（两条 UPDATE/INSERT），不值得为它们扩 repositories 公共面。）

关键 SQL 形状：

```sql
-- setTemplateTypeActive:
UPDATE template_types SET is_active = ?, managed_at = datetime('now'), managed_by = ?
 WHERE name = ? AND kind = 'doc_type'
-- PG: managed_at = now()
-- updateEdgeRuleVocab:
UPDATE template_edge_rules SET allowed_vocab = ?, managed_at = datetime('now'), managed_by = ? WHERE id = ?
```

usageReasons 查询：
```sql
SELECT r.id, r.edge_type FROM template_edge_rules r
 WHERE r.is_active = 1 AND (r.source_type_id = :id OR r.target_type_id = :id);
SELECT COUNT(*) AS n FROM documents WHERE doc_type = :typeName;
```
（documents.count 仅统计，COUNT 在大表上也要走索引——documents.doc_type 无独立索引时接受全扫：修复脚本类操作频率可忽略。）

- [ ] **Step 4: 聚焦测试绿** + `npm run build`

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/pipeline/templateManage.ts apps/server/test/pipeline/templateManage.test.ts
git commit -m "feat(template): templateManage业务层(创建/改词表/软禁用激活+删除保护+版本审计)"
```

---

### Task 3: /api/templates 管理 REST（GET 读 + POST/PATCH 变更 + DELETE 软禁用）

**Files:**
- Modify: `apps/server/src/routes/templates.ts`（context handler 之后追加）
- Verify/Wire: `apps/server/src/index.ts`（确认 `/api/templates` 挂载已含 requireAuth；若 context 依赖的 `c.get('user')!` 由隐式约定保证，则为变更子路径显式加中间件）
- Test: `apps/server/test/routes/templatesManage.test.ts`

**Interfaces:**
- Consumes: Task 2 templateManage 全部函数；`requireAuth`（index.ts 现用）、`requireRole`（auth-middleware.ts:66，favorites.ts:33 先例）。
- Produces:

| Method & Path | 权限 | 说明 |
|---|---|---|
| `GET /api/templates/types` | 登录用户 | 全量类型行（含 inactive 与 managed 元数据） |
| `GET /api/templates/rules` | 登录用户 | 全量边规则行（含 inactive；需要新 repo fn `listAllEdgeRules` 或给 listActiveEdgeRules 加参数——二选一，裁定加独立 fn 避免改热点签名） |
| `GET /api/templates/versions?limit=` | 登录用户 | 版本审计倒序 |
| `POST /api/templates/types` | admin | body `{ kind, name, parentIdName?, props? }` |
| `PATCH /api/templates/types/:id` | admin | body `{ parentIdName?, props? }` |
| `POST /api/templates/rules` | admin | body `{ sourceTypeId|sourceTypeName, targetTypeId?, edgeType, allowedVocab, isActive? }` |
| `PATCH /api/templates/rules/:id` | admin | body `{ allowedVocab?, isActive? }` |
| `DELETE /api/templates/types/:id` | admin | 软禁用（永物理删）；响应附 inUseReasons |
| `DELETE /api/templates/rules/:id` | admin | 软禁用 |

错误映射：ManageResult.code -> HTTP：not_found 404 / duplicate 409 / protected 409 / invalid 400（body `{ error: reason }`）。
Admin 之外访问变更端点：403 `{ error: 'forbidden' }`（requireRole 语义原样透出）。

- [ ] **Step 1: 写失败测试**（bindingsRead.test.ts 的 vi.hoisted getDbContext 注入脚手架照抄）
  - trader 角色 PATCH -> 403；
  - admin POST types 创建带 props(requiredFields/fieldHints/bindingsTargetKind:'Contract') -> 200/201 且 GET types 可见 managed_by=admin 用户；
  - admin POST types 重名 -> 409 duplicate；
  - admin PATCH rules/:id 改词表 -> GET 反映 + versions+1；
  - admin DELETE types/:id -> 类型 is_active=0 且响应带 inUseReasons（预置一条引用它的 active 规则）；
  - 非 admin GET types -> 200（读放开）。
  
- [ ] **Step 2: 跑测试确认失败**（404/403——路由不存在）

- [ ] **Step 3: 实现**——templates.ts 追加 handlers（薄壳：zod parse -> templateManage.* -> 结果映射）；查清 index.ts templates 挂载是否已 requireAuth，若无则在变更组前 `templatesRoute.use('*', requireAuth, ...)` 只对管理方法（或在 index.ts 为 `/api/templates/*` 整体 requireAuth——context 本就读 user.id，整体加最安全）。repo 补 `listAllEdgeRules/listTemplateVersions(+Pg twins)`。

- [ ] **Step 4: 聚焦测试绿 + 全量回归**

Run: `npm test --workspace apps/server -- test/routes/templatesManage.test.ts test/routes/templatesContext.test.ts && npm run build && npm test`
Expected: 全 PASS（context 老用例零变化）

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes/templates.ts apps/server/src/index.ts apps/server/src/pipeline/db/repositories.ts apps/server/src/pipeline/db/postgres-repositories.ts apps/server/test/routes/templatesManage.test.ts
git commit -m "feat(template): /api/templates 管理 REST(CRUD+软禁用+admin权限+版本列表)"
```

---

### Task 4: manage_template L2 Agent 工具

**Files:**
- Create: `apps/server/src/pipeline/tools/manageTemplateTool.ts`
- Modify: `apps/server/src/harness/roleToolRegistry.ts`（import、TRADER_CTX_TOOL_NAMES、getToolsForRole push）
- Modify: `apps/server/src/harness/permissionGate.ts`（registerPermission('manage_template', 'L2')）
- Modify: `apps/server/src/harness/contextContract.ts`（照 link_amends :143 形状补契约项）
- Test: `apps/server/test/pipeline/tools/manageTemplateTool.test.ts`

**Interfaces:**
- Consumes: Task 2 templateManage（唯一写入面——工具不含独立 SQL）。
- Produces: `buildManageTemplateTool(deps: { ctx: DbContext; userId?: string })`，inputSchema：

```ts
z.object({
  action: z.enum(['create_type', 'update_props', 'update_vocab', 'set_type_active', 'set_rule_active'])
    .describe('create_type=新增类型; update_props=改类型属性(抽取提示/绑定目标); update_vocab=改边规则词表; set_type_active=set_rule_active=软禁用/激活'),
  // create_type
  kind: z.enum(['doc_type', 'contract_type']).optional(),
  name: z.string().min(1).max(50).optional(),
  parentIdName: z.string().optional().describe('父类型名, 如 收货单 的父 运输凭证'),
  props: z.record(z.unknown()).optional().describe('如 {requiredFields:[..], fieldHints:{..}, bindingsTargetKind:"Contract"|"Project"}'),
  typeId: z.string().optional(),          // update_props / set_rule_active 前者的目标(dt-/ct- 前缀 id)
  ruleId: z.string().optional(),          // update_vocab / set_rule_active 目标(er- 前缀)
  allowedVocab: z.array(z.string()).optional(),
  active: z.boolean().optional(),
})
```

- 输出结构：成功 `{ status:'ok', action, templateVersion, ...payload }`；失败 `{ status:'error', reason, code }`（不抛异常——照 templateOverviewTool 的 error 返回先例）。
- 描述文案写"什么时候用"+"边界"（对照 link_amends :131 格式）：什么时候用=用户说"新增一类XX单据""以后收货单也可以挂物流合同""先把XX类型停用"；边界=不做物理删除(spec §5 删除保护)/不改已落图边的版本/组合兼容性由绑定时的 templateGate 把关而非此处。

- [ ] **Step 1: 写失败测试**（直接 `await tool.execute(input, {messages:[],toolCallId:'t',abortSignal:undefined} as any)` 照 documentEntry.test.ts 模式）
  - create_type 最小入参 -> ok + 版本号 >=1 + DB 行 managed_by=deps.userId；
  - create_type 非法 bindingsTargetKind -> `{status:'error', code:'invalid'}`；
  - update_vocab 合法 -> ok 且 GET(直查 DB) 词表变化；下一轮 ensureSeed 同 id 重灌不复原（集成点复断言）；
  - set_rule_active false 后 listActiveEdgeRules 不含该规则；
  - 缺必填参数（action=create_type 但无 kind/name）-> error/invalid（zod 天然挡，execute 内再兜一层）。
  
- [ ] **Step 2: 跑测试确认失败**（模块不存在）

- [ ] **Step 3: 实现工具文件**（全部转调 templateManage；double-switch if/else 按 action 分派；参数缺省校验集合在一处 switch 内完成）

- [ ] **Step 4: 注册四件套（graphLinkTools/roleToolRegistry 先例逐一对照）**
  - roleToolRegistry.ts：:13 import 追加 `buildManageTemplateTool`；:86 TRADER_CTX_TOOL_NAMES 追加 `'manage_template'`；getToolsForRole 内 :134 link_amends push 之后加 `{ ...buildManageTemplateTool({ ctx, userId }), name: 'manage_template', needsApproval: true }`。
  - permissionGate.ts :77 之后：`registerPermission('manage_template', 'L2'); // 2026-08-28 P4: 模板维护(新增类型/改词表/软禁用激活)`
  - contextContract.ts :146 之后补契约项（persist 'business', risk L2, injection 'safe'）。

- [ ] **Step 5: 注册面回归 + 全量**

Run: `npm test --workspace apps/server -- test/pipeline/tools/manageTemplateTool.test.ts test/harness/roleRegistry.test.ts && npm run build && OPENAI_API_KEY=ci-dummy-key npm test`
（若 harness 注册断言测试文件名不同，grep `listToolNames` 找到消费测试替换路径。）
Expected: 全 PASS——特别注意任何 listToolNames 快照型断言需要同步加名。

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/pipeline/tools/manageTemplateTool.ts apps/server/src/harness/roleToolRegistry.ts apps/server/src/harness/permissionGate.ts apps/server/src/harness/contextContract.ts apps/server/test/pipeline/tools/manageTemplateTool.test.ts
git commit -m "feat(template): manage_template L2工具(action分派+needsApproval+四件套注册)"
```

---

### Task 5: 新类型端到端 props 生效断言（零/极少代码）

**Files:**
- Test: `apps/server/test/pipeline/templatePropsE2E.test.ts`

**背景**：props 的三个消费点已存在于主干（无需新代码，但要防回归的断言）：
- 抽取：autoExtraction.ts `buildAutoExtractionDeps.extract` 读 `typeRow.props.requiredFields / fieldHints` 传入 extractGroundedFields（extraction.ts:208）；
- 绑定目标：routes/bindings.ts:384 与 routes/templates.ts:49 读 `props.bindsTargetKind`。

**Steps:**
- [ ] Step 1: 测试流：templateManage.createTemplateType 新建 doc_type「铁路运单」props={fieldHints:{车次:'实际车次字段'}, bindingsTargetKind:'Contract'} -> 断言 listTemplateTypes 行 props 原样往返；用 buildBindingCandidates/buildAutoExtractionDeps 消费路径各写一条最小断言（前者验证 listTemplateTypes 查名命中新类型即可驱动 rule 匹配 fallback；后者直接断言 `listTemplateTypes(...)` 查询形状支持任意新名——本质是把 P2 的动态机制用新类型再走一遍，捕捉"未来有人把类型白名单硬编码回来"）。
- [ ] Step 2: 若发现某消费点真硬编码了类型集（目前已知 classifier DEFAULT_COARSE 是有意硬编码的粗类四选一，不算），顺路修复。
- [ ] Step 3: 绿 + Commit

```bash
git commit -m "test(template): 新增类型 props 消费端到端断言(抽取提示/绑定目标防回归)"
```

---

### Task 6: 小修包（四件，一个 commit）

**6a 上传回复引用存储 docType（叙述修正 G 的服务端一半）**

- Files: `apps/server/src/routes/files.ts`（:255 c.json 对象加 `docType`——:239 已有存根写入的真实值；`ALLOWED_DOCTYPES` 兜底后的变量即存储事实源）
- Test: `apps/server/test/routes/files.test.ts` 追加断言：上传后响应 `docType === 请求传参存储值`（会用桩挡 MinIO 则照既有用例方式，先看该文件有无上传用例；若无合适夹具，允许改为对 createDocumentStub 入参与响应字段的等值断言）。
- 说明：这是任务书 G 项的可交付服务端部分——"叙述"由前端/模型基于此字段组装（前端泳道后续消费）。

**6b 已解析(parsed)文档的「重新处理」入口**

- Files: `apps/web/src/components/shell/FileTree.tsx`（:328 `canTriggerParse` 条件放宽为 `'uploaded' || 'failed' || 'parsed'`；:341-358 badge 文案分支：failed='解析失败，点击重试'、uploaded 现状、parsed='重新处理'）
- 无组件测试设施：按 brief 不强制；手动验收点＝parsed 文件徽标可点击触发 POST /:docId/process 且状态回流 parsing->parsed。
- 风险护栏：重新处理会覆盖 block_model/extraction（ensureDocumentExtracted 终态短路——需确认 processDocument 对 terminal 'parsed' 不拒绝重跑：它是直接管道不是 single-flight skip，behavior=覆盖重算，符合"重新处理"预期；实现时以代码为准并把结论写进提交信息）。

**6c contracts 拉取失败态改进**

- Files: `apps/web/src/hooks/useBindings.ts`（loadContracts :363 catch 目前 setContracts([]) 静默——增加 `contractsError: string | null` + `retryContracts()` 导出）
- Files: `apps/web/src/components/bindings/CandidatePanel.tsx`（manual 区域 contracts.length===0 分支 :324/:357：contractsError 存在时渲染「台账加载失败：<msg> + 重试按钮(调 retryContracts)」，否则维持原文案）——prop 透传两个新值。
- 组件层无测试设施：hook 逻辑简单状态位，手测+构建通过即可。

**6d 死代码清理**

- `hasContractDocBinding`（repositories.ts:720 + postgres-repositories.ts:690）——P3 死锁放宽后无调用方（bindings.ts 已改 findContractLedgerByNo）。
- `findTemplateTypeByName`（repositories.ts:3368 + pg twin）——先 `grep -rn "findTemplateTypeByName"` 复核确实零消费（P1 计划曾规划它，落地未见使用）；零消费即删（含 PG twin 与 drizzle 无关）。
- 每个 export 删除前跑 `npx oxlint src` + 全量测试兜底意外消费（测试文件如有使用则一并修正）。

**Commit:**

```bash
git add apps/server/src/routes/files.ts apps/server/test/routes/files.test.ts \
        apps/web/src/components/shell/FileTree.tsx apps/web/src/hooks/useBindings.ts apps/web/src/components/bindings/CandidatePanel.tsx \
        apps/server/src/pipeline/db/repositories.ts apps/server/src/pipeline/db/postgres-repositories.ts
git commit -m "chore: P4小修包(上传回执带存储docType/parsed重新处理入口/contracts失败重试/死代码清理)"
```

---

## 开放问题（实现者遇到即停，交 Orchestrator 裁定）

1. **模板变更的角色边界**：本计划裁定 REST 变更=admin only、Agent 侧=L2 审批（spec §5"人对 AI 共用同一通道"的字面延伸）。若运营期望 trader 也能改词表，只需把 Task 3 的 requireRole 列表加 'trader'——一处改动。
2. **POST /api/templates/rules 是否允许创建 sourceTypeId 不存在的悬空规则**：裁定允许（登记先行、类型后建的运维顺序合法），validateEdge 天然不匹配悬空源。
3. **ensureTemplateType 现有 props 处理与 Task 1 WHERE 的交互**：若实施中发现 SQLite 对"DO UPDATE 带 props + WHERE"组合报语法错（老 SQLite），降级方案=先 SELECT managed_at 判空再决定是否 UPDATE（性能可忽略，模板表极小）。
4. **6b 重新处理是否会重复物化执行流水/台账**：processDocument 重跑即覆盖抽取并重挂 buildLedgerWritingDeps（upsert 幂等）——预计安全，实现时以一条手动验证为准并在报告中记录观察结果。

## 裁决记录（Orchestrator 2026-08-28，执行不重议）

1. 角色=REST admin only + Agent L2 审批，按计划执行；trader 放行留作运营后续单点改动。
2. 悬空规则允许创建，**附加软提示**：响应体带 `warnings: ['sourceTypeId 不存在（登记先行）']`，前端/工具消费可见即可。
3. 老 SQLite 降级方案照准（SELECT 判空→UPDATE）。
4. 幂等验证照准；参考先例：refreshExecutionFlowsForDocument 本就「先撤回该文档全部流水再物化」（documentEntry 防漂移重建），6b 重跑路径确认是否复用同款语义并在报告记录。
