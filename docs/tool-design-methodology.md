# 工具设计方法论（Tool Design Methodology）

> 版本：2026-08-28。SSOT 清单：`docs/tool-inventory.json`；执行门禁：
> `apps/server/test/harness/toolInventory.test.ts`（CI 必跑）。
> 理论来源：《AI Agent Book》ch2（上下文工程）/ ch4（工具设计哲学）、
> Pi（Mario Zechner，四工具极简派）、Codex CLI（极简核心 + 动态加载）、
> Claude Code / OpenCode（多专用工具派的反面参照）。

本仓库（供应链业务 Agent）在 2026-08-28 将 trader 工具面从 30 个收敛到 26 个
（砍 4、环境门控 1），并登记了后续合并计划（26 -> 19）。本文档把这套方法固化
为**可验证、可重复**的流程，防止工具面再次无序膨胀。

## 0. 一句话原则

> 模型只需回答四类问题：**读**（系统里有什么）、**算**（拿数据推理）、
> **写**（改状态，需审批）、**求助**。工具按这四类组织，不按"每张表 x 每个动词"组织。

每个工具描述每轮都进上下文（ch2 静态前缀），工具面膨胀 = 每轮白烧 token +
选择噪声。4 个描述清晰的工具胜过 40 个松散的（Pi）。

## 1. 四步流程（顺序执行，每步可独立提交验证）

### 第 1 步：砍死（YAGNI）

满足任一条即候选，两条以上必须砍：

- **无数据源**：数据来自演示种子/硬编码，生产环境必然空手（例：`query_orders`、`cross_check` 只读 `data/seed.js`）
- **环境未配置**：依赖的部署资源不存在，挂载必败（例：`execute_code` 依赖 CubeSandbox，生产未配 -> 走环境门控而非直接删）
- **被新闭环取代**：功能被更完整的流程覆盖（例：`verify_document_fields` 被 `present_document_review` + `update_document_fields` 取代；`extract_fields` 与 `ingest_document` 的自动抽取重叠）

执行动作：registry 移除 + 清单挪入 `removed` 黑名单（防回潮，历史案例 `create_payment`）。

### 第 2 步：并相似（统一入口 + 类型参数）

**合并判据（三条同时满足才合）**：

1. 功能相似（都是同一数据面的同类操作）
2. 使用场景重叠（模型会在同一类问题里二选一犹豫）
3. 参数集简单且同构（能被一个枚举参数区分）

例：`query_contract` / `query_execution_flows` / `query_quota_usage` /
`project_rollup` / `template_overview` -> `query_business(entity, ...)`；
`link_contracts` / `link_projects` / `link_amends` -> `link_documents(relation)`
（底层本就是同一个 `GraphLinkKind` 三选一）。

**保持独立的反判据**（任一条成立就不合，强行合并反而语义模糊）：

- 参数形态差异大（例：`inspect_extraction` 是单字段 span 下钻）
- 使用频率极高、语义不可替代（例：`gather_settlement_evidence` 是"一次给齐"的复合取证包）
- 涉及写操作需要独立审计粒度（见第 2 节）

### 第 3 步：挂场景（动态装配）

- 常驻核心工具 <= 10 个；其余按场景（录入态/问答态/结算态）经 AI SDK 6
  `activeTools` 按意图窄化，变动放轮次边界
- 部署级差异用**环境门控**：`mount: "env"` + 显式开关
  （例：`execute_code` 仅在 `CUBE_SANDBOX_ENABLED=true` 时挂载；未启用 =
  工具根本不存在，而不是运行时报错让模型撞墙）
- 参考 Codex 的 `tool_search` 思路：动态部分追加在轮次末尾，保持静态前缀稳定以复用 KV Cache

### 第 4 步：Skill 化（流程知识不占工具名额）

"怎么做"的知识（质量扣款判定流程、结算取证顺序、基态换算规则）写成文档/
系统提示词/Skill，按需加载（渐进式披露，ch4）。工具回答"能做什么"，
Skill 回答"怎么做"——用工具数量解决流程知识问题是方向性错误。

## 2. 硬性规则（门禁测试强制）

1. **清单先行**：新增/删除/合并工具，先改 `docs/tool-inventory.json` 再改
   registry。测试断言两侧**双射**——registry 里的每个工具必须有清单条目，
   清单条目必须真实存在。
2. **描述三要素**：每个工具必填 `whenToUse`（什么时候用）、`boundary`
   （做不到什么/不接受什么——边界比能力描述更重要）、`rationale`
   （为什么它值得存在）。
3. **黑名单**：`removed` 里的名字不得重新出现。
4. **合并计划可追溯**：`mergeInto` 必须指向已登记的 `merges.plans` 目标；
   计划吸收的名字必须真实在册。
5. **deprecated 必须带 `removalPlan`**：挂起状态的工具不允许无限期存在。
6. **场景挂载数上限**：`policy.maxToolsMountedPerScenario`（当前 10），
   场景挂载实现后由测试强制。

## 3. 描述写作规范（每个工具的 description 都要过这五条）

1. **何时用优先于是什么**："按内容召回已录入单据片段" 不如 "需按内容召回…
   时调用；枚举台账用 query_contract，不要用本工具反复翻找"
2. **写边界**：明确"做不到什么、不接受什么输入"（未命中返回空数组、只接受
   INGEST_ROOT 白名单路径…）
3. **参数给例子**：`contractNo`（如 GMNH-JBKZ-20250303HNWH），不写抽象规范
4. **说明返回结构与代价**：返回 matches 数组含 document_id/snippet；
   大文档可能较慢时给出替代入口
5. **选错工具先修描述**：模型频繁选错时，第一反应该是修 description，而不是换更强的模型

## 4. 变更流程（可重复）

```
提出工具变更
  -> 改 docs/tool-inventory.json（新条目含三要素 / deprecated / merges / removed）
  -> 改 registry（挂载逻辑、门控、needsApproval）
  -> 跑 npm test --workspace apps/server -- test/harness/toolInventory.test.ts
  -> build -> lint -> test 全绿后提交（commit message 注明方法论阶段）
```

## 5. 当前状态快照（2026-08-28）

| 阶段 | 动作 | 工具面 |
|---|---|---|
| 完成前 | 初始 30 个（含 4 个死工具） | 30 |
| 阶段 1（2026-08-28） | execute_code 环境门控（默认不挂载）；4 个 deprecated 登记 | 29 -> 26（生产默认 25） |
| 阶段 2a（2026-08-28） | query_business 5 合 1（query_contract/query_execution_flows/query_quota_usage/project_rollup/template_overview -> removed） | 26 -> 22（生产默认 21） |
| 阶段 2b（2026-08-28） | link_documents 3 合 1（correlates/relates/amends）+ tag_document 并入 update_document_fields(tags 参数) | 22 -> 19（生产默认 18） |
| 阶段 3（2026-08-28） | 场景挂载（harness/scenarios.ts: entry/qa/settlement ∪ CORE，检测保守，'all' 不收窄；每场景可见 <= 10） | 每步视口 7-10 |
| 评估（2026-08-28） | 工具选择评估集 eval/datasets/tool-use.json：离线门禁 test/eval/toolUse.dataset.test.ts（npm test）+ 真实模型 runner `npm run eval:tools` | 持续回归 |
| 运维 | 标签回填脚本 `npm run backfill:tags --workspace apps/server`（先 --dry-run） | Lane B 生效 |
