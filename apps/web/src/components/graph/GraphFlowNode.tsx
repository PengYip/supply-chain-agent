import { Fragment } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { FileText } from 'lucide-react';
import { KIND_ICONS, kindStyle, nodeDisplayName } from './kinds';
import type { GraphNode } from '../../hooks/useGraph';

/** 自定义节点携带的数据：原始 GraphNode 直接透传，便于回调查询。 */
export type ScaNodeData = { graph: GraphNode; isCenter: boolean };
export type ScaFlowNode = Node<ScaNodeData, 'sca'>;

const HANDLE_SIDES = [Position.Top, Position.Right, Position.Bottom, Position.Left] as const;

/** 四边各挂一组 source/target 隐藏锚点，连线走向在布局阶段按相对方位计算。 */
export function AllSideHandles() {
  return (
    <>
      {HANDLE_SIDES.map((side) => (
        <Fragment key={side}>
          <Handle
            type="target"
            position={side}
            id={`${side}-t`}
            isConnectable={false}
            className="!h-1 !w-1 !min-h-0 !min-w-0 !border-0 !bg-transparent !opacity-0"
          />
          <Handle
            type="source"
            position={side}
            id={`${side}-s`}
            isConnectable={false}
            className="!h-1 !w-1 !min-h-0 !min-w-0 !border-0 !bg-transparent !opacity-0"
          />
        </Fragment>
      ))}
    </>
  );
}

export function GraphFlowNode({ data }: NodeProps<ScaFlowNode>) {
  const { graph, isCenter } = data;
  const style = kindStyle(graph.kind);
  const Icon = KIND_ICONS[graph.kind] ?? FileText;
  const name = nodeDisplayName(graph);

  if (isCenter) {
    // 中心节点：主色实底反白，与周围节点形成焦点
    return (
      <div
        className="w-44 rounded-lg px-3 py-2 shadow-card ring-1"
        style={{ background: style.color, boxShadow: '0 4px 14px rgba(15, 58, 92, 0.35)' }}
        title={name}
      >
        <div className="flex items-center gap-1.5">
          <span className="flex h-4 w-4 items-center justify-center rounded" style={{ background: 'rgba(255,255,255,0.18)' }}>
            <Icon className="h-2.5 w-2.5" style={{ color: '#FFFFFF' }} aria-hidden />
          </span>
          <span className="text-[10px] font-medium tracking-wider" style={{ color: 'rgba(255,255,255,0.85)' }}>
            {style.label} · 中心
          </span>
        </div>
        <div className="mt-1 line-clamp-2 text-[13px] font-medium leading-4 break-all text-white">{name}</div>
        <AllSideHandles />
      </div>
    );
  }

  // 周围节点：白卡 + 类别色徽章，克制的描边与阴影
  return (
    <div
      className="w-40 rounded-lg border bg-white px-3 py-2 shadow-card transition-shadow hover:shadow-md"
      style={{ borderColor: style.softBorder }}
      title={name}
    >
      <div className="flex items-center gap-1.5">
        <span
          className="flex h-4 w-4 items-center justify-center rounded"
          style={{ background: style.softBg, color: style.color }}
        >
          <Icon className="h-2.5 w-2.5" aria-hidden />
        </span>
        <span className="text-[10px] font-medium tracking-wider" style={{ color: style.color }}>
          {style.label}
        </span>
      </div>
      <div className="mt-1 line-clamp-2 text-[13px] leading-4 break-all text-textDark">{name}</div>
      <AllSideHandles />
    </div>
  );
}
