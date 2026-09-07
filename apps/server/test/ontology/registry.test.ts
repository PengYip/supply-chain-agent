import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ONTOLOGY_ENTITIES, ENTITY_NAMES, entitySchema, entityFieldNames,
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

  it('8 relation types / 13 pairs, endpoints all valid entity names', () => {
    expect(ONTOLOGY_RELATIONS).toHaveLength(8);
    const names = ONTOLOGY_RELATIONS.map((r) => r.name);
    expect(new Set(names).size).toBe(8);
    expect(names).toEqual(expect.arrayContaining(
      ['ALLOCATE_TO', 'OFFSET_SETTLE', 'WRITE_OFF', 'REVERSE_ORIGIN',
       'FEEDS_INTO', 'CORRESPONDS_TO', 'TRIGGERS', 'PROVIDE']));
    const pairs = ONTOLOGY_RELATIONS.flatMap((r) => r.pairs);
    expect(pairs).toHaveLength(14);
    for (const p of pairs) {
      expect(ENTITY_NAMES).toContain(p.from);
      expect(ENTITY_NAMES).toContain(p.to);
    }
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
    expect(json.relations).toHaveLength(8);
    const contract = json.entities.find((e: { name: string }) => e.name === 'TradeContract');
    expect(contract.fields).toContain('contractNo');
    expect(json.enums.PayType).toEqual(['预付', '尾款', '进度款', '质保金']);
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
});
