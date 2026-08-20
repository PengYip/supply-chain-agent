# 项目维度与合同类型细分 实现计划（2026-08-20）

> Spec: `docs/superpowers/specs/2026-08-20-project-dimension-design.md`（§ 号在文中引用）
> 执行者: agentic workers（Claude Code 子任务）。每个 Task 自含：失败测试 → 实现 → 通过 → 提交。

## Goal

给合同增加主体视角的**合同类型**维度（采购/销售/物流/租赁/服务/其他），引入**项目**实体并以 `project_memberships` 为 SSOT 建立合同↔项目归属，最终以 `projectRollup` 提供按项目統一的统计视图（销售+采购+执行流水+指标+校验），并通过 API / Web 工作台 / Agent 工具三个入口暴露。

## Architecture

三层不变式（spec §1）：

1. **关系库是 SSOT，图是投影视图**。`projects` / `project_memberships` 落 SQLite/PG；Neo4j 上的 `part_of` / `counterparty` / `participates` 全部由同步器派生，图不可达绝不阻塞业务。
2. **contractType 与 docType 正交**。docType（八类路由词表）不动；contractType 是合同上的受控属性，由纯函数 `deriveContractType` 派生（字段 > 非方向标题关键词 > 主体侧别 > 方向关键词），同一函数在台账写回、快照展示、图提交三处消费，保证不漂移。
3. **报表不依赖图**。`rollupProject` 只读关系库（memberships + contract_ledger + execution_flows），Neo4j 宕机不影响统计。

## Tech Stack

既有栈（Vite+React 19 / Hono+AI SDK 6 / better-sqlite3 + PG 双胞胎 / Neo4j / vitest / oxlint），不引入新依赖。

## Global Constraints

- **AI SDK 6**: 工具 schema 字段是 `inputSchema`（不是 v5 的 `parameters`）。
- **Neo4j assertToken**: label/relType 只能 `[A-Za-z_][A-Za-z0-9_]*` —— 英文标识（`Project` / `part_of` / `counterparty` / `participates`），中文只进 props。
- **双后端孪生**: repositories 的每个改动都要 SQLite 实现 + `postgres-repositories.ts` PG 孪生 + `client.ts` 两侧 DDL。SQLite 用 guarded `ALTER`（`PRAGMA table_info` 探测），PG 用 `ADD COLUMN IF NOT EXISTS`。
- **DDL 真源**: 新表（`projects` / `project_memberships`）的 DDL 只写在 `client.ts` 的 `migrate()` / `migratePostgres()`（raw SQL），**不进** drizzle `schema.ts`（与 contract_ledger / execution_flows 同例）。
- **故障隔离**: 图同步、项目提议等旁路钩子 try/catch + `console.error/warn`，绝不影响录入/确认主流程；返回 `{status:'ok'|'skipped'|'failed', reason?, syncedAt?}`（复用 `BindingGraphStatus`）落 `graph_status` 列。
- **不引入循环依赖**: `repositories.ts` 不能 import `executionFlow.ts`（后者依赖前者）；快照侧主体名单用本地 helper（`parseSelfPartyNames(env.SELF_PARTY_NAMES)` + `listSelfParties`）。`documentEntry.ts` / `projectGraphSync.ts` / `projectRollup.ts`（pipeline 层）可以 import `executionFlow.ts`。
- **代码中不加 emoji**；注释/文案中文，标识符英文。
- 每任务收尾: 根目录 `npm run build && npm run lint && npm test`；单测加速用 `npm test --workspace apps/server -- test/<路径>`。
- 每任务一次提交（`feat:` + 中文摘要），`git add` 只加本任务文件。**不重复启动前端服务器进程**（web 验证用 build，不起 dev）。
- 测试里需要主体名单时优先 `addSelfParty(ctx, ...)` 种数据，不要 stub `env`（env 在 import 时定型）。

---

## Phase 1: 合同类型（contractType）维度

### Task 1 词表扩展 + `deriveContractType` 纯函数

**Files**
- `apps/server/src/domain/tradeSemantics.ts`（改）
- `apps/server/src/domain/contractType.ts`（新）
- `apps/server/test/domain/contractType.test.ts`（新）

**Steps**

1. [ ] 写失败测试 `apps/server/test/domain/contractType.test.ts`（覆盖矩阵）：

```ts
import { describe, expect, it } from 'vitest';
import { deriveContractType } from '../../src/domain/contractType.js';

const F = (name: string, value: string | number) => ({ name, value });

describe('deriveContractType', () => {
  it('非合同 docType 一律 null', () => {
    const r = deriveContractType({ docType: '发票', fields: [F('合同类型', '销售合同')], selfPartyNames: ['我方'] });
    expect(r).toEqual({ contractType: null, source: null, conflict: false });
  });

  it('合同类型字段命中别名映射 -> field 来源', () => {
    const r = deriveContractType({ docType: '合同', fields: [F('合同类型', '运输合同')], selfPartyNames: [] });
    expect(r.contractType).toBe('物流');
    expect(r.source).toBe('field');
  });

  it('字段是受控值本身时直接采用', () => {
    const r = deriveContractType({ docType: '合同', fields: [F('合同类型', '租赁')], selfPartyNames: [] });
    expect(r.contractType).toBe('租赁');
    expect(r.source).toBe('field');
  });

  it('购销合同不映射(无方向语义), 回退主体侧别', () => {
    const r = deriveContractType({
      docType: '合同',
      fields: [F('合同类型', '购销合同'), F('甲方', '我方贸易'), F('乙方', '某供应商')],
      selfPartyNames: ['我方贸易'],
    });
    // 甲方=主体 -> buyer -> 采购; 购销合同字段不产生 fieldType, 不算冲突
    expect(r).toEqual({ contractType: '采购', source: 'side', conflict: false });
  });

  it('字段与主体侧别方向相反 -> conflict 标记, 字段胜出', () => {
    const r = deriveContractType({
      docType: '合同',
      fields: [F('合同类型', '销售合同'), F('买方', '我方贸易'), F('卖方', '某厂')],
      selfPartyNames: ['我方贸易'],
    });
    expect(r.contractType).toBe('销售');
    expect(r.source).toBe('field');
    expect(r.conflict).toBe(true);
  });

  it('非方向类型不参与冲突判定', () => {
    const r = deriveContractType({
      docType: '合同',
      fields: [F('合同类型', '物流合同'), F('买方', '我方贸易'), F('卖方', '某厂')],
      selfPartyNames: ['我方贸易'],
    });
    expect(r.contractType).toBe('物流');
    expect(r.conflict).toBe(false);
  });

  it('无字段: 非方向标题关键词优先于主体侧别', () => {
    const r = deriveContractType({
      docType: '合同',
      fields: [F('合同名称', '焦煤公路运输合同'), F('买方', '我方贸易'), F('卖方', '某厂')],
      selfPartyNames: ['我方贸易'],
    });
    expect(r).toEqual({ contractType: '物流', source: 'keyword', conflict: false });
  });

  it('无字段无关键词: 主体侧别兜底(主体是卖方 -> 销售)', () => {
    const r = deriveContractType({
      docType: '合同',
      fields: [F('买方', '某钢厂'), F('卖方', '我方贸易')],
      selfPartyNames: ['我方贸易'],
    });
    expect(r).toEqual({ contractType: '销售', source: 'side', conflict: false });
  });

  it('名单未配置且侧别判不出: 方向标题关键词兜底', () => {
    const r = deriveContractType({ docType: '合同', fields: [F('合同名称', '2026年度焦炭采购合同')], selfPartyNames: [] });
    expect(r).toEqual({ contractType: '采购', source: 'keyword', conflict: false });
  });

  it('全无信号 -> null', () => {
    const r = deriveContractType({ docType: '合同', fields: [F('合同名称', '框架协议')], selfPartyNames: [] });
    expect(r).toEqual({ contractType: null, source: null, conflict: false });
  });
});
```

2. [ ] `npm test --workspace apps/server -- test/domain/contractType.test.ts` 确认失败（模块不存在）。

3. [ ] `tradeSemantics.ts` 扩展。`TradeVocabulary` 接口新增字段 + `TRADE_VOCAB` 新增值 + 新类型：

```ts
/** 合同类型受控词表(主体视角): 采购=主体买进, 销售=主体卖出(spec §3.1)。 */
export type ContractType = '采购' | '销售' | '物流' | '租赁' | '服务' | '其他';

// TradeVocabulary 接口追加:
  /** 合同类型受控值全集(枚举校验用)。 */
  readonly contractTypes: readonly ContractType[];
  /** 文档写法 -> 受控值。'购销合同'/'买卖合同' 有意不映射: 无方向语义, 宁可空着走侧别兜底。 */
  readonly contractTypeByAlias: Readonly<Record<string, ContractType>>;
  /** 标题关键词。键序即优先级: 物流/租赁/服务(非方向)在前, 采购/销售(方向)兜底。 */
  readonly contractTypeKeywords: Readonly<
    Record<Exclude<ContractType, '其他'>, readonly string[]>
  >;
  /** 主体侧别 -> 合同类型(确定性锚点)。 */
  readonly contractTypeBySide: Readonly<Record<'buyer' | 'seller', '采购' | '销售'>>;
  /** 项目标识字段名(合同/单据上)。 */
  readonly projectFields: ReadonlySet<string>;
  /** 合同类型 -> 对手方参与项目角色(派生 participates 边用)。 */
  readonly participatesRoleByContractType: Readonly<Record<'采购' | '销售', '供应商' | '客户'>>;

// TRADE_VOCAB 追加(键序保持: 物流/租赁/服务在前):
  contractTypes: ['采购', '销售', '物流', '租赁', '服务', '其他'],
  contractTypeByAlias: {
    采购合同: '采购', 购买合同: '采购', 采购协议: '采购',
    销售合同: '销售', 出售合同: '销售', 销售协议: '销售',
    物流合同: '物流', 运输合同: '物流', 货运合同: '物流', 物流协议: '物流',
    租赁合同: '租赁', 租赁协议: '租赁',
    服务合同: '服务', 服务协议: '服务', 技术服务合同: '服务', 咨询合同: '服务',
  },
  contractTypeKeywords: {
    物流: ['物流', '运输', '货运'],
    租赁: ['租赁', '租用'],
    服务: ['服务', '咨询'],
    采购: ['采购'],
    销售: ['销售'],
  },
  contractTypeBySide: { buyer: '采购', seller: '销售' },
  projectFields: new Set(['项目编号', '项目号', '项目名称', '项目', '工程名称']),
  participatesRoleByContractType: { 采购: '供应商', 销售: '客户' },
```

4. [ ] 新建 `apps/server/src/domain/contractType.ts`：

```ts
// 合同类型派生(spec 2026-08-20 §3.2)。纯函数: 台账写回、复核快照、图提交三处
// 消费同一规则, 保证不漂移(与 deriveProposedEdges 同原则)。
// 优先级: 合同类型字段 > 非方向标题关键词(物流/租赁/服务) > 主体侧别 > 方向标题关键词。
// '购销合同' 这类无方向写法有意不映射 —— 方向留给确定性锚点(主体侧别)。
import { resolveSelfSide, type PartySide } from './flowDirection.js';
import { TRADE_VOCAB, type ContractType, type TradeVocabulary } from './tradeSemantics.js';

export type ContractTypeSource = 'field' | 'side' | 'keyword';

export interface ContractTypeDerivation {
  contractType: ContractType | null;
  source: ContractTypeSource | null;
  /** 字段与主体侧别的采购/销售方向相反时 true(复核卡黄条)。 */
  conflict: boolean;
}

/** 最小字段投影(ExtractedField 与 ReviewSnapshot.fields 均满足)。 */
export interface ContractTypeFieldInput {
  name: string;
  value: string | number;
}

/** 无方向语义的类型: 标题命中时优先于主体侧别, 也不参与冲突判定。 */
const NON_DIRECTIONAL: readonly ContractType[] = ['物流', '租赁', '服务'];

function matchKeyword(title: string, vocab: TradeVocabulary): ContractType | null {
  if (!title) return null;
  for (const [type, words] of Object.entries(vocab.contractTypeKeywords) as Array<
    [Exclude<ContractType, '其他'>, readonly string[]]
  >) {
    if (words.some((w) => title.includes(w))) return type;
  }
  return null;
}

export function deriveContractType(args: {
  docType: string;
  fields: ContractTypeFieldInput[];
  selfPartyNames: string[];
  vocab?: TradeVocabulary;
}): ContractTypeDerivation {
  const vocab = args.vocab ?? TRADE_VOCAB;
  if (args.docType !== '合同') return { contractType: null, source: null, conflict: false };

  const byName = new Map(
    args.fields.map((f) => [f.name, typeof f.value === 'string' ? f.value.trim() : String(f.value)]),
  );

  // 主体侧别(确定性): 买方|甲方 / 卖方|乙方 锚点哪侧命中主体名单。
  const side: PartySide | null = resolveSelfSide(args.selfPartyNames, {
    buyer: byName.get('买方') ?? byName.get('甲方') ?? '',
    seller: byName.get('卖方') ?? byName.get('乙方') ?? '',
  });
  const sideType = side ? vocab.contractTypeBySide[side] : null;

  // 文档自带 合同类型 字段(受控值或别名映射; 人工修正以 confidence 1.0 落此字段)。
  const raw = byName.get('合同类型') ?? '';
  const fieldType = raw
    ? vocab.contractTypeByAlias[raw] ??
      (vocab.contractTypes.includes(raw as ContractType) ? (raw as ContractType) : null)
    : null;

  // 标题关键词: 非方向类型(物流/租赁/服务)优先于侧别, 方向类型(采购/销售)最后兜底。
  const keywordType = matchKeyword(byName.get('合同名称') ?? byName.get('标的物') ?? '', vocab);
  const keywordNonDirectional =
    keywordType && NON_DIRECTIONAL.includes(keywordType) ? keywordType : null;

  const contractType = fieldType ?? keywordNonDirectional ?? sideType ?? keywordType ?? null;
  const source =
    contractType === null
      ? null
      : fieldType !== null
        ? 'field'
        : contractType === keywordNonDirectional
          ? 'keyword'
          : contractType === sideType
            ? 'side'
            : 'keyword';
  // 冲突只看方向类型交叉(字段销售/侧别采购 这类); 物流等非方向类型不算。
  const conflict =
    fieldType !== null &&
    sideType !== null &&
    fieldType !== sideType &&
    (fieldType === '采购' || fieldType === '销售') &&
    (sideType === '采购' || sideType === '销售');

  return { contractType, source, conflict };
}
```

5. [ ] 跑测试至全绿；`npm run build && npm run lint && npm test`。
6. [ ] 提交 `feat(server): 合同类型受控词表与派生纯函数`。

---

### Task 2 台账 `contract_type` 列 + 录入写回派生

**Files**
- `apps/server/src/pipeline/db/client.ts`（改：两侧 DDL）
- `apps/server/src/pipeline/contractLedger.ts`（改）
- `apps/server/src/pipeline/db/repositories.ts` + `postgres-repositories.ts`（改）
- `apps/server/src/pipeline/tools/documentEntry.ts`（改）
- 测试：`apps/server/test/pipeline/contractLedger.test.ts`（改）+ 台账仓储测试文件（`grep -rl "upsertContractLedgerEntry" apps/server/test` 定位）

**Steps**

1. [ ] 失败测试先行：
   - `contractLedger.test.ts`：`buildLedgerEntryFromExtraction` 不传 `contractType` → `entry.contractType === null`；传 `'销售'` → 透传。（若测试里有手工构造的 `ContractLedgerEntry` 字面量，补 `contractType: null`。）
   - 仓储测试：`upsertContractLedgerEntry` 写入带 `contractType: '采购'` 的 entry → `findContractLedgerByNo` 读回 `contractType === '采购'`；再次 upsert 同合同号改为 `'销售'` → 读回更新（ON CONFLICT SET 生效）。
2. [ ] `client.ts` DDL：
   - SQLite `migrate()`：`CREATE TABLE IF NOT EXISTS contract_ledger` 语句中加 `contract_type TEXT`；并在 guarded-ALTER 区（bindings graph_status 块旁）加：

```ts
{
  const have = new Set(
    (sqlite.prepare('PRAGMA table_info(contract_ledger)').all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!have.has('contract_type')) {
    try { sqlite.exec('ALTER TABLE contract_ledger ADD COLUMN contract_type TEXT'); } catch { /* concurrent */ }
  }
}
```

   - PG `migratePostgres()`：contract_ledger 的 CREATE TABLE 镜像加列 + 语句数组加 `ALTER TABLE contract_ledger ADD COLUMN IF NOT EXISTS contract_type TEXT`。
3. [ ] `contractLedger.ts`：`ContractLedgerEntry` 加 `contractType: ContractType | null`（`import type { ContractType } from '../domain/tradeSemantics.js'`）；`buildLedgerEntryFromExtraction` 的 args 加可选 `contractType?: ContractType | null`，返回对象加 `contractType: args.contractType ?? null`。
4. [ ] `repositories.ts` / `postgres-repositories.ts`：`upsertContractLedgerEntry` 的 INSERT 列与 `ON CONFLICT(contract_no, user_id) DO UPDATE SET` 各加 `contract_type` / `excluded.contract_type`；`findContractLedgerByNo` / `listContractLedgerEntries` 的 SELECT 与行映射加 `contractType: row.contract_type ?? null`。
5. [ ] `documentEntry.ts` 写回钩子派生：
   - 新 import：`import { deriveContractType, type ContractTypeDerivation } from '../../domain/contractType.js';`、`import { getEffectiveSelfPartyNames } from '../executionFlow.js';`（documentEntry 已 import executionFlow，无环）。
   - 新私有 helper（Task 8 复用）：

```ts
/** 录入侧合同类型派生(纯函数 + 有效主体名单; 名单读取失败按空名单降级)。 */
async function deriveContractTypeForDoc(args: {
  ctx: DbContext;
  docType: string;
  fields: Record<string, { value: string | number; confidence?: number }>;
}): Promise<ContractTypeDerivation> {
  let names: string[] = [];
  try { names = await getEffectiveSelfPartyNames(args.ctx); } catch { names = []; }
  return deriveContractType({
    docType: args.docType,
    fields: Object.entries(args.fields).map(([name, f]) => ({ name, value: f.value })),
    selfPartyNames: names,
  });
}
```

   - `buildLedgerWritingDeps` 的 save 包装里：先 `const derivation = await deriveContractTypeForDoc({ ctx, docType, fields })`，再把 `contractType: derivation.contractType` 传给 `writeContractLedger` → `buildLedgerEntryFromExtraction`。写回本身保持既有故障隔离（try/catch + console.error）。
6. [ ] 测试至绿（含既有 documentEntry 台账写回用例补断言 `contract_type` 落库）；全量三连。
7. [ ] 提交 `feat(server): 合同台账落库合同类型维度`。

---

### Task 3 复核快照 `contractType` + 图提交 props

**Files**
- `apps/server/src/pipeline/db/repositories.ts`（改）
- `apps/server/src/pipeline/graphCommit.ts`（改）
- `apps/server/src/graph/graphWriter.ts`（改）
- 测试：快照测试文件（`grep -rl "getReviewSnapshot" apps/server/test` 定位）+ `graphCommit` / `graphWriter` 测试（`grep -rl "writeDocumentGraph\|commitDocumentGraph" apps/server/test` 定位）

**Steps**

1. [ ] 失败测试：
   - 快照：in-memory ctx + `addSelfParty(ctx, '我方贸易')`，种一份 甲方='我方贸易' 的合同文档+抽取 → `getReviewSnapshot` 返回 `contractType: { contractType: '采购', source: 'side', conflict: false }`。
   - graphWriter：fake io 断言 `input.contractType = '销售'` 时 Document 的 `createEntity` props 含 `contractType: '销售'`，且 kind='Contract' 的实体 props 同样带上；`contractType = null` 时不出现该 key。
   - graphCommit：fake io 下确认提交后，Contract 实体 props 带 `contractType`。
2. [ ] `repositories.ts`：
   - import：`deriveContractType, type ContractTypeDerivation`（`'../../domain/contractType.js'`）、`parseSelfPartyNames, normalizeCompanyName`（`'../../domain/flowDirection.js'`）、`env`（`'../../env.js'`）。
   - `ReviewSnapshot` 加 `contractType: ContractTypeDerivation | null`。
   - 本地 helper（避免 repositories → executionFlow 运行时环）：

```ts
/** 快照侧派生用有效主体名单: env ∪ self_parties。与 executionFlow
 * 的 getEffectiveSelfPartyNames 同语义, 本地实现以免环(executionFlow 依赖本文件)。 */
async function effectiveSelfPartyNamesForDerivation(ctx: DbContext): Promise<string[]> {
  const rows = await listSelfParties(ctx);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const n of [...parseSelfPartyNames(env.SELF_PARTY_NAMES), ...rows.map((r) => r.name)]) {
    const key = normalizeCompanyName(n);
    if (key && !seen.has(key)) { seen.add(key); out.push(n); }
  }
  return out;
}
```

   - `getReviewSnapshot` 的快照组装点（两后端共用或各分支）：fields 就绪后计算 `contractType = deriveContractType({ docType, fields, selfPartyNames: await effectiveSelfPartyNamesForDerivation(ctx) })` 并挂到返回对象。人工在复核卡改「合同类型」字段走 `applyDocumentCorrections` 后，该字段以 confidence 1.0 落 fields → 派生 source 自动变 'field'，无需额外代码。
3. [ ] `graphCommit.ts`：`writeDocumentGraph` 调用入参加 `contractType: snapshot.contractType?.contractType ?? null`。
4. [ ] `graphWriter.ts`：`WriteDocumentGraphInput` 加 `contractType?: string | null`；Document 节点 props 条件加 `...(input.contractType ? { contractType: input.contractType } : {})`；实体写循环中 `ent.kind === 'Contract' && input.contractType` 时给该实体 props 加 `contractType`。
5. [ ] 测试至绿（若有手工构造 ReviewSnapshot 的字面量，补 `contractType: null`）；全量三连。
6. [ ] 提交 `feat(server): 复核快照与图提交携带合同类型`。

---

### Task 4 Web：复核卡合同类型区 + 图谱徽章

**Files**
- `apps/web/src/components/DocumentReviewCard.tsx`（改）
- 快照类型镜像文件（`grep -rn "proposedEdges" apps/web/src --include=*.ts* -l` 定位）+ `apps/web/src/api/review.ts`（如有独立类型）
- `apps/web/src/components/graph/GraphFlowNode.tsx`（改，含 DetailPanel 若字段展示集中在此）

**Steps**

1. [ ] 快照类型镜像加可选字段：

```ts
contractType?: {
  contractType: string | null;
  source: 'field' | 'side' | 'keyword' | null;
  conflict: boolean;
} | null;
```

2. [ ] `DocumentReviewCard.tsx` 在 docType 区之后渲染「合同类型」区（复用现有 section/badge class）：
   - `contractType.contractType` 非空：徽章 = 类型文本 + 来源小字（field→字段 / side→主体侧别 / keyword→标题关键词 / null→未识别）。
   - `conflict === true`：黄条提示「合同类型与主体方向不一致，请人工确认」（沿用既有警示条样式）。
   - `contractType === null`：不渲染该区。
3. [ ] `GraphFlowNode.tsx`（及详情面板）：kind==='Contract' 或（Document 且 `props.docType === '合同'`）且 `props.contractType` 存在时，标签下方加小徽章显示类型文本（样式复用现有徽章 token）。
4. [ ] `npm run build --workspace apps/web && npm run lint`（web 无单测；不起 dev 服务器）。
5. [ ] 提交 `feat(web): 复核卡与图谱展示合同类型徽章`。

---

## Phase 2: 项目实体与归属

### Task 5 抽取提议 Project 实体与引用边 + writer kinds

**Files**
- `apps/server/src/pipeline/extraction.ts`（改）
- `apps/server/src/pipeline/db/repositories.ts`（改：类型联合）
- `apps/server/src/graph/graphWriter.ts`（改：kind 联合）
- 测试：extraction 测试（`grep -rl "deriveProposedEdges" apps/server/test`）+ graphWriter 测试

**Steps**

1. [ ] 失败测试：
   - extraction：字段含 `项目编号: 'PRJ-2026-001'` → 实体提议 `{ kind: 'Project', name: 'PRJ-2026-001' }`，边提议 `{ type: 'references', dstKind: 'Project', dstName: 'PRJ-2026-001' }`；同时含 `项目名称: '曹妃甸项目'` 时边只出一条且 `dstName` 取编号值；只含名称时取名称值。
   - graphWriter：kind='Project' 实体与 dstKind='Project' 边可写入（fake io 断言透传）。
2. [ ] `repositories.ts`：`ProposedRelationship['kind']` 联合加 `'Project'`；`ProposedEdge['dstKind']` 联合加 `'Project'`（持久化 JSON 列，无 DDL）。
3. [ ] `extraction.ts`：
   - `deriveProposedRelationships` 加分支（与 contractFields 分支并列）：`vocab.projectFields.has(f.name)` → `out.push({ kind: 'Project', name: val, confidence: f.confidence })`。
   - `deriveProposedEdges` 加项目分支：项目字段 → `{ type: 'references', dstKind: 'Project', dstName, confidence }`。同文档多项目字段折叠为一条：**编号类字段（项目编号/项目号）优先于名称类**；同类取 confidence 最高者。按函数现有结构适配（contractFields 的折叠写法可参照）。
4. [ ] `graphWriter.ts`：`GraphEntityInput['kind']` 加 `'Project'`；`GraphEdgeInput['dstKind']` 加 `'Project'`。
5. [ ] 测试至绿；全量三连。
6. [ ] 提交 `feat(server): 抽取提议项目实体与引用边`。

---

### Task 6 `projects` / `project_memberships` 表 + 仓储（SQLite/PG）

**Files**
- `apps/server/src/pipeline/db/client.ts`（改：两侧 DDL，raw SQL）
- `apps/server/src/pipeline/db/repositories.ts` + `postgres-repositories.ts`（改）
- `apps/server/test/pipeline/projectRepositories.test.ts`（新）

**Steps**

1. [ ] 失败测试（SQLite in-memory，装配方式照既有仓储测试）：

```ts
// 覆盖点:
// - createProject 成功; 同 code 二次创建返回 null(幂等, 不抛)
// - findProjectByCode 大小写归一命中('prj-2026-001' 命中 'PRJ-2026-001')
// - upsertProjectMembership 幂等: 同 (contractNo, projectCode) 再次 upsert 返回同 id,
//   且 role/status/confidence 更新为最新值
// - updateMembershipStatus: proposed -> confirmed(confirmation_source='human'),
//   proposed -> rejected; 未知 id 返回 null
// - listMembershipsByProject 的 status 过滤; listMembershipsByContract 命中
// - membership.contractNo 存的是 normalizeContractNo 后的值
// - (如既有仓储测试带多用户装置) 用户隔离: 他人行不可见
```

2. [ ] `client.ts` DDL。SQLite `migrate()` 加（bindings 建表块之后）：

```sql
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  user_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS projects_code_user_uq ON projects (code, user_id);

CREATE TABLE IF NOT EXISTS project_memberships (
  id TEXT PRIMARY KEY,
  contract_no TEXT NOT NULL,
  project_code TEXT NOT NULL,
  role TEXT,
  status TEXT NOT NULL DEFAULT 'proposed',
  proposed_by TEXT NOT NULL DEFAULT 'system',
  confirmation_source TEXT,
  confidence REAL NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL DEFAULT 'system',
  user_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  graph_status TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS project_memberships_uq
  ON project_memberships (contract_no, project_code, user_id);
CREATE INDEX IF NOT EXISTS project_memberships_project_idx
  ON project_memberships (project_code, user_id);
CREATE INDEX IF NOT EXISTS project_memberships_contract_idx
  ON project_memberships (contract_no, user_id);
```

   PG `migratePostgres()` 镜像（`TIMESTAMPTZ DEFAULT now()`、`DOUBLE PRECISION`、同名索引 `IF NOT EXISTS`）。**不进 drizzle schema.ts。**
3. [ ] `repositories.ts` 新类型 + 函数（用户作用域与 3-way OR 过滤照 contract_ledger 的写法；id 用既有 `rid()`）：

```ts
export interface ProjectRow {
  code: string;            // 归一大写
  name: string;
  status: string;          // 'active' | 'archived'
  userId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type MembershipStatus = 'proposed' | 'confirmed' | 'rejected';
export type MembershipProposedBy = 'system' | 'agent' | 'human';

export interface ProjectMembershipRow {
  id: string;
  contractNo: string;      // normalizeContractNo 后(报表连接键, spec §4.1)
  projectCode: string;     // 归一大写
  role: string | null;     // 合同类型
  status: MembershipStatus;
  proposedBy: MembershipProposedBy;
  confirmationSource: string | null;
  confidence: number;
  createdBy: string;
  userId: string | null;
  createdAt: string;
  graphStatus: BindingGraphStatus | null;
}

export interface ProjectMembershipInput {
  contractNo: string;
  projectCode: string;
  role?: string | null;
  status?: MembershipStatus;                       // 默认 'proposed'
  proposedBy?: MembershipProposedBy;               // 默认 'system'
  confirmationSource?: 'auto_rule' | 'human' | null;
  confidence?: number;                             // 默认 0
  createdBy: string;
}

/** 项目编号归一: trim + 大写(与合同号归一分开, 项目编号是人工编码)。 */
export function normalizeProjectCode(raw: string): string {
  return raw.trim().toUpperCase();
}
```

   函数清单（全部 `if (ctx.backend === 'postgres') return fnPg(...)` 委派 + PG 孪生）：

```ts
export async function createProject(ctx, input: { code: string; name: string; userId?: string | null }): Promise<ProjectRow | null>;
// code 先 normalizeProjectCode; 已存在(同 code+user)返回 null
export async function findProjectByCode(ctx, code: string, userId?: string): Promise<ProjectRow | null>;
export async function listProjects(ctx, userId?: string): Promise<ProjectRow[]>;
export async function upsertProjectMembership(ctx, input: ProjectMembershipInput, userId?: string): Promise<string>;
// 唯一键 (contract_no, project_code, user_id) 冲突时 UPDATE role/status/proposed_by/
// confirmation_source/confidence/created_by(ON CONFLICT DO UPDATE), 返回 id
export async function findMembershipById(ctx, id: string, userId?: string): Promise<ProjectMembershipRow | null>;
export async function listMembershipsByProject(ctx, projectCode: string, userId?: string, status?: MembershipStatus): Promise<ProjectMembershipRow[]>;
export async function listMembershipsByContract(ctx, contractNo: string, userId?: string): Promise<ProjectMembershipRow[]>;
export async function updateMembershipStatus(ctx, id: string, status: MembershipStatus, confirmationSource: 'auto_rule' | 'human' | null, userId?: string): Promise<ProjectMembershipRow | null>;
export async function setMembershipGraphStatus(ctx, id: string, gs: BindingGraphStatus, userId?: string): Promise<void>;
```

   行映射：`graphStatus: row.graph_status ? JSON.parse(row.graph_status) : null`。
4. [ ] PG 孪生（postgres-repositories.ts）：同 SQL 语义，`$n` 占位 + `ON CONFLICT ... DO UPDATE`，`graph_status` 以 JSON 字符串写入。
5. [ ] 测试至绿；全量三连。
6. [ ] 提交 `feat(server): 项目与归属关系表及仓储(SQLite/PG)`。

---

### Task 7 `projectGraphSync`：part_of / counterparty / participates 投影

**Files**
- `apps/server/src/pipeline/projectGraphSync.ts`（新）
- `apps/server/test/pipeline/projectGraphSync.test.ts`（新）

**Steps**

1. [ ] 失败测试（fake io 记录调用；`NEO4J_PASSWORD` 用 `vi.stubEnv`/手动删并恢复，确保未设时 skipped）：

```ts
// 覆盖点:
// - NEO4J_PASSWORD 未设 -> { status:'skipped' }, io 零调用
// - ok 路径(种台账 甲方=主体名单成员 + 乙方=对手方, role='采购'):
//   Project/Contract 节点 ensure(find 命中则不 create), part_of 边 props.role='采购',
//   两条 counterparty 边(Party->Contract, role 买方/卖方),
//   两条 participates 边(对手方 role='供应商', 主体 role='主体')
// - 台账缺失 -> 只写 part_of, 无 counterparty/participates, 仍 'ok'
// - role='物流' -> 有 counterparty 无 participates(只有采购/销售派生参与角色)
// - removeProjectMembershipGraph: 只 removeEdge(part_of), 不触派生边
// - io 抛错 -> { status:'failed', reason } 且不向上抛
```

2. [ ] 新建 `projectGraphSync.ts`（io 面与 bindingGraphSync 完全同款 —— `graph/repo.js` 的 elementId 接口）：

```ts
// 项目归属 -> Neo4j 同步(spec 2026-08-20 §4.3)。project_memberships 是 SSOT, 图是
// 投影视影。与 bindingGraphSync 同一模式: NEO4J_PASSWORD 门禁 -> 'skipped';
// 驱动错误 -> 'failed'; 永不抛出, 绝不阻塞业务主流程。io 可注入, 单测无需 Neo4j。
//
// 边语义:
//   Contract -[part_of {role}]-> Project        归属(确认时写, 拒绝时删)
//   Party -[counterparty {role}]-> Contract     派生(台账甲乙方锚点)
//   Party -[participates {role}]-> Project      派生(采购->供应商 / 销售->客户 /
//                                               主体方->主体), role 为采购/销售时才有
// 派生边不追删(spec §8 已知简化): 下一次任一归属确认时按最新 SSOT 重 MERGE 收敛。
import { createEntity, mergeEdge, removeEdge, findEntities } from '../graph/repo.js';
import { normalizeName } from '../graph/normalize.js';
import { resolveSelfSide } from '../domain/flowDirection.js';
import { TRADE_VOCAB } from '../domain/tradeSemantics.js';
import { getEffectiveSelfPartyNames } from './executionFlow.js';
import { findContractLedgerByNo, type BindingGraphStatus, type ContractLedgerEntry } from './db/repositories.js';
import type { DbContext } from './db/client.js';

export const PART_OF_EDGE = 'part_of';
export const COUNTERPARTY_EDGE = 'counterparty';
export const PARTICIPATES_EDGE = 'participates';

export interface ProjectGraphSyncIo {
  createEntity(i: { kind: string; name: string; props?: Record<string, unknown> }): Promise<{ elementId: string }>;
  mergeEdge(i: { srcId: string; dstId: string; kind: string; props?: Record<string, unknown>; confidence?: number }): Promise<unknown>;
  removeEdge(i: { srcId: string; kind: string; dstId: string }): Promise<number>;
  findEntityByName(kind: string, name: string): Promise<{ elementId: string } | null>;
}

export const defaultProjectGraphSyncIo: ProjectGraphSyncIo = {
  createEntity: (i) => createEntity(i),
  mergeEdge: (i) => mergeEdge(i),
  removeEdge: (i) => removeEdge(i),
  findEntityByName: async (kind, name) => {
    const hits = await findEntities({ kind, name, exact: true });
    return hits[0] ?? null;
  },
};

async function ensureNode(
  io: ProjectGraphSyncIo, kind: string, name: string,
  createFallback: () => Promise<{ elementId: string }>,
): Promise<{ elementId: string }> {
  const found = await io.findEntityByName(kind, name);
  if (found) return found;
  return createFallback();
}

function anchorsFromLedger(entry: ContractLedgerEntry): { buyer?: string; seller?: string } {
  const f = entry.fields;
  const buyer = String(f['买方']?.value ?? f['甲方']?.value ?? '').trim() || undefined;
  const seller = String(f['卖方']?.value ?? f['乙方']?.value ?? '').trim() || undefined;
  return { buyer, seller };
}

export interface ProjectMembershipSyncInput {
  contractNo: string;   // 已 normalizeContractNo
  projectCode: string;  // 已 normalizeProjectCode
  projectName: string;
  role: string;         // 合同类型
  confidence: number;
}

export async function syncProjectMembershipGraph(
  ctx: DbContext,
  input: ProjectMembershipSyncInput,
  io: ProjectGraphSyncIo = defaultProjectGraphSyncIo,
): Promise<BindingGraphStatus> {
  const now = () => new Date().toISOString();
  if (!process.env.NEO4J_PASSWORD) return { status: 'skipped', reason: 'NEO4J_PASSWORD not set' };
  try {
    // 节点名与 graphWriter 同键: Contract.name = normalizeName(合同号)。
    const contractName = normalizeName(input.contractNo);
    if (!contractName) return { status: 'failed', reason: 'contractNo normalized to empty', syncedAt: now() };

    const projectNode = await ensureNode(io, 'Project', input.projectCode,
      () => io.createEntity({ kind: 'Project', name: input.projectCode, props: { code: input.projectCode, name: input.projectName } }));
    const contractNode = await ensureNode(io, 'Contract', contractName,
      () => io.createEntity({ kind: 'Contract', name: contractName, props: { rawName: input.contractNo, ...(input.role ? { contractType: input.role } : {}) } }));

    await io.mergeEdge({
      srcId: contractNode.elementId, dstId: projectNode.elementId, kind: PART_OF_EDGE,
      confidence: input.confidence, props: { role: input.role, source: 'project_membership' },
    });

    // 派生边: 台账甲乙方锚点 + 主体名单 -> counterparty / participates(纯投影, 不落库)。
    const ledger = await findContractLedgerByNo(ctx, input.contractNo);
    const anchors = ledger ? anchorsFromLedger(ledger) : {};
    if (anchors.buyer && anchors.seller) {
      const side = resolveSelfSide(await getEffectiveSelfPartyNames(ctx), anchors);
      if (side) {
        const selfName = side === 'buyer' ? anchors.buyer : anchors.seller;
        const otherName = side === 'buyer' ? anchors.seller : anchors.buyer;
        const pairs: Array<[string, string]> = side === 'buyer'
          ? [[selfName, '买方'], [otherName, '卖方']]
          : [[selfName, '卖方'], [otherName, '买方']];
        for (const [raw, role] of pairs) {
          const partyNode = await ensureNode(io, 'Party', normalizeName(raw),
            () => io.createEntity({ kind: 'Party', name: normalizeName(raw), props: { rawName: raw } }));
          await io.mergeEdge({ srcId: partyNode.elementId, dstId: contractNode.elementId, kind: COUNTERPARTY_EDGE, props: { role } });
        }
        if (input.role === '采购' || input.role === '销售') {
          const otherNode = await io.findEntityByName('Party', normalizeName(otherName));
          const selfNode = await io.findEntityByName('Party', normalizeName(selfName));
          if (otherNode) {
            await io.mergeEdge({ srcId: otherNode.elementId, dstId: projectNode.elementId, kind: PARTICIPATES_EDGE,
              props: { role: TRADE_VOCAB.participatesRoleByContractType[input.role] } });
          }
          if (selfNode) {
            await io.mergeEdge({ srcId: selfNode.elementId, dstId: projectNode.elementId, kind: PARTICIPATES_EDGE, props: { role: '主体' } });
          }
        }
      }
    }
    return { status: 'ok', syncedAt: now() };
  } catch (e) {
    return { status: 'failed', reason: e instanceof Error ? e.message : String(e), syncedAt: now() };
  }
}

/** 拒绝/移除归属: 只删 part_of(派生边靠后续重 MERGE 收敛, spec §8)。 */
export async function removeProjectMembershipGraph(
  input: { contractNo: string; projectCode: string },
  io: ProjectGraphSyncIo = defaultProjectGraphSyncIo,
): Promise<BindingGraphStatus> {
  const now = () => new Date().toISOString();
  if (!process.env.NEO4J_PASSWORD) return { status: 'skipped', reason: 'NEO4J_PASSWORD not set' };
  try {
    const contractName = normalizeName(input.contractNo);
    const contractNode = await io.findEntityByName('Contract', contractName);
    const projectNode = await io.findEntityByName('Project', input.projectCode);
    if (contractNode && projectNode) {
      await io.removeEdge({ srcId: contractNode.elementId, kind: PART_OF_EDGE, dstId: projectNode.elementId });
    }
    return { status: 'ok', syncedAt: now() };
  } catch (e) {
    return { status: 'failed', reason: e instanceof Error ? e.message : String(e), syncedAt: now() };
  }
}
```

3. [ ] 测试至绿；全量三连。
4. [ ] 提交 `feat(server): 项目归属图同步 part_of/counterparty/participates`。

---

### Task 8 `projectProposal`：合同录入自动提议归属

**Files**
- `apps/server/src/pipeline/projectProposal.ts`（新）
- `apps/server/src/pipeline/tools/documentEntry.ts`（改）
- `apps/server/test/pipeline/projectProposal.test.ts`（新）+ documentEntry 台账写回测试（改）

**Steps**

1. [ ] 失败测试：
   - 纯函数 `proposeProjectMemberships`：合同+合同号+项目编号 → 一条提议（contractNo 已归一、projectCode 大写、role=传入 contractType、confidence=参与字段最小值）；只有项目名称无编号 → projectCode 取 `normalizeName(名称)`；非合同 docType / 无合同号 / 无项目字段 → `[]`。
   - documentEntry 集成（照既有台账写回用例装配 fake deps）：合同抽取含 合同号+项目名称 → `projects` 表出现该行、`project_memberships` 出现 `status='proposed'` 行；发票 docType → 两表无新行。
2. [ ] 新建 `projectProposal.ts`：

```ts
// 项目归属自动提议(spec 2026-08-20 §4.2): 合同录入时, 若抽取字段同时给出合同号
// 与项目标识, 提议一条 proposed 会员关系(不写图, 不阻塞录入)。确认(人工/Agent)
// 才是唯一写图入口。
import { TRADE_VOCAB, type ContractType } from '../domain/tradeSemantics.js';
import { normalizeContractNo } from './contractLedger.js';
import { normalizeName } from '../graph/normalize.js';

export interface ProjectMembershipProposal {
  contractNo: string;   // normalizeContractNo 后
  projectCode: string;  // 编号(大写)或 normalizeName(名称兜底)
  projectName: string;
  role: ContractType | null;
  confidence: number;
}

const CODE_FIELDS = ['项目编号', '项目号'] as const;
const NAME_FIELDS = ['项目名称', '工程名称', '项目'] as const;

export function proposeProjectMemberships(args: {
  docType: string;
  fields: Array<{ name: string; value: string | number; confidence: number }>;
  contractType: ContractType | null;
}): ProjectMembershipProposal[] {
  if (args.docType !== '合同') return [];
  const find = (names: readonly string[]) =>
    names.map((n) => args.fields.find((f) => f.name === n)).find(Boolean);
  const contractField = args.fields.find((f) => f.name === '合同号' || f.name === '合同编号');
  const codeField = find(CODE_FIELDS);
  const nameField = find(NAME_FIELDS);
  if (!contractField || (!codeField && !nameField)) return [];

  const contractNo = normalizeContractNo(String(contractField.value));
  const projectCode = codeField
    ? String(codeField.value).trim().toUpperCase()
    : normalizeName(String(nameField!.value));
  if (!contractNo || !projectCode) return [];

  const labelField = nameField ?? codeField!;
  const used = [contractField, codeField, nameField].filter(Boolean) as Array<{ confidence: number }>;
  return [{
    contractNo,
    projectCode,
    projectName: String(labelField.value).trim() || projectCode,
    role: args.contractType,
    confidence: Math.min(...used.map((f) => f.confidence)),
  }];
}
```

3. [ ] `documentEntry.ts` 接线（save 包装内、`writeContractLedger` 之后，独立 try/catch）：

```ts
// 项目归属自动提议(spec §4.2): 故障隔离, 失败只告警。createProject 幂等(已存在
// 忽略), membership 以 (contractNo, projectCode) upsert 为 proposed。
async function writeProjectProposals(args: {
  ctx: DbContext;
  docType: string;
  fields: Record<string, { value: string | number; confidence: number }>;
  contractType: ContractType | null;
  userId?: string;
}): Promise<void> {
  const proposals = proposeProjectMemberships({
    docType: args.docType,
    fields: Object.entries(args.fields).map(([name, f]) => ({ name, value: f.value, confidence: f.confidence })),
    contractType: args.contractType,
  });
  for (const p of proposals) {
    await createProject(args.ctx, { code: p.projectCode, name: p.projectName, userId: args.userId });
    await upsertProjectMembership(args.ctx, {
      contractNo: p.contractNo,
      projectCode: p.projectCode,
      role: p.contractType,
      status: 'proposed',
      proposedBy: 'system',
      confirmationSource: null,
      confidence: p.confidence,
      createdBy: 'system',
    }, args.userId);
  }
}
```

   调用点：save 包装里 Task 2 已算好的 `derivation` 复用 —— `await writeProjectProposals({ ctx, docType, fields, contractType: derivation.contractType, userId })`，外层 `try { ... } catch (e) { console.error('[documentEntry] 项目归属提议失败:', ...) }`。import：`proposeProjectMemberships`（`'../projectProposal.js'`）、`createProject, upsertProjectMembership`（并入现有 `./db/repositories.js` import）。
4. [ ] 测试至绿；全量三连。
5. [ ] 提交 `feat(server): 合同录入自动提议项目归属`。

---

### Task 9 项目维度 API 与挂载

**Files**
- `apps/server/src/routes/projects.ts`（新）
- `apps/server/src/index.ts`（改：挂载）
- `apps/server/test/routes/projects.test.ts`（新）

**Steps**

1. [ ] 失败测试（装配照 `apps/server/test/routes` 下既有路由测试的 app 组装与用户注入；`NEO4J_PASSWORD` 未设 → 确认接口返回的 membership `graphStatus.status === 'skipped'`）：

```ts
// 覆盖点:
// - POST /api/projects {code,name} 创建; 重复 code -> 409; 空 code/name -> 400
// - GET /api/projects 列表带 membershipCount/proposedCount
// - GET /api/projects/:code/memberships 404(项目不存在) / 200(含各状态行)
// - POST /api/projects/:code/memberships {contractNo, role:'采购'} -> confirmed 行,
//   contractNo 归一落库; role 非法 -> 400; 项目不存在 -> 404
// - POST /api/project-memberships/:id/confirm -> status confirmed + confirmation_source human
// - POST /api/project-memberships/:id/reject -> status rejected(不触图)
// - confirm 未知 id -> 404
```

2. [ ] 新建 `routes/projects.ts`（骨架，rollup 在 Task 12 扩展）：

```ts
// 项目维度 API(design 2026-08-20 §6.1)。projects/project_memberships 是 SSOT;
// Neo4j 只在确认时经 syncProjectMembershipGraph 投影(故障隔离, 结果落 graph_status)。
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../lib/auth-middleware.js';
import { getDbContext } from '../pipeline/db/dbBackend.js';
import type { DbContext } from '../pipeline/db/client.js';
import {
  createProject, findProjectByCode, listProjects, findMembershipById,
  listMembershipsByProject, updateMembershipStatus, upsertProjectMembership,
  setMembershipGraphStatus, normalizeProjectCode,
} from '../pipeline/db/repositories.js';
import { syncProjectMembershipGraph } from '../pipeline/projectGraphSync.js';
import { normalizeContractNo } from '../pipeline/contractLedger.js';
import { TRADE_VOCAB } from '../domain/tradeSemantics.js';

export const projectsRoute = new Hono<AuthEnv>();

let _ctx: DbContext | null = null;
function ctx(): DbContext {
  if (!_ctx) _ctx = getDbContext();
  return _ctx;
}

const createProjectSchema = z.object({ code: z.string().min(1), name: z.string().min(1) });
const assignSchema = z.object({
  contractNo: z.string().min(1),
  role: z.string().optional(),
  confidence: z.number().optional(),
});
const MEMBERSHIP_STATUSES = new Set(['proposed', 'confirmed', 'rejected']);

/** GET /api/projects —— 列表 + 归属计数。 */
projectsRoute.get('/', async (c) => {
  const user = c.get('user');
  const projects = await listProjects(ctx(), user?.id);
  const out = [];
  for (const p of projects) {
    const ms = await listMembershipsByProject(ctx(), p.code, user?.id);
    out.push({
      ...p,
      membershipCount: ms.filter((m) => m.status === 'confirmed').length,
      proposedCount: ms.filter((m) => m.status === 'proposed').length,
    });
  }
  return c.json({ projects: out });
});

/** POST /api/projects —— 新建项目(code 归一大写)。 */
projectsRoute.post('/', async (c) => {
  const user = c.get('user');
  const parsed = createProjectSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
  const code = normalizeProjectCode(parsed.data.code);
  const project = await createProject(ctx(), { code, name: parsed.data.name.trim(), userId: user?.id });
  if (!project) return c.json({ ok: false, error: 'project_exists' }, 409);
  return c.json({ ok: true, project }, 201);
});

/** GET /api/projects/:code/memberships —— 项目归属列表(?status= 过滤)。 */
projectsRoute.get('/:code/memberships', async (c) => {
  const user = c.get('user');
  const code = normalizeProjectCode(c.req.param('code'));
  const project = await findProjectByCode(ctx(), code, user?.id);
  if (!project) return c.json({ ok: false, error: 'project_not_found' }, 404);
  const statusParam = c.req.query('status');
  const status = statusParam && MEMBERSHIP_STATUSES.has(statusParam)
    ? (statusParam as 'proposed' | 'confirmed' | 'rejected')
    : undefined;
  const memberships = await listMembershipsByProject(ctx(), project.code, user?.id, status);
  return c.json({ ok: true, project, memberships });
});

/** POST /api/projects/:code/memberships —— 人工指派(直接 confirmed)。 */
projectsRoute.post('/:code/memberships', async (c) => {
  const user = c.get('user');
  const code = normalizeProjectCode(c.req.param('code'));
  const project = await findProjectByCode(ctx(), code, user?.id);
  if (!project) return c.json({ ok: false, error: 'project_not_found' }, 404);
  const parsed = assignSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
  if (parsed.data.role && !TRADE_VOCAB.contractTypes.includes(parsed.data.role as never)) {
    return c.json({ ok: false, error: 'invalid_role' }, 400);
  }
  const contractNo = normalizeContractNo(parsed.data.contractNo);
  if (!contractNo) return c.json({ ok: false, error: 'invalid_contract_no' }, 400);
  const id = await upsertProjectMembership(ctx(), {
    contractNo,
    projectCode: project.code,
    role: parsed.data.role ?? null,
    status: 'confirmed',
    proposedBy: 'human',
    confirmationSource: 'human',
    confidence: parsed.data.confidence ?? 1,
    createdBy: user?.id ?? 'human',
  }, user?.id);
  // 图投影: 故障隔离, 结果落 graph_status, 绝不阻塞指派。
  let graphStatus: Awaited<ReturnType<typeof syncProjectMembershipGraph>> | null = null;
  try {
    graphStatus = await syncProjectMembershipGraph(ctx(), {
      contractNo, projectCode: project.code, projectName: project.name,
      role: parsed.data.role ?? '', confidence: parsed.data.confidence ?? 1,
    });
    await setMembershipGraphStatus(ctx(), id, graphStatus, user?.id);
  } catch (e) {
    console.error('[projects] 归属图同步失败:', e instanceof Error ? e.message : String(e));
  }
  const memberships = await listMembershipsByProject(ctx(), project.code, user?.id);
  const membership = memberships.find((m) => m.id === id) ?? null;
  return c.json({ ok: true, membership, graphStatus }, 201);
});

/** POST /api/project-memberships/:id/confirm —— 确认提议。 */
projectsRoute.post('/memberships/:id/confirm', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const existing = await findMembershipById(ctx(), id, user?.id);
  if (!existing) return c.json({ ok: false, error: 'membership_not_found' }, 404);
  const updated = await updateMembershipStatus(ctx(), id, 'confirmed', 'human', user?.id);
  const project = await findProjectByCode(ctx(), existing.projectCode, user?.id);
  let graphStatus: Awaited<ReturnType<typeof syncProjectMembershipGraph>> | null = null;
  try {
    graphStatus = await syncProjectMembershipGraph(ctx(), {
      contractNo: existing.contractNo,
      projectCode: existing.projectCode,
      projectName: project?.name ?? existing.projectCode,
      role: existing.role ?? '',
      confidence: existing.confidence,
    });
    await setMembershipGraphStatus(ctx(), id, graphStatus, user?.id);
  } catch (e) {
    console.error('[projects] 确认图同步失败:', e instanceof Error ? e.message : String(e));
  }
  return c.json({ ok: true, membership: updated, graphStatus });
});

/** POST /api/project-memberships/:id/reject —— 拒绝提议(不触图)。 */
projectsRoute.post('/memberships/:id/reject', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const updated = await updateMembershipStatus(ctx(), id, 'rejected', 'human', user?.id);
  if (!updated) return c.json({ ok: false, error: 'membership_not_found' }, 404);
  return c.json({ ok: true, membership: updated });
});
```

3. [ ] `index.ts` 挂载（与其他路由并列）：`app.use('/api/projects/*', requireAuth); app.route('/api/projects', projectsRoute);`。
4. [ ] 测试至绿；全量三连。
5. [ ] 提交 `feat(server): 项目维度 API 与路由挂载`。

---

### Task 10 图谱项目节点样式 + graph_find_entity 扩展 + 系统提示词

**Files**
- `apps/web/src/components/graph/kinds.ts`（改）
- `apps/server/src/graph/tools.ts`（改）
- `apps/server/src/harness/agent.ts`（改：SYSTEM_PROMPT）
- 测试：graph tools 测试（`grep -rl "graph_find_entity" apps/server/test`）

**Steps**

1. [ ] 失败测试：`graph_find_entity` 的 `kind` 传 `'Project'` 能通过 schema 校验（现有 enum 用例处并列加断言）。
2. [ ] `kinds.ts`：`KIND_ICONS` 加 `Project`（lucide 图标，如 `FolderKanban`，加入 import）；`KIND_STYLES` 加 `Project` 条目（紫色系，如 `color:'#6D5FC3'`, softBg/softBorder 同既有条目的字段结构），label `'项目'`；`EDGE_LABELS` 加 `part_of: '归属'`、`counterparty: '对手方'`、`participates: '参与'`（字段结构照 `binds` 条目）。
3. [ ] `graph/tools.ts`：`kind: z.enum(['Party','Commodity','Contract','Document','Project'])`；description 补一句「项目（Project）节点由合同归属项目产生，name 为项目编号」。
4. [ ] `harness/agent.ts` SYSTEM_PROMPT 追加项目维度段（中文，无 emoji）：项目是统计维度实体；合同经 `part_of` 归属项目；采购合同的对手方在项目中是供应商、销售合同的对手方是客户；按项目统计时优先用 `project_rollup` 工具（Task 12 注册；本任务先写「项目维度统计工具即将上线」则不必 —— 直接在本任务写入完整描述，Task 12 只做注册与数量断言调整）。
5. [ ] 测试至绿（如工具数量/枚举断言测试有硬编码列表，同步更新）；全量三连 + `npm run build --workspace apps/web`。
6. [ ] 提交 `feat(server,web): 图谱项目节点样式与实体查询扩展`。

---

## Phase 3: 项目统计视图

### Task 11 `projectRollup` 汇总服务

**Files**
- `apps/server/src/pipeline/projectRollup.ts`（新）
- `apps/server/test/pipeline/projectRollup.test.ts`（新）

**Steps**

1. [ ] 失败测试：

```ts
// buildRollup 纯函数(fixture 直接构造 memberships/ledgers/flowSummaries):
// - 指标: 2 销售合同(金额 100+120) + 1 采购(80) + 1 物流(5) ->
//   salesAmount=220, purchaseAmount=80, expenseAmount=5, grossMargin=220-80-5=135
// - receivableOpen = sales - 发票流out - 资金流in; payableOpen = purchase - 发票流in - 资金流out
// - flows 六向聚合: 多合同同向求和, 货物流走 totalQuantityTon 其余走 totalAmount
// - counterparty: 台账 甲方=主体名单成员 -> 对手方取乙方值(role='采购')
// - checks: role='销售' 且 发票流 in>0 -> type_direction_mismatch(warn);
//   role='采购' 且 发票流 out>0 -> 同上; 货物流净量 != 0 -> qty_gap(info);
//   confirmed 合同台账缺失或金额缺失 -> amount_missing(warn)
// - pendingMemberships 与 contracts 按 status 分离
// - rollupProject 集成(in-memory ctx): 种 project/memberships/contract_ledger/
//   execution_flows(种法照 executionFlow 既有测试) -> 端到端指标; 项目不存在 -> null
```

2. [ ] 新建 `projectRollup.ts`：

```ts
// 项目维度统计汇总(spec 2026-08-20 §5)。纯读: memberships(SSOT) + 合同台账 +
// 执行流水 -> 单项目口径的合同面/六向流水/指标/校验。不查 Neo4j —— 报表不依赖图。
import {
  findProjectByCode, findContractLedgerByNo, listMembershipsByProject,
  normalizeProjectCode, type ProjectMembershipRow,
} from './db/repositories.js';
import { getEffectiveSelfPartyNames, summarizeExecutionFlows, type ExecutionFlowSummary } from './executionFlow.js';
import { resolveSelfSide } from '../domain/flowDirection.js';
import type { ContractLedgerEntry } from './contractLedger.js';
import type { DbContext } from './db/client.js';

export interface RollupContract {
  contractNo: string;
  displayContractNo: string;
  role: string;              // 合同类型
  title: string | null;
  amount: number | null;
  currency: string | null;
  counterparty: string | null;
}

export interface RollupFlows {
  资金流: { in: number; out: number };
  发票流: { in: number; out: number };
  货物流: { inTon: number; outTon: number };
}

export interface RollupCheck { level: 'warn' | 'info'; code: string; message: string }

export interface ProjectRollup {
  project: { code: string; name: string };
  contracts: RollupContract[];
  pendingMemberships: Array<{ contractNo: string; role: string | null }>;
  flows: RollupFlows;
  metrics: {
    salesAmount: number; purchaseAmount: number; expenseAmount: number;
    grossMargin: number;
    receivableOpen: number;
    payableOpen: number;
  };
  checks: RollupCheck[];
}

const EXPENSE_ROLES = new Set(['物流', '租赁', '服务']);

function parseAmount(raw: string | number | undefined): number | null {
  if (raw === undefined) return null;
  const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/[,，\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function counterpartyOf(entry: ContractLedgerEntry | null | undefined, selfNames: string[]): string | null {
  if (!entry) return null;
  const buyer = String(entry.fields['买方']?.value ?? entry.fields['甲方']?.value ?? '').trim();
  const seller = String(entry.fields['卖方']?.value ?? entry.fields['乙方']?.value ?? '').trim();
  if (!buyer || !seller) return null;
  const side = resolveSelfSide(selfNames, { buyer, seller });
  if (!side) return null;
  return side === 'buyer' ? seller : buyer;
}

export function buildRollup(args: {
  project: { code: string; name: string };
  memberships: ProjectMembershipRow[];
  ledgers: Map<string, ContractLedgerEntry | null>;
  flowSummaries: ExecutionFlowSummary[];
  selfPartyNames: string[];
}): ProjectRollup {
  const checks: RollupCheck[] = [];
  const contracts: RollupContract[] = [];
  const pendingMemberships: Array<{ contractNo: string; role: string | null }> = [];

  let salesAmount = 0;
  let purchaseAmount = 0;
  let expenseAmount = 0;

  for (const m of args.memberships) {
    if (m.status !== 'confirmed') {
      if (m.status === 'proposed') pendingMemberships.push({ contractNo: m.contractNo, role: m.role });
      continue;
    }
    const entry = args.ledgers.get(m.contractNo) ?? null;
    const amount = parseAmount(entry?.fields['金额']?.value);
    const currencyRaw = entry?.fields['币种']?.value;
    contracts.push({
      contractNo: m.contractNo,
      displayContractNo: entry?.displayContractNo ?? m.contractNo,
      role: m.role ?? '未分类',
      title: entry?.title ?? null,
      amount,
      currency: currencyRaw === undefined ? null : String(currencyRaw),
      counterparty: counterpartyOf(entry, args.selfPartyNames),
    });
    if (amount === null) {
      checks.push({ level: 'warn', code: 'amount_missing', message: `合同 ${m.contractNo} 无台账金额${entry ? '(金额字段缺失)' : '(台账缺失)'}` });
    } else if (m.role === '采购') {
      purchaseAmount += amount;
    } else if (m.role === '销售') {
      salesAmount += amount;
    } else if (EXPENSE_ROLES.has(m.role ?? '')) {
      expenseAmount += amount;
    }
  }

  // 六向流水聚合: 资金流/发票流按 totalAmount, 货物流按 totalQuantityTon。
  const flows: RollupFlows = {
    资金流: { in: 0, out: 0 },
    发票流: { in: 0, out: 0 },
    货物流: { inTon: 0, outTon: 0 },
  };
  const roleByContractNo = new Map(args.memberships.filter((m) => m.status === 'confirmed').map((m) => [m.contractNo, m.role ?? '']));
  for (const s of args.flowSummaries) {
    if (s.flowType === '资金流' || s.flowType === '发票流') {
      const bucket = flows[s.flowType];
      if (s.direction === 'in') bucket.in += s.totalAmount;
      else bucket.out += s.totalAmount;
    } else if (s.flowType === '货物流') {
      if (s.direction === 'in') flows.货物流.inTon += s.totalQuantityTon;
      else flows.货物流.outTon += s.totalQuantityTon;
    }
    // 类型-方向交叉校验
    const role = roleByContractNo.get(s.contractNo);
    if (s.flowType === '发票流' && s.totalAmount > 0) {
      if (role === '销售' && s.direction === 'in') {
        checks.push({ level: 'warn', code: 'type_direction_mismatch', message: `销售合同 ${s.contractNo} 收到进项发票 ${s.totalAmount}` });
      } else if (role === '采购' && s.direction === 'out') {
        checks.push({ level: 'warn', code: 'type_direction_mismatch', message: `采购合同 ${s.contractNo} 开出销项发票 ${s.totalAmount}` });
      }
    }
  }
  const qtyNet = flows.货物流.inTon - flows.货物流.outTon;
  if (Math.abs(qtyNet) > 0.01) {
    checks.push({ level: 'info', code: 'qty_gap', message: `货物流净量未平: ${qtyNet > 0 ? '+' : ''}${qtyNet.toFixed(2)} 吨` });
  }

  const metrics = {
    salesAmount,
    purchaseAmount,
    expenseAmount,
    grossMargin: salesAmount - purchaseAmount - expenseAmount,
    receivableOpen: salesAmount - flows.发票流.out - flows.资金流.in,
    payableOpen: purchaseAmount - flows.发票流.in - flows.资金流.out,
  };
  return { project: args.project, contracts, pendingMemberships, flows, metrics, checks };
}

export async function rollupProject(
  ctx: DbContext,
  code: string,
  userId?: string,
): Promise<ProjectRollup | null> {
  const project = await findProjectByCode(ctx, normalizeProjectCode(code), userId);
  if (!project) return null;
  const memberships = await listMembershipsByProject(ctx, project.code, userId);
  const ledgers = new Map<string, ContractLedgerEntry | null>();
  const flowSummaries: ExecutionFlowSummary[] = [];
  for (const m of memberships) {
    if (m.status !== 'confirmed') continue;
    ledgers.set(m.contractNo, await findContractLedgerByNo(ctx, m.contractNo, userId));
    flowSummaries.push(...(await summarizeExecutionFlows(ctx, m.contractNo, userId)));
  }
  return buildRollup({
    project: { code: project.code, name: project.name },
    memberships,
    ledgers,
    flowSummaries,
    selfPartyNames: await getEffectiveSelfPartyNames(ctx),
  });
}
```

   注意 `summarizeExecutionFlows` 返回的 `direction` 取值以实现为准（`'in'|'out'`），不符则按实际枚举适配。
3. [ ] 测试至绿；全量三连。
4. [ ] 提交 `feat(server): 项目维度统计汇总服务`。

---

### Task 12 汇总 API + Agent `project_rollup` 工具

**Files**
- `apps/server/src/routes/projects.ts`（改：加 rollup 端点）
- `apps/server/src/tools/queries.ts`（改）
- `apps/server/src/harness/agent.ts`（改：注册）
- 相关注册/断言文件：`grep -rl "query_contract\|buildQueryContractTool" apps/server/src apps/server/test` 定位（roleToolRegistry / contextContract / 工具数量断言）
- 测试：新工具单测 + 注册断言更新

**Steps**

1. [ ] 失败测试：
   - 路由：`GET /api/projects/:code/rollup` 200 带指标 / 项目不存在 404。
   - 工具：`buildProjectRollupTool({ ctx, userId })` 注入种好数据的 in-memory ctx → execute 返回指标与合同摘要；项目不存在 → `{ notFound: true }`；不传 deps → `{ notConfigured: true }`（照 buildQueryContractTool 的测试装配）。
   - 注册断言：工具数量断言处 +1（grep 定位硬编码数量）。
2. [ ] `routes/projects.ts` 加（挂在 `/:code/memberships` 之前避免路径遮蔽）：

```ts
/** GET /api/projects/:code/rollup —— 项目统计汇总(spec §5)。 */
projectsRoute.get('/:code/rollup', async (c) => {
  const user = c.get('user');
  const rollup = await rollupProject(ctx(), c.req.param('code'), user?.id);
  if (!rollup) return c.json({ ok: false, error: 'project_not_found' }, 404);
  return c.json({ ok: true, rollup });
});
```

3. [ ] `tools/queries.ts` 加（照 buildQueryContractTool 模式）：

```ts
const projectRollupSchema = z.object({
  projectCode: z.string().min(1).describe('项目编号，如 PRJ-2026-001'),
});

export function buildProjectRollupTool(deps?: { ctx?: DbContext; userId?: string }) {
  return tool({
    description:
      '按项目编号汇总该项目的销售/采购/费用合同金额、毛差、应收应付未清、六向执行流水(资金/货物/发票 x 进/出)与校验提示。用于"这个项目赚了多少/还差多少发票/项目概况"等报表类问题。',
    inputSchema: projectRollupSchema,
    execute: async ({ projectCode }) => {
      if (!deps?.ctx) return { notConfigured: true as const };
      const rollup = await rollupProject(deps.ctx, projectCode, deps.userId);
      if (!rollup) return { notFound: true as const, projectCode };
      return {
        project: rollup.project,
        contractCount: rollup.contracts.length,
        pendingCount: rollup.pendingMemberships.length,
        contracts: rollup.contracts.map((x) => ({
          contractNo: x.displayContractNo, role: x.role, counterparty: x.counterparty, amount: x.amount,
        })),
        flows: rollup.flows,
        metrics: rollup.metrics,
        checks: rollup.checks,
      };
    },
  });
}
```

4. [ ] `harness/agent.ts` 注册：与 query_contract 同处并列（L1，带 ctx/user 的 builder）；roleToolRegistry 各角色工具清单加名；contextContract 加工具条目（用途/输入/返回摘要）；SYSTEM_PROMPT 已在 Task 10 写入的项目段确认提到 `project_rollup`。
5. [ ] 测试至绿（工具数量断言 +1）；全量三连。
6. [ ] 提交 `feat(server): 项目汇总 API 与 Agent project_rollup 工具`。

---

### Task 13 Web 项目工作台视图 + 全量验证

**Files**
- `apps/web/src/api/projects.ts`（新）
- `apps/web/src/hooks/useProjects.ts`（新）
- `apps/web/src/components/projects/ProjectsView.tsx`（新）
- `apps/web/src/App.tsx`（改：挂载入口）

**Steps**

1. [ ] `api/projects.ts`：类型（`ProjectSummary = ProjectRow + membershipCount/proposedCount`、`ProjectMembership`、`ProjectRollupResp`）+ 函数 `listProjects / createProject / listMemberships / assignMembership / confirmMembership / rejectMembership / fetchProjectRollup`。fetch 包装照 `apps/web/src/api/review.ts` 的既有写法（credentials/JSON/错误形状一致）。
2. [ ] `hooks/useProjects.ts`：项目列表 + 选中项 + rollup 数据加载与确认/拒绝后的刷新（照 `apps/web/src/hooks` 下既有 hook 的模式，如 useBindings/useParties）。
3. [ ] `ProjectsView.tsx` 双栏（样式复用现有卡片/表格/徽章 class，无 emoji）：
   - 左栏：项目列表（编号/名称/合同数/待确认角标）+ 新建表单（编号/名称）。
   - 右栏（选中项目）：指标卡六格（销售/采购/费用/毛差/应收未清/应付未清）；合同面表格（合同号/类型/对手方/金额/币种）；待确认归属列表（确认/拒绝按钮，调 confirm/reject 后刷新）；人工指派表单（合同号 + 类型下拉 = `['采购','销售','物流','租赁','服务','其他']`）；校验提示条（warn 黄 / info 灰）；六向流水小表（3 流 × 进出）。
4. [ ] `App.tsx`：按 BindingsView 的挂载方式加「项目」入口（标签/路由照现有结构）。
5. [ ] 根目录全量：`npm run build && npm run lint && npm test`。
6. [ ] 提交 `feat(web): 项目维度工作台视图`。

---

## Self-Review 记录

（执行者按任务完成后填写：偏离计划的改动及原因、发现并修复的问题、遗留 followup）

- Task 1: 环境修复（非代码）：worktree 根 node_modules 缺 better-sqlite3（drizzle 从根解析不到，44 个测试文件 import 即挂）。根因 lock 解析为根 12.11.1 + 嵌套 11.10.0 双落点但磁盘只有手工嵌套副本；离线无法装 12.x，把已编译 11.10.0 复制到根（满足 peer >=7）。未改 package.json/lock。
- Task 2: 手动 extract_fields 路径同样接入 deriveContractTypeForDoc（计划只写 buildLedgerWritingDeps save 包装），两个录入入口语义一致；手动路径的 derivation 复用同一 helper。SQLite 读回 contract_type 加 as ContractType | null 收窄。guarded-ALTER 块置于模板字符串外（bindings graph_status 块后）。
- Task 3: 快照外层 null 语义——派生无结果（非合同/全无信号）时 ReviewSnapshot.contractType 挂 null 而非 {contractType:null,...} 对象，与 Task 4 复核卡「null 不渲染」措辞对齐。effectiveSelfPartyNamesForDerivation 导出供 PG 快照分支复用（避免环）。
- Task 4: 无偏离。快照类型镜像加可选 contractType 字段；GraphFlowNode 两族节点卡加类型徽章（Contract 实体 / docType=合同的 Document，props.contractType 存在时）。
- Task 5: 实体提议与边提议策略不同——实体侧保留全部项目字段候选（写入按归一化名 MERGE 去重），边侧才做编号优先折叠；与计划字面一致，测试覆盖补充了该差异。graphWriter 用例的“红”由 tsc 类型联合把关（运行时本就透传字符串 kind）。
- Task 6: createProject 存在性检查用精确 (code, user_id)（读侧 3-way OR 会让他人项目挡创建，与唯一索引矛盾）；归属写侧 user_id 统一 effectiveUserId 归一存 ''（NULL 会让唯一索引幂等失效，与 contract_ledger 同约定）。PG 孪生经 repositories 静态 import 块分发。
- Task 7: ContractLedgerEntry 类型实际在 contractLedger.ts（计划写在 repositories），导入路径修正。测试用例覆盖计划全部要点（skipped/ok/台账缺失/物流角色/remove 只删 part_of/io 抛错不上抛）。
- Task 8: 两个录入入口都接 writeProjectProposals（与 Task 2 适配一致）；传入字段合并 fieldMeta confidence（save 包装的 fields 本身不带 confidence，直传会使提议 confidence 退化为 0）。projectName 语义对齐计划代码：无名称字段取编号字段原始写法（非大写后值）。计划导入的 TRADE_VOCAB 未使用，移除。
- Task 9: 路由 ctx 改每请求 getDbContext()（弃计划中的模块级 _ctx 单例——测试间缓存第一个 in-memory ctx 致后续用例查空库；生产下 getDbContext 自身是单例，语义不变）。测试显式删除并恢复 NEO4J_PASSWORD（本地 .env 带该变量且 vitest 注入，使图门禁走到真实连接）。
- Task 10: SYSTEM_PROMPT 项目段按计划直接写入 project_rollup 完整描述（含“工具未注册/notFound 时如实告知”回退）。kinds.ts 加 Project 图标（FolderKanban）/紫系样式/三条边标签。
- Task 11: summarizeExecutionFlows 与 ExecutionFlowSummary 实际从 repositories.ts 导出（计划写在 executionFlow.ts），导入源适配；direction 'in'|'out' 与计划假设一致。totalAmount/totalQuantityTon 可能为 null，聚合按 ?? 0 处理（SUM 对全 NULL 组返回 null 的既有语义）。
- Task 12: 工具数量断言 +1 共三处（e2e-loop 20->21、integration-recall 20->21、contextContract EXPECTED_TOOLS 加名）；permissionGate L1 + contextContract 条目照 query_execution_flows 模式。rollup 端点挂在 /:code/memberships 之前。
- Task 13: 无偏离。api/projects.ts fetch 包装照 review.ts（错误码中文映射）；useProjects 写操作后 refreshAll 统一刷新列表计数+选中明细；ProjectsView 双栏复用既有卡片/表格/徽章 token；App.tsx 照 BindingsView 挂载方式加「项目」入口（FolderKanban 图标）。
- 遗留 followup: (1) PG 集成测试默认 skip，新表/新列的 PG 路径靠 tsc 类型对齐 + SQL 孪生审读保证；(2) 派生边（counterparty/participates）不追删，靠下一次任一归属确认按最新 SSOT 重 MERGE 收敛（spec §8 已知简化）；(3) 图谱 GraphFlowNode 的项目徽章依赖 props.contractType，仅确认后图提交/归属同步写入的节点可见。
