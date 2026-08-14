import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate } from '../../../src/pipeline/db/client.js';
import {
  createDocumentStub,
  setDocumentParseStatus,
  getDocumentParseStatus,
  getDocumentSourceUri,
} from '../../../src/pipeline/db/repositories.js';

// Model B: decouple upload from parse. These cover the documents.parse_status
// lifecycle column + the stub/lifecycle repository fns on SQLite (the default
// runtime). Postgres twins are exercised by postgres.integration.test.ts when
// DB_BACKEND=postgres is set.

let ctx: ReturnType<typeof createDb>;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
});

describe('document parse_status lifecycle (Model B)', () => {
  it('createDocumentStub inserts a row with parse_status=uploaded', async () => {
    const { docId } = await createDocumentStub(ctx, {
      sourceUri: '/tmp/x.txt',
      minioKey: 'users/u1/abc.txt',
      userId: 'u1',
      filename: 'x.txt',
      docType: '合同',
    });
    expect(docId).toMatch(/^DOC-/);
    // Default lifecycle state on a fresh stub.
    expect(await getDocumentParseStatus(ctx, docId)).toBe('uploaded');
    // source_uri is echoed back so processDocument can resolve the source path.
    expect(await getDocumentSourceUri(ctx, docId)).toBe('/tmp/x.txt');
  });

  it('createDocumentStub applies docType/defaults and stamps minio_key/user_id', async () => {
    const { docId } = await createDocumentStub(ctx, {
      sourceUri: '/tmp/y.txt',
      minioKey: 'users/u2/y.txt',
      userId: 'u2',
      docType: '发票',
    });
    // doc_type from input, modality placeholder 'digital' (overwritten at parse
    // time), minio_key + user_id stamped. block_model is a valid (empty) JSON
    // placeholder so a pre-parse loadDocument does not crash.
    const row = ctx.sqlite
      .prepare('SELECT doc_type, modality, minio_key, user_id, block_model FROM documents WHERE id = ?')
      .get(docId) as {
        doc_type: string;
        modality: string;
        minio_key: string;
        user_id: string;
        block_model: string;
      };
    expect(row.doc_type).toBe('发票');
    expect(row.modality).toBe('digital');
    expect(row.minio_key).toBe('users/u2/y.txt');
    expect(row.user_id).toBe('u2');
    expect(() => JSON.parse(row.block_model)).not.toThrow();
    expect(JSON.parse(row.block_model).blocks).toEqual([]);
  });

  it('setDocumentParseStatus round-trips uploaded -> parsing -> parsed', async () => {
    const { docId } = await createDocumentStub(ctx, { sourceUri: '/tmp/z.txt' });
    expect(await getDocumentParseStatus(ctx, docId)).toBe('uploaded');

    await setDocumentParseStatus(ctx, docId, 'parsing');
    expect(await getDocumentParseStatus(ctx, docId)).toBe('parsing');

    await setDocumentParseStatus(ctx, docId, 'parsed');
    expect(await getDocumentParseStatus(ctx, docId)).toBe('parsed');
  });

  it('setDocumentParseStatus records needs_ocr and failed states', async () => {
    const { docId } = await createDocumentStub(ctx, { sourceUri: '/tmp/scan.txt' });
    await setDocumentParseStatus(ctx, docId, 'needs_ocr');
    expect(await getDocumentParseStatus(ctx, docId)).toBe('needs_ocr');
    await setDocumentParseStatus(ctx, docId, 'failed');
    expect(await getDocumentParseStatus(ctx, docId)).toBe('failed');
  });

  it('getDocumentSourceUri returns null for a missing doc', async () => {
    expect(await getDocumentSourceUri(ctx, 'DOC-does-not-exist')).toBeNull();
    expect(await getDocumentParseStatus(ctx, 'DOC-does-not-exist')).toBeNull();
  });
});
