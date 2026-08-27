# 文件管理体验优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 文件管理面板支持子文件夹创建、拖放/批量上传（含文件夹、带进度）、拖拽移动、文件夹重命名/移动，且从浮动抽屉改为停靠可伸缩侧边栏。

**Architecture:** 后端仅新增一个 `PATCH /api/files/folder-path` 接口（前缀重写 MinIO key + file_folders 行，docId 不变）+ 2 个 repo 函数；前端把 776 行的 FileDrawer 拆为容器/树/hook，新增 DnD 与上传队列 hook 和 XHR 进度传输层；AppShell 增加 filesPanel 停靠槽位。

**Tech Stack:** Hono + MinIO SDK（后端）；React 19 + Tailwind + HTML5 DnD + XMLHttpRequest（前端）；vitest。

**Spec:** `docs/superpowers/specs/2026-08-27-file-management-enhancements-design.md`

## Global Constraints

- 无 emoji（仓库约定）。验证顺序固定：build → lint → test。
- 禁止动 AI SDK / harness 相关文件；本次不涉及模型链路。
- SQLite 用裸 SQL（client.ts 幂等 DDL），PG 走 postgres-repositories.ts 对应实现——repo 函数必须双实现。
- 路由测试模式：`vi.hoisted` ctxHolder mock dbBackend，route 在 mock 后动态 import，`appAs(userId)` 注入用户；files 路由测试还需 `vi.mock('../../src/lib/minio.js')`。
- 前端无组件测试设施，前端任务以 `npm run build`（含 tsc -b）为门禁；可抽纯函数处如需测试放 server test 不做（保持简单）。
- 所有提交信息中文一句，格式 `feat:/refactor:/docs: 描述`。

---

### Task 1: 后端 folder-path 纯守卫函数 + 单测

**Files:**
- Modify: `apps/server/src/routes/files.ts`（新增并导出纯函数）
- Test: `apps/server/test/routes/files.test.ts`

**Interfaces:**
- Produces:
  - `validateFolderPathChange(from: string, to: string): { ok: true } | { ok: false; reason: 'empty_from' | 'self_nested' | 'same_path' }`
  - `rewriteKeyPrefix(key: string, userId: string, from: string, to: string): string`（key 形如 `users/<uid>/<from>/.../<file>`）
  - `isPathUnderFolder(path: string, from: string): boolean`（path === from 或以 `from + '/'` 开头）

- [ ] **Step 1: 写失败测试**（追加到 files.test.ts）

```ts
import { validateFolderPathChange, rewriteKeyPrefix, isPathUnderFolder } from '../../src/routes/files.js';

describe('validateFolderPathChange', () => {
  it('空 from -> empty_from', () => {
    expect(validateFolderPathChange('', 'x')).toEqual({ ok: false, reason: 'empty_from' });
  });
  it('同名 / 移入自己子树 -> 拒绝', () => {
    expect(validateFolderPathChange('a', 'a')).toEqual({ ok: false, reason: 'same_path' });
    expect(validateFolderPathChange('a', 'a/b')).toEqual({ ok: false, reason: 'self_nested' });
  });
  it('合法改名与合法移动通过', () => {
    expect(validateFolderPathChange('合同', '合同2026')).toEqual({ ok: true });
    expect(validateFolderPathChange('汽运业务资料', '煤焦化/发运')).toEqual({ ok: true });
  });
});

describe('isPathUnderFolder', () => {
  it('精确匹配与前缀匹配', () => {
    expect(isPathUnderFolder('a', 'a')).toBe(true);
    expect(isPathUnderFolder('a/b', 'a')).toBe(true);
    expect(isPathUnderFolder('ab', 'a')).toBe(false);
    expect(isPathUnderFolder('b/a', 'a')).toBe(false);
  });
});

describe('rewriteKeyPrefix', () => {
  it('替换 <uid>/<from>/ 前缀，其余段保留', () => {
    expect(rewriteKeyPrefix('users/u1/合同/x.pdf', 'u1', '合同', '合同2026'))
      .toBe('users/u1/合同2026/x.pdf');
    expect(rewriteKeyPrefix('users/u1/合同/子/xy.txt', 'u1', '合同', '发运/合同')
    ).toBe('users/u1/发运/合同/子/xy.txt');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test --workspace apps/server -- test/routes/files.test.ts`
Expected: FAIL（导出不存在）

- [ ] **Step 3: 实现**（加在 files.ts 的 normalizeDirectory 之后）

```ts
/** folder-path 守卫谓词（纯函数）：空 from、目标同源、移入自己子树均拒绝。 */
export function validateFolderPathChange(
  rawFrom: string,
  rawTo: string,
): { ok: true } | { ok: false; reason: 'empty_from' | 'same_path' | 'self_nested' } {
  const from = normalizeDirectory(rawFrom);
  const to = normalizeDirectory(rawTo);
  if (!from) return { ok: false, reason: 'empty_from' };
  if (to === from) return { ok: false, reason: 'same_path' };
  if (to.startsWith(`${from}/`)) return { ok: false, reason: 'self_nested' };
  return { ok: true };
}

/** path === from 或位于 from 子树内。 */
export function isPathUnderFolder(path: string, from: string): boolean {
  return path === from || path.startsWith(`${from}/`);
}

/** 把 `users/<uid>/<from>/...` 形态的对象 key 改写为新前缀。 */
export function rewriteKeyPrefix(key: string, userId: string, from: string, to: string): string {
  const prefix = `users/${userId}/${from}/`;
  if (!key.startsWith(prefix)) return key;
  return `users/${userId}/${to}/${key.slice(prefix.length)}`;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test --workspace apps/server -- test/routes/files.test.ts`
Expected: PASS 全绿

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes/files.ts apps/server/test/routes/files.test.ts
git commit -m "feat: folder-path 守卫与前缀改写纯函数"
```

---

### Task 2: repo 层文件夹前缀改名（SQLite + PG 双实现）

**Files:**
- Modify: `apps/server/src/pipeline/db/repositories.ts`（约 :1242 文件夹区追加）
- Modify: `apps/server/src/pipeline/db/postgres-repositories.ts`（约 :1055 文件夹区追加）
- Test: `apps/server/test/pipeline/db/repositories.test.ts`

**Interfaces:**
- Consumes: `createDb/migrate`（测试），现有 dispatch 模式（backend === 'postgres' 分流）。
- Produces:
  - `listFileFoldersUnder(ctx, userId: string, from: string): Promise<FileFolder[]>`（path===from 或其子树的行）
  - `renameFileFoldersPrefix(ctx, userId: string, from: string, to: string): Promise<number>`（返回改写的行数；SQL 一条 UPDATE 完成，不用 LIKE 以免 %/_ 转义问题）

SQL 核心（两后端通用、1-indexed substr）：
```sql
UPDATE file_folders SET path = :to || substr(path, LENGTH(:from) + 1)
WHERE user_id = :userId AND (path = :from OR substr(path, 1, LENGTH(:from) + 1) = :from || '/')
```

- [ ] **Step 1: 写失败测试**（repositories.test.ts 追加 describe）

```ts
import {
  createFileFolder, listFileFolders, listFileFoldersUnder, renameFileFoldersPrefix,
} from '../../../src/pipeline/db/repositories.js';

describe('file folders prefix rename', () => {
  it('renameFileFoldersPrefix 级联改写子树路径并返回行数', async () => {
    await createFileFolder(ctx, 'u1', '合同');
    await createFileFolder(ctx, 'u1', '合同/上游');
    await createFileFolder(ctx, 'u1', '合同/下游/明细');
    await createFileFolder(ctx, 'u1', '发票');
    const n = await renameFileFoldersPrefix(ctx, 'u1', '合同', '2026/合同归档');
    expect(n).toBe(3);
    const paths = (await listFileFolders(ctx, 'u1')).map((f) => f.path).sort();
    expect(paths).toEqual(['2026/合同归档', '2026/合同归档/下游/明细', '2026/合同归档/上游', '发票']);
  });

  it('listFileFoldersUnder 只返回该前缀下的行', async () => {
    await createFileFolder(ctx, 'u2', 'a');
    await createFileFolder(ctx, 'u2', 'a/b');
    await createFileFolder(ctx, 'u2', 'ax');          // 相邻名不算
    await createFileFolder(ctx, 'u3', 'a');            // 别的用户不算
    const rows = await listFileFoldersUnder(ctx, 'u2', 'a');
    expect(rows.map((r) => r.path).sort()).toEqual(['a', 'a/b']);
  });

  it('无命中时 rename 返回 0 且不抛错', async () => {
    expect(await renameFileFoldersPrefix(ctx, 'uX', 'ghost', 'new')).toBe(0);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test --workspace apps/server -- test/pipeline/db/repositories.test.ts`
Expected: FAIL（函数未导出）

- [ ] **Step 3: 实现 SQLite 路径（repositories.ts dispatch 区）**

```ts
export async function listFileFoldersUnder(
  ctx: DbContext,
  userId: string,
  from: string,
): Promise<Array<{ id: string; path: string }>> {
  if (ctx.backend === 'postgres') return listFileFoldersUnderPg(ctx, userId, from);
  const rows = ctx.sqlite
    .prepare(
      `SELECT id, path FROM file_folders
       WHERE user_id = ? AND (path = ? OR substr(path, 1, LENGTH(?) + 1) = ? || '/')`,
    )
    .all(userId, from, from, from) as Array<{ id: string; path: string }>;
  return rows;
}

export async function renameFileFoldersPrefix(
  ctx: DbContext,
  userId: string,
  from: string,
  to: string,
): Promise<number> {
  if (ctx.backend === 'postgres') return renameFileFoldersPrefixPg(ctx, userId, from, to);
  const stmt = ctx.sqlite.prepare(
    `UPDATE file_folders SET path = ? || substr(path, LENGTH(?) + 1)
     WHERE user_id = ? AND (path = ? OR substr(path, 1, LENGTH(?) + 1) = ? || '/')`,
  );
  const res = stmt.run(to, from, userId, from, from, from);
  return Number(res.changes ?? 0);
}
```

- [ ] **Step 4: 实现 PG 路径（postgres-repositories.ts，$n 参数化同样 SQL）**

```ts
export async function listFileFoldersUnderPg(
  ctx: PgDbContext,
  userId: string,
  from: string,
): Promise<Array<{ id: string; path: string }>> {
  const res = await ctx.query(
    `SELECT id, path FROM file_folders
     WHERE user_id = $1 AND (path = $2 OR substr(path, 1, LENGTH($2) + 1) = $2 || '/')`,
    [userId, from],
  );
  return res.rows as Array<{ id: string; path: string }>;
}

export async function renameFileFoldersPrefixPg(
  ctx: PgDbContext,
  userId: string,
  from: string,
  to: string,
): Promise<number> {
  const res = await ctx.query(
    `UPDATE file_folders SET path = $1 || substr(path, LENGTH($2) + 1)
     WHERE user_id = $3 AND (path = $2 OR substr(path, 1, LENGTH($2) + 1) = $2 || '/')`,
    [to, from, userId],
  );
  return res.rowCount ?? 0;
}
```
（函数签名按文件内既有 Pg 函数真实形态对齐：ctx 类型与 query/rowCount 取法照抄相邻函数。）
并在 repositories.ts 顶部既有 PG import 区补两个新 Pg 函数 import。

- [ ] **Step 5: 运行确认通过**

Run: `npm test --workspace apps/server -- test/pipeline/db/repositories.test.ts`
Expected: PASS 全绿

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/pipeline/db/repositories.ts apps/server/src/pipeline/db/postgres-repositories.ts apps/server/test/pipeline/db/repositories.test.ts
git commit -m "feat: file_folders 前缀查询与级联改名（SQLite/PG 双实现）"
```

---

### Task 3: PATCH /api/files/folder-path 路由

**Files:**
- Modify: `apps/server/src/routes/files.ts`（在 `/mkdir` 附近插入路由）
- Test: `apps/server/test/routes/files.folderPath.test.ts`（新建）

**Interfaces:**
- Consumes: Task1 纯函数、Task2 repo 函数、既有 `findDocIdsByMinioKeys/setDocumentMinioKey`、`minioClient.copyObject/removeObject/listObjectsV2`。
- Produces: HTTP 行为——400（空/自套娃）、409（任一目标路径已被占用）、403（Body 无关所有权天然限定；无需额外检查）、200 `{ok:true,folders:n,objects:m}`。
- Behavior: 先校验冲突（合并现役 folders + MinIO 目标 key 冲突不查 DB 直接覆盖跳过——目标精确同名才 409），再迁对象（copy→remove→setDocumentMinioKey），再改 folders 行。中途失败 best-effort 反向回滚已迁对象并 500 带 detail。

- [ ] **Step 1: 写失败路由测试**（照 contractsSearch.test.ts 的 ctxHolder/appAs 模式，外加 minio mock）

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { AuthEnv } from '../../src/lib/auth-middleware.js';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import { createFileFolder, listFileFolders } from '../../src/pipeline/db/repositories.js';

const { ctxHolder } = vi.hoisted(() => ({ ctxHolder: { current: null as DbContext | null } }));
vi.mock('../../src/pipeline/db/dbBackend.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/pipeline/db/dbBackend.js')>();
  return { ...mod, getDbContext: () => ctxHolder.current };
});
const minioState = vi.hoisted(() => ({
  copied: [] as Array<[string, string]>,
  removed: [] as string[],
}));
vi.mock('../../src/lib/minio.js', () => ({
  MINIO_BUCKET: 'test-bucket',
  minioClient: {
    copyObject: async (_b: string, nk: string, src: string) => {
      minioState.copied.push([nk, src]);
    },
    removeObject: async (_b: string, k: string) => { minioState.removed.push(k); },
    listObjectsV2: () => ({
      async *[Symbol.asyncIterator]() {
        yield { name: 'users/u1/旧目录/a-blob.pdf', size: 3 };
        yield { name: 'users/u1/旧目录/子/x-c.csv', size: 4 };
      },
    }),
  },
}));
const { filesRoute } = await import('../../src/routes/files.js');

function appAs(userId: string) {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { id: userId, email: 't@t', role: 'trader' } as never);
    await next();
  });
  app.route('/api/files', filesRoute);
  return app;
}
function req(app: ReturnType<typeof appAs>, body: object) {
  return app.request('/api/files/folder-path', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

let ctx: DbContext;
beforeEach(() => {
  ctx = createDb(':memory:'); migrate(ctx.sqlite); ctxHolder.current = ctx;
  minioState.copied.length = 0; minioState.removed.length = 0;
});

describe('PATCH /api/files/folder-path', () => {
  it('400: 空 from / 移入自己子树', async () => {
    expect((await req(appAs('u1'), { from: '', to: 'x' })).status).toBe(400);
    expect((await req(appAs('u1'), { from: 'a', to: 'a/b' })).status).toBe(400);
  });

  it('409: 目标精确同名已存在', async () => {
    await createFileFolder(ctx, 'u1', '旧目录');
    await createFileFolder(ctx, 'u1', '新家');
    expect((await req(appAs('u1'), { from: '旧目录', to: '新家' })).status).toBe(409);
  });

  it('成功: 迁移 MinIO 对象（copy+remove）并级联改 folders，docId 关联不丢', async () => {
    await createFileFolder(ctx, 'u1', '旧目录');
    // 模拟 documents stub 已关联旧 key，验证回填调用后仍能查到（走 setDocumentMinioKey 真实 impl）。
    const res = await req(appAs('u1'), { from: '旧目录', to: '新家' });
    expect(res.status).toBe(200);
    const data = await res.json() as { ok: boolean; folders: number; objects: number };
    expect(data).toMatchObject({ ok: true, folders: 1, objects: 2 });
    expect(minioState.copied.map(([nk]) => nk).sort()).toEqual([
      'users/u1/新家/a-blob.pdf', 'users/u1/新家/子/x-c.csv',
    ]);
    expect(minioState.removed.sort()).toEqual([
      'users/u1/旧目录/a-blob.pdf', 'users/u1/旧目录/子/x-c.csv',
    ]);
    const paths = (await listFileFolders(ctx, 'u1')).map((f) => f.path);
    expect(paths).toEqual(['新家']);
  });
});
```

注意：`findDocIdsByMinioKeys([key])` 在此测试中查不到 stub 文档 → `setDocumentMinioKey` 不被调用，属预期（docId 关联逻辑由 move 同款代码路径保证，不做额外集成桩）。

- [ ] **Step 2: 运行确认失败**

Run: `npm test --workspace apps/server -- test/routes/files.folderPath.test.ts`
Expected: FAIL（404，路由不存在）

- [ ] **Step 3: 实现路由**（files.ts，插到 /rmdir 之后）

```ts
/** Rename or relocate a virtual folder subtree: rewrites every descendant path
 *  in file_folders and moves all MinIO objects under users/<uid>/<from>/ to the
 *  rewritten prefix (documents.minio_key re-linked by docId; parse artifacts and
 *  graph bindings anchor on docId so they are unaffected). Best-effort reverse
 *  rollback on mid-flight failure -- same guarantee level as single-file /move. */
filesRoute.patch('/folder-path', requireRole('admin', 'trader'), async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);

  let body: { from?: unknown; to?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }
  const fromRaw = typeof body.from === 'string' ? body.from : '';
  const toRaw = typeof body.to === 'string' ? body.to : '';
  const guard = validateFolderPathChange(fromRaw, toRaw);
  if (!guard.ok) return c.json({ error: guard.reason }, 400);
  const from = normalizeDirectory(fromRaw);
  const to = normalizeDirectory(toRaw);

  try {
    // 1. Conflict scan: any existing folder row exactly colliding with a target.
    const allFolders = await listFileFolders(ctx(), user.id);
    const underFrom = allFolders.filter((f) => isPathUnderFolder(f.path, from));
    const existingTargets = new Set(allFolders.filter((f) => !isPathUnderFolder(f.path, from)).map((f) => f.path));
    const targetOf = (p: string) => to + p.slice(from.length);
    if (underFrom.some((f) => existingTargets.has(targetOf(f.path)))) {
      return c.json({ error: 'target exists' }, 409);
    }

    // 2. Move MinIO objects under the old prefix (copy -> remove -> relink doc).
    const srcPrefix = `users/${user.id}/${from}/`;
    let moved = 0;
    const done: Array<{ oldKey: string; newKey: string }> = [];
    try {
      const stream = minioClient.listObjectsV2(MINIO_BUCKET, srcPrefix, true);
      for await (const obj of stream) {
        const oldKey = obj.name ?? '';
        if (!oldKey.startsWith(srcPrefix)) continue;
        const newKey = rewriteKeyPrefix(oldKey, user.id, from, to);
        if (newKey === oldKey) continue;
        await minioClient.copyObject(MINIO_BUCKET, newKey, `${MINIO_BUCKET}/${oldKey}`);
        await minioClient.removeObject(MINIO_BUCKET, oldKey);
        done.push({ oldKey, newKey });
        moved += 1;
      }
    } catch (e) {
      for (const d of done.reverse()) {
        try { await minioClient.removeObject(MINIO_BUCKET, d.newKey); } catch { /* best-effort */ }
        try { await minioClient.copyObject(MINIO_BUCKET, d.oldKey, `${MINIO_BUCKET}/${d.newKey}`); } catch { /* best-effort */ }
      }
      throw e;
    }

    // 3. Rewrite the virtual folder rows (single UPDATE, prefix math in SQL).
    const foldersRewritten = await renameFileFoldersPrefix(ctx(), user.id, from, to);

    // 4. Relink document rows (needs the fresh keys; do after storage success).
    for (const d of done) {
      const map = await findDocIdsByMinioKeys(ctx(), [d.oldKey], user.id);
      const docId = map.get(d.oldKey);
      if (docId) await setDocumentMinioKey(ctx(), docId, d.newKey);
    }

    return c.json({ ok: true, folders: foldersRewritten, objects: moved });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[files] folder-path failed:', msg);
    return c.json({ error: 'folder-path failed', detail: msg }, 500);
  }
});
```

同时更新 import：新增 `listFileFolders`、`renameFileFoldersPrefix` 及本文件已导出的纯函数直接可用。修复顺序注意：relink 使用旧 key 反查 map —— 但此时旧对象已删除、DB 里 minio_key 仍是旧值所以反查有效 ✓。

- [ ] **Step 4: 运行确认通过**

Run: `npm test --workspace apps/server -- test/routes/files.folderPath.test.ts`
Expected: PASS 全绿

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes/files.ts apps/server/test/routes/files.folderPath.test.ts
git commit -m "feat: 新增 PATCH /api/files/folder-path 文件夹整体改名/移动接口"
```

---

### Task 4: 前端共享上传传输层 uploadWithProgress（XHR 进度）

**Files:**
- Create: `apps/web/src/api/uploadWithProgress.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface UploadProgressInfo { loaded: number; total: number; percent: number; }
  export function uploadWithProgress(
    file: File,
    directory: string,
    onProgress?: (info: UploadProgressInfo) => void,
  ): Promise<{ docId: string; filename: string; key: string; directory: string }>
  ```
  fetch/XHR 错误 reject Error(message)；413 时 message 含「过大」。

- [ ] **Step 1: 实现**（无可测设施，build 为门禁）

```ts
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export interface UploadProgressInfo { loaded: number; total: number; percent: number }

export interface UploadResult { docId: string; filename: string; key: string; directory: string }

/** XHR 上传：唯一能拿到字节级上传进度的浏览器原语（fetch 不支持 upload 方向进度）。
 *  聊天输入框与文件面板拖放队列共用。 */
export function uploadWithProgress(
  file: File,
  directory: string,
  onProgress?: (info: UploadProgressInfo) => void,
): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append('file', file);
    if (directory) fd.append('directory', directory);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/files');
    xhr.withCredentials = true;

    xhr.upload.onprogress = (e) => {
      if (!onProgress || !e.lengthComputable) return;
      onProgress({
        loaded: e.loaded,
        total: e.total,
        percent: e.total > 0 ? Math.round((e.loaded / e.total) * 100) : 0,
      });
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as UploadResult);
        } catch {
          reject(new Error(`unexpected response (${xhr.status})`));
        }
        return;
      }
      let detail = `upload failed (${xhr.status})`;
      try {
        const j = JSON.parse(xhr.responseText) as { error?: string; detail?: string };
        detail = j.error === 'file too large'
          ? `文件过大（${(file.size / 1024 / 1024).toFixed(1)} MiB），上限为 25 MiB`
          : j.error || j.detail || detail;
      } catch { /* keep default */ }
      reject(new Error(detail));
    };
    xhr.onerror = () => reject(new Error('网络错误，上传中断'));
    xhr.send(fd);
  });
}

export { MAX_UPLOAD_BYTES };
```

- [ ] **Step 2: Verify**

Run: `npm run build`
Expected: 编译通过

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/api/uploadWithProgress.ts
git commit -m "feat: XHR 上传传输层 uploadWithProgress（字节级进度）"
```

---

### Task 5: FileTree 组件拆分（纯搬移）

**Files:**
- Create: `apps/web/src/components/shell/FileTree.tsx`
- Modify: `apps/web/src/components/shell/FileDrawer.tsx`

**Interfaces:**
- Consumes: 现 FileDrawer 内 `TreeNode/formatSize/pathSegments/buildTree/normalizeMoveDirectory/parseBadge/actionLinkClass/FileNameText/MoveDropdown/DeleteConfirmOverlay/FileRow/TreeFolder` 整体迁出。
- Produces（FileTree.tsx 导出）:
  - `export function buildTree(files: FileEntry[], folders: FileFolder[]): TreeNode`
  - `export interface TreeCallbacks { downloadFile; removeFolder; onPreview; onAddToConversation; onStartMove; movingFileKey; folders; onMove; onCancelMove; contextFileKeys; deletingFolderPath; setDeletingFolderPath; onDelete; deletingFilePath; setDeletingFilePath; onOpenBindings?; onTriggerParse?; parsingDocIds }`
  - `export function FileTree(props: { tree: TreeNode; expanded: Set<string>; toggle: (p: string) => void; callbacks: TreeCallbacks })`
- FileDrawer.tsx 仅余容器状态编排 + 预览弹窗，行数预计 <300。

- [ ] **Step 1: 创建 FileTree.tsx**：把上述符号原样剪切成新文件，包一层 `FileTree` 入口组件（渲染根层 files + subdirs，即现 FileDrawer 内 `{tree.files.map(...)}{Object.entries(tree.subdirs).map(...)}` 两段的封装）；所有 props 类型显式导出。回调经单一 `callbacks` 对象下传。
- [ ] **Step 2: FileDrawer.tsx 删除已迁出定义并改为引用**，渲染 `<FileTree tree={tree} expanded={expanded} toggle={toggle} callbacks={{...}} />`。
- [ ] **Step 3: Verify**

Run: `npm run build`
Expected: 通过；抽屉功能手工回归不变（列表/移动下拉/删除确认/预览）

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/shell/FileTree.tsx apps/web/src/components/shell/FileDrawer.tsx
git commit -m "refactor: FileDrawer 拆分出 FileTree 树形展示组件"
```

---

### Task 6: 子文件夹创建 UI

**Files:**
- Modify: `apps/web/src/components/shell/FileTree.tsx`
- Modify: `apps/web/src/hooks/useFiles.ts`（createFolder 已支持多级路径，仅类型收窄注释；无行为变更可跳过）

**Interfaces:**
- Consumes: `createFolder(path)`（useFiles 现有）、父路径由 TreeFolder 自身已知 `fullPath` 提供。
- Produces: TreeFolder 新 prop `onCreateSubfolder: (parentFullPath: string, name: string) => void`；FileDrawer 实现为 `(p, n) => createFolder(p ? `${p}/${n}` : n)`。

- [ ] **Step 1: TreeFolder 行 hover 动作区**「删除」左侧加「+」：

```tsx
<span
  onClick={(e) => { e.stopPropagation(); setCreatingHere(fullPath); }}
  title="新建子文件夹"
  className="hidden cursor-pointer rounded px-1 py-0.5 text-[11px] text-primary transition-colors hover:bg-primary/10 group-hover:inline"
>
  +
</span>
```
`creatingHere` state 由 FileDrawer 提升（`creatingInDir: string | null`），命名输入行渲染在该文件夹子内容顶部（缩进 +depth*14），样式复用现有 creatingFolder 输入行类。Enter → `onCreateSubfolder(fullPath, name)` 并清零；Esc 只取消输入。

- [ ] **Step 2: 头部「新建文件夹」语义保持根目录**（FileDrawer 原 handleCreateFolder 即 `createFolder(name)`，不动）。
- [ ] **Step 3: Verify**

Run: `npm run build` 通过；手工回归：根建夹、任一文件夹内建子夹、嵌套两级展开可见。

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/shell/FileTree.tsx apps/web/src/components/shell/FileDrawer.tsx
git commit -m "feat: 文件夹内新建子文件夹入口"
```

---

### Task 7: 拖拽移动（文件/文件夹单层拖拽 + 回根）

**Files:**
- Create: `apps/web/src/hooks/useFileDnd.ts`
- Modify: `apps/web/src/components/shell/FileTree.tsx`（行 draggable + drop 高亮）
- Modify: `apps/web/src/components/shell/FileDrawer.tsx`（根落点提示条）

**Interfaces:**
- Consumes: `moveFile(key, directory)`、Task3 的 `renameFolderPath`（本任务先在 useFiles 加薄封装）。
- useFiles.ts 新增：
  ```ts
  const renameFolderPath = useCallback(async (from: string, to: string) => {
    await fetch('/api/files/folder-path', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to }),
      credentials: 'include',
    });
    await refresh();
  }, [refresh]);
  ```
  （return 对象同步追加 renameFolderPath）

- [ ] **Step 1: useFileDnd.ts**

```ts
import { useState, useCallback } from 'react';

export type DragPayload =
  | { kind: 'file'; key: string; name: string }
  | { kind: 'folder'; path: string };

export const FILE_MIME = 'application/x-sca-file';
export const FOLDER_MIME = 'application/x-sca-folder';

function writePayload(e: React.DragEvent, payload: DragPayload) {
  const [mime, json] = payload.kind === 'file'
    ? [FILE_MIME, JSON.stringify(payload)]
    : [FOLDER_MIME, JSON.stringify(payload)];
  e.dataTransfer.setData(mime, json);
  e.dataTransfer.effectAllowed = 'move';
}

export function readPayload(e: React.DragEvent): DragPayload | null {
  try {
    const f = e.dataTransfer.getData(FILE_MIME);
    if (f) return JSON.parse(f) as DragPayload;
    const fo = e.dataTransfer.getData(FOLDER_MIME);
    if (fo) return JSON.parse(fo) as DragPayload;
  } catch { /* ignore */ }
  return null;
}

export function isSelfDrop(payload: DragPayload, target: { kind: 'root' } | { kind: 'folder'; path: string }): boolean {
  if (payload.kind !== 'folder') return target.kind !== 'root' && 'path' in target && target.path === '';
  if (target.kind !== 'folder') return false;
  return target.path === payload.path || target.path.startsWith(`${payload.path}/`);
}

/** 面板内部拖拽状态机：dragging 设置载荷，dropTarget 记录当前悬停目标用于高亮。 */
export function useFileDnd() {
  const [dragging, setDragging] = useState<DragPayload | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null); // '' = root

  const onDragStart = useCallback((payload: DragPayload) => (e: React.DragEvent) => {
    writePayload(e, payload);
    setDragging(payload);
  }, []);

  const onDragOver = useCallback((targetPath: string) => (e: React.DragEvent) => {
    if (!dragging) return;                 // 外部 OS 文件走 upload 流程，另行判定
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropTarget(targetPath);
  }, [dragging]);

  const clear = useCallback(() => { setDragging(null); setDropTarget(null); }, []);

  return { dragging, dropTarget, onDragStart, onDragOver, clear, setDragging };
}
```

- [ ] **Step 2: FileTree 接线**
  - FileRow 行元素加 `draggable` + `onDragStart={callbacks.onDragStart({kind:'file',key,name})}` + `onDragEnd={clear}`；
  - TreeFolder 行加 folder 版 onDragStart/dragEnd，行上 `onDragOver={dnd.onDragOver(fullPath)} onDragLeave={() => dnd.dropTarget === fullPath && dnd.setDropTarget(null)}`、行 className 高亮条件 `dnd.dropTarget === fullPath && dnd.dragging`（整行 `bg-primary/10 outline outline-1 outline-primary/40`）+ 左缘竖条 span；
  - Drop 处理在 TreeFolder/Filerow 行 `onDrop={(e)=>{e.stopPropagation(); const p=readPayload(e); if(!p||isSelfDrop(p,{kind:'folder',path:fullPath})) return clear(); p.kind==='file'? onMoveFile(p.key,fullPath) : onMoveFolder(p.path,fullPath); clear();}}`；
  - 新 prop：`onMoveFile(key, dirPath)`（FileDrawer 实现 `(k,d)=>{moveFile(k,d)}`，dirPath === '' 表根）、`onMoveFolder(from,toParent)`（实现 `renameFolderPath(from, toParent ? `${toParent}/${basename(from)}` : basename(from))`）。
  - `isSelfDrop` 中 file 拖到 root：kind==='folder' target==='root' → self=false 允许；file 拖自身所在目录等效 no-op（dirPath === 当前 directory 时后端 newKey===key 早退 200，天然幂等）。

- [ ] **Step 2b: 文件夹行内重命名**
  - TreeFolder hover 动作区在「删除」前加「改名」：点击进入 `renamingPath === fullPath` 状态（state 提升到 FileDrawer），行名称列替换为输入框（默认值当前名，全选）。
  - Enter → 计算 `parent = fullPath.includes('/') ? fullPath.slice(0, lastIndex) : ''`；新路径 `parent ? parent+'/'+newName : newName`；`onMoveFolder(fullPath, parent)` 已足够实现（Task7 的 onMoveFolder 语义=改父目录保持 basename）——但重命名需改 basename 本身，故新增独立 prop：
    ```ts
    onRenameFolder: (from: string, newName: string) => void
    // FileDrawer 实现:
    const onRenameFolder = useCallback((from: string, newName: string) => {
      const idx = from.lastIndexOf('/');
      const parent = idx > 0 ? from.slice(0, idx) : '';
      void renameFolderPath(from, parent ? `${parent}/${newName}` : newName);
    }, [renameFolderPath]);
    ```
  - Esc 取消；同名不改直接退出。
- [ ] **Step 3: 根落点**（FileDrawer 内容区最外层 div）：`onDragOver={(e)=>dnd.dragging&&e.preventDefault()} onDrop={...to root...}`，且 dragging 时顶部标题区显示提示条：
  `拖放到此处移到根目录`；content 区 className 附 `dnd.dragging ? 'ring-1 ring-inset ring-primary/30' : ''`。

- [ ] **Step 4: Verify**

Run: `npm run build` 通过。手工回归：文件拖入另一文件夹、文件夹拖入兄弟文件夹、拖到头部回根、拖自己本身/子树上无响应、普通点击不受影响。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/hooks/useFileDnd.ts apps/web/src/hooks/useFiles.ts apps/web/src/components/shell/FileTree.tsx apps/web/src/components/shell/FileDrawer.tsx
git commit -m "feat: 文件/文件夹拖拽移动与拖回根目录"
```

---

### Task 8: 批量拖放上传（含文件夹层级重建）+ 队列进度 UI

**Files:**
- Create: `apps/web/src/hooks/useFolderDropUpload.ts`
- Modify: `apps/web/src/hooks/useFiles.ts`（add createFolderIfMissing 内聚不必要——队列内部直接调 mkdir）
- Modify: `apps/web/src/components/shell/FileTree.tsx` / `FileDrawer.tsx`（OS 文件 drop 分流 + 底部汇总条）

**Interfaces:**
- Consumes: `uploadWithProgress`（Task4）、`readPayload` 返回 null ⇒ OS 文件载荷、`File.webkitRelativePath`、`DataTransferItem.webkitGetAsEntry()`。
- Produces:
  - 纯收集器 `collectDropItems(dt: DataTransfer): Promise<Array<{ file: File; relativeDir: string }>>`
  - `collectEntriesRecursively(entry: FileSystemEntry, dir: string, out: ...): Promise<void>`（用 ts-ignore-free 的局部 interface 断言；`getAsFileSystemHandle` 不用）
  - `useFolderDropUpload({ onBatchDone })` → `{ uploads: UploadItem[]; enqueue(items: Array<{file;relativeDir}>, targetDir: string): Promise<void>; aggregate: { done: number; total: number; bytesLoaded: number; bytesTotal: number; failed: number }; active: boolean }`

- [ ] **Step 1: 收集器 + hook**

```ts
import { useState, useRef, useCallback, useMemo } from 'react';
import { uploadWithProgress, type UploadProgressInfo } from '../api/uploadWithProgress';

export interface DroppedItem { file: File; relativeDir: string }

type FSEntry = {
  isFile: boolean; isDirectory: boolean; name: string; fullPath: string;
  file: (cb: (f: File) => void, err?: (e: unknown) => void) => void;
  createReader: () => { readEntries: (cb: (entries: FSEntry[]) => void, err?: (e: unknown) => void) => void };
};

async function readAllEntries(dir: FSEntry): Promise<FSEntry[]> {
  const reader = dir.createReader();
  const out: FSEntry[] = [];
  for (;;) {
    const batch = await new Promise<FSEntry[]>((res, rej) =>
      reader.readEntries(res, rej));
    if (batch.length === 0) break;
    out.push(...batch);
  }
  return out;
}

async function walk(entry: FSEntry, parentDir: string, out: DroppedItem[]) {
  if (entry.isFile) {
    const file = await new Promise<File>((res, rej) => entry.file(res, rej));
    out.push({ file, relativeDir: parentDir });
  } else if (entry.isDirectory) {
    const nextDir = parentDir ? `${parentDir}/${entry.name}` : entry.name;
    for (const child of await readAllEntries(entry)) await walk(child, nextDir, out);
  }
}

/** dt.items 优先（可拿到文件夹层级）；读取后清 items 再读 files 兜底平铺。 */
export async function collectDropItems(dt: DataTransfer): Promise<DroppedItem[]> {
  const out: DroppedItem[] = [];
  const items = Array.from(dt.items ?? []);
  const entries = items
    .map((it) => (typeof (it as unknown as { webkitGetAsEntry?: () => unknown }).webkitGetAsEntry === 'function'
      ? ((it as unknown as { webkitGetAsEntry: () => FSEntry | null }).webkitGetAsEntry())
      : null))
    .filter((x): x is FSEntry => !!x);
  if (entries.length > 0) {
    for (const e of entries) await walk(e, '', out);
    return out;
  }
  for (const f of Array.from(dt.files ?? [])) {
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath ?? '';
    const idx = rel.lastIndexOf('/');
    out.push({ file: f, relativeDir: idx > 0 ? rel.slice(0, idx) : '' });
  }
  return out;
}
```

hook 部分：

```ts
interface UploadItem {
  id: number; name: string; dir: string; percent: number; loaded: number; total: number;
  status: 'uploading' | 'done' | 'failed'; error?: string;
}

export function useFolderDropUpload(opts: {
  ensureDirs: (dirs: string[]) => Promise<void>;
  onDone: (okCount: number, failCount: number) => void;
}) {
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const counter = useRef(0);

  const active = uploads.some((u) => u.status === 'uploading');

  const patch = useCallback((id: number, p: Partial<UploadItem>) =>
    setUploads((prev) => prev.map((u) => (u.id === id ? { ...u, ...p } : u))), []);

  const enqueue = useCallback(async (items: DroppedItem[], targetDir: string) => {
    // 1. 重建目录结构：mkdir 补齐缺失路径（含多级），去重后逐个创建。
    const dirs = new Set<string>();
    for (const it of items) {
      const full = it.relativeDir
        ? (targetDir ? `${targetDir}/${it.relativeDir}` : it.relativeDir)
        : targetDir;
      let cur = '';
      for (const seg of full.split('/').filter(Boolean)) {
        cur = cur ? `${cur}/${seg}` : seg;
        dirs.add(cur);
      }
    }
    if (dirs.size > 0) await opts.ensureDirs(Array.from(dirs));

    // 2. 登记并串行上传（并发会压垮服务端 fGetObject 落盘）。
    const staged: UploadItem[] = items.map((it) => ({
      id: ++counter.current, name: it.file.name, dir: targetDir,
      percent: 0, loaded: 0, total: it.file.size, status: 'uploading',
    }));
    setUploads((prev) => [...prev, ...staged]);

    let ok = 0; let fail = 0;
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i]!;
      const row = staged[i]!;
      const fullDir = item.relativeDir
        ? (targetDir ? `${targetDir}/${item.relativeDir}` : item.relativeDir)
        : targetDir;
      try {
        await uploadWithProgress(item.file, fullDir, (p: UploadProgressInfo) =>
          patch(row.id, { percent: p.percent, loaded: p.loaded }));
        patch(row.id, { status: 'done', percent: 100 });
        ok += 1;
      } catch (e) {
        patch(row.id, { status: 'failed', error: e instanceof Error ? e.message : String(e) });
        fail += 1;
      }
    }
    opts.onDone(ok, fail);
    setTimeout(() => setUploads((prev) => prev.filter((u) => u.status !== 'failed')), 1500);
  }, [opts, patch]);

  const aggregate = useMemo(() => ({
    total: uploads.length,
    done: uploads.filter((u) => u.status !== 'uploading').length,
    failed: uploads.filter((u) => u.status === 'failed').length,
    bytesLoaded: uploads.reduce((s, u) => s + (u.status === 'done' ? u.total : u.loaded), 0),
    bytesTotal: uploads.reduce((s, u) => s + u.total, 0),
  }), [uploads]);

  return { uploads, active, aggregate, enqueue };
}
```
说明：done 行 loaded 已到 total，bytesLoaded 直接累加各 row.loaded 与终态差额兜底；aggregate 在组件侧用于汇总条渲染。失败项保留 1.5s 后清理成功/上传中之外失败行持久供查看——如需手动关闭再迭代。
```

aggregate 由组件 useMemo 从 uploads 计算（done=uploads.filter(u=>u.status!=='uploading').length 等）。说明：串行执行防并发压垮服务端 fGetObject。

- [ ] **Step 2: 接线**
  - FileDrawer 组合：`ensureDirs = async (dirs) => { const have = new Set(folders.map(f=>f.path)); for (const d of dirs) if (!have.has(d)) await createFolder(d); }`；`onDone = () => refresh()`。
  - 面板根 content 区 drop handler 更新分流：
    ```ts
    const internal = readPayload(e);            // 内部移动（Task7 分支优先）
    if (internal) { /* Task7 逻辑 */ } else {
      e.preventDefault();
      const items = await collectDropItems(e.dataTransfer);
      if (items.length > 0) void enqueue(items, '');   // root 落点
    }
    ```
  - TreeFolder drop 分支同理：内部载荷 move；否则 `enqueue(collectDropItems(e.dataTransfer), fullPath)`。
  - `dragover` 根分支需对 OS 文件也 preventDefault（Task7 目前只对 internal 有效——调整 `onDragOver` 判定：`if (!dragging) { e.preventDefault(); e.dataTransfer.dropEffect='copy'; }` 在 drop 目标行/根两处包装本地函数而非依赖 hook 单一来源）。
  - 底部汇总条（aside 底部 fixed 区）：`active` 或存在失败项时渲染：
    「上传中 {done}/{total} · 失败 {failed}」 + 细进度条 div 宽度 `${Math.round(bytesLoaded / Math.max(1, bytesTotal) * 100)}%`；每个失败项一行错误文案。

- [ ] **Step 3: Verify**

Run: `npm run build` 通过。手工回归：多选文件拖入某文件夹逐个出现进度；从资源管理器拖整个文件夹层级在面板中重建；413 大文件失败项显示原因不阻塞其余。

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/hooks/useFolderDropUpload.ts apps/web/src/components/shell/FileTree.tsx apps/web/src/components/shell/FileDrawer.tsx
git commit -m "feat: 拖放批量上传（含文件夹层级重建）与队列进度汇总"
```

---

### Task 9: 停靠式可伸缩侧边栏

**Files:**
- Modify: `apps/web/src/components/shell/AppShell.tsx`
- Modify: `apps/web/src/components/shell/FileDrawer.tsx`
- Modify: `apps/web/src/App.tsx`

**Interfaces:**
- AppShell 新 prop `filesPanel?: ReactNode`，布局改为：
  ```tsx
  <div className="flex min-w-0 flex-1 flex-col">
    <AppTopbar ... />
    <div className="flex min-h-0 flex-1">
      <main className="relative min-w-0 flex-1">{children}</main>
      {filesPanel}
    </div>
  </div>
  ```
- FileDrawer 渲染改动：删除遮罩 div 与 `fixed inset-y-0 right-0 z-drawer` 浮层定位；变为
  ```tsx
  <aside style={{ width }} className="flex h-full w-[var(--w)] shrink-0 flex-col border-l border-line bg-white">
  ```
  （直接 style={{width}}）。宽助手 `useState(() => clamp(Number(localStorage.getItem('sca.filesPanelWidth')) || 360))`；左缘手柄：
  ```tsx
  <div
    role="separator" aria-orientation="vertical"
    onMouseDown={startResize}
    className="absolute inset-y-0 left-0 z-10 w-1 cursor-col-resize bg-transparent transition-colors hover:bg-primary/40"
  />
  ```
  `startResize` 记录起点并 `document.addEventListener('mousemove/mouseup')`；move 时 `setWidth(clamp(startW + startX - e.clientX, 280, 560))`；up 时持久化 localStorage 且移除监听。手柄期间 `document.body.style.userSelect='none'` 还原。
- Esc 关闭保留；open=false 直接 return null（无遮罩可删）。
- App.tsx：把 `<FileDrawer .../>` 移入 AppShell 的 `filesPanel={fileDrawerOpen ? <FileDrawer open onClose=... /> : undefined}`（open 恒真或保留 prop 均可，建议仍传 open 以便内部 effect 语义不变）。`onClose={() => setFileDrawerOpen(false)}` 不变。
- 注意主内容在被压缩时的最小宽度：main 已 `min-w-0`；chat 视图自适应。

- [ ] **Step 1: 改 AppShell**（上述槽位）
- [ ] **Step 2: 改 FileDrawer 容器外壳**（去遮罩/浮层，加手柄+宽度状态+localStorage）
- [ ] **Step 3: 改 App.tsx 挂载方式**
- [ ] **Step 4: Verify**

Run: `npm run build` 通过。手工回归：打开后面板推挤主内容而非覆盖；拖左缘手柄实时变宽（280–560）刷新页面记忆；关闭后不占位；各视图（chat/bindings/graph…）下面板均可开且布局正常。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/shell/AppShell.tsx apps/web/src/components/shell/FileDrawer.tsx apps/web/src/App.tsx
git commit -m "feat: 文件管理改为停靠式可伸缩侧边栏"
```

---

### Task 10: 聊天框上传内联进度条（替换转圈按钮）

**Files:**
- Modify: `apps/web/src/components/RealChatView.tsx`（handleFileUpload 与上传按钮区）

**Interfaces:**
- Consumes: `uploadWithProgress`（Task4）。

- [ ] **Step 1: state 替换**：`uploadState/uploadMsg` 保留；新增 `uploadPercent: number | null`（null=空闲）。
- [ ] **Step 2: handleFileUpload 改造**：大小守卫保留但复用 `MAX_UPLOAD_BYTES`（自 uploadWithProgress 导入）；FormData/fetch 段替换为
  ```ts
  setUploadPercent(0)
  try {
    const data = await uploadWithProgress(file, '', (p) => setUploadPercent(p.percent))
    setUploadState('success'); setUploadMsg(`已上传「${data.filename}」，可在右侧文件管理中添加到对话`)
    onFilesChanged?.()
  } catch (err) { ...原样 } finally { setUploadPercent(null); 清 input value }
  ```
- [ ] **Step 3: 按钮 UI**： uploading 时按钮不再 disabled 变圈，改为其下方细进度条（textarea 左侧列内不好塞，置于 form 上方右对齐 80px 宽）：
  ```tsx
  {uploadPercent !== null && (
    <div className="mb-1 ml-auto w-32">
      <div className="h-1 overflow-hidden rounded bg-surface">
        <div className="h-full rounded bg-primary transition-all" style={{ width: `${uploadPercent}%` }} />
      </div>
      <div className="mt-0.5 text-right text-[10px] text-ink-soft">上传中 {uploadPercent}%</div>
    </div>
  )}
  ```
  按钮恢复静态 Paperclip 图标；Loader2 import 若不再使用则移除。
- [ ] **Step 4: Verify**

Run: `npm run build` 通过。手工回归：聊天上传大文件可见百分比推进；完成后提示与 shared 列表刷新正常。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/RealChatView.tsx
git commit -m "feat: 聊天上传改为内联字节级进度条"
```

---

### Task 11: 全量验证 + 收尾推送

- [ ] **Step 1:** `npm run build`（root，两端构建+tsc）
- [ ] **Step 2:** `npm run lint`
- [ ] **Step 3:** `npm test`
- [ ] **Step 4:** 修掉所有红项（若有）后重复 1–3 至全绿。
- [ ] **Step 5: Commit & push**

```bash
git push origin PengYip/Feat-文件管理体验优化
```
