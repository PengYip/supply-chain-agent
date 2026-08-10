# 供应链贸易 Agent · 会话上下文移交文档

> 本文档用于把「上下文工程基础设施方案」这段工作的对话上下文无损移交给新会话。
> 新会话（人或 AI）只需读完本文 + `ARCHITECTURE.md` + 飞书文档（见下）即可完整接手。
> 生成时间：见文件修改时间。生成时的活跃任务：上下文工程基础设施方案已落地飞书文档，本会话结束。

---

## 1. 一句话项目定位

大宗商品（能源/化工/金属）供应链贸易 **私有化部署** 企业 AI Agent 原型。核心价值 = **业务语义行动层**——把自然语言映射到可审计的工具调用，而非自由文本闲聊。栈：Vite + React19 前端（原型已实现）；`server/` = Hono + AI SDK 6（ToolLoopAgent）+ DeepSeek + SQLite + Langfuse。

---

## 2. 恢复上下文必读的三个文件（按优先级）

| 顺序 | 文件 | 作用 | 状态 |
|---|---|---|---|
| 1 | `ARCHITECTURE.md`（项目根，~441 行） | **SSOT**。11 节 + 附录 A-D。含 5 原则、3 层架构、L1/L2/L3 权限模型、5 种 HITL 形态、4 层文档库、§11 MVP 蓝图 | 稳定 |
| 2 | 飞书文档「供应链贸易 Agent · 上下文工程基础设施实施方案」<br>URL: https://zcngvwhbtg8y.feishu.cn/docx/QzPwdGDZ8oQkbrxu5Q3cga7vnDc<br>document_id: `QzPwdGDZ8oQkbrxu5Q3cga7vnDc` | 本会话产出。P0–P3 基础设施缺口 + 实施路线表 | 本会话新建 |
| 3 | `docs/context-handoff.md`（本文档） | 对话过程、决策来龙去脉、未决项 | 本会话新建 |

辅助（可选）：第二章原文笔记 `C:\Users\yepeng\AppData\Local\Temp\opencode\ch2_fixed.md`（1116 行，可能已被系统清理，如缺可从 https://bojieli.github.io/ai-agent-book/ 第二章重新取）。

---

## 3. 本会话做了什么（研究路径，按时间）

1. **读第二章**「上下文工程」(bojieli/ai-agent-book, `book/chapter2.md`，~142KB)。
   用 @explorer 子进程（exp-1 / `ses_025f32f88ffeieI63CErSvOMwc`，已完成可复用）提取全文。
2. **对照本项目代码**找缺口：通读 `server/src/harness/agent.ts`（204 行，含 `SYSTEM_PROMPT` / `runStream` / `buildGatedTools`）及 harness/ 全部文件、`routes/`、`pipeline/`、`tools/`、`telemetry/`。
3. **产出缺口分析**（P0–P3 分级）并口头交付。
4. **固化为飞书文档**：`lark-cli docs +create --content @.lark_doc.xml --as user`，用户身份 `ou_50f1d7be8166ac09fcb4c1b96e5b6100`。

---

## 4. 核心结论：上下文工程基础设施缺口（P0–P3）

**第二章的操作模型**：上下文 = 静态前缀（system prompt + tool defs，字节级稳定，永不变）+ 轨迹（user/assistant/tool msgs，只追加）。动态信息永远追加到末尾，绝不编辑前缀。

**本项目已经做对的**（符合第二章规范，无需动）：静态 `SYSTEM_PROMPT`（无动态插值，规避了 `Current time:{{now}}` 反模式）；SOP 流程驱动；标准 API 格式（`convertToModelMessages` + `.chat()`）；`stepCountIs(5)` 迭代上限；数字零幻觉护栏；基于角色的工具子集（`RoleToolRegistry`）；SQLite 会话持久化；Langfuse OTel 可观测。

**需要实施的缺口**：

### P0（红，最紧迫）
- **Agent 状态栏（完全缺失）** — 3–5 人日。
  第二章信息密度最高的能力。上下文窗口是「只有一半的检索引擎」——检索强，但**没有提炼层**；任何关于内容的「结论」（计数、剩余 TODO、约束命中）每次都要从原始记录重算，N 越大越易错。
  做法：在轨迹末尾以 `user` 角色 `<agent_status>` 标签**追加**状态摘要。4 类内容：任务规划/TODO、事件侧信道信息、环境当前状态、可用能力清单。
  **3 条铁律**：(1) 用**代码**维护（regex 级），绝不拿大模型批量总结（若非用 LLM：逐条抽取 + 代码汇总）；(2) 删原始记录前先确认状态栏覆盖了所有会被问到的问题维度（否则断崖式崩塌，Claude 100%→7.6%；新增问题类型 = 数据库改表结构）；(3) 把状态栏准确率当一线生产指标（~10% 容忍度）。两种更新实现：每轮替换（短轨迹/大状态）vs 持久追加（频繁更新/长轨迹）。
- **提示注入防御（完全缺失）** — 3–5 人日。
  上下文层是分层防御第一道。3 招：(1) 来源标记 `<external_content source="...">`；(2) 结构化角色（严格 Chat Template）；(3) 输入清洗（仅辅助）。**须与文档摄取 pipeline 同步**（本项目有 doc ingestion，外部文档即注入面）。

### P1（橙）
- **5 层上下文压缩 + 熔断器（缺失）** — 5–8 人日。
  压缩发生在两次 API 调用之间，不动静态前缀，只动 tool 结果，接近 80% 阈值时批量压缩（不要每轮）。
  5 层（便宜→贵）：(1) tool 结果预算控制（大输出落盘、摘要预览、冻结替换字符串）；(2) 噪声删除；(3) API 层微压缩；(4) 归档式摘要（像 `git log` 不是 `git squash`，按轮）；(5) 全量压缩 + 熔断（连续 N 次失败停）。
  保留优先级：架构决策/约束（绝不压缩）→ 改动文件清单（全留）→ 验证通过/失败（必留）→ 未决 TODO/回滚笔记（必留）→ tool 输出（可删，留 pass/fail）。标识符（UUID/哈希/IP/端口/URL/文件名）逐字保留。
- **DeepSeek `reasoning_content` 续跑验证** — 1–2 人日。**潜在 bug**：DeepSeek V4 要求强制回传 `reasoning_content`（含 tool-call 轮），作者结论「思考不是废料，而是状态」。须验证 AI SDK 6 在 SQLite resume 时是否原样回放 `reasoning_content`，否则续跑会丢中间推理状态。

### P2（蓝）
- **KV Cache 架构约束** — 2–3 人日。按缓存边界拆分提示词（边界前=全局可缓存，边界后=会话特定）；每个运行时条件放在边界前 → 缓存键翻倍（N 个二值条件 → 2^N 键）。冻结替换字符串于首次使用。
- **Agent Skills 渐进式披露（方式三）** — 5–7 人日。当工具数到 13+ 时上。元数据（name+description 几百 token，启动扫描注入）→ 选中后用专用工具加载完整 SKILL.md → 细则文档。`description` 要写成路由条件（Use when / Don't use when + 反例），不是功能介绍。路由与执行分离：Claude Code 生产做法。
- **子 Agent 上下文隔离** — 4–6 人日。隔离优于压缩。把大块探索（如「找付款回调处理」）委托给子 Agent 在自己的上下文里跑，返回几百 token 结论，主 Agent 的 KV 前缀不动。代价：任务描述须自包含。

### P3（灰，持续）
Few-shot 示例打磨（2–3 高质量、固定后字节稳定、绝不动态检索）+ 工具描述打磨（明确边界/示例/协作提示）+ 消融实验方法论（差了就逐个关组件，别整体重写）。

---

## 5. 已交付物

1. **飞书文档**（见 §2 表格第 2 行）——P0–P3 详细方案 + 现状对照表 + 实施路线表。
2. **本文档** `docs/context-handoff.md`。

---

## 6. 未决项 / 已知风险

- **DeepSeek reasoning_content 续跑**（见 P1）——未验证，可能是真实 bug，建议优先排查。
- `server/src/routes/chat.ts` 有**预存在 LSP 错误**：`toDataStreamResponse` 在 AI SDK v6 已移除，需改为 `toUIMessageStreamResponse`。**与上下文工程工作无关，本会话未修**，但接手实施 P0/P1 时大概率要顺带改。
- 飞书文档当时以 `--as user` 创建，权限/可见范围未配置（如要分享需单独设）。
- 第二章原文本地缓存 `ch2_fixed.md` 在 temp 目录，可能被系统清理。

---

## 7. 下一步建议（给接手者）

1. 先读 `ARCHITECTURE.md` §11（MVP 蓝图）确认范围边界。
2. 读飞书文档 §P0 确认状态栏与注入防御的实施细节。
3. 若开始动手：建议从**注入防御**起步（与现有 `pipeline/` doc ingestion 耦合，早做早省事），状态栏紧随其后（收益最大、风险可控、纯追加不碰前缀）。
4. 动手前先验证 P1 的 reasoning_content 续跑 bug——如果是真 bug，会影响所有续跑相关设计。
5. 修 `chat.ts` 的 `toDataStreamResponse`（顺带，不阻塞）。

---

## 8. 环境与工具备忘

- OS: win32；shell: bash；Python: 用 `uv` 管理。
- 代码中**不加 emoji**（CLAUDE.md 规则）。
- 飞书文档操作：`lark-cli docs +create/+fetch/+update --as user`；身份 `ou_50f1d7be8166ac09fcb4c1b96e5b6100`。
- 可复用 explorer session：`ses_025f32f88ffeieI63CErSvOMwc`（第二章提取，已完成）。
- 第二章 9 个配套实验对应 7 类基础设施，详见飞书文档与第二章原文。
