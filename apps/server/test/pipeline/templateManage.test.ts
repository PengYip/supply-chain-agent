// P4 templateManage 业务层测试(Task 2): REST 与 Agent 工具共用唯一写入面。
// 场景覆盖简报 Step 1 用例清单: 创建/改词表/软禁用激活 + 删除保护提示 + 版本审计。
// 每个用例独立内存库(beforeEach 重建): managed-wins 生效后 seed 无法复位已管理行,
// 共享连接会让上一用例的管理痕迹泄进下一用例, 故不复用跨用例 ctx。
import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, migrate, type SqliteDbContext } from '../../src/pipeline/db/client.js';
import { ensureTemplateSeed } from '../../src/pipeline/templateSeed.js';
import {
  listActiveEdgeRules, listTemplateTypes,
} from '../../src/pipeline/db/repositories.js';
import {
  createTemplateType, updateEdgeRuleVocab, updateTemplateTypeProps,
  setEdgeRuleActive, setTemplateTypeActive, typeUsageReasons, listTemplateVersions,
  type ManageResult,
} from '../../src/pipeline/templateManage.js';

let ctx: SqliteDbContext;
beforeEach(async () => {
  ctx = createDb();
  migrate(ctx.sqlite);
  await ensureTemplateSeed(ctx);
});

/** 展开 ok 结果以便断言 data/templateVersion(失败则显式炸出 code/reason)。 */
function unwrap<T>(r: ManageResult<T>): { data: T; templateVersion: number } {
  if (!r.ok) throw new Error(`预期成功, 实得 ${r.code}: ${r.reason}`);
  return { data: r.data, templateVersion: r.templateVersion };
}

describe('templateManage 业务层', () => {
  it('create 正常: 返回 dt-/ct- 约定 id 且版本号从 1 起', async () => {
    const r = await createTemplateType(ctx, 'admin', {
      kind: 'doc_type', name: '磅码单',
      parentIdName: '履约凭证',
      props: { requiredFields: ['毛重', '皮重'] },
    });
    expect(r.ok).toBe(true);
    const u = unwrap(r);
    expect(u.data.id).toBe('dt-磅码单');
    expect(u.templateVersion).toBe(1);
  });

  it('create 重名(同 kind+name) -> duplicate', async () => {
    const r = await createTemplateType(ctx, 'admin', { kind: 'doc_type', name: '合同' });
    expect(r).toMatchObject({ ok: false, code: 'duplicate' });
  });

  it('create 非法 bindingsTargetKind -> invalid(该键有行为语义)', async () => {
    const r = await createTemplateType(ctx, 'admin', {
      kind: 'doc_type', name: '订单',
      props: { bindingsTargetKind: 'Order' },
    });
    expect(r).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('create 后 listTemplateTypes 可见, managed_by 落值, template_versions 有行', async () => {
    unwrap(await createTemplateType(ctx, 'zhang', {
      kind: 'doc_type', name: '磅码单',
    }));
    const types = await listTemplateTypes(ctx);
    const row = types.find((t) => t.name === '磅码单');
    expect(row?.isActive).toBe(true);
    const raw = ctx.sqlite
      .prepare("SELECT managed_by AS b, managed_at AS a, props AS p FROM template_types WHERE id = 'dt-磅码单'")
      .get() as { b: string; a: string; p: string };
    expect(raw.b).toBe('zhang');
    expect(raw.a).toBeTruthy(); // managed_at 非空 => boot seed 永不再覆写该行
    expect(JSON.parse(raw.p)).toEqual({});
    const versions = await listTemplateVersions(ctx);
    expect(versions[0]).toMatchObject({
      version: 1, changedBy: 'zhang', changeSummary: 'type.create 磅码单',
    });
  });

  it('updateTemplateTypeProps: 覆写 props, parentId 缺省不动, 摘要 type.props_update', async () => {
    unwrap(await updateTemplateTypeProps(ctx, 'admin', {
      typeId: 'dt-发货单',
      props: { requiredFields: ['车号'], fieldHints: { 车号: '车牌号' } },
    }));
    const row = ctx.sqlite
      .prepare("SELECT props AS p, parent_id AS pid, managed_by AS b FROM template_types WHERE id = 'dt-发货单'")
      .get() as { p: string; pid: string; b: string };
    expect(JSON.parse(row.p)).toEqual({ requiredFields: ['车号'], fieldHints: { 车号: '车牌号' } });
    expect(row.pid).toBe('dt-运输凭证'); // 未传 parentIdName 则父不动
    expect(row.b).toBe('admin');
    const versions = await listTemplateVersions(ctx);
    expect(versions[0].changeSummary).toBe('type.props_update 发货单');
  });

  it('updateTemplateTypeProps: parentIdName=null 解除父子挂接', async () => {
    unwrap(await updateTemplateTypeProps(ctx, 'admin', {
      typeId: 'dt-化验报告', parentIdName: null,
    }));
    const row = ctx.sqlite
      .prepare("SELECT parent_id AS pid FROM template_types WHERE id = 'dt-化验报告'")
      .get() as { pid: string | null };
    expect(row.pid).toBeNull();
  });

  it('updateTemplateTypeProps: 父类型名不存在 -> not_found; 自引用 -> invalid', async () => {
    expect(await updateTemplateTypeProps(ctx, 'admin', {
      typeId: 'dt-发货单', parentIdName: '不存在的类型',
    })).toMatchObject({ ok: false, code: 'not_found' });
    expect(await updateTemplateTypeProps(ctx, 'admin', {
      typeId: 'dt-发货单', parentIdName: '发货单',
    })).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('updateEdgeRuleVocab: 覆写词表且 boot seed 同词表重灌不回滚(managed-wins 链路集成)', async () => {
    const u = unwrap(await updateEdgeRuleVocab(ctx, 'admin', {
      ruleId: 'er-bind-huozhuan', allowedVocab: ['货权转移', '货交承运人'],
    }));
    expect(u.templateVersion).toBe(1);
    // boot seed 重跑: ensureEdgeRule 对 managed_at 非空行跳过(Task 1 条件生效的链路证据)。
    await ensureTemplateSeed(ctx);
    const row = ctx.sqlite
      .prepare("SELECT allowed_vocab AS v, managed_by AS b FROM template_edge_rules WHERE id = 'er-bind-huozhuan'")
      .get() as { v: string; b: string };
    expect(JSON.parse(row.v)).toEqual(['货权转移', '货交承运人']);
    expect(row.b).toBe('admin');
    const versions = await listTemplateVersions(ctx);
    expect(versions[0].changeSummary).toBe('rule.vocab_update er-bind-huozhuan');
  });

  it('updateEdgeRuleVocab: 词表非字符串数组 -> invalid', async () => {
    const bad = await updateEdgeRuleVocab(ctx, 'admin', {
      ruleId: 'er-bind-huozhuan', allowedVocab: ['a', 3] as unknown as string[],
    });
    expect(bad).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('setTemplateTypeActive(false): 行禁用且返回 inUseReasons(激活规则引用+文档占用), 不阻止', async () => {
    // 场景构造: 发货单已有激活边规则 er-settle-fahuodan(seed 自带) + 存量文档一条。
    ctx.sqlite.prepare(
      "INSERT INTO documents (id, doc_type, modality, source_uri, block_model) VALUES ('doc-fhd', '发货单', 'text', 'minio://x/fhd.pdf', 'test')",
    ).run();
    const r = await setTemplateTypeActive(ctx, 'admin', { typeName: '发货单', active: false });
    expect(r.ok).toBe(true);
    const u = unwrap(r);
    expect(u.data.id).toBe('dt-发货单');
    expect(u.data.inUseReasons).toContain('激活边规则 er-settle-fahuodan 引用');
    expect(u.data.inUseReasons).toContain('documents 表存在 1 个该类型文档');
    // 展示性提示不阻止软禁用: 行照常置 0 且打管理戳。
    const raw = ctx.sqlite
      .prepare("SELECT is_active AS a, managed_by AS b FROM template_types WHERE id = 'dt-发货单'")
      .get() as { a: number; b: string };
    expect(raw.a).toBe(0);
    expect(raw.b).toBe('admin');
    const versions = await listTemplateVersions(ctx);
    expect(versions[0].changeSummary).toBe('type.deactivate 发货单');
  });

  it('setTemplateTypeActive(true): 复活被软禁用的类型本身(发货单)', async () => {
    // 直接 SQL 置 inactive 模拟存量禁用态(正式入口即本函数)。
    ctx.sqlite.prepare("UPDATE template_types SET is_active = 0 WHERE id = 'dt-发货单'").run();
    const u = unwrap(await setTemplateTypeActive(ctx, 'admin', { typeName: '发货单', active: true }));
    expect(u.data.id).toBe('dt-发货单');
    expect(u.data.inUseReasons).toBeUndefined(); // 只有停用路径给原因
    const raw = ctx.sqlite
      .prepare("SELECT is_active AS a, managed_by AS b, managed_at AS m FROM template_types WHERE id = 'dt-发货单'")
      .get() as { a: number; b: string; m: string };
    expect(raw.a).toBe(1);
    expect(raw.b).toBe('admin');
    expect(raw.m).toBeTruthy();
    const versions = await listTemplateVersions(ctx);
    expect(versions[0].changeSummary).toBe('type.activate 发货单');
  });

  it('setEdgeRuleActive: 登记不启用的 executes 规则双向切换, 版本号递增且列表过滤随动', async () => {
    // 初始: er-exec-fapiao 登记 inactive, 不在激活列表。
    expect((await listActiveEdgeRules(ctx)).some((r) => r.id === 'er-exec-fapiao')).toBe(false);
    const on = unwrap(await setEdgeRuleActive(ctx, 'admin', { ruleId: 'er-exec-fapiao', active: true }));
    expect(on.data.id).toBe('er-exec-fapiao');
    expect(on.templateVersion).toBe(1);
    expect((await listActiveEdgeRules(ctx)).some((r) => r.id === 'er-exec-fapiao')).toBe(true);

    const off = unwrap(await setEdgeRuleActive(ctx, 'admin', { ruleId: 'er-exec-fapiao', active: false }));
    expect(off.templateVersion).toBe(2);
    expect((await listActiveEdgeRules(ctx)).some((r) => r.id === 'er-exec-fapiao')).toBe(false);

    const versions = await listTemplateVersions(ctx);
    expect(versions.map((v) => v.changeSummary)).toEqual([
      'rule.deactivate er-exec-fapiao', 'rule.activate er-exec-fapiao',
    ]);
  });

  it('目标不存在 -> not_found(typeName / typeId / ruleId 多路)', async () => {
    expect(await setTemplateTypeActive(ctx, 'admin', { typeName: '没有的类型', active: false }))
      .toMatchObject({ ok: false, code: 'not_found' });
    // kind 收窄为 doc_type: 仅存在同名 contract_type 时同样判 not_found。
    expect(await setTemplateTypeActive(ctx, 'admin', { typeName: '采购', active: false }))
      .toMatchObject({ ok: false, code: 'not_found' });
    expect(await updateTemplateTypeProps(ctx, 'admin', { typeId: 'dt-没有' }))
      .toMatchObject({ ok: false, code: 'not_found' });
    expect(await updateEdgeRuleVocab(ctx, 'admin', { ruleId: 'er-nope', allowedVocab: ['x'] }))
      .toMatchObject({ ok: false, code: 'not_found' });
    expect(await setEdgeRuleActive(ctx, 'admin', { ruleId: 'er-nope', active: true }))
      .toMatchObject({ ok: false, code: 'not_found' });
  });

  it('typeUsageReasons: 独立只读 helper 输出与停用提示一致; 无占用时空数组', async () => {
    ctx.sqlite.prepare(
      "INSERT INTO documents (id, doc_type, modality, source_uri, block_model) VALUES ('doc-qz', '质检报告', 'text', 'minio://x/qz.pdf', 'test')",
    ).run();
    const reasons = await typeUsageReasons(ctx, '质检报告');
    expect(reasons).toContain('documents 表存在 1 个该类型文档');
    // 履约凭证只当父节点(规则都挂在子类型上)且无同名文档 -> 零占用。
    const none = await typeUsageReasons(ctx, '履约凭证');
    expect(none).toEqual([]);
  });
});
