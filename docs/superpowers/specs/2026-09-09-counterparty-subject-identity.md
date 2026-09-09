# 企业主体身份与层级：Counterparty 主体锚、更名史与父子关系

日期: 2026-09-09
状态: 已评审待实施（排期未定；实施计划见 `docs/superpowers/plans/2026-09-09-counterparty-subject-identity.md`）
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

## 附A. 既有断言/文案需同步的清单（实施时逐项核对）
- `registry.test.ts`：ONTOLOGY_RELATIONS 长度 8→10、连接对 14→17（PARENT_OF 1 对 + DELIVERED_AS 2 对）；`ontologySchemaJson().version` 常量；TradeGoods.attributes 袋约束（键长/条数/标量值）。
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

工具面：`match_goods`（L1）/ `register_goods`（L2，走 insertTradeFact 写入边界 + 审批链）——实施前先登记 tool-inventory.json（五道门）。attributes 受控约束对 Agent 预填同样生效（32 条/标量/键长）。

依赖与顺序：**Phase 1（主体身份+商品属性袋）先行**——没有 attributes 袋，Agent 从单据抽取的品类异构属性无处落。实施规模预估：A 段（两个工具+词表登记，约半天）→ B 段（确认流候选+向量通道，约一天）→ C 段（别名闭环+报告，按需）。
