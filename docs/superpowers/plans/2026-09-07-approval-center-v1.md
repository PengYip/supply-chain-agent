# 审批中心 v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 跨会话审批工作台（列表/详情/带理由决策/副作用审计/会话跳转），预留飞书审批适配接口。

**Architecture:** `pending_approvals` 是票据 SSOT（扩列不新建表）；审批中心是通用工作流壳，payload 透传渲染、不感知业务实体；决策复用既有 `POST /api/approval/callback`；ApprovalChannel 接口隔离外部审批（local 实现 + env 开关）。

**Tech Stack:** Hono + zod（apps/server）、better-sqlite3 / node-postgres 双后端（sessionStore facade）、React 19 + Tailwind（apps/web）、vitest（`app.request` + `appAs` 模式）。

**Spec:** `docs/superpowers/specs/2026-09-07-approval-center-v1.md`（含现状基线与设计原则，实施前必读）

## Global Constraints

- 代码零 emoji（repo 约定）；TS 严格模式，`tsc` 必须过（build = `tsc -b`）
- 双后端列对列镜像：SQLite raw DDL（PRAGMA 守卫幂等迁移）与 Postgres `ADD COLUMN IF NOT EXISTS`，JSON 一律 TEXT
- AI SDK 6：工具 schema 字段名是 `inputSchema`；L2 恢复用瞬态 tool-approval-response，勿改 callback 既有 404/403/409 语义
- 认证：路由挂载已由 index.ts:117 `requireAuth` 覆盖 `/api/approval/*`；handler 内保留 `c.get('user')` 防御检查（直挂测试）
- 测试模式照抄 `test/harness/approvalCallbackBackground.test.ts`（`appAs(userId)` + `vi.hoisted` resolve-holder + 共享文件库 unique id）
- 每个任务完成即 commit；验证顺序统一为 `npm run build && npm run lint && npm test`（仓库根目录执行）
- 本计划不改 tool-inventory.json（无新工具），不引入新 npm 依赖

---

### Task 1: pending_approvals 扩列 + resolveApproval 决策记录

**Files:**
- Modify: `apps/server/src/harness/sessionStore.ts`（类型 + SessionStoreBackend 接口）
- Modify: `apps/server/src/harness/sessionStoreSqlite.ts`（DDL + 迁移 + resolveApproval）
- Modify: `apps/server/src/harness/sessionStorePostgres.ts`（ensureSessionTables + resolveApproval）
- Test: `apps/server/test/harness/approvalDecisionFields.test.ts`

**Interfaces:**
- Produces: `PendingApprovalRow` 新增 `decided_by?: string | null; decided_at?: string | null; reason?: string | null; side_effect_results?: string | null`
- Produces: `resolveApproval(id: string, status: 'approved' | 'denied', decision?: { decidedBy?: string | null; reason?: string | null }): Promise<void>`（第三参可选，既有两参调用不破坏）

- [ ] **Step 1: 写失败测试**

先打开 `test/harness/approvalCallbackBackground.test.ts:56-90`，把其中 `createSession` / `recordPendingApproval` / `getPending` 的调用形态逐字抄进 fixture（本文件共享同一个 agent.db，用 unique id 前缀防串）。

```ts
// apps/server/test/harness/approvalDecisionFields.test.ts
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';

const { createSession, recordPendingApproval, resolveApproval, getPending } =
  await import('../../src/harness/sessionStore.js');

const uid = (p: string) => `${p}-${randomUUID().slice(0, 8)}`;

describe('approval decision fields', () => {
  it('resolveApproval 记录决策人与理由', async () => {
    const sid = uid('sess');
    // createSession 签名以 sessionStore.ts facade 为准（见 Step 3 前置检查）
    await createSession({ id: sid, role: 'trader' } as never);

    const approvalId = `ap_${uid('dec')}`;
    await recordPendingApproval({
      sessionId: sid,
      level: 'L2',
      toolName: 'bind_document',
      toolCallId: `call_${uid('c')}`,
      input: { contractNo: 'XYXD-2209-094' },
      approvalId,
    });

    const row0 = await getPending(approvalId);
    expect(row0?.status).toBe('pending');
    expect(row0?.decided_by ?? null).toBeNull();

    await resolveApproval(row0!.id, 'approved', { decidedBy: 'u1', reason: '已核对合同' });

    const row = await getPending(approvalId);
    expect(row?.status).toBe('approved');
    expect(row?.decided_by).toBe('u1');
    expect(row?.reason).toBe('已核对合同');
    expect(row?.decided_at).toBeTruthy();
  });

  it('无 decision 参数时新列保持 null（向后兼容）', async () => {
    const sid = uid('sess');
    await createSession({ id: sid, role: 'trader' } as never);
    const ticketId = `ESC-${uid('t')}`;
    await recordPendingApproval({
      sessionId: sid, level: 'L3', toolName: 'escalate_to_human',
      input: { issue: '付款金额超限' }, ticketId,
    });
    const row0 = await getPending(ticketId)!;
    await resolveApproval(row0.id, 'denied');
    const row = await getPending(ticketId)!;
    expect(row.status).toBe('denied');
    expect(row.decided_by ?? null).toBeNull();
  });
});
```

注意：`getPending` 现有实现按 `ticket_id OR approval_id` 查（approvalCallback.ts:70 依赖此语义），返回行需含新列。若 fixture 报 createSession 参数不匹配，按 facade 实际签名改入参，断言不变。

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/harness/approvalDecisionFields.test.ts`
Expected: FAIL（`decided_by` undefined / TS 报 PendingApprovalRow 无该字段——测试用 `row?.decided_by` 会在断言处失败）

- [ ] **Step 3: 实现**

前置检查：`grep -n "createSession" apps/server/src/harness/sessionStore.ts` 与 `grep -n "resolveApproval" apps/server/src/harness/sessionStore*.ts` 确认 facade 签名与两个后端实现位置。

3a. `sessionStore.ts`：`PendingApprovalRow`（:62-73）追加四个可选字段；`SessionStoreBackend` 接口的 `resolveApproval` 加可选第三参 `decision?: { decidedBy?: string | null; reason?: string | null }`。

3b. `sessionStoreSqlite.ts`：
- `CREATE TABLE IF NOT EXISTS pending_approvals`（:91-103）尾部加四列：`decided_by TEXT, decided_at TEXT, reason TEXT, side_effect_results TEXT`
- 紧随既有 Phase-2 迁移块（:126-129 同款 try/catch 竞态守卫）新增：

```ts
// Approval-center v1: decision/audit columns on pre-existing dev DBs.
try {
  const cols = db.prepare('PRAGMA table_info(pending_approvals)').all() as { name: string }[];
  const have = new Set(cols.map((c) => c.name));
  const add: string[] = [];
  if (!have.has('decided_by')) add.push('decided_by TEXT');
  if (!have.has('decided_at')) add.push('decided_at TEXT');
  if (!have.has('reason')) add.push('reason TEXT');
  if (!have.has('side_effect_results')) add.push('side_effect_results TEXT');
  for (const col of add) db.exec(`ALTER TABLE pending_approvals ADD COLUMN ${col}`);
} catch { /* 列已存在（vitest 并发竞态），忽略 */ }
```

- resolveApproval 实现改为：

```ts
async resolveApproval(id, status, decision) {
  withBusyRetry(() =>
    db.prepare(
      `UPDATE pending_approvals
         SET status = ?, decided_by = ?, decided_at = ?, reason = ?
       WHERE id = ?`,
    ).run(status, decision?.decidedBy ?? null, decision ? new Date().toISOString() : null,
          decision?.reason ?? null, id),
  );
},
```

（`withBusyRetry` 以文件内实际的 busy 重试包装函数名为准，:55-67 附近。）

3c. `sessionStorePostgres.ts`：`ensureSessionTables` 内追加：

```sql
ALTER TABLE pending_approvals ADD COLUMN IF NOT EXISTS decided_by TEXT;
ALTER TABLE pending_approvals ADD COLUMN IF NOT EXISTS decided_at TEXT;
ALTER TABLE pending_approvals ADD COLUMN IF NOT EXISTS reason TEXT;
ALTER TABLE pending_approvals ADD COLUMN IF NOT EXISTS side_effect_results TEXT;
```

`createAgentSessionStore` 的 resolveApproval UPDATE 同步镜像 SQLite 语义。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test --workspace apps/server -- test/harness/approvalDecisionFields.test.ts`
Expected: PASS (2)

- [ ] **Step 5: 全量回归 + commit**

Run: `npm run build && npm run lint && npm test`
Expected: 全绿（既有 resolveApproval 两参调用不受影响）

```bash
git checkout -b approval-center-v1
git add apps/server/src/harness/sessionStore.ts apps/server/src/harness/sessionStoreSqlite.ts apps/server/src/harness/sessionStorePostgres.ts apps/server/test/harness/approvalDecisionFields.test.ts
git commit -m "feat(approval): decision audit columns on pending_approvals (both backends)"
```

---

### Task 2: appendSideEffect 存储 helper

**Files:**
- Modify: `apps/server/src/harness/sessionStore.ts` / `sessionStoreSqlite.ts` / `sessionStorePostgres.ts`
- Test: `apps/server/test/harness/approvalSideEffects.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `side_effect_results` 列
- Produces: `export interface SideEffect { target: string; action: string; ok: boolean; detail: string; at: string }`（sessionStore.ts）
- Produces: `appendSideEffect(toolCallId: string, effect: SideEffect): Promise<void>`（无匹配行 no-op 不抛错）

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/test/harness/approvalSideEffects.test.ts
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';

const { createSession, recordPendingApproval, getPending, appendSideEffect } =
  await import('../../src/harness/sessionStore.js');
import type { SideEffect } from '../../src/harness/sessionStore.js';

const uid = (p: string) => `${p}-${randomUUID().slice(0, 8)}`;
const fx = (n: number): SideEffect => ({
  target: `toolCall:call_${n}`, action: 'bind_document', ok: true,
  detail: `{"n":${n}}`, at: new Date().toISOString(),
});

describe('appendSideEffect', () => {
  it('按 toolCallId 追加并可读回', async () => {
    const sid = uid('sess');
    await createSession({ id: sid, role: 'trader' } as never);
    const toolCallId = `call_${uid('c')}`;
    const approvalId = `ap_${uid('a')}`;
    await recordPendingApproval({ sessionId: sid, level: 'L2', toolName: 'bind_document',
      toolCallId, input: {}, approvalId });

    await appendSideEffect(toolCallId, fx(1));
    await appendSideEffect(toolCallId, fx(2));

    const row = await getPending(approvalId)!;
    const arr = JSON.parse(row.side_effect_results!) as SideEffect[];
    expect(arr).toHaveLength(2);
    expect(arr[0].action).toBe('bind_document');
    expect(arr[1].target).toContain('call_2');
  });

  it('未知 toolCallId no-op', async () => {
    await expect(appendSideEffect('call_nonexistent', fx(9))).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/harness/approvalSideEffects.test.ts`
Expected: FAIL（appendSideEffect 未导出）

- [ ] **Step 3: 实现（双后端）**

接口加进 `SessionStoreBackend`；SQLite 实现：

```ts
async appendSideEffect(toolCallId: string, effect: SideEffect) {
  withBusyRetry(() => {
    const row = db
      .prepare('SELECT id, side_effect_results FROM pending_approvals WHERE tool_call_id = ?')
      .get(toolCallId) as { id: string; side_effect_results: string | null } | undefined;
    if (!row) return; // no-op：票据不存在/已清理
    const arr: SideEffect[] = row.side_effect_results
      ? (() => { try { return JSON.parse(row.side_effect_results) as SideEffect[]; } catch { return []; } })()
      : [];
    arr.push(effect);
    db.prepare('UPDATE pending_approvals SET side_effect_results = ? WHERE id = ?')
      .run(JSON.stringify(arr), row.id);
  });
},
```

Postgres 镜像（SELECT/UPDATE 换 pool.query，竞态可容忍丢一条审计但不抛错：UPDATE 用 `WHERE id = $1` 即可）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test --workspace apps/server -- test/harness/approvalSideEffects.test.ts`
Expected: PASS (2)

- [ ] **Step 5: commit**

```bash
git add apps/server/src/harness/sessionStore.ts apps/server/src/harness/sessionStoreSqlite.ts apps/server/src/harness/sessionStorePostgres.ts apps/server/test/harness/approvalSideEffects.test.ts
git commit -m "feat(approval): appendSideEffect audit trail keyed by tool_call_id"
```

---

### Task 3: listApprovals + getApprovalById

**Files:**
- Modify: `apps/server/src/harness/sessionStore.ts` / 两个后端
- Test: `apps/server/test/harness/approvalList.test.ts`

**Interfaces:**
- Produces:
```ts
export type ApprovalListItem = PendingApprovalRow & { session_user_id: string | null };
listApprovals(filter: { userId: string; status?: 'pending' | 'approved' | 'denied' | 'all'; limit?: number }): Promise<ApprovalListItem[]>;
getApprovalById(id: string): Promise<PendingApprovalRow | null>;
```

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/test/harness/approvalList.test.ts
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';

const { createSession, recordPendingApproval, resolveApproval, listApprovals, getPending } =
  await import('../../src/harness/sessionStore.js');
const { listApprovals: _l, getApprovalById } = await import('../../src/harness/sessionStore.js');

const uid = (p: string) => `${p}-${randomUUID().slice(0, 8)}`;

// fixture：先确认 createSession 如何携带 userId（grep createSession 的 facade 签名；
// 若 userId 是独立参数或第互参，按实际调整，断言不变）
async function seed(userId: string | null) {
  const sid = uid('sess');
  await createSession({ id: sid, role: 'trader' } as never, userId as never);
  const approvalId = `ap_${uid('a')}`;
  await recordPendingApproval({ sessionId: sid, level: 'L2', toolName: 'bind_document',
    toolCallId: `call_${uid('c')}`, input: {}, approvalId });
  return { sid, approvalId };
}

describe('listApprovals ownership + filter', () => {
  it('只看到本人与 legacy(NULL) 会话的票据', async () => {
    const mine = await seed('u1');
    await seed('u2');          // 他人
    await seed(null);          // legacy

    const items = await listApprovals({ userId: 'u1', status: 'all', limit: 50 });
    const ids = items.map((i) => i.approval_id);
    expect(ids).toContain(mine.approvalId);
    expect(items.filter((i) => i.session_user_id === 'u2')).toHaveLength(0);
  });

  it('status 过滤 pending', async () => {
    const mine = await seed('u1');
    const row = await getPending(mine.approvalId)!;
    await resolveApproval(row.id, 'approved', { decidedBy: 'u1' });
    const pending = await listApprovals({ userId: 'u1', status: 'pending' });
    expect(pending.map((i) => i.approval_id)).not.toContain(mine.approvalId);
    const done = await listApprovals({ userId: 'u1', status: 'approved' });
    expect(done.map((i) => i.approval_id)).toContain(mine.approvalId);
  });
});

describe('getApprovalById', () => {
  it('按主键取行（含任意状态）', async () => {
    const mine = await seed('u1');
    const row = await getApprovalById((await getPending(mine.approvalId))!.id);
    expect(row?.approval_id).toBe(mine.approvalId);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/harness/approvalList.test.ts`
Expected: FAIL（listApprovals/getApprovalById 未导出）

- [ ] **Step 3: 实现（双后端镜像）**

```ts
async listApprovals({ userId, status = 'all', limit = 50 }) {
  const rows = withBusyRetry(() =>
    db.prepare(
      `SELECT pa.*, s.user_id AS session_user_id
         FROM pending_approvals pa
         JOIN sessions s ON s.id = pa.session_id
        WHERE (s.user_id = ? OR s.user_id IS NULL)
          AND (? = 'all' OR pa.status = ?)
        ORDER BY pa.created_at DESC
        LIMIT ?`,
    ).all(userId, status, status, limit),
  );
  return rows as ApprovalListItem[];
},
async getApprovalById(id: string) {
  return withBusyRetry(() =>
    db.prepare('SELECT * FROM pending_approvals WHERE id = ?').get(id),
  ) as Promise<PendingApprovalRow | null>;
},
```

Postgres：同 SQL，参数 $1..$4。

- [ ] **Step 4: 跑测试确认通过 + commit**

Run: `npm test --workspace apps/server -- test/harness/approvalList.test.ts`
Expected: PASS (3)

```bash
git add apps/server/src/harness/sessionStore.ts apps/server/src/harness/sessionStoreSqlite.ts apps/server/src/harness/sessionStorePostgres.ts apps/server/test/harness/approvalList.test.ts
git commit -m "feat(approval): cross-session listApprovals with ownership filter"
```

---

### Task 4: GET /api/approval/list 与 GET /api/approval/:id

**Files:**
- Modify: `apps/server/src/routes/approvalCallback.ts`（同一 Hono 子应用，index.ts 挂载不变）
- Test: `apps/server/test/harness/approvalListRoutes.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `listApprovals/getApprovalById`、既有 `sessionBelongsTo`
- Produces: `GET /api/approval/list?status=&limit=` → `{ items: (ApprovalListItem & { sideEffects: SideEffect[] | null })[] }`；`GET /api/approval/:id` → `{ item: PendingApprovalRow & { sideEffects: SideEffect[] | null } }`

- [ ] **Step 1: 写失败测试**

fixture 完整照抄 approvalCallbackBackground.test.ts:1-45（含 appAs / post helper 改 get）。

```ts
// apps/server/test/harness/approvalListRoutes.test.ts
// 头部 = approvalCallbackBackground.test.ts:1-28 的 imports + appAs（:30-38），另加：
const { createSession, recordPendingApproval } = await import('../../src/harness/sessionStore.js');

const get = (app: Hono<AuthEnv>, path: string) =>
  app.request(`http://test/api${path}`, { method: 'GET' });

describe('GET /api/approval/list', () => {
  it('200 返回本人 items 且 sideEffects 已解析', async () => {
    const sid = uid('sess');
    await createSession({ id: sid, role: 'trader' } as never, 'u1' as never);
    const approvalId = `ap_${uid('a')}`;
    await recordPendingApproval({ sessionId: sid, level: 'L3', toolName: 'escalate_to_human',
      input: { issue: 'x' }, ticketId: `ESC-${uid('t')}` });
    const res = await get(appAs('u1'), '/approval/list?status=pending');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items[0]).toHaveProperty('level');
    expect(body.items[0]).toHaveProperty('sideEffects');
  });

  it('limit/status 非法 400', async () => {
    const res = await get(appAs('u1'), '/approval/list?limit=abc');
    expect(res.status).toBe(400);
  });
});

describe('GET /api/approval/:id', () => {
  it('他人票据 404（防枚举）', async () => {
    const sid = uid('sess');
    await createSession({ id: sid, role: 'trader' } as never, 'u2' as never);
    const approvalId = `ap_${uid('a')}`;
    await recordPendingApproval({ sessionId: sid, level: 'L2', toolName: 'bind_document',
      toolCallId: `call_${uid('c')}`, input: {}, approvalId });
    const row = await getPending(approvalId);
    const res = await get(appAs('u1'), `/approval/${row!.id}`);
    expect(res.status).toBe(404);
  });

  it('未知 id 404', async () => {
    const res = await get(appAs('u1'), '/approval/nonexistent');
    expect(res.status).toBe(404);
  });
});
```

（`getPending` import 加进头部；fixture 里 approvalId 变量在 L3 用例中未直接断言属正常——L3 走 ticket_id。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/harness/approvalListRoutes.test.ts`
Expected: FAIL（404：路由不存在，Hono 默认 404）

- [ ] **Step 3: 实现（approvalCallback.ts 追加）**

```ts
const ListQuerySchema = z.object({
  status: z.enum(['pending', 'approved', 'denied', 'all']).default('all'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

function parseSideEffects(raw: string | null | undefined): SideEffect[] | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as SideEffect[]; } catch { return null; }
}

approvalCallback.get('/approval/list', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const q = ListQuerySchema.safeParse(c.req.query());
  if (!q.success) return c.json({ error: 'Invalid query', detail: q.error.flatten() }, 400);
  const items = await listApprovals({ userId: user.id, ...q.data });
  return c.json({ items: items.map((i) => ({ ...i, sideEffects: parseSideEffects(i.side_effect_results) })) });
});

approvalCallback.get('/approval/:id', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const row = await getApprovalById(c.req.param('id'));
  if (!row) return c.json({ error: 'approval not found' }, 404);
  if (!(await sessionBelongsTo(row.session_id, user.id))) {
    return c.json({ error: 'approval not found' }, 404); // 防枚举：与不存在同响应
  }
  return c.json({ item: { ...row, sideEffects: parseSideEffects(row.side_effect_results) } });
});
```

顶部 import 增加 `listApprovals, getApprovalById` 与 `type SideEffect`（来自 sessionStore.js）。

- [ ] **Step 4: 跑测试确认通过 + 全量回归 + commit**

Run: `npm test --workspace apps/server -- test/harness/approvalListRoutes.test.ts && npm run build && npm run lint && npm test`
Expected: PASS + 全绿

```bash
git add apps/server/src/routes/approvalCallback.ts apps/server/test/harness/approvalListRoutes.test.ts
git commit -m "feat(approval): GET /api/approval/list and /:id endpoints"
```

---

### Task 5: callback 落 decided_by / reason

**Files:**
- Modify: `apps/server/src/routes/approvalCallback.ts:164`
- Test: `apps/server/test/harness/approvalCallbackDecision.test.ts`

**Interfaces:**
- Consumes: Task 1 的三参 resolveApproval

- [ ] **Step 1: 写失败测试**

头部照抄 approvalCallbackBackground.test.ts:1-45（vi.mock runSession resolve-holder + appAs + post + session fixture）。

```ts
// 核心用例（fixture 造 L2 pending 后）：
it('批准时记录决策人与理由', async () => {
  const { sid, approvalId, rowId } = await seedL2Pending('u1'); // 本地 helper：createSession+recordPendingApproval
  const res = await post(appAs('u1'), { approvalId, approved: true, reason: '已核对附件' });
  expect(res.status).toBe(200);
  const row = await getPending(approvalId);
  expect(row?.decided_by).toBe('u1');
  expect(row?.reason).toBe('已核对附件');
  expect(row?.decided_at).toBeTruthy();
});
it('拒绝同样留痕', async () => {
  const { approvalId } = await seedL2Pending('u1');
  const res = await post(appAs('u1'), { approvalId, approved: false, reason: '金额不符' });
  expect(res.status).toBe(200);
  const row = await getPending(approvalId);
  expect(row?.status).toBe('denied');
  expect(row?.reason).toBe('金额不符');
});
```

（seedL2Pending 内部 = Task 4 测试的 seed 模式；runSession 被 stub 阻塞不影响断言。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/harness/approvalCallbackDecision.test.ts`
Expected: FAIL（decided_by 为 null）

- [ ] **Step 3: 实现（一行改动 + import）**

approvalCallback.ts:164 改为：

```ts
await resolveApproval(pending.id, approved ? 'approved' : 'denied', {
  decidedBy: user.id,
  reason: reason ?? null,
});
```

- [ ] **Step 4: 跑测试确认通过 + commit**

Run: `npm test --workspace apps/server -- test/harness/approvalCallbackDecision.test.ts && npm test --workspace apps/server -- test/harness/approvalCallbackBackground.test.ts`
Expected: 全 PASS（既有回调行为不回归）

```bash
git add apps/server/src/routes/approvalCallback.ts apps/server/test/harness/approvalCallbackDecision.test.ts
git commit -m "feat(approval): persist decider and reason on callback resolution"
```

---

### Task 6: ApprovalChannel 适配层（local 实现 + env + 挂点）

**Files:**
- Create: `apps/server/src/harness/approvalChannel.ts`
- Modify: `apps/server/src/env.ts`（APPROVAL_CHANNEL）
- Modify: `apps/server/src/harness/agent.ts`（L2 记录后通知）、`apps/server/src/tools/hitl.ts`（L3 记录后通知）、`apps/server/src/routes/approvalCallback.ts`（resolve 后通知）
- Test: `apps/server/test/harness/approvalChannel.test.ts`

**Interfaces:**
- Produces:
```ts
export interface ApprovalChannel {
  readonly name: string;
  onTicketCreated(row: PendingApprovalRow): Promise<void>;
  onTicketResolved(row: PendingApprovalRow): Promise<void>;
}
export function getApprovalChannel(): ApprovalChannel;
export function notifyApprovalCreated(row: PendingApprovalRow): Promise<void>; // 内部 catch，永不抛
export function notifyApprovalResolved(row: PendingApprovalRow): Promise<void>;
export function __setApprovalChannelForTests(ch?: ApprovalChannel): void; // 测试注入
```

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/test/harness/approvalChannel.test.ts
import { describe, it, expect, vi } from 'vitest';

const { notifyApprovalCreated, notifyApprovalResolved, getApprovalChannel, __setApprovalChannelForTests } =
  await import('../../src/harness/approvalChannel.js');

const row = { id: 'r1', session_id: 's1', level: 'L2', tool_name: 'bind_document',
  tool_call_id: 'c1', input_json: '{}', ticket_id: null, approval_id: 'a1',
  status: 'pending', created_at: new Date().toISOString() } as never;

describe('approvalChannel', () => {
  it('默认 local 通道', () => {
    expect(getApprovalChannel().name).toBe('local');
  });
  it('通道抛错时 notify 吞掉不外抛', async () => {
    __setApprovalChannelForTests({
      name: 'boom',
      onTicketCreated: async () => { throw new Error('x'); },
      onTicketResolved: async () => { throw new Error('x'); },
    });
    await expect(notifyApprovalCreated(row)).resolves.toBeUndefined();
    await expect(notifyApprovalResolved(row)).resolves.toBeUndefined();
    __setApprovalChannelForTests(undefined);
  });
  it('通知正常通道', async () => {
    const spy = vi.fn();
    __setApprovalChannelForTests({ name: 'spy', onTicketCreated: spy, onTicketResolved: spy });
    await notifyApprovalCreated(row);
    expect(spy).toHaveBeenCalledWith(row);
    __setApprovalChannelForTests(undefined);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/harness/approvalChannel.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// apps/server/src/harness/approvalChannel.ts
// 外部审批适配层 seam（spec §7）。v1 仅 local：结构化日志，无外部行为。
// 飞书审批接入点：新增 LarkChannel 实现本接口，在 getApprovalChannel 按
// env.APPROVAL_CHANNEL 分发；callback 端点的 ticketId/approvalId 二选一语义
// 天然兼容外部审批回调。
import { env } from '../env.js';
import type { PendingApprovalRow } from './sessionStore.js';

export interface ApprovalChannel {
  readonly name: string;
  onTicketCreated(row: PendingApprovalRow): Promise<void>;
  onTicketResolved(row: PendingApprovalRow): Promise<void>;
}

const localChannel: ApprovalChannel = {
  name: 'local',
  async onTicketCreated(row) {
    console.log(JSON.stringify({ event: 'approval_ticket_created', channel: 'local',
      id: row.id, level: row.level, tool: row.tool_name, sessionId: row.session_id }));
  },
  async onTicketResolved(row) {
    console.log(JSON.stringify({ event: 'approval_ticket_resolved', channel: 'local',
      id: row.id, status: row.status }));
  },
};

let override: ApprovalChannel | undefined;
export function __setApprovalChannelForTests(ch?: ApprovalChannel) { override = ch; }

export function getApprovalChannel(): ApprovalChannel {
  if (override) return override;
  const configured = env.APPROVAL_CHANNEL ?? 'local';
  if (configured !== 'local') {
    console.warn(JSON.stringify({ event: 'approval_channel_unknown_fallback', configured }));
  }
  return localChannel;
}

export async function notifyApprovalCreated(row: PendingApprovalRow): Promise<void> {
  try { await getApprovalChannel().onTicketCreated(row); }
  catch (e) { console.warn(JSON.stringify({ event: 'approval_channel_notify_failed', phase: 'created', msg: String(e) })); }
}
export async function notifyApprovalResolved(row: PendingApprovalRow): Promise<void> {
  try { await getApprovalChannel().onTicketResolved(row); }
  catch (e) { console.warn(JSON.stringify({ event: 'approval_channel_notify_failed', phase: 'resolved', msg: String(e) })); }
}
```

env.ts：在 optional 段（找既有 optional 字段分组）加：

```ts
/** 审批通知通道：local（默认，仅日志）| lark（预留，未实现时回退 local） */
APPROVAL_CHANNEL: z.string().optional(),
```

挂点（三处，均 fire-and-forget）：
1. `agent.ts` `recordL2PendingFromResponse`（:291-331）循环内 recordPendingApproval 之后：`const createdRow = await getPending(approvalId); if (createdRow) void notifyApprovalCreated(createdRow);`
2. `tools/hitl.ts`（:43-71）L3 recordPendingApproval 之后：`const createdRow = await getPending(ticketId); if (createdRow) void notifyApprovalCreated(createdRow);`
3. `approvalCallback.ts` resolveApproval（Task 5 改后那行）之后：`void notifyApprovalResolved({ ...pending, status: approved ? 'approved' : 'denied' });`

- [ ] **Step 4: 跑测试确认通过 + 全量回归 + commit**

Run: `npm test --workspace apps/server -- test/harness/approvalChannel.test.ts && npm run build && npm run lint && npm test`
Expected: PASS + 全绿

```bash
git add apps/server/src/harness/approvalChannel.ts apps/server/src/env.ts apps/server/src/harness/agent.ts apps/server/src/tools/hitl.ts apps/server/src/routes/approvalCallback.ts apps/server/test/harness/approvalChannel.test.ts
git commit -m "feat(approval): ApprovalChannel seam with local channel + env switch"
```

---

### Task 7: L2 批准后工具执行自动记录副作用

**Files:**
- Modify: `apps/server/src/harness/agent.ts`（buildGatedTools, :160-181）
- Test: `apps/server/test/harness/approvalSideEffectWire.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `appendSideEffect`
- Produces: needsApproval 工具 execute 执行后按 `options.toolCallId` 自动落一条 SideEffect（deny 不执行 execute，天然不记录）

- [ ] **Step 1: 前置检查（写测试前）**

Run: `grep -n "export function buildGatedTools\|export const buildGatedTools" apps/server/src/harness/agent.ts` 与 `grep -rn "toolCallId" apps/server/src/tools/*.ts | head -5`
确认：buildGatedTools 是否可独立 import；AI SDK 6 execute 的第二参确实携带 `toolCallId`（v6 ToolExecuteOptions）。若 buildGatedTools 未导出，加 `export`。

- [ ] **Step 2: 写失败测试**

```ts
// apps/server/test/harness/approvalSideEffectWire.test.ts
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';

const { buildGatedTools } = await import('../../src/harness/agent.js');
const { createSession, recordPendingApproval, getPending } = await import('../../src/harness/sessionStore.js');

const uid = (p: string) => `${p}-${randomUUID().slice(0, 8)}`;

describe('L2 execute side-effect wire', () => {
  it('批准后的 execute 记录副作用（按 toolCallId）', async () => {
    // 造一条已批准的 L2 pending 行
    const sid = uid('sess');
    await createSession({ id: sid, role: 'trader' } as never);
    const toolCallId = `call_${uid('c')}`;
    const approvalId = `ap_${uid('a')}`;
    await recordPendingApproval({ sessionId: sid, level: 'L2', toolName: 'bind_document',
      toolCallId, input: {}, approvalId });
    await resolveApprovalForTest(approvalId); // helper: getPending→resolveApproval(...,'approved')

    const tools = buildGatedTools(/* 按 agent.ts 实际入参：工具定义数组+权限映射，照抄 :160 调用点 */);
    const t = tools.find((x) => (x as { name?: string }).name === 'bind_document');
    expect(t).toBeTruthy();

    await (t as { execute: (i: unknown, o: { toolCallId: string }) => Promise<unknown> })
      .execute({}, { toolCallId });

    const row = await getPending(approvalId)!;
    const arr = JSON.parse(row.side_effect_results!) as Array<{ action: string; ok: boolean }>;
    expect(arr).toHaveLength(1);
    expect(arr[0].action).toBe('bind_document');
    expect(arr[0].ok).toBe(true);
  });
});
```

（buildGatedTools 入参以 :160-181 真实签名为准组装；若它内部读取 roleToolRegistry，则照抄 runSession 的调用形态。）

- [ ] **Step 3: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/harness/approvalSideEffectWire.test.ts`
Expected: FAIL（side_effect_results 为 null）

- [ ] **Step 4: 实现（agent.ts buildGatedTools 内）**

```ts
// 在 stamping needsApproval 的同一分支里，包装 execute：
if (needsApproval && typeof def.execute === 'function') {
  const origExecute = def.execute;
  def.execute = async (input: unknown, options: { toolCallId?: string }) => {
    const output = await origExecute(input, options as never);
    const callId = options?.toolCallId;
    if (callId) {
      let detail = '';
      try { detail = JSON.stringify(output).slice(0, 500); }
      catch { detail = String(output).slice(0, 500); }
      void appendSideEffect(callId, {
        target: `toolCall:${callId}`, action: def.name ?? name, ok: true,
        detail, at: new Date().toISOString(),
      }).catch(() => { /* 审计失败不影响业务执行 */ });
    }
    return output;
  };
}
```

（变量名 `def/name/needsApproval` 对齐 :160-181 实际代码；顶部 import `appendSideEffect`。注释说明：needsApproval 工具仅批准后才会进 execute（deny 走 execution-denied），故此处即"已批准执行"审计点。）

- [ ] **Step 5: 跑测试确认通过 + 全量回归 + commit**

Run: `npm test --workspace apps/server -- test/harness/approvalSideEffectWire.test.ts && npm run build && npm run lint && npm test`
Expected: PASS + 全绿（approvalResume.runtime.test.ts 不回归——wrapper 透传返回值）

```bash
git add apps/server/src/harness/agent.ts apps/server/test/harness/approvalSideEffectWire.test.ts
git commit -m "feat(approval): auto side-effect audit for approved L2 tool executions"
```

---

### Task 8: 前端导航 + 审批中心列表页

**Files:**
- Modify: `apps/web/src/components/shell/navigation.ts`（ViewId + NAV_ITEMS）
- Modify: `apps/web/src/App.tsx`（视图分发，:288-322 区域）
- Create: `apps/web/src/components/approval/ApprovalCenterView.tsx`

**Interfaces:**
- Produces: hash 路由 `#/approvals`；组件内部自管 fetch/轮询，props 与相邻视图（如 Bindings）保持一致（Step 1 确认是否需要传参）

- [ ] **Step 1: 前置检查**

Run: 打开 `apps/web/src/App.tsx:280-325`，记录既有视图 case 的组件调用形态（是否传 props）；打开任一已有视图（如 Bindings 视图组件）记录卡片/列表的 Tailwind 类名惯例（圆角、边框、灰底等级），下述代码中的类名以其为准微调。

- [ ] **Step 2: navigation.ts 改动**

```ts
// ViewId 联合类型中 'chat' 后插入 'approvals'
// lucide-react import 增加 ClipboardCheck
{ id: 'approvals', label: '审批中心', description: 'L2/L3 审批待办与历史', icon: ClipboardCheck, group: 'work', enabled: true },
```

- [ ] **Step 3: ApprovalCenterView.tsx（列表 + tab + 10s 轮询 + 选中态）**

```tsx
// apps/web/src/components/approval/ApprovalCenterView.tsx
import { useCallback, useEffect, useState } from 'react';
import { ApprovalDetailDrawer } from './ApprovalDetailDrawer';

type Tab = 'pending' | 'approved' | 'denied';
interface ApprovalItem {
  id: string; session_id: string; level: 'L2' | 'L3'; tool_name: string;
  status: string; created_at: string; decided_by?: string | null;
  decided_at?: string | null; reason?: string | null;
  sideEffects: Array<{ action: string; ok: boolean; detail: string; at: string }> | null;
}

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'pending', label: '待处理' },
  { id: 'approved', label: '已批准' },
  { id: 'denied', label: '已拒绝' },
];

const fmt = (iso: string) => new Date(iso).toLocaleString('zh-CN', { hour12: false });

export function ApprovalCenterView() {
  const [tab, setTab] = useState<Tab>('pending');
  const [items, setItems] = useState<ApprovalItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/approval/list?status=${tab}&limit=100`);
      if (res.ok) setItems((await res.json()).items ?? []);
    } finally { setLoading(false); }
  }, [tab]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const t = setInterval(() => { void load(); }, 10_000); // v1 轮询，spec §9
    return () => clearInterval(t);
  }, [load]);

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <div className="flex items-center gap-2">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`rounded-md px-3 py-1.5 text-sm ${tab === t.id ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}>
            {t.label}
          </button>
        ))}
        {loading && <span className="text-xs text-gray-400">刷新中...</span>}
      </div>

      <div className="flex-1 overflow-y-auto">
        {items.length === 0 && <p className="py-10 text-center text-sm text-gray-400">暂无票据</p>}
        {items.map((it) => (
          <button key={it.id} onClick={() => setSelectedId(it.id)}
            className="mb-2 flex w-full items-center justify-between rounded-lg border border-gray-200 bg-white px-4 py-3 text-left hover:border-blue-300">
            <div className="flex items-center gap-3">
              <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${it.level === 'L3' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`}>
                {it.level}
              </span>
              <span className="text-sm font-medium">{it.tool_name}</span>
              {it.status !== 'pending' && it.reason && (
                <span className="max-w-52 truncate text-xs text-gray-400">理由: {it.reason}</span>
              )}
            </div>
            <span className="text-xs text-gray-400">{fmt(it.created_at)}</span>
          </button>
        ))}
      </div>

      {selectedId && (
        <ApprovalDetailDrawer id={selectedId}
          onClose={() => setSelectedId(null)}
          onDecided={() => { setSelectedId(null); void load(); }} />
      )}
    </div>
  );
}
```

- [ ] **Step 4: App.tsx 分发**

switch 中 `case 'approvals': return <ApprovalCenterView />;`（import 顶部；props 形态按 Step 1 结论对齐）。

- [ ] **Step 5: 手动验证 + commit**

Run: `npm run dev:all`（若前端已在跑则勿重复起），浏览器登录后：
1. 导航出现「审批中心」，hash `#/approvals` 可达；
2. 任意会话触发一个 L2 工具（如"把单据 X 绑定到合同 Y"）→ 待处理 tab 10s 内出现该票据；
3. `npm run build && npm run lint && npm test` 全绿。

```bash
git add apps/web/src/components/shell/navigation.ts apps/web/src/App.tsx apps/web/src/components/approval/ApprovalCenterView.tsx
git commit -m "feat(web): approval center view with tabs and polling"
```

（本任务与 Task 9 一起通过 build；drawer 组件在 Task 9 创建前，可先在同 commit 内创建占位会导致编译失败——因此 Task 8 提交时 ApprovalDetailDrawer 的 import 一起加，drawer 文件在 Task 9 Step 2 立即补上后统一 build。若严格逐任务可编译，把 drawer import 与使用一并放入 Task 9，Task 8 的列表先 setSelectedId 后 no-op。）

---

### Task 9: 详情抽屉 + 状态栏入口

**Files:**
- Create: `apps/web/src/components/approval/ApprovalDetailDrawer.tsx`
- Modify: `apps/web/src/components/chat/HumanAgentStatusBar.tsx`（待办数 → 链接；路径以 grep 为准）

**Interfaces:**
- Consumes: `GET /api/approval/:id`、`POST /api/approval/callback`（RealChatView.tsx:544 postApproval 的 fetch 形态）

- [ ] **Step 1: 前置检查**

Run: `grep -rn "postApproval\|/api/approval/callback" apps/web/src/components/RealChatView.tsx | head` 抄 fetch 形态；`grep -rn "pendingApprovals" apps/web/src/components/chat/HumanAgentStatusBar.tsx`（若不在此路径，`grep -rln "HumanAgentStatusBar" apps/web/src`）。

- [ ] **Step 2: ApprovalDetailDrawer.tsx**

```tsx
// apps/web/src/components/approval/ApprovalDetailDrawer.tsx
import { useEffect, useState } from 'react';

interface Detail {
  id: string; session_id: string; level: 'L2' | 'L3'; tool_name: string;
  status: string; created_at: string; decided_by?: string | null;
  decided_at?: string | null; reason?: string | null; input_json: string;
  ticket_id?: string | null; approval_id?: string | null;
  sideEffects: Array<{ target: string; action: string; ok: boolean; detail: string; at: string }> | null;
}

export function ApprovalDetailDrawer(props: { id: string; onClose(): void; onDecided(): void }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    const res = await fetch(`/api/approval/${props.id}`);
    if (res.ok) setDetail((await res.json()).item);
  };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [props.id]);

  const decide = async (approved: boolean) => {
    if (!detail) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch('/api/approval/callback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ticketId: detail.ticket_id ?? undefined,
          approvalId: detail.approval_id ?? undefined,
          approved, reason: reason || undefined,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      props.onDecided();
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };

  let payload: Array<[string, unknown]> = [];
  try { payload = Object.entries(JSON.parse(detail?.input_json ?? '{}')); }
  catch { payload = [['raw', detail?.input_json ?? '']]; }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={props.onClose}>
      <div className="h-full w-[480px] overflow-y-auto bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        {!detail ? <p className="text-sm text-gray-400">加载中...</p> : (
          <>
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold">{detail.tool_name}</h2>
              <span className="text-xs text-gray-400">{detail.level} · {detail.status}</span>
            </div>

            <h3 className="mb-1 text-sm font-medium text-gray-700">参数</h3>
            <div className="mb-4 rounded-md bg-gray-50 p-3">
              {payload.map(([k, v]) => (
                <div key={k} className="mb-1 text-sm">
                  <span className="text-gray-500">{k}: </span>
                  <span className="break-all">{String(v).slice(0, 200)}</span>
                </div>
              ))}
            </div>

            {detail.status === 'pending' && (
              <>
                <h3 className="mb-1 text-sm font-medium text-gray-700">理由（留痕）</h3>
                <textarea value={reason} onChange={(e) => setReason(e.target.value)}
                  rows={2} className="mb-3 w-full rounded-md border border-gray-300 p-2 text-sm"
                  placeholder="批准/拒绝理由，将写入审计" />
                <div className="mb-4 flex gap-2">
                  <button disabled={busy} onClick={() => decide(true)}
                    className="rounded-md bg-green-600 px-4 py-1.5 text-sm text-white disabled:opacity-50">批准</button>
                  <button disabled={busy} onClick={() => decide(false)}
                    className="rounded-md bg-red-600 px-4 py-1.5 text-sm text-white disabled:opacity-50">拒绝</button>
                </div>
              </>
            )}

            {detail.status !== 'pending' && (
              <p className="mb-4 text-sm text-gray-500">
                决策: {detail.status} · 决策人: {detail.decided_by ?? '-'} · 时间: {detail.decided_at ?? '-'} · 理由: {detail.reason ?? '-'}
              </p>
            )}

            <h3 className="mb-1 text-sm font-medium text-gray-700">执行副作用</h3>
            {(!detail.sideEffects || detail.sideEffects.length === 0)
              ? <p className="mb-4 text-xs text-gray-400">暂无（L3 或未执行）</p>
              : (
                <ul className="mb-4 space-y-1">
                  {detail.sideEffects.map((s, i) => (
                    <li key={i} className={`rounded px-2 py-1 text-xs ${s.ok ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
                      {s.action} · {s.ok ? '成功' : '失败'} · {s.detail.slice(0, 120)}
                    </li>
                  ))}
                </ul>
              )}

            {error && <p className="mb-2 text-sm text-red-600">操作失败: {error}</p>}
            <a className="text-sm text-blue-600 underline" href={`#/chat?session=${detail.session_id}`}>
              打开相关会话
            </a>
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: HumanAgentStatusBar 链接**

把现有 pendingApprovals 计数元素包进 `<a href="#/approvals" className="...原类名...">`（最小 diff；若组件在别的文件按 grep 结果改）。

- [ ] **Step 4: 手动验收（spec §10 全流程）+ commit**

Run: `npm run build && npm run lint && npm test`，然后 dev 环境：
1. 对话触发 L2 → 审批中心待办 → 打开详情 → 填理由批准 → 会话续跑 → 详情页出现副作用条目；
2. 触发 L3（escalate）→ 待办出现 ESC 票据 → 拒绝 → 会话收到拒绝叙事；
3. 已批准/已拒绝 tab 显示决策人、时间、理由；
4. 状态栏待办数点击进入审批中心。

```bash
git add apps/web/src/components/approval/ApprovalDetailDrawer.tsx apps/web/src
git commit -m "feat(web): approval detail drawer with decision audit and session link"
```

---

### Task 10: 收尾 — AGENTS.md 补记 + 分支合并

**Files:**
- Modify: `AGENTS.md`（Environment 列表 + Backend notes）

- [ ] **Step 1: AGENTS.md 两处补记**

Environment 段（OPENAI 等变量列表附近）加一行：
```
- `APPROVAL_CHANNEL` — 审批通知通道（default `local` 仅结构化日志；`lark` 预留未实现，回退 local）。
```
Backend notes 段 approval 一句改为涵盖新端点：审批中心路由 `GET /api/approval/list`、`GET /api/approval/:id`；决策经 `POST /api/approval/callback` 落 decided_by/reason；L2 批准后副作用自动写 `side_effect_results`。

- [ ] **Step 2: 终验**

Run: `npm run build && npm run lint && npm test`
Expected: 全绿。对照 spec §10 六条验收逐条打勾。

- [ ] **Step 3: 合并（仓库惯例：分支验证后并回 main）**

```bash
git add AGENTS.md && git commit -m "docs: approval center env + routes notes"
git push origin HEAD:approval-center-v1
git fetch origin main && git merge origin/main
npm run build && npm run lint && npm test   # 合并若触碰代码需复验
git push origin HEAD:approval-center-v1
git push origin HEAD:main
```

---

## Self-Review 记录

- Spec 覆盖：§5 数据模型（T1/T2）、§6 API（T3/T4/T5）、§7 适配层（T6）、§8 副作用（T2/T7）、§9 前端（T8/T9）、§10 验收（T9 Step4/T10 Step2）——无缺口；§3 OUT 项均未越界。
- 类型一致性：`SideEffect`（T2 定义，T4/T7/T9 消费）、`ApprovalListItem`（T3 定义，T4 消费）、`resolveApproval` 三参（T1 定义，T5 消费）——签名一致。
- 已知不确定点均以"前置检查"显式步骤暴露（createSession 入参、buildGatedTools 签名、StatusBar 路径、App.tsx props 形态），不允许猜。
