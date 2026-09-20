# 本体业务闭环 Wave 4（报表闭环）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 四组勾稽缺口报表（存货/应收/应付/票款错配）以本体表为数据源可查——数字可复现原型金标准样例，消灭闭环最后一个断点。

**Architecture:** 纯 TS 聚合模块 `ontology/gaps.ts`（facts+edges 最新业务口径 rollup，公式对齐原型 reportGaps）+ 既有 `/api/ontology` 挂载下追加一个只读 GET 路由 + 前端缺口面板（designer 通道执行）。金标准测试以原型 CON-2025-0817/CON-2025-0512 的 11 项 checks 数字为断言。

**Tech Stack:** TypeScript / vitest / Hono（既有路由挂载）/ React（前端，designer）。

**Spec:** `docs/superpowers/specs/2026-09-20-ontology-business-loop-design.md` §3 Wave 4。

---

## Global Constraints

- 验证 `npm run build && npm run lint && npm test`；零 emoji
- 聚合只读（L1 语义）：不写任何表；新路由只挂在既有 `/api/ontology`（requireAuth 已覆盖）
- 前端任务走 designer 子代理（UI 质量归设计通道），后端先交付 DTO
- 分支 PengYip/tools-grouping；Wave 3 完成后执行

## 聚合口径（对齐原型 reportGaps，W4-A）

数据源：`trade_facts`（asOfBusinessTime(now)）+ `ontology_edges`。合同归属两路：payload.contractNo（发票/付款/收款/结算）与 ALLOCATE_TO 边（收/发货 → 台账行 id → contract_no）。

按合同聚合：receipts{qty,amt} / deliveries{qty,amt} / settlements(amt) / invoicesIn(amt，红冲负数自然轧差) / invoicesOut(净amt) / payments(净amt，退款负数) / collections(amt)。

四组缺口（tiles：存货结存 qty、应收未收 amt、应付未付 amt、票款错配 amt）：
- 存货：①已采购未销售 qty=Σ购收−Σ销发（TRADE_PAIR 范围优先，无则全局）；②已收货未结算=Σ购收amt−Σ购结算；③已发货未结算=Σ销发amt−Σ销结算
- 应收：④结算未收=Σ销结算−Σ收款；⑤发货未收=Σ销发amt−Σ收款；⑥开票未收=净销项−Σ收款
- 应付：⑦结算未付=Σ购结算−Σ付款净；⑧收货未付=Σ购收amt−Σ付款净；⑨收票未付=Σ进项−Σ付款净
- 错配：⑩付无票=|付款净−Σ进项|；⑪收无票=|Σ收款−净销项|
- 数据可得性：某口径缺输入（如收货无 amt）时该项 null + missingInputs 标注，不造数。

金标准数字（原型样例，测试断言）：采购 0817：收 1600t/3,200,000，结算 2,444,000，进项票 2,444,000，付款净 2,616,000（1,158,000+1,544,000−86,000）；销售 0512：发 390t/764,000，结算 588,000，净销项 529,200（588,000−58,800），收款 588,000。断言：①1,210t ②756,000 ③176,000 ⑧ 584,000 ⑨=⑦ 900,000 ⑩172,000 ⑪58,800；tiles：存货 1,210t / 应收 176,000（发货口径）/ 应付 900,000（结算口径）/ 错配 230,800。

---

### Task 1: 聚合模块 ontology/gaps.ts

**Files:** Create `apps/server/src/ontology/gaps.ts`；Test `apps/server/test/ontology/gaps.test.ts`

**Interfaces:**
- Produces: `computeGaps(ctx, opts?: { projectNo?: string }, userId?): Promise<GapsReport>`
- `GapsReport = { scope: string; tiles: Array<{ key, label, qty?: number|null, amt?: number|null, hint?: string }>; groups: Array<{ key, label, desc, items: Array<{ code, label, qty?: number|null, amt?: number|null, basis, missingInputs?: string[] }> }>; checks: string[] }`
- Consumes: `listTradeFactsAsOf/listOntologyEdgesAsOf`（repo）、`findContractRowById`（projection）

- [ ] **Step 1: 失败测试**——seed 台账两合同 + 原型数字全量 facts/edges（含红冲负数票、退款负数付款、ALLOCATE_TO 数量边），断言 tiles 四值与 ⑦⑨⑩⑪ 等关键 items 数字；再断言缺 amt 的收货 → ② missingInputs 标注 null 不造数
- [ ] **Step 2: 跑红** → **Step 3: 实现**（纯函数聚合，沿 writeoff.ts 口径风格；金额 EPSILON 0.005 对齐）
- [ ] **Step 4: 跑绿 + commit** `feat(ontology): gaps aggregation module with prototype golden numbers (business-loop wave4)`

### Task 2: REST GET /api/ontology/gaps

**Files:** Modify `apps/server/src/routes/ontology.ts`；Test `apps/server/test/routes/ontologyGaps.test.ts`（沿既有路由测试范式，无则参照 writeoffRoutes.test.ts）

- [ ] 失败测试（200 形状 + projectNo 过滤 + 未认证 401 由挂载层既有断言覆盖）→ 实现（GET /gaps，调 computeGaps，异常 500 兜底）→ 跑绿 + commit `feat(routes): GET /api/ontology/gaps (business-loop wave4)`

### Task 3: 前端缺口面板（designer 通道）

**Files:** `apps/web/src/`（组件位置与导航挂载由 designer 定，建议 Overview 或 ontology 台账旁挂"勾稽缺口"入口；api client 沿 apps/web/src/api/ontology.ts 既有模式加 fetchGaps()）

- [ ] dispatch designer：四 tiles 摘要行 + 四组可折叠明细（code/label/qty/amt/basis，missingInputs 显示"待登记"态）+ 刷新动作；零 emoji；沿既有设计语言（卡片/间距/色阶与 OverviewView 一致）
- [ ] designer 产出后跑 web 测试 + commit `feat(web): reconciliation gaps panel (business-loop wave4)`

### Task 4: 收口（已获授权自动执行）

- [ ] 全量验证 → 合并 push（CI/CD 部署）→ dev 库 `POST /api/ontology/graph/sync` 后用真实单据冒烟 GET /api/ontology/gaps → spec 实施记录回填
