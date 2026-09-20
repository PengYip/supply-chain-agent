# 本体业务闭环 Wave 2（实体化一跳）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 单据确认/绑定确认/结算确认后自动实体化为本体事实（trade_facts）+ ALLOCATE_TO 归属边（ontology_edges）+ Neo4j 投影——消灭闭环最大断点"管线不写本体"。

**Architecture:** 映射源以 `execution_flows` 为主（confirmed 绑定驱动、flow_type×direction 已类型化），`settlement_records` 直连 SettlementEvent，extraction 最新行仅作补充字段（仓库/发票号/款项类型关键词）。幂等=两源表各加 `ontology_fact_id` 写回列。新模块 `pipeline/ontologyMaterialize.ts` 自包含映射与写入（全部经既有写入边界 insertTradeFact/insertOntologyEdge），三族确认钩子 fire-and-forget。spec 裁决 W2-A/B/C/D（2026-09-20 修订节）。

**Tech Stack:** TypeScript 严格模式 / zod / better-sqlite3 / node-postgres / drizzle-orm（twin）/ vitest / tsx（回填脚本）。

**Spec:** `docs/superpowers/specs/2026-09-20-ontology-business-loop-design.md` §3 Wave 2（2026-09-20 修订节，裁决 W2-A~W2-D）。

---

## Global Constraints

- 验证顺序 `npm run build && npm run lint && npm test`（仓库根）；单测先 `npm test --workspace apps/server -- test/ontology/ test/pipeline/`
- 代码零 emoji；`ontology/index.ts` 只 import zod
- **不新增 agent 工具、不新增 HTTP 路由**（回填走 tsx 脚本，沿 backfillEmbeddings 先例）
- 本体写入只经 `ontology/repo.ts` 写入边界（entitySchema strict / 连接对白名单 / params strict）——materializer 不得直写 trade_facts/ontology_edges
- 钩子一律 fire-and-forget：materializer 的 safe 包装永不抛出（复刻 syncOntologyGraphSafe 模式），图投影在 materialize 成功后内部触发
- 注册表变更（Task 1）：版本升 `2026-09-20-loop-v3` + 指纹重生成（win32 用 .ts 后缀修正版命令）
- 分支：PengYip/tools-grouping（基线=origin/main 269e4c2）；每任务验证绿后 commit；Wave 末统一合并 push（已获授权）

## 摸底结论（2026-09-20 exp-2 定向 recon，行号已核实）

- **确认路径**：`routes/review.ts` `POST /:docId/review` 确认分支 :158-169（setReviewOutcome :164 → commitDocumentGraph :165）；批量 `POST /:docId/review-batch` :706-783（逐条 :760-770，try/catch 故障隔离 :762-769）。
- **execution_flows**：DDL `db/client.ts:245-267`（binding_id/document_id/contract_no/flow_type(资金流|货物流|发票流)/direction(in|out)/amount/quantity_*/unit/doc_type/voucher_date/extraction_id/confidence，UNIQUE(binding_id,user_id)）；物化钩子=bind_document（documentEntry.ts:2553/:2577）与 refreshExecutionFlowsForDocument（review.ts:154/:502、documentEntry.ts:2725）。
- **settlement_records**：DDL `db/client.ts:273-291`（含 contract_no/**contract_ledger_id**/settled_quantity/total_amount/currency/status）；唯一写入口=confirm_settlement（settlementTools.ts:201 insertSettlementRecord），无图投影。
- **extractions**：append 新行，读侧 `loadLatestExtractionByDocId` 取最新；fields 中文键（仓库类如「仓库」、发票类如「发票号码/号码」、款项类关键词在值文本里）。
- **合同行解析**：ALLOCATE_TO 的 to 侧=contract_ledger 行 id（linkTools 先例）；execution_flows 只有 contract_no——用 repositories 既有按 contract_no 查台账的函数（实施时 rg 定位；无则沿 USER_SCOPE 直 SELECT id）。
- **fire-and-forget 先例**：`void syncOntologyGraphSafe(...)`（eventTools.ts:70-71 等 6 处）。
- **回填先例**：`extractionBackfill.ts`（boot 时跑）+ `backfill:embeddings` = `tsx scripts/backfillEmbeddings.ts`（package.json scripts :14-16）。

---

### Task 1: 注册表修订——ALLOCATE_TO 数量归属（W2-D，版本 v3）

**Files:**
- Modify: `apps/server/src/ontology/index.ts`（ALLOCATE_TO params + 版本常量）
- Modify: `apps/server/src/ontology/linkTools.ts`（description 两处文案）
- Test: `apps/server/test/ontology/registry.test.ts`

**Interfaces:**
- Produces: ALLOCATE_TO params = `{amount?, quantity?, ratio?, method, batch?}`（plain z.object，**不用 superRefine**——OntologyRelationDef.params 类型是 z.ZodObject，ontologySchemaJson 消费 .shape；"至少其一"约束由写入方保证并在 describe 声明）；`ONTOLOGY_SCHEMA_VERSION = '2026-09-20-loop-v3'`。

- [ ] **Step 1: 失败测试**（registry.test.ts 追加）

```ts
it('W2-D: ALLOCATE_TO supports quantity-based attribution', () => {
  expect(() => relationDef('ALLOCATE_TO').params.parse({ amount: 15000, method: '金额' })).not.toThrow();
  expect(() => relationDef('ALLOCATE_TO').params.parse({ quantity: 620, method: '数量' })).not.toThrow();
  expect(() => relationDef('ALLOCATE_TO').params.parse({ method: '定额' } as never)).not.toThrow(); // 注册表不硬拦, 写入方保证
  expect(() => relationDef('ALLOCATE_TO').params.parse({ quantity: 620 })).toThrow(); // method 仍必填
});
it('W2-D: schema version bumped to loop-v3', () => {
  expect(ONTOLOGY_SCHEMA_VERSION).toBe('2026-09-20-loop-v3');
});
```

- [ ] **Step 2: 跑红** `npm test --workspace apps/server -- test/ontology/registry.test.ts`
- [ ] **Step 3: 实现**——index.ts：版本常量改 `'2026-09-20-loop-v3'`；ALLOCATE_TO params 替换为：

```ts
    params: z.object({
      amount: z.number().optional().describe('分摊金额(金额归属时与 method=金额 搭配)'),
      quantity: z.number().optional().describe('归属数量(business-loop W2-D: 数量归属, 如 收货 620 吨; 与 method=数量 搭配)'),
      ratio: z.number().min(0).max(1).optional().describe('分摊比例'),
      method: AllocateMethod.describe('分摊方式: 金额/数量/重量/定额'),
      batch: z.string().optional().describe('批次'),
    }).strict(),
```

linkTools.ts description：'参数必须匹配关系定义（分摊必须 amount+method…' → '分摊须 amount 或 quantity 其一 + method'（两处提及处同步）。
- [ ] **Step 4: 指纹重生成**（.ts 修正版命令，workdir apps/server）
- [ ] **Step 5: 跑绿 + commit** `feat(ontology): ALLOCATE_TO quantity attribution + version v3 (business-loop wave2)`

---

### Task 2: 幂等写回列（W2-B）

**Files:**
- Modify: `apps/server/src/pipeline/db/client.ts`（migrate 守卫 ALTER + migratePostgres statements）
- Modify: `apps/server/src/pipeline/db/postgres-schema.ts`（executionFlows/settlementRecords twin 加列）
- Test: `apps/server/test/ontology/tables.test.ts`（列镜像断言）

**Interfaces:**
- Produces: `execution_flows.ontology_fact_id TEXT NULL`、`settlement_records.ontology_fact_id TEXT NULL`（双后端 + drizzle twin `ontologyFactId: text('ontology_fact_id')`）。NULL=未实体化；非空=已产事实且可溯源。

- [ ] **Step 1: 失败测试**（tables.test.ts 沿既有列断言范式追加两表 ontology_fact_id）
- [ ] **Step 2: 跑红**
- [ ] **Step 3: 实现**——client.ts migrate 在 Wave1 schema_version 守卫块后追加同款：

```ts
  // business-loop Wave 2(W2-B): 实体化幂等写回列——materializer 产事实后回写 fact id。
  for (const tbl of ['execution_flows', 'settlement_records']) {
    const cols = sqlite.prepare(`PRAGMA table_info(${tbl})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'ontology_fact_id')) {
      try { sqlite.exec(`ALTER TABLE ${tbl} ADD COLUMN ontology_fact_id TEXT`); } catch { /* concurrent */ }
    }
  }
```

migratePostgres statements 追加 `ALTER TABLE execution_flows ADD COLUMN IF NOT EXISTS ontology_fact_id TEXT` 与 settlement_records 同款；postgres-schema.ts 两表 twin 加 `ontologyFactId: text('ontology_fact_id'),`。
- [ ] **Step 4: 跑绿（含全量 tables 测试）+ commit** `feat(pipeline): ontology_fact_id writeback columns on flows/settlements (business-loop wave2)`

---

### Task 3: 实体化映射器（核心）

**Files:**
- Create: `apps/server/src/pipeline/ontologyMaterialize.ts`
- Test: `apps/server/test/pipeline/ontologyMaterialize.test.ts`

**Interfaces:**
- Consumes: `insertTradeFact/insertOntologyEdge`（repo）、`ONTOLOGY_ENTITIES` 类型、`syncOntologyGraphSafe`、`loadLatestExtractionByDocId`（repositories，函数名以实际为准）。
- Produces（Task 4/5 依赖）:
  - `materializeDocumentOntology(ctx, docId, userId?): Promise<MaterializeResult>`——扫描该文档 execution_flows（ontology_fact_id IS NULL）逐条实体化
  - `materializeSettlementRecord(ctx, record, userId?): Promise<{ factId: string | null }>`——settlement_records 行直连 SettlementEvent
  - `materializeDocumentOntologySafe(ctx, docId, userId?): Promise<void>`——永不抛出；成功后内部 fire-and-forget `syncOntologyGraphSafe`
  - `MaterializeResult = { attempted, created, edges, skippedPayment, skippedInvoice, skippedNoMap, skippedNoContract, failures: string[] }`

- [ ] **Step 1: 失败测试**（沿 :memory: + migrate 范式；fixture 直插 contract_ledger/execution_flows/extractions 行，列以 client.ts DDL 为准）

```ts
describe('ontologyMaterialize (wave2)', () => {
  function seedFlow(over: Record<string, unknown>) { /* INSERT execution_flows: id/document_id/binding_id/contract_no/flow_type/direction/amount/quantity_ton(实际列名以 DDL 为准)/unit/doc_type/voucher_date + ontology_fact_id NULL */ }
  it('货物流 in -> GoodsReceiptEvent + ALLOCATE_TO(quantity) edge + fact_id 回写', async () => {
    // contract_ledger 一行 + seedFlow({flow_type:'货物流', direction:'in', quantity_ton:620, unit:'吨'})
    const r = await materializeDocumentOntology(ctx, 'doc-1', 'u1');
    expect(r.created).toBe(1); expect(r.edges).toBe(1);
    const fact = await getTradeFactById(ctx, /* 取回 */);
    expect(fact?.entityType).toBe('GoodsReceiptEvent');
    expect(fact?.documentId).toBe('doc-1');
    // flow 回写非空; 重跑幂等:
    const r2 = await materializeDocumentOntology(ctx, 'doc-1', 'u1');
    expect(r2.created).toBe(0);
  });
  it('资金流 out 无款项类型关键词 -> skippedPayment 且不产事实', async () => { ... });
  it('资金流 out + extraction 含"预付" -> PaymentEvent(payType=预付)', async () => { ... });
  it('发票流 in 无发票号 -> skippedInvoice', async () => { ... });
  it('发票流 out + extraction 发票号码 -> InvoiceEvent(销项)', async () => { ... });
  it('合同台账无行 -> 事实产出但边跳过(skippedNoContract)', async () => { ... });
  it('settlement_records 直连 -> SettlementEvent + 边 + 回写', async () => { ... });
  it('safe 包装吞错', async () => { /* 注入 throw 的 ctx 槽位或坏数据 */ });
});
```

- [ ] **Step 2: 跑红**
- [ ] **Step 3: 实现**——模块骨架（完整逻辑，函数名/列名按实际微调）：

```ts
// business-loop Wave 2: execution_flows/settlement_records -> 本体事实+归属边。
// 铁律: 本体写入只经 repo 写入边界; safe 包装永不抛(钩子 fire-and-forget);
// 跳过计数不造假数据(W2-C: payType/invoiceNo 解析不到就跳)。
import type { DbContext } from './db/client.js';
import { insertTradeFact, insertOntologyEdge } from '../ontology/repo.js';
import { syncOntologyGraphSafe } from '../ontology/graphSync.js';
import type { OntologyEntityName } from '../ontology/index.js';

const FLOW_ENTITY: Record<string, Partial<Record<'in' | 'out', OntologyEntityName>>> = {
  货物流: { in: 'GoodsReceiptEvent', out: 'GoodsDeliveryEvent' },
  发票流: { in: 'InvoiceEvent', out: 'InvoiceEvent' },
  资金流: { out: 'PaymentEvent', in: 'CollectionEvent' },
};
const PAY_TYPE_KEYWORDS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['预付', ['预付']], ['尾款', ['尾款']], ['进度款', ['进度款', '进度']], ['质保金', ['质保金', '质保']],
];

export interface MaterializeResult { attempted: number; created: number; edges: number; skippedPayment: number; skippedInvoice: number; skippedNoMap: number; skippedNoContract: number; failures: string[]; }
```

  主流程：读 flows（document_id + user 口径 + fact_id IS NULL）→ 每条：entity=FLOW_ENTITY[flow_type][direction]（null→skippedNoMap）→ 读最新 extraction 补充字段 → payload 构建器（严格匹配 entitySchema：amount+currency 成对、币种缺省 'CNY'、eventBizType '正向'）→ 跳过规则（PaymentEvent 无 payType→skippedPayment；InvoiceEvent 无 invoiceNo→skippedInvoice）→ `insertTradeFact({entityType, payload, validAt: voucher_date ?? new Date(), createdBy:'materializer', documentId})` → 合同行解析（按 contract_no，沿 USER_SCOPE）→ 有则 `insertOntologyEdge({relation:'ALLOCATE_TO', fromType:entity, fromId:factId, toType:'TradeContract', toId:台账行id, params: amount!=null?{amount,method:'金额'}:{quantity,method:'数量'}, validAt, createdBy:'materializer'})` → 回写 `UPDATE execution_flows SET ontology_fact_id=?`。末尾统计返回。
  `materializeSettlementRecord`：`insertTradeFact({entityType:'SettlementEvent', payload:{eventBizType:'正向', amount:record.total_amount, currency:record.currency ?? 'CNY', settledQuantity:record.settled_quantity ?? undefined, contractNo:record.contract_no}, validAt:record.created_at, createdBy:'materializer', documentId:null})` + ALLOCATE_TO(amount) 边（toId=record.contract_ledger_id）+ 回写。
  `materializeDocumentOntologySafe`：try/catch warn 全吞，成功路径末尾 `void syncOntologyGraphSafe(ctx, userId)`。
- [ ] **Step 4: 跑绿 + commit** `feat(pipeline): ontology materializer from execution flows and settlements (business-loop wave2)`

---

### Task 4: 三族确认钩子

**Files:**
- Modify: `apps/server/src/routes/review.ts`（:164/:165 后 + :760 批量 + :154/:502 refresh 处）
- Modify: `apps/server/src/pipeline/tools/documentEntry.ts`（bind_document :2553/:2577 后）
- Modify: `apps/server/src/pipeline/tools/settlementTools.ts`（confirm_settlement :201 后）
- Test: `apps/server/test/pipeline/ontologyMaterialize.test.ts`（钩子层用集成式用例：直接调 materialize 函数已覆盖；本任务测试聚焦"确认路由触发"最小一条——沿 review 路由既有测试范式，若无既有范式则以 materializer 测试 + 类型检查为准并在报告注明）

**Interfaces:**
- Consumes: Task 3 的 safe 包装。
- 挂点（每处一行，`void` 前缀）：确认单条、批量逐条、bind_document 两处、refreshExecutionFlowsForDocument 两处、confirm_settlement（用 materializeSettlementRecord 的 safe 版——Task 3 补 `materializeSettlementRecordSafe`）。

- [ ] **Step 1: 实现**（六处挂点，每处 `void materializeDocumentOntologySafe(ctx, docId, userId)` 或 settlement 版）
- [ ] **Step 2: 跑绿（全量）+ commit** `feat(pipeline): confirmation hooks materialize ontology facts (business-loop wave2)`

---

### Task 5: 回填脚本

**Files:**
- Create: `apps/server/scripts/backfillOntology.ts`
- Modify: `apps/server/package.json`（scripts 加 `"backfill:ontology": "tsx scripts/backfillOntology.ts"`）

**Interfaces:**
- Consumes: `materializeDocumentOntology`（按 document_id 分组调用）、`materializeSettlementRecord`。
- CLI：`--dry-run`（只数不写：统计将处理的 flow/记录数与跳过预估，不落库不回写）、`--limit N`（默认 200）。

- [ ] **Step 1: 实现**（沿 backfillEmbeddings 脚本结构：env 加载、getDbContext、分组扫描、计数打印、退出码）
- [ ] **Step 2: 本地验证**——`npm run backfill:ontology --workspace apps/server -- --dry-run`（本地 SQLite 空库跑通退出码 0）
- [ ] **Step 3: 跑绿（全量回归）+ commit** `feat(pipeline): backfill:ontology script with dry-run (business-loop wave2)`

---

### Task 6: 收口（已获授权自动执行）

- [ ] **Step 1**: 全量 `npm run build && npm run lint && npm test`
- [ ] **Step 2**: dev 库回填实跑——部署后 `ssh ubuntu-server`（nvm PATH 先行）`cd ~/supply-chain-agent && npm run backfill:ontology -- --dry-run` 人工核对量级后去 dry-run 实跑，`POST /api/ontology/graph/sync` 收敛图
- [ ] **Step 3**: 合并推送——`git fetch origin main && git merge origin/main` → 重验证 → `git push origin HEAD:PengYip/tools-grouping && git push origin HEAD:main`（CI/CD 自动部署）
- [ ] **Step 4**: spec 实施记录回填 + commit

## Self-Review

- Spec 覆盖：W2-A（映射源+词表）=T3；W2-B（幂等列）=T2；W2-C（跳过策略）=T3 跳过规则与测试；W2-D（params 修订+版本 v3）=T1；触发三族=T4；回填=T5；闭环验收"录入即入谱"=T4+T6 实跑。
- 类型一致性：MaterializeResult 字段在 T3 定义、T5 消费打印；materializeSettlementRecord(Safe) 在 T3 产出、T4 settlement 钩子消费。
- 占位符：fixture 的 quantity 列名（quantity_ton vs 其他）与 loadLatestExtractionByDocId 函数名标注"以实际为准微调"——实施者首步 rg 定位。
