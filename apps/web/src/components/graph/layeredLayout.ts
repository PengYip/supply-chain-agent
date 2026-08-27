// 语义分层泳道布局(spec 2026-08-27): 项目→合同→履约 三层固定层次, 多项目横向泳道并排。
// 纯函数模块, 不依赖 G6/React — GraphCanvas 直接消费坐标结果落位。
import type { GraphEdge, GraphNode } from '../../hooks/useGraph';

/** 履约归属边: 任一端 Document 且另一端 Contract 即视为履约关系(方向无关)。 */
const FULFILLMENT_TYPES = new Set([
  'executes', 'references', 'binds', 'trades', 'settles', 'amends', 'granted', 'relates', 'correlates',
]);
/** 合同→项目归属边。 */
const PROJECT_LINK_TYPE = 'part_of';
const AUX_KINDS = new Set(['Party', 'Commodity']);

// ---- 行高与间距常量(集中导出便于调参) ----
export const HEADPAD = 24; // 泳道内容距顶部
export const LANEPAD = 32; // 泳道水平内边距
export const LANEGAP = 72; // 相邻泳道间距
export const ROWGAP = 48; // 层与层之间的空隙
export const COLGAP = 28;
export const STACKGAP = 14; // 单据纵向堆叠间距
export const HPROJECT = 56;
export const HAUX = 34;
export const HCONTRACT = 52;
export const HDOC = 40;

// 各类卡片宽度估算(按名称长度), min/max 卡住极端值
const MINW_BY_KIND: Record<string, number> = {
  Project: 220, Contract: 170, Document: 140, Party: 120, Commodity: 120,
};
const MAXW = 280;

/** 固定行位: 所有泳道共享同一套 y 波段 → 左侧层标尺可全局对齐。 */
const ROOT_TOP = HEADPAD;
const AUX_TOP = ROOT_TOP + HPROJECT + ROWGAP;
const CON_TOP = AUX_TOP + HAUX + ROWGAP;

export interface RulerAnchorSpec { id: string; label: string; x: number; y: number }

export interface LayoutResult {
  positions: Record<string, { x: number; y: number }>;
  comboIds: Array<{ id: string }>;
  comboOf: Record<string, string>;
  rulerAnchors: RulerAnchorSpec[];
  scatterIds: ReadonlySet<string>;
  orphanComboId: string;
}

export function classifyEdge(edgeType: string, srcKind: string, dstKind: string): 'hierarchy' | 'plain' {
  const kinds = [srcKind, dstKind];
  if (edgeType === PROJECT_LINK_TYPE && kinds.includes('Contract') && kinds.includes('Project')) return 'hierarchy';
  if (FULFILLMENT_TYPES.has(edgeType) && kinds.includes('Contract') && kinds.includes('Document')) return 'hierarchy';
  return 'plain';
}

function cardWidth(kind: string, name: string): number {
  // CJK 按每字 ~15px、拉丁按 ~8px 粗估 + padding
  let w = 44;
  for (const ch of name) w += ch.charCodeAt(0) > 0x2e7f ? 15 : 8;
  return Math.min(Math.max(w, MINW_BY_KIND[kind] ?? 120), MAXW);
}

function heightOf(kind: string): number {
  if (kind === 'Project') return HPROJECT;
  if (kind === 'Contract') return HCONTRACT;
  if (kind === 'Document') return HDOC;
  return HAUX;
}

/** 卡片几何: 布局与画布渲染共用同一套宽高估算, 保证落位与碰撞一致。 */
export function cardGeometry(kind: string, name: string): { width: number; height: number } {
  return { width: cardWidth(kind, name), height: heightOf(kind) };
}

export function computeLayeredLayout(nodes: GraphNode[], edges: GraphEdge[]): LayoutResult {
  const kindOf = new Map(nodes.map((v) => [v.elementId, v.kind]));
  const docContract = new Map<string, string>();
  const contractProject = new Map<string, string>();
  for (const ed of edges) {
    const sk = kindOf.get(ed.srcId);
    const dk = kindOf.get(ed.dstId);
    if (!sk || !dk) continue;
    if (FULFILLMENT_TYPES.has(ed.type)) {
      if (sk === 'Document' && dk === 'Contract' && !docContract.has(ed.srcId)) docContract.set(ed.srcId, ed.dstId);
      else if (dk === 'Document' && sk === 'Contract' && !docContract.has(ed.dstId)) docContract.set(ed.dstId, ed.srcId);
    }
    if (ed.type === PROJECT_LINK_TYPE) {
      if (sk === 'Contract' && dk === 'Project' && !contractProject.has(ed.srcId)) contractProject.set(ed.srcId, ed.dstId);
      else if (sk === 'Project' && dk === 'Contract' && !contractProject.has(ed.dstId)) contractProject.set(ed.dstId, ed.srcId);
    }
  }

  // 辅助节点传递求所属泳道: 直连项目 > 经合同 > 经单据的合同
  const laneOfAux = (id: string): string | null => {
    for (const ed of edges) {
      if (ed.srcId !== id && ed.dstId !== id) continue;
      const other = ed.srcId === id ? ed.dstId : ed.srcId;
      const ok = kindOf.get(other);
      if (!ok) continue;
      if (ok === 'Project') return `lane:${other}`;
      if (ok === 'Contract') {
        const p = contractProject.get(other);
        return p ? `lane:${p}` : `lane:${other}`;
      }
      if (ok === 'Document') {
        const c = docContract.get(other);
        if (c) {
          const p = contractProject.get(c);
          return p ? `lane:${p}` : `lane:${c}`;
        }
      }
    }
    return null;
  };

  const orphanComboId = 'lane:__scatter';
  const comboOf: Record<string, string> = {};
  const scatterIds = new Set<string>();

  for (const nd of nodes) {
    if (nd.kind === 'Project') { comboOf[nd.elementId] = `lane:${nd.elementId}`; continue; }
    if (nd.kind === 'Contract') {
      const p = contractProject.get(nd.elementId);
      comboOf[nd.elementId] = p ? `lane:${p}` : `lane:${nd.elementId}`;
      continue;
    }
    if (nd.kind === 'Document') {
      const c = docContract.get(nd.elementId);
      const target = c ? contractProject.get(c) : undefined;
      if (c && comboOf[c]) comboOf[nd.elementId] = comboOf[c]!;
      else if (target) comboOf[nd.elementId] = `lane:${target}`;
      else if (c) comboOf[nd.elementId] = `lane:${c}`;
      else { scatterIds.add(nd.elementId); comboOf[nd.elementId] = orphanComboId; }
      continue;
    }
    if (AUX_KINDS.has(nd.kind)) {
      const key = laneOfAux(nd.elementId);
      if (key) comboOf[nd.elementId] = key;
      else { scatterIds.add(nd.elementId); comboOf[nd.elementId] = orphanComboId; }
      continue;
    }
    scatterIds.add(nd.elementId);
    comboOf[nd.elementId] = orphanComboId;
  }

  // 组装泳道成员(顺序保持 nodes 输入序, 保证可复现)
  const orderedLanes: string[] = [];
  for (const nd of nodes) if (nd.kind === 'Project') orderedLanes.push(`lane:${nd.elementId}`);
  for (const nd of nodes) if (nd.kind === 'Contract' && !contractProject.has(nd.elementId)) orderedLanes.push(`lane:${nd.elementId}`);
  for (const id of Object.values(comboOf)) if (!orderedLanes.includes(id)) orderedLanes.push(id);

  const positions: Record<string, { x: number; y: number }> = {};
  let cursorX = 0;
  for (const laneId of orderedLanes) {
    const members = nodes.filter((nd) => comboOf[nd.elementId] === laneId).map((nd) => nd.elementId);
    if (members.length === 0) continue;

    if (laneId === orphanComboId) {
      // 散件区: 最右侧独立列纵向堆叠
      let sy = ROOT_TOP + heightOf(members[0]!) / 2;
      let colW = 0;
      for (const m of members) {
        const k = kindOf.get(m)!;
        positions[m] = { x: cursorX + LANEPAD + Math.max(cardWidth(k, nodes.find((v) => v.elementId === m)!.name) / 2, 70), y: sy };
        sy += heightOf(k) + STACKGAP + 6;
        colW = Math.max(colW, cardWidth(k, nodes.find((v) => v.elementId === m)!.name));
      }
      cursorX += LANEPAD * 2 + colW + LANEGAP / 2;
      continue;
    }

    const projectsHere = members.filter((m) => kindOf.get(m) === 'Project');
    const contractsHere = members.filter((m) => kindOf.get(m) === 'Contract');
    const auxHere = members.filter((m) => AUX_KINDS.has(kindOf.get(m)!));

    const docsByContract = new Map<string, string[]>();
    for (const m of members) {
      if (kindOf.get(m) !== 'Document') continue;
      const c = docContract.get(m);
      if (!c) continue;
      const arr = docsByContract.get(c) ?? [];
      arr.push(m);
      docsByContract.set(c, arr);
    }

    const widthOf = (id: string) => cardWidth(kindOf.get(id)!, nodes.find((v) => v.elementId === id)?.name ?? '');
    const rootId = projectsHere[0] ?? contractsHere[0];
    if (!rootId) continue;

    const contractsRowW = contractsHere.reduce((acc, c) => acc + widthOf(c) + COLGAP, -COLGAP);
    const auxRowW = auxHere.reduce((acc, a) => acc + widthOf(a) + COLGAP, -COLGAP);
    const contentW = Math.max(widthOf(rootId), auxRowW, contractsRowW, 120);
    const innerLeft = cursorX + LANEPAD;

    // 根节点: 顶层居中
    positions[rootId] = { x: innerLeft + contentW / 2, y: ROOT_TOP + HPROJECT / 2 };

    // 辅助 chip 行: 居中排布
    let axCursor = innerLeft + Math.max(0, (contentW - auxRowW) / 2);
    for (const a of auxHere) {
      positions[a] = { x: axCursor + widthOf(a) / 2, y: AUX_TOP + HAUX / 2 };
      axCursor += widthOf(a) + COLGAP;
    }

    // 合同列均布, 单据在各合同正下方堆叠
    let colCursor = innerLeft + Math.max(0, (contentW - contractsRowW) / 2);
    for (const c of contractsHere) {
      const cw = widthOf(c);
      positions[c] = { x: colCursor + cw / 2, y: CON_TOP + HCONTRACT / 2 };
      let dy = CON_TOP + HCONTRACT + STACKGAP + HDOC / 2;
      for (const d of docsByContract.get(c) ?? []) {
        positions[d] = { x: colCursor + cw / 2, y: dy };
        dy += HDOC + STACKGAP;
      }
      colCursor += cw + COLGAP;
    }

    cursorX += contentW + LANEPAD * 2 + LANEGAP;
  }

  // 左侧层标尺锚点: 全局共享行位 → 可精确落在各波段中点
  const allXs = Object.values(positions).map((p) => p.x);
  const minX = allXs.length ? Math.min(...allXs) - 110 : 40;
  const docYs = nodes.filter((nd) => nd.kind === 'Document').map((nd) => positions[nd.elementId]?.y).filter((y): y is number => typeof y === 'number');
  const rulerAnchors: RulerAnchorSpec[] = [];
  if (allXs.length > 0) {
    rulerAnchors.push({ id: '__rule_project', label: '项目层', x: minX, y: ROOT_TOP + HPROJECT / 2 });
    rulerAnchors.push({ id: '__rule_contract', label: '合同层', x: minX, y: CON_TOP + HCONTRACT / 2 });
    if (docYs.length > 0 || [...scatterIds].some((id) => kindOf.get(id) === 'Document')) {
      const band2Y = docYs.length ? docYs.reduce((a, b) => a + b, 0) / docYs.length : CON_TOP + HCONTRACT + STACKGAP + HDOC / 2;
      rulerAnchors.push({ id: '__rule_fulfill', label: '履约层', x: minX, y: band2Y });
    }
  }

  const comboIds = orderedLanes
    .filter((laneId) => nodes.some((nd) => comboOf[nd.elementId] === laneId))
    .map((id) => ({ id }));

  return { positions, comboIds, comboOf, rulerAnchors, scatterIds, orphanComboId };
}
