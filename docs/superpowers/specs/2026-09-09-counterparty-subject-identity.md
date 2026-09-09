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
| 变更操作 | 纯操作语义，无新表新列 | trade_facts 双时间轴既有 |
| Counterparty 附加属性 | v1 全可选 string：`address` 地址 / `bankAccount` 收款账号 / `bankName` 开户行 / `legalRepresentative` 法定代表人 / `registeredCapital` 注册资本 / `establishedDate` 成立日期 / `businessScope` 经营范围 | payload，零 DDL |

附加属性三条设计边界：**(a)** 逐个进注册表（zod optional string），**不开放自由 KV 扩展袋**——台账列生成/主数据表单/搜索/治理全景全靠注册表 schema 驱动，开放袋绕过类型约束与词汇门禁；将来真需要，往 payload 加 optional record 也是向后兼容小改动。**(b)** 属性变更复用 supersede 模型，零新机制——一条事实=主体在时点上的属性快照，地址史/账号史=as-of 当时口径（change 端点整包提交，UI 预填现行值保证合并）。**(c)** `bankAccount` 属敏感信息，前端展示做脱敏（如 `6222****5678`）；多收款账号 v1 不支持（单值主账号），多值需 fieldKind 加 array 支持，勿为此建"账户实体"（docx 模型爆炸警告）。工商信息核心=统一社会信用代码，即 uscc 锚本身。

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
7. **附加属性逐个进注册表，不开自由 KV 袋**：台账列/表单/搜索/治理全景全部注册表驱动（自动生效是本体的核心红利），开放袋会绕过类型约束与词汇门禁；长尾字段逐个补充是低成本操作，自由袋留作将来向后兼容的演进选项。属性变更不单独建机制——supersede 整包快照 + 双时间轴统一承载任意属性的变更史。

## 9. 既有断言/文案需同步的清单（实施时逐项核对）

- `registry.test.ts`：ONTOLOGY_RELATIONS 长度 8→9、连接对 14→15；`ontologySchemaJson().version` 常量。
- `masterData.test / routes` 用例：uscc 必填后既有 Counterparty 用例补 uscc。
- 前端 `businessTypes.ts` EDGE_LABELS：PARENT_OF=「母子公司」。
- 治理全景（governance/ontologySchemaJson 驱动）：9 关系自动出现，无代码改动，验证即可。
- `linkTools.test.ts`：词表断言 +PARENT_OF。

## 10. 风险与取舍

- **存量无 uscc**：显示为独立主体并提示补录，不阻塞读路径；写入侧新事实强制必填。
- **重名企业**：uscc 分流后天然解决；名字仅作展示与搜索。
- **normalizeName 陷阱**：文档图谱 Party 节点仍按归一企业名键（与本体 Counterparty 是两套键空间）——既有现状，本项不改动、不合并（决策 #3 的延伸）。
- **payload 无 schema 演进问题**：uscc 进 payload，旧事实缺字段读侧容忍（fields 渲染空）。
