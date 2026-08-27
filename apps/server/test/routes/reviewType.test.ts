import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import { Hono } from 'hono';
import type { AuthEnv } from '../../src/lib/auth-middleware.js';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import {
  createDocumentStub, getDocumentMeta, saveExtraction,
} from '../../src/pipeline/db/repositories.js';
import { ensureTemplateSeed } from '../../src/pipeline/templateSeed.js';
import type { DocType } from '../../src/pipeline/types.js';

// reviewRoute 的 DbContext 经 getDbContext(dbBackend) 解析。逐测试注入内存 ctx。
const { ctxHolder } = vi.hoisted(() => ({
  ctxHolder: { current: null as DbContext | null },
}));
vi.mock('../../src/pipeline/db/dbBackend.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/pipeline/db/dbBackend.js')>();
  return { ...mod, getDbContext: () => ctxHolder.current };
});

// 桩掉执行流水重建: 路由测试聚焦 路由/校验/所有权 分支, 重建逻辑由
// executionFlow 测试覆盖(与本仓其他路由测试 mock 存储层的做法一致)。
const { refreshMock } = vi.hoisted(() => ({
  refreshMock: vi.fn<(args: unknown[]) => Promise<{ retracted: number; materialized: number; skipped: unknown[] }>>(
    async () => ({ retracted: 0, materialized: 1, skipped: [] }),
  ),
}));
vi.mock('../../src/pipeline/executionFlow.js', () => ({
  refreshExecutionFlowsForDocument: refreshMock,
}));

// 桩掉 docType 图同步(F3): 路由测试聚焦 路由/校验/所有权 分支, 图同步由
// graphCommit.test.ts 覆盖。partial mock 保留 commitDocumentGraph(确认路径用)。
const { syncMock } = vi.hoisted(() => ({
  syncMock: vi.fn<(args: unknown[]) => Promise<void>>(async () => {}),
}));
vi.mock('../../src/pipeline/graphCommit.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/pipeline/graphCommit.js')>();
  return { ...mod, syncDocumentTypeToGraph: syncMock };
});

const { reviewRoute } = await import('../../src/routes/review.js');

function appAs(userId: string) {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { id: userId, email: 't@t', role: 'trader' } as any);
    await next();
  });
  app.route('/api/documents', reviewRoute);
  return app;
}

async function seedDoc(ctx: DbContext, overrides: { userId?: string; docType?: string } = {}) {
  const { docId } = await createDocumentStub(ctx, {
    sourceUri: 'file:///inv.pdf',
    docType: (overrides.docType ?? '其他') as DocType,
    userId: overrides.userId ?? 'u1',
  });
  await saveExtraction(ctx, {
    documentId: docId, docType: '其他',
    fields: { 购买方名称: { value: '浙江浙能富兴燃料有限公司', sourceSpans: [] } },
    fieldMeta: {}, overallConfidence: 1, needsReview: false,
  }, overrides.userId ?? 'u1');
  return docId;
}

describe('PATCH /api/documents/:docId/type', () => {
  // reviewRoute 的 ctx() 是模块级懒单例(首个 getDbContext 结果缓存), 因此
  // 全文件共享一个内存库(路由始终落在同一个 ctxHolder 上); 每测试重置 mock。
  beforeAll(async () => {
    const ctx = createDb(':memory:');
    migrate(ctx.sqlite);
    await ensureTemplateSeed(ctx); // PATCH /type 校验改模板派生, 需种子在位
    ctxHolder.current = ctx;
  });
  beforeEach(() => {
    refreshMock.mockReset();
    refreshMock.mockResolvedValue({ retracted: 0, materialized: 1, skipped: [] });
    syncMock.mockReset();
    syncMock.mockResolvedValue(undefined);
  });

  it('合法类型修正 -> 200 { ok:true, docType, refreshedFlows, skipped } 且落库', async () => {
    const ctx = ctxHolder.current!;
    const docId = await seedDoc(ctx);

    const res = await appAs('u1').request(`/api/documents/${docId}/type`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docType: '发票' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean; docType: string; refreshedFlows: number; skipped: unknown[];
    };
    expect(body).toEqual({ ok: true, docType: '发票', refreshedFlows: 1, skipped: [] });

    // 文档行与 extraction 行都已级联更新。
    const meta = await getDocumentMeta(ctx, docId, 'u1');
    expect(meta?.docType).toBe('发票');
    expect(refreshMock).toHaveBeenCalledWith(ctx, docId, 'u1');
    // F3: 图同步以新 docType 调用。
    expect(syncMock).toHaveBeenCalledWith(docId, '发票');
  });

  it('图同步失败(best-effort) -> PATCH 仍 200, 不阻断修正', async () => {
    const ctx = ctxHolder.current!;
    const docId = await seedDoc(ctx);
    syncMock.mockRejectedValue(new Error('neo4j down'));

    const res = await appAs('u1').request(`/api/documents/${docId}/type`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docType: '发票' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean; docType: string; refreshedFlows: number; skipped: unknown[];
    };
    expect(body).toEqual({ ok: true, docType: '发票', refreshedFlows: 1, skipped: [] });
    // 图同步失败后仍继续执行流水重建。
    expect(refreshMock).toHaveBeenCalled();
  });

  it('PATCH 透传 refresh 的 skipped(方向判不出等跳过原因)', async () => {
    const ctx = ctxHolder.current!;
    const docId = await seedDoc(ctx);
    refreshMock.mockResolvedValue({
      retracted: 0,
      materialized: 0,
      skipped: [{ bindingId: 'BD-1', contractNo: 'HT-1', reason: 'direction-undeterminable' }],
    });

    const res = await appAs('u1').request(`/api/documents/${docId}/type`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docType: '发票' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; refreshedFlows: number; skipped: unknown[] };
    expect(body.refreshedFlows).toBe(0);
    expect(body.skipped).toEqual([
      { bindingId: 'BD-1', contractNo: 'HT-1', reason: 'direction-undeterminable' },
    ]);
  });

  it('非法类型 -> 400 invalid_doc_type', async () => {
    const ctx = ctxHolder.current!;
    const docId = await seedDoc(ctx);

    const res = await appAs('u1').request(`/api/documents/${docId}/type`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docType: '采购单' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'invalid_doc_type' });
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('aliasOf 别名类型(提单) -> 400 invalid_doc_type(小修 4)', async () => {
    // 提单/装箱单是货转单的别名(props.aliasOf), boot 迁移 migrateDocTypeAliases
    // 会把设成别名的 doc_type 翻回 货转单 —— 人工修正接口必须拒绝这类值。
    const ctx = ctxHolder.current!;
    const docId = await seedDoc(ctx);

    const res = await appAs('u1').request(`/api/documents/${docId}/type`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docType: '提单' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'invalid_doc_type' });
    expect(refreshMock).not.toHaveBeenCalled();
    // 文档行未被修改。
    expect((await getDocumentMeta(ctx, docId, 'u1'))?.docType).toBe('其他');
  });

  it('缺 body / 空 docType -> 400 invalid_body', async () => {
    const ctx = ctxHolder.current!;
    const docId = await seedDoc(ctx);

    const noBody = await appAs('u1').request(`/api/documents/${docId}/type`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(noBody.status).toBe(400);
    expect(await noBody.json()).toEqual({ ok: false, error: 'invalid_body' });

    const empty = await appAs('u1').request(`/api/documents/${docId}/type`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docType: '' }),
    });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ ok: false, error: 'invalid_body' });
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('非本人文档(他人私有行) -> 404 document_not_found', async () => {
    const ctx = ctxHolder.current!;
    const docId = await seedDoc(ctx, { userId: 'u-other' });

    const res = await appAs('u1').request(`/api/documents/${docId}/type`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docType: '发票' }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: 'document_not_found' });
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('文档不存在 -> 404 document_not_found', async () => {
    const res = await appAs('u1').request('/api/documents/DOC-NOPE/type', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docType: '发票' }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: 'document_not_found' });
  });

  it('执行流水重建失败 -> 500(不告警吞掉)', async () => {
    const ctx = ctxHolder.current!;
    const docId = await seedDoc(ctx);
    refreshMock.mockRejectedValue(new Error('refresh boom'));

    const res = await appAs('u1').request(`/api/documents/${docId}/type`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docType: '发票' }),
    });
    expect(res.status).toBe(500);
    expect((await res.json()) as { ok: boolean; error: string }).toEqual({ ok: false, error: 'refresh boom' });
  });

  it('未认证 -> 401', async () => {
    const app = new Hono<AuthEnv>();
    app.route('/api/documents', reviewRoute);
    const res = await app.request('/api/documents/DOC-1/type', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docType: '发票' }),
    });
    expect(res.status).toBe(401);
  });
});
