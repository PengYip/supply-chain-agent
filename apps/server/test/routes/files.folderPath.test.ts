import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { AuthEnv } from '../../src/lib/auth-middleware.js';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import {
  createFileFolder,
  listFileFolders,
  findDocIdsByMinioKeys,
} from '../../src/pipeline/db/repositories.js';

const { ctxHolder } = vi.hoisted(() => ({ ctxHolder: { current: null as DbContext | null } }));
vi.mock('../../src/pipeline/db/dbBackend.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/pipeline/db/dbBackend.js')>();
  return { ...mod, getDbContext: () => ctxHolder.current };
});

const { minioState } = vi.hoisted(() => ({
  minioState: {
    copied: [] as Array<[string, string]>,
    removed: [] as string[],
    failRemove: false,
  },
}));
vi.mock('../../src/lib/minio.js', () => ({
  MINIO_BUCKET: 'test-bucket',
  minioClient: {
    copyObject: async (_bucket: string, newKey: string, src: string) => {
      minioState.copied.push([newKey, src]);
    },
    removeObject: async (_bucket: string, key: string) => {
      // failRemove 只在「子」目录对象上引爆：让首个对象完整迁移、第二个失败，
      // 以验证 best-effort 回滚确实动到了已迁移的首个对象。
      if (minioState.failRemove && key.includes('子')) throw new Error('S3 simulate failure');
      minioState.removed.push(key);
    },
    listObjectsV2: () => ({
      async *[Symbol.asyncIterator]() {
        yield { name: 'users/u1/旧目录/8f0e2c10-9d3f-4f5a-8b6c-7d1e2f3a4b5c-a.pdf', size: 3 };
        yield { name: 'users/u1/旧目录/子/x-c.csv', size: 4 };
        yield { name: 'users/u1/发票/keep.pdf', size: 5 }; // outside the subtree
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
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
  ctxHolder.current = ctx;
  minioState.copied.length = 0;
  minioState.removed.length = 0;
  minioState.failRemove = false;
});

describe('PATCH /api/files/folder-path', () => {
  it('未认证 -> 401', async () => {
    const app = new Hono<AuthEnv>();
    app.route('/api/files', filesRoute);
    expect((await app.request('/api/files/folder-path', { method: 'PATCH' })).status).toBe(401);
  });

  it('400: 空 from / 移入自己子树 / 同名 / 非法 JSON', async () => {
    expect((await req(appAs('u1'), { from: '', to: 'x' })).status).toBe(400);
    expect((await req(appAs('u1'), { from: 'a', to: 'a/b' })).status).toBe(400);
    expect((await req(appAs('u1'), { from: 'a', to: 'a' })).status).toBe(400);
    const bad = await appAs('u1').request('/api/files/folder-path', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: '{oops',
    });
    expect(bad.status).toBe(400);
  });

  it('409: 目标精确同名已存在（子树内部重排不算冲突）', async () => {
    await createFileFolder(ctx, 'u1', '旧目录');
    await createFileFolder(ctx, 'u1', '新家');
    // 新家 不与 旧目录 的目标（新家）冲突地改名到别的名字是允许的；这里直接对撞。
    expect((await req(appAs('u1'), { from: '旧目录', to: '新家' })).status).toBe(409);
  });

  it('成功: MinIO copy+remove 全部子对象、级联改 folders、按旧 key 回链 docId', async () => {
    await createFileFolder(ctx, 'u1', '旧目录');
    const res = await req(appAs('u1'), { from: '旧目录', to: '发运/新家' });
    expect(res.status).toBe(200);
    const data = await res.json() as { ok: boolean; folders: number; objects: number };
    expect(data).toEqual({ ok: true, folders: 1, objects: 2 });

    expect(minioState.copied.map(([nk]) => nk).sort()).toEqual([
      'users/u1/发运/新家/8f0e2c10-9d3f-4f5a-8b6c-7d1e2f3a4b5c-a.pdf',
      'users/u1/发运/新家/子/x-c.csv',
    ]);
    // copy 源均为旧 key
    for (const [, src] of minioState.copied) {
      expect(src.startsWith(`test-bucket/users/u1/旧目录/`)).toBe(true);
    }
    expect(minioState.removed.sort()).toEqual([
      'users/u1/旧目录/8f0e2c10-9d3f-4f5a-8b6c-7d1e2f3a4b5c-a.pdf',
      'users/u1/旧目录/子/x-c.csv',
    ]);

    const paths = (await listFileFolders(ctx, 'u1')).map((f) => f.path);
    expect(paths).toEqual(['发运/新家']);
  });

  it('docId 回链: 旧 key 命中的文档被改写到新 key', async () => {
    await createFileFolder(ctx, 'u1', '旧目录');
    // 用真实 createDocumentStub 铸一行带 minio_key 的 doc，验证路由第 4 步
    // 反查的前提（documents.minio_key 此时仍是旧 key）与回链动作本身。
    const { createDocumentStub } = await import('../../src/pipeline/db/repositories.js');
    const { docId } = await createDocumentStub(ctx, {
      userId: 'u1',
      filename: 'd1.pdf',
      minioKey: 'users/u1/旧目录/子/x-c.csv',
      sourceUri: 'ingest://x',
    });

    const res = await req(appAs('u1'), { from: '旧目录', to: '新家' });
    expect(res.status).toBe(200);
    const map = await findDocIdsByMinioKeys(ctx, ['users/u1/新家/子/x-c.csv'], 'u1');
    expect(map.get('users/u1/新家/子/x-c.csv')).toBe(docId);
  });

  it('中途失败: 返回 500 且 best-effort 回滚已迁对象', async () => {
    await createFileFolder(ctx, 'u1', '旧目录');
    minioState.failRemove = true; // 第二个对象（含「子」）remove 时引爆
    const res = await req(appAs('u1'), { from: '旧目录', to: '新家' });
    expect(res.status).toBe(500);
    const data = await res.json() as { error: string; detail: string };
    expect(data.error).toBe('folder-path failed');
    // 对象序：o1 完整迁移(copy1/remove1)；o2 copy2 后 remove 引爆；
    // 回滚再把 o1 拷回（copy3）并删除其新 key。
    expect(minioState.copied).toHaveLength(3);
    expect(minioState.copied[2]?.[0]).toBe(
      'users/u1/旧目录/8f0e2c10-9d3f-4f5a-8b6c-7d1e2f3a4b5c-a.pdf',
    );
    expect(minioState.removed).toContain('users/u1/新家/8f0e2c10-9d3f-4f5a-8b6c-7d1e2f3a4b5c-a.pdf');
    // folders 行未被改写
    expect((await listFileFolders(ctx, 'u1')).map((f) => f.path)).toEqual(['旧目录']);
  });
});
