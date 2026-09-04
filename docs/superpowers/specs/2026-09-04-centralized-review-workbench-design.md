# 集中复核工作台（Centralized Review Workbench）设计

日期：2026-09-04
状态：已与需求方对齐，待实施
分支：PengYip/UI-UX优化

## 1. 背景与问题

火车大票、汽运磅单两类单据是**多页拼版文件**：一个 PDF 几十到上百页，批量拆分器（batch
splitter）把物理文件拆成单据组（container，docType=「单据组」）和若干逻辑子单据
（document_units，如汽运磅单/轨道衡称重单/化验报告）。

现状复核链路是"一卡一单据"：文件树/聊天点「复核」→ ReviewModal 弹窗 →
DocumentReviewCard 渲染单份子单据的字段 + 原片 → 用户逐字段核对 → 确认。container
的拆分清单只是导航入口，每份子单据仍要单独开弹窗逐份过。页数多时效率极低。

## 2. 目标

做一个**全页集中复核工作台**：container 内按单据类型分组，schema 票据（汽运磅单/
轨道衡称重单）的每个计量行摊平成表格一行，左侧原文页 + 右侧可编辑表格对照，支持
置信度驱动的批量放行、行内编辑、键盘流。核对动作从"每页开一个界面"变成"一张表里
连续过"。

### 非目标（Phase 2 备忘，见第 12 节）

- 字段/行级 bbox 高亮（需先扩展 VLM 输出契约）
- 火运大票专属 schema 与其表格化
- 跨文件聚合复核
- 行级"已核"勾选的服务端持久化
- 复核工作台导航级入口/复核队列（v1 仅从文件树 container 进入）

## 3. 需求决策记录（已确认）

| 决策点 | 结论 |
|---|---|
| 确认语义 | 置信度驱动分级复核：高置信单据批量放行，人工只核对低置信/告警单据；保留页级（单据级）审计记录 |
| 票种范围 | 首期只做有 schema 的票据（汽运磅单、轨道衡称重单）；其他类型组内列表走现有复核卡 |
| 编辑深度 | 表格内直接编辑，复用现有 corrections API（整字段 JSON 替换，客户端组装） |
| 聚合范围 | 单物理文件（container）内按类型分组；磅单聚合复核，质检报告等单独复核 |
| 审计增强 | documents 表新增 `review_action` 列，区分 `manual`（人工确认）/ `auto-release`（阈值放行） |

## 4. 业界参考（调研结论摘要）

成熟模式来自 IDP 产品：Rossum（验证界面：置信度阈值自动放行默认 0.975、Enter 只跳
待复核字段、放行原因可解释、中央工作台状态 tab）、ABBYY FlexiCapture（三窗格布局、
字段 bbox 高亮、红/黄/红下划线颜色语义、F6/F8/F9 错误巡检快捷键）、Label Studio
（Accept / Fix+Accept / Reject 三动作语义）、合合信息 TextIn DocFlow（position 坐标
用于原文高亮回显）。共同骨架：左侧原文 + 右侧可编辑表格 + 置信度分流 + 键盘流 +
行级状态机。本设计 v1 落地其中的"最小可行组合"。

## 5. 现状事实（实现依据，来自代码侦察）

- 复核链路：`requestOpenReview(docId)` → `ReviewModal`（App 层单例）→
  `GET /api/documents/:docId/review`（`getReviewSnapshot`，repositories.ts:2188+）→
  `DocumentReviewCard`；提交 `POST /api/documents/:docId/review`
  `{corrections:[{name,value}]}` 或 `{confirm:true}`。
- 汽运磅单行字段（vouchers.ts:127-137）：编号/卡号/车号/毛重_吨/皮重_吨/净重_吨/
  毛重时间/皮重时间/称号；单据级字段：明细行[]/总净重_吨/页数/失败页。
  轨道衡行字段（vouchers.ts:148-156）：车型/车号/毛重_吨/皮重_吨/净重_吨/票重_吨/盈亏_吨。
- 明细行 = 表格型字段：JSON 数组序列化塞在 `fields['明细行'].value`（documentEntry.ts:685），
  前端已有 round-trip 先例（DocumentReviewCard.tsx:1723）。
- **行带页码无坐标**：pageRecords.ts 聚合时逐行注入 `页码`（汽运磅单一页一行 :127-129，
  轨道衡一页多行 :144-146）；VLM 路径 `sourceSpans` 恒为 `[]`（documentEntry.ts:681-686），
  无字段级 bbox。
- unit ≠ 页：unit 是逻辑单据（续页合并），`document_units` 存
  `page_start/page_end/bbox_json/rotation_deg/manifest_json`
  （`regions:[{page,bbox,rotationDeg}]`，client.ts:442-456）。
- `GET /:docId/unit-preview`（review.ts:277+）：无参数，按 manifest.regions 把整个
  unit 纵向拼接成一张 PNG 返回，32 条 LRU 缓存。
- corrections 粒度：整字段覆盖，`fields[name] = { value, sourceSpans: [] }`，
  confidence 置 1.0（repositories.ts:2840-2846）。
- 批量查询先例：`listContainerUnitSummaries(ctx, parentDocId)`（repositories.ts:1610-1630，
  一条 SQL 拿全 container 的 child_doc_type/review_status/needs_review）、
  `getBatchRolesForDocuments(ctx, docIds)`（:1637，IN 查询先例）。
- 批量互斥先例：`withContainerLock`（batch.ts:64-87，per-container 异步锁）。
- 确认 = `setReviewStatus`（repositories.ts:2375）+ `commitDocumentGraph`（per-doc
  故障隔离）。`review_status/reviewed_at/reviewed_by` 每个子单据（documents 行）一份。
- 前端路由：`useHashRoute` 只支持 `#/view?key=value` 查询参数风格
  （useHashRoute.ts:15-24）；加视图需改 navigation.ts 的 ViewId + App.tsx 分支。
- 前端无表格库/虚拟滚动；表格为手写 `<table>`；Tailwind 3.4 + lucide-react，
  无组件库；弹窗/色彩 token 见 tailwind.config.js 与 index.css。

## 6. 入口与布局

### 入口

- 文件树 container（单据组）行新增「集中复核」按钮（FileTree.tsx UnitRow 区域
  :342-410 旁），跳转 `#/review?docId=<containerDocId>`。
- 现有单据级「复核」弹窗入口全部保留不动（聊天、结算卡、unit 行）。

### 路由

- navigation.ts：ViewId 加 `'review'`；按现有模式注册（是否加 NAV_ITEMS 图标条目
  以 route 解析实际要求为准，非必须）。
- App.tsx：`view === 'review' ? <ReviewWorkbench docId={route.params.docId} />`。
- AppShell 主区渲染，不新开布局。

### 布局（两栏）

```
┌──────────────────────────────────────────────────────────────┐
│ 顶栏：文件名 | 类型分组chips(汽运磅单12/轨道衡3/化验报告2…)    │
│       进度(待复核/已放行/已确认) | 一键放行 | 确认已核 | 设置  │
├────────────────────────┬─────────────────────────────────────┤
│ 左栏 原文区 (~40%)     │ 右栏 当前类型组的可编辑表格           │
│  当前页大图            │  sticky表头 + 虚拟滚动               │
│  缩略图条(按页)        │  行=明细行(含页码/状态/已核勾选)      │
│  (点表格行→跳对应页)   │  单据组分隔行(unit粒度)              │
└────────────────────────┴─────────────────────────────────────┘
```

- 类型分组 chips 切换右栏内容；schema 票据组渲染表格，其他类型渲染组内列表
  （每行「复核」按钮打开现有 ReviewModal）。
- 表格列 = schema 行字段 + 页码 + 状态；unit 分组分隔行显示单据级信息
  （单号/页区间/总净重/单据状态徽标/整体置信度）。
- 行点击 = 选中并驱动左栏跳转到该行 `页码` 对应原片。
- 虚拟滚动：引入 `@tanstack/react-virtual`（新前端依赖，仅此一个）。

## 7. API 与数据层增量（后端）

### 7.1 `GET /api/documents/:docId/review-workbench`

docId 为 container docId。挂 `/api/documents`，requireAuth + requireRole('admin','trader')
（与 review.ts 同）。实现：

- 复用 `listContainerUnitSummaries` 取子单据清单与状态。
- 新增 repo 函数 `listLatestExtractionsByDocIds(ctx, docIds, userId)`：批量 IN
  查询各子单据最新 extraction 行（fields/fieldMeta/overall_confidence/needs_review），
  仿 `getBatchRolesForDocuments` 的 IN 模式。
- 组装响应：

```ts
type ReviewWorkbenchResponse = {
  containerDocId: string;
  containerTitle: string;
  groups: Array<{
    docType: string;                    // '汽运磅单' | '轨道衡称重单' | '化验报告' | ...
    kind: 'voucher-table' | 'unit-list'; // 有无 schema 行结构
    units: Array<{
      docId: string;
      title: string;
      reviewStatus: 'pending' | 'confirmed' | 'corrected';
      reviewAction: 'manual' | 'auto-release' | null;
      overallConfidence: number;
      needsReview: boolean;
      warnings: string[];               // field_meta._warnings
      pageStart: number; pageEnd: number;
      releaseEligible: boolean;         // 见 7.6 放行资格，服务端计算
      // kind='voucher-table' 专有：
      rows?: Array<Record<string, string | number | null>>;  // 行字段原样 + 页码，缺失为 null
      rowChecks?: Array<RowCheck>;     // 与 rows 等长，见 7.4
      totals?: { 总净重_吨?: number; 页数?: number; 失败页?: number[] };
      totalCheck?: { expected: number; actual: number; tolerance: number; pass: boolean };
    }>;
  }>;
};

type RowCheck = {
  issues: Array<{
    rule: string;            // 如 'gross_minus_tare' / 'net_positive' / 'required_missing' / 'failed_page'
    severity: 'error' | 'warning';
    columns: string[];       // 需标色的列
    message: string;
  }>;
};
```

- 抽取缺失/失败的子单据照常入组，rows 为空数组 + warnings 注明，行上显示错误徽标。

### 7.2 `GET /api/documents/:docId/unit-preview` 扩展 page 参数

- 可选 query 参数 `page`。提供且落在 unit 页区间内 → 按 manifest.regions 中该页的
  region 裁切旋正，仅返回该页 PNG；未提供 → 维持现状（整 unit 纵向拼接）。
- LRU 缓存 key 加入 page 维度。原片渲染逻辑复用现有裁切管线。

### 7.3 `POST /api/documents/:docId/review-batch`

```ts
// 请求
{ actions: Array<{ docId: string; confirm: true; action: 'manual' | 'auto-release' }> }
// 响应
{ results: Array<{ docId: string; ok: boolean; error?: string; reviewStatus?: string }> }
```

- 整体包 `withContainerLock(containerDocId)`。
- 逐单据：`setReviewStatus('confirmed')` + 写 `review_action` + `commitDocumentGraph`
  （fire-and-forget，图失败不阻断，沿用现有故障隔离）。
- 幂等：重复 confirm 无害（状态已是 confirmed 直接 ok）。
- 部分失败不回滚：逐单据返回成败，前端标红重试。

### 7.4 勾稽校验模块 `apps/server/src/pipeline/reviewChecks.ts`

纯函数，workbench 端点组装时对 voucher-table 单据逐行计算：

| 规则 | 逻辑 | severity |
|---|---|---|
| gross_minus_tare | `\|(毛重-皮重) - 净重\| ≤ 0.02`（吨，容忍进位），涉及列：毛重_吨/皮重_吨/净重_吨 | error |
| net_positive | `净重 > 0` | error |
| required_missing | 毛重/皮重/净重 为空 | warning |
| failed_page | 行页码 ∈ 单据 `失败页` 列表 | warning |
| surplus_check（轨道衡） | `盈亏 ≈ 票重 - 净重`（±0.02），涉及列：票重_吨/净重_吨/盈亏_吨 | error |
| sum_check（单据级） | `Σ行净重 ≈ 总净重_吨`（±0.05）→ totalCheck | error |

- 容忍值为模块内常量，集中定义便于调整。
- 前端据此标色：error 列红、warning 列黄（对齐 ABBYY 颜色语义）。

### 7.5 DB 变更

- SQLite：client.ts 幂等 DDL 追加 `ALTER TABLE documents ADD COLUMN review_action TEXT`
  （值 `manual` / `auto-release` / NULL，按现有幂等 DDL 模式）。
- Postgres：postgres-schema.ts（drizzle）加列 + drizzle-kit 生成迁移
  （按 docs/postgres-migration-runbook.md；migrateOnStartup 启动自迁移，SQLite 无操作）。
- 写入点：review-batch 端点；现有单文档 `POST /:docId/review` 的 confirm 分支同步写
  `review_action='manual'`（保持口径一致）。

### 7.6 阈值配置

- 放行阈值：服务端常量，默认 0.975（对齐 Rossum 默认），env `REVIEW_AUTO_RELEASE_THRESHOLD`
  可覆盖（env.ts 注册，可选带默认值，不新增必填项）。
- 放行资格（服务端计算并随 unit 返回 `releaseEligible: boolean`，前端只展示）：
  `overall_confidence ≥ 阈值 && !needs_review && warnings 为空 && 全行无 error 级 issue
  && reviewStatus === 'pending'`。

## 8. 状态机与复核流

### 单据状态（持久化，审计）

```
pending ──确认(人工/批量)──> confirmed(review_action=manual)
        └─更正后确认────────> confirmed/corrected(review_action=manual)
```

### 行级客户端状态（不持久化，v1）

`unchecked（未核）→ checked（已核勾选）→ edited（已修改并提交更正）`。
行状态仅存前端；刷新丢失勾选，单据状态不受影响。

### 复核流

1. 进入工作台 → 默认选中第一个 schema 票据组，光标落在首个问题行
   （有 error issue 或低置信单据的首行）。
2. 用户逐行核对：看左栏原片 ↔ 右侧行数据，勾选"已核"；发现错误双击格内编辑
   （失焦即按现有 corrections 端点提交整个明细行数组，行转 `edited`）。
3. 一个 unit 的所有行均为 checked/edited → 该单据进入"可确认清单"
   （unit 分隔行出现可确认标识）。
4. 「确认已核」批量提交可确认清单（review-batch, action=manual）。
5. 「一键放行」对全部 `releaseEligible` 单据批量确认（action=auto-release），
   按钮显示数量，点击后二次确认弹层列出将放行的单据。
6. 提交后以响应就地刷新单据状态；已确认单据的行转只读、状态徽标更新。
7. 「确认后自动跳下一行」开关（顶栏设置，本地 localStorage 持久化）。

## 9. 前端结构与键盘流

### 新增文件（apps/web/src）

```
components/review-workbench/
  ReviewWorkbench.tsx        // 页面根：数据拉取、分组、状态编排
  WorkbenchToolbar.tsx       // 顶栏：分组chips/进度/批量操作/设置
  VoucherTable.tsx           // 虚拟滚动可编辑表格（@tanstack/react-virtual）
  UnitGroupHeader.tsx        // unit 分组分隔行（单据级信息/状态/可确认标识）
  OriginalPane.tsx           // 左栏：当前页大图 + 缩略图条
  UnitListGroup.tsx          // 非 schema 类型组的列表 + 打开复核卡
  useWorkbenchKeyboard.ts    // 键盘导航 hook
  checksColoring.ts          // RowCheck → 单元格颜色的映射
api/reviewWorkbench.ts       // workbench / review-batch / page 预览 API client
```

### 键盘流

| 键 | 行为 |
|---|---|
| Enter | 行内下一待办格 → 行尾跳下一行首格（Rossum"只跳待复核"简化版） |
| F8 / Shift+F8 | 下一个 / 上一个**问题行**（error issue / 低置信单据行 / 必填缺失） |
| 方向键 | 格间移动（虚拟滚动内） |
| 双击 / Enter 进入编辑 | 失焦或 Enter 提交（corrections） |
| Ctrl+Enter | 确认当前单据（若已可确认） |
| Ctrl+Shift+Enter | 一键放行（带二次确认） |
| Esc | 退出编辑 / 关闭弹层 |

### 交互细节

- 编辑提交：客户端持有该 unit 明细行数组的 working copy，格编辑后组装完整数组
  `JSON.stringify` 提交（`corrections:[{name:'明细行', value}]`），成功后行标
  `edited` 并以响应的 snapshot 更新本地行数据。
- 左栏缩略图条按 container 总页序排列，schema 行页码即缩略图索引；点击行平滑滚动
  缩略图并加载大图（`unit-preview?page=N`，img 懒加载）。
- 行/格颜色：error 红（勾稽失败列）、warning 黄（缺失/失败页）、edited 浅蓝底 +
  单元格角标"已改"（沿用 DocumentReviewCard 的已改高亮惯例）、确认后行变只读灰。
- 进度统计：待复核（pending 单据数）/ 已放行 / 已确认，随批量响应即时更新。

## 10. 错误处理

- review-batch 逐单据成败返回；失败单据 unit 分隔行标红 + toast，可重试（幂等）。
- corrections 提交失败：单元格回退编辑前值 + toast，行保持原状态。
- workbench 拉取失败：整页错误态 + 重试按钮。
- unit-preview 页参数越界：400 错误码，前端 toast 并回退整 unit 预览。
- 图提交（commitDocumentGraph）失败沿用现有故障隔离，不影响复核状态流转。

## 11. 测试与验证

- 后端 vitest（apps/server/test/）：
  - reviewChecks：各规则通过/失败/边界（0.02 容忍、空值、失败页标记）。
  - review-workbench 路由：分组正确性（混合类型 container）、行摊平与页码、
    releaseEligible 计算、鉴权（requireRole）。
  - review-batch：锁内串行、部分失败不回滚、幂等重复确认、review_action 写入。
  - unit-preview page 参数：指定页裁切、越界 400、无参向后兼容。
  - listLatestExtractionsByDocIds：IN 查询、缺 extraction 的子单据。
- 全仓验证顺序：build → lint → test（CI 同序）。
- 前端无测试基建：dev server 手动冒烟（混合类型拼版样本：分组/锚定/编辑/批量放行/
  键盘流），样本可用 `样本收集/` 下已有磅单/质检材料构造。

## 12. Phase 2 备忘（本期不做，留档）

1. **VLM 行级 bbox + 行级置信度契约**：vlmAdapter 输出行对象携带 bbox 与 confidence
   → 解锁字段级原文高亮与行级阈值分流（当前 sourceSpans 恒空是 v1 锚定降级到
   "行→页"的根因）。
2. 火运大票专属 schema 与表格化。
3. 跨文件聚合（项目/上传批次维度）。
4. 行级勾选服务端持久化（复核中断续传）。
5. 工作台导航级入口与复核队列（待复核 container 列表）。
6. 候选值下拉（ABBYY 建议值模式）与单元格拖拽复制（Rossum）。
7. 方向键盘格间导航与格级 Enter（v1 降级为行粒度 Enter）。
8. 一键放行二次确认列出单据清单（v1 仅显示数量）。
9. 工作台进入时光标落首个问题行（v1 未做）。

## 13. 风险与开放问题

- **风险 1**：明细行更正为整字段 JSON 替换，同一 unit 多行连续编辑时需以最新
  snapshot 为基线组装，避免覆盖（前端串行提交 + 失败回退已覆盖；单人复核场景风险低）。
- **风险 2**：`@tanstack/react-virtual` 与手写 `<table>` 的集成（行高不一致：unit
  分隔行 vs 数据行）需要实现时校准；兜底方案是行数 < 100 时退化为普通渲染。
- **开放**：轨道衡 `盈亏 = 票重 - 净重` 的方向（票-净 vs 净-票）需用真实样本验证后
  定死规则方向；实现时先抽样核对，若方向存疑降级为 warning。
