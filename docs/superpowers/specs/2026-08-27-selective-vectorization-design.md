# 设计：单据类型驱动的选择性向量化入库

日期：2026-08-27
状态：已评审通过（设计口述稿经用户确认）

## 背景与问题

单据录入解析后，五维复核卡展示「向量化入库状态」。当前三条录入路径对**所有**类型
的单据一律尝试向量嵌入：

1. 图片凭证路径 `runVoucherPipeline`（`apps/server/src/pipeline/tools/documentEntry.ts` ~L365）
2. 文本/PDF 直接录入 `ingestFile`（同文件 ~L637）
3. 上传后处理 `processDocument`（同文件 ~L1018）

实际业务中只有**合同与立项文件**需要语义召回；运输凭证等履约类单据走向量化既浪费
嵌入调用（分块多的文档一次调大量 token），也会把无关类型混入语义检索空间。个案：
某运输凭证 6 分块在 SiliconFlow `/v1/embeddings`（BAAI/bge-m3）上整批返回 400。

## 决策（用户确认）

| 议题 | 决策 |
|---|---|
| 向量化范围 | 按粗类子树判定：模板树上根为「合同」或「立项书」的类型全部向量化（含补充合同等细类） |
| 五维卡纠错后行为 | 纠错时回溯：改为可向量化类型 → 补跑嵌入入库；改为不可向量化 → 清除已有向量 |
| 实现形态 | 方案 A：策略谓词独立成模块，三处录入点各加一行门禁 |
| 空块防御 | 嵌入前过滤空文本 chunk（防单个空串导致整批 embeddings 400） |

## 详细设计

### 1. 策略模块 `pipeline/vectorPolicy.ts`

```ts
export const VECTORIZE_ROOT_TYPES = ['合同', '立项书'] as const;
export const SKIP_REASON_NOT_VECTORIZABLE = '仅合同/立项书类型向量化入库';
export function isVectorizableDocType(docType: string, types: TemplateTypeRow[]): boolean;
```

- 用 `dt-${name}` 在模板类型表中定位行，沿 `parentId` 上溯至无父行的顶层粗类；
  粗类 ∈ VECTORIZE_ROOT_TYPES 才允许向量化。
- 类型不在模板表（离线/测试环境）：回退字面匹配 docType 是否等于两个根名。
- aliasOf/isActive 不参与判定：历史合法值仍按其树位置归类。
- 判定点前置保证：三条录入路径的分类均发生在向量化之前，docType 已定。

### 2. 录入门禁（documentEntry.ts 三处）

各嵌入块开头先判 `isVectorizableDocType`；不可向量化时不构造 embedder 调用，
直接落 `{status:'skipped', mode:embedder.kind, chunkCount:n, reason:SKIP_REASON}`。

不变量：chunk 落库、FTS5 关键词召回、Lane B 分块标签、自动抽取、绑定建议、
parse_status 均不受影响——只省掉嵌入这一步。

### 3. 空文本块防御

三处嵌入前把 `[{chunkRowId, text}]` 中 `text.trim()` 为空的项过滤后再 embed；
过滤后全空则落 `{status:'skipped', reason:'无有效文本块'}`，不发起请求。
保存的 chunk 行本身不删（FTS5 无损），只影响嵌入输入。

### 4. 纠错回溯

新基础设施：

- `repositories.ts`：`listChunksByDocument(ctx, docId): Array<{id, text}>`
  （SQLite prepared + PG 两实现）。
- `vecStore.ts`：`clearChunkVectorsForDocument(ctx, docId)`
  （SQLite：`DELETE FROM doc_chunk_vec WHERE id IN (SELECT id FROM doc_chunk WHERE document_id=?)`；
  PG：`UPDATE doc_chunk SET embedding = NULL WHERE document_id = $1`）。

新模块 `pipeline/vectorReconcile.ts`：

```
reconcileVectorizationAfterDocTypeChange(ctx, docId, newDocType, embedder?, userId?)
  -> Promise<DocumentVectorization>
```

- 不可向量化 → `clearChunkVectorsForDocument` + meta `{skipped, reason:SKIP_REASON}`。
- 可向量化且 embedder 存在且 vec 后端就绪 → 读现有 chunk（空块过滤）→ embed →
  `saveChunkVectors`（已是幂等 upsert）+ meta ok。
- vec 后端未就绪 / 无 embedder / API 失败 → meta 落 skipped（infra 原因）或 failed
  （API 错误带 reason）。
- **永不抛出**（catch-all + warn 日志），调用方无需包裹即可继续。

### 5. 路由接线 `PATCH /api/documents/:docId/type`（routes/review.ts）

`updateDocumentType` 成功后调用 reconcile，embedder 取 `defaultEmbedder()`
（pipeline/ingestModel.ts 既有工厂，无状态、构造廉价）。与既有图同步相同的
warn-only 模式：失败不影响修正结果。200 响应体新增 `vectorization` 字段
（增量字段，旧客户端忽略）。

### 6. 前端（最小改动）

`apps/web/src/api/review.ts` 的 updateDocumentType 返回类型加可选 `vectorization`；
`DocumentReviewCard.tsx` 类型修正成功回调中用其更新第 5 维状态。复用现有
「已跳过」徽章 + reason 斜体渲染，不新增组件。

## 错误处理汇总

- 门禁判定纯函数，无 IO，不失败（模板表缺失走字面回退）。
- reconcile 全容错：任何异常降级为 meta 写入 skipped/failed 并 warn，绝不阻断纠错。
- 嵌入 API 失败维持现状语义：meta failed + reason，FTS5 召回兜底。

## 测试计划

- 新增策略单测：细类→根解析（补充合同→合同）、立项书子树、履约凭证子树拒绝、
  树外类型字面回退。
- 新增门禁断言（存量 ingest 测试补强）：非向量化类型 DeterministicEmbedder 零调用、
  meta 为 skipped+约定 reason；合同照常 ok。
- 新增纠错回溯测试（内存 SQLite；PG 分支随既有 skip 规则）：
  - 运输凭证 → 合同：doc_chunk_vec 出现该 doc 行、meta ok；
  - 合同 → 运输凭证：向量清空、meta skipped。
- 空块过滤：含空串 chunk 时仅非空块进入 embed 输入。
- 验证顺序：build → lint → test（仓库规定，CI 同序）。

## 明确不做（Out of Scope)

- 历史存量单据的批量向量回溯或清理。
- agent 侧手动触发重嵌入的工具/入口。
- SiliconFlow 400 的进一步根因分析（门禁落地后该场景消失；契约失败仍走既有
  failed 语义）。

## 受影响文件清单

| 文件 | 动作 |
|---|---|
| apps/server/src/pipeline/vectorPolicy.ts | 新增 |
| apps/server/src/pipeline/vectorReconcile.ts | 新增 |
| apps/server/src/pipeline/tools/documentEntry.ts | 三处门禁 + 空块过滤 |
| apps/server/src/pipeline/db/repositories.ts(+pg twin) | listChunksByDocument |
| apps/server/src/pipeline/db/vecStore.ts(+pg) | clearChunkVectorsForDocument |
| apps/server/src/routes/review.ts | PATCH type 接线 + 响应字段 |
| apps/web/src/api/review.ts、components/DocumentReviewCard.tsx | 状态回填 |
| apps/server/test/... | 新增/补强测试 |
