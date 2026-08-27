/** 项目维度工作台 API 客户端(只读 + 指派/确认/拒绝)。信封/错误处理对齐 api/review.ts。 */

/** GET /api/projects 列表行: ProjectRow + 归属计数。 */
export interface ProjectSummary {
  code: string
  name: string
  status: string
  userId: string | null
  createdAt: string
  updatedAt: string
  membershipCount: number
  proposedCount: number
}

/** 归属行(与 server ProjectMembershipRow 一致)。 */
export interface ProjectMembership {
  id: string
  contractNo: string
  projectCode: string
  role: string | null
  status: 'proposed' | 'confirmed' | 'rejected'
  proposedBy: string
  confirmationSource: string | null
  confidence: number
  createdBy: string
  userId: string | null
  createdAt: string
  graphStatus: { status: string; reason?: string; syncedAt?: string } | null
}

/** 每合同执行块(与 server ContractExecution 一致; progress 结构见 lib/executionProgress)。 */
export interface ContractExecutionView {
  summaries: Array<{
    contractNo: string
    flowType: string
    direction: 'in' | 'out'
    entryCount: number
    totalAmount: number | null
    totalQuantityTon: number | null
    totalMassKg?: number | null
    lastVoucherDate: string | null
  }>
  progress: import('../lib/executionProgress').ExecutionProgressView
  flowCount: number
}

/** GET /api/projects/:code/rollup 响应(与 server ProjectRollup 一致)。 */
export interface ProjectRollupResp {
  project: { code: string; name: string }
  contracts: Array<{
    contractNo: string
    displayContractNo: string
    role: string
    title: string | null
    amount: number | null
    currency: string | null
    counterparty: string | null
    execution: ContractExecutionView
  }>
  pendingMemberships: Array<{ contractNo: string; role: string | null }>
  flows: {
    资金流: { in: number; out: number }
    发票流: { in: number; out: number }
    货物流: { inTon: number; outTon: number }
  }
  metrics: {
    salesAmount: number
    purchaseAmount: number
    expenseAmount: number
    grossMargin: number
    receivableOpen: number
    payableOpen: number
  }
  checks: Array<{ level: 'warn' | 'info'; code: string; message: string }>
}

/** 服务端错误码 -> 中文文案。 */
const PROJECT_ERROR_TEXT: Record<string, string> = {
  project_exists: '项目编号已存在',
  project_not_found: '项目不存在',
  invalid_body: '请求参数错误',
  invalid_role: '合同类型不合法',
  invalid_contract_no: '合同号无效',
  membership_not_found: '归属记录不存在',
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, { credentials: 'include', ...init })
  } catch {
    throw new Error('网络错误，请稍后重试')
  }
  if (!res.ok) {
    let message = `请求失败（${res.status}）`
    try {
      const data = (await res.json()) as { error?: string }
      if (data?.error && PROJECT_ERROR_TEXT[data.error]) message = PROJECT_ERROR_TEXT[data.error]
      else if (data?.error) message = data.error
    } catch {
      /* 非 JSON 响应，保留状态码消息 */
    }
    throw new Error(message)
  }
  try {
    return (await res.json()) as T
  } catch {
    throw new Error('响应格式异常')
  }
}

function postJson<T>(url: string, body: unknown): Promise<T> {
  return request<T>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const data = await request<{ projects: ProjectSummary[] }>('/api/projects')
  return Array.isArray(data?.projects) ? data.projects : []
}

export async function createProject(code: string, name: string): Promise<ProjectSummary> {
  const data = await postJson<{ project: ProjectSummary }>('/api/projects', { code, name })
  return data.project
}

export async function listMemberships(code: string): Promise<ProjectMembership[]> {
  const data = await request<{ memberships: ProjectMembership[] }>(
    `/api/projects/${encodeURIComponent(code)}/memberships`,
  )
  return Array.isArray(data?.memberships) ? data.memberships : []
}

export async function assignMembership(
  code: string,
  body: { contractNo: string; role?: string; confidence?: number },
): Promise<{ membership: ProjectMembership | null }> {
  return postJson(`/api/projects/${encodeURIComponent(code)}/memberships`, body)
}

export async function confirmMembership(id: string): Promise<{ membership: ProjectMembership | null }> {
  return postJson(`/api/projects/memberships/${encodeURIComponent(id)}/confirm`, {})
}

export async function rejectMembership(id: string): Promise<{ membership: ProjectMembership | null }> {
  return postJson(`/api/projects/memberships/${encodeURIComponent(id)}/reject`, {})
}

export async function fetchProjectRollup(code: string): Promise<ProjectRollupResp> {
  const data = await request<{ rollup: ProjectRollupResp }>(
    `/api/projects/${encodeURIComponent(code)}/rollup`,
  )
  return data.rollup
}
