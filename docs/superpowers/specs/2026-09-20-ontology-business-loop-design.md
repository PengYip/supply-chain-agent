# 本体业务闭环 ontology-business-loop：从单据确认到勾稽报表的全链

日期: 2026-09-20
状态: 待裁决（D1-D4 阻塞性决策均有默认值，Wave 1 可按默认值开工）
上游:
- 产品原型 WALL-F：`D:\Users\yepeng\workai`（`js/data.js` 演示数据 + `db/schema.sql` PG 设计）
- `docs/superpowers/plans/2026-09-07-ontology-foundation.md`（本体基座，已落地 main）
- `docs/superpowers/specs/2026-09-09-ontology-graph-projection.md`（图谱投影 P1-P4，已落地）
- `本体建模技术备忘.md`（领域模型 SSOT，工作区根）
- docx《贸易企业全链路数据本体建设落地方案（精准关系语义校准终版）》（最终上游）

## 1. 背景与问题

产品原型定义了完整业务闭环：录入 → 解析抽取 → 复核确认 → 实体化（本体事实 +
关系 + 图谱）→ 勾稽操作（核销/冲抵/分摊/红冲）→ 报表（购销存票四组勾稽缺口）
→ AI 对话读写。原型与本项目同源（同一 docx 方案），实体/关系核心已在本项目落地，
但闭环存在七个已核实断点：

| # | 断点 | 证据 |
|---|---|---|
| 1 | 管线确认后不写本体：`insertTradeFact/insertOntologyEdge` 调用方仅 6 个对话工具 + 主数据端点，pipeline 目录零调用 | explorer 全量核实 2026-09-20 |
| 2 | 关系词汇缺 5 个：BELONGS_TO / STOCK_OFFSET / INVOICE_MATCH / TRADE_PAIR / MASTER_SUPPLEMENT；无 TradeProject 核算分组实体 | `ontology/index.ts`（11 实体 / 11 关系 / 19 对）vs 原型 schema.sql §3.3 |
| 3 | 实体字段薄：原型 biz_* 富字段（方向/签约日/仓库/结算类型…）未进注册表，勾稽报表缺锚点字段 | `ONTOLOGY_ENTITIES` v1 最小集 |
| 4 | AI 读侧不通：`query_business` 不读本体表；本体 schema 未注入对话上下文 | `queryBusiness.ts:26-50` |
| 5 | 报表缺两块：存货结存（STOCK_OFFSET 口径）与票票配比（INVOICE_MATCH 口径）；应收/应付/票款错稽已有（R2 + projectRollup） | `reconciliation.ts` / `projectRollup.ts` |
| 6 | 模型版本机制缺：无行级 schema_version；原型期高频变更 + 多版本并行无基础设施 | `trade_facts/ontology_edges` 列清单 |
| 7 | 注册表派生不完全：`graphSync.FACT_NODE_LABELS` 与 `projection.BUSINESS_KEY_FIELDS` 硬编码，新实体易改漏 | `graphSync.ts:35` / `projection.ts:185` |

## 2. 闭环定义与验收口径

六环验收（全部通过 = 业务闭环成立）：

1. **录入即入谱**：单据复核确认后，本体台账与图谱自动出现对应事实节点与归属边，
   不依赖对话手工登记。
2. **关系可登记**：事实间关系（归属/核销/冲抵/分摊/红冲/库存核减/票票配比/主补/
   背靠背）可经工具 + 工作台登记，全部走写入边界。
3. **报表可复现**：四组勾稽缺口（存货/应收/应付/票款错配）数字可复现原型金标准样例。
4. **AI 可问可答**：对话中可查询本体（台账/穿透/余额/缺口），答案以本体表为数据源。
5. **模型可演进**：注册表变更走版本机制；旧数据按写入时版本存活，as-of 读不受影响。
6. **全链绿**：build → lint → test。

**金标准样例**：原型 `chainProgress/reportGaps` 的 CON-2025-0817（采购 ¥3.86M /
1,600t）与 CON-2025-0512（销售 ¥980K / 390t），11 项勾稽检查（原型 data.js
`reportGaps.checks` ①-⑪）做成 Wave 4 测试断言。

## 3. 分波方案

四波递进，每波独立交付可测试软件；Wave 1 计划随本 spec 出，Wave 2-4 计划在
前置决策确认后按波补写。

### Wave 1 模型与版本基座（本 spec 的 Plan: 2026-09-20-ontology-business-loop-wave1.md）

- schema_version 行级血缘标记（两表双后端）+ 注册表内容指纹 CI 门禁
- 硬编码清单注册表派生（FACT_NODE_LABELS / BUSINESS_KEY_FIELDS）
- TradeProject 第 12 实体（静态，masterData 表单入口）+ BELONGS_TO 关系
- 5 个新关系：TRADE_PAIR / MASTER_SUPPLEMENT / STOCK_OFFSET / INVOICE_MATCH /
  WRITE_OFF_SETTLEMENT（D1 裁决，17 类型 / 26 连接对）
- 实体字段最小扩展集（D4 默认集）
- link_ontology 词表扩到 14 关系（含合同端点解析重构）
- 旧本体测试数据清理（D8 运维步骤）

### Wave 2 实体化一跳（断点 1；2026-09-20 修订：映射源升级）

- **映射源（修订裁决 W2-A，基于管线侦察）**：`execution_flows` 为主源（confirmed 绑定驱动、
  flow_type×direction×amount/quantity/voucher_date 已类型化、UNIQUE(binding_id) 幓等）——
  映射词表：货物流+in→GoodsReceiptEvent / 货物流+out→GoodsDeliveryEvent / 发票流+in→
  InvoiceEvent(进项) / 发票流+out→InvoiceEvent(销项) / 资金流+out→PaymentEvent / 资金流+in→
  CollectionEvent。`settlement_records`（confirm_settlement 确认产物）直连映射 SettlementEvent。
  extraction 最新行仅作补充字段源（warehouse/发票号码/款项类型关键词）。
- **W2-B 幂等**：execution_flows 与 settlement_records 各加 `ontology_fact_id` 可空列
  （guarded ALTER 双后端 + drizzle twin），materializer 写回 fact id；非空即跳过。
- **W2-C 保守跳过策略**：PaymentEvent 必填 payType 无法从流推断——extraction 款项类型
  关键词（预付/尾款/进度款/质保金）可解析则用，否则跳过并计数；InvoiceEvent 必填
  invoiceNo——extraction 发票号码缺失则跳过并计数（不造假数据）。资金币种缺省 CNY。
- **W2-D 注册表修订**（版本升 '2026-09-20-loop-v3'）：ALLOCATE_TO params 放宽为
  {amount?, quantity?, ratio?, method, batch?}——注册表**不硬拦**双缺（params 类型
  须保持 ZodObject 供 .shape 消费），"至少其一"由写入方运行时守卫保证
  （materializer 必供其一；link_ontology 有守卫）。
- 触发点：单据确认（review.ts 单条+批量）、绑定确认/流水刷新（bind_document、
  refreshExecutionFlowsForDocument）、结算确认（confirm_settlement）三族钩子，全部
  fire-and-forget（复刻 syncOntologyGraphSafe 模式）+ 图投影。
- 回填：`backfill:ontology` tsx 脚本（--dry-run 先行，沿 backfillEmbeddings 先例）。
- 逆向事件（退货/红冲）不经 materializer——沿用对话登记（create_trade_event）。

### Wave 3 AI 读闭环（断点 4）

- `query_business` 增本体数据源（实体台账 listProjectedEntities / 穿透 getNeighbors /
  核销余额 getWriteoffOverview），沿其既有"结构化统一读入口"定位扩 resource 类型
- 有界本体词汇节（`buildOntologyVocabSection`，模块加载期静态消费注册表常量——
  与注册表零漂移）注入 system prompt 尾部；枚举词汇由工具 inputSchema 承载
- 不新增写工具（Wave 1 已把 14 关系全量入 link_ontology / 核销工作台）

### Wave 4 报表闭环（断点 5）

- 聚合函数（TS，沿 writeoff.ts 口径）：`goodsBalance(goodsCode/spec, warehouse)`
  = Σ收货净量 − Σ发货量（沿 STOCK_OFFSET 边）；`invoiceMatchResidual(goodsName)`
  = Σ进项 − Σ销项（红字负数参与，沿 INVOICE_MATCH 边）
- 四组勾稽缺口 API `GET /api/ontology/gaps?projectNo=`（对齐原型 reportGaps 口径：
  已采购未销售/已收货未结算/已发货未结算/应收未收/应付未付/票款错配）
- 前端报表视图（复用 OverviewView/ProjectLedger 模式）
- 金标准测试：原型 11 项 checks 数字断言

## 4. 待裁决决策点

### 阻塞 Wave 1 定稿（D1-D4，均有默认值）

**D1 WRITE_OFF 核销目标口径【已裁决 2026-09-20：采用结算目标（原型口径）】**
裁决内容: 新增关系名 `WRITE_OFF_SETTLEMENT`（PaymentEvent/CollectionEvent →
SettlementEvent，常规核销），Wave 1 Task 5 注册；既有 `WRITE_OFF`（→发票，票款匹配）
**保留并存**，禁止复用旧名改语义（决策 #9）。核销工作台（create_writeoff）与
对账公式（writeoff.ts）向结算目标的迁移归 **Wave 4 前置任务**（勾稽口径统一时切换，
涉及 BALANCE_ENTITY_TYPES/WriteoffView 联动，不进 Wave 1）。

**D2 TradeProject 第 12 实体**
默认: **采纳**。核算分组需要本体级锚点（BELONGS_TO 目标、资产树、按项目勾稽）。
落地: 静态实体 + masterData 表单 + 图投影事实节点（不桥既有 (:Project)，避免与
文档派生 Project 节点键空间冲突；桥接留 Wave 5 观察项）。
不采纳的后果: BELONGS_TO 无目标实体，资产树/按项目报表只能沿用图派生节点，
本体侧无项目维度。

**D3 退款语义**
默认: **保持 EventBizType='逆向' + 负数金额**（不往 PayType 加 '退款' 值）。与注册表
现行语义规则（逆向=负数自动轧差）一致，与红冲同构。原型的 pay_type=refund 是
类型值方案，表达力等价，采纳需动闭枚举 + 全部既有断言，收益为零。

**D4 v1 字段扩展范围**（Wave 1 Task 6 + Wave 2 映射器目标词汇）
默认最小安全集:
- TradeContract: +direction(开放) signDate? expireDate? buyerName? sellerName? contractAmount?
- GoodsReceiptEvent / GoodsDeliveryEvent: +warehouse?（STOCK_OFFSET 核减维度）
- SettlementEvent: +settlementType?（周期/批次/最终/补差，开放）
原型 biz_* 其余富字段（磅差/水杂/质检指标/允差/定价方式/交货条款/INCOTERMS…）
按业务需要追加，机制相同（payload 词汇扩展免 DDL）。

### 非阻塞（有默认，可后改）

**D5 占位边/后置绑定/FIFO 账本**: v1 不做。冲抵发生时建边 + 聚合算余额（现状）。
业务要求逐笔回放时 Wave 5 立项（nullable to + bound_at + biz_fund_offset 式流水）。
**D6 报表范围**: 四组全做（Wave 4），存货/票票配比依赖本 Wave 的 STOCK_OFFSET/
INVOICE_MATCH。
**D7 实体化粒度**: document 级 1:1，units 走 EVIDENCE。
**D8 旧本体数据**: dev 库（sca-pgvector）TRUNCATE 两表（测试数据无审计价值）；
本地 SQLite 自理。不走 invalid_at 仪式。

## 5. 设计决策

1. **版本化 = 行级 schema_version + 内容指纹门禁（L1 级多版本），不做 DB 元数据化**。
   zod 保持编译期 SSOT（类型安全 + CI 门禁不丢）；指纹测试强制"注册表内容变了
   必须同步指纹文件"，版本号是语义发布标记。多版本并行 v1 达到"同库新旧共存"；
   部署级并行（L0）天然可用（分支 + 独立 DB）。
2. **指纹用纯 TS fnv-1a + 稳定序列化**：注册表文件保持零 node 内建依赖（前端可
   消费约束，ontology-foundation 决策沿用）。指纹文件进 test 目录随代码走。
3. **schema_version 盖章在写入边界，读路径透传不校验**：v1 版本语义 = 数据血缘
   标记（这行按哪个版本文体写入），不是多 schema 运行时路由。回填可显式指定
   旧版本盖章。
4. **FACT_NODE_LABELS 派生规则 = ENTITY_NAMES 去掉 TradeContract**（TradeContract
   永远走 Contract 桥，graphSync.ts:35 注释先例）。TradeProject 自动进事实节点集，
   验证派生正确性的测试随 Task 4 落。
5. **BUSINESS_KEY_FIELDS → 注册表 ENTITY_BUSINESS_KEYS 映射**（按实体声明业务键
   优先级数组），projection 消费；新实体不再改 projection 硬编码。
6. **新关系全部带参**: STOCK_OFFSET params {quantity, batch?}（对应原型 weight=核减
   数量）；INVOICE_MATCH params {quantity, note?}；TRADE_PAIR / MASTER_SUPPLEMENT
   params {note?}。quantity 新入 SHARED_TOOL_FIELD_NAMES（toolOntologyMap 词表）。
7. **link_ontology 端点解析泛化**: 现要求 from 必为事实行；BELONGS_TO/TRADE_PAIR/
    MASTER_SUPPLEMENT 的合同端点走 findContractRowById（ALLOCATE_TO to 侧既有先例）。
    词表 9 → 14 关系；WRITE_OFF/OFFSET_SETTLE/WRITE_OFF_SETTLEMENT 仍刻意排除
    （核销工作台领地，结算核销迁移归 Wave 4）。
8. **不新增 agent 工具**: 全部经既有 link_ontology 扩词表；tool-inventory.json 只改
   link_ontology 条目的 whenToUse/boundary（inventory bijection 门禁不动）。
9. **旧关系语义冻结**: WRITE_OFF 维持 → 发票（D1 默认）；任何已发布关系的语义变更
   一律新名 + 旧边 invalid_at，禁止复用名。

## 6. 测试与验收（Wave 1）

- `test/ontology/registry.test.ts`：12 实体（4+1 静态 + 7 事件）/ 17 关系 / 26 连接对
  断言更新；**指纹门禁新用例**（version+fingerprint 与 `registry-fingerprint.json`
  一致；改注册表不更新文件即红）。
- `test/ontology/repo.test.ts`：schema_version 默认盖章 / 显式覆盖（回填）断言。
- `test/pipeline/postgres.integration.test.ts`：两表 schema_version 列断言。
- `test/ontology/graphSync.test.ts`：派生 label 集含 TradeProject（零改 graphSync）。
- `test/ontology/masterData.test.ts`：TradeProject 表单投影四类主数据。
- `test/ontology/linkTools.test.ts`：14 关系词表 / 合同端点解析（BELONGS_TO from
  合同行 / TRADE_PAIR 双合同端点）/ quantity params strict。
- 收口：全量 `npm run build && npm run lint && npm test`；指纹文件重生成命令留档。

## 7. Out of scope（明确不做）

- 原型产品面：IM/OA/ERP 账号打通、待办、会议、看板、动态（另行立项，不进本体层）
- 占位边 / 后置绑定 / 参数迭代审计 / FIFO 账本（D5 默认不做，Wave 5 候选）
- 本体元数据 DB 化（object/link/action/rule 行式元数据，原型路线 L2）
- CDC 增量同步 / SOURCE_ROW_CAP=500 扩容 / GraphRAG
- 已发布关系复用名改语义（永久禁止，见决策 #9）

## 实施记录

### Wave 3（2026-09-20 完成，终审 MERGE_READY）

- **T1 本体读三值**（cac9373）：query_business entity 增 ontology/neighbors/writeoff
  （内联直调三个只读函数，错误不抛）；factId 入共享词表（R17；指纹值不变——共享词表
  不进 schema 投影）。
- **T2 词汇节**（d94a2be）：`buildOntologyVocabSection()` 模块加载期静态生成（≤25 行，
  12 实体+17 关系+工具引导），置于 skill 索引后；与注册表常量同源零漂移；inventory
  口径同步。
- **终审 7 Minor 全可推迟**：#1 关系简介"首句截 30 字"对 wave1/2 六关系截断失义（Wave 4
  改 strip 出处注记）、#2 entityType 白名单校验、#3 ontology 分页参数、#4 uscc 剔除
  注记、#5 L2 标注整句化、#6 换行（本次已修）、#7 spec 措辞（本次已修）。



- **T1 ALLOCATE_TO 数量归属**（f745f35）：params 放宽 {amount?, quantity?, method, batch?}
  （W2-D，不用 superRefine 保 ZodObject 类型）；版本 '2026-09-20-loop-v3'；R8 口径下
  link_ontology 的运行时守卫折入 T3。
- **T2 幂等写回列**（ef820d5）：execution_flows/settlement_records 各加 ontology_fact_id
  （三处镜像）。留意：src/pipeline/db/schema.ts SQLite drizzle twin 未被迁移消费未同步。
- **T3 实体化映射器**（7dbd8b5）：`pipeline/ontologyMaterialize.ts`——execution_flows 按
  flow_type×direction 映射六事件实体；extraction 补充字段（仓库/发票号/款项类型关键词）；
  跳过计数不造假（W2-C）；ALLOCATE_TO 数量/金额边 + fact_id 回写幂等；safe 包装吞错 +
  图投影 fire-and-forget；settlement_records 直连 SettlementEvent。结算→合同边被连接对
  白名单拒绝 → R10 裁决走 payload.contractNo 属性路由。
- **T4 六挂点 + R10**（47c785f）：SettlementEvent 补 contractNo?（对齐 Invoice 族先例，
  指纹重生成，版本维持 v3）；materializer 结算 payload 激活；确认/绑定/结算三族钩子
  全部 void ...Safe 挂接。留意：review.test 同文件双 confirm 404 系既有环境怪癖（受控
  实验证明与钩子无关），deferred 独立排查。
- **T5 回填脚本**（d108083）：`npm run backfill:ontology`（--dry-run 零写副作用 / --limit
  200 默认），只调 materialize 函数不复制逻辑，实跑末尾 await 图收敛。
- **验收**：每任务 TDD 红绿 + 全量绿（终态 server 1917 passed / web 123 / lint 0 错误）；
  五任务评审全部 Spec PASS + Quality APPROVED；裁决台账 R7-R10 见 SDD ledger。
- **最终评审修复轮（R11-R13，2026-09-20 三轮收敛，oracle 终审放行）**：
  - R11（7dd550a）：refresh=删全重建摧毁幂等链——去重复用/差异换代（旧事实 invalid_at
    +旧边失效）/条件认领封 TOCTOU；correct_document 补钩；settlement 台账行 id 语义摆正；
    四 Minor（settlement 图投影/计数口径/换行/spec 措辞）。
  - R12（39e10d6）：一单多绑定匹配键过粗——本趟认领集 + ALLOCATE_TO 边目标优先配对 +
    孤儿清扫。
  - R13（351b412）：顺序绑定主路径残余——维度级模式判别（claimedSiblings==0 重建签名
    才配对/换代/清扫；增量模式 plain insert 不动兄弟事实），清扫收窄到有成功流的配对维度。
  - 遗留裁决：同合同重复绑定不去重=审计链语义（Wave 4 勾稽层策略）；解绑不触发刷新的
    孤儿事实存活到下次全量刷新（可恢复）；差异换代连带失效用户手工边=换代语义（Wave 4+
    评估补登记 UX）。
- **收口**：全量绿（server 1925 / web 123 / lint 0 错误）；合并 main + push（CI/CD 部署）；
  dev 库 backfill dry-run→实跑 + 图收敛。

### Wave 1（2026-09-20 完成，分支 PengYip/tools-grouping，六任务全评审通过）

- **T1 版本化机制**（4d15f49）：`ONTOLOGY_SCHEMA_VERSION='2026-09-20-loop-v2'` +
  `registryContentFingerprint()`（纯 TS fnv-1a 稳定序列化，剔除 version）+ 指纹文件
  `test/ontology/registry-fingerprint.json` CI 门禁。win32 下重生成命令用 `.ts` 后缀。
- **T2 schema_version 落列**（55abdfd）：trade_facts/ontology_edges 双后端 + drizzle
  twin 三处加列；repo 四处 INSERT 与行映射全链透传；缺省盖章=当前版本、显式覆盖=回填。
  附带 tables.test.ts 列镜像断言补列（最低必要）。
- **T3 注册表派生**（3ee74b6）：`FACT_NODE_LABELS = ENTITY_NAMES 去掉 TradeContract`；
  `ENTITY_BUSINESS_KEYS` 按实体声明业务键，`businessKeyOf` 导出。指纹中性如裁决。
- **T4 TradeProject + BELONGS_TO**（4013833）：第 12 实体（静态，projectNo/name 必填）、
  masterData 四类表单、link_ontology 合同起点解析（CONTRACT_FROM_RELATIONS）。
  附带 routes 计数/web businessTypes 标签（门禁逼出，评审裁决接受）。
- **T5 五新关系**（fe6916e）：TRADE_PAIR/MASTER_SUPPLEMENT/STOCK_OFFSET/INVOICE_MATCH/
  WRITE_OFF_SETTLEMENT（D1 裁决新名承载）——17 类型/26 连接对；link_ontology 词表 14
  （WRITE_OFF_SETTLEMENT 归核销工作台领地）；SHARED_TOOL_FIELD_NAMES +quantity；
  自环守卫。核销读侧注册表驱动自动纳入新关系（R6 裁决=设计使然），写侧不扩面归 Wave 4。
- **T6 字段扩展集**（e27ccaf）：TradeContract +direction(必填)/signDate/expireDate/
  buyerName/sellerName/contractAmount；收发货 +warehouse；结算 +settlementType。
- **验收**：每任务 TDD 红绿 + 全量 build/lint/test 绿（终态 server 1904 passed / 42
  skipped[PG 集成车道] / web 123 passed / lint 0 错误）；六任务评审全部 Spec PASS +
  Quality APPROVED，全部 Minor 已随后续任务携带修复，无遗留 deferred。
- **裁决台账**（R1-R6 详见 SDD ledger）：R4 PG 集成断言待 sca_test 库实跑；R5 版本
  波次级升版（Wave 1 合并即 '2026-09-20-loop-v2'）；R6 核销读侧纳入=设计使然。
- **收口待办**：合并 main + push（触发 CI/CD）；D8 dev 库两表 TRUNCATE；PG 集成在
  sca_test 实跑（R4）。
