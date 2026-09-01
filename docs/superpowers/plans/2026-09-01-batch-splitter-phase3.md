# 批量拆分器 Phase 3(谱系)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** container→unit 谱系全链路打通:后端 API/快照/图谱/recall 带谱系字段,前端文件树层级 + container 导航卡 + unit 卡「来源与拆分」第六区块 + 重拆/合并/单 unit 重抽入口。

**Architecture:** 谱系是只读透出面 + 三个修正操作。数据底座已在 P1 落地(`documents.batch_role` + `document_units` 表,unit 走 documents 全链路),P3 只做:快照/files/recall 三个读面补谱系 join;Neo4j 补 `batchRole` prop + `(container)-[:CONTAINS]->(unit)` 边;container 分类固定「单据组」;`/api/batch` 三个修正端点。前端 FileTree 加一层可展开的 unit 层级 + 复用 DocumentReviewCard 的复核弹窗。

**Tech Stack:** Hono + better-sqlite3/Postgres(drizzle) 双库仓储、Neo4j(可选配置, fault-isolated)、React 19 + TS + Tailwind。零新增 npm 依赖。

**设计与实测 SSOT:** `docs/superpowers/specs/2026-09-01-batch-splitter-design.md`(§5/§7/§8);上一轮对话 Phase 3 方案结论(2026-09-01 会话末尾,用户已拍板:container doc_type 固定「单据组」)。

## Global Constraints

- `BATCH_SPLIT_ENABLED=false` → 零行为变化(有测试锁定)。本计划所有新读面挂在 DB 里 batch_role 存在性上,开关关闭时无 container 产生,谱系面自然空转;修正端点(/api/batch)对非 container 文档一律 404/400。
- SQLite 与 Postgres 仓储函数必须成对实现(repositories.ts + postgres-repositories.ts),SQL 语法按各自分支现有惯例。
- 代码中禁止 emoji。UI 文案中文。
- 完成顺序铁律:build → lint → test(`npm run build && npm run lint && npm test`,repo 根)。
- 单测里 fake VLM 按调用序回灌的用例必须 `BATCH_SPLIT_CONCURRENCY=1`。
- pg 集成测试只可用独立 `sca_test` 库,绝不指向共享开发库 `sca`。
- AI SDK 6 规则见 ARCHITECTURE.md 附录 D(本计划不动 harness 流,仅 present_document_review 返回字面量扩两个字段,无 SDK 面风险)。
- 每个 Task 结束提交一次 commit(信息风格照 `git log --oneline`:中文/英文均可,沿用 `feat(server): ...` 前缀风格)。
- 工作分支 `PengYip/业务逻辑优化`,全部完成后按惯例合入 main(CI 当前红是 runner TLS 运维问题,不是代码问题,不影响推送惯例)。

## 关键既有锚点(实现者必读,省去再探索)

| 锚点 | 位置 |
|---|---|
| ReviewSnapshot 接口 | `apps/server/src/pipeline/db/repositories.ts:382-407` |
| getReviewSnapshot(SQLite) | `repositories.ts:1818-1951`;PG twin `postgres-repositories.ts:1411` |
| `_warnings` 写入形态 | `apps/server/src/pipeline/tools/documentEntry.ts:664-668`:`fieldMeta['_warnings'] = { strength:'none', confidence:1, warnings }`(field_meta JSON 顶层键) |
| document_units 仓储 | `repositories.ts:1354-1485`:`saveDocumentUnits/listDocumentUnitsByParent/updateDocumentUnitChild/setDocumentBatchRole`,`BatchRole`/`DocumentUnitRow`(`manifest: Record<string,unknown>` 已解析)在 :1363/:1381;PG twin `postgres-repositories.ts:3084-3176` |
| /api/files GET 处理器 | `apps/server/src/routes/files.ts:287-377`;`parseFileKey` :120-130;`findDocIdsByMinioKeys` `repositories.ts:1536-1576`(phase2 LIKE fallback :1564-1574 会误中 unit 行,本计划修) |
| processDocument 分类步 | `documentEntry.ts:1319-1344`(`opts.docType` hint,classificationSource `'classified'|'hint'|'fallback'`);`ProcessDocumentOptions` :1040-1053 |
| processDocumentWithBatch | `documentEntry.ts:1496-1684`:幂等探针 :1527-1530,container 调用 :1577,unit 子循环 :1589-1683(createDocumentStub 共享 sourceUri、minio_key=NULL,:1625) |
| present_document_review | `documentEntry.ts:2248-2279`(返回 allowlist 字面量,**非**透传;GET /review 路由 `routes/review.ts:170-185` 是透传不用改) |
| recall_documents 工具 | `apps/server/src/pipeline/tools/recall.ts:336-687`;matches 形态 :477-485;fullText 模式 documents 数组 :315-334 |
| graphWriter | `apps/server/src/graph/graphWriter.ts`:`WriteDocumentGraphInput` :45-53,边类型 `GraphEdgeInput.type` :17-23,Document 节点 MERGE 委托 `graph/repo.ts:91-96` createEntity,边 MERGE repo.ts:424-425 |
| commitDocumentGraph | `apps/server/src/pipeline/graphCommit.ts:52-102`;`syncDocumentTypeToGraph` :113-125 |
| projectTree | `graph/repo.ts:264-339`,`TREE_FULFILLMENT_TYPES` :239-241(**不**加 CONTAINS) |
| 齐套率 | 前端纯函数 `apps/web/src/lib/voucherCoverage.ts`(DOC_TYPE_DIMENSION :43-64,未映射→null→排除;「单据组」天然不进五维,无需改) |
| 前端复核卡 | `apps/web/src/components/DocumentReviewCard.tsx`(918 行):`DocumentReviewPayload` :45-98(**前端 SSOT**,api/review.ts 反向 import),区块 1-7 到 :604-867 |
| 文件树 | `apps/web/src/components/shell/FileTree.tsx`(`BUSINESS_TYPE_TAG_STYLES` :59-101,FileRow :333,TreeCallbacks :264-314) + `shell/FileDrawer.tsx`(装配 :175-373) + `lib/fileTree.ts` buildTree(仅目录层嵌套) + `hooks/useFiles.ts`(FileEntry :12-25,fetch :117-136) |
| 复核卡唯一挂载点 | 聊天工具步 `apps/web/src/components/chat/RealToolSteps.tsx:166-291`(仅 present_document_review)——P3 需新增弹窗挂载点 |
| documents 表 | `apps/server/src/pipeline/db/client.ts:46-61`(无 title 列,显示名从 minio_key 派生) |
| 路由挂载 | `apps/server/src/index.ts`:`app.use('/api/documents/*', requireAuth)` :112、`app.route('/api/documents', reviewRoute)` :139、`/api/graph` :114/:142 |

**已拍板决策(2026-09-01):**
1. container 跳过 classifier,`doc_type` 固定 `单据组`(新常量 `CONTAINER_DOC_TYPE`,导出自 `batchSplit.ts`)。分类行 source='hint'、confidence=1。
2. `unitIndex` 从 1 起(检测器现状,batchSplit.ts:57)。
3. Neo4j container 节点**不携带**业务 docType prop;`batchRole` prop 必带。
4. recall 双索引保留(方案 A),matches 带谱系字段,靠 prompt 指引模型归并时优先 unit。
5. 本轮验证只用单测 + 内存库实查(processBatch.ts);dev 灰度部署由运维另行处理。

---

### Task 1: ReviewSnapshot 谱系块 + `_warnings` 序列化 + 择优旋回落库

**Files:**
- Modify: `apps/server/src/pipeline/db/repositories.ts`(类型 + 4 个新函数 + getReviewSnapshot)
- Modify: `apps/server/src/pipeline/db/postgres-repositories.ts`(PG twins)
- Modify: `apps/server/src/pipeline/tools/documentEntry.ts`(present_document_review 返回字面量 + unitVoucher 择优后写回 unit 行)
- Test: `apps/server/test/pipeline/db/review-snapshot.test.ts`(扩展)

**Interfaces(Produces,后续 Task 全依赖此契约):**

```ts
// repositories.ts 新增(与 ReviewSnapshot 同文件)
export interface BatchUnitSummary {
  unitId: string;                 // document_units.id ('DU-*')
  docId: string | null;           // 子单据 documents.id
  unitIndex: number;
  detectedFormType: string;       // 检测词表标签(汽运磅单/质检报告...)
  childDocType: string | null;    // 子单据落库业务类型(可与 detectedFormType 不同)
  unitStatus: string;             // pending|processing|processed|needs_ocr|failed
  reviewStatus: 'pending' | 'confirmed' | 'corrected' | null;
  needsReview: boolean;           // 最新 extraction needs_review=1
}
export interface BatchLineage {
  role: 'container' | 'unit';
  // container 侧
  unitCount?: number;
  units?: BatchUnitSummary[];
  needsReviewCount?: number;
  // unit 侧
  parentDocumentId?: string;
  parentFileName?: string | null; // container 的 minio_key 派生显示名, fallback source_uri basename
  unitIndex?: number;
  detectedFormType?: string;
  pageStart?: number | null;
  pageEnd?: number | null;
  rotationDeg?: number | null;    // 择优后的旋回方向(双候选落库后即最终值)
  regionCount?: number | null;    // manifest.regions.length
}
// ReviewSnapshot 增补两个字段:
//   warnings: string[]            // field_meta._warnings.warnings
//   batch: BatchLineage | null    // batch_role IS NULL -> null
export async function getDocumentUnitByChild(ctx: DbContext, childDocId: string): Promise<DocumentUnitRow | null>;
export async function listContainerUnitSummaries(ctx: DbContext, parentDocId: string): Promise<BatchUnitSummary[]>;
export async function getBatchRolesForDocuments(ctx: DbContext, docIds: string[]): Promise<Map<string, { batchRole: string | null; unitCount: number }>>;
export async function updateDocumentUnitManifest(ctx: DbContext, unitId: string, patch: { rotationDeg?: number; manifest?: Record<string, unknown> }): Promise<void>;
```

**Steps:**

- [ ] **1.1 写失败测试**(扩展 review-snapshot.test.ts,沿用该文件现有 saveDocument/saveDocumentUnits/extractions 夹具惯例):
  - `container snapshot lists units with needsReview aggregation`:container + 2 unit 行(其一 extractions.needs_review=1)→ `snapshot.batch.role==='container'`、`units.length===2`、`needsReviewCount===1`、units 按 unitIndex 升序。
  - `unit snapshot carries parent lineage`:unit doc + document_units 行(manifest 含 regions:3 项)→ `batch.role==='unit'`、`parentDocumentId`/`unitIndex`/`pageStart/pageEnd`/`regionCount===3` 正确。
  - `field_meta _warnings surfaced as snapshot.warnings`:extraction.field_meta 含 `_warnings: { strength:'none', confidence:1, warnings:['编号两遍分歧: 10384417 vs 10394417'] }` → `snapshot.warnings` 等于该数组;无 `_warnings` → `[]`。
  - `legacy doc (batch_role null) has batch null and empty warnings`。
- [ ] **1.2 跑测试确认失败**:`npm test --workspace apps/server -- test/pipeline/db/review-snapshot.test.ts`
- [ ] **1.3 实现(SQLite 分支)**:
  - `getReviewSnapshot` 首个 SELECT 增列 `batch_role`;字段装配处(`:1907-1914`)解析 `_warnings`:`const w = parsedMeta['_warnings'] as { warnings?: unknown } | undefined; const warnings = Array.isArray(w?.warnings) ? w.warnings.map(String) : [];`
  - container 分支 SQL(新函数 `listContainerUnitSummaries`):
    ```sql
    SELECT u.id AS unit_id, u.child_document_id, u.unit_index, u.doc_type AS detected_form_type,
           u.status AS unit_status, d.doc_type AS child_doc_type, d.review_status,
           COALESCE(e.needs_review, 0) AS needs_review
    FROM document_units u
    LEFT JOIN documents d ON d.id = u.child_document_id
    LEFT JOIN extractions e ON e.document_id = u.child_document_id
      AND e.rowid = (SELECT MAX(e2.rowid) FROM extractions e2 WHERE e2.document_id = u.child_document_id)
    WHERE u.parent_document_id = ?
    ORDER BY u.unit_index ASC
    ```
  - unit 分支:`getDocumentUnitByChild`(`WHERE child_document_id = ? LIMIT 1`);`parentFileName` 派生:container 行 `minio_key` 非空 → 取最后段,长度>37 去掉前 37 字符(UUID-),与 routes/files.ts `parseFileKey` 同规则;否则 `source_uri` basename。**实现放 repositories.ts 内小助手 `displayNameFromDocRow`,勿 import routes/**。
  - `regionCount`:`Array.isArray((unit.manifest as { regions?: unknown[] })?.regions) ? regions.length : null`。
  - `updateDocumentUnitManifest`:动态拼 UPDATE(仅传入的字段,manifest_json JSON.stringify)。
- [ ] **1.4 PG twins**(`postgres-repositories.ts`):四个函数同语义;extractions 最新行用 `DISTINCT ON (document_id) ... ORDER BY document_id, ctid DESC` 或该文件现有惯例;IN 列表参数化照现有分块惯例。
- [ ] **1.5 present_document_review**(`documentEntry.ts:2264-2276` 返回字面量)增两行:`warnings: snap.warnings, batch: snap.batch,`。GET 路由透传,无需改。
- [ ] **1.6 择优旋回落库**:unitVoucher 分支双候选择优处(`[perf-batch-split] unit ... 旋回双候选` 日志旁),胜出后调用 `updateDocumentUnitManifest(ctx, unitId, { rotationDeg: 胜出rot, manifest: { ...原manifest, chosenRotation: 胜出rot, candidateScores: [{rot, score, mismatch}, ...] } })`(fire-and-forget `.catch(() => {})`,失败不阻断)。这使 Task 8 的「来源与拆分」能展示最终方向与择优证据。
- [ ] **1.7 跑测试通过** → `npm run build && npm run lint` → commit `feat(server): 快照/复核工具带谱系块与 _warnings 序列化, 择优旋回落库`

### Task 2: /api/files 谱系字段 + GET /:docId/units + source_uri fallback 防误中

**Files:**
- Modify: `apps/server/src/routes/files.ts`(GET / 响应)
- Modify: `apps/server/src/pipeline/db/repositories.ts` + `postgres-repositories.ts`(findDocIdsByMinioKeys fallback;getBatchRolesForDocuments 已在 Task 1)
- Modify: `apps/server/src/routes/review.ts`(新端点,挂同 mount)
- Test: `apps/server/test/routes/files.batch.test.ts`(新)、`apps/server/test/routes/reviewUnits.test.ts`(新)

**Interfaces(Produces):**
- `GET /api/files` 每个文件对象增:`batchRole: 'container' | null`、`unitCount: number | null`(非 container 恒 null/0 → 前端判 batchRole==='container')。
- `GET /api/documents/:docId/units` → `{ ok: true; docId: string; units: BatchUnitSummary[] }`;doc 不存在/非本人/`batch_role != 'container'` → 404 `{ ok: false }`(照 review.ts GET 现有错误形态)。

**Steps:**

- [ ] **2.1 写失败测试**:files.batch.test.ts —— container 文件条目带 `batchRole:'container'`+`unitCount:2`;普通文件 `batchRole:null`。reviewUnits.test.ts —— container 返回 units 列表;非 container 404;他人文档 404。
- [ ] **2.2 findDocIdsByMinioKeys fallback 加固**(repositories.ts:1564-1574,PG twin 同):LIKE fallback SELECT 增加条件 `AND (batch_role IS NULL OR batch_role <> 'unit')`——unit 与 container 共享 source_uri,不得劫持文件条目 docId。补一条 repo 级测试(unit 与 container 同 source_uri,fallback 命中 container)。
- [ ] **2.3 files.ts GET**(在 `:346-355` docTypes 之后):`const batchRoles = await getBatchRolesForDocuments(ctx(), filesWithStatus.filter(f=>f.docId).map(f=>f.docId!), user.id);` 映射进 `filesWithMeta`:`batchRole: b?.batchRole ?? null, unitCount: b?.batchRole === 'container' ? b.unitCount : null`。
- [ ] **2.4 units 端点**(review.ts,GET 挂 `/api/documents/:docId/units`,requireAuth 已由 mount 覆盖):先 `getReviewSnapshot(ctx, docId, user.id)` 非空校验所有权(snapshot 对他人文档返回 null 的现行为即守卫),再查 `snapshot.batch?.role==='container'`,返回 `listContainerUnitSummaries`。
- [ ] **2.5 跑测试通过** → build/lint → commit `feat(server): /api/files 带批量谱系字段, 新增 /api/documents/:docId/units, fallback 防误中 unit`

### Task 3: container 固定「单据组」跳过分类

**Files:**
- Modify: `apps/server/src/pipeline/batchSplit.ts`(导出常量)
- Modify: `apps/server/src/pipeline/tools/documentEntry.ts`(ProcessDocumentOptions + 分类步 + 两处 container 调用)
- Test: `apps/server/test/pipeline/tools/batchSplitter.test.ts`(扩展)

**Steps:**

- [ ] **3.1 写失败测试**:split 场景(现有 2-unit 夹具)断言:container documents.doc_type === '单据组';classifications 行 source==='hint' 且 confidence===1;unit 子单据分类不受影响(hint 走别名桥既有行为)。另断言 off-switch 用例(已有)仍绿。
- [ ] **3.2 实现**:
  - batchSplit.ts:`export const CONTAINER_DOC_TYPE = '单据组' as const;`
  - ProcessDocumentOptions 增:`/** 批量拆分器内部选项: 固定业务类型跳过分类器(container 无业务语义, 词表分类只会产噪声)。 */ fixedDocType?: DocType;`
  - 分类步(`:1322-1324`)改为:
    ```ts
    const cls = opts.fixedDocType
      ? { docType: opts.fixedDocType, confidence: 1, source: 'hint' as const }
      : opts.classifier
        ? await classifyDocument(opts.classifier, { blocks: blockModel.blocks, hint: opts.docType, vocab })
        : classifyDocumentWithoutModel({ blocks: blockModel.blocks, hint: opts.docType });
    ```
  - processDocumentWithBatch 两处 container 调用(幂等重解析 `:1529`、首次 `:1577`)的 opts 增 `fixedDocType: CONTAINER_DOC_TYPE`。
- [ ] **3.3 防御确认(不写代码,跑测试)**:齐套率 `voucherCoverage.ts` 的 DOC_TYPE_DIMENSION 无「单据组」→ dimension null → 排除,无需改;PATCH /:docId/type 的词表校验不含「单据组」→ 天然防止手工把普通文档改成单据组(前端 Task 8 对 container 也会禁用类型下拉)。
- [ ] **3.4 跑测试通过**(含既有 batchSplitter 全部用例)→ build/lint → commit `feat(server): container 跳过分类器, doc_type 固定「单据组」`

### Task 4: recall_documents 谱系 enrich

**Files:**
- Modify: `apps/server/src/pipeline/db/repositories.ts` + `postgres-repositories.ts`(新函数 `getBatchLineageForDocuments`)
- Modify: `apps/server/src/pipeline/tools/recall.ts`(matches/fullText documents 附加字段 + description 指引)
- Test: `apps/server/test/pipeline/recall.test.ts`(扩展)

**Interfaces(Produces):**
```ts
export interface DocBatchLineage { batchRole: string | null; parentDocumentId: string | null; unitIndex: number | null }
export async function getBatchLineageForDocuments(ctx: DbContext, docIds: string[]): Promise<Map<string, DocBatchLineage>>;
// matches 每项增: batchRole: string | null; parentDocumentId: string | null; unitIndex: number | null
```

**Steps:**

- [ ] **4.1 写失败测试**:unit 文档的 chunk 命中 → match 带 `batchRole:'unit'` + 正确 parentDocumentId/unitIndex;container 命中 → `batchRole:'container'`,parent/unitIndex null;普通文档 → 三者 null。fullText 模式 documents[] 同样附加。
- [ ] **4.2 实现**:
  ```sql
  SELECT d.id, d.batch_role, u.parent_document_id, u.unit_index
  FROM documents d LEFT JOIN document_units u ON u.child_document_id = d.id
  WHERE d.id IN (...)
  ```
  recall.ts 在 matches 装配前收集 distinct document_id 批量查一次,映射附加;fullText 分支的 `documents` 数组同样处理。inputSchema 不变。
- [ ] **4.3 description 增指引**(工具 description 末尾追加一句):`命中结果带谱系字段 batchRole/parentDocumentId/unitIndex: 同一物理文件的 container 与 unit 同时命中时, 优先引用 unit(unit 有业务类型/字段/绑定), container 命中仅用于说明物理来源; 向用户列举时按物理文件归并展示。`
- [ ] **4.4 跑测试通过** → build/lint → commit `feat(server): recall 命中带谱系字段, 归并指引进工具描述`

### Task 5: Neo4j batchRole prop + CONTAINS 边 + commit 门控

**Files:**
- Modify: `apps/server/src/graph/graphWriter.ts`(WriteDocumentGraphInput.batchRole;新 `writeBatchLineageEdges`)
- Modify: `apps/server/src/graph/repo.ts`(MERGE CONTAINS 边函数)
- Modify: `apps/server/src/pipeline/graphCommit.ts`(传 batchRole;container 门控)
- Create: `apps/server/src/pipeline/batchLineageGraphSync.ts`(fault-isolated 包装,照 bindingGraphSync.ts 模式)
- Modify: `apps/server/src/pipeline/tools/documentEntry.ts`(拆分完成后调用一次)
- Test: `apps/server/test/pipeline/graphCommit.test.ts`(扩展)+ `apps/server/test/pipeline/batchLineageGraphSync.test.ts`(新)

**Interfaces(Produces):**
```ts
// graphWriter.ts
export interface BatchLineageUnitInput { unitDocId: string; unitIndex: number; pages: string } // pages 形如 'p3-p5' / 'p5'
export interface WriteBatchLineageInput { containerDocId: string; sourceUri?: string | null; units: BatchLineageUnitInput[] }
export async function writeBatchLineageEdges(input: WriteBatchLineageInput, io?: GraphWriterIo): Promise<void>;
// repo.ts
export async function mergeContainsEdge(io, srcElementId: string, dstElementId: string, props: { unitIndex: number; pages: string }): Promise<void>;
// batchLineageGraphSync.ts
export async function syncBatchLineageGraph(ctx: DbContext, containerDocId: string): Promise<'ok' | 'skipped' | 'failed'>;
```

**Steps:**

- [ ] **5.1 写失败测试**(照 graphCommit.test.ts 的 fake io 惯例):writeBatchLineageEdges 建容器节点(props 含 batchRole:'container'、**不含** docType)+ N 个 unit 节点 + N 条 CONTAINS 边(props unitIndex/pages);重复调用幂等(fake io 去重语义);commitDocumentGraph 对 batch.role==='container' 的 snapshot 只写 Document 节点、不派生实体/业务边;对 unit snapshot 传 batchRole prop。batchLineageGraphSync:Neo4j 未配置 → 'skipped' 不抛;units 无 childDocId 的行跳过。
- [ ] **5.2 实现**:
  - repo.ts:`mergeContainsEdge` Cypher:`MATCH (a), (b) WHERE elementId(a) = $src AND elementId(b) = $dst MERGE (a)-[r:CONTAINS]->(b) SET r += $props RETURN count(r) AS n`(幂等 upsert)。
  - graphWriter.ts:`WriteDocumentGraphInput` 增 `batchRole?: 'container' | 'unit'`,Document props 展开 `...(input.batchRole ? { batchRole: input.batchRole } : {})`;`writeBatchLineageEdges` 用 io.createEntity 建 container(仅 docId/batchRole/sourceUri)与 unit(docId/batchRole:'unit')节点后逐条 `mergeContainsEdge`;GraphWriterIo 接口增对应槽位,默认 io 实现。
  - graphCommit.ts:writeDocumentGraph 调用传入 `batchRole: snapshot.batch?.role`;container 门控:`if (snapshot.batch?.role === 'container')` 跳过 deriveProposedRelationships/deriveProposedEdges 实体边写入(直接写 Document 节点 return)。
  - batchLineageGraphSync.ts:读 `listDocumentUnitsByParent`,过滤 childDocumentId 非空行,组 `pages` 字符串(`pageStart===pageEnd ? \`p${pageStart}\` : \`p${pageStart}-p${pageEnd}\``),调 writeBatchLineageEdges;未配置(Neo4j password/env 缺失,照 graphCommit/bindingGraphSync 现行判定)→ 'skipped';异常 catch + console.warn → 'failed'。
  - documentEntry.ts:processDocumentWithBatch 在 mapLimit 全部 unit 完成后 `await syncBatchLineageGraph(ctx, docId).catch(() => {})`(失败只 warn,不阻断返回)。
  - projectTree 的 TREE_FULFILLMENT_TYPES **不加** CONTAINS(unit 绑定合同,container 不绑;树不受影响)。
- [ ] **5.3 跑测试通过** → build/lint → commit `feat(server): Neo4j 谱系 -- batchRole prop + CONTAINS 边 + container 提交门控`

---

### Task 9: P3d 后端 —— /api/batch 重拆 / 单 unit 重抽 / 合并修正

**依赖 Task 1(updateDocumentUnitManifest/BatchUnitSummary)与 Task 3(CONSTAINER_DOC_TYPE)。**

**Files:**
- Create: `apps/server/src/routes/batch.ts`(三个端点)
- Modify: `apps/server/src/index.ts`(mount + requireAuth)
- Modify: `apps/server/src/pipeline/db/repositories.ts` + PG twin(新 `clearDocumentUnits(ctx, parentDocId)`)
- Modify: `apps/server/src/pipeline/tools/documentEntry.ts`:`processDocumentWithBatch` 增 `forceResplit`;unit 子循环体抽取为可导出函数 `processUnitChild`(初始拆分与重抽共用)
- Test: `apps/server/test/routes/batch.test.ts`(新)、`batchSplitter.test.ts`(扩展)

**Interfaces(Produces):**
```ts
// 路由(全部 requireAuth; 资源不存在/非 container/非本人 -> 404; 破坏性守卫 -> 409)
POST /api/batch/:docId/resplit      body { force?: boolean }
  -> 200 { ok: true; docId; unitCount; childDocIds: string[] }
  -> 409 { ok: false; error: 'unit_bound'; detail: { docId; unitIndex }[] }  // 存在 confirmed 绑定且未 force
POST /api/batch/:docId/units/:unitId/reextract  body { docType?: string; rotationDeg?: 0|90|180|270; force?: boolean }
  -> 200 { ok: true; unitId; docId /*新子单据*/ }
  -> 409 同上(该 unit 已绑定且未 force)
POST /api/batch/:docId/units/merge   body { unitIds: string[] /* >=2, 同 container */ }
  -> 200 { ok: true; mergedUnitId; docId }
  -> 409 任一参与 unit 已绑定; 400 unitIds <2 或跨 container
// processDocumentWithBatch opts 增: forceResplit?: boolean(绕过幂等探针, 删旧子单据+unit 行后重检测)
```

**Steps:**

- [ ] **9.1 写失败测试**(batch.test.ts 走内存 ctx + 直接调路由处理逻辑,照 test/routes 现有惯例):
  - resplit:已有 2 unit 的 container 重拆 → 旧 childDocIds 全部消失(documents/chunks/extractions 级联删)、新 unit 行生成、unitCount 正确;任一 unit 有 confirmed binding 且未 force → 409 + detail;force → 通过并删绑定。
  - reextract:指定 `rotationDeg: 270` → 重抽后 unit 行 rotation_deg=270 且 manifest.chosenRotation=270、单候选(fake VLM 只被调一次该 unit);指定 `docType`(有注册 schema 的类型)→ 走凭证路径;unit 已绑定未 force → 409。
  - merge:两个相邻 unit 合并 → 一行(unitIndex 取小、pageStart/pageEnd 取包络、manifest.regions 拼接且 `merged:true, mergedFrom:[...]`)、多余子单据删除、重处理为新 child;参与 unit 已绑定 → 409。
- [ ] **9.2 重构 processUnitChild**:把 `documentEntry.ts:1589-1683` 循环体提取为模块内(或导出)函数,入参含 overrides `{ docTypeOverride?: string; rotationOverride?: number }`——rotationOverride 存在时 unitRotationPlans 退化为 `[rotationOverride]` 单候选;初始拆分调用点行为不变(既有 batchSplitter 测试全绿即证明等价)。
- [ ] **9.3 forceResplit**:幂等探针处(`:1527-1530`)`existing.length > 0 && opts.forceResplit` 时:逐个 `deleteDocument(ctx, childDocId, opts.userId)`(级联 chunks/extractions/bindings/向量,现有 deleteDocument 已含 unit 行级联)、`clearDocumentUnits(ctx, docId)`(`DELETE FROM document_units WHERE parent_document_id = ?`,PG twin 同),随后走全新检测分支。container 自身不重解析(block_model 复用;若 container parse_status 非 parsed → 400)。
- [ ] **9.4 路由 batch.ts**:三个端点按上述契约;绑定守卫用 `listDocumentIdsWithConfirmedBindings` 或对 childDocIds 逐查(照 bindings 现有函数取用);merge 实现:读 unit 行集 → 校验同 parent → 合并字段(manifest:{ merged:true, mergedFrom, formType: 首个非空, identifier: 首个非空, evidence: concat, regions: 按 unitIndex 序 concat })→ 保留 unitIndex 最小行(updateDocumentUnitManifest 写包络页码+合并 manifest),其余行删子单据+删行 → 对保留行跑 processUnitChild 重建子单据。reextract:删旧子(未绑定或 force)→ processUnitChild(带 overrides)。resplit:调 processDocumentWithBatch({ forceResplit:true })。全部端点返回前 `syncBatchLineageGraph(ctx, docId).catch(()=>{})` 刷新 CONTAINS 边。
- [ ] **9.5 index.ts 挂载**:`app.use('/api/batch/*', requireAuth)` + `app.route('/api/batch', batchRoute)`(照 :112/:139 形态,放相邻位置)。
- [ ] **9.6 跑测试通过** → build/lint → commit `feat(server): /api/batch 重拆/单unit重抽/合并修正端点`

---

### Task 6: 前端数据层(类型 + API 客户端)

**依赖 Task 1/2 端点。Files:**
- Create: `apps/web/src/api/documents.ts`
- Modify: `apps/web/src/hooks/useFiles.ts`(FileEntry 增字段)
- Modify: `apps/web/src/components/shell/FileTree.tsx`(BUSINESS_TYPE_TAG_STYLES 增「单据组」)
- Test: 手动 tsc(无 web 测试基建则靠 build)

**Interfaces(Produces,Task 7/8/10 消费):**
```ts
// api/documents.ts
export interface BatchUnitSummary { unitId: string; docId: string | null; unitIndex: number;
  detectedFormType: string; childDocType: string | null; unitStatus: string;
  reviewStatus: 'pending' | 'confirmed' | 'corrected' | null; needsReview: boolean }
export interface BatchLineage { role: 'container' | 'unit'; unitCount?: number; units?: BatchUnitSummary[];
  needsReviewCount?: number; parentDocumentId?: string; parentFileName?: string | null;
  unitIndex?: number; detectedFormType?: string; pageStart?: number | null; pageEnd?: number | null;
  rotationDeg?: number | null; regionCount?: number | null }
export async function listDocumentUnits(docId: string): Promise<BatchUnitSummary[]>        // GET /api/documents/:docId/units
export async function resplitDocument(docId: string, force = false): Promise<{ unitCount: number; childDocIds: string[] }>
export async function reextractUnit(docId: string, unitId: string, body: { docType?: string; rotationDeg?: 0|90|180|270; force?: boolean }): Promise<{ docId: string }>
export async function mergeUnits(docId: string, unitIds: string[]): Promise<{ mergedUnitId: string; docId: string }>
// useFiles.ts FileEntry 增: batchRole?: 'container' | null; unitCount?: number | null
// FileTree.tsx BUSINESS_TYPE_TAG_STYLES 增 '单据组' 样式(容器族, 与现有色系协调, designer 可调)
```

- [ ] 按 api/documentType.ts 的 getJson/parseBody 惯例实现;`npm run build` 通过即验收;commit `feat(web): 批量谱系数据层`

### Task 7: 文件树 container→unit 层级 + 复核弹窗挂载点

**依赖 Task 6。Files:** `FileTree.tsx`、`FileDrawer.tsx`、`App.tsx`、新 `components/ReviewModal.tsx`。**视觉与交互细节归 @designer,以下为行为契约:**

- container FileRow:badge「单据组 · N 份单据」+ 展开箭头;展开时懒加载 `listDocumentUnits(docId)`。
- unit 子行(缩进一层):`#unitIndex` + 子单据类型 badge(复用 BUSINESS_TYPE_TAG_STYLES)+ 状态(解析状态/复核状态)+ 待复核红旗(needsReview)。
- unit 子行主操作「复核」→ 打开 ReviewModal;container 行不提供加对话以外的旧操作(unit 无独立物理文件,「添加到对话」仍作用于整文件 key,置于 container 行如旧)。
- ReviewModal:全局单例挂载(App 层),props `{ docId, onClose }`;打开时 `GET /api/documents/:docId/review` 取 snapshot → 渲染现有 `<DocumentReviewCard payload={snapshot} .../>`(组件已支持 pending 水合与 onUpdated);关闭即卸载。container/unit/普通文档三种 payload 都可开(普通文档顺手获得「从文件树直接复核」能力,不额外做入口)。
- 验收:展开/收起记忆在会话内;loading/失败态有兜底;build 通过;commit `feat(web): 文件树批量拆分层级与复核弹窗`

### Task 8: DocumentReviewCard —— container 导航卡 + unit 第六区块 + warnings 横幅

**依赖 Task 6。Files:** `DocumentReviewCard.tsx`(payload 类型 :45-98 为前端 SSOT,增 `warnings?: string[]; batch?: BatchLineage`;api/review.ts 反向 import 自动获得)。**布局视觉归 @designer,内容契约:**

- **container 变体**(`batch?.role === 'container'`):整卡切「拆分清单」形态——头部「单据组 · N 份单据 · M 份待复核」;列表每行:序号/类型 badge/解析状态/复核状态/待复核标记/「复核」跳转(开 ReviewModal(unitDocId));**不渲染** 结构化字段/待确认关系/合同类型/向量化/图入库 区块(container 无 extraction);底部「重新拆分」入口(Task 10 接线,先置 disabled)。
- **unit 第六区块「来源与拆分」**(图入库状态区块后、操作条前):来源文件(parentFileName)、页区间 `p{start}-p{end}`、区域数、旋回方向(带择优标记,manifest 有 chosenRotation 时显示「择优」)、共识状态(`warnings.length ? N 条读数分歧(已强制复核) : 两遍读数一致`)。
- **warnings 横幅**:结构化字段区块顶部,`warnings.length > 0` 时黄色警示条逐条列出(两遍读数共识分歧,P2 已强制 needs_review)。
- 回归:普通文档(无 batch/warnings)渲染与现状零差异。
- 验收:build 通过;commit `feat(web): 复核卡批量谱系 -- container 导航卡与 unit 来源拆分区块`

### Task 10: 前端修正入口(重拆/重抽/合并)

**依赖 Task 6(API 已含三函数)+ Task 9(端点)。Files:** `DocumentReviewCard.tsx`(container 卡)、`ReviewModal.tsx`、`FileTree.tsx`(unit 行/列表多选)。**行为契约:**

- 重新拆分(container 卡):二次确认弹窗列明后果——将删除现有 N 份子单据及其抽取/复核/绑定/向量并重新检测;存在已绑定 unit 时红色警示并要求勾选「强制」(force=true)才可提交;提交后刷新 units 列表。
- 单 unit 重抽(unit 复核弹窗操作条):可选覆盖项——业务类型(下拉,来自现有 active docTypes 词表)+ 旋回方向(0/90/180/270,默认不覆盖);已绑定 unit 需勾选强制;完成后刷新该 unit 快照与列表状态。
- 合并修正(container 卡 units 列表):多选 ≥2 行(提示建议相邻)→ 确认 → `mergeUnits` → 刷新。
- 所有操作 loading 态 + 中文错误提示(后端 409 detail 展示哪些 unit 已绑定)。
- 验收:build 通过;commit `feat(web): 批量拆分修正入口 -- 重拆/重抽/合并`

### Task 11: 收尾与合入(orchestrator 亲自)

- [ ] `processBatch.ts` 末尾增谱系摘要打印:container snapshot(units×类型×needsReviewCount)+ 首个 unit 的 batch 块(来源/页区间/旋回/共识),供内存链路自验。
- [ ] 设计文档追加 §9 Phase 3 落地记录(照 §7/§8 体例:要点+决策+边界);AGENTS.md「Backend notes」补一行 /api/batch mount 与 CONTAINS 边。
- [ ] 全量 `npm run build && npm run lint && npm test`。
- [ ] commit + push 分支 + 合入 main(照 repo 惯例;CI 红为 runner TLS 运维问题,不重跑)。

---

## Self-Review 记录

- **Spec 覆盖**:P3a(snapshot/list/recall 谱系字段、CONTAINS 边、container 跳分类)= Task 1-5;P3b(文件树层级/badge 不进词表/container 导航卡)= Task 6/7/8;P3c(第六维 join/needs_review 聚合)= Task 8(_warnings 序列化补齐是 Task 1);P3d(重拆/合并/重抽)= Task 9/10。方案第五点 recall 方案 A + 齐套率防御 = Task 4 + 3.3 确认。✓
- **Placeholder 扫描**:前端 Task 7/8/10 为契约式(视觉实现归 designer lane,系有意的路由决策而非缺失);后端 Task 1-5/9 均含字面代码或 SQL。✓
- **类型一致性**:`BatchUnitSummary`/`BatchLineage` 在 Task 1(后端 SSOT)与 Task 6(前端镜像)字段逐一对应;`DocBatchLineage`(recall)独立命名避免与 UI 形状混淆。✓
- **执行顺序**:Task 1→2→3 同会话(repositories 重叠);4、5 可在其后并行(文件不相交,5 仅在 documentEntry 加一行调用);9 在 1/3 后;6-8 在 1/2 后可与 4/5/9 并行(designer 只动 apps/web);10 在 6+9 后;11 最后。
