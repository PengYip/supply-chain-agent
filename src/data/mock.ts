export type Role = 'trader' | 'risk' | 'finance' | 'management'

export const ROLE_LABELS: Record<Role, string> = {
  trader: '业务/贸易员',
  risk: '风控',
  finance: '财务',
  management: '管理层',
}

export const ROLE_DOMAINS: Record<Role, string[]> = {
  trader: ['合同', '订单', '仓储库存', '单据处理'],
  risk: ['敞口', '点价', '套保', '风控预警'],
  finance: ['结算', '资金', '发票', '对账'],
  management: ['审批', '经营月报', '客商', '行情'],
}

export const ROLE_TOOLKITS: Record<Role, RoleToolkit> = {
  trader: {
    role: 'trader',
    label: ROLE_LABELS.trader,
    tagline: '合同履约的执行者，单据与对账的第一责任人',
    guardrails: [
      { rule: '业务数字必须来自工具调用，禁止凭记忆或推断作答', severity: 'block' },
      { rule: '合同/付款变更必须双人审批（发起人≠审批人）', severity: 'block' },
      { rule: '客户敏感信息脱敏展示（银行账号/身份证/税号）', severity: 'warn' },
      { rule: '跨系统单据挂接前必须字段比对核验', severity: 'warn' },
    ],
    experts: [
      { name: '贸易执行专家', persona: '深耕能源化工贸易10年', methodology: ['合同条款→履约节点拆解', '异常订单三色分级', '发货协调优先级'] },
      { name: '合同合规专家', persona: '法务+贸易双背景', methodology: ['条款风险点扫描', '变更影响追溯', '归档完整性核验'] },
    ],
    skills: [
      { name: '合同履约追踪', sop: '拉合同+订单+发货+回款→生成履约甘特图与异常清单', trigger: '合同执行中' },
      { name: '对账差异分析', sop: '双方账面拉平→差异定位→分类(数量/单价/汇总)→生成草稿', trigger: '月度对账' },
      { name: '单据智能挂接', sop: 'OCR提取→字段比对→自动匹配业务对象→留痕', trigger: '收到新单据' },
      { name: '发货协调', sop: '查库存+物流+合同交期→推荐装运方案', trigger: '合同到发货节点' },
    ],
    connectors: [
      {
        name: 'ERP 合同/订单系统',
        category: 'readonly',
        auth: 'public',
        tools: [
          { name: 'query_contract', label: '合同查询', permission: 'L1', desc: '按合同号/客商查合同主数据与条款', source: 'ERP-合同模块' },
          { name: 'query_orders', label: '订单查询', permission: 'L1', desc: '查合同下订单与执行状态', source: 'ERP-订单模块' },
          { name: 'query_delivery', label: '发货查询', permission: 'L1', desc: '查发货单/物流/签收回执', source: 'ERP-物流模块' },
        ],
      },
      {
        name: '仓储系统',
        category: 'readonly',
        auth: 'public',
        tools: [
          { name: 'query_inventory', label: '库存查询', permission: 'L1', desc: '查仓单/可用库存/在途', source: 'WMS-仓储' },
          { name: 'get_warehouse_status', label: '仓单状态', permission: 'L1', desc: '查指定仓单明细与状态', source: 'WMS-仓储' },
        ],
      },
      {
        name: '业务写操作',
        category: 'approval',
        auth: 'personal',
        tools: [
          { name: 'create_delivery_order', label: '发货指令', permission: 'L2', desc: '下达发货指令并锁定库存', source: 'ERP-订单模块' },
          { name: 'push_reconciliation', label: '推送对账单', permission: 'L2', desc: '向客商推送对账草稿', source: 'ERP-结算模块' },
          { name: 'amend_contract', label: '合同变更', permission: 'L3', desc: '修改合同条款/金额/交期', source: 'ERP-合同模块' },
        ],
      },
    ],
    knowledge: [
      { title: '贸易合规手册（2024版）', type: '手册' },
      { title: '标准合同模板库', type: '模板' },
      { title: 'HS编码对照表', type: '对照表' },
      { title: '单据字段抽取规则', type: '规则' },
    ],
  },
  risk: {
    role: 'risk',
    label: ROLE_LABELS.risk,
    tagline: '敞口与在险的守门人，盯市预警的第一响应者',
    guardrails: [
      { rule: '敞口数据实时刷新，禁止缓存超过1小时', severity: 'block' },
      { rule: '超阈值必须预警，不可静默或降级处理', severity: 'block' },
      { rule: '授信变更必须留痕可追溯', severity: 'warn' },
    ],
    experts: [
      { name: '市场风险专家', persona: '有色金属+能源化工大宗定价背景', methodology: ['价格敞口实时聚合', '汇率/价格敏感性分析', '止损线触发判断'] },
      { name: '信用风险专家', persona: '银行风控+企业征信背景', methodology: ['客商授信动态评估', '账龄+回款联合分析', '集中度风险识别'] },
    ],
    skills: [
      { name: '敞口监控', sop: '聚合合同+订单+持仓→按品种/客商/期限维度输出敞口', trigger: '实时盯市' },
      { name: '盯市预警', sop: '价格/汇率突破阈值→分级预警→推送责任人', trigger: '行情波动' },
      { name: '授信额度审查', sop: '查客商授信余额+在途合同占用→输出可用额度', trigger: '新合同/大额订单' },
      { name: '风险事件溯源', sop: '定位事件根因→关联单据→生成复盘报告', trigger: '风险事件发生' },
    ],
    connectors: [
      {
        name: '行情数据源',
        category: 'readonly',
        auth: 'public',
        tools: [
          { name: 'get_price_quote', label: '实时行情', permission: 'L1', desc: '查铜/原油/柴油等实时价格', source: '行情API' },
          { name: 'get_fx_rate', label: '汇率查询', permission: 'L1', desc: '查主要货币实时汇率', source: '汇率API' },
        ],
      },
      {
        name: '风控数据',
        category: 'readonly',
        auth: 'public',
        tools: [
          { name: 'query_exposure', label: '敞口聚合查询', permission: 'L1', desc: '按维度聚合当前敞口', source: '风控系统' },
          { name: 'query_credit_balance', label: '授信余额查询', permission: 'L1', desc: '查客商授信总额与占用', source: '风控系统' },
          { name: 'query_credit_report', label: '客商征信', permission: 'L1', desc: '查客商外部征信报告', source: '征信API' },
        ],
      },
      {
        name: '风控审批',
        category: 'approval',
        auth: 'personal',
        tools: [
          { name: 'adjust_risk_threshold', label: '风险阈值调整', permission: 'L3', desc: '修改预警/止损阈值', source: '风控系统' },
          { name: 'change_credit_limit', label: '授信变更', permission: 'L3', desc: '调整客商授信额度', source: '风控系统' },
          { name: 'force_close_position', label: '强平指令', permission: 'L3', desc: '强制平仓/止损', source: '交易系统' },
        ],
      },
    ],
    knowledge: [
      { title: '公司风控政策', type: '政策' },
      { title: '客商信用档案库', type: '档案' },
      { title: '历史风险事件复盘', type: '案例' },
      { title: '品种波动率手册', type: '手册' },
    ],
  },
  finance: {
    role: 'finance',
    label: ROLE_LABELS.finance,
    tagline: '资金与发票的把关者，三单匹配的最后防线',
    guardrails: [
      { rule: '收付款必须三单匹配（合同+发票+入库），缺一不可', severity: 'block' },
      { rule: '资金流水不可篡改，仅可冲红', severity: 'block' },
      { rule: '发票核验必须通过税局验真', severity: 'block' },
      { rule: '跨期记账调整需财务主管确认', severity: 'warn' },
    ],
    experts: [
      { name: '结算会计专家', persona: '贸易结算+差异调账背景', methodology: ['三单匹配自动化', '差异定位与分类', '账龄与坏账预警'] },
      { name: '税务发票专家', persona: '税务师+企业开票背景', methodology: ['发票验真与抵扣', '开票合规检查', '税务风险识别'] },
    ],
    skills: [
      { name: '三单匹配对账', sop: '合同+发票+入库自动比对→输出差异清单', trigger: '收付款前' },
      { name: '发票核验', sop: 'OCR+税局验真+重复性检查→合规标记', trigger: '收到发票' },
      { name: '资金计划', sop: '应收应付+到期日→生成资金缺口与建议', trigger: '周/月资金计划' },
      { name: '账龄分析', sop: '按客商+账期聚合应收→输出超期预警', trigger: '月度结账' },
    ],
    connectors: [
      {
        name: '财务系统',
        category: 'readonly',
        auth: 'public',
        tools: [
          { name: 'query_invoice', label: '发票查询', permission: 'L1', desc: '查发票主数据与验真状态', source: '财务-发票模块' },
          { name: 'query_fund_flow', label: '资金流水查询', permission: 'L1', desc: '查收付款流水与凭证', source: '财务-资金模块' },
          { name: 'query_ar_ap', label: '应收应付查询', permission: 'L1', desc: '查客商应收应付余额与账龄', source: '财务-总账' },
          { name: 'query_gl', label: '总账查询', permission: 'L1', desc: '查科目余额与明细', source: '财务-总账' },
        ],
      },
      {
        name: '资金审批',
        category: 'approval',
        auth: 'personal',
        tools: [
          { name: 'create_payment', label: '付款申请', permission: 'L3', desc: '发起付款（需三单匹配+财务主管审批）', source: '财务-资金模块' },
          { name: 'create_refund', label: '退款申请', permission: 'L3', desc: '发起退款（需双人审批）', source: '财务-资金模块' },
          { name: 'adjust_entry', label: '记账调整', permission: 'L2', desc: '跨期记账调整（需财务主管确认）', source: '财务-总账' },
        ],
      },
    ],
    knowledge: [
      { title: '企业会计准则应用指南', type: '准则' },
      { title: '税务合规手册', type: '手册' },
      { title: '客户开票信息库', type: '档案' },
      { title: '发票验真规则', type: '规则' },
    ],
  },
  management: {
    role: 'management',
    label: ROLE_LABELS.management,
    tagline: '全局视角的经营决策者，异常与协同的总协调',
    guardrails: [
      { rule: '决策数据必须带时间戳与出处，口径可追溯', severity: 'block' },
      { rule: '部门间数据口径必须一致，禁用非标口径', severity: 'block' },
      { rule: '战略级调整需董事会授权', severity: 'warn' },
    ],
    experts: [
      { name: '经营分析专家', persona: '战略+财务分析背景', methodology: ['KPI趋势归因', '同业对标', '经营预测建模'] },
      { name: '异常归因专家', persona: '运营+风控复合背景', methodology: ['异常事件溯源', '跨部门责任定位', '改进建议生成'] },
    ],
    skills: [
      { name: '经营日报', sop: '聚合各部门数据→生成经营日报与关键变化', trigger: '每日自动' },
      { name: '异常归因', sop: '识别异常指标→下钻定位→跨部门协同建议', trigger: 'KPI偏离阈值' },
      { name: '部门协同', sop: '识别跨部门卡点→推送协调任务→跟踪闭环', trigger: '异常事件' },
      { name: '投资测算', sop: '项目现金流+NPV/IRR→输出投资建议', trigger: '新项目立项' },
    ],
    connectors: [
      {
        name: '经营仪表盘',
        category: 'readonly',
        auth: 'public',
        tools: [
          { name: 'query_kpi', label: 'KPI查询', permission: 'L1', desc: '查部门/公司级KPI与达成', source: 'BI系统' },
          { name: 'query_anomaly', label: '异常事件流', permission: 'L1', desc: '查实时异常事件与状态', source: '风控+运营' },
          { name: 'query_benchmark', label: '行业对标', permission: 'L1', desc: '查同业经营对标数据', source: '行业数据API' },
        ],
      },
      {
        name: '战略审批',
        category: 'approval',
        auth: 'personal',
        tools: [
          { name: 'strategic_adjustment', label: '战略调整', permission: 'L3', desc: '业务方向/授信政策/风控策略调整', source: '决策系统' },
        ],
      },
    ],
    knowledge: [
      { title: '年度经营计划', type: '计划' },
      { title: '行业研究报告', type: '研究' },
      { title: '历史决策复盘', type: '案例' },
      { title: '董事会决议库', type: '档案' },
    ],
  },
}

export interface TodoItem {
  id: string
  title: string
  type: 'contract' | 'exposure' | 'order' | 'invoice' | 'settlement' | 'risk' | 'approval'
  status: 'pending' | 'warning' | 'error' | 'normal'
  time: string
  role: Role
}

export interface QuickAction {
  id: string
  label: string
  prompt: string
  icon: 'search' | 'file' | 'box' | 'calculator' | 'link' | 'shield'
}

export interface Order {
  id: string
  customer: string
  product: string
  quantity: number
  unit: string
  status: '已发货' | '待付款' | '待发货' | '已完成'
  updateTime: string
}

export interface InventoryItem {
  warehouse: string
  product: string
  quantity: number
  unit: string
}

export interface Exposure {
  netExposure: number
  unit: string
  riskLevel: '高' | '中' | '低'
  change: number
}

export interface Approval {
  id: string
  type: string
  applicant: string
  summary: string
  riskLevel: '高' | '中' | '低'
  time: string
  status: 'pending' | 'approved' | 'rejected' | 'transferred'
  detail?: ApprovalDetail
}

export interface ApprovalDetail {
  contractNo: string
  payee: string
  amount: number
  payMethod: string
  accountTail: string
  purpose?: string
  dutyNote?: string
  checks: { label: string; ok: boolean; warn?: boolean }[]
}

export interface DocumentField {
  key: string
  label: string
  value: string
  confidence: 'high' | 'medium' | 'low'
  highlight: { top: number; left: number; width: number; height: number }
}

export type ActionType =
  | 'draft' | 'approve' | 'link' | 'retry' | 'confirm' | 'view'
  | 'manual' | 'reocr' | 'continue' | 'cancel' | 'resolve' | 'archive' | 'defer'

export interface ChatMessage {
  id: string
  sender: 'user' | 'agent' | 'system'
  content: string
  thinking?: ThinkingStep[]
  actions?: { label: string; type: ActionType; nextStep?: string; userText?: string }[]
  uncertainty?: string
  sources?: string[]
  plan?: PlanCard
  artifacts?: ArtifactReference[]
  approval?: ApprovalDetail
  systemNote?: string
}

export interface ThinkingStep {
  id: string
  title: string
  tool: string
  params: string
  status: 'success' | 'running' | 'retry'
  duration: number
}

export interface PlanCard {
  id: string
  title: string
  steps: PlanStep[]
  requiresApproval: boolean
  businessObjects: string[]
  confirmed?: boolean
}

export interface PlanStep {
  id: string
  tool: string
  description: string
  params: string
  status: 'pending' | 'running' | 'done'
}

export interface ArtifactReference {
  id: string
  type: 'reconciliation' | 'order_status' | 'inventory' | 'contract_summary' | 'linked_documents' | 'ocr_field_check' | 'reconciliation_draft'
  title: string
  payload?: unknown
}

export interface NotificationItem {
  id: string
  title: string
  type: 'warning' | 'error' | 'info'
  time: string
}

export type TaskStatus = '进行中' | '已完成' | '失败'
export type TaskMode = 'ask' | 'plan' | 'execute'

export interface Task {
  id: string
  title: string
  projectId: string
  businessNo: string
  businessType: 'contract' | 'order' | 'settlement' | 'document'
  status: TaskStatus
  updatedAt: string
  role: Role
  messages: ChatMessage[]
  mode: TaskMode
  active?: boolean
  artifacts?: ArtifactReference[]
  changes?: ChangeEntry[]
}

export type ProjectStatus = '进行中' | '已完成' | '归档'

export interface Project {
  id: string
  name: string
  businessNo: string
  businessType: 'contract' | 'settlement' | 'risk' | 'logistics' | 'p2p'
  templateId: string
  status: ProjectStatus
  stage: number
  stages: string[]
  updatedAt: string
  role: Role
  instructions: string
  experts: { name: string; description: string }[]
  skills: { name: string; description: string }[]
  connectors: { name: string; authType: 'public' | 'personal'; status: 'connected' | 'pending' }[]
  docLibrary: { name: string; type: string; size: string }[]
  taskIds: string[]
}

export interface ProjectTemplate {
  id: string
  name: string
  businessType: Project['businessType']
  description: string
  icon: string
  stages: string[]
  instructions: string
  experts: { name: string; description: string }[]
  skills: { name: string; description: string }[]
  connectors: { name: string; authType: 'public' | 'personal' }[]
}

export type ToolPermission = 'L1' | 'L2' | 'L3'

export interface Guardrail {
  rule: string
  severity: 'block' | 'warn' | 'info'
}

export interface Expert {
  name: string
  persona: string
  methodology: string[]
}

export interface SkillDef {
  name: string
  sop: string
  trigger: string
}

export interface ToolDef {
  name: string
  label: string
  permission: ToolPermission
  desc: string
  source: string
}

export interface ConnectorDef {
  name: string
  category: 'readonly' | 'approval'
  auth: 'public' | 'personal'
  tools: ToolDef[]
}

export interface KnowledgeDoc {
  title: string
  type: string
}

export interface RoleToolkit {
  role: Role
  label: string
  tagline: string
  guardrails: Guardrail[]
  experts: Expert[]
  skills: SkillDef[]
  connectors: ConnectorDef[]
  knowledge: KnowledgeDoc[]
}

export interface ChangeEntry {
  id: string
  type: 'link' | 'status' | 'field' | 'create'
  title: string
  description: string
  from?: string
  to?: string
  timestamp: string
  actor: 'agent' | 'user'
}

export type AuditEventType = 'user' | 'tool' | 'approval' | 'system'

export interface AuditEvent {
  id: string
  type: AuditEventType
  timestamp: string
  title: string
  detail?: string
  meta?: string
  actor?: string
}

export const CURRENT_CONTRACT_NO = 'HT-2024'
export const CURRENT_ORDER_NO = 'PO-202408'
export const CURRENT_PAYMENT_NO = 'RZ-202408'
export const CURRENT_BL_NO = 'BL-20240815-001'
export const CURRENT_RECONCILIATION_NO = 'DD-202408'

export const MOCK_TODOS: TodoItem[] = [
  { id: 't1', title: '合同 HT-2024 待核对', type: 'contract', status: 'pending', time: '10:23', role: 'trader' },
  { id: 't2', title: '敞口预警：净敞口超限', type: 'exposure', status: 'warning', time: '09:45', role: 'trader' },
  { id: 't3', title: '订单 PO-202408 物流异常', type: 'order', status: 'error', time: '09:10', role: 'trader' },
  { id: 't4', title: '合同 HT-2024 尾款付款申请', type: 'approval', status: 'pending', time: '08:55', role: 'trader' },
  { id: 't5', title: '铜精矿点价确认', type: 'risk', status: 'warning', time: '11:02', role: 'risk' },
  { id: 't6', title: '套保方案待复核', type: 'risk', status: 'pending', time: '10:30', role: 'risk' },
  { id: 't7', title: '本月对账 DD-202407 待核对', type: 'settlement', status: 'pending', time: '09:15', role: 'finance' },
  { id: 't8', title: '发票 FP-202405 未核销', type: 'invoice', status: 'warning', time: '08:40', role: 'finance' },
  { id: 't9', title: '经营月报已生成', type: 'contract', status: 'normal', time: '08:00', role: 'management' },
  { id: 't10', title: '大额付款待审批', type: 'approval', status: 'warning', time: '07:50', role: 'management' },
]

export const QUICK_ACTIONS: QuickAction[] = [
  { id: 'q1', label: '查订单', prompt: '帮我查一下最近的订单状态', icon: 'search' },
  { id: 'q2', label: '查库存', prompt: '查一下当前库存总览', icon: 'box' },
  { id: 'q3', label: '查合同', prompt: '查合同 HT-2024 的执行情况', icon: 'file' },
  { id: 'q4', label: '对账', prompt: '帮我发起本月对账', icon: 'calculator' },
  { id: 'q5', label: '挂单据', prompt: '帮我把这份提单挂到合同 HT-2024', icon: 'link' },
  { id: 'q6', label: '付款审批', prompt: '合同 HT-2024 尾款付款审批', icon: 'shield' },
]

export const MOCK_ORDERS: Order[] = [
  { id: 'PO-202408', customer: '华东石化', product: '柴油', quantity: 10000, unit: '吨', status: '已发货', updateTime: '10:23' },
  { id: 'SO-202407', customer: '北方贸易', product: '铜精矿', quantity: 500, unit: '吨', status: '待付款', updateTime: '09:45' },
  { id: 'PO-202405', customer: '南方能源', product: '沥青', quantity: 2000, unit: '吨', status: '已完成', updateTime: '昨天' },
]

export const MOCK_INVENTORY: InventoryItem[] = [
  { warehouse: '张家港仓库', product: '柴油', quantity: 12000, unit: '吨' },
  { warehouse: '连云港仓库', product: '铜精矿', quantity: 8500, unit: '吨' },
]

export const MOCK_EXPOSURE: Exposure = {
  netExposure: -5000,
  unit: '吨',
  riskLevel: '中',
  change: 12,
}

export const MOCK_APPROVALS: Approval[] = [
  {
    id: 'a1',
    type: '付款申请',
    applicant: '张三',
    summary: '合同 HT-2024 尾款',
    riskLevel: '高',
    time: '10:23',
    status: 'pending',
    detail: {
      contractNo: 'HT-2024',
      payee: '北方贸易',
      amount: 13600000,
      payMethod: '银行承兑汇票',
      accountTail: '8899',
      checks: [
        { label: '合同金额与本次付款比例匹配：20%', ok: true },
        { label: '订单 PO-202408 已收货', ok: true },
        { label: '发票已收到', ok: true },
        { label: '收款账户与合同账户不一致', ok: false, warn: true },
      ],
    },
  },
  {
    id: 'a2',
    type: '点价确认',
    applicant: '李四',
    summary: '铜精矿 点价 68,500',
    riskLevel: '中',
    time: '09:45',
    status: 'pending',
  },
  {
    id: 'a3',
    type: '结算提交',
    applicant: '王五',
    summary: '对账 DD-202407',
    riskLevel: '低',
    time: '09:10',
    status: 'pending',
  },
  {
    id: 'a4',
    type: '付款申请',
    applicant: '张三',
    summary: '合同 HT-2023 尾款',
    riskLevel: '低',
    time: '昨天',
    status: 'approved',
  },
]

export const PAYMENT_APPROVAL_DETAIL: ApprovalDetail = {
  contractNo: 'HT-2024',
  payee: '北方贸易',
  amount: 13600000,
  payMethod: '银行承兑汇票',
  accountTail: '8899',
  purpose: '合同 HT-2024 尾款付款',
  checks: [
    { label: '合同金额与本次付款比例匹配：20%', ok: true },
    { label: '订单 PO-202408 已收货', ok: true },
    { label: '发票已收到', ok: true },
    { label: '收款账户与合同账户不一致', ok: false, warn: true },
  ],
}

export const MOCK_DOCUMENT_FIELDS: DocumentField[] = [
  { key: 'no', label: '合同编号', value: 'HT-2024', confidence: 'high', highlight: { top: 8, left: 6, width: 22, height: 5 } },
  { key: 'date', label: '签约日期', value: '2024-06-01', confidence: 'high', highlight: { top: 14, left: 6, width: 20, height: 5 } },
  { key: 'partyA', label: '甲方', value: '华东石化', confidence: 'high', highlight: { top: 22, left: 6, width: 24, height: 5 } },
  { key: 'partyB', label: '乙方', value: '北方贸易', confidence: 'high', highlight: { top: 28, left: 6, width: 24, height: 5 } },
  { key: 'goods', label: '货物', value: '柴油 10,000 吨', confidence: 'high', highlight: { top: 36, left: 6, width: 30, height: 5 } },
  { key: 'price', label: '单价', value: '6,800 元/吨', confidence: 'high', highlight: { top: 42, left: 6, width: 22, height: 5 } },
  { key: 'amount', label: '金额', value: '68,000,000 元', confidence: 'high', highlight: { top: 48, left: 6, width: 28, height: 5 } },
  { key: 'delivery', label: '交货地', value: '张家港', confidence: 'high', highlight: { top: 54, left: 6, width: 18, height: 5 } },
  { key: 'payMethod', label: '付款方式', value: '银行承兑汇票', confidence: 'medium', highlight: { top: 60, left: 6, width: 26, height: 5 } },
  { key: 'term', label: '账期', value: '30 天', confidence: 'high', highlight: { top: 66, left: 6, width: 16, height: 5 } },
  { key: 'spec', label: '货物规格', value: '0# 柴油 (0.72)', confidence: 'low', highlight: { top: 72, left: 6, width: 26, height: 5 } },
]

export const INITIAL_CHAT: ChatMessage[] = [
  {
    id: 'm1',
    sender: 'user',
    content: '帮我查一下合同 HT-2024 的订单执行和已收款情况。',
  },
  {
    id: 'm2',
    sender: 'agent',
    content: '合同 HT-2024 对应订单 3 个，其中 2 个已发货，1 个待付款。已收款 80%（400 万 / 500 万）。',
    sources: ['ERP 订单系统', '财务资金系统', '合同管理系统'],
    thinking: [
      { id: 's1', title: '解析合同号', tool: 'intent-parser', params: 'contractNo=HT-2024', status: 'success', duration: 120 },
      { id: 's2', title: '查询合同关联订单', tool: 'erp-query-order', params: 'contractNo=HT-2024', status: 'success', duration: 340 },
      { id: 's3', title: '查询财务收款记录', tool: 'finance-query-payment', params: 'contractNo=HT-2024', status: 'success', duration: 520 },
      { id: 's4', title: '计算订单执行比例', tool: 'calc-execution', params: 'orders=3,shipped=2,paid=0.8', status: 'success', duration: 80 },
    ],
    uncertainty: '系统未匹配到本次收款的发票号，已用黄色标出，请确认。',
    actions: [
      { label: '生成对账草稿', type: 'draft' },
      { label: '提交审批', type: 'approve' },
    ],
    artifacts: [
      { id: 'a1', type: 'contract_summary', title: '合同 HT-2024 执行摘要' },
      { id: 'a2', type: 'order_status', title: '订单执行时间线' },
    ],
  },
]

export const RECONCILIATION_PLAN: PlanCard = {
  id: 'p1',
  title: '本月对账执行计划',
  steps: [
    { id: 'ps1', tool: 'intent-parser', description: '解析对账月份与合同范围', params: 'month=2024-08,contracts=HT-2024', status: 'pending' },
    { id: 'ps2', tool: 'erp-query-order', description: '拉取 8 月订单与发货数据', params: 'month=2024-08', status: 'pending' },
    { id: 'ps3', tool: 'finance-query-payment', description: '拉取 8 月资金流水', params: 'month=2024-08', status: 'pending' },
    { id: 'ps4', tool: 'invoice-query', description: '匹配发票与收款记录', params: 'contractNo=HT-2024', status: 'pending' },
    { id: 'ps5', tool: 'settlement-draft', description: '生成对账草稿并标记差异', params: 'auto-match=true', status: 'pending' },
  ],
  requiresApproval: true,
  businessObjects: ['合同 HT-2024', '订单 PO-202408', '收款单 RZ-202408', '对账 DD-202408'],
}

export const RECONCILIATION_ARTIFACT: ArtifactReference = {
  id: 'ra1',
  type: 'reconciliation',
  title: '对账草稿 DD-202408',
  payload: {
    rows: [
      { item: '订单 PO-202408', erp: '10,000 吨', finance: '10,000 吨', diff: '0', status: 'ok' },
      { item: '发货金额', erp: '6,800 万元', finance: '6,800 万元', diff: '0', status: 'ok' },
      { item: '已收款', erp: '400 万元', finance: '400 万元', diff: '0', status: 'ok' },
      { item: '发票号', erp: '未匹配', finance: 'FP-202408', diff: '1 张', status: 'warn' },
      { item: '收款发票差额', erp: '0', finance: '6.8 万元', diff: '6.8 万元', status: 'warn' },
    ],
    summary: '差异金额 68,000 元，待确认发票 FP-202408。',
  },
}

export const MOCK_NOTIFICATIONS: NotificationItem[] = [
  { id: 'n1', title: '敞口预警：净敞口 -5,000 吨，风险等级中', type: 'warning', time: '10:23' },
  { id: 'n2', title: '订单 PO-202408 物流异常，请及时处理', type: 'error', time: '09:10' },
  { id: 'n3', title: '合同 HT-2024 尾款付款申请待审批', type: 'info', time: '08:55' },
]

export const AI_PROMPT_TEMPLATES = [
  '查今日待发货订单',
  '核对本月发票',
  '合同 HT-2024 执行情况',
  '当前敞口是多少',
  '生成对账草稿',
  '挂接提单到合同',
]

export const MOCK_FINANCE_SUMMARY = {
  pendingSettlement: 7,
  unverifiedInvoice: 3,
  fundFlow: 28500000,
}

export const MOCK_MANAGEMENT_SUMMARY = {
  grossProfit: 12400000,
  inventoryTurnover: 4.2,
  pendingApprovals: 5,
  abnormalOrders: 1,
}

export const MOCK_RISK_SUMMARY = {
  alerts: 4,
  hedgingTodo: 2,
  priceRisk: '中',
}

export const MOCK_TASKS: Task[] = [
  {
    id: 'tk1',
    title: '合同 HT-2024 执行与收款',
    projectId: 'proj-ht2024',
    businessNo: 'HT-2024',
    businessType: 'contract',
    status: '进行中',
    updatedAt: '今天 10:23',
    role: 'trader',
    mode: 'ask',
    active: true,
    messages: INITIAL_CHAT,
    changes: [],
    artifacts: [
      { id: 'a1', type: 'contract_summary', title: '合同 HT-2024 执行摘要' },
      { id: 'a2', type: 'order_status', title: '订单执行时间线' },
    ],
  },
  {
    id: 'tk2',
    title: '本月对账 DD-202408',
    projectId: 'proj-ht2024',
    businessNo: 'DD-202408',
    businessType: 'settlement',
    status: '进行中',
    updatedAt: '今天 09:15',
    role: 'finance',
    mode: 'plan',
    messages: [
      {
        id: 'm1',
        sender: 'user',
        content: '帮我发起本月对账',
      },
      {
        id: 'm2',
        sender: 'agent',
        content: '已为您制定本月对账执行计划。该计划涉及合同、订单、资金与发票系统，需要您确认后执行。',
        plan: RECONCILIATION_PLAN,
        sources: ['ERP 订单系统', '财务资金系统', '发票管理系统'],
        actions: [{ label: '确认执行', type: 'confirm' }],
      },
    ],
    changes: [],
  },
  {
    id: 'tk3',
    title: '挂接提单到合同 HT-2024',
    projectId: 'proj-ht2024',
    businessNo: 'BL-20240815-001',
    businessType: 'document',
    status: '已完成',
    updatedAt: '今天 08:40',
    role: 'trader',
    mode: 'execute',
    messages: [
      {
        id: 'm1',
        sender: 'user',
        content: '帮我把这份提单挂到合同 HT-2024',
      },
      {
        id: 'm2',
        sender: 'agent',
        content: '已完成提单 BL-20240815-001 与合同 HT-2024 的挂接。OCR 共抽取 12 个字段，关键字段置信度均高于 95%。',
        thinking: [
          { id: 's1', title: 'OCR 结构化抽取', tool: 'ocr-mineru', params: 'file=BL-20240815-001.pdf', status: 'success', duration: 890 },
          { id: 's2', title: '字段抽取与校验', tool: 'field-extract', params: 'docType=BL,contractNo=HT-2024', status: 'success', duration: 340 },
          { id: 's3', title: '业务绑定', tool: 'doc-link', params: 'contractNo=HT-2024,blNo=BL-20240815-001', status: 'success', duration: 120 },
        ],
        sources: ['OCR 识别服务', '合同管理系统', '单据中心'],
        actions: [{ label: '查看单据', type: 'view' }],
      },
    ],
    changes: [
      { id: 'c1', type: 'link', title: '挂接单据', description: '合同 HT-2024 挂接提单 BL-20240815-001', timestamp: '08:40:22', actor: 'agent' },
      { id: 'c2', type: 'field', title: '更新单据索引', description: 'OCR 字段写入单据中心', from: '未索引', to: '已索引', timestamp: '08:40:25', actor: 'agent' },
    ],
  },
  {
    id: 'tk4',
    title: '付款审批：HT-2024 尾款',
    projectId: 'proj-ht2024',
    businessNo: 'HT-2024',
    businessType: 'contract',
    status: '进行中',
    updatedAt: '昨天 16:30',
    role: 'management',
    mode: 'ask',
    messages: [
      {
        id: 'm1',
        sender: 'user',
        content: '合同 HT-2024 尾款付款申请帮我审批一下',
      },
      {
        id: 'm2',
        sender: 'agent',
        content: '合同 HT-2024 尾款付款申请已调出，金额 1,360 万元。AI 校验发现 1 项预警：收款账户与合同账户不一致，请重点核对。',
        approval: PAYMENT_APPROVAL_DETAIL,
        sources: ['合同管理系统', '财务资金系统'],
        actions: [
          { label: '通过审批', type: 'approve' },
          { label: '拒绝', type: 'retry' },
        ],
      },
    ],
    changes: [],
  },
  {
    id: 'tk5',
    title: '铜精矿点价方案',
    projectId: 'proj-risk-cu',
    businessNo: 'SO-202407',
    businessType: 'order',
    status: '已完成',
    updatedAt: '昨天 14:22',
    role: 'risk',
    mode: 'ask',
    messages: [
      {
        id: 'm1',
        sender: 'user',
        content: '铜精矿点价方案分析一下',
      },
      {
        id: 'm2',
        sender: 'agent',
        content: '建议分批点价，先锁定 30% 敞口，剩余 70% 观察 LME 铜价走势。当前净敞口 -500 吨。',
        sources: ['行情系统', '风控系统'],
      },
    ],
    changes: [],
  },
  {
    id: 'tk6',
    title: '仓库库存盘点核对',
    projectId: 'proj-logistics-zjg',
    businessNo: 'WH-ZJG',
    businessType: 'order',
    status: '已完成',
    updatedAt: '周三 11:05',
    role: 'trader',
    mode: 'ask',
    messages: [
      {
        id: 'm1',
        sender: 'user',
        content: '张家港仓库柴油库存核对',
      },
      {
        id: 'm2',
        sender: 'agent',
        content: '系统台账 12,000 吨，实物盘点 11,980 吨，差异 20 吨，在合理损耗范围内。',
        sources: ['WMS 仓储系统'],
      },
    ],
    changes: [],
  },
]

export const DEFAULT_CONTRACT_SUMMARY = {
  no: 'HT-2024',
  date: '2024-06-01',
  partyA: '华东石化',
  partyB: '北方贸易',
  goods: '柴油',
  quantity: 10000,
  unit: '吨',
  price: 6800,
  amount: 68000000,
  delivery: '张家港',
  payMethod: '银行承兑汇票',
  term: '30 天',
  status: '执行中',
  unavailable: [
    { key: 'warehouseReceipt', label: '仓单状态', reason: '数据不可得', tool: 'get_warehouse_status' },
  ],
}

export const RECONCILIATION_CHANGES: ChangeEntry[] = [
  { id: 'r1', type: 'create', title: '生成对账草稿', description: '创建对账单 DD-202408', timestamp: '09:16:03', actor: 'agent' },
  { id: 'r2', type: 'field', title: '差异标记', description: '发票 FP-202408 未匹配', from: '未匹配', to: '待确认', timestamp: '09:16:05', actor: 'agent' },
  { id: 'r3', type: 'field', title: '金额差异', description: '收款发票差额', from: '0', to: '68,000 元', timestamp: '09:16:05', actor: 'agent' },
]

export const PROJECT_TEMPLATES: ProjectTemplate[] = [
  {
    id: 'tpl-contract',
    name: '合同执行',
    businessType: 'contract',
    description: '大宗商品合同履约全流程跟踪：签约、发货、对账、付款、归档。',
    icon: 'file',
    stages: ['签约', '履约', '发货', '结算', '付款', '归档'],
    instructions: '本助手只引用合同管理系统、ERP 订单系统与财务资金系统的真实记录；所有付款与定价类写操作必须经人工确认后方可执行。',
    experts: [
      { name: '贸易履约专家', description: '跟踪合同执行、发货、收款与单据挂接' },
      { name: '对账结算专员', description: '自动核对 ERP 与财务资金流水差异' },
    ],
    skills: [
      { name: '合同条款抽取', description: '从合同 PDF 抽取关键字段并校验' },
      { name: '订单状态聚合', description: '汇总合同下全部订单与发货状态' },
      { name: '对账差异分析', description: '匹配订单、发票、收款并标记差异' },
      { name: '单据 OCR 绑定', description: '提单/发票自动识别并挂接到合同' },
    ],
    connectors: [
      { name: 'ERP-湖北国贸能源化工', authType: 'public' },
      { name: '合同管理系统', authType: 'public' },
      { name: '财务资金系统', authType: 'public' },
      { name: 'OCR 识别服务', authType: 'personal' },
    ],
  },
  {
    id: 'tpl-settlement',
    name: '对账结算',
    businessType: 'settlement',
    description: '月度结算核对：发起对账、差异确认、开票、收款、归档。',
    icon: 'calculator',
    stages: ['发起对账', '差异核对', '确认', '开票', '收款', '归档'],
    instructions: '对账过程必须逐笔核对 ERP 发货记录、财务收款记录与发票平台；差异项需人工确认后方可生成最终结算单。',
    experts: [
      { name: '对账结算专员', description: '主导差异核对与结算单生成' },
      { name: '税务合规助手', description: '校验发票与合同一致性' },
    ],
    skills: [
      { name: '结算单生成', description: '按合同/月份聚合应收应付' },
      { name: '发票匹配', description: '将发票与订单/收款自动勾稽' },
      { name: '差异预警', description: '标记金额、数量、发票不一致项' },
    ],
    connectors: [
      { name: 'ERP-湖北国贸能源化工', authType: 'public' },
      { name: '财务资金系统', authType: 'public' },
      { name: '发票管理平台', authType: 'public' },
    ],
  },
  {
    id: 'tpl-risk',
    name: '风控盯市',
    businessType: 'risk',
    description: '大宗商品敞口监控、价格预警、套保与平仓复盘。',
    icon: 'shield',
    stages: ['建仓', '盯市', '预警', '平仓', '复盘'],
    instructions: '风控助手仅读取行情与敞口数据，点价与平仓建议需经风控审批；所有价格类数据以行情系统为准。',
    experts: [
      { name: '风险监控官', description: '实时监测敞口与价格预警' },
      { name: '套保策略师', description: '提供套保方案与平仓建议' },
    ],
    skills: [
      { name: '敞口测算', description: '实时计算净敞口与在险合同' },
      { name: '价格预警', description: '监控基差、LME/SHFE 波动' },
      { name: '套保方案生成', description: '按敞口生成对冲建议' },
    ],
    connectors: [
      { name: '行情系统', authType: 'public' },
      { name: '风控中心', authType: 'public' },
      { name: '期货交易系统', authType: 'personal' },
    ],
  },
  {
    id: 'tpl-logistics',
    name: '仓储物流',
    businessType: 'logistics',
    description: '入库、在库、提货、出库到结算的物流台账管理。',
    icon: 'truck',
    stages: ['入库', '在库', '提货', '出库', '结算'],
    instructions: '物流数据以 WMS 仓储系统为准；出入库必须与合同/订单号绑定，确保货权清晰。',
    experts: [
      { name: '仓储调度员', description: '跟踪入库、出库与库存异动' },
      { name: '货权管理员', description: '校验货权转移与提单一致性' },
    ],
    skills: [
      { name: '库存盘点', description: '系统台账与实物盘点核对' },
      { name: '出入库绑定', description: '将出入库与合同/订单关联' },
      { name: '物流异常预警', description: '识别超期在库、在途停滞' },
    ],
    connectors: [
      { name: 'WMS-张家港仓库', authType: 'public' },
      { name: 'WMS-连云港仓库', authType: 'public' },
      { name: '物流跟踪平台', authType: 'public' },
    ],
  },
  {
    id: 'tpl-p2p',
    name: '采购到付款 P2P',
    businessType: 'p2p',
    description: '请购、比价、合同、订单、到货、对账、付款全流程。',
    icon: 'cart',
    stages: ['请购', '比价', '合同', '订单', '到货', '对账', '付款'],
    instructions: 'P2P 助手遵循采购审批流，比价与合同需采购审批，到货与付款需财务复核。',
    experts: [
      { name: '采购专员', description: '比价、合同与订单执行' },
      { name: '应付会计', description: '到货核对、对账与付款发起' },
    ],
    skills: [
      { name: '比价分析', description: '多供应商报价对比与推荐' },
      { name: '采购订单跟踪', description: '跟踪订单、到货与验收' },
      { name: '应付对账', description: '匹配订单、收货单与发票' },
    ],
    connectors: [
      { name: '采购管理系统', authType: 'public' },
      { name: 'ERP-湖北国贸能源化工', authType: 'public' },
      { name: '财务资金系统', authType: 'public' },
    ],
  },
]

export interface OCRFieldRow {
  key: string
  label: string
  extractedValue: string
  confidence: number
  status: 'auto' | 'manual' | 'error'
  correctValue?: string
}

export interface HITLDemoDecision {
  label: string
  nextStep: string
  userText?: string
  type: ActionType
}

export interface HITLDemoStep {
  id: string
  label: string
  mode: TaskMode
  userMessage?: string
  agentMessage: ChatMessage
  systemNote?: string
  decisions?: HITLDemoDecision[]
  changes?: ChangeEntry[]
  projectStageAdvanceTo?: number
  projectStatus?: ProjectStatus
}

export const HITL_CONTRACT_SUMMARY = {
  no: 'HT-2024',
  date: '2024-06-01',
  partyA: '华盛炼化',
  partyB: '湖北国贸能源化工',
  goods: '0# 柴油',
  quantity: 5000,
  unit: '吨',
  price: 7200,
  amount: 36000000,
  delivery: '张家港港',
  payMethod: '银行承兑汇票',
  term: '30 天',
  status: '执行中',
  unavailable: [
    { key: 'warehouseReceipt', label: '仓单状态', reason: '数据不可得', tool: 'get_warehouse_status 超时' },
    { key: 'shipmentDetail', label: 'ORD-2024-0883 发运明细', reason: '数据不可得', tool: 'fetch_shipment_detail 未返回' },
  ],
}

export const HITL_ORDERS: Order[] = [
  { id: 'ORD-2024-0881', customer: '华盛炼化', product: '0# 柴油', quantity: 2000, unit: '吨', status: '已完成', updateTime: '2024-07-15' },
  { id: 'ORD-2024-0882', customer: '华盛炼化', product: '0# 柴油', quantity: 1500, unit: '吨', status: '已完成', updateTime: '2024-07-28' },
  { id: 'ORD-2024-0883', customer: '华盛炼化', product: '0# 柴油', quantity: 1500, unit: '吨', status: '待付款', updateTime: '2024-08-12' },
]

export const HITL_OCR_FIELDS: OCRFieldRow[] = [
  { key: 'consignee', label: '收货人', extractedValue: '华盛炼化', confidence: 0.98, status: 'auto' },
  { key: 'quantity', label: '数量', extractedValue: '49X0 吨', confidence: 0.61, status: 'manual', correctValue: '4950 吨' },
  { key: 'arrivalDate', label: '到港日期', extractedValue: '2024-08-15', confidence: 0.95, status: 'auto' },
]

export const HITL_PAYMENT_APPROVAL: ApprovalDetail = {
  contractNo: 'HT-2024',
  payee: '华盛炼化',
  amount: 10800000,
  payMethod: '银行承兑汇票',
  accountTail: '8847',
  purpose: '合同 HT-2024 尾款付款',
  checks: [
    { label: '合同状态正常：HT-2024 执行中', ok: true },
    { label: '发票齐全：FP-202408 已核销', ok: true },
    { label: '授信额度充足：剩余额度 2,500 万', ok: true },
    { label: '收款账户末位变化：合同登记 ...8842，本次 ...8847', ok: false, warn: true },
  ],
}

export const HITL_DEMO_FLOW: HITLDemoStep[] = [
  {
    id: 'T1',
    label: 'T1 执行状态查询',
    mode: 'ask',
    userMessage: '把 HT-2024 的执行状态给我。',
    agentMessage: {
      id: 'hitl-t1',
      sender: 'agent',
      content: '合同 HT-2024 当前执行中，已发货 3,500 吨，待付款 1,500 吨。账面累计收款 70%（2,520 万 / 3,600 万）。',
      thinking: [
        { id: 't1-1', title: '查询合同主数据', tool: 'query_contract', params: 'contractNo=HT-2024', status: 'success', duration: 180 },
        { id: 't1-2', title: '查询订单执行', tool: 'query_orders', params: 'contractNo=HT-2024', status: 'success', duration: 320 },
        { id: 't1-3', title: '查询库存台账', tool: 'query_inventory', params: 'contractNo=HT-2024', status: 'success', duration: 260 },
        { id: 't1-4', title: '交叉校验', tool: 'cross_check', params: 'contract=HT-2024,orders=3', status: 'success', duration: 140 },
      ],
      uncertainty: '第 3 笔订单（ORD-2024-0883）缺发票号，可能影响本月对账。',
      sources: ['ERP-湖北国贸能源化工', '仓储 WMS', '资金系统'],
      actions: [
        { label: '发起对账', type: 'draft' },
        { label: '查看明细', type: 'view' },
      ],
      artifacts: [
        { id: 'hitl-a1', type: 'contract_summary', title: '合同 HT-2024 执行摘要', payload: 'hitl-contract' },
        { id: 'hitl-a2', type: 'order_status', title: '订单执行时间线', payload: 'hitl-orders' },
      ],
    },
    decisions: [
      { label: '发起对账', nextStep: 'T2', userText: '帮我发起本月对账。', type: 'draft' },
      { label: '查看明细', nextStep: 'T1_DETAIL', userText: '查看 HT-2024 明细。', type: 'view' },
    ],
  },
  {
    id: 'T1_DETAIL',
    label: 'T1 明细',
    mode: 'ask',
    agentMessage: {
      id: 'hitl-t1-detail',
      sender: 'agent',
      content: '明细：ORD-2024-0881 已完成（2,000 吨），ORD-2024-0882 已完成（1,500 吨），ORD-2024-0883 待付款（1,500 吨）。',
      sources: ['ERP-湖北国贸能源化工'],
      actions: [
        { label: '发起对账', nextStep: 'T2', userText: '帮我发起本月对账。', type: 'draft' },
      ],
    },
  },
  {
    id: 'T2',
    label: 'T2 对账计划',
    mode: 'plan',
    userMessage: '帮我发起本月对账。',
    agentMessage: {
      id: 'hitl-t2',
      sender: 'agent',
      content: '已为您制定本月对账执行计划。该计划涉及合同、订单、买方回执与资金系统，确认后才会执行。',
      sources: ['ERP-湖北国贸能源化工', '买方回执系统', '资金系统'],
      plan: {
        id: 'hitl-plan-1',
        title: '本月对账执行计划',
        steps: [
          { id: 'p1', tool: 'fetch_shipment', description: '拉取发货明细', params: 'contractNo=HT-2024,month=2024-08', status: 'pending' },
          { id: 'p2', tool: 'fetch_buyer_receipt', description: '对比买方回执', params: 'buyer=华盛炼化,month=2024-08', status: 'pending' },
          { id: 'p3', tool: 'calc_variance', description: '计算数量与金额差异', params: 'threshold=0.5%', status: 'pending' },
          { id: 'p4', tool: 'create_reconciliation', description: '生成对账草稿 REC-2024-0912', params: 'auto-match=true', status: 'pending' },
          { id: 'p5', tool: 'notify_buyer', description: '推送给华盛炼化', params: 'channel=email', status: 'pending' },
        ],
        requiresApproval: true,
        businessObjects: ['合同 HT-2024', '订单 ORD-2024-0883'],
      },
      actions: [
        { label: '确认执行', type: 'confirm' },
        { label: '修改计划', type: 'manual' },
        { label: '取消', type: 'cancel' },
      ],
    },
    decisions: [
      { label: '确认执行', nextStep: 'T3', userText: '确认执行。', type: 'confirm' },
      { label: '修改计划', nextStep: 'T2_EDIT', userText: '我想调整一下计划。', type: 'manual' },
      { label: '取消', nextStep: 'T2_CANCEL', userText: '取消对账。', type: 'cancel' },
    ],
  },
  {
    id: 'T2_EDIT',
    label: 'T2 修改计划',
    mode: 'ask',
    userMessage: '我想调整一下计划。',
    agentMessage: {
      id: 'hitl-t2-edit',
      sender: 'agent',
      content: '请在下方输入框中补充修改意见，例如：调整阈值、增加复核人、跳过推送等。当前计划已暂存。',
      actions: [
        { label: '使用当前计划继续', nextStep: 'T3', userText: '确认执行。', type: 'confirm' },
      ],
    },
  },
  {
    id: 'T2_CANCEL',
    label: 'T2 取消',
    mode: 'ask',
    userMessage: '取消对账。',
    agentMessage: {
      id: 'hitl-t2-cancel',
      sender: 'agent',
      content: '已取消对账计划。如需重新发起，可随时输入指令。',
      actions: [
        { label: '重新发起', nextStep: 'T2', userText: '帮我发起本月对账。', type: 'draft' },
      ],
    },
  },
  {
    id: 'T3',
    label: 'T3 执行与差异暂停',
    mode: 'plan',
    userMessage: '确认执行。',
    agentMessage: {
      id: 'hitl-t3',
      sender: 'agent',
      content: '对账执行到第 3 步时暂停，需要您确认差异处理方式。',
      thinking: [
        { id: 't3-1', title: '拉取发货明细', tool: 'fetch_shipment', params: 'contractNo=HT-2024,month=2024-08', status: 'success', duration: 420 },
        { id: 't3-2', title: '对比买方回执', tool: 'fetch_buyer_receipt', params: 'buyer=华盛炼化,month=2024-08', status: 'success', duration: 380 },
        { id: 't3-3', title: '计算差异', tool: 'calc_variance', params: 'threshold=0.5%', status: 'success', duration: 260 },
        { id: 't3-4', title: '生成对账草稿', tool: 'create_reconciliation', params: 'auto-match=true', status: 'running', duration: 120 },
        { id: 't3-5', title: '推送买方', tool: 'notify_buyer', params: 'channel=email', status: 'running', duration: 120 },
      ],
      uncertainty: '发现数量差异：我方账面 4,980 吨，对方回执 4,950 吨，差 30 吨（0.6%），超过 0.5% 阈值。请确认处理方式。',
      sources: ['ERP-湖北国贸能源化工', '买方回执系统'],
      actions: [
        { label: '按我方账面发出', type: 'resolve' },
        { label: '按对方回执发出（我方留备忘）', type: 'resolve' },
        { label: '联系华盛核实（转人工）', type: 'manual' },
        { label: '查看差异明细', type: 'view' },
      ],
    },
    decisions: [
      { label: '按对方回执发出（我方留备忘）', nextStep: 'T4', userText: '按对方回执发出（我方留备忘）。另外把今天的提单挂上去。', type: 'resolve' },
      { label: '按我方账面发出', nextStep: 'T3_OUR_SIDE', userText: '按我方账面发出。', type: 'resolve' },
      { label: '联系华盛核实（转人工）', nextStep: 'T3_HANDOFF', userText: '联系华盛核实。', type: 'manual' },
      { label: '查看差异明细', nextStep: 'T3_DETAIL', userText: '查看差异明细。', type: 'view' },
    ],
    changes: [
      { id: 'hitl-c1', type: 'create', title: '生成对账草稿', description: '对账草稿 REC-2024-0912（草稿，未提交）', timestamp: '10:28:15', actor: 'agent' },
    ],
    projectStageAdvanceTo: 3,
  },
  {
    id: 'T3_DETAIL',
    label: 'T3 差异明细',
    mode: 'ask',
    userMessage: '查看差异明细。',
    agentMessage: {
      id: 'hitl-t3-detail',
      sender: 'agent',
      content: '差异明细：ORD-2024-0883 发货 1,500 吨中，买方回执确认 1,470 吨，差异 30 吨。可能原因：卸货港计量损耗 / 质检扣减。按合同 0.5% 免赔条款，本次差异 0.6% 需双方确认。',
      sources: ['ERP-湖北国贸能源化工', '买方回执系统'],
      actions: [
        { label: '按对方回执发出（我方留备忘）', type: 'resolve' },
        { label: '按我方账面发出', type: 'resolve' },
        { label: '联系华盛核实（转人工）', type: 'manual' },
      ],
    },
    decisions: [
      { label: '按对方回执发出（我方留备忘）', nextStep: 'T4', userText: '按对方回执发出（我方留备忘）。另外把今天的提单挂上去。', type: 'resolve' },
      { label: '按我方账面发出', nextStep: 'T3_OUR_SIDE', userText: '按我方账面发出。', type: 'resolve' },
      { label: '联系华盛核实（转人工）', nextStep: 'T3_HANDOFF', userText: '联系华盛核实。', type: 'manual' },
    ],
  },
  {
    id: 'T3_OUR_SIDE',
    label: 'T3 按我方账面',
    mode: 'plan',
    userMessage: '按我方账面发出。',
    agentMessage: {
      id: 'hitl-t3-our',
      sender: 'agent',
      content: '已按我方账面 4,980 吨生成对账草稿，差异 30 吨已标记待复核。',
      actions: [
        { label: '继续挂提单', nextStep: 'T4', userText: '把今天的提单挂上去。', type: 'link' },
      ],
    },
    changes: [
      { id: 'hitl-c1b', type: 'field', title: '对账数量确认', description: '对账草稿 REC-2024-0912 数量', from: '待确认', to: '4,980 吨', timestamp: '10:28:45', actor: 'user' },
    ],
    projectStageAdvanceTo: 3,
  },
  {
    id: 'T3_HANDOFF',
    label: 'T3 转人工',
    mode: 'plan',
    userMessage: '联系华盛核实。',
    agentMessage: {
      id: 'hitl-t3-handoff',
      sender: 'agent',
      content: '已创建人工跟进单，待业务员联系华盛炼化确认 30 吨差异后重新触发对账。',
      actions: [
        { label: '重新开始', nextStep: 'T1', userText: '把 HT-2024 的执行状态给我。', type: 'retry' },
      ],
    },
  },
  {
    id: 'T4',
    label: 'T4 提单 OCR 核验',
    mode: 'execute',
    userMessage: '按对方回执发出（我方留备忘）。另外把今天的提单挂上去。',
    agentMessage: {
      id: 'hitl-t4',
      sender: 'agent',
      content: '已切换至执行模式，正在对提单 BL-20240815-001 进行 OCR 字段核验。请确认异常字段。',
      thinking: [
        { id: 't4-1', title: 'OCR 结构化抽取', tool: 'ocr_mineru', params: 'file=BL-20240815-001.pdf', status: 'success', duration: 760 },
        { id: 't4-2', title: '字段置信度评估', tool: 'field_confidence', params: 'docType=BL', status: 'success', duration: 220 },
        { id: 't4-3', title: '合同号匹配', tool: 'match_contract', params: 'contractNo=HT-2024', status: 'success', duration: 180 },
      ],
      sources: ['OCR 识别服务', '合同管理系统'],
      actions: [
        { label: '确认为 4950', type: 'confirm' },
        { label: '手动修正', type: 'manual' },
        { label: '重新 OCR', type: 'reocr' },
      ],
      artifacts: [
        { id: 'hitl-a3', type: 'ocr_field_check', title: '提单 BL-20240815-001 字段核验', payload: 'hitl-ocr' },
      ],
    },
    decisions: [
      { label: '确认为 4950', nextStep: 'T4_CONFIRM', userText: '确认数量为 4950 吨。', type: 'confirm' },
      { label: '手动修正', nextStep: 'T4_CONFIRM', userText: '手动修正为 4950 吨并确认。', type: 'manual' },
      { label: '重新 OCR', nextStep: 'T4_CONFIRM', userText: '重新 OCR 后确认数量为 4950 吨。', type: 'reocr' },
    ],
  },
  {
    id: 'T4_CONFIRM',
    label: 'T4 确认挂接',
    mode: 'execute',
    userMessage: '确认数量为 4950 吨。',
    agentMessage: {
      id: 'hitl-t4-confirm',
      sender: 'agent',
      content: '已写入：合同 HT-2024 挂接提单 BL-20240815-001（已核验）。数量按 4,950 吨落库，30 吨差异已写入备忘。',
      sources: ['合同管理系统', '单据中心'],
      actions: [
        { label: '发起尾款付款申请', nextStep: 'T5', userText: '对账草稿确认了，发起尾款付款申请。', type: 'approve' },
      ],
    },
    changes: [
      { id: 'hitl-c2', type: 'link', title: '挂接单据', description: '合同 HT-2024 挂接提单 BL-20240815-001（字段已核验）', timestamp: '10:31:22', actor: 'agent' },
      { id: 'hitl-c3', type: 'field', title: '数量修正备忘', description: '提单数量按买方回执落库', from: '49X0 吨', to: '4,950 吨', timestamp: '10:31:25', actor: 'user' },
    ],
  },
  {
    id: 'T5',
    label: 'T5 付款审批门',
    mode: 'ask',
    userMessage: '对账草稿确认了，发起尾款付款申请。',
    agentMessage: {
      id: 'hitl-t5',
      sender: 'agent',
      content: '检测到高风险写操作，已触发硬审批门。请核对付款信息并提交审批。',
      thinking: [
        { id: 't5-1', title: '付款意图解析', tool: 'parse_payment_intent', params: 'contractNo=HT-2024', status: 'success', duration: 120 },
        { id: 't5-2', title: '合同与对账状态校验', tool: 'validate_contract_settlement', params: 'contractNo=HT-2024,rec=REC-2024-0912', status: 'success', duration: 280 },
        { id: 't5-3', title: '风险预检', tool: 'risk_check', params: 'contractNo=HT-2024,amount=10800000', status: 'success', duration: 340 },
      ],
      approval: HITL_PAYMENT_APPROVAL,
      sources: ['合同管理系统', '资金系统', '风控中心'],
      actions: [
        { label: '提交审批', type: 'approve' },
        { label: '我先核实账户', type: 'manual' },
        { label: '转交他人', type: 'manual' },
      ],
    },
    decisions: [
      { label: '提交审批', nextStep: 'T6_WAIT', userText: '提交审批。', type: 'approve' },
      { label: '我先核实账户', nextStep: 'T6_WAIT', userText: '我先核实账户，确认后提交审批。', type: 'manual' },
      { label: '转交他人', nextStep: 'T6_WAIT', userText: '转交业务员复核后提交审批。', type: 'manual' },
    ],
  },
  {
    id: 'T6_WAIT',
    label: 'T6 等待审批',
    mode: 'ask',
    userMessage: '提交审批。',
    agentMessage: {
      id: 'hitl-t6-wait',
      sender: 'agent',
      content: '付款申请已提交，等待财务主管审批。系统将自动回灌审批结果并续跑后续资金动作。',
      sources: ['审批系统'],
      actions: [
        { label: '模拟审批通过', type: 'confirm' },
      ],
    },
  },
  {
    id: 'T6_RESULT',
    label: 'T6 审批回灌与续跑',
    mode: 'execute',
    systemNote: '审批通过（李芳，附注：账户已核实为新开户行）',
    agentMessage: {
      id: 'hitl-t6-result',
      sender: 'agent',
      content: '尾款 1,080 万元已发起，资金流水 FLOW-2024-0912 已记录。合同阶段已推进至「付款」。',
      thinking: [
        { id: 't6-1', title: '创建付款单', tool: 'create_payment', params: 'contractNo=HT-2024,amount=10800000', status: 'success', duration: 260 },
        { id: 't6-2', title: '记录资金流水', tool: 'record_fund_flow', params: 'flowNo=FLOW-2024-0912', status: 'success', duration: 180 },
        { id: 't6-3', title: '通知付款方', tool: 'notify_payer', params: 'channel=email', status: 'success', duration: 140 },
        { id: 't6-4', title: '推进合同阶段', tool: 'advance_contract_stage', params: 'contractNo=HT-2024,to=付款', status: 'success', duration: 100 },
      ],
      sources: ['审批系统', '资金系统'],
      actions: [
        { label: '归档', type: 'archive' },
        { label: '暂不', type: 'defer' },
      ],
    },
    decisions: [
      { label: '归档', nextStep: 'T6_ARCHIVE', userText: '归档 HT-2024。', type: 'archive' },
      { label: '暂不', nextStep: 'T6_END', userText: '暂不归档。', type: 'defer' },
    ],
    changes: [
      { id: 'hitl-c4', type: 'create', title: '资金流水新增', description: '资金流水 FLOW-2024-0912 已记录', timestamp: '10:38:10', actor: 'agent' },
      { id: 'hitl-c5', type: 'status', title: '合同阶段推进', description: '合同 HT-2024 阶段推进', from: '结算', to: '付款', timestamp: '10:38:12', actor: 'agent' },
    ],
    projectStageAdvanceTo: 4,
  },
  {
    id: 'T6_END',
    label: 'T6 暂不归档',
    mode: 'ask',
    userMessage: '暂不归档。',
    agentMessage: {
      id: 'hitl-t6-end',
      sender: 'agent',
      content: '已暂停归档。如需继续，可随时输入「归档 HT-2024」。',
      actions: [
        { label: '归档', nextStep: 'T6_ARCHIVE', userText: '归档 HT-2024。', type: 'archive' },
      ],
    },
  },
  {
    id: 'T6_ARCHIVE',
    label: 'T6 归档',
    mode: 'execute',
    userMessage: '归档 HT-2024。',
    agentMessage: {
      id: 'hitl-t6-archive',
      sender: 'agent',
      content: '合同 HT-2024 已归档，项目生命周期推进至终态。',
      sources: ['合同管理系统'],
      actions: [],
    },
    changes: [
      { id: 'hitl-c6', type: 'status', title: '合同阶段推进', description: '合同 HT-2024 阶段推进', from: '付款', to: '归档', timestamp: '10:39:05', actor: 'user' },
    ],
    projectStageAdvanceTo: 5,
    projectStatus: '已完成',
  },
]

export const HITL_AUDIT_TIMELINE: AuditEvent[] = [
  { id: 'a-1', type: 'user', timestamp: '10:24:00', title: '用户提问', detail: '把 HT-2024 的执行状态给我。' },
  { id: 'a-2', type: 'tool', timestamp: '10:24:01', title: '调用 query_contract', detail: '参数: contractNo=HT-2024', meta: '返回: 合同状态 执行中 · 耗时 180ms' },
  { id: 'a-3', type: 'tool', timestamp: '10:24:02', title: '调用 query_orders', detail: '参数: contractNo=HT-2024', meta: '返回: 3 笔订单 · 耗时 320ms' },
  { id: 'a-4', type: 'tool', timestamp: '10:24:03', title: '调用 query_inventory', detail: '参数: contractNo=HT-2024', meta: '返回: 库存台账 3,500 吨 · 耗时 260ms' },
  { id: 'a-5', type: 'tool', timestamp: '10:24:04', title: '调用 cross_check', detail: '参数: contract=HT-2024,orders=3', meta: '返回: 第 3 笔订单缺发票号 · 耗时 140ms' },
  { id: 'a-6', type: 'system', timestamp: '10:24:05', title: 'AI 响应', detail: '合同 HT-2024 当前执行中，已发货 3,500 吨，待付款 1,500 吨。', meta: 'Token: 612 · 耗时: 1.1s' },
  { id: 'a-7', type: 'user', timestamp: '10:25:00', title: '用户发起计划', detail: '帮我发起本月对账。' },
  { id: 'a-8', type: 'tool', timestamp: '10:25:02', title: '调用 plan_reconciliation', detail: '参数: contractNo=HT-2024,month=2024-08', meta: '返回: 5 步计划 · 耗时 420ms' },
  { id: 'a-9', type: 'system', timestamp: '10:25:06', title: 'AI 生成计划', detail: '已为您制定本月对账执行计划。', meta: 'Token: 498 · 耗时: 0.9s' },
  { id: 'a-10', type: 'user', timestamp: '10:28:00', title: '用户确认执行', detail: '确认执行。' },
  { id: 'a-11', type: 'tool', timestamp: '10:28:02', title: '调用 fetch_shipment', detail: '参数: contractNo=HT-2024,month=2024-08', meta: '返回: 账面 4,980 吨 · 耗时 420ms' },
  { id: 'a-12', type: 'tool', timestamp: '10:28:03', title: '调用 fetch_buyer_receipt', detail: '参数: buyer=华盛炼化,month=2024-08', meta: '返回: 回执 4,950 吨 · 耗时 380ms' },
  { id: 'a-13', type: 'tool', timestamp: '10:28:04', title: '调用 calc_variance', detail: '参数: threshold=0.5%', meta: '返回: 差异 30 吨(0.6%) · 耗时 260ms' },
  { id: 'a-14', type: 'system', timestamp: '10:28:05', title: 'AI 暂停并请求确认', detail: '对账执行到第 3 步时暂停，需要您确认差异处理方式。', meta: 'Token: 356 · 耗时: 0.8s' },
  { id: 'a-15', type: 'user', timestamp: '10:31:00', title: '用户确认差异', detail: '按对方回执发出（我方留备忘）。另外把今天的提单挂上去。' },
  { id: 'a-16', type: 'tool', timestamp: '10:31:02', title: '调用 ocr_mineru', detail: '参数: file=BL-20240815-001.pdf', meta: '返回: 12 个字段 · 耗时 760ms' },
  { id: 'a-17', type: 'tool', timestamp: '10:31:04', title: '调用 field_confidence', detail: '参数: docType=BL', meta: '返回: 数量置信度 0.61 · 耗时 220ms' },
  { id: 'a-18', type: 'tool', timestamp: '10:31:05', title: '调用 match_contract', detail: '参数: contractNo=HT-2024', meta: '返回: 匹配成功 · 耗时 180ms' },
  { id: 'a-19', type: 'system', timestamp: '10:31:06', title: 'AI 字段核验', detail: '已切换至执行模式，正在对提单 BL-20240815-001 进行 OCR 字段核验。', meta: 'Token: 412 · 耗时: 1.0s' },
  { id: 'a-20', type: 'user', timestamp: '10:31:30', title: '用户确认字段', detail: '确认数量为 4950 吨。' },
  { id: 'a-21', type: 'system', timestamp: '10:31:32', title: '系统写入', detail: '合同 HT-2024 挂接提单 BL-20240815-001（已核验）。', actor: 'AI 助手' },
  { id: 'a-22', type: 'user', timestamp: '10:35:00', title: '用户发起付款', detail: '对账草稿确认了，发起尾款付款申请。' },
  { id: 'a-23', type: 'approval', timestamp: '10:35:02', title: '审批门触发', detail: '检测到高风险写操作，已触发硬审批门。', actor: '风控中心' },
  { id: 'a-24', type: 'tool', timestamp: '10:35:03', title: '调用 risk_check', detail: '参数: contractNo=HT-2024,amount=10800000', meta: '返回: 账户末位不一致 · 耗时 340ms' },
  { id: 'a-25', type: 'user', timestamp: '10:36:00', title: '用户提交审批', detail: '提交审批。' },
  { id: 'a-26', type: 'approval', timestamp: '10:38:00', title: '审批通过', detail: '审批通过（李芳，附注：账户已核实为新开户行）。', actor: '李芳' },
  { id: 'a-27', type: 'tool', timestamp: '10:38:02', title: '调用 create_payment', detail: '参数: contractNo=HT-2024,amount=10800000', meta: '返回: 付款单已创建 · 耗时 260ms' },
  { id: 'a-28', type: 'tool', timestamp: '10:38:03', title: '调用 record_fund_flow', detail: '参数: flowNo=FLOW-2024-0912', meta: '返回: 流水已记录 · 耗时 180ms' },
  { id: 'a-29', type: 'tool', timestamp: '10:38:04', title: '调用 notify_payer', detail: '参数: channel=email', meta: '返回: 通知已发送 · 耗时 140ms' },
  { id: 'a-30', type: 'tool', timestamp: '10:38:05', title: '调用 advance_contract_stage', detail: '参数: contractNo=HT-2024,to=付款', meta: '返回: 阶段已推进 · 耗时 100ms' },
  { id: 'a-31', type: 'system', timestamp: '10:38:06', title: 'AI 续跑完成', detail: '尾款 1,080 万元已发起，资金流水 FLOW-2024-0912 已记录。', meta: 'Token: 520 · 耗时: 1.2s' },
  { id: 'a-32', type: 'user', timestamp: '10:39:00', title: '用户归档', detail: '归档 HT-2024。' },
  { id: 'a-33', type: 'system', timestamp: '10:39:02', title: '系统归档', detail: '合同 HT-2024 已归档，项目生命周期推进至终态。', actor: '用户' },
]

export const buildAuditTimeline = (task: Task): AuditEvent[] => {
  if (task.title === '演示：对账 + 付款 HITL 全流程') return HITL_AUDIT_TIMELINE

  const events: AuditEvent[] = []
  const push = (e: AuditEvent) => events.push(e)
  let seq = 0
  const nextTime = () => {
    const base = new Date('2024-08-01T10:23:00')
    base.setSeconds(base.getSeconds() + seq)
    seq += 2
    return base.toLocaleTimeString('zh-CN', { hour12: false })
  }

  for (const msg of task.messages) {
    if (msg.sender === 'user') {
      push({ id: `${msg.id}-user`, type: 'user', timestamp: nextTime(), title: '用户提问', detail: msg.content })
    } else if (msg.sender === 'system') {
      push({ id: `${msg.id}-system`, type: 'system', timestamp: nextTime(), title: '系统通知', detail: msg.systemNote || msg.content })
    } else if (msg.sender === 'agent') {
      if (msg.approval) {
        push({ id: `${msg.id}-approval`, type: 'approval', timestamp: nextTime(), title: '审批触发', detail: msg.content, actor: '风控中心' })
      } else {
        push({ id: `${msg.id}-agent`, type: 'system', timestamp: nextTime(), title: 'AI 响应', detail: msg.content, meta: `Token: ${Math.floor(Math.random() * 500 + 400)} · 耗时: ${(Math.random() * 1 + 0.5).toFixed(1)}s` })
      }
    }

    if (msg.thinking) {
      for (const step of msg.thinking) {
        push({
          id: `${msg.id}-${step.id}`,
          type: 'tool',
          timestamp: nextTime(),
          title: `调用 ${step.tool}`,
          detail: `参数: ${step.params}`,
          meta: `耗时: ${step.duration}ms · 状态: ${step.status}`,
        })
      }
    }
  }

  if (task.changes) {
    for (const change of task.changes) {
      push({
        id: change.id,
        type: 'system',
        timestamp: change.timestamp || nextTime(),
        title: change.title,
        detail: change.description,
        actor: change.actor === 'agent' ? 'AI 助手' : '用户',
      })
    }
  }

  return events
}


export const MOCK_PROJECTS: Project[] = [
  {
    id: 'proj-ht2024',
    name: '合同 HT-2024 柴油采购',
    businessNo: 'HT-2024',
    businessType: 'contract',
    templateId: 'tpl-contract',
    status: '进行中',
    stage: 2,
    stages: ['签约', '履约', '发货', '结算', '付款', '归档'],
    updatedAt: '今天 10:23',
    role: 'trader',
    instructions: '本助手只引用合同管理系统、ERP 订单系统与财务资金系统的真实记录；所有付款与定价类写操作必须经人工确认后方可执行。',
    experts: [
      { name: '贸易履约专家', description: '跟踪合同执行、发货、收款与单据挂接' },
      { name: '对账结算专员', description: '自动核对 ERP 与财务资金流水差异' },
    ],
    skills: [
      { name: '合同条款抽取', description: '从合同 PDF 抽取关键字段并校验' },
      { name: '订单状态聚合', description: '汇总合同下全部订单与发货状态' },
      { name: '对账差异分析', description: '匹配订单、发票、收款并标记差异' },
      { name: '单据 OCR 绑定', description: '提单/发票自动识别并挂接到合同' },
    ],
    connectors: [
      { name: 'ERP-湖北国贸能源化工', authType: 'public', status: 'connected' },
      { name: '合同管理系统', authType: 'public', status: 'connected' },
      { name: '财务资金系统', authType: 'public', status: 'connected' },
      { name: 'OCR 识别服务', authType: 'personal', status: 'connected' },
    ],
    docLibrary: [
      { name: '合同 HT-2024.pdf', type: '合同', size: '1.2 MB' },
      { name: '订单 PO-202408.pdf', type: '订单', size: '0.8 MB' },
      { name: '提单 BL-20240815-001.pdf', type: '提单', size: '2.1 MB' },
      { name: '发票 FP-202408.pdf', type: '发票', size: '0.5 MB' },
    ],
    taskIds: ['tk1', 'tk2', 'tk3', 'tk4'],
  },
  {
    id: 'proj-risk-cu',
    name: '铜精矿点价套保',
    businessNo: 'SO-202407',
    businessType: 'risk',
    templateId: 'tpl-risk',
    status: '进行中',
    stage: 2,
    stages: ['建仓', '盯市', '预警', '平仓', '复盘'],
    updatedAt: '昨天 14:22',
    role: 'risk',
    instructions: '风控助手仅读取行情与敞口数据，点价与平仓建议需经风控审批；所有价格类数据以行情系统为准。',
    experts: [
      { name: '风险监控官', description: '实时监测敞口与价格预警' },
      { name: '套保策略师', description: '提供套保方案与平仓建议' },
    ],
    skills: [
      { name: '敞口测算', description: '实时计算净敞口与在险合同' },
      { name: '价格预警', description: '监控基差、LME/SHFE 波动' },
      { name: '套保方案生成', description: '按敞口生成对冲建议' },
    ],
    connectors: [
      { name: '行情系统', authType: 'public', status: 'connected' },
      { name: '风控中心', authType: 'public', status: 'connected' },
      { name: '期货交易系统', authType: 'personal', status: 'pending' },
    ],
    docLibrary: [
      { name: '铜精矿点价方案.docx', type: '方案', size: '0.4 MB' },
      { name: 'LME 铜价走势.xlsx', type: '行情', size: '1.5 MB' },
    ],
    taskIds: ['tk5'],
  },
  {
    id: 'proj-logistics-zjg',
    name: '张家港柴油库存管理',
    businessNo: 'WH-ZJG',
    businessType: 'logistics',
    templateId: 'tpl-logistics',
    status: '已完成',
    stage: 4,
    stages: ['入库', '在库', '提货', '出库', '结算'],
    updatedAt: '周三 11:05',
    role: 'trader',
    instructions: '物流数据以 WMS 仓储系统为准；出入库必须与合同/订单号绑定，确保货权清晰。',
    experts: [
      { name: '仓储调度员', description: '跟踪入库、出库与库存异动' },
      { name: '货权管理员', description: '校验货权转移与提单一致性' },
    ],
    skills: [
      { name: '库存盘点', description: '系统台账与实物盘点核对' },
      { name: '出入库绑定', description: '将出入库与合同/订单关联' },
      { name: '物流异常预警', description: '识别超期在库、在途停滞' },
    ],
    connectors: [
      { name: 'WMS-张家港仓库', authType: 'public', status: 'connected' },
      { name: 'WMS-连云港仓库', authType: 'public', status: 'connected' },
      { name: '物流跟踪平台', authType: 'public', status: 'connected' },
    ],
    docLibrary: [
      { name: '入库单 RK-20240801.pdf', type: '入库单', size: '0.6 MB' },
      { name: '盘点报告 PD-20240815.pdf', type: '盘点', size: '0.9 MB' },
    ],
    taskIds: ['tk6'],
  },
]
