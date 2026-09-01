# 批量拆分器设计：一个物理文件 ≠ 一份业务单据

日期: 2026-09-01 · 状态: Phase 1(后端)已实现(BATCH_SPLIT_ENABLED 默认关闭);
Phase 2(抽取切片)/Phase 3(前端层级)待做

## 0. 背景与问题

真实业务文件经常是"多份单据拼一个 PDF/图片":

- 10 张煤炭检测报告拼成 5 页 PDF(每页左右并排 2 份);
- 运输单据把重量凭证(磅单)与质量凭证(化验报告)分页合订;
- 一页上拼贴多张手机拍的磅单照片, 且照片带旋转。

当前管线假设 `一个文件 = 一份单据`: scanned PDF 分类只看第 1 页, 凭证路由
把全部页一次性交给**单据级 schema** 抽取(如 化验报告Schema 只有一份报告的
字段)。多单据文件实际只抽出第一份的内容 —— 用户已实测确认("只会读取第一
页的第一个, 后面的没有读取")。

## 1. 核心原则

> 物理文件先进入"批量拆分层", 拆出 N 个逻辑单据(unit), 每个 unit 仍走现有
> 单据处理流水线(分类/抽取/审核/绑定)。一个物理文件 ≠ 一份业务单据。

不把多份单据塞进一个 `extraction.fields` 大 JSON: 审核状态、合同绑定、
台账/履约/图谱都以 `documents.id` 为锚, 嵌套会破坏全部下游假设。

## 2. 架构

```text
上传 PDF / 图片
  ↓ 物理文件记录(parent document, batch_role='container')
批量拆分器 Batch Splitter (detectDocumentUnits)
  ├─ 0/1 份 → 原路径 processDocument, 行为完全不变
  └─ N 份  → 生成 N 个子单据(batch_role='unit', 页区间+bbox+旋转)
        ↓ 每个子单据独立走 现有 分类→抽取→审核→绑定 流水线
``+
灰度开关: `BATCH_SPLIT_ENABLED`(默认关闭, 关闭时零行为变化)。

### 数据模型(新增, 不动 documents 语义)

```sql
CREATE TABLE document_units (
  id TEXT PRIMARY KEY,
  parent_document_id TEXT NOT NULL,
  child_document_id TEXT,          -- 拆出子单据的 documents.id
  unit_index INTEGER NOT NULL,
  doc_type TEXT NOT NULL,
  page_start INTEGER, page_end INTEGER,
  bbox_json TEXT,                  -- 归一化 {x,y,w,h}
  rotation_deg INTEGER,            -- 0/90/180/270
  detector_confidence REAL NOT NULL DEFAULT 0,
  manifest_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
ALTER TABLE documents ADD COLUMN batch_role TEXT; -- NULL|container|unit
```

SQLite 走 `client.ts` raw idempotent DDL, Postgres 走 drizzle migration;
老数据 `batch_role IS NULL` 天然兼容。

### unit 是"逻辑单据", 不是"页"

页数 ≠ 单据数: 磅单 A 续页(2 页 1 单据)要合并, 一页并排 2 份检测报告要拆开。
检测器输出逻辑单据清单(页区间+bbox+类型+证据+编号), 由"版面清点 + 类型识别
+ 业务校验"组成, 不是纯切页。

## 3. 检测器(原型验证过的 prompt 形态)

逐页(150 DPI, 与生产 `pdfRender.ts` 同口径)调 VLM 做**版面清点**:

- 数出该页独立完整业务单据数量(并排/堆叠都算), 不把印章/logo/页眉当单据;
- 每个单元给: unitIndex(左→右、上→下)、formType、confidence、归一化 bbox、
  rotationDeg、evidence(该区域可见短语)、identifierOrNull(单号/报告号);
- 空白页返回 `units: []`(可先用像素非白占比 <5% 免费预判, 省 VLM 调用);
- 输出 strict JSON(`response_format: json_object`, temperature 0)。

formType 词表: 汽运磅单 / 轨道衡称重单 / 水尺计重单 / 质检报告 / 货转单 /
付款凭证 / 微信聊天记录 / 数据表格 / 空白页 / 其他。

## 4. 原型测试结果(2026-09-01, 10.10.0.2, 生产同款 VLM)

### 4.1 华新水泥襄阳化验报告.pdf(标准拼版, 5 页 10 份检测报告)

**10/10 全部拆出**, 每页左右并排 2 份, bbox 规整(x≈0.01/0.51, w≈0.48),
10 个报告编号全部唯一, confidence 均 0.95, 裁剪图目视核验完整。
→ 标准并排拼版场景, 检测层可直接生产化。

### 4.2 宣威收货数据、微信确认、磅单盖章8.28.pdf(极限样例)

8 页: 第 2/4/8 页近空白(非白像素 2.5%), 第 3 页密(73%)。结果:

| 页 | 内容 | 拆分结果 |
|---|---|---|
| 1 | 微信聊天截图(旋转) | 1 微信聊天记录, rot=90 |
| 2/4/8 | 空白 | 正确跳过 |
| 3 | 煤质化验分析报表照片(旋转) | 1 质检报告(内含 3 个样品行, 合计 1664.92 吨) |
| 5 | 4 张磅单照片拼贴 | 4 汽运磅单(rot 90/270 混合), 编号 10384417-20 |
| 6 | 4 张磅单照片拼贴 | 4 汽运磅单 |
| 7 | 1 张磅单照片 | 1 汽运磅单 |

**清点覆盖: 11/11 份单据全部找到, 无漏检**(对第 3/7 页另做独立"区域清点"
复核, 均确认只有 1 个区域)。检测层在最恶劣样例上仍然可靠。

但二次逐单元核验暴露了两个**下游上限**(不是检测问题):

1. **旋转方向歧义**: rotationDeg=90 的照片, 按同一方向旋回后部分正确、部分
   180° 颠倒(90 与 270 不可分辨)。第 6 页 4 张全部旋反, 第 5 页 4 张全对。
2. **模糊照片数字不稳**: 检测遍与裁剪核验遍两次独立读取, 单号/净重频繁
   不一致(如 10384417 vs 10394417; 净重 34250 vs 54520; 10084416 vs
   10384414)。两遍读数分歧是这类照片的常态。

耗时(串行逐页): 空白页 5-13s, 普通内容页 60-110s, 拼贴密页最长 172s;
8 页串行约 9 分钟。生产需按页并行(并发 4 时墙钟约等于最慢一页)。

## 5. 落地要点(由测试结论反推)

1. **检测层可直接落地**: 通用清点 prompt + 空白页像素预判 + bbox+rot+证据。
   bbox 加 2-3% padding(原型 1% 仍出现边缘裁切)。
2. **旋回方向不信任单次猜测**: 抽取时对 90/270 两个候选各跑一次, 取 OCR/抽取
   置信度高者; 或专用轻量方向分类器。抽取 VLM 本身具备旋转不变性(颠倒图
   仍读出了大部分字段), 旋回只是提升可靠性的优化而非硬前提。
3. **两遍读数分歧 → 强制 needs_review**: 拼贴模糊磅单的数字字段不可自动入
   台账; 检测遍 evidence 与抽取遍读数不一致时 confidence 压低并转人工。
   这与现有 review 流程天然衔接。
4. **一表多样品**: 化验分析报表内含多个样品时是"1 个 unit + 指标数组"
  (同 汽运磅单Schema 明细行 模式), 不是拆成多个 unit。
5. **灰度与回退**: BATCH_SPLIT_ENABLED 关闭 = 旧路径原样; 拆分仅在新表
   记录 manifest, 子单据复用现有 documents 全链路, 不新增下游分支。

## 6. 实施切分建议

- Phase 1(后端): document_units 表 + batch_role + detectDocumentUnits +
  processDocumentWithBatch 灰度入口 + 空白页预判; 单元测试用固定页图。
- Phase 2(抽取): 子单据页图切片(bbox+padding+旋回候选)接入现有 voucher
  管线; 两遍读数共识与 needs_review 联动。
- Phase 3(前端): 文件树展示 container→units 层级与拆分 manifest, 逐单元
  审核/重抽/合并修正入口。

原型脚本与产物(临时): 10.10.0.2 `/tmp/xuanwei-*`, `/tmp/split-result.json`,
本地裁剪图 `D:\Users\yepeng\.tmp-orca\xuanwei\`。

## 7. Phase 1 落地记录(2026-09-01)

- 数据模型: `document_units` + `documents.batch_role`(SQLite raw DDL +
  Postgres migratePostgres + postgres-schema.ts 声明, 双库同步, 老数据
  batch_role IS NULL 零影响; deleteDocument 级联清理 unit 行)。
- 灰度: `BATCH_SPLIT_ENABLED`(env.ts zod 契约, 默认 false = 零行为变化,
  有测试锁定) + `BATCH_SPLIT_CONCURRENCY`(默认 4) + `BATCH_SPLIT_MAX_PAGES`
  (默认 50, 超限走旧路径)。未配置 VLM 时拆分自动不生效。
- 检测器: `src/pipeline/batchSplit.ts` —— 内置最小 PNG 解码器做空白页
  非白占比预判(<5% 跳过 VLM), 逐页 150 DPI VLM 版面清点(严格 JSON +
  失败回灌重试 1 次), 跨页续表合并(相邻页 + 同 formType + 同非空单号),
  bbox 四边加 2.5% padding 并截断 [0,1]。实查工具:
  `npx tsx apps/server/scripts/detectUnits.ts <pdf>`。
- 灰度入口: `processDocumentWithBatch` 挂在 `ensureDocumentParsed`(覆盖
  /process 与 chat 兜底)。仅图像型 PDF 参与(显式 scanned 或无文字层);
  文字层 PDF 的 digital 解析不带页号(blockModelFromText 全部 page=1), 页
  区间切片无意义。N>1 时: parent 标 container + unit 行落库, container 走
  旧链路解析(跳过 Voucher 路由, 多单据整文件硬喂单据级 schema 正是本 bug),
  子单据(container BlockModel 按 unit 页区间切片 + formType 派生分类 hint)
  各自独立走现有 分类→抽取→审核→绑定 全链路。已拆分文件重跑幂等(只重解析
  container)。container 解析失败(needs_ocr/failed)不生成子单据, unit 行留
  pending 待审计。
- Phase 1 切片粒度 = 页区间: 同页并排多 unit 的子单据暂共享该页块,
  bbox 像素级切片 + 旋回双候选 + 两遍读数共识属 Phase 2(逐页 region 明细
  已存 manifest_json, 供 Phase 2 直接消费)。
