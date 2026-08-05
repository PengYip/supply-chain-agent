import React from 'react'
import {
  ShieldCheck,
  Users,
  Zap,
  Plug,
  BookOpen,
  Layers,
  Info,
  Lock,
  Unlock,
  AlertCircle,
  AlertTriangle,
  FileCheck,
  Circle,
} from 'lucide-react'
import { type Role, type RoleToolkit, ROLE_TOOLKITS, ROLE_LABELS } from '../data/mock'
import { RoleSwitcher } from './RoleSwitcher'
import { Card } from './ui/Card'
import clsx from 'clsx'

interface RoleToolkitViewProps {
  role: Role
  onRoleChange: (role: Role) => void
}

const SectionHeader: React.FC<{ icon: React.ReactNode; title: string }> = ({ icon, title }) => (
  <div className="flex items-center gap-2 text-textDark mb-3">
    {icon}
    <span className="text-sm font-bold">{title}</span>
  </div>
)

const GuardrailDot: React.FC<{ severity: RoleToolkit['guardrails'][0]['severity'] }> = ({ severity }) => {
  const cls = {
    block: 'bg-danger',
    warn: 'bg-warning',
    info: 'bg-steelBlue',
  }
  return <span className={clsx('w-2 h-2 rounded-full shrink-0 mt-1.5', cls[severity])} />
}

const PermissionTag: React.FC<{ permission: 'L1' | 'L2' | 'L3' }> = ({ permission }) => {
  const map = {
    L1: { cls: 'bg-success text-white', label: 'L1 只读' },
    L2: { cls: 'bg-warning text-white', label: 'L2 写需确认' },
    L3: { cls: 'bg-danger text-white', label: 'L3 双人审批' },
  }
  return (
    <span
      className={clsx('text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0', map[permission].cls)}
      title={permission === 'L1' ? '只读自动，无副作用查询' : permission === 'L2' ? '内部写操作需用户确认' : '资金/合同不可逆高风险，需双人审批'}
    >
      {map[permission].label}
    </span>
  )
}

const AuthTag: React.FC<{ auth: 'public' | 'personal' }> = ({ auth }) => (
  <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-bgGray text-textGray border border-borderGray">
    {auth === 'public' ? <Unlock className="w-3 h-3" /> : <Lock className="w-3 h-3" />}
    {auth === 'public' ? '公共授权' : '个人授权'}
  </span>
)

const CategoryBadge: React.FC<{ category: 'readonly' | 'approval' }> = ({ category }) => {
  const isReadonly = category === 'readonly'
  return (
    <span className={clsx(
      'inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full font-medium',
      isReadonly ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning'
    )}>
      {isReadonly ? <FileCheck className="w-3 h-3" /> : <AlertTriangle className="w-3 h-3" />}
      {isReadonly ? '只读查询类' : '写操作审批类'}
    </span>
  )
}

const ConnectorCard: React.FC<{ connector: RoleToolkit['connectors'][0] }> = ({ connector }) => (
  <div className="rounded-lg border border-borderGray bg-white p-3">
    <div className="flex items-center justify-between mb-2">
      <div className="flex items-center gap-2">
        <Plug className="w-4 h-4 text-steelBlue" />
        <span className="text-sm font-medium text-textDark">{connector.name}</span>
      </div>
      <div className="flex items-center gap-2">
        <CategoryBadge category={connector.category} />
        <AuthTag auth={connector.auth} />
      </div>
    </div>
    <div className="space-y-1.5">
      {connector.tools.map((tool) => (
        <div
          key={tool.name}
          className="flex items-start justify-between gap-3 py-1.5 px-2 rounded bg-bgGray/50"
        >
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-mono text-steelBlue font-medium">{tool.name}</span>
              <span className="text-xs text-textDark">{tool.label}</span>
              <PermissionTag permission={tool.permission} />
            </div>
            <div className="text-[11px] text-textGray mt-0.5">{tool.desc}</div>
          </div>
          <div className="text-[10px] text-textGray/70 shrink-0 text-right">{tool.source}</div>
        </div>
      ))}
    </div>
  </div>
)

export const RoleToolkitView: React.FC<RoleToolkitViewProps> = ({ role, onRoleChange }) => {
  const toolkit = ROLE_TOOLKITS[role]
  const readonlyConnectors = toolkit.connectors.filter((c) => c.category === 'readonly')
  const approvalConnectors = toolkit.connectors.filter((c) => c.category === 'approval')

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-bgGray h-full overflow-auto">
      {/* Top strip */}
      <div className="h-14 bg-white border-b border-borderGray flex items-center justify-between px-5 shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-deepSea/10 flex items-center justify-center shrink-0">
            <Layers className="w-4 h-4 text-deepSea" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-medium text-textDark truncate">岗位工具集</div>
            <div className="text-xs text-textGray">{ROLE_LABELS[role]}</div>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <span className="hidden md:inline text-xs text-textGray max-w-md truncate">{toolkit.tagline}</span>
          <RoleSwitcher currentRole={role} onRoleChange={onRoleChange} variant="light" />
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 p-5">
        <div className="max-w-5xl mx-auto space-y-5">
          {/* Tagline mobile */}
          <div className="md:hidden text-sm text-textGray bg-white border border-borderGray rounded-lg p-3">
            {toolkit.tagline}
          </div>

          {/* Guardrails */}
          <Card title={<SectionHeader icon={<ShieldCheck className="w-4 h-4 text-danger" />} title="护栏规则" />}>
            <div className="space-y-2">
              {toolkit.guardrails.map((g, idx) => (
                <div key={idx} className="flex items-start gap-2 text-sm">
                  <GuardrailDot severity={g.severity} />
                  <span className="text-textDark leading-relaxed">{g.rule}</span>
                </div>
              ))}
            </div>
          </Card>

          {/* Experts */}
          <Card title={<SectionHeader icon={<Users className="w-4 h-4 text-steelBlue" />} title="专家人设" />}>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {toolkit.experts.map((expert, idx) => (
                <div key={idx} className="rounded-lg border border-borderGray bg-bgGray/50 p-3">
                  <div className="text-sm font-medium text-textDark">{expert.name}</div>
                  <div className="text-xs text-textGray mt-0.5">{expert.persona}</div>
                  <div className="mt-2 space-y-1">
                    {expert.methodology.map((m, i) => (
                      <div key={i} className="flex items-start gap-1.5 text-xs text-textDark">
                        <Circle className="w-1.5 h-1.5 fill-steelBlue text-steelBlue shrink-0 mt-1" />
                        {m}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </Card>

          {/* Skills */}
          <Card title={<SectionHeader icon={<Zap className="w-4 h-4 text-amber" />} title="技能 SOP" />}>
            <div className="space-y-3">
              {toolkit.skills.map((skill, idx) => (
                <div key={idx} className="flex items-start gap-3">
                  <div className="w-6 h-6 rounded-full bg-amber/10 flex items-center justify-center shrink-0 text-xs font-medium text-amber">
                    {idx + 1}
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-textDark">{skill.name}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-steelBlue/10 text-steelBlue">触发：{skill.trigger}</span>
                    </div>
                    <div className="text-xs text-textGray mt-0.5 leading-relaxed">{skill.sop}</div>
                  </div>
                </div>
              ))}
            </div>
          </Card>

          {/* Connectors */}
          <Card title={<SectionHeader icon={<Plug className="w-4 h-4 text-success" />} title="连接器" />}>
            <div className="space-y-4">
              {/* Readonly */}
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <FileCheck className="w-3.5 h-3.5 text-success" />
                  <span className="text-xs font-medium text-success">只读查询类（L1 自动）</span>
                </div>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                  {readonlyConnectors.map((connector) => (
                    <ConnectorCard key={connector.name} connector={connector} />
                  ))}
                </div>
              </div>

              {/* Approval */}
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <AlertCircle className="w-3.5 h-3.5 text-warning" />
                  <span className="text-xs font-medium text-warning">写操作审批类（L2 确认 / L3 双人审批）</span>
                </div>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                  {approvalConnectors.map((connector) => (
                    <ConnectorCard key={connector.name} connector={connector} />
                  ))}
                </div>
              </div>
            </div>
          </Card>

          {/* Knowledge */}
          <Card title={<SectionHeader icon={<BookOpen className="w-4 h-4 text-deepSea" />} title="资料库" />}>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
              {toolkit.knowledge.map((doc, idx) => (
                <div key={idx} className="rounded-lg border border-borderGray bg-white p-3 hover:border-deepSea/30 transition-colors">
                  <div className="text-xs text-textGray mb-1">{doc.type}</div>
                  <div className="text-sm font-medium text-textDark leading-snug">{doc.title}</div>
                </div>
              ))}
            </div>
          </Card>

          {/* Footer note */}
          <div className="flex items-start gap-2 text-xs text-textGray italic bg-white border border-borderGray rounded-lg p-3">
            <Info className="w-3.5 h-3.5 text-steelBlue shrink-0 mt-0.5" />
            此视图展示岗位 {ROLE_LABELS[role]} 的工具集配置。生产环境中由管理员统一配置，成员自动继承；当前为原型 mock 数据，用于演示与指导后续开发。
          </div>
        </div>
      </div>
    </div>
  )
}

export default RoleToolkitView
