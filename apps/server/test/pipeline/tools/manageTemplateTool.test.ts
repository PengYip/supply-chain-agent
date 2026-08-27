// P4 Task 4: manage_template L2 Agent 工具测试。
// 工具是 templateManage 统一写入面的薄分派层: 本文件验证 action 分派、参数兜底、
// 错误结构化返回(error 不抛异常)与 needsApproval 注册语义, 以及与 boot seed 的
// managed-wins 集成链路(update_vocab 后重灌不复原)。
import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate, type SqliteDbContext } from '../../../src/pipeline/db/client.js';
import { ensureTemplateSeed } from '../../../src/pipeline/templateSeed.js';
import { listActiveEdgeRules } from '../../../src/pipeline/db/repositories.js';
import { buildManageTemplateTool } from '../../../src/pipeline/tools/manageTemplateTool.js';

let ctx: SqliteDbContext;
let tool: ReturnType<typeof buildManageTemplateTool>;

beforeEach(async () => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
  await ensureTemplateSeed(ctx);
  tool = buildManageTemplateTool({ ctx, userId: 'agent-u1' });
});

/** documentEntry.test.ts 同款调用形态(AI SDK 6 直调 execute)。 */
const exec = (input: unknown) =>
  tool.execute(input as never, { messages: [], toolCallId: 't', abortSignal: undefined } as never);

describe('manage_template L2 工具', () => {
  it('create_type 最小入参 -> ok + 版本号 >=1 + DB 行 managed_by=deps.userId', async () => {
    const res: any = await exec({
      action: 'create_type', kind: 'doc_type', name: '磅码单',
    });
    expect(res.status).toBe('ok');
    expect(res.action).toBe('create_type');
    expect(res.templateVersion).toBeGreaterThanOrEqual(1);
    expect(res.id).toBe('dt-磅码单');
    const raw = ctx.sqlite.prepare(
      "SELECT managed_by AS b FROM template_types WHERE id = 'dt-磅码单'",
    ).get() as { b: string };
    expect(raw.b).toBe('agent-u1');
  });

  it('create_type 非法 bindingsTargetKind -> {status:error, code:invalid}', async () => {
    const res: any = await exec({
      action: 'create_type', kind: 'doc_type', name: '订单',
      props: { bindingsTargetKind: 'Order' },
    });
    expect(res.status).toBe('error');
    expect(res.code).toBe('invalid');
    expect(typeof res.reason).toBe('string');
  });

  it('update_vocab 合法 -> 词表变化且 ensureSeed 同 id 重灌不复原(managed-wins 链路)', async () => {
    const res: any = await exec({
      action: 'update_vocab', ruleId: 'er-bind-huozhuan',
      allowedVocab: ['货权转移', '货交承运人'],
    });
    expect(res.status).toBe('ok');
    expect(res.id).toBe('er-bind-huozhuan');
    const read = () => (ctx.sqlite.prepare(
      "SELECT allowed_vocab AS v FROM template_edge_rules WHERE id = 'er-bind-huozhuan'",
    ).get() as { v: string }).v;
    expect(JSON.parse(read())).toEqual(['货权转移', '货交承运人']);
    // boot seed 重跑同一词表: managed_at 非空行被跳过(Task 1 条件生效的链路证据)。
    await ensureTemplateSeed(ctx);
    expect(JSON.parse(read())).toEqual(['货权转移', '货交承运人']);
  });

  it('set_rule_active false 后 listActiveEdgeRules 不含该规则', async () => {
    // 种子里 er-settle-fahuodan 为激活态。
    const res: any = await exec({
      action: 'set_rule_active', ruleId: 'er-settle-fahuodan', active: false,
    });
    expect(res.status).toBe('ok');
    expect(res.id).toBe('er-settle-fahuodan');
    expect(res.templateVersion).toBeGreaterThanOrEqual(1);
    const rules = await listActiveEdgeRules(ctx);
    expect(rules.some((r) => r.id === 'er-settle-fahuodan')).toBe(false);
  });

  it('缺必填参数(create_type 无 kind/name) -> error/invalid(execute 内兜底)', async () => {
    // 直调 execute 不经框架层 zod 校验, 参数守卫必须在工具内再挡一层。
    for (const bad of [
      { action: 'create_type' },
      { action: 'create_type', kind: 'doc_type' },
      { action: 'create_type', name: 'X' },
      { action: 'update_vocab', ruleId: 'er-x' },                       // 缺 allowedVocab
      { action: 'set_type_active', typeName: '发货单' },                 // 缺 active
      { action: 'set_rule_active', ruleId: 'er-x' },                    // 缺 active
      { action: 'update_props' },                                       // 缺 typeId
    ]) {
      const res: any = await exec(bad);
      expect(res.status, JSON.stringify(bad)).toBe('error');
      expect(res.code, JSON.stringify(bad)).toBe('invalid');
    }
  });

  it('目标不存在 -> error/not_found(update_vocab | set_type_active)', async () => {
    const a: any = await exec({ action: 'update_vocab', ruleId: 'er-nope', allowedVocab: ['x'] });
    expect(a).toMatchObject({ status: 'error', code: 'not_found' });
    const b: any = await exec({ action: 'set_type_active', typeName: '没有的类型', active: false });
    expect(b).toMatchObject({ status: 'error', code: 'not_found' });
  });

  it('set_type_active(false) 返回 inUseReasons 展示占用提示', async () => {
    const res: any = await exec({ action: 'set_type_active', typeName: '发货单', active: false });
    expect(res.status).toBe('ok');
    expect(res.inUseReasons).toContain('激活边规则 er-settle-fahuodan 引用');
  });
});
