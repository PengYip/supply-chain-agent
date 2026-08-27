import { describe, it, expect, beforeAll, vi } from 'vitest';
import { Hono } from 'hono';
import { env } from '../../src/env.js';
import type { AuthEnv } from '../../src/lib/auth-middleware.js';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import { getDocumentMeta } from '../../src/pipeline/db/repositories.js';
import {
  exceedsUploadLimit,
  contentTypeForKey,
  validateFolderPathChange,
  rewriteKeyPrefix,
  isPathUnderFolder,
  filesRoute,
} from '../../src/routes/files.js';

// ---- 小修 6a 测试基建(照 reviewType.test.ts 模式) ----
// 路由的 DbContext 经 getDbContext 解析 -> 注入内存库; MinIO 双桩(putObject/
// fGetObject)挡掉对象存储, 路由测试聚焦「回执字段 === 存根写入值」等值。
const { ctxHolder } = vi.hoisted(() => ({
  ctxHolder: { current: null as DbContext | null },
}));
vi.mock('../../src/pipeline/db/dbBackend.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/pipeline/db/dbBackend.js')>();
  return { ...mod, getDbContext: () => ctxHolder.current };
});
vi.mock('../../src/lib/minio.js', () => ({
  MINIO_BUCKET: 'sca-files',
  minioClient: {
    putObject: async () => {},
    fGetObject: async () => {},
    removeObject: async () => {},
  },
}));

describe('exceedsUploadLimit (upload size guard predicate)', () => {
  const limit = env.MAX_UPLOAD_BYTES;

  it('returns true when size exceeds the limit', () => {
    expect(exceedsUploadLimit(limit + 1, limit)).toBe(true);
    expect(exceedsUploadLimit(limit * 2, limit)).toBe(true);
  });

  it('returns false at or under the limit (boundary inclusive)', () => {
    expect(exceedsUploadLimit(limit, limit)).toBe(false);
    expect(exceedsUploadLimit(0, limit)).toBe(false);
    expect(exceedsUploadLimit(limit - 1, limit)).toBe(false);
  });

  it('default MAX_UPLOAD_BYTES is 25 MiB (CI-safe permissive default)', () => {
    // Only OPENAI_API_KEY is required; MAX_UPLOAD_BYTES has a permissive default
    // so env.ts zod-parses cleanly in CI and unit tests that import env.ts.
    expect(env.MAX_UPLOAD_BYTES).toBe(25 * 1024 * 1024);
  });
});

describe('contentTypeForKey (in-app stream MIME mapping)', () => {
  it('maps common office + document extensions to authoritative MIME types', () => {
    expect(contentTypeForKey('users/u1/abc-report.pdf')).toBe('application/pdf');
    expect(contentTypeForKey('users/u1/x.docx')).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(contentTypeForKey('users/u1/x.xlsx')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(contentTypeForKey('users/u1/x.pptx')).toBe(
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    );
    expect(contentTypeForKey('users/u1/x.doc')).toBe('application/msword');
    expect(contentTypeForKey('users/u1/x.xls')).toBe('application/vnd.ms-excel');
    expect(contentTypeForKey('users/u1/x.ppt')).toBe('application/vnd.ms-powerpoint');
  });

  it('matches extensions case-insensitively', () => {
    expect(contentTypeForKey('users/u1/REPORT.PDF')).toBe('application/pdf');
    expect(contentTypeForKey('users/u1/scan.JpEg')).toBe('image/jpeg');
    expect(contentTypeForKey('users/u1/sheet.XLSX')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
  });

  it('falls back to application/octet-stream for unknown or missing extensions', () => {
    expect(contentTypeForKey('users/u1/archive.7z')).toBe('application/octet-stream');
    expect(contentTypeForKey('users/u1/noext')).toBe('application/octet-stream');
  });

  it('handles keys with directories and a uuid prefix (upload key shape)', () => {
    const key = 'users/u1/合同/2026/8f0e2c10-9d3f-4f5a-8b6c-7d1e2f3a4b5c-报告.pdf';
    expect(contentTypeForKey(key)).toBe('application/pdf');
    // Extension comes from the final path segment only, not earlier dots.
    expect(contentTypeForKey('users/u1/dir.with.dots/file.txt')).toBe('text/plain');
  });
});

describe('validateFolderPathChange (folder rename/move guard)', () => {
  it('rejects empty from', () => {
    expect(validateFolderPathChange('', 'x')).toEqual({ ok: false, reason: 'empty_from' });
    expect(validateFolderPathChange('/', 'x')).toEqual({ ok: false, reason: 'empty_from' });
  });

  it('rejects same-path rename and moving a folder into its own subtree', () => {
    expect(validateFolderPathChange('a', 'a')).toEqual({ ok: false, reason: 'same_path' });
    expect(validateFolderPathChange('/a/', 'a')).toEqual({ ok: false, reason: 'same_path' });
    expect(validateFolderPathChange('a', 'a/b')).toEqual({ ok: false, reason: 'self_nested' });
    expect(validateFolderPathChange('a', 'a/b/c')).toEqual({ ok: false, reason: 'self_nested' });
  });

  it('accepts legitimate renames and moves', () => {
    expect(validateFolderPathChange('合同', '合同2026')).toEqual({ ok: true });
    expect(validateFolderPathChange('汽运业务资料', '煤焦化/发运')).toEqual({ ok: true });
    expect(validateFolderPathChange('a/b', 'a')).toEqual({ ok: true });
    expect(validateFolderPathChange('', '')).toEqual({ ok: false, reason: 'empty_from' });
  });
});

describe('isPathUnderFolder (subtree membership predicate)', () => {
  it('matches exact and prefix paths', () => {
    expect(isPathUnderFolder('a', 'a')).toBe(true);
    expect(isPathUnderFolder('a/b', 'a')).toBe(true);
    expect(isPathUnderFolder('a/b/c', 'a')).toBe(true);
  });

  it('does not match sibling names sharing characters or unrelated paths', () => {
    expect(isPathUnderFolder('ab', 'a')).toBe(false);
    expect(isPathUnderFolder('b/a', 'a')).toBe(false);
    expect(isPathUnderFolder('', 'a')).toBe(false);
  });
});

describe('rewriteKeyPrefix (MinIO key relocation math)', () => {
  it('replaces the <uid>/<from>/ prefix and keeps trailing segments', () => {
    expect(rewriteKeyPrefix('users/u1/合同/x.pdf', 'u1', '合同', '合同2026'))
      .toBe('users/u1/合同2026/x.pdf');
    expect(rewriteKeyPrefix('users/u1/合同/子/xy.txt', 'u1', '合同', '发运/合同'))
      .toBe('users/u1/发运/合同/子/xy.txt');
  });

  it('leaves keys outside the folder untouched', () => {
    expect(rewriteKeyPrefix('users/u1/发票/a.pdf', 'u1', '合同', '合同2'))
      .toBe('users/u1/发票/a.pdf');
    expect(rewriteKeyPrefix('users/u1/合同化/a.pdf', 'u1', '合同', '合同2'))
      .toBe('users/u1/合同化/a.pdf');
    expect(rewriteKeyPrefix('users/u2/合同/a.pdf', 'u1', '合同', '合同2'))
      .toBe('users/u2/合同/a.pdf');
  });
});

// ---- 小修 6a: 上传回执携带存储 docType(叙述修正 G 的服务端一半) ----
describe('POST /api/files (upload receipt echoes the STORED docType)', () => {
  function appAs(userId: string) {
    const app = new Hono<AuthEnv>();
    app.use('*', async (c, next) => {
      c.set('user', { id: userId, email: 't@t', role: 'trader' } as never);
      await next();
    });
    app.route('/api/files', filesRoute);
    return app;
  }

  beforeAll(async () => {
    const ctx = createDb(':memory:');
    migrate(ctx.sqlite);
    ctxHolder.current = ctx;
  });

  async function upload(docType?: string) {
    const fd = new FormData();
    fd.append('file', new File(['采购合同内容'], '采购合同.txt', { type: 'text/plain' }));
    if (docType !== undefined) fd.append('docType', docType);
    const res = await appAs('u1').request('/api/files', { method: 'POST', body: fd });
    return { res, body: (await res.json()) as Record<string, unknown> };
  }

  it('回执 docType === 存根写入值(合法传入原样落库并回显)', async () => {
    const { res, body } = await upload('发票');
    expect(res.status).toBe(201);
    expect(body.docType).toBe('发票');
    // 等值断言: 响应字段 === createDocumentStub 落库后的真实存储值。
    const meta = await getDocumentMeta(ctxHolder.current!, String(body.docId), 'u1');
    expect(meta?.docType).toBe(body.docType);
  });

  it('非法 docType 走 ALLOWED_DOCTYPES 兜底为 其他, 回执与存根一致', async () => {
    const { res, body } = await upload('不是合法类型');
    expect(res.status).toBe(201);
    expect(body.docType).toBe('其他');
    const meta = await getDocumentMeta(ctxHolder.current!, String(body.docId), 'u1');
    expect(meta?.docType).toBe(body.docType);
  });

  it('缺省 docType 兜底为 其他, 回执与存根一致', async () => {
    const { res, body } = await upload();
    expect(res.status).toBe(201);
    expect(body.docType).toBe('其他');
    const meta = await getDocumentMeta(ctxHolder.current!, String(body.docId), 'u1');
    expect(meta?.docType).toBe(body.docType);
  });
});
