# Neo4j 图关系落地（确认后写入 · 文档为中心）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 复核卡确认后将文档的实体/边确定性写入 Neo4j（文件内 party/commodity/references + 文件间 executes；back_to_back 留给 Agent L2 手动），并为 Agent 补按名称找实体的 L1 工具与提示词指引。

**Architecture:** 抽取层纯函数派生边提议（`deriveProposedEdges`）；确认时 `POST /:docId/review` confirm 分支经 `commitDocumentGraph` 编排：读 snapshot → `writeDocumentGraph`（幂等 MERGE、逐条容错、NEO4J 未配置则 skipped）→ 持久化 `documents.graph_status`。图写入永不阻塞确认。新增 `graph_find_entity` L1 工具补"按名称找实体"入口。

**Tech Stack:** Hono + AI SDK 6（`inputSchema`/`needsApproval`，v6 语义）、better-sqlite3（默认）+ node-postgres（twin 必需）、neo4j-driver、React 19 + Tailwind、vitest。

**Spec:** `docs/superpowers/specs/2026-08-17-graph-relations-design.md`

## Global Constraints

- AI SDK 6：工具 schema 字段是 `inputSchema`（不是 `parameters`）；L2 用 `needsApproval: true`。
- 图 label/relType 只允许 `[A-Za-z_][A-Za-z0-9_]*`（`graph/repo.ts` assertToken）——英文 label，中文进 props。
- 受控边词表：`party` / `commodity` / `references` / `executes`（自动）+ `back_to_back`（仅手动，不在本计划写入路径）。
- 代码中不加 emoji。
- 双后端：每处 repositories 改动都要 SQLite 实现 + Postgres twin（`postgres-repositories.ts`）+ client.ts 两侧 DDL（SQLite guarded ALTER / PG `ADD COLUMN IF NOT EXISTS`）。
- 完成顺序：build → lint → test（repo 根目录 `npm run build && npm run lint && npm test`）。
- 测试一律 vitest；纯函数用 in-memory（`createDb(':memory:')` + `migrate`）；Neo4j 用例 `describe.skipIf(!process.env.NEO4J_PASSWORD)`。
- 单测命令：`npm test --workspace apps/server -- test/<path>`；每个 Task 结束单独 commit（信息风格 `feat:/test:/docs: + 中文摘要`，与 git log 一致）。
- 禁止改动 `.agents/`、`.slim/` 下文件；工作区已有无关未提交改动（documentEntry.ts/recall.ts/eval 等），**git add 只加本任务文件**。

---

### Task 1: 名称归一化纯函数 `normalizeName`

**Files:**
- Create: `apps/server/src/graph/normalize.ts`
- Test: `apps/server/test/graph/normalize.test.ts`

**Interfaces:**
- Consumes: 无（叶模块）
- Produces: `normalizeName(raw: string): string` —— 后续 Task 5 实体/边写入统一调用

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/test/graph/normalize.test.ts
import { describe, it, expect } from 'vitest';
import { normalizeName } from '../../src/graph/normalize.js';

describe('normalizeName', () => {
  it('去除首尾与内部空白（含全角空格）', () => {
    expect(normalizeName('  中石化 ')).toBe('中石化');
    expect(normalizeName('中国\u3000石化')).toBe('中国石化');
    expect(normalizeName('HT 001')).toBe('HT001');
  });
  it('剥离公司后缀（可重复剥，最长优先）', () => {
    expect(normalizeName('中石化集团有限公司')).toBe('中石化');
    expect(normalizeName('中石化股份有限公司')).toBe('中石化');
    expect(normalizeName('中石化集团')).toBe('中石化');
    expect(normalizeName('中石化有限公司')).toBe('中石化');
  });
  it('后缀即全名时不剥（防空名）', () => {
    expect(normalizeName('集团')).toBe('集团');
    expect(normalizeName('有限公司')).toBe('有限公司');
  });
  it('空白输入返回空串', () => {
    expect(normalizeName('')).toBe('');
    expect(normalizeName('   ')).toBe('');
  });
  it('合同号（无后缀无空白）原样保留', () => {
    expect(normalizeName('HT-2024-001')).toBe('HT-2024-001');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/graph/normalize.test.ts`
Expected: FAIL —— `Cannot find module .../graph/normalize.js`

- [ ] **Step 3: 最小实现**

```ts
// apps/server/src/graph/normalize.ts
/**
 * Graph name normalization (design 2026-08-17 §5). Neo4j 实体按 (kind, name)
 * 精确 MERGE，写入前必须归一化：去首尾/内部空白（含全角 U+3000）+ 剥常见公司
 * 后缀，使 "中石化集团有限公司" 与 "中石化" 收敛到同一 Party 节点。合同号不含
 * 这些后缀，同一函数处理无副作用。
 */

// 最长优先：'集团有限公司' 必须先于 '集团'/'有限公司' 被剥。
const SUFFIXES = ['股份有限公司', '有限责任公司', '集团有限公司', '集团公司', '有限公司', '集团'];

export function normalizeName(raw: string): string {
  let s = (raw ?? '').replace(/[\s\u3000]+/g, '').trim();
  if (!s) return '';
  let changed = true;
  while (changed) {
    changed = false;
    for (const suf of SUFFIXES) {
      // s.length > suf.length：后缀即全名时保留，避免剥成空串。
      if (s.length > suf.length && s.endsWith(suf)) {
        s = s.slice(0, -suf.length);
        changed = true;
        break;
      }
    }
  }
  return s;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test --workspace apps/server -- test/graph/normalize.test.ts`
Expected: PASS（5 tests）

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/graph/normalize.ts apps/server/test/graph/normalize.test.ts
git commit -m "feat(graph): normalizeName 名称归一化（空白/公司后缀）"
```

---

### Task 2: repo 层 `mergeEdge`（幂等边）+ `findEntities`（按名查实体）

**Files:**
- Modify: `apps/server/src/graph/repo.ts`（在 `linkEntities` 之后、`DIR_TEMPLATES` 之前插入两个导出）
- Test: `apps/server/test/graph/repo.test.ts`（新增 offline describe + live skipIf 用例）

**Interfaces:**
- Consumes: 既有 `getDriver/assertToken/nodeToEntity/relToEdge/GraphEntity/GraphEdge`
- Produces:
  - `mergeEdge(input: {srcId; dstId; kind; props?; confidence?; sourceSpan?}): Promise<GraphEdge>`（MERGE 幂等）
  - `findEntities(input: {kind?; name; exact?; limit?}): Promise<GraphEntity[]>`（上限 10）

- [ ] **Step 1: 写失败测试（offline 部分）**

在 `test/graph/repo.test.ts` 现有 import 中加入 `findEntities, mergeEdge`，并在文件末尾（live describe 之外）追加：

```ts
describe('findEntities / mergeEdge (offline guards)', () => {
  it('findEntities 空白名称直接返回 []（不触驱动）', async () => {
    await expect(findEntities({ name: '   ' })).resolves.toEqual([]);
  });
  it('findEntities 对非法 kind 先经 assertToken 校验', async () => {
    await expect(findEntities({ kind: 'a b', name: 'x' })).rejects.toThrow(/Invalid label/);
  });
  it('mergeEdge 在未配置 NEO4J_PASSWORD 时抛驱动错误（CI 无密码路径）', async () => {
    await expect(
      mergeEdge({ srcId: '4:a:0', dstId: '4:b:0', kind: 'party' }),
    ).rejects.toThrow(/NEO4J_PASSWORD|not found/i);
  });
});
```

在 live `describe.skipIf(skip)` 块内追加：

```ts
  it('mergeEdge 幂等：同 (src,type,dst) 重复写不产生重复边', async () => {
    const a = await createEntity({ kind: 'Party', name: `MEA-${RUN_ID}`, props: { scaRunId: RUN_ID } });
    const b = await createEntity({ kind: 'Contract', name: `MEB-${RUN_ID}`, props: { scaRunId: RUN_ID } });
    await mergeEdge({ srcId: a.elementId, dstId: b.elementId, kind: 'party', confidence: 0.9, props: { scaRunId: RUN_ID, role: '买方' } });
    await mergeEdge({ srcId: a.elementId, dstId: b.elementId, kind: 'party', confidence: 0.9, props: { scaRunId: RUN_ID, role: '买方' } });
    const res = await graphQuery({ subjectId: a.elementId, depth: 1, edgeKinds: ['party'], direction: 'out' });
    expect(res.edges.filter((e) => e.dstId === b.elementId)).toHaveLength(1);
  });

  it('findEntities 按 kind+contains 模糊与 exact 精确匹配', async () => {
    await createEntity({ kind: 'Party', name: `中石化-${RUN_ID}`, props: { scaRunId: RUN_ID } });
    await createEntity({ kind: 'Party', name: `中石化贸易-${RUN_ID}`, props: { scaRunId: RUN_ID } });
    const fuzzy = await findEntities({ kind: 'Party', name: `-${RUN_ID}` });
    expect(fuzzy.length).toBeGreaterThanOrEqual(2); // 其他 live 用例的 Party 也带 -RUN_ID
    const exact = await findEntities({ kind: 'Party', name: `中石化贸易-${RUN_ID}`, exact: true });
    expect(exact).toHaveLength(1);
    expect(exact[0].name).toBe(`中石化贸易-${RUN_ID}`);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/graph/repo.test.ts`
Expected: FAIL —— `mergeEdge/findEntities` 未导出（TS 编译错误）

- [ ] **Step 3: 实现（插入 repo.ts，位置：`linkEntities` 函数结束后）**

```ts
export interface MergeEdgeInput {
  srcId: string;
  dstId: string;
  kind: string;
  props?: Record<string, unknown>;
  confidence?: number;
  sourceSpan?: unknown;
}
/**
 * Idempotent link: MERGE on (src)-[kind]->(dst) —— 重复确认同一文档不会产生
 * 重复边（design 2026-08-17 §4）。与 agent 面向的 linkEntities（CREATE）不同，
 * 这是确认写入器（graphWriter）专用的确定性入口。
 */
export async function mergeEdge(input: MergeEdgeInput): Promise<GraphEdge> {
  const cypher = `
    MATCH (a) WHERE elementId(a) = $srcId
    MATCH (b) WHERE elementId(b) = $dstId
    MERGE (a)-[r:$($kind)]->(b)
    ON CREATE SET r.createdAt = datetime()
    SET r += $props, r.confidence = $confidence
    RETURN r AS rel
  `;
  const props = { ...(input.props ?? {}) };
  if (input.sourceSpan !== undefined) props.sourceSpan = input.sourceSpan;
  const session = getDriver().session();
  try {
    const { records } = await session.executeWrite(async (txc) => {
      const result = await txc.run(cypher, {
        srcId: input.srcId,
        dstId: input.dstId,
        kind: input.kind,
        props,
        confidence: input.confidence ?? 0,
      });
      return result;
    });
    if (records.length === 0) {
      throw new Error(`mergeEdge: src or dst node not found (src=${input.srcId} dst=${input.dstId})`);
    }
    const rec = records[0];
    if (!rec) throw new Error('mergeEdge: unexpected empty record');
    return relToEdge(rec.get('rel') as Relationship);
  } finally {
    await session.close();
  }
}

export interface FindEntitiesInput {
  kind?: string;
  name: string;
  /** true = 精确相等；默认（false）= CONTAINS 包含匹配。 */
  exact?: boolean;
  limit?: number;
}
/**
 * 按 kind+name 查实体（design 2026-08-17 §6.1）—— graph_query 缺的"按名称找
 * 实体"入口：用户说的是 "中石化"/合同号，不是 elementId。上限 10。
 */
export async function findEntities(input: FindEntitiesInput): Promise<GraphEntity[]> {
  if (input.kind) assertToken(input.kind, 'label');
  const name = (input.name ?? '').trim();
  if (!name) return [];
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 10) || 10, 1), 10);
  const session = getDriver().session({ defaultAccessMode: neo4j.session.READ });
  try {
    const nodePattern = input.kind ? 'MATCH (n:$($kind))' : 'MATCH (n)';
    const whereClause = input.exact ? 'WHERE n.name = $name' : 'WHERE toString(n.name) CONTAINS $name';
    const cypher = `${nodePattern} ${whereClause} RETURN n AS node ORDER BY n.name LIMIT $limit`;
    const params: Record<string, unknown> = { name, limit };
    if (input.kind) params.kind = input.kind;
    const result = await session.executeRead((txc) => txc.run(cypher, params));
    return result.records.map((rec) => nodeToEntity(rec.get('node') as Node));
  } finally {
    await session.close();
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test --workspace apps/server -- test/graph/repo.test.ts`
Expected: PASS（offline 3 + live skipIf 条件下 2；无 NEO4J_PASSWORD 时 live 跳过）

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/graph/repo.ts apps/server/test/graph/repo.test.ts
git commit -m "feat(graph): mergeEdge 幂等边 + findEntities 按名查实体"
```

---

### Task 3: `ProposedEdge` 类型 + `deriveProposedEdges` 纯函数 + Party 角色扩展

**Files:**
- Modify: `apps/server/src/pipeline/db/repositories.ts`（`ProposedRelationship` 接口后新增类型，约 :156）
- Modify: `apps/server/src/pipeline/extraction.ts`（`REL_ROLE_BY_FIELD` 扩展 + 新导出函数）
- Test: `apps/server/test/pipeline/extraction.edges.test.ts`（新建）
- Test: `apps/server/test/pipeline/extraction.relationships.test.ts`（追加一例）

**Interfaces:**
- Consumes: 既有 `REL_ROLE_BY_FIELD/COMMODITY_FIELDS/CONTRACT_FIELDS`、`ProposedRelationship`
- Produces:
  - `ProposedEdge { type: 'party'|'commodity'|'references'|'executes'; dstKind: 'Party'|'Commodity'|'Contract'; dstName: string; role?: string; confidence: number }`（repositories.ts）
  - `deriveProposedEdges(docType: string, fields: Array<{name; value; string|number; confidence: number}>): ProposedEdge[]`（extraction.ts，纯函数）
  - `REL_ROLE_BY_FIELD` 新增键：`发货人/收货人/承运人`（角色同名）

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/test/pipeline/extraction.edges.test.ts
import { describe, it, expect } from 'vitest';
import { deriveProposedEdges } from '../../src/pipeline/extraction.js';

const f = (name: string, value: string, confidence = 0.9) => ({ name, value, confidence });

describe('deriveProposedEdges', () => {
  it('合同字段派生 party/commodity/references 边，但不派生 executes', () => {
    const edges = deriveProposedEdges('合同', [
      f('甲方', 'A公司'), f('乙方', 'B公司'), f('标的物', '动力煤'), f('合同号', 'HT-1'),
    ]);
    expect(edges).toContainEqual(expect.objectContaining({ type: 'party', dstKind: 'Party', dstName: 'A公司', role: '买方' }));
    expect(edges).toContainEqual(expect.objectContaining({ type: 'party', dstKind: 'Party', dstName: 'B公司', role: '卖方' }));
    expect(edges).toContainEqual(expect.objectContaining({ type: 'commodity', dstKind: 'Commodity', dstName: '动力煤' }));
    expect(edges).toContainEqual(expect.objectContaining({ type: 'references', dstKind: 'Contract', dstName: 'HT-1' }));
    expect(edges.some((e) => e.type === 'executes')).toBe(false);
  });
  it('发票/提单/装箱单带合同号时派生 executes（执行合同）', () => {
    for (const docType of ['发票', '提单', '装箱单']) {
      const edges = deriveProposedEdges(docType, [f('合同号', 'HT-1', 0.8), f('卖方', 'B公司')]);
      expect(edges).toContainEqual(expect.objectContaining({ type: 'executes', dstKind: 'Contract', dstName: 'HT-1', confidence: 0.8 }));
    }
  });
  it('提单场景支持 发货人/收货人/承运人 party 角色', () => {
    const edges = deriveProposedEdges('提单', [f('发货人', 'S公司'), f('收货人', 'R公司'), f('承运人', 'C航运')]);
    expect(edges).toContainEqual(expect.objectContaining({ type: 'party', role: '发货人', dstName: 'S公司' }));
    expect(edges).toContainEqual(expect.objectContaining({ type: 'party', role: '收货人', dstName: 'R公司' }));
    expect(edges).toContainEqual(expect.objectContaining({ type: 'party', role: '承运人', dstName: 'C航运' }));
  });
  it('合同号与合同编号同值时 references/executes 去重', () => {
    const edges = deriveProposedEdges('发票', [f('合同号', 'HT-1'), f('合同编号', 'HT-1')]);
    expect(edges.filter((e) => e.type === 'references')).toHaveLength(1);
    expect(edges.filter((e) => e.type === 'executes')).toHaveLength(1);
  });
  it('无可关联字段返回 []', () => {
    expect(deriveProposedEdges('发票', [f('金额', '1000')])).toEqual([]);
  });
});
```

在 `extraction.relationships.test.ts` 末尾 describe 内追加：

```ts
  it('发货人/收货人/承运人 提升为 Party 提议（design 2026-08-17）', () => {
    const rels = deriveProposedRelationships([f('发货人', 'S公司'), f('收货人', 'R公司'), f('承运人', 'C航运')]);
    expect(rels).toContainEqual(expect.objectContaining({ kind: 'Party', role: '发货人', name: 'S公司' }));
    expect(rels).toContainEqual(expect.objectContaining({ kind: 'Party', role: '收货人', name: 'R公司' }));
    expect(rels).toContainEqual(expect.objectContaining({ kind: 'Party', role: '承运人', name: 'C航运' }));
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/pipeline/extraction.edges.test.ts test/pipeline/extraction.relationships.test.ts`
Expected: FAIL —— `deriveProposedEdges` 未导出；发货人角色断言失败

- [ ] **Step 3: 实现**

repositories.ts（`ProposedRelationship` 接口之后插入）：

```ts
/**
 * 确定性边提议（design 2026-08-17 §3.2）。恒为 Document -> 实体；dstKind/dstName
 * 定位目标节点（写入时按 kind+归一化名 MERGE）。'executes' 是文件间"该单据是
 * 合同执行的结果"边（doc -> Contract 枢纽）。
 */
export interface ProposedEdge {
  type: 'party' | 'commodity' | 'references' | 'executes';
  dstKind: 'Party' | 'Commodity' | 'Contract';
  dstName: string;
  /** party 边专用：买方|卖方|发货人|收货人|承运人 */
  role?: string;
  confidence: number;
}
```

extraction.ts：

(a) 类型导入行改为（第 7 行）：

```ts
import type { ProposedRelationship, ProposedEdge } from './db/repositories.js';
```

(b) `REL_ROLE_BY_FIELD` 替换为：

```ts
const REL_ROLE_BY_FIELD: Record<string, string> = {
  甲方: '买方', 乙方: '卖方', 买方: '买方', 卖方: '卖方',
  发货人: '发货人', 收货人: '收货人', 承运人: '承运人',
};
```

(c) 在 `deriveProposedRelationships` 函数之后插入：

```ts
/** 构成合同"执行凭证"的单据类型（design 2026-08-17 §2.2）。 */
const EXECUTES_DOCTYPES = new Set(['发票', '提单', '装箱单']);

/** deriveProposedEdges 的最小字段投影（ReviewSnapshot.fields 与 ExtractedField 均满足）。 */
export interface EdgeFieldInput {
  name: string;
  value: string | number;
  confidence: number;
}

/**
 * 纯函数：从扁平字段确定性派生 Document->实体边，无 LLM 参与。抽取时与确认时
 * （graphCommit）跑同一规则，复核卡展示与图写入不会漂移。
 */
export function deriveProposedEdges(docType: string, fields: EdgeFieldInput[]): ProposedEdge[] {
  const out: ProposedEdge[] = [];
  const contractConf = new Map<string, number>();
  const contractOrder: string[] = [];
  for (const f of fields) {
    const val = typeof f.value === 'string' ? f.value.trim() : '';
    if (!val) continue;
    const role = REL_ROLE_BY_FIELD[f.name];
    if (role) {
      out.push({ type: 'party', dstKind: 'Party', dstName: val, role, confidence: f.confidence });
    } else if (COMMODITY_FIELDS.has(f.name)) {
      out.push({ type: 'commodity', dstKind: 'Commodity', dstName: val, confidence: f.confidence });
    } else if (CONTRACT_FIELDS.has(f.name)) {
      if (!contractConf.has(val)) contractOrder.push(val);
      contractConf.set(val, Math.max(contractConf.get(val) ?? 0, f.confidence));
    }
  }
  for (const name of contractOrder) {
    const confidence = contractConf.get(name) ?? 0;
    out.push({ type: 'references', dstKind: 'Contract', dstName: name, confidence });
    if (EXECUTES_DOCTYPES.has(docType)) {
      out.push({ type: 'executes', dstKind: 'Contract', dstName: name, confidence });
    }
  }
  return out;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test --workspace apps/server -- test/pipeline/extraction.edges.test.ts test/pipeline/extraction.relationships.test.ts`
Expected: PASS（5 + 6 tests）

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/pipeline/db/repositories.ts apps/server/src/pipeline/extraction.ts apps/server/test/pipeline/extraction.edges.test.ts apps/server/test/pipeline/extraction.relationships.test.ts
git commit -m "feat(pipeline): ProposedEdge 类型 + deriveProposedEdges 边派生 + 提单角色扩展"
```

---

### Task 4: `graph_status` 持久化 + ReviewSnapshot 扩展（SQLite + PG twin）

**Files:**
- Modify: `apps/server/src/pipeline/db/client.ts`（SQLite guarded ALTER 块 ~:220；PG 语句数组 ~:361）
- Modify: `apps/server/src/pipeline/db/repositories.ts`（类型 + setDocumentGraphStatus + getReviewSnapshot）
- Modify: `apps/server/src/pipeline/db/postgres-repositories.ts`（Pg twin + getReviewSnapshotPg）
- Test: `apps/server/test/pipeline/db/review-graph.test.ts`（新建）

**Interfaces:**
- Consumes: Task 3 的 `deriveProposedEdges`（repositories 从 `../extraction.js` 运行时导入；extraction 对 repositories 仅 `import type`，无运行时环）
- Produces:
  - `DocumentGraphStatus { status: 'ok'|'partial'|'failed'|'skipped'; nodeCount: number; edgeCount: number; reason?: string; failures?: string[]; writtenAt: string }`
  - `setDocumentGraphStatus(ctx, docId, status, userId?): Promise<void>`（含 Pg twin）
  - `ReviewSnapshot` 新增字段：`proposedEdges: ProposedEdge[]`、`graphStatus: DocumentGraphStatus | null`

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/test/pipeline/db/review-graph.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate, type DbContext } from '../../../src/pipeline/db/client.js';
import {
  createDocumentStub, saveExtraction, getReviewSnapshot,
  setDocumentGraphStatus, setReviewStatus,
} from '../../../src/pipeline/db/repositories.js';

let ctx: DbContext;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
});

describe('review snapshot 图字段（design 2026-08-17）', () => {
  it('proposedEdges 从持久化字段派生（发票 -> executes+references+party）', async () => {
    const { docId } = await createDocumentStub(ctx, { sourceUri: 'file:///inv.pdf', docType: '发票' });
    await saveExtraction(ctx, {
      documentId: docId, docType: '发票',
      fields: { 合同号: { value: 'HT-1', sourceSpans: [] }, 卖方: { value: 'B公司', sourceSpans: [] } },
      fieldMeta: { 合同号: { strength: 'exact', confidence: 0.9 }, 卖方: { strength: 'exact', confidence: 0.9 } },
      overallConfidence: 0.9, needsReview: false,
    });
    const snap = await getReviewSnapshot(ctx, docId);
    expect(snap?.proposedEdges.map((e) => e.type).sort()).toEqual(['executes', 'party', 'references']);
  });

  it('graphStatus 确认前为 null，setDocumentGraphStatus 后可读回', async () => {
    const { docId } = await createDocumentStub(ctx, { sourceUri: 'file:///c.pdf' });
    await saveExtraction(ctx, {
      documentId: docId, docType: '其他',
      fields: {}, fieldMeta: {}, overallConfidence: 0, needsReview: false,
    });
    let snap = await getReviewSnapshot(ctx, docId);
    expect(snap?.graphStatus).toBeNull();
    await setReviewStatus(ctx, docId, 'confirmed');
    const status = { status: 'ok' as const, nodeCount: 5, edgeCount: 4, writtenAt: '2026-08-17T00:00:00Z' };
    await setDocumentGraphStatus(ctx, docId, status);
    snap = await getReviewSnapshot(ctx, docId);
    expect(snap?.graphStatus).toEqual(status);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/pipeline/db/review-graph.test.ts`
Expected: FAIL —— `setDocumentGraphStatus` 未导出 / `proposedEdges` 不存在

- [ ] **Step 3: 实现**

(a) `client.ts` SQLite guarded ALTER 块（`vectorization_meta` 块之后、`extraction_status` 之前，~:220）插入：

```ts
    // Graph-relations design (2026-08-17 §4): 确认时 Neo4j 写入结果持久化
    // （ok/partial/failed/skipped + 计数）。与 vectorization_meta 同一 guarded ALTER 模式。
    if (!have.has('graph_status')) {
      try { sqlite.exec('ALTER TABLE documents ADD COLUMN graph_status TEXT'); } catch { /* concurrent */ }
    }
```

(b) `client.ts` PG 语句数组（`vectorization_meta jsonb` 行 ~:361 之后）插入：

```ts
    `ALTER TABLE documents ADD COLUMN IF NOT EXISTS graph_status jsonb`,
```

(c) `repositories.ts`：

- 顶部加运行时导入（与现有 import 并列）：
```ts
import { deriveProposedEdges } from '../extraction.js';
```
- `DocumentVectorization`/`UNKNOWN_VECTORIZATION`（~:174）之后插入：
```ts
/**
 * 确认时 Neo4j 写入结果（design 2026-08-17 §4）。'skipped' = 图未配置
 * （NEO4J_PASSWORD 未设）；'partial' = 部分实体/边失败（见 failures[]）；
 * 'failed' = 写入整体失败（图不可达等）。
 */
export type DocumentGraphStatus = {
  status: 'ok' | 'partial' | 'failed' | 'skipped';
  nodeCount: number;
  edgeCount: number;
  reason?: string;
  failures?: string[];
  writtenAt: string;
};
```
- `ReviewSnapshot` 接口（`vectorization` 字段后）追加：
```ts
  /** 确定性 Document->实体边提议（design 2026-08-17 §3.2），快照读取时同规则派生。 */
  proposedEdges: ProposedEdge[];
  /** 确认时 Neo4j 写入结果；未确认或从未写入时为 null。 */
  graphStatus: DocumentGraphStatus | null;
```
- `setDocumentVectorization`（~:1153）之后插入：
```ts
/**
 * 持久化确认时图写入结果到 documents 行。镜像 setDocumentVectorization 的裸
 * UPDATE 形态。userId 仅为签名对称（void）。
 */
export async function setDocumentGraphStatus(
  ctx: DbContext,
  docId: string,
  status: DocumentGraphStatus,
  userId?: string,
): Promise<void> {
  if (ctx.backend === 'postgres') return setDocumentGraphStatusPg(ctx, docId, status, userId);
  void userId;
  ctx.sqlite
    .prepare('UPDATE documents SET graph_status = ? WHERE id = ?')
    .run(JSON.stringify(status), docId);
}
```
- `getReviewSnapshot`（SQLite 分支）：
  - SELECT 增列：`'SELECT doc_type, review_status, vectorization_meta, graph_status FROM documents WHERE id = ?'`，行类型加 `graph_status: string | null`；
  - vectorization 解析块后加：
```ts
  let graphStatus: DocumentGraphStatus | null = null;
  if (doc.graph_status) {
    try {
      graphStatus = JSON.parse(doc.graph_status) as DocumentGraphStatus;
    } catch {
      graphStatus = null;
    }
  }
```
  - return 对象追加两字段：
```ts
    proposedEdges: deriveProposedEdges(doc.doc_type, fields),
    graphStatus,
```
- Pg twin 导入行（repositories.ts:38-39 附近，跟随 `setDocumentVectorizationPg` 的 import 来源）追加 `setDocumentGraphStatusPg`；类型 `DocumentGraphStatus` 一并在 postgres-repositories.ts 从 `'./repositories.js'` 以 type-only 导入（与 `DocumentVectorization` 同一 import 语句）。

(d) `postgres-repositories.ts`：

- `getReviewSnapshotPg`：SELECT 改为 `'SELECT doc_type, review_status, vectorization_meta, graph_status FROM documents WHERE id = $1'`，行类型加 `graph_status: DocumentGraphStatus | null`；return 前加：
```ts
  const graphStatus: DocumentGraphStatus | null = doc.graph_status ?? null;
```
  return 对象追加：
```ts
    proposedEdges: deriveProposedEdges(doc.doc_type, fields),
    graphStatus,
```
  并在文件顶部加运行时导入 `import { deriveProposedEdges } from '../extraction.js';`
- `setDocumentVectorizationPg`（~:926）之后插入：
```ts
/**
 * 持久化确认时图写入结果（pg twin of setDocumentGraphStatus）。graph_status
 * 为 jsonb；node-postgres 写入时以 JSON 字符串 cast。
 */
export async function setDocumentGraphStatusPg(
  ctx: PostgresDbContext,
  docId: string,
  status: DocumentGraphStatus,
  userId?: string,
): Promise<void> {
  void userId;
  await ctx.pool.query(
    'UPDATE documents SET graph_status = $1::jsonb WHERE id = $2',
    [JSON.stringify(status), docId],
  );
}
```

- [ ] **Step 4: 跑测试确认通过（含既有 review-snapshot 套件防回归）**

Run: `npm test --workspace apps/server -- test/pipeline/db/review-graph.test.ts test/pipeline/db/review-snapshot.test.ts`
Expected: PASS（新增 2 + 既有全绿）

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/pipeline/db/client.ts apps/server/src/pipeline/db/repositories.ts apps/server/src/pipeline/db/postgres-repositories.ts apps/server/test/pipeline/db/review-graph.test.ts
git commit -m "feat(db): documents.graph_status 列 + 快照 proposedEdges/graphStatus（SQLite+PG）"
```

---

### Task 5: `writeDocumentGraph` 确定性图写入器（可注入 io）

**Files:**
- Create: `apps/server/src/graph/graphWriter.ts`
- Test: `apps/server/test/graph/graphWriter.test.ts`

**Interfaces:**
- Consumes: Task 1 `normalizeName`、Task 2 `createEntity/mergeEdge`
- Produces:
  - `GraphWriterIo { createEntity(...); mergeEdge(...) }`（默认实现绑定真驱动；测试注入 fake）
  - `writeDocumentGraph(input: { docId; docType; sourceUri: string|null; entities: GraphEntityInput[]; edges: GraphEdgeInput[] }, io?): Promise<GraphWriteResult>`
  - `GraphWriteResult { status: 'ok'|'partial'|'failed'|'skipped'; nodeCount; edgeCount; reason?; failures: string[] }`
  - `GraphEntityInput { kind: 'Party'|'Commodity'|'Contract'; name; role?; confidence }`、`GraphEdgeInput { type: 'party'|'commodity'|'references'|'executes'; dstKind; dstName; role?; confidence }`

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/test/graph/graphWriter.test.ts
import { describe, it, expect } from 'vitest';
import { writeDocumentGraph, type GraphWriterIo } from '../../src/graph/graphWriter.js';

function mkIo(opts: { failEntity?: string; failEdge?: string } = {}): GraphWriterIo & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    createEntity: async ({ kind, name }) => {
      calls.push(`create:${kind}:${name}`);
      if (opts.failEntity && name.includes(opts.failEntity)) throw new Error('boom');
      return { elementId: `el-${kind}-${name}`, kind, name, props: {}, created: true };
    },
    mergeEdge: async ({ srcId, dstId, kind }) => {
      calls.push(`edge:${srcId}-${kind}->${dstId}`);
      if (opts.failEdge && kind === opts.failEdge) throw new Error('edge-boom');
      return {};
    },
  };
}

const input = {
  docId: 'DOC-1',
  docType: '发票',
  sourceUri: 'file:///inv.pdf',
  entities: [
    { kind: 'Party' as const, name: '中石化集团有限公司', role: '卖方', confidence: 0.9 },
    { kind: 'Contract' as const, name: 'HT-1', confidence: 0.95 },
  ],
  edges: [
    { type: 'party' as const, dstKind: 'Party' as const, dstName: '中石化集团有限公司', role: '卖方', confidence: 0.9 },
    { type: 'references' as const, dstKind: 'Contract' as const, dstName: 'HT-1', confidence: 0.95 },
    { type: 'executes' as const, dstKind: 'Contract' as const, dstName: 'HT-1', confidence: 0.95 },
  ],
};

describe('writeDocumentGraph (fake io)', () => {
  it('写 Document + 归一化实体 + 全部边，status ok', async () => {
    const io = mkIo();
    const res = await writeDocumentGraph(input, io);
    expect(res.status).toBe('ok');
    expect(res.nodeCount).toBe(3); // Document + Party + Contract
    expect(res.edgeCount).toBe(3);
    expect(io.calls).toContain('create:Party:中石化'); // 后缀已剥
    expect(res.failures).toEqual([]);
  });

  it('NEO4J_PASSWORD 未设时整体 skipped，零 io 调用', async () => {
    const prev = process.env.NEO4J_PASSWORD;
    delete process.env.NEO4J_PASSWORD;
    try {
      const io = mkIo();
      const res = await writeDocumentGraph(input, io);
      expect(res.status).toBe('skipped');
      expect(res.reason).toContain('NEO4J_PASSWORD');
      expect(io.calls).toHaveLength(0);
    } finally {
      if (prev !== undefined) process.env.NEO4J_PASSWORD = prev;
    }
  });

  it('实体失败被隔离：依赖边记失败，其余照写，status partial', async () => {
    const io = mkIo({ failEntity: '中石化' });
    const res = await writeDocumentGraph(input, io);
    expect(res.status).toBe('partial');
    expect(res.edgeCount).toBe(2); // references + executes 仍落地
    expect(res.failures.some((f) => f.includes('Party'))).toBe(true);
    expect(res.failures.some((f) => f.startsWith('edge party->'))).toBe(true);
  });

  it('Document 节点本身创建失败时 status failed 并带 reason', async () => {
    const io = mkIo({ failEntity: 'DOC-1' });
    const res = await writeDocumentGraph(input, io);
    expect(res.status).toBe('failed');
    expect(res.reason).toBe('boom');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/graph/graphWriter.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现**

```ts
// apps/server/src/graph/graphWriter.ts
import { createEntity, mergeEdge, type GraphEntity } from './repo.js';
import { normalizeName } from './normalize.js';

/**
 * 确认时确定性 Neo4j 写入器（design 2026-08-17 §4）。不读 DB 行——调用方
 * （pipeline/graphCommit）把派生好的实体/边传入；本模块只负责幂等图写入与
 * 逐条容错。io 可注入，单测无需 Neo4j。
 */

export interface GraphEntityInput {
  kind: 'Party' | 'Commodity' | 'Contract';
  name: string; // 原始名；此处归一化
  role?: string;
  confidence: number;
}

export interface GraphEdgeInput {
  type: 'party' | 'commodity' | 'references' | 'executes';
  dstKind: 'Party' | 'Commodity' | 'Contract';
  dstName: string; // 原始名；此处归一化
  role?: string;
  confidence: number;
}

export interface GraphWriteResult {
  status: 'ok' | 'partial' | 'failed' | 'skipped';
  nodeCount: number;
  edgeCount: number;
  reason?: string;
  failures: string[];
}

export interface GraphWriterIo {
  createEntity(input: { kind: string; name: string; props?: Record<string, unknown> }): Promise<GraphEntity & { created: boolean }>;
  mergeEdge(input: { srcId: string; dstId: string; kind: string; props?: Record<string, unknown>; confidence?: number }): Promise<unknown>;
}

export const defaultGraphWriterIo: GraphWriterIo = {
  createEntity: (i) => createEntity(i),
  mergeEdge: (i) => mergeEdge(i) as Promise<unknown>,
};

export interface WriteDocumentGraphInput {
  docId: string;
  docType: string;
  sourceUri: string | null;
  entities: GraphEntityInput[];
  edges: GraphEdgeInput[];
}

/**
 * 写入一份已确认文档：1) MERGE Document 节点（name=docId，受 name 唯一约束）
 * 2) MERGE 各实体（kind + 归一化名）3) MERGE 各边（Document -> 实体）。
 * 逐条失败记入 failures[] 并折算 'partial'；整体出错（驱动不可用等）为
 * 'failed'/'skipped'。永不抛出——确认流程不被图层阻塞。
 */
export async function writeDocumentGraph(
  input: WriteDocumentGraphInput,
  io: GraphWriterIo = defaultGraphWriterIo,
): Promise<GraphWriteResult> {
  const failures: string[] = [];
  let nodeCount = 0;
  let edgeCount = 0;

  // 0. 图未配置（NEO4J_PASSWORD 未设）-> skipped，非错误。
  if (!process.env.NEO4J_PASSWORD) {
    return { status: 'skipped', nodeCount: 0, edgeCount: 0, reason: 'NEO4J_PASSWORD not set', failures: [] };
  }

  // 1. Document 节点（失败即整体 failed：没有锚点无法连边）。
  let docNodeId: string;
  try {
    const docNode = await io.createEntity({
      kind: 'Document',
      name: input.docId,
      props: {
        docId: input.docId,
        docType: input.docType,
        ...(input.sourceUri ? { sourceUri: input.sourceUri } : {}),
      },
    });
    docNodeId = docNode.elementId;
    nodeCount += 1;
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return { status: 'failed', nodeCount, edgeCount, reason, failures: [`Document:${reason}`] };
  }

  // 2. 实体节点（归一化名；归一化后为空则跳过并记录）。
  const entityIds = new Map<string, string>(); // `${kind}:${norm}` -> elementId
  for (const ent of input.entities) {
    const norm = normalizeName(ent.name);
    if (!norm) {
      failures.push(`entity ${ent.kind}: normalized name empty (raw='${ent.name}')`);
      continue;
    }
    const key = `${ent.kind}:${norm}`;
    if (entityIds.has(key)) continue;
    try {
      const node = await io.createEntity({
        kind: ent.kind,
        name: norm,
        props: { rawName: ent.name, ...(ent.role ? { role: ent.role } : {}) },
      });
      entityIds.set(key, node.elementId);
      nodeCount += 1;
    } catch (e) {
      failures.push(`entity ${ent.kind}/${norm}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 3. 边（Document -> 实体），按 (src,type,dst) MERGE 幂等。
  for (const edge of input.edges) {
    const norm = normalizeName(edge.dstName);
    if (!norm) {
      failures.push(`edge ${edge.type}: normalized dst empty (raw='${edge.dstName}')`);
      continue;
    }
    const dstId = entityIds.get(`${edge.dstKind}:${norm}`);
    if (!dstId) {
      failures.push(`edge ${edge.type}->${norm}: dst node missing (create failed or skipped)`);
      continue;
    }
    try {
      await io.mergeEdge({
        srcId: docNodeId,
        dstId,
        kind: edge.type,
        confidence: edge.confidence,
        props: { source: 'auto', ...(edge.role ? { role: edge.role } : {}) },
      });
      edgeCount += 1;
    } catch (e) {
      failures.push(`edge ${edge.type}->${norm}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return {
    status: failures.length === 0 ? 'ok' : 'partial',
    nodeCount,
    edgeCount,
    failures,
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test --workspace apps/server -- test/graph/graphWriter.test.ts`
Expected: PASS（4 tests）

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/graph/graphWriter.ts apps/server/test/graph/graphWriter.test.ts
git commit -m "feat(graph): writeDocumentGraph 确定性幂等写图（容错/可注入 io）"
```

---

### Task 6: `commitDocumentGraph` 确认编排（pipeline 层）

**Files:**
- Create: `apps/server/src/pipeline/graphCommit.ts`
- Test: `apps/server/test/pipeline/graphCommit.test.ts`

**Interfaces:**
- Consumes: Task 4 `getReviewSnapshot/getDocumentSourceUri/setDocumentGraphStatus/DocumentGraphStatus`；Task 5 `writeDocumentGraph/GraphWriterIo`
- Produces: `commitDocumentGraph(ctx: DbContext, docId: string, userId?: string, io?: GraphWriterIo): Promise<DocumentGraphStatus>`（永不抛出；结果同时持久化到 documents.graph_status）

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/test/pipeline/graphCommit.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import {
  createDocumentStub, saveExtraction, setReviewStatus, getReviewSnapshot,
} from '../../src/pipeline/db/repositories.js';
import { commitDocumentGraph } from '../../src/pipeline/graphCommit.js';
import type { GraphWriterIo } from '../../src/graph/graphWriter.js';

let ctx: DbContext;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
});

async function seedInvoice(): Promise<string> {
  const { docId } = await createDocumentStub(ctx, { sourceUri: 'file:///inv.pdf', docType: '发票' });
  await saveExtraction(ctx, {
    documentId: docId, docType: '发票',
    fields: {
      合同号: { value: 'HT-1', sourceSpans: [] },
      卖方: { value: '中石化集团有限公司', sourceSpans: [] },
    },
    fieldMeta: {
      合同号: { strength: 'exact', confidence: 0.95 },
      卖方: { strength: 'exact', confidence: 0.9 },
    },
    overallConfidence: 0.9, needsReview: false,
    proposedRelationships: [
      { kind: 'Contract', name: 'HT-1', confidence: 0.95 },
      { kind: 'Party', role: '卖方', name: '中石化集团有限公司', confidence: 0.9 },
    ],
  });
  return docId;
}

const okIo: GraphWriterIo = {
  createEntity: async ({ kind, name }) => ({ elementId: `el-${kind}-${name}`, kind, name, props: {}, created: true }),
  mergeEdge: async () => ({}),
};

describe('commitDocumentGraph', () => {
  it('从持久化快照提交实体+边并落 graph_status', async () => {
    const id = await seedInvoice();
    await setReviewStatus(ctx, id, 'confirmed');
    const status = await commitDocumentGraph(ctx, id, 'user-1', okIo);
    expect(status.status).toBe('ok');
    expect(status.nodeCount).toBe(3); // Document + Contract + Party
    expect(status.edgeCount).toBe(3); // party + references + executes
    const snap = await getReviewSnapshot(ctx, id);
    expect(snap?.graphStatus).toEqual(status);
  });

  it('未知文档返回 failed(document_or_extraction_not_found)', async () => {
    const status = await commitDocumentGraph(ctx, 'DOC-missing', 'user-1', okIo);
    expect(status.status).toBe('failed');
    expect(status.reason).toBe('document_or_extraction_not_found');
  });

  it('图 io 出错不抛异常，failed 状态仍持久化', async () => {
    const id = await seedInvoice();
    await setReviewStatus(ctx, id, 'confirmed');
    const badIo: GraphWriterIo = {
      createEntity: async () => { throw new Error('neo4j down'); },
      mergeEdge: async () => { throw new Error('neo4j down'); },
    };
    const status = await commitDocumentGraph(ctx, id, undefined, badIo);
    expect(status.status).toBe('failed');
    expect(status.reason).toBe('neo4j down');
    const snap = await getReviewSnapshot(ctx, id);
    expect(snap?.graphStatus?.status).toBe('failed');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/pipeline/graphCommit.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现**

```ts
// apps/server/src/pipeline/graphCommit.ts
import type { DbContext } from './db/client.js';
import {
  getDocumentSourceUri,
  getReviewSnapshot,
  setDocumentGraphStatus,
  type DocumentGraphStatus,
} from './db/repositories.js';
import { writeDocumentGraph, type GraphWriteResult, type GraphWriterIo } from '../graph/graphWriter.js';

/**
 * 确认时图提交编排（design 2026-08-17 §4）：读持久化快照（字段 + 实体提议 +
 * docType）-> 派生实体/边 -> writeDocumentGraph -> 结果落 documents.graph_status。
 * 永不抛出：确认流程不被图层阻塞（图不可达 => status 'failed'/'skipped' 记录）。
 */
export async function commitDocumentGraph(
  ctx: DbContext,
  docId: string,
  userId?: string,
  io?: GraphWriterIo,
): Promise<DocumentGraphStatus> {
  const failed = (reason: string): DocumentGraphStatus => ({
    status: 'failed', nodeCount: 0, edgeCount: 0, reason, failures: [], writtenAt: new Date().toISOString(),
  });
  let status: DocumentGraphStatus;
  try {
    const snapshot = await getReviewSnapshot(ctx, docId, userId);
    if (!snapshot) return failed('document_or_extraction_not_found');
    const sourceUri = await getDocumentSourceUri(ctx, docId, userId);
    const result: GraphWriteResult = await writeDocumentGraph(
      {
        docId,
        docType: snapshot.docType,
        sourceUri,
        entities: snapshot.proposedRelationships.map((r) => ({
          kind: r.kind, name: r.name, role: r.role, confidence: r.confidence,
        })),
        edges: snapshot.proposedEdges.map((e) => ({
          type: e.type, dstKind: e.dstKind, dstName: e.dstName, role: e.role, confidence: e.confidence,
        })),
      },
      io,
    );
    status = {
      status: result.status,
      nodeCount: result.nodeCount,
      edgeCount: result.edgeCount,
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.failures.length ? { failures: result.failures } : {}),
      writtenAt: new Date().toISOString(),
    };
  } catch (e) {
    status = failed(e instanceof Error ? e.message : String(e));
  }
  try {
    await setDocumentGraphStatus(ctx, docId, status, userId);
  } catch (e) {
    // 状态本身持久化失败：记日志，不阻断确认流程。
    console.error('[graphCommit] graph_status persistence failed:', e instanceof Error ? e.message : String(e));
  }
  return status;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test --workspace apps/server -- test/pipeline/graphCommit.test.ts`
Expected: PASS（3 tests）

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/pipeline/graphCommit.ts apps/server/test/pipeline/graphCommit.test.ts
git commit -m "feat(pipeline): commitDocumentGraph 确认编排（快照->图写入->graph_status）"
```

---

### Task 7: review 路由 confirm 分支接线

**Files:**
- Modify: `apps/server/src/routes/review.ts`（import 区 + confirm 分支 ~:118-125）

**Interfaces:**
- Consumes: Task 6 `commitDocumentGraph`
- Produces: confirm 响应的 snapshot 自动携带 `proposedEdges/graphStatus`（Task 4 已加）

- [ ] **Step 1: 修改代码**

(a) import 区（`documentEntry.js` 导入行附近）追加：

```ts
import { commitDocumentGraph } from '../pipeline/graphCommit.js';
```

(b) confirm 分支整体替换为：

```ts
    } else if (confirm) {
      // Confirm-as-is: flip reviewStatus to 'confirmed' (previously a dead
      // state — this makes it reachable), then commit the derived entities/
      // edges to Neo4j (design 2026-08-17 §4). Graph commit is
      // fault-isolated: it NEVER blocks/fails the confirmation — the outcome
      // is persisted as documents.graph_status and surfaced on the snapshot.
      await setReviewStatus(ctx(), docId, 'confirmed', user.id);
      await commitDocumentGraph(ctx(), docId, user.id);
      snapshot = await getReviewSnapshot(ctx(), docId, user.id);
      if (!snapshot) {
        return c.json({ ok: false, error: 'document_or_extraction_not_found' }, 404);
      }
    } else {
```

- [ ] **Step 2: 类型检查 + 相关套件回归**

Run: `npm run build --workspace apps/server && npm test --workspace apps/server -- test/pipeline/graphCommit.test.ts test/harness/present-review.test.ts test/pipeline/db/review-graph.test.ts`
Expected: build PASS（tsc 零错误），测试全绿

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/routes/review.ts
git commit -m "feat(review): 确认分支提交图写入（fault-isolated）"
```

---

### Task 8: `graph_find_entity` 工具 + 三处注册 + 系统提示词

**Files:**
- Modify: `apps/server/src/graph/tools.ts`（导入 findEntities + 新 builder）
- Modify: `apps/server/src/harness/permissionGate.ts`（L1 注册块 ~:59）
- Modify: `apps/server/src/harness/contextContract.ts`（graph 块 ~:136 后）
- Modify: `apps/server/src/harness/roleToolRegistry.ts`（import + TRADER_CTX_TOOL_NAMES + push）
- Modify: `apps/server/src/harness/agent.ts`（SYSTEM_PROMPT 数组末尾追加一条）
- Test: `apps/server/test/graph/tools.test.ts`、`apps/server/test/harness/contextContract.test.ts`、`apps/server/test/harness/e2e-loop.test.ts`

**Interfaces:**
- Consumes: Task 2 `findEntities`
- Produces: trader 工具集新增 `graph_find_entity`（L1，只读）

- [ ] **Step 1: 写失败测试**

(a) `test/graph/tools.test.ts`：import 行加 `buildGraphFindEntityTool`；schema describe 内追加：

```ts
  it('graph_find_entity requires name; kind enum optional', () => {
    const t = buildGraphFindEntityTool();
    expect((t.inputSchema as any).safeParse({ name: '中石化' }).success).toBe(true);
    expect((t.inputSchema as any).safeParse({ kind: 'Party', name: '中石化', exact: true }).success).toBe(true);
    expect((t.inputSchema as any).safeParse({ kind: 'Bogus', name: 'x' }).success).toBe(false);
    expect((t.inputSchema as any).safeParse({}).success).toBe(false);
  });
```

contract describe 的 names 数组改为 `['create_entity', 'link_entities', 'graph_query', 'graph_find_entity']`。

(b) `test/harness/contextContract.test.ts`：`EXPECTED_TOOLS` 数组在 `'graph_query',` 后插入 `'graph_find_entity',`。

(c) `test/harness/e2e-loop.test.ts`：注释行与断言更新——注释追加 `+ graph_find_entity`，`expect(capturedNames).toHaveLength(18)` 改为 `19`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/graph/tools.test.ts test/harness/contextContract.test.ts test/harness/e2e-loop.test.ts`
Expected: FAIL —— builder 未导出 / EXPECTED_TOOLS 不匹配 / 数量 18≠19

- [ ] **Step 3: 实现**

(a) `graph/tools.ts`：import 行改为 `import { createEntity, linkEntities, graphQuery, findEntities } from './repo.js';`，文件末尾追加：

```ts
export function buildGraphFindEntityTool() {
  return tool({
    description:
      '按名称查找图实体 (Party/Commodity/Contract/Document), 返回 elementId 列表, 供 graph_query 起步或 link_entities 引用. 默认包含匹配 (CONTAINS), exact=true 精确匹配. 图不可用时返回错误.',
    inputSchema: z.object({
      kind: z.enum(['Party', 'Commodity', 'Contract', 'Document']).optional().describe('实体类型, 省略则查所有类型'),
      name: z.string().min(1).describe('实体名称或名称片段, 如 "中石化" / 合同号'),
      exact: z.boolean().optional().describe('true=精确匹配; 默认包含匹配'),
    }),
    execute: async ({ kind, name, exact }) => {
      const found = await findEntities({ kind, name, exact });
      return {
        status: 'ok' as const,
        matched: found.length,
        entities: found.map((e) => ({ elementId: e.elementId, kind: e.kind, name: e.name })),
      };
    },
  });
}
```

(b) `permissionGate.ts`（L1 块 `present_document_review` 行后）：

```ts
registerPermission('graph_find_entity', 'L1'); // 2026-08-17: 按名查图实体（只读入口）
```

(c) `contextContract.ts`（`graph_query` 条目后）：

```ts
  graph_find_entity: {
    // Read-only kind+name lookup. Returns graph-stored names/ids (trusted
    // agent graph data, no document text) -> output 'raw' / injection 'safe'.
    // Short bounded lists -> budget 'summary'. signal 'counter' (a read).
    persist 'graph' marks the store it reads.
    output: 'raw', budget: 'summary', signal: 'counter',
    persist: 'graph', risk: { level: 'L1', injection: 'safe' },
  },
```

(d) `roleToolRegistry.ts`：
- graph tools import 行加 `buildGraphFindEntityTool`；
- `TRADER_CTX_TOOL_NAMES` 在 `'graph_query',` 后插入 `'graph_find_entity',`；
- `getToolsForRole` 中 `graph_query` push 之前插入：

```ts
        // graph_find_entity is L1: read-only name lookup —— graph_query 缺的
        // "按名称找实体"入口（用户说名称，不说 elementId）。
        { ...buildGraphFindEntityTool(), name: 'graph_find_entity' },
```

(e) `agent.ts` SYSTEM_PROMPT 数组末尾（`'- 合同台账(接线闭环): ...'` 条目之后）追加：

```ts
  '- 图关系交互: 用户询问实体/单据关系("XX合同关联了哪些发票/单据"、"XX供应商有哪些合同")时, 先用 graph_find_entity 按名称定位实体拿到 elementId, 再用 graph_query 从该实体遍历(direction=both 双向命中); 用户要求建立/修正文件间关系("把这张发票挂到XX合同下"、"这两份合同背靠背")时, 用 graph_find_entity 定位两端实体后调 link_entities(L2, 需用户确认), 边类型优先复用词表 party/commodity/references/executes/back_to_back(购销方向写在 props.role)。经复核卡确认的单据已由系统自动写入图库, 不要再手动重建 party/commodity/references/executes 边。图工具返回错误(图不可用)时如实告知, 不得编造图数据。',
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test --workspace apps/server -- test/graph/tools.test.ts test/harness/contextContract.test.ts test/harness/e2e-loop.test.ts test/harness/wiring.test.ts`
Expected: PASS（全部含更新后的 19 断言）

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/graph/tools.ts apps/server/src/harness/permissionGate.ts apps/server/src/harness/contextContract.ts apps/server/src/harness/roleToolRegistry.ts apps/server/src/harness/agent.ts apps/server/test/graph/tools.test.ts apps/server/test/harness/contextContract.test.ts apps/server/test/harness/e2e-loop.test.ts
git commit -m "feat(harness): graph_find_entity L1 工具 + 注册 + 图交互提示词"
```

---

### Task 9: 前端复核卡升级（待确认关系边展示 + 图入库状态）

**Files:**
- Modify: `apps/web/src/components/DocumentReviewCard.tsx`

**Interfaces:**
- Consumes: Task 4 后端 snapshot 的 `proposedEdges/graphStatus`（present_document_review 与 review 端点同形）
- Produces: 卡片新维度渲染；`api/review.ts` 无需改动（类型经 `DocumentReviewPayload` 传递）

- [ ] **Step 1: 修改代码**

(a) lucide-react import 中加入 `Share2`（按字母序插入）。

(b) `DocumentReviewPayload` 类型：`proposedRelationships` 字段后追加：

```ts
  proposedEdges?: Array<{
    type: 'party' | 'commodity' | 'references' | 'executes'
    dstKind: 'Party' | 'Commodity' | 'Contract'
    dstName: string
    role?: string
    confidence: number
  }>
  graphStatus?: {
    status: 'ok' | 'partial' | 'failed' | 'skipped'
    nodeCount: number
    edgeCount: number
    reason?: string
    failures?: string[]
    writtenAt: string
  } | null
```

(c) `RELATIONSHIP_KIND_LABEL` 常量后追加：

```ts
const EDGE_TYPE_LABEL: Record<string, string> = {
  party: '当事方',
  commodity: '标的物',
  references: '引用合同',
  executes: '执行合同',
}
```

(d) `VectorizationStatus` 组件后追加：

```tsx
const GraphStatusView: React.FC<{ g: NonNullable<DocumentReviewPayload['graphStatus']> }> = ({ g }) => {
  const map = {
    ok: { label: '已入库', cls: 'bg-success/10 text-success border-success/30', Icon: CheckCircle2 },
    partial: { label: '部分入库', cls: 'bg-amber/10 text-amber border-amber/30', Icon: AlertTriangle },
    failed: { label: '失败', cls: 'bg-danger/10 text-danger border-danger/30', Icon: AlertCircle },
    skipped: { label: '未配置', cls: 'bg-bgGray text-textGray border-borderGray', Icon: MinusCircle },
  } as const
  const entry = map[g?.status] || map.skipped
  const { Icon } = entry
  return (
    <div className="text-xs">
      <div className="flex items-center gap-2 flex-wrap">
        <span
          className={clsx(
            'inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded border',
            entry.cls,
          )}
        >
          <Icon className="w-3 h-3" />
          {entry.label}
        </span>
        <span className="text-textGray">
          节点 <span className="font-mono text-steelBlue">{g?.nodeCount ?? 0}</span>
        </span>
        <span className="text-textGray">
          边 <span className="font-mono text-steelBlue">{g?.edgeCount ?? 0}</span>
        </span>
      </div>
      {g?.reason && (
        <div className="text-[11px] text-textGray italic mt-1 line-clamp-2">{g.reason}</div>
      )}
    </div>
  )
}
```

(e) 组件解构（`vectorization,` 后）追加 `proposedEdges, graphStatus,`。

(f) "3. 待确认关系" 区块：实体 chips 的 `</div>` 之后、区块收尾 `</div>` 之前追加：

```tsx
          {(proposedEdges ?? []).length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-1.5">
              {(proposedEdges ?? []).map((e, i) => (
                <span
                  key={`${e.type}-${e.dstName}-${i}`}
                  className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded border bg-bgGray/50 text-textDark border-borderGray/50"
                >
                  <span className="text-textGray">
                    {EDGE_TYPE_LABEL[e.type] || e.type}
                    {e.role ? `(${e.role})` : ''}
                  </span>
                  <span className="font-medium">{e.dstName}</span>
                  <span className="font-mono text-steelBlue">{pct(e.confidence)}</span>
                </span>
              ))}
            </div>
          )}
```

(g) "6. 向量化入库状态" 区块之后追加：

```tsx
        {/* 7. 图入库状态 — 确认时 Neo4j 写入结果（2026-08-17）；未确认（graphStatus 为
            null/undefined）时不渲染。 */}
        {graphStatus && (
          <div>
            <SectionLabel icon={<Share2 className="w-3 h-3" />}>图入库状态</SectionLabel>
            <GraphStatusView g={graphStatus} />
          </div>
        )}
```

- [ ] **Step 2: 类型检查 + 构建前端**

Run: `npm run build --workspace apps/web`
Expected: `tsc -b && vite build` PASS

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/DocumentReviewCard.tsx
git commit -m "feat(web): 复核卡展示提议边与图入库状态"
```

---

### Task 10: 全量验证 + 推送

**Files:** 无新增（验证与推送）

- [ ] **Step 1: 全量三连（repo 根目录，顺序固定）**

Run: `npm run build && npm run lint && npm test`
Expected: build PASS / lint 零错误 / 全部 vitest 套件绿（Postgres 集成与 live Neo4j 用例按环境跳过）

- [ ] **Step 2: （可选，配置了 NEO4J_PASSWORD 的本地环境）live 图写入验证**

Run: `NEO4J_PASSWORD=<pwd> npm test --workspace apps/server -- test/graph/repo.test.ts`
Expected: live describe 不跳过且全绿（mergeEdge 幂等 / findEntities 匹配）

- [ ] **Step 3: 确认无越权暂存后推送**

```bash
git status --short   # 只应看到本计划 10 个任务的文件
git push origin main
```

Expected: push 成功，CI（install→build→lint→test）触发；main 分支绿。

---

## Self-Review 记录

- **Spec 覆盖**：§2 图模型（Document/实体节点 + 受控边词表）→ Task 5/3；§3.1 角色扩展 → Task 3；§3.2 确定性边派生 → Task 3；§3.3 复核卡两维 → Task 4（snapshot）+ Task 9（渲染）；§4 确认写入/graph_status/不阻塞 → Task 5/6/7；§5 归一化 → Task 1；§6.1 graph_find_entity → Task 2/8；§6.2 工具组合 → Task 8 提示词；§6.3 提示词 → Task 8(e)；§7 验证 → 各 Task 测试 + Task 10。back_to_back 按 spec 为手动路径（提示词指引），无自动写入 —— 覆盖。
- **占位符扫描**：无 TBD/TODO；每步含完整代码或精确命令。
- **类型一致性**：`ProposedEdge`（Task 3 定义，Task 4 snapshot 使用）；`GraphWriterIo`（Task 5 定义，Task 6 注入）；`DocumentGraphStatus`（Task 4 定义，Task 6/7 使用）；`findEntities/mergeEdge`（Task 2 定义，Task 5/8 使用）。签名已逐一核对。
- **偏离说明**：graph_status 增加 `'skipped'`（图未配置）状态，优于 spec 原文把未配置也记 'failed'——卡片可区分"未配置"与"失败"，其余语义不变。
