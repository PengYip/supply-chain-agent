import React from 'react'
import {
  FileText,
  Users,
  Plug,
  Wrench,
  Library,
  CheckCircle2,
  Clock,
  AlertCircle,
  ExternalLink,
} from 'lucide-react'
import { type Project } from '../data/mock'
import clsx from 'clsx'

interface ProjectSettingsPanelProps {
  project: Project
}

const SectionHeader: React.FC<{ icon: React.ReactNode; title: string }> = ({ icon, title }) => (
  <div className="flex items-center gap-2 text-xs font-medium text-textGray uppercase tracking-wider mb-3">
    {icon}
    {title}
  </div>
)

export const ProjectSettingsPanel: React.FC<ProjectSettingsPanelProps> = ({ project }) => {
  return (
    <div className="space-y-5 animate-fade-in">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-textDark">项目配置</div>
        <span className="text-xs text-textGray">{project.stages[project.stage]} · {project.status}</span>
      </div>

      <div className="rounded-xl border-2 border-deepSea/20 bg-white overflow-hidden">
        <div className="px-4 py-2 bg-deepSea/5 border-b border-deepSea/10 flex items-center gap-2">
          <FileText className="w-4 h-4 text-deepSea" />
          <span className="text-sm font-medium text-textDark">指令 Instructions</span>
        </div>
        <div className="p-4 text-sm text-textDark leading-relaxed">
          {project.instructions}
        </div>
      </div>

      <div>
        <SectionHeader icon={<Users className="w-3.5 h-3.5" />} title="专家 Experts" />
        <div className="grid grid-cols-1 gap-2">
          {project.experts.map((expert) => (
            <div key={expert.name} className="flex items-start gap-3 p-3 rounded-lg border border-borderGray bg-white hover:border-steelBlue/30 transition-colors">
              <div className="w-8 h-8 rounded-full bg-steelBlue/10 flex items-center justify-center shrink-0">
                <Users className="w-4 h-4 text-steelBlue" />
              </div>
              <div>
                <div className="text-sm font-medium text-textDark">{expert.name}</div>
                <div className="text-xs text-textGray mt-0.5">{expert.description}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div>
        <SectionHeader icon={<Plug className="w-3.5 h-3.5" />} title="连接器 Connectors" />
        <div className="space-y-2">
          {project.connectors.map((connector) => (
            <div key={connector.name} className="flex items-center justify-between p-3 rounded-lg border border-borderGray bg-white">
              <div className="flex items-center gap-2">
                <Plug className={clsx('w-4 h-4', connector.status === 'connected' ? 'text-success' : 'text-textGray')} />
                <span className="text-sm text-textDark">{connector.name}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className={clsx(
                  'text-[10px] px-1.5 py-0.5 rounded border',
                  connector.authType === 'public'
                    ? 'bg-success/10 text-success border-success/20'
                    : 'bg-steelBlue/10 text-steelBlue border-steelBlue/20'
                )}>
                  {connector.authType === 'public' ? '公共授权' : '个人授权'}
                </span>
                <span className={clsx(
                  'text-[10px] px-1.5 py-0.5 rounded flex items-center gap-0.5',
                  connector.status === 'connected'
                    ? 'bg-success/10 text-success'
                    : 'bg-warning/10 text-warning'
                )}>
                  {connector.status === 'connected' ? <><CheckCircle2 className="w-3 h-3" /> 已连接</> : <><Clock className="w-3 h-3" /> 待授权</>}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div>
        <SectionHeader icon={<Wrench className="w-3.5 h-3.5" />} title="技能 Skills" />
        <div className="flex flex-wrap gap-2">
          {project.skills.map((skill) => (
            <div key={skill.name} className="flex flex-col p-2.5 rounded-lg border border-borderGray bg-white min-w-[140px] flex-1">
              <span className="text-xs font-medium text-textDark">{skill.name}</span>
              <span className="text-[10px] text-textGray mt-0.5">{skill.description}</span>
            </div>
          ))}
        </div>
      </div>

      <div>
        <SectionHeader icon={<Library className="w-3.5 h-3.5" />} title="资料库 Doc Library" />
        <div className="space-y-2">
          {project.docLibrary.map((doc) => (
            <div key={doc.name} className="flex items-center justify-between p-2.5 rounded-lg border border-borderGray bg-white hover:bg-bgGray transition-colors">
              <div className="flex items-center gap-2">
                <FileText className="w-4 h-4 text-steelBlue" />
                <div>
                  <div className="text-sm text-textDark">{doc.name}</div>
                  <div className="text-[10px] text-textGray">{doc.type} · {doc.size}</div>
                </div>
              </div>
              <button className="p-1.5 rounded hover:bg-borderGray text-textGray" title="查看原件">
                <ExternalLink className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="p-3 rounded-lg bg-warning/10 border border-warning/20 text-xs text-warning flex items-start gap-2">
        <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
        <span>项目级配置为只读预览。实际授权与指令变更需由管理员在「系统设置」中操作。</span>
      </div>
    </div>
  )
}
