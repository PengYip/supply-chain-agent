# 图谱/绑定页合同搜索 + 图谱页 G6 v5 重设计 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 图谱页与绑定页加入基于合同（合同编号/买方/卖方/标题）的模糊搜索下拉；图谱页重写为 AntV G6 v5 渲染并加入节点类型过滤、双击增量展开、Inspector 绑定状态薄互通。

**Architecture:** 统一搜索端点 `GET /api/contracts/search` 走 `contract_ledger`（SQL LIKE 粗筛 + JS 精排，SQLite/PG 双仓库函数）；`GET /api/graph/schema` 提供图例计数。前端新增共享 `ContractSearchBar` 组合框，两个页面接线；`GraphCanvas` 从 @xyflow/react 换成 G6 v5（命令式生命周期），`kinds.ts` 迁移为 `businessTypes.ts` 业务类型注册表。

**Tech Stack:** Hono + zod 3.25 + better-sqlite3 / pg（双后端）；React 19 + TS + Tailwind（无组件库）+ @antv/g6 ^5（新增）。

**Spec:** `docs/superpowers/specs/2026-08-26-graph-contract-search-design.md`

## Global Constraints

- 代码中禁止 emoji（仓库约定）。
- SQLite 是默认运行时；每个新 repo 函数必须有 PG 分支（`ctx.backend === 'postgres'` dispatch + `postgres-repositories.ts`孪生）。PG `contract_ledger.fields` 是 **jsonb**（`client.ts:568-583`），SQLite 是 TEXT(JSON)。
- 路由测试模式照 `apps/server/test/routes/bindingsRead.test.ts`：`vi.hoisted` + mock `dbBackend.getDbContext` + `createDb(':memory:')` + `migrate` + `appAs(userId)` 中间件。
- 前端 fetch 遵循 `useGraph.ts` 的 `getJson` 模式（`credentials:'include'` + `{ok,data}` 信封兼容 + 中文错误消息）。
- 完成顺序：build → lint → test（对应 CI）。提交信息中文、格式 `feat(scope): ...`。
- 不引入 Graphin / 组件库；BindingMiniGraph 保持 @xyflow/react 不动。
- G6 v5 API 与计划代码可能有出入：Task 8 每个 G6 调用须先对照 `node_modules/@antv/g6` 类型定义核实后再落地；**props 契约不可变**。

---

### Task 1: 合同搜索纯逻辑（contractSearch.ts）

**Files:**
- Create: `apps/server/src/pipeline/contractSearch.ts`
- Test: `apps/server/test/pipeline/contractSearch.test.ts`

**Interfaces:**
- Consumes: `ContractLedgerEntry`、`normalizeContractNo`（`contractLedger.ts`）；`matchEntity`（`bindingProposal.ts:146`）。
- Produces（Task 2/3 依赖）:
  - `type ContractSearchField = 'contractNo' | 'buyer' | 'seller' | 'title'`
  - `interface ContractSearchItem { contractNo: string; displayContractNo: string; title: string; buyer: string | null; seller: string | null; docType: string; overallConfidence: number; matchedField: ContractSearchField }`
  - `extractLedgerParty(entry: Pick<ContractLedgerEntry,'fields'>, side: 'buyer'|'seller'): string | null`
  - `matchContractQuery(q: string, entry: ContractLedgerEntry): { field: ContractSearchField; score: number } | null`
  - `toSearchItem(entry: ContractLedgerEntry, matchedField: ContractSearchField): ContractSearchItem`
  - `rankContractSearch(q: string, entries: ContractLedgerEntry[], limit: number): ContractSearchItem[]`

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/test/pipeline/contractSearch.test.ts
import { describe, it, expect } from 'vitest';
import {
  extractLedgerParty, matchContractQuery, rankContractSearch, type ContractSearchItem,
} from '../../src/pipeline/contractSearch.js';
import type { ContractLedgerEntry } from '../../src/pipeline/contractLedger.js';

function entry(over: Partial<ContractLedgerEntry> = {}): ContractLedgerEntry {
  return {
    contractNo: 'CJXC-CTCL-JY-2024-131-01', displayContractNo: 'ｃｊｘｃ－ctcl－jy－2024-131-01',
    docType: '合同', documentId: 'D1', title: '动力煤采购合同', contractType: null,
    fields: {
      合同号: { value: 'ｃｊｘｃ－ctcl－jy－2024-131-01', sourceSpans: [] },
      买方: { value: '浙江浙能富兴燃料有限公司', sourceSpans: [] },
      卖方: { value: '山西焦煤集团', sourceSpans: [] },
    },
    fieldMeta: {}, overallConfidence: 0.9, needsReview: false, userId: 'u1',
    ...over,
  };
}

describe('extractLedgerParty', () => {
  it('买方优先 买方 键, 回退 甲方; 卖方优先 卖方 键, 回退 乙方', () => {
    expect(extractLedgerParty(entry(), 'buyer')).toBe('浙江浙能富兴燃料有限公司');
    expect(extractLedgerParty(entry(), 'seller')).toBe('山西焦煤集团');
    const e2 = entry({ fields: { 甲方: { value: 'A公司', sourceSpans: [] }, 乙方: { value: 'B公司', sourceSpans: [] } } });
    expect(extractLedgerParty(e2, 'buyer')).toBe('A公司');
    expect(extractLedgerParty(e2, 'seller')).toBe('B公司');
  });
  it('无匹配键或空串 -> null', () => {
    expect(extractLedgerParty(entry({ fields: {} }), 'buyer')).toBeNull();
    expect(extractLedgerParty(entry({ fields: { 买方: { value: '  ', sourceSpans: [] } } }), 'buyer')).toBeNull();
  });
});

describe('matchContractQuery', () => {
  it('归一化合同号精确/前缀/包含 -> contractNo 1 / 0.95 / 0.9', () => {
    expect(matchContractQuery('cjxc-ctcl-jy-2024-131-01', entry())?.score).toBe(1);
    expect(matchContractQuery('CJXC-CTCL', entry())).toEqual({ field: 'contractNo', score: 0.95 });
    expect(matchContractQuery('2024-131', entry())).toEqual({ field: 'contractNo', score: 0.9 });
  });
  it('全角输入归一化后精确命中', () => {
    expect(matchContractQuery('ｃｊｘｃ－ｃｔｃｌ－ｊｙ－2024-131-01', entry())?.score).toBe(1);
  });
  it('displayContractNo 原文包含 -> contractNo 0.85', () => {
    expect(matchContractQuery('ctcl－jy－2024', entry())).toEqual({ field: 'contractNo', score: 0.85 });
  });
  it('买方模糊(包含) -> buyer 0.9; 卖方 -> seller', () => {
    expect(matchContractQuery('浙能富兴', entry())).toEqual({ field: 'buyer', score: 0.9 });
    expect(matchContractQuery('焦煤集团', entry())).toEqual({ field: 'seller', score: 0.9 });
  });
  it('标题包含 -> title 0.6', () => {
    expect(matchContractQuery('动力煤', entry())).toEqual({ field: 'title', score: 0.6 });
  });
  it('不匹配 -> null; 空 q -> null', () => {
    expect(matchContractQuery('完全不相关词组', entry())).toBeNull();
    expect(matchContractQuery('   ', entry())).toBeNull();
  });
});

describe('rankContractSearch', () => {
  it('按分数降序 + 截断 limit + 字段优先级(contractNo 高于 buyer)', () => {
    const a = entry(); // contractNo 前缀命中 0.95
    const b = entry({ contractNo: 'ZZ-OTHER-1', displayContractNo: 'ZZ-OTHER-1', fields: { 买方: { value: '浙能富兴燃料', sourceSpans: [] } } }); // buyer 0.9
    const out = rankContractSearch('CJXC', [b, a], 10);
    expect(out[0]?.contractNo).toBe(a.contractNo);
    expect(out).toHaveLength(2);
    expect(out[1]?.matchedField).toBe('buyer');
    expect(rankContractSearch('CJXC', [b, a], 1)).toHaveLength(1);
  });
  it('buyer/seller 进入返回项', () => {
    const out = rankContractSearch('浙能富兴', [entry()], 10);
    expect(out[0]?.buyer).toBe('浙江浙能富兴燃料有限公司');
    expect(out[0]?.seller).toBe('山西焦煤集团');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test --workspace apps/server -- test/pipeline/contractSearch.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// apps/server/src/pipeline/contractSearch.ts
// 合同台账搜索纯逻辑(spec 2026-08-26 §4.1): SQL 粗筛后的 JS 精排与打分。
// 依赖方向: contractSearch -> bindingProposal -> contractLedger, 无环。
import { normalizeContractNo, type ContractLedgerEntry } from './contractLedger.js';
import { matchEntity } from './bindingProposal.js';

export type ContractSearchField = 'contractNo' | 'buyer' | 'seller' | 'title';

export interface ContractSearchItem {
  contractNo: string;
  displayContractNo: string;
  title: string;
  buyer: string | null;
  seller: string | null;
  docType: string;
  overallConfidence: number;
  matchedField: ContractSearchField;
}

/** fields JSON 里的主体键: 买方侧优先 买方 回退 甲方(销售合同视角), 卖方同理。 */
const BUYER_KEYS = ['买方', '甲方'] as const;
const SELLER_KEYS = ['卖方', '乙方'] as const;

export function extractLedgerParty(
  entry: Pick<ContractLedgerEntry, 'fields'>,
  side: 'buyer' | 'seller',
): string | null {
  const keys = side === 'buyer' ? BUYER_KEYS : SELLER_KEYS;
  for (const k of keys) {
    const v = entry.fields[k]?.value;
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  }
  return null;
}

/**
 * 单条目打分(优先级从高到低, 命中即返回):
 * - 归一化合同号: 精确 1 / 前缀 0.95 / 包含 0.9
 * - displayContractNo 原文包含 0.85(兼容全角连字符等归一化会丢的输入)
 * - 买方/卖方: matchEntity(精确 1 / 包含 0.9 / 字符重合 0.75), 阈值 0.75
 * - 标题包含 0.6
 */
export function matchContractQuery(
  q: string,
  entry: ContractLedgerEntry,
): { field: ContractSearchField; score: number } | null {
  const raw = q.trim();
  if (!raw) return null;
  const nq = normalizeContractNo(raw);
  if (nq) {
    if (entry.contractNo === nq) return { field: 'contractNo', score: 1 };
    if (entry.contractNo.startsWith(nq)) return { field: 'contractNo', score: 0.95 };
    if (entry.contractNo.includes(nq)) return { field: 'contractNo', score: 0.9 };
  }
  const rawLower = raw.toLowerCase();
  if (entry.displayContractNo.toLowerCase().includes(rawLower)) {
    return { field: 'contractNo', score: 0.85 };
  }
  const buyer = extractLedgerParty(entry, 'buyer');
  if (buyer) {
    const m = matchEntity(raw, buyer);
    if (m >= 0.75) return { field: 'buyer', score: m };
  }
  const seller = extractLedgerParty(entry, 'seller');
  if (seller) {
    const m = matchEntity(raw, seller);
    if (m >= 0.75) return { field: 'seller', score: m };
  }
  if (entry.title && entry.title.toLowerCase().includes(rawLower)) {
    return { field: 'title', score: 0.6 };
  }
  return null;
}

export function toSearchItem(
  entry: ContractLedgerEntry,
  matchedField: ContractSearchField,
): ContractSearchItem {
  return {
    contractNo: entry.contractNo,
    displayContractNo: entry.displayContractNo,
    title: entry.title,
    buyer: extractLedgerParty(entry, 'buyer'),
    seller: extractLedgerParty(entry, 'seller'),
    docType: entry.docType,
    overallConfidence: entry.overallConfidence,
    matchedField,
  };
}

/** entries 需按 updated_at DESC 预排(SQL 层保证): 稳定排序使同分保持近者优先。 */
export function rankContractSearch(
  q: string,
  entries: ContractLedgerEntry[],
  limit: number,
): ContractSearchItem[] {
  const scored: Array<{ score: number; item: ContractSearchItem }> = [];
  for (const e of entries) {
    const m = matchContractQuery(q, e);
    if (!m) continue;
    scored.push({ score: m.score, item: toSearchItem(e, m.field) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.item);
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test --workspace apps/server -- test/pipeline/contractSearch.test.ts`
Expected: PASS 全绿

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/pipeline/contractSearch.ts apps/server/test/pipeline/contractSearch.test.ts
git commit -m "feat(search): 合同台账搜索纯逻辑(编号/买方/卖方/标题打分排序)"
```

---

### Task 2: searchContractLedger 仓库函数（SQLite + PG）

**Files:**
- Modify: `apps/server/src/pipeline/db/repositories.ts`（在 `listContractLedgerEntries` 之后，约 L2010 附近插入）
- Modify: `apps/server/src/pipeline/db/postgres-repositories.ts`（在 `listContractLedgerEntriesPg` 之后，约 L363 附近插入）
- Test: `apps/server/test/pipeline/db/contractSearchRepo.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `rankContractSearch`/`ContractSearchItem`；`effectiveUserId`（两文件已有）。
- Produces（Task 3 依赖）: `searchContractLedger(ctx: DbContext, q: string, userId?: string, limit = 10): Promise<ContractSearchItem[]>`

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/test/pipeline/db/contractSearchRepo.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate, type DbContext } from '../../../src/pipeline/db/client.js';
import { upsertContractLedgerEntry, searchContractLedger } from '../../../src/pipeline/db/repositories.js';
import type { ContractLedgerEntry } from '../../../src/pipeline/contractLedger.js';

let ctx: DbContext;
beforeEach(() => { ctx = createDb(':memory:'); migrate(ctx.sqlite); });

function mk(p: Partial<ContractLedgerEntry> & { contractNo: string }, userId = 'u1'): ContractLedgerEntry {
  return {
    displayContractNo: p.contractNo, docType: '合同', documentId: 'D', title: '',
    contractType: null, fields: { 合同号: { value: p.contractNo, sourceSpans: [] } },
    fieldMeta: {}, overallConfidence: 1, needsReview: false, userId, ...p,
  } as ContractLedgerEntry;
}

describe('searchContractLedger(SQLite)', () => {
  beforeEach(async () => {
    await upsertContractLedgerEntry(ctx, mk({
      contractNo: 'CJXC-2024-001',
      title: '动力煤采购合同',
      fields: {
        合同号: { value: 'CJXC-2024-001', sourceSpans: [] },
        买方: { value: '浙江浙能富兴燃料有限公司', sourceSpans: [] },
        卖方: { value: '山西焦煤集团', sourceSpans: [] },
      },
    }));
    await upsertContractLedgerEntry(ctx, mk({ contractNo: 'HT-2024-002', title: '焦炭销售合同' }));
  });

  it('合同号包含命中 + matchedField=contractNo', async () => {
    const items = await searchContractLedger(ctx, 'CJXC', 'u1', 10);
    expect(items).toHaveLength(1);
    expect(items[0]?.contractNo).toBe('CJXC-2024-001');
    expect(items[0]?.matchedField).toBe('contractNo');
  });

  it('买方中文名子串(模糊包含)命中 fields JSON 内的 买方 键', async () => {
    const items = await searchContractLedger(ctx, '浙能富兴', 'u1', 10);
    expect(items[0]?.contractNo).toBe('CJXC-2024-001');
    expect(items[0]?.matchedField).toBe('buyer');
    expect(items[0]?.buyer).toBe('浙江浙能富兴燃料有限公司');
  });

  it('卖方命中', async () => {
    const items = await searchContractLedger(ctx, '焦煤集团', 'u1', 10);
    expect(items[0]?.matchedField).toBe('seller');
  });

  it('标题命中', async () => {
    const items = await searchContractLedger(ctx, '焦炭销售', 'u1', 10);
    expect(items[0]?.contractNo).toBe('HT-2024-002');
    expect(items[0]?.matchedField).toBe('title');
  });

  it('user 隔离: 他人的台账不可见(legacy 空 user_id 行仍可见)', async () => {
    await upsertContractLedgerEntry(ctx, mk({ contractNo: 'OTHER-1' }, 'u2'));
    const items = await searchContractLedger(ctx, 'OTHER', 'u1', 10);
    expect(items).toHaveLength(0);
    const unscoped = await searchContractLedger(ctx, 'OTHER', undefined, 10);
    expect(unscoped).toHaveLength(1);
  });

  it('limit 截断与空结果', async () => {
    expect(await searchContractLedger(ctx, 'CJXC', 'u1', 0)).toEqual([]);
    expect(await searchContractLedger(ctx, '不存在词', 'u1', 10)).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test --workspace apps/server -- test/pipeline/db/contractSearchRepo.test.ts`
Expected: FAIL（searchContractLedger 未导出）

- [ ] **Step 3: 实现 SQLite 版（repositories.ts）**

在 `repositories.ts` 顶部 import 区加入（与现有 contractLedger import 合并即可）：

```ts
import { rankContractSearch, type ContractSearchItem } from '../contractSearch.js';
```

在 `listContractLedgerEntries` 函数结束后插入：

```ts
/** LIKE 模式转义: %/_/\ 在 LIKE 中是通配符, 输入原样匹配时须转义。 */
function likePattern(s: string): string {
  return `%${s.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

const LEDGER_PARTY_KEYS = ['买方', '甲方', '卖方', '乙方'] as const;
const LEDGER_COLS = `contract_no, display_contract_no, doc_type, document_id, title, fields, field_meta,
                   overall_confidence, needs_review, user_id, contract_type`;
type LedgerRow = {
  contract_no: string; display_contract_no: string; doc_type: string; document_id: string;
  title: string; fields: string; field_meta: string; overall_confidence: number;
  needs_review: number; user_id: string; contract_type: string | null;
};

/**
 * 合同台账搜索(spec 2026-08-26 §4.1): SQL LIKE 粗筛(LIMIT 200) + rankContractSearch
 * JS 精排截断 limit。粗筛覆盖 编号(归一化前缀+原文包含)/标题/fields 四个主体键。
 * user 过滤沿用 legacy 3-way OR。PG 走 searchContractLedgerPg。
 */
export async function searchContractLedger(
  ctx: DbContext,
  q: string,
  userId?: string,
  limit = 10,
): Promise<ContractSearchItem[]> {
  if (ctx.backend === 'postgres') return searchContractLedgerPg(ctx, q, userId, limit);
  const raw = q.trim();
  if (!raw) return [];
  const uid = effectiveUserId(userId);
  const like = likePattern(raw);
  const nq = normalizeContractNo(raw);
  const ors: string[] = [
    'contract_no LIKE ? ESCAPE \'\\\'',
    'display_contract_no LIKE ? ESCAPE \'\\\'',
    'title LIKE ? ESCAPE \'\\\'',
  ];
  const params: unknown[] = [like, like, like];
  for (const key of LEDGER_PARTY_KEYS) {
    ors.push(`json_extract(fields, '$.${key}.value') LIKE ? ESCAPE '\\'`);
    params.push(like);
  }
  if (nq) {
    ors.push(`contract_no LIKE ? ESCAPE '\\'`);
    params.push(`${nq.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
  }
  const userWhere = uid ? '(user_id = ? OR user_id = \'\' OR user_id IS NULL) AND ' : '';
  const userParams = uid ? [uid] : [];
  const rows = ctx.sqlite
    .prepare(
      `SELECT ${LEDGER_COLS} FROM contract_ledger
       WHERE ${userWhere}(${ors.join(' OR ')})
       ORDER BY updated_at DESC
       LIMIT 200`,
    )
    .all(...userParams, ...params) as unknown as LedgerRow[];
  const entries: ContractLedgerEntry[] = rows.map((row) => ({
    contractNo: row.contract_no,
    displayContractNo: row.display_contract_no,
    docType: row.doc_type,
    documentId: row.document_id,
    title: row.title,
    contractType: (row.contract_type as ContractLedgerEntry['contractType']) ?? null,
    fields: JSON.parse(row.fields) as ContractLedgerEntry['fields'],
    fieldMeta: JSON.parse(row.field_meta) as ContractLedgerEntry['fieldMeta'],
    overallConfidence: row.overall_confidence,
    needsReview: !!row.needs_review,
    userId: row.user_id,
  }));
  return rankContractSearch(raw, entries, limit);
}
```

注意：`normalizeContractNo` 与 `ContractLedgerEntry` 在 repositories.ts 已有 import（`listContractLedgerEntries` 在用），不要重复引入。

- [ ] **Step 4: 实现 PG 版（postgres-repositories.ts）**

在顶部 import 区加入：

```ts
import { rankContractSearch, type ContractSearchItem } from '../contractSearch.js';
```

在 `listContractLedgerEntriesPg` 后插入：

```ts
/** PG 版合同台账搜索: ILIKE 粗筛(fields 为 jsonb, 用 ->'键'->>'value') + JS 精排。 */
export async function searchContractLedgerPg(
  ctx: PostgresDbContext,
  q: string,
  userId?: string,
  limit = 10,
): Promise<ContractSearchItem[]> {
  const raw = q.trim();
  if (!raw) return [];
  const uid = effectiveUserId(userId);
  const esc = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);
  const like = `%${esc(raw)}%`;
  const nq = esc(normalizeContractNo(raw));
  const ors: string[] = [
    'contract_no ILIKE $1', 'display_contract_no ILIKE $1', 'title ILIKE $1',
    `fields->'买方'->>'value' ILIKE $1`, `fields->'甲方'->>'value' ILIKE $1`,
    `fields->'卖方'->>'value' ILIKE $1`, `fields->'乙方'->>'value' ILIKE $1`,
  ];
  const params: unknown[] = [like];
  if (nq) {
    params.push(`${nq}%`);
    ors.push(`contract_no ILIKE $${params.length}`);
  }
  const where = uid
    ? `(user_id = $${params.length + 1} OR user_id = '' OR user_id IS NULL) AND (${ors.join(' OR ')})`
    : `(${ors.join(' OR ')})`;
  if (uid) params.push(uid);
  const res = await ctx.pool.query(
    `SELECT contract_no, display_contract_no, doc_type, document_id, title, fields, field_meta,
            overall_confidence, needs_review, user_id, contract_type
     FROM contract_ledger WHERE ${where}
     ORDER BY updated_at DESC LIMIT 200`,
    params,
  );
  const entries: ContractLedgerEntry[] = res.rows.map((r) => ({
    contractNo: r.contract_no,
    displayContractNo: r.display_contract_no,
    docType: r.doc_type,
    documentId: r.document_id,
    title: r.title,
    contractType: (r.contract_type as ContractLedgerEntry['contractType']) ?? null,
    fields: r.fields as ContractLedgerEntry['fields'],
    fieldMeta: r.field_meta as ContractLedgerEntry['fieldMeta'],
    overallConfidence: Number(r.overall_confidence),
    needsReview: !!r.needs_review,
    userId: r.user_id,
  }));
  return rankContractSearch(raw, entries, limit);
}
```

然后在 `repositories.ts` 的 `searchContractLedger` PG 分支补 import（若尚未引入）：

```ts
import { searchContractLedgerPg } from './postgres-repositories.js';
```

（repositories.ts 已从 postgres-repositories.ts import 多个 `*Pg` 函数，加到既有 import 列表即可。）

- [ ] **Step 5: 运行确认通过**

Run: `npm test --workspace apps/server -- test/pipeline/db/contractSearchRepo.test.ts test/pipeline/contractSearch.test.ts`
Expected: PASS 全绿（PG 分支在 SQLite 测试中不被触发；PG 行为由编译期类型保证）

- [ ] **Step 6: 类型检查**

Run: `npm run build --workspace apps/server`
Expected: tsc 无错误

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/pipeline/db/repositories.ts apps/server/src/pipeline/db/postgres-repositories.ts apps/server/test/pipeline/db/contractSearchRepo.test.ts
git commit -m "feat(search): searchContractLedger 仓库函数(SQLite+PG, LIKE粗筛+精排)"
```

---

### Task 3: /api/contracts/search 路由

**Files:**
- Create: `apps/server/src/routes/contracts.ts`
- Modify: `apps/server/src/index.ts`（import 区 + L110 附近的 use 块 + L140 附近的 route 块）
- Test: `apps/server/test/routes/contractsSearch.test.ts`

**Interfaces:**
- Consumes: Task 2 `searchContractLedger`。
- Produces（Task 6 依赖）: `GET /api/contracts/search?q=&limit=` → `{ items: ContractSearchItem[] }`（401 未登录 / 400 参数非法）

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/test/routes/contractsSearch.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { AuthEnv } from '../../src/lib/auth-middleware.js';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import { upsertContractLedgerEntry } from '../../src/pipeline/db/repositories.js';
import type { ContractLedgerEntry } from '../../src/pipeline/contractLedger.js';

const { ctxHolder } = vi.hoisted(() => ({ ctxHolder: { current: null as DbContext | null } }));
vi.mock('../../src/pipeline/db/dbBackend.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/pipeline/db/dbBackend.js')>();
  return { ...mod, getDbContext: () => ctxHolder.current };
});
const { contractsRoute } = await import('../../src/routes/contracts.js');

function appAs(userId: string) {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { id: userId, email: 't@t', role: 'trader' } as never);
    await next();
  });
  app.route('/api/contracts', contractsRoute);
  return app;
}

let ctx: DbContext;
beforeEach(() => { ctx = createDb(':memory:'); migrate(ctx.sqlite); ctxHolder.current = ctx; });

async function seed(no: string, buyer?: string) {
  const e: ContractLedgerEntry = {
    contractNo: no, displayContractNo: no, docType: '合同', documentId: 'D1', title: 'T',
    contractType: null,
    fields: buyer
      ? { 合同号: { value: no, sourceSpans: [] }, 买方: { value: buyer, sourceSpans: [] } }
      : { 合同号: { value: no, sourceSpans: [] } },
    fieldMeta: {}, overallConfidence: 1, needsReview: false, userId: 'u1',
  };
  await upsertContractLedgerEntry(ctx, e, 'u1');
}

describe('GET /api/contracts/search', () => {
  it('未认证 -> 401', async () => {
    const app = new Hono<AuthEnv>();
    app.route('/api/contracts', contractsRoute);
    expect((await app.request('/api/contracts/search?q=x')).status).toBe(401);
  });

  it('缺 q / 空白 q -> 400', async () => {
    expect((await appAs('u1').request('/api/contracts/search')).status).toBe(400);
    expect((await appAs('u1').request('/api/contracts/search?q=%20%20')).status).toBe(400);
  });

  it('limit 越界 -> 400', async () => {
    expect((await appAs('u1').request('/api/contracts/search?q=a&limit=21')).status).toBe(400);
    expect((await appAs('u1').request('/api/contracts/search?q=a&limit=0')).status).toBe(400);
  });

  it('按买方模糊命中并返回分组字段', async () => {
    await seed('CJXC-1', '浙江浙能富兴燃料有限公司');
    const res = await appAs('u1').request('/api/contracts/search?q=' + encodeURIComponent('浙能富兴'));
    expect(res.status).toBe(200);
    const data = await res.json() as { items: Array<{ contractNo: string; matchedField: string; buyer: string }> };
    expect(data.items).toHaveLength(1);
    expect(data.items[0]?.matchedField).toBe('buyer');
    expect(data.items[0]?.buyer).toBe('浙江浙能富兴燃料有限公司');
  });

  it('默认 limit=10 生效', async () => {
    for (let i = 0; i < 12; i++) await seed(`BULK-${String(i).padStart(2, '0')}`);
    const res = await appAs('u1').request('/api/contracts/search?q=BULK');
    const data = await res.json() as { items: unknown[] };
    expect(data.items).toHaveLength(10);
  });

  it('空结果 -> items: [] 而非 404', async () => {
    const res = await appAs('u1').request('/api/contracts/search?q=zzz');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { items: unknown[] }).items).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test --workspace apps/server -- test/routes/contractsSearch.test.ts`
Expected: FAIL（routes/contracts.ts 不存在）

- [ ] **Step 3: 实现路由**

```ts
// apps/server/src/routes/contracts.ts
// 合同搜索 REST 面(spec 2026-08-26 §4.1)。挂在 /api/contracts(requireAuth,
// index.ts)。只读; 供图谱页/绑定页搜索组合框共用。
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../lib/auth-middleware.js';
import { getDbContext } from '../pipeline/db/dbBackend.js';
import { searchContractLedger } from '../pipeline/db/repositories.js';

export const contractsRoute = new Hono<AuthEnv>();

contractsRoute.use('*', async (c, next) => {
  if (!c.get('user')) return c.json({ error: 'unauthorized' }, 401);
  await next();
});

const searchSchema = z.object({
  q: z.string().trim().min(1, 'q 必填'),
  limit: z.coerce.number().int().min(1).max(20).default(10),
});

/** GET /search?q=&limit= — 台账模糊搜索(编号/买方/卖方/标题), 分组字段 matchedField。 */
contractsRoute.get('/search', async (c) => {
  const user = c.get('user')!;
  const parsed = searchSchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json(
      { error: 'invalid query params', detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) },
      400,
    );
  }
  const { q, limit } = parsed.data;
  const items = await searchContractLedger(getDbContext(), q, user.id, limit);
  return c.json({ items });
});
```

- [ ] **Step 4: 注册到 index.ts**

三处编辑（锚点：`app.use('/api/bindings/*', requireAuth);` 与 `app.route('/api/bindings', bindingsRoute);`）：

```ts
// import 区(与 bindingsRoute import 相邻):
import { contractsRoute } from './routes/contracts.js';

// use 块(app.use('/api/bindings/*', requireAuth); 之后):
app.use('/api/contracts/*', requireAuth);

// route 块(app.route('/api/bindings', bindingsRoute); 之后):
// 合同搜索(spec 2026-08-26): 图谱/绑定页共用组合框。
app.route('/api/contracts', contractsRoute);
```

- [ ] **Step 5: 运行确认通过 + 类型检查**

Run: `npm test --workspace apps/server -- test/routes/contractsSearch.test.ts && npm run build --workspace apps/server`
Expected: 测试 PASS，tsc 无错误

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/routes/contracts.ts apps/server/src/index.ts apps/server/test/routes/contractsSearch.test.ts
git commit -m "feat(api): GET /api/contracts/search 合同模糊搜索端点"
```

---

### Task 4: /api/graph/schema 端点（图例计数）

**Files:**
- Modify: `apps/server/src/graph/repo.ts`（文件尾部追加）
- Modify: `apps/server/src/routes/graph.ts`（在 `/resolve` 端点后追加）
- Test: `apps/server/test/graph/graphLabelCounts.test.ts`
- Test: `apps/server/test/routes/graphSchema.test.ts`

**Interfaces:**
- Consumes: `getDriver`（repo.ts 已有）。
- Produces（Task 8 依赖）: `graphLabelCounts(): Promise<Array<{ label: string; count: number }>>`（60s 进程内缓存）；`GET /api/graph/schema` → `{ labels: Array<{ label: string; count: number }> }`

- [ ] **Step 1: 写失败测试（缓存 + 计数）**

```ts
// apps/server/test/graph/graphLabelCounts.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

const runMock = vi.fn();
const closeMock = vi.fn();
vi.mock('../../src/graph/neo4j.js', () => ({
  getDriver: () => ({
    session: () => ({
      run: runMock,
      close: closeMock,
    }),
  }),
}));

// 缓存有状态, 动态 import 以便 reset 后重新加载模块
async function loadFresh() {
  const mod = await import('../../src/graph/repo.js');
  return mod;
}

beforeEach(() => {
  vi.resetModules();
  runMock.mockReset();
  closeMock.mockReset();
  // MATCH (n) UNWIND labels(n) AS label RETURN label, count(n) AS count
  runMock.mockResolvedValue({
    records: [
      { get: (k: string) => (k === 'label' ? 'Contract' : 12) },
      { get: (k: string) => (k === 'label' ? 'Party' : 34) },
    ],
  });
});

describe('graphLabelCounts', () => {
  it('单查询聚合 label 计数并降序', async () => {
    const { graphLabelCounts } = await loadFresh();
    const out = await graphLabelCounts();
    expect(out).toEqual([
      { label: 'Party', count: 34 },
      { label: 'Contract', count: 12 },
    ]);
    expect(runMock).toHaveBeenCalledTimes(1);
  });

  it('60s 内重复调用走缓存(不再查询); reset 后重新查询', async () => {
    const { graphLabelCounts, __resetLabelCountsCacheForTests } = await loadFresh();
    await graphLabelCounts();
    await graphLabelCounts();
    expect(runMock).toHaveBeenCalledTimes(1);
    __resetLabelCountsCacheForTests();
    await graphLabelCounts();
    expect(runMock).toHaveBeenCalledTimes(2);
  });

  it('neo4j Integer 形状(count.toNumber)也可解析', async () => {
    runMock.mockResolvedValue({
      records: [{ get: (k: string) => (k === 'label' ? 'Contract' : { toNumber: () => 7 }) }],
    });
    const { graphLabelCounts } = await loadFresh();
    expect((await graphLabelCounts())[0]?.count).toBe(7);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test --workspace apps/server -- test/graph/graphLabelCounts.test.ts`
Expected: FAIL（graphLabelCounts 不存在）

- [ ] **Step 3: 实现 repo 函数（graph/repo.ts 尾部）**

```ts
// ---- 图 schema(图例计数, spec 2026-08-26 §4.1) --------------------------------
//
// 单条 Cypher 聚合全部 label 计数; 进程内缓存 60s(图例徽标轮询代价可控)。
// 部署侧 Neo4j 5.26, count() 返回 Integer, 统一转 number。

let labelCountsCache: { at: number; labels: Array<{ label: string; count: number }> } | null = null;
const LABEL_COUNTS_TTL_MS = 60_000;

/** 测试钩子: 清空 schema 缓存。 */
export function __resetLabelCountsCacheForTests(): void {
  labelCountsCache = null;
}

export async function graphLabelCounts(): Promise<Array<{ label: string; count: number }>> {
  if (labelCountsCache && Date.now() - labelCountsCache.at < LABEL_COUNTS_TTL_MS) {
    return labelCountsCache.labels;
  }
  const session = getDriver().session();
  try {
    const result = await session.run(
      'MATCH (n) UNWIND labels(n) AS label RETURN label, count(n) AS count ORDER BY count DESC',
    );
    const labels = result.records.map((r) => {
      const v = r.get('count');
      const count = typeof v === 'number' ? v : (v as { toNumber(): number }).toNumber();
      return { label: String(r.get('label')), count };
    });
    labelCountsCache = { at: Date.now(), labels };
    return labels;
  } finally {
    await session.close();
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test --workspace apps/server -- test/graph/graphLabelCounts.test.ts`
Expected: PASS

- [ ] **Step 5: 路由测试 + 路由实现**

路由测试（mock repo 层，验证 401/200/503 三态）：

```ts
// apps/server/test/routes/graphSchema.test.ts
import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import type { AuthEnv } from '../../src/lib/auth-middleware.js';

vi.mock('../../src/graph/repo.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/graph/repo.js')>();
  return { ...mod, graphLabelCounts: vi.fn() };
});
const { graphRoute } = await import('../../src/routes/graph.js');
const { graphLabelCounts } = await import('../../src/graph/repo.js');

function appAs(userId?: string) {
  const app = new Hono<AuthEnv>();
  if (userId) {
    app.use('*', async (c, next) => {
      c.set('user', { id: userId, email: 't@t', role: 'trader' } as never);
      await next();
    });
  }
  app.route('/api/graph', graphRoute);
  return app;
}

describe('GET /api/graph/schema', () => {
  it('未认证 -> 401', async () => {
    expect((await appAs().request('/api/graph/schema')).status).toBe(401);
  });

  it('返回 labels 计数', async () => {
    vi.mocked(graphLabelCounts).mockResolvedValue([{ label: 'Contract', count: 3 }]);
    const res = await appAs('u1').request('/api/graph/schema');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ labels: [{ label: 'Contract', count: 3 }] });
  });

  it('图谱不可用 -> 503', async () => {
    vi.mocked(graphLabelCounts).mockRejectedValue(new Error('Neo4jError: Connection refused'));
    const res = await appAs('u1').request('/api/graph/schema');
    expect(res.status).toBe(503);
  });
});
```

> 注意：`isGraphUnavailable` 的判定逻辑以 `graph.ts` 顶部现有实现为准——测试里的 503 断言依赖它把 `Neo4jError` 识别为不可用。**先读 `graph.ts` 顶部的 `isGraphUnavailable`**，若判定条件不同（如只认 `ServiceUnavailable`），把 mock 的错误消息改成能命中的那种。

路由实现（`graph.ts`，紧跟 `/resolve` 端点后；`graphLabelCounts` 加入文件顶部 repo import 列表）：

```ts
/** GET /api/graph/schema — 全部 label 计数(图例徽标, 60s 服务端缓存)。 */
graphRoute.get('/schema', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  try {
    const labels = await graphLabelCounts();
    return c.json({ labels });
  } catch (e) {
    if (isGraphUnavailable(e)) {
      return c.json({ error: '图谱服务未配置或不可用' }, 503);
    }
    console.error('[graph] graphLabelCounts failed:', errDetail(e));
    return c.json({ error: 'schema query failed', detail: errDetail(e) }, 500);
  }
});
```

- [ ] **Step 6: 运行全部新测试 + 类型检查**

Run: `npm test --workspace apps/server -- test/graph/graphLabelCounts.test.ts test/routes/graphSchema.test.ts && npm run build --workspace apps/server`
Expected: PASS + tsc 无错误

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/graph/repo.ts apps/server/src/routes/graph.ts apps/server/test/graph/graphLabelCounts.test.ts apps/server/test/routes/graphSchema.test.ts
git commit -m "feat(api): GET /api/graph/schema 图例 label 计数(60s缓存)"
```

---

### Task 5: web businessTypes.ts 业务类型注册表（迁移 kinds.ts）

**Files:**
- Create: `apps/web/src/components/graph/businessTypes.ts`
- Delete: `apps/web/src/components/graph/kinds.ts`
- Modify: 所有 import kinds 的文件（用 grep 找全：`apps/web/src/components/graph/DocumentListPanel.tsx`、`graph/DetailPanel.tsx`、`graph/docMeta.ts`（若引用）、`bindings/DocListPanel.tsx`、`bindings/BindingMiniGraph.tsx` 等；GraphView/GraphCanvas 在 Task 8 重写，此处一并替换即可）

**Interfaces:**
- Produces（Task 8 依赖）: 保留 kinds.ts 全部既有导出（`KIND_ICONS`、`KindStyle`、`KIND_STYLES`、`kindStyle`、`EDGE_LABELS`、`EDGE_STYLE_OVERRIDES`、`edgeLabel`、`DocMeta`、`DocMetaResolver`、`docIdOf`、`nodeDisplayName`、`docTypeName`、`prettyDocName`），新增：
  - `interface BusinessType { label: string; displayName: string; color: string; softBg: string; softBorder: string; icon: LucideIcon; defaultVisible: boolean }`
  - `BUSINESS_TYPES: Record<string, BusinessType>`
  - `businessTypeOf(kind: string): BusinessType`（未知 kind 回退灰色"节点"）

- [ ] **Step 1: 创建 businessTypes.ts**

内容 = 现 `kinds.ts` 全文（130 行）原样迁移，文件头注释改为业务类型注册表说明，并在 `KIND_STYLES` 定义之后追加：

```ts
/** 业务类型注册表(spec 2026-08-26 §4.2, Bloom Perspective 轻量版):
 *  Neo4j 原始 label -> 展示名/配色/图标/默认可见。图谱图例、类型过滤、
 *  Inspector 与搜索摘要共用这一份 SSOT。 */
export interface BusinessType {
  /** Neo4j 原始 label(= kind)。 */
  label: string;
  displayName: string;
  color: string;
  softBg: string;
  softBorder: string;
  icon: LucideIcon;
  defaultVisible: boolean;
}

const FALLBACK_ICON: LucideIcon = FileText;

export const BUSINESS_TYPES: Record<string, BusinessType> = Object.fromEntries(
  Object.keys(KIND_STYLES).map((k) => {
    const s = KIND_STYLES[k]!;
    return [k, {
      label: k,
      displayName: s.label,
      color: s.color,
      softBg: s.softBg,
      softBorder: s.softBorder,
      icon: KIND_ICONS[k] ?? FALLBACK_ICON,
      defaultVisible: true,
    }];
  }),
) as Record<string, BusinessType>;

const FALLBACK_BUSINESS_TYPE: BusinessType = {
  label: '', displayName: '节点', color: '#6B7280', softBg: '#F3F4F6',
  softBorder: '#E5E7EB', icon: FALLBACK_ICON, defaultVisible: true,
};

export function businessTypeOf(kind: string): BusinessType {
  return BUSINESS_TYPES[kind] ?? { ...FALLBACK_BUSINESS_TYPE, label: kind };
}
```

- [ ] **Step 2: 删除 kinds.ts 并批量替换 import**

```bash
cd apps/web/src && grep -rl "from '\./kinds'\|from '\.\./graph/kinds'" . | xargs sed -i "s#from '\./kinds'#from './businessTypes'#; s#from '\.\./graph/kinds'#from '../graph/businessTypes'#"
rm components/graph/kinds.ts
```

再 grep 验证无残留：`grep -rn "graph/kinds\|'\./kinds'" apps/web/src` → 无输出。

- [ ] **Step 3: 类型检查 + lint**

Run: `npm run build --workspace apps/web && npm run lint`
Expected: tsc -b 无错误（GraphView/GraphCanvas 的 import 已被替换，仍引用同名导出，不受影响）

- [ ] **Step 4: Commit**

```bash
git add -A apps/web/src
git commit -m "refactor(web): kinds.ts 迁移为 businessTypes.ts 业务类型注册表"
```

---

### Task 6: web 合同搜索 API + ContractSearchBar 组合框

**Files:**
- Create: `apps/web/src/api/contractSearch.ts`
- Create: `apps/web/src/components/common/ContractSearchBar.tsx`

**Interfaces:**
- Consumes: Task 3 端点 `GET /api/contracts/search`。
- Produces（Task 7/8 依赖）:
  - `interface ContractSearchItem { contractNo: string; displayContractNo: string; title: string; buyer: string | null; seller: string | null; docType: string; overallConfidence: number; matchedField: 'contractNo' | 'buyer' | 'seller' | 'title' }`
  - `fetchContractSearch(q: string, limit?: number, signal?: AbortSignal): Promise<ContractSearchItem[]>`（失败 throw Error 中文消息）
  - `fetchGraphSchema(): Promise<Array<{ label: string; count: number }>>`（失败返回 `[]`，静默降级）
  - `<ContractSearchBar placeholder? onSelect idleItems? itemNote? className? />`，`onSelect(item: ContractSearchItem): void`；`idleItems?: ContractSearchItem[]`（空输入聚焦时展示）；`itemNote?: (item: ContractSearchItem) => string | null`（每项右侧小徽标文案）

- [ ] **Step 1: API 模块**

```ts
// apps/web/src/api/contractSearch.ts
// 合同搜索 + 图 schema API(照 useGraph.ts 的 getJson 模式: 信封兼容 + 中文错误)。

export interface ContractSearchItem {
  contractNo: string;
  displayContractNo: string;
  title: string;
  buyer: string | null;
  seller: string | null;
  docType: string;
  overallConfidence: number;
  matchedField: 'contractNo' | 'buyer' | 'seller' | 'title';
}

export interface GraphLabelCount {
  label: string;
  count: number;
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: 'include', signal });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new Error('网络错误，请稍后重试');
  }
  if (!res.ok) {
    let message = `请求失败（${res.status}）`;
    try {
      const data = (await res.json()) as { error?: unknown; message?: unknown };
      const serverMsg =
        typeof data.error === 'string' && data.error
          ? data.error
          : typeof data.message === 'string' && data.message
            ? data.message
            : '';
      if (serverMsg) message = serverMsg;
    } catch { /* 非 JSON 响应 */ }
    throw new Error(message);
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new Error('响应格式异常');
  }
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const envelope = data as { ok?: unknown; data?: unknown };
    if (envelope.ok === true && 'data' in envelope) data = envelope.data;
  }
  return data as T;
}

function asStr(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function normalizeItem(raw: Record<string, unknown>): ContractSearchItem | null {
  const contractNo = asStr(raw.contractNo);
  if (!contractNo) return null;
  const matchedField = asStr(raw.matchedField);
  return {
    contractNo,
    displayContractNo: asStr(raw.displayContractNo) || contractNo,
    title: asStr(raw.title),
    buyer: asStr(raw.buyer) || null,
    seller: asStr(raw.seller) || null,
    docType: asStr(raw.docType),
    overallConfidence: typeof raw.overallConfidence === 'number' ? raw.overallConfidence : 0,
    matchedField:
      matchedField === 'buyer' || matchedField === 'seller' || matchedField === 'title'
        ? matchedField
        : 'contractNo',
  };
}

export async function fetchContractSearch(
  q: string,
  limit = 10,
  signal?: AbortSignal,
): Promise<ContractSearchItem[]> {
  const qs = new URLSearchParams({ q, limit: String(limit) });
  const data = await getJson<{ items?: unknown[] }>(`/api/contracts/search?${qs.toString()}`, signal);
  const rawList = Array.isArray(data?.items) ? data.items : [];
  return rawList
    .map((raw) => (raw && typeof raw === 'object' ? normalizeItem(raw as Record<string, unknown>) : null))
    .filter((x): x is ContractSearchItem => x !== null);
}

/** 图例计数; 失败静默降级为 [](图例退化为静态注册表)。 */
export async function fetchGraphSchema(): Promise<GraphLabelCount[]> {
  try {
    const data = await getJson<{ labels?: unknown[] }>('/api/graph/schema');
    const rawList = Array.isArray(data?.labels) ? data.labels : [];
    return rawList
      .map((raw) => {
        const r = raw as Record<string, unknown>;
        return { label: asStr(r.label), count: typeof r.count === 'number' ? r.count : 0 };
      })
      .filter((x) => x.label.length > 0);
  } catch {
    return [];
  }
}
```

- [ ] **Step 2: ContractSearchBar 组件**

```tsx
// apps/web/src/components/common/ContractSearchBar.tsx
// 合同搜索组合框(spec 2026-08-26 §4.3): 防抖 200ms -> /api/contracts/search,
// 下拉按 matchedField 分组(合同编号/买方/卖方/标题), 键盘导航, 竞态取最后请求。
import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { Loader2, Search } from 'lucide-react';
import { fetchContractSearch, type ContractSearchItem } from '../../api/contractSearch';

const GROUP_ORDER: Array<{ field: ContractSearchItem['matchedField']; label: string }> = [
  { field: 'contractNo', label: '合同编号' },
  { field: 'buyer', label: '买方' },
  { field: 'seller', label: '卖方' },
  { field: 'title', label: '标题' },
];

interface ContractSearchBarProps {
  placeholder?: string;
  onSelect: (item: ContractSearchItem) => void;
  /** 空输入聚焦时展示的默认候选(如 CandidatePanel 的台账前 N 条)。 */
  idleItems?: ContractSearchItem[];
  /** 每项右侧徽标文案(如 已挂合同文件)。 */
  itemNote?: (item: ContractSearchItem) => string | null;
  className?: string;
}

export function ContractSearchBar({
  placeholder = '搜索合同：编号 / 买方 / 卖方 / 标题',
  onSelect,
  idleItems,
  itemNote,
  className,
}: ContractSearchBarProps) {
  const [text, setText] = useState('');
  const [items, setItems] = useState<ContractSearchItem[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 防抖 + 竞态(AbortController, 后发先至丢弃)
  useEffect(() => {
    const q = text.trim();
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!q) {
      abortRef.current?.abort();
      setItems([]);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    debounceRef.current = setTimeout(() => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      fetchContractSearch(q, 10, ac.signal)
        .then((list) => {
          if (ac.signal.aborted) return;
          setItems(list);
          setError(null);
          setActiveIndex(0);
        })
        .catch((e) => {
          if (ac.signal.aborted || (e instanceof DOMException && e.name === 'AbortError')) return;
          setItems([]);
          setError(e instanceof Error ? e.message : '搜索失败');
        })
        .finally(() => {
          if (!ac.signal.aborted) setLoading(false);
        });
    }, 200);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [text]);

  // 点击外部关闭
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const flatItems = text.trim() ? items : (idleItems ?? []);

  const choose = (item: ContractSearchItem) => {
    onSelect(item);
    setText('');
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open && (e.key === 'ArrowDown' || e.key === 'Enter')) {
      setOpen(true);
      return;
    }
    if (e.key === 'ArrowDown' && flatItems.length > 0) {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % flatItems.length);
    } else if (e.key === 'ArrowUp' && flatItems.length > 0) {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + flatItems.length) % flatItems.length);
    } else if (e.key === 'Enter' && open && flatItems[activeIndex]) {
      e.preventDefault();
      choose(flatItems[activeIndex]!);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  let runningIndex = -1;

  return (
    <div ref={rootRef} className={clsx('relative', className)}>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-soft" aria-hidden />
        <input
          type="text"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          className="h-8 w-full rounded-md border border-line bg-white pl-8 pr-7 text-[12px] text-ink focus:border-primary focus:outline-none"
        />
        {loading && (
          <Loader2 className="absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-ink-soft" aria-hidden />
        )}
      </div>
      {open && (
        <div className="absolute left-0 top-9 z-30 max-h-72 w-[340px] overflow-auto rounded-md border border-line bg-white py-1 shadow-card">
          {error && <div className="px-3 py-2 text-[12px] text-danger">搜索暂不可用：{error}</div>}
          {!error && flatItems.length === 0 && (
            <div className="px-3 py-2 text-[12px] text-ink-soft">
              {text.trim() ? `没有匹配「${text.trim()}」的合同` : '输入关键词搜索合同'}
            </div>
          )}
          {!error &&
            GROUP_ORDER.map(({ field, label }) => {
              const group = flatItems.filter((it) => it.matchedField === field);
              if (group.length === 0) return null;
              return (
                <div key={field}>
                  <div className="bg-surface px-3 py-1 text-[10px] font-medium text-ink-soft">{label}</div>
                  {group.map((it) => {
                    runningIndex += 1;
                    const idx = runningIndex;
                    const note = itemNote?.(it) ?? null;
                    return (
                      <button
                        key={it.contractNo}
                        type="button"
                        onMouseEnter={() => setActiveIndex(idx)}
                        onClick={() => choose(it)}
                        className={clsx(
                          'block w-full px-3 py-1.5 text-left',
                          idx === activeIndex ? 'bg-primary/10' : 'hover:bg-surface',
                        )}
                      >
                        <div className="flex items-center gap-2">
                          <span className="max-w-[220px] truncate text-[12px] font-medium text-ink">
                            {it.displayContractNo || it.contractNo}
                          </span>
                          {it.title && (
                            <span className="max-w-[90px] truncate text-[11px] text-ink-soft">{it.title}</span>
                          )}
                          {note && (
                            <span className="ml-auto shrink-0 rounded border border-line bg-surface px-1 py-px text-[10px] text-ink-soft">
                              {note}
                            </span>
                          )}
                        </div>
                        {(it.buyer || it.seller) && (
                          <div className="mt-0.5 truncate text-[11px] text-ink-soft">
                            {[it.buyer, it.seller].filter(Boolean).join(' -> ')}
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: 类型检查 + lint**

Run: `npm run build --workspace apps/web && npm run lint`
Expected: 无错误（组件尚未被引用，仅编译验证）

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/api/contractSearch.ts apps/web/src/components/common/ContractSearchBar.tsx
git commit -m "feat(web): ContractSearchBar 合同搜索组合框 + API 模块"
```

---

### Task 7: 绑定页接线（顶部合同搜索 + CandidatePanel 升级）

**Files:**
- Modify: `apps/web/src/components/bindings/BindingsView.tsx`
- Modify: `apps/web/src/components/bindings/CandidatePanel.tsx`

**Interfaces:**
- Consumes: Task 6 `ContractSearchBar`/`ContractSearchItem`；既有 `handleSelectDoc`（BindingsView 内）、`contracts`/`establishedContracts`/`isExecutionDoc`（CandidatePanel 内）。
- Produces: 无对外新接口（页面内接线）。

- [ ] **Step 1: BindingsView 顶部搜索**

1) import 区加：

```ts
import { ContractSearchBar } from '../common/ContractSearchBar';
import type { ContractSearchItem } from '../../api/contractSearch';
import { X } from 'lucide-react'; // 若未引入
```

2) 状态区（`selectedDocId` 状态旁）加：

```ts
// 合同过滤(spec 2026-08-26 §4.5): 选中合同 -> 左栏只显示绑定该合同的文档并定位首个。
const [contractFilter, setContractFilter] = useState<ContractSearchItem | null>(null);
const filteredOverview = useMemo(() => {
  if (!contractFilter) return overview;
  return overview.filter((d) => d.bindings.some((b) => b.contractNo === contractFilter.contractNo));
}, [overview, contractFilter]);
const handleContractSelect = useCallback(
  (item: ContractSearchItem) => {
    setContractFilter(item);
    const first = overview.find((d) => d.bindings.some((b) => b.contractNo === item.contractNo));
    if (first) handleSelectDoc(first);
  },
  [overview, handleSelectDoc],
);
```

（若 `handleSelectDoc` 是普通函数而非 useCallback，引用即可，不必改它；去掉 useCallback 依赖数组中的该项。）

3) 工具条渲染（`未绑定 N` 徽章之前，即 `{/* 二级工具条 */}` 区域内左段）加：

```tsx
<ContractSearchBar
  className="w-[300px]"
  onSelect={handleContractSelect}
/>
{contractFilter && (
  <span className="flex items-center gap-1 rounded-md bg-primary/10 px-2 py-1 text-[11px] text-primary-500">
    <span className="max-w-[160px] truncate">合同 {contractFilter.displayContractNo}</span>
    <button
      type="button"
      aria-label="清除合同过滤"
      onClick={() => setContractFilter(null)}
      className="text-primary-500 hover:text-danger"
    >
      <X className="h-3 w-3" aria-hidden />
    </button>
  </span>
)}
```

4) `DocListPanel` 的 `docs={overview}` 改为 `docs={filteredOverview}`（L622）。

- [ ] **Step 2: CandidatePanel 手动绑定表单替换**

删除：`manualSearch` state、`filteredContracts` memo、`establishedOptions`/`unestablishedOptions` memo、以及"搜索合同"input + "选择合同"`<select>` 整块（L359-400 区域，含"没有匹配"提示；保留其后的 关系类型/备注 字段与业务顺序提示文案）。

替换为：

```tsx
<div>
  <label className="text-[11px] font-medium text-ink-soft">搜索合同</label>
  <ContractSearchBar
    placeholder="按合同编号 / 买方 / 卖方 / 标题搜索"
    idleItems={contracts.slice(0, 20).map((c) => ({
      contractNo: c.contractNo,
      displayContractNo: c.displayContractNo,
      title: c.title,
      buyer: null,
      seller: null,
      docType: c.docType,
      overallConfidence: c.overallConfidence,
      matchedField: 'contractNo' as const,
    }))}
    itemNote={(it) =>
      establishedContracts.has(it.contractNo)
        ? '已挂合同文件'
        : isExecutionDoc
          ? '未挂合同文件（不可选）'
          : '未挂合同文件'
    }
    onSelect={(it) => {
      if (isExecutionDoc && !establishedContracts.has(it.contractNo)) {
        setFormError('执行类单据只能绑定「已挂合同文件」的合同；请先把合同类型文件绑定到该合同（关系选「引用」）');
        return;
      }
      setFormError(null);
      setManualContract(it.contractNo);
    }}
  />
  {manualContract && (
    <div className="mt-1 flex items-center gap-1 text-[11px] text-ink-soft">
      <span className="truncate">
        已选 {contracts.find((c) => c.contractNo === manualContract)?.displayContractNo ?? manualContract}
      </span>
      <button type="button" onClick={() => setManualContract('')} className="text-danger hover:underline">
        清除
      </button>
    </div>
  )}
  {isExecutionDoc && (
    <div className="mt-1 text-[11px] leading-4 text-ink-soft">
      执行类单据只能绑定到「已挂合同文件」的合同；请先把合同类型文件绑定到该合同（关系选「引用」）
    </div>
  )}
</div>
```

同时：import 区加 `import { ContractSearchBar } from '../common/ContractSearchBar';`，删掉不再使用的 `manualSearch`/`filteredContracts`/`establishedOptions`/`unestablishedOptions`（oxlint 会揪未使用变量，务必删干净）。

- [ ] **Step 3: 类型检查 + lint + 手工冒烟**

Run: `npm run build --workspace apps/web && npm run lint`
Expected: 无错误

手工冒烟（若本地 dev server 已在跑，直接热更新验证；否则跳过，Task 9 统一验收）：
- 绑定页顶部搜买方名片段 → 下拉出现"买方"分组；选中 → 左栏只剩绑定该合同的文档且自动选中首个；点 X 恢复。
- 展开手动创建绑定 → 聚焦空输入显示台账前 20 条（含"已挂/未挂"徽标）；执行类单据选未挂合同 → 报错提示且不选中。

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/bindings/BindingsView.tsx apps/web/src/components/bindings/CandidatePanel.tsx
git commit -m "feat(web): 绑定页合同搜索接线(顶部过滤+手动绑定组合框)"
```

---

### Task 8: 图谱页 G6 v5 重写 + 类型过滤 + 搜索跳转 + 薄互通

**Files:**
- Modify: `apps/web/package.json`（新增依赖）
- Rewrite: `apps/web/src/components/graph/GraphCanvas.tsx`
- Modify: `apps/web/src/components/graph/GraphView.tsx`
- Modify: `apps/web/src/components/graph/DetailPanel.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/components/bindings/BindingsView.tsx`（focus prop）

**Interfaces:**
- Consumes: Task 5 `businessTypes.ts` 全部导出；Task 6 `ContractSearchBar`/`fetchGraphSchema`；既有 `/api/graph/resolve`（`GET ?contractNo=` → `{ doc: GraphEntity|null, contract: GraphEntity|null }`）与 `/api/graph/query`。
- Produces:
  - `GraphCanvasProps { subgraph: Subgraph; centerElementId: string | null; hiddenKinds: ReadonlySet<string>; onHover: (t: InspectTarget | null) => void; onNodeSelect: (n: GraphNode) => void; onEdgeSelect: (e: GraphEdge) => void; onPaneSelect: () => void; onNodeDoubleClick: (n: GraphNode) => void }`
  - App 层 `onOpenInBindings(docId: string)` 回调（GraphView → DetailPanel"去审核"）。

- [ ] **Step 1: 安装 G6**

```bash
npm install --workspace @sca/web @antv/g6@^5.0.0
```

**Step 2: 核对 G6 v5 API（必做，防计划代码与实际 API 偏差）**

打开 `node_modules/@antv/g6/`（或其 `lib/index.d.ts` / 官方文档），核对以下名称并记录实际拼写，后续代码以实际为准：
`new Graph({ container, data, node, edge, layout, behaviors, plugins, animation })`；behaviors `drag-canvas`/`zoom-canvas`/`drag-element`/`click-select`；layout type（force 系）；事件 `node:click`/`edge:click`/`canvas:click`/`node:dblclick`/`node:pointerenter`/`node:pointerleave`；方法 `render()`/`setData()`/`destroy()`/`focusElement(id)`/`fitView()`；插件 `{ type: 'minimap', size: [140, 90] }`。
**props 契约不可改**；API 名称有出入时以类型定义为准调整内部实现。

- [ ] **Step 3: 重写 GraphCanvas.tsx**

```tsx
// apps/web/src/components/graph/GraphCanvas.tsx
// G6 v5 画布(spec 2026-08-26 §4.4): 命令式生命周期 + 稳定 props 契约。
// GraphView 以 key={center-depth-direction} 重挂载本组件, 内部不做增量 diff,
// 只在 hiddenKinds 变化时 setData 重绘。@xyflow/react 退役(本期仅 BindingMiniGraph 仍用)。
import { useEffect, useMemo, useRef } from 'react';
import { Graph as G6Graph } from '@antv/g6';
import type { GraphDirection, GraphEdge, GraphNode, InspectTarget, Subgraph } from '../../hooks/useGraph';
import { EDGE_STYLE_OVERRIDES, businessTypeOf, edgeLabel, nodeDisplayName } from './businessTypes';
import { useDocMeta } from './docMeta';

interface GraphCanvasProps {
  subgraph: Subgraph;
  centerElementId: string | null;
  /** 隐藏的节点类型(图例点选过滤), 空集合 = 全部可见。 */
  hiddenKinds: ReadonlySet<string>;
  onHover: (t: InspectTarget | null) => void;
  onNodeSelect: (node: GraphNode) => void;
  onEdgeSelect: (edge: GraphEdge) => void;
  onPaneSelect: () => void;
  /** 双击节点 = 增量展开(以该节点为新中心, Bloom 核心交互)。 */
  onNodeDoubleClick: (node: GraphNode) => void;
}

interface CanvasDatum {
  kind: string;
  name: string;
  props: Record<string, unknown> | null;
  rawNode?: GraphNode;
  rawEdge?: GraphEdge;
}

export function GraphCanvas({
  subgraph, centerElementId, hiddenKinds, onHover, onNodeSelect, onEdgeSelect, onPaneSelect, onNodeDoubleClick,
}: GraphCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<G6Graph | null>(null);
  const docMeta = useDocMeta();

  const toNodes = (nodes: GraphNode[]) =>
    nodes
      .filter((n) => !hiddenKinds.has(n.kind))
      .map((n) => {
        const bt = businessTypeOf(n.kind);
        const isCenter = n.elementId === centerElementId;
        return {
          id: n.elementId,
          data: { kind: n.kind, name: n.name, props: n.props, rawNode: n } as CanvasDatum,
          style: {
            size: isCenter ? 44 : 30,
            fill: bt.color,
            // Document=空心(描边家族区分), 实体=实心, 对齐原画布视觉
            ...(n.kind === 'Document' ? { fill: '#FFFFFF', lineWidth: 2, stroke: bt.color } : {}),
            labelText: nodeDisplayName(n, docMeta),
            labelPlacement: 'bottom' as const,
            labelFill: '#374151',
            labelFontSize: 11,
          },
        };
      });

  const toEdges = (edges: GraphEdge[], visibleNodeIds: Set<string>) =>
    edges
      .filter((e) => visibleNodeIds.has(e.srcId) && visibleNodeIds.has(e.dstId))
      .map((e) => {
        const override = EDGE_STYLE_OVERRIDES[e.type];
        return {
          id: e.elementId,
          source: e.srcId,
          target: e.dstId,
          data: { kind: e.type, name: e.type, props: e.props, rawEdge: e } as CanvasDatum,
          style: {
            stroke: override?.color ?? '#94A3B8',
            lineWidth: 1,
            ...(override?.dashed ? { lineDash: [4, 3] } : {}),
            labelText: edgeLabel(e.type),
            labelFontSize: 10,
            labelFill: '#6B7280',
            endArrow: true,
          },
        };
      });

  // 建图(重挂载时全量重建)
  useEffect(() => {
    if (!containerRef.current) return;
    const nodes = toNodes(subgraph.nodes);
    const nodeIds = new Set(nodes.map((n) => n.id));
    const edges = toEdges(subgraph.edges, nodeIds);
    const graph = new G6Graph({
      container: containerRef.current,
      autoFit: 'view',
      data: { nodes, edges },
      layout: { type: 'force', linkDistance: 90, nodeStrength: -120, collide: 22 },
      behaviors: ['drag-canvas', 'zoom-canvas', 'drag-element', 'click-select'],
      plugins: [{ type: 'minimap', size: [140, 90] }],
      animation: false,
    });
    graphRef.current = graph;

    graph.on('node:click', (ev) => {
      const raw = (ev.target?.getData?.() as CanvasDatum | undefined)?.rawNode;
      if (raw) onNodeSelect(raw);
    });
    graph.on('edge:click', (ev) => {
      const raw = (ev.target?.getData?.() as CanvasDatum | undefined)?.rawEdge;
      if (raw) onEdgeSelect(raw);
    });
    graph.on('canvas:click', () => onPaneSelect());
    graph.on('node:dblclick', (ev) => {
      const raw = (ev.target?.getData?.() as CanvasDatum | undefined)?.rawNode;
      if (raw) onNodeDoubleClick(raw);
    });
    graph.on('node:pointerenter', (ev) => {
      const raw = (ev.target?.getData?.() as CanvasDatum | undefined)?.rawNode;
      if (raw) onHover({ type: 'node', node: raw });
    });
    graph.on('node:pointerleave', () => onHover(null));

    void graph.render().then(() => {
      if (centerElementId) {
        try { graph.focusElement(centerElementId); } catch { /* 中心节点被过滤时不定位 */ }
      }
    });

    return () => {
      graph.destroy();
      graphRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 重挂载键在 GraphView 控制
  }, []);

  // hiddenKinds 变化: 过滤重绘(不重建实例)
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    const nodes = toNodes(subgraph.nodes);
    const nodeIds = new Set(nodes.map((n) => n.id));
    graph.setData({ nodes, edges: toEdges(subgraph.edges, nodeIds) });
    void graph.render();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hiddenKinds]);

  const tip = useMemo(
    () => `双击节点向外展开 · 已隐藏类型 ${hiddenKinds.size || '无'}`,
    [hiddenKinds],
  );

  return (
    <div className="h-full w-full">
      <div ref={containerRef} className="h-full w-full" data-testid="g6-canvas" />
      <div className="pointer-events-none absolute bottom-3 left-3 z-10 rounded-md border border-line bg-white/90 px-2 py-1 text-[10px] text-ink-soft">
        {tip}
      </div>
    </div>
  );
}
```

> 上文 `ev.target.getData()` / `autoFit` / `focusElement` / `labelPlacement` / force 布局参数名以 Step 2 核对结果为准调整；若 v5 事件对象直接是元素数据（如 `ev.item.getData()` 或 `ev.data`），相应改取。`useDocMeta` 的实际签名以 `docMeta.ts` 现状为准（GraphView 用 `DocMetaProvider value={resolver}`，本组件用同名 hook 取 resolver）。

- [ ] **Step 4: GraphView 集成（搜索跳转 + 图例过滤 + 双击展开 + 绑定状态）**

对 `GraphView.tsx` 做以下编辑（锚点行号基于当前版本）：

1) import 区追加：

```ts
import { ContractSearchBar } from '../common/ContractSearchBar';
import { fetchGraphSchema, type GraphLabelCount } from '../../api/contractSearch';
import { BUSINESS_TYPES, businessTypeOf } from './businessTypes';
```

删除 `KIND_STYLES` 的 import（改用 `businessTypeOf`）。

2) 组件状态区（`detailCollapsed` 之后）追加：

```ts
// 节点类型过滤(spec 2026-08-26 §4.4): 空集合 = 全部可见; 图例计数来自 /api/graph/schema。
const [hiddenKinds, setHiddenKinds] = useState<ReadonlySet<string>>(new Set());
const [labelCounts, setLabelCounts] = useState<GraphLabelCount[]>([]);
// 合同搜索跳转的临时提示(合同在台账但未入图等), 下次查询自动清除。
const [searchNotice, setSearchNotice] = useState<string | null>(null);
// Inspector 薄互通: docId -> 绑定计数(懒加载一次 overview)。
const [docBindingCounts, setDocBindingCounts] = useState<Map<string, { confirmed: number; proposed: number }> | null>(null);
const bindingCountsLoadedRef = useRef(false);

const toggleKind = useCallback((kind: string) => {
  setHiddenKinds((prev) => {
    const next = new Set(prev);
    if (next.has(kind)) next.delete(kind);
    else next.add(kind);
    return next;
  });
}, []);

useEffect(() => {
  void fetchGraphSchema().then(setLabelCounts);
}, []);

const loadBindingCounts = useCallback(() => {
  if (bindingCountsLoadedRef.current) return;
  bindingCountsLoadedRef.current = true;
  void fetch('/api/bindings/overview', { credentials: 'include' })
    .then((r) => (r.ok ? r.json() : null))
    .then((data: { documents?: Array<{ docId: string; bindings: Array<{ status: string }> }> } | null) => {
      if (!data?.documents) return;
      const map = new Map<string, { confirmed: number; proposed: number }>();
      for (const d of data.documents) {
        map.set(d.docId, {
          confirmed: d.bindings.filter((b) => b.status === 'confirmed').length,
          proposed: d.bindings.filter((b) => b.status === 'proposed').length,
        });
      }
      setDocBindingCounts(map);
    })
    .catch(() => { bindingCountsLoadedRef.current = false; });
}, []);

// 合同搜索选中: resolve 定位合同节点 -> 以它为中心查询; 未入图给出提示。
const handleSearchSelect = useCallback(
  async (item: { contractNo: string; displayContractNo: string }) => {
    setSearchNotice(null);
    try {
      const res = await fetch(`/api/graph/resolve?contractNo=${encodeURIComponent(item.contractNo)}`, { credentials: 'include' });
      if (!res.ok) throw new Error('resolve failed');
      const data = (await res.json()) as { contract?: { elementId?: string } | null };
      const elementId = data.contract?.elementId;
      if (!elementId) {
        setSearchNotice(`合同 ${item.displayContractNo} 尚未同步到图谱（无合同节点）`);
        return;
      }
      query(elementId, item.displayContractNo, false, depth, direction);
    } catch {
      setSearchNotice('图谱定位失败，请稍后重试');
    }
  },
  [query, depth, direction],
);
```

（`query` 已存在；`query` 回调内部加一句 `setSearchNotice(null);`。）

3) 工具条左段（`center` 徽章之前）插入搜索框：

```tsx
<ContractSearchBar className="w-[300px]" onSelect={(it) => void handleSearchSelect(it)} />
{searchNotice && (
  <span className="max-w-[260px] truncate rounded-md bg-warning/15 px-2 py-1 text-[11px] text-warning" title={searchNotice}>
    {searchNotice}
  </span>
)}
```

4) 静态图例（L203-219 的 `LEGEND_KINDS.map` 块）替换为可点选过滤（保留 `hidden xl:flex` 外层容器）：

```tsx
<div className="hidden items-center gap-2.5 border-l border-line pl-3 xl:flex">
  {Object.values(BUSINESS_TYPES).map((bt) => {
    const hidden = hiddenKinds.has(bt.label);
    const count = labelCounts.find((x) => x.label === bt.label)?.count;
    return (
      <button
        key={bt.label}
        type="button"
        onClick={() => toggleKind(bt.label)}
        title={hidden ? `显示${bt.displayName}` : `隐藏${bt.displayName}`}
        className={clsx(
          'flex items-center gap-1 rounded px-1 text-[11px] transition-opacity',
          hidden ? 'text-ink-soft/50 opacity-50 line-through' : 'text-ink-soft hover:bg-surface',
        )}
      >
        {bt.label === 'Document' ? (
          <span className="h-2 w-2 rounded-full border-2 bg-white" style={{ borderColor: bt.color }} aria-hidden />
        ) : (
          <span className="h-2 w-2 rounded-full" style={{ background: bt.color }} aria-hidden />
        )}
        {bt.displayName}
        {typeof count === 'number' && <span className="tabular-nums">({count})</span>}
      </button>
    );
  })}
</div>
```

删除顶部 `const LEGEND_KINDS = [...]` 常量。

5) `<GraphCanvas ...>`（L288-296）追加两个 props：

```tsx
hiddenKinds={hiddenKinds}
onNodeDoubleClick={handleExpandNode}
```

（`handleExpandNode` 已存在，语义从"点击展开"变"双击展开"；若原画布单击即展开，本版本单击=固定详情、双击=展开。）

6) `<DetailPanel ...>`（L327-332）追加薄互通 props：

```tsx
docBindingCounts={docBindingCounts}
onLoadBindingCounts={loadBindingCounts}
onOpenInBindings={onOpenInBindings}
```

同时组件签名改为：

```ts
export function GraphView({
  focus = null,
  onOpenInBindings,
}: {
  focus?: GraphFocus | null;
  onOpenInBindings?: (docId: string) => void;
}) {
```

选中节点为 Document 时调用 `onLoadBindingCounts()`（在 `setPinned` 处：`if (node.kind === 'Document') onLoadBindingCounts()` —— 直接在 onNodeSelect 回调里判断）。

- [ ] **Step 5: DetailPanel 绑定状态区**

先读 `apps/web/src/components/graph/DetailPanel.tsx`。在节点标题区（`nodeDisplayName` 渲染处）下方，为 `inspect.type === 'node' && node.kind === 'Document'` 追加：

```tsx
interface DocBindingCounts { confirmed: number; proposed: number }

function BindingStatusSection({
  counts, onOpenInBindings,
}: {
  counts: DocBindingCounts | null;
  onOpenInBindings?: (docId: string) => void;
}) {
  const docId = /* 当前节点 docId: docIdOf(node) */;
  return (
    <div className="mt-2 flex items-center gap-2 text-[11px] text-ink-soft">
      {counts ? (
        <span>
          已绑定 <span className="font-semibold tabular-nums text-ink">{counts.confirmed}</span>
          {' · 待审 '}
          <span className="font-semibold tabular-nums text-warning">{counts.proposed}</span>
        </span>
      ) : (
        <span>绑定状态加载中…</span>
      )}
      {onOpenInBindings && (
        <button
          type="button"
          onClick={() => onOpenInBindings(docId)}
          className="text-primary underline underline-offset-2 hover:text-primary-800"
        >
          去审核
        </button>
      )}
    </div>
  );
}
```

Props 增加 `docBindingCounts?: Map<string, DocBindingCounts> | null`、`onLoadBindingCounts?: () => void`、`onOpenInBindings?: (docId: string) => void`；`docId` 用既有 `docIdOf(node)` 解析；`counts = docBindingCounts?.get(docId) ?? null`。

- [ ] **Step 6: App.tsx 反向跳转**

先读 `apps/web/src/App.tsx`（重点 L35-39 `openInGraph` 与 L162-171 视图渲染）。追加（与 graphFocus 同款 nonce 模式）：

```ts
// 图谱 Inspector -> 绑定工作台深链(薄互通, spec 2026-08-26 §4.4)。
const [bindingsFocus, setBindingsFocus] = useState<{ docId: string; nonce: number } | null>(null);
const bindingsFocusNonceRef = useRef(0);
const openInBindings = useCallback((docId: string) => {
  bindingsFocusNonceRef.current += 1;
  setBindingsFocus({ docId, nonce: bindingsFocusNonceRef.current });
  // 与 openInGraph 同款视图切换调用(按实际实现, 如 setView('bindings'))
}, []);
```

渲染处：`<BindingsView focus={bindingsFocus} onOpenInGraph={openInGraph} />`、`<GraphView focus={graphFocus} onOpenInBindings={openInBindings} />`。

`BindingsView.tsx` 组件签名与 focus 消费：

```ts
export function BindingsView({
  onOpenInGraph,
  focus = null,
}: {
  onOpenInGraph?: (target: GraphFocusTarget) => void;
  focus?: { docId: string; nonce: number } | null;
}) {
  // ...既有状态...
  const handledFocusNonceRef = useRef(-1);
  useEffect(() => {
    if (!focus || focus.nonce === handledFocusNonceRef.current) return;
    handledFocusNonceRef.current = focus.nonce;
    const doc = overview.find((d) => d.docId === focus.docId);
    if (doc) handleSelectDoc(doc);
  }, [focus, overview, handleSelectDoc]);
```

- [ ] **Step 7: 类型检查 + lint**

Run: `npm run build --workspace apps/web && npm run lint`
Expected: 无错误。若 G6 API 名称报错，回 Step 2 核对并修正（不改 props 契约）。

- [ ] **Step 8: Commit**

```bash
git add apps/web/package.json apps/web/package-lock.json apps/web/src
git commit -m "feat(web): 图谱页 G6 v5 重写(类型过滤/双击展开/合同搜索跳转/绑定薄互通)"
```

---

### Task 9: 全量验证 + 手工验收

**Files:** 无新文件（验证任务）

- [ ] **Step 1: 全量 build → lint → test（CI 同序）**

```bash
npm run build && npm run lint && npm test
```
Expected: 三者全绿。若 server 测试有既有失败，对照 `git stash` 前后确认非本计划引入。

- [ ] **Step 2: 手工验收清单（本地 dev，遵守"不重复启动前端服务器"）**

1. `#/bindings`：顶部搜"浙能富兴"片段 → 下拉买方分组；选中 → 左栏过滤 + 首文档定位；X 清除。
2. `#/bindings`：手动创建绑定 → 空输入聚焦见前 20 条 + 已挂/未挂徽标；执行类单据选未挂 → 拦截提示。
3. `#/graph`：顶部搜合同号 → 画布以合同为中心展开（G6 渲染 + minimap）。
4. `#/graph`：图例点"交易方" → Party 节点隐藏（画布与计数变灰划线）；再点恢复。
5. `#/graph`：双击任意节点 → 以它为中心增量展开。
6. `#/graph`：点 Document 节点 → Inspector 显示"已绑定 N · 待审 M" + 去审核 → 跳到绑定页并选中该文档。
7. Neo4j 停用场景（可选）：`/api/graph/schema` 503 → 图例退化为无计数静态样式，页面不崩。

- [ ] **Step 3: Commit（如有零星修复）+ 推送**

```bash
git add -A apps/server apps/web && git commit -m "fix: 验收修复" || true
git push origin HEAD
```

---

## Self-Review 记录

- Spec 覆盖：§4.1 端点(Task 1-3)、§4.1 schema(Task 4)、§4.2 注册表(Task 5)、§4.3 组合框(Task 6)、§4.5 绑定接线(Task 7)、§4.4 图谱重设计+薄互通(Task 8)、§7 测试(Task 1-4/9)、§8 不做清单（未引入 pg_trgm/fulltext/Graphin，BindingMiniGraph 未动）。无缺口。
- 类型一致性：`ContractSearchItem` 字段在 Task 1/2/3/6 四处一致；`searchContractLedger(ctx,q,userId?,limit=10)` 与路由调用一致；`GraphCanvasProps` 与 GraphView 传参一致。
- 已知风险已显式标注：G6 v5 API 名称以 Task 8 Step 2 核对为准；`isGraphUnavailable` 判定条件需在 Task 4 Step 5 对照实现。
