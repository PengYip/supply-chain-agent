# 图谱 label 防重叠（Neo4j Browser 思路）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消除图谱页文字重叠：节点 label 画入圆内并按弦宽截断（Neo4j Browser 同款）、节点按度数自适应尺寸、布局加节点间距、边 label 加白色衬底。

**Architecture:** 保留 @antv/g6 v5.1.1 与现有 radial 布局/交互，只改渲染层参数与 label 文本生成。新增纯函数模块 `captionFit.ts`（弦宽截断，确定性、可单测），`GraphCanvas.tsx` 用它生成多行 labelText 并调整尺寸/间距/衬底。

**Tech Stack:** React 19 + TypeScript + @antv/g6 5.1.1 + vitest 4（web 侧新引入，与 apps/server 的 ^4.1.10 对齐）。

**Spec:** `docs/superpowers/specs/2026-08-26-graph-label-overlap-design.md`

## Global Constraints

- 代码中禁止 emoji（仓库惯例，含测试与注释）。
- 完成顺序必须 build → lint → test 全绿后才算完成（与 CI 一致）。
- 不换渲染库、不改数据流/API/后端、不加新交互。
- 字号 11、行高 1.1、行数上限 3、节点直径 `clamp(16 + degree*1.8, 16, 34)`、中心节点 `max(size, 44)`、布局 `nodeSpacing: 24`（spec 固定值）。
- radial 布局没有 `preventOverlapPadding` 选项（那是 d3-force 的）；节点间距用 `nodeSpacing`，碰撞尺寸用 `nodeSize` 回调（已对照 `node_modules/@antv/layout/lib/algorithm/types.d.ts` 与 `radial/types.d.ts`）。
- `apps/web` 的 tsc 构建 `include: ["src"]`，`verbatimModuleSyntax` + `erasableSyntaxOnly` 开启：src 下新文件不得用 enum/namespace，类型导入必须 `import type`。
- 测试文件放 `apps/web/test/`（对齐 apps/server 的 test/ 惯例，且不进 tsc 构建）。
- 注释风格沿用现有文件：中文、说明"为什么"。

---

### Task 1: vitest 测试基建 + captionFit 弦宽截断纯函数（TDD）

**Files:**
- Modify: `apps/web/package.json`（devDependencies + test script）
- Modify: `package.json`（根，test 脚本纳入 web）
- Create: `apps/web/src/components/graph/captionFit.ts`
- Test: `apps/web/test/captionFit.test.ts`

**Interfaces:**
- Consumes: 无（纯函数，无依赖）
- Produces:
  - `fitCaption(name: string, options: { diameter: number; fontSize: number; maxLines?: number; lineHeight?: number }): string` — 返回 `\n` 连接的多行文本；空输入返回 `''`
  - `charEmWidth(ch: string): number` — 单字符宽度（em 倍数）：CJK/全角 = 1.0，其余 = 0.62
  - Task 2 的 GraphCanvas 将消费这两个函数。

- [ ] **Step 1: 给 apps/web 安装 vitest 并加 test script**

在仓库根执行：

```bash
npm install -D vitest@^4.1.10 --workspace apps/web
```

Expected: 安装成功，无 peer 冲突（web 已有 vite ^8.1.1，vitest 4 自带兼容 vite）。

编辑 `apps/web/package.json` scripts，加一行（dev 之前即可）：

```json
"scripts": {
    "test": "vitest run",
    "dev": "vite",
```

编辑根 `package.json` 第 16 行：

```json
"test": "npm test --workspace apps/server && npm test --workspace apps/web",
```

（CI 跑根 `npm test`，这样 web 测试进 CI。）

- [ ] **Step 2: 写失败测试**

创建 `apps/web/test/captionFit.test.ts`：

```ts
// captionFit 弦宽截断纯函数单测。数值断言基于:
// padding = fontSize*0.5, CJK 字宽 = 1.0*fontSize, ASCII = 0.62*fontSize。
import { describe, expect, it } from 'vitest';
import { charEmWidth, fitCaption } from '../src/components/graph/captionFit';

describe('charEmWidth', () => {
  it('CJK 与全角为 1.0, ASCII 为 0.62', () => {
    expect(charEmWidth('甲')).toBe(1);
    expect(charEmWidth('。')).toBe(1); // 0x3002 CJK 标点
    expect(charEmWidth('Ａ')).toBe(1); // 0xFF21 全角
    expect(charEmWidth('A')).toBe(0.62);
    expect(charEmWidth('5')).toBe(0.62);
  });
});

describe('fitCaption', () => {
  it('空输入返回空串', () => {
    expect(fitCaption('', { diameter: 30, fontSize: 11 })).toBe('');
  });

  it('短名单行原样返回', () => {
    // 直径30/字号11: 中心行宽 = 30 - 11 = 19px; 单个 CJK 11px、两个 ASCII 13.64px 均可容纳
    expect(fitCaption('甲', { diameter: 30, fontSize: 11 })).toBe('甲');
    expect(fitCaption('AB', { diameter: 30, fontSize: 11 })).toBe('AB');
    // 直径44: 中心行宽 33px, 恰好 3 个 CJK
    expect(fitCaption('一二三', { diameter: 44, fontSize: 11 })).toBe('一二三');
  });

  it('超长文本断行为多行', () => {
    // 直径44: L=1 装 3 字装不下 9 字, L=2 每行仅 2 字(31.3px), L=3 装下 7 字(2+3+2)
    const out = fitCaption('一二三四五六七八九', { diameter: 44, fontSize: 11 });
    const lines = out.split('\n');
    expect(lines.length).toBe(3);
    expect(lines[0]).toBe('一二');
    expect(lines[1]).toBe('三四五');
    expect(lines[2]).toBe('六七');
  });

  it('装不下时行数不超过上限且末行以省略号结尾', () => {
    // 直径30: L=2 每行 1 个 CJK(共2字)为最大容量, 8 字输入必然截断
    const out = fitCaption('一二三四五六七八', { diameter: 30, fontSize: 11 });
    const lines = out.split('\n');
    expect(lines.length).toBeLessThanOrEqual(3);
    expect(lines.at(-1)?.endsWith('…')).toBe(true);
  });

  it('ASCII 单行容纳数多于 CJK', () => {
    const cjk = fitCaption('一二三四五六七八九十一二三', { diameter: 30, fontSize: 11 });
    const ascii = fitCaption('abcdefgh', { diameter: 30, fontSize: 11 });
    expect(ascii.split('\n')[0]!.length).toBeGreaterThan(cjk.split('\n')[0]!.length);
  });

  it('极小节点不产生 NaN 且不崩溃', () => {
    const out = fitCaption('测试', { diameter: 8, fontSize: 11 });
    expect(typeof out).toBe('string');
    expect(out).not.toContain('NaN');
    expect(out).not.toContain('undefined');
  });

  it('maxLines 可收紧为单行截断', () => {
    const out = fitCaption('一二三四五', { diameter: 44, fontSize: 11, maxLines: 1 });
    expect(out).not.toContain('\n');
    expect(out.endsWith('…')).toBe(true);
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

```bash
npm test --workspace apps/web
```

Expected: FAIL — `Failed to resolve import "../src/components/graph/captionFit"`（模块不存在）。

- [ ] **Step 4: 写 captionFit 实现**

创建 `apps/web/src/components/graph/captionFit.ts`：

```ts
// 节点圆内文字截断(Neo4j Browser fitCaptionIntoCircle 思路的确定性重实现):
// 每行宽度上限 = 该行垂直偏移处的弦宽 - 水平内边距; 装不下断行,
// 达到行数上限仍有剩余则末行截断加省略号(U+2026)。
// 字宽用 em 近似(CJK=1.0/其余=0.62)而非 canvas measureText: 确定性、可单测。

const ELLIPSIS = '…';
/** 浮点容差: 抵消 0.62*11 这类乘法的表示误差(如 13.640000000000014)。 */
const EPSILON = 1e-6;

/** 单字符显示宽度(em 倍数): CJK 统一表意/标点/全角形式 = 1.0, 其余(ASCII/半角) = 0.62。 */
export function charEmWidth(ch: string): number {
  const code = ch.codePointAt(0) ?? 0;
  const cjk =
    (code >= 0x2e80 && code <= 0x9fff) || // CJK 部首~统一表意(含 0x3000 段标点)
    (code >= 0xf900 && code <= 0xfaff) || // CJK 兼容表意
    (code >= 0xff00 && code <= 0xffef); // 全角形式
  return cjk ? 1 : 0.62;
}

export interface FitCaptionOptions {
  /** 节点直径(px)。 */
  diameter: number;
  /** 字号(px)。 */
  fontSize: number;
  /** 行数上限, 默认 3。 */
  maxLines?: number;
  /** 行高倍数, 默认 1.1(与 G6 labelLineHeight 保持一致)。 */
  lineHeight?: number;
}

/** 距圆心垂直偏移 offset 处的内接弦长; 圆外返回 0。 */
function chordWidth(radius: number, offset: number): number {
  const sq = radius * radius - offset * offset;
  return sq <= 0 ? 0 : 2 * Math.sqrt(sq);
}

/** lineCount 行布局下第 i 行的可用宽度(px): 行中心偏移处的弦宽减两侧内边距。 */
function lineWidthAt(radius: number, fontSize: number, lineCount: number, i: number): number {
  const offset = Math.abs(i - (lineCount - 1) / 2) * fontSize * (lineCount > 1 ? 1.1 : 1);
  return Math.max(chordWidth(radius, offset) - fontSize, 0);
}

/**
 * 按每行宽度上限把文本贪心分批成行。
 * @param reserveEllipsis 末行为省略号预留 1em 宽度(截断模式); false 用于试探能否完整容纳。
 */
function greedyWrap(
  chars: string[],
  widths: number[],
  fontSize: number,
  reserveEllipsis: boolean,
): string[] {
  const lines: string[] = [];
  let rest = chars;
  for (let i = 0; i < widths.length; i += 1) {
    const isLast = i === widths.length - 1;
    const cap = isLast && reserveEllipsis ? widths[i]! - fontSize : widths[i]!;
    let w = 0;
    let count = 0;
    while (count < rest.length) {
      const next = charEmWidth(rest[count]!) * fontSize;
      if (w + next > cap + EPSILON) break;
      w += next;
      count += 1;
    }
    lines.push(rest.slice(0, count).join(''));
    rest = rest.slice(count);
    if (rest.length === 0) break;
  }
  if (rest.length > 0 && reserveEllipsis) {
    // 仍有剩余: 末行截断加省略号(cap<=0 时末行退化为单独的省略号)
    const last = lines.length - 1;
    lines[last] = `${lines[last]}${ELLIPSIS}`;
  }
  return lines;
}

/** 把名字裁进圆内: 完整装下时返回最小行数的断行结果; 否则取容量最大的行数截断加省略号。 */
export function fitCaption(name: string, options: FitCaptionOptions): string {
  const { diameter, fontSize, maxLines = 3, lineHeight = 1.1 } = options;
  if (!name) return '';
  const radius = diameter / 2;
  const chars = Array.from(name); // 按码点切分, 避免拆散代理对

  const widthsFor = (lineCount: number): number[] => {
    const widths: number[] = [];
    for (let i = 0; i < lineCount; i += 1) {
      const offset = Math.abs(i - (lineCount - 1) / 2) * fontSize * lineHeight;
      widths.push(Math.max(chordWidth(radius, offset) - fontSize, 0));
    }
    return widths;
  };

  // 1) 最小行数完整容纳
  for (let lc = 1; lc <= maxLines; lc += 1) {
    const lines = greedyWrap(chars, widthsFor(lc), fontSize, false);
    if (lines.join('').length === chars.length) return lines.join('\n');
  }
  // 2) 装不下: 取放置字符最多的行数, 末行截断加省略号
  let best = 1;
  let bestPlaced = -1;
  for (let lc = 1; lc <= maxLines; lc += 1) {
    const placed = greedyWrap(chars, widthsFor(lc), fontSize, false).join('').length;
    if (placed > bestPlaced) {
      bestPlaced = placed;
      best = lc;
    }
  }
  return greedyWrap(chars, widthsFor(best), fontSize, true).join('\n');
}
```

注意：上面 `lineWidthAt` 是给读者理解用的重复展示，实现里**不要**包含它（`widthsFor` 内联了同样逻辑）——创建文件时只保留 `charEmWidth` / `chordWidth` / `greedyWrap` / `fitCaption` 四个成员。

- [ ] **Step 5: 跑测试确认通过**

```bash
npm test --workspace apps/web
```

Expected: PASS — `Test Files  1 passed`, 8 个用例全绿。

若 `一二三四五六七八九`（直径44）用例失败，手算复核：L=1 行宽 33(3字) 不够；L=2 偏移 ±6.05 弦宽 42.3-11=31.3(2字)；L=3 偏移 0/±12.1 → 33/25.76/25.76 → 2+3+2=7 字 < 9 → 截断模式 best=3，末行 cap=25.76-11=14.76 → 1 字 + …。即期望 `一二\n三四五\n六…`。**以手算为准修正测试断言**（断言 `lines[2]` 为 `'六…'`），算法常数不动。

- [ ] **Step 6: 确认根测试链与类型构建**

```bash
npm test
```

Expected: server 全部测试 + web 8 个用例全绿（web 的 captionFit.ts 在 `src/` 内会进 tsc，但本步只跑测试；类型检查在 Task 2 的 build 里覆盖——captionFit.ts 无外部依赖，`tsc -b` 应直接通过）。

- [ ] **Step 7: Commit**

```bash
git add apps/web/package.json apps/web/package-lock.json package.json package-lock.json apps/web/src/components/graph/captionFit.ts apps/web/test/captionFit.test.ts
git commit -m "test(web): 引入 vitest 与 captionFit 弦宽截断纯函数(Neo4j Browser 圆内文字思路)"
```

（若根目录无独立 package-lock 变更则去掉对应路径；workspaces 共享一个 lock 文件时通常会有。）

---

### Task 2: GraphCanvas 接入——label 入圆、度数自适应尺寸、布局间距、边 label 衬底

**Files:**
- Modify: `apps/web/src/components/graph/GraphCanvas.tsx`（`toNodes`/`toEdges` 重构为 `buildData`，layout 与边样式调整）

**Interfaces:**
- Consumes: Task 1 的 `fitCaption(name, { diameter, fontSize })`
- Produces: 无对外新接口（组件 props 契约不变）

- [ ] **Step 1: 用 buildData 替换 toNodes/toEdges**

`GraphCanvas.tsx` 中删除 `toNodes`（45-65 行）与 `toEdges`（67-87 行）两个函数，替换为：

```tsx
  // 度数自适应 + label 画入圆内(spec 2026-08-26 §2): 度数高=连接多=节点大,
  // 大节点装得下更多文字且给布局留出物理间距(Neo4j Browser 同款行为)。
  // label 原本悬浮在节点下方(labelPlacement:'bottom'), radial 布局节点密集时
  // 相邻 label 互相覆盖且 G6 preventOverlap 只约束节点圆形、不管文本。
  const buildData = (nodes: GraphNode[], edges: GraphEdge[]) => {
    const visibleNodes = nodes.filter((n) => !hiddenKinds.has(n.kind));
    const visibleIds = new Set(visibleNodes.map((n) => n.elementId));
    const visibleEdges = edges.filter(
      (e) => visibleIds.has(e.srcId) && visibleIds.has(e.dstId),
    );
    const degree = new Map<string, number>();
    for (const e of visibleEdges) {
      degree.set(e.srcId, (degree.get(e.srcId) ?? 0) + 1);
      degree.set(e.dstId, (degree.get(e.dstId) ?? 0) + 1);
    }
    const sizeOf = (n: GraphNode): number => {
      const base = Math.min(Math.max(16 + (degree.get(n.elementId) ?? 0) * 1.8, 16), 34);
      return n.elementId === centerElementId ? Math.max(base, 44) : base;
    };
    const g6Nodes = visibleNodes.map((n) => {
      const bt = businessTypeOf(n.kind);
      const size = sizeOf(n);
      // Document=空心(描边家族区分, 深色文字), 实体=实心(白色文字)
      const hollow = n.kind === 'Document';
      return {
        id: n.elementId,
        // data.size 供 radial 布局的 nodeSize 回调读取(碰撞检测按真实尺寸)
        data: { kind: n.kind, name: n.name, props: n.props, rawNode: n, size } as CanvasDatum,
        style: {
          size,
          fill: bt.color,
          ...(hollow ? { fill: '#FFFFFF', lineWidth: 2, stroke: bt.color } : {}),
          labelText: fitCaption(nodeDisplayName(n, docMeta), { diameter: size, fontSize: 11 }),
          labelPlacement: 'center' as const,
          labelFill: hollow ? '#374151' : '#FFFFFF',
          labelFontSize: 11,
          labelLineHeight: 1.1,
          labelTextAlign: 'center' as const,
        },
      };
    });
    const g6Edges = visibleEdges.map((e) => {
      const override = EDGE_STYLE_OVERRIDES[e.type];
      return {
        id: e.elementId,
        source: e.srcId,
        target: e.dstId,
        data: { kind: e.type, name: e.type, props: e.props, rawEdge: e } as CanvasDatum,
        style: {
          stroke: override?.color ?? '#94A3B8',
          lineWidth: 1,
          ...(override?.dashed ? { lineDash: [4, 3] } : {}),
          labelText: edgeLabel(e.type),
          labelFontSize: 10,
          labelFill: '#6B7280',
          // 白色衬底: 边文字不再被线穿过(label shape 的 background 系列样式)
          labelBackground: true,
          labelBackgroundFill: '#FFFFFF',
          labelBackgroundRadius: 2,
          labelBackgroundOpacity: 0.85,
          endArrow: true,
        },
      };
    });
    return { nodes: g6Nodes, edges: g6Edges };
  };
```

同时在文件头 import 区加入（`businessTypes` 那一行之后）：

```tsx
import { fitCaption } from './captionFit';
```

- [ ] **Step 2: 更新建图 effect 的调用与 layout 配置**

建图 effect（原 90-113 行区域）中，把

```tsx
    const nodes = toNodes(subgraph.nodes);
    const nodeIds = new Set(nodes.map((n) => n.id));
    const edges = toEdges(subgraph.edges, nodeIds);
```

改为：

```tsx
    const { nodes, edges } = buildData(subgraph.nodes, subgraph.edges);
```

layout 配置（原 102-109 行）改为：

```tsx
      layout: {
        type: 'radial',
        focusNode: centerElementId ?? undefined,
        unitRadius: 110,
        linkDistance: 90,
        preventOverlap: true,
        // 防重叠按各节点真实直径(data.size) + 24px 最小间距计算;
        // 原来固定 nodeSize:30 与实际尺寸脱节, 大节点仍会被挤到一起。
        nodeSpacing: 24,
        nodeSize: (d: NodeData) => (d.data as CanvasDatum | undefined)?.size ?? 30,
      },
```

- [ ] **Step 3: 更新 hiddenKinds effect 的调用**

原 178-180 行：

```tsx
    const nodes = toNodes(subgraph.nodes);
    const nodeIds = new Set(nodes.map((n) => n.id));
    const edges = toEdges(subgraph.edges, nodeIds);
```

改为：

```tsx
    const { nodes, edges } = buildData(subgraph.nodes, subgraph.edges);
```

（类型过滤后 degree 变化 → 节点尺寸随过滤重算，语义与 spec 一致。）

- [ ] **Step 4: build 验证类型**

```bash
npm run build
```

Expected: web `tsc -b && vite build` 与 server `tsc` 均成功。若 `nodeSize` 回调参数类型报错，用 `import type { NodeData }` 已有的类型（文件头已 import `NodeData`，确认未被 `noUnusedLocals` 报错即可——它在建图 effect 里还在用）。

- [ ] **Step 5: lint + 全量测试**

```bash
npm run lint
npm test
```

Expected: oxlint 0 错误；server + web 测试全绿。

- [ ] **Step 6: 浏览器目检（验收标准）**

前提：本地或共享 dev 环境（前端 :5173 代理 /api → :3001；若本地后端无 Neo4j 图数据，连 10.10.0.2 的 dev 环境页面目检）。不要重复启动已在运行的前端 dev server。

1. 打开图谱页，选一个有多文档的 subject，depth=2。
2. 核对三项：
   - 节点文字在圆内、不互相覆盖；长文件名显示为多行 + `…`。
   - 度数高的节点明显更大；中心节点 ≥44px。
   - 边上的"交易方/商品/…"有白色衬底，线不穿字。
3. hover/点击节点 → DetailPanel 仍显示完整名；拖拽/缩放/小地图/双击展开不受影响。
4. 切换图例隐藏某类型 → 节点尺寸随度数重算，无报错。

若 `\n` 未渲染为多行（G6 5.1.1 label 不支持换行的兜底）：`fitCaption` 输出后 `.split('\n')[0]` 取首行即为单行截断，确认视觉可接受后在代码中加一行注释说明，不阻塞交付。

- [ ] **Step 7: Commit + push**

```bash
git add apps/web/src/components/graph/GraphCanvas.tsx
git commit -m "feat(web): 图谱节点文字画入圆内并按弦宽截断,度数自适应尺寸,修复文字重叠"
git push
```

（push 前确认 build/lint/test 全绿；本分支为功能分支，push 触发远端 CI。）

---

## Self-Review

- **Spec 覆盖**：诀窍1（弦宽截断+label 居中+颜色区分）→ Task 1+2 Step 1；诀窍2（度数尺寸+nodeSpacing+nodeSize 回调）→ Task 2 Step 1/2；诀窍3（边 label 衬底）→ Task 2 Step 1；验收（单测/build/lint/浏览器）→ Task 1 Step 5/6、Task 2 Step 4/5/6。无遗漏。
- **占位符**：无 TBD/TODO；所有代码步骤含完整代码。
- **类型一致性**：`fitCaption(name, { diameter, fontSize })` 在 Task 1 定义、Task 2 消费一致；`CanvasDatum` 索引签名允许新增 `size` 字段；`NodeData` 已在 GraphCanvas 现有 import 中。
