import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import { TaskSidebar } from './TaskSidebar'
import { ConversationView } from './ConversationView'
import { ResultPanel } from './ResultPanel'
import { RoleDashboard } from './RoleDashboard'
import { RoleToolkitView } from './RoleToolkitView'
import { RealChatView } from './RealChatView'
import { ProjectTemplateDialog } from './ProjectTemplateDialog'
import {
  type Role,
  type Task,
  type TaskMode,
  type ChatMessage,
  type ThinkingStep,
  type ActionType,
  type Project,
  type ProjectTemplate,
  type HITLDemoStep,
  MOCK_TASKS,
  MOCK_PROJECTS,
  HITL_DEMO_FLOW,
  RECONCILIATION_PLAN,
  RECONCILIATION_ARTIFACT,
  RECONCILIATION_CHANGES,
  PAYMENT_APPROVAL_DETAIL,
} from '../data/mock'

function createTaskId() {
  return `tk${Date.now()}`
}

function createProjectId() {
  return `proj${Date.now()}`
}

function createMessageId() {
  return `m${Date.now()}`
}

const emptyTask: Task = {
  id: '',
  title: '',
  projectId: '',
  businessNo: '',
  businessType: 'contract',
  status: '进行中',
  updatedAt: '刚刚',
  role: 'trader',
  mode: 'ask',
  messages: [],
  changes: [],
  artifacts: [],
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export const Workspace: React.FC<{ currentRole: Role; onRoleChange: (role: Role) => void }> = ({
  currentRole,
  onRoleChange,
}) => {
  const [projects, setProjects] = useState<Project[]>(MOCK_PROJECTS)
  const [tasks, setTasks] = useState<Task[]>(MOCK_TASKS)
  const [view, setView] = useState<'dashboard' | 'project' | 'toolkit'>('dashboard')
  const [chatMode, setChatMode] = useState<'mock' | 'real'>('mock')
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(MOCK_PROJECTS[0]?.id || null)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [sidebarView, setSidebarView] = useState<'dashboard' | 'projects'>('dashboard')
  const [input, setInput] = useState('')
  const [mode, setMode] = useState<TaskMode>('ask')
  const [rightPanelOpen, setRightPanelOpen] = useState(true)
  const [rightPanelTab, setRightPanelTab] = useState<'overview' | 'artifacts' | 'changes' | 'audit' | 'settings'>('overview')
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null)
  const [showProjectDialog, setShowProjectDialog] = useState(false)

  const [hitlDemo, setHitlDemo] = useState<{
    active: boolean
    stepId: string | null
    taskId: string | null
  }>({ active: false, stepId: null, taskId: null })

  const tasksRef = useRef(tasks)
  const projectsRef = useRef(projects)
  const selectedProjectIdRef = useRef(selectedProjectId)
  const selectedTaskIdRef = useRef(selectedTaskId)
  useEffect(() => { tasksRef.current = tasks }, [tasks])
  useEffect(() => { projectsRef.current = projects }, [projects])
  useEffect(() => { selectedProjectIdRef.current = selectedProjectId }, [selectedProjectId])
  useEffect(() => { selectedTaskIdRef.current = selectedTaskId }, [selectedTaskId])

  const selectedProject = useMemo(() => projects.find((p) => p.id === selectedProjectId) || null, [projects, selectedProjectId])
  const selectedTask = useMemo(() => tasks.find((t) => t.id === selectedTaskId) || null, [tasks, selectedTaskId])

  const activeMode = selectedTask ? selectedTask.mode : mode
  const isHitlProject = selectedProject?.businessNo === 'HT-2024'

  const updateTask = useCallback((taskId: string, updater: (task: Task) => Task) => {
    setTasks((prev) => prev.map((t) => (t.id === taskId ? updater(t) : t)))
  }, [])

  const updateProject = useCallback((projectId: string, updater: (project: Project) => Project) => {
    setProjects((prev) => prev.map((p) => (p.id === projectId ? updater(p) : p)))
  }, [])

  const appendMessage = useCallback((taskId: string, message: ChatMessage) => {
    updateTask(taskId, (task) => ({
      ...task,
      messages: [...task.messages, message],
      updatedAt: '刚刚',
    }))
  }, [updateTask])

  const simulateSteps = async (
    taskId: string,
    agentMessageId: string,
    stepDefs: { title: string; tool: string; params: string; duration: number }[],
  ): Promise<ThinkingStep[]> => {
    const steps: ThinkingStep[] = stepDefs.map((s, idx) => ({
      id: `${agentMessageId}-${idx}`,
      title: s.title,
      tool: s.tool,
      params: s.params,
      status: 'running',
      duration: 0,
    }))

    updateTask(taskId, (task) => {
      const msgs = task.messages.map((m) => (m.id === agentMessageId ? { ...m, thinking: steps } : m))
      return { ...task, messages: msgs }
    })

    for (let i = 0; i < steps.length; i++) {
      await sleep(stepDefs[i].duration)
      steps[i] = { ...steps[i], status: 'success', duration: stepDefs[i].duration }
      updateTask(taskId, (task) => {
        const msgs = task.messages.map((m) => (m.id === agentMessageId ? { ...m, thinking: [...steps] } : m))
        return { ...task, messages: msgs }
      })
    }

    return steps
  }

  const handleSelectProject = (project: Project) => {
    setHitlDemo({ active: false, stepId: null, taskId: null })
    setSelectedProjectId(project.id)
    setView('project')
    setSidebarView('projects')
    setRightPanelTab('overview')
    const firstTask = tasks.find((t) => t.projectId === project.id)
    setSelectedTaskId(firstTask?.id || null)
    setInput('')
  }

  const handleSelectTask = (task: Task) => {
    if (task.id !== hitlDemo.taskId) {
      setHitlDemo({ active: false, stepId: null, taskId: null })
    }
    setSelectedProjectId(task.projectId)
    setSelectedTaskId(task.id)
    setView('project')
    setSidebarView('projects')
    setMode(task.mode)
    setRightPanelTab('overview')
    setInput('')
  }

  const handleCreateProject = (template: ProjectTemplate) => {
    const newProjectId = createProjectId()
    const businessNo = template.businessType === 'contract'
      ? 'HT-NEW'
      : template.businessType === 'settlement'
      ? 'DD-NEW'
      : template.businessType === 'risk'
      ? 'RK-NEW'
      : template.businessType === 'logistics'
      ? 'WH-NEW'
      : 'P2P-NEW'

    const newProject: Project = {
      id: newProjectId,
      name: `${template.name} ${businessNo}`,
      businessNo,
      businessType: template.businessType,
      templateId: template.id,
      status: '进行中',
      stage: 0,
      stages: template.stages,
      updatedAt: '刚刚',
      role: currentRole,
      instructions: template.instructions,
      experts: template.experts,
      skills: template.skills,
      connectors: template.connectors.map((c) => ({ ...c, status: 'connected' })),
      docLibrary: [],
      taskIds: [],
    }

    const newTaskBusinessType: Task['businessType'] =
      template.businessType === 'settlement' ? 'settlement'
      : template.businessType === 'logistics' ? 'document'
      : 'contract'

    const newTask: Task = {
      ...emptyTask,
      id: createTaskId(),
      projectId: newProjectId,
      title: `${template.name} 新建会话`,
      businessNo,
      businessType: newTaskBusinessType,
      status: '进行中',
      updatedAt: '刚刚',
      role: currentRole,
      mode: 'ask',
      messages: [],
    }

    newProject.taskIds = [newTask.id]

    setProjects((prev) => [newProject, ...prev])
    setTasks((prev) => [newTask, ...prev])
    setSelectedProjectId(newProjectId)
    setSelectedTaskId(newTask.id)
    setView('project')
    setSidebarView('projects')
    setShowProjectDialog(false)
    setRightPanelTab('settings')
    setInput('')
    setHitlDemo({ active: false, stepId: null, taskId: null })
  }

  const handlePrompt = (prompt: string) => {
    if (prompt.includes('对账')) setMode('plan')
    else if (prompt.includes('提单')) setMode('execute')
    else if (prompt.includes('审批')) setMode('ask')
    else setMode('ask')
    setInput(prompt)
    handleSend(prompt)
  }

  const handleSend = async (overrideInput?: string) => {
    const text = overrideInput !== undefined ? overrideInput : input
    if (!text.trim() || streamingMessageId) return

    let projectId = selectedProjectIdRef.current
    let taskId = selectedTaskIdRef.current

    if (!projectId) {
      // Fallback to HT-2024 project if none selected
      const defaultProject = projectsRef.current.find((p) => p.businessNo === 'HT-2024')
      if (defaultProject) {
        projectId = defaultProject.id
        setSelectedProjectId(projectId)
      }
    }

    if (!projectId) return

    const project = projectsRef.current.find((p) => p.id === projectId)
    if (!project) return

    if (!taskId) {
      const taskBusinessType: Task['businessType'] =
      project.businessType === 'settlement' ? 'settlement'
      : project.businessType === 'logistics' ? 'document'
      : 'contract'

    const newTask: Task = {
        ...emptyTask,
        id: createTaskId(),
        projectId: projectId,
        title: text.slice(0, 24),
        businessNo: project.businessNo,
        businessType: taskBusinessType,
        status: '进行中',
        updatedAt: '刚刚',
        role: currentRole,
        mode,
        messages: [],
      }
      setTasks((prev) => [newTask, ...prev])
      setProjects((prev) => prev.map((p) => (p.id === projectId ? { ...p, taskIds: [newTask.id, ...p.taskIds], updatedAt: '刚刚' } : p)))
      setSelectedTaskId(newTask.id)
      selectedTaskIdRef.current = newTask.id
      tasksRef.current = [newTask, ...tasksRef.current]
      taskId = newTask.id
    }

    const currentTask = tasksRef.current.find((t) => t.id === taskId)
    if (!currentTask) return

    const userMsg: ChatMessage = {
      id: createMessageId(),
      sender: 'user',
      content: text,
    }
    appendMessage(taskId, userMsg)
    setInput('')

    const agentMsgId = createMessageId()
    const activeModeForTask = mode
    setStreamingMessageId(agentMsgId)

    // Detect scenario
    const isContractQuery = text.includes('合同') && text.includes('HT-2024') && (text.includes('执行') || text.includes('情况') || text.includes('收款'))
    const isSettlementPlan = text.includes('对账') && activeModeForTask === 'plan'
    const isDocumentLink = text.includes('提单') && text.includes('合同') && text.includes('HT-2024')
    const isApproval = text.includes('审批') && (text.includes('尾款') || text.includes('付款'))

    if (isContractQuery) {
      const agentMsg: ChatMessage = {
        id: agentMsgId,
        sender: 'agent',
        content: '合同 HT-2024 对应订单 3 个，其中 2 个已发货，1 个待付款。已收款 80%（400 万 / 500 万）。',
        sources: ['ERP 订单系统', '财务资金系统', '合同管理系统'],
        thinking: [],
        uncertainty: '系统未匹配到本次收款的发票号，已用黄色标出，请确认。',
        actions: [
          { label: '生成对账草稿', type: 'draft' },
          { label: '提交审批', type: 'approve' },
        ],
        artifacts: [
          { id: 'a1', type: 'contract_summary', title: '合同 HT-2024 执行摘要' },
          { id: 'a2', type: 'order_status', title: '订单执行时间线' },
        ],
      }
      appendMessage(taskId, agentMsg)
      await simulateSteps(taskId, agentMsgId, [
        { title: '解析合同号', tool: 'intent-parser', params: 'contractNo=HT-2024', duration: 400 },
        { title: '查询合同关联订单', tool: 'erp-query-order', params: 'contractNo=HT-2024', duration: 700 },
        { title: '查询财务收款记录', tool: 'finance-query-payment', params: 'contractNo=HT-2024', duration: 900 },
        { title: '计算订单执行比例', tool: 'calc-execution', params: 'orders=3,shipped=2,paid=0.8', duration: 400 },
      ])
      updateTask(taskId, (task) => ({
        ...task,
        businessNo: 'HT-2024',
        businessType: 'contract',
        title: '合同 HT-2024 执行与收款',
        artifacts: [
          { id: 'a1', type: 'contract_summary', title: '合同 HT-2024 执行摘要' },
          { id: 'a2', type: 'order_status', title: '订单执行时间线' },
        ],
      }))
      updateProject(projectId, (p) => ({ ...p, stage: 2, updatedAt: '刚刚' }))
      setRightPanelTab('artifacts')
    } else if (isSettlementPlan) {
      const planId = `plan-${Date.now()}`
      const agentMsg: ChatMessage = {
        id: agentMsgId,
        sender: 'agent',
        content: '已为您制定本月对账执行计划。该计划涉及合同、订单、资金与发票系统，需要您确认后执行。',
        sources: ['ERP 订单系统', '财务资金系统', '发票管理系统'],
        plan: {
          ...RECONCILIATION_PLAN,
          id: planId,
          confirmed: false,
        },
        actions: [{ label: '确认执行', type: 'confirm' }],
      }
      appendMessage(taskId, agentMsg)
      setStreamingMessageId(null)
      updateTask(taskId, (task) => ({
        ...task,
        businessNo: 'DD-202408',
        businessType: 'settlement',
        title: '本月对账 DD-202408',
        mode: 'plan',
      }))
      return
    } else if (isDocumentLink) {
      const agentMsg: ChatMessage = {
        id: agentMsgId,
        sender: 'agent',
        content: '已完成提单 BL-20240815-001 与合同 HT-2024 的挂接。OCR 共抽取 12 个字段，关键字段置信度均高于 95%。',
        sources: ['OCR 识别服务', '合同管理系统', '单据中心'],
        thinking: [],
        actions: [{ label: '查看单据', type: 'view' }],
        artifacts: [
          { id: 'a1', type: 'linked_documents', title: '已挂接单据' },
        ],
      }
      appendMessage(taskId, agentMsg)
      await simulateSteps(taskId, agentMsgId, [
        { title: 'OCR 结构化抽取', tool: 'ocr-mineru', params: 'file=BL-20240815-001.pdf', duration: 800 },
        { title: '字段抽取与校验', tool: 'field-extract', params: 'docType=BL,contractNo=HT-2024', duration: 500 },
        { title: '业务绑定', tool: 'doc-link', params: 'contractNo=HT-2024,blNo=BL-20240815-001', duration: 400 },
      ])
      const change1 = { id: createMessageId(), type: 'link' as const, title: '挂接单据', description: '合同 HT-2024 挂接提单 BL-20240815-001', timestamp: new Date().toLocaleTimeString('zh-CN', { hour12: false }), actor: 'agent' as const }
      const change2 = { id: createMessageId(), type: 'field' as const, title: '更新单据索引', description: 'OCR 字段写入单据中心', from: '未索引', to: '已索引', timestamp: new Date().toLocaleTimeString('zh-CN', { hour12: false }), actor: 'agent' as const }
      updateTask(taskId, (task) => ({
        ...task,
        businessNo: 'BL-20240815-001',
        businessType: 'document',
        title: '挂接提单到合同 HT-2024',
        status: '已完成',
        mode: 'execute',
        changes: [...(task.changes || []), change1, change2],
        artifacts: [{ id: 'a1', type: 'linked_documents', title: '已挂接单据' }],
      }))
      updateProject(projectId, (p) => ({ ...p, stage: 3, updatedAt: '刚刚' }))
      setRightPanelTab('changes')
    } else if (isApproval) {
      const agentMsg: ChatMessage = {
        id: agentMsgId,
        sender: 'agent',
        content: '合同 HT-2024 尾款付款申请已调出，金额 1,360 万元。AI 校验发现 1 项预警：收款账户与合同账户不一致，请重点核对。',
        sources: ['合同管理系统', '财务资金系统'],
        approval: PAYMENT_APPROVAL_DETAIL,
        actions: [
          { label: '通过审批', type: 'approve' },
          { label: '拒绝', type: 'retry' },
        ],
      }
      appendMessage(taskId, agentMsg)
      setStreamingMessageId(null)
      updateTask(taskId, (task) => ({
        ...task,
        businessNo: 'HT-2024',
        businessType: 'contract',
        title: '付款审批：HT-2024 尾款',
        mode: 'ask',
      }))
      updateProject(projectId, (p) => ({ ...p, stage: 4, updatedAt: '刚刚' }))
      return
    } else {
      const agentMsg: ChatMessage = {
        id: agentMsgId,
        sender: 'agent',
        content: `已收到您的请求：${text}。当前模式下我将仅执行读操作或返回计划，如需进一步处理请切换模式。`,
        sources: ['ERP 订单系统'],
        thinking: [],
        actions: [{ label: '查看详情', type: 'link' }],
      }
      appendMessage(taskId, agentMsg)
      await simulateSteps(taskId, agentMsgId, [
        { title: '解析用户意图', tool: 'intent-parser', params: `query=${text.slice(0, 20)}`, duration: 400 },
        { title: '执行查询', tool: 'erp-query', params: `keyword=${text.slice(0, 20)}`, duration: 600 },
      ])
    }

    setStreamingMessageId(null)
  }

  const handleConfirmPlan = (planId: string) => {
    if (!selectedTask) return
    const taskId = selectedTask.id
    const projectId = selectedTask.projectId

    updateTask(taskId, (task) => ({
      ...task,
      messages: task.messages.map((m) =>
        m.plan && m.plan.id === planId ? { ...m, plan: { ...m.plan, confirmed: true } } : m
      ),
    }))

    const confirmMsgId = createMessageId()
    setStreamingMessageId(confirmMsgId)

    const agentMsg: ChatMessage = {
      id: confirmMsgId,
      sender: 'agent',
      content: '已确认执行计划，正在生成对账草稿。系统已标记 1 处差异，请核对。',
      sources: ['ERP 订单系统', '财务资金系统', '发票管理系统'],
      thinking: [],
      artifacts: [RECONCILIATION_ARTIFACT],
      uncertainty: '系统未匹配到发票号，差异金额 68,000 元，请人工确认。',
      actions: [
        { label: '查看草稿', type: 'link' },
        { label: '提交审批', type: 'approve' },
      ],
    }
    appendMessage(taskId, agentMsg)

    setTimeout(async () => {
      await simulateSteps(taskId, confirmMsgId, [
        { title: '拉取订单数据', tool: 'erp-query-order', params: 'month=2024-08', duration: 500 },
        { title: '拉取资金流水', tool: 'finance-query-payment', params: 'month=2024-08', duration: 600 },
        { title: '匹配发票与收款', tool: 'invoice-query', params: 'contractNo=HT-2024', duration: 500 },
        { title: '生成对账草稿', tool: 'settlement-draft', params: 'auto-match=true', duration: 400 },
      ])
      updateTask(taskId, (task) => ({
        ...task,
        changes: [...(task.changes || []), ...RECONCILIATION_CHANGES],
        artifacts: [RECONCILIATION_ARTIFACT],
        status: '已完成',
      }))
      updateProject(projectId, (p) => ({ ...p, stage: 3, updatedAt: '刚刚' }))
      setStreamingMessageId(null)
      setRightPanelTab('changes')
    }, 0)
  }

  const startHitlDemo = async () => {
    const htProject = projectsRef.current.find((p) => p.businessNo === 'HT-2024')
    if (!htProject) return

    const demoTaskId = createTaskId()
    const demoTask: Task = {
      ...emptyTask,
      id: demoTaskId,
      projectId: htProject.id,
      title: '演示：对账 + 付款 HITL 全流程',
      businessNo: 'HT-2024',
      businessType: 'contract',
      status: '进行中',
      updatedAt: '刚刚',
      role: currentRole,
      mode: 'ask',
      messages: [],
    }

    setTasks((prev) => [demoTask, ...prev])
    setProjects((prev) => prev.map((p) => (p.id === htProject.id ? { ...p, taskIds: [demoTaskId, ...p.taskIds], updatedAt: '刚刚' } : p)))
    setSelectedProjectId(htProject.id)
    setSelectedTaskId(demoTaskId)
    setView('project')
    setSidebarView('projects')
    setHitlDemo({ active: true, stepId: 'T1', taskId: demoTaskId })
    setRightPanelTab('overview')
    setInput('')

    const t1 = HITL_DEMO_FLOW.find((s) => s.id === 'T1')!
    if (t1.userMessage) {
      appendMessage(demoTaskId, { id: createMessageId(), sender: 'user', content: t1.userMessage })
    }
    await appendAgentMessage(demoTaskId, t1.agentMessage)
    applyStepSideEffects(htProject.id, demoTaskId, t1)
  }

  const appendAgentMessage = async (taskId: string, agentMsg: ChatMessage) => {
    if (agentMsg.thinking && agentMsg.thinking.length > 0) {
      const runningMsg: ChatMessage = {
        ...agentMsg,
        thinking: agentMsg.thinking.map((s) => ({ ...s, status: 'running' })),
      }
      appendMessage(taskId, runningMsg)
      setStreamingMessageId(agentMsg.id)
      const stepDefs = agentMsg.thinking.map((s) => ({
        title: s.title,
        tool: s.tool,
        params: s.params,
        duration: s.duration || 600,
      }))
      await simulateSteps(taskId, agentMsg.id, stepDefs)
      updateTask(taskId, (task) => ({
        ...task,
        messages: task.messages.map((m) =>
          m.id === agentMsg.id
            ? {
                ...m,
                content: agentMsg.content,
                uncertainty: agentMsg.uncertainty,
                artifacts: agentMsg.artifacts,
                approval: agentMsg.approval,
                actions: agentMsg.actions,
                sources: agentMsg.sources,
              }
            : m
        ),
      }))
      setStreamingMessageId(null)
    } else {
      appendMessage(taskId, agentMsg)
    }
  }

  const applyStepSideEffects = (projectId: string, taskId: string, step: HITLDemoStep) => {
    const changes = step.changes || []
    if (changes.length > 0) {
      updateTask(taskId, (task) => ({
        ...task,
        changes: [...(task.changes || []), ...changes],
      }))
    }
    if (step.projectStageAdvanceTo !== undefined) {
      updateProject(projectId, (p) => ({ ...p, stage: step.projectStageAdvanceTo!, updatedAt: '刚刚' }))
    }
    if (step.projectStatus) {
      updateProject(projectId, (p) => ({ ...p, status: step.projectStatus!, updatedAt: '刚刚' }))
    }
  }

  const advanceHitlDemo = async (taskId: string, userText: string, nextStepId: string) => {
    const nextStep = HITL_DEMO_FLOW.find((s) => s.id === nextStepId)
    if (!nextStep) return

    const projectId = selectedProjectIdRef.current
    if (!projectId) return

    appendMessage(taskId, { id: createMessageId(), sender: 'user', content: userText })
    setMode(nextStep.mode)
    setHitlDemo((prev) => ({ ...prev, stepId: nextStepId }))
    setInput('')

    if (nextStep.systemNote) {
      appendMessage(taskId, {
        id: createMessageId(),
        sender: 'system',
        content: nextStep.systemNote,
        systemNote: nextStep.systemNote,
      })
    }

    // T3 需要展示“前 3 步 success、后 2 步 running”的暂停状态，不流式跑
    if (nextStep.id === 'T3') {
      appendMessage(taskId, nextStep.agentMessage)
    } else {
      await appendAgentMessage(taskId, nextStep.agentMessage)
    }
    applyStepSideEffects(projectId, taskId, nextStep)

    if (nextStep.id === 'T2') {
      setRightPanelTab('overview')
    } else if (nextStep.id === 'T3' || nextStep.id === 'T3_OUR_SIDE' || nextStep.id === 'T3_HANDOFF') {
      setRightPanelTab('changes')
    } else if (nextStep.id === 'T4') {
      setRightPanelTab('artifacts')
    } else if (nextStep.id === 'T4_CONFIRM' || nextStep.id === 'T5') {
      setRightPanelTab('changes')
    } else if (nextStep.id === 'T6_RESULT' || nextStep.id === 'T6_ARCHIVE') {
      setRightPanelTab('changes')
    }
  }

  const handleAction = (label: string, type: ActionType) => {
    if (hitlDemo.active && hitlDemo.taskId && selectedTask?.id === hitlDemo.taskId) {
      const currentStep = HITL_DEMO_FLOW.find((s) => s.id === hitlDemo.stepId)
      if (!currentStep) return
      const decision = currentStep.decisions?.find((d) => d.label === label)
      if (decision) {
        advanceHitlDemo(hitlDemo.taskId, decision.userText || decision.label, decision.nextStep)
        return
      }
    }

    if (!selectedTask) return
    const taskId = selectedTask.id
    const projectId = selectedTask.projectId
    if (type === 'approve') {
      appendMessage(taskId, {
        id: createMessageId(),
        sender: 'agent',
        content: '审批已通过，已触发资金系统付款流程。可在变更面板查看审批记录。',
        sources: ['审批系统', '资金系统'],
      })
      updateTask(taskId, (task) => ({
        ...task,
        status: '已完成',
        changes: [
          ...(task.changes || []),
          { id: createMessageId(), type: 'create', title: '审批通过', description: '合同 HT-2024 尾款付款审批已通过', timestamp: new Date().toLocaleTimeString('zh-CN', { hour12: false }), actor: 'user' },
        ],
      }))
      updateProject(projectId, (p) => ({ ...p, stage: 5, updatedAt: '刚刚' }))
      setRightPanelTab('changes')
    } else if (type === 'draft' || type === 'confirm') {
      setMode('plan')
      handlePrompt('帮我发起本月对账')
    } else if (type === 'retry') {
      appendMessage(taskId, {
        id: createMessageId(),
        sender: 'agent',
        content: '已拒绝本次审批，已通知申请人补充账户一致性说明。',
        sources: ['审批系统'],
      })
    } else {
      appendMessage(taskId, {
        id: createMessageId(),
        sender: 'agent',
        content: `已执行操作：${label}（模拟）。`,
        sources: [],
      })
    }
  }

  const handleSidebarViewChange = (newView: 'dashboard' | 'projects') => {
    setSidebarView(newView)
    if (newView === 'dashboard') {
      setView('dashboard')
      setSelectedTaskId(null)
    } else {
      if (selectedProjectId) {
        setView('project')
      } else {
        const firstProject = projects.find((p) => p.role === currentRole || currentRole === 'management')
        if (firstProject) {
          setSelectedProjectId(firstProject.id)
          setView('project')
          const firstTask = tasks.find((t) => t.projectId === firstProject.id)
          setSelectedTaskId(firstTask?.id || null)
        }
      }
    }
  }

  const handleNewProject = () => {
    setShowProjectDialog(true)
  }

  return (
    <div className="flex h-screen w-full bg-bgGray overflow-hidden">
      <TaskSidebar
        currentRole={currentRole}
        onRoleChange={onRoleChange}
        currentView={view}
        chatMode={chatMode}
        onChatModeChange={setChatMode}
        projects={projects}
        tasks={tasks}
        selectedProjectId={selectedProjectId}
        selectedTaskId={selectedTaskId}
        sidebarView={sidebarView}
        onSidebarViewChange={handleSidebarViewChange}
        onOpenToolkit={() => setView('toolkit')}
        onSelectProject={handleSelectProject}
        onSelectTask={handleSelectTask}
        onNewProject={handleNewProject}
      />

      {chatMode === 'real' ? (
        <RealChatView />
      ) : view === 'dashboard' ? (
        <RoleDashboard
          role={currentRole}
          projects={projects}
          tasks={tasks}
          onSelectProject={handleSelectProject}
          onSelectTask={handleSelectTask}
        />
      ) : view === 'toolkit' ? (
        <RoleToolkitView role={currentRole} onRoleChange={onRoleChange} />
      ) : (
        <ConversationView
          task={selectedTask}
          input={input}
          onInputChange={setInput}
          onSend={() => handleSend()}
          mode={activeMode}
          onModeChange={setMode}
          streamingMessageId={streamingMessageId}
          rightPanelOpen={rightPanelOpen}
          onToggleRightPanel={() => setRightPanelOpen(!rightPanelOpen)}
          onAction={handleAction}
          onConfirmPlan={handleConfirmPlan}
          onPrompt={handlePrompt}
          showHitlDemo={isHitlProject && !hitlDemo.active}
          onStartHitlDemo={startHitlDemo}
        />
      )}

      {chatMode !== 'real' && view !== 'toolkit' && (
        <ResultPanel
          task={selectedTask}
          project={selectedProject}
          activeTab={rightPanelTab}
          onTabChange={setRightPanelTab}
          collapsed={!rightPanelOpen}
          onToggle={() => setRightPanelOpen(!rightPanelOpen)}
        />
      )}

      <ProjectTemplateDialog
        open={showProjectDialog}
        onClose={() => setShowProjectDialog(false)}
        onCreate={handleCreateProject}
      />
    </div>
  )
}
