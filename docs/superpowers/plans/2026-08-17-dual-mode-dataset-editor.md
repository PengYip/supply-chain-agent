# 双模式数据集编辑器 (Dual-Mode Dataset Editor) 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 数据集编辑面板增加「表单 | 源码」双模式 — 表单模式以分节卡片渲染并支持常规字段编辑, 源码模式保留; 两模式共享同一份 YAML 文本 (表单经 yaml Document API 写回, 保注释)。

**Architecture:** 纯前端改造。新模块 `yamlFormBridge` 封装 yaml 解析/写回; 新组件 `DatasetFormView` (场景手风琴 + 五个分节) 消费 bridge; 现有 `EvalDatasetEditor` 加 mode tab 与切换守卫。后端零改动 (PUT/422 复用)。

**Tech Stack:** React 19 + Tailwind 3 (既有 tokens) + `yaml` (apps/web 新增依赖, 已在根 lockfile) + clsx + lucide-react。

## Global Constraints

- 无 emoji; 无暗色模式; 无新 UI 依赖 (`yaml` 是唯一新增包, 仅数据层); 前端导入无扩展名; Tailwind 3 默认 spacing (h-5 非 h-4.5)。
- core (builtin) 数据集: 表单模式全控件 disabled, 源码模式只读 — 与后端 PUT 防线一致。
- 保存链完全复用现有: `putEvalDataset` + 422 红字 + dirty/beforeunload/scenarioCount/从此数据集运行, 行为不变。
- 每任务验证: `npm run build --workspace apps/web` 绿 + 全量 `npm test` 无回归 (390|18) + `npm run lint` 0 新警告。
- 场景级增删/重排不做 (spec YAGNI); 逐字段实时校验不做 (服务端 zod 统一)。

---

### Task 1: yamlFormBridge 模块 + yaml 依赖

**Files:**
- Create: `apps/web/src/components/eval/yamlFormBridge.ts`
- Modify: `apps/web/package.json` (+`yaml` dependency, `npm install yaml --workspace apps/web`)

**Interfaces (Produces, T2/T3 消费):**
```ts
import type { Document } from 'yaml';
export interface ParseResult {
  ok: boolean;
  doc?: Document;                      // ok 时必有
  error?: string;                      // 非 ok 时含 yaml 错误信息 (行号若可得)
}
export function parseDatasetYaml(text: string): ParseResult;
export function getIn(doc: Document, path: (string | number)[]): unknown;   // 缺路径返回 undefined
export function setIn(doc: Document, path: (string | number)[], value: unknown): void;
export function appendListItem(doc: Document, listPath: (string | number)[], item: unknown): void;   // listPath 缺失时创建空数组
export function removeListItem(doc: Document, listPath: (string | number)[], index: number): void;
export function docToText(doc: Document): string;
```

**要点 (yaml 库行为, 实现时遵守):**
- `parseDocument(text)` 不抛异常 — 非法 YAML 收在 `doc.errors`; `parseDatasetYaml` 必须检查 `doc.errors.length > 0` 并归入 error 分支 (error 信息含 `errors[0].message`, 有行号则附)。
- `setIn` 对标量/对象字段保注释 (只换值); 数组行增删走「getIn 取整组 → JS 数组改 → setIn 写回整组」策略, 该数组内部的注释会丢 — 可接受, 报告中注明。`appendListItem`/`removeListItem` 即此策略的封装。
- `docToText` = `doc.toString({ lineWidth: 0 })` (长中文行不折行)。
- `getIn` 直接 `doc.getIn(path)`; undefined 安全。

**Steps:**
- [ ] `npm install yaml --workspace apps/web` (确认 package.json 出现, 版本对齐 server 侧 ^2.x)
- [ ] 实现 yamlFormBridge.ts (纯函数, 无 React)
- [ ] 验证: `npm run build --workspace apps/web` 绿; 另跑一次性 tsx 探针 (不提交): 解析 core.yaml 文本 → getIn scenarios[0].id === 't1-order-status' → setIn 改 goal → docToText 含新值且原注释行仍在 → appendListItem facts +1 → removeListItem 还原 → 非法文本 (`id: [unclosed`) 返回 ok:false。探针输出贴报告。
- [ ] `npm test` + `npm run lint` 无回归
- [ ] Commit: `feat(eval-ui): yaml form bridge module for dataset editor`

### Task 2: DatasetFormView 分节表单组件

**Files:**
- Create: `apps/web/src/components/eval/DatasetFormView.tsx` (含分节子组件, 单文件, 预计 300-400 行)

**Interfaces:**
- Consumes: T1 bridge 全部导出; 现有 `Scenario` 数据形态 (apps/server/eval/agent/types.ts 的客户端 JS 视图, 不 import 后端类型, 本地声明宽松 interface)。
- Produces: `DatasetFormView({ text, onChangeText, readOnly }: { text: string; onChangeText(next: string): void; readOnly: boolean })` — text 为共享 YAML 文本; 组件内部 parse 失败时渲染红字错误卡 (不该发生 — 切换已被 T3 守卫, 但防御渲染)。
- 表单编辑流: 局部 `doc` 由 text parse 而来 (useMemo) → 控件 onChange → bridge 改 doc → `onChangeText(docToText(doc))` (走编辑器现有 dirty 链)。

**结构 (散文规格, 遵循仓库视觉惯例 — 卡片/表格/徽章/badge 样式参照 EvalRunReport/EvalEpisodeDetail):**
- 场景手风琴: 每场景一张卡, 头部 id + tier 徽章 + 展开箭头 (ChevronDown/Right); 默认全部折叠, core 副本 9 场景可逐个展开。
- 基本节: id (text) / tier (下拉 1|2|3) / maxTurns (number input, 失焦 coerce, 非法回退) / capability (标签增删 — 输入+添加按钮+每项 X)。
- Persona 节: facts (条目列表, 每条 text + 删; 底部添加) / disclosure (textarea rows 3) / goal (textarea rows 4) / patience (number, coerce 同上)。
- 审批策略节: default (下拉 approve|reject) + rules 表格 (列: tool/ifField/op(下拉六种)/value/action(下拉 approve|reject), 行删, 底部加行 — 新行默认值 tool:'create_payment', ifField:'amount', op:'>', value:0, action:'approve')。
- Verifiers 节: 三个结构化数组小表格 (payments: contractNo+amount; paymentsAbsent: contractNo; contractLinked: contractNo+documentId; 均行增删) + 三个字符串数组标签组 (mustAppear/forbidden/keywordInReply)。
- Rubric 节: 每维度一张子卡 (name text / weight 下拉 essential|important|optional / 锚点四档各一 textarea rows 3, 标签「4 档(优秀)…1 档(不合格)」按 key 排序展示) + veto.hallucination (存在时 textarea rows 3; 不存在不渲染该块)。
- readOnly=true: 全控件 disabled, 列表/表格无增删按钮。
- 数值 coerce: 失焦时 Number(value), NaN 或 <1 → 回退显示原值不写回。

**Steps:**
- [ ] 实现 DatasetFormView (分节子组件同文件)
- [ ] 验证: web build 绿; lint 0 新警告; `npm test` 390|18
- [ ] Commit: `feat(eval-ui): dataset form view sections`

### Task 3: 编辑器集成双模式 + 全量验证

**Files:**
- Modify: `apps/web/src/components/eval/EvalDatasetEditor.tsx` (mode tab + 切换守卫 + core readonly 接线)
- Test: 手动冒烟清单 (报告列出, 控制器后补环境受限项)

**要点:**
- 编辑面板顶部 (保存按钮行下) 加「表单 | 源码」mode state ('form' | 'yaml'), 默认 'form'。
- 切到 form: `parseDatasetYaml(text)` 失败 → 红字显示 error + 停留 yaml tab; 成功 → 渲染 DatasetFormView。
- 切到 yaml: 直接渲染现有 textarea (text 即共享文本)。
- DatasetFormView 的 onChangeText 接现有 setText (dirty/beforeunload/保存链不动)。
- readOnly = builtin (现有 selected.builtin)。
- 打开数据集时 mode 重置为 'form'; 422 红字两模式共用 (位置不动)。
- 手动冒烟清单 (写入报告, 执行环境受阻则声明未冒烟): ①复制 core→my-test, 表单渲染 9 场景全字段; ②表单改 goal/加 fact/改锚点/加 rule 行 → 保存成功 → 源码 tab 相应内容已变; ③源码改非法 → 切表单被拦截; ④core 表单全 disabled; ⑤表单下保存 422 (锚点 key 改非法) 红字可见。

**Steps:**
- [ ] 集成改造 EvalDatasetEditor
- [ ] 验证: web build 绿; `npm test` 390|18; lint 0 新警告
- [ ] 手动冒烟 (或声明未冒烟 + 原因)
- [ ] Commit: `feat(eval-ui): dual-mode dataset editor integration`
