# 本体业务闭环 Wave 6（火运贯通 + 闭环补全）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。Steps 用 checkbox 跟踪。
> **压缩恢复锚点**：恢复时读本文件 + `docs/superpowers/specs/2026-09-20-ontology-business-loop-design.md`（含 Wave1-5 实施记录）+ 本 wave 的 progress.md 账本；分支 PengYip/tools-grouping，基线 = origin/main 07869f3；评审席 cou-2、oracle 终审、fixer 会话见 Background Job Board。

**Goal:** 火运单据词汇贯通流水（重测头号发现）；上传特殊字符文件名健壮性；补上闭环六环验收唯一例外（WRITE_OFF_SETTLEMENT 写入口）。

**Spec:** 主 spec §4 D1 裁决（工作台迁移归 Wave 4→顺延至此）+ §Wave5 实施记录"新发现"节。

## Global Constraints
- 验证 `npm run build && npm run lint && npm test`；零 emoji；本体写入只经 repo 边界；注册表变更须指纹重生成（版本维持 v3）
- 授权状态：用户已授权全程自主（合并/推送/部署/运维自动执行，不逐项确认）
- 火运复测数据在 dev：乐化站 13 单（容器/子单据已拆分），验收账号 acceptance@test.local

## Task 1: 火运词汇流水适配（FLOW_ADAPTERS + 模板提示）
**Files:** `apps/server/src/domain/tradeSemantics.ts`（FLOW_ADAPTERS）、`apps/server/src/pipeline/templateSeed.ts`（数量 hints）、test。
- 现状：轨道衡称重单/铁路大票/货转单/运输凭证 类单据绑定后无流水（重测实证 muant2ur 运输凭证+货权转移 → 0 流水）。
- 要求：a) rg FLOW_ADAPTERS 全量现有 docType 清单；b) 为缺失的火运词汇补货物流适配（轨道衡称重单/铁路大票/货转单/运输凭证/重量凭证；方向按适配表机制——绑定 relation 货权转移 + 既有收发判定逻辑，与收货单/发货单同构）；c) templateSeed 为这些类型补 qtyFields 对应的 fieldHints（合计净重/净重/重量_吨/数量_吨 键已在汽运磅单族适配——对齐即可）；d) 测试：适配表新增行断言 + 火运 docType×货权转移 → flow_type=货物流 的派生用例。
**Commit:** `feat(pipeline): rail vocabulary goods-flow adapters + hints (business-loop wave6)`

## Task 2: 上传特殊字符文件名修复
**Files:** `apps/server/src/routes/files.ts`（:186 上传处理）、test。
- 现状：含 ≥（）等特殊字符的文件名上传 500（重测实证，干净名可绕）。
- 要求：定位 500 根因（MinIO key / INGEST_ROOT 落盘 / assertWithinRoot 哪层炸），最小修复（文件名净化或正确编码），测试：含特殊字符文件名上传 200 + 台账可见。
**Commit:** `fix(routes): upload tolerates special-char filenames (business-loop wave6)`

## Task 3: WRITE_OFF_SETTLEMENT 写入口（闭环最后缺口）
**Files:** `apps/server/src/ontology/writeoffTools.ts`/`writeoff.ts`、`apps/server/src/ontology/index.ts`（如需）、`apps/web/src/components/writeoff/WriteoffView.tsx`、tool-inventory 文案、test。
- 现状：D1 裁决的结算目标核销无产品写入口（读侧已自动纳入=空模式行；写侧 create_writeoff 硬编码 WRITE_OFF→发票）。
- 要求：a) create_writeoff inputSchema 增 target 判别（invoice|settlement，默认 invoice 保持向后兼容）；settlement 分支校验目标为 SettlementEvent 事实 + 写 WRITE_OFF_SETTLEMENT 边（amount params）；b) writeoff.ts 余额域已纳入（R6）核对无改；c) WriteoffView 空模式行隐藏（无该类事实时折叠"结算核销"区块——机械 UI 改动，fixer 可做，保持设计语言）；d) tool-inventory + 工具描述更新；e) 测试：settlement 目标核销落边 + 幂等 + inventory 门禁。
**Commit:** `feat(ontology): create_writeoff settlement target + empty-mode hide (business-loop wave6)`

## Task 4: 收口
- 全量验证 → 合并推送 → dev 部署后火运复测（绑定一轨道衡称重单子单据 → 流水→事实→边自动出现，免回填）→ spec 回填。

## 遗留不做（记入 spec Wave 6 节）
JPG 图像件解析（图像管线专项）、loadLatest 同秒平局其他消费方统一、未挂边事实进 tile① 口径、④⑥ 负值角标、resolveByNo 缓存。
