import React from 'react'
import {
  LayoutDashboard,
  FileText,
  Calculator,
  AlertTriangle,
  Package,
  TrendingUp,
  Briefcase,
  ArrowRight,
  Clock,
  CheckCircle2,
  XCircle,
  Building2,
  Plug,
} from 'lucide-react'
import {
  type Role,
  type Project,
  type Task,
  ROLE_LABELS,
  MOCK_TODOS,
  MOCK_FINANCE_SUMMARY,
  MOCK_MANAGEMENT_SUMMARY,
  MOCK_RISK_SUMMARY,
  MOCK_EXPOSURE,
  MOCK_INVENTORY,
} from '../data/mock'
import { LifecycleBar } from './LifecycleBar'
import { RiskMetricCard } from './ui/RiskMetricCard'
import clsx from 'clsx'

interface RoleDashboardProps {
  role: Role
  projects: Project[]
  tasks: Task[]
  onSelectProject: (project: Project) => void
  onSelectTask: (task: Task) => void
}

const StatusIcon: React.FC<{ status: Task['status'] }> = ({ status }) => {
  if (status === '已完成') return <CheckCircle2 className="w-3.5 h-3.5 text-success" />
  if (status === '失败') return <XCircle className="w-3.5 h-3.5 text-danger" />
  return <Clock className="w-3.5 h-3.5 text-steelBlue" />
}

export const RoleDashboard: React.FC<RoleDashboardProps> = ({ role, projects, tasks, onSelectProject, onSelectTask }) => {
  const roleTodos = MOCK_TODOS.filter((t) => t.role === role)
  const inProgressTasks = tasks.filter((t) => t.status === '进行中')
  const inProgressProjects = projects.filter((p) => p.status === '进行中')

  return (
    <div className="h-full overflow-auto p-5">
      <div className="max-w-6xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-bold text-textDark flex items-center gap-2">
              <LayoutDashboard className="w-5 h-5 text-deepSea" />
              {ROLE_LABELS[role]}工作台
            </h1>
            <p className="text-sm text-textGray mt-1">数据更新时间：2024-08-01 10:23</p>
          </div>
          <div className="text-xs text-textGray flex items-center gap-1">
            <Building2 className="w-3.5 h-3.5" /> 私有化部署 · 项目维度
          </div>
        </div>

        {role === 'trader' && (
          <div className="space-y-6">
            <div className="grid grid-cols-4 gap-4">
              <RiskMetricCard label="待办任务" value={roleTodos.length} unit="项" ratio={Math.min(roleTodos.length / 10, 1)} level={roleTodos.length >= 5 ? 'high' : 'medium'} hint="今日需处理" />
              <RiskMetricCard label="跟进中项目" value={inProgressProjects.length} unit="个" ratio={Math.min(inProgressProjects.length / 10, 1)} level="low" hint="合同/物流/风控" />
              <RiskMetricCard label="待收款" value="1,360" unit="万" ratio={0.68} level="medium" hint="合同 HT-2024 尾款" />
              <RiskMetricCard label="异常预警" value={1} unit="项" ratio={0.2} level="high" hint="物流异常 1 项" />
            </div>
            <div className="grid grid-cols-3 gap-4">
              <RiskMetricCard label="履约进度" value="78" unit="%" ratio={0.78} level="low" hint="合同 HT-2024 已发货 3,500/5,000 吨" />
              <RiskMetricCard label="对账完成率" value="65" unit="%" ratio={0.65} level="medium" hint="本月 13/20 笔已核对" />
              <RiskMetricCard label="回款率" value="70" unit="%" ratio={0.7} level="medium" hint="累计 2,520/3,600 万" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="bg-white rounded-xl border border-borderGray p-4">
                <div className="text-sm font-medium text-textDark mb-3 flex items-center gap-2">
                  <Clock className="w-4 h-4 text-steelBlue" /> 待办任务
                </div>
                <div className="space-y-2">
                  {inProgressTasks.slice(0, 6).map((task) => (
                    <button
                      key={task.id}
                      onClick={() => onSelectTask(task)}
                      className="w-full flex items-center justify-between p-2 rounded-lg hover:bg-bgGray transition-colors text-left"
                    >
                      <div className="flex items-center gap-2">
                        <StatusIcon status={task.status} />
                        <span className="text-sm text-textDark">{task.title}</span>
                      </div>
                      <span className="text-xs text-textGray">{task.updatedAt}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="bg-white rounded-xl border border-borderGray p-4">
                <div className="text-sm font-medium text-textDark mb-3 flex items-center gap-2">
                  <Package className="w-4 h-4 text-steelBlue" /> 库存总览
                </div>
                <div className="space-y-3">
                  {MOCK_INVENTORY.map((item) => (
                    <div key={item.warehouse} className="flex justify-between items-center text-sm">
                      <span className="text-textDark">{item.warehouse}</span>
                      <span className="font-mono font-medium text-textDark">{item.quantity.toLocaleString()} {item.unit}</span>
                    </div>
                  ))}
                </div>
                <div className="mt-3 pt-3 border-t border-borderGray flex justify-between text-sm">
                  <span className="text-textGray">合计</span>
                  <span className="font-mono font-bold text-textDark">20,500 吨</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {role === 'finance' && (
          <div className="space-y-6">
            <div className="grid grid-cols-4 gap-4">
              <RiskMetricCard label="待对账" value={MOCK_FINANCE_SUMMARY.pendingSettlement} unit="笔" ratio={MOCK_FINANCE_SUMMARY.pendingSettlement / 20} level="medium" hint="本月待处理" />
              <RiskMetricCard label="未核销发票" value={MOCK_FINANCE_SUMMARY.unverifiedInvoice} unit="笔" ratio={MOCK_FINANCE_SUMMARY.unverifiedInvoice / 10} level="medium" hint="差异待查" />
              <RiskMetricCard label="资金流水" value={(MOCK_FINANCE_SUMMARY.fundFlow / 10000).toFixed(0)} unit="万" ratio={0.72} level="low" hint="较昨日 +5.2%" />
              <RiskMetricCard label="待付款审批" value={MOCK_TODOS.filter((t) => t.role === 'finance' && t.type === 'approval').length} unit="笔" ratio={0.1} level="high" hint="高风项 1 项" />
            </div>
            <div className="grid grid-cols-3 gap-4">
              <RiskMetricCard label="对账完成率" value="65" unit="%" ratio={0.65} level="medium" hint="本月 13/20 笔已核对" />
              <RiskMetricCard label="发票核销率" value="82" unit="%" ratio={0.82} level="low" hint="17/21 笔已核销" />
              <RiskMetricCard label="资金回笼率" value="70" unit="%" ratio={0.7} level="medium" hint="回流 1,995/2,850 万" />
            </div>
            <div className="bg-white rounded-xl border border-borderGray p-4">
              <div className="text-sm font-medium text-textDark mb-3 flex items-center gap-2">
                <Calculator className="w-4 h-4 text-steelBlue" /> 对账/发票待办
              </div>
              <div className="space-y-2">
                {inProgressTasks.filter((t) => t.businessType === 'settlement' || t.businessType === 'document').map((task) => (
                  <button
                    key={task.id}
                    onClick={() => onSelectTask(task)}
                    className="w-full flex items-center justify-between p-2 rounded-lg hover:bg-bgGray transition-colors text-left"
                  >
                    <div className="flex items-center gap-2">
                      <StatusIcon status={task.status} />
                      <span className="text-sm text-textDark">{task.title}</span>
                    </div>
                    <span className="text-xs text-textGray">{task.updatedAt}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {role === 'risk' && (
          <div className="space-y-6">
            <div className="grid grid-cols-4 gap-4">
              <RiskMetricCard label="当前敞口" value={MOCK_EXPOSURE.netExposure} unit={MOCK_EXPOSURE.unit} ratio={0.5} level={MOCK_EXPOSURE.riskLevel === '高' ? 'high' : MOCK_EXPOSURE.riskLevel === '中' ? 'medium' : 'low'} hint={`风险等级 ${MOCK_EXPOSURE.riskLevel}`} />
              <RiskMetricCard label="在险合同数" value={projects.filter((p) => p.businessType === 'risk').length} unit="个" ratio={projects.filter((p) => p.businessType === 'risk').length / 10} level="medium" hint="铜精矿/原油" />
              <RiskMetricCard label="价格预警" value={MOCK_RISK_SUMMARY.alerts} unit="项" ratio={MOCK_RISK_SUMMARY.alerts / 10} level="high" hint="基差波动 >3%" />
              <RiskMetricCard label="授信使用率" value="72" unit="%" ratio={0.72} level="medium" hint="正常区间" />
            </div>
            <div className="grid grid-cols-3 gap-4">
              <RiskMetricCard label="套保覆盖率" value="78" unit="%" ratio={0.78} level="low" hint="对冲 3,900/5,000 吨" />
              <RiskMetricCard label="授信使用率" value="72" unit="%" ratio={0.72} level="medium" hint="剩余 2,800 万" />
              <RiskMetricCard label="价格监控覆盖率" value="95" unit="%" ratio={0.95} level="low" hint="19/20 合约已接入" />
            </div>
            <div className="bg-white rounded-xl border border-borderGray p-4">
              <div className="text-sm font-medium text-textDark mb-3 flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-steelBlue" /> 风控预警列表
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between p-2 rounded-lg bg-danger/5">
                  <span className="text-sm text-danger">净敞口接近阈值</span>
                  <span className="text-xs text-danger font-medium">高</span>
                </div>
                <div className="flex items-center justify-between p-2 rounded-lg bg-warning/5">
                  <span className="text-sm text-warning">铜精矿价格波动大于 3%</span>
                  <span className="text-xs text-warning font-medium">中</span>
                </div>
                <div className="flex items-center justify-between p-2 rounded-lg bg-success/5">
                  <span className="text-sm text-success">套保覆盖率正常</span>
                  <span className="text-xs text-success font-medium">低</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {role === 'management' && (
          <div className="space-y-6">
            <div className="grid grid-cols-4 gap-4">
              <RiskMetricCard label="月度毛利" value={(MOCK_MANAGEMENT_SUMMARY.grossProfit / 10000).toFixed(0)} unit="万" ratio={0.92} level="low" hint="预算达成 92%" />
              <RiskMetricCard label="库存周转" value={MOCK_MANAGEMENT_SUMMARY.inventoryTurnover} unit="次/月" ratio={0.7} level="low" hint="周转健康" />
              <RiskMetricCard label="待审批" value={MOCK_MANAGEMENT_SUMMARY.pendingApprovals} unit="项" ratio={MOCK_MANAGEMENT_SUMMARY.pendingApprovals / 10} level="medium" hint="大额付款 2 项" />
              <RiskMetricCard label="异常订单" value={MOCK_MANAGEMENT_SUMMARY.abnormalOrders} unit="项" ratio={0.2} level="high" hint="物流停滞 1 项" />
            </div>
            <div className="grid grid-cols-3 gap-4">
              <RiskMetricCard label="预算达成率" value="92" unit="%" ratio={0.92} level="low" hint="1,240/1,350 万" />
              <RiskMetricCard label="回款率" value="85" unit="%" ratio={0.85} level="low" hint="3,060/3,600 万" />
              <RiskMetricCard label="库存周转健康度" value="70" unit="%" ratio={0.7} level="medium" hint="20,500 吨在库" />
            </div>
            <div className="bg-white rounded-xl border border-borderGray p-4">
              <div className="text-sm font-medium text-textDark mb-3 flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-steelBlue" /> 月度利润趋势（万元）
              </div>
              <div className="h-40 flex items-end justify-around gap-2 px-4">
                {['1月', '2月', '3月', '4月', '5月', '6月', '7月'].map((m, i) => {
                  const h = [35, 48, 42, 55, 60, 52, 68][i]
                  return (
                    <div key={m} className="flex flex-col items-center gap-2 flex-1">
                      <div className="w-full max-w-[40px] rounded-t bg-steelBlue/80 hover:bg-deepSea transition-all" style={{ height: `${h}%` }} />
                      <span className="text-xs text-textGray">{m}</span>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        )}

        <div className="mt-8">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-bold text-textDark flex items-center gap-2">
              <Briefcase className="w-4 h-4 text-deepSea" /> 项目概览
            </h2>
            <span className="text-xs text-textGray">共 {projects.length} 个项目</span>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {projects.map((project) => (
              <button
                key={project.id}
                onClick={() => onSelectProject(project)}
                className="text-left rounded-xl border border-borderGray bg-white p-4 hover:border-deepSea/30 hover:shadow-sm transition-all"
              >
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <div className="text-sm font-medium text-textDark">{project.name}</div>
                    <div className="text-xs text-textGray mt-0.5">{project.businessNo} · {ROLE_LABELS[project.role]}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={clsx(
                      'text-xs px-2 py-0.5 rounded',
                      project.status === '进行中' ? 'bg-steelBlue/10 text-steelBlue' : 'bg-success/10 text-success'
                    )}>{project.status}</span>
                    <ArrowRight className="w-4 h-4 text-textGray" />
                  </div>
                </div>
                <div className="mb-3">
                  <LifecycleBar stages={project.stages} currentStage={project.stage} compact />
                </div>
                <div className="flex items-center gap-3 text-xs text-textGray">
                  <span className="flex items-center gap-1"><Clock className="w-3 h-3" /> {project.updatedAt}</span>
                  <span className="flex items-center gap-1"><FileText className="w-3 h-3" /> {project.taskIds.length} 个任务</span>
                  <span className="flex items-center gap-1"><Plug className="w-3 h-3" /> {project.connectors.filter((c) => c.status === 'connected').length}/{project.connectors.length} 连接器</span>
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
