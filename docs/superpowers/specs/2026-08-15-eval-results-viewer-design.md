# 评估结果查看器 (Eval Results Viewer) — Phase 1 设计

日期: 2026-08-15
状态: 已与用户逐节确认通过
关联: docs/superpowers/specs/2026-08-14-llm-judge-eval-design.md (评估系统本体, 已上线)

## 1. 背景与定位

LLM-as-judge 评估系统已交付 (12 commits, d9b0c40): CLI `npm run eval:agent` 将结果写入
`apps/server/eval/agent/results/<stamp>-<dataset>/{episodes.jsonl, report.md}` (gitignored)。
当前只能读文件看结果。目标是一套评估前端工作台, 分三期:

- **Phase 1 (本 spec)**: 只读结果查看器 — 运行列表 / 运行报告 / episode 详情三级页面。
- Phase 2 (后续单独 spec): UI 触发评估运行 + 任务状态/进度/防并发。
- Phase 3 (后续单独 spec): 场景/rubric 在线编辑、多模型对比、跨运行趋势。

本期不引入运行编排; 评估仍由 CLI 触发。

## 2. 关键决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 本期范围 | 只读结果查看器 | 风险最低的地基, 后续期在其上生长 |
| 导航 | App 内切换, 无路由库 | 现有应用无路由 (单屏条件渲染); 三级页面用状态导航; 零新依赖 |
| 权限 | 所有登录用户 | 与现有页面一致, 内部小团队 |
| API 形态 | B 结构化 API (服务端解析聚合) | 解析逻辑有 vitest 保障; 从 episodes.jsonl 重算矩阵, 天然绕开 report.md Tier 列缺陷 (follow-up #2) |
| 轨迹渲染 | 富渲染同构聊天 | 复用 RealMessageItem 模式 (markdown + 工具步骤卡片 + 审批卡片) |
| 前端依赖 | 零新增 | react-markdown/remark-gfm/clsx/lucide-react 已有 |

## 3. 架构总览

```
CLI (不变) ──写──> results/<stamp>-<dataset>/{episodes.jsonl, report.md}
                          |
后端 (新增)               v
  src/routes/evalResults.ts ── 解析/聚合 ──> GET /api/eval/runs
  (requireAuth 显式包住)                    GET /api/eval/runs/:runId/episodes
前端 (新增)
  App.tsx 顶栏「对话/评估」切换 ──> EvalWorkbenchView (三级状态导航)
```

- 解析聚合代码放 `apps/server/src/routes/` 下 (evalResults.ts + 辅助模块),
  落入 tsc `src/**` 检查范围, 不受 eval/** 无类型检查问题影响。
- `report.md` 不是前端数据源; 报告矩阵从 `episodes.jsonl` 服务端重算。

## 4. 后端 API 设计

### 4.1 GET /api/eval/runs

扫描 `apps/server/eval/agent/results/` 下所有 `<stamp>-<dataset>` 目录, 按时间倒序返回:

```ts
interface EvalRunSummary {
  runId: string;            // 目录名, 如 2026-08-15T03-21-07-123Z-core
  startedAt: string;        // ISO, 从目录名解析
  dataset: string;          // core
  episodeCount: number;
  verdictDist: Record<string, number>;   // verdict -> count
  totalTokens: number;      // 各 episode totalUsage.totalTokens 合计
  totalWallMs: number;
  scenarios: EvalScenarioRow[];
}
interface EvalScenarioRow {
  scenarioId: string;
  tier: number | null;      // 从 core.yaml 加载失败则为 null
  verdicts: string[];       // 每轮 verdict, 顺序即 run 顺序
  passAt1: boolean;         // 首轮 pass
  passConsecutiveK: boolean; // 全轮连续 pass (runs.length === k 全部通过)
  avgRubricScore: number | null;  // null 当全轮均无 rubricScore
  totalTokens: number;
  avgWallMs: number;
}
```

tier 获取: 路由模块内自包含读取 `apps/server/eval/agent/datasets/<dataset>.yaml` 并解析出
`{scenarioId, tier}` 映射 (仅用 `yaml` 依赖做轻量解析, 不 import `eval/**` 模块 — tsconfig
`rootDir: src` 约束下 src 不能依赖 eval); 数据集文件缺失/解析失败时 tier 为 null, 接口不报错
(评估结果与数据集版本可能已分离)。

### 4.2 GET /api/eval/runs/:runId/episodes

解析该 run 的 episodes.jsonl, 返回类型化 view model 数组:

```ts
interface EvalEpisodeView {
  scenarioId: string;
  runIndex: number;
  verdict: string;
  vetoTriggered: boolean;
  rubricScore: number | null;
  judgeConfidence: number | null;
  judgeDimensions: { name: string; score: number; rationale: string }[];
  verifierFailures: { check: string; detail: string }[];
  simError: string | null;
  approvals: { toolName: string; level: string; decision: string; matchedRule: string | null; reason: string }[];
  toolCalls: { toolName: string; args: unknown; result: unknown; durationMs: number | null }[];
  totalUsage: { inputTokens: number; outputTokens: number; totalTokens: number } | null;
  wallMs: number;
  turnsUsed: number;
  transcript: TranscriptSegment[];
}
type TranscriptSegment = { kind: 'text'; role: 'user' | 'assistant' | 'system'; content: string };
```

transcript 只含文本分段: `artifact.transcript` 是 `{role, text}` 数组, 无工具/审批的交错锚点,
无法忠实地内联插卡 (不虚构顺序); 工具调用与审批以独立数组返回, 前端在聊天列下方以卡片区呈现
(见 §5.2)。system-note 映射为 role=system。

错误信封遵循仓库惯例: 成功 `{ok:true, data}`, 失败 `{ok:false, error}` (404: runId 不存在;
500: JSONL 行损坏 — 单行损坏跳过该行并在 data.droppedLines 计数, 不整体失败)。

### 4.3 挂载与守卫

对齐 sibling 路由模式 (sessions/files/review): `index.ts` 中
`app.use('/api/eval/*', requireAuth)` 统一门控 + `app.route('/api/eval', evalResultsRoute)`
挂载; 路由文件内不重复门控。401 响应体为现有 `{error: 'unauthorized'}` (auth-middleware.ts)。
results 根目录定位: 路由模块内 `resolve(__dirname, '../../eval/agent/results')`
(dev: src/routes → apps/server; prod: dist/routes → apps/server), 测试经工厂函数注入 tmp 根。

### 4.4 测试 (vitest, hermetic)

- tmp 目录写 fixture JSONL + 目录名, 覆盖: 多 run 排序、verdict 分布、Pass@1/Pass^k、
  均分 (含全 null)、tier null 降级、损坏行跳过、transcript 三类分段、404。
- 不触网, 不依赖真实 results/ 目录。

## 5. 前端设计

### 5.1 壳与导航

- `App.tsx`: 登录分支内加顶层视图状态 `view: 'chat' | 'eval'`, 顶栏切换按钮
  (图标 + 文案「评估」, 遵循现有 header 按钮样式)。chat 壳不动。
- `EvalWorkbenchView` 内部三级状态: `{page:'runs'} | {page:'report', runId} | {page:'episode', runId, episodeIdx}`
  + 面包屑返回。无 URL 路由 (决策表)。

### 5.2 页面

1. **EvalRunsList** — 表格: 开始时间 / 数据集 / episode 数 / verdict 分布条
   (水平堆叠色条, 图例) / totalTokens。空态: 引导文案 + CLI 命令代码块。
2. **EvalRunReport** — 顶部汇总卡 (verdict 分布、总 token、总耗时) + 场景矩阵表
   (scenarioId, tier 徽章, verdict 芯片序列, Pass@1, Pass^k, 均分, tokens);
   点击场景行 → 该场景 episode 列表 (简化行: runIndex, verdict 芯片, 均分)。
3. **EvalEpisodeDetail** — 左: 聊天列 (user/assistant 气泡 + MarkdownContent; system-note
   以居中灰字小条呈现; 下方追加「工具调用」卡片区与「审批记录」卡片区, 复用 RealToolStep /
   SoftGateCard / BlockedCard 的视觉语言); 右: 信息栏 (verdict 大徽章, judge 维度列表
   name+score+rationale, verifier 失败红卡, usage/turns/耗时)。

### 5.3 API 层与 hooks

- `src/api/eval.ts`: `listEvalRuns()` / `getEvalRunEpisodes(runId)`, fetch 信封 +
  中文错误消息, 对齐 `src/api/process.ts` 模式。
- `src/hooks/useEvalRuns.ts` / `useEvalRunEpisodes.ts`: `refresh()` useCallback +
  mount effect 模式, 对齐 useSessions。

### 5.4 视觉规范

- Tailwind tokens: 主色 deepSea, 背景 bgGray, 卡片白底 rounded-lg border-borderGray。
- 状态色: pass → success, fail → danger, veto → danger (加强样式, 加 VETO 标),
  needs_human_review → warning, sim_error/judge_error → textGray (机器故障非模型问题)。
- clsx 条件类, lucide-react 图标, tabular-nums 数字列, 无 emoji, 无暗色模式, 无新依赖。

## 6. 验收标准

1. `npm run build && npm run lint && npm test` 全绿 (后端新增测试纳入)。
2. 跑一次 `npm run eval:agent --workspace apps/server -- --filter=t1-order-status --runs=1` 后,
   UI 运行列表出现该 run; 报告矩阵 Tier 列正确显示 tier=1 (非 `-`);
   episode 详情可见完整轨迹、工具步骤、审批记录、judge 评分。
3. 未登录访问 /api/eval/* 返回 401; 登录后正常。
4. results/ 为空时前端显示引导空态, 不报错。

## 7. YAGNI 边界 (本期不做)

- 触发评估运行 / 任务进度 / 防并发 (Phase 2)
- 场景/rubric 编辑、多模型对比、趋势历史 (Phase 3)
- 自动刷新 / WebSocket 推送 (Phase 2 随编排引入)
- 前端单元测试 (现有前端零测试基建, 本期以手动冒烟验收; 不为此引入测试栈)
- report.md 的渲染或修正 (矩阵已由 JSONL 重算; follow-up #2 随之收敛)
- 分页/虚拟滚动 (单 run 数据量小; 列表分页留待数据量证明需要)
