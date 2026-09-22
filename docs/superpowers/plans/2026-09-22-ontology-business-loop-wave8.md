# 本体业务闭环 Wave 8（AI 可答勾稽 + 按合同下钻 + 契约卫生）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。Steps 用 checkbox 跟踪。
> **压缩恢复锚点**：恢复时读本文件 + `docs/superpowers/specs/2026-09-20-ontology-business-loop-design.md` + `.superpowers/sdd/2026-09-22-ontology-business-loop-wave8/progress.md`；分支 PengYip/tools-grouping，基线 = origin/main 3397f40；评审席 councillor + oracle 终审、fixer/designer 会话见 Background Job Board。

**Goal:** 补全六环验收第 4 环的真实缺口——勾稽数字进 AI 问答（query_business entity=gaps）；gaps 按合同下钻（验收实测撞到的第一需求）；清偿 oracle 定位的契约卫生三项（refreshedFlows 单位、修正审计、'(kg)' 单位推断）。

**Architecture:** computeGaps 已是纯读函数，三个消费面（REST 面板 / AI 工具 / 逐合同下钻）共用同一聚合，ContractAgg 内部数据只需暴露不需重算。契约卫生三项互相独立，均为小改动。数据面（华能背靠背链）已由导入战役落地 dev，作为本波验收的实弹靶场。

**Spec:** 主 spec Wave 7 记录 + oracle 终审 triage（refreshedFlows 异单位为最高优先）+ Wave 7 followup 的 kg 键观察。

## Global Constraints
- 验证 `npm run build && npm run lint && npm test`；零 emoji；本体写入只经 repo 边界
- 注册表（apps/server/src/ontology/index.ts）零变更 → 指纹不重生成；若评审引入变更必须重生成 `test/ontology/registry-fingerprint.json`（win32 用 .ts 后缀，workdir apps/server）
- tool-inventory.json 变更仅限 query_business 条目 whenToUse/boundary/rationale 文案与 group 归属，registry 双射门禁不动
- dev 复测账号 acceptance@test.local（Origin 头必带）；API 测试走 Node .mjs；dev 库业务表绝不 TRUNCATE
- 授权状态：用户已授权全程自主（合并/推送/部署自动执行）

## Task 1: AI 可答勾稽（query_business entity=gaps）

**Files:** `apps/server/src/pipeline/tools/queryBusiness.ts`、`docs/tool-inventory.json`、test（沿 queryBusiness 既有工具测试文件，无则新建 test/pipeline/tools/queryBusinessGaps.test.ts）。

**Interfaces:**
- Consumes: `computeGaps(ctx, opts, userId)`（ontology/gaps.ts 既有，GapsReport {scope,tiles,groups,checks}）；inputSchema 既有 `projectCode` 参数（entity=project/quota 用）——gaps 复用该参数映射 computeGaps 的 projectNo（BELONGS_TO 反查）。
- Produces: `entity:'gaps'` 分支返回 `{status:'ok', entity:'gaps', scope, tiles, checks, usage}`（tiles 四组数字+hint；groups 明细不进工具返回——对话场景 tiles+checks 够用，明细走面板；usage 引导"按合同明细用 gaps 面板"）。

- [ ] 失败测试：entity=gaps 返回 tiles 四组（fixture 断言数字）；projectCode 传递（有 BELONGS_TO fixture 时 scope 命中，无则断言透传行为）；缺参不炸（全局口径缺省）。
- [ ] 实现：enum +'gaps'；describe 补一行；switch 分支直调 computeGaps（沿 unbound_docs 分支的直调风格，错误不抛返回 error 对象）；inventory 条目 whenToUse 补 `gaps=四组勾稽缺口快照(存货结存/应收未收/应付未付/票款错配, 可选 projectCode)`。
- [ ] 全量验证；Commit: `feat(tools): query_business entity=gaps — reconciliation tiles in AI answers (business-loop wave8)`

## Task 2: gaps 按合同下钻（server 数据暴露 + 组名兜底修复）

**Files:** `apps/server/src/ontology/gaps.ts`、可能 `apps/server/src/ontology/projection.ts`（contractNo 兜底）、test（gaps 既有测试文件扩展）。

**Interfaces:**
- Produces: GapsReport 增 `contracts: GapContractRow[]`——`{contractNo, side:'buy'|'sell'|null, receiptsQty, deliveriesQty, settlements, invoicesIn, invoicesOut, payments, collections, receiptsQtyMissing, deliveriesQtyMissing, paymentsMissing}`（从既有 aggs Map 直接投影，按 |settlements+invoicesOut+invoicesIn| 或合同号稳定排序；不新增聚合逻辑）。
- **组名兜底修复**（oracle candidate）：resolveByEdge 现回退台账行 id（ledger fields 缺 contractNo）——修为优先用台账 `contract_no` 列（核对 findContractRowById/projection 的 fields 映射，缺则在投影处补 `fields.contractNo`，或在 gaps 侧由行 id 反查 contract_no）；sideUnknown 备注同步受益。

- [ ] 失败测试：多合同 fixture → contracts[] 各行数字正确；合同号显示为 contract_no 而非 CLD- 行 id；missing 标志正确。
- [ ] 实现 + 既有 gaps 测试回归；Commit: `feat(ontology): gaps per-contract drilldown rows + contractNo naming fallback (business-loop wave8)`

## Task 3: GapsPanel 按合同下钻展示（designer 通道）

**Files:** `apps/web/src/components/ontology/GapsPanel.tsx`（+ 同目录测试）。

- 要求：消费 Task 2 的 `report.contracts`——面板增"按合同"展开区（四 tiles 下方折叠列表：合同号/侧别徽标/量与金额列/缺失标注弱化态）；沿用既有设计语言与角标体系；空态（无归属合同数据）安静折叠；projectNo 过滤联动。文案接地（orchestrator 复核）。
- **Commit:** `feat(web): gaps per-contract drilldown in GapsPanel (business-loop wave8)`

## Task 4: 契约卫生 A——refreshedFlows 单位统一

**Files:** `apps/server/src/routes/contracts.ts`、`apps/web/src/api/contracts.ts`（+ 两端测试）、tool-inventory 无涉。

- 设计裁决（oracle 建议 + 向后兼容）：contracts.ts PATCH 响应**新增 `refreshedDocuments`**（语义准确的"张"数），`refreshedFlows` 保留为同值别名（deprecated 注释 + API 注释标明单位=文档张数）；review.ts PATCH /type 的 refreshedFlows 语义本就准确（单文档流水条数）不改。web 的 ContractTypeChangeResult 切到 refreshedDocuments 消费（文案不变，仍是张口径）。
- [ ] 失败测试：响应两字段并存同值；web 消费切换后冒烟不破。
- [ ] Commit: `fix(routes): refreshedDocuments field on contract-type correction, unit-ambiguous alias kept (business-loop wave8)`

## Task 5: 契约卫生 B——修正动作审计

**Files:** `apps/server/src/pipeline/db/client.ts`（SQLite raw DDL）、`postgres-repositories.ts`（migratePostgres + 查询）、`db/postgres-schema.ts`（drizzle twin）、`routes/contracts.ts` + `routes/review.ts`（两写入点）、test。

- 设计：新表 `correction_audit`（id TEXT pk, kind TEXT（'contract_type'|'doc_type'）, target TEXT（contractNo 或 docId）, old_value TEXT NULL, new_value TEXT, user_id TEXT, created_at UTC ISO）；写入点=contracts.ts PATCH type（old 从台账行读）+ review.ts PATCH /type（old 从 documents 读）；审计失败仅 warn 不阻断主流程（沿图同步兜底模式）。
- [ ] 失败测试：两写入点各落一行审计（字段全断言）；审计表双后端列镜像断言（tables.test 模式）。
- [ ] Commit: `feat(pipeline): correction_audit trail for type corrections (business-loop wave8)`
- 查询端点不做（DB 可查），spec 记候选。

## Task 6: 契约卫生 C——'(kg)' 后缀单位推断

**Files:** `apps/server/src/pipeline/bindingProposal.ts`（单位推断链）、`domain/tradeSemantics.ts`（运输凭证 qtyFields）、`pipeline/templateSeed.ts`（hints）、test。

- 推断链现状（:425-428）：`unitHint ?? (name.endsWith('_吨')?'吨':undefined) ?? unitFields`——增 `\(kg\)$/i` 后缀识别 → unit='kg'（UNIT_REGISTRY 已含 kg；mass canonical → projectLegacyQuantity /1000 出吨）。
- 运输凭证 qtyFields 追加 `['重量(kg)','kg'], ['计费重量(kg)','kg']`（吨制键之后）；templateSeed 运输凭证 hints 补两键。
- [ ] 失败测试：{重量(kg):57720} → quantityTon=57.72（正是 mt 旧批异常值的单位解释）；{重量_吨:100} 仍优先吨制；适配表断言。
- [ ] Commit: `fix(pipeline): (kg)-suffix unit inference + waybill kg qty keys (business-loop wave8)`

## Task 6b: 发票/付款事件物化修复（materializer fieldStr 包装形态——导入战役战地发现，**执行序第一**）

**Files:** `apps/server/src/pipeline/ontologyMaterialize.ts`、test（沿 wave2/5 materializer 既有测试文件扩展）。

**战地证据（2026-09-22 导入报告）：** 销项票 #14 发票号已抽取（26422000003159763606，修正补键）且发票流已物化（5,117,908.02），但 InvoiceEvent 跳过——materializer 的 fieldStr 补充字段读取期望**裸字符串**，而抽取 fields 实际存 `{value, sourceSpans}` 包装对象 → invoiceNo/payType 守卫全部落空；PaymentEvent 同病（存量 2021 发票流同受影响）。此 bug 卡死勾稽钱侧（④⑤⑥⑦ tiles 的发票/付款事实）。

- [ ] 失败测试：fixture 抽取 fields 为 `{发票号码: {value: '2642...', sourceSpans: []}, 款项类型: {value: '预付...', ...}}` 包装形态 → InvoiceEvent 物化（invoiceNo 命中）、PaymentEvent 物化（payType 关键词命中）；既有裸字符串形态（如测试 fixture 旧形状）行为不回归。
- [ ] 实现：fieldStr/关键词读取处解包 `.value`（对象形态取 value，原始标量兼容——双形态守卫）；核对 W2-C 的款项类型关键词与发票号读取路径全链。
- [ ] 修复后存量复活验证：dev 上 backfill:ontology 对 2021 发票流（或导入 #14）重跑 → InvoiceEvent 落事实（收口时一并复测）。
- [ ] Commit: `fix(pipeline): materializer reads wrapped extraction field values — invoice/payment events revive (business-loop wave8)`

## Task 7: 收口
- 全量验证 → 合并推送（CI/CD 部署）→ dev 验收：
  a) AI 可答：对话问"四组勾稽缺口现在什么数"→ 模型调 entity=gaps 答出 tiles 数字（与面板一致）；
  b) 下钻：GapsPanel 按合同区可见华能背靠背两合同的逐合同数字，合同号显示正常（非 CLD-）；
  c) 导入链复检：GMNH/HNJM 流水与 tiles 与 (a) 战役导入报告一致；
  d) kg 修复复测：mt 旧批称重单（如 DOC-mtjgnlw0）重抽或重绑后 quantity 不再 57720 吨级异常（57.72t）。
- spec 回填 Wave 8 记录；oracle 全分支终审后合并。

## 遗留（本波不做，回归样例专项接续）
- **回归测试样例集**（用户指令第三阶段，(a)+(b) 落地后立项）：从华能语料选代表性文档 + ERP 结构化真值（批次量/结算额/付款额）为 Ground Truth，冻结 golden expectations，接 eval 管线（apps/server/eval）——任何功能变更改变 Ground Truth 即红。
- gaps 面板 contracts 分页/上限（当前合同量级 <50 直出）、认票管理 vouchers 语义、华能云南滇东甄别。
