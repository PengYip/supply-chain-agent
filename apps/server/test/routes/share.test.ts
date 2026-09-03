import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { Readable } from 'node:stream';
import type { AuthEnv, SessionUser } from '../../src/lib/auth-middleware.js';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import {
  createSession,
  setSessionTitle,
  appendMessages,
} from '../../src/harness/sessionStore.js';
import type { UIMessage } from 'ai';

// 对话分享路由测试(feature 2026-08-31): POST /api/sessions/:id/share(受保护)+
// GET /api/share/:token(公开, 不挂任何 auth 中间件)。scaffold 对齐 quotas.test.ts
// 的 ctxHolder mock(dbBackend.getDbContext -> 内存 SQLite)+ favorites.test.ts
// 的 appAs 用户注入。会话本体在 harness session store(agent.db)。

const { ctxHolder } = vi.hoisted(() => ({ ctxHolder: { current: null as DbContext | null } }));
vi.mock('../../src/pipeline/db/dbBackend.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/pipeline/db/dbBackend.js')>();
  return { ...mod, getDbContext: () => ctxHolder.current };
});
const { minioHolder } = vi.hoisted(() => ({
  minioHolder: {
    getObject: async () => { throw new Error('unexpected getObject') },
  },
}));
vi.mock('../../src/lib/minio.js', () => ({
  minioClient: minioHolder,
  MINIO_BUCKET: 'sca-files',
}));
const { sessionsRoute } = await import('../../src/routes/sessions.js');
const { shareRoute } = await import('../../src/routes/share.js');

function trader(id: string, role: SessionUser['role'] = 'trader'): SessionUser {
  return { id, email: `${id}@t`, name: null, role };
}

// Owner app: sessions 路由挂在受保护挂载下(生产由 index.ts requireAuth 兜底,
// 这里直接注入用户, 与 favorites/quotas 测试同款)。
function appAs(user: SessionUser) {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('user', user);
    await next();
  });
  app.route('/api/sessions', sessionsRoute);
  return app;
}

// Public app: /api/share 在生产不挂 requireAuth —— 这里一个中间件都不加,
// 证明该端点无需任何认证上下文即可访问。
function publicApp() {
  const app = new Hono<AuthEnv>();
  app.route('/api/share', shareRoute);
  return app;
}

function msg(id: string, role: 'user' | 'assistant', text: string): UIMessage {
  return { id, role, parts: [{ type: 'text', text }] } as UIMessage;
}

function attachmentMsg(id: string, key: string): UIMessage {
  return {
    id,
    role: 'user',
    parts: [
      {
        type: 'data-attachment',
        id: key,
        data: { filename: 'contract.pdf', docId: 'DOC-test', key, fileType: 'PDF' },
      },
      { type: 'text', text: '请看这份文件' },
    ],
  } as UIMessage;
}

beforeEach(() => {
  ctxHolder.current = createDb(':memory:');
  migrate(ctxHolder.current.sqlite);
});

describe('POST /api/sessions/:id/share', () => {
  it('owner 分享成功, 返回 token + path 形状', async () => {
    const s = await createSession('trader', 'u1');
    const res = await appAs(trader('u1')).request(`/api/sessions/${s.id}/share`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; path: string };
    expect(body.token).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(body.path).toBe(`/share/${body.token}`);
  });

  it('not-owned session -> 404 (existence hidden)', async () => {
    const s = await createSession('trader', 'u1');
    const res = await appAs(trader('u2')).request(`/api/sessions/${s.id}/share`, { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('unknown session -> 404', async () => {
    const res = await appAs(trader('u1')).request('/api/sessions/no-such-id/share', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('unauthenticated -> 401', async () => {
    const app = new Hono<AuthEnv>();
    app.route('/api/sessions', sessionsRoute);
    const res = await app.request('/api/sessions/x/share', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('viewer -> 403 (只读角色不能对外发放分享链接)', async () => {
    const s = await createSession('trader', 'v1');
    const res = await appAs(trader('v1', 'viewer')).request(`/api/sessions/${s.id}/share`, { method: 'POST' });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/share/:token (public)', () => {
  it('无认证可读快照: title/createdAt/messages 原样返回', async () => {
    const s = await createSession('trader', 'u1');
    await setSessionTitle(s.id, '合同查询会话');
    await appendMessages(s.id, [msg('m1', 'user', '查一下 HT-2024 的交货期'), msg('m2', 'assistant', '交货期为 2024-10-01')]);
    const share = (await (
      await appAs(trader('u1')).request(`/api/sessions/${s.id}/share`, { method: 'POST' })
    ).json()) as { token: string };

    const res = await publicApp().request(`/api/share/${share.token}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      title: string;
      createdAt: string;
      messages: UIMessage[];
    };
    expect(body.title).toBe('合同查询会话');
    expect(typeof body.createdAt).toBe('string');
    expect(body.createdAt.length).toBeGreaterThan(0);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe('user');
    expect((body.messages[0].parts[0] as { text: string }).text).toBe('查一下 HT-2024 的交货期');
    expect((body.messages[1].parts[0] as { text: string }).text).toBe('交货期为 2024-10-01');
  });

  it('错误 token -> 404', async () => {
    const res = await publicApp().request('/api/share/00000000-0000-4000-8000-000000000000');
    expect(res.status).toBe(404);
  });

  it('重复分享 upsert: 旧 token 失效, 新 token 读到刷新后的内容', async () => {
    const s = await createSession('trader', 'u1');
    await appendMessages(s.id, [msg('m1', 'user', '第一轮')]);
    const app = appAs(trader('u1'));
    const first = (await (await app.request(`/api/sessions/${s.id}/share`, { method: 'POST' })).json()) as { token: string };

    // 会话继续 + 再次分享: 快照刷新为当前状态。
    await appendMessages(s.id, [msg('m2', 'assistant', '第二轮回复')]);
    const second = (await (await app.request(`/api/sessions/${s.id}/share`, { method: 'POST' })).json()) as { token: string };
    expect(second.token).not.toBe(first.token);

    expect((await publicApp().request(`/api/share/${first.token}`)).status).toBe(404);
    const refreshed = (await (await publicApp().request(`/api/share/${second.token}`)).json()) as {
      messages: UIMessage[];
    };
    expect(refreshed.messages).toHaveLength(2);
    expect((refreshed.messages[1].parts[0] as { text: string }).text).toBe('第二轮回复');
  });

  it('快照是分享时刻副本: 分享后追加消息不影响已分享内容', async () => {
    const s = await createSession('trader', 'u1');
    await appendMessages(s.id, [msg('m1', 'user', '分享前的消息')]);
    const { token } = (await (
      await appAs(trader('u1')).request(`/api/sessions/${s.id}/share`, { method: 'POST' })
    ).json()) as { token: string };

    await appendMessages(s.id, [msg('m2', 'assistant', '分享后的消息(不应出现)')]);
    const body = (await (await publicApp().request(`/api/share/${token}`)).json()) as {
      messages: UIMessage[];
    };
    expect(body.messages).toHaveLength(1);
    expect((body.messages[0].parts[0] as { text: string }).text).toBe('分享前的消息');
  });
});

describe('GET /api/share/:token/file (public, object-level authz)', () => {
  const fileKey = 'users/u1/docs/00000000-0000-4000-8000-000000000000-contract.pdf';

  beforeEach(() => {
    minioHolder.getObject = vi.fn(async () => Readable.from([Buffer.from('pdf-bytes')]));
  });

  async function shareAttachment(tokenOwner = 'u1') {
    const s = await createSession('trader', tokenOwner);
    await appendMessages(s.id, [attachmentMsg('m1', fileKey)]);
    return (await (
      await appAs(trader(tokenOwner)).request(`/api/sessions/${s.id}/share`, { method: 'POST' })
    ).json()) as { token: string };
  }

  it('无认证可流式预览快照中明确出现的附件', async () => {
    const { token } = await shareAttachment();
    const res = await publicApp().request(`/api/share/${token}/file?key=${encodeURIComponent(fileKey)}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('pdf-bytes');
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
    expect(res.headers.get('Content-Disposition')).toContain('contract.pdf');
  });

  it('拒绝不在快照里的任意对象（不能按 owner 前缀越权猜 key）', async () => {
    const { token } = await shareAttachment();
    const res = await publicApp().request(
      `/api/share/${token}/file?key=${encodeURIComponent('users/u1/secret.pdf')}`,
    );
    expect(res.status).toBe(404);
    expect(minioHolder.getObject).not.toHaveBeenCalled();
  });
});
