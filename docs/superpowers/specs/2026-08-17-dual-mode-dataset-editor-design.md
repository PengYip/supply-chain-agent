# 数据集双模式编辑器 (Dual-Mode Dataset Editor) 设计

日期: 2026-08-17
状态: 已与用户确认通过 (双模式表单方案)
关联: docs/superpowers/specs/2026-08-16-eval-run-console-design.md (数据集 CRUD + 编辑器骨架), docs/superpowers/specs/2026-08-14-llm-judge-eval-design.md (场景 schema)

## 1. 背景与目标

现有数据集编辑器 (EvalDatasetEditor) 是 YAML 源码 textarea — 对人不够友好: 嵌套结构
(persona facts / rubric 四档锚点 / verifiers 六类数组 / 审批规则) 全靠缩进与心算。
目标: 同一编辑面板提供「表单 | 源码」双模式 — 表单模式以卡片+分节表单渲染并支持
常规字段编辑, 源码模式保留全量表达力。两模式共享同一份内存 YAML 文本, 无同步漂移。

## 2. 关键决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 深度 | 双模式表单 (预览+常用字段编辑, 长文本仍多行域) | 体验与风险最佳平衡; 纯表单失去表达力 |
| 共享状态 | 单份 YAML 文本, 表单经 `yaml` Document API 写回 | 保留注释往返; 无双状态漂移 |
| core 数据集 | 表单模式只读 (disabled), 源码模式只读显示 | 与后端 PUT 防线一致, 读得舒服改不了 |
| 非法 YAML | 源码 tab 产物解析失败时禁止切表单 (提示错误) | 表单无法承载非法文本 |
| 保存/校验 | 完全复用现有 PUT /api/eval/datasets/:name + 422 透传 | 后端零改动 |
| 依赖 | `yaml` 加入 apps/web dependencies (已在根 lockfile, 零下载) | 前端解析/写回需要 |

## 3. 组件结构

```
EvalDatasetEditor (现有, 改造)
  |- 编辑面板顶部: 「表单 | 源码」mode tab + dirty/保存/422 区 (共用)
  |- DatasetFormView (新, mode='form')
  |    |- 场景手风琴列表 (每场景可折叠; 头部 id + tier 徽章)
  |    |    |- 基本节: id / tier(1-3 下拉) / maxTurns / capability(标签增删)
  |    |    |- Persona 节: facts(条目增删) / disclosure / goal(多行) / patience
  |    |    |- 审批策略节: default(下拉) + rules 表格(tool/ifField/op/value/action 行增删)
  |    |    |- Verifiers 节: 结构化数组(payments/paymentsAbsent/contractLinked 行表格)
  |    |    |                + 字符串数组(mustAppear/forbidden/keywordInReply 标签增删)
  |    |    |- Rubric 节: 维度卡片(name / weight 下拉 / 四档锚点各一多行域)
  |    |                   + veto.hallucination 多行域
  |- 源码 textarea (现有, mode='yaml')
```

- yamlFormBridge (新模块, 非组件): `parseDatasetYaml(text)` → Document + 错误定位;
  `applyField(doc, path, value)` / `appendListItem` / `removeListItem` / `docToText(doc)`。
  表单组件只调 bridge, 不直接摸 yaml 库。
- 表单字段编辑 → bridge 改 Document → docToText → 共享 setText (走现有 dirty 链)。
- 场景增删 (加新场景/删场景) 本期不做 — 复制数据集后改既有场景已覆盖主要用例 (YAGNI)。

## 4. 交互细节

- 模式切换: form→yaml 直接序列化; yaml→form 需解析成功, 失败 toast/红字 + 停留源码 tab。
- dirty / beforeunload / 保存 / 422 红字 / scenarioCount 角标 / 「从此数据集运行」:
  两模式共用, 行为与现状完全一致 (都在编辑器层, 不下放表单组件)。
- 表单内数值字段 (maxTurns/patience/value) 失焦时 coerce number, 非法回退原值。
- 长中文多行文本 (disclosure/goal/锚点/veto) 用 textarea 行高 3-5, 等宽外的正文字体。
- 视觉: 沿用 deepSea/bgGray/borderGray tokens + clsx + lucide-react; 无 emoji/暗色/新 UI 依赖。

## 5. 验收标准

1. web build (tsc+vite) 绿; 全量 npm test 无回归 (390|18); lint 0 新警告。
2. 打开 user 数据集: 表单模式正确渲染全部 9 类字段 (以 core 复制品验证);
   表单改动 (改 goal、加 fact、改锚点、增删 rule/verifier 行) 保存成功且源码 tab 中
   相应内容同步更新, 既有注释保留。
3. 源码 tab 改出非法 YAML → 切表单被拦截并显示解析错误。
4. core 数据集: 表单只读渲染, 所有控件 disabled; 源码只读。
5. 保存 422 (如锚点 key 非法) → 表单模式下同样红字显示完整错误。

## 6. YAGNI 边界

- 场景级增删/重排 (加新场景、删场景、拖拽排序) — 本期不做
- 表单内实时逐字段校验 (仍由保存时服务端 zod 统一校验)
- 撤销/重做、修订历史、diff 视图
- 双向光标映射 (源码行高亮对应表单字段)
- JSON 导入导出
