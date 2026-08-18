import { useState } from 'react';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  MarkerType,
  useNodesState,
  type Edge,
  type NodeMouseHandler,
  type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './graph-canvas.css';
import { GraphFlowNode, type ScaFlowNode } from './GraphFlowNode';
import { edgeLabel, kindStyle, EDGE_STYLE_OVERRIDES } from './kinds';
import type { GraphEdge, GraphNode, InspectTarget, Subgraph } from '../../hooks/useGraph';

/* ---------- 径向布局：中心在原点，其余按 BFS 深度分层成环 ---------- */

interface Point {
  x: number;
  y: number;
}

const GOLDEN_ANGLE = 2.39996; // 相邻环错开黄金角，避免径向对齐呆板
const EDGE_STROKE = '#9DB0C3';

/** 从中心节点出发做无向 BFS，得到每个节点的环深度。 */
function bfsDepths(subjectId: string, edges: GraphEdge[]): Map<string, number> {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (!e.srcId || !e.dstId) continue;
    let list = adj.get(e.srcId);
    if (!list) adj.set(e.srcId, (list = []));
    list.push(e.dstId);
    let rlist = adj.get(e.dstId);
    if (!rlist) adj.set(e.dstId, (rlist = []));
    rlist.push(e.srcId);
  }
  const depths = new Map<string, number>();
  depths.set(subjectId, 0);
  const queue: string[] = [subjectId];
  while (queue.length > 0) {
    const cur = queue.shift() as string;
    const d = depths.get(cur) ?? 0;
    for (const next of adj.get(cur) ?? []) {
      if (!depths.has(next)) {
        depths.set(next, d + 1);
        queue.push(next);
      }
    }
  }
  return depths;
}

function radialLayout(subjectId: string, nodes: GraphNode[], edges: GraphEdge[]): Map<string, Point> {
  const depths = bfsDepths(subjectId, edges);
  const maxDepth = nodes.reduce((m, n) => Math.max(m, depths.get(n.elementId) ?? 0), 0);
  const positions = new Map<string, Point>();
  positions.set(subjectId, { x: 0, y: 0 });

  const rings = new Map<number, string[]>();
  for (const node of nodes) {
    if (node.elementId === subjectId) continue;
    // 未与中心连通的节点兜底放到最外圈
    const d = depths.get(node.elementId) ?? Math.min(maxDepth + 1, 6);
    const ring = rings.get(d);
    if (ring) ring.push(node.elementId);
    else rings.set(d, [node.elementId]);
  }

  for (const [depth, ringIds] of rings) {
    // 环内按 id 排序，保证同样数据多次刷新布局稳定
    const sorted = [...ringIds].sort();
    // 节点多了自动放大半径，避免卡片互相压盖
    const radius = Math.max(220 + (depth - 1) * 190, sorted.length * 26);
    const base = depth * GOLDEN_ANGLE;
    sorted.forEach((id, i) => {
      const theta = base + (2 * Math.PI * i) / sorted.length;
      positions.set(id, { x: radius * Math.cos(theta), y: radius * Math.sin(theta) });
    });
  }
  return positions;
}

/** 按两端相对方位挑选锚点：水平主导走左右，垂直主导走上下。 */
function handlePairFor(src: Point, dst: Point): { sourceHandle: string; targetHandle: string } {
  const dx = dst.x - src.x;
  const dy = dst.y - src.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0
      ? { sourceHandle: 'right-s', targetHandle: 'left-t' }
      : { sourceHandle: 'left-s', targetHandle: 'right-t' };
  }
  return dy >= 0
    ? { sourceHandle: 'bottom-s', targetHandle: 'top-t' }
    : { sourceHandle: 'top-s', targetHandle: 'bottom-t' };
}

interface CanvasLayout {
  flowNodes: ScaFlowNode[];
  flowEdges: Edge[];
  edgeMap: Map<string, GraphEdge>;
}

function buildLayout(subgraph: Subgraph, centerId: string): CanvasLayout {
  const positions = radialLayout(centerId, subgraph.nodes, subgraph.edges);
  const flowNodes: ScaFlowNode[] = subgraph.nodes.map((node) => ({
    id: node.elementId,
    type: 'sca' as const,
    position: positions.get(node.elementId) ?? { x: 0, y: 0 },
    data: { graph: node, isCenter: node.elementId === centerId },
  }));
  const flowEdges: Edge[] = subgraph.edges.map((edge) => {
    const src = positions.get(edge.srcId) ?? { x: 0, y: 0 };
    const dst = positions.get(edge.dstId) ?? { x: 0, y: 0 };
    const { sourceHandle, targetHandle } = handlePairFor(src, dst);
    const override = EDGE_STYLE_OVERRIDES[edge.type];
    const stroke = override?.color ?? EDGE_STROKE;
    return {
      id: edge.elementId,
      source: edge.srcId,
      target: edge.dstId,
      sourceHandle,
      targetHandle,
      label: edgeLabel(edge.type),
      style: { stroke, strokeWidth: 1.5, ...(override?.dashed ? { strokeDasharray: '6 4' } : {}) },
      labelStyle: { fill: '#4B5563', fontSize: 11 },
      labelBgStyle: { fill: '#FFFFFF', stroke: '#E5E7EB', strokeWidth: 1 },
      labelBgPadding: [5, 2] as [number, number],
      labelBgBorderRadius: 4,
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: stroke },
    };
  });
  const edgeMap = new Map<string, GraphEdge>();
  for (const e of subgraph.edges) edgeMap.set(e.elementId, e);
  return { flowNodes, flowEdges, edgeMap };
}

const nodeTypes: NodeTypes = { sca: GraphFlowNode };

interface GraphCanvasProps {
  subgraph: Subgraph;
  centerElementId: string | null;
  onHover: (target: InspectTarget | null) => void;
  onNodeSelect: (node: GraphNode) => void;
  onEdgeSelect: (edge: GraphEdge) => void;
  onPaneSelect: () => void;
}

/** 每次查询父层都用新 key 重建本组件，因此布局只需在挂载时计算一次。 */
export function GraphCanvas({ subgraph, centerElementId, onHover, onNodeSelect, onEdgeSelect, onPaneSelect }: GraphCanvasProps) {
  const effectiveCenter = centerElementId ?? subgraph.subject?.elementId ?? subgraph.nodes[0]?.elementId ?? '';

  const [layout] = useState<CanvasLayout>(() => buildLayout(subgraph, effectiveCenter));
  const [nodes, , onNodesChange] = useNodesState<ScaFlowNode>(layout.flowNodes);

  const handleNodeEnter: NodeMouseHandler<ScaFlowNode> = (_event, node) => {
    onHover({ type: 'node', node: node.data.graph });
  };
  const handleNodeLeave = () => onHover(null);
  const handleNodeClick: NodeMouseHandler<ScaFlowNode> = (_event, node) => {
    onNodeSelect(node.data.graph);
  };

  return (
    <ReactFlow<ScaFlowNode>
      className="sca-flow"
      nodes={nodes}
      edges={layout.flowEdges}
      onNodesChange={onNodesChange}
      nodeTypes={nodeTypes}
      onNodeClick={handleNodeClick}
      onNodeMouseEnter={handleNodeEnter}
      onNodeMouseLeave={handleNodeLeave}
      onEdgeMouseEnter={(_event, edge) => {
        const graphEdge = layout.edgeMap.get(edge.id);
        if (graphEdge) onHover({ type: 'edge', edge: graphEdge });
      }}
      onEdgeMouseLeave={handleNodeLeave}
      onEdgeClick={(_event, edge) => {
        const graphEdge = layout.edgeMap.get(edge.id);
        if (graphEdge) onEdgeSelect(graphEdge);
      }}
      onPaneMouseEnter={handleNodeLeave}
      onPaneClick={onPaneSelect}
      fitView
      fitViewOptions={{ padding: 0.25, maxZoom: 1.1 }}
      minZoom={0.15}
      zoomOnDoubleClick={false}
      nodesConnectable={false}
    >
      <Background variant={BackgroundVariant.Dots} gap={22} size={1.3} color="#CBD5E1" />
      <Controls showInteractive={false} position="bottom-left" />
      <MiniMap
        pannable
        zoomable
        position="bottom-right"
        maskColor="rgba(245, 247, 250, 0.78)"
        nodeColor={(n) => {
          const data = (n as ScaFlowNode).data as { graph?: GraphNode } | undefined;
          return kindStyle(data?.graph?.kind ?? '').color;
        }}
        nodeStrokeWidth={2}
      />
    </ReactFlow>
  );
}
