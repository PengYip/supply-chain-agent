# 企业主体身份与层级：Counterparty 主体锚、更名史与父子关系

日期: 2026-09-09
状态: 已实施（Phase 1，Task 1-8；实施记录见文末 §13；Phase 2 波次一已实施，见 §11 末实施记录；向量召回/确认流候选/别名闭环/未匹配报告留波次二）
上游:
- 《贸易企业全链路数据本体建设落地方案》docx §3（实体定稿）/ §5（关系定稿）/ §6.2（正向/逆向统一语义）
- 本体基座: `docs/superpowers/plans/2026-09-07-ontology-foundation.md`（已落地 main）
- 图谱投影: `docs/superpowers/specs/2026-09-09-ontology-graph-projection.md`（P1-P4 已落地）

## 1. 背景与问题（三缺口）

企业主体（Counterparty，以及广义的对手方台账）信息随时间变更，当前模型有三个缺口：

1. **主体无身份锚**：注册表 Counterparty 仅 `{ name, role }`。名字是随时间变化的属性值却被当作身份键——更名前后的两条事实是两个 TF id，台账无法归一到同一主体；重名企业还会误归一。
2. **变更无入口**：`trade_facts` 自带双时间轴（valid_at/invalid_at/ingested_at）与 as-of 查询，"变更 = 新事实 + 旧事实失效"的机制完全就绪，但产品里只有新增入口（POST /api/ontology/master-data），没有任何变更语义。
3. **父子关系不可表达**：8 种关系 14 连接对中没有任何 Counterparty→Counterparty 的对，写入边界白名单会拒绝母子公司边；穿透/台账/治理全景的词表自然也无此概念。

## 2. 方案总纲（Palantir 九字原则）

- **先对象**：给 Counterparty 加法定身份锚 `uscc`（统一社会信用代码）。主体同一性 = uscc；名字只是主体的一个随时间变化的属性值。
- **后关系**：新增带参关系 `PARENT_OF`（Counterparty→Counterparty），持股比例/备注挂关系 params，不挂节点。
- **再语义**：更名/信息变更 = **同主体新事实 + 旧事实失效**（supersede 模型），零新实体、零新关系类型——as-of 双口径免费获得"当时叫什么/现在叫什么"，完全符合 docx §1.3"不新增实体、属性区分"的约束。

## 3. 数据模型增量（零 DDL）

| 项 | 内容 | 存储 |
|---|---|---|
| Counterparty.uscc | `z.string().min(1).describe('统一社会信用代码(主体归一锚)')` | payload（jsonb/TEXT），随既有列 |
| PARENT_OF 关系 | pairs `Counterparty→Counterparty`；params `{ ratio?: 0-1 持股比例, note?: string }` strict | ontology_edges，既有列 |
| DELIVERED_AS 关系 | pairs `GoodsReceiptEvent→TradeGoods`、`GoodsDeliveryEvent→TradeGoods`；params `{ batch?: string }` strict——收/发货实际交付的商品 SKU（决策 #10：合同只约品类，SKU 随实际收货生长） | ontology_edges，既有列 |
| TRADING_WITH 关系 | pairs `GoodsReceiptEvent→Counterparty`、`GoodsDeliveryEvent→Counterparty`；params `{ role: 上游/下游 }` strict——收/发货事件的交易对手显式化（决策 #11：穿透不再依赖 绑定→合同→对手方 推导链） | ontology_edges，既有列 |
| 变更操作 | 纯操作语义，无新表新列 | trade_facts 双时间轴既有 |
| Counterparty 附加属性 | v1 全可选 string：`address` 地址 / `bankAccount` 收款账号 / `bankName` 开户行 / `legalRepresentative` 法定代表人 / `registeredCapital` 注册资本 / `establishedDate` 成立日期 / `businessScope` 经营范围 | payload，零 DDL |
| TradeGoods.attributes | **受控标量 KV 袋**：`z.record(z.string().min(1), z.union([z.string(), z.number()])).optional()`——键非空≤40 字、值限 string/number、条数上限 32；品类异构属性（钢材牌号/煤炭发热量/化工纯度）免发版登记 | payload，零 DDL |
| TradeGoods 规格语义 | `name`=品名（品类族，如"螺纹钢"/"YJV 电力电缆"——家族聚合键）；`spec`=规范化规格串（v1 人工填经 normalizeSpec 归一；v2 品类模板后由结构化属性键按序派生，canonicalSpec）；SKU 粒度=一条事实一个 品名+规格 组合 | payload，零 DDL |

**规格与目录策略（决策 #9）**——钢材/电缆等品类规格组合成百上千，优雅处理 = 三个决策组合：

1. **粒度落 SKU**：主数据一条 = 一个 品名+规格 组合（结算/对账就是对到规格的，价差大）；品类族聚合 = 按 name 分组呈现，不建"商品家族实体"（模型爆炸警告）。
2. **规格结构化 + 规范串派生**：品类模板（v2）定义有序规格键（螺纹钢→牌号/直径/定尺；电缆→型号/芯数截面/电压等级；电缆愿意整串存一个键也行——拆多细模板定，模型只收标量袋），canonicalSpec=模板键按序 join 的派生串，从根上消灭同义写法；**v1 先落 `normalizeSpec()` 归一函数**（全半角/×x*/大小写/空格，normalizeName 的商品版）治异写。
3. **目录按需生长，不预建**：规格组合成百上千 ≠ 维护量大——主数据是"见过的规格"集合，单据到达 → Phase 2 Agent 匹配（normalizeSpec+向量召回）命中挂接、未命中预填注册走 L2；人工只审批机器拿不准的长尾。

**分对象策略（决策 #7 修订）**：附加属性对两类对象采取不同扩展方式，理由是属性结构本质不同——

- **Counterparty 跨企业同构**（地址/账号/法人家家都有，键稳定）：逐个进注册表（zod optional string），不开放 KV 袋——开放无收益还绕过类型约束。
- **TradeGoods 跨品类异构**（键随品类变）：固定字段必"字段爆炸或大面积空列"（稀疏列问题），开受控标量袋。v1 治理=写入边界软约束（标量/条数/键长）；**v2 品类模板门禁**——注册表加 `GOODS_CATEGORY_TEMPLATES`（品类→允许属性键/类型/单位），写入边界按品类校验键、表单按品类动态渲染，与 COMMODITY_CODES"开放词汇→业务确认收敛"同构（备忘 §7 商品分层本就待业务确认）。
- 两条共同边界：**(a)** 属性变更复用 supersede 模型，零新机制——一条事实=主体在时点上的属性快照，地址史/账号史/属性变更史=as-of 当时口径（change 端点整包提交，UI 预填现行值保证合并）。**(b)** `bankAccount` 属敏感信息，前端展示脱敏（如 `6222****5678`）；多收款账号/多值属性 v1 不支持（单值标量），标量数组为 v2 选项（Neo4j props 兼容，无锁仓）。

**TradeGoods 袋的隐藏技术约束（实施必做）**：Neo4j 节点 props 不接受嵌套对象——`graphSync` 的 payload 整包展平遇到嵌套 record 会投影报错。同步层必须把 attributes 展平为 `attr.<键>` 前缀 props（如 `attr.牌号='Q235B'`），见 plan Task 4b。

明确不做（OUT）：OrgUnit 层级/部门树（另一需求）；对手方识别管线用 uscc 映射（更名后新单据自动归一，属解析管线后续）；RENAME 专有关系（决策 #2）；GraphRAG 主体卡。

## 4. 变更操作语义（supersede）

新增直写端点 `POST /api/ontology/master-data/change`（与 master-data 同哲学：主数据非资金事实，不走 agent 会话、不加 L2 工具）：

```
请求: { entityType: 'Counterparty', prevFactId, payload: {uscc, name, role?}, validAt? }
语义: 事务内两步——
  1) INSERT 新事实 (payload=新值, valid_at=validAt, createdBy='master-data-change')
  2) UPDATE 旧行 SET invalid_at = validAt
前置校验: prev 事实存在且可见 / entityType 一致 / payload.uscc === prev.payload.uscc
  (防跨主体误换代) / prev 未被失效过
as-of 效果: 变更时刻前台账显示旧名，之后显示新名；名称史 = 同 uscc 事实按 valid_at 排列
```

repo 层新增 `supersedeTradeFact(ctx, {...}, userId?)`：双后端事务（SQLite transaction / PG BEGIN-COMMIT），仿 `insertOntologyEdgesBatch` 的"任一步失败整批回滚"。

## 5. 台账归一（projection 呈现层）

- **列表归一**：`listProjectedEntities(Counterparty)` 按 `payload.uscc` 分组——每主体一行：label=现行名，`fields.formerNames=[曾用名...]`（被失效历史的 name），排序按现行事实 ingestedAt；搜索 q 同时命中现名与曾用名。分组外（uscc 缺失的存量行）保持独立行并提示补录。
- **详情**：entity=现行事实；timeline=组内全部事实（含失效，按 valid_at 升序，失效行标"曾用名"）——即名称变更史；**relations=组内全部事实端点的边 union（cap 50）**——更名前建的核销/分摊边不丢。
- 本体 relations/时间线既有 as-of 机制不变；"仅事件实体支持时间切片"的边界文案更新为"事件实体=金额时间线，Counterparty=名称史"。

## 6. 图投影与穿透

- Counterparty 事实节点 props 自动带 uscc（graphSync payload 展平，**零改动**）。
- 事实节点键保持 TF id；**v1 不做图上主体归一**（决策 #3）：归一是台账的呈现职责，穿透保持事实粒度。
- PARENT_OF 经 link_ontology 登记后自动投影；前端 EDGE_LABELS 增中文标签。
- **计数语义变化（消费方须知）**：`GET /api/ontology/counts` 的 Counterparty 计数将从"事实行数"变为"主体数"（归一分组口径），治理全景图该节点数字会变小——属预期口径修正；该路由复用 listProjectedEntities total，无独立 SQL 需改。

## 7. 写入路径与权限

| 操作 | 入口 | 权限 |
|---|---|---|
| PARENT_OF 建边 | link_ontology（词表 +PARENT_OF） | L2 审批（既有链路） |
| 主体变更（更名等） | POST /api/ontology/master-data/change | 直写（同 master-data 先例），createdBy 审计 |
| 新建主体 | POST /api/ontology/master-data（uscc 变必填） | 直写（既有） |
| uscc 补录 | 存量无 uscc 事实=独立主体+提示补录；不做数据迁移（dev 阶段数据量小） | — |

## 8. 设计决策

1. **为什么 uscc，不用内部编码或名字**：统一社会信用代码是法定唯一标识，跨系统可对账；名字随时间变不能当键；内部编码是新造概念（业务后续若有编码体系，加可选字段不与本设计冲突）。v1 只做 `min(1)` 非空，校验位格式校验留后续。
2. **为什么事实失效，不做 RENAMED_FROM 关系**：docx §1.3 约束"不新增实体、属性区分"；as-of 语义免费；RENAMED_FROM 是可从名称史派生的冗余信息，属模型污染。
3. **为什么 v1 不做图上归一**：事实节点 TF id 键体系稳定（EVIDENCE/关系边都锚在其上）；归一是台账呈现职责；图上归一需要 alias 节点机制+桥改造，收益不匹配成本。
4. **为什么变更走 REST 不走 L2 工具**：master-data 既有先例（主数据非资金事实不走会话）；变更是确定性操作，无 LLM 翻译需求，直写端点 + zod strict 即可。
5. **ratio 用 0-1 小数**：与 ALLOCATE_TO.ratio 同构。
6. **timeline 扩展到 Counterparty**：名称史即时间线；详情抽屉"仅事件实体支持时间切片"的空态文案同步更新。
7. **附加属性分对象策略**：Counterparty（同构）逐个进注册表；TradeGoods（异构）开受控标量 KV 袋。台账列/表单/搜索/治理全景的注册表驱动自动化对"注册字段"依然全自动；商品袋是文档化的、有边界的例外——它的治理分两步：v1 写入边界软约束（标量/条数/键长），v2 品类模板硬门禁（业务确认商品分层后，同 COMMODITY_CODES 收敛路径）。属性变更不单独建机制——supersede 整包快照 + 双时间轴统一承载任意属性的变更史。
8. **商品袋不进表单投影，进键值编辑区**：masterDataFormSchemaJson 反射注册字段（fieldKind 不支持 record），attributes 的录入/展示由前端专用键值编辑区与"扩展属性"渲染区承载——这是开放袋的固有代价，限定在一个组件内。
9. **规格落 SKU 粒度 + 规范串派生 + 目录按需生长**：钢材/电缆规格组合成百上千，预建目录不可维护；主数据=品名（家族键）+规范化规格串（v1 normalizeSpec 归一人工输入，v2 品类模板派生 canonicalSpec），目录由单据流按需生长（Phase 2 Agent 匹配/注册），人工只审批长尾。**品类模板键类型 v2 为三型：string / number / enum（值域=注册表开放词汇，业务维护）**——枚举型键覆盖品类内分类学维度：冻品牛肉的部位（牛腩/牛腱/西冷/眼肉/上脑/T骨…）、级别、分割方式，与钢材牌号、电缆型号同构，新增品类=加一份模板配置、模型零改动。冻品示例：name=冻牛肉，模板键={部位, 级别, 分割方式, 产地, 厂号, 包装}；**厂号（屠宰场注册号，如巴西 SIF）进 attributes、到货批次进 DELIVERED_AS.batch——构成收货事件→SKU→厂号批次的食安追溯链**（冻品贸易合规硬需求，设计零成本顺带覆盖）。
10. **合同不约定规格的场景（品类/SKU 双层挂接）**：钢材/电缆合同常只约品类与约数（"螺纹钢约5000吨，规格以实际收货为准"）——合同签订零主数据动作，**SKU 的诞生时点=第一次实际收货**；履约与商品的归属由 `DELIVERED_AS` 带参关系承载（收/发货事件→TradeGoods），品类锚 v1=TradeGoods.name 家族键 + 合同 fields 品种字段（归一化聚合），v2 模板键转正。单据源收货（Document 表示）v1 不挂 SKU（ontology_edges 端点限 11 实体），Phase 2"收货确认→自动登记收货事实"后自然并入。台账呈现：合同详情按 SKU 分组小计收发数量。对账分层：合同级守恒 R1 照旧（约数+容差，SQL 对账桥），SKU 级价差结算留 v2。
11. **物流/货权双轴（上游发→我收→我发→下游收）**：单租户口径下我方只记自己一侧的物理动作，事件实体保持 2 个（收/发货）不扩成 4 个——上游发货、下游收货以**对端凭证单据**表达（上游发货单/下游签收回单，EVIDENCE 挂接）。四段链=两次移动，每段=我方事件+对端凭证。补三件：**(a)** `TRADING_WITH` 关系显式化事件交易对手（穿透不依赖推导链）；**(b)** 收/发货事件 payload 增 `titleTransfer` 货权口径（发货即转/签收转/验收转/到岸转，v1 开放文本 v2 收敛枚举）与可选 `titleTransferAt` 时点——**货权与物理解耦**（发货≠免责、在途≠无货权，发货即转的在途也属我方存货口径）；**(c)** "在途"=有上游发货凭证而无对应我方收货事件，台账/穿透可直接查询。纯货转单（货物不动、堆场转货权）v1 以 titleTransferAt 近似，业务高频时 v2 注册表增补货转事件类型（docx §2.2"货转"的本源，单文件扩展）。payload 新增字段 counterpartyId/titleTransfer 经 create_trade_event inputSchema 同步透出（toolOntologyMap 门禁：实体字段自动入词汇）。

## 附A. 既有断言/文案需同步的清单（实施时逐项核对）
- `registry.test.ts`：ONTOLOGY_RELATIONS 长度 8→11、连接对 14→19（PARENT_OF 1 对 + DELIVERED_AS 2 对 + TRADING_WITH 2 对）；`ontologySchemaJson().version` 常量；TradeGoods.attributes 袋约束（键长/条数/标量值）。
- `eventTools.test.ts`：create_trade_event inputSchema 增 counterpartyId/titleTransfer（可选，透传 payload——实体 schema 同步扩展后 gate 通过）。
- `masterData.test / routes` 用例：uscc 必填后既有 Counterparty 用例补 uscc；TradeGoods 用例带 attributes（含超限/非标量拒绝负例）。
- `graphSync` 展平：attributes 嵌套 record → `attr.<键>` props（Neo4j props 不收嵌套对象）；对 Counterparty/事件 payload 无 attributes 的路径零影响。
- 前端 `businessTypes.ts` EDGE_LABELS：PARENT_OF=「母子公司」、DELIVERED_AS=「实际交付」。
- 治理全景（governance/ontologySchemaJson 驱动）：10 关系自动出现，无代码改动，验证即可。
- `linkTools.test.ts`：词表断言 +PARENT_OF。

## 10. 风险与取舍

- **存量无 uscc**：显示为独立主体并提示补录，不阻塞读路径；写入侧新事实强制必填。
- **重名企业**：uscc 分流后天然解决；名字仅作展示与搜索。
- **normalizeName 陷阱**：文档图谱 Party 节点仍按归一企业名键（与本体 Counterparty 是两套键空间）——既有现状，本项不改动、不合并（决策 #3 的延伸）。
- **payload 无 schema 演进问题**：uscc/attributes 进 payload，旧事实缺字段读侧容忍（fields 渲染空）。
- **商品袋键名失控（v1 无模板期）**：自由键可能不规范（"牌号"vs"材质牌号"）。缓解：登记表单键输入给常用键建议；v2 品类模板上线后写入侧拒模板外新键，历史数据走 supersede 换代收敛。

## 11. 后续路线（Phase 2，本期不实施）：Agent 辅助商品主数据匹配/注册

人工维护商品主数据工作量过大；文档管线已抽取品名/规格，pgvector 召回+reranker、候选工作台模式、L2 审批链、attributes 袋全部就位。设计原则：**匹配优先、注册兜底、注册必过人工**。

三档动作（风险/自动化递增）：
1. **匹配（L1 只读）**：单据商品描述 → 主数据检索打分，四通道从硬到软：商品码精确 → 归一键（normalizeSpec(品名)+normalizeSpec(规格)，决策 #9）精确 → 向量召回（pgvector 嵌入"品名+规格+类别"+ reranker，解决"热轧卷板 vs 热轧板卷"异写）→ LLM 语义判定兜底（只产生候选提议）。输出候选+分数+证据字段。
2. **关联（低风险写，软门控）**：高置信候选自动把单据/文档图节点挂到既有 TradeGoods，记 confidence + confirmationSource='auto'。
3. **注册（SSOT 写，L2 必审）**：无候选 → `register_goods` L2 工具，name/spec/commodityCode/attributes 全部从单据抽取预填 → 审批中心批准 → insertTradeFact 写入边界。错误主数据会全链扩散，这道人工门不能省。

触发点：① 文档确认流自动挂候选（绑定工作台"候选+确认"交互模式复用）；② 对话（"把这批收货单上的商品匹配到主数据"，`match_goods` L1 + `register_goods` L2）；③ 定期物化任务出"未匹配商品清单"报告。

反馈闭环：人工确认→别名落 attributes（匹配率随积累上升）；纠正→负样本。冷启动期"提议预填"占大头（人工从敲字段降为点批准），全自动注册比例随别名/向量积累上升。

工具面：`match_goods`（L1）/ `register_goods`（L2，走 insertTradeFact 写入边界 + 审批链）——attributes 受控约束对 Agent 预填同样生效（32 条/标量/键长）。**实施计划：`plans/2026-09-10-four-flows-wave1.md`（波次一：本节 Task A1/A2 + 决策 #11 + 恒等式自洽；向量召回/确认流候选/别名闭环留波次二）。**

依赖与顺序：**Phase 1（主体身份+商品属性袋）先行**——没有 attributes 袋，Agent 从单据抽取的品类异构属性无处落。实施规模预估：A 段（两个工具+词表登记，约半天）→ B 段（确认流候选+向量通道，约一天）→ C 段（别名闭环+报告，按需）。

### 11.1 实施记录（波次一，2026-09-10）

分支 `PengYip/four-flows-wave1` 逐任务 TDD 落地（plan: `plans/2026-09-10-four-flows-wave1.md`），零 DDL。

| 交付 | 落点 |
|---|---|
| 决策 #11：TRADING_WITH 关系（第 11 关系/19 对，params `{role: 上游/下游}` strict）+ 收/发货 payload 可选 `counterpartyId`/`titleTransfer`（经 create_trade_event inputSchema 透传，不解构溯源列）；link_ontology 词表 8→9（+TRADING_WITH，inputSchema 增 role）；web EDGE_LABELS「交易对手」灰虚线 | `ontology/index.ts`（schema version 2026-09-10）、`ontology/eventTools.ts`、`ontology/linkTools.ts`、`apps/web/src/components/graph/businessTypes.ts` |
| §14 backlog#1：confirm_settlement 算术自洽硬校验（`totalAmount ≈ settledQuantity × basePrice + Σadjustments`，容差 0.005；basePrice 缺省跳过）——**只拒绝不改写**，不满足返回 `{status:'invalid', detail 含差异值}` 零落库 | `pipeline/tools/settlementTools.ts` |
| §11 匹配优先：`match_goods` L1——三通道打分（商品码精确 1.0 / 归一键精确 0.95 / 名称双向包含 0.6），候选去重按分排序 cap 10，suggestion≥0.95→match 否则→register；纯 SQL 检索现行（未失效）TradeGoods 事实，用户隔离，无 Neo4j/向量依赖 | `ontology/goodsMatch.ts`（新增） |
| §11 注册兜底：`register_goods` L2（needsApproval）——写入必经 insertTradeFact（createdBy='register_goods'，attributes 受控袋对 Agent 预填同样生效），缺商品码以归一键合成占位码（goodsSeed 同款），归一键重复仍落库但 detail 软提示"疑似重复"（重名不同规格合法），图投影 fire-and-forget | `ontology/goodsRegisterTool.ts`（新增） |
| 五道门登记：tool-inventory version 2026-09-10 + **场景帽 12→14**（结算域 +2 工具的显式决策）+ 新分组「商品主数据」；roleToolRegistry 挂载（trader 23→25）；permissionGate（L1/L2）；contextContract 两契约（match_goods 读 L1 persist business；register_goods 同 create_trade_event 模式）；scenarios：settlement +2、qa +match_goods；toolOntologyMap 映射两工具（词汇门禁：字段∈TradeGoods 实体 ∪ 双时间轴共享词汇） | `docs/tool-inventory.json`、`harness/{roleToolRegistry,permissionGate,contextContract,scenarios}.ts`、`ontology/toolOntologyMap.ts` |

验证：仓库根 build/lint/test 全绿（server 252 文件 1860 用例、web 18 文件 117 用例）。

### 11.2 dev 冒烟（10.10.0.2，sha 31dd8e8）与冒烟驱动的 Phase 1 缺陷修复

验收路径逐项通过：对话 match_goods（三通道无候选，suggestion=register）→ register_goods 提交（L2 审批单 → 批准 → 落 trade_facts，createdBy='register_goods'，attributes 受控袋透传，缺商品码以归一键合成占位码）→ 再 match_goods（0.95 归一键精确命中，suggestion=match）→ 台账商品 payload 含 attributes → 穿透节点 `attr.<键>` 展平核对（attr.牌号/attr.厚度，name=TF id）。

场景路由边界确认（非缺陷）：settlement 收窄按"当前用户消息"检测，含「对账/结算」词汇的回合才可见 register_goods；无词汇回合模型按设计降级（不可见 → escalate_to_human 工单，不猜测）。

冒烟暴露并已修复（随波次一合入）：

1. **graphSync payload.name 覆盖 MERGE 键（Phase 1 缺陷）**：TradeGoods/Counterparty/OrgUnit 的 payload 含 `name` 键，展平时随 props 回写，`ON CREATE SET` 把节点 MERGE 键 `name=TF id`（spec §2.1）覆盖成品名/企业名——prune 按 TF id keep 集找不到节点，每次同步误删新建节点（商品/对手方事实节点在图上永不落地），且同 payload name 的多事实（重名/换代史）触发 name 唯一约束冲突（2026-09-09 冒烟的 partial projection 报错同根因）。修复：展平时把 `payload.name` 与 attributes 一并摘出；测试断言同步修正。

冒烟数据（PG 事实/会话/审批单/用户 + Neo4j 节点）已清理。

**波次二遗留（届时另立计划）**：向量召回通道（商品嵌入+pgvector 检索+reranker，解决"热轧卷板 vs 热轧板卷"异写）；确认流候选自动挂接（绑定工作台"候选+确认"模式）；别名反馈闭环（人工确认→别名落 attributes）；未匹配商品定期报告。

## 12. 冷启动种子策略（Phase 1 落地时执行）

要种，但只种**两层薄种子**，不种全量规格目录（按需生长原则不变；无交易历史的 SKU 在台账/穿透里是噪音）。种子的价值：匹配精确通道冷启动命中率、家族键归一对照表、品类模板（v2）挂载点、验收演示基线。

| 层 | 内容 | 是否必种 |
|---|---|---|
| 品类族层 | 高频品类 name 级条目（螺纹钢/热轧卷板/电力电缆/冻牛肉/动力煤…，10-30 条），带 unit 与已知 commodityCode | **必种，业务确认名单**（= COMMODITY_CODES 收敛路径第一步） |
| 高频 SKU 层 | 当前业务反复出现的具体规格（如 HRB400E Φ12/Φ14/Φ16/Φ18/Φ20/Φ25） | 可选，业务提供清单；没有则首单收货走"注册兜底+L2"自动生长 |

机制（沿仓库既有惯例）：

- 清单文件（JSON，业务确认）→ 种子脚本 runner，**仿 `backfill:embeddings` 先 `--dry-run` 再实跑**
- 写入经 `insertTradeFact` 写入边界（zod 校验不绕过），`createdBy='seed'` 可识别；先例：`templateSeed.ts`（模板种子 managed-wins）与 trade_facts 早期种子写入方
- 幂等：`normalizeSpec(name)+normalizeSpec(spec)` 去重，重复执行不增殖
- 纠错：错误种子走 supersede 失效（换代模型天然覆盖），不删行
- v2 衔接：品类族条目即品类模板挂载点

清单骨架示例：

```json
[
  {"name": "螺纹钢", "unit": "吨", "attributes": {"品类族": "建筑钢材"}},
  {"name": "螺纹钢", "spec": "HRB400E Φ12mm 9m定尺", "unit": "吨",
   "attributes": {"牌号": "HRB400E", "直径": "12mm", "定尺": "9m"}},
  {"name": "冻牛肉", "unit": "公斤", "attributes": {"品类族": "冻品"}},
  {"name": "冻牛肉", "spec": "巴西 牛腩 冷分割 20kg/箱", "unit": "公斤",
   "attributes": {"部位": "牛腩", "产地": "巴西", "包装": "20kg/箱"}}
]
```

## 13. 实施记录（Phase 1，2026-09-09）

分支 `PengYip/counterparty-subject-identity` 逐任务 TDD 落地，全程零 DDL、零新工具、零 tool-inventory 变更。

| Task | 交付 | 关键落点 |
|---|---|---|
| 1 | 注册表扩展 + normalizeSpec | `ontology/index.ts`：Counterparty uscc 首字段必填 + 7 个可选附加属性；TradeGoods.attributes 受控袋（键≤40 字/标量值/≤32 条 superRefine）；PARENT_OF/DELIVERED_AS 关系（10 类型/17 对）；schema version 2026-09-09。`ontology/goodsSpec.ts` normalizeSpec（NFKC/去空白/乘号族统一/小写）。`masterData.ts` 输入 schema 增字段；attributes 不进表单投影（决策 #8，跳过 record） |
| 2 | supersedeTradeFact | `ontology/repo.ts`：INSERT 新事实 + UPDATE 旧行 invalid_at 双后端事务（PG pool.connect BEGIN/COMMIT；SQLite transaction）；兜底校验 prev 可见/entityType 一致/uscc 一致/未失效过；失效更新未命中整批回滚 |
| 3 | POST /master-data/change | `routes/ontology.ts` + `masterData.ts` ChangeMasterDataInputSchema（payload 复用注册表 Counterparty strict schema，整包提交）；supersede 前置校验 400 / prev 不存在 404；createdBy='master-data-change'。`lib/zodFieldErrors.ts` 多段路径取叶子字段名 |
| 4 | link_ontology 词表 | LINKABLE_RELATIONS 6→8（+PARENT_OF/DELIVERED_AS），描述补母子公司/收发挂 SKU 话术与 ratio/note/batch 参数；contextContract/permissionGate/scenarios/roleToolRegistry 仅登记工具名（既有），零改动；toolOntologyMap/toolInventory 测试通过（工具面零变化） |
| 4b | 图投影展平 | `graphSync.ts`：payload.attributes 拆为 `attr.<键>` 标量 props（Neo4j props 不收嵌套对象）；无袋事实 props 零变化；边 props（ontology_edges.params）恒标量不受影响 |
| 5 | 台账归一投影 | `projection.ts`：collectEntities('Counterparty') 按 uscc 内存分组（无 uscc 存量行独立分组），现行事实作行 + fields.formerNames + meta.uscc；详情 entity=现行事实、timeline=组内名称史（invalidAt 可辨）、relations=组内事实端点边 union（cap 50）；ProjectedEntity 增 invalidAt；repo 增 listTradeFactHistory（json_extract / payload->> 双写法）；counts 路由 Counterparty 计数随归一口径（spec §6 预期修正） |
| 6 | 前端呈现 | 台账 Counterparty 行副标题曾用名 + 行级「变更」入口；MasterDataDrawer change 模式（预填现行值、uscc 只读、bankAccount 掩码回显未改还原原值、生效时间可选）与 TradeGoods 键值编辑区（增删行/32 条截停/重复键拦截）；详情抽屉时间线「曾用名」徽标 + 「扩展属性」键值区 + 空态文案更新（事件实体=金额时间线，交易对手=名称史）；EDGE_LABELS PARENT_OF=母子公司 / DELIVERED_AS=实际交付（灰虚线）；`lib/mask.ts` 统一脱敏 helper |
| 8 | 冷启动种子 | `src/ontology/goodsSeed.ts` + `scripts/seed-goods.ts`（--file/--dry-run，沿 backfill 惯例挂 `seed:goods`）+ `goods-seed.example.json` 骨架；幂等键 normalizeSpec(name)+normalizeSpec(spec)；写入经 insertTradeFact（createdBy='seed'，共享域）；缺 commodityCode 以归一键合成占位码（v1 开放词汇）；正式名单待业务确认 |

验证：仓库根 build / lint / test 全绿（server 249 文件 1836 用例、web 18 文件 117 用例）；本地种子 CLI 三连冒烟（dry-run → 实跑 → 重跑 skipped=7）通过。

### 13.1 dev 冒烟（10.10.0.2，sha 3b4372b）与冒烟驱动的两处修复

验收路径逐项通过：主数据登记（缺 uscc 400；Counterparty/TradeGoods+attributes 200）→ 对话 link_ontology 建 PARENT_OF（L2 审批单→批准→落边，params {ratio:0.6, note:控股}）→ change 端点更名（201；跨主体 400；prev 不存在 404；二次换代 400）→ 台账归一（2 主体组、label=现行名、formerNames=[旧名]、meta.uscc）→ 搜索旧名命中组 → 详情（entity=现行事实、timeline 两行失效行可辨、relations=组内 union 含更名前的 PARENT_OF、netAmount=null）→ counts 口径（Counterparty=2 主体数而非 4 事实行）。

冒烟暴露并已修复（均合入本分支）：

1. **场景路由回归（harness，非本体模块，P3 引入）**：`agent.ts` 在追加 role='user' 的 `<agent_status>` 快照后才做场景检测，快照文本恒含「复核」命中 ENTRY_RE——对话每回合被收窄到 entry 工具集，settlement 写工具（link_ontology/create_trade_event/create_writeoff/create_offset/manage_quota/confirm_settlement）与 qa 读工具（graph_query 等）自 P3 部署起在对话路径永不可见（模型只能升级工单）。修复：检测输入改回真实对话尾部 `lastUserText(messages)`；回归测试 `scenarioDetection.regression.test.ts`（快照注入不影响 settlement/entry 路由）。
2. **supersedeTradeFact PG 分支**：UPDATE 语句 `?` 占位未转 `$n` 透传 node-postgres → 语法错误 500（SQLite 测试无法暴露）。修复 + `postgres.integration.test.ts` 增 ontology supersede PG lane（事务化换代/uscc 防线，唯一 uscc 保证跨跑幂等）；顺带补 P3 漏同步的 trade_facts 列断言（document_id）。

冒烟数据（e2e 账号下 4 条事实/1 条边/3 审批单/2 会话/1 登录态）已清理。

## 13. Phase 3 提案：CargoLot 批次对象与四流分离（对齐方法论 §4.2，本期不实施）

上游文档《供应链贸易智能化与风控的本体方法论》§4.2：真实贸易链 5-6 主体（矿方 A→贸易商 B(我方)→贸易商 C→钢厂 D），同一船 3 万吨矿，物理/货权/合同/资金/票据五张拓扑各不相同；多对多靠"分配桥边+守恒校验"。

**四流对照现状**：资金拓扑（Payment/Collection+WRITE_OFF/OFFSET_SETTLE+TRADING_WITH）✅；票据拓扑（Invoice+CORRESPONDS_TO/REVERSE_ORIGIN）✅；合同拓扑（correlates 链+变长穿透）✅；货权拓扑（收发货事件+titleTransfer+DELIVERED_AS）◐ 待 Phase 1；**批次拓扑 ❌——批次目前只是 DELIVERED_AS.batch 字符串参数，不是对象**。

**缺口补法（仍零 DDL，注册表扩展）**：

- 新实体 `CargoLot`（第 12 实体）：`{ lotNo, goodsId(锚 TradeGoods), qty, unit, category?, vessel?, location?, status, parentLotId? }`——拆分保留原批次、新批次带父缘（方法论 §4.1 SplitCargoLot 模式）；存 trade_facts（entity_type=CargoLot）
- 转移边 `TRANSFER_LOT`（CargoLot→CargoLot）：params `{ qty, 对价合同, fromParty, toParty }` strict——货转单/放货单作 EVIDENCE 凭证挂边；收/发货事件经 DELIVERED_AS 反挂批次
- 守恒挂桥（对账桥新增规则）：批次流出合计 ≤ 流入合计，超限即异常——方法论 §4.2"守恒规则挂在桥上"
- 分摊/核销既有能力对齐：支付分摊边（WRITE_OFF 多对多+部分）✅、发票核销边 ✅、票↔批次粒度关联随批次对象补齐

**证据边界（必须写明的口径）**：五张拓扑在 B 系统中的完整度取决于 B 持有的证据——A→B、B→C 两段合同与 B 侧款/票/权事件天然在系统内；**C→D 段不可见**，除非 C 的合同/单据作为凭证上传（背靠背实务中货转单链条通常经手我方）。这与方法论"source-backed 映射"原则一致：每条流记到证据所及，链外段以对手方主数据补齐，不虚构。

**风控价值（方法论 §4.3）**：四流显式建模后，融资性/循环贸易（闭环结构+货权流与资金流拓扑背离）从"人肉对账发现不了"变为"可计算的图查询"——correlates/TRADING_WITH 图上找环 + 四流拓扑比对；专项风控查询与告警属 Phase 3 交付物。

**依赖与顺序**：Phase 1（主体身份+DELIVERED_AS/titleTransfer）先行；Phase 2（Agent 商品匹配）受益于批次锚定；Phase 3 独立成 PR，估期 1-2 天（注册表+对账桥规则+台账/穿透呈现）。

## 14. 方法论全文对照与 backlog（2026-09-10 全文核对）

上游：《供应链贸易智能化与风控的本体方法论：Palantir 对标与我们的演进路线（讨论稿）》飞书文档全文核对。

**文档 §6 缺口表逐项现状**（文档写作早于实现，两项已补）：

| 文档缺口 | 现状 |
|---|---|
| 主体节点显式化（"对手方目前是台账文本字段"） | ✅ 已补：Counterparty 实体 + uscc 锚 + master-data/change + PARENT_OF（Phase 1 已上线） |
| 核销/分摊桥边（多对多无处安放） | ✅ 已补：WRITE_OFF/OFFSET_SETTLE 多对多+部分+分批+整单守恒（核销工作台+link_ontology） |
| 批次实体（货物连续身份） | ◐ Phase 3 CargoLot（§13）；**补遗：批次四态状态机（在途/已入库/已发运下游/已签收）+ 证据门槛迁移**（状态迁移必须持 confirmed 实重/质检凭证，L2 动作而非裸改字段）此前 §13 未细化，纳入 Phase 3 |
| 守恒校验查询 | ◐ 核销余额/R1-R3 已有；批次流出≤流入、四流拓扑背离审计归 Phase 3 |

**新增 backlog（文档覆盖、此前 spec 未登记，按文档 §7"需求触发"原则排期）**：

1. **恒等式交叉验证 + 自洽报警**（文档 §10.3/10.5 标注"立即可做"）：聚合结果破恒等式即报警拒答；confirm_settlement 增算术自洽硬校验（只拒绝不改写）——优先级最高的小增量
2. **付款 L3 硬门禁 create_payment**：Agent 生成付款提议 → 预检（结算已确认/发票已收/资金计划内）→ 工单 → 人工批准才执行；L3 首个注册工具（当前付款仅 L2 事件登记，无付款执行动作）
3. **计量差守恒告警**：流入 vs 实收水尺差对照合同短溢装条款（±3%），超限主动告警+索赔流程建议——对账桥规则，随 Phase 3
4. **货权质押 PledgeCargoLot**（L2：未质押 ✓ / 质押量≤可售量 ✓ 前置校验，供应链金融同步）——Phase 3+
5. **合同关闭动作**（前置校验：结算完成/发票齐/敞口=0，生成完结记录）——Phase 3+
6. **批次配比成本/毛利 Function**（单位成本=采购结算÷结算量；配比成本=单位成本×批次配比量）——依赖 Phase 3 批次实体
7. **资金周转天数 Function**（付款/收款事件按日期梯形累计净占用；文档自注"付款单未物化需补"——PaymentEvent validAt 已具备日期）——Phase 3+
8. **对账面板 + 三级钻取**（指标数字→构成明细→原始凭证；毛利率/结清/未开票/资金占用四栏）——前端产品形态
9. ERP 实体同步映射（文档幕1"若 ERP 已有则同步映射"）——当前无 ERP 集成，OUT/待业务接入

**架构注意事项（差异核对中发现）**：背靠背链 correlates/relates/amends 走 graph_links 体系（图谱投影），本体四流关系走 ontology_edges 体系——**两套关系空间并存**；Phase 3 货权链设计时需统一评估（环检测查询会横跨两套空间）。文档幕1 的"link_entities 建背靠背边"对应前者，四流桥边对应后者。

**总原则对齐确认**：文档 §7"增量落在现有工具面与 Neo4j，不动数据库 schema 骨架"与本 spec 全部三个 Phase 的零 DDL 设计完全一致；文档 §6"已有"清单（六向流水不双计/绑定溯源/L1-L2-L3/清单 SSOT/结算双工具）经核对全部仍然成立。

## 15. 对账面板：合同四流泳道可视化（产品设计，待排期）

需求：紧凑可视化面板，展现当前合同的 货/权/款/票 在 上游/我方/下游 各节点的进度与状态——即方法论 §10.4"对账面板与三级钻取"的泳道化产品形态。

**布局（紧凑，整块高约 300px，嵌合同详情抽屉首屏）**：四条泳道共享一条节点轴（上游 → 在途 → 我方 → 下游）——

- 货泳道：上游发运 → 在途 → 我方收货(实称) → 库存/拆分 → 我方发货 → 下游签收；点标注数量（吨/米）与日期；数据源 bindings + execution_flows（预告/实重不双计）✅ 已上线
- 权泳道：货权归属色带（上游/我方/下游）+ 转移时点 ✕（titleTransfer 口径 + 货转单 EVIDENCE）——依赖 Phase 1.5（titleTransfer），上线前按合同交货条款渲染"约定口径"并标注待货权凭证
- 款泳道：付出（预付/进度/尾款）+ 收到 + 净占用（先收后付为负）——PaymentEvent/CollectionEvent
- 票泳道：进项（已收/未收，金额）+ 销项（已开/未开）+ 核销状态——InvoiceEvent + WRITE_OFF
- 告警条：超合同发货期 / 水尺差超短溢装容差 / 票款不齐——红圈同步标在泳道节点上（"上游发货事件"测试对话中的人工升级，未来即此处的自动告警）

状态点语义：实心=已完成 / 琥珀=进行中 / 空心=未发生 / 红圈=异常。**三级钻取**：点状态点 → 明细抽屉（逐笔构成）→ 原始凭证（凭证 id 直达）——方法论 §10.4"每个数字三步点到证据"。

**后端**：`GET /api/contracts/:contractNo/flow-panel`（L1 只读聚合）——SQL 聚合 bindings/execution_flows/settlement_records/trade_facts + ontology_edges 核销 completeness，输出四泳道里程碑数组 + alerts + netPosition（已付/已收/净占用、进/销项）。

**两个前置**：① PaymentEvent/CollectionEvent/InvoiceEvent payload 增可选 `contractNo`（SHARED_TOOL_FIELD_NAMES 已含，注册表+create_trade_event inputSchema 小改，登记时带上即可按合同聚合款/票）；② 权泳道依赖 Phase 1.5 titleTransfer。背靠背对偶合同以 correlates 相互切换（chip）。

**分期**：面板 v1 = 货/款/票三泳道 + 告警条（前置①半天 + 聚合端点 + 面板组件约 1-1.5 天，建议并入 four-flows-wave1 分支实施）；权泳道随 Phase 1.5 自动点亮。bankAccount 等敏感属性展示沿用 `lib/mask.ts` 脱敏。
