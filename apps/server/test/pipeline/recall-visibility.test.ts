// recall 可见性过滤(2026-09-01 悬空单据不可见)的行为契约:
//   1. 悬空凭证(无绑定) fts 命中也不返回, 并给出悬空说明 note;
//   2. 建立 proposed(待确认)绑定后可见;
//   3. rejected 绑定不算归属, 重新隐藏;
//   4. 合同类锚点文档无绑定也始终可见。
import { describe, it, expect, beforeAll } from 'vitest';
import { createDb, migrate } from '../../src/pipeline/db/client.js';
import type { SqliteDbContext } from '../../src/pipeline/db/client.js';
import { saveChunks } from '../../src/pipeline/db/repositories.js';
import { buildRecallDocumentsTool } from '../../src/pipeline/tools/recall.js';

const execOpts = {
  messages: [], toolCallId: 't', abortSignal: undefined as any,
} as any;

function insertDoc(ctx: SqliteDbContext, id: string, docType: string) {
  ctx.sqlite
    .prepare(
      'INSERT INTO documents (id, doc_type, modality, source_uri, block_model, user_id) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(id, docType, 'digital', `/tmp/${id}.txt`, '{}', '');
}

function insertBinding(ctx: SqliteDbContext, id: string, docId: string, status: string) {
  ctx.sqlite
    .prepare(
      `INSERT INTO bindings (id, document_id, contract_no, relation, source_refs, confidence, created_by, user_id, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, docId, 'CJXC-2025-001', 'primary', '[]', 0.9, 'test', '', status);
}

describe('recall visibility: 悬空凭证不参与检索', () => {
  let ctx: SqliteDbContext;
  let recall: ReturnType<typeof buildRecallDocumentsTool>;

  beforeAll(async () => {
    ctx = createDb(':memory:');
    migrate(ctx.sqlite);
    recall = buildRecallDocumentsTool({ ctx });

    insertDoc(ctx, 'doc-quality', '质检报告');
    insertDoc(ctx, 'doc-contract', '合同');
    await saveChunks(ctx, 'doc-quality', [{ text: '灰分 12.5 检验结论 合格', index: 0 }]);
    await saveChunks(ctx, 'doc-contract', [{ text: '烧碱 采购 合同条款 价格', index: 0 }]);
  });

  it('悬空凭证(无绑定)命中也不返回, 并说明原因', async () => {
    const res = (await recall.execute!(
      { query: '灰分', limit: 5, strategy: 'fts', tagMode: 'any' },
      execOpts,
    )) as { matchCount: number; note?: string };
    expect(res.matchCount).toBe(0);
    expect(String(res.note ?? '')).toContain('悬空');
  });

  it('proposed(待确认)绑定建立后可见', async () => {
    insertBinding(ctx, 'bind-1', 'doc-quality', 'proposed');
    const res = (await recall.execute!(
      { query: '灰分', limit: 5, strategy: 'fts', tagMode: 'any' },
      execOpts,
    )) as { matchCount: number; matches: Array<{ document_id: string }> };
    expect(res.matchCount).toBe(1);
    expect(res.matches[0]!.document_id).toBe('doc-quality');
  });

  it('rejected 绑定不算归属, 重新隐藏', async () => {
    ctx.sqlite.prepare("UPDATE bindings SET status = 'rejected' WHERE id = 'bind-1'").run();
    const res = (await recall.execute!(
      { query: '灰分', limit: 5, strategy: 'fts', tagMode: 'any' },
      execOpts,
    )) as { matchCount: number; note?: string };
    expect(res.matchCount).toBe(0);
    expect(String(res.note ?? '')).toContain('悬空');
  });

  it('合同类锚点文档无绑定也始终可见', async () => {
    const res = (await recall.execute!(
      { query: '烧碱', limit: 5, strategy: 'fts', tagMode: 'any' },
      execOpts,
    )) as { matchCount: number; matches: Array<{ document_id: string }> };
    expect(res.matchCount).toBeGreaterThanOrEqual(1);
    expect(res.matches.some((m) => m.document_id === 'doc-contract')).toBe(true);
  });
});
