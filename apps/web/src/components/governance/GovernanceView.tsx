// apps/web/src/components/governance/GovernanceView.tsx
import { useState } from 'react';
import { OntologyTab } from './OntologyTab';
import { ToolsTab } from './ToolsTab';
import { PermissionsTab } from './PermissionsTab';
import { ApprovalAuditTab } from './ApprovalAuditTab';

export type GovernanceTabId = 'ontology' | 'tools' | 'permissions' | 'approvals';

const TABS: Array<{ id: GovernanceTabId; label: string }> = [
  { id: 'ontology', label: '本体' },
  { id: 'tools', label: '工具面' },
  { id: 'permissions', label: '权限矩阵' },
  { id: 'approvals', label: '审批审计' },
];

/** 治理后台（roadmap Item 6）：只读治理视图，四个 tab 各自标注数据出处。
 *  无在线编辑；本体/权限变更走代码（本体注册表/permissionGate），审批决策走审批中心。 */
export function GovernanceView() {
  const [tab, setTab] = useState<GovernanceTabId>('ontology');
  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <div className="flex items-center gap-2">
        {TABS.map((t) => (
          <button key={t.id} type="button" onClick={() => setTab(t.id)}
            className={`rounded-md px-3 py-1.5 text-sm ${tab === t.id ? 'bg-primary text-white' : 'bg-surface text-ink-soft hover:bg-line/30'}`}>
            {t.label}
          </button>
        ))}
        <span className="ml-auto text-xs text-ink-soft">全部只读（无在线编辑）</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'ontology' && <OntologyTab />}
        {tab === 'tools' && <ToolsTab />}
        {tab === 'permissions' && <PermissionsTab />}
        {tab === 'approvals' && <ApprovalAuditTab />}
      </div>
    </div>
  );
}
