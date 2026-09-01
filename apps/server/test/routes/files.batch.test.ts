import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { AuthEnv } from '../../src/lib/auth-middleware.js';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import {
  createDocumentStub,
  setDocumentBatchRole,
  saveDocumentUnits,
  findDocIdsByMinioKeys,
  updateDocumentParseStage,
} from '../../src/pipeline/db/repositories.js';

// P3 谱系(批量拆分器 Phase 3): /api/files 条目带 batchRole/unitCount;
// source_uri LIKE fallback 不得命中 batch_role='unit' 行(unit 与 container
// 共享 source_uri, 未加固时会劫持文件条目的 docId)。
//
// 隔离文件: 路由 DbContext 经 getDbContext 解析 -> 注入内存库; MinIO 只桩
// listObjectsV2(GET / 的对象清单来源)。

const { ctxHolder } = vi.hoisted(() => ({ ctxHolder: { current: null as DbContext | null } }));
vi.mock('../../src/pipeline/db/dbBackend.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/pipeline/db/dbBackend.js')>();
  return { ...mod, getDbContext: () => ctxHolder.current };
});

const { minioState } = vi.hoisted(() => ({
  minioState: { keys: [] as Array<{ name: string; size: number }> },
}));
vi.mock('../../src/lib/minio.js', () => ({
  MINIO_BUCKET: 'test-bucket',
  minioClient: {
    listObjectsV2: () => ({
      async *[Symbol.asyncIterator]() {
        for (const k of minioState.keys) yield { name: k.name, size: k.size };
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

const CONTAINER_KEY = 'users/u1/8f0e2c10-9d3f-4f5a-8b6c-7d1e2f3a4b5c-拼版件.pdf';
const PLAIN_KEY = 'users/u1/9f1e3c11-0e4f-4f5a-8b6c-7d1e2f3a4b5c-普通件.pdf';

let ctx: DbContext;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
  ctxHolder.current = ctx;
  minioState.keys = [
    { name: CONTAINER_KEY, size: 10 },
    { name: PLAIN_KEY, size: 20 },
  ];
});

/** container + 2 unit 子单据。unit 存根先落(无 minio_key, 与 container 共享
 *  source_uri): 让 LIKE fallback 在未加固时按插入序先命中 unit 行, 测试才能
 *  真正锁住加固行为。 */
async function seedContainer(): Promise<string> {
  const sourceUri = `D:/ingest/${CONTAINER_KEY.replace(/\//g, '_')}`;
  const children: string[] = [];
  for (let i = 0; i < 2; i++) {
    const { docId } = await createDocumentStub(ctx, { sourceUri, userId: 'u1' });
    await setDocumentBatchRole(ctx, docId, 'unit');
    children.push(docId);
  }
  const { docId } = await createDocumentStub(ctx, { sourceUri, minioKey: CONTAINER_KEY, userId: 'u1' });
  await setDocumentBatchRole(ctx, docId, 'container');
  await saveDocumentUnits(ctx, [
    { parentDocumentId: docId, childDocumentId: children[0], unitIndex: 1, docType: '汽运磅单' },
    { parentDocumentId: docId, childDocumentId: children[1], unitIndex: 2, docType: '质检报告' },
  ]);
  return docId;
}

async function seedPlain(): Promise<string> {
  const { docId } = await createDocumentStub(ctx, {
    sourceUri: `D:/ingest/${PLAIN_KEY.replace(/\//g, '_')}`,
    minioKey: PLAIN_KEY,
    userId: 'u1',
  });
  return docId;
}

describe('GET /api/files batch lineage fields (P3)', () => {
  it('container 条目带 batchRole=container + unitCount, 普通文件恒 null', async () => {
    await seedContainer();
    await seedPlain();
    const res = await appAs('u1').request('/api/files');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { files: Array<Record<string, unknown>> };
    const container = body.files.find((f) => String(f.name).includes('拼版件'))!;
    const plain = body.files.find((f) => String(f.name).includes('普通件'))!;
    expect(container.batchRole).toBe('container');
    expect(container.unitCount).toBe(2);
    expect(plain.batchRole).toBeNull();
    expect(plain.unitCount).toBeNull();
  });

  it('parseStage/stageStartedAt: 置了阶段的条目带值, 未置阶段恒 null', async () => {
    const containerId = await seedContainer();
    await seedPlain();
    // 手工置阶段(模拟解析进行中; 终态清空由管线测试覆盖)。
    await updateDocumentParseStage(ctx, containerId, 'ocr');

    const res = await appAs('u1').request('/api/files');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      files: Array<{ name: string; parseStage: string | null; stageStartedAt: string | null }>;
    };
    const container = body.files.find((f) => f.name.includes('拼版件'))!;
    const plain = body.files.find((f) => f.name.includes('普通件'))!;
    expect(container.parseStage).toBe('ocr');
    expect(typeof container.stageStartedAt).toBe('string');
    expect(Number.isNaN(Date.parse(container.stageStartedAt!))).toBe(false);
    expect(plain.parseStage).toBeNull();
    expect(plain.stageStartedAt).toBeNull();
  });
});

describe('findDocIdsByMinioKeys source_uri fallback excludes unit rows (P3)', () => {
  it('unit 与 container 共享 source_uri: fallback 命中 container, 不被 unit 劫持', async () => {
    const containerId = await seedContainer();
    // 精确 minio_key 不在(模拟 folder move 后旧 key 反查) -> 走 source_uri LIKE fallback。
    const movedKey = 'users/u1/新家/8f0e2c10-9d3f-4f5a-8b6c-7d1e2f3a4b5c-拼版件.pdf';
    const map = await findDocIdsByMinioKeys(ctx, [movedKey], 'u1');
    expect(map.get(movedKey)).toBe(containerId);
  });
});
