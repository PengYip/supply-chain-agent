import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, migrate } from '../../src/pipeline/db/client.js';
import { ensureTemplateSeed } from '../../src/pipeline/templateSeed.js';
import { listActiveEdgeRules, listTemplateTypes } from '../../src/pipeline/db/repositories.js';

const ctx = createDb();
beforeEach(() => migrate(ctx.sqlite));

describe('template seed', () => {
  it('种子含分类八类+合同六类+层级枢纽', async () => {
    await ensureTemplateSeed(ctx);
    const types = await listTemplateTypes(ctx);
    const names = (k: string) => types.filter((t) => t.kind === k).map((t) => t.name);
    for (const dt of ['合同', '发票', '提单', '装箱单', '货转单', '化验报告', '付款凭证', '其他', '履约凭证']) {
      expect(names('doc_type')).toContain(dt);
    }
    for (const ct of ['采购', '销售', '物流', '租赁', '服务', '其他', '买卖合同']) {
      expect(names('contract_type')).toContain(ct);
    }
    // 层级(v2 树): 发票 ⊂ 发票凭证 ⊂ 履约凭证; 采购 ⊂ 买卖合同
    const fapiao = types.find((t) => t.name === '发票')!;
    const fapiaoPiao = types.find((t) => t.name === '发票凭证')!;
    const lvyue = types.find((t) => t.name === '履约凭证')!;
    expect(fapiao.parentId).toBe(fapiaoPiao.id);
    expect(fapiaoPiao.parentId).toBe(lvyue.id);
    // v2 方向编码类型已登记
    expect(names('doc_type')).toContain('收货单');
    expect(names('doc_type')).toContain('销项票');
    const caigou = types.find((t) => t.name === '采购')!;
    const maimai = types.find((t) => t.name === '买卖合同')!;
    expect(caigou.parentId).toBe(maimai.id);
  });

  it('种子规则覆盖现状硬编码语义 + 兜底通配', async () => {
    await ensureTemplateSeed(ctx);
    const rules = await listActiveEdgeRules(ctx);
    const typeById = new Map((await listTemplateTypes(ctx)).map((t) => [t.id, t.name]));
    const vocabOf = (src: string, edge: string) =>
      rules.filter((r) => typeById.get(r.sourceTypeId) === src && r.edgeType === edge)
        .map((r) => ({ target: r.targetTypeId === '' ? '*' : typeById.get(r.targetTypeId), vocab: r.allowedVocab }));
    expect(vocabOf('货转单', 'binds')).toContainEqual({ target: '*', vocab: ['货权转移'] });
    expect(vocabOf('付款凭证', 'settles')).toContainEqual({ target: '*', vocab: ['收款', '付款'] });
    expect(vocabOf('发票', 'settles')).toContainEqual({ target: '*', vocab: ['收票', '开票'] });
    // 通用履约物化层(spec 2026-08-27 §7): 运输三类型 settles, 类型不带方向 -> 两向词表。
    expect(vocabOf('汽运磅单', 'settles')).toContainEqual({ target: '*', vocab: ['收货', '发货'] });
    expect(vocabOf('火运大票', 'settles')).toContainEqual({ target: '*', vocab: ['收货', '发货'] });
    expect(vocabOf('轨道衡称重单', 'settles')).toContainEqual({ target: '*', vocab: ['收货', '发货'] });
    expect(vocabOf('派船通知单', 'settles')).toContainEqual({ target: '*', vocab: ['收货', '发货'] });
    expect(vocabOf('其他', 'binds')).toContainEqual({ target: '*', vocab: ['凭证'] });
    // 兜底: 合同类型"其他"作 source? 不——兜底是任意 doc -> 通配。检查存在通配兜底:
    const fallback = rules.find((r) => r.edgeType === 'binds' && r.targetTypeId === '' && r.sourceTypeId === '');
    expect(fallback?.allowedVocab).toEqual(['凭证']);
  });

  it('幂等: 连续两次灌入行数不变', async () => {
    await ensureTemplateSeed(ctx);
    const a = (await listTemplateTypes(ctx)).length + (await listActiveEdgeRules(ctx)).length;
    await ensureTemplateSeed(ctx);
    const b = (await listTemplateTypes(ctx)).length + (await listActiveEdgeRules(ctx)).length;
    expect(b).toBe(a);
  });

  it('v2.1: 重量凭证中间节点收编汽运磅单/轨道衡称重单, 新增水尺计重单 + formTypes', async () => {
    await ensureTemplateSeed(ctx);
    const rows = await listTemplateTypes(ctx);
    const byName = new Map(rows.filter((r) => r.kind === 'doc_type').map((r) => [r.name, r]));
    expect(byName.get('重量凭证')?.parentId).toBe('dt-履约凭证');
    expect(byName.get('汽运磅单')?.parentId).toBe('dt-重量凭证');
    expect(byName.get('轨道衡称重单')?.parentId).toBe('dt-重量凭证');
    expect(byName.get('水尺计重单')?.parentId).toBe('dt-重量凭证');
    expect(byName.get('汽运磅单')?.props.formTypes).toContain('汽车过磅单票据');
    expect(byName.get('轨道衡称重单')?.props.formTypes).toContain('轨道衡称重记录');
    expect(byName.get('水尺计重单')?.props.formTypes).toContain('水尺计重单');
    expect(byName.get('合同')?.props.formTypes).toContain('合同扫描件');
    // 登记不启用的边规则不进活跃列表
    const active = await listActiveEdgeRules(ctx);
    expect(active.find((r) => r.edgeType === 'settles' && r.sourceTypeId === 'dt-水尺计重单')).toBeUndefined();
  });
});