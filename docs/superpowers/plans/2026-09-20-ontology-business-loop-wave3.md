# 本体业务闭环 Wave 3（AI 读闭环）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** AI 对话能查本体（台账/穿透/核销余额）且知道本体词汇（能登记什么/查什么）——消灭断点"AI 读侧不通"。

**Architecture:** `query_business` 沿其 entity 判别词模式扩三个只读值（ontology/neighbors/writeoff），实现内联（沿 unbound_docs 先例直调函数，不新建 builder 工具）；SYSTEM_PROMPT 尾部追加本体词汇节（模块加载期静态生成，沿 buildSkillIndexSection 先例，KV cache 静态前缀不变）。

**Tech Stack:** TypeScript / zod / vitest。

**Spec:** `docs/superpowers/specs/2026-09-20-ontology-business-loop-design.md` §3 Wave 3。

---

## Global Constraints

- 验证 `npm run build && npm run lint && npm test`；零 emoji；不新增工具/路由（query_business 是既有工具扩词表）
- query_business 是 L1 只读——新 entity 值不得引入写路径
- tool-inventory.json 的 query_business 条目 whenToUse 补三个新 entity 值
- 分支 PengYip/tools-grouping；Wave 2 完成后执行本计划

## 摸底结论（2026-09-20 自读核实）

- `pipeline/tools/queryBusiness.ts`（110 行）：entity enum 六值分派，五值委托 builder、unbound_docs 内联直调 `listUnboundVoucherDocs(deps.ctx, deps.userId)`——内联先例在 :93-105。
- `harness/agent.ts:32-48`：SYSTEM_PROMPT 静态数组 join('\n')，尾部 `...buildSkillIndexSection(discoverSkills()).split('\n')` 模块加载期拼接。
- 本体读函数（Wave 1 已产出）：`ontology/projection.ts listProjectedEntities(ctx, type, opts, userId)`；`ontology/neighbors.ts getNeighbors`（签名实施时 rg 对齐）；`ontology/writeoff.ts getWriteoffOverview`（同前）；`ontology/index.ts ENTITY_LABELS/ONTOLOGY_RELATIONS`（词汇节数据源）。

---

### Task 1: query_business 扩本体读

**Files:**
- Modify: `apps/server/src/pipeline/tools/queryBusiness.ts`
- Modify: `docs/tool-inventory.json`（query_business 条目 whenToUse）
- Test: `apps/server/test/pipeline/tools/queryBusiness.test.ts`（无则创建，沿 :memory: 范式）

**Interfaces:**
- Produces: entity enum 增 `'ontology' | 'neighbors' | 'writeoff'`；inputSchema 增 `entityType?: string`（ontology 用，12 实体名）、`factId?: string`（neighbors/writeoff 锚点）。

- [ ] **Step 0**: rg 对齐 `getNeighbors`/`getWriteoffOverview` 精确签名（参数序/返回形）
- [ ] **Step 1: 失败测试**——三用例：ontology 返回某实体台账分页 items；neighbors 以 factId 锚点返回邻域（空数据时 status ok + nodes 0）；writeoff 返回余额汇总结构
- [ ] **Step 2: 跑红** → **Step 3: 实现**——switch 增三 case（沿 unbound_docs 内联模式直调三个函数，错误 try/catch 返回 `{error}` 不抛）；description 增用法句与两个调用示例；tool-inventory 同步
- [ ] **Step 4: 跑绿 + commit** `feat(tools): query_business reads ontology ledger/neighbors/writeoff (business-loop wave3)`

### Task 2: SYSTEM_PROMPT 本体词汇节

**Files:**
- Modify: `apps/server/src/harness/agent.ts`（SYSTEM_PROMPT 尾部）
- Test: `apps/server/test/harness/systemPrompt.test.ts`（无则创建）

- [ ] **Step 1: 失败测试**——SYSTEM_PROMPT 含 'GoodsReceiptEvent'、'BELONGS_TO'、'登记' 与 'link_ontology' 引导语；含本体词汇节标记行
- [ ] **Step 2: 跑红** → **Step 3: 实现**——agent.ts 增纯函数 `buildOntologyVocabSection(): string`（import `ENTITY_NAMES/ENTITY_LABELS/ONTOLOGY_RELATIONS` from '../ontology/index.js'；渲染为 ≤25 行：12 实体一行一名+标签，17 关系一行一名+一句话；尾部一句"登记事件=create_trade_event、登记关系=link_ontology、核销=create_writeoff/create_offset；查询=query_business entity=ontology/neighbors/writeoff"）；SYSTEM_PROMPT 数组尾部 `...buildOntologyVocabSection().split('\n')`
- [ ] **Step 4: 跑绿 + commit** `feat(harness): ontology vocabulary section in system prompt (business-loop wave3)`

### Task 3: 收口（已获授权自动执行）

- [ ] 全量验证 → 合并 push（CI/CD 自动部署）→ spec 实施记录回填
