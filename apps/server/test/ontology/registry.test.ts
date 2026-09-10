import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ONTOLOGY_ENTITIES, ENTITY_NAMES, ENTITY_LABELS, ENTITY_DESCRIPTIONS,
  entitySchema, entityFieldNames, type OntologyEntityName,
  ONTOLOGY_RELATIONS, relationDef, isRelationPairAllowed,
  PayType, EventBizType, AllocateMethod, COMMODITY_CODES, MEANING_URIS,
  DUAL_TIMELINE_FIELDS, PROVENANCE_FIELDS, ontologySchemaJson,
} from '../../src/ontology/index.js';

describe('ontology registry', () => {
  it('11 entities: 4 static + 7 events, exact names', () => {
    expect(ENTITY_NAMES).toEqual([
      'TradeContract', 'TradeGoods', 'Counterparty', 'OrgUnit',
      'GoodsReceiptEvent', 'GoodsDeliveryEvent', 'SettlementEvent',
      'InvoiceEvent', 'PaymentEvent', 'CollectionEvent', 'ServiceCostEvent',
    ]);
  });

  it('closed enums from docx section 6', () => {
    expect(PayType.options).toEqual(['预付', '尾款', '进度款', '质保金']);
    expect(EventBizType.options).toEqual(['正向', '逆向']);
    expect(AllocateMethod.options).toEqual(['金额', '数量', '重量', '定额']);
    expect(PayType.safeParse('预付').success).toBe(true);
    expect(PayType.safeParse('赊账').success).toBe(false);
  });

  it('commodity code is open vocabulary in v1 (memo section 7 pending)', () => {
    expect(Array.isArray(COMMODITY_CODES)).toBe(true);
    expect(ONTOLOGY_ENTITIES.TradeGoods.shape.commodityCode).toBeDefined();
  });

  it('event semantics (docx 6.2): reverse events carry negative amounts only', () => {
    const base = { invoiceNo: 'INV-1', invoiceType: '销项', currency: 'CNY' };
    expect(entitySchema('InvoiceEvent').safeParse(
      { ...base, eventBizType: '正向', amount: 100 }).success).toBe(true);
    expect(entitySchema('InvoiceEvent').safeParse(
      { ...base, eventBizType: '逆向', amount: 100 }).success).toBe(false);
    expect(entitySchema('InvoiceEvent').safeParse(
      { ...base, eventBizType: '逆向', amount: -100 }).success).toBe(true);
  });

  describe('收/发货 amount 可选（2026-09-08：磅单/质检单常只有数量，货值后置结算）', () => {
    const qtyOnly = { eventBizType: '正向', quantity: 100, unit: '吨' };

    it('数量-only 收货/发货合法（amount/currency 全省略）', () => {
      expect(entitySchema('GoodsReceiptEvent').safeParse(qtyOnly).success).toBe(true);
      expect(entitySchema('GoodsDeliveryEvent').safeParse(qtyOnly).success).toBe(true);
    });

    it('amount 与 currency 同缺同在（superRefine 不变量）：只有其一被拒', () => {
      expect(entitySchema('GoodsReceiptEvent').safeParse({ eventBizType: '正向', amount: 100 }).success).toBe(false);
      expect(entitySchema('GoodsReceiptEvent').safeParse({ eventBizType: '正向', currency: 'CNY' }).success).toBe(false);
      expect(entitySchema('GoodsDeliveryEvent').safeParse({ eventBizType: '正向', amount: 100 }).success).toBe(false);
      expect(entitySchema('GoodsDeliveryEvent').safeParse({ eventBizType: '正向', currency: 'CNY' }).success).toBe(false);
    });

    it('amount 存在时语义不变：正向正数/逆向负数/两全合法', () => {
      expect(entitySchema('GoodsReceiptEvent').safeParse(
        { eventBizType: '正向', amount: 100, currency: 'CNY' }).success).toBe(true);
      expect(entitySchema('GoodsReceiptEvent').safeParse(
        { eventBizType: '逆向', amount: 100, currency: 'CNY' }).success).toBe(false);
      expect(entitySchema('GoodsDeliveryEvent').safeParse(
        { eventBizType: '逆向', amount: -100, currency: 'CNY' }).success).toBe(true);
    });

    it('五个钱事件 amount 仍必填（结算/发票/收付款/服务费不动）', () => {
      const moneyEvents = [
        'SettlementEvent', 'InvoiceEvent', 'PaymentEvent', 'CollectionEvent', 'ServiceCostEvent',
      ] as const;
      for (const t of moneyEvents) {
        expect(entitySchema(t).safeParse({ eventBizType: '正向' }).success).toBe(false);
      }
    });
  });

  it('11 relation types / 19 pairs (docx 8 + spec 2026-09-09 PARENT_OF/DELIVERED_AS + 决策 #11 TRADING_WITH)', () => {
    expect(ONTOLOGY_RELATIONS).toHaveLength(11);
    const names = ONTOLOGY_RELATIONS.map((r) => r.name);
    expect(new Set(names).size).toBe(11);
    expect(names).toEqual(expect.arrayContaining(
      ['ALLOCATE_TO', 'OFFSET_SETTLE', 'WRITE_OFF', 'REVERSE_ORIGIN',
       'FEEDS_INTO', 'CORRESPONDS_TO', 'TRIGGERS', 'PROVIDE',
       'PARENT_OF', 'DELIVERED_AS', 'TRADING_WITH']));
    const pairs = ONTOLOGY_RELATIONS.flatMap((r) => r.pairs);
    expect(pairs).toHaveLength(19);
    for (const p of pairs) {
      expect(ENTITY_NAMES).toContain(p.from);
      expect(ENTITY_NAMES).toContain(p.to);
    }
  });

  it('TRADING_WITH: 收/发货事件 -> 交易对手(spec 决策 #11, 事件对手显式化)', () => {
    expect(isRelationPairAllowed('TRADING_WITH', 'GoodsReceiptEvent', 'Counterparty')).toBe(true);
    expect(isRelationPairAllowed('TRADING_WITH', 'GoodsDeliveryEvent', 'Counterparty')).toBe(true);
    // 白名单只放行事件->对手方: 事件->商品走 DELIVERED_AS, 不混用
    expect(isRelationPairAllowed('TRADING_WITH', 'GoodsReceiptEvent', 'TradeGoods')).toBe(false);
    expect(isRelationPairAllowed('TRADING_WITH', 'Counterparty', 'Counterparty')).toBe(false);
    const params = relationDef('TRADING_WITH').params;
    expect(params.safeParse({ role: '上游' }).success).toBe(true);
    expect(params.safeParse({ role: '下游' }).success).toBe(true);
    expect(params.safeParse({}).success).toBe(false); // role 必填
    expect(params.safeParse({ role: '平行' }).success).toBe(false); // 闭枚举
    expect(params.safeParse({ role: '上游', bogus: 1 }).success).toBe(false); // strict
  });

  it('PARENT_OF: 母子公司带参关系(spec 主体身份 §2)', () => {
    expect(isRelationPairAllowed('PARENT_OF', 'Counterparty', 'Counterparty')).toBe(true);
    expect(isRelationPairAllowed('PARENT_OF', 'Counterparty', 'InvoiceEvent')).toBe(false);
    const params = relationDef('PARENT_OF').params;
    expect(params.safeParse({}).success).toBe(true);
    expect(params.safeParse({ ratio: 0.6 }).success).toBe(true);
    expect(params.safeParse({ ratio: 0.6, note: '控股' }).success).toBe(true);
    expect(params.safeParse({ ratio: 1.1 }).success).toBe(false); // ratio 0-1
    expect(params.safeParse({ bogus: 1 }).success).toBe(false); // strict
  });

  it('DELIVERED_AS: 收/发货事件 -> 商品 SKU(spec 决策 #10, batch 食安追溯)', () => {
    expect(isRelationPairAllowed('DELIVERED_AS', 'GoodsReceiptEvent', 'TradeGoods')).toBe(true);
    expect(isRelationPairAllowed('DELIVERED_AS', 'GoodsDeliveryEvent', 'TradeGoods')).toBe(true);
    expect(isRelationPairAllowed('DELIVERED_AS', 'GoodsReceiptEvent', 'TradeContract')).toBe(false);
    const params = relationDef('DELIVERED_AS').params;
    expect(params.safeParse({}).success).toBe(true);
    expect(params.safeParse({ batch: 'SIF1234-20260909' }).success).toBe(true);
    expect(params.safeParse({ other: 1 }).success).toBe(false); // strict
  });

  it('relation params are strict closed schemas', () => {
    const alloc = relationDef('ALLOCATE_TO');
    expect(alloc.params.safeParse({ amount: 1200, method: '金额' }).success).toBe(true);
    expect(alloc.params.safeParse({ amount: 1200 }).success).toBe(false); // 缺 method
    expect(alloc.params.safeParse({ amount: 1200, method: '金额', ratio: 1.1 }).success).toBe(false); // ratio<=1
    expect(relationDef('OFFSET_SETTLE').params.safeParse({ amount: 500, batch: 'B1' }).success).toBe(true);
    expect(relationDef('FEEDS_INTO').params.safeParse({}).success).toBe(true);
    expect(relationDef('FEEDS_INTO').params.safeParse({ x: 1 }).success).toBe(false); // 无参关系拒绝任意参数
  });

  it('pair allow-list: legal pairs pass, illegal pairs throw at write boundary', () => {
    expect(isRelationPairAllowed('WRITE_OFF', 'PaymentEvent', 'InvoiceEvent')).toBe(true);
    expect(isRelationPairAllowed('ALLOCATE_TO', 'TradeContract', 'InvoiceEvent')).toBe(false);
    expect(isRelationPairAllowed('NO_SUCH_RELATION', 'PaymentEvent', 'InvoiceEvent')).toBe(false);
    expect(() => relationDef('NO_SUCH_RELATION')).toThrow();
  });

  it('entityFieldNames unions own + timeline + provenance fields', () => {
    const f = entityFieldNames('TradeContract');
    expect(f.has('contractNo')).toBe(true);
    expect(f.has('validAt')).toBe(true);
    expect(f.has('createdBy')).toBe(true);
    expect([...DUAL_TIMELINE_FIELDS, ...PROVENANCE_FIELDS].every((x) => f.has(x))).toBe(true);
  });

  it('ontologySchemaJson is the frontend-consumable projection', () => {
    const json = JSON.parse(JSON.stringify(ontologySchemaJson()));
    expect(json.entities).toHaveLength(11);
    expect(json.relations).toHaveLength(11);
    const contract = json.entities.find((e: { name: string }) => e.name === 'TradeContract');
    expect(contract.fields).toContain('contractNo');
    expect(json.enums.PayType).toEqual(['预付', '尾款', '进度款', '质保金']);
  });

  it('schema version 随注册表结构变更推进(spec 附A: 实施同步清单)', () => {
    expect(ontologySchemaJson().version).toBe('2026-09-10-flowpanel');
  });

  it('款/票事件 payload 可选 contractNo(spec §15 前置①: 按合同聚合款/票)', () => {
    // 三个事件实体登记 contractNo; 缺省合法(可选), 收/发货不收(归属走绑定/分摊边)。
    const minimal: Record<string, Record<string, unknown>> = {
      PaymentEvent: { eventBizType: '正向', amount: 100, currency: 'CNY', payType: '预付' },
      CollectionEvent: { eventBizType: '正向', amount: 100, currency: 'CNY' },
      InvoiceEvent: { eventBizType: '正向', amount: 100, currency: 'CNY', invoiceNo: 'INV-1', invoiceType: '进项' },
    };
    for (const t of ['PaymentEvent', 'CollectionEvent', 'InvoiceEvent'] as const) {
      expect(ONTOLOGY_ENTITIES[t].shape['contractNo'], t).toBeDefined();
      expect(entitySchema(t).safeParse(minimal[t]!).success, t).toBe(true);
      expect(entitySchema(t).safeParse({ ...minimal[t]!, contractNo: 'GMNH-JBKZ-20250303HNWH' }).success, t).toBe(true);
    }
    // 收/发货 payload 不收 contractNo(strict 快速失败)
    expect(entitySchema('GoodsReceiptEvent').safeParse({
      eventBizType: '正向', quantity: 10, unit: '吨', contractNo: 'X',
    }).success).toBe(false);
  });

  it('Counterparty: uscc 主体归一锚必填, 附加属性全可选(spec §3)', () => {
    const shape = ONTOLOGY_ENTITIES.Counterparty.shape;
    expect(shape['uscc']).toBeDefined();
    // uscc 在首字段(身份锚视觉位置)
    expect(Object.keys(shape)[0]).toBe('uscc');
    const optional = ['address', 'bankAccount', 'bankName', 'legalRepresentative',
      'registeredCapital', 'establishedDate', 'businessScope'];
    for (const f of optional) expect(shape[f]).toBeDefined();
    // uscc/name 必填经 entitySchema(strict) 权威执行
    expect(entitySchema('Counterparty').safeParse({ uscc: '91130000MA0A0000XA', name: '某钢铁', role: '供应商' }).success).toBe(true);
    expect(entitySchema('Counterparty').safeParse({ name: '某钢铁', role: '供应商' }).success).toBe(false);
    expect(entitySchema('Counterparty').safeParse({ uscc: '91130000MA0A0000XA', role: '供应商' }).success).toBe(false);
    // 附加属性缺省合法; 未知字段 strict 拒绝
    expect(entitySchema('Counterparty').safeParse({
      uscc: '91130000MA0A0000XA', name: '某钢铁', role: '供应商',
      address: '唐山市', bankAccount: '6222000011112222', bankName: '工行',
      legalRepresentative: '张某', registeredCapital: '5000万', establishedDate: '2001-01-01',
      businessScope: '钢材贸易',
    }).success).toBe(true);
    expect(entitySchema('Counterparty').safeParse({
      uscc: '91130000MA0A0000XA', name: '某钢铁', role: '供应商', bogus: 1,
    }).success).toBe(false);
  });

  it('TradeGoods.attributes: 受控标量 KV 袋(spec §3, 键<=40 字/值标量/条数<=32)', () => {
    const legal = {
      name: '螺纹钢', commodityCode: 'HRB400E',
      attributes: { '牌号': 'HRB400E', '直径': '12mm', '定尺': '9m', '件重': 12 },
    };
    expect(entitySchema('TradeGoods').safeParse(legal).success).toBe(true);
    // attributes 可选: 缺省合法
    expect(entitySchema('TradeGoods').safeParse({ name: '螺纹钢', commodityCode: 'X' }).success).toBe(true);
    // 键超 40 字拒绝
    const longKey = 'k'.repeat(41);
    expect(entitySchema('TradeGoods').safeParse({
      name: '螺纹钢', commodityCode: 'X', attributes: { [longKey]: 'v' },
    }).success).toBe(false);
    // 空键拒绝
    expect(entitySchema('TradeGoods').safeParse({
      name: '螺纹钢', commodityCode: 'X', attributes: { '': 'v' },
    }).success).toBe(false);
    // 值为对象/数组拒绝(仅标量 string|number)
    expect(entitySchema('TradeGoods').safeParse({
      name: '螺纹钢', commodityCode: 'X', attributes: { '牌号': { nested: true } },
    }).success).toBe(false);
    expect(entitySchema('TradeGoods').safeParse({
      name: '螺纹钢', commodityCode: 'X', attributes: { '牌号': ['Q235B'] },
    }).success).toBe(false);
    // 超 32 条拒绝(superRefine 写入边界叠加)
    const big: Record<string, string> = {};
    for (let i = 0; i < 33; i += 1) big[`k${i}`] = 'v';
    expect(entitySchema('TradeGoods').safeParse({
      name: '螺纹钢', commodityCode: 'X', attributes: big,
    }).success).toBe(false);
    const cap32: Record<string, string> = {};
    for (let i = 0; i < 32; i += 1) cap32[`k${i}`] = 'v';
    expect(entitySchema('TradeGoods').safeParse({
      name: '螺纹钢', commodityCode: 'X', attributes: cap32,
    }).success).toBe(true);
  });

  it('收/发货 payload 增 counterpartyId/titleTransfer 可选字段(spec 决策 #11)', () => {
    for (const t of ['GoodsReceiptEvent', 'GoodsDeliveryEvent'] as const) {
      // 缺省合法(向后兼容既有事实)
      expect(entitySchema(t).safeParse(
        { eventBizType: '正向', quantity: 100, unit: '吨' }).success).toBe(true);
      // 新字段携带合法, 经 strict 写入边界不拒绝
      expect(entitySchema(t).safeParse({
        eventBizType: '正向', quantity: 100, unit: '吨',
        counterpartyId: 'TF-cp-1', titleTransfer: '发货即转',
      }).success).toBe(true);
      // 空串拒绝(min(1))
      expect(entitySchema(t).safeParse({
        eventBizType: '正向', quantity: 100, unit: '吨', counterpartyId: '',
      }).success).toBe(false);
      expect(entitySchema(t).safeParse({
        eventBizType: '正向', quantity: 100, unit: '吨', titleTransfer: '',
      }).success).toBe(false);
    }
    // 非收/发货事件不扩此词汇(strict 快速失败)
    expect(entitySchema('SettlementEvent').safeParse({
      eventBizType: '正向', amount: 1, currency: 'CNY', titleTransfer: '发货即转',
    }).success).toBe(false);
  });

  it('meaning URIs: mechanism ships empty, values must be URIs when attached', () => {
    expect(Object.keys(MEANING_URIS)).toEqual([]);
    const pattern = /^[a-z][a-z0-9+.-]*:\S+$/;
    for (const uri of Object.values(MEANING_URIS)) expect(uri).toMatch(pattern);
  });

  it('registry file stays frontend-consumable: zod-only imports, no node builtins', () => {
    const src = readFileSync(fileURLToPath(new URL('../../src/ontology/index.ts', import.meta.url)), 'utf-8');
    expect(src).not.toMatch(/from 'node:/);
    expect(src).not.toMatch(/require\(/);
    // 只允许 zod 外部 import
    const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]!);
    expect(imports.every((i) => i === 'zod' || i.startsWith('.'))).toBe(true);
  });

  it('entity labels + ownFields for the Item 3 ledger UI', () => {
    expect(Object.keys(ENTITY_LABELS).sort()).toEqual([...ENTITY_NAMES].sort());
    for (const label of Object.values(ENTITY_LABELS)) {
      expect(typeof label).toBe('string');
      expect(label.length).toBeGreaterThan(0);
    }
    const json = JSON.parse(JSON.stringify(ontologySchemaJson()));
    const invoice = json.entities.find((e: { name: string }) => e.name === 'InvoiceEvent');
    expect(invoice.label).toBe('发票事件');
    expect(invoice.ownFields).toContain('invoiceNo');
    expect(invoice.ownFields).not.toContain('validAt'); // 时间轴字段在 fields 全集，不在 ownFields
  });

  it('11 实体全有非空中文 description（业务定义 + 对账/履约链角色）', () => {
    expect(Object.keys(ENTITY_DESCRIPTIONS).sort()).toEqual([...ENTITY_NAMES].sort());
    for (const name of ENTITY_NAMES) {
      const desc = ENTITY_DESCRIPTIONS[name];
      expect(typeof desc).toBe('string');
      expect(desc.length).toBeGreaterThan(0);
    }
  });

  it('schema DTO 透出 entities[].description（治理 UI 数据源）', () => {
    const json = JSON.parse(JSON.stringify(ontologySchemaJson()));
    for (const e of json.entities as Array<{ name: string; description: string }>) {
      expect(e.description).toBe(ENTITY_DESCRIPTIONS[e.name as OntologyEntityName]);
    }
  });
});
