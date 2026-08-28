# 模型服务欠费提示 — 设计文档

日期：2026-08-28
状态：已确认（用户批准）

## 背景与目标

模型 API（DeepSeek / 千问，经 `OPENAI_*` 环境变量切换）欠费时，后台 run 抛出
provider 错误，`runManager` emit `run.error` 事件携带原始英文错误文本（如
"Insufficient Balance"），前端在消息列表尾部用通用 `<ErrorMessage>` 显示
"请求出错：Insufficient Balance"——用户不知道发生了什么、该找谁。

目标：欠费发生时，前端对话流内显示专用中文卡片，明确告知用户
**AI 模型服务欠费，请联系管理员充值**。

## 需求决议

- 展示形式：对话流内提示卡片（消息列表尾部，与现有 ErrorMessage 同位置）。
- 持久化：**临时提示**。不写入会话历史，刷新后消失；下次发送若仍欠费会再次出现。
  理由：不污染 LLM 下轮上下文，实现最简单。
- 实现方案：**方案 A — 服务端分类 + 结构化事件 + 前端专用卡片**。
  欠费判定是服务端事实（哪个 provider、什么错误码），服务端分类一次、事件带
  机器可读 `code`，前端只负责展示。

## 现状链路（改动前）

```
streamText 流抛错（provider 欠费）
  -> runSession for-await 抛出
  -> runManager catch: emit { type:'run.error', sessionId, runId, message: 原始err.message }
  -> useSessionEvents: setError(message 字符串)
  -> RealChatView: <ErrorMessage error={new Error(error)} /> 显示原文
```

## 设计

### 1. 服务端：新增 `apps/server/src/harness/providerErrors.ts`

```ts
export interface ProviderErrorInfo {
  code: 'provider_arrears' | null;
  userMessage: string | null;
}
export function classifyProviderError(err: unknown): ProviderErrorInfo;
```

判定信号（命中任一即欠费，覆盖 DeepSeek 与千问/DashScope 的 OpenAI 兼容层）：

- `err.statusCode === 402`（DeepSeek 欠费返回 HTTP 402 "Insufficient Balance"，
  AI SDK 抛 `APICallError`，字段为 `statusCode` / `responseBody`）
- message / responseBody 匹配
  `/insufficient balance|arrearage|欠费|余额不足|exceeded your current quota/i`
  （覆盖 DashScope 的 `Arrearage` code 与 OpenAI 兼容层 quota 文案）

命中时 `userMessage = 'AI 模型服务欠费，请联系管理员充值后重试。'`。
未命中返回 `{ code: null, userMessage: null }`。

### 2. 服务端：`runManager.ts` catch 分支

```ts
const cls = classifyProviderError(err);
await emit({
  type: 'run.error', sessionId, runId,
  message: err instanceof Error ? err.message : String(err), // 保留原文（排障）
  code: cls.code ?? 'run_failed',
  userMessage: cls.userMessage ?? undefined,
});
```

console.error 日志与现状一致。

### 3. 前端：结构化 error 透传

- `useSessionEvents.ts`：
  - `onRunError` 签名扩展为 `(runId, message, meta?: { code?: string; userMessage?: string })`。
  - `error` state 类型从 `string | null` 改为
    `SessionError | null`，其中 `interface SessionError { code?: string; message: string; userMessage?: string }`。
  - 连接永久断开时置 `{ message: '连接已断开' }`；`run.started` 清空（现状不变）。
- `useSessionMessages.ts`：`onRunError` 透传结构化 error；对外暴露的 `error`
  类型同步为 `SessionError | null`。

### 4. 前端：`RealChatView` 欠费卡片

`error?.code === 'provider_arrears'` 时渲染专用卡片（消息列表尾部，
`ErrorMessage` 原位置，替代之）：

- 样式：红色警示（复用 danger 色系 + `AlertCircle` 图标），布局语法与现有
  ErrorMessage 一致。
- 标题：`AI 模型服务欠费`
- 正文：`模型服务商账户余额不足，本轮回复未能生成。请联系管理员为 DeepSeek / 千问账户充值，充值后重新发送消息即可继续对话。`

其他错误（含无 `code` 的老事件）仍走现有 `ErrorMessage`。卡片组件放在
`RealMessageItem.tsx` 内（与 `ErrorMessage` 同文件，姊妹组件）。

### 5. 边界与兼容

- 分类未命中 → `code='run_failed'`，前端走 generic 路径，行为与现状完全一致。
- `run.error` 仅由 `runManager` emit；重放缓冲里的老事件（上线前持久化的）
  无 `code` 字段 → 前端按 generic 处理，不崩。
- title-gen（`titleGen.ts`）也调 LLM，但 fire-and-forget best-effort，
  欠费时静默失败，不额外处理。
- run.error 是瞬态 UI 状态：刷新消失、下次发送若仍欠费复现（需求决议）。
- 工具级错误不抛流（走 tool-error part），本设计只影响 provider 级失败，
  与现有工具错误分类 `errorClassification.ts` 互不干扰。

### 6. 测试

- 服务端：新增 `apps/server/test/harness/providerErrors.test.ts`：
  - 402 状态码命中；DeepSeek "Insufficient Balance" message 命中；
    DashScope `Arrearage` responseBody 命中；千问"欠费"中文命中；
    普通错误（400 invalid args / 网络错误 / 无关文案）不误判。
- 前端：无测试设施（`npm test` 只跑 server vitest），卡片靠
  build + lint 验证。

## 改动清单

| 文件 | 动作 |
|---|---|
| `apps/server/src/harness/providerErrors.ts` | 新增：欠费分类器 |
| `apps/server/src/harness/runManager.ts` | 修改：catch 分支分类 + emit 带 code |
| `apps/web/src/hooks/useSessionEvents.ts` | 修改：error 结构化 + onRunError 签名 |
| `apps/web/src/hooks/useSessionMessages.ts` | 修改：透传结构化 error |
| `apps/web/src/components/RealMessageItem.tsx` | 新增：ArrearsNotice 卡片组件 |
| `apps/web/src/components/RealChatView.tsx` | 修改：按 error.code 分发卡片 |
| `apps/server/test/harness/providerErrors.test.ts` | 新增：分类器单测 |

验证顺序：build → lint → test（CI 同序）。
