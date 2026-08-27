// 右侧详情面板(spec 2026-08-27 四轮): 按节点类型组织业务视图, 不再倾倒原始 props。
// 数据三来源: 节点薄 props(白名单译名) / 子图边聚合的关系洞察 / 合同台账懒加载。
import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Building2, Crosshair, FileText, FolderKanban, MousePointerClick } from 'lucide-react';
import { docIdOf, docTypeName, edgeLabel, kindStyle, nodeDisplayName } from './businessTypes';
import { useDocMeta } from './docMeta';
import { fetchContractSearch, type ContractSearchItem } from '../../api/contractSearch';
import type { GraphEdge, GraphNode, InspectTarget } from '../../hooks/useGraph';

/** 节点 props 白名单: key -> 中文业务标签(未命中进「其他属性」折叠区)。 */
const PROP_LABELS: Record<string, string> = {
  rawName: '合同编号',
  contractType: '合同类型',
  code: '项目编号',
  name: '名称',
  role: '角色',
  scope: '适用范围',
  ownerLabel: '归属主体',
  amount: '金额',
  status: '状态',
  country: '国家/地区',
};
/** 内部实现键: 永不展示。 */
const PROP_HIDDEN = new Set(['source', 'docId', 'sourceUri', 'confidence', 'graph_status']);

function propValueText(value: unknown): string {
  if (value === null) return '';
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

/** 业务属性区: 白名单字段译名直出; 剩余非内部键折叠为「其他属性」。 */
function BusinessProps({ props }: { props: Record<string, unknown> | null }) {
  const entries = useMemo(() => Object.entries(props ?? {}), [props]);
  const primary = entries.filter(([k]) => PROP_LABELS[k] && !PROP_HIDDEN.has(k));
  const rest = entries.filter(([k]) => !PROP_LABELS[k] && !PROP_HIDDEN.has(k));
  if (primary.length === 0 && rest.length === 0) return null;
  return (
    <div className="mt-3">
      <div className="text-[11px] font-medium tracking-wide text-ink-soft">业务属性</div>
      <div className="mt-1.5 space-y-1.5">
        {primary.map(([key, value]) => (
          <div key={key} className="flex gap-2 text-[12px] leading-4">
            <span className="w-[74px] shrink-0 text-right text-ink-soft">{PROP_LABELS[key]}</span>
            <span className="min-w-0 break-all font-medium text-ink">{propValueText(value)}</span>
          </div>
        ))}
      </div>
      {rest.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-[11px] text-ink-soft hover:text-ink">其他属性（{rest.length}）</summary>
          <div className="mt-1.5 space-y-1.5">
            {rest.map(([key, value]) => (
              <div key={key} className="flex gap-2 text-[12px] leading-4">
                <span className="w-[74px] shrink-0 break-all text-right text-ink-soft" title={key}>{key}</span>
                <span className="min-w-0 break-all text-ink" title={propValueText(value)}>{propValueText(value)}</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

/** 关系洞察通用行: 标签 + 数值。 */
function StatRow({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-center justify-between text-[12px] leading-5">
      <span className="text-ink-soft">{label}</span>
      <span className="tabular-nums font-medium text-ink">{value}</span>
    </div>
  );
}

function ChipList({ items, color, border, bg, icon }: {
  items: Array<{ text: string; title?: string }>;
  color: string; border: string; bg: string; icon?: React.ReactNode;
}) {
  if (items.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {items.map((it, i) => (
        <span
          key={`${it.text}-${i}`}
          className="inline-flex items-center gap-1 rounded border px-1.5 py-px text-[10px]"
          style={{ color, background: bg, borderColor: border }}
          title={it.title}
        >
          {icon}
          {it.text}
        </span>
      ))}
    </div>
  );
}

interface Insight {
  counterparties: Array<{ name: string; role: string }>;
  contractCount: number;
  docCount: number;
  participantNames: string[];
  participantRoles: string[];
}

interface DocBindingCounts { confirmed: number; proposed: number }

function BindingStatusSection({
  docId, counts, failed, onOpenInBindings,
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

/** 合同台账联动: 按合同号懒加载台账摘要(标题/买方/卖方); 未入台账静默降级隐藏。 */
function ContractLedgerSection({ contractNo }: { contractNo: string }) {
  const [item, setItem] = useState<ContractSearchItem | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'miss'>('loading');

  useEffect(() => {
    const ctrl = new AbortController();
    let alive = true;
    setState('loading');
    setItem(null);
    fetchContractSearch(contractNo, 5, ctrl.signal)
      .then((items) => {
        if (!alive) return;
        // 精确优先: contractNo/displayContractNo 等于节点合同号者胜
        const hit =
          items.find((x) => x.contractNo === contractNo || x.displayContractNo === contractNo) ??
          items.find((x) => contractNo.includes(x.contractNo) && x.contractNo.length >= 6) ??
          null;
        if (hit) { setItem(hit); setState('ready'); } else setState('miss');
      })
      .catch(() => { if (alive) setState('miss'); });
    return () => { alive = false; ctrl.abort(); };
  }, [contractNo]);

  if (state === 'miss') return null;
  if (state === 'loading') {
    return <div className="mt-3 h-[64px] animate-pulse rounded-lg bg-surface" />;
  }
  return (
    <div className="mt-3 rounded-lg border border-line bg-surface/60 px-3 py-2.5">
      <div className="text-[11px] font-medium tracking-wide text-ink-soft">台账信息</div>
      {item?.title && <div className="mt-1 line-clamp-2 text-[12.5px] leading-4 font-medium text-ink" title={item.title}>{item.title}</div>}
      <div className="mt-1.5 space-y-1">
        <StatRow label="买方" value={item?.buyer || '—'} />
        <StatRow label="卖方" value={item?.seller || '—'} />
      </div>
    </div>
  );
}

interface DetailPanelProps {
  inspect: InspectTarget | null;
  isCenter: (elementId: string) => boolean;
  resolveName: (elementId: string) => string;
  onExpand: (node: GraphNode) => void;
  partOfLinks?: Map<string, string[]>;
  insights?: Map<string, Insight>;
  docBindingCounts?: Map<string, DocBindingCounts> | null;
  bindingCountsFailed?: boolean;
  onLoadBindingCounts?: () => void;
  onOpenInBindings?: (docId: string) => void;
}

export function DetailPanel({
  inspect, isCenter, resolveName, onExpand, partOfLinks, insights,
  docBindingCounts, bindingCountsFailed = false, onLoadBindingCounts, onOpenInBindings,
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
              这里会展示业务信息与关系洞察
            </div>
          </div>
        ) : inspect.type === 'node' ? (
          <NodeDetail
            node={inspect.node}
            isCenter={isCenter(inspect.node.elementId)}
            onExpand={onExpand}
            partOfLinks={partOfLinks}
            insight={insights?.get(inspect.node.elementId)}
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

const PARTY_STYLE = { color: '#4A6D8C', softBg: '#EBF1F5', softBorder: '#CFDCE6' };
const CONTRACT_STYLE = { color: '#15803D', softBg: '#E9F4EC', softBorder: '#CBE5D3' };

function NodeDetail({
  node, isCenter, onExpand, partOfLinks, insight,
  docBindingCounts, bindingCountsFailed, onLoadBindingCounts, onOpenInBindings,
}: {
  node: GraphNode;
  isCenter: boolean;
  onExpand: (node: GraphNode) => void;
  partOfLinks?: Map<string, string[]>;
  insight?: Insight;
  docBindingCounts?: Map<string, DocBindingCounts> | null;
  bindingCountsFailed?: boolean;
  onLoadBindingCounts?: () => void;
  onOpenInBindings?: (docId: string) => void;
}) {
  const docMeta = useDocMeta();
  const style = kindStyle(node.kind);
  const docType = docTypeName(node, docMeta);
  const displayName = nodeDisplayName(node, docMeta);
  const docId = docIdOf(node);
  const projectLinks = partOfLinks?.get(node.elementId) ?? [];

  useEffect(() => {
    if (node.kind === 'Document') onLoadBindingCounts?.();
  }, [node.kind, node.elementId, onLoadBindingCounts]);

  const isContract = node.kind === 'Contract';
  // 合同号: props.rawName 优先(台账 SSOT 键), 老数据回退展示名本身
  const contractNo = isContract
    ? (typeof node.props?.rawName === 'string' && node.props.rawName ? node.props.rawName : displayName)
    : '';

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
      <div className="mt-2 break-all text-[14px] font-medium leading-5 text-ink" title={node.elementId}>
        {displayName}
      </div>

      {/* 合同: 台账业务信息(标题/买方/卖方) */}
      {isContract && <ContractLedgerSection contractNo={contractNo} />}

      {/* 单据: 绑定状态 + 去审核 */}
      {node.kind === 'Document' && (
        <BindingStatusSection
          docId={docId}
          counts={docBindingCounts?.get(docId) ?? null}
          failed={bindingCountsFailed ?? false}
          onOpenInBindings={onOpenInBindings}
        />
      )}

      {/* 关系洞察: 对手方(交易视角最有用的信息) */}
      {(insight?.counterparties.length ?? 0) > 0 && (
        <div className="mt-2.5">
          <div className="text-[11px] font-medium tracking-wide text-ink-soft">对手方</div>
          <ChipList
            items={(insight?.counterparties ?? []).map((c) => ({
              text: c.role ? `${c.name} · ${c.role}` : c.name,
              title: c.name,
            }))}
            color={PARTY_STYLE.color}
            border={PARTY_STYLE.softBorder}
            bg={PARTY_STYLE.softBg}
            icon={<Building2 className="h-3 w-3" aria-hidden />}
          />
        </div>
      )}

      {/* 交易方: 关联合同清单 */}
      {node.kind === 'Party' && (insight?.contractCount ?? 0) > 0 && (
        <div className="mt-2.5">
          <div className="text-[11px] font-medium tracking-wide text-ink-soft">关联合同</div>
          <ChipList
            items={[{ text: `${insight?.contractCount} 份` }]}
            color={CONTRACT_STYLE.color}
            border={CONTRACT_STYLE.softBorder}
            bg={CONTRACT_STYLE.softBg}
            icon={<FileText className="h-3 w-3" aria-hidden />}
          />
        </div>
      )}

      {/* 项目: 参与主体 + 规模统计 */}
      {node.kind === 'Project' && (
        <div className="mt-2.5 space-y-1">
          <StatRow label="合同数" value={insight?.contractCount ?? 0} />
          <StatRow label="履约单据" value={insight?.docCount ?? 0} />
          {(insight?.participantRoles.length ?? 0) > 0 && (
            <StatRow label="参与方" value={insight!.participantRoles.join(' / ')} />
          )}
        </div>
      )}
      {node.kind === 'Project' && (insight?.participantNames.length ?? 0) > 0 && (
        <ChipList
          items={(insight?.participantNames ?? []).map((n) => ({ text: n, title: n }))}
          color={PARTY_STYLE.color}
          border={PARTY_STYLE.softBorder}
          bg={PARTY_STYLE.softBg}
        />
      )}

      {/* 合同: 履约单据计数 */}
      {isContract && (insight?.docCount ?? 0) > 0 && (
        <div className="mt-2.5">
          <StatRow label="履约单据" value={insight!.docCount} />
        </div>
      )}

      {/* 项目归属(part_of 聚合) */}
      {projectLinks.length > 0 && (
        <div className="mt-2.5">
          <div className="text-[11px] font-medium tracking-wide text-ink-soft">项目归属</div>
          <ChipList
            items={projectLinks.map((name) => ({ text: name, title: `经 part_of 归属：${name}` }))}
            color="#6D5FC3"
            border="#D8D0F0"
            bg="#EEEBF8"
            icon={<FolderKanban className="h-3 w-3" aria-hidden />}
          />
        </div>
      )}

      <BusinessProps props={node.props} />

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
      </div>

      <div className="mt-2.5 space-y-1.5 rounded-md bg-surface px-3 py-2.5">
        <div className="break-all text-[12px] leading-4 text-ink">{resolveName(edge.srcId) || edge.srcId}</div>
        <div className="flex items-center gap-1 text-[11px] text-ink-soft">
          <ArrowRight className="h-3 w-3" aria-hidden />
          <span>{edgeLabel(edge.type)}</span>
        </div>
        <div className="break-all text-[12px] leading-4 text-ink">{resolveName(edge.dstId) || edge.dstId}</div>
      </div>

      {edge.props?.role != null && (
        <div className="mt-2.5">
          <StatRow label="角色" value={String(edge.props.role)} />
        </div>
      )}

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

      <BusinessProps props={edge.props} />
    </div>
  );
}
