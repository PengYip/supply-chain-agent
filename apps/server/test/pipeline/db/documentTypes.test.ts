import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate } from '../../../src/pipeline/db/client.js';
import {
  createDocumentStub,
  getDocumentTypes,
  setDocumentParseStatus,
} from '../../../src/pipeline/db/repositories.js';

let ctx: ReturnType<typeof createDb>;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
});

describe('getDocumentTypes', () => {
  it('batch-reads visible document types and preserves one stable result per id', async () => {
    const contract = await createDocumentStub(ctx, {
      sourceUri: '/tmp/contract.pdf',
      userId: 'u1',
      filename: 'contract.pdf',
      docType: '合同',
    });
    const invoice = await createDocumentStub(ctx, {
      sourceUri: '/tmp/invoice.pdf',
      userId: 'u1',
      filename: 'invoice.pdf',
      docType: '发票',
    });
    const other = await createDocumentStub(ctx, {
      sourceUri: '/tmp/other.pdf',
      userId: 'u1',
      filename: 'other.pdf',
      docType: '其他',
    });
    await setDocumentParseStatus(ctx, contract.docId, 'parsed');

    const types = await getDocumentTypes(
      ctx,
      [contract.docId, invoice.docId, other.docId, invoice.docId, 'missing'],
      'u1',
    );
    expect(types.get(contract.docId)).toBe('合同');
    expect(types.get(invoice.docId)).toBe('发票');
    expect(types.get(other.docId)).toBe('其他');
    expect(types.has('missing')).toBe(false);
    expect(types.size).toBe(3);
  });

  it('does not leak another user document and ignores empty ids', async () => {
    const foreign = await createDocumentStub(ctx, {
      sourceUri: '/tmp/foreign.pdf',
      userId: 'u2',
      filename: 'foreign.pdf',
      docType: '发票',
    });
    const types = await getDocumentTypes(ctx, [foreign.docId, ''], 'u1');
    expect(types.size).toBe(0);
  });
});
