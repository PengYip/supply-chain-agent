# Skill 注入机制设计（load_skill + 内置技能）

> 日期：2026-08-28。状态：已与用户确认设计，本文档为实现依据。
> 方法论依据：docs/tool-design-methodology.md 第 4 步（Skill 化）。
> 参考实现：D:\repo\fastchain-agent-demo（packages/core/src/tools/skill-tool.ts、
> infra/skill-discovery.ts、routes/chat.ts 的技能索引注入）。按本仓库准则适配，
> 非完全照搬（用户确认）。

## 0. 目标与动机

把"怎么做"的流程知识（如货值暂估/结算计算）从工具面和系统提示词中解耦：
按需加载（渐进式披露），不占常驻工具名额，不进静态前缀烧 token。

首个落地技能：`settlement-valuation`（货值计算：暂估 + 结算）。

## 1. 总体架构：发现 → 索引 → 按需加载（两阶段披露）

```
apps/server/skills/<skill名>/SKILL.md   ← YAML frontmatter(name/description/whenToUse) + 正文
        │
        ├─ 模块加载时扫描一次 → 元数据缓存（frontmatter 三要素 + 相对路径）
        ├─ 索引注入：SYSTEM_PROMPT 静态尾部追加技能清单 + 使用规则（启动后不变，KV cache 稳定）
        └─ load_skill(name)：登记名校验 → 返回 SKILL.md 全文 → 工具结果持久进入对话
```

与参考实现的差异（有意为之）：
- **启动扫一次**，不每轮 `discoverAll()` 扫盘；
- **name 参数**而非任意 path（不暴露任意文件读取原语）；
- **静态索引**拼进 SYSTEM_PROMPT 常量（skills 是部署内置的，清单启动后不变）。

## 2. Skill 文件格式与目录

目录：`apps/server/skills/<skill名>/SKILL.md`（src 与 dist 布局下
`new URL('../../skills/', import.meta.url)` 均解析到 `apps/server/skills/`）。

格式（frontmatter 单行值，不支多行 YAML——边界如实声明）：

```markdown
---
name: settlement-valuation
description: 大宗商品货值计算：暂估（基准价×发运重量）与结算（质量奖罚修正基准价）。
whenToUse: 用户问"这批货值多少钱/暂估/估算/结算多少钱/怎么结"时加载。
---
（正文：流程步骤、计算书规范、缺口处理）
```

## 3. 发现层 `apps/server/src/harness/skillDiscovery.ts`

- zod schema：`Metadata { name, description, whenToUse, path }`、`Definition = Metadata + { content }`。
- `discoverSkills()`：扫 skills 目录一级子目录的 SKILL.md，解析 frontmatter
  （`yaml` 包已是 apps/server 直接依赖 ^2.9.0）；frontmatter 缺失/解析失败 → warn 跳过；
  目录不存在 → 返回空数组，不抛错、不阻塞启动。
- 模块级缓存：首次调用扫描并缓存；测试可用 `resetSkillCache()` 重建。
- `loadSkillByName(name)`：查缓存 → 读文件全文 → 剥离 frontmatter 返回 Definition；
  未登记名返回 null。

## 4. `load_skill` 工具（`apps/server/src/tools/skillTool.ts`）

- 无 DbContext 依赖的静态工具（同 query_orders 挂 BASE 的方式）。
- `inputSchema: z.object({ name: z.string().min(1) })`（AI SDK 6 `inputSchema`）。
- execute：`loadSkillByName` → 命中返回 `{ success: true, name, description, content }`；
  未命中返回 `{ success: false, error: '未登记的技能名: ...' }`（不 throw，withAudit 语义）。
- 描述按五条规范写：何时用（对照系统提示词技能清单）+ 边界（只接受登记名；
  返回的是指导文本，本身不执行计算/写操作）+ 返回结构。
- 挂载：`SCENARIO_CORE`（各场景都可能需要流程知识）；L1 只读。

## 5. 索引注入（agent.ts）

- `skillDiscovery.ts` 导出 `buildSkillIndexSection(): string`：生成
  "## 可用技能（Skills）"清单（每行：name + description + 何时用）+ 四条使用规则
  （命中技能场景必须先 load_skill 再执行；用户问"你有什么技能"时如实列举；
  技能内容是操作指导，执行仍须走业务工具；无技能时返回空串）。
- `SYSTEM_PROMPT = [...业务规则].join('\n') + skillSection`（模块加载时一次性拼接，
  运行期不变）。

## 6. 场景挂载与清单门禁

- `scenarios.ts`：`SCENARIO_CORE` 增加 `load_skill`（4→5）。
- 场景可见数：entry 10→11、qa 9→10、settlement 7→8 —— `docs/tool-inventory.json`
  `policy.maxToolsMountedPerScenario` 10 → **11**（有意识的政策修订，注释说明）。
- `roleToolRegistry.ts`：`BASE_TOOLS_FOR_ROLE.trader` 增加静态 `load_skill`；
  `TRADER_CTX_TOOL_NAMES` 同步加名（保 `listToolNames` 双射）。
- `docs/tool-inventory.json` 新增 `load_skill` 条目（layer=感知, level=L1,
  status=active, mount=always, 三要素齐全）。
- 路由词补充：`SETTLEMENT_RE` 增加 `暂估|货值`（货值暂估/结算同属结算域；
  settlement 视口仍含 CORE，误路由代价小）。

## 7. 首个技能 settlement-valuation（内容大纲）

业务规则（用户提供，2026-08-28）：
1. **暂估**：化验前，按实际发运重量 × 合同基准价估算货值；
2. **结算**：质检报告出具后，按实际质量奖罚修正基准价，得到最终货值。

SKILL.md 正文流程：
- 暂估：query_business(entity=contract) 取基准价 → recall_documents/gather 取重量凭证
  → 算式展示（重量来源、价格出处、分步算式）。
- 结算四步：查合同约定（数量/质量/奖罚规则）→ 查实际数量与质量单据 →
  按规则修正计算 → 输出计算书。取证走 gather_settlement_evidence，确认走 confirm_settlement。
- 计算书规范：规则引用（条款/document_id）+ 分步算式 + 最终结果，每个数字可溯源。
- 缺口处理：缺质检报告只能暂估并如实说明；条款无法解析 → escalate_to_human；
  禁止编造数字（呼应系统提示词硬约束 1/2）。

## 8. 测试与验收

- `test/harness/skillDiscovery.test.ts`：frontmatter 解析、缺失跳过、按名加载、
  未知名 null、目录缺失返回空。
- `test/harness/skillTool.test.ts`：load_skill 命中/未命中形状。
- 既有门禁自动覆盖：toolInventory 双射 + cap=11 + CORE ⊆ 每场景；
  toolInventory.test.ts 场景路由断言补 暂估/货值 → settlement。
- tool-use.json 评估集新增用例：货值暂估/结算问题期望先 load_skill（离线门禁自动生效）。
- 验收顺序：build → lint → test 全绿。

## 9. 错误处理

- 技能目录缺失/扫描失败：返回空清单，索引段为空串，服务正常启动。
- load_skill 未命中：结构化 `{ success:false }` 工具结果，模型可改道 escalate_to_human。
- frontmatter 损坏：discovery 时 warn 跳过，不会进索引（模型调不到坏技能）。
