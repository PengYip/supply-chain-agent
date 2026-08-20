# 第六章 Agent 评估体系 — 本项目应用分析

> 来源：《深入理解AI Agent》第六章（`D:\repo\ai-agent-book\book\chapter6.md`）。本文档把书中评估体系逐项映射到本仓库（branch `feat/doc-ingestion-tool-redesign-phase1` HEAD `8e30647`），标注已有/缺失/可扩展，并给出分层采纳建议。仅分析，不含实现。

## 1. 书中评估体系（精炼）

### 1.1 指标维度
- **能力上限 vs 业务可靠度**：`Pass@k = 1-(1-p)^k`（k 次任一通过即算）与 `Best@k` 对比 `Pass^k = p^k`（k 次连续通过）。例 p=0.6,k=5 → 99.0% vs 7.8%。k 必须连同其采样语义一起报告。
- **过程（白盒）指标**：行动合法率、工具调用正确率（参数语义）、路径效率（步数/冗余动作/回退次数，需人工或启发式基线）、检索覆盖率、**成本与延迟**（请求数、输入/输出/cache token、含 TTFT 的壁钟时间、p95）。
- **安全与合规**：零容忍 / 一票否决（veto）——一次严重违规即整轮失败。
- **鲁棒性**：种子敏感性、页面变更适应、API 抖动容忍、长上下文记忆干扰。
- **轨迹 + 结果双覆盖**：「说了什么/做了什么」对比「系统最终变成什么样」，两者都打分。

### 1.2 方法论
- **Rubric + LLM-as-a-Judge**（Scale AI「Rubrics as Rewards」四原则）：专家落地、含陷阱、权重分级（essential/important/optional/pitfall+veto）、自洽可验证打分档；长度偏差与位置偏差缓解（pair-swap）；**确定性优先聚合**：`if deterministic.veto: FAIL else judge(answer,rubric,evidence)`。
- **多源异质裁判**（对抗 Goodhart 律与同族偏差）、裁判校准（100-200 人工金标注集，kappa≥0.7）、红队对抗、多裁判一致性。
- **Pairwise / Elo / Bradley-Terry** 模型对比。
- **失败归因**：定位**首个**错误（后续均为后果）；6 类错误分类表；结构化 JSON/YAML 归因记录（引用 step/tool/evidence + 根因 vs 后果 + 置信度）。
- **回归两层**：端到端（全任务，查终态+必要产物+安全）与 **trajectory-prefix**（冻结上下文/前缀+环境，模型须产出下一个可观测动作；答案=可接受动作集合）。
- **模型互换**（区分模型能力 vs 线束设计瓶颈）。
- **统计显著性**：`SE(p)≈sqrt(p(1-p)/n)`；**配对分析**（McNemar / paired bootstrap，3-5 固定种子）；多重比较纪律。
- **成本核算**：上下文累积（1k+2k+3k=6k 非 3k）、思考 token、工具结果重复计费；4 开关成本表（前缀稳定 28.3%、压缩 17.5%、组合 30%——非加性）；单任务成本上限。

### 1.3 基础设施与产物
- 数据集模式：`{task, initial_state, prompt, tools, verifier}`；eval 循环伪代码。
- Verifier 环境类型矩阵：SingleTurnEnv / ToolEnv / StatefulToolEnv / SandboxEnv。
- YAML Rubric 示例（4 档 4/3/2/1、`weight: essential/important/veto`、`edge_cases`）。
- τ-bench 用户模拟（渐进式信息披露）；τ²-bench 双控+接地要求。
- 消融总开关（每特性可独立关闭，启动早期注入）、AB 测试（多臂、机制 vs 目标 vs 护栏指标）、特性开关（编译期+运行期）、prompt 敏感回归（确定性渲染、CI 中版本化系统提示）。

---

## 2. 本项目现状

### 2.1 现有 eval（`apps/server/eval/run.ts`，108 行）
- **抽取管道** eval（非 agent eval）：加载 `contracts/ground-truth.json` → 用真实 DeepSeek 模型 → `ingestWithDigital`/`ingestWithMinerU` → `saveDocument` → `extractGroundedFields`。
- 数据集模式：`{ samples: [{ id, path, modality:'digital'|'scanned', docType:'合同', expected: Record<field,value>, traps: string[] }] }`（2 个样本：clean-digital、带金额陷阱的 scanned）。
- 指标（`run.ts:99-105`）：字段抽取准确率（归一化精确匹配）、span 接地率（strength≠none 占比）、引用准确率（citedText 含值占比）、HITL precision/recall（needsReview vs trap fields）。单次运行、控制台打印、无 JSON 产物、无种子、无显著性。

### 2.2 现有可复用基础设施（关键：并非从零）
- **`auditRecorder`**（`auditRecorder.ts:11-20`）：每会话 `ToolCallRecord[]`（toolName/args/result/durationMs/timestamp/sessionId）——正是轨迹评估、失败归因、回归测试所需的证据存储。
- **`runStream` 测试缝**（`RunStreamOpts.{model,deps,userId,sessionId}`，`agent.ts:113-135`）：支持注入模型/依赖做 hermetic agent-loop 评估。
- **Phase 3 的 `<agent_status>` 快照**（`getToolCallCounts`/`countDocuments`/`countPendingApprovals`）：已聚合了过程指标（工具调用次数、待审批数、文档数）。
- **`compression.ts` 的 `FailureTracker` + `makeCircuitBreaker`**：已有连续失败计数（阈值 3，恰与书中经验值「连续 3 次」吻合）。

---

## 3. 逐项差距映射（书中 → 本项目）

| 书中要素 | 本项目状态 | 差距/说明 |
|---|---|---|
| 金标注集（golden set） | ✅ 有 | `ground-truth.json` 2 样本；规模偏小、仅合同、仅抽取场景 |
| 断言式 verifier | ✅ 有 | 字段精确匹配 + span + 引用 + HITL；非 agent 级 |
| 一票否决（veto） | 部分 ✅ | 陷阱字段须触发 needsReview（近 veto 语义）；无显式 veto 聚合层 |
| 零幻觉接地 | ✅ 精神上 | `citedText` 接地率已测 |
| **agent-loop/轨迹评估** | ❌ 缺 | eval 从不调 `runStream`，只测抽取管道 |
| LLM-as-Judge + Rubric | ❌ 缺 | 无 Rubric 文件、无 judge、无权重分级 |
| 失败归因（首错定位） | ❌ 缺 | 有 audit 数据，无归因管线 |
| trajectory-prefix 回归 | ❌ 缺 | 无 |
| 模型互换 | ❌ 缺 | eval 固定 DeepSeek；但 `getModel()` 缝存在可改 |
| 统计显著性（Pass@k/Pass^k、配对、SE） | ❌ 缺 | 单次运行，无种子，无 k 次 |
| 成本/延迟跟踪 | ❌ 缺 | runStream 有 `experimental_telemetry`，但 eval 未聚合 token/cost/p95 |
| 过程指标（路径效率、检索覆盖） | 部分 | `<agent_status>` 已有工具调用次数；无冗余/回退检测 |
| 消融总开关/特性开关/AB | ❌ 缺 | 无 |
| prompt 敏感回归 | ❌ 缺 | SYSTEM_PROMPT 版本化但未 CI 回归 |
| 成本核算（累积/非加性） | ❌ 缺 | 无 |
| 数据集产物 JSON | ❌ 缺 | 仅 console 打印 |

---

## 4. 分层采纳建议

### Tier 1 — 低成本快赢（在现有 `eval/run.ts` + `auditRecorder` 上增量）
1. **结果产物化**：eval 结束写 `eval/results/<timestamp>.json`（每样本：字段准确率/接地率/引用率/HITL、token 消耗、壁钟时间）。非加性成本从 `experimental_telemetry` 聚合。
2. **k 次重复 + Pass@k/Pass^k**：参数化 `--runs K`（默认 3），固定 3-5 种子，输出 `Pass@k` 与 `Pass^k` 两栏 + `SE(p)`。
3. **veto 聚合层**：显式 `deterministic.veto` 优先（陷阱字段未触发 needsReview = veto→FAIL），再叠加现有准确率。

### Tier 2 — 中等投入（新建 agent-level runner）
4. **agent-loop runner**：新 `eval/agent-run.ts` 驱动 `runStream`（注入模型缝 + 固定种子），用 `auditRecorder` 捕获轨迹，跑端到端任务集（不只抽取）。
5. **过程指标**：从 audit 记录算路径效率（步数 vs 基线、重复 (tool,args) 指纹数=冗余、回退次数）、检索覆盖率。
6. **失败归因 v1**：扫 audit 轨迹定位首个失败 tool call，产 YAML 归因记录（step/tool/evidence/root-vs-consequence）。
7. **模型互换**：`eval --model <id>` 切换 DeepSeek/Qwen，区分模型能力 vs 线束瓶颈。

### Tier 3 — 较大投入（评测科学与持续回归）
8. **Rubric + LLM-as-Judge**：建立 YAML Rubric（essential/important/veto/pitfall），judge 模型评分，100-200 人工金标注校准 kappa≥0.7，pair-swap 缓解偏差。
9. **trajectory-prefix 回归**：冻结前缀+环境，断言「下一步可接受动作集合」。
10. **消融总开关 + 特性开关**：启动早期注入，每特性可独立关闭；CI 中版本化 prompt 做敏感回归。
11. **统计严格化**：McNemar/paired bootstrap 做模型对比；多重比较校正。

---

## 5. 推荐起点

**先 Tier 1（1-3 项）**：成本最低、价值确定，且为 Tier 2/3 铺路（产物 JSON 是后续统计与归因的输入；k 次重复是显著性的前提）。Tier 1 全部可在现有 `eval/run.ts` 内增量完成，不碰 agent 线束、不引入新依赖。

**Tier 2（4-7 项）**是「真正评估 agent（而非仅评估抽取）」的关键跃迁——`auditRecorder` + `runStream` 测试缝已就绪，缺口是工具而非管道。

**Tier 3** 在 agent 评测稳定运行后再投入，避免过早优化。

---

## 6. 待决策点
- 评估目标范围：仅「合同抽取+抽取」扩量，还是扩到多 docType / agent 端到端任务？
- 是否引入 judge 模型（Tier 3）——涉及额外 API 成本与校准工作量。
- 评估运行环境：本地 `npm run eval` 够用，还是需 CI 定时跑 + 历史趋势？
