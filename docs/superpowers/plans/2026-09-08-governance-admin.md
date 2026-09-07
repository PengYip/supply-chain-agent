# 治理后台 governance-admin 实施计划（roadmap Item 6, P2）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新 ViewId `governance`（admin 组），四个全部只读的 tab——本体 / 工具 inventory / 权限矩阵 / 审批审计——各自数据来自 SSOT 并在页面标注出处。

**Architecture:** 后端只加只读 HTTP 面：`/api/tools/inventory`（读 docs/tool-inventory.json 并与注册表实测挂载对比）、`/api/tools/permissions`（permissionGate 快照导出）、`/api/approval/list` 扩展 toolName/decidedBy/createdFrom/createdTo 过滤（SQLite/PG 双后端同 SQL 语义）。前端在既有 hash 路由壳内新增 governance 视图，四个 tab 组件全部由接口数据驱动，零硬编码业务字段。

**Tech Stack:** Hono + zod v3 + AI SDK 6（后端不新增 agent 工具）；Vite + React 19 + Tailwind（前端）；vitest（server + web）。

**Spec:** docs/superpowers/specs/2026-09-07-frontend-p0-p2-roadmap.md §Item 6（128-144 行）

## Global Constraints（照抄路线图 §3.4 + 任务硬约束）

- 验证顺序 `npm run build && npm run lint && npm test`（仓库根），全绿才算完成
- 代码零 emoji；TS 严格模式过 tsc
- 双后端列对列镜像；SQLite 幂等迁移（PRAGMA 守卫）/ Postgres `ADD COLUMN IF NOT EXISTS`（本项只读查询，无新表新列）
- 新增 agent 工具必须先登记 `docs/tool-inventory.json`——本项**不新增 agent 工具**，`/api/tools/*` 是 HTTP 路由（先例：`/api/ontology/*` 无 inventory 条目），不进注册表
- AI SDK 6 陷阱以 AGENTS.md「AI SDK 6」节为准（本项不涉及工具/流式代码）
- 认证 `requireAuth`；测试模式 `appAs(userId)` + `app.request`（照抄 approvalListRoutes.test.ts）
- 分支惯例：feature 分支开发，验证绿后 merge 回 main 并 push（触发 CI+CD 到 10.10.0.2）
- 不动 Item 7（总览工作台 overview）；不扩范围（OUT：本体/权限在线编辑、多环境对比）
- 范围锚点：四个 tab 的数据源分别为 `GET /api/ontology/schema`、`docs/tool-inventory.json`×注册表、`harness/permissionGate.ts`、`GET /api/approval/list`；每个 tab 页面标注数据出处

## 开工前重摸底结论（2026-09-08 实测，分支 PengYip/governance-admin @ 7abf4fd）

1. `apps/server/src/ontology/index.ts` 导出 `ontologySchemaJson()`（289-313 行）：`{version, enums{PayType,EventBizType,AllocateMethod,commodityCodes}, entities[{name,label,ownFields,fields,meaning}], relations[{name,description,pairs,params,meaning}]}`。`GET /api/ontology/schema` 已存在（routes/ontology.ts:24，requireAuth 覆盖）。Tab 1 纯消费，后端零改动。
2. `apps/web/src/components/shell/navigation.ts`：ViewId 联合类型（18-31 行）+ NAV_ITEMS（49-63 行），admin 组已有 eval/audit/favorites/parties。新增 `'governance'` 进 admin 组即可，无按角色的导航过滤（既有惯例即如此）。
3. `GET /approval/list`（routes/approvalCallback.ts:240-260）现仅支持 `status`+`limit`。`ApprovalListFilter`（sessionStore.ts:163-167）同。`pending_approvals` 两后端列一致且全 TEXT：`tool_name/created_at/decided_by/decided_at/status`（SQLite DDL sessionStoreSqlite.ts:98-114；PG CREATE+幂等 ALTER sessionStorePostgres.ts:106-148）。时间列 UTC ISO TEXT，字典序=时间序，双后端可用同一比较语义。`ontology/asof.ts` 的 `normalizeIsoUtc`（21-26 行）可复用作入参归一。
4. `harness/permissionGate.ts` 只有 register/get 判定函数，无快照导出——需新增 `listPermissions()` 与 `TOOL_PERMISSION_LEVELS`。L3 当前无注册工具（escalate_to_human 是 L1 工具，产生 L3 工单）。
5. `docs/tool-inventory.json`（version 2026-08-28）：**query_orders / cross_check / verify_document_fields / extract_fields 四条 `status:"deprecated"` 且带 `removalPlan`，但仍挂载在注册表**（roleToolRegistry.ts:91-94 BASE 表 + 102 行 TRADER_CTX_TOOL_NAMES）。CI 门禁（toolInventory.test.ts）按 `status==='active'||'deprecated'` 都算 live 条目断言双射，故现状绿。Tab 2 必须如实呈现「已挂载 + 已标废弃 + removalPlan」对照，不得掩饰。
6. 注册表实测挂载名取 `getToolsForRole('trader', { ctx }).map(t=>t.name)`（而非 `listToolNames`，后者无条件含 env 门控的 execute_code，不真实）。GatedTool 的 `needsApproval` 布尔即 L2 软门控实测值。
7. web 有 vitest（`npm test --workspace apps/web`），纯逻辑测试放组件旁/`lib`；根 `npm test` 串联 server+web。
8. PG 集成测试（sessionStore.postgres.integration.test.ts）有 TRUNCATE 门禁（库名须含 "test" 或 PG_TRUNCATE_OK=1），CI 无 PG 时自动 skip；`listApprovals` 目前无 PG 侧用例，本计划补一条。

---

### Task 1: permissionGate 快照导出

**Files:**
- Modify: `apps/server/src/harness/permissionGate.ts`
- Test: `apps/server/test/harness/permissionGate.test.ts`（新建）

**Interfaces:**
- Consumes: 现有 `PERMISSIONS` Map、`ToolPermission` 类型
- Produces: `TOOL_PERMISSION_LEVELS: readonly ToolPermission[]`（`['L1','L2','L3']`）；`listPermissions(): Array<{ toolName: string; level: ToolPermission }>`（按注册声明序，不排序——声明序即 permissionGate.ts 的 L1→L2 分组）。Task 5 的 `/api/tools/permissions` 消费。

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/test/harness/permissionGate.test.ts
import { describe, it, expect } from 'vitest';
import { listPermissions, getPermission, TOOL_PERMISSION_LEVELS } from '../../src/harness/permissionGate.js';

describe('permissionGate snapshot', () => {
  it('levels 词汇 = L1/L2/L3', () => {
    expect([...TOOL_PERMISSION_LEVELS]).toEqual(['L1', 'L2', 'L3']);
  });

  it('listPermissions 含既知声明且层级正确', () => {
    const entries = listPermissions();
    const byName = new Map(entries.map((e) => [e.toolName, e.level]));
    expect(byName.get('query_business')).toBe('L1');
    expect(byName.get('bind_document')).toBe('L2');
    expect(byName.get('create_writeoff')).toBe('L2');
    // L3 当前无注册工具（permissionGate 头注：money/irreversible 不落系统内工具）
    expect([...byName.values()].filter((l) => l === 'L3')).toHaveLength(0);
  });

  it('未注册工具 getPermission 兜底 L1（快照不包含兜底项）', () => {
    expect(getPermission('no_such_tool')).toBe('L1');
    expect(listPermissions().some((e) => e.toolName === 'no_such_tool')).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/harness/permissionGate.test.ts`
Expected: FAIL，`SyntaxError: ... is not exported`（TOOL_PERMISSION_LEVELS / listPermissions 不存在）

- [ ] **Step 3: 最小实现**

在 `apps/server/src/harness/permissionGate.ts` 文件末尾追加：

```ts
// ---- governance read surface (roadmap Item 6, 2026-09-08): 治理后台权限矩阵
// 数据源。只读快照：按注册声明序导出（声明序即上方 L1->L2 分组），不含
// getPermission 的 L1 兜底（未注册工具不属于已声明权限面）。L3 保留在 levels
// 词汇里：sessionStore 审批行与 L3 工单流仍使用该层字符串。

export const TOOL_PERMISSION_LEVELS: readonly ToolPermission[] = ['L1', 'L2', 'L3'];

export interface PermissionEntry {
  toolName: string;
  level: ToolPermission;
}

export function listPermissions(): PermissionEntry[] {
  return [...PERMISSIONS.entries()].map(([toolName, level]) => ({ toolName, level }));
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test --workspace apps/server -- test/harness/permissionGate.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/harness/permissionGate.ts apps/server/test/harness/permissionGate.test.ts
git commit -m "feat(server): permissionGate snapshot export for governance permission matrix"
```

---

### Task 2: ApprovalListFilter 扩展 + 双后端 listApprovals 过滤

**Files:**
- Modify: `apps/server/src/harness/sessionStore.ts:163-167`（ApprovalListFilter）
- Modify: `apps/server/src/harness/sessionStoreSqlite.ts:551-568`（listApprovals）
- Modify: `apps/server/src/harness/sessionStorePostgres.ts:594-611`（listApprovals）
- Test: `apps/server/test/harness/approvalList.test.ts`（追加用例）
- Test: `apps/server/test/harness/sessionStore.postgres.integration.test.ts`（追加用例，PG 不可用自动 skip）

**Interfaces:**
- Consumes: 现有 `ApprovalListFilter`/`ApprovalListItem`、两后端 listApprovals
- Produces: `ApprovalListFilter` 新增四个可选字段：

```ts
export type ApprovalListFilter = {
  userId: string;
  status?: 'pending' | 'approved' | 'denied' | 'all';
  limit?: number;
  /** 精确匹配 tool_name（治理后台审批审计 tab）。 */
  toolName?: string;
  /** 精确匹配 decided_by。 */
  decidedBy?: string;
  /** UTC ISO；created_at >= createdFrom（TEXT 列字典序=时间序，双后端同语义）。 */
  createdFrom?: string;
  /** UTC ISO；created_at <= createdTo。 */
  createdTo?: string;
};
```

两后端 listApprovals 签名不变（解构新字段）。Task 3 的路由消费。

- [ ] **Step 1: 写失败测试（SQLite 侧，追加到 approvalList.test.ts 末尾）**

```ts
describe('listApprovals audit filters (roadmap Item 6)', () => {
  it('toolName 精确过滤', async () => {
    const s = await createSession('trader', 'u1');
    const bindId = `ap_${uid('a')}`;
    await recordPendingApproval({ sessionId: s.id, level: 'L2', toolName: 'bind_document',
      toolCallId: `call_${uid('c')}`, input: {}, approvalId: bindId });
    const escId = `ESC-${uid('t')}`;
    await recordPendingApproval({ sessionId: s.id, level: 'L3', toolName: 'escalate_to_human',
      toolCallId: `call_${uid('c')}`, input: {}, ticketId: escId });
    // 共享文件库：不假设空库，只断言过滤语义（命中集全为该工具且含本用例种子）
    const onlyBind = await listApprovals({ userId: 'u1', toolName: 'bind_document' });
    expect(onlyBind.length).toBeGreaterThan(0);
    expect(onlyBind.every((i) => i.tool_name === 'bind_document')).toBe(true);
    expect(onlyBind.map((i) => i.approval_id)).toContain(bindId);
    expect(onlyBind.some((i) => i.tool_name === 'escalate_to_human')).toBe(false);
    const onlyEsc = await listApprovals({ userId: 'u1', toolName: 'escalate_to_human' });
    expect(onlyEsc.every((i) => i.tool_name === 'escalate_to_human')).toBe(true);
    expect(onlyEsc.map((i) => i.ticket_id)).toContain(escId);
  });

  it('decidedBy 过滤只中本人决策的已决票据', async () => {
    const s = await createSession('trader', 'u1');
    const approvalId = `ap_${uid('a')}`;
    await recordPendingApproval({ sessionId: s.id, level: 'L2', toolName: 'bind_document',
      toolCallId: `call_${uid('c')}`, input: {}, approvalId });
    await resolveApproval((await getPending(approvalId))!.id, 'approved', { decidedBy: 'boss-1' });
    expect(await listApprovals({ userId: 'u1', decidedBy: 'boss-1' })).toHaveLength(1);
    expect(await listApprovals({ userId: 'u1', decidedBy: 'nobody' })).toHaveLength(0);
    // pending 行 decided_by 为 NULL，不中任何 decidedBy 过滤
    const approvalId2 = `ap_${uid('a')}`;
    await recordPendingApproval({ sessionId: s.id, level: 'L2', toolName: 'bind_document',
      toolCallId: `call_${uid('c')}`, input: {}, approvalId: approvalId2 });
    expect(await listApprovals({ userId: 'u1', decidedBy: 'boss-1' })).toHaveLength(1);
  });

  it('createdFrom/createdTo 时间窗过滤（UTC ISO 字典序）', async () => {
    const s = await createSession('trader', 'u1');
    const ticketId = `ESC-${uid('t')}`;
    await recordPendingApproval({ sessionId: s.id, level: 'L3', toolName: 'escalate_to_human',
      input: {}, ticketId });
    const mine = (await listApprovals({ userId: 'u1' })).find((i) => i.ticket_id === ticketId)!;
    const createdAt = mine.created_at;
    // 边界含入：[createdAt, createdAt] 命中自身
    const atBoth = await listApprovals({ userId: 'u1', createdFrom: createdAt, createdTo: createdAt });
    expect(atBoth.map((i) => i.ticket_id)).toContain(ticketId);
    expect(await listApprovals({ userId: 'u1', createdFrom: createdAt }).then((r) => r.map((i) => i.ticket_id)))
      .toContain(ticketId);
    const after = new Date(new Date(createdAt).getTime() + 60_000).toISOString();
    const before = new Date(new Date(createdAt).getTime() - 60_000).toISOString();
    expect((await listApprovals({ userId: 'u1', createdFrom: after })).map((i) => i.ticket_id))
      .not.toContain(ticketId);
    expect((await listApprovals({ userId: 'u1', createdTo: before })).map((i) => i.ticket_id))
      .not.toContain(ticketId);
  });

  it('过滤条件可组合（status+toolName）', async () => {
    const s = await createSession('trader', 'u1');
    const approvalId = `ap_${uid('a')}`;
    await recordPendingApproval({ sessionId: s.id, level: 'L2', toolName: 'bind_document',
      toolCallId: `call_${uid('c')}`, input: {}, approvalId });
    await recordPendingApproval({ sessionId: s.id, level: 'L2', toolName: 'bind_document',
      toolCallId: `call_${uid('c')}`, input: {}, approvalId: `ap_${uid('a')}` });
    await resolveApproval((await getPending(approvalId))!.id, 'denied', { decidedBy: 'u1' });
    const rows = await listApprovals({ userId: 'u1', status: 'denied', toolName: 'bind_document' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('denied');
  });
});
```

实现注记（2026-09-08 执行时确认）：`ApprovalList.test.ts` 同文件用例共享一个 SQLite 文件库（test/setup-env.ts 按文件注入），不能假设空库——toolName/时间窗用例按「种子 id 包含 + 命中集全等语义」断言，而非绝对条数；`ApprovalLevel` 是 `'L2'|'L3'` 闭集（sessionStore.ts:48），escalate_to_human 种子用 `level:'L3'`（语义也更准确：该工具产生 L3 工单）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/harness/approvalList.test.ts`
Expected: FAIL——toolName/decidedBy/createdFrom/createdTo 被忽略（第一条期望 toHaveLength(1) 实得 2）

- [ ] **Step 3: 实现 SQLite 侧**

`sessionStore.ts` 的 `ApprovalListFilter` 按上面 Interfaces 块扩展（带注释）。`sessionStoreSqlite.ts` 的 `listApprovals` 整体替换为动态 WHERE：

```ts
async function listApprovals({
  userId,
  status = 'all',
  limit = 50,
  toolName,
  decidedBy,
  createdFrom,
  createdTo,
}: ApprovalListFilter): Promise<ApprovalListItem[]> {
  const conds: string[] = ['(s.user_id = ? OR s.user_id IS NULL)'];
  const params: unknown[] = [userId];
  if (status !== 'all') {
    conds.push('pa.status = ?');
    params.push(status);
  }
  if (toolName) {
    conds.push('pa.tool_name = ?');
    params.push(toolName);
  }
  if (decidedBy) {
    conds.push('pa.decided_by = ?');
    params.push(decidedBy);
  }
  if (createdFrom) {
    conds.push('pa.created_at >= ?');
    params.push(createdFrom);
  }
  if (createdTo) {
    conds.push('pa.created_at <= ?');
    params.push(createdTo);
  }
  const rows = db
    .prepare(
      `SELECT pa.*, s.user_id AS session_user_id
         FROM pending_approvals pa
         JOIN sessions s ON s.id = pa.session_id
        WHERE ${conds.join(' AND ')}
        ORDER BY pa.created_at DESC
        LIMIT ?`,
    )
    .all(...params, limit);
  return rows as ApprovalListItem[];
}
```

- [ ] **Step 4: 跑 SQLite 测试确认通过**

Run: `npm test --workspace apps/server -- test/harness/approvalList.test.ts`
Expected: PASS（原有 + 新增 4 条）

- [ ] **Step 5: 实现 PG 侧 + 集成测试**

`sessionStorePostgres.ts` 的 `listApprovals` 同语义替换（$n 占位）：

```ts
    async listApprovals({
      userId,
      status = 'all',
      limit = 50,
      toolName,
      decidedBy,
      createdFrom,
      createdTo,
    }: ApprovalListFilter): Promise<ApprovalListItem[]> {
      await ensure();
      const conds: string[] = ['(s.user_id = $1 OR s.user_id IS NULL)'];
      const params: unknown[] = [userId];
      if (status !== 'all') {
        conds.push(`pa.status = $${params.length + 1}`);
        params.push(status);
      }
      if (toolName) {
        conds.push(`pa.tool_name = $${params.length + 1}`);
        params.push(toolName);
      }
      if (decidedBy) {
        conds.push(`pa.decided_by = $${params.length + 1}`);
        params.push(decidedBy);
      }
      if (createdFrom) {
        conds.push(`pa.created_at >= $${params.length + 1}`);
        params.push(createdFrom);
      }
      if (createdTo) {
        conds.push(`pa.created_at <= $${params.length + 1}`);
        params.push(createdTo);
      }
      params.push(limit);
      const { rows } = await pool.query<ApprovalListItem>(
        `SELECT pa.*, s.user_id AS session_user_id
           FROM pending_approvals pa
           JOIN sessions s ON s.id = pa.session_id
          WHERE ${conds.join(' AND ')}
          ORDER BY pa.created_at DESC
          LIMIT $${params.length}`,
        params,
      );
      return rows;
    },
```

在 `sessionStore.postgres.integration.test.ts` 的 describe 块内（现有 approvals 用例附近，文件 170 行以后找 `pending_approvals` 相关段）追加：

```ts
  it('listApprovals audit filters (roadmap Item 6): toolName + decidedBy', async () => {
    const s = await store.createSession('trader', 'pg-u1');
    await store.recordPendingApproval({ sessionId: s.id, level: 'L2', toolName: 'bind_document',
      toolCallId: 'call-pg-1', input: {}, approvalId: 'ap-pg-1' });
    await store.recordPendingApproval({ sessionId: s.id, level: 'L1', toolName: 'escalate_to_human',
      toolCallId: 'call-pg-2', input: {}, ticketId: 'ESC-PG-1' });
    const binds = await store.listApprovals({ userId: 'pg-u1', toolName: 'bind_document' });
    expect(binds).toHaveLength(1);
    expect(binds[0]!.tool_name).toBe('bind_document');
    await store.resolveApproval((await store.getPending('ap-pg-1'))!.id, 'approved',
      { decidedBy: 'pg-boss' });
    expect(await store.listApprovals({ userId: 'pg-u1', decidedBy: 'pg-boss' })).toHaveLength(1);
    expect(await store.listApprovals({ userId: 'pg-u1', decidedBy: 'no-one' })).toHaveLength(0);
  });
```

（若该文件内已有同构 helper/常量，按文件内既有风格对齐 fixture 写法；断言不变。）

- [ ] **Step 6: 跑 PG 集成测试（无 PG 时确认 skip 不红）**

Run: `npm test --workspace apps/server -- test/harness/sessionStore.postgres.integration.test.ts`
Expected: 本地未设 DB_BACKEND/PG_TEST_URL 时整个 describe skipped，PASS（0 run）；有 sca_test 库时用例通过

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/harness/sessionStore.ts apps/server/src/harness/sessionStoreSqlite.ts apps/server/src/harness/sessionStorePostgres.ts apps/server/test/harness/approvalList.test.ts apps/server/test/harness/sessionStore.postgres.integration.test.ts
git commit -m "feat(server): approval list audit filters (toolName/decidedBy/createdFrom/createdTo) on both backends"
```

---

### Task 3: GET /api/approval/list 查询参数扩展

**Files:**
- Modify: `apps/server/src/routes/approvalCallback.ts:240-243`（ListQuerySchema）与 253-260（handler 透传）
- Test: `apps/server/test/harness/approvalListRoutes.test.ts`（追加用例）

**Interfaces:**
- Consumes: Task 2 的 `ApprovalListFilter` 新字段
- Produces: `GET /api/approval/list?status=&limit=&toolName=&decidedBy=&createdFrom=&createdTo=`。时间参数接受任意可解析时间串，经 `normalizeIsoUtc`（`../ontology/asof.js`）归一为 UTC ISO 后进过滤；非法值 400。响应形状不变。

- [ ] **Step 1: 写失败测试（追加到 approvalListRoutes.test.ts）**

```ts
describe('GET /api/approval/list audit filters (roadmap Item 6)', () => {
  it('toolName/decidedBy 过滤生效', async () => {
    const s = await createSession('trader', 'u1');
    await recordPendingApproval({ sessionId: s.id, level: 'L2', toolName: 'bind_document',
      toolCallId: `call_${uid('c')}`, input: {}, approvalId: `ap_${uid('a')}` });
    await recordPendingApproval({ sessionId: s.id, level: 'L1', toolName: 'escalate_to_human',
      toolCallId: `call_${uid('c')}`, input: {}, ticketId: `ESC-${uid('t')}` });
    const res = await get(appAs('u1'), '/approval/list?toolName=bind_document');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].tool_name).toBe('bind_document');
  });

  it('createdFrom 接受非归一格式并归一；非法时间 400', async () => {
    const res = await get(appAs('u1'), `/approval/list?createdFrom=${encodeURIComponent('2026-09-08 00:00:00')}`);
    expect(res.status).toBe(200);
    const bad = await get(appAs('u1'), `/approval/list?createdFrom=${encodeURIComponent('not-a-time')}`);
    expect(bad.status).toBe(400);
  });
});
```

注意：`'2026-09-08 00:00:00'` 依赖 `new Date()` 可解析（Node 对该格式按本地时区解析，normalizeIsoUtc 落为 UTC ISO），仅断言 200 + items 为数组，不断言具体条数（时区相关）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/harness/approvalListRoutes.test.ts`
Expected: FAIL——toolName 参数被 schema 剥掉（第一条期望 1 实得 2）

- [ ] **Step 3: 实现**

`approvalCallback.ts` 头部加 `import { normalizeIsoUtc } from '../ontology/asof.js';`，ListQuerySchema 与 handler 替换：

```ts
const isoTimeParam = z
  .string()
  .max(40)
  .refine((v) => {
    try {
      normalizeIsoUtc(v);
      return true;
    } catch {
      return false;
    }
  }, { message: '必须是可解析的时间（归一为 UTC ISO）' })
  .transform((v) => normalizeIsoUtc(v));

const ListQuerySchema = z.object({
  status: z.enum(['pending', 'approved', 'denied', 'all']).default('all'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  toolName: z.string().trim().min(1).max(100).optional(),
  decidedBy: z.string().trim().min(1).max(200).optional(),
  createdFrom: isoTimeParam.optional(),
  createdTo: isoTimeParam.optional(),
});
```

handler 内 `listApprovals({ userId: user.id, ...q.data })` 不变（q.data 已含新字段）。

- [ ] **Step 4: 跑路由测试确认通过**

Run: `npm test --workspace apps/server -- test/harness/approvalListRoutes.test.ts`
Expected: PASS（原有 + 新增 2 条）

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes/approvalCallback.ts apps/server/test/harness/approvalListRoutes.test.ts
git commit -m "feat(server): extend GET /api/approval/list with audit filters (toolName/decidedBy/createdFrom/createdTo)"
```

---

### Task 4: toolInventoryView builder（inventory × 注册表对比）

**Files:**
- Create: `apps/server/src/harness/toolInventoryView.ts`
- Test: `apps/server/test/harness/toolInventoryView.test.ts`（新建）

**Interfaces:**
- Consumes: `docs/tool-inventory.json`（readFileSync，路径 `new URL('../../../../docs/tool-inventory.json', import.meta.url)`——src 与 dist 目录深度一致，`src/harness` 与 `dist/harness` 向上四级都是仓库根）；`getToolsForRole('trader', { ctx })`（roleToolRegistry）+ `getDbContext()`（pipeline/db/dbBackend）取实测挂载
- Produces（Task 5 路由直接 JSON 返回）:

```ts
export interface InventoryRegistryState {
  mounted: boolean;
  needsApproval: boolean;
}
export interface InventoryToolView {
  name: string;
  layer: string;
  level: string;
  status: string;
  mount: string;
  requiresEnv?: string;
  whenToUse: string;
  boundary: string;
  rationale: string;
  removalPlan?: string;
  mergeInto?: string;
  registry: InventoryRegistryState;
}
export interface ToolInventoryView {
  source: 'docs/tool-inventory.json';
  version: string;
  policy: unknown;
  tools: InventoryToolView[];
  removed: unknown[];
  merges: unknown;
  mountedCount: number;
  diff: { mountedNotInInventory: string[]; inventoryNotMounted: string[] };
}
export function buildToolInventoryView(mounted?: Array<{ name: string; needsApproval: boolean }>): ToolInventoryView
```

`mounted` 缺省时 = `getToolsForRole('trader', { ctx: getDbContext() }).map(t => ({ name: t.name, needsApproval: t.needsApproval === true }))`。对比口径与 CI 门禁一致：inventory 的 live 条目 = `status==='active'||'deprecated'`（deprecated 仍挂载不算漂移，如实带出 status+removalPlan+mounted:true）。

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/test/harness/toolInventoryView.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildToolInventoryView } from '../../src/harness/toolInventoryView.js';

const inventoryPath = fileURLToPath(new URL('../../../../docs/tool-inventory.json', import.meta.url));
const inventory = JSON.parse(readFileSync(inventoryPath, 'utf-8')) as {
  version: string;
  tools: Array<{ name: string; status: string }>;
};

describe('toolInventoryView', () => {
  it('显式挂载清单：每条 inventory 工具带 registry 对比，diff 为空', () => {
    const live = inventory.tools.filter((t) => t.status === 'active' || t.status === 'deprecated');
    const mounted = live.map((t) => ({ name: t.name, needsApproval: t.name === 'bind_document' }));
    const view = buildToolInventoryView(mounted);
    expect(view.source).toBe('docs/tool-inventory.json');
    expect(view.version).toBe(inventory.version);
    expect(view.tools.map((t) => t.name)).toEqual(live.map((t) => t.name));
    expect(view.diff).toEqual({ mountedNotInInventory: [], inventoryNotMounted: [] });
    const bind = view.tools.find((t) => t.name === 'bind_document')!;
    expect(bind.registry).toEqual({ mounted: true, needsApproval: true });
    const load = view.tools.find((t) => t.name === 'load_skill')!;
    expect(load.registry).toEqual({ mounted: true, needsApproval: false });
    expect(view.mountedCount).toBe(1);
  });

  it('挂载侧多出的工具进 diff.mountedNotInInventory（不掩饰漂移）', () => {
    const view = buildToolInventoryView([
      { name: 'load_skill', needsApproval: false },
      { name: 'ghost_tool', needsApproval: false },
    ]);
    expect(view.diff.mountedNotInInventory).toEqual(['ghost_tool']);
    expect(view.diff.inventoryNotMounted).toEqual(
      inventory.tools
        .filter((t) => (t.status === 'active' || t.status === 'deprecated') && t.name !== 'load_skill')
        .map((t) => t.name),
    );
  });

  it('deprecated+mounted 如实呈现（Item 6 硬要求：不掩饰）', () => {
    const liveNames = inventory.tools
      .filter((t) => t.status === 'active' || t.status === 'deprecated')
      .map((t) => t.name);
    const view = buildToolInventoryView(liveNames.map((n) => ({ name: n, needsApproval: false })));
    for (const name of ['query_orders', 'cross_check', 'verify_document_fields', 'extract_fields']) {
      const t = view.tools.find((x) => x.name === name)!;
      expect(t.status).toBe('deprecated');
      expect(t.registry.mounted).toBe(true);
      expect(t.removalPlan).toBeTruthy();
    }
  });

  it('removed 黑名单原样带出', () => {
    const view = buildToolInventoryView([]);
    expect(Array.isArray(view.removed)).toBe(true);
    expect((view.removed as Array<{ name: string }>).some((r) => r.name === 'tag_document')).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/harness/toolInventoryView.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现**

```ts
// apps/server/src/harness/toolInventoryView.ts
// 治理后台 Tab 2 数据源（roadmap Item 6, 2026-09-08）：docs/tool-inventory.json
// （工具面 SSOT）× 注册表实测挂载（getToolsForRole，env 门控如实反映）。
// 只读投影：绝不写 inventory 文件；漂移不掩盖——多出/缺失都进 diff 由前端展示。
// 本模块是 HTTP 视图层，不是 agent 工具：不进 tool-inventory.json（先例 /api/ontology）。
import { readFileSync } from 'node:fs';
import { getToolsForRole, type GatedTool } from './roleToolRegistry.js';
import { getDbContext } from '../pipeline/db/dbBackend.js';

interface InventoryFile {
  version: string;
  policy: unknown;
  tools: Array<{
    name: string;
    layer: string;
    level: string;
    status: string;
    mount: string;
    requiresEnv?: string;
    whenToUse: string;
    boundary: string;
    rationale: string;
    removalPlan?: string;
    mergeInto?: string;
  }>;
  removed: unknown[];
  merges: unknown;
}

const INVENTORY_URL = new URL('../../../../docs/tool-inventory.json', import.meta.url);

function readInventory(): InventoryFile {
  return JSON.parse(readFileSync(INVENTORY_URL, 'utf-8')) as InventoryFile;
}

function toRegistryState(t: GatedTool): { name: string; needsApproval: boolean } {
  return { name: t.name, needsApproval: t.needsApproval === true };
}

export interface InventoryRegistryState {
  mounted: boolean;
  needsApproval: boolean;
}

export interface InventoryToolView {
  name: string;
  layer: string;
  level: string;
  status: string;
  mount: string;
  requiresEnv?: string;
  whenToUse: string;
  boundary: string;
  rationale: string;
  removalPlan?: string;
  mergeInto?: string;
  registry: InventoryRegistryState;
}

export interface ToolInventoryView {
  source: 'docs/tool-inventory.json';
  version: string;
  policy: unknown;
  tools: InventoryToolView[];
  removed: unknown[];
  merges: unknown;
  mountedCount: number;
  diff: { mountedNotInInventory: string[]; inventoryNotMounted: string[] };
}

/** mounted 缺省 = trader 实测挂载（含 env 门控语义，与 CI 门禁同口径）。 */
export function buildToolInventoryView(
  mounted?: Array<{ name: string; needsApproval: boolean }>,
): ToolInventoryView {
  const inv = readInventory();
  const states =
    mounted ??
    getToolsForRole('trader', { ctx: getDbContext() }).map(toRegistryState);
  const stateByName = new Map(states.map((s) => [s.name, s]));
  // 与 toolInventory.test.ts 同口径：active+deprecated 都是 live 条目。
  const live = inv.tools.filter((t) => t.status === 'active' || t.status === 'deprecated');
  const liveNames = live.map((t) => t.name);
  const liveSet = new Set(liveNames);
  const mountedNames = states.map((s) => s.name);
  const tools: InventoryToolView[] = live.map((t) => {
    const state = stateByName.get(t.name);
    return {
      ...t,
      registry: { mounted: state !== undefined, needsApproval: state?.needsApproval ?? false },
    };
  });
  return {
    source: 'docs/tool-inventory.json',
    version: inv.version,
    policy: inv.policy,
    tools,
    removed: inv.removed,
    merges: inv.merges,
    mountedCount: mountedNames.filter((n) => liveSet.has(n)).length,
    diff: {
      mountedNotInInventory: mountedNames.filter((n) => !liveSet.has(n)),
      inventoryNotMounted: liveNames.filter((n) => !stateByName.has(n)),
    },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test --workspace apps/server -- test/harness/toolInventoryView.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/harness/toolInventoryView.ts apps/server/test/harness/toolInventoryView.test.ts
git commit -m "feat(server): tool-inventory x registry comparison view builder"
```

---

### Task 5: GET /api/tools/inventory + /api/tools/permissions 路由与挂载

**Files:**
- Create: `apps/server/src/routes/tools.ts`
- Modify: `apps/server/src/index.ts`（import + requireAuth 挂载 + route 挂载，位置紧挨 ontology 挂载点 133/172 行）
- Test: `apps/server/test/harness/toolsRoutes.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 `listPermissions`/`TOOL_PERMISSION_LEVELS`；Task 4 `buildToolInventoryView`
- Produces（前端 Task 6 消费）:
  - `GET /api/tools/inventory` → `ToolInventoryView`（Task 4 形状）
  - `GET /api/tools/permissions` → `{ source: string; levels: ToolPermission[]; entries: Array<{toolName, level}>; note: string }`
  - 两条路由都过 `requireAuth`（index.ts `app.use('/api/tools/*', requireAuth)`），且**不进 agent 工具注册表、不进 tool-inventory.json**（HTTP 视图层，先例 `/api/ontology/*`）

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/test/harness/toolsRoutes.test.ts
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import type { AuthEnv } from '../../src/lib/auth-middleware.js';

const { toolsRoute } = await import('../../src/routes/tools.js');
const { listPermissions } = await import('../../src/harness/permissionGate.js');

function appAs(userId: string) {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { id: userId, email: 't@t', role: 'trader' } as any);
    await next();
  });
  app.route('/api/tools', toolsRoute);
  return app;
}

const get = (app: Hono<AuthEnv>, path: string) =>
  app.request(`http://test/api/tools${path}`, { method: 'GET' });

describe('GET /api/tools/inventory', () => {
  it('200：SSOT 工具清单 × 注册表对比，deprecated+mounted 如实在列', async () => {
    const res = await get(appAs('u1'), '/inventory');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe('docs/tool-inventory.json');
    expect(body.version).toBe('2026-08-28');
    const byName = new Map<string, { status: string; registry: { mounted: boolean }; removalPlan?: string }>(
      body.tools.map((t: any) => [t.name, t]),
    );
    for (const name of ['query_orders', 'cross_check', 'verify_document_fields', 'extract_fields']) {
      const t = byName.get(name)!;
      expect(t.status).toBe('deprecated');
      expect(t.registry.mounted).toBe(true);
      expect(t.removalPlan).toBeTruthy();
    }
    expect(byName.get('query_business')!.registry.mounted).toBe(true);
    // 未认证（直接裸挂载时）由 requireAuth 在 index.ts 兜底；本测试直挂路由，
    // 防御性 user 检查在 handler 内。
  });
});

describe('GET /api/tools/permissions', () => {
  it('200：levels 词汇 + 注册声明快照与 listPermissions 一致', async () => {
    const res = await get(appAs('u1'), '/permissions');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect([...body.levels]).toEqual(['L1', 'L2', 'L3']);
    expect(body.entries).toEqual(listPermissions());
    expect(body.entries.some((e: { level: string }) => e.level === 'L3')).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/harness/toolsRoutes.test.ts`
Expected: FAIL，`routes/tools.js` 不存在

- [ ] **Step 3: 实现路由**

```ts
// apps/server/src/routes/tools.ts
// 治理后台只读 HTTP 面（roadmap Item 6, 2026-09-08）：工具 inventory 视图 +
// 权限快照。挂载：index.ts `app.use('/api/tools/*', requireAuth)` +
// `app.route('/api/tools', toolsRoute)`。
// 注意：这是 HTTP 视图层，不是 agent 工具——不进 roleToolRegistry，也不进
// docs/tool-inventory.json（先例：/api/ontology/* 同样无 inventory 条目）。
import { Hono } from 'hono';
import type { AuthEnv } from '../lib/auth-middleware.js';
import { buildToolInventoryView } from '../harness/toolInventoryView.js';
import { listPermissions, TOOL_PERMISSION_LEVELS } from '../harness/permissionGate.js';

export const toolsRoute = new Hono<AuthEnv>();

toolsRoute.use('*', async (c, next) => {
  if (!c.get('user')) return c.json({ error: 'unauthorized' }, 401);
  await next();
});

/** GET /inventory — docs/tool-inventory.json × 注册表实测挂载对比。 */
toolsRoute.get('/inventory', (c) => {
  try {
    return c.json(buildToolInventoryView());
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error('[tools] inventory view failed:', detail);
    return c.json({ error: 'inventory view failed', detail }, 500);
  }
});

/** GET /permissions — permissionGate 注册声明快照（治理后台权限矩阵数据源）。 */
toolsRoute.get('/permissions', (c) => {
  return c.json({
    source: 'apps/server/src/harness/permissionGate.ts',
    levels: TOOL_PERMISSION_LEVELS,
    entries: listPermissions(),
    note:
      '未注册工具经 getPermission 兜底为 L1（不在此快照内）；' +
      'L3 当前无注册工具：资金/不可逆操作走 escalate_to_human 工单（该工具本身 L1），经审批中心回调复核。',
  });
});
```

`index.ts` 修改三处（照 ontology 挂载模式）：

```ts
import { toolsRoute } from './routes/tools.js';
```

```ts
app.use('/api/tools/*', requireAuth);
```

```ts
app.route('/api/tools', toolsRoute);
```

- [ ] **Step 4: 跑路由测试确认通过**

Run: `npm test --workspace apps/server -- test/harness/toolsRoutes.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: 全量 server 测试回归（确认 CI 双射门禁仍绿）**

Run: `npm test --workspace apps/server`
Expected: PASS，toolInventory.test.ts 双射断言不红（本任务未加注册表工具）

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/routes/tools.ts apps/server/src/index.ts apps/server/test/harness/toolsRoutes.test.ts
git commit -m "feat(server): read-only /api/tools/inventory and /api/tools/permissions routes"
```

---

### Task 6: web API client + governanceModel + 测试

**Files:**
- Create: `apps/web/src/api/governance.ts`
- Create: `apps/web/src/components/governance/governanceModel.ts`
- Test: `apps/web/src/components/governance/governanceModel.test.ts`（新建）

**Interfaces:**
- Consumes: Task 5 两个路由、`GET /api/approval/list`（Task 3）、`GET /api/ontology/schema`（既有 `api/ontology.ts` 的 `fetchOntologySchema` 可直接复用，Tab 1 不新增 client）
- Produces:

```ts
// api/governance.ts
export interface ToolInventoryItemDTO { /* Task 4 InventoryToolView 同形 */ }
export interface ToolInventoryDTO { source: string; version: string; policy: unknown;
  tools: ToolInventoryItemDTO[]; removed: Array<{ name: string; reason: string; removedOn?: string; mergedInto?: string }>;
  merges: unknown; mountedCount: number;
  diff: { mountedNotInInventory: string[]; inventoryNotMounted: string[] }; }
export interface PermissionEntryDTO { toolName: string; level: 'L1' | 'L2' | 'L3'; }
export interface PermissionSnapshotDTO { source: string; levels: string[]; entries: PermissionEntryDTO[]; note: string; }
export interface ApprovalAuditItemDTO { id: string; session_id: string; level: 'L2' | 'L3'; tool_name: string;
  status: 'pending' | 'approved' | 'denied'; created_at: string; decided_by?: string | null;
  decided_at?: string | null; reason?: string | null; sideEffects: Array<{ target: string; action: string; ok: boolean; detail: string; at: string }> | null; }
export function fetchToolInventory(): Promise<ToolInventoryDTO>
export function fetchPermissionSnapshot(): Promise<PermissionSnapshotDTO>
export function fetchApprovalAudit(filters: { status?: string; toolName?: string; decidedBy?: string;
  createdFrom?: string; createdTo?: string; limit?: number }): Promise<{ items: ApprovalAuditItemDTO[] }>
```

```ts
// governanceModel.ts（纯函数，web vitest 覆盖）
export interface ToolRowFlags { deprecatedMounted: boolean; envGated: boolean; }
export function toolRowFlags(t: ToolInventoryItemDTO): ToolRowFlags
export interface MatrixRow { toolName: string; level: string; }
export function permissionMatrixRows(snapshot: PermissionSnapshotDTO): { levels: string[]; rows: MatrixRow[] }
```

- [ ] **Step 1: 写失败测试**

```ts
// apps/web/src/components/governance/governanceModel.test.ts
import { describe, it, expect } from 'vitest';
import { toolRowFlags, permissionMatrixRows, type ToolInventoryItemDTO, type PermissionSnapshotDTO } from './governanceModel';

const tool = (over: Partial<ToolInventoryItemDTO>): ToolInventoryItemDTO => ({
  name: 'x', layer: '感知', level: 'L1', status: 'active', mount: 'always',
  whenToUse: '', boundary: '', rationale: '', registry: { mounted: true, needsApproval: false },
  ...over,
});

describe('toolRowFlags', () => {
  it('deprecated 且仍挂载 = 如实标记（Item 6 硬要求）', () => {
    expect(toolRowFlags(tool({ status: 'deprecated', registry: { mounted: true, needsApproval: false } })))
      .toEqual({ deprecatedMounted: true, envGated: false });
  });
  it('active 挂载、env 门控分别判定', () => {
    expect(toolRowFlags(tool({}))).toEqual({ deprecatedMounted: false, envGated: false });
    expect(toolRowFlags(tool({ mount: 'env', requiresEnv: 'CUBE_SANDBOX_ENABLED=true' })))
      .toEqual({ deprecatedMounted: false, envGated: true });
    expect(toolRowFlags(tool({ status: 'deprecated', registry: { mounted: false, needsApproval: false } })).deprecatedMounted)
      .toBe(false);
  });
});

describe('permissionMatrixRows', () => {
  it('行=工具，levels 从快照带出（不硬编码）', () => {
    const snap: PermissionSnapshotDTO = {
      source: 's', levels: ['L1', 'L2', 'L3'],
      entries: [
        { toolName: 'query_business', level: 'L1' },
        { toolName: 'bind_document', level: 'L2' },
      ],
      note: '',
    };
    const { levels, rows } = permissionMatrixRows(snap);
    expect(levels).toEqual(['L1', 'L2', 'L3']);
    expect(rows).toEqual([
      { toolName: 'query_business', level: 'L1' },
      { toolName: 'bind_document', level: 'L2' },
    ]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/web -- governanceModel`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现 client 与 model**

`api/governance.ts` 照 `api/ontology.ts` 的 `request` 帮手形态：

```ts
// apps/web/src/api/governance.ts
// 治理后台只读数据源（roadmap Item 6）。三条 SSOT：
// /api/tools/inventory（docs/tool-inventory.json x 注册表）、
// /api/tools/permissions（permissionGate）、/api/approval/list（pending_approvals）。

export interface InventoryRegistryStateDTO { mounted: boolean; needsApproval: boolean; }

export interface ToolInventoryItemDTO {
  name: string;
  layer: string;
  level: string;
  status: string;
  mount: string;
  requiresEnv?: string;
  whenToUse: string;
  boundary: string;
  rationale: string;
  removalPlan?: string;
  mergeInto?: string;
  registry: InventoryRegistryStateDTO;
}

export interface ToolInventoryDTO {
  source: string;
  version: string;
  policy: unknown;
  tools: ToolInventoryItemDTO[];
  removed: Array<{ name: string; reason: string; removedOn?: string; mergedInto?: string }>;
  merges: unknown;
  mountedCount: number;
  diff: { mountedNotInInventory: string[]; inventoryNotMounted: string[] };
}

export interface PermissionEntryDTO { toolName: string; level: 'L1' | 'L2' | 'L3'; }

export interface PermissionSnapshotDTO {
  source: string;
  levels: string[];
  entries: PermissionEntryDTO[];
  note: string;
}

export interface ApprovalAuditItemDTO {
  id: string;
  session_id: string;
  level: 'L2' | 'L3';
  tool_name: string;
  status: 'pending' | 'approved' | 'denied';
  created_at: string;
  decided_by?: string | null;
  decided_at?: string | null;
  reason?: string | null;
  sideEffects: Array<{ target: string; action: string; ok: boolean; detail: string; at: string }> | null;
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

export function fetchToolInventory(): Promise<ToolInventoryDTO> {
  return request<ToolInventoryDTO>('/api/tools/inventory');
}

export function fetchPermissionSnapshot(): Promise<PermissionSnapshotDTO> {
  return request<PermissionSnapshotDTO>('/api/tools/permissions');
}

export interface ApprovalAuditFilters {
  status?: string;
  toolName?: string;
  decidedBy?: string;
  createdFrom?: string;
  createdTo?: string;
  limit?: number;
}

export function fetchApprovalAudit(filters: ApprovalAuditFilters = {}): Promise<{ items: ApprovalAuditItemDTO[] }> {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.toolName) params.set('toolName', filters.toolName);
  if (filters.decidedBy) params.set('decidedBy', filters.decidedBy);
  if (filters.createdFrom) params.set('createdFrom', filters.createdFrom);
  if (filters.createdTo) params.set('createdTo', filters.createdTo);
  params.set('limit', String(filters.limit ?? 100));
  return request<{ items: ApprovalAuditItemDTO[] }>(`/api/approval/list?${params.toString()}`);
}
```

`governanceModel.ts`：

```ts
// apps/web/src/components/governance/governanceModel.ts
// 治理后台四个 tab 的纯展示逻辑：全部由接口数据驱动，不硬编码业务字段。
import type { ToolInventoryItemDTO, PermissionSnapshotDTO } from '../../api/governance';

export type { ToolInventoryItemDTO, PermissionSnapshotDTO };

export interface ToolRowFlags {
  /** inventory 已标 deprecated 但注册表仍挂载：如实呈现，不掩饰。 */
  deprecatedMounted: boolean;
  /** mount=env：部署未开启时注册表实测不挂载。 */
  envGated: boolean;
}

export function toolRowFlags(t: ToolInventoryItemDTO): ToolRowFlags {
  return {
    deprecatedMounted: t.status === 'deprecated' && t.registry.mounted,
    envGated: t.mount === 'env',
  };
}

export interface MatrixRow {
  toolName: string;
  level: string;
}

export function permissionMatrixRows(
  snapshot: PermissionSnapshotDTO,
): { levels: string[]; rows: MatrixRow[] } {
  return {
    levels: snapshot.levels,
    rows: snapshot.entries.map((e) => ({ toolName: e.toolName, level: e.level })),
  };
}
```

- [ ] **Step 4: 跑 web 测试确认通过**

Run: `npm test --workspace apps/web -- governanceModel`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/api/governance.ts apps/web/src/components/governance/governanceModel.ts apps/web/src/components/governance/governanceModel.test.ts
git commit -m "feat(web): governance api clients and pure view model"
```

---

### Task 7: ViewId governance + GovernanceView 壳 + Tab 1 本体

**Files:**
- Modify: `apps/web/src/components/shell/navigation.ts`（ViewId 联合 + NAV_ITEMS）
- Modify: `apps/web/src/App.tsx`（import + 视图分发链加 governance 分支）
- Create: `apps/web/src/components/governance/GovernanceView.tsx`
- Create: `apps/web/src/components/governance/OntologyTab.tsx`

**Interfaces:**
- Consumes: `fetchOntologySchema`（api/ontology.ts，`OntologySchemaDTO`）；Task 6 model
- Produces: `GovernanceView`（无 props）；`ViewId` 含 `'governance'`；后续 Task 8/9 的三个 tab 组件签名 `({ }) => JSX.Element`，由 GovernanceView 以 `tab` state 分发

- [ ] **Step 1: navigation.ts 注册视图**

ViewId 联合加一行 `'governance'`（放 `'writeoff'` 之后、`'review'` 之前不强制，跟 admin 组相邻即可）；NAV_ITEMS 追加（lucide 图标 `Shield`，admin 组，enabled: true）：

```ts
{ id: 'governance', label: '治理后台', description: '本体 / 工具面 / 权限 / 审批审计 只读治理视图', icon: Shield, group: 'admin', enabled: true },
```

- [ ] **Step 2: GovernanceView 壳（tab 分发 + 出处页脚惯例）**

```tsx
// apps/web/src/components/governance/GovernanceView.tsx
import { useState } from 'react';
import { clsx } from 'clsx';
import { OntologyTab } from './OntologyTab';

export type GovernanceTabId = 'ontology' | 'tools' | 'permissions' | 'approvals';

const TABS: Array<{ id: GovernanceTabId; label: string }> = [
  { id: 'ontology', label: '本体' },
  { id: 'tools', label: '工具面' },
  { id: 'permissions', label: '权限矩阵' },
  { id: 'approvals', label: '审批审计' },
];

export function GovernanceView() {
  const [tab, setTab] = useState<GovernanceTabId>('ontology');
  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <div className="flex items-center gap-2">
        {TABS.map((t) => (
          <button key={t.id} type="button" onClick={() => setTab(t.id)}
            className={`rounded-md px-3 py-1.5 text-sm ${tab === t.id ? 'bg-primary text-white' : 'bg-surface text-ink-soft hover:bg-line/30'}`}>
            {t.label}
          </button>
        ))}
        <span className="ml-auto text-xs text-ink-soft">全部只读（无在线编辑）</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'ontology' && <OntologyTab />}
        {tab === 'tools' && null}
        {tab === 'permissions' && null}
        {tab === 'approvals' && null}
      </div>
    </div>
  );
}
```

（Task 8/9 把三个 `null` 换成真实 tab 组件；每 tab 底部渲染「数据出处」行。）

- [ ] **Step 3: OntologyTab（数据源 GET /api/ontology/schema，零硬编码）**

```tsx
// apps/web/src/components/governance/OntologyTab.tsx
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { fetchOntologySchema, type OntologySchemaDTO } from '../../api/ontology';
import { clsx } from 'clsx';

/** 治理 Tab 1 本体：类/关系/枚举/meaning 全量渲染。
 *  数据出处：apps/server/src/ontology/index.ts（经 GET /api/ontology/schema）。 */
export function OntologyTab() {
  const [schema, setSchema] = useState<OntologySchemaDTO | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchOntologySchema()
      .then((s) => { if (alive) setSchema(s); })
      .catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, []);

  if (error) return <div className="rounded-lg border border-line bg-white p-4 text-sm text-danger">{error}</div>;
  if (!schema) return <div className="rounded-lg border border-line bg-white p-4 text-sm text-ink-soft">加载中...</div>;

  return (
    <div className="max-w-6xl space-y-4 pb-2">
      <Section title={`实体（${schema.entities.length}）`}>
        <div className="overflow-x-auto rounded-lg border border-line bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-ink-soft">
                <th className="px-3 py-2 font-medium">名称</th>
                <th className="px-3 py-2 font-medium">标签</th>
                <th className="px-3 py-2 font-medium">自有字段</th>
                <th className="px-3 py-2 font-medium">全字段（含 mixin）</th>
                <th className="px-3 py-2 font-medium">meaning</th>
              </tr>
            </thead>
            <tbody>
              {schema.entities.map((e) => (
                <tr key={e.name} className="border-b border-line/60 last:border-b-0">
                  <td className="px-3 py-2 font-mono text-xs text-ink">{e.name}</td>
                  <td className="px-3 py-2 text-ink">{e.label}</td>
                  <td className="px-3 py-2 text-xs text-ink-soft">{e.ownFields.join('、')}</td>
                  <td className="px-3 py-2 text-xs text-ink-soft">{e.fields.length}</td>
                  <td className="px-3 py-2">
                    {e.meaning
                      ? <span className="font-mono text-xs text-primary">{e.meaning}</span>
                      : <span className="text-xs text-ink-soft/60">未挂载</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title={`关系（${schema.relations.length}）`}>
        <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
          {schema.relations.map((r) => (
            <div key={r.name} className="rounded-lg border border-line bg-white p-3">
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm font-medium text-ink">{r.name}</span>
                {r.meaning && <span className="font-mono text-xs text-primary">{r.meaning}</span>}
              </div>
              <p className="mt-1 text-xs text-ink-soft">{r.description}</p>
              <div className="mt-2 space-y-0.5 text-xs text-ink-soft">
                {r.pairs.map((p, i) => (
                  <div key={i} className="font-mono">{p.from} -&gt; {p.to}</div>
                ))}
              </div>
              <div className="mt-2 text-xs text-ink-soft">
                params: {r.params.length ? r.params.join('、') : '（无参关系）'}
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="枚举与开放词汇">
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          {Object.entries(schema.enums).map(([name, values]) => (
            <div key={name} className="rounded-lg border border-line bg-white p-3">
              <div className="font-mono text-xs font-medium text-ink">{name}</div>
              <div className="mt-1 flex flex-wrap gap-1">
                {values.length === 0
                  ? <span className="text-xs text-ink-soft/60">（空：待业务确认）</span>
                  : values.map((v) => (
                    <span key={v} className="rounded bg-surface px-1.5 py-0.5 text-xs text-ink">{v}</span>
                  ))}
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Provenance text={`数据出处：apps/server/src/ontology/index.ts（本体注册表 SSOT）经 GET /api/ontology/schema，version ${schema.version}`} />
    </div>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-medium text-ink">{title}</h3>
      {children}
    </section>
  );
}

export function Provenance({ text }: { text: string }) {
  return (
    <p className={clsx('rounded border border-dashed border-line bg-white/60 px-3 py-2 text-xs text-ink-soft')}>
      {text}
    </p>
  );
}
```

- [ ] **Step 4: App.tsx 分发**

import 区加 `import { GovernanceView } from './components/governance/GovernanceView';`；视图链 `view === 'entities'` 分支后加：

```tsx
      ) : view === 'governance' ? (
        <GovernanceView />
```

- [ ] **Step 5: 构建 + web 测试验证**

Run: `npm run build --workspace apps/web && npm run lint`
Expected: build 成功（tsc 严格模式过），lint 无新告警。手动冒烟（可选）：`npm run dev` 访问 `#/governance` 见本体 tab。

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/shell/navigation.ts apps/web/src/App.tsx apps/web/src/components/governance/GovernanceView.tsx apps/web/src/components/governance/OntologyTab.tsx
git commit -m "feat(web): governance view shell with ontology tab (roadmap Item 6)"
```

---

### Task 8: Tab 2 工具面 + Tab 3 权限矩阵

**Files:**
- Create: `apps/web/src/components/governance/ToolsTab.tsx`
- Create: `apps/web/src/components/governance/PermissionsTab.tsx`
- Modify: `apps/web/src/components/governance/GovernanceView.tsx`（两个 null 分支换组件 + import）

**Interfaces:**
- Consumes: Task 6 `fetchToolInventory`/`fetchPermissionSnapshot`/`toolRowFlags`/`permissionMatrixRows`；Task 7 的 `Section`/`Provenance`
- Produces: `<ToolsTab />`、`<PermissionsTab />`

- [ ] **Step 1: ToolsTab**

```tsx
// apps/web/src/components/governance/ToolsTab.tsx
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { clsx } from 'clsx';
import { fetchToolInventory, type ToolInventoryDTO } from '../../api/governance';
import { toolRowFlags } from './governanceModel';
import { Section, Provenance } from './OntologyTab';

/** 治理 Tab 2 工具面：tool-inventory SSOT 视图化 x 注册表实测对比。
 *  deprecated 且仍挂载的工具如实标红呈现（含 removalPlan），不掩饰漂移。 */
export function ToolsTab() {
  const [inv, setInv] = useState<ToolInventoryDTO | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchToolInventory()
      .then((d) => { if (alive) setInv(d); })
      .catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, []);

  if (error) return <div className="rounded-lg border border-line bg-white p-4 text-sm text-danger">{error}</div>;
  if (!inv) return <div className="rounded-lg border border-line bg-white p-4 text-sm text-ink-soft">加载中...</div>;

  return (
    <div className="max-w-6xl space-y-4 pb-2">
      <div className="flex items-center gap-3 text-xs text-ink-soft">
        <span>inventory version {inv.version}</span>
        <span>注册表实测挂载（trader）：{inv.mountedCount} 个</span>
        {(inv.diff.mountedNotInInventory.length > 0 || inv.diff.inventoryNotMounted.length > 0) && (
          <span className="rounded bg-danger/10 px-1.5 py-0.5 text-danger">
            漂移：挂载多出 {inv.diff.mountedNotInInventory.join('、') || '无'}；inventory 缺挂载 {inv.diff.inventoryNotMounted.join('、') || '无'}
          </span>
        )}
      </div>

      <Section title={`工具清单（${inv.tools.length}）`}>
        <div className="space-y-2">
          {inv.tools.map((t) => {
            const flags = toolRowFlags(t);
            return (
              <div key={t.name} className={clsx('rounded-lg border bg-white p-3',
                flags.deprecatedMounted ? 'border-danger/40' : 'border-line')}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm font-medium text-ink">{t.name}</span>
                  <Badge>{t.layer}</Badge>
                  <Badge accent={t.level === 'L2'}>{t.level}</Badge>
                  <Badge accent={t.status === 'deprecated'}>{t.status}</Badge>
                  <Badge>mount: {t.mount}</Badge>
                  <Badge accent={flags.deprecatedMounted}>
                    {t.registry.mounted ? '注册表：已挂载' : '注册表：未挂载'}
                  </Badge>
                  {t.registry.mounted && (
                    <Badge accent={t.registry.needsApproval}>
                      {t.registry.needsApproval ? 'needsApproval（L2 软门控）' : '自动执行'}
                    </Badge>
                  )}
                  {flags.envGated && t.requiresEnv && <Badge>{t.requiresEnv}</Badge>}
                </div>
                <dl className="mt-2 space-y-1 text-xs text-ink-soft">
                  <div><dt className="inline font-medium text-ink">何时用：</dt><dd className="inline"> {t.whenToUse}</dd></div>
                  <div><dt className="inline font-medium text-ink">边界：</dt><dd className="inline"> {t.boundary}</dd></div>
                  <div><dt className="inline font-medium text-ink">存留理由：</dt><dd className="inline"> {t.rationale}</dd></div>
                  {t.removalPlan && (
                    <div className={clsx(flags.deprecatedMounted && 'text-danger')}>
                      <dt className="inline font-medium">移除计划：</dt><dd className="inline"> {t.removalPlan}</dd>
                    </div>
                  )}
                </dl>
              </div>
            );
          })}
        </div>
      </Section>

      <Section title={`removed 黑名单（${inv.removed.length}，防回潮）`}>
        <div className="rounded-lg border border-line bg-white p-3 text-xs text-ink-soft">
          {inv.removed.map((r) => (
            <div key={r.name} className="py-0.5">
              <span className="font-mono text-ink">{r.name}</span>
              {r.mergedInto && <span className="font-mono"> -> {r.mergedInto}</span>}
              <span>：{r.reason}</span>
            </div>
          ))}
        </div>
      </Section>

      <Provenance text={`数据出处：docs/tool-inventory.json（工具面 SSOT, version ${inv.version}）x 角色工具注册表实测挂载（apps/server/src/harness/roleToolRegistry.ts，经 GET /api/tools/inventory）`} />
    </div>
  );
}

function Badge({ children, accent = false }: { children: ReactNode; accent?: boolean }) {
  return (
    <span className={clsx('rounded px-1.5 py-0.5 text-xs',
      accent ? 'bg-amber-100 text-amber-700' : 'bg-surface text-ink-soft')}>
      {children}
    </span>
  );
}
```

- [ ] **Step 2: PermissionsTab**

```tsx
// apps/web/src/components/governance/PermissionsTab.tsx
import { useEffect, useState } from 'react';
import { fetchPermissionSnapshot, type PermissionSnapshotDTO } from '../../api/governance';
import { permissionMatrixRows } from './governanceModel';
import { Section, Provenance } from './OntologyTab';

/** 治理 Tab 3 权限矩阵：L1/L2/L3 x 工具（列来自快照 levels，不硬编码）。 */
export function PermissionsTab() {
  const [snap, setSnap] = useState<PermissionSnapshotDTO | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchPermissionSnapshot()
      .then((s) => { if (alive) setSnap(s); })
      .catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, []);

  if (error) return <div className="rounded-lg border border-line bg-white p-4 text-sm text-danger">{error}</div>;
  if (!snap) return <div className="rounded-lg border border-line bg-white p-4 text-sm text-ink-soft">加载中...</div>;

  const { levels, rows } = permissionMatrixRows(snap);

  return (
    <div className="max-w-6xl space-y-4 pb-2">
      <Section title={`权限矩阵（注册声明 ${rows.length} 条）`}>
        <div className="overflow-x-auto rounded-lg border border-line bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-ink-soft">
                <th className="px-3 py-2 font-medium">工具</th>
                {levels.map((l) => <th key={l} className="px-3 py-2 text-center font-medium">{l}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.toolName} className="border-b border-line/60 last:border-b-0">
                  <td className="px-3 py-1.5 font-mono text-xs text-ink">{r.toolName}</td>
                  {levels.map((l) => (
                    <td key={l} className="px-3 py-1.5 text-center text-xs">
                      {r.level === l
                        ? <span className={l === 'L2' ? 'text-amber-600' : 'text-primary'}>{l}</span>
                        : <span className="text-ink-soft/30">-</span>}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-ink-soft">{snap.note}</p>
      </Section>

      <Provenance text={`数据出处：${snap.source}（经 GET /api/tools/permissions）`} />
    </div>
  );
}
```

- [ ] **Step 3: GovernanceView 接线**

```tsx
import { OntologyTab } from './OntologyTab';
import { ToolsTab } from './ToolsTab';
import { PermissionsTab } from './PermissionsTab';
```

分支体：`{tab === 'tools' && <ToolsTab />}`、`{tab === 'permissions' && <PermissionsTab />}`。

- [ ] **Step 4: 构建 + lint 验证**

Run: `npm run build --workspace apps/web && npm run lint`
Expected: build 成功，lint 无新告警

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/governance/ToolsTab.tsx apps/web/src/components/governance/PermissionsTab.tsx apps/web/src/components/governance/GovernanceView.tsx
git commit -m "feat(web): governance tools-inventory and permission-matrix tabs"
```

---

### Task 9: Tab 4 审批审计

**Files:**
- Create: `apps/web/src/components/governance/ApprovalAuditTab.tsx`
- Modify: `apps/web/src/components/governance/GovernanceView.tsx`（最后一个 null 分支换组件）

**Interfaces:**
- Consumes: Task 6 `fetchApprovalAudit` + `ApprovalAuditFilters`/`ApprovalAuditItemDTO`
- Produces: `<ApprovalAuditTab />`（含 status/toolName/decidedBy/时间窗过滤栏）

- [ ] **Step 1: ApprovalAuditTab**

```tsx
// apps/web/src/components/governance/ApprovalAuditTab.tsx
import { useCallback, useEffect, useState } from 'react';
import { fetchApprovalAudit, type ApprovalAuditItemDTO } from '../../api/governance';
import { Section, Provenance } from './OntologyTab';

const STATUS_OPTIONS = ['all', 'pending', 'approved', 'denied'] as const;

const fmt = (iso: string) => new Date(iso).toLocaleString('zh-CN', { hour12: false });

/** 治理 Tab 4 审批审计：pending_approvals 经 GET /api/approval/list 的
 *  时间/决策人/工具/状态过滤视图（只读，不做审批决策——决策在审批中心）。 */
export function ApprovalAuditTab() {
  const [status, setStatus] = useState<string>('all');
  const [toolName, setToolName] = useState('');
  const [decidedBy, setDecidedBy] = useState('');
  const [createdFrom, setCreatedFrom] = useState('');
  const [createdTo, setCreatedTo] = useState('');
  const [items, setItems] = useState<ApprovalAuditItemDTO[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchApprovalAudit({
        status,
        toolName: toolName.trim() || undefined,
        decidedBy: decidedBy.trim() || undefined,
        createdFrom: createdFrom || undefined,
        createdTo: createdTo || undefined,
        limit: 200,
      });
      setItems(res.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [status, toolName, decidedBy, createdFrom, createdTo]);

  useEffect(() => { void load(); }, [load]);

  const inputCls = 'h-8 rounded border border-line bg-white px-2 text-sm text-ink placeholder:text-ink-soft/60 focus:outline-none focus:ring-1 focus:ring-primary/40';

  return (
    <div className="max-w-6xl space-y-4 pb-2">
      <div className="flex flex-wrap items-center gap-2">
        <select value={status} onChange={(e) => setStatus(e.target.value)}
          className={inputCls + ' text-xs'}>
          {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <input value={toolName} onChange={(e) => setToolName(e.target.value)}
          placeholder="工具名（精确）" className={inputCls + ' w-44 text-xs'} />
        <input value={decidedBy} onChange={(e) => setDecidedBy(e.target.value)}
          placeholder="决策人" className={inputCls + ' w-36 text-xs'} />
        <label className="text-xs text-ink-soft">从
          <input type="datetime-local" value={createdFrom}
            onChange={(e) => setCreatedFrom(e.target.value ? new Date(e.target.value).toISOString() : '')}
            className={inputCls + ' ml-1 text-xs'} />
        </label>
        <label className="text-xs text-ink-soft">到
          <input type="datetime-local" value={createdTo}
            onChange={(e) => setCreatedTo(e.target.value ? new Date(e.target.value).toISOString() : '')}
            className={inputCls + ' ml-1 text-xs'} />
        </label>
        {loading && <span className="text-xs text-ink-soft">加载中...</span>}
        {error && <span className="text-xs text-danger">{error}</span>}
        <span className="ml-auto text-xs text-ink-soft">共 {items.length} 条</span>
      </div>

      <Section title="审批流水">
        <div className="overflow-x-auto rounded-lg border border-line bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-ink-soft">
                <th className="px-3 py-2 font-medium">层级</th>
                <th className="px-3 py-2 font-medium">工具</th>
                <th className="px-3 py-2 font-medium">状态</th>
                <th className="px-3 py-2 font-medium">创建时间</th>
                <th className="px-3 py-2 font-medium">决策人</th>
                <th className="px-3 py-2 font-medium">决策时间</th>
                <th className="px-3 py-2 font-medium">理由</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.id} className="border-b border-line/60 last:border-b-0">
                  <td className="px-3 py-2">
                    <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${it.level === 'L3' ? 'bg-danger/10 text-danger' : 'bg-amber-100 text-amber-700'}`}>
                      {it.level}
                    </span>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-ink">{it.tool_name}</td>
                  <td className="px-3 py-2 text-xs text-ink">{it.status}</td>
                  <td className="px-3 py-2 text-xs text-ink-soft">{fmt(it.created_at)}</td>
                  <td className="px-3 py-2 text-xs text-ink-soft">{it.decided_by ?? '-'}</td>
                  <td className="px-3 py-2 text-xs text-ink-soft">{it.decided_at ? fmt(it.decided_at) : '-'}</td>
                  <td className="max-w-52 truncate px-3 py-2 text-xs text-ink-soft">{it.reason ?? '-'}</td>
                </tr>
              ))}
              {!loading && items.length === 0 && (
                <tr><td colSpan={7} className="px-3 py-8 text-center text-sm text-ink-soft">无匹配票据</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Section>

      <Provenance text="数据出处：pending_approvals 审批表（sessionStore 双后端 SSOT，经 GET /api/approval/list；审批决策操作在审批中心进行，本视图只读）" />
    </div>
  );
}
```

- [ ] **Step 2: GovernanceView 接线**

```tsx
import { ApprovalAuditTab } from './ApprovalAuditTab';
```

`{tab === 'approvals' && <ApprovalAuditTab />}`。

- [ ] **Step 3: 构建 + lint + web 测试**

Run: `npm run build --workspace apps/web && npm run lint && npm test --workspace apps/web`
Expected: 全绿

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/governance/ApprovalAuditTab.tsx apps/web/src/components/governance/GovernanceView.tsx
git commit -m "feat(web): governance approval-audit tab with time/decider/tool/status filters"
```

---

### Task 10: 全量验证 + merge main + push

**Files:** 无新改动（验证 + 集成）

- [ ] **Step 1: 仓库根全量验证**

Run: `npm run build && npm run lint && npm test`
Expected: build（web tsc -b + vite、server tsc）、oxlint、server+web vitest 全绿；toolInventory.test.ts 双射门禁绿（未加注册表工具）

- [ ] **Step 2: 合回 main（仓库惯例）**

```bash
git fetch origin main
git merge origin/main   # 若 merge 触碰代码则重跑 Step 1
git push origin HEAD:PengYip/governance-admin
git push origin HEAD:main   # 触发 CI + CD（部署 10.10.0.2）
```

- [ ] **Step 3: 验收对照（自查）**

- 四个 tab 数据分别来自 `GET /api/ontology/schema` / `docs/tool-inventory.json`×注册表 / `permissionGate` / 审批表，页面均有「数据出处」标注
- 零硬编码业务字段（枚举/实体/关系/工具/权限全部接口驱动）
- `query_orders`/`cross_check`/`verify_document_fields`/`extract_fields` 在工具 tab 以「deprecated + 已挂载 + removalPlan」红标如实呈现
- 全部只读：四个 tab 无任何写操作入口；`/api/tools/*` 未进 agent 工具注册表与 inventory
- 未动 Item 7（无 overview 相关代码）
