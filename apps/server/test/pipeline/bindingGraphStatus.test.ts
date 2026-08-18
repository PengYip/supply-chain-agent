import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import {
  saveDocument, saveBinding, findBindingById, listBindingsForUser, setBindingGraphStatus,
  type BindingGraphStatus,
} from '../../src/pipeline/db/repositories.js';
import type { BlockModel } from '../../src/pipeline/types.js';

// better-sqlite3 v11 enables FK by default, so bindings need a documents row
// (same seeding pattern as db/repositories.test.ts).
function mkModel(docId: string): BlockModel {
  return {
    docId, docType: '合同', modality: 'digital',
    blocks: [{ id: 'b1', type: 'kv', text: '合同号: HT-1', page: 1, bbox: null, ocrConfidence: 1 }],
    sourceUri: 'file:///x', createdAt: '2026-08-05T00:00:00.000Z',
  };
}

let ctx: DbContext;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
});

async function seedDoc(docId: string): Promise<void> {
  await saveDocument(ctx, mkModel(docId));
}

describe('binding graph_status + 查询函数 (SQLite)', () => {
  it('saveBinding 后 findBindingById 返回行, graphStatus 初始 null', async () => {
    await seedDoc('DOC-1');
    const id = await saveBinding(ctx, {
      documentId: 'DOC-1', contractNo: 'HT-1', relation: '付款',
      sourceRefs: [], confidence: 0.9, createdBy: 'test',
      status: 'proposed', proposedBy: 'system', evidence: null,
    }, 'u1');
    const row = await findBindingById(ctx, id, 'u1');
    expect(row?.contractNo).toBe('HT-1');
    expect(row?.graphStatus).toBeNull();
  });

  it('setBindingGraphStatus 落库并可读回', async () => {
    await seedDoc('DOC-1');
    const id = await saveBinding(ctx, {
      documentId: 'DOC-1', contractNo: 'HT-1', relation: '付款',
      sourceRefs: [], confidence: 0.9, createdBy: 'test', status: 'confirmed',
    }, 'u1');
    const gs: BindingGraphStatus = { status: 'failed', reason: 'boom', syncedAt: '2026-08-18T00:00:00Z' };
    expect(await setBindingGraphStatus(ctx, id, gs, 'u1')).toBe(true);
    const row = await findBindingById(ctx, id, 'u1');
    expect(row?.graphStatus).toEqual(gs);
  });

  it('listBindingsForUser 返回全状态行, legacy 空行可见, 其他用户不可见', async () => {
    await seedDoc('DOC-1');
    await seedDoc('DOC-2');
    await seedDoc('DOC-3');
    await saveBinding(ctx, { documentId: 'DOC-1', contractNo: 'HT-1', relation: 'x', sourceRefs: [], confidence: 1, createdBy: 't', status: 'confirmed' }, 'u1');
    await saveBinding(ctx, { documentId: 'DOC-2', contractNo: 'HT-2', relation: 'x', sourceRefs: [], confidence: 1, createdBy: 't', status: 'proposed' }); // legacy user_id=''
    await saveBinding(ctx, { documentId: 'DOC-3', contractNo: 'HT-3', relation: 'x', sourceRefs: [], confidence: 1, createdBy: 't', status: 'rejected' }, 'u2');
    const rows = await listBindingsForUser(ctx, 'u1');
    expect(rows.map((r) => r.contractNo).sort()).toEqual(['HT-1', 'HT-2']);
  });

  it('findBindingById 用户隔离: 他人行不可见', async () => {
    await seedDoc('DOC-1');
    const id = await saveBinding(ctx, {
      documentId: 'DOC-1', contractNo: 'HT-1', relation: 'x',
      sourceRefs: [], confidence: 1, createdBy: 't', status: 'confirmed',
    }, 'u2');
    expect(await findBindingById(ctx, id, 'u1')).toBeNull();
  });
});
