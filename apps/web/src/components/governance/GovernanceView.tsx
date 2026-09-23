// apps/web/src/components/governance/GovernanceView.tsx
import clsx from 'clsx';
import { useHashRoute } from '../../hooks/useHashRoute';
import { PageHeader } from '../shell/PageHeader';
import { AuditView } from '../audit/AuditView';
import { PanoramaTab } from './PanoramaTab';
import { OntologyTab } from './OntologyTab';
import { ToolsTab } from './ToolsTab';
import { PermissionsTab } from './PermissionsTab';
import { ApprovalAuditTab } from './ApprovalAuditTab';

export type GovernanceTabId = 'panorama' | 'ontology' | 'tools' | 'permissions' | 'approvals' | 'usage';

const TABS: Array<{ id: GovernanceTabId; label: string }> = [
  { id: 'panorama', label: '全景图' },
  { id: 'ontology', label: '本体' },
  { id: 'tools', label: '工具面' },
  { id: 'permissions', label: '权限矩阵' },
  { id: 'approvals', label: '审批审计' },
  { id: 'usage', label: '用量审计' },
];

/** 治理后台（roadmap Item 6）：只读治理视图，tab 各自标注数据出处。
 *  首个 tab=本体全景图(Item 8)：一张图展现业务全景；其余 tab 沿用。
 *  无在线编辑；本体/权限变更走代码（本体注册表/permissionGate），审批决策走审批中心。
 *  tab 落 hash 参数（#/governance?tab=permissions，菜单重构 2026-09-23），
 *  与 projects/ontology/approvals/eval 的深链口径统一。
 *  用量审计自顶层视图并入为 usage tab（菜单重构 2026-09-23 二期），
 *  旧 #/audit 在 parseHash 重定向至此；AuditView 以 embedded 模式渲染，
 *  隐藏自身标题只保留 7d/30d 切换与刷新。 */
export function GovernanceView() {
  const { route, navigate } = useHashRoute();
  const tab: GovernanceTabId = TABS.some((t) => t.id === route.params['tab'])
    ? (route.params['tab'] as GovernanceTabId)
    : 'panorama';
  const setTab = (t: GovernanceTabId) =>
    navigate('governance', t === 'panorama' ? {} : { tab: t }, { replace: true });

  return (
    <div className="flex h-full flex-col bg-surface">
      <PageHeader
        tabs={
          <div className="flex items-center gap-1 rounded-lg bg-surface p-0.5">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={clsx(
                  'rounded-md px-3 py-1 text-xs transition-colors',
                  tab === t.id ? 'bg-white font-medium text-primary shadow-sm' : 'text-ink-soft hover:text-ink',
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
        }
        actions={<span className="text-xs text-ink-soft">全部只读（无在线编辑）</span>}
      />
      {tab === 'usage' ? (
        // 用量审计自带 PageHeader 工具条（embedded 隐藏标题），不套 p-6 滚动容器
        <div className="min-h-0 flex-1">
          <AuditView embedded />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          {tab === 'panorama' && <PanoramaTab />}
          {tab === 'ontology' && <OntologyTab />}
          {tab === 'tools' && <ToolsTab />}
          {tab === 'permissions' && <PermissionsTab />}
          {tab === 'approvals' && <ApprovalAuditTab />}
        </div>
      )}
    </div>
  );
}
