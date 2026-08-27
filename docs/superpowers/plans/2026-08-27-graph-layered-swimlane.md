# 图谱语义分层泳道布局 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把主图谱从径向混杂布局改为「项目→合同→履约」语义分层泳道布局，多项目分泳道并排。

**Architecture:** 新增纯函数布局模块 `layeredLayout.ts`（归层 + 定位，vitest 可测）；`GraphCanvas.tsx` 消费其坐标结果直接落位（无需注册自定义 BaseLayout），泳道用 G6 v5 Combo 渲染，节点升级为圆角卡片；`GraphView.tsx` 移除深度/方向控件。规格见 `docs/superpowers/specs/2026-08-27-graph-layered-swimlane-design.md`。

**Tech Stack:** React 19 + TS + @antv/g6 v5 (^5.1.1)、vitest（apps/web 自带 test 目录）。

## Global Constraints

- 禁止 emoji 入代码。
- 不改后端、不改 BindingMiniGraph。
- 五色语义色板以 `businessTypes.ts` 为唯一来源（KIND_STYLES / EDGE_STYLE_OVERRIDES）。
- 完工门槛：`npm run build`、`npm run lint`、`npm test` 全绿后才提交推送。
- 与规格的已记录偏差：首帧淡入用容器 CSS `animate-fade-in` 实现（G6 全局 `animation:false` 保持不变，避免触发 StrictMode 渲染管线风险）。

---

### Task 1: 分层布局纯函数模块（TDD）

**Files:**
- Create: `apps/web/src/components/graph/layeredLayout.ts`
- Test: `apps/web/test/layeredLayout.test.ts`

**Interfaces:**
- Consumes: `GraphNode`/`GraphEdge` 类型（from `../../hooks/useGraph`）
- Produces（Task 2 依赖）:

```ts
export interface LayoutResult {
  positions: Record<string, { x: number; y: number }>;
  comboIds: Array<{ id: string }>;
  comboOf: Record<string, string>;
  rulerAnchors: Array<{ id: string; label: string; x: number; y: number }>;
  scatterIds: ReadonlySet<string>;
  orphanComboId: string;
}
export function computeLayeredLayout(
  nodes: GraphNode[],
  edges: GraphEdge[],
): LayoutResult
export function classifyEdge(
  edgeType: string,
  srcKind: string,
  dstKind: string,
): 'hierarchy' | 'plain'
```

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from 'vitest';
import { classifyEdge, computeLayeredLayout } from '../src/components/graph/layeredLayout';
import type { GraphEdge, GraphNode } from '../src/hooks/useGraph';

function n(elementId: string, kind: string, name = elementId): GraphNode {
  return { elementId, kind, name, props: null };
}
function e(elementId: string, type: string, srcId: string, dstId: string): GraphEdge {
  return { elementId, type, srcId, dstId, props: null, confidence: null };
}

describe('classifyEdge', () => {
  it('part_of 的项目-合同边是层级边', () => {
    expect(classifyEdge('part_of', 'Contract', 'Project')).toBe('hierarchy');
  });
  it('executes/references/bindes 类合同-单据边是层级边', () => {
    expect(classifyEdge('executes', 'Contract', 'Document')).toBe('hierarchy');
    expect(classifyEdge('references', 'Document', 'Contract')).toBe('hierarchy');
    expect(classifyEdge('binds', 'Document', 'Contract')).toBe('hierarchy');
  });
  it('其余是普通边', () => {
    expect(classifyEdge('counterparty', 'Party', 'Party')).toBe('plain');
    expect(classifyEdge('part_of', 'Document', 'Project')).toBe('plain');
  });
});

describe('computeLayeredLayout', () => {
  const project = n('p1', 'Project', '电解铜进口');
  const contract = n('c1', 'Contract', 'HT-2026-001');
  const party = n('s1', 'Party', '赣州冶炼厂');
  const docA = n('d1', 'Document', '发票.pdf');
  const docB = n('d2', 'Document', '提单.pdf');
  const nodes = [contract, docA, docB, party, project];
  const edges = [
    e('e1', 'part_of', 'c1', 'p1'),
    e('e2', 'party', 'c1', 's1'),
    e('e3', 'references', 'd1', 'c1'),
    e('e4', 'binds', 'd2', 'c1'),
  ];

  it('单据归首次引用它的合同下方（y 大于合同）', () => {
    const r = computeLayeredLayout(nodes, edges);
    const c = r.positions['c1']!;
    const d = r.positions['d1']!;
    expect(d.y).toBeGreaterThan(c.y);
    expect(r.comboOf['d1']).toBe(r.comboOf['c1']);
  });

  it('单据只占一处位置（跨合同引用不复制节点）', () => {
    const c2 = n('c2', 'Contract', 'HT-2026-002');
    const r = computeLayeredLayout([...nodes, c2], [...edges, e('e5', 'references', 'd1', 'c2')]);
    expect(Object.values(r.positions).filter((p) => p === r.positions['d1']).length).toBeLessThanOrEqual(1);
  });

  it('主体挂在项目旁边（同泳道、合同层上方附近）', () => {
    const r = computeLayeredLayout(nodes, edges);
    expect(r.comboOf['s1']).toBe(r.comboOf['p1']);
    const proj = r.positions['p1']!;
    const aux = r.positions['s1']!;
    const con = r.positions['c1']!;
    expect(aux.y).toBeGreaterThan(proj.y);
    expect(aux.y).toBeLessThan(con.y);
  });

  it('单项目时恰好一个泳道 Combo', () => {
    const r = computeLayeredLayout(nodes, edges);
    expect(r.comboIds.filter((c) => !r.orphanComboId.includes(c.id)).length).toBe(1);
  });

  it('多项目各自成泳道且水平错开（包围盒不相交）', () => {
    const p2 = n('p2', 'Project', '锌锭出口');
    const c2 = n('c2', 'Contract', 'ZN-2026-002');
    const d3 = n('d3', 'Document', '箱单.pdf');
    const r = computeLayeredLayout(
      [...nodes, p2, c2, d3],
      [...edges, e('e6', 'part_of', 'c2', 'p2'), e('e7', 'references', 'd3', 'c2')],
    );
    expect(new Set([r.comboOf['p1'], r.comboOf['p2']]).size).toBe(2);
    expect(r.positions['p2']!.x).not.toBe(r.positions['p1']!.x);
    expect(Object.keys(r.positions).length).toBe(nodes.length + 3);
  });

  it('无合同时散落单据进孤儿区标记 scatterIds', () => {
    const lone = n('dx', 'Document', '申报单.pdf');
    const r = computeLayeredLayout([lone], []);
    expect(r.scatterIds.has('dx')).toBe(true);
  });

  it('无项目时合同作为伪泳道根仍然成立', () => {
    const r = computeLayeredLayout([contract, docA], [e('e8', 'references', 'docA_ref', 'c1').dstId === 'c1' ? e('e8', 'references', 'd1', 'c1') : e('e8', 'references', 'd1', 'c1')]);
    expect(r.comboOf['c1']).toBeTruthy();
    expect(r.positions['c1']).toBeTruthy();
    expect(r.positions['d1']).toBeTruthy();
  });
});
```

注意第 7 个用例写得拗口了——直接写成：

```ts
  it('无项目时合同作为伪泳道根仍然成立', () => {
    const r = computeLayeredLayout([contract, docA], [e('e8', 'references', 'd1', 'c1')]);
    expect(r.comboOf['c1']).toBeTruthy();
    expect(r.positions['c1']).toBeTruthy();
    expect(r.positions['d1']).toBeTruthy();
  });
```

- [ ] **Step 2: 运行验证失败**

Run: `npm run test --workspace apps/web -- test/layeredLayout.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 layeredLayout.ts**

实现要点（完整实现按此语义写，常量集中导出便于调参）：

```ts
import type { GraphEdge, GraphNode } from '../../hooks/useGraph';

/** 履约归属边：任一端为 Document 且另一端为 Contract 时即视为履约关系。 */
const FULFILLMENT_TYPES = new Set(['executes', 'references', 'binds', 'trades', 'settles', 'amends', 'granted', 'relates', 'correlates']);
const PROJECT_LINK_TYPES = new Set(['part_of', 'participates']);
const AUX_KINDS = new Set(['Party', 'Commodity']);

export interface LaneSize { width: number; height: number }
export interface RulerAnchorSpec { id: string; label: string; x: number; y: number }

export interface LayoutResult {
  positions: Record<string, { x: number; y: number }>;
  comboIds: Array<{ id: string }>;
  comboOf: Record<string, string>;
  rulerAnchors: RulerAnchorSpec[];
  scatterIds: ReadonlySet<string>;
  orphanComboId: string;
}

// 行距常量
export const LANEPAD = 32, LANEGAP = 72, ROWGAP = 48, COLMIN = 168, COLGAP = 28,
  HPROJECT = 56, HAUX = 34, HCONTRACT = 52, HDOC = 40, STACKGAP = 14, HEADPAD = 24;

export function classifyEdge(edgeType: string, srcKind: string, dstKind: string): 'hierarchy' | 'plain' {
  const k = [srcKind, dstKind];
  if (edgeType === 'part_of' && k.includes('Contract') && k.includes('Project')) return 'hierarchy';
  if (FULFILLMENT_TYPES.has(edgeType) && k.includes('Contract') && k.includes('Document')) return 'hierarchy';
  return 'plain';
}

export function computeLayeredLayout(nodes: GraphNode[], edges: GraphEdge[]): LayoutResult {
  const kindOf = new Map(nodes.map((v) => [v.elementId, v.kind]));
  // 1. 归属图：document -> 首次引用它的 contract；contract -> project
  const docContract = new Map<string, string>();
  const contractProject = new Map<string, string>();
  for (const ed of edges) {
    const sk = kindOf.get(ed.srcId), dk = kindOf.get(ed.dstId);
    if (!sk || !dk) continue;
    const pair = (a: string, b: string) => {
      if (sk === a && dk === b) docContract.set(ed.srcId, ed.dstId);
      if (dk === a && sk === b) docContract.set(ed.dstId, ed.srcId);
    };
    if (FULFILLMENT_TYPES.has(ed.type)) pair('Document', 'Contract');
    if (ed.type === 'part_of') {
      if (sk === 'Contract' && dk === 'Project') contractProject.set(ed.srcId, ed.dstId);
      else if (sk === 'Project' && dk === 'Contract') contractProject.set(ed.dstId, ed.srcId);
    }
  }
  const comboOf: Record<string, string> = {};
  const lanes: Array<{ id: string; members: string[] }> = [];
  const scatter = new Set<string>();

  // 辅助节点传递求所属合约 → 项目
  const auxLaneKey = (id: string): string | null => {
    for (const ed of edges) {
      if (ed.srcId !== id && ed.dstId !== id) continue;
      const other = ed.srcId === id ? ed.dstId : ed.srcId;
      const ok = kindOf.get(other)!;
      if (ok === 'Project') return `lane:${other}`;
      if (ok === 'Contract') return contractProject.get(other) ? `lane:${contractProject.get(other)}` : `lane:${other}`;
      if (ok === 'Document') {
        const c = docContract.get(other);
        if (c) return contractProject.get(c) ? `lane:${contractProject.get(c)}` : `lane:${c}`;
      }
    }
    return null;
  };

  const rootIds = nodes.filter((v) => v.kind === 'Project').map((v) => v.elementId);
  const pseudoRootContracts = nodes
    .filter((v) => v.kind === 'Contract' && !contractProject.has(v.elementId))
    .map((v) => v.elementId);
  const laneIds = [...rootIds.map((id) => `lane:${id}`), ...pseudoRootContracts.map((id) => `lane:${id}`)];

  for (const nd of nodes) {
    const k = nd.kind;
    if (k === 'Project') { comboOf[nd.elementId] = `lane:${nd.elementId}`; continue; }
    if (k === 'Contract') {
      comboOf[nd.elementId] = contractProject.has(nd.elementId) ? `lane:${contractProject.get(nd.elementId)}` : `lane:${nd.elementId}`;
      continue;
    }
    if (k === 'Document') {
      const c = docContract.get(nd.elementId);
      if (c && comboOf[c]) comboOf[nd.elementId] = comboOf[c];
      else scatter.add(nd.elementId);
      continue;
    }
    if (AUX_KINDS.has(k)) {
      const key = auxLaneKey(nd.elementId);
      if (key) comboOf[nd.elementId] = key;
      else scatter.add(nd.elementId);
      continue;
    }
    scatter.add(nd.elementId);
  }
  for (const id of scatter) comboOf[id] = 'lane:__scatter';
  const orphanComboId = 'lane:__scatter';

  // 2. 组装每条泳道的成员
  const laneMembers = new Map(laneIds.concat(orphanComboId).map((id) => [id, [] as string[]]));
  for (const [nodeId, lane] of Object.entries(comboOf)) {
    if (!laneMembers.has(lane)) laneMembers.set(lane, []);
    laneMembers.get(lane)!.push(nodeId);
  }

  // 3. 泳道内定位（局部坐标），再整体平移
  const positions: Record<string, { x: number; y: number }> = {};
  const estimateW = (id: string) => {
    const nameLen = nodes.find((v) => v.elementId === id)?.name.length ?? 4;
    return Math.min(Math.max(COLMIN, nameLen * 16 + 40), 260);
  };
  let cursorX = 0;
  const rulerPlanned: Array<{ rank: number; label: string; yLocal: number }> = [];
  const pendingRulerLabels = ['项目层', '合同层', '履约层'];
  let cursorYGlobal = 0;

  for (const [laneIdx, laneIdRaw] of [...laneMembers.keys()].entries()) {
    const members = laneMembers.get(laneIdRaw)!;
    const projectsHere = members.filter((m) => kindOf.get(m) === 'Project');
    const contractsHere = members.filter((m) => kindOf.get(m) === 'Contract');
    const docsByContract = new Map<string, string[]>();
    const aux = members.filter((m) => AUX_KINDS.has(kindOf.get(m)!));
    const bareDocs = members.filter((m) => kindOf.get(m) === 'Document');
    for (const d of bareDocs) {
      const c = docContract.get(d);
      if (c) { const arr = docsByContract.get(c) ?? []; arr.push(d); docsByContract.set(c, arr); }
    }
    const rootId = projectsHere[0] ?? contractsHere[0];
    if (!rootId) continue;

    // 内容宽度
    const docColWidths = contractsHere.map((c) => Math.max(estimateW(c), ...(docsByContract.get(c)?.map(estimateW) ?? [0])));
    const auxTotal = aux.reduce((acc, m) => acc + estimateW(m) + COLGAP, -COLGAP);
    const contentW = Math.max(
      estimateW(rootId),
      Math.max(auxTotal, 0),
      docColWidths.reduce((a, b) => a + b + COLGAP, -COLGAP),
    );
    const padX = LANEPAD;
    const innerLeft = cursorX + padX;
    const rootY = cursorYGlobal + HEADPAD;
    positions[rootId] = { x: innerLeft + contentW / 2, y: rootY };

    // 辅助 chip 一行，居中排布在项目行下
    const auxY = cursorYGlobal + HEADPAD + HPROJECT + ROWGAP / 2;
    let axCursor = innerLeft + Math.max(0, (contentW - auxTotal) / 2);
    for (const m of aux) {
      positions[m] = { x: axCursor + estimateW(m) / 2, y: auxY };
      axCursor += estimateW(m) + COLGAP;
    }
    // 合同行
    const contractY = auxY + HAUX / 2 + ROWGAP;
    let colCursor = innerLeft + Math.max(0, (contentW - (docColWidths.reduce((a, b) => a + b + COLGAP, -COLGAP))) / 2);
    let deepest = contractY;
    contractsHere.forEach((c, i) => {
      const colW = docColWidths[i]!;
      const cx = colCursor + colW / 2;
      positions[c] = { x: cx, y: contractY };
      let dy = contractY + HCONTRACT / 2 + STACKGAP + HDOC / 2;
      for (const d of docsByContract.get(c) ?? []) {
        positions[d] = { x: cx, y: dy };
        dy += HDOC + STACKGAP;
      }
      deepest = Math.max(deepest, dy - STACKGAP);
      colCursor += colW + COLGAP;
    });
    const laneHeight = deepest + LANEPAD - cursorYGlobal;
    // 散件纵向排在内容右外侧
    if (members.some((m) => scatter.has(m)) && laneIdRaw !== orphanComboId) {
      const scatterColX = innerLeft + contentW + COLGAP;
      let sy = auxY;
      for (const m of members.filter((mm) => scatter.has(mm))) {
        positions[m] = { x: scatterColX, y: sy };
        sy += HDOC + STACKGAP;
      }
      cursorX += contentW + 2 * LANEPAD + LANEGAP + estimateW(members.find((m) => scatter.has(m))!) + COLGAP;
    } else {
      cursorX += contentW + 2 * LANEPAD + (laneIdx < laneMembers.size - 1 ? LANEGAP : 0);
    }
    void laneHeight; void cursorYGlobal; void rulerPlanned; void pendingRulerLabels;
  }
  ...
```

⚠️ 上面的骨架故意接近成品但遗漏了两块收尾，完整实现必须补齐（这是规格要求，不是可选）：

(a) **孤儿泳道**（`lane:__scatter` 成员）：在最右侧独立成列纵向堆叠；
(b) **rulerAnchors**：三条泳道顶层对齐后，取 `minX = 所有 position.x 最小值减 110`，
分别放在三层波段竖直中点：`{ id:'__rule0', label:'项目层', x:minX, y:(HEADPAD+HPROJECT/2) }`、
`{ id:'__rule1', label:'合同层', x:minX, y: 合同行全局 y }`、
`{ id:'__rule2', label:'履约层', x:minX, y: 取所有 Document 位置 y 的均值（无则省略该锚点）}`。
`comboIds` 返回 `[...laneMembers.keys()].map(id=>({id}))`；
所有 Document 都缺失时第二条锚点也照常返回（合同行为空时 y 用第一泳道默认行位）。

简化推荐：内部先按「单泳道局部定位函数 layoutLane(members) → {相对坐标, 高度, 宽度}」拆出，
再平移拼接，逻辑更直白，测试全部按返回结果断言即可。

- [ ] **Step 4: 运行测试通过**

Run: `npm run test --workspace apps/web -- test/layeredLayout.test.ts`
Expected: PASS 全部用例

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/graph/layeredLayout.ts apps/web/test/layeredLayout.test.ts
git commit -m "feat(web): 图谱分层泳道布局纯函数(layeredLayout)"
```

---

### Task 2: GraphCanvas 接入布局 + 卡片化视觉

**Files:**
- Modify: `apps/web/src/components/graph/GraphCanvas.tsx`

**Interfaces:**
- Consumes: `computeLayeredLayout` / `classifyEdge`（Task 1 导出）、`KIND_STYLES`（existing）
- Produces: 无新导出（内部重构）。对外 props 契约不变（depth/direction 由 View 层消失后不再入 key）。

- [ ] **Step 1: 改造 buildData 与建图配置**

关键改动点（逐项）：
1. `buildData` 内先算 `const layout = computeLayeredLayout(visibleNodes2, visibleEdges)`（注意：先过滤 hiddenKinds 再进布局，保证隐藏类型后重排）。
2. 每个 g6Node 增加：`type:'rect'`、`style.x/y = layout.positions[id]`、`combo = layout.comboOf[id]`、卡片几何（按下表）。
3. g6Node 卡片样式基准（用 businessTypes token）：
   - Project：`fill:'#6D5FC3'`、白字、`lineWidth:0`、size `{width: 根contentW, height:HPROJECT}`（直接用 layout 里给的估算或用 `style.size:[w,h]`）。
   - Contract：`fill:'#E9F4EC'`、`stroke:'#CBE5D3'`、左色条 badge：`badges:[{text:'', placement:'left', backgroundFill:'#15803D', padding:[0], size:[4,HCONTRACT]}]`。
   - Document：`fill:'#E8EEF4'`、`stroke:'#C7D6E3'`、badge 同法藏青。
   - Party/Commodity：对应 softBg/softBorder，chip 小尺寸。
   - label：`labelPlacement:'center'`、`labelFill:'#374151'`（Project 白）、字号 11、`labelMaxLines:2`、文本仍走 `fitCaption` 但传 `diameter: 宽度*0.92`。
   - `radius:8`（Project 10）。散件成员加 `lineDash:[4,3]`。
4. 伪标尺节点：把 `layout.rulerAnchors` 映射成附加 g6Node：`data:{pseudo:true}`、无 fill/stroke、仅 `labelText:label`、`labelFill:'#94A3B8'`、`labelFontSize:11`、`letterSpacing:? 若不支持忽略`、`combo` 缺省。事件 handler 已有 `rawNode` 空守卫，天然免疫点击/hover。拖拽行为可能挪动它们：可接受（重挂载复位）。
5. `combos` 数组传入 graph data：`combos: layout.comboIds.map(...)`，配 `combo:{ style:{ fill:'#FFFFFF', stroke:'#E2E8F0', lineWidth:1, radius:12 } }`（graph options 顶层 `combo` 字段）。
6. 边：每条 g6Edge 增加 `type: classifyEdge(...)==='hierarchy' ? 'cubic-vertical':'curved'`；层级边 `stroke:'#CBD5E1', lineWidth:1.5`，普通边保持现有 #94A3B8 宽1；binds 绿虚线 override 不变；`endArrowSize:6` 替代默认；交叉引用（两端同 kind 或异泳道非层级）继续 plain。
7. 建图 options：删除整个 `layout` 配置块（坐标已显式给出）；behaviors 改为 `['drag-canvas','zoom-canvas','drag-element','click-select','hover-activate']`；plugins 增加 `{ type:'grid-line', size:22 }` 放在 minimap 前。⚠️ 验证步骤若 grid-line 报错则删掉该项再继续（备份方案：不加网格，不影响其余任务）。
8. 外层 div 加 `animate-fade-in` class（替代 G6 appear 动画，已记录偏差）。
9. 底部提示文案改为：`双击节点向外展开 · 点阵画布可缩放拖拽 · 已隐藏类型 N`（替换 useMemo tip 内容）。

- [ ] **Step 2: 类型检查**

Run: `npm run build --workspace apps/web`
Expected: 构建成功无类型错误

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/graph/GraphCanvas.tsx
git commit -m "feat(web): 主图谱接入分层泳道布局与卡片化节点"
```

---

### Task 3: GraphView 控件简化

**Files:**
- Modify: `apps/web/src/components/graph/GraphView.tsx`

**Interfaces:**
- Consumes: `useGraph.loadSubgraph(id, depth, dir)`（后端查询深度固定为 3、both）
- Produces: 移除 `depth/direction` 状态与 UI；`query()` 内固定调用 `loadSubgraph(id, 3, 'both')`

- [ ] **Step 1: 移除深度/方向**

1. 删除 `DEPTH_OPTIONS`、`DIRECTION_OPTIONS` 常量与 `depth/direction` useState。
2. `query(id,label,fromDocument)` 固定 `loadSubgraph(id, 3, 'both')`；所有调用点同步去掉两参。
3. 删除工具条里深度 select 与三向按钮 JSX；删除 `handleDepthChange/handleDirectionChange`。
4. `GraphCanvas` 的 `key` 改为 `` `${center?.id ?? ''}` ``。
5. 各 useCallback 依赖数组随引用变化收紧。

- [ ] **Step 2: 图例与文案更新**

1. 图例圆点换成方块色板（贴近新卡片观感）：所有 `bt.label` 渲染统一 `<span className="h-2 w-2 rounded-[2px]" style={{ background: bt.softBg, border: \`1px solid ${bt.color}\` }} />`（去掉 Document 特判分支）。
2. 图例容器加一行小注：`<span className="text-[10px] text-line">自上而下：项目 · 合同 · 履约</span>` 放在 legend flex 内末尾。
3. 空态文案改为 `在画布上浏览项目的合同与履约单据，双击任意节点向外展开`。
4. graphEmpty 文案微调为分层语境（去掉"增大深度或切换方向"字样，换成"尝试以其他节点为中心重新展开"）。

- [ ] **Step 3: 构建 + 提交**

Run: `npm run build --workspace apps/web && npm run lint`
Expected: 成功

```bash
git add apps/web/src/components/graph/GraphView.tsx
git commit -m "feat(web): 图谱页移除深度方向控件, 图例适配分层语义"
```

---

### Task 4: 全量门禁 + 手动可视化验证

- [ ] **Step 1: 门禁**

Run: `npm run build && npm run lint && npm test`
Expected: 全绿（web vitest + server vitest 均过）

- [ ] **Step 2: dev server 可视化核对**

检查 5173 是否已有前端在跑（避免重复起服务）：没有才 `npm run dev`。用浏览器打开图谱页核对三类场景：单项目多合同多单据、双项目泳道错开、以单据为中心（伪根兜底）。重点看：Combo 包裹不裁剪、badge 左色条生效、grid-line/console 无报错。

- [ ] **Step 3: push branch + merge main（按仓库工作流约定）**

验证全绿后：push 当前分支并合并回 main（触发 CD 部署到 10.10.0.2）。
