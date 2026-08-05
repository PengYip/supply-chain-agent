import React from 'react'
import {
  LayoutDashboard,
  FileText,
  FileDiff,
  ClipboardCheck,
  Clock,
  ArrowRight,
  Minimize2,
  Maximize2,
  ExternalLink,
  GitCompare,
  Link2,
  Plus,
  Settings,
  ShieldCheck,
} from 'lucide-react'
import { type Task, type ChangeEntry, type ArtifactReference, type Project } from '../data/mock'
import { ContractCard, OrderTimeline, ReconciliationDiff, LinkedDocuments, FieldConfidenceList, OCRFieldCheckCard } from './BusinessCards'
import { LifecycleBar, StageBadge } from './LifecycleBar'
import { ProjectSettingsPanel } from './ProjectSettingsPanel'
import { AuditTimeline } from './AuditTimeline'
import { buildAuditTimeline } from '../data/mock'
import clsx from 'clsx'

type TabKey = 'overview' | 'artifacts' | 'changes' | 'audit' | 'settings'

interface ResultPanelProps {
  task: Task | null
  project: Project | null
  activeTab: TabKey
  onTabChange: (tab: TabKey) => void
  collapsed?: boolean
  onToggle?: () => void
}

const TabButton: React.FC<{
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
}> = ({ active, onClick, icon, label }) => (
  <button
    onClick={onClick}
    className={clsx(
      'flex items-center gap-1.5 px-2.5 py-2 text-xs font-medium transition-colors border-b-2',
      active
        ? 'text-deepSea border-deepSea bg-white'
        : 'text-textGray border-transparent hover:text-textDark hover:bg-white/50'
    )}
  >
    {icon}
    {label}
  </button>
)

const ChangeRow: React.FC<{ change: ChangeEntry }> = ({ change }) => {
  const icon = change.type === 'link' ? Link2 : change.type === 'create' ? Plus : GitCompare
  const Icon = icon
  return (
    <div className="relative pl-5 py-2 border-l-2 border-borderGray ml-1.5">
      <div className="absolute -left-[5px] top-3 w-2.5 h-2.5 rounded-full bg-white border-2 border-steelBlue" />
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2">
          <Icon className="w-3.5 h-3.5 text-steelBlue" />
          <span className="text-sm font-medium text-textDark">{change.title}</span>
        </div>
        <span className="text-[10px] text-textGray tabular-nums">{change.timestamp}</span>
      </div>
      <p className="text-xs text-textGray mt-1">{change.description}</p>
      {change.from && change.to && (
        <div className="mt-1.5 flex items-center gap-2 text-xs font-mono">
          <span className="px-1.5 py-0.5 rounded bg-danger/10 text-danger line-through">{change.from}</span>
          <ArrowRight className="w-3 h-3 text-textGray" />
          <span className="px-1.5 py-0.5 rounded bg-success/10 text-success">{change.to}</span>
        </div>
      )}
      <div className="mt-1.5 text-[10px] text-textGray/70 flex items-center gap-1">
        <Clock className="w-3 h-3" /> 由 {change.actor === 'agent' ? 'AI 助手' : '用户'} 执行
      </div>
    </div>
  )
}

const ArtifactRenderer: React.FC<{ artifact: ArtifactReference }> = ({ artifact }) => {
  if (artifact.type === 'contract_summary') return <ContractCard variant={artifact.payload === 'hitl-contract' ? 'hitl' : 'default'} />
  if (artifact.type === 'order_status') return <OrderTimeline variant={artifact.payload === 'hitl-orders' ? 'hitl' : 'default'} />
  if (artifact.type === 'reconciliation') return <ReconciliationDiff payload={artifact.payload} />
  if (artifact.type === 'reconciliation_draft') return <ReconciliationDiff payload={artifact.payload} />
  if (artifact.type === 'linked_documents') return (
    <div className="space-y-3">
      <LinkedDocuments />
      <FieldConfidenceList />
    </div>
  )
  if (artifact.type === 'ocr_field_check') return <OCRFieldCheckCard />
  return null
}

export const ResultPanel: React.FC<ResultPanelProps> = ({
  task,
  project,
  activeTab,
  onTabChange,
  collapsed,
  onToggle,
}) => {
  if (!task && !project) return null

  const artifacts = task?.artifacts || []
  const changes = task?.changes || []

  return (
    <div className={clsx(
      'h-full flex flex-col bg-white border-l border-borderGray shrink-0 transition-all duration-300',
      collapsed ? 'w-14' : 'w-[340px]'
    )}>
      <div className="h-12 border-b border-borderGray flex items-center justify-between px-2 bg-bgGray">
        {!collapsed && (
          <div className="flex items-center">
            <TabButton
              active={activeTab === 'overview'}
              onClick={() => onTabChange('overview')}
              icon={<LayoutDashboard className="w-3.5 h-3.5" />}
              label="概览"
            />
            <TabButton
              active={activeTab === 'artifacts'}
              onClick={() => onTabChange('artifacts')}
              icon={<FileText className="w-3.5 h-3.5" />}
              label="结果"
            />
            <TabButton
              active={activeTab === 'changes'}
              onClick={() => onTabChange('changes')}
              icon={<FileDiff className="w-3.5 h-3.5" />}
              label="变更"
            />
            <TabButton
              active={activeTab === 'audit'}
              onClick={() => onTabChange('audit')}
              icon={<ShieldCheck className="w-3.5 h-3.5" />}
              label="审计"
            />
            <TabButton
              active={activeTab === 'settings'}
              onClick={() => onTabChange('settings')}
              icon={<Settings className="w-3.5 h-3.5" />}
              label="配置"
            />
          </div>
        )}
        <button
          onClick={onToggle}
          className="p-1.5 rounded hover:bg-borderGray text-textGray ml-auto"
          title={collapsed ? '展开右侧面板' : '收起右侧面板'}
        >
          {collapsed ? <Maximize2 className="w-4 h-4" /> : <Minimize2 className="w-4 h-4" />}
        </button>
      </div>

      {collapsed ? (
        <div className="flex-1 flex flex-col items-center pt-4 gap-4 text-textGray">
          {(['overview', 'artifacts', 'changes', 'audit', 'settings'] as TabKey[]).map((tab) => (
            <button
              key={tab}
              onClick={() => onTabChange(tab)}
              className={clsx('p-2 rounded-lg transition-colors', activeTab === tab && 'bg-amber/10 text-amber')}
              title={tab === 'overview' ? '概览' : tab === 'artifacts' ? '结果' : tab === 'changes' ? '变更' : tab === 'audit' ? '审计' : '配置'}
            >
              {tab === 'overview' && <LayoutDashboard className="w-4 h-4" />}
              {tab === 'artifacts' && <FileText className="w-4 h-4" />}
              {tab === 'changes' && <FileDiff className="w-4 h-4" />}
              {tab === 'audit' && <ShieldCheck className="w-4 h-4" />}
              {tab === 'settings' && <Settings className="w-4 h-4" />}
            </button>
          ))}
        </div>
      ) : (
        <div className="flex-1 overflow-auto p-4 space-y-4">
          {activeTab === 'overview' && (
            <div className="space-y-4 animate-fade-in">
              {project && (
                <div className="rounded-xl border-2 border-deepSea/20 bg-white overflow-hidden">
                  <div className="px-3 py-2 bg-deepSea/5 border-b border-deepSea/10 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <ClipboardCheck className="w-4 h-4 text-deepSea" />
                      <span className="text-sm font-medium text-textDark">项目生命周期</span>
                    </div>
                    <StageBadge stageName={project.stages[project.stage]} />
                  </div>
                  <div className="p-4">
                    <LifecycleBar stages={project.stages} currentStage={project.stage} />
                    <div className="mt-3 text-xs text-textGray leading-relaxed">
                      项目 {project.name} 当前处于“{project.stages[project.stage]}”阶段。下一阶段为“{project.stages[Math.min(project.stage + 1, project.stages.length - 1)]}”。
                    </div>
                  </div>
                </div>
              )}

              <div className="rounded-lg border border-borderGray bg-white p-3">
                <div className="text-xs text-textGray mb-2 flex items-center gap-1">
                  <ClipboardCheck className="w-3.5 h-3.5" /> 当前任务
                </div>
                <div className="text-sm font-medium text-textDark">{task?.title || project?.name}</div>
                {task && (
                  <div className="mt-2 flex items-center gap-2">
                    <span className={clsx(
                      'text-xs px-1.5 py-0.5 rounded',
                      task.status === '进行中' ? 'bg-steelBlue/10 text-steelBlue' : 'bg-success/10 text-success'
                    )}>
                      {task.status}
                    </span>
                    <span className="text-xs text-textGray">{task.updatedAt}</span>
                  </div>
                )}
              </div>

              <ContractCard />

              <div className="rounded-lg border border-borderGray bg-white overflow-hidden">
                <div className="px-3 py-2 border-b border-borderGray bg-deepSea/5 flex items-center gap-2">
                  <FileText className="w-4 h-4 text-steelBlue" />
                  <span className="text-sm font-medium text-textDark">关联单据</span>
                </div>
                <div className="p-3 space-y-2">
                  {(project?.docLibrary || ['合同 HT-2024.pdf', '订单 PO-202408', '收款单 RZ-202408', '发票 FP-202408'].map((name) => ({ name, type: '单据', size: '' }))).map((doc) => (
                    <div key={doc.name} className="flex items-center justify-between text-sm">
                      <div className="flex items-center gap-2">
                        <FileText className="w-4 h-4 text-steelBlue" />
                        <span className="text-textDark">{doc.name}</span>
                      </div>
                      <button className="text-xs text-steelBlue hover:text-deepSea flex items-center gap-0.5">
                        查看原件 <ExternalLink className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {activeTab === 'artifacts' && (
            <div className="space-y-4 animate-fade-in">
              {artifacts.length === 0 && (
                <div className="text-center py-8 text-textGray text-sm">
                  <FileText className="w-8 h-8 mx-auto mb-2 text-borderGray" />
                  暂无生成结果
                </div>
              )}
              {artifacts.map((artifact) => (
                <ArtifactRenderer key={artifact.id} artifact={artifact} />
              ))}
            </div>
          )}

          {activeTab === 'changes' && (
            <div className="animate-fade-in">
              {changes.length === 0 && (
                <div className="text-center py-8 text-textGray text-sm">
                  <GitCompare className="w-8 h-8 mx-auto mb-2 text-borderGray" />
                  暂无变更记录
                </div>
              )}
              {changes.length > 0 && (
                <div className="space-y-1">
                  {changes.map((change) => (
                    <ChangeRow key={change.id} change={change} />
                  ))}
                </div>
              )}
            </div>
          )}

          {activeTab === 'audit' && task && (
            <div className="animate-fade-in">
              <AuditTimeline events={buildAuditTimeline(task)} />
            </div>
          )}

          {activeTab === 'audit' && !task && (
            <div className="text-center py-8 text-textGray text-sm">
              <ShieldCheck className="w-8 h-8 mx-auto mb-2 text-borderGray" />
              未选中任务
            </div>
          )}

          {activeTab === 'settings' && project && (
            <ProjectSettingsPanel project={project} />
          )}

          {activeTab === 'settings' && !project && (
            <div className="text-center py-8 text-textGray text-sm">
              <Settings className="w-8 h-8 mx-auto mb-2 text-borderGray" />
              未选中项目
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export { ContractCard, OrderTimeline, ReconciliationDiff, LinkedDocuments, FieldConfidenceList }
