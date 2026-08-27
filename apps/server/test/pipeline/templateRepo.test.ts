import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, migrate } from '../../src/pipeline/db/client.js';
import {
  bumpTemplateVersion, ensureEdgeRule, ensureTemplateType, findTemplateTypeByName,
  listActiveEdgeRules, listTemplateTypes,
} from '../../src/pipeline/db/repositories.js';

const ctx = createDb();
beforeEach(() => migrate(ctx.sqlite));

describe('template repo', () => {
  it('ensure 幂等: 重复灌入不报错不重复', async () => {
    await ensureTemplateType(ctx, { id: 'dt-发票', kind: 'doc_type', name: '发票' });
    await ensureTemplateType(ctx, { id: 'dt-发票', kind: 'doc_type', name: '发票' });
    const rows = await listTemplateTypes(ctx);
    expect(rows.filter((r) => r.name === '发票')).toHaveLength(1);
  });

  it('findTemplateTypeByName 精确命中', async () => {
    await ensureTemplateType(ctx, { id: 'ct-采购', kind: 'contract_type', name: '采购' });
    expect((await findTemplateTypeByName(ctx, 'contract_type', '采购'))?.id).toBe('ct-采购');
    expect(await findTemplateTypeByName(ctx, 'contract_type', '不存在')).toBeNull();
  });

  it('ensureEdgeRule 词表 JSON往返 + isActive 过滤', async () => {
    await ensureTemplateType(ctx, { id: 'dt-付款凭证', kind: 'doc_type', name: '付款凭证' });
    await ensureEdgeRule(ctx, { id: 'er-pay-settles', sourceTypeId: 'dt-付款凭证', edgeType: 'settles', allowedVocab: ['收款', '付款'] });
    await ensureEdgeRule(ctx, { id: 'er-inactive', sourceTypeId: 'dt-付款凭证', edgeType: 'binds', allowedVocab: ['凭证'], isActive: false });
    const rules = await listActiveEdgeRules(ctx);
    const pay = rules.find((r) => r.id === 'er-pay-settles');
    expect(pay?.allowedVocab).toEqual(['收款', '付款']);
    expect(rules.some((r) => r.id === 'er-inactive')).toBe(false);
  });

  it('重跑 ensure 不带 anchorWeights 时保留既有权重不被抹成 null(小修 3)', async () => {
    // 场景: manage_template 设了 anchor_weights, 之后 boot seed 幂等重跑
    // (seed 输入不带 anchorWeights) -> 已有权重必须保留。
    await ensureTemplateType(ctx, { id: 'dt-付款凭证', kind: 'doc_type', name: '付款凭证' });
    await ensureEdgeRule(ctx, {
      id: 'er-weights',
      sourceTypeId: 'dt-付款凭证',
      edgeType: 'binds',
      allowedVocab: ['凭证'],
      anchorWeights: { party: 0.4, time: 0.1, amount: 0.3, qty: 0.2 },
    });
    // 重跑: 未传 anchorWeights(undefined -> SQL NULL)。
    await ensureEdgeRule(ctx, {
      id: 'er-weights',
      sourceTypeId: 'dt-付款凭证',
      edgeType: 'binds',
      allowedVocab: ['凭证'],
    });
    const rule = (await listActiveEdgeRules(ctx)).find((r) => r.id === 'er-weights');
    expect(rule?.anchorWeights).toEqual({ party: 0.4, time: 0.1, amount: 0.3, qty: 0.2 });
  });

  it('显式传新 anchorWeights 时照常覆写(COALESCE 只护 NULL)', async () => {
    await ensureTemplateType(ctx, { id: 'dt-付款凭证', kind: 'doc_type', name: '付款凭证' });
    await ensureEdgeRule(ctx, {
      id: 'er-overwrite',
      sourceTypeId: 'dt-付款凭证',
      edgeType: 'binds',
      allowedVocab: ['凭证'],
      anchorWeights: { party: 0.4, time: 0.1, amount: 0.3, qty: 0.2 },
    });
    await ensureEdgeRule(ctx, {
      id: 'er-overwrite',
      sourceTypeId: 'dt-付款凭证',
      edgeType: 'binds',
      allowedVocab: ['凭证'],
      anchorWeights: { party: 0.9, time: 0.02, amount: 0.04, qty: 0.04 },
    });
    const rule = (await listActiveEdgeRules(ctx)).find((r) => r.id === 'er-overwrite');
    expect(rule?.anchorWeights).toEqual({ party: 0.9, time: 0.02, amount: 0.04, qty: 0.04 });
  });
});

describe('seed 冲突策略(managed-wins)', () => {
  it('未管理行: seed 重跑仍覆写 vocab 与 isActive(旧行为不变)', async () => {
    await ensureTemplateType(ctx, { id: 'dt-货转单', kind: 'doc_type', name: '货转单' });
    await ensureEdgeRule(ctx, {
      id: 'er-x', sourceTypeId: 'dt-货转单', edgeType: 'binds',
      allowedVocab: ['旧词'], isActive: true,
    });
    // 管理员未碰过(managed_at NULL): 同 id 但不同内容的"seed"可继续覆写。
    await ensureEdgeRule(ctx, {
      id: 'er-x', sourceTypeId: 'dt-货转单', edgeType: 'binds',
      allowedVocab: ['新词'], isActive: false,
    });
    const rules = await ctx.sqlite
      .prepare('SELECT allowed_vocab AS v FROM template_edge_rules WHERE id = ?')
      .get('er-x') as { v: string };
    expect(rules.v).toBe(JSON.stringify(['新词']));
  });

  it('已管理行(isActive=0 软禁用): seed 重跑不复活', async () => {
    await ensureTemplateType(ctx, { id: 'dt-发货单', kind: 'doc_type', name: '发货单' });
    await ensureEdgeRule(ctx, {
      id: 'er-y', sourceTypeId: 'dt-发货单', edgeType: 'settles',
      allowedVocab: ['发货'], isActive: true,
    });
    // 管理操作: 直接 SQL 置 managed_at 模拟 markManaged(正式入口在 Task 2)。
    ctx.sqlite.prepare(
      "UPDATE template_edge_rules SET is_active = 0, managed_at = datetime('now'), managed_by = 'admin' WHERE id = ?",
    ).run('er-y');
    // boot seed 重跑同一内容(种子语义本想拉回 active=true):
    await ensureEdgeRule(ctx, {
      id: 'er-y', sourceTypeId: 'dt-发货单', edgeType: 'settles',
      allowedVocab: ['发货'], isActive: true,
    });
    const rules = await ctx.sqlite
      .prepare('SELECT is_active AS a, managed_by AS b FROM template_edge_rules WHERE id = ?')
      .get('er-y') as { a: number; b: string };
    expect(rules.a).toBe(0);
    expect(rules.b).toBe('admin');
  });

  it('已管理类型的 props: seed 重跑不覆盖 props 变更', async () => {
    await ensureTemplateType(ctx, { id: 'dt-Z', kind: 'doc_type', name: 'Z' });
    ctx.sqlite.prepare(
      "UPDATE template_types SET props = ?, managed_at = datetime('now'), managed_by = 'admin' WHERE id = ?",
    ).run(JSON.stringify({ requiredFields: ['合同号'] }), 'dt-Z');
    await ensureTemplateType(ctx, { id: 'dt-Z', kind: 'doc_type', name: 'Z', parentId: null });
    const row = ctx.sqlite.prepare('SELECT props AS p FROM template_types WHERE id = ?').get('dt-Z') as { p: string };
    expect(JSON.parse(row.p)).toEqual({ requiredFields: ['合同号'] });
  });

  it('bumpTemplateVersion: 递增并落 changed_by/change_summary', async () => {
    const v1 = await bumpTemplateVersion(ctx, { changedBy: 'u1', changeSummary: '首次调整' });
    const v2 = await bumpTemplateVersion(ctx, { changedBy: 'u1', changeSummary: '第二次' });
    expect(v1).toBe(1);
    expect(v2).toBe(2);
    const row = ctx.sqlite
      .prepare('SELECT changed_by, change_summary, version FROM template_versions ORDER BY version DESC LIMIT 1')
      .get() as { changed_by: string; change_summary: string; version: number };
    expect(row.version).toBe(2);
    expect(row.change_summary).toBe('第二次');
  });
});
