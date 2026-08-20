import { Fragment } from 'react';
import clsx from 'clsx';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { FileText } from 'lucide-react';
import { KIND_ICONS, docTypeName, kindStyle, nodeDisplayName, type DocMetaResolver } from './kinds';
import { useDocMeta } from './docMeta';
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

/* 两族节点卡：
 *  - 文档（Document）：白底纸片 + 左侧藏蓝色条 + 业务类型徽章，圆角更柔；
 *  - 实体（Party/Commodity/Contract）：类别色实底 + 白字，圆角更硬，读起来是结构化对象。
 *  中心态统一放大一档并加深投影，家族区分不因中心强调而丢失。 */

/** 文档节点卡：纸片感。业务类型徽章与左栏文档列表的类型标签同款（primary-500 浅底描边）。 */
function DocumentCard({
  graph,
  isCenter,
  docMeta,
}: {
  graph: GraphNode;
  isCenter: boolean;
  docMeta: DocMetaResolver | null;
}) {
  const style = kindStyle(graph.kind);
  const name = nodeDisplayName(graph, docMeta);
  const docType = docTypeName(graph, docMeta) || '文档';
  return (
    <div
      className={clsx(
        'rounded-lg border-l-[3px] bg-white px-3 py-2 shadow-card',
        isCenter ? 'w-44 border-l-4' : 'w-40',
      )}
      style={{
        borderLeftColor: style.color,
        ...(isCenter ? { boxShadow: '0 4px 14px rgba(15, 58, 92, 0.28)' } : undefined),
      }}
      title={name}
    >
      <div className="flex items-center gap-1.5">
        <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded" style={{ background: style.softBg, color: style.color }}>
          <FileText className="h-2.5 w-2.5" aria-hidden />
        </span>
        <span className="min-w-0 max-w-[104px] shrink truncate rounded border border-primary/20 bg-primary/10 px-1.5 py-px text-[10px] leading-4 text-primary-500">
          {docType}
        </span>
        {isCenter && (
          <span className="ml-auto shrink-0 rounded bg-primary px-1.5 py-px text-[10px] leading-4 text-white">中心</span>
        )}
      </div>
      <div className="mt-1 line-clamp-2 break-all text-[13px] font-medium leading-4 text-ink">{name}</div>
      <AllSideHandles />
    </div>
  );
}

/** 实体节点卡：类别色实底反白，与文档纸片形成强烈的家族对比；类别间靠颜色区分。 */
function EntityCard({ graph, isCenter }: { graph: GraphNode; isCenter: boolean }) {
  const style = kindStyle(graph.kind);
  const Icon = KIND_ICONS[graph.kind] ?? FileText;
  const name = nodeDisplayName(graph);
  return (
    <div
      className={clsx('rounded-md px-3 py-2', isCenter ? 'w-44' : 'w-40')}
      style={{
        background: style.color,
        boxShadow: isCenter
          ? '0 4px 14px rgba(15, 58, 92, 0.35)'
          : '0 1px 3px rgba(15, 58, 92, 0.22)',
      }}
      title={name}
    >
      <div className="flex items-center gap-1.5">
        <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded" style={{ background: 'rgba(255,255,255,0.18)' }}>
          <Icon className="h-2.5 w-2.5 text-white" aria-hidden />
        </span>
        <span className="shrink-0 text-[10px] font-medium tracking-wider" style={{ color: 'rgba(255,255,255,0.85)' }}>
          {style.label}
        </span>
        {isCenter && (
          <span className="ml-auto shrink-0 rounded bg-white/20 px-1.5 py-px text-[10px] leading-4 text-white">中心</span>
        )}
      </div>
      <div className="mt-1 line-clamp-2 break-all text-[13px] font-medium leading-4 text-white">{name}</div>
      <AllSideHandles />
    </div>
  );
}

export function GraphFlowNode({ data }: NodeProps<ScaFlowNode>) {
  const { graph, isCenter } = data;
  const docMeta = useDocMeta();
  if (graph.kind === 'Document') {
    return <DocumentCard graph={graph} isCenter={isCenter} docMeta={docMeta} />;
  }
  return <EntityCard graph={graph} isCenter={isCenter} />;
}
