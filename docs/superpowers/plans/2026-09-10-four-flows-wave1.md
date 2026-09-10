# 四流波次一 实施计划：事件对手方/货权口径 + 恒等式自洽 + 商品匹配注册

> **For agentic workers:** 按 superpowers:executing-plans 逐任务执行；每任务先写失败测试再实现。验证顺序 `npm run build && npm run lint && npm test`（仓库根）。

**Goal:** 三件事——① 决策 #11 落地（TRADING_WITH 关系 + 收发货事件的 counterpartyId/titleTransfer 字段，补"上游发货"场景缺口）；② confirm_settlement 算术自洽硬校验（方法论 §10.5 标注"立即可做"的快赢）；③ Phase 2 核心（match_goods L1 + register_goods L2，商品主数据"匹配优先、注册兜底"）。

**Architecture:** 全部零 DDL。①② 走本体注册表与既有工具文件；③ 新增 2 个工具（五道门登记）+ `ontology/goodsMatch.ts` 打分模块（纯 SQL 检索 trade_facts，不依赖 Neo4j/向量——向量召回属波次二）。

**Tech Stack:** TypeScript 严格 / zod ^3 / vitest；AI SDK `tool()`（inputSchema zod）。

**Spec:** `docs/superpowers/specs/2026-09-09-counterparty-subject-identity.md`（§11 Phase 2 / 决策 #11 / §14 backlog#1；§1-§10 与"实施记录"为已上线背景，只需通读不需重做）。

## Global Constraints

- 零 DDL、零 emoji；feature 分支 `PengYip/four-flows-wave1` 从 origin/main 切出，验证绿后 push 分支并合 main
- **Phase 1（Task 1-8 of 2026-09-09 计划）已实施上线，本计划不要重做**；spec §1-§10/实施记录是背景
- 新增 2 个工具 = 每个走五道门：tool-inventory.json → roleToolRegistry → permissionGate → contextContract → scenarios（+TRADER_CTX_TOOL_NAMES）
- 场景帽：settlement 现 12/12，本波 +2（match_goods/register_goods）→ `maxToolsMountedPerScenario` 12→14，inventory version 同步 bump（此为显式决策，提交信息注明）
- 本波**不做**（后续波次）：向量召回通道、确认流候选自动挂接、别名反馈闭环、未匹配报告、CargoLot/TRANSFER_LOT/SPLIT_FROM（§13 Phase 3）、ERP 同步
- 开工第一步：`git fetch origin && git checkout -b PengYip/four-flows-wave1 origin/main`，基线 `npm run build && npm run lint && npm test` 全绿再动手

## 摸底锚点（2026-09-10 main；行号可能漂移，以文件/函数名为锚）

- 注册表：`apps/server/src/ontology/index.ts`（现 10 关系类型/17 对；GoodsReceiptEvent/GoodsDeliveryEvent payload 无 counterpartyId/titleTransfer）
- 工具：`ontology/linkTools.ts`（LINKABLE_RELATIONS 8 元）、`ontology/eventTools.ts`（CreateTradeEventInputSchema）、`pipeline/tools/settlementTools.ts`（confirm_settlement）
- 登记：`docs/tool-inventory.json`（version 2026-09-09，帽 12）、`harness/roleToolRegistry.ts`（TRADER_CTX_TOOL_NAMES + base.push 挂载）、`harness/contextContract.ts`（TOOL_CONTEXT_CONTRACTS）、`harness/permissionGate.ts`、`harness/scenarios.ts`（SETTLEMENT 列表）
- 断言：`test/harness/contextContract.test.ts`（EXPECTED_TOOLS）、`test/pipeline/integration-recall.test.ts`（trader 工具总数 23）、`test/harness/toolsRoutes.test.ts`（inventory version）

---

### Task 1: TRADING_WITH + counterpartyId/titleTransfer（决策 #11）

**Files:** `ontology/index.ts`、`ontology/eventTools.ts`、`ontology/linkTools.ts`、`test/ontology/registry.test.ts`、`test/ontology/linkTools.test.ts`、`test/ontology/eventTools.test.ts`

**Interfaces:**
- `ONTOLOGY_RELATIONS` 增 `TRADING_WITH`：pairs `GoodsReceiptEvent→Counterparty`、`GoodsDeliveryEvent→Counterparty`；params `z.object({ role: z.enum(['上游','下游']) }).strict()` → 11 类型/19 对
- `ONTOLOGY_ENTITIES.GoodsReceiptEvent/GoodsDeliveryEvent` 增可选 `counterpartyId: z.string().min(1)`（对手方事实 id）、`titleTransfer: z.string().min(1)`（货权口径：发货即转/签收转/验收转/到岸转，v1 开放文本）
- `CreateTradeEventInputSchema` 增同名两个可选字段（实体字段随 payload 自然透传，**不需要**解构摘出——与 documentId 的溯源列处理区分）；表单投影自动带出
- `LINKABLE_RELATIONS` + 'TRADING_WITH'（9 元）

**Steps:**
- [ ] 失败测试：registry（11 类型/19 对/TRADING_WITH 白名单 true、事件→TradeGoods false）；eventTools（收货事件带 counterpartyId/titleTransfer 落 payload）；linkTools（TRADING_WITH 建边 ok、缺 role 拒、role 非法值拒）
- [ ] 实现三文件；EDGE_LABELS（web `businessTypes.ts`）+ `TRADING_WITH: '交易对手'`
- [ ] 全量 ontology 测试 + toolOntologyMap/toolInventory 通过

### Task 2: confirm_settlement 算术自洽硬校验（快赢）

**Files:** `pipeline/tools/settlementTools.ts`、`test/pipeline/tools/settlementTools.test.ts`（沿既有测试文件定位）

**Interfaces:**
- confirm_settlement execute 前置校验追加：**算术自洽**——`totalAmount ≈ settledQuantity × basePrice + Σadjustments.amount`（容差 0.005；basePrice 缺省或 adjustments 为空时跳过对应项）；不满足 → 返回 `{status:'invalid', detail:'算术自洽校验失败: ...差异...'}`，**只拒绝不改写**（不自动修正数字）
- 既有硬校验（结算量≤权威交付量、依据流水归属本合同）不变

**Steps:**
- [ ] 失败测试：自洽通过（调整项正负混合）；总额与算式差 > 容差被拒且 detail 含差异值；无 basePrice 跳过校验照常确认
- [ ] 实现；回归 settlement 既有测试

### Task 3: match_goods L1 工具（匹配优先）

**Files:** Create `ontology/goodsMatch.ts`、`test/ontology/goodsMatch.test.ts`；登记五道门 + scenarios

**Interfaces:**
```ts
// ontology/goodsMatch.ts
export interface GoodsCandidate {
  id: string; name: string; spec: string | null; commodityCode: string | null;
  score: number; evidence: string;   // 'commodityCode 精确' | '归一键精确' | '名称包含'
}
export async function matchGoods(
  ctx: DbContext, q: { name: string; spec?: string; commodityCode?: string }, userId?: string,
): Promise<{ candidates: GoodsCandidate[]; suggestion: 'match' | 'register' }>;
// 通道: 1) commodityCode 精确(score 1.0) 2) normalizeSpec(name)+normalizeSpec(spec) 归一键精确(0.95)
//       3) name 归一后包含匹配(score 0.6, 证据=命中字段)。候选去重、按分排序、上限 10。
// suggestion: 有 score≥0.95 候选 -> 'match'；否则 'register'（Agent 据此走 register_goods）
```
- 工具 `match_goods`（L1）：inputSchema `{ name: min(1), spec?, commodityCode? }`（字段 ∈ TradeGoods 实体词汇，toolOntologyMap 门禁自然通过）；output 候选+suggestion；描述引导"register_goods 前必先调用本工具"

**Steps:**
- [ ] 失败测试：三通道各自命中（归一异写 "3×120+1×70" vs "3*120+1*70" 命中归一键）；无候选 suggestion=register；候选去重排序；用户隔离
- [ ] 实现模块 + 工具壳；登记五道门（inventory 条目 whenToUse/boundary/rationale、L1、group 商品主数据；permissionGate L1；contextContract {output:'raw', budget:'token', signal:'env', persist:'none', risk:{level:'L1',injection:'safe'}}；scenarios：settlement + qa 两场景挂载）

### Task 4: register_goods L2 工具（注册兜底）

**Files:** Create `ontology/goodsRegisterTool.ts`（或并入 goodsMatch.ts 同文件，实施时定）、`test/ontology/goodsRegisterTool.test.ts`；五道门同上

**Interfaces:**
- inputSchema：`{ name: min(1), commodityCode?, spec?, unit?, attributes?: record<string, scalar>（≤32 条）, validAt }`——描述强制"调用前必须先 match_goods 确认无匹配，避免重复建档"
- execute：`insertTradeFact(ctx, { entityType:'TradeGoods', payload, validAt, createdBy:'register_goods' }, userId)`（attributes 受控约束由写入边界 superRefine 强制）→ fire-and-forget `syncOntologyGraphSafe` → `{status:'ok', id, entityType}` / `{status:'invalid', detail}`

**Steps:**
- [ ] 失败测试：注册落库（createdBy/attributes 幂等校验链生效）；attributes 超限被拒；重复 name+spec（归一键同）**仍允许**但 detail 提示"存在疑似重复，建议先 match_goods"（软提示不阻断——重名不同规格合法）
- [ ] 实现工具；登记五道门（L2、group 商品主数据、settlement 场景；permissionGate L2；contextContract 同 create_trade_event 模式 persist:'business'）

### Task 5: 登记收尾 + 场景帽提升

**Files:** `docs/tool-inventory.json`、`harness/roleToolRegistry.ts`、`harness/scenarios.ts`、`harness/permissionGate.ts`、`harness/contextContract.ts`、`test/harness/contextContract.test.ts`、`test/pipeline/integration-recall.test.ts`、`test/harness/toolsRoutes.test.ts`

**Steps:**
- [ ] inventory：+match_goods/+register_goods 条目、version '2026-09-10'、**maxToolsMountedPerScenario 12→14**（提交信息注明理由：结算域动作/读工具，决策留痕）
- [ ] roleToolRegistry 挂载（match_goods L1 无需审批；register_goods L2 needsApproval）+ TRADER_CTX_TOOL_NAMES + scenarios SETTLEMENT（match_goods 同时挂 qa）+ permissionGate（L1/L2）+ contextContract 两契约 + contextContract.test EXPECTED_TOOLS + integration-recall 总数 23→25 + toolsRoutes version 断言
- [ ] 全量 `npm test --workspace apps/server` 通过

### Task 6: 收尾验证 + 合并

- [ ] 仓库根 `npm run build && npm run lint && npm test` 全绿
- [ ] spec §11 回填实施记录（波次一交付范围 + 波次二遗留：向量召回/确认流候选/别名闭环/未匹配报告）
- [ ] push 分支 + 合 main，盯 CI/CD 到绿；dev 冒烟：对话"匹配 商品X → 无候选 → register_goods 注册（审批）→ 再 match 命中"；台账商品详情 attributes/穿透节点 attr. 展平核对

## 波次二（本波不做，届时另立计划）

向量召回通道（商品嵌入 + pgvector 检索）；确认流自动挂候选（绑定工作台模式）；别名反馈闭环；未匹配商品定期报告；CargoLot/TRANSFER_LOT/SPLIT_FROM（spec §13 Phase 3）；TRADING_WITH 的在途查询视图。

## 规模预估

Task 1-6 单 PR，约 1-1.5 天。Task 3 打分口径是唯一设计余地，歧义以 spec §11 为准。
