// Feature: 对话分享(2026-08-31) -- 公开只读快照端点。
//
// 快照由 POST /api/sessions/:sessionId/share(在 sessions.ts, requireAuth 保护)
// 生成/刷新; 本文件是消费侧: GET /api/share/:token 按 token 读快照。
//
// 这是 /api/share 下的 PUBLIC 端点: 外部用户无需登录即可访问, 绝不能挂
// requireAuth(index.ts 的受保护挂载清单里没有 /api/share)。token 是不可猜测的
// randomUUID, 本身即访问凭证; payload 是分享时刻的 messages 副本(再次分享才刷新)。

import { Hono } from 'hono';
import type { AuthEnv } from '../lib/auth-middleware.js';
import { getDbContext } from '../pipeline/db/dbBackend.js';
import { getConversationShareByToken } from '../pipeline/db/repositories.js';

export const shareRoute = new Hono<AuthEnv>();

shareRoute.get('/:token', async (c) => {
  const token = c.req.param('token');
  const row = await getConversationShareByToken(getDbContext(), token);
  // 404 (not 403) for unknown tokens -- token space is unguessable UUIDs, so
  // probing is the only attack and 404 gives it nothing.
  if (!row) return c.json({ error: 'not found' }, 404);

  // payload is JSON.stringify({ messages: UIMessage[] }) written by the share
  // POST; parse defensively so a corrupt row degrades to an empty transcript
  // instead of a 500 on a public endpoint.
  let messages: unknown = [];
  try {
    const parsed = JSON.parse(row.payload) as { messages?: unknown };
    if (parsed && Array.isArray(parsed.messages)) messages = parsed.messages;
  } catch {
    messages = [];
  }
  return c.json({ title: row.title, createdAt: row.createdAt, messages });
});
