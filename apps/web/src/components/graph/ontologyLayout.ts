// 本体全景图布局（治理全景图专用, 2026-09-08）：按关系方向最长路径分层，
// 列=层（左→右为业务流向），列内垂直居中——替代 computeLayeredLayout 的文档泳道
// 语义（那里 11 实体全部落入散件窄列，纵向成列、14 条边几乎不可辨）。
// 纯函数模块, 不依赖 G6/React；分层完全由注册表关系对派生, 无硬编码实体清单。
import type { GraphEdge, GraphNode } from '../../hooks/useGraph';
import { cardSpec, type LayoutResult, type NodeCardMeta } from './layeredLayout';

// 列/行间距（比文档泳道更宽松：11 节点 + 14 边要一眼可辨）
export const ONTO_COLGAP = 150; // 列间距（中心到卡片边留白）
export const ONTO_ROWWIDTH = 220; // 单列宽度（卡片宽 + 余量）
export const ONTO_ROWGAP = 46; // 列内卡片纵向间距
export const ONTO_TOPPAD = 60;

const ORPHAN = 'lane:__scatter';

/** 关系方向最长路径分层：自环跳过，环路上限迭代 nodes.length 轮后收敛。 */
export function layerByRelation(nodes: GraphNode[], edges: GraphEdge[]): Map<string, number> {
  const ids = new Set(nodes.map((n) => n.elementId));
  const layer = new Map<string, number>(nodes.map((n) => [n.elementId, 0]));
  const rel = edges.filter(
    (e) => e.srcId !== e.dstId && ids.has(e.srcId) && ids.has(e.dstId),
  );
  for (let round = 0; round < nodes.length; round++) {
    let moved = false;
    for (const e of rel) {
      const next = layer.get(e.srcId)! + 1;
      if (next > layer.get(e.dstId)!) {
        layer.set(e.dstId, next);
        moved = true;
      }
    }
    if (!moved) break;
  }
  return layer;
}

export function computeOntologyLayout(
  nodes: GraphNode[],
  edges: GraphEdge[],
  metaMap?: Record<string, NodeCardMeta>,
): LayoutResult {
  const layer = layerByRelation(nodes, edges);
  const maxLayer = nodes.reduce((m, n) => Math.max(m, layer.get(n.elementId) ?? 0), 0);

  // 几何：卡片尺寸用与画布一致的 cardSpec 精确测量（metaMap 缺失时退回名称估宽）。
  const sizeOf = (nd: GraphNode): { width: number; height: number } => {
    const m = metaMap?.[nd.elementId];
    return cardSpec(nd.kind, m?.displayName ?? nd.name, m?.subtitle ?? '');
  };

  // 分列
  const columns: GraphNode[][] = Array.from({ length: maxLayer + 1 }, () => []);
  for (const nd of nodes) columns[layer.get(nd.elementId) ?? 0]!.push(nd);

  const positions: Record<string, { x: number; y: number }> = {};
  const lanes: LayoutResult['lanes'] = [];
  const maxRows = columns.reduce((m, col) => Math.max(m, col.length), 0);
  const columnCenterY = ONTO_TOPPAD + (maxRows * (ONTO_ROWGAP + 58)) / 2;

  let cursorX = ONTO_COLGAP;
  for (let li = 0; li < columns.length; li++) {
    const col = columns[li]!;
    if (col.length === 0) continue;
    const colW = ONTO_ROWWIDTH;
    const colH = col.length * (ONTO_ROWGAP + 58);
    let cursorY = columnCenterY - colH / 2;
    const colLeft = cursorX;
    for (const nd of col) {
      const { width, height } = sizeOf(nd);
      positions[nd.elementId] = { x: cursorX + (colW - width) / 2 + width / 2, y: cursorY + height / 2 };
      cursorY += ONTO_ROWGAP + 58;
    }
    lanes.push({ id: `onto-layer:${li}`, x: colLeft - ONTO_COLGAP / 2, y: 0, width: colW + ONTO_COLGAP, height: Math.max(colH, 120) });
    cursorX += colW + ONTO_COLGAP;
  }

  return {
    positions,
    comboIds: [],
    comboOf: {},
    lanes,
    scatterIds: new Set<string>(),
    orphanComboId: ORPHAN,
  };
}
