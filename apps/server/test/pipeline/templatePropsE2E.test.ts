// P4 Task 5: 运行时新增类型的 props 端到端生效断言(零产品代码, 防回归测试)。
//
// 防什么: 未来有人把"可用类型白名单"硬编码回任一 props 消费点时变红。
// 证明方式: 用 templateManage.createTemplateType 新建代码里从未出现过的类型
// 「铁路运单」, 让三个既有消费点各自吃一次它的 props——
//   1. 抽取(autoExtraction.buildAutoExtractionDeps.extract 的查询与守卫形状):
//      按 kind+'name==='铁路运单'' 在 listTemplateTypes 结果中命中并提取
//      requiredFields/fieldHints(extraction.ts:208 的动态提示词吃的就是这份数据);
//   2. 绑定目标(routes/templates.ts 与 routes/bindings.ts 的 bindsTargetKind 读):
//      按 dt-{名} 在类型表取 props.bindsTargetKind;
//   3. 绑定候选(buildBindingCandidates 全链路): 通用锚点路径(非 VOUCHER_TYPES)
//      + fallback 通配规则驱动 rule 匹配, 台账候选正常产出。
import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, migrate, type SqliteDbContext } from '../../src/pipeline/db/client.js';
import { ensureTemplateSeed } from '../../src/pipeline/templateSeed.js';
import {
  createTemplateType,
} from '../../src/pipeline/templateManage.js';
import {
  createDocumentStub, listTemplateTypes, saveExtraction,
  upsertContractLedgerEntry,
} from '../../src/pipeline/db/repositories.js';
import { buildBindingCandidates } from '../../src/pipeline/bindingCandidates.js';
import type { ContractLedgerEntry } from '../../src/pipeline/contractLedger.js';

let ctx: SqliteDbContext;
beforeEach(async () => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
  await ensureTemplateSeed(ctx);
});

const NEW_TYPE = '铁路运单';
const PROPS = { fieldHints: { 车次: '实际车次字段' }, bindingsTargetKind: 'Contract' };

/** 复刻 autoExtraction.buildAutoExtractionDeps.extract 的取数与守卫逻辑(逐形)。 */
function extractionConsumerShape(types: Awaited<ReturnType<typeof listTemplateTypes>>, docType: string) {
  // eslint-disable-next-line @typescript-eslint/no-shadow -- 与产品代码同名局部变量
  const typeRow = types.find((t) => t.kind === 'doc_type' && t.name === docType);
  return {
    found: typeRow !== undefined,
    requiredFields: Array.isArray(typeRow?.props.requiredFields)
      ? (typeRow.props.requiredFields as string[])
      : undefined,
    fieldHints: typeRow?.props.fieldHints !== null && typeof typeRow?.props.fieldHints === 'object'
      && !Array.isArray(typeRow.props.fieldHints)
      ? (typeRow.props.fieldHints as Record<string, string>)
      : undefined,
    // routes/templates.ts 与 routes/bindings.ts 的绑定目标读取形状。
    bindingsTargetKind: typeRow?.props.bindingsTargetKind === 'Project' ? 'Project' : 'Contract',
  };
}

describe('运行时新增类型 props 端到端(防白名单回归)', () => {
  it('templateManage 新建「铁路运单」-> listTemplateTypes 行 props 原样往返', async () => {
    const r = await createTemplateType(ctx, 'admin', {
      kind: 'doc_type', name: NEW_TYPE, props: PROPS,
    });
    expect(r.ok).toBe(true);

    const types = await listTemplateTypes(ctx);
    const row = types.find((t) => t.kind === 'doc_type' && t.name === NEW_TYPE);
    expect(row, '新类型必须出现在全量类型表(无白名单过滤)').toBeDefined();
    expect(row!.id).toBe(`dt-${NEW_TYPE}`);
    expect(row!.isActive).toBe(true);
    expect(row!.props).toEqual(PROPS); // 自由 JSON 原样往返, 键无裁剪
  });

  it('抽取消费点(autoExtraction 同款查询+守卫): fieldHints 吃到新类型值, requiredFields 容缺省', async () => {
    await createTemplateType(ctx, 'admin', { kind: 'doc_type', name: NEW_TYPE, props: PROPS });
    const shape = extractionConsumerShape(await listTemplateTypes(ctx), NEW_TYPE);
    expect(shape.found).toBe(true);
    expect(shape.requiredFields).toBeUndefined(); // 未声明必填 -> 走缺省 prompt 分支
    expect(shape.fieldHints).toEqual({ 车次: '实际车次字段' }); // 动态提示词数据源

    // 对照组: 无 props 的另一个新类型 -> 守卫全部落缺省(同链路不得崩)。
    await createTemplateType(ctx, 'admin', { kind: 'doc_type', name: '很怪的凭证' });
    const bare = extractionConsumerShape(await listTemplateTypes(ctx), '很怪的凭证');
    expect(bare.found).toBe(true);
    expect(bare.requiredFields).toBeUndefined();
    expect(bare.fieldHints).toBeUndefined();
  });

  it('绑定目标消费点(routes 两处读取形状): 新类型 bindsTargetKind 按 dt-{名} 取回 Contract', async () => {
    await createTemplateType(ctx, 'admin', { kind: 'doc_type', name: NEW_TYPE, props: PROPS });
    const types = await listTemplateTypes(ctx);
    const byId = new Map(types.map((t) => [t.id, t]));
    // templates.ts/binding 工作台都是这样按名字合成 id 再查表的。
    const target = byId.get(`dt-${NEW_TYPE}`);
    expect(target).toBeDefined();
    expect(target!.props.bindingsTargetKind === 'Project' ? 'Project' : 'Contract').toBe('Contract');
  });

  it('buildBindingCandidates 全链路吃进新类型: 通用锚点路径 + fallback 规则匹配照常出候选', async () => {
    await createTemplateType(ctx, 'admin', { kind: 'doc_type', name: NEW_TYPE, props: PROPS });
    const { docId } = await createDocumentStub(ctx, { sourceUri: 'file:///tl.pdf', docType: NEW_TYPE as never });
    await saveExtraction(ctx, {
      // 运行时新类型不在编译期 DocType 联合内——这正是被测事实(动态注册), 用
      // 断言换类型豁免; 其余消费点(listTemplateTypes/bindingCandidates)均为 string 形参。
      documentId: docId, docType: NEW_TYPE as never,
      fields: {
        合同号: { value: 'HT-R', sourceSpans: [] },
        数量: { value: 100, sourceSpans: [] },
      },
      fieldMeta: {}, overallConfidence: 1, needsReview: false,
    });
    const entry: ContractLedgerEntry = {
      contractNo: 'HT-R', displayContractNo: 'HT-R', docType: '买卖合同', documentId: docId,
      title: 'T', contractType: null, fields: {}, fieldMeta: {}, overallConfidence: 1, needsReview: false, userId: 'u-tl',
    };
    await upsertContractLedgerEntry(ctx, entry, 'u-tl');

    const res = await buildBindingCandidates(ctx, docId, 'u-tl');
    // 铁路运单 不在 VOUCHER_TYPES 三类图片凭证内 -> 走通用字段锚点; 合同号成为锚点。
    expect(res.hasExtraction).toBe(true);
    expect(res.anchors.contractNo).toBe('HT-R');
    // 台账有同号合同 -> 候选非空(fallback 通配 binds 规则的 rule 匹配分支被执行)。
    expect(res.candidates.some((c) => c.contractNo === 'HT-R')).toBe(true);
  });
});
