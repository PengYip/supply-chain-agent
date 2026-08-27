import { useEffect } from 'react';
import { ArrowRight, Crosshair, FolderKanban, MousePointerClick } from 'lucide-react';
import { docIdOf, docTypeName, edgeLabel, kindStyle, nodeDisplayName } from './businessTypes';
import { useDocMeta } from './docMeta';
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
      <div className="text-[11px] font-medium tracking-wide text-ink-soft">属性</div>
      <div className="mt-1.5 space-y-1.5">
        {entries.map(([key, value]) => (
          <div key={key} className="flex gap-2 text-[12px] leading-4">
            <span className="w-[86px] shrink-0 text-right text-ink-soft">{key}</span>
            <span className="min-w-0 break-all text-ink" title={propValueText(value)}>
              {propValueText(value)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

interface DocBindingCounts {
  confirmed: number;
  proposed: number;
}

function BindingStatusSection({
  docId,
  counts,
  failed,
  onOpenInBindings,
}: {
  docId: string;
  counts: DocBindingCounts | null;
  failed: boolean;
  onOpenInBindings?: (docId: string) => void;
}) {
  return (
    <div className="mt-2 flex items-center gap-2 text-[11px] text-ink-soft">
      {counts ? (
        <span>
          已绑定 <span className="font-semibold tabular-nums text-ink">{counts.confirmed}</span>
          {' · 待审 '}
          <span className="font-semibold tabular-nums text-warning">{counts.proposed}</span>
        </span>
      ) : failed ? (
        <span className="text-danger">绑定状态加载失败</span>
      ) : (
        <span>绑定状态加载中…</span>
      )}
      {onOpenInBindings && (
        <button
          type="button"
          onClick={() => onOpenInBindings(docId)}
          className="text-primary underline underline-offset-2 hover:text-primary-800"
        >
          去审核
        </button>
      )}
    </div>
  );
}

interface DetailPanelProps {
  inspect: InspectTarget | null;
  isCenter: (elementId: string) => boolean;
  resolveName: (elementId: string) => string;
  onExpand: (node: GraphNode) => void;
  /** part_of 归属聚合(GraphView 预计算): 节点 elementId -> 对端展示名列表。 */
  partOfLinks?: Map<string, string[]>;
  docBindingCounts?: Map<string, DocBindingCounts> | null;
  bindingCountsFailed?: boolean;
  onLoadBindingCounts?: () => void;
  onOpenInBindings?: (docId: string) => void;
}

export function DetailPanel({
  inspect,
  isCenter,
  resolveName,
  onExpand,
  partOfLinks,
  docBindingCounts,
  bindingCountsFailed = false,
  onLoadBindingCounts,
  onOpenInBindings,
}: DetailPanelProps) {
  return (
    <aside className="flex w-72 shrink-0 flex-col border-l border-line bg-white">
      <div className="shrink-0 border-b border-line px-4 py-3 text-[15px] font-semibold text-ink">
        详情
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {!inspect ? (
          <div className="flex flex-col items-center px-2 py-14 text-center">
            <MousePointerClick className="h-9 w-9 text-line" aria-hidden />
            <div className="mt-3 text-[13px] leading-5 text-ink-soft">
              悬停或点击画布中的节点、连线
              <br />
              这里会展示属性与置信度
            </div>
          </div>
        ) : inspect.type === 'node' ? (
          <NodeDetail
            node={inspect.node}
            isCenter={isCenter(inspect.node.elementId)}
            onExpand={onExpand}
            partOfLinks={partOfLinks}
            docBindingCounts={docBindingCounts}
            bindingCountsFailed={bindingCountsFailed}
            onLoadBindingCounts={onLoadBindingCounts}
            onOpenInBindings={onOpenInBindings}
          />
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
  partOfLinks,
  docBindingCounts,
  bindingCountsFailed,
  onLoadBindingCounts,
  onOpenInBindings,
}: {
  node: GraphNode;
  isCenter: boolean;
  onExpand: (node: GraphNode) => void;
  partOfLinks?: Map<string, string[]>;
  docBindingCounts?: Map<string, DocBindingCounts> | null;
  bindingCountsFailed?: boolean;
  onLoadBindingCounts?: () => void;
  onOpenInBindings?: (docId: string) => void;
}) {
  const docMeta = useDocMeta();
  const style = kindStyle(node.kind);
  const docType = docTypeName(node, docMeta);
  const displayProps = node.props
    ? Object.fromEntries(Object.entries(node.props).filter(([key]) => key !== 'name'))
    : null;
  const docId = docIdOf(node);
  const projectLinks = partOfLinks?.get(node.elementId) ?? [];
  const projectStyle = kindStyle('Project');

  // Document 节点展示绑定状态: 懒加载一次 overview(幂等, 悬停/点击都会触发)。
  useEffect(() => {
    if (node.kind === 'Document') onLoadBindingCounts?.();
  }, [node.kind, node.elementId, onLoadBindingCounts]);

  return (
    <div className="animate-fade-in">
      <div className="flex items-center gap-1.5">
        <span
          className="rounded border px-1.5 py-px text-[10px]"
          style={{ color: style.color, background: style.softBg, borderColor: style.softBorder }}
        >
          {style.label}
        </span>
        {docType && (
          <span className="rounded border border-primary/20 bg-primary/10 px-1.5 py-px text-[10px] text-primary-500">
            {docType}
          </span>
        )}
        {isCenter && <span className="rounded bg-primary px-1.5 py-px text-[10px] text-white">当前中心</span>}
      </div>
      <div className="mt-2 break-all text-[14px] font-medium leading-5 text-ink">{nodeDisplayName(node, docMeta)}</div>
      <div className="mt-1 break-all font-mono text-[10px] leading-4 text-ink-soft">{node.elementId}</div>
      {node.kind === 'Document' && (
        <BindingStatusSection
          docId={docId}
          counts={docBindingCounts?.get(docId) ?? null}
          failed={bindingCountsFailed ?? false}
          onOpenInBindings={onOpenInBindings}
        />
      )}
      {projectLinks.length > 0 && (
        <div className="mt-2.5">
          <div className="text-[11px] font-medium tracking-wide text-ink-soft">项目归属</div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {projectLinks.map((name, i) => (
              <span
                key={`${name}-${i}`}
                className="inline-flex items-center gap-1 rounded border px-1.5 py-px text-[10px]"
                style={{
                  color: projectStyle.color,
                  background: projectStyle.softBg,
                  borderColor: projectStyle.softBorder,
                }}
                title={`经 part_of 归属：${name}`}
              >
                <FolderKanban className="h-3 w-3" aria-hidden />
                {name}
              </span>
            ))}
          </div>
        </div>
      )}
      <PropsTable props={displayProps} />
      {!isCenter && (
        <button
          type="button"
          onClick={() => onExpand(node)}
          className="mt-4 flex w-full items-center justify-center gap-1.5 rounded-md bg-primary py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-primary-800"
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
        <span className="rounded border border-primary/20 bg-primary/10 px-1.5 py-px text-[10px] text-primary-500">
          {edgeLabel(edge.type)}
        </span>
        <span className="font-mono text-[10px] text-ink-soft">{edge.type}</span>
      </div>

      <div className="mt-2.5 space-y-1.5 rounded-md bg-surface px-3 py-2.5">
        <div className="break-all text-[12px] leading-4 text-ink">{resolveName(edge.srcId) || edge.srcId}</div>
        <div className="flex items-center gap-1 text-[11px] text-ink-soft">
          <ArrowRight className="h-3 w-3" aria-hidden />
          <span>{edgeLabel(edge.type)}</span>
        </div>
        <div className="break-all text-[12px] leading-4 text-ink">{resolveName(edge.dstId) || edge.dstId}</div>
      </div>

      {edge.confidence != null && (
        <div className="mt-3">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-medium tracking-wide text-ink-soft">置信度</span>
            <span className="tabular-nums text-[12px] font-medium text-ink">
              {formatConfidence(edge.confidence).text}
            </span>
          </div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface">
            <div
              className="h-full rounded-full bg-primary"
              style={{ width: `${Math.round(formatConfidence(edge.confidence).ratio * 100)}%` }}
            />
          </div>
        </div>
      )}

      <PropsTable props={edge.props} />
    </div>
  );
}
