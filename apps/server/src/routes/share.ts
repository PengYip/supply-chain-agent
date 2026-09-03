// Feature: 对话分享(2026-08-31) -- 公开只读快照端点。
//
// 快照由 POST /api/sessions/:sessionId/share(在 sessions.ts, requireAuth 保护)
// 生成/刷新; 本文件是消费侧: GET /api/share/:token 按 token 读快照。
//
// 这是 /api/share 下的 PUBLIC 端点: 外部用户无需登录即可访问, 绝不能挂
// requireAuth(index.ts 的受保护挂载清单里没有 /api/share)。token 是不可猜测的
// randomUUID, 本身即访问凭证; payload 是分享时刻的 messages 副本(再次分享才刷新)。

import { Hono } from 'hono';
import { Readable } from 'node:stream';
import { minioClient, MINIO_BUCKET } from '../lib/minio.js';
import type { AuthEnv } from '../lib/auth-middleware.js';
import { getDbContext } from '../pipeline/db/dbBackend.js';
import { getConversationShareByToken } from '../pipeline/db/repositories.js';
import { contentTypeForKey, parseFileKey } from './files.js';

export const shareRoute = new Hono<AuthEnv>();

/** Parse the immutable share payload defensively. Returns an empty transcript
 *  when the row is corrupt so public readers never turn a bad row into a 500. */
function parseSharedMessages(row: { payload: string }): unknown[] {
  try {
    const parsed = JSON.parse(row.payload) as { messages?: unknown };
    if (parsed && Array.isArray(parsed.messages)) return parsed.messages;
  } catch {
    // Fall through to the empty transcript.
  }
  return [];
}

/** Collect MinIO keys explicitly embedded in data-attachment parts. File access
 *  is granted by exact membership, not by key prefix: a share token grants the
 *  files shown in that conversation, never the owner's whole bucket prefix. */
function collectSharedFileKeys(messages: unknown[]): Set<string> {
  const keys = new Set<string>();
  for (const raw of messages) {
    if (raw === null || typeof raw !== 'object') continue;
    const msg = raw as { parts?: unknown };
    if (!Array.isArray(msg.parts)) continue;
    for (const part of msg.parts) {
      if (part === null || typeof part !== 'object') continue;
      const p = part as { type?: unknown; data?: unknown };
      if (p.type !== 'data-attachment' || p.data === null || typeof p.data !== 'object') continue;
      const d = p.data as { key?: unknown };
      if (typeof d.key === 'string' && d.key.length > 0) keys.add(d.key);
    }
  }
  return keys;
}

/** Load a share and verify that `key` is explicitly present in its transcript.
 *  Returns the row + parsed messages on success; null means unknown token,
 *  unknown file, or a stale/malicious key that is not part of the snapshot. */
async function authorizeSharedFile(token: string, key: string) {
  const row = await getConversationShareByToken(getDbContext(), token);
  if (!row || !key) return null;
  const messages = parseSharedMessages(row);
  if (!collectSharedFileKeys(messages).has(key)) return null;
  // Defense in depth against legacy/corrupt snapshots: an attachment key must
  // still belong to the owner who created the share.
  if (!row.ownerUserId || !key.startsWith(`users/${row.ownerUserId}/`)) return null;
  return { row, messages };
}

shareRoute.get('/:token', async (c) => {
  const token = c.req.param('token');
  const row = await getConversationShareByToken(getDbContext(), token);
  // 404 (not 403) for unknown tokens -- token space is unguessable UUIDs, so
  // probing is the only attack and 404 gives it nothing.
  if (!row) return c.json({ error: 'not found' }, 404);

  // payload is JSON.stringify({ messages: UIMessage[] }) written by the share
  // POST; parse defensively so a corrupt row degrades to an empty transcript
  // instead of a 500 on a public endpoint.
  const messages = parseSharedMessages(row);
  return c.json({ title: row.title, createdAt: row.createdAt, messages });
});

// Stream an object explicitly referenced by this share. The token is the public
// read credential, but membership in the immutable snapshot is the object-level
// authorization; no `users/:id/` prefix guessing is possible.
shareRoute.get('/:token/file', async (c) => {
  const token = c.req.param('token');
  const key = c.req.query('key') ?? '';
  const authorized = await authorizeSharedFile(token, key);
  if (!authorized) return c.json({ error: 'not found' }, 404);

  let obj;
  try {
    obj = await minioClient.getObject(MINIO_BUCKET, key);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[share] file stream failed:', msg);
    return c.json({ error: 'stream failed', detail: msg }, 500);
  }

  const name = parseFileKey(key, authorized.row.ownerUserId)?.name ?? key.split('/').pop() ?? key;
  const webStream = Readable.toWeb(obj) as unknown as ReadableStream;
  return new Response(webStream, {
    headers: {
      'Content-Type': contentTypeForKey(key),
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(name)}`,
      'Cache-Control': 'no-store',
    },
  });
});
