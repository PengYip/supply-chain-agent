# 评估运行台 + 样例编辑器 (Eval Run Console + Dataset Editor) — Phase 2+3a 设计

日期: 2026-08-16
状态: 已与用户逐节确认通过
关联: docs/superpowers/specs/2026-08-15-eval-results-viewer-design.md (Phase 1 查看器, 已上线)

## 1. 背景与定位

Phase 1 查看器只能看落盘结果; 本期补齐「全程可视化」与「测试样例手动修改」:

- **触发运行**: UI 上选数据集/轮数/场景筛选发起评估, 免 CLI。
- **轨迹直播**: 运行中实时看进度与当前 episode 的对话轨迹逐 turn 出现 (模拟用户发言 / agent 回复 / 工具调用 / 审批), verdict 逐个点亮, 完成后跳标准报告页。
- **样例编辑器**: YAML 源码编辑用户数据集, 保存时 zod 校验 (错误定位到 scenario #N), 支持从 core 复制/新建/删除, 并可「从此数据集运行」。

合并原 Phase 2 (编排) 与 Phase 3a (编辑器) 为一期交付。Phase 3b (多模型对比/趋势/定时) 仍不做。

## 2. 关键决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 分期 | 2+3a 合并 | 用户指定; 两个子系统在同轮 spec 设计 |
| 触发/编辑权限 | 所有登录用户 | 内部小团队, 与查看一致; token 成本自律 |
| 可视化粒度 | 轨迹直播 (episode 内逐 turn) | 「看 agent 考试直播」; runner 每 turn 上报 |
| 编辑器形式 | YAML 源码 (等宽 textarea + 保存校验) | 场景文件 90% 是长中文多行文本 (persona/四档锚点), YAML 块标量可读可编辑; JSONL 长文本转义不可编辑; zod 校验兜住缩进风险。JSONL 适合 results 流式追加, 不适合整文件人工编辑 |
| 触发机制 | 子进程 spawn `tsx eval/agent/run.ts` | dist 不含 eval 代码 (tsc 只编 src/); npm install 含 devDeps; 崩溃隔离; 不侵入生产面 |
| 校验机制 | 子进程 `tsx eval/agent/validate.ts` | 同上; 复用 loadDataset zod 错误信息 |
| 用户数据集位置 | `eval/agent/datasets/user/*.yaml` (gitignored) | CD `git reset --hard` 会抹掉对 tracked core.yaml 的在线修改; untracked+ignored 目录部署安全 |
| 内置 core.yaml | 只读 (可读可复制, 不可 PUT/DELETE) | 同上; 数据集版本与评估结果解耦 |
| 并发 | 单并发锁 (同时 1 个服务器触发的运行), 409 | 真实 token 成本, 防误触双跑; CLI 直跑不受此锁约束 (自然分目录) |
| 事件持久化 | 不做; 内存 ring buffer + SSE | 结果仍走 episodes.jsonl; 重启后 live 404 → UI 显示中断, 磁盘结果不受影响 |

## 3. 架构总览

```
浏览器 ──POST /api/eval/runs──> Hono 服务器 ──spawn──> tsx eval/agent/run.ts (子进程)
   ^                          │  (单并发锁)
   │ SSE /api/eval/runs/:runId/events   │ stdout NDJSON 事件行 (@@EVT@@{json} 前缀)
   └── 实时进度 + 轨迹直播 <─────────────┘ (人类可读日志走 stderr; 内存事件总线)
run 完成 → 子进程 writeResults 落盘 → Phase 1 查看器照常读
```

- **runId 由服务器生成** (保持 `<ISO-stamp>-<dataset>` 目录名格式), 经环境变量 `EVAL_RUN_ID` 传给子进程; runner 用它定 results 输出目录, 保证与注册表/URL 一致。
- **事件协议** (stdout 每行 `@@EVT@@` + JSON):
  `run_started{runId,total}` / `scenario_started{scenarioId,runIndex}` / `turn{scenarioId,runIndex,role,text}` / `tool_call{scenarioId,runIndex,toolName}` / `approval{scenarioId,runIndex,toolName,decision}` / `episode_done{scenarioId,runIndex,verdict,rubricScore?,vetoTriggered}` / `run_done{outDir}` / `run_error{message}`
- **事件总线**: 每运行一个内存数组 (重放用) + 订阅者集合; SSE 先重放缓冲再实时推; run 终态后丢弃。
- **服务器重启**: 注册表内存态丢失 → live 端点 404 → UI 降级显示「运行中断」; 不尝试复活子进程。

## 4. 后端 API

沿用 `/api/eval/*` requireAuth 组门控; 信封 `{ok:true,data}` / `{ok:false,error}`。

### 4.1 运行编排

- `POST /api/eval/runs` body `{dataset, runs, filter?}` → 数据集存在性校验 (core 或 user/*); runs 钳制 1-10; 已有活运行 → **409**; spawn (cwd=apps/server, `npx tsx eval/agent/run.ts --dataset=<ds> --runs=<n> [--filter=<id>]`, env `EVAL_RUN_ID`) → `{runId}`。
- `GET /api/eval/runs/:runId/live` → `{state:'running'|'done'|'error', events:[...已缓冲]}`; 未知/已丢弃 → 404。重连恢复用。
- `GET /api/eval/runs/:runId/events` → SSE (`text/event-stream`, 每 event 一条 `data:`); 对齐 `/api/sessions/:id/events` 先例; cookie 同源鉴权 (EventSource 无法带 header, 现有先例同此)。
- `DELETE /api/eval/runs/:runId` → kill 子进程 + 终态 `run_error{message:'用户中止'}`; 幂等。
- `GET /api/eval/runs` (Phase 1 既有) 响应**增量**增加 `activeRunId: string | null` — 列表页横幅用, 向后兼容。

### 4.2 数据集管理

- `GET /api/eval/datasets` → `{datasets:[{name, builtin, scenarioCount}]}` (core + user/*)。
- `GET /api/eval/datasets/:name` → `{name, yaml, builtin}`。
- `PUT /api/eval/datasets/:name` body `{yaml}` → builtin → 400; 子进程校验失败 → **422** `{error}` (含 loadDataset 的 `scenario #N invalid` 定位); 通过则原子写 (tmp+rename)。
- `POST /api/eval/datasets/:name/copy` → 源存在 + 目标名规则 `^[a-z0-9][a-z0-9-]{0,63}$` + 不覆盖 → `{name}`。
- `DELETE /api/eval/datasets/:name` → builtin → 400。
- name 做与 runId 同级的路径穿越守卫。

### 4.3 runner 改造 (eval/agent/)

- `run.ts`: 主循环内插入事件发射 (stdout `@@EVT@@` 行); 人类日志全部改 stderr; 尊重 `EVAL_RUN_ID` 作为输出目录名; 事件发射函数收到注入 sink (测试缝)。
- `validate.ts` (新): 一次性脚本, `loadDataset(file)` → 成功 stdout `{ok:true,scenarioCount:N}` exit 0; 失败 `{ok:false,error}` exit 1。
- 不改 driver/judge/verifiers 等既有模块 — 事件数据从 run.ts 循环内可见信息构造 (scenario/verdict/rubricScore 在 aggregateScore 后即有; turn 级文本从 artifact 增量收集需 driver 暴露回调 — **driver 增加可选 `onTurn` 回调缝**, 默认不传零影响)。

### 4.4 部署事实 (约束)

- prod 是 `pm2` 单实例 → 内存锁/注册表成立; 扩实例需改 Redis 锁 (YAGNI)。
- spawn 依赖服务器上 devDeps 的 tsx — CI 用 `npm install` (非 `--production`), 已满足。
- Windows dev 与 ubuntu prod 的进程终止差异: `child.kill()`; tsx 为单进程 loader, 直接 kill 即可。

## 5. 前端设计

### 5.1 运行列表页 (Phase 1 页增强)

顶部触发栏: 数据集下拉 (GET /datasets) + runs 数字输入 (1-10) + 可选 filter 文本 + 「运行评估」按钮 → POST 成功跳直播页; 409 → 提示已有运行 + 跳转该运行直播页。
`activeRunId` 非空时列表顶部横幅「评估进行中」+ 链接。

### 5.2 直播页 EvalRunLive

- 头部: 总进度 (N/M episodes + 当前场景名) + 状态徽章 (running/done/error) + 操作 (中止 / 完成后「查看报告」→ Phase 1 报告页)。
- verdict 网格: 每场景一行 × 每轮一格, episode_done 点亮 (复用 VerdictBadge 视觉)。
- 轨迹直播区: 当前 episode 逐 turn 气泡/工具卡/审批卡 — **复用 EvalEpisodeDetail 的渲染件** (MarkdownContent 副本与卡片组件提取为共享或同构复制, 以计划裁决为准); scenario_started 切换清屏。
- SSE 断线: 自动重连 (EventSource 原生) + GET live 重放兜底; 404 → 「运行中断」态。

### 5.3 数据集编辑器页 EvalDatasetEditor

- 工作台顶部 tab: 「结果 / 数据集」。
- 左列: 数据集列表 (core 带「内置·只读」标记) + 新建/复制(core→user)/删除按钮。
- 右侧: 等宽 YAML textarea + 保存按钮 → PUT; 422 错误信息行内红字展示 (含 scenario 定位); 保存成功 toast/角标。
- 「从此数据集运行」快捷按钮 → 跳触发流程 (预选该数据集)。
- 未保存修改离开 → beforeunload 提示。

### 5.4 视觉与工程约束

Tailwind 3 既有 tokens / clsx / lucide-react / 无 emoji / 无暗色 / 无新依赖 / 原生 EventSource / 前端导入无扩展名。hook 沿 refresh+EventSource 模式 (对齐 useSessionEvents)。

## 6. 测试策略

- 后端 hermetic (vitest): 事件行解析器、注册表/锁状态机、数据集 CRUD (校验器注入 fake)、路由测试壳 (直接 set user)、spawn 通过注入 fake runner 工厂 (不真起进程)。
- eval/agent 侧: 事件发射纯函数与 driver onTurn 回调的单元测试 (vitest import, 不依赖 tsc build 覆盖 eval/** — 该缺口已记 follow-up)。
- 前端: build 门 (tsc+vite) + 手动冒烟 (同 Phase 1)。
- 在线冒烟 (人工, 不进 CI): 触发 core 单场景 runs=1 → 直播逐 turn → 报告页可见; 复制改锚点跑通; 坏 YAML 422。

## 7. 验收标准

1. `npm run build && npm run lint && npm test` 全绿 (新增 hermetic 测试纳入)。
2. UI 触发 → 直播页逐 turn 看到轨迹 → verdict 点亮 → 完成后 Phase 1 报告页出现该 run。
3. 复制 core → 修改一个锚点 → 保存通过 → 用该数据集跑一次成功; 写坏缩进 → 保存被拒且显示 `scenario #N` 定位。
4. 并发第二跑 409; DELETE 中止生效; 服务器重启后 live 404 → UI 显示中断, 已完成结果不受影响。

## 8. YAGNI 边界 (本期不做)

- 定时评估 / 多模型对比 / 跨运行趋势 (原 Phase 3b)
- 事件持久化与历史回放 (内存即弃; 结果走 JSONL)
- CLI 直跑的锁约束 / 分布式锁 (单 pm2 实例假设)
- 表单化场景编辑器 / 双向同步 (YAML 源码编辑已定)
- 数据集版本管理 / diff / 回滚 (git 不管 user 目录, 编辑器只保最新)
- SSE 鉴权强化 (cookie 同源即够, 先例一致)
