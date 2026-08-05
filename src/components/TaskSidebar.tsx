import React, { useState, useMemo } from 'react'
import {
  Bot,
  Plus,
  Search,
  FileText,
  Truck,
  Calculator,
  FileQuestion,
  ShieldCheck,
  MoreHorizontal,
  User,
  Server,
  X,
  LayoutDashboard,
  Briefcase,
  Layers,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  Folder,
  Clock,
} from 'lucide-react'
import { RoleSwitcher } from './RoleSwitcher'
import { type Role, type Task, type Project, type ProjectStatus, ROLE_LABELS } from '../data/mock'
import clsx from 'clsx'

type SidebarView = 'dashboard' | 'projects'

export type ChatMode = 'mock' | 'real'

interface TaskSidebarProps {
  currentRole: Role
  onRoleChange: (role: Role) => void
  currentView?: 'dashboard' | 'project' | 'toolkit'
  chatMode?: ChatMode
  onChatModeChange?: (mode: ChatMode) => void
  projects: Project[]
  tasks: Task[]
  selectedProjectId: string | null
  selectedTaskId: string | null
  sidebarView: SidebarView
  onSidebarViewChange: (view: SidebarView) => void
  onOpenToolkit?: () => void
  onSelectProject: (project: Project) => void
  onSelectTask: (task: Task) => void
  onNewProject: () => void
}

const TaskIcon: React.FC<{ type: Task['businessType']; mode: Task['mode'] }> = ({ type, mode }) => {
  const className = 'w-3.5 h-3.5'
  if (type === 'contract') return <FileText className={className} />
  if (type === 'order') return <Truck className={className} />
  if (type === 'settlement') return <Calculator className={className} />
  if (mode === 'plan') return <FileQuestion className={className} />
  return <ShieldCheck className={className} />
}

const StatusDot: React.FC<{ status: ProjectStatus | Task['status'] }> = ({ status }) => (
  <span className={clsx(
    'w-2 h-2 rounded-full',
    status === '进行中' ? 'bg-steelBlue' : status === '已完成' || status === '归档' ? 'bg-success' : 'bg-danger'
  )} />
)

const ProjectCard: React.FC<{
  project: Project
  isActive: boolean
  isExpanded: boolean
  tasks: Task[]
  selectedTaskId: string | null
  onToggle: () => void
  onSelectProject: () => void
  onSelectTask: (task: Task) => void
}> = ({ project, isActive, isExpanded, tasks, selectedTaskId, onToggle, onSelectProject, onSelectTask }) => {
  const projectTasks = tasks.filter((t) => t.projectId === project.id)

  return (
    <div className={clsx(
      'rounded-lg border transition-all overflow-hidden',
      isActive ? 'border-amber/50 bg-white/10' : 'border-white/10 bg-white/5 hover:bg-white/10'
    )}>
      <div
        onClick={() => {
          onSelectProject()
          if (!isExpanded) onToggle()
        }}
        className="w-full text-left p-3 cursor-pointer"
      >
        <div className="flex items-start gap-2">
          <div className={clsx(
            'w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5',
            isActive ? 'bg-amber/20 text-amber' : 'bg-white/10 text-white/70'
          )}>
            {isActive ? <FolderOpen className="w-4 h-4" /> : <Folder className="w-4 h-4" />}
          </div>
          <div className="flex-1 min-w-0">
            <div className={clsx('text-sm font-medium truncate', isActive ? 'text-white' : 'text-white/90')}>
              {project.name}
            </div>
            <div className="flex items-center gap-2 mt-1">
              <StatusDot status={project.status} />
              <span className="text-xs text-white/60">{project.businessNo}</span>
              <span className="text-xs text-white/40 ml-auto">{project.updatedAt}</span>
            </div>
            <div className="flex items-center justify-between mt-2">
              <div className="flex items-center gap-1 text-[10px] text-white/50">
                <Clock className="w-3 h-3" /> {project.stage + 1}/{project.stages.length} 阶段
                <span className="mx-1">·</span>
                {projectTasks.length} 任务
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  onToggle()
                }}
                className="p-0.5 rounded hover:bg-white/10 text-white/50"
              >
                {isExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
              </button>
            </div>
          </div>
        </div>
      </div>

      {isExpanded && (
        <div className="border-t border-white/10">
          {projectTasks.length === 0 && (
            <div className="px-3 py-2 text-[11px] text-white/40">暂无任务</div>
          )}
          {projectTasks.map((task) => (
            <button
              key={task.id}
              onClick={() => onSelectTask(task)}
              className={clsx(
                'w-full text-left px-3 py-2 text-xs transition-colors flex items-center gap-2',
                selectedTaskId === task.id
                  ? 'bg-amber/10 text-amber border-l-2 border-amber'
                  : 'text-white/70 hover:bg-white/5 hover:text-white border-l-2 border-transparent'
              )}
            >
              <TaskIcon type={task.businessType} mode={task.mode} />
              <span className="flex-1 truncate">{task.title}</span>
              <StatusDot status={task.status} />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export const TaskSidebar: React.FC<TaskSidebarProps> = ({
  currentRole,
  onRoleChange,
  currentView,
  chatMode = 'mock',
  onChatModeChange,
  projects,
  tasks,
  selectedProjectId,
  selectedTaskId,
  sidebarView,
  onSidebarViewChange,
  onOpenToolkit,
  onSelectProject,
  onSelectTask,
  onNewProject,
}) => {
  const [search, setSearch] = useState('')
  const [expandedProjectIds, setExpandedProjectIds] = useState<string[]>([selectedProjectId || ''])
  const [showMobileDrawer, setShowMobileDrawer] = useState(false)

  const filteredProjects = useMemo(() => {
    return projects
      .filter((p) => p.role === currentRole || currentRole === 'management')
      .filter((p) => p.name.toLowerCase().includes(search.toLowerCase()) || p.businessNo.toLowerCase().includes(search.toLowerCase()))
  }, [projects, currentRole, search])

  const toggleExpanded = (projectId: string) => {
    setExpandedProjectIds((prev) =>
      prev.includes(projectId) ? prev.filter((id) => id !== projectId) : [...prev, projectId]
    )
  }

  const sidebarContent = (
    <>
      <div className="h-14 flex items-center px-4 border-b border-white/10 shrink-0">
        <Bot className="w-6 h-6 text-amber mr-2" />
        <span className="font-bold text-base text-white">贸易 AI 助手</span>
        <button
          onClick={() => setShowMobileDrawer(false)}
          className="ml-auto p-1 rounded text-white/50 hover:text-white hover:bg-white/10 lg:hidden"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="p-3 space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => onChatModeChange?.('mock')}
            className={clsx(
              'flex items-center justify-center gap-1 h-9 rounded-lg text-xs transition-colors',
              chatMode === 'mock'
                ? 'bg-white text-deepSea font-medium'
                : 'bg-white/10 text-white/80 hover:bg-white/20'
            )}
          >
            <span className="w-1.5 h-1.5 rounded-full bg-amber" />
            演示模式
          </button>
          <button
            onClick={() => onChatModeChange?.('real')}
            className={clsx(
              'flex items-center justify-center gap-1 h-9 rounded-lg text-xs transition-colors',
              chatMode === 'real'
                ? 'bg-white text-deepSea font-medium'
                : 'bg-white/10 text-white/80 hover:bg-white/20'
            )}
          >
            <span className="w-1.5 h-1.5 rounded-full bg-success" />
            真实模式
          </button>
        </div>

        <RoleSwitcher currentRole={currentRole} onRoleChange={onRoleChange} />

        <div className="grid grid-cols-3 gap-2">
          <button
            onClick={() => {
              if (chatMode === 'real') onChatModeChange?.('mock')
              onSidebarViewChange('dashboard')
            }}
            className={clsx(
              'flex items-center justify-center gap-1 h-9 rounded-lg text-xs transition-colors',
              sidebarView === 'dashboard' && currentView !== 'toolkit' && chatMode !== 'real'
                ? 'bg-white text-deepSea font-medium'
                : 'bg-white/10 text-white/80 hover:bg-white/20'
            )}
          >
            <LayoutDashboard className="w-3.5 h-3.5" />
            概览
          </button>
          <button
            onClick={() => {
              if (chatMode === 'real') onChatModeChange?.('mock')
              onSidebarViewChange('projects')
            }}
            className={clsx(
              'flex items-center justify-center gap-1 h-9 rounded-lg text-xs transition-colors',
              sidebarView === 'projects' && currentView !== 'toolkit' && chatMode !== 'real'
                ? 'bg-white text-deepSea font-medium'
                : 'bg-white/10 text-white/80 hover:bg-white/20'
            )}
          >
            <Briefcase className="w-3.5 h-3.5" />
            项目
          </button>
          <button
            onClick={() => {
              if (chatMode === 'real') onChatModeChange?.('mock')
              onOpenToolkit?.()
            }}
            className={clsx(
              'flex items-center justify-center gap-1 h-9 rounded-lg text-xs transition-colors',
              currentView === 'toolkit' && chatMode !== 'real'
                ? 'bg-white text-deepSea font-medium'
                : 'bg-white/10 text-white/80 hover:bg-white/20'
            )}
          >
            <Layers className="w-3.5 h-3.5" />
            工具集
          </button>
        </div>

        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/40" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={sidebarView === 'dashboard' ? '搜索项目...' : '搜索项目或任务...'}
            className="w-full h-9 pl-8 pr-3 rounded-lg bg-white/10 border border-white/10 text-sm text-white placeholder:text-white/40 focus:outline-none focus:bg-white/20 focus:border-white/30"
          />
        </div>

        {sidebarView === 'projects' && (
          <button
            onClick={onNewProject}
            className="w-full flex items-center justify-center gap-1.5 h-9 rounded-lg bg-amber text-white text-sm font-medium hover:bg-amber/90 transition-colors"
          >
            <Plus className="w-4 h-4" />
            新建项目
          </button>
        )}
      </div>

      <div className="flex-1 overflow-auto px-3 pb-3">
        {sidebarView === 'dashboard' ? (
          <div className="space-y-3">
            <div className="text-xs font-medium text-white/50 uppercase tracking-wider px-1">最近项目</div>
            {filteredProjects.slice(0, 4).map((project) => (
              <button
                key={project.id}
                onClick={() => {
                  onSelectProject(project)
                  onSidebarViewChange('projects')
                }}
                className={clsx(
                  'w-full text-left p-3 rounded-lg border transition-all',
                  selectedProjectId === project.id
                    ? 'border-amber/50 bg-white/10'
                    : 'border-white/10 bg-white/5 hover:bg-white/10'
                )}
              >
                <div className="flex items-start gap-2">
                  <div className={clsx(
                    'w-8 h-8 rounded-lg flex items-center justify-center shrink-0',
                    selectedProjectId === project.id ? 'bg-amber/20 text-amber' : 'bg-white/10 text-white/70'
                  )}>
                    <Folder className="w-4 h-4" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className={clsx('text-sm font-medium truncate', selectedProjectId === project.id ? 'text-white' : 'text-white/90')}>
                      {project.name}
                    </div>
                    <div className="text-[10px] text-white/50 mt-1">{project.stages[project.stage]} · {project.taskIds.length} 任务</div>
                  </div>
                </div>
              </button>
            ))}
            <button
              onClick={() => onSidebarViewChange('projects')}
              className="w-full text-center text-xs text-white/50 hover:text-white py-2 transition-colors"
            >
              查看全部项目
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            {filteredProjects.map((project) => (
              <ProjectCard
                key={project.id}
                project={project}
                isActive={selectedProjectId === project.id}
                isExpanded={expandedProjectIds.includes(project.id)}
                tasks={tasks}
                selectedTaskId={selectedTaskId}
                onToggle={() => toggleExpanded(project.id)}
                onSelectProject={() => onSelectProject(project)}
                onSelectTask={onSelectTask}
              />
            ))}
          </div>
        )}
      </div>

      <div className="p-3 border-t border-white/10 shrink-0">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center text-white">
            <User className="w-4 h-4" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-white">当前用户</div>
            <div className="text-xs text-white/50">{ROLE_LABELS[currentRole]}</div>
          </div>
        </div>
        <div className="flex items-center justify-between text-xs text-white/40">
          <span className="flex items-center gap-1"><Server className="w-3 h-3" /> 私有化部署 v0.1</span>
          <span>Qwen / 可选云端</span>
        </div>
      </div>
    </>
  )

  return (
    <>
      <aside className="hidden lg:flex flex-col h-full w-[260px] bg-deepSea text-white shrink-0 transition-all duration-300">
        {sidebarContent}
      </aside>

      <button
        onClick={() => setShowMobileDrawer(true)}
        className="lg:hidden fixed left-4 bottom-4 z-40 w-10 h-10 rounded-full bg-deepSea text-white shadow-lg flex items-center justify-center"
      >
        <MoreHorizontal className="w-5 h-5" />
      </button>

      {showMobileDrawer && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setShowMobileDrawer(false)} />
          <aside className="absolute left-0 top-0 bottom-0 w-[280px] bg-deepSea text-white flex flex-col animate-slide-up">
            {sidebarContent}
          </aside>
        </div>
      )}
    </>
  )
}

export default TaskSidebar
