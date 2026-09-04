import { describe, it, expect, beforeAll, vi } from 'vitest';
import { Hono } from 'hono';
import type { AuthEnv } from '../../src/lib/auth-middleware.js';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import {
  createDocumentStub,
  setDocumentBatchRole,
  saveDocumentUnits,
} from '../../src/pipeline/db/repositories.js';

const { ctxHolder } = vi.hoisted(() => ({ ctxHolder: { current: null as DbContext | null } }));
vi.mock('../../src/pipeline/db/dbBackend.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/pipeline/db/dbBackend.js')>();
  return { ...mod, getDbContext: () => ctxHolder.current };
});

const { reviewRoute } = await import('../../src/routes/review.js');

beforeAll(() => {
  const ctx = createDb(':memory:');
  migrate(ctx.sqlite);
  ctxHolder.current = ctx;
});

function appAs(userId: string, role = 'trader') {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { id: userId, email: 't@t', role } as never);
    await next();
  });
  app.route('/api/documents', reviewRoute);
  return app;
}

function rawStatus(docId: string) {
  return ctxHolder.current!.sqlite
    .prepare('SELECT review_status, review_action FROM documents WHERE id = ?')
    .get(docId) as { review_status: string; review_action: string | null } | undefined;
}

async function seedContainer(userId: string): Promise<{ container: string; children: string[] }> {
  const src = 'file:///batch.pdf';
  const mk = async (role: 'unit' | 'container') => {
    const { docId } = await createDocumentStub(ctxHolder.current!, { sourceUri: src, userId });
    await setDocumentBatchRole(ctxHolder.current!, docId, role);
    return docId;
  };
  const [c1, c2, container] = [await mk('unit'), await mk('unit'), await mk('container')];
  await saveDocumentUnits(ctxHolder.current!, [
    { parentDocumentId: container, childDocumentId: c1, unitIndex: 1, docType: '汽运磅单' },
    { parentDocumentId: container, childDocumentId: c2, unitIndex: 2, docType: '汽运磅单' },
  ]);
  return { container, children: [c1, c2] };
}

function post(app: ReturnType<typeof appAs>, url: string, body: unknown) {
  return app.request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/documents/:docId/review-batch', () => {
  it('批量确认: 逐单据写 confirmed + review_action', async () => {
    const { container, children } = await seedContainer('u1');
    const res = await post(appAs('u1'), `/api/documents/${container}/review-batch`, {
      actions: [
        { docId: children[0], confirm: true, action: 'manual' },
        { docId: children[1], confirm: true, action: 'auto-release' },
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; results: Array<{ docId: string; ok: boolean }> };
    expect(body.ok).toBe(true);
    expect(body.results.every((r) => r.ok)).toBe(true);
    expect(rawStatus(children[0]!)).toEqual({ review_status: 'confirmed', review_action: 'manual' });
    expect(rawStatus(children[1]!)).toEqual({ review_status: 'confirmed', review_action: 'auto-release' });
  });

  it('非本 container 的 docId -> 该条失败, 其余成功(部分失败不回滚)', async () => {
    const { container, children } = await seedContainer('u1');
    const foreign = await seedContainer('u2');
    const res = await post(appAs('u1'), `/api/documents/${container}/review-batch`, {
      actions: [
        { docId: children[0]!, confirm: true, action: 'manual' },
        { docId: foreign.children[0]!, confirm: true, action: 'manual' },
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: Array<{ docId: string; ok: boolean; error?: string }> };
    expect(body.results.find((r) => r.docId === children[0])!.ok).toBe(true);
    const bad = body.results.find((r) => r.docId === foreign.children[0])!;
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('不属于');
    expect(rawStatus(children[0]!)!.review_status).toBe('confirmed');
  });

  it('幂等: 重复确认已 confirmed 的单据 -> ok', async () => {
    const { container, children } = await seedContainer('u1');
    const first = await post(appAs('u1'), `/api/documents/${container}/review-batch`, {
      actions: [{ docId: children[0], confirm: true, action: 'manual' }],
    });
    expect(first.status).toBe(200);
    const second = await post(appAs('u1'), `/api/documents/${container}/review-batch`, {
      actions: [{ docId: children[0], confirm: true, action: 'manual' }],
    });
    expect(second.status).toBe(200);
    expect(((await second.json()) as { results: Array<{ ok: boolean }> }).results[0]!.ok).toBe(true);
  });

  it('auto-release 闸门: 非 pending 状态的子单据拒绝放行(manual 幂等不受影响)', async () => {
    const { container, children } = await seedContainer('u1');
    await post(appAs('u1'), `/api/documents/${container}/review-batch`, {
      actions: [{ docId: children[0], confirm: true, action: 'manual' }],
    });
    const res = await post(appAs('u1'), `/api/documents/${container}/review-batch`, {
      actions: [{ docId: children[0], confirm: true, action: 'auto-release' }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: Array<{ docId: string; ok: boolean; error?: string }>;
    };
    const r = body.results.find((x) => x.docId === children[0])!;
    expect(r.ok).toBe(false);
    expect(r.error).toContain('不是待复核');
    expect(rawStatus(children[0]!)).toEqual({ review_status: 'confirmed', review_action: 'manual' });
  });

  it('参数校验: 空 actions / 非法 action -> 400', async () => {
    const { container } = await seedContainer('u1');
    expect(
      (await post(appAs('u1'), `/api/documents/${container}/review-batch`, { actions: [] })).status,
    ).toBe(400);
    expect(
      (await post(appAs('u1'), `/api/documents/${container}/review-batch`, {
        actions: [{ docId: 'DOC-x', confirm: true, action: 'weird' }],
      })).status,
    ).toBe(400);
  });

  it('非 container -> 404; 他人 -> 404; viewer 角色 -> 403', async () => {
    const { container } = await seedContainer('u1');
    const { docId: plain } = await createDocumentStub(ctxHolder.current!, {
      sourceUri: 'file:///p.pdf', userId: 'u1',
    });
    const one = [{ docId: 'DOC-x', confirm: true, action: 'manual' }];
    expect((await post(appAs('u1'), `/api/documents/${plain}/review-batch`, { actions: one })).status).toBe(404);
    expect((await post(appAs('u2'), `/api/documents/${container}/review-batch`, { actions: one })).status).toBe(404);
    expect((await post(appAs('u1', 'viewer'), `/api/documents/${container}/review-batch`, { actions: one })).status).toBe(403);
  });
});