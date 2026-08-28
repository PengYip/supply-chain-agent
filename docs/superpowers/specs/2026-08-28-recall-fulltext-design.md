# recall_documents 全文返回模式（fullText）设计

日期：2026-08-28
状态：已实现（fts/vector/hybrid 全路径 + SQLite/PG 双后端 + 压缩层保留 + 单测/PG 集成测试）
背景：合同 GMNH-JBKZ-20250303HNWH 第三条 3.1/3.2 质量条款多轮 fts/hybrid/vector
检索均未命中，导致煤质报告合规判定失败。根因分析见本文件末尾附录。

## 1. 目标与路线

业务问题："报告值 vs 合同限值"的判定依赖条款原文。规则差异大、难以完全结构化，
采用**语义召回 + Agent 计算**路线：召回负责精准命中条款，计算交给 Agent 输出
结果与过程。

核心改动：recall_documents 从"返回 top-k 片段"升级为**定位文档 + 短文档全文
返回**——命中后若文档足够短，按 chunk_index 顺序拼全量返回。词面不命中这一
问题类别随之消失；跨条款引用（4.3.3 扣款引用第三条限值）天然成立。

## 2. 行为定义

- 触发条件（自动）：命中文档的全部 chunk 合计 `<= FULLTEXT_PER_DOC_CHARS`
  （8,000 字符）且当次命中文档合计 `<= FULLTEXT_TOTAL_CHARS`（16,000 字符）
- 显式参数：`fullText?: boolean`（true 强制全文、false 强制片段；缺省自动）
- 返回形状：`{ mode: 'fullText', documents: [{document_id, doc_type, chars,
  text(按 chunk_index 拼接)}], degradedDocIds: string[] }`；超限文档降级为
  现有片段模式并在 `degradedDocIds` 如实声明
- 每份全文整体 `tagExternal()` 包裹（untrusted external content，注入防御不变）
- 权限与过滤不变：userId 隔离、contractNo 过滤、wantTags 照旧

## 3. 实现清单

1. **双后端全文查询**：SQLite 复用 repositories.ts:1575 的按文档取全量 chunk
   模式（抽出独立函数）；Postgres 新增等价实现（recall 已按 ctx.backend 分流）
2. **recall.ts**：策略路由后增加全文预算判定 + 拼接 + 降级逻辑；工具
   inputSchema 增 `fullText`
3. **契约三件套同步**（不做会被管线静默破坏）：
   - `harness/contextContract.ts` recall_documents 条目：budget 标记与 persist
     说明覆盖 fullText 形状
   - `harness/compression.ts`：fullText 输出不得进 'snippets' 压缩层（matches
     数组假设不成立）
   - `harness/agent.ts` 工具描述：告知模型"短文档返回全文，引用仍带
     document_id；超长文档返回片段"
4. **默认值**：8K/16K 以常量收敛在 recall.ts，超限时行为可预期降级

## 4. 验收标准

1. 真实失败案例回放：对合同 GMNH-JBKZ-20250303HNWH 问"第三条质量指标"——
   fullText 返回全文（该合同 13 chunks ≈ 5K 字符），Agent 能给出挥发分判定
   过程，且对"灰分是否达标"正确回答"合同未约定灰分限值"（而非误报检索失败）
2. 超长文档（构造 > 8K chunk 合计）保持片段模式，degraded 语义正确
3. 多文档命中（主合同 + 补充合同同号）合计超 16K 时按序降级，声明完整
4. 双后端（SQLite 单测 + 既有 PG 集成测试路径）行为一致
5. 全量回归：build -> lint -> test 绿；eval 不回归

## 5. 明确不做（本次范围外）

- hashtag 注入 chunk 正文（污染原文、re-embed 成本，已否决）
- FTS AND-of-unigrams -> OR 语义修复（fullText 已覆盖单文档场景；跨文档枚举
  由 query_contract/graph 承担；如后续出现痛点再立项）
- chunk 标签 backfill（独立小任务，另开）
- 合同模板 props 分层（另一议题，与本设计无依赖）

---

## 附录：根因记录（2026-08-28 排查结论）

生产库（10.10.0.2 Postgres）DOC-mtaylujp-1hiu（上游康庄合同，扫描件，bge-m3
向量化 ok）：13 chunks 全文**不含"灰分"**（含异写"灰份"亦无）。第三条原文仅有
3.1 基准发热量 Qnet.ar>=5300、3.2 干燥无灰基挥发分 28%<=Vdaf<=42%、3.3 全硫
St,ad<=2.5%、3.4 全水分 Mt,ar<=15%；4.3 质量调整价仅考核发热量/全硫/挥发分/
碱金属。**检索器没有失败，是目标信息在合同中不存在**——Agent 的正确行为是如实
回答"合同未约定"，其"检索工具对数字型条款命中不稳定"的自诊断是误诊。

附带发现的真实缺陷（另案处理）：PG FTS `plainto_tsquery` 把 query 全部
unigram 做 AND（postgres-repositories.ts:595），查询含任一文档没有的字/数字
即结构性零命中；该合同 13 chunks 的 tags 全空（全库 75% chunk 未打标）。
