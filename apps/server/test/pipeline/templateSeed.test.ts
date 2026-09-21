import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, migrate } from '../../src/pipeline/db/client.js';
import { ensureTemplateSeed } from '../../src/pipeline/templateSeed.js';
import { listActiveEdgeRules, listTemplateTypes } from '../../src/pipeline/db/repositories.js';
import { CONTRACT_TEMPLATE_FIELDS, CONTRACT_FIELD_HINTS } from '../../src/pipeline/schemas/contract.js';
import { FLOW_ADAPTERS } from '../../src/domain/tradeSemantics.js';

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

  it('合同模板 props 逐名覆盖保底字段集(SSOT), 锚点字段在列', async () => {
    await ensureTemplateSeed(ctx);
    const types = await listTemplateTypes(ctx);
    const hetong = types.find((t) => t.name === '合同')!;
    const req = hetong.props.requiredFields as string[];
    expect(req).toHaveLength(CONTRACT_TEMPLATE_FIELDS.length);
    for (const f of CONTRACT_TEMPLATE_FIELDS) expect(req).toContain(f);
    for (const anchor of ['合同号', '合同类型', '甲方', '乙方', '标的物', '数量', '单位', '金额', '签订日', '生效日', '交货期', '项目编号']) {
      expect(req).toContain(anchor);
    }
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

  it('wave6: 运输凭证/重量凭证 fieldHints 覆盖 FLOW_ADAPTERS 适配数量键', async () => {
    await ensureTemplateSeed(ctx);
    const rows = await listTemplateTypes(ctx);
    const byName = new Map(rows.filter((r) => r.kind === 'doc_type').map((r) => [r.name, r]));
    for (const docType of ['运输凭证', '重量凭证'] as const) {
      const hints = byName.get(docType)?.props.fieldHints as Record<string, string>;
      for (const [qtyKey] of FLOW_ADAPTERS[docType].qtyFields) {
        expect(hints?.[qtyKey], `${docType} fieldHints 缺适配数量键 ${qtyKey}`).toBeTruthy();
      }
      expect(hints['合计净重']).toContain('净重');
      expect(hints['净重']).toContain('吨');
    }
  });

  it('v2.3(wave5 验收): 发货单/收货单 formTypes 词表 + 数量提示; 合同字段集含合同类型', async () => {
    await ensureTemplateSeed(ctx);
    const rows = await listTemplateTypes(ctx);
    const byName = new Map(rows.filter((r) => r.kind === 'doc_type').map((r) => [r.name, r]));
    // 发货单(销售侧发货凭证): 交货确认单 等表单词 + 数量提示(多键覆盖适配表数量键)
    expect(byName.get('发货单')?.props.formTypes)
      .toEqual(expect.arrayContaining(['交货确认单', '交货单', '发运单']));
    expect(byName.get('发货单')?.props.fieldHints)
      .toMatchObject({ 数量_吨: expect.stringContaining('净重') });
    // 收货单: 收货确认单 表单词 + 同款数量提示
    expect(byName.get('收货单')?.props.formTypes).toContain('收货确认单');
    expect(byName.get('收货单')?.props.fieldHints)
      .toMatchObject({ 数量_吨: expect.stringContaining('净重') });
    // fieldHints 覆盖 FLOW_ADAPTERS(tradeSemantics.ts) qtyFields 全部数量键
    // (以适配表为准逐键补非空提示): 收货单/发货单适配键同为 发运数量/数量_吨/数量,
    // 无签收类键可分配。
    for (const docType of ['收货单', '发货单'] as const) {
      const hints = byName.get(docType)?.props.fieldHints as Record<string, string>;
      for (const [qtyKey] of FLOW_ADAPTERS[docType].qtyFields) {
        expect(hints?.[qtyKey], `${docType} fieldHints 缺适配数量键 ${qtyKey}`).toBeTruthy();
      }
      // 首选键(发运数量)提示引导发运类写法; 次选键(数量_吨)保留带单位语义提示
      expect(hints['发运数量']).toContain('发运');
      expect(hints['数量_吨']).toContain('净重');
    }
    // 合同: 保底字段集含 合同类型, fieldHints 引导受控别名
    expect(CONTRACT_TEMPLATE_FIELDS).toContain('合同类型');
    expect(CONTRACT_FIELD_HINTS['合同类型']).toContain('采购合同');
    expect(CONTRACT_FIELD_HINTS['合同类型']).toContain('销售合同');
  });
});
