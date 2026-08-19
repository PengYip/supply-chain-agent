import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate } from '../../../src/pipeline/db/client.js';
import {
  addSelfParty,
  listSelfParties,
  removeSelfParty,
  listDocumentIdsWithConfirmedBindings,
  hasExecutionFlowsForDocument,
  saveBinding,
  upsertExecutionFlow,
} from '../../../src/pipeline/db/repositories.js';

// 自主体名单仓储(Task A): self_parties 表 CRUD + 回填辅助查询。
// 去重语义 = domain normalizeCompanyName(全角转半角 + 剥空白/括号/标点 + 大写)。
let ctx: ReturnType<typeof createDb>;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
});

/** 插入最小 documents 行(bindings/execution_flows 的 FK 需要)。 */
function insertDocumentStub(id: string, userId = ''): void {
  ctx.sqlite
    .prepare(
      `INSERT INTO documents (id, doc_type, modality, source_uri, block_model, user_id)
       VALUES (?, '发票', 'digital', 'stub://doc', 'stub', ?)`,
    )
    .run(id, userId);
}

describe('addSelfParty(归一化去重)', () => {
  it('首次新增 true, 精确重复 false', async () => {
    expect(await addSelfParty(ctx, '浙江浙能富兴燃料有限公司', 'u1')).toBe(true);
    expect(await addSelfParty(ctx, '浙江浙能富兴燃料有限公司', 'u1')).toBe(false);
  });

  it('归一化重复 false: 全角括号/空白被剥除后命中同一键', async () => {
    // normalizeCompanyName: 全角 ASCII 转半角 + 仅保留 CJK/字母/数字(剥括号/空白) + 大写。
    // 「华能（上海）」与「华能上海」归一为同一键(flowDirection.ts 文档注释里的真实用例)。
    expect(await addSelfParty(ctx, '华能（上海）', 'u1')).toBe(true);
    expect(await addSelfParty(ctx, '华能上海', 'u1')).toBe(false);
    // 首尾空白变体同样归一。
    expect(await addSelfParty(ctx, '浙江浙能富兴燃料有限公司', 'u1')).toBe(true);
    expect(await addSelfParty(ctx, ' 浙江浙能富兴燃料有限公司 ', 'u1')).toBe(false);
  });

  it('归一化后为空串 -> false(存储层兜底)', async () => {
    expect(await addSelfParty(ctx, '  （） ', 'u1')).toBe(false);
    expect(await listSelfParties(ctx)).toEqual([]);
  });
});

describe('listSelfParties / removeSelfParty', () => {
  it('listSelfParties 返回 {name, createdBy, createdAt}, 按 name 升序', async () => {
    await addSelfParty(ctx, '甲公司', 'u1');
    await addSelfParty(ctx, '乙公司', 'u2');
    const rows = await listSelfParties(ctx);
    expect(rows).toHaveLength(2);
    // ORDER BY name ASC: 乙(U+4E59) < 甲(U+7532)。
    expect(rows[0]!.name).toBe('乙公司');
    expect(rows[0]!.createdBy).toBe('u2');
    expect(rows[0]!.createdAt).toBeTruthy();
    expect(rows[1]!.name).toBe('甲公司');
    expect(rows[1]!.createdBy).toBe('u1');
  });

  it('removeSelfParty 按原始名精确删除: 存在 true, 不存在/归一化变体 false', async () => {
    await addSelfParty(ctx, '浙江浙能富兴燃料有限公司', 'u1');
    expect(await removeSelfParty(ctx, '浙江浙能富兴燃料有限公司')).toBe(true);
    expect(await removeSelfParty(ctx, '浙江浙能富兴燃料有限公司')).toBe(false);
    // 归一化变体不匹配原始名 -> 删不掉(设计如此: 删除按原始名精确匹配)。
    await addSelfParty(ctx, '华能（上海）', 'u1');
    expect(await removeSelfParty(ctx, '华能上海')).toBe(false);
    expect(await listSelfParties(ctx)).toHaveLength(1);
  });
});

describe('回填辅助查询', () => {
  it('listDocumentIdsWithConfirmedBindings 对同文档多条 confirmed 绑定去重, 排除非 confirmed', async () => {
    insertDocumentStub('D1', 'u1');
    insertDocumentStub('D2', 'u1');
    await saveBinding(ctx, {
      documentId: 'D1', contractNo: 'HT-1', relation: '收票',
      sourceRefs: [], confidence: 1, createdBy: 'u1',
    }, 'u1');
    await saveBinding(ctx, {
      documentId: 'D1', contractNo: 'HT-2', relation: '收票',
      sourceRefs: [], confidence: 1, createdBy: 'u1',
    }, 'u1');
    // D2 的绑定是 proposed -> 不参与回填候选。
    await saveBinding(ctx, {
      documentId: 'D2', contractNo: 'HT-3', relation: '收票',
      sourceRefs: [], confidence: 1, createdBy: 'u1', status: 'proposed',
    }, 'u1');

    const ids = await listDocumentIdsWithConfirmedBindings(ctx, 'u1');
    expect(ids).toEqual(['D1']);
  });

  it('hasExecutionFlowsForDocument 反映文档是否已有流水行(回填跳过已物化文档)', async () => {
    insertDocumentStub('D1', 'u1');
    expect(await hasExecutionFlowsForDocument(ctx, 'D1', 'u1')).toBe(false);
    await upsertExecutionFlow(ctx, {
      bindingId: 'BD-1', documentId: 'D1', contractNo: 'HT-1', flowType: '发票流',
      direction: 'in', amount: 100, quantityTon: null, docType: '发票',
      voucherDate: null, confidence: 1, createdBy: 'u1',
    }, 'u1');
    expect(await hasExecutionFlowsForDocument(ctx, 'D1', 'u1')).toBe(true);
  });
});