import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, migrate } from '../../src/pipeline/db/client.js';
import { ensureTemplateSeed } from '../../src/pipeline/templateSeed.js';
import {
  ensureEdgeRule, ensureTemplateType, listActiveEdgeRules, listTemplateTypes,
} from '../../src/pipeline/db/repositories.js';
import { ancestorChain, matchEdgeRule, validateEdge } from '../../src/pipeline/templateGuard.js';

const ctx = createDb();
beforeEach(async () => {
  migrate(ctx.sqlite);
  await ensureTemplateSeed(ctx);
});

describe('ancestorChain', () => {
  it('发票 -> 履约凭证 两级链', async () => {
    const types = await listTemplateTypes(ctx);
    const byId = new Map(types.map((t) => [t.id, t]));
    const fapiao = types.find((t) => t.name === '发票')!;
    // 含自身: 发票 -> 发票凭证 -> 履约凭证 共 3 节点(brief 原文 toHaveLength(2) 为笔误,
    // 与"含自身"语义及 matchEdgeRule 精确命中用例矛盾, 已修正)。
    expect(ancestorChain(fapiao.id, byId)).toHaveLength(3);
  });
  it('环安全: A->B->A 不死循环', async () => {
    await ensureTemplateType(ctx, { id: 'dt-A', kind: 'doc_type', name: 'A' });
    await ensureTemplateType(ctx, { id: 'dt-B', kind: 'doc_type', name: 'B', parentId: 'dt-A' });
    const db = ctx.sqlite;
    db.prepare("UPDATE template_types SET parent_id = 'dt-B' WHERE id = 'dt-A'").run();
    const types = await listTemplateTypes(ctx);
    const byId = new Map(types.map((t) => [t.id, t]));
    const chain = ancestorChain('dt-A', byId);
    expect(chain.length).toBeLessThanOrEqual(2);
  });
});

describe('matchEdgeRule 最具体优先', () => {
  it('子类型覆盖 > 通配兜底', async () => {
    // 铁路运单 ⊂ 履约凭证, 自身无规则 -> 命中通配兜底 er-bind-fallback
    await ensureTemplateType(ctx, { id: 'dt-铁路运单', kind: 'doc_type', name: '铁路运单', parentId: 'dt-履约凭证' });
    const types = await listTemplateTypes(ctx);
    const rules = await listActiveEdgeRules(ctx);
    const byId = new Map(types.map((t) => [t.id, t]));
    const chain = ancestorChain('dt-铁路运单', byId);
    const rule = matchEdgeRule({ rules, sourceChain: chain, targetChain: [''], edgeType: 'binds' });
    expect(rule?.id).toBe('er-bind-fallback');
  });
  it('精确规则优先于通配: 付款凭证 settles', async () => {
    const rules = await listActiveEdgeRules(ctx);
    const types = await listTemplateTypes(ctx);
    const byId = new Map(types.map((t) => [t.id, t]));
    const chain = ancestorChain(byId.get('dt-付款凭证')!.id, byId);
    const rule = matchEdgeRule({ rules, sourceChain: chain, targetChain: [''], edgeType: 'settles' });
    expect(rule?.id).toBe('er-settle-fukuan');
  });
});

describe('validateEdge', () => {
  it('未知 docType 放行(passthrough)', async () => {
    const r = await validateEdge(ctx, { docType: '神秘单据', edgeType: 'binds' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ruleId).toBe('passthrough');
  });
  it('付款凭证 binds 任意合同: 通过, relation 付款在词表内', async () => {
    const r = await validateEdge(ctx, { docType: '付款凭证', contractType: '采购', edgeType: 'binds', relation: '付款' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.relationInVocab).toBe(true);
  });
  it('自由文本 relation 软校验: 通过但 relationInVocab=false', async () => {
    const r = await validateEdge(ctx, { docType: '付款凭证', edgeType: 'binds', relation: '运费分摊' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.relationInVocab).toBe(false);
  });
  it('合同类型显式排除场景: 禁用规则后无兜底才拒绝', async () => {
    // 现种子有源通配兜底, 一切已登记 docType 都过; 验证无兜底路径:
    ctx.sqlite.prepare("UPDATE template_edge_rules SET is_active = 0 WHERE id = 'er-bind-fallback'").run();
    ctx.sqlite.prepare("UPDATE template_edge_rules SET is_active = 0 WHERE id LIKE 'er-bind-%'").run();
    const r = await validateEdge(ctx, { docType: '化验报告', contractType: '采购', edgeType: 'binds' });
    expect(r.ok).toBe(false);
  });
  it('非守卫范围 edgeType 放行', async () => {
    const r = await validateEdge(ctx, { docType: '发票', edgeType: 'party' });
    expect(r.ok).toBe(true);
  });
});