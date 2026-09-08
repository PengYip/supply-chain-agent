import clsx from 'clsx';
import { useHashRoute } from '../../hooks/useHashRoute';
import { PageHeader } from '../shell/PageHeader';
import { EntitiesView } from '../entities/EntitiesView';
import { GraphView } from '../graph/GraphView';
import type { GraphFocus, GraphFocusTarget } from '../graph/focus';

type OntologyTab = 'ledger' | 'graph';

const TABS: Array<{ key: OntologyTab; label: string }> = [
  { key: 'ledger', label: '台账' },
  { key: 'graph', label: '图谱' },
];

/** 本体视图（导航整合 2026-09-08）：实体台账与图谱合一的 tab 容器，
 *  tab 落 hash 参数（#/ontology?tab=graph，缺省台账）；旧 /entities 与 /graph
 *  路由在 parseHash 重定向至此。图谱 tab 迁入完整 GraphView，保留
 *  文档图谱/本体穿透双模式并按 focus 类型自动切换（协调者定案 2026-09-08）。 */
export function OntologyView({
  graphFocus = null,
  onOpenInGraph,
  onOpenInBindings,
}: {
  graphFocus?: GraphFocus | null;
  onOpenInGraph?: (t: GraphFocusTarget) => void;
  onOpenInBindings?: (docId: string) => void;
}) {
  const { route, navigate } = useHashRoute();
  const tab: OntologyTab = route.params['tab'] === 'graph' ? 'graph' : 'ledger';
  const setTab = (t: OntologyTab) => navigate('ontology', { tab: t }, { replace: true });

  return (
    <div className="flex h-full min-w-0 flex-col bg-surface/40">
      {/* 二级工具条（视图标题由 AppTopbar 承担）：台账/图谱分段式 Tab */}
      <PageHeader
        tabs={
          <div className="flex items-center gap-1 rounded-lg bg-surface p-0.5">
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                aria-pressed={tab === t.key}
                className={clsx(
                  'rounded-md px-3 py-1 text-xs transition-colors',
                  tab === t.key ? 'bg-white font-medium text-primary shadow-sm' : 'text-ink-soft hover:text-ink',
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
        }
      />
      <div className="min-h-0 flex-1">
        {tab === 'ledger' ? (
          <EntitiesView onOpenInGraph={onOpenInGraph} />
        ) : (
          <GraphView focus={graphFocus} onOpenInBindings={onOpenInBindings} />
        )}
      </div>
    </div>
  );
}
