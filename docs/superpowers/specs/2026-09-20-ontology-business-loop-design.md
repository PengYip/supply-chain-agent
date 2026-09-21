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

### Wave 7（2026-09-21 合同类型消歧+遗留清偿，7 提交已部署 4142d01）

- **T1 映射链诊断**（无代码）：乐化 XYRL-2022-225 dev 实证——抽取值"购销合同"有意不映射
  （别名表设计，tradeSemantics:35）、标题"煤炭购销合同"关键词不中、甲方/乙方锚点在但乙方
  （湖北国贸供应链管理有限公司）不在 self_parties → 三层诚实降级全落空；抽取行早台账行
  3-5ms **无 confirm 早于抽取竞态**；upsertContractLedgerEntry 唯一调用点=录入时。结论
  (A) 链路完好纯歧义。
- **T2 修正端点**（78bea28）：`PATCH /api/contracts/:contractNo/type`——白名单=
  TRADE_VOCAB.contractTypes（"购销合同"400 拒绝）；更新域 (contract_no, user_id) 请求者
  本人行（UNIQUE 索引对齐，双后端）；修正后按请求者 confirmed 绑定逐文档重建流水
  （parties.ts backfillFlows 模式：refreshedFlows/failed/skipped 透传）+ materializer
  钩子；PATCH /:docId/type 重派生守卫（非空不动）保护人工值不被 docType 级联清洗。
- **T3 前端入口**（09f96ca+ef1c1c2，designer 通道）：ContractTypeCorrection 两态组件
  （待消歧 warning 弱化引导 / 受控态安静入口）挂 EntityDetailDrawer 合同详情；受控六值
  选择禁自由文本；refreshedFlows 按张口径文案；ok:false-on-200 防御消费（评审修复轮）。
- **T4 R16 Neo4j 结案**（7a5bca5）：dev 实证 Neo4j/驱动/网络健康（bolt 双栈探针 80ms、
  钩子路径持续投影、驱动超时自诞生即有）——挂起不可按需复现；根因判定=无查询级超时的
  无界 await + 零进度信号 + 脚本无资源收尾。修复：scripts/lib/watchdog.ts（可测原语）+
  图同步段逐属主 120s 看门狗 + 阶段进度日志 + closeNeo4j/双后端 ctx finally 收尾
  （dry-run 也收尾）。残余：driver.close 对 hung 查询不强制 abort（既定取舍，ops 兜底）。
- **T5 四小项**（cc68ff0）：loadLatest 平局键下沉源函数（SQLite rowid DESC / PG id DESC，
  8 消费方自动继承，wave5 交叉核对转防御性冗余）；gaps resolveByNo byNo 缓存（镜像
  resolveByEdge）；GapsPanel ④负→「预收」/⑥负→「超收」语义角标（R2 亚分归 0 故纯
  amt<0）；tool-inventory query_business 补 page 分页文案。
- **收口验收（dev 实证）**：acceptance 会话 PATCH XYRL-2022-225→销售：200
  refreshedFlows=2、结算单据诚实 skipped(not-whitelisted)；台账 contract_type='销售'；
  大票流水 EF-mub161ok-n6u1（货物流/**out**——Wave 6 卡点 direction-undeterminable
  消除）+ 事实 TF-mub161os-z3jl GoodsDeliveryEvent 自动入谱（ontology_fact_id 回写）。
  **遗留观察**：大票（运输凭证）抽取无吨位字段→事实 qty/amt 空→ALLOCATE_TO 守卫
  （至少其一）跳过→悬空不进勾稽聚合——W2-C 诚实降级与"未挂边悬空口径"已知项；
  轨道衡称重单子单据（携带重量）绑定后即挂边入账。
- **Wave 7 followup（2026-09-21 纵深验收衍生，43e5004 已部署）**：轨道衡称重单
  qtyFields 追加 ['总净重_吨','吨'],['净重_吨','吨']（追加位零扰动既有优先级；总净重优先
  =unit 页区聚合，兄弟 unit 值互异实证非父总计复制；cou-1 评审 APPROVED）+ templateSeed
  hints 两键。dev 全链实证：绑定称重单 DOC-muanykrl-v9kz（凭证 relation，手动绑定路由
  直接 confirmed）→ 同值重 PATCH 触发全绑定重建 → 流水 quantity_ton=1405.79 → 事实
  差分换代（旧 qty 空事实 invalid_at、新事实带量存活）→ 首条 ALLOCATE_TO 边挂台账行
  → tile① 2000.05→594.26 实时变化；⑤应收未收 0→null 为 R19 诚实降级（称重单有量
  无金额，结算/发票单据补齐后回值）。运输凭证 重量(kg)/计费重量(kg)（'(kg)' 后缀不
  在单位推断链）与重量凭证 裸'重量'（单位不明）暂不接，记 Wave 8 候选。
- **乐化数据集收尾（2026-09-21 dev 实证）**：mu… 批 6 张有量称重单批量绑定
  （凭证 relation）后，XYRL-2022-225 名下 8 条流水 total_qty=10,654.9t（合同量 1.0
  万吨，合理超运区间）、8 事实存活、7 条 ALLOCATE_TO 全挂（大票无数量无边=守卫自洽）；
  tile①=−8,654.85 为诚实算术（dev 仅销侧发货在册，无采购侧收货——购侧单据录入后
  自衡）。mt… 旧批称重单（另属主、含 57720 异常值疑 kg 误读）整批不绑，留用户裁决。
- **验收**：每任务 TDD + councillor 评审（T3 一轮修复后全 ADDRESSED）+ oracle 全分支
  终审 GO（零 Critical/Important，红线三条独立验证）；全量 build/lint/test 绿
  （server 1976·42skip / web 143）；合并 main + push（CI/CD 部署 10.10.0.2，sha 4142d01；
  followup 43e5004 同链部署）。
- **Wave 8 候选（oracle triage + 波内发现）**：refreshedFlows 同名异单位契约陷阱
  （review.ts=流水条数 vs contracts.ts=文档张数，优先统一）；修正动作审计痕迹
  （decided_by/telemetry，与 review.ts PATCH /type 一起做）；legacy user_id='' 行 404
  错误码细化；500 errDetail 透出收敛；买受方/出卖方 侧别锚点键集词汇候选；前端
  encodeURIComponent 机会补测；角标 aria；未挂边悬空事实进勾稽口径重估；gaps API
  无按合同下钻（响应仅全局四组+检查项，合同身份只经 sideUnknown 备注浮现且
  fields.contractNo 缺失时回退台账行 id——下钻视图与命名兜底一并评估）；运输凭证
  重量(kg)/计费重量(kg) 的 '(kg)' 后缀单位推断；重量凭证 裸'重量' 键单位语义。

### Wave 6（2026-09-21 火运贯通+闭环补全，5 枚提交已部署 7e66bf4）

- **T1 火运词汇适配**（d08b073）：根因＝运输凭证/重量凭证（模板树中间节点）不在
  FLOW_ADAPTERS；补两行货物流适配（qtyFields 对齐汽运磅单族 7 键，R21 无
  codedDirection）。轨道衡称重单/铁路大票本有适配；货转单因图片凭证锚点路由保护
  有意不改。
- **T2 上传健壮性**（558310a）：根因＝MinIO fGetObject part 临时名 263B > NAME_MAX
  255（ENAMETOOLONG，dev pm2 日志实证）；flattenLocalName 190B 预算仅净化落盘名，
  MinIO key 与可见名不动（红线遵守）。
- **T3+T3b 结算核销写入口**（0994c15+2bc7462）：create_writeoff 增 target 判别
  （缺省 invoice 向后兼容，R22）；settlement 分支 dst 白名单拦截 InvoiceEvent、守恒
  复用 validateAllocationPlan；WriteoffView 全空模式折叠+WS- 批次前缀；工作台提交
  路由三值枚举+指令带 target: settlement。六环验收"关系可登记"最后缺口补上。
- **收口复测**：PATCH 刷新大票（运输凭证×货权转移×XYRL-2022-225）→ skipped 原因
  `direction-undeterminable`——适配器已生效（到达方向判定层），卡在合同侧别：
  deriveContractType 无法消歧抽取值"购销合同" → contract_type 空 → sideUnknown。
  系统诚实跳过并给出理由，行为正确。
- **Wave 7 发现**：购销合同类歧义需要业务消歧 UX（台账合同类型人工修正入口）；
  deriveContractType 与抽取"合同类型"字段的映射链待核；dev Neo4j 脚本端图同步
  挂起诊断（R16 遗留）。


钢材项目实测发现 + 火运数据集复测驱动的修复：
- **56c400f 三连修复**：发货单 formTypes 增 交货确认单/交货单/发运单（分类纠偏）；
  PATCH /type 白名单对齐模板树（allowedDocTypes = 模板活跃 ∪ legacy 八类，DB 失败兜底）；
  bindings 路由补本体 materializer 钩子。
- **b32e548 fieldHints 多键**：收/发货单 fieldHints 覆盖 FLOW_ADAPTERS qtyFields 全键
  （发运数量/数量_吨/数量）。
- **c07c65f 流水重建读最新抽取**：根因＝SQLite 秒精度 created_at 同秒平局使
  loadLatest ORDER BY 取旧行（20/20 实证）；流水重建经 resolveLatestExtraction
  （loadLatest 主取 + listLatestExtractionsByDocIds 确定性口径交叉核对）；附带
  gaps sideOf 购销合同双词歧义 → sideUnknown。
- **复测结论（dev 实证）**：PATCH 发货单 3/3 通过且流水重建为 out/发货单 + 事实自动
  入谱免回填；重抽后 数量_吨=2000.049 精确抽取并贯通 流水→事实→首条 ALLOCATE_TO
  边→勾稽 tile①=2000.05 吨实数；批次拆分器在火运多票 PDF 上自动工作（单据组容器+
  轨道衡称重单子单据）。
- **新发现（Wave 6 候选）**：火运词汇（运输凭证/铁路大票/轨道衡称重单）不在
  FLOW_ADAPTERS → 绑定后无流水；JPG 签收件解析失败（图像管线限制）；合同文件名
  特殊字符上传 500（干净名可绕）；loadLatest 同秒平局的其他消费方待统一确定性口径；
  未挂边的发货事实不进 tile①（悬空口径设计再评估）。



- **T1 聚合+金标准+W3 打磨**（306728e）+ 修复轮（4b49dc3）：`ontology/gaps.ts`
  computeGaps 四组 11 项；金标准数字逐字断言（终审独立复算全对）；R20 双口径（⑦⑨
  非预付付款净/⑧⑩全净）；R18 全局口径 tile①；R19 缺输入 null+missingInputs；侧别
  无法判定"值照算+标注"；EPSILON 近零归零；W3 五打磨（白名单/page/uscc/简介 strip/
  L2 整句）同 commit 清偿。
- **T2 REST**（9d01448）：GET /api/ontology/gaps（挂既有 requireAuth 路由，位于
  /entities/:type 之前无遮蔽），4 用例含端到端数字。
- **T3 前端**（980b833，designer 通道）：GapsPanel（四 tiles/四组折叠/checks/projectNo
  过滤/待登记弱化态），挂 OntologyView 第三 tab 零顶层导航膨胀；5 冒烟测试。
- **终审 5 Minor 全可推迟**：resolveByNo 缓存（数据增长后加）、paymentsNonPrepay 死
  防御注记、mis tile ??0 留意、④⑥ 负值"预收/超收"角标（Wave 5）、page 参数 inventory
  boundary 文案顺手补。
- **验收**：server 1940+ / web 128 全绿；合并 main + push（CI/CD 部署）+ dev 冒烟。

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
