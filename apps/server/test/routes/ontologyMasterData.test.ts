import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import type { AuthEnv } from '../../src/lib/auth-middleware.js';

const { ctxHolder } = vi.hoisted(() => ({ ctxHolder: { current: null as DbContext | null } }));
vi.mock('../../src/pipeline/db/dbBackend.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/pipeline/db/dbBackend.js')>();
  return { ...mod, getDbContext: () => ctxHolder.current };
});
const { ontologyRoute } = await import('../../src/routes/ontology.js');
const { listProjectedEntities } = await import('../../src/ontology/projection.js');
const { getTradeFactById } = await import('../../src/ontology/repo.js');
const { commodityCodeGateError } = await import('../../src/ontology/masterData.js');

function appAs(userId: string) {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { id: userId, email: 't@t', role: 'trader' } as never);
    await next();
  });
  app.route('/api/ontology', ontologyRoute);
  return app;
}

let ctx: DbContext;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
  ctxHolder.current = ctx;
});

describe('GET /api/ontology/master-data/schema', () => {
  it('401 without session', async () => {
    const app = new Hono<AuthEnv>();
    app.route('/api/ontology', ontologyRoute);
    const res = await app.request('http://test/api/ontology/master-data/schema');
    expect(res.status).toBe(401);
  });

  it('表单投影反射注册表：3 类静态主数据，字段含必填/描述/标签', async () => {
    const res = await appAs('u1').request('http://test/api/ontology/master-data/schema');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      types: Array<{
        name: string; label: string; description: string;
        fields: Array<{ name: string; kind: string; required: boolean; description: string }>;
      }>;
    };
    expect(body.types.map((t) => t.name)).toEqual(['TradeGoods', 'Counterparty', 'OrgUnit']);
    const goods = body.types.find((t) => t.name === 'TradeGoods')!;
    expect(goods.label).toBe('商品');
    expect(goods.description.length).toBeGreaterThan(0);
    const byName = new Map(goods.fields.map((f) => [f.name, f]));
    expect(byName.get('name')!.required).toBe(true);
    expect(byName.get('commodityCode')!.required).toBe(true);
    expect(byName.get('spec')!.required).toBe(false);
    expect(byName.get('name')!.description).toContain('品名');
    // spec 决策 #8: attributes 袋不进表单投影(fieldKind 不支持 record), 录入走键值编辑区
    expect(byName.has('attributes')).toBe(false);
    // Counterparty: uscc 主体归一锚必填出现在投影(spec §3)
    const party = body.types.find((t) => t.name === 'Counterparty')!;
    const partyByName = new Map(party.fields.map((f) => [f.name, f]));
    expect(partyByName.get('uscc')!.required).toBe(true);
    expect(partyByName.get('name')!.required).toBe(true);
    expect(partyByName.get('address')!.required).toBe(false);
    expect(partyByName.get('bankAccount')!.required).toBe(false);
  });
});

describe('POST /api/ontology/master-data', () => {
  const post = (app: Hono<AuthEnv>, body: unknown) =>
    app.request('http://test/api/ontology/master-data', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });

  it('401 without session', async () => {
    const app = new Hono<AuthEnv>();
    app.route('/api/ontology', ontologyRoute);
    const res = await post(app, { entityType: 'Counterparty', uscc: '91130000MA0A0000XA', name: '某钢铁', role: '供应商' });
    expect(res.status).toBe(401);
  });

  it('400 inputSchema strict：未知字段字段级报错，且不产生写入', async () => {
    const app = appAs('u1');
    const res = await post(app, { entityType: 'Counterparty', uscc: '91130000MA0A0000XA', name: '某钢铁', role: '供应商', phantomField: 1 });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; detail: { fieldErrors: Record<string, string[]> } };
    expect(body.error).toBe('invalid_body');
    expect(Object.keys(body.detail.fieldErrors)).toContain('phantomField');
    const list = await listProjectedEntities(ctx, 'Counterparty', {}, 'u1');
    expect(list.total).toBe(0);
  });

  it('400 事件类型不可走主数据登记（entityType 字段级报错）', async () => {
    const app = appAs('u1');
    const res = await post(app, { entityType: 'PaymentEvent', amount: 100, currency: 'CNY' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; detail: { fieldErrors: Record<string, string[]> } };
    expect(body.error).toBe('invalid_body');
    expect(Object.keys(body.detail.fieldErrors)).toContain('entityType');
  });

  it('400 注册表语义预检：必填字段缺失（Counterparty 缺 uscc/name）字段级报错', async () => {
    const app = appAs('u1');
    const res = await post(app, { entityType: 'Counterparty', role: '供应商' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; detail: { fieldErrors: Record<string, string[]> } };
    expect(body.error).toBe('invalid_master_data');
    expect(Object.keys(body.detail.fieldErrors)).toContain('name');
    expect(Object.keys(body.detail.fieldErrors)).toContain('uscc');
  });

  it('400 注册表语义预检：实体词汇外字段（Counterparty 带 commodityCode）整单拒绝', async () => {
    const app = appAs('u1');
    const res = await post(app, { entityType: 'Counterparty', uscc: '91130000MA0A0000XA', name: '某钢铁', role: '供应商', commodityCode: 'COAL' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; detail: { fieldErrors: Record<string, string[]> } };
    expect(body.error).toBe('invalid_master_data');
    expect(Object.keys(body.detail.fieldErrors)).toContain('commodityCode');
  });

  it('400 TradeGoods attributes 袋超限拒绝（spec §3 受控软约束写入边界生效）', async () => {
    const app = appAs('u1');
    const big: Record<string, string> = {};
    for (let i = 0; i < 33; i += 1) big[`k${i}`] = 'v';
    const res = await post(app, {
      entityType: 'TradeGoods', name: '螺纹钢', commodityCode: 'HRB400E', attributes: big,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; detail: { fieldErrors: Record<string, string[]> } };
    expect(body.error).toBe('invalid_master_data');
    expect(Object.keys(body.detail.fieldErrors)).toContain('attributes');
  });

  it('200 商品登记：v1 词汇为空编码自由填写，写入 createdBy=manual，台账列表刷新可见', async () => {
    const app = appAs('u1');
    const res = await post(app, {
      entityType: 'TradeGoods', name: '动力煤', commodityCode: '5500K', spec: 'Q5500', unit: '吨',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; entityType: string };
    expect(body.entityType).toBe('TradeGoods');
    expect(body.id).toBeTruthy();
    const fact = await getTradeFactById(ctx, body.id, 'u1');
    expect(fact?.createdBy).toBe('manual');
    expect(fact?.payload['name']).toBe('动力煤');
    const list = await listProjectedEntities(ctx, 'TradeGoods', {}, 'u1');
    expect(list.total).toBe(1);
    expect(list.items[0]!.label).toBe('动力煤');
    expect(list.items[0]!.fields['commodityCode']).toBe('5500K');
  });

  it('200 商品登记带 attributes 袋：KV 原样入 payload（spec §3 品类异构属性）', async () => {
    const app = appAs('u1');
    const res = await post(app, {
      entityType: 'TradeGoods', name: '螺纹钢', commodityCode: 'HRB400E',
      spec: 'HRB400E Φ12mm 9m定尺', unit: '吨',
      attributes: { '牌号': 'HRB400E', '直径': '12mm', '定尺': '9m', '件重': 12 },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    const fact = await getTradeFactById(ctx, body.id, 'u1');
    expect(fact?.payload['attributes']).toEqual({
      '牌号': 'HRB400E', '直径': '12mm', '定尺': '9m', '件重': 12,
    });
  });

  it('200 交易对手登记：uscc 必填、validAt 归一 UTC ISO、附加属性入 payload、用户隔离', async () => {
    const app = appAs('u1');
    const res = await post(app, {
      entityType: 'Counterparty', uscc: '91130000MA0A0000XA', name: '某矿业', role: '客户',
      validAt: '2026-06-25', bankAccount: '6222000011112222333', legalRepresentative: '张某',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    const fact = await getTradeFactById(ctx, body.id, 'u1');
    expect(fact?.validAt).toBe('2026-06-25T00:00:00.000Z');
    expect(fact?.payload['uscc']).toBe('91130000MA0A0000XA');
    expect(fact?.payload['bankAccount']).toBe('6222000011112222333');
    const other = await listProjectedEntities(ctx, 'Counterparty', {}, 'u2');
    expect(other.total).toBe(0);
  });
});

describe('commodityCodeGateError（词汇非空时收紧，空词汇 v1 自由填写）', () => {
  it('空词汇（v1 开放）不拦截', () => {
    expect(commodityCodeGateError('任意码', [])).toBeNull();
  });

  it('词汇非空：圈内放行、圈外拒绝', () => {
    const vocab = ['煤炭', '铁矿石'];
    expect(commodityCodeGateError('煤炭', vocab)).toBeNull();
    expect(commodityCodeGateError('原油', vocab)).not.toBeNull();
  });
});
