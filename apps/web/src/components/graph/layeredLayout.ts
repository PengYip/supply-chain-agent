// 语义分层泳道布局(spec 2026-08-27 + 评审修订): 项目→合同→履约 三层固定层次,
// 多项目横向泳道并排; 泳道宽度受限, 合同超宽自动折成多排(适配视口导航优先)。
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
export const HEADPAD = 28; // 泳道内容距顶部
export const LANEPAD = 36; // 泳道水平内边距
export const LANEGAP = 56; // 相邻泳道间距
export const ROWGAP = 44; // 层与层之间的空隙
export const COLGAP = 26;
export const STACKGAP = 12; // 单据纵向堆叠间距
/** 单排合同的宽度预算: 超出即把合同折到下一排(限制泳道横向膨胀)。 */
export const LANE_MAX_W = 720;

// 卡片高度(布局间距按统一档位预留; 画布实际渲染可略低):
// 名称两行 + 概述一行 + 类型徽标行的呼吸空间。
export const HPROJECT = 78;
export const HCONTRACT = 72;
export const HDOC = 58;
export const HAUX = 48;

// 卡片排版 token(与 GraphCanvas 的 cardHtml 严格一致):
// padTop8 + chip16 + gap2 + 名称行17*n(≤2) + [gap2+概述13] + padBottom7
const CARD_PAD_T = 8, CARD_PAD_B = 7, CARD_GAP = 2;
const CHIP_ROW = 16, NAME_LINE = 17, SUB_LINE = 13;

const MINW_BY_KIND: Record<string, number> = {
  Project: 230, Contract: 190, Document: 160, Party: 130, Commodity: 130,
};
const MAXW = 320;

/** 固定行位起点: 所有泳道共享顶部对齐。 */
const ROOT_TOP = HEADPAD;

function heightOf(kind: string): number {
  if (kind === 'Project') return HPROJECT;
  if (kind === 'Contract') return HCONTRACT;
  if (kind === 'Document') return HDOC;
  return HAUX;
}

function nameLines(name: string, widthInner: number): number {
  // CJK≈15px / 其他≈8px @12.5px 粗估; 与 CSS line-clamp 上限 2 对齐
  let w = 0;
  for (const ch of name) w += ch.charCodeAt(0) > 0x2e7f ? 15 : 8;
  const lines = Math.max(1, Math.ceil(w / Math.max(widthInner, 40)));
  return Math.min(lines, 2);
}

/** 展示元数据: 由画布解析(displayName 走文件名兜底链), 布局据此定几何。 */
export interface NodeCardMeta {
  displayName?: string;
  subtitle?: string;
}

/**
 * 单源卡片几何: 宽按文本估宽钳制, 高按 chip 行 + 名称折行数 + 概述有无精确相加。
 * 布局间距与 HTML 模板共用本函数, 保证不再出现"字被拦腰截断"。
 */
export function cardSpec(
  kind: string,
  displayName: string,
  subtitle: string,
): { width: number; height: number } {
  let w = 48;
  for (const ch of displayName) w += ch.charCodeAt(0) > 0x2e7f ? 15 : 8;
  const width = Math.min(Math.max(w, MINW_BY_KIND[kind] ?? 130), MAXW);
  void kindOfNoop(kind);
  const lines = nameLines(displayName, width - 24);
  const height =
    CARD_PAD_T + CHIP_ROW + CARD_GAP +
    lines * NAME_LINE +
    (subtitle ? CARD_GAP + SUB_LINE : 0) +
    CARD_PAD_B;
  return { width, height };
}
function kindOfNoop(_k: string): number {
  return _k.length;
}

/** 卡片几何: 兼容旧签名(无 meta 时退回 kind 档位高度)。 */
export function cardGeometry(
  kind: string,
  name: string,
  meta?: NodeCardMeta,
): { width: number; height: number } {
  if (meta) return cardSpec(kind, meta.displayName ?? name, meta.subtitle ?? '');
  return { width: cardWidthCompat(kind, name), height: heightOf(kind) };
}
function cardWidthCompat(kind: string, name: string): number {
  let w = 48;
  for (const ch of name) w += ch.charCodeAt(0) > 0x2e7f ? 15 : 8;
  return Math.min(Math.max(w, MINW_BY_KIND[kind] ?? 130), MAXW);
}

export interface LayoutResult {
  positions: Record<string, { x: number; y: number }>;
  comboIds: Array<{ id: string }>;
  comboOf: Record<string, string>;
  /** 每条泳道的包围盒(canvas 坐标), 供画布计算初始焦点缩放。 */
  lanes: Array<{ id: string; x: number; y: number; width: number; height: number }>;
  scatterIds: ReadonlySet<string>;
  orphanComboId: string;
}

export function classifyEdge(edgeType: string, srcKind: string, dstKind: string): 'hierarchy' | 'plain' {
  const kinds = [srcKind, dstKind];
  if (edgeType === PROJECT_LINK_TYPE && kinds.includes('Contract') && kinds.includes('Project')) return 'hierarchy';
  if (FULFILLMENT_TYPES.has(edgeType) && kinds.includes('Contract') && kinds.includes('Document')) return 'hierarchy';
  return 'plain';
}

interface InternalLane {
  id: string;
  members: { node: GraphNode; kind: string }[];
}

export function computeLayeredLayout(
  nodes: GraphNode[],
  edges: GraphEdge[],
  metaMap?: Record<string, NodeCardMeta>,
): LayoutResult {
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

  // 组装泳道成员与固定顺序(保持 nodes 输入序, 保证可复现)
  const orderedLanes: string[] = [];
  for (const nd of nodes) if (nd.kind === 'Project') orderedLanes.push(`lane:${nd.elementId}`);
  for (const nd of nodes) if (nd.kind === 'Contract' && !contractProject.has(nd.elementId)) orderedLanes.push(`lane:${nd.elementId}`);
  for (const id of Object.values(comboOf)) if (!orderedLanes.includes(id)) orderedLanes.push(id);

  const laneMembersMap = new Map<string, InternalLane['members']>();
  for (const laneId of orderedLanes.concat(orphanComboId)) {
    if (!laneMembersMap.has(laneId)) laneMembersMap.set(laneId, []);
  }
  for (const nd of nodes) {
    const target = comboOf[nd.elementId];
    if (!target) continue;
    if (!laneMembersMap.has(target)) laneMembersMap.set(target, []);
    laneMembersMap.get(target)!.push({ node: nd, kind: nd.kind });
  }

  // ---- 定位 ----
  const positions: Record<string, { x: number; y: number }> = {};
  const lanes: Array<{ id: string; x: number; y: number; width: number; height: number }> = [];
  let cursorX = 0;
  let cursorYGlobalMax = ROOT_TOP;

  /** 单源几何: 有 meta 用精确测量, 否则退回 kind 档位。 */
  const measure = (nd: GraphNode): { width: number; height: number } => {
    const m = metaMap?.[nd.elementId];
    if (!m) return { width: cardWidthCompat(nd.kind, nd.name), height: heightOf(nd.kind) };
    return cardSpec(nd.kind, m.displayName ?? nd.name, m.subtitle ?? '');
  };

  /** 把节点按宽度预算切成多行, 行内均布。 */
  const wrapByWidth = <T,>(items: T[], widthOf: (item: T) => number, budget = LANE_MAX_W): T[][] => {
    const rows: T[][] = [];
    let current: T[] = [];
    let currentW = 0;
    for (const it of items) {
      const w = widthOf(it);
      const nextW = current.length === 0 ? w : currentW + COLGAP + w;
      if (current.length > 0 && nextW > budget) {
        rows.push(current);
        current = [it];
        currentW = w;
      } else {
        current = current.concat(it);
        currentW = nextW;
      }
    }
    if (current.length > 0) rows.push(current);
    return rows;
  };

  const placeRow = (row: InternalLane['members'], rowTopY: number, innerLeft: number, contentW: number) => {
    const rowW = row.reduce((acc, m, i) => acc + measure(m.node).width + (i > 0 ? COLGAP : 0), 0);
    let cx = innerLeft + Math.max(0, (contentW - rowW) / 2);
    for (const m of row) {
      const w = measure(m.node).width;
      positions[m.node.elementId] = { x: cx + w / 2, y: rowTopY + measure(m.node).height / 2 };
      cx += w + COLGAP;
    }
  };

  for (const laneId of orderedLanes) {
    const members = laneMembersMap.get(laneId)!;
    if (members.length === 0) continue;

    const widthOfMember = (m: InternalLane['members'][number]) => measure(m.node).width;

    if (laneId === orphanComboId) {
      // 散件区: 独立窄列纵向堆叠
      const colW = Math.max(...members.map(widthOfMember));
      let sy = ROOT_TOP;
      for (const m of members) {
        positions[m.node.elementId] = { x: cursorX + LANEPAD + colW / 2, y: sy + heightOf(m.kind) / 2 };
        sy += heightOf(m.kind) + STACKGAP + 4;
      }
      const h = sy - ROOT_TOP - STACKGAP - 4;
      lanes.push({ id: laneId, x: cursorX, y: 0, width: colW + LANEPAD * 2, height: Math.max(h, HDOC) });
      cursorX += colW + LANEPAD * 2 + LANEGAP / 2;
      cursorYGlobalMax = Math.max(cursorYGlobalMax, h);
      continue;
    }

    const projectsHere = members.filter((m) => m.kind === 'Project');
    const contractsHere = members.filter((m) => m.kind === 'Contract');
    const auxHere = members.filter((m) => AUX_KINDS.has(m.kind));

    const docsByContract = new Map<string, string[]>();
    for (const m of members) {
      if (m.kind !== 'Document') continue;
      const c = docContract.get(m.node.elementId);
      if (!c) continue;
      const arr = docsByContract.get(c) ?? [];
      arr.push(m.node.elementId);
      docsByContract.set(c, arr);
    }

    const root = projectsHere[0] ?? contractsHere[0];
    if (!root) continue;

    // 根节点: 顶层居中
    positions[root.node.elementId] = { x: cursorX + LANEPAD, y: ROOT_TOP + heightOf(root.kind) / 2 };
    void positions[root.node.elementId].x; // x 在泳道宽度确定后校正

    // 辅助 chip 行(同样受宽度约束, 可换行)
    let rowCursorY = ROOT_TOP + HPROJECT + ROWGAP;
    const auxRows = wrapByWidth(auxHere, widthOfMember);
    for (const auxRow of auxRows) {
      placeRow(auxRow, rowCursorY, cursorX + LANEPAD, LANE_MAX_W);
      rowCursorY += HAUX + STACKGAP + 6;
    }

    // 合同行: 分排 → 每排下方挂各自的单据列
    let deepestBottom = rowCursorY;
    const contractRows = contractsHere.length > 0 ? wrapByWidth(contractsHere, widthOfMember) : [];
    for (const cRow of contractRows) {
      const rowTopY = rowCursorY;
      let colX = cursorX + LANEPAD;
      // 每排独立起点(左对齐而非居中, 多排阅读动线更稳)
      for (const cm of cRow) {
        const cw = widthOfMember(cm);
        const contractCX = colX + cw / 2;
        positions[cm.node.elementId] = { x: contractCX, y: rowTopY + HCONTRACT / 2 };
        let dy = rowTopY + HCONTRACT + STACKGAP + HDOC / 2;
        for (const d of docsByContract.get(cm.node.elementId) ?? []) {
          positions[d] = { x: contractCX, y: dy };
          dy += HDOC + STACKGAP;
        }
        deepestBottom = Math.max(deepestBottom, dy - STACKGAP);
        colX += cw + COLGAP;
      }
      // 排高 = 该排最深单据底
      let maxColBottom = rowTopY + HCONTRACT;
      for (const cm of cRow) {
        const n = (docsByContract.get(cm.node.elementId)?.length ?? 0);
        maxColBottom = Math.max(maxColBottom, rowTopY + HCONTRACT + STACKGAP + n * (HDOC + STACKGAP));
      }
      rowCursorY = maxColBottom + ROWGAP;
    }

    // 泳道几何: 内容宽 + 内边距(至少比根卡片宽)
    const rootW = widthOfMember(root);
    const contentBottom = deepestBottom;
    const laneH = Math.max(contentBottom + LANEPAD - ROOT_TOP, root ? HPROJECT : HDOC);
    const laneW = Math.min(LANE_MAX_W + LANEPAD * 2, Math.max(rootW + LANEPAD * 2, LANE_MAX_W + LANEPAD * 2));
    // 根节点水平位置最终校正为泳道中心
    positions[root.node.elementId] = { x: cursorX + laneW / 2, y: ROOT_TOP + heightOf(root.kind) / 2 };
    lanes.push({ id: laneId, x: cursorX, y: 0, width: laneW, height: laneH });

    cursorX += laneW + LANEGAP;
    cursorYGlobalMax = Math.max(cursorYGlobalMax, laneH);
  }

  return { positions, comboIds: lanes.map((l) => ({ id: l.id })), comboOf, lanes, scatterIds, orphanComboId };
}
