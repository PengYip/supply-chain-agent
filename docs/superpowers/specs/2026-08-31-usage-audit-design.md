# 用量审计页面（LLM + OCR）设计

日期：2026-08-31 ｜ 状态：已批准（用户口头批准，连续实现）

## 目标

为 LLM 调用与 OCR/解析调用提供统一审计页面：统计用量，LLM 支持每轮 input/output 元数据与截断正文。

## 决策

- 数据来源：**自建审计表**（SQLite raw DDL + PG drizzle 双轨，照 quotas 模式），不依赖 Langfuse API
- 正文：**截断存储**（input/output 各前 2000 字符 + 完整长度字段）
- 权限：**所有登录用户**可见全局统计（requireAuth，无角色体系）

## 数据模型

`llm_calls`：id, session_id, user_id, kind(chat|title|compaction|extraction), model,
input_tokens, output_tokens, total_tokens, input_preview(2000), output_preview(2000),
input_chars, output_chars, duration_ms, finish_reason, status(ok|error), error, created_at

`ocr_calls`：id, session_id, user_id, doc_id, doc_type, file_name, backend(digital|mineru|qianfan),
file_bytes, pages, blocks, duration_ms, status, error, created_at

保留：启动时 DELETE 90 天前数据。

## 采集

`harness/usageAudit.ts` 暴露 recordLlmCall/recordOcrCall，fire-and-forget（失败 console.warn 不阻断主链路）。

- chat：`runSession.ts` 的 `result.totalUsage.then`（usage）+ `result.response`（assistant 文本、耗时）
- title：`titleGen.ts` generateSessionTitle
- compaction：`historyCompaction.ts` 的 LLM 调用
- extraction：字段抽取 LLM 调用点
- OCR：`parseDocument.ts` 统一出口（digital/mineru/qianfan 三后端全覆盖）

## API（`/api/audit`，requireAuth）

- GET /summary?range=7d|30d — 汇总（LLM 按天/kind/model 聚合 tokens+调用数；OCR 页数/文档数/耗时）
- GET /llm?limit&offset&kind&sessionId — LLM 明细分页
- GET /ocr?limit&offset&backend — OCR 明细分页

## 前端

新 ViewId `audit`（navigation.ts + App.tsx + AppNav）。
`components/audit/AuditView.tsx`：汇总卡片 + LLM/OCR 两张明细表（筛选、分页、行展开看截断正文 pre-wrap）。

## 测试

usageAudit 写入单测；/api/audit 路由测试（内存 SQLite，照 share.test.ts 模式）。

## 非目标

成本折算（¥）、Langfuse 跳转、复杂图表。
