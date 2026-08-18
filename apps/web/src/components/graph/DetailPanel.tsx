import { ArrowRight, Crosshair, MousePointerClick } from 'lucide-react';
import { edgeLabel, kindStyle, nodeDisplayName } from './kinds';
import type { GraphEdge, GraphNode, InspectTarget } from '../../hooks/useGraph';

/** props 值格式化为短文本；对象截断序列化。 */
function propValueText(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    const s = JSON.stringify(value);
    return s && s.length > 90 ? `${s.slice(0, 90)}...` : (s ?? '');
  } catch {
    return String(value);
  }
}

function formatConfidence(c: number): { text: string; ratio: number } {
  if (c >= 0 && c <= 1) return { text: `${Math.round(c * 100)}%`, ratio: c };
  return { text: String(c), ratio: 1 };
}

function PropsTable({ props }: { props: Record<string, unknown> | null }) {
  if (!props) return null;
  const entries = Object.entries(props);
  if (entries.length === 0) return null;
  return (
    <div className="mt-3">
      <div className="text-[11px] font-medium tracking-wide text-textGray">属性</div>
      <div className="mt-1.5 space-y-1.5">
        {entries.map(([key, value]) => (
          <div key={key} className="flex gap-2 text-[12px] leading-4">
            <span className="w-[86px] shrink-0 text-right text-textGray">{key}</span>
            <span className="min-w-0 break-all text-textDark" title={propValueText(value)}>
              {propValueText(value)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

interface DetailPanelProps {
  inspect: InspectTarget | null;
  isCenter: (elementId: string) => boolean;
  resolveName: (elementId: string) => string;
  onExpand: (node: GraphNode) => void;
}

export function DetailPanel({ inspect, isCenter, resolveName, onExpand }: DetailPanelProps) {
  return (
    <aside className="flex w-72 shrink-0 flex-col border-l border-borderGray bg-white">
      <div className="shrink-0 border-b border-borderGray px-4 py-3 text-[15px] font-semibold text-textDark">
        详情
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {!inspect ? (
          <div className="flex flex-col items-center px-2 py-14 text-center">
            <MousePointerClick className="h-9 w-9 text-borderGray" aria-hidden />
            <div className="mt-3 text-[13px] leading-5 text-textGray">
              悬停或点击画布中的节点、连线
              <br />
              这里会展示属性与置信度
            </div>
          </div>
        ) : inspect.type === 'node' ? (
          <NodeDetail node={inspect.node} isCenter={isCenter(inspect.node.elementId)} onExpand={onExpand} />
        ) : (
          <EdgeDetail edge={inspect.edge} resolveName={resolveName} />
        )}
      </div>
    </aside>
  );
}

function NodeDetail({
  node,
  isCenter,
  onExpand,
}: {
  node: GraphNode;
  isCenter: boolean;
  onExpand: (node: GraphNode) => void;
}) {
  const style = kindStyle(node.kind);
  const displayProps = node.props
    ? Object.fromEntries(Object.entries(node.props).filter(([key]) => key !== 'name'))
    : null;
  return (
    <div className="animate-fade-in">
      <div className="flex items-center gap-1.5">
        <span
          className="rounded border px-1.5 py-px text-[10px]"
          style={{ color: style.color, background: style.softBg, borderColor: style.softBorder }}
        >
          {style.label}
        </span>
        {isCenter && <span className="rounded bg-deepSea px-1.5 py-px text-[10px] text-white">当前中心</span>}
      </div>
      <div className="mt-2 break-all text-[14px] font-medium leading-5 text-textDark">{nodeDisplayName(node)}</div>
      <div className="mt-1 break-all font-mono text-[10px] leading-4 text-textGray">{node.elementId}</div>
      <PropsTable props={displayProps} />
      {!isCenter && (
        <button
          type="button"
          onClick={() => onExpand(node)}
          className="mt-4 flex w-full items-center justify-center gap-1.5 rounded-md bg-deepSea py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-[#164a76]"
        >
          <Crosshair className="h-3.5 w-3.5" aria-hidden />
          以此为中心展开
        </button>
      )}
    </div>
  );
}

function EdgeDetail({ edge, resolveName }: { edge: GraphEdge; resolveName: (elementId: string) => string }) {
  return (
    <div className="animate-fade-in">
      <div className="flex items-center gap-1.5">
        <span className="rounded border border-[#D8E2EB] bg-[#EEF2F6] px-1.5 py-px text-[10px] text-steelBlue">
          {edgeLabel(edge.type)}
        </span>
        <span className="font-mono text-[10px] text-textGray">{edge.type}</span>
      </div>

      <div className="mt-2.5 space-y-1.5 rounded-md bg-bgGray px-3 py-2.5">
        <div className="break-all text-[12px] leading-4 text-textDark">{resolveName(edge.srcId) || edge.srcId}</div>
        <div className="flex items-center gap-1 text-[11px] text-textGray">
          <ArrowRight className="h-3 w-3" aria-hidden />
          <span>{edgeLabel(edge.type)}</span>
        </div>
        <div className="break-all text-[12px] leading-4 text-textDark">{resolveName(edge.dstId) || edge.dstId}</div>
      </div>

      {edge.confidence != null && (
        <div className="mt-3">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-medium tracking-wide text-textGray">置信度</span>
            <span className="tabular-nums text-[12px] font-medium text-textDark">
              {formatConfidence(edge.confidence).text}
            </span>
          </div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-bgGray">
            <div
              className="h-full rounded-full bg-deepSea"
              style={{ width: `${Math.round(formatConfidence(edge.confidence).ratio * 100)}%` }}
            />
          </div>
        </div>
      )}

      <PropsTable props={edge.props} />
    </div>
  );
}
