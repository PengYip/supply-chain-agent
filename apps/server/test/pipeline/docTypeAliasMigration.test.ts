import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate } from '../../src/pipeline/db/client.js';
import { ensureTemplateSeed, migrateDocTypeAliases } from '../../src/pipeline/templateSeed.js';
import { ensureTemplateType, listTemplateTypes } from '../../src/pipeline/db/repositories.js';
import { createDocumentStub } from '../../src/pipeline/db/repositories.js';
import { buildClassifierVocab } from '../../src/pipeline/classifier.js';

const ctx = createDb();
beforeEach(async () => { migrate(ctx.sqlite); await ensureTemplateSeed(ctx); });

describe('docType alias migration', () => {
  it('ensureTemplateType 支持 props upsert', async () => {
    await ensureTemplateType(ctx, { id: 'dt-提单', kind: 'doc_type', name: '提单', parentId: 'dt-货转单', props: { aliasOf: '货转单' } });
    const types = await listTemplateTypes(ctx);
    const tidan = types.find((t) => t.name === '提单')!;
    expect(tidan.props.aliasOf).toBe('货转单');
  });

  it('buildClassifierVocab 排除 alias 类型(提单/装箱单不进细类)', async () => {
    await ensureTemplateType(ctx, { id: 'dt-提单', kind: 'doc_type', name: '提单', parentId: 'dt-货转单', props: { aliasOf: '货转单' } });
    await ensureTemplateType(ctx, { id: 'dt-装箱单', kind: 'doc_type', name: '装箱单', parentId: 'dt-货转单', props: { aliasOf: '货转单' } });
    const types = await listTemplateTypes(ctx);
    const vocab = buildClassifierVocab(types);
    expect(vocab.fineByCoarse['履约凭证']).not.toContain('提单');
    expect(vocab.fineByCoarse['履约凭证']).not.toContain('装箱单');
    expect(vocab.fineByCoarse['履约凭证']).toContain('货转单');
  });

  it('存量 documents 幂等迁移 提单/装箱单 -> 货转单', async () => {
    await createDocumentStub(ctx, { sourceUri: 'file:///t.pdf', docType: '提单' });
    await createDocumentStub(ctx, { sourceUri: 'file:///z.pdf', docType: '装箱单' });
    const n1 = await migrateDocTypeAliases(ctx);
    expect(n1).toBeGreaterThanOrEqual(2);
    const n2 = await migrateDocTypeAliases(ctx); // 幂等: 二次执行 0 行
    expect(n2).toBe(0);
    const rows = ctx.sqlite.prepare("SELECT doc_type FROM documents WHERE doc_type IN ('提单','装箱单')").all();
    expect(rows).toHaveLength(0);
    const huozhuan = ctx.sqlite.prepare("SELECT COUNT(*) AS c FROM documents WHERE doc_type = '货转单'").get() as { c: number };
    expect(huozhuan.c).toBeGreaterThanOrEqual(2);
  });
});