# 图谱 label 防重叠设计（参考 Neo4j Browser）

日期：2026-08-26
状态：已与用户确认设计方向（方案 A）

## 背景与根因

图谱页面（`apps/web/src/components/graph/`）文字重叠严重。现状：

- 库：`@antv/g6` v5.1.1（`apps/web/package.json:14`），radial 布局（`GraphCanvas.tsx:102-109`）。
- 节点 label：`labelPlacement: 'bottom'`、字号 11（`GraphCanvas.tsx:59-62`），**无任何文本防重叠处理**——G6 的 `preventOverlap: true` 只约束节点圆形间距，不作用于 label 文本。
- Document 节点 label 是完整文件名（`businessTypes.ts:85-101` `nodeDisplayName`），普遍很长。
- 边 label：2-3 字中文短词（`edgeLabel`，`GraphCanvas.tsx:81-83`），沿线渲染无衬底，压线可读性差。

结论：径向布局节点密集 + 长文件名 + label 悬浮在节点下方且无碰撞处理 → 相邻节点 label 互相覆盖。

## Neo4j Browser 调研结论（选型依据）

来源：neo4j/neo4j-browser GitHub 源码（`src/neo4j-arc/graph-visualization/`）。

- 技术栈：d3-force@3 子模块 + 纯 SVG，React 只是外壳。无独立可复用 npm 包（组件内嵌仓库，且 Neo4j Browser 为 GPL，直接拷代码有协议传染风险）。
- 它文字不重叠的真正原因不是高级碰撞算法，而是三个朴素做法：
  1. **节点文字画在圆内**：`fitCaptionIntoCircle` 按弦宽（`2*sqrt(r^2-d^2)`）限制每行宽度，多行居中，超长词逐字符截断加省略号（U+2026）。
  2. **forceCollide 保证节点本身不重叠**：collide 半径 = 节点半径 + 25px padding；charge=-400、linkDistance=源半径+目标半径+90。
  3. **边文字沿线中点渲染并按线长截断**，角度 90-270 度时 180 度翻转保持可读；无 label 级碰撞检测。

## 方案选择

- **A（选定）**：保留 G6，移植上述三个诀窍。改动集中、风险低、交互全保留。
- B（否决）：d3-force + SVG 重写渲染层。还原度最高但工作量最大（GPL 不能拷只能重写）、SVG 大图性能不如 canvas。
- C（否决）：换 react-force-graph / Cytoscape / sigma.js 等。label 防重叠能力更弱或需自写，等于换坑。

## 设计（方案 A）

### 1. label 移入节点内部 + 弦宽截断（诀窍 1）

新增纯函数模块 `apps/web/src/components/graph/captionFit.ts`（约 80 行）：

- `fitCaption(name: string, diameter: number, fontSize: number): string`
  - 返回多行文本（`\n` 连接）；输入节点直径与字号。
  - 算法：逐行分配；第 i 行距圆心垂直距离 d，该行宽度上限 = `2*sqrt(r^2-d^2)`；行内按字符累积宽度超限即断行；单"词"（无空格分隔的中文名/文件名视为连续词）超一行宽度时逐字符截断加 U+2026。
  - 字宽近似（确定性、可单测，不用 canvas measureText）：CJK 全角字符 = 1.0em；ASCII/半角 = 0.62em。
  - 行数上限 3 行；达到上限仍有剩余字符时最后一行截断加省略号；空输入返回空串。
- `GraphCanvas.tsx` `toNodes`：
  - `labelPlacement: 'bottom'` → `'center'`；`labelText` 改为 `fitCaption(nodeDisplayName(n, docMeta), size, 11)`。
  - `labelLineHeight` 用紧凑值（约 1.1em）；`labelTextAlign: 'center'`。
  - 文字颜色按 kind：Document 为空心节点（白底）→ 深色 `#374151`；其余实心 → 白色 `#FFFFFF`。
  - 选中态（click-select）保持 G6 默认描边高亮，无需额外处理。

### 2. 节点尺寸按度数自适应 + collision padding（诀窍 2）

- 节点直径 = `clamp(16 + degree * 1.8, 16, 34)`，degree = 当前可见边中该节点出现次数；中心节点 `max(size, 44)`（44 为现状值，保持中心视觉突出）。
- 度数高的节点更大 → 装得下更多文字（Neo4j 同款行为），也天然给布局留出物理间距。
- radial 布局配置（`GraphCanvas.tsx:102-109`）：
  - `nodeSpacing: 24`（节点最小间距，与 nodeSize 相加参与碰撞检测；radial 无 `preventOverlapPadding`，该字段属 d3-force 布局——已对照 `@antv/layout` 5.1 类型定义修正）。
  - `nodeSize` 由常量 30 改为回调，返回各节点真实直径（`nodeSize?: Size | ((node: NodeData) => Size)`），保证防重叠按真实尺寸计算。

### 3. 边 label 白色衬底（诀窍 3 的本地化）

- 边 label 都是短词（交易方/商品/引用/履行/绑定/归属/对手方/参与），保留常显，不做按线长截断（中文 2-3 字无需）。
- 加 `labelBackground: true`（白底 + 圆角 + padding，G6 v5 内建样式），解决文字压线、线穿字。
- 若 spike 发现 5.1.1 的 `labelBackground` 配置形态不同，以 G6 5.1 实际 API 为准（如 `labelBackgroundFill/Radius/Padding` 系列）。

### 边界处理

- 空名/未命名节点：`nodeDisplayName` 已兜底"XX（未命名）"，fitCaption 后仍能显示截断形式。
- 特长文件名：节点内只显示装得下的部分 + `…`；完整名通过 hover/点击 DetailPanel 查看（现状交互保留，非目标里明确不删）。
- `hiddenKinds` 过滤变化时 degree 会变 → 节点尺寸随过滤重算（`toNodes` 本来就在过滤后调用，天然满足）。
- G6 5.1.1 的 `\n` 多行 label 与 labelBackground 支持在实施首步做小 spike 验证；若 `\n` 多行不支持，退化为单行截断（仍解决主要重叠问题）。

### 改动文件

| 文件 | 改动 |
|---|---|
| `apps/web/src/components/graph/captionFit.ts`（新增） | 弦宽截断纯函数 |
| `apps/web/src/components/graph/GraphCanvas.tsx` | label 配置、节点尺寸、布局 padding、边 label 衬底 |
| `apps/web/src/components/graph/captionFit.test.ts`（新增） | 纯函数单测 |

后端、API、hooks（`useGraph.ts`）、其余 graph 组件均不动。

### 验收标准

1. `npm test`（captionFit 单测覆盖：弦宽约束、断行、超长截断加省略号、CJK/ASCII 混合、空输入、行数上限）全绿。
2. `npm run build` + `npm run lint` 全绿。
3. 浏览器实测（dev 数据、depth=2/3、含多个长文件名 Document 节点）：节点文字不再互相覆盖；节点内文字不溢出圆外；边文字有衬底不压线；缩放后仍可读。

### 非目标

- 不换渲染库、不引入 d3-force。
- 不改数据流、API、后端。
- 不加新交互（tooltip、label 开关等）。
- 不处理超大图（depth=5 极端情况）性能优化。

### 验收修订记录（2026-08-26，浏览器验收后）

首轮浏览器验收失败，依据 @antv/g-lite 与 G6 5.1.1 源码查证（lib-2）修订固定值：

- **`labelLineHeight` 是 px 绝对值**（g-lite PropertySyntax.LENGTH），非倍数。`1.1` 会被当作 1.1px 行距导致多行叠死。修订：节点 label 设 `labelLineHeight: 12`（11px 字号 + 1px leading；captionFit 的 `lineHeight: 1.1` 假设 12.1px，0.1px 误差由弦宽内边距吸收）。
- **G6 `Label.defaultStyleProps.maxLines = 1`**（label.js:88），含 `\n` 的 labelText 未显式设置时被截为 1 行。修订：节点 label 显式 `labelMaxLines: 3`。
- **节点直径 `clamp(16+degree*1.8, 16, 34)` 设计性偏小**：弦宽上限 = 直径 − fontSize，16px 节点连 1 个 CJK 都装不下，外围 label 全部退化成 `…`。对齐 Neo4j 的直径/字号比例（约 50/10）：修订为 `clamp(34 + degree*3, 34, 56)`，中心节点 `max(size, 56)`。radial 布局 `nodeSpacing: 24` 不变（`unitRadius: 110` 对 34-56px 节点仍有 ~54px 净距）。
- **边 label 衬底**：`labelBackground*` 系列受支持（EdgeLabelStyleProps extends LabelStyleProps），但 padding 默认 0 使衬底紧贴文字不可辨、`opacity < 1` 会透出边线（G6 issue #7341）。修订：`labelPadding: [2, 4]`、`labelBackgroundOpacity: 1`（原 0.85 作废）、radius 2 不变。
- 已知遗留：中心节点周围短边的 label 可能互相挤压（视觉上"履行用"/"绑定书"是两条边 label 重叠），节点增大+行高修复后复验，仍严重再调边 label placement。
