# 本体基座 ontology-foundation 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把《本体建模技术备忘》§3 的领域模型（11 实体 / 8 关系类型 14 连接对 / 4 枚举 / 双时间轴）落成代码级 SSOT（zod 注册表），并为其提供双后端数据表（ontology_edges / trade_facts）、as-of 查询 helper、工具词汇 CI 门禁。

**Architecture:** 单文件纯 zod 注册表（`apps/server/src/ontology/index.ts`，只 import zod，前端可消费）+ 两张双后端镜像表（SQLite raw DDL 进 `client.ts migrate()`；Postgres raw DDL 进 `client.ts migratePostgres()` + drizzle twin 进 `postgres-schema.ts`）+ 自包含仓储模块 `ontology/repo.ts`（双后端 dispatch，仿 repositories.ts 风格）+ `toolOntologyMap` 词汇门禁挂进现有 CI 门禁测试。

**Tech Stack:** TypeScript 严格模式 / zod ^3.25.76（v3 classic API）/ better-sqlite3 / node-postgres / drizzle-orm（仅 PG schema 声明）/ vitest。

**Spec:** `docs/superpowers/specs/2026-09-07-frontend-p0-p2-roadmap.md` Item 2 节（P0 · 关键路径）。领域模型 SSOT：`本体建模技术备忘.md`（工作区根，未跟踪文件）§3/§4，其上游为《贸易企业全链路数据本体建设落地方案（精准关系语义校准终版）.docx》（本计划已按其抽取件核对实体/关系/枚举定稿）。

---

## Global Constraints

（来自路线图「计划编写约定」#4，逐字适用；每个任务的需求隐含本节）

- 验证顺序 `npm run build && npm run lint && npm test`（仓库根执行）
- 代码零 emoji；TS 严格模式过 tsc
- 双后端列对列镜像；SQLite 幂等迁移（`PRAGMA table_info` 守卫）/ Postgres `ADD COLUMN IF NOT EXISTS` / `CREATE TABLE IF NOT EXISTS`
- 新增工具必须先登记 `docs/tool-inventory.json` 再上注册表——**本项不新增任何工具**（只对 3 个既有 L2 工具做本体映射），不触碰 tool-inventory.json
- AI SDK 6 陷阱以 AGENTS.md「AI SDK 6」节为准（本项只读工具 `inputSchema`，不写工具；读法见 Task 4，`inputSchema` 是 zod schema，`.shape` / `safeParse` 均可用，先例 `apps/server/test/graph/tools.test.ts:13-40`）
- 认证 `requireAuth`——**本项不新增 HTTP 路由**（`GET /api/ontology/schema` 等 API 属 Item 3），无需动 routes
- 分支惯例：feature 分支开发（当前分支 `PengYip/架构设计` 即是），验证绿后 merge 回 main 并 push（触发 CI+CD 到 10.10.0.2）
- 当前 DB 拓扑（AGENTS.md 2026-09-07 更新）：**Postgres 是部署运行时，SQLite 弃用于部署但仍为测试/本地零配置默认**——双后端镜像约定不变，单测全部跑内存 SQLite，PG 结构断言进 `test/pipeline/postgres.integration.test.ts`（无 `DB_BACKEND=postgres` 时 skip，不破坏 SQLite CI 车道）

## 摸底结论（2026-09-07，写计划前定向 recon）

- **本分支落后 origin/main 15 个提交，0 领先**。Item 1（审批中心）已落地 main（approval routes/审计列/web view，commits 2f85880..061e7ef）。diff 确认 Item 2 要改的核心路径（`pipeline/db/*`、`toolInventory.test.ts`、`tool-inventory.json`、`graph/tools.ts`）在 HEAD 与 origin/main 之间**无差异**（仅 `tools/hitl.ts` 与新增 approval 测试不同），本计划贴出的代码即实施基线。**开工第一步必须先 merge origin/main**（见前置检查）。
- 3 个待映射 L2 工具定义位置与 inputSchema（全部 `tool()` from `'ai'`，z.object inputSchema）：
  - `create_entity`：`apps/server/src/graph/tools.ts:5-25`，字段 `kind / name / props?`
  - `link_entities`：`apps/server/src/graph/tools.ts:27-52`，字段 `srcId / dstId / kind / props? / confidence? / sourceSpan?`
  - `bind_document`：`apps/server/src/pipeline/tools/documentEntry.ts:2523-2588`，字段 `documentId / contractNo / relation / confidence / sourceSpan{blockId,start,end}`
  - 挂载点：`apps/server/src/harness/roleToolRegistry.ts:127-135`（`{ ...buildXxxTool(), name: 'xxx', needsApproval: true }`）
- CI 门禁测试：`apps/server/test/harness/toolInventory.test.ts`（147 行，bijection/blacklist/metadata/gating/scenario 五类断言；`createDb(':memory:') + migrate(ctx.sqlite) + getToolsForRole('trader', { ctx })` 取工具的先例在 115-117 行）
- 建表范式（以 `graph_links` 为样板）：
  - SQLite：`client.ts:44 migrate(sqlite)` 内一个大 `sqlite.exec` 模板，`CREATE TABLE IF NOT EXISTS` + 注释块；守卫 ALTER 用 `PRAGMA table_info`（`client.ts:460-527`）
  - Postgres：`client.ts:689 migratePostgres(pool)` 的 `statements` 数组，`CREATE TABLE IF NOT EXISTS`，timestamptz/jsonb 惯例
  - drizzle twin：`postgres-schema.ts:332-357 graphLinks`（`text/numeric/nowTs()/uniqueIndex/index`，props 用 TEXT 存 JSON 惯例；本表 params/payload 用 jsonb，先例 `documents ADD COLUMN graph_status jsonb`）
- 仓储范式：`repositories.ts:4179 saveGraphLink`（`if (ctx.backend === 'postgres') return xxxPg(ctx, ...)` 双 dispatch；行映射 fn + `GRAPH_LINK_COLS` 常量；`export function effectiveUserId` 在 `repositories.ts:174`）。`rid` 是 `repositories.ts:470` 的**模块私有** helper（`const rid = (p) => \`${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,6)}\``），新模块自带同款。
- 测试范式：`createDb(':memory:'); migrate(ctx.sqlite)` per-test（`test/pipeline/db/repositories.test.ts:1-22`）；vitest 配置 `apps/server/vitest.config.ts`，include `test/**/*.test.ts`（新目录 `test/ontology/` 自动被收）
- 前端消费现状：apps/web 与 apps/server 零跨包 import（web 不依赖 `@sca/server`，server 无 exports 字段）。因此「注册表可被前端消费」落地为：**注册表单文件只 import zod、无 node 内建、可 JSON 序列化导出**；Item 3 再经 `GET /api/ontology/schema` 消费。

## 设计决策（spec 要求写明理由的部分）

1. **trade_facts 用通用表 + entity_type 判别（spec 倾向方案，采纳）**，不按实体分表。理由：(a) 7 类事件 payload 差异大且会随抽取管线演化，分表要么稀疏列要么频繁加列；(b) 真正的字段防线是写入边界的 zod 校验（`entitySchema(type).parse(payload)`），表结构只需保证判别键 + 三时间列；(c) 与领域铁律「不拆分同语义实体」一致；(d) Item 3 投影按 entity_type 过滤即可；未来某类事件查询模式固化后可无痛垂直拆表——as-of helper 与调用方不受影响。
2. **关系口径：8 类型 / 14 连接对**。roadmap 写「9 关系」，docx §5 定稿实际是 4 核心类型（ALLOCATE_TO 3 对 / OFFSET_SETTLE 2 对 / WRITE_OFF 2 对 / REVERSE_ORIGIN 1 对）+ 4 辅助类型（FEEDS_INTO 2 对 / CORRESPONDS_TO 2 对 / TRIGGERS 1 对 / PROVIDE 1 对）= 8 类型 14 对；「9」按「4 核心 + 5 辅助连接语义」口径数（CORRESPONDS_TO 的两对语义各算一条）。注册表以**类型**为键、`pairs` 数组承载全部 14 对，语义零遗漏。
3. **CommodityCode v1 开放词汇**。备忘 §7 明示 TradeGoods 分层待业务确认；强造闭枚举有编造风险。v1 `commodityCode: z.string().min(1)` + 注册表导出 `COMMODITY_CODES` 词汇表常量（起步为空数组），业务确认后转闭枚举只改注册表单文件（符合验收 1 精神）。PayType/EventBizType/AllocateMethod 三枚举在 docx §6 有闭集定义，直接落 z.enum。
4. **meaning URI 只建机制不挂条目**。roadmap OUT 边界明确「meaning 只挂已确认的 OEO/FIBO 条目」；v1 导出 `MEANING_URIS` 空映射 + URI 格式校验（测试断言所有已挂值匹配 URI 模式），词汇精选属后续任务（备忘落地路线第 4 步）。
5. **实体词汇与语义规则分层**。`ONTOLOGY_ENTITIES` 存纯 `z.object`（保证 `.shape` 可直接取字段，供 CI 门禁与 Item 3 列生成）；「逆向=负数金额」等语义规则（docx §6.2）放独立 refinement，经 `entitySchema(name)` 在**写入边界**叠加。对应 docx 第三层（实体）与第四层（语义规则）的分层。
6. **invalid_at 的写入模式**：v1 只提供 insert + as-of 读，不提供事后 update。红冲场景由调用方在创建逆向事实时一并提交被冲销事实的 invalid_at（幂等、免二次写）；真正的事务性「冲销原单」动作留给 Item 5 的 L2/L3 工具。as-of 系统时间查询只看 ingested_at，与 invalid_at 的写入时点无关，月报复现语义不受影响。
7. **时间列格式**：SQLite 全部 TEXT 存 UTC ISO（`strftime('%Y-%m-%dT%H:%M:%fZ','now')`，projects 表先例），字典序即时间序；仓储写入统一经 `normalizeIsoUtc()` 归一，杜绝 `datetime('now')` 空格格式混入破坏比较。PG 用 timestamptz。
8. **仓储放新模块 `src/ontology/repo.ts`**（双后端实现都在里面），不往 4697 行的 repositories.ts 塞——本体自包含，Item 3/4/5 复用时不牵连 pipeline 仓储。

---

### Task 1: 前置检查 + 本体注册表单文件（纯 zod SSOT）

**Files:**
- Create: `apps/server/src/ontology/index.ts`
- Test: `apps/server/test/ontology/registry.test.ts`

**Interfaces:**
- Consumes: 无（纯新模块）
- Produces（后续任务依赖的精确签名）:
  - `OntologyEntityNameSchema: z.ZodEnum`；`type OntologyEntityName = z.infer<...>`（11 个字面量）
  - `ONTOLOGY_ENTITIES: Record<OntologyEntityName, z.ZodObject<any>>`（纯 object，无 effects）
  - `entitySchema(name: OntologyEntityName): z.ZodTypeAny`（object + 事件语义 refinement，写入边界用）
  - `entityFieldNames(name: OntologyEntityName): Set<string>`（实体自有字段 ∪ `DUAL_TIMELINE_FIELDS` ∪ `PROVENANCE_FIELDS`）
  - `ONTOLOGY_RELATIONS: ReadonlyArray<OntologyRelationDef>`；`relationDef(name: string): OntologyRelationDef`（未知名 throw）；`isRelationPairAllowed(name: string, from: string, to: string): boolean`
  - `DUAL_TIMELINE_FIELDS = ['validAt','invalidAt','ingestedAt'] as const`；`PROVENANCE_FIELDS = ['createdBy','sourceSpan','confidence'] as const`；`SHARED_TOOL_FIELD_NAMES`（Task 4 用）
  - `ontologySchemaJson(): unknown`（可 JSON 序列化的注册表投影，Item 3 的 `/api/ontology/schema` 数据源）
  - `COMMODITY_CODES: readonly string[]`；`MEANING_URIS: Readonly<Record<string, string>>`

- [ ] **Step 0: 前置检查（基线同步 + 冲突探查）**

```bash
# 0.1 同步基线：本分支落后 origin/main 15 提交（Item 1 审批中心已进 main）
git fetch origin main
git merge origin/main
# 预期：无冲突（HEAD 与 main 在本项要改的路径上无 diff）

# 0.2 基线验证绿（约定要求的起点干净）
npm run build && npm run lint && npm test

# 0.3 确认无既有 ontology 模块冲突
rg -n "ontology" apps/server/src --ignore-case
# 预期：0 命中（命中则停下人工研判）

# 0.4 确认 zod 版本与 import 风格
node -e "console.log(require('./apps/server/package.json').dependencies.zod)"
# 预期：^3.25.76；import 风格 `import { z } from 'zod'`（graph/tools.ts:2 先例）
```

- [ ] **Step 1: 写失败测试** `apps/server/test/ontology/registry.test.ts`

```ts
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/ontology/registry.test.ts`
Expected: FAIL（`Cannot find module '../../src/ontology/index.js'`）

- [ ] **Step 3: 写实现** `apps/server/src/ontology/index.ts`

```ts
// 本体注册表 SSOT（roadmap 2026-09-07 Item 2 / 本体建模技术备忘 §3）。
// 单文件、只 import zod：CI 门禁与前端（Item 3 经 /api/ontology/schema）共同消费，
// 新增实体/关系/枚举值只改本文件（验收 1）。领域变更上游 SSOT：
// docs/贸易企业全链路数据本体建设落地方案（精准关系语义校准终版）.docx。
import { z } from 'zod';

// ---------------------------------------------------------------------------
// 枚举（docx §6 闭集）+ 开放词汇
// ---------------------------------------------------------------------------

export const PayType = z.enum(['预付', '尾款', '进度款', '质保金']);
export const EventBizType = z.enum(['正向', '逆向']);
export const AllocateMethod = z.enum(['金额', '数量', '重量', '定额']);

// 商品码：备忘 §7 待业务确认（TradeGoods 分层），v1 开放词汇表；确认后转 z.enum 只改本文件。
export const COMMODITY_CODES: readonly string[] = [];

// meaning URI 映射：只挂已确认的 OEO/FIBO 条目（roadmap OUT：不做全量词汇导入）。
// key = 实体/关系/枚举值名，value = 外部词汇 URI。确认一个挂一个，测试校验 URI 格式。
export const MEANING_URIS: Readonly<Record<string, string>> = {};

// ---------------------------------------------------------------------------
// 实体（docx §3：4 静态 + 7 事件；v1 字段=单据/流水既有词汇最小集）
// ---------------------------------------------------------------------------

export const OntologyEntityNameSchema = z.enum([
  'TradeContract', 'TradeGoods', 'Counterparty', 'OrgUnit',
  'GoodsReceiptEvent', 'GoodsDeliveryEvent', 'SettlementEvent', 'InvoiceEvent',
  'PaymentEvent', 'CollectionEvent', 'ServiceCostEvent',
]);
export type OntologyEntityName = z.infer<typeof OntologyEntityNameSchema>;

const Currency = z.string().min(1).describe('币种代码, 如 CNY/USD');

export const ONTOLOGY_ENTITIES = {
  TradeContract: z.object({
    contractNo: z.string().min(1).describe('合同号(归一主键口径, 与 contract_ledger.contract_no 同源)'),
    title: z.string().optional(),
    contractType: z.string().describe('合同类型(开放: 采购/销售/...; 与 contract_ledger.contract_type 同源)'),
    currency: Currency.optional(),
  }),
  TradeGoods: z.object({
    name: z.string().min(1).describe('商品名'),
    commodityCode: z.string().min(1).describe('商品码; v1 开放词汇(COMMODITY_CODES), 收敛后转闭枚举'),
    spec: z.string().optional().describe('规格品位(分层待业务确认, 备忘 §7)'),
    unit: z.string().optional().describe('计量单位'),
  }),
  Counterparty: z.object({
    name: z.string().min(1).describe('企业名(归一化, 与图 Party 同源)'),
    role: z.string().describe('角色(开放: 供应商/客户/服务商, docx: 交易对手含服务商)'),
  }),
  OrgUnit: z.object({
    name: z.string().min(1).describe('内部组织名'),
    code: z.string().optional(),
  }),
  GoodsReceiptEvent: z.object({
    eventBizType: EventBizType.describe('收货(含采购退货); 逆向=负数金额'),
    amount: z.number().describe('金额; 逆向为负数(docx §6.2 自动轧差)'),
    currency: Currency,
    quantity: z.number().optional().describe('数量'),
    unit: z.string().optional(),
  }),
  GoodsDeliveryEvent: z.object({
    eventBizType: EventBizType.describe('发货(含销售退货); 逆向=负数金额'),
    amount: z.number(),
    currency: Currency,
    quantity: z.number().optional(),
    unit: z.string().optional(),
  }),
  SettlementEvent: z.object({
    eventBizType: EventBizType.describe('结算(采购/销售/补差); 补差/冲减走逆向负数'),
    amount: z.number(),
    currency: Currency,
    settledQuantity: z.number().optional().describe('结算数量(settlement_records.settled_quantity 同源)'),
    unit: z.string().optional(),
  }),
  InvoiceEvent: z.object({
    eventBizType: EventBizType.describe('发票(进项/销项/服务费); 红冲=逆向负数+REVERSE_ORIGIN 边'),
    amount: z.number(),
    currency: Currency,
    invoiceNo: z.string().min(1).describe('发票号'),
    invoiceType: z.string().describe('进项/销项/服务费(开放)'),
  }),
  PaymentEvent: z.object({
    eventBizType: EventBizType.describe('付款(预付/尾款/进度款/退款); 退款=逆向负数'),
    amount: z.number(),
    currency: Currency,
    payType: PayType.describe('流程分支开关(docx §6.1): 预付免票先行, 其余强依赖结算+发票'),
  }),
  CollectionEvent: z.object({
    eventBizType: EventBizType.describe('收款(预收/回款/退款); 退款=逆向负数'),
    amount: z.number(),
    currency: Currency,
    collectionType: z.string().optional().describe('预收/回款(开放, 非闭枚举)'),
  }),
  ServiceCostEvent: z.object({
    eventBizType: EventBizType.describe('第三方服务费; 费用冲减=逆向负数'),
    amount: z.number(),
    currency: Currency,
    costType: z.string().describe('物流/质检/仓储/报关/保险(开放)'),
  }),
} as const satisfies Record<OntologyEntityName, z.ZodObject<z.ZodRawShape>>;

export const ENTITY_NAMES = Object.keys(ONTOLOGY_ENTITIES) as OntologyEntityName[];

// ---------------------------------------------------------------------------
// mixin 字段词汇（docx 双时间轴 + 溯源；表列名 snake_case 由仓储映射）
// ---------------------------------------------------------------------------

export const DUAL_TIMELINE_FIELDS = ['validAt', 'invalidAt', 'ingestedAt'] as const;
export const PROVENANCE_FIELDS = ['createdBy', 'sourceSpan', 'confidence'] as const;

// 工具输入共享词汇（结构/溯源字段, Task 4 CI 门禁用）。新工具字段先进本表或实体 schema。
export const SHARED_TOOL_FIELD_NAMES = [
  'id', 'kind', 'name', 'props',
  'srcId', 'dstId', 'documentId', 'contractNo', 'relation',
  'confidence', 'sourceSpan',
  ...DUAL_TIMELINE_FIELDS, ...PROVENANCE_FIELDS,
] as const;

// ---------------------------------------------------------------------------
// 语义规则层（docx §6.2）：事件实体 逆向=负数 / 正向=正数。
// 与词汇层分离——ONTOLOGY_ENTITIES 保持纯 z.object（.shape 可直取），规则在写入边界叠加。
// ---------------------------------------------------------------------------

const EVENT_ENTITY_NAMES: readonly OntologyEntityName[] = [
  'GoodsReceiptEvent', 'GoodsDeliveryEvent', 'SettlementEvent', 'InvoiceEvent',
  'PaymentEvent', 'CollectionEvent', 'ServiceCostEvent',
];

const eventAmountRule = (v: Record<string, unknown>, ctx: z.RefinementCtx) => {
  const bizType = v['eventBizType'];
  const amount = v['amount'];
  if (typeof amount !== 'number') return;
  if (bizType === '逆向' && amount >= 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['amount'],
      message: '逆向事件金额必须为负数(docx 6.2: 负数金额自动轧差)' });
  }
  if (bizType === '正向' && amount <= 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['amount'],
      message: '正向事件金额必须为正数' });
  }
};

/** 写入边界用的完整 schema：词汇 + 语义规则。静态实体直接返回原 schema。 */
export function entitySchema(name: OntologyEntityName): z.ZodTypeAny {
  const base = ONTOLOGY_ENTITIES[name];
  return EVENT_ENTITY_NAMES.includes(name) ? base.superRefine(eventAmountRule) : base;
}

/** 字段全集 = 实体自有 ∪ 双时间轴 ∪ 溯源（CI 门禁与 Item 3 列生成共用）。 */
export function entityFieldNames(name: OntologyEntityName): Set<string> {
  const own = Object.keys(ONTOLOGY_ENTITIES[name]!.shape);
  return new Set([...own, ...DUAL_TIMELINE_FIELDS, ...PROVENANCE_FIELDS]);
}

// ---------------------------------------------------------------------------
// 关系（docx §5：4 核心 + 4 辅助 = 8 类型 / 14 连接对；带参是一等公民）
// ---------------------------------------------------------------------------

const NO_PARAMS = z.object({}).strict().describe('无参关系');

export interface OntologyRelationDef {
  name: string;
  description: string;
  pairs: ReadonlyArray<{ from: OntologyEntityName; to: OntologyEntityName }>;
  params: z.ZodObject<z.ZodRawShape>;
  meaning?: string;
}

export const ONTOLOGY_RELATIONS: ReadonlyArray<OntologyRelationDef> = [
  {
    name: 'ALLOCATE_TO',
    description: '分摊关系(docx §5.1): 费用/履约归属合同, 成本核算。多合同分摊=多边。',
    pairs: [
      { from: 'ServiceCostEvent', to: 'TradeContract' },
      { from: 'GoodsReceiptEvent', to: 'TradeContract' },
      { from: 'GoodsDeliveryEvent', to: 'TradeContract' },
    ],
    params: z.object({
      amount: z.number().describe('分摊金额'),
      ratio: z.number().min(0).max(1).optional().describe('分摊比例'),
      method: AllocateMethod.describe('分摊方式: 金额/数量/重量/定额'),
      batch: z.string().optional().describe('批次'),
    }).strict(),
  },
  {
    name: 'OFFSET_SETTLE',
    description: '冲抵关系(docx §5.2): 预付/预收资金冲抵货值结算, 预付场景核心。',
    pairs: [
      { from: 'PaymentEvent', to: 'SettlementEvent' },
      { from: 'CollectionEvent', to: 'SettlementEvent' },
    ],
    params: z.object({
      amount: z.number().describe('冲抵金额'),
      batch: z.string().optional().describe('批次'),
    }).strict(),
  },
  {
    name: 'WRITE_OFF',
    description: '核销关系(docx §5.3): 票款匹配闭环, 多对多/部分核销。',
    pairs: [
      { from: 'PaymentEvent', to: 'InvoiceEvent' },
      { from: 'CollectionEvent', to: 'InvoiceEvent' },
    ],
    params: z.object({
      amount: z.number().describe('核销金额'),
      partial: z.boolean().optional().describe('部分核销标记'),
      batch: z.string().optional().describe('批次'),
    }).strict(),
  },
  {
    name: 'REVERSE_ORIGIN',
    description: '红冲溯源(docx §5.4): 红冲票绑定原蓝字票, 全额/部分/多次。',
    pairs: [{ from: 'InvoiceEvent', to: 'InvoiceEvent' }],
    params: z.object({
      amount: z.number().describe('红冲金额'),
      reason: z.string().optional().describe('冲抵原因'),
    }).strict(),
  },
  {
    name: 'FEEDS_INTO',
    description: '辅助(docx §5.5): 履约数据生成结算数据。',
    pairs: [
      { from: 'GoodsReceiptEvent', to: 'SettlementEvent' },
      { from: 'GoodsDeliveryEvent', to: 'SettlementEvent' },
    ],
    params: NO_PARAMS,
  },
  {
    name: 'CORRESPONDS_TO',
    description: '辅助(docx §5.5): 结算/费用对应发票（两对语义各算一条, 合计 9 关系口径）。',
    pairs: [
      { from: 'SettlementEvent', to: 'InvoiceEvent' },
      { from: 'ServiceCostEvent', to: 'InvoiceEvent' },
    ],
    params: NO_PARAMS,
  },
  {
    name: 'TRIGGERS',
    description: '辅助(docx §5.5): 第三方费用触发付款。',
    pairs: [{ from: 'ServiceCostEvent', to: 'PaymentEvent' }],
    params: NO_PARAMS,
  },
  {
    name: 'PROVIDE',
    description: '辅助(docx §5.5): 服务商与服务费关联归属。',
    pairs: [{ from: 'Counterparty', to: 'ServiceCostEvent' }],
    params: NO_PARAMS,
  },
];

export function relationDef(name: string): OntologyRelationDef {
  const def = ONTOLOGY_RELATIONS.find((r) => r.name === name);
  if (!def) throw new Error(`ontology: unknown relation "${name}"`);
  return def;
}

export function isRelationPairAllowed(name: string, from: string, to: string): boolean {
  const def = ONTOLOGY_RELATIONS.find((r) => r.name === name);
  if (!def) return false;
  return def.pairs.some((p) => p.from === from && p.to === to);
}

// ---------------------------------------------------------------------------
// 前端/治理可消费的纯 JSON 投影（Item 3 GET /api/ontology/schema 的数据源）
// ---------------------------------------------------------------------------

export function ontologySchemaJson() {
  return {
    version: '2026-09-07',
    enums: {
      PayType: PayType.options,
      EventBizType: EventBizType.options,
      AllocateMethod: AllocateMethod.options,
      commodityCodes: COMMODITY_CODES,
    },
    entities: ENTITY_NAMES.map((n) => ({
      name: n,
      fields: [...entityFieldNames(n)],
      meaning: MEANING_URIS[n] ?? null,
    })),
    relations: ONTOLOGY_RELATIONS.map((r) => ({
      name: r.name,
      description: r.description,
      pairs: r.pairs,
      params: Object.keys(r.params.shape),
      meaning: r.meaning ?? MEANING_URIS[r.name] ?? null,
    })),
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test --workspace apps/server -- test/ontology/registry.test.ts`
Expected: PASS（全部用例）

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/ontology/index.ts apps/server/test/ontology/registry.test.ts
git commit -m "feat(ontology): 领域本体注册表(11实体/8关系13对/枚举/双时间轴字段/meaning机制)"
```

---

### Task 2: ontology_edges + trade_facts 双后端幂等建表

**Files:**
- Modify: `apps/server/src/pipeline/db/client.ts`（`migrate()` 的 exec 模板末尾追加两表 DDL，位置在 `document_units` 建表之后；`migratePostgres()` 的 `statements` 数组末尾追加两表 raw DDL）
- Modify: `apps/server/src/pipeline/db/postgres-schema.ts`（文件末尾追加两个 pgTable twin）
- Test: `apps/server/test/ontology/tables.test.ts`（SQLite 结构+幂等）
- Test: `apps/server/test/pipeline/postgres.integration.test.ts`（追加 PG 结构断言 describe 块，随既有 skip 门禁）

**Interfaces:**
- Consumes: Task 1 无依赖（本任务只建表）；测试范式 `createDb(':memory:')` + `migrate(ctx.sqlite)`
- Produces: 表 `ontology_edges(id, relation, from_type, from_id, to_type, to_id, params, valid_at, invalid_at, ingested_at, created_by, user_id)` 与 `trade_facts(id, entity_type, payload, valid_at, invalid_at, ingested_at, created_by, user_id)`，双后端列对列镜像（Task 3 仓储依赖此列集）；drizzle 导出 `ontologyEdges` / `tradeFacts`（后续 Item 查询可用）

- [ ] **Step 1: 前置检查**

```bash
# 确认 postgres-schema.ts 顶部 import 已含 jsonb/timestamp/sql（graph_links 用过 sql; doc_chunk tags 用过 jsonb）
grep -n "pg-core" apps/server/src/pipeline/db/postgres-schema.ts | head -2
# 若缺 jsonb/timestamp 则在该 import 行补上（照抄既有写法）
# 找到 migrate() exec 模板的收尾位置(document_units 建表之后, 462 行 guarded ALTER 之前)
grep -n "document_units" apps/server/src/pipeline/db/client.ts | head -3
grep -n "export async function migratePostgres" apps/server/src/pipeline/db/client.ts
```

- [ ] **Step 2: 写失败测试** `apps/server/test/ontology/tables.test.ts`

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';

let ctx: DbContext;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
});

const EDGE_COLS = ['id', 'relation', 'from_type', 'from_id', 'to_type', 'to_id',
  'params', 'valid_at', 'invalid_at', 'ingested_at', 'created_by', 'user_id'];
const FACT_COLS = ['id', 'entity_type', 'payload', 'valid_at', 'invalid_at',
  'ingested_at', 'created_by', 'user_id'];

function tableCols(table: string): string[] {
  return (ctx.sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .map((c) => c.name);
}

describe('ontology tables (SQLite lane)', () => {
  it('ontology_edges columns mirror the spec exactly', () => {
    expect(tableCols('ontology_edges')).toEqual(EDGE_COLS);
  });

  it('trade_facts columns mirror the spec exactly', () => {
    expect(tableCols('trade_facts')).toEqual(FACT_COLS);
  });

  it('migrate is idempotent (spec: 幂等建表)', () => {
    expect(() => migrate(ctx.sqlite)).not.toThrow(); // 二次迁移不报错
    ctx.sqlite.prepare(
      `INSERT INTO ontology_edges (id, relation, from_type, from_id, to_type, to_id,
         params, valid_at, created_by) VALUES ('OE-1','WRITE_OFF','PaymentEvent','TF-1',
         'InvoiceEvent','TF-2','{}','2026-06-15T00:00:00.000Z','test')`,
    ).run();
    expect(() => migrate(ctx.sqlite)).not.toThrow(); // 有数据后迁移仍幂等
  });

  it('ingested_at defaults to UTC ISO (lexicographic == chronological)', () => {
    ctx.sqlite.prepare(
      `INSERT INTO trade_facts (id, entity_type, payload, valid_at, created_by)
       VALUES ('TF-1','InvoiceEvent','{}','2026-06-15T00:00:00.000Z','test')`,
    ).run();
    const row = ctx.sqlite.prepare('SELECT ingested_at FROM trade_facts WHERE id = ?').get('TF-1') as { ingested_at: string };
    expect(row.ingested_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/); // T 分隔, 非 datetime('now') 空格格式
  });

  it('as-of comparisons work on the TEXT time columns', () => {
    ctx.sqlite.prepare(
      `INSERT INTO trade_facts (id, entity_type, payload, valid_at, invalid_at, created_by)
       VALUES ('TF-1','InvoiceEvent','{}','2026-06-15T00:00:00.000Z','2026-06-15T00:00:00.000Z','test')`,
    ).run();
    // invalid_at = valid_at: 任一 t >= 6/15 时该行被 asOfBusinessTime 排除(invalid_at > t 为假)
    const hit = ctx.sqlite.prepare(
      `SELECT COUNT(*) AS n FROM trade_facts
       WHERE valid_at <= ? AND (invalid_at IS NULL OR invalid_at > ?)`,
    ).get('2026-06-30T00:00:00.000Z', '2026-06-30T00:00:00.000Z') as { n: number };
    expect(hit.n).toBe(0);
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/ontology/tables.test.ts`
Expected: FAIL（`no such table: ontology_edges`）

- [ ] **Step 4: SQLite DDL——在 `client.ts migrate()` 的 exec 模板内、`document_units` 建表语句之后追加**

```sql
    -- 本体基座(roadmap 2026-09-07 Item 2 / 技术备忘 §3-§4): 带参关系边 + 事件事实。
    -- 实体业务数据 v1 不搬家(Item 3 只读投影), 本两表只收本体原生写入(经
    -- src/ontology/repo.ts 的 zod 校验入口, 不要绕过直写)。时间列全 UTC ISO
    -- (strftime Z 惯例, projects 表先例): TEXT 字典序即时间序, as-of 比较依赖此点。
    CREATE TABLE IF NOT EXISTS ontology_edges (
      id TEXT PRIMARY KEY,
      relation TEXT NOT NULL,
      from_type TEXT NOT NULL,
      from_id TEXT NOT NULL,
      to_type TEXT NOT NULL,
      to_id TEXT NOT NULL,
      params TEXT NOT NULL DEFAULT '{}',
      valid_at TEXT NOT NULL,
      invalid_at TEXT,
      ingested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      created_by TEXT NOT NULL,
      user_id TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_ontology_edges_relation ON ontology_edges(relation, user_id);
    CREATE INDEX IF NOT EXISTS idx_ontology_edges_from ON ontology_edges(from_type, from_id, user_id);
    CREATE INDEX IF NOT EXISTS idx_ontology_edges_to ON ontology_edges(to_type, to_id, user_id);

    CREATE TABLE IF NOT EXISTS trade_facts (
      id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      valid_at TEXT NOT NULL,
      invalid_at TEXT,
      ingested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      created_by TEXT NOT NULL,
      user_id TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_trade_facts_type ON trade_facts(entity_type, user_id);
    CREATE INDEX IF NOT EXISTS idx_trade_facts_valid ON trade_facts(valid_at);
    CREATE INDEX IF NOT EXISTS idx_trade_facts_ingested ON trade_facts(ingested_at);
```

- [ ] **Step 5: Postgres raw DDL——在 `client.ts migratePostgres()` 的 `statements` 数组末尾追加**

```ts
    // 本体基座(2026-09-07 Item 2): mirrors SQLite ontology_edges/trade_facts 列对列;
    // params/payload 用 jsonb(PG 惯例, 供 Item 4/5 边摘要与聚合查询), 时间列 timestamptz。
    `CREATE TABLE IF NOT EXISTS ontology_edges (
       id TEXT PRIMARY KEY,
       relation TEXT NOT NULL,
       from_type TEXT NOT NULL,
       from_id TEXT NOT NULL,
       to_type TEXT NOT NULL,
       to_id TEXT NOT NULL,
       params jsonb NOT NULL DEFAULT '{}'::jsonb,
       valid_at timestamptz NOT NULL,
       invalid_at timestamptz,
       ingested_at timestamptz NOT NULL DEFAULT NOW(),
       created_by TEXT NOT NULL,
       user_id TEXT NOT NULL DEFAULT ''
     )`,
    `CREATE INDEX IF NOT EXISTS idx_ontology_edges_relation ON ontology_edges(relation, user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_ontology_edges_from ON ontology_edges(from_type, from_id, user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_ontology_edges_to ON ontology_edges(to_type, to_id, user_id)`,
    `CREATE TABLE IF NOT EXISTS trade_facts (
       id TEXT PRIMARY KEY,
       entity_type TEXT NOT NULL,
       payload jsonb NOT NULL,
       valid_at timestamptz NOT NULL,
       invalid_at timestamptz,
       ingested_at timestamptz NOT NULL DEFAULT NOW(),
       created_by TEXT NOT NULL,
       user_id TEXT NOT NULL DEFAULT ''
     )`,
    `CREATE INDEX IF NOT EXISTS idx_trade_facts_type ON trade_facts(entity_type, user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_trade_facts_valid ON trade_facts(valid_at)`,
    `CREATE INDEX IF NOT EXISTS idx_trade_facts_ingested ON trade_facts(ingested_at)`,
```

- [ ] **Step 6: drizzle twin——`postgres-schema.ts` 文件末尾追加**

```ts
/**
 * 本体基座(roadmap 2026-09-07 Item 2): 带参关系边 + 事件事实通用表。
 * Mirrors SQLite ontology_edges/trade_facts 列对列; params/payload 用 jsonb。
 * 原生写入只经 src/ontology/repo.ts(zod 校验), 不要绕过直写。
 */
export const ontologyEdges = pgTable(
  'ontology_edges',
  {
    id: text('id').primaryKey(),
    relation: text('relation').notNull(),
    fromType: text('from_type').notNull(),
    fromId: text('from_id').notNull(),
    toType: text('to_type').notNull(),
    toId: text('to_id').notNull(),
    params: jsonb('params').notNull().default(sql`'{}'::jsonb`),
    validAt: timestamp('valid_at', { withTimezone: true }).notNull(),
    invalidAt: timestamp('invalid_at', { withTimezone: true }),
    ingestedAt: timestamp('ingested_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: text('created_by').notNull(),
    userId: text('user_id').notNull().default(''),
  },
  (t) => ({
    relIdx: index('idx_ontology_edges_relation').on(t.relation, t.userId),
    fromIdx: index('idx_ontology_edges_from').on(t.fromType, t.fromId, t.userId),
    toIdx: index('idx_ontology_edges_to').on(t.toType, t.toId, t.userId),
  }),
);

export const tradeFacts = pgTable(
  'trade_facts',
  {
    id: text('id').primaryKey(),
    entityType: text('entity_type').notNull(),
    payload: jsonb('payload').notNull(),
    validAt: timestamp('valid_at', { withTimezone: true }).notNull(),
    invalidAt: timestamp('invalid_at', { withTimezone: true }),
    ingestedAt: timestamp('ingested_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: text('created_by').notNull(),
    userId: text('user_id').notNull().default(''),
  },
  (t) => ({
    typeIdx: index('idx_trade_facts_type').on(t.entityType, t.userId),
    validIdx: index('idx_trade_facts_valid').on(t.validAt),
    ingestedIdx: index('idx_trade_facts_ingested').on(t.ingestedAt),
  }),
);
```

- [ ] **Step 7: SQLite 测试通过 + PG 集成测试扩展**

Run: `npm test --workspace apps/server -- test/ontology/tables.test.ts`
Expected: PASS

在 `test/pipeline/postgres.integration.test.ts` 既有结构内（TRUNCATE 门禁之外，不碰业务表 TRUNCATE 清单）追加一个 describe 块（沿用该文件既有的 `RUN_PG` skip 判定变量，照抄文件内其他 describe 的门禁写法；若该文件用 `const RUN_PG = DB_BACKEND === 'postgres' || !!process.env.DATABASE_URL` 一类判定，则 `describe.skipIf(!RUN_PG)` 同款）：

```ts
describe.skipIf(!(DB_BACKEND === 'postgres' || process.env.DATABASE_URL))('ontology tables (PG lane)', () => {
  beforeAll(async () => {
    // ctx 由该文件既有的 PG ctx 初始化路径提供; migratePostgres 幂等可重复执行
    await migratePostgres(ctx.pool);
  });

  it('ontology_edges / trade_facts exist with mirrored columns', async () => {
    const res = await ctx.pool.query(`SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name IN ('ontology_edges','trade_facts')
      ORDER BY table_name, ordinal_position`);
    const byTable: Record<string, string[]> = {};
    for (const r of res.rows as Array<{ table_name: string; column_name: string }>) {
      (byTable[r.table_name] ??= []).push(r.column_name);
    }
    expect(byTable['ontology_edges']).toEqual(['id', 'relation', 'from_type', 'from_id',
      'to_type', 'to_id', 'params', 'valid_at', 'invalid_at', 'ingested_at', 'created_by', 'user_id']);
    expect(byTable['trade_facts']).toEqual(['id', 'entity_type', 'payload', 'valid_at',
      'invalid_at', 'ingested_at', 'created_by', 'user_id']);
  });
});
```

（实现时以该文件实际的 ctx 变量名/skip 写法为准做等价嵌入——前置检查 Step 1 已读过文件头；核心断言是列集一致，别改文件既有门禁与 TRUNCATE 逻辑。）

Run: `npm test --workspace apps/server -- test/pipeline/postgres.integration.test.ts`
Expected: SQLite 车道下该 describe 整体 skip（PASS 0 matched 或 skipped）；只有 `DB_BACKEND=postgres` + 独立 sca_test 库时才真跑（**绝不可把 DATABASE_URL 指向共享开发库 sca**——该文件头注释有 2026-08-17 事故记录）。

- [ ] **Step 8: 提交**

```bash
git add apps/server/src/pipeline/db/client.ts apps/server/src/pipeline/db/postgres-schema.ts \
  apps/server/test/ontology/tables.test.ts apps/server/test/pipeline/postgres.integration.test.ts
git commit -m "feat(ontology): ontology_edges/trade_facts 双后端幂等建表(SQLite raw DDL/PG raw DDL+drizzle twin)"
```

---

### Task 3: as-of 查询谓词 + 双后端仓储（写入 zod 校验 / 红冲三问三答）

**Files:**
- Create: `apps/server/src/ontology/asof.ts`
- Create: `apps/server/src/ontology/repo.ts`
- Test: `apps/server/test/ontology/repo.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `entitySchema` / `relationDef` / `isRelationPairAllowed` / `OntologyEntityName`；Task 2 的两张表；`DbContext` / `PostgresDbContext`（`apps/server/src/pipeline/db/client.js`）；`effectiveUserId`（`repositories.ts:174` 导出）
- Produces:
  - `asOfBusinessTime(t: string): AsOfPredicate` / `asOfSystemTime(t: string): AsOfPredicate`，`AsOfPredicate = { sql: string; params: string[] }`（sql 用 `?` 占位，PG 侧经 `numberPlaceholders` 转 `$n`）
  - `normalizeIsoUtc(input: string | Date): string`
  - `insertTradeFact(ctx: DbContext, input: TradeFactInput, userId?: string): Promise<string>`（返回行 id；payload 经 `entitySchema(type).parse`，非法 throw）
  - `insertOntologyEdge(ctx: DbContext, input: OntologyEdgeInput, userId?: string): Promise<string>`（关系名/连接对/params 三重校验）
  - `listTradeFactsAsOf(ctx, pred, opts: { entityType?: string }, userId?): Promise<TradeFactRow[]>`
  - `listOntologyEdgesAsOf(ctx, pred, opts: { relation?: string }, userId?): Promise<OntologyEdgeRow[]>`
  - Row 类型 `TradeFactRow { id, entityType, payload: Record<string, unknown>, validAt, invalidAt, ingestedAt, createdBy, userId }`、`OntologyEdgeRow { id, relation, fromType, fromId, toType, toId, params: Record<string, unknown>, validAt, invalidAt, ingestedAt, createdBy, userId }`

- [ ] **Step 1: 写失败测试** `apps/server/test/ontology/repo.test.ts`

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import {
  asOfBusinessTime, asOfSystemTime, normalizeIsoUtc,
  insertTradeFact, insertOntologyEdge, listTradeFactsAsOf,
} from '../../src/ontology/repo2.js'; // NOTE: 见下方更正——统一从 './repo.js' 导入
```

（更正：import 路径为 `'../../src/ontology/repo.js'`，asof 函数由 repo.ts re-export 或直接从 `'../../src/ontology/asof.js'` 导入。以下按「asof 从 asof.js、repo 函数从 repo.js」两条 import 写。）

```ts
import { asOfBusinessTime, asOfSystemTime, normalizeIsoUtc } from '../../src/ontology/asof.js';
import {
  insertTradeFact, insertOntologyEdge, listTradeFactsAsOf, listOntologyEdgesAsOf,
} from '../../src/ontology/repo.js';

let ctx: DbContext;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
});

const INVOICE = (amount: number, eventBizType: '正向' | '逆向') => ({
  invoiceNo: 'INV-1', invoiceType: '销项', eventBizType, amount, currency: 'CNY',
});

describe('as-of predicates (memo section 4 semantics)', () => {
  it('business time: valid window [validAt, invalidAt)', () => {
    const p = asOfBusinessTime('2026-07-31T00:00:00.000Z');
    expect(p.sql).toBe('valid_at <= ? AND (invalid_at IS NULL OR invalid_at > ?)');
    expect(p.params).toEqual(['2026-07-31T00:00:00.000Z', '2026-07-31T00:00:00.000Z']);
  });

  it('system time: ingested_at only (what we knew then)', () => {
    const p = asOfSystemTime('2026-07-31T00:00:00.000Z');
    expect(p.sql).toBe('ingested_at <= ?');
    expect(p.params).toEqual(['2026-07-31T00:00:00.000Z']);
  });

  it('normalizeIsoUtc: date-only and Date objects both land on UTC ISO', () => {
    expect(normalizeIsoUtc('2026-06-15')).toBe('2026-06-15T00:00:00.000Z');
    expect(normalizeIsoUtc(new Date('2026-06-15T08:00:00+08:00'))).toBe('2026-06-15T00:00:00.000Z');
    expect(() => normalizeIsoUtc('not-a-date')).toThrow();
  });
});

describe('ontology repo write boundary', () => {
  it('insertTradeFact validates payload via the registry (event semantics enforced)', async () => {
    const id = await insertTradeFact(ctx, {
      entityType: 'InvoiceEvent', payload: INVOICE(1_000_000, '正向'),
      validAt: '2026-06-15', createdBy: 'test',
    });
    expect(id).toMatch(/^TF-/);
    await expect(insertTradeFact(ctx, {
      entityType: 'InvoiceEvent', payload: INVOICE(100, '逆向'), // 逆向正数 => 违反 6.2
      validAt: '2026-06-15', createdBy: 'test',
    })).rejects.toThrow();
    await expect(insertTradeFact(ctx, {
      entityType: 'NoSuchEntity', payload: {},
      validAt: '2026-06-15', createdBy: 'test',
    })).rejects.toThrow();
  });

  it('insertOntologyEdge validates relation + pair + params', async () => {
    const id = await insertOntologyEdge(ctx, {
      relation: 'WRITE_OFF', fromType: 'PaymentEvent', fromId: 'TF-P1',
      toType: 'InvoiceEvent', toId: 'TF-I1',
      params: { amount: 500, partial: true }, validAt: '2026-06-20', createdBy: 'test',
    });
    expect(id).toMatch(/^OE-/);
    await expect(insertOntologyEdge(ctx, { // 非法连接对
      relation: 'ALLOCATE_TO', fromType: 'TradeContract', fromId: 'C1',
      toType: 'InvoiceEvent', toId: 'I1', params: { amount: 1, method: '金额' },
      validAt: '2026-06-20', createdBy: 'test',
    })).rejects.toThrow();
    await expect(insertOntologyEdge(ctx, { // params 违反 strict schema
      relation: 'WRITE_OFF', fromType: 'PaymentEvent', fromId: 'TF-P1',
      toType: 'InvoiceEvent', toId: 'TF-I1',
      params: { amount: 500, bogus: 1 }, validAt: '2026-06-20', createdBy: 'test',
    })).rejects.toThrow();
  });
});

describe('red-invoice as-of scenario (memo section 4: three questions, three answers)', () => {
  // 6/15 收发票 100 万; 8/5 红冲重开 80 万(追溯 6/15 生效)。原票失效点=红冲生效点。
  beforeEach(async () => {
    await insertTradeFact(ctx, {
      entityType: 'InvoiceEvent', payload: INVOICE(1_000_000, '正向'),
      validAt: '2026-06-15', invalidAt: '2026-06-15', ingestedAt: '2026-06-16',
      createdBy: 'scenario',
    });
    await insertTradeFact(ctx, {
      entityType: 'InvoiceEvent', payload: INVOICE(-1_000_000, '逆向'),
      validAt: '2026-06-15', ingestedAt: '2026-08-05', createdBy: 'scenario',
    });
    await insertTradeFact(ctx, {
      entityType: 'InvoiceEvent', payload: { ...INVOICE(800_000, '正向'), invoiceNo: 'INV-2' },
      validAt: '2026-06-15', ingestedAt: '2026-08-05', createdBy: 'scenario',
    });
  });

  const sum = (rows: Array<{ payload: Record<string, unknown> }>) =>
    rows.reduce((acc, r) => acc + (r.payload['amount'] as number), 0);

  it('Q1 最新口径(asOfBusinessTime now): 80 万', async () => {
    const rows = await listTradeFactsAsOf(ctx, asOfBusinessTime('2026-09-07T00:00:00.000Z'), {});
    expect(sum(rows)).toBe(800_000);
  });

  it('Q2 7/31 出表时账面(asOfSystemTime): 100 万——月报可复现', async () => {
    const rows = await listTradeFactsAsOf(ctx, asOfSystemTime('2026-07-31T23:59:59.000Z'), {});
    expect(sum(rows)).toBe(1_000_000);
  });

  it('Q3 6 月真实成本(asOfBusinessTime 6/30): 80 万', async () => {
    const rows = await listTradeFactsAsOf(ctx, asOfBusinessTime('2026-06-30T00:00:00.000Z'), {});
    expect(sum(rows)).toBe(800_000);
  });

  it('entityType filter narrows the slice', async () => {
    const rows = await listTradeFactsAsOf(ctx, asOfSystemTime('2026-07-31T00:00:00.000Z'), { entityType: 'PaymentEvent' });
    expect(rows).toEqual([]);
  });
});

describe('ontology edges as-of', () => {
  it('edges honor the same dual-timeline predicates', async () => {
    await insertOntologyEdge(ctx, {
      relation: 'WRITE_OFF', fromType: 'PaymentEvent', fromId: 'TF-P1',
      toType: 'InvoiceEvent', toId: 'TF-I1', params: { amount: 500 },
      validAt: '2026-06-15', createdBy: 'test',
    });
    await insertOntologyEdge(ctx, {
      relation: 'OFFSET_SETTLE', fromType: 'PaymentEvent', fromId: 'TF-P2',
      toType: 'SettlementEvent', toId: 'TF-S1', params: { amount: 300 },
      validAt: '2026-06-15', invalidAt: '2026-07-01', createdBy: 'test',
    });
    const at620 = await listOntologyEdgesAsOf(ctx, asOfBusinessTime('2026-06-20T00:00:00.000Z'), {});
    expect(at620).toHaveLength(2);
    const at715 = await listOntologyEdgesAsOf(ctx, asOfBusinessTime('2026-07-15T00:00:00.000Z'), {});
    expect(at715.map((e) => e.relation)).toEqual(['WRITE_OFF']); // OFFSET_SETTLE 已于 7/1 失效
    const filtered = await listOntologyEdgesAsOf(ctx, asOfBusinessTime('2026-07-15T00:00:00.000Z'), { relation: 'OFFSET_SETTLE' });
    expect(filtered).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/ontology/repo.test.ts`
Expected: FAIL（`Cannot find module '../../src/ontology/asof.js'`）

- [ ] **Step 3: 写实现** `apps/server/src/ontology/asof.ts`

```ts
// as-of 双时间轴查询谓词（本体建模技术备忘 §4 的 SQL 语义, 逐字对应）:
//   业务时间: 当时为真的事实(valid_at <= t 且尚未失效)
//   系统时间: 当时我们知道什么(ingested_at <= t, 审计/月报复现口径)
// 谓词与表无关: ontology_edges 与 trade_facts 共用; sql 用 ? 占位,
// Postgres 侧经 numberPlaceholders 转 $n。
export interface AsOfPredicate {
  sql: string;
  params: string[];
}

export function asOfBusinessTime(t: string): AsOfPredicate {
  const iso = normalizeIsoUtc(t);
  return { sql: 'valid_at <= ? AND (invalid_at IS NULL OR invalid_at > ?)', params: [iso, iso] };
}

export function asOfSystemTime(t: string): AsOfPredicate {
  return { sql: 'ingested_at <= ?', params: [normalizeIsoUtc(t)] };
}

/** UTC ISO 归一(毫秒精度)。SQLite TEXT 列字典序=时间序依赖统一格式。 */
export function normalizeIsoUtc(input: string | Date): string {
  const d = typeof input === 'string' ? new Date(input) : input;
  const t = d.getTime();
  if (Number.isNaN(t)) throw new Error(`asof: invalid datetime "${String(input)}"`);
  return new Date(t).toISOString();
}

/** '?' 占位转 PG '$n' 占位(谓词 sql 内无字符串字面量, 安全)。 */
export function numberPlaceholders(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}
```

- [ ] **Step 4: 写实现** `apps/server/src/ontology/repo.ts`

```ts
// 本体基座仓储(双后端 dispatch, 仿 pipeline/db/repositories.ts 模式)。
// 写入边界=注册表 zod 校验(entitySchema/relationDef/isRelationPairAllowed),
// 不要绕过本模块直写 ontology_edges/trade_facts。
import type { DbContext, PostgresDbContext } from '../pipeline/db/client.js';
import { effectiveUserId } from '../pipeline/db/repositories.js';
import {
  entitySchema, relationDef, isRelationPairAllowed,
  type OntologyEntityName,
} from './index.js';
import { normalizeIsoUtc, numberPlaceholders, type AsOfPredicate } from './asof.js';

const rid = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

// ---------------------------------------------------------------------------
// 输入/行类型
// ---------------------------------------------------------------------------

export interface TradeFactInput {
  entityType: OntologyEntityName;
  payload: Record<string, unknown>;
  validAt: string | Date;
  invalidAt?: string | Date | null;
  ingestedAt?: string | Date;
  createdBy: string;
}

export interface OntologyEdgeInput {
  relation: string;
  fromType: OntologyEntityName;
  fromId: string;
  toType: OntologyEntityName;
  toId: string;
  params?: Record<string, unknown>;
  validAt: string | Date;
  invalidAt?: string | Date | null;
  ingestedAt?: string | Date;
  createdBy: string;
}

export interface TradeFactRow {
  id: string; entityType: string; payload: Record<string, unknown>;
  validAt: string; invalidAt: string | null; ingestedAt: string;
  createdBy: string; userId: string;
}

export interface OntologyEdgeRow {
  id: string; relation: string;
  fromType: string; fromId: string; toType: string; toId: string;
  params: Record<string, unknown>;
  validAt: string; invalidAt: string | null; ingestedAt: string;
  createdBy: string; userId: string;
}

const FACT_COLS = 'id, entity_type, payload, valid_at, invalid_at, ingested_at, created_by, user_id';
const EDGE_COLS = 'id, relation, from_type, from_id, to_type, to_id, params, valid_at, invalid_at, ingested_at, created_by, user_id';

const parseJson = (raw: unknown): Record<string, unknown> => {
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
  }
  return (raw ?? {}) as Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// trade_facts
// ---------------------------------------------------------------------------

export async function insertTradeFact(
  ctx: DbContext, input: TradeFactInput, userId?: string,
): Promise<string> {
  // 写入边界: 注册表词汇 + 语义规则(entitySchema 含事件金额方向 refinement)
  entitySchema(input.entityType).parse(input.payload);
  const id = rid('TF');
  const validAt = normalizeIsoUtc(input.validAt);
  const invalidAt = input.invalidAt == null ? null : normalizeIsoUtc(input.invalidAt);
  const ingestedAt = input.ingestedAt == null ? null : normalizeIsoUtc(input.ingestedAt);
  const uid = effectiveUserId(userId);

  if (ctx.backend === 'postgres') {
    const pg = ctx as PostgresDbContext;
    await pg.pool.query(
      `INSERT INTO trade_facts (${FACT_COLS})
       VALUES ($1,$2,$3,$4,$5,COALESCE($6, NOW()),$7,$8)`,
      [id, input.entityType, JSON.stringify(input.payload), validAt, invalidAt,
       ingestedAt, input.createdBy, uid],
    );
    return id;
  }
  ctx.sqlite.prepare(
    `INSERT INTO trade_facts (id, entity_type, payload, valid_at, invalid_at, ingested_at, created_by, user_id)
     VALUES (?, ?, ?, ?, ?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ','now')), ?, ?)`,
  ).run(id, input.entityType, JSON.stringify(input.payload), validAt, invalidAt,
    ingestedAt, input.createdBy, uid);
  return id;
}

export async function listTradeFactsAsOf(
  ctx: DbContext, pred: AsOfPredicate, opts: { entityType?: string } = {}, userId?: string,
): Promise<TradeFactRow[]> {
  const uid = effectiveUserId(userId);
  const conds = [pred.sql, "(user_id = ? OR user_id = '')"];
  const params = [...pred.params, uid];
  if (opts.entityType) { conds.push('entity_type = ?'); params.push(opts.entityType); }
  const where = conds.join(' AND ');

  if (ctx.backend === 'postgres') {
    const pg = ctx as PostgresDbContext;
    const res = await pg.pool.query(
      `SELECT ${FACT_COLS} FROM trade_facts WHERE ${numberPlaceholders(where)} ORDER BY valid_at, id`,
      params,
    );
    return (res.rows as Array<Record<string, unknown>>).map((r) => ({
      id: r['id'] as string,
      entityType: r['entity_type'] as string,
      payload: parseJson(r['payload']),
      validAt: new Date(r['valid_at'] as string).toISOString(),
      invalidAt: r['invalid_at'] == null ? null : new Date(r['invalid_at'] as string).toISOString(),
      ingestedAt: new Date(r['ingested_at'] as string).toISOString(),
      createdBy: r['created_by'] as string,
      userId: r['user_id'] as string,
    }));
  }
  const rows = ctx.sqlite.prepare(
    `SELECT ${FACT_COLS} FROM trade_facts WHERE ${where} ORDER BY valid_at, id`,
  ).all(...params) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r['id'] as string,
    entityType: r['entity_type'] as string,
    payload: parseJson(r['payload']),
    validAt: r['valid_at'] as string,
    invalidAt: (r['invalid_at'] as string | null) ?? null,
    ingestedAt: r['ingested_at'] as string,
    createdBy: r['created_by'] as string,
    userId: r['user_id'] as string,
  }));
}

// ---------------------------------------------------------------------------
// ontology_edges
// ---------------------------------------------------------------------------

export async function insertOntologyEdge(
  ctx: DbContext, input: OntologyEdgeInput, userId?: string,
): Promise<string> {
  // 写入边界: 关系存在 + 连接对合法 + params 走关系的 strict schema
  const def = relationDef(input.relation);
  if (!isRelationPairAllowed(input.relation, input.fromType, input.toType)) {
    throw new Error(
      `ontology: relation "${input.relation}" does not allow ${input.fromType} -> ${input.toType}` +
      ` (allowed: ${def.pairs.map((p) => `${p.from}->${p.to}`).join(', ')})`);
  }
  def.params.parse(input.params ?? {});
  const id = rid('OE');
  const validAt = normalizeIsoUtc(input.validAt);
  const invalidAt = input.invalidAt == null ? null : normalizeIsoUtc(input.invalidAt);
  const ingestedAt = input.ingestedAt == null ? null : normalizeIsoUtc(input.ingestedAt);
  const uid = effectiveUserId(userId);

  if (ctx.backend === 'postgres') {
    const pg = ctx as PostgresDbContext;
    await pg.pool.query(
      `INSERT INTO ontology_edges (${EDGE_COLS})
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10, NOW()),$11,$12)`,
      [id, input.relation, input.fromType, input.fromId, input.toType, input.toId,
       JSON.stringify(input.params ?? {}), validAt, invalidAt,
       ingestedAt, input.createdBy, uid],
    );
    return id;
  }
  ctx.sqlite.prepare(
    `INSERT INTO ontology_edges (id, relation, from_type, from_id, to_type, to_id, params,
        valid_at, invalid_at, ingested_at, created_by, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ','now')), ?, ?)`,
  ).run(id, input.relation, input.fromType, input.fromId, input.toType, input.toId,
    JSON.stringify(input.params ?? {}), validAt, invalidAt,
    ingestedAt, input.createdBy, uid);
  return id;
}

export async function listOntologyEdgesAsOf(
  ctx: DbContext, pred: AsOfPredicate, opts: { relation?: string } = {}, userId?: string,
): Promise<OntologyEdgeRow[]> {
  const uid = effectiveUserId(userId);
  const conds = [pred.sql, "(user_id = ? OR user_id = '')"];
  const params = [...pred.params, uid];
  if (opts.relation) { conds.push('relation = ?'); params.push(opts.relation); }
  const where = conds.join(' AND ');

  const mapRow = (r: Record<string, unknown>, iso: (v: unknown) => string | null): OntologyEdgeRow => ({
    id: r['id'] as string,
    relation: r['relation'] as string,
    fromType: r['from_type'] as string, fromId: r['from_id'] as string,
    toType: r['to_type'] as string, toId: r['to_id'] as string,
    params: parseJson(r['params']),
    validAt: iso(r['valid_at']) as string,
    invalidAt: iso(r['invalid_at']),
    ingestedAt: iso(r['ingested_at']) as string,
    createdBy: r['created_by'] as string,
    userId: r['user_id'] as string,
  });

  if (ctx.backend === 'postgres') {
    const pg = ctx as PostgresDbContext;
    const res = await pg.pool.query(
      `SELECT ${EDGE_COLS} FROM ontology_edges WHERE ${numberPlaceholders(where)} ORDER BY valid_at, id`,
      params,
    );
    return (res.rows as Array<Record<string, unknown>>).map((r) => mapRow(r, (v) =>
      v == null ? null : new Date(v as string).toISOString()));
  }
  const rows = ctx.sqlite.prepare(
    `SELECT ${EDGE_COLS} FROM ontology_edges WHERE ${where} ORDER BY valid_at, id`,
  ).all(...params) as Array<Record<string, unknown>>;
  return rows.map((r) => mapRow(r, (v) => (v == null ? null : v as string)));
}
```

注意：`user_id` 过滤沿用 graph_links 的 `(user_id = ? OR user_id = '')` 共享行语义（`repositories.ts:4218` 先例）。若 tsc 对 `ctx as PostgresDbContext` 收窄报错，改用 `if (ctx.backend === 'postgres')` 分支内 `const pg: PostgresDbContext = ctx;`（DbContext 是二者 union，pattern 先例 `repositories.ts:4182`）。

- [ ] **Step 5: 跑测试确认通过**

Run: `npm test --workspace apps/server -- test/ontology/`
Expected: PASS（repo.test.ts + tables.test.ts + registry.test.ts 全绿）

- [ ] **Step 6: 提交**

```bash
git add apps/server/src/ontology/asof.ts apps/server/src/ontology/repo.ts apps/server/test/ontology/repo.test.ts
git commit -m "feat(ontology): as-of 双时间轴谓词 + 双后端仓储(写入边界 zod 校验/红冲三问三答)"
```

---

### Task 4: toolOntologyMap 工具词汇门禁接入 CI

**Files:**
- Create: `apps/server/src/ontology/toolOntologyMap.ts`
- Modify: `apps/server/test/harness/toolInventory.test.ts`（文件末尾追加一个 `it`）
- Test: `apps/server/test/ontology/toolOntologyMap.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `SHARED_TOOL_FIELD_NAMES` / `entityFieldNames` / `OntologyEntityName`；`getToolsForRole('trader', { ctx })`（取已挂载工具与其 `inputSchema.shape`，先例 `toolInventory.test.ts:115-117`、`test/graph/tools.test.ts:13-40`）
- Produces:
  - `toolOntologyMap: Readonly<Record<string, { entities: readonly OntologyEntityName[]; note: string }>>`——已映射工具清单（3 个 L2 工具）
  - `toolFieldsViolations(toolName: string, fields: readonly string[]): string[]`——纯函数，返回不在词汇表内的字段名（空数组=合规）

- [ ] **Step 1: 写失败测试** `apps/server/test/ontology/toolOntologyMap.test.ts`

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import { getToolsForRole } from '../../src/harness/roleToolRegistry.js';
import {
  toolOntologyMap, toolFieldsViolations,
} from '../../src/ontology/toolOntologyMap.js';

let ctx: DbContext;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
});

describe('toolOntologyMap vocabulary gate', () => {
  it('maps exactly the three L2 demo tools from the roadmap', () => {
    expect(Object.keys(toolOntologyMap).sort()).toEqual(['bind_document', 'create_entity', 'link_entities']);
  });

  it('mapped tools are actually mounted for trader', () => {
    const names = getToolsForRole('trader', { ctx }).map((t) => t.name);
    for (const name of Object.keys(toolOntologyMap)) {
      expect(names, `${name} mapped but not mounted`).toContain(name);
    }
  });

  it('every real inputSchema field of the mapped tools passes the gate', () => {
    const tools = getToolsForRole('trader', { ctx });
    for (const [name] of Object.entries(toolOntologyMap)) {
      const t = tools.find((x) => x.name === name)!;
      const fields = Object.keys((t.inputSchema as { shape: Record<string, unknown> }).shape);
      expect(toolFieldsViolations(name, fields),
        `${name} fields outside vocabulary`).toEqual([]);
    }
  });

  it('acceptance 3 demo: a field missing from the registry turns the gate red', () => {
    // 给 create_entity 假设加一个注册表不存在的字段 => 必须被拦截
    expect(toolFieldsViolations('create_entity', ['kind', 'name', 'props', 'bogus_field']))
      .toEqual(['bogus_field']);
    expect(toolFieldsViolations('bind_document', ['documentId', 'contractNo', 'relation', 'confidence', 'sourceSpan']))
      .toEqual([]);
    expect(toolFieldsViolations('link_entities', ['srcId', 'dstId', 'kind', 'props', 'confidence', 'sourceSpan']))
      .toEqual([]);
  });

  it('unmapped tools are ignored (mapping is opt-in)', () => {
    expect(toolFieldsViolations('graph_query', ['subject', 'depth'])).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/ontology/toolOntologyMap.test.ts`
Expected: FAIL（`Cannot find module '../../src/ontology/toolOntologyMap.js'`）

- [ ] **Step 3: 写实现** `apps/server/src/ontology/toolOntologyMap.ts`

```ts
// 工具-本体映射与词汇门禁（roadmap Item 2: 映射示范 3 个既有 L2 工具）。
// 语义: 已映射工具的 inputSchema 顶层字段必须 ∈ (映射实体的字段集 ∪ 共享词汇)。
// 目的与 tool-inventory 双射门禁一致——工具输入面不能绕开本体词汇悄悄膨胀;
// 新字段先落注册表(实体 schema 或 SHARED_TOOL_FIELD_NAMES)再上工具。
import { entityFieldNames, SHARED_TOOL_FIELD_NAMES, type OntologyEntityName } from './index.js';

export interface ToolOntologyMapping {
  /** 该工具触碰的本体实体; 空数组=纯结构/共享词汇工具 */
  entities: readonly OntologyEntityName[];
  note: string;
}

export const toolOntologyMap: Readonly<Record<string, ToolOntologyMapping>> = {
  create_entity: {
    entities: ['TradeContract', 'TradeGoods', 'Counterparty', 'OrgUnit'],
    note: '图谱手工补图(Neo4j 层); 输入词汇与 4 静态实体对齐, kind/name/props 属共享词汇',
  },
  link_entities: {
    entities: [],
    note: '结构字段(srcId/dstId/kind/props/confidence/sourceSpan)全部属共享词汇; 业务关系优先走带 SSOT 的 bind/link',
  },
  bind_document: {
    entities: ['TradeContract'],
    note: '单据-合同绑定; contractNo 属 TradeContract 词汇, documentId/relation 属共享引用词汇',
  },
};

const SHARED = new Set<string>(SHARED_TOOL_FIELD_NAMES);

/** 返回不在词汇表内的字段名列表(空=合规)。未映射工具恒为空(映射 opt-in)。 */
export function toolFieldsViolations(toolName: string, fields: readonly string[]): string[] {
  const mapping = toolOntologyMap[toolName];
  if (!mapping) return [];
  const allowed = new Set<string>(SHARED);
  for (const e of mapping.entities) {
    for (const f of entityFieldNames(e)) allowed.add(f);
  }
  return fields.filter((f) => !allowed.has(f));
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test --workspace apps/server -- test/ontology/toolOntologyMap.test.ts`
Expected: PASS

- [ ] **Step 5: 接入 CI 门禁——`apps/server/test/harness/toolInventory.test.ts` 顶部补 import、文件末尾（最后一个 `it` 之后、`describe` 收尾之前）追加断言**

顶部 import 区追加：

```ts
import { toolOntologyMap, toolFieldsViolations } from '../../src/ontology/toolOntologyMap.js';
```

`describe('tool inventory gate', ...)` 内最后一个 `it` 之后追加：

```ts
  it('toolOntologyMap: mapped tools stay inside the ontology vocabulary', () => {
    const ctx = createDb(':memory:');
    migrate(ctx.sqlite);
    const tools = getToolsForRole('trader', { ctx });
    expect(Object.keys(toolOntologyMap).length, 'demo mapping: exactly 3 tools').toBe(3);
    for (const name of Object.keys(toolOntologyMap)) {
      const t = tools.find((x) => x.name === name);
      expect(t, `${name} is mapped in toolOntologyMap but not mounted for trader`).toBeDefined();
      const fields = Object.keys((t!.inputSchema as { shape: Record<string, unknown> }).shape ?? {});
      const violations = toolFieldsViolations(name, fields);
      expect(violations,
        `${name} inputSchema fields outside the ontology registry vocabulary: ${violations.join(', ')} ` +
        '(add them to the entity schema or SHARED_TOOL_FIELD_NAMES in src/ontology/index.ts first)').toEqual([]);
    }
  });
```

- [ ] **Step 6: 跑 CI 门禁测试确认通过（含既有断言无回归）**

Run: `npm test --workspace apps/server -- test/harness/toolInventory.test.ts`
Expected: PASS（6+1 个用例全绿；bijection/blacklist/metadata/gating/scenario 无回归）

- [ ] **Step 7: 提交**

```bash
git add apps/server/src/ontology/toolOntologyMap.ts \
  apps/server/test/ontology/toolOntologyMap.test.ts apps/server/test/harness/toolInventory.test.ts
git commit -m "test(ontology): toolOntologyMap 工具词汇门禁(3 个 L2 工具映射示范接入 CI)"
```

---

### Task 5: AGENTS.md 本体基座节 + 全量验证 + 合并 main

**Files:**
- Modify: `AGENTS.md`（「## Tool design methodology」节之后、「## When docs conflict with code」之前插入新节）
- 无新测试（本任务是文档 + 验证收口）

**Interfaces:**
- Consumes: Task 1-4 全部产出（文档引用其路径与扩展方法）
- Produces: AGENTS.md「本体基座」节（后续 Item 3/4/5/6 计划编写时的 recon 锚点）

- [ ] **Step 1: 前置检查——确认 merge 后的 AGENTS.md 结构**

```bash
grep -n "^## " AGENTS.md
# 找到 "## Tool design methodology" 与 "## When docs conflict with code" 的行号,
# 新节插在两者之间; 若标题有变(merge 带来的改动), 等价插入到工具治理相关章节之后。
```

- [ ] **Step 2: 写入新节（内容如下，路径/函数名与 Task 1-4 实际产出严格一致）**

```markdown
## 本体基座 ontology foundation

- 注册表 SSOT：`apps/server/src/ontology/index.ts`——纯 zod 单文件（只 import zod，无 node 内建，前端可消费；Item 3 经 `GET /api/ontology/schema` 返回 `ontologySchemaJson()`）。11 实体（4 静态 + 7 事件）+ 8 关系类型/14 连接对（docx 方案 §5 定稿；roadmap 的"9 关系"= 4 核心 + 5 辅助连接语义口径）+ 闭枚举 PayType/EventBizType/AllocateMethod（商品码 v1 开放词汇 `COMMODITY_CODES`，待业务确认后转闭枚举）+ 双时间轴字段（validAt/invalidAt/ingestedAt）+ meaning URI 机制（`MEANING_URIS` 只挂已确认条目）。领域变更上游 SSOT：`本体建模技术备忘.md` §3（其上游为 docs/ 下 docx 方案）。
- 数据表：`ontology_edges`（带参关系边）与 `trade_facts`（事件事实通用表，entity_type 判别 + payload zod 校验；spec 决策理由见 plans/2026-09-07-ontology-foundation.md），双后端列对列镜像（SQLite raw DDL 在 `pipeline/db/client.ts migrate()`；PG raw DDL 在 `migratePostgres()` + drizzle twin 在 `postgres-schema.ts`）。时间列 UTC ISO（SQLite TEXT 字典序=时间序）。
- as-of 查询：`asOfBusinessTime(t)` / `asOfSystemTime(t)`（`src/ontology/asof.ts`，语义=技术备忘 §4：业务时间=当时为真，系统时间=当时知道什么，月报复现走后者）。
- 写入边界：`insertTradeFact` / `insertOntologyEdge`（`src/ontology/repo.ts`）——payload/params 走注册表 zod 校验（含"逆向=负数金额"语义规则），关系连接对白名单校验；不要绕过直写 SQL。
- 工具词汇门禁：`toolOntologyMap`（`src/ontology/toolOntologyMap.ts`）——已映射工具的 inputSchema 字段必须 ∈ 实体字段 ∪ `SHARED_TOOL_FIELD_NAMES`，CI 断言在 `test/harness/toolInventory.test.ts`。
- 扩展方法：新增实体/关系/枚举值只改注册表单文件（Item 3 台账列表自动多列）；给工具加输入字段先在注册表登记词汇（实体 schema 或共享词汇表），CI 会拦未登记字段。
```

- [ ] **Step 3: 全量验证（约定顺序，仓库根）**

```bash
npm run build && npm run lint && npm test
```

Expected: 三段全绿。重点确认：
- `tsc` 严格模式对 `as const satisfies` / union 收窄无报错
- 新测试文件（registry/tables/repo/toolOntologyMap）全绿；toolInventory/postgres.integration 无回归
- lint（oxlint）对新增文件无告警

- [ ] **Step 4: 提交 + 合并 main + push**

```bash
git add AGENTS.md
git commit -m "docs(agents): 本体基座一节(注册表/表/as-of/写入边界/扩展方法)"

# 合并回 main（约定: 验证绿后 merge 并 push, 触发 CI+CD 到 10.10.0.2）
git fetch origin main
git merge origin/main   # 若有冲突解决后重跑 Step 3 验证
git push origin HEAD:PengYip/架构设计
git push origin HEAD:main
```

注意：push main 前 Watch CI（自托管 runner；GitHub 出入站走 ubuntu-server 的 mihomo 代理，CI 超时先查 `curl -s http://127.0.0.1:9091/proxies/AUTO`，见 AGENTS.md）。CD 会把 migratePostgres 的新表幂等建到 10.10.0.2 的 sca 库——`CREATE TABLE IF NOT EXISTS` 对已有数据零影响。

---

## 验收对照（spec Item 2 -> 本计划）

| spec 验收 | 覆盖 |
|---|---|
| 1. 注册表单文件可被前端与 CI 消费；新增实体只改该文件 | Task 1（纯度测试 + `ontologySchemaJson` + 全部定义集中在单文件） |
| 2. 边表/事实表双后端幂等建表；as-of 双查询语义有单测（红冲追溯） | Task 2（双后端 DDL + 幂等测试 + PG 列镜像断言）+ Task 3 Step 1（三问三答） |
| 3. CI 断言：工具 inputSchema 加注册表外字段 -> 测试红 | Task 4（`bogus_field` 演示用例 + toolInventory.test.ts 接入） |
| 4. build/lint/test 全绿 | Task 5 Step 3（+每任务内验证步骤） |

spec IN 清单其余项：zod 注册表（Task 1）、带参边表（Task 2）、trade_facts 决策（设计决策 #1）、as-of helper（Task 3）、CI 扩展与映射示范（Task 4）、AGENTS.md 增补（Task 5）。spec OUT 边界（Cube/Graphiti/全量词汇/实体数据迁移）本计划零触碰。

## Self-Review 记录

- 占位符扫描：无 TBD/TODO；Task 2 Step 7 的 PG 集成测试嵌入点标注了「以文件实际 skip 写法为准做等价嵌入」并给出前置检查步骤（该文件在 HEAD 与 origin/main 间无 diff，已核对 1-80 行结构）——这是允许的既有签名适配，非占位。
- 类型一致性：`entityFieldNames`/`SHARED_TOOL_FIELD_NAMES`/`toolFieldsViolations`/`AsOfPredicate` 在 Task 1/3/4 间签名一致；表列集在 Task 2 DDL、Task 3 `FACT_COLS/EDGE_COLS`、Task 2 测试三处一致；id 前缀 TF-/OE- 与测试断言一致。
- spec 覆盖：见上表；「或按实体分表——计划编写时决策并写明理由」已在设计决策 #1 落实。
