# 入库增强：自动字段抽取 (2a) + 分块语义标签 (chunk-tag)

状态: 设计已批准 (2026-08-14)。两条 lane 并行，无相互依赖。
分支: `omos/ingest-enrich` (worktree `.slim/worktrees/ingest-enrich`, base `ac60b20`)。
背景: MinerU OCR 已修复上线，复核卡数据正常。本设计聚焦检索质量与确定性抽取。

## 总览

两条 lane 都属于「解析时 LLM 增强」，都挂在解析流水线 (`ingestFile` / 未来的 `processDocument`)：
- **Lane A (2a)**: 把 `extractGroundedFields` 移进解析流水线，故障隔离，确定性产出结构化字段 + 待确认关系。替换原本「靠模型自由裁量调 extract_fields」的不确定性。
- **Lane B (chunk-tag)**: 按 docType 的预置标签体系，LLM 批量给每个 chunk 打标签（多标签），存为 `doc_chunk.tags` 元数据，检索时可按标签过滤。

两条 lane 产出**各自独立的新模块 + 测试**（不相交文件），编排器统一接线共享文件（schema / repo / 流水线），避免并发写冲突。

## Lane A — 自动字段抽取 (2a)

详细设计见 ora-1 输出（2026-08-13 关系图谱设计 §2a）。要点：

### 新模块 `apps/server/src/pipeline/autoExtraction.ts` (NEW)
- 导出 `runAutoExtraction({ ctx, docId, blockModel, userId, deps }): Promise<{ status: 'ok'|'skipped'|'failed'; fields?; relationships? }>`
- 内部：调用 `extractGroundedFields(model, blockModel)` → `saveExtraction(...)` 持久化 fields + fieldMeta + proposed_relationships。
- **故障隔离**：try/catch，模型不可用/超时 → 返回 `{status:'skipped'}`（文档仍可检索），不抛错。与 vector/tag 隔离模式一致。
- 60s 超时（Phase 1 同步、无队列）。

### 预置工作（编排器接线）
1. `IngestOptions` 增加 `extraction` deps 字段，从两个调用方 (`ingest_document` 工具 + `/api/files`) 传入。
2. `deriveProposedRelationships` (extraction.ts:112-124) 扩展：从 `合同号` 字段额外产出 `kind:'Contract'` 提案（目前只产 Party/Commodity）。
3. `documents.extraction_status` 列 (pending/ok/skipped/failed)，`setExtractionStatus` repo fn (+Pg twin)。
4. 在 `ingestFile` 流水线（tag 之后）接入 `runAutoExtraction`。

### Lane A 测试 `apps/server/test/pipeline/autoExtraction.test.ts` (NEW)
mock model + ctx/repo：成功→ok+持久化；模型失败→skipped；无字段→ok+空 fields。

## Lane B — 分块语义标签 (chunk-tag)

### 决策
- **存储模型 B**：向量只 embed chunk 原文；标签存为 `doc_chunk.tags` 元数据列；检索 = 先按标签过滤再向量排序。改标签不需重 embed。
- **标签体系 A**：预置配置（每 docType 一套固定标签），LLM 只负责给 chunk 选标签。标签稳定、可复现、可过滤。
- **多标签/chunk**：一个 chunk 可有多个标签。
- **与文档级 `deriveAutoTags` 并存**：文档级（document_tags，喂复核卡，关键词词典）vs chunk 级（检索，LLM 按条款）用途不同，互不替代。

### 新模块 `apps/server/src/pipeline/tag-taxonomy.ts` (NEW)
```ts
export const CHUNK_TAG_TAXONOMY: Record<DocType, string[]> = {
  合同: ['当事人信息','标的物','数量与计量','价格与金额','付款条款','交付与运输',
         '检验与验收','权利义务','违约责任','不可抗力','争议解决','期限与生效','签署信息'],
  发票: ['购方信息','销方信息','票据号','开票日期','品名规格','数量与单位','单价','金额','税额','价税合计'],
  提单: ['托运人','收货人','通知方','船名航次','装货港','卸货港','唛头','货物描述','数量与包装','运费条款','签发信息'],
  装箱单: ['购方/销方','唛头','货物描述','数量','毛重','净重','体积','包装方式','批次号'],
  其他: [],  // 不打标签
};
export function getTaxonomy(docType: DocType): string[] { return CHUNK_TAG_TAXONOMY[docType] ?? []; }
```

### 新模块 `apps/server/src/pipeline/chunkTagging.ts` (NEW)
- 导出 `tagChunks({ chunks, taxonomy, model }): Promise<(string[]|null)[]>`
- **一次批量 LLM 调用**（`generateObject`）：喂入所有 chunk 文本 + taxonomy，schema = `{ chunkIndex: string[] }`，返回每块标签。
- **故障隔离**：失败 → 全部返回 null（检索照常走 FTS5+向量），不抛错。
- taxonomy 为空（如 `其他`）→ 直接返回全 null，跳过 LLM。

### 新模块 `apps/server/src/pipeline/chunkTagFilter.ts` (NEW)
- 导出 `filterChunksByTag(chunks: {tags?:string[]|null}[], wantTags: string[], mode?: 'any'|'all')`
- 纯函数过滤逻辑，供召回路径调用。

### 预置工作（编排器接线）
1. `doc_chunk.tags` 列 (TEXT JSON 数组, nullable)，SQLite guarded-ALTER + Postgres `ADD COLUMN IF NOT EXISTS` + drizzle pgTable。
2. `setChunkTags(ctx, docId, chunkTags[])` + `getChunksByTags(ctx, docId, tags, mode)` repo fn (+Pg twins)。
3. 在 `ingestFile` 流水线（分块之后、向量化之前）接入 `tagChunks`，结果随 `saveChunks` 一起写入。
4. 扩展召回路径（`recall_documents` / vecStore 向量搜索）支持可选 `tags` 过滤参数，调用 `filterChunksByTag`。

### Lane B 测试 `apps/server/test/pipeline/chunkTagging.test.ts` (NEW)
mock model：批量返回多标签；模型失败→全 null；空 taxonomy→全 null（跳过）。

## 共享接线（编排器统一做，lane 完成后）

| 共享文件 | Lane A 改动 | Lane B 改动 |
|---|---|---|
| `client.ts` migrate | `documents.extraction_status` 列 + guarded-ALTER | `doc_chunk.tags` 列 + guarded-ALTER |
| `postgres-schema.ts` | `extraction_status` pgTable 列 | `doc_chunk.tags` pgTable 列 |
| `repositories.ts` (+Pg) | `setExtractionStatus` | `setChunkTags` + `getChunksByTags` |
| `documentEntry.ts` `ingestFile` | 接 `runAutoExtraction` (tag 之后) | 接 `tagChunks` (分块后、向量前) |
| `extraction.ts` | `deriveProposedRelationships` 产 Contract | — |
| `vecStore.ts` / recall | — | `tags` 过滤参数 |

## 验证
每 lane 自带单元测试（mock 依赖）。编排器接线后跑全量 `build → lint → test`（AGENTS.md 要求顺序）。Green 后合并到 main（避开并发 push 窗口），触发 CI + CD。

## 不在本期范围
- **2b 关系图谱**（contracts/contract_versions/entities/entity_edges/resolution_proposals）— 后续 phase。
- **Neo4j 投影** — 可选，后续。
- **Model B（upload=存储、按需解析）** — 已实现暂存于 `feat/background-session-runtime` (026820e)，待完整 Phase 0（前端解析按钮 + agent 引用接线）再回来。
- **回填** — 老文档默认 extraction_status='pending' / tags=null，不自动重处理（opt-in）。
