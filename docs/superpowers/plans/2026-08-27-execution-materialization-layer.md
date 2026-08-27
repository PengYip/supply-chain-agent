# 通用履约物化层 Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 任何履约凭证 confirmed 绑定后物化单位规范的统一执行流水（数量=原值+单位+量纲+规范值），覆盖扩到运输/进销项票类，历史数据可回填，合同执行进度可查询。

**Architecture:** 方案A——单位注册表与类型适配表都是代码内纯数据（domain/units.ts、tradeSemantics.FLOW_ADAPTERS）；方向判定三级链（主体锚点→合同类型→类型自带）集中在 executionFlow.ts；execution_flows 加 3 列保留 quantity_ton 兼容；回填走既有 refresh 防漂移路径。

**Tech Stack:** TypeScript / zod / vitest / better-sqlite3 (raw DDL + guarded ALTER) / Postgres (drizzle schema + ADD COLUMN IF NOT EXISTS) / tsx scripts。

**Spec:** `docs/superpowers/specs/2026-08-27-execution-materialization-layer-design.md`

## Global Constraints

- 禁止 emoji（repo 约定）；中文注释风格与现有一致。
- 不猜测原则：单位未知 → dimension/canonical 为 NULL，原值照存；方向判不出 → 跳过。
- 双端 DB 同步：SQLite（client.ts raw DDL + guarded ALTER）与 Postgres（client.ts PG DDL `ADD COLUMN IF NOT EXISTS` + postgres-schema.ts drizzle 定义）必须成对修改。
- 每个任务完成即 commit；最终 build → lint → test 全绿。
- 测试命令: `npm test --workspace apps/server -- test/pipeline/xxx.test.ts`（repo 根目录执行）。

---

### Task 1: domain/units.ts 单位注册表

**Files:**
- Create: `apps/server/src/domain/units.ts`
- Test: `apps/server/test/domain/units.test.ts`

**Interfaces:**
- Produces: `QuantityDimension = 'mass' | 'count'`; `UnitDef { dimension; factorToKg }`; `UNIT_REGISTRY`; `resolveUnit(name: string): UnitDef | null`; `CanonicalQuantity { dimension; canonical }`; `canonicalizeQuantity(value: number, unit: string): CanonicalQuantity | null`。后续 Task 3/7 消费。

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/test/domain/units.test.ts
import { describe, it, expect } from 'vitest';
import { UNIT_REGISTRY, resolveUnit, canonicalizeQuantity } from '../../src/domain/units.js';

describe('UNIT_REGISTRY', () => {
  it('首批注册: 质量(吨/千克/公斤/克) + 计数(箱/件/车)', () => {
    expect(UNIT_REGISTRY['吨']).toEqual({ dimension: 'mass', factorToKg: 1000 });
    expect(UNIT_REGISTRY['千克']).toEqual({ dimension: 'mass', factorToKg: 1 });
    expect(UNIT_REGISTRY['公斤']).toEqual({ dimension: 'mass', factorToKg: 1 });
    expect(UNIT_REGISTRY['克']).toEqual({ dimension: 'mass', factorToKg: 0.001 });
    expect(UNIT_REGISTRY['箱']).toEqual({ dimension: 'count', factorToKg: 1 });
    expect(UNIT_REGISTRY['件']).toEqual({ dimension: 'count', factorToKg: 1 });
    expect(UNIT_REGISTRY['车']).toEqual({ dimension: 'count', factorToKg: 1 });
  });
});

describe('resolveUnit', () => {
  it('精确匹配(去除首尾空白)', () => {
    expect(resolveUnit(' 吨 ')).toEqual({ dimension: 'mass', factorToKg: 1000 });
  });
  it('未注册单位返回 null(不猜)', () => {
    expect(resolveUnit('磅')).toBeNull();
    expect(resolveUnit('')).toBeNull();
  });
});

describe('canonicalizeQuantity', () => {
  it('mass: 3吨 -> 3000 kg', () => {
    expect(canonicalizeQuantity(3, '吨')).toEqual({ dimension: 'mass', canonical: 3000 });
  });
  it('mass: 500克 -> 0.5 kg', () => {
    expect(canonicalizeQuantity(500, '克')).toEqual({ dimension: 'mass', canonical: 0.5 });
  });
  it('count: 120箱 -> count 池原值', () => {
    expect(canonicalizeQuantity(120, '箱')).toEqual({ dimension: 'count', canonical: 120 });
  });
  it('未知单位 -> null', () => {
    expect(canonicalizeQuantity(10, '磅')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace apps/server -- test/domain/units.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/server/src/domain/units.ts
// 数量单位注册表(L1): 通用履约物化层的量纲与换算唯一归宿(spec 2026-08-27 §3)。
// 纯数据 + 纯函数; 新增单位 = 注册表加一行, 机制不变。未知单位宁可 null 不猜。

export type QuantityDimension = 'mass' | 'count';

/** mass: canonical=千克, factorToKg 为换算系数; count: 各单位自成聚合池, factor 恒 1。 */
export interface UnitDef {
  readonly dimension: QuantityDimension;
  readonly factorToKg: number;
}

export const UNIT_REGISTRY: Readonly<Record<string, UnitDef>> = {
  吨: { dimension: 'mass', factorToKg: 1000 },
  千克: { dimension: 'mass', factorToKg: 1 },
  公斤: { dimension: 'mass', factorToKg: 1 },
  克: { dimension: 'mass', factorToKg: 0.001 },
  箱: { dimension: 'count', factorToKg: 1 },
  件: { dimension: 'count', factorToKg: 1 },
  车: { dimension: 'count', factorToKg: 1 },
};

/** 归一化后精确匹配(trim; 不做别名/模糊匹配), 未注册返回 null。 */
export function resolveUnit(name: string): UnitDef | null {
  const key = name.trim();
  return UNIT_REGISTRY[key] ?? null;
}

export interface CanonicalQuantity {
  readonly dimension: QuantityDimension;
  /** mass -> 千克; count -> 原值。 */
  readonly canonical: number;
}

/** 未注册单位返回 null(调用方保留原值, dimension/canonical 落 NULL)。 */
export function canonicalizeQuantity(value: number, unit: string): CanonicalQuantity | null {
  const def = resolveUnit(unit);
  if (!def) return null;
  return {
    dimension: def.dimension,
    canonical: def.dimension === 'mass' ? value * def.factorToKg : value,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace apps/server -- test/domain/units.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/domain/units.ts apps/server/test/domain/units.test.ts
git commit -m "feat(domain): 数量单位注册表(量纲+千克规范换算, 未知单位不猜)"
```

---

### Task 2: tradeSemantics FLOW_ADAPTERS 类型适配表

**Files:**
- Modify: `apps/server/src/domain/tradeSemantics.ts`（文件末尾追加）
- Test: `apps/server/test/domain/flowAdapters.test.ts`（新建）

**Interfaces:**
- Produces: `FlowAdapter { flowFamily; qtyFields; unitFields; dateFields; amountFields; codedDirection? }`; `FLOW_ADAPTERS: Readonly<Record<string, FlowAdapter>>`; `CONTRACT_TYPE_FLOW_DIRECTION: Readonly<Record<'采购'|'销售', Readonly<Record<FlowFamily, 'in'|'out'>>>>`。FlowFamily 本文件已导出（'资金流'|'货物流'|'发票流'）。Task 3/5 消费。

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/test/domain/flowAdapters.test.ts
import { describe, it, expect } from 'vitest';
import { FLOW_ADAPTERS, CONTRACT_TYPE_FLOW_DIRECTION } from '../../src/domain/tradeSemantics.js';

describe('FLOW_ADAPTERS', () => {
  it('覆盖 spec §6 全部字段路径类型', () => {
    for (const t of ['收货单', '发货单', '汽运磅单', '火运大票', '派船通知单', '进项票', '销项票', '发票']) {
      expect(FLOW_ADAPTERS[t], t).toBeDefined();
    }
  });
  it('流族映射', () => {
    expect(FLOW_ADAPTERS['发货单']!.flowFamily).toBe('货物流');
    expect(FLOW_ADAPTERS['进项票']!.flowFamily).toBe('发票流');
    expect(FLOW_ADAPTERS['发票']!.flowFamily).toBe('发票流');
  });
  it('方向编码类型 codedDirection', () => {
    expect(FLOW_ADAPTERS['收货单']!.codedDirection).toBe('in');
    expect(FLOW_ADAPTERS['发货单']!.codedDirection).toBe('out');
    expect(FLOW_ADAPTERS['进项票']!.codedDirection).toBe('in');
    expect(FLOW_ADAPTERS['销项票']!.codedDirection).toBe('out');
    expect(FLOW_ADAPTERS['火运大票']!.codedDirection).toBeUndefined();
  });
  it('发货单日期别名含 dev 实测 发货日期; 磅单数量别名含 合计净重', () => {
    expect(FLOW_ADAPTERS['发货单']!.dateFields).toContain('发货日期');
    expect(FLOW_ADAPTERS['汽运磅单']!.qtyFields.map((f) => f[0])).toContain('合计净重');
  });
});

describe('CONTRACT_TYPE_FLOW_DIRECTION', () => {
  it('采购: 货物收/资金付/发票收; 销售: 反向', () => {
    expect(CONTRACT_TYPE_FLOW_DIRECTION['采购']).toEqual({ 资金流: 'out', 货物流: 'in', 发票流: 'in' });
    expect(CONTRACT_TYPE_FLOW_DIRECTION['销售']).toEqual({ 资金流: 'in', 货物流: 'out', 发票流: 'out' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace apps/server -- test/domain/flowAdapters.test.ts`
Expected: FAIL（导出不存在）

- [ ] **Step 3: Write minimal implementation**（追加到 `tradeSemantics.ts` 末尾）

```ts
// ---------------------------------------------------------------------------
// 通用履约物化层: 类型适配表(spec 2026-08-27 §4)。字段路径文档的流族/字段别名/
// 方向编码唯一归宿; 图片凭证(货转单/付款凭证/化验报告)不在此表, 走 vouchers.extractAnchors。
// 新单据类型接入 = 本表加一行, 机制不变。

/** 单据类型 -> 履约流水适配(数量/日期/金额字段按优先序, 首个命中即用)。 */
export interface FlowAdapter {
  readonly flowFamily: FlowFamily;
  /** [字段名, 单位提示?]。'_吨' 后缀命名即单位(与台账 scoreQty 词表一致)。 */
  readonly qtyFields: ReadonlyArray<readonly [string] | [string, string]>;
  readonly unitFields: readonly string[];
  readonly dateFields: readonly string[];
  readonly amountFields: readonly string[];
  /** 类型自带方向(方向编码类型), 仅主体/合同类型都判不出时的第三级兜底。 */
  readonly codedDirection?: 'in' | 'out';
}

const INVOICE_QTY: FlowAdapter['qtyFields'] = [['数量']];
const INVOICE_DATE: readonly string[] = ['开票日期', '日期'];
const INVOICE_AMOUNT: readonly string[] = ['价税合计', '价税合计小写_元', '合计金额', '金额'];

export const FLOW_ADAPTERS: Readonly<Record<string, FlowAdapter>> = {
  收货单: {
    flowFamily: '货物流',
    qtyFields: [['发运数量'], ['数量_吨', '吨'], ['数量']],
    unitFields: ['单位'],
    dateFields: ['收货日期', '到货日期', '发货日期', '日期'],
    amountFields: ['含税总价'],
    codedDirection: 'in',
  },
  发货单: {
    flowFamily: '货物流',
    qtyFields: [['发运数量'], ['数量_吨', '吨'], ['数量']],
    unitFields: ['单位'],
    dateFields: ['发货日期', '收货日期', '到货日期', '日期'],
    amountFields: ['含税总价'],
    codedDirection: 'out',
  },
  汽运磅单: {
    flowFamily: '货物流',
    qtyFields: [['合计净重'], ['净重'], ['合计毛重'], ['毛重'], ['重量_吨', '吨'], ['数量_吨', '吨'], ['数量']],
    unitFields: ['重量单位', '单位'],
    dateFields: ['称量日期', '发货日期', '日期'],
    amountFields: [],
  },
  火运大票: {
    flowFamily: '货物流',
    qtyFields: [['合计净重'], ['净重'], ['合计毛重'], ['毛重'], ['重量_吨', '吨'], ['数量_吨', '吨'], ['数量']],
    unitFields: ['重量单位', '单位'],
    dateFields: ['称量日期', '发货日期', '日期'],
    amountFields: [],
  },
  派船通知单: {
    flowFamily: '货物流',
    qtyFields: [['数量'], ['数量_吨', '吨'], ['重量_吨', '吨']],
    unitFields: ['单位'],
    dateFields: ['通知日期', '发货日期', '日期'],
    amountFields: [],
  },
  进项票: {
    flowFamily: '发票流',
    qtyFields: INVOICE_QTY,
    unitFields: ['单位'],
    dateFields: INVOICE_DATE,
    amountFields: INVOICE_AMOUNT,
    codedDirection: 'in',
  },
  销项票: {
    flowFamily: '发票流',
    qtyFields: INVOICE_QTY,
    unitFields: ['单位'],
    dateFields: INVOICE_DATE,
    amountFields: INVOICE_AMOUNT,
    codedDirection: 'out',
  },
  发票: {
    flowFamily: '发票流',
    qtyFields: INVOICE_QTY,
    unitFields: ['单位'],
    dateFields: INVOICE_DATE,
    amountFields: INVOICE_AMOUNT,
  },
};

/** 合同类型 -> 六向方向兜底(主体锚点缺席时, spec §5 第 2 级)。 */
export const CONTRACT_TYPE_FLOW_DIRECTION: Readonly<
  Record<'采购' | '销售', Readonly<Record<FlowFamily, 'in' | 'out'>>>
> = {
  采购: { 资金流: 'out', 货物流: 'in', 发票流: 'in' },
  销售: { 资金流: 'in', 货物流: 'out', 发票流: 'out' },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace apps/server -- test/domain/flowAdapters.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/domain/tradeSemantics.ts apps/server/test/domain/flowAdapters.test.ts
git commit -m "feat(domain): FLOW_ADAPTERS 类型适配表 + 合同类型方向兜底词表"
```

---

### Task 3: 锚点派生重构（bindingProposal + vouchers）

**Files:**
- Modify: `apps/server/src/pipeline/schemas/vouchers.ts`（VoucherAnchors 加 quantity 字段）
- Modify: `apps/server/src/pipeline/bindingProposal.ts:300-426`（firstStr/firstNum 保留; buildAnchorsFromFields 保留为通用兜底; buildGoodsDocAnchors 改为适配表委托; 新增 deriveAnchorsFromFields; anchorsForExtraction 分派改表驱动）
- Test: `apps/server/test/pipeline/bindingAnchors.test.ts`（扩展; 先读现有断言, 别名行为迁移处同步更新）

**Interfaces:**
- Consumes: Task 1 `canonicalizeQuantity/QuantityDimension`; Task 2 `FLOW_ADAPTERS`。
- Produces: `VoucherAnchors.quantity?: AnchorQuantity`，其中 `AnchorQuantity { value: number; unit?: string; dimension: QuantityDimension | null; canonical: number | null }`（定义放 `domain/units.ts`）; `deriveAnchorsFromFields(docType: string, fields: Record<string, { value: string | number }>): VoucherAnchors`。quantityTon/quantityUnit 兼容投影规则：
  - dimension='mass' → quantityTon = canonical/1000, quantityUnit='吨'
  - dimension='count' → quantityTon = null（箱/件不得混入吨汇总）, quantityUnit = 原单位
  - dimension=null（无单位字段或单位未注册）→ quantityTon = 原值（现状行为）, quantityUnit = 原单位或 null

- [ ] **Step 1: 先读现有测试** `apps/server/test/pipeline/bindingAnchors.test.ts` 与 `bindingProposal.test.ts` 中涉及 buildGoodsDocAnchors/anchorsForExtraction 的断言（确认 迁移后仍成立或按新表更新）。

- [ ] **Step 2: Write the failing test**（追加到 bindingAnchors.test.ts）

```ts
describe('deriveAnchorsFromFields 适配表驱动', () => {
  const wrap = (m: Record<string, string | number>) =>
    Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { value: v }]));

  it('发货单 dev 实测形状: 发运数量无单位 -> dimension/canonical NULL, quantityTon 留原值', () => {
    const a = deriveAnchorsFromFields('发货单', wrap({ 发运数量: 3357.46, 单位缺失: 'x' }));
    expect(a.quantity).toEqual({ value: 3357.46, dimension: null, canonical: null });
    expect(a.quantityTon).toBe(3357.46);
    expect(a.quantityUnit).toBeUndefined();
  });

  it('磅单: 合计净重 + 重量单位=吨 -> mass/canonical', () => {
    const a = deriveAnchorsFromFields('火运大票', wrap({ 合计净重: 3.2, 重量单位: '吨', 称量日期: '2025-03-01' }));
    expect(a.quantity).toEqual({ value: 3.2, unit: '吨', dimension: 'mass', canonical: 3200 });
    expect(a.quantityTon).toBe(3.2);
    expect(a.quantityUnit).toBe('吨');
    expect(a.date).toBe('2025-03-01');
  });

  it('贵金属: 数量_吨 命名即单位优先于别名顺序', () => {
    const a = deriveAnchorsFromFields('收货单', wrap({ 数量_吨: 0.5 }));
    expect(a.quantity).toEqual({ value: 0.5, unit: '吨', dimension: 'mass', canonical: 500 });
    expect(a.quantityTon).toBe(0.5);
  });

  it('计数单位(箱): quantityTon 为 null 不混入吨汇总', () => {
    const a = deriveAnchorsFromFields('发货单', wrap({ 发运数量: 120, 单位: '箱' }));
    expect(a.quantity).toEqual({ value: 120, unit: '箱', dimension: 'count', canonical: 120 });
    expect(a.quantityTon).toBeNull();
    expect(a.quantityUnit).toBe('箱');
  });

  it('未注册单位(磅): 原值照存 dimension NULL', () => {
    const a = deriveAnchorsFromFields('发货单', wrap({ 发运数量: 10, 单位: '磅' }));
    expect(a.quantity).toEqual({ value: 10, unit: '磅', dimension: null, canonical: null });
    expect(a.quantityTon).toBe(10);
  });

  it('未知类型走通用兜底(合同号/主体别名行为不变)', () => {
    const a = deriveAnchorsFromFields('其他', wrap({ 合同号: 'HT-1', 买方: '甲', 卖方: '乙' }));
    expect(a.contractNo).toBe('HT-1');
    expect(a.buyer).toBe('甲');
    expect(a.seller).toBe('乙');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test --workspace apps/server -- test/pipeline/bindingAnchors.test.ts`
Expected: FAIL（deriveAnchorsFromFields 未导出）

- [ ] **Step 4: Implement**

`domain/units.ts` 追加:

```ts
/** 锚点数量投影(物化层统一形状): 原值+原始单位+量纲+规范值。 */
export interface AnchorQuantity {
  readonly value: number;
  readonly unit?: string;
  readonly dimension: QuantityDimension | null;
  readonly canonical: number | null;
}
```

`schemas/vouchers.ts` VoucherAnchors 追加（type-only import domain/units）:

```ts
import type { AnchorQuantity } from '../../domain/units.js';
export interface VoucherAnchors {
  // ...现有字段不动...
  /** 通用物化层数量投影(spec 2026-08-27 §8)。quantityTon/quantityUnit 由它投影兼容。 */
  quantity?: AnchorQuantity;
}
```

`bindingProposal.ts`：

1. import `{ FLOW_ADAPTERS } from '../domain/tradeSemantics.js'`; `{ canonicalizeQuantity, type AnchorQuantity } from '../domain/units.js'`。
2. `buildAnchorsFromFields` 原样保留（通用兜底），但数量段收敛为: 命中 数量/重量_吨/交货总量_吨 后填 `quantityTon/quantityUnit`（现行为）**并** 填 `quantity`（同一算法: unitHint/`_吨`/单位字段 → canonicalizeQuantity）。
3. `buildGoodsDocAnchors` 改为薄委托: `return deriveAnchorsFromFields(docType, fields);`（保留导出, 旧调用/测试不破）。
4. 新增:

```ts
/**
 * 适配表驱动的字段锚点派生(spec 2026-08-27 §8): FLOW_ADAPTERS 命中走表
 * (数量/日期/金额别名 + 单位注册表 canonicalize), 未命中走通用兜底
 * (buildAnchorsFromFields, 行为不变)。图片凭证不走这里(extractAnchors 专用)。
 */
export function deriveAnchorsFromFields(
  docType: string,
  fields: Record<string, { value: string | number }>,
): VoucherAnchors {
  const adapter = FLOW_ADAPTERS[docType];
  if (!adapter) return buildAnchorsFromFields(docType, fields);
  const anchors = buildAnchorsFromFields(docType, fields);
  // 日期/金额: 表别名优先(覆盖兜底), 按优先序首个非空命中。
  const date = firstStr(fields, adapter.dateFields);
  if (date) anchors.date = date;
  const amount = firstNum(fields, adapter.amountFields);
  if (amount !== undefined) anchors.amount = amount;
  // 日期兜底: 表未命中时保留兜底结果的 date。
  // 数量: 表别名优先序首个数值命中; 单位 = 提示 > '_吨'后缀 > unitFields。
  const qty = deriveAnchorQuantity(adapter, fields);
  if (qty) {
    anchors.quantity = qty;
    const projected = projectLegacyQuantity(qty);
    anchors.quantityTon = projected.quantityTon;
    anchors.quantityUnit = projected.quantityUnit;
  }
  return anchors;
}

function deriveAnchorQuantity(
  adapter: FlowAdapter,
  fields: Record<string, { value: string | number }>,
): AnchorQuantity | undefined {
  for (const [name, unitHint] of adapter.qtyFields) {
    const value = firstNum(fields, [name]);
    if (value === undefined) continue;
    const unit =
      unitHint ??
      (name.endsWith('_吨') ? '吨' : undefined) ??
      firstStr(fields, [...adapter.unitFields]);
    const canon = unit ? canonicalizeQuantity(value, unit) : null;
    return {
      value,
      ...(unit ? { unit } : {}),
      dimension: canon?.dimension ?? null,
      canonical: canon?.canonical ?? null,
    };
  }
  return undefined;
}

/** quantityTon/quantityUnit 兼容投影: mass->canonical/1000 吨; count->null 不混吨; 其余->原值。 */
function projectLegacyQuantity(q: AnchorQuantity): { quantityTon: number | null; quantityUnit?: string } {
  if (q.dimension === 'mass' && q.canonical !== null) {
    return { quantityTon: q.canonical / 1000, quantityUnit: '吨' };
  }
  if (q.dimension === 'count') return { quantityTon: null, ...(q.unit ? { quantityUnit: q.unit } : {}) };
  return { quantityTon: q.value, ...(q.unit ? { quantityUnit: q.unit } : {}) };
}
```

5. `anchorsForExtraction` 改为:

```ts
export function anchorsForExtraction(docType, fields): VoucherAnchors {
  if (docType === '发票' || FLOW_ADAPTERS[docType]) return deriveAnchorsFromFields(docType, fields);
  if (GOODS_FIELD_DOCS.has(docType)) return buildGoodsDocAnchors(docType, fields);
  return extractAnchors(docType as VoucherType, /* 现有转换 */);
}
```

- [ ] **Step 5: Run anchor-related tests**

Run: `npm test --workspace apps/server -- test/pipeline/bindingAnchors.test.ts test/pipeline/bindingProposal.test.ts test/pipeline/selfPartyCandidates.test.ts`
Expected: PASS（老断言如按表行为更新, 更新处逐条说明）

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/pipeline/bindingProposal.ts apps/server/src/pipeline/schemas/vouchers.ts apps/server/src/domain/units.ts apps/server/test/pipeline/bindingAnchors.test.ts
git commit -m "feat(pipeline): 锚点派生改适配表驱动, VoucherAnchors.quantity 数量投影(量纲+规范值)"
```

---

### Task 4: execution_flows 三新列（双端 DDL + 仓储读写）

**Files:**
- Modify: `apps/server/src/pipeline/db/client.ts`（SQLite CREATE TABLE execution_flows 列定义 ~L245-262 加 3 列; guarded ALTER 段 ~L504-511 后新增 execution_flows 补列块; PG DDL execution_flows ~L677 加 3 列 + `ADD COLUMN IF NOT EXISTS` 段）
- Modify: `apps/server/src/pipeline/db/postgres-schema.ts:260-284`（executionFlows 表加 3 列）
- Modify: `apps/server/src/pipeline/db/repositories.ts`（ExecutionFlowInput/Row/Summary; upsertExecutionFlow INSERT/ON CONFLICT; executionFlowRowFromSqlite; listExecutionFlows SELECT）
- Modify: `apps/server/src/pipeline/db/postgres-repositories.ts`（upsertExecutionFlowPg ~L1816; listExecutionFlowsPg ~L1932; summarizeExecutionFlowsPg ~L1951; 行映射 ~L1800）
- Test: `apps/server/test/pipeline/executionFlowRepo.test.ts`（扩展 roundtrip）

**Interfaces:**
- Produces: `ExecutionFlowInput` 新增 `quantityValue?: number | null; quantityDimension?: 'mass' | 'count' | null; quantityCanonical?: number | null`（raw unit 复用现有 `unit` 列）; `ExecutionFlowSummary` 新增 `totalMassKg: number | null`; 新仓储函数 `listAllConfirmedBindings(ctx): Promise<Array<{ id; documentId; contractNo; confidence; userId: string | null }>>`（Task 9 回填用, SQLite+PG 双实现）。Task 5 写入方、Task 7 聚合方消费。

- [ ] **Step 1: Write the failing test**（追加到 executionFlowRepo.test.ts; 先读该文件现有的 upsert/list 辅助函数复用）

```ts
describe('execution_flows 数量量纲列', () => {
  it('upsert 写入 quantity_value/dimension/canonical 并回读', async () => {
    await upsertExecutionFlow(ctx, {
      bindingId: 'BD-Q1', documentId: 'DOC-Q1', contractNo: 'HT-Q1',
      flowType: '货物流', direction: 'in', amount: null,
      quantityTon: null, unit: '箱',
      quantityValue: 120, quantityDimension: 'count', quantityCanonical: 120,
      docType: '发货单', voucherDate: '2025-03-21', confidence: 1, createdBy: 't',
    });
    const flows = await listExecutionFlows(ctx, 'HT-Q1');
    expect(flows[0]!.quantityValue).toBe(120);
    expect(flows[0]!.quantityDimension).toBe('count');
    expect(flows[0]!.quantityCanonical).toBe(120);
    const sums = await summarizeExecutionFlows(ctx, 'HT-Q1');
    expect(sums[0]!.totalMassKg).toBeNull();
  });

  it('mass 行 summary.totalMassKg 求和(千克)', async () => {
    await upsertExecutionFlow(ctx, {
      bindingId: 'BD-Q2', documentId: 'DOC-Q2', contractNo: 'HT-Q2',
      flowType: '货物流', direction: 'in', amount: null, quantityTon: 1, unit: '吨',
      quantityValue: 1, quantityDimension: 'mass', quantityCanonical: 1000,
      docType: '收货单', voucherDate: null, confidence: 1, createdBy: 't',
    });
    await upsertExecutionFlow(ctx, {
      bindingId: 'BD-Q3', documentId: 'DOC-Q3', contractNo: 'HT-Q2',
      flowType: '货物流', direction: 'in', amount: null, quantityTon: 0.5, unit: '吨',
      quantityValue: 500, quantityDimension: 'mass', quantityCanonical: 500,
      docType: '收货单', voucherDate: null, confidence: 1, createdBy: 't',
    });
    const sums = await summarizeExecutionFlows(ctx, 'HT-Q2');
    expect(sums[0]!.totalMassKg).toBe(1500);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace apps/server -- test/pipeline/executionFlowRepo.test.ts`
Expected: FAIL（列不存在/类型缺字段）

- [ ] **Step 3: Implement**

client.ts SQLite `CREATE TABLE execution_flows` 在 `unit TEXT,` 后加:

```sql
      quantity_value REAL,
      quantity_dimension TEXT,
      quantity_canonical REAL,
```

client.ts SQLite guarded ALTER 段（contract_ledger 块后追加）:

```ts
  // 通用履约物化层(spec 2026-08-27 §2): execution_flows 数量量纲三列, 存量库补列。
  {
    const have = new Set(
      (sqlite.prepare('PRAGMA table_info(execution_flows)').all() as Array<{ name: string }>).map((c) => c.name),
    );
    for (const col of ['quantity_value', 'quantity_dimension', 'quantity_canonical']) {
      if (!have.has(col)) {
        try { sqlite.exec(`ALTER TABLE execution_flows ADD COLUMN ${col} REAL`); } catch { /* concurrent */ }
      }
    }
  }
```

（PG 端同一概念用 TEXT 列: quantity_dimension 为 TEXT。）client.ts PG DDL execution_flows 同位置加 3 列（`quantity_value double precision, quantity_dimension text, quantity_canonical double precision`），并在 PG 迁移段加:

```ts
  await pool.query(`ALTER TABLE execution_flows ADD COLUMN IF NOT EXISTS quantity_value DOUBLE PRECISION`);
  await pool.query(`ALTER TABLE execution_flows ADD COLUMN IF NOT EXISTS quantity_dimension TEXT`);
  await pool.query(`ALTER TABLE execution_flows ADD COLUMN IF NOT EXISTS quantity_canonical DOUBLE PRECISION`);
```

（放在既有 PG 启动迁移函数内、与其他 ADD COLUMN IF NOT EXISTS 同段。）

postgres-schema.ts executionFlows:

```ts
    quantityValue: doublePrecision('quantity_value'),
    quantityDimension: text('quantity_dimension'),
    quantityCanonical: doublePrecision('quantity_canonical'),
```

repositories.ts: `ExecutionFlowInput` 加三可选字段; upsert INSERT 列与 VALUES 加 3 列, ON CONFLICT SET 加 3 行; executionFlowRowFromSqlite 类型与映射加 3 字段; listExecutionFlows 两条 SELECT 加列。Summary 接口加 `totalMassKg: number | null`, summarize SELECT 加:

```sql
SUM(CASE WHEN quantity_dimension = 'mass' THEN quantity_canonical END) AS total_mass_kg
```

映射: `totalMassKg: r.total_mass_kg == null ? null : Number(r.total_mass_kg)`。

postgres-repositories.ts: upsertExecutionFlowPg INSERT/EXCLUDED 同步加 3 列; listExecutionFlowsPg SELECT 加列; summarizeExecutionFlowsPg 同加 CASE SUM; 行映射同 SQLite。

新增 listAllConfirmedBindings（SQLite + PG, 3-way user 过滤参照 listConfirmedBindingsForDocument 的 legacy OR 写法, 但不带 userId 参数）:

```ts
/** 回填用: 全部 confirmed 绑定(跨用户)。按 user_id, document_id 分组由调用方做。 */
export async function listAllConfirmedBindings(ctx: DbContext) {
  if (ctx.backend === 'postgres') return listAllConfirmedBindingsPg(ctx);
  return ctx.db.select({
    id: bindings.id, documentId: bindings.documentId, contractNo: bindings.contractNo,
    confidence: bindings.confidence, userId: bindings.userId,
  }).from(bindings).where(eq(bindings.status, 'confirmed')).all();
}
```

（PG 版用 drizzle pg 表同形; 或 pool.query 原生 SQL, 与该文件既有风格一致。）

- [ ] **Step 4: Run repo tests**

Run: `npm test --workspace apps/server -- test/pipeline/executionFlowRepo.test.ts test/pipeline/db/repositories.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/pipeline/db/ apps/server/test/pipeline/executionFlowRepo.test.ts
git commit -m "feat(db): execution_flows 数量量纲三列(双端 DDL+读写) + listAllConfirmedBindings"
```

---

### Task 5: 方向三级判定 + 白名单扩围 + 物化写量纲列（executionFlow.ts）

**Files:**
- Modify: `apps/server/src/pipeline/executionFlow.ts`（FLOW_TYPE_BY_DOC_TYPE → flowTypeFor(); resolveFlowDirection; materialize 写新列; refresh introspection 同源）
- Test: `apps/server/test/pipeline/executionFlow.test.ts`（扩展）

**Interfaces:**
- Consumes: Task 2 `FLOW_ADAPTERS/CONTRACT_TYPE_FLOW_DIRECTION`; Task 3 `anchorsForExtraction`(quantity 投影); Task 4 新列。
- Produces: `flowTypeFor(docType: string): string | undefined`（资金流: 付款凭证; 货物流: 货转单/收货单/发货单/汽运磅单/火运大票/派船通知单; 发票流: 发票/进项票/销项票）; 方向链 主体→合同类型→coded; upsert 输入带 quantityValue/quantityDimension/quantityCanonical。
- 依赖注入注意: 合同类型查找用 `findContractLedgerByNo`（repositories.ts 已有, 若未导出则导出）。测试通过 vi.mock 注入。

- [ ] **Step 1: Write the failing test**（追加到 executionFlow.test.ts; 复用现有 extractionRow/baseInput/mocks 模式, 新增 mock `findContractLedgerByNo`）

```ts
describe('方向三级判定与白名单扩围', () => {
  it('火运大票(无主体锚点): 合同类型采购兜底 -> 货物流/in, quantity 投影 mass', async () => {
    mocks.loadLatestExtractionByDocId.mockResolvedValue(extractionRow('火运大票', {
      合计净重: 3.2, 重量单位: '吨', 称量日期: '2025-03-01',
    }));
    mocks.findContractLedgerByNo.mockResolvedValue({ contractNo: 'CJXC-001', contractType: '采购' });
    const settled = await materializeExecutionFlow(ctx, baseInput, 'u1', ['我方贸易有限公司']);
    expect(settled).toEqual({ flowId: 'EX-1', flowType: '货物流', direction: 'in', amount: null });
    expect(mocks.upsertExecutionFlow.mock.calls[0]![0]).toMatchObject({
      quantityValue: 3.2, quantityDimension: 'mass', quantityCanonical: 3200,
      quantityTon: 3.2, unit: '吨', voucherDate: '2025-03-01',
    });
  });

  it('发货单: 主体命中 buyer -> in(收货), codedDirection(out) 不覆盖主体证据', async () => {
    mocks.loadLatestExtractionByDocId.mockResolvedValue(extractionRow('发货单', {
      买方: '我方贸易有限公司', 卖方: '某物流公司', 发运数量: 100,
    }));
    const settled = await materializeExecutionFlow(ctx, baseInput, 'u1', ['我方贸易有限公司']);
    expect(settled!.direction).toBe('in');
  });

  it('方向编码类型第三级: 名单与合同类型都缺席时 发货单 -> out', async () => {
    mocks.loadLatestExtractionByDocId.mockResolvedValue(extractionRow('发货单', {
      发货人: '某人', 发运数量: 5,
    }));
    mocks.findContractLedgerByNo.mockResolvedValue(null);
    const settled = await materializeExecutionFlow(ctx, baseInput, 'u1', []);
    expect(settled!.direction).toBe('out');
  });

  it('进项票 -> 发票流; 付款单/结算单仍不物化', async () => {
    mocks.loadLatestExtractionByDocId.mockResolvedValue(extractionRow('进项票', {
      购买方名称: '我方贸易有限公司', 金额: 999,
    }));
    const settled = await materializeExecutionFlow(ctx, baseInput, 'u1', ['我方贸易有限公司']);
    expect(settled!.flowType).toBe('发票流');
    expect(settled!.direction).toBe('in');

    mocks.loadLatestExtractionByDocId.mockResolvedValue(extractionRow('付款单', { 金额: 1 }));
    mocks.upsertExecutionFlow.mockClear();
    await materializeExecutionFlow(ctx, baseInput, 'u1', ['我方贸易有限公司']);
    expect(mocks.upsertExecutionFlow).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace apps/server -- test/pipeline/executionFlow.test.ts`
Expected: FAIL（火运大票 null / 无 quantity 列）

- [ ] **Step 3: Implement**（executionFlow.ts）

1. import `{ FLOW_ADAPTERS, CONTRACT_TYPE_FLOW_DIRECTION } from '../domain/tradeSemantics.js'`; `import { findContractLedgerByNo } from './db/repositories.js'`（确认已导出）。
2. 替换 `FLOW_TYPE_BY_DOC_TYPE`:

```ts
/** 图片凭证(封闭 schema, extractAnchors 路径)的流族映射。 */
const IMAGE_VOUCHER_FLOW_TYPE: Record<string, string> = { 付款凭证: '资金流', 货转单: '货物流' };

/** docType -> 流族: 图片凭证映射 + 适配表(flowFamily), 白名单外 undefined 不物化。 */
export function flowTypeFor(docType: string): string | undefined {
  return IMAGE_VOUCHER_FLOW_TYPE[docType] ?? FLOW_ADAPTERS[docType]?.flowFamily;
}
```

3. 方向链:

```ts
/**
 * 方向三级判定(spec 2026-08-27 §5): 主体锚点 -> 合同类型兜底 -> 类型自带方向。
 * 全部判不出返回 null(宁可空缺不猜)。
 */
async function resolveFlowDirection(args: {
  docType: string;
  flowFamily: string;
  anchors: VoucherAnchors;
  contractNo: string;
  userId?: string;
  selfPartyNames: string[];
}): Promise<FlowDirection | null> {
  const side = resolveSelfSide(args.selfPartyNames, args.anchors);
  if (side) {
    if (args.flowFamily === '资金流') return moneyDirectionFor(side);
    if (args.flowFamily === '货物流') return goodsDirectionFor(side);
    return invoiceDirectionFor(side);
  }
  let contractType: string | null | undefined;
  try {
    contractType = (await findContractLedgerByNo(ctxOf(args), args.contractNo, args.userId))?.contractType ?? null;
  } catch { contractType = null; }
  if (contractType === '采购' || contractType === '销售') {
    return CONTRACT_TYPE_FLOW_DIRECTION[contractType][args.flowFamily as FlowFamily] ?? null;
  }
  return FLOW_ADAPTERS[args.docType]?.codedDirection ?? null;
}
```

（`ctxOf` 即 materialize 的 ctx 参数——实现时把 ctx 传入该函数, 不引全局。）
4. `materializeExecutionFlow`: `const flowType = flowTypeFor(extraction.docType)`; `const direction = await resolveFlowDirection({...})`; upsert 输入追加:

```ts
      quantityValue: anchors.quantity?.value ?? null,
      quantityDimension: anchors.quantity?.dimension ?? null,
      quantityCanonical: anchors.quantity?.canonical ?? null,
```

5. `refreshExecutionFlowsForDocument` introspection: `flowType = flowTypeFor(extraction.docType)`; side 判定后追加合同类型/coded 同源检查——实现为对每 binding 直接调 resolveFlowDirection 的轻量预检（失败 catch 维持原 introspectionOk 语义）, skip reason 维持 'direction-undeterminable'。
6. 头注释同步更新白名单说明（火运大票等接入, 付款单/结算单仍排除）。

- [ ] **Step 4: Run tests**

Run: `npm test --workspace apps/server -- test/pipeline/executionFlow.test.ts test/pipeline/executionFlowTypeCascade.test.ts test/pipeline/selfPartyFlow.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/pipeline/executionFlow.ts apps/server/test/pipeline/executionFlow.test.ts
git commit -m "feat(pipeline): 方向三级判定(主体->合同类型->类型编码) + 运输/进销项票白名单扩围 + 量纲列写入"
```

---

### Task 6: 模板 settles 边规则（3 个运输类型）

**Files:**
- Modify: `apps/server/src/pipeline/templateSeed.ts:71-76`（EDGE_RULE_SEED 追加 3 行）
- Test: `apps/server/test/pipeline/templateSeed.test.ts`（扩展断言）

**Interfaces:**
- Consumes: 无（纯种子数据）。
- Produces: 激活规则 `er-settle-qiyun`（汽运磅单→settles ['收货','发货']）、`er-settle-huoyun`（火运大票）、`er-settle-paichuan`（派船通知单）。

- [ ] **Step 1: Write the failing test**（templateSeed.test.ts 追加）

```ts
it('运输三类型 settles 规则已激活且两向词表', () => {
  for (const id of ['er-settle-qiyun', 'er-settle-huoyun', 'er-settle-paichuan']) {
    const rule = edgeRules.find((r) => r.id === id);
    expect(rule, id).toBeDefined();
    expect(rule!.isActive).toBe(true);
    expect(rule!.allowedVocab).toEqual(['收货', '发货']);
  }
});
```

（`edgeRules` 取该测试现有断言同款数据来源——先读文件复用。）

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace apps/server -- test/pipeline/templateSeed.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**（EDGE_RULE_SEED 的 v2 注释块后追加）

```ts
  // 通用履约物化层(spec 2026-08-27 §7): 运输三类型接入 settles。类型不带方向,
  // relation 由 flowType x direction 派生 -> 两向词表都放行(对齐货转单先例)。
  { id: 'er-settle-qiyun', src: '汽运磅单', edge: 'settles', vocab: ['收货', '发货'] },
  { id: 'er-settle-huoyun', src: '火运大票', edge: 'settles', vocab: ['收货', '发货'] },
  { id: 'er-settle-paichuan', src: '派船通知单', edge: 'settles', vocab: ['收货', '发货'] },
```

- [ ] **Step 4: Run tests**

Run: `npm test --workspace apps/server -- test/pipeline/templateSeed.test.ts test/pipeline/templateGuard.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/pipeline/templateSeed.ts apps/server/test/pipeline/templateSeed.test.ts
git commit -m "feat(template): 汽运磅单/火运大票/派船通知单 settles 边规则登记激活"
```

---

### Task 7: 执行进度纯函数 + query 工具输出

**Files:**
- Create: `apps/server/src/pipeline/executionProgress.ts`
- Modify: `apps/server/src/pipeline/executionFlow.ts`（buildQueryExecutionFlowsTool 挂 executionProgress）
- Test: `apps/server/test/pipeline/executionProgress.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 `canonicalizeQuantity/resolveUnit`; Task 4 `ExecutionFlowRow`。
- Produces:

```ts
export interface ExecutionProgress {
  basis: { quantity: number; unit: string; dimension: 'mass' | 'count'; canonical: number } | null;
  delivered: { massKg: number | null; countPools: Record<string, number> } | null;
  progress: number | null;
  reason?: 'no-contract-basis' | 'dimension-mismatch' | 'unit-pool-missing';
}
export function computeExecutionProgress(
  flows: Array<Pick<ExecutionFlowRow, 'quantityDimension' | 'quantityCanonical' | 'quantityValue' | 'unit'>>,
  ledgerFields: Record<string, { value: string | number }> | null | undefined,
): ExecutionProgress
```

query 工具响应追加 `executionProgress`（findContractLedgerByNo 取 fields, try/catch 降级 null）。

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { computeExecutionProgress } from '../../src/pipeline/executionProgress.js';

const mass = (canonical: number) => ({ quantityDimension: 'mass', quantityCanonical: canonical, quantityValue: canonical, unit: '吨' });
const count = (unit: string, value: number) => ({ quantityDimension: 'count', quantityCanonical: value, quantityValue: value, unit });
const wrap = (m: Record<string, unknown>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { value: v }]));

describe('computeExecutionProgress', () => {
  it('mass 对齐: 台账 3吨, 已发 1+0.5吨 -> 0.5', () => {
    const r = computeExecutionProgress([mass(1000), mass(500)], wrap({ 数量: 3, 单位: '吨' }));
    expect(r.basis).toEqual({ quantity: 3, unit: '吨', dimension: 'mass', canonical: 3000 });
    expect(r.delivered!.massKg).toBe(1500);
    expect(r.progress).toBeCloseTo(0.5);
  });

  it('量纲不一致: 台账吨 vs 流水箱 -> progress null + dimension-mismatch', () => {
    const r = computeExecutionProgress([count('箱', 120)], wrap({ 数量: 3, 单位: '吨' }));
    expect(r.progress).toBeNull();
    expect(r.reason).toBe('dimension-mismatch');
  });

  it('count 池对齐: 台账箱 对 箱池', () => {
    const r = computeExecutionProgress([count('箱', 30), count('箱', 20)], wrap({ 数量: 100, 单位: '箱' }));
    expect(r.progress).toBeCloseTo(0.5);
  });

  it('count 池缺失(台账件 vs 流水箱) -> progress null + unit-pool-missing', () => {
    const r = computeExecutionProgress([count('箱', 30)], wrap({ 数量: 100, 单位: '件' }));
    expect(r.progress).toBeNull();
    expect(r.reason).toBe('unit-pool-missing');
  });

  it('无台账基准 -> no-contract-basis', () => {
    const r = computeExecutionProgress([mass(1000)], null);
    expect(r.basis).toBeNull();
    expect(r.reason).toBe('no-contract-basis');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace apps/server -- test/pipeline/executionProgress.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: Implement** `executionProgress.ts`

```ts
// 合同执行进度(spec 2026-08-27 §9): 流水行 + 台账字段 -> 进度块。纯函数零 IO。
// 数字零幻觉: 换算只在单位注册表可查时进行; 量纲/池不一致如实报 reason, 不硬算。

import { canonicalizeQuantity, type QuantityDimension } from '../domain/units.js';
import type { ExecutionFlowRow } from './db/repositories.js';

export interface ExecutionProgress {
  basis: { quantity: number; unit: string; dimension: QuantityDimension; canonical: number } | null;
  delivered: { massKg: number | null; countPools: Record<string, number> } | null;
  progress: number | null;
  reason?: 'no-contract-basis' | 'dimension-mismatch' | 'unit-pool-missing';
}

type FlowQty = Pick<ExecutionFlowRow, 'quantityDimension' | 'quantityCanonical' | 'quantityValue' | 'unit'>;
type LedgerFields = Record<string, { value: string | number }> | null | undefined;

export function computeExecutionProgress(flows: FlowQty[], ledgerFields: LedgerFields): ExecutionProgress {
  const massKg = flows.reduce((s, f) => s + (f.quantityDimension === 'mass' && f.quantityCanonical != null ? f.quantityCanonical : 0), 0);
  const countPools: Record<string, number> = {};
  for (const f of flows) {
    if (f.quantityDimension === 'count' && f.unit) {
      countPools[f.unit] = (countPools[f.unit] ?? 0) + (f.quantityValue ?? 0);
    }
  }
  const delivered = { massKg: flows.some((f) => f.quantityDimension === 'mass') ? massKg : null, countPools };

  const rawQty = ledgerFields?.['数量']?.value;
  const rawUnit = ledgerFields?.['单位']?.value;
  if (rawQty === undefined || rawUnit === undefined) {
    return { basis: null, delivered, progress: null, reason: 'no-contract-basis' };
  }
  const qty = Number(String(rawQty).replace(/[,\s]/g, ''));
  const canon = Number.isFinite(qty) ? canonicalizeQuantity(qty, String(rawUnit)) : null;
  if (!canon) return { basis: null, delivered, progress: null, reason: 'no-contract-basis' };

  const basis = { quantity: qty, unit: String(rawUnit), dimension: canon.dimension, canonical: canon.canonical };
  if (canon.dimension === 'mass') {
    if (delivered.massKg === null) return { basis, delivered, progress: null, reason: 'dimension-mismatch' };
    return { basis, delivered, progress: basis.canonical > 0 ? delivered.massKg / basis.canonical : null };
  }
  const pool = countPools[basis.unit];
  if (pool === undefined) return { basis, delivered, progress: null, reason: 'unit-pool-missing' };
  return { basis, delivered, progress: basis.canonical > 0 ? pool / basis.canonical : null };
}
```

`buildQueryExecutionFlowsTool.execute` 返回对象追加（import findContractLedgerByNo, try/catch）:

```ts
      let ledgerFields: Record<string, { value: string | number }> | null = null;
      try { ledgerFields = (await findContractLedgerByNo(deps.ctx, contractNo, deps.userId))?.fields ?? null; } catch { /* 降级 */ }
      return { contractNo, summaries, flows: ..., executionProgress: computeExecutionProgress(flowRows, ledgerFields) };
```

- [ ] **Step 4: Run tests**

Run: `npm test --workspace apps/server -- test/pipeline/executionProgress.test.ts test/pipeline/executionFlow.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/pipeline/executionProgress.ts apps/server/src/pipeline/executionFlow.ts apps/server/test/pipeline/executionProgress.test.ts
git commit -m "feat(pipeline): 合同执行进度纯函数(量纲对齐/mismatch 如实报) + query 工具挂载"
```

---

### Task 9: 历史回填脚本

**Files:**
- Create: `apps/server/scripts/backfillFlows.ts`
- Modify: `apps/server/package.json`（scripts 加 `"backfill:flows": "tsx scripts/backfillFlows.ts"`）

**Interfaces:**
- Consumes: Task 4 `listAllConfirmedBindings`; 既有 `refreshExecutionFlowsForDocument(ctx, documentId, userId?)`。
- Bootstrap 方式: 先读 `apps/server/scripts/reprocessContracts.ts` 头部, 逐行复用其 env/db 初始化（同一套环境变量与 DbContext 构造），不新造引导逻辑。

- [ ] **Step 1: Implement**（骨架; bootstrap 段以 reprocessContracts.ts 实际代码为准替换 TODO 注释处）

```ts
// 历史流水回填(spec 2026-08-27 §10): 全部 confirmed 绑定重跑 refresh(先撤后物化, 幂等)。
// 用途: 物化层上线后补齐上线前确认绑定遗漏的流水。失败仅告警不中断。
import { listAllConfirmedBindings } from '../src/pipeline/db/repositories.js';
import { refreshExecutionFlowsForDocument } from '../src/pipeline/executionFlow.js';

async function main() {
  // [bootstrap: 与 scripts/reprocessContracts.ts 同款 env + DbContext 构造]
  const ctx = /* 同 reprocessContracts */;
  const bindings = await listAllConfirmedBindings(ctx);
  const groups = new Map<string, typeof bindings>();
  for (const b of bindings) {
    const key = `${b.userId ?? ''}|${b.documentId}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(b);
  }
  let materialized = 0, skipped = 0;
  for (const [, rows] of groups) {
    try {
      const res = await refreshExecutionFlowsForDocument(ctx, rows[0]!.documentId, rows[0]!.userId ?? undefined);
      materialized += res.materialized;
      skipped += res.skipped.length;
      console.log(`[backfill:flows] ${rows[0]!.documentId} user=${rows[0]!.userId ?? ''} retracted=${res.retracted} materialized=${res.materialized} skipped=${res.skipped.length}`);
    } catch (e) {
      console.warn(`[backfill:flows] ${rows[0]!.documentId} 失败(跳过):`, (e as Error).message);
    }
  }
  console.log(`[backfill:flows] 完成: 文档组=${groups.size} materialized=${materialized} skipped=${skipped}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Verify build passes**（脚本走 tsconfig.scripts.json, build 覆盖）

Run: `npm run build --workspace apps/server`
Expected: 无类型错误

- [ ] **Step 3: Commit**

```bash
git add apps/server/scripts/backfillFlows.ts apps/server/package.json
git commit -m "feat(scripts): backfill:flows 历史流水回填脚本(全量 confirmed 绑定重物化)"
```

---

### Task 10: 全量验证

- [ ] **Step 1:** `npm run build` — 两个 workspace 全过
- [ ] **Step 2:** `npm run lint` — 0 error
- [ ] **Step 3:** `npm test` — 全绿（含既有 postgres 集成测试按 env 跳过）
- [ ] **Step 4:** 按 AGENTS.md 工作流约定: push 分支 + merge 到 main（触发 CI/CD）
- [ ] **Step 5:** dev 部署后执行 `npm run backfill:flows --workspace apps/server`（10.10.0.2, 带 nvm PATH），验证:
  - DOC-mtb032yu-8pj7（发货单）→ execution_flows 出现 货物流/in（主体: 买方=湖北国贸命中）, quantity_value=3357.46
  - DOC-mtb4vyd3-55xz（运输凭证/铁路）→ 货物流/in（合同类型采购兜底）, quantity 取 合计净重+重量单位
  - `query_execution_flows`（问 Agent "GMNH-JBKZ-20250303HNWH 发了多少货"）返回非空汇总与进度块

## Self-Review 记录

- Spec §2 双端列 ✓ Task 4; §3 ✓ Task 1; §4 ✓ Task 2; §5/§6 ✓ Task 5; §7 ✓ Task 6; §8 ✓ Task 3; §9 ✓ Task 7; §10 ✓ Task 9; §11 验收 ✓ Task 10。
- 类型一致性: AnchorQuantity 在 units.ts 定义, vouchers/bindingProposal/executionFlow 引用同名; FlowFamily 复用 tradeSemantics 既有导出; listAllConfirmedBindings 返回形状与 Task 9 消费一致。
- 无占位符: bootstrap 段显式指向 reprocessContracts.ts 复用（任务内含读取步骤, 非省略）。
