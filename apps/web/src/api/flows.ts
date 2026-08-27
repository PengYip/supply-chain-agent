/** 执行流水(四流合一)只读 API 客户端。信封/错误处理对齐 api/review.ts。 */

export type FlowType = '资金流' | '货物流' | '发票流'

export type FlowDirection = 'in' | 'out'

/** 六向汇总: 按 flowType x direction 分组。totalMassKg 为服务端扩展字段(旧后端不带)。 */
export interface FlowSummary {
  contractNo: string
  flowType: FlowType
  direction: FlowDirection
  entryCount: number
  totalAmount: number | null
  totalQuantityTon: number | null
  totalMassKg?: number | null
  lastVoucherDate: string | null
}

/** 逐笔明细行, createdAt 升序。amount/quantityTon/unit/docType/voucherDate/extractionId 均可为 null。 */
export interface ExecutionFlowItem {
  id: string
  bindingId: string
  documentId: string
  contractNo: string
  flowType: FlowType
  direction: FlowDirection
  amount: number | null
  quantityTon: number | null
  unit: string | null
  docType: string | null
  voucherDate: string | null
  extractionId: string | null
  /** 溯源展示: 文档来源路径末段(未剥 uuid 前缀, 展示层用 prettyDocName 再加工)。 */
  documentFileName: string | null
  /** 溯源预览: MinIO 对象 key, 非空时可经 /api/files/stream 取流预览。 */
  documentMinioKey: string | null
  confidence: number
  createdBy: string
  userId: string
  createdAt: string
}

/** GET /api/bindings/flows 响应。selfPartiesConfigured 为后端扩展字段:
 *  生效主体名单非空时为 true; 旧后端不带该字段, 调用方按缺省 true 处理。 */
export interface ExecutionFlowsResponse {
  contractNo: string
  summaries: FlowSummary[]
  flows: ExecutionFlowItem[]
  selfPartiesConfigured?: boolean
}

/** 六向词汇映射(固定, 勿自造)。 */
const FLOW_LABEL_MAP: Record<string, string> = {
  '资金流-in': '收款',
  '资金流-out': '付款',
  '货物流-in': '收货',
  '货物流-out': '发货',
  '发票流-in': '收票',
  '发票流-out': '开票',
}

/** 六向词汇名; 未知组合返回 `${flowType}-${direction}` 原样。 */
export function flowDirectionLabel(flowType: FlowType, direction: FlowDirection): string {
  return FLOW_LABEL_MAP[`${flowType}-${direction}`] ?? `${flowType}-${direction}`
}

/** 金额展示: null -> '—', 否则千分位。 */
export function formatFlowAmount(n: number | null): string {
  if (n === null) return '—'
  return n.toLocaleString('zh-CN')
}

/** 数量展示: n 为 null -> '—'; unit 非空则数字后拼 unit(如 50,000吨), 否则只数字。 */
export function formatFlowQuantity(n: number | null, unit: string | null): string {
  if (n === null) return '—'
  const num = n.toLocaleString('zh-CN')
  return unit ? `${num}${unit}` : num
}

/** null/空串 -> '—', 其余原样。 */
export function flowText(v: string | null): string {
  return v == null || v === '' ? '—' : v
}

/** 取这组 flows 中 quantityTon 非 null 的行的 unit 去重; 恰好一个不同值则返回它, 否则(多个或全 null)返回 null。 */
export function pickRepresentativeUnit(flows: ExecutionFlowItem[]): string | null {
  const units = new Set<string | null>()
  for (const f of flows) {
    if (f.quantityTon !== null) units.add(f.unit ?? null)
  }
  if (units.size !== 1) return null
  const only = [...units][0]
  return only == null || only === '' ? null : only
}

/** 六向固定排序: 收款/付款/收货/发货/收票/开票。返回新数组, 不改入参。 */
const SUMMARY_ORDER: Record<string, number> = {
  '资金流-in': 0,
  '资金流-out': 1,
  '货物流-in': 2,
  '货物流-out': 3,
  '发票流-in': 4,
  '发票流-out': 5,
}

export function sortFlowSummaries(summaries: FlowSummary[]): FlowSummary[] {
  return [...summaries].sort((a, b) => {
    const ka = `${a.flowType}-${a.direction}`
    const kb = `${b.flowType}-${b.direction}`
    return (SUMMARY_ORDER[ka] ?? 99) - (SUMMARY_ORDER[kb] ?? 99)
  })
}

/** GET /api/bindings/flows?contractNo=xxx。Cookie 同源鉴权。网络/非 2xx/畸形 JSON 均抛中文 Error。 */
export async function fetchExecutionFlows(contractNo: string): Promise<ExecutionFlowsResponse> {
  let res: Response
  try {
    res = await fetch(`/api/bindings/flows?contractNo=${encodeURIComponent(contractNo)}`, {
      credentials: 'include',
    })
  } catch {
    throw new Error('网络错误，请稍后重试')
  }

  if (!res.ok) {
    let message = `请求失败（${res.status}）`
    try {
      const data = (await res.json()) as { ok?: unknown; error?: unknown }
      if (data && data.ok === false && typeof data.error === 'string' && data.error) {
        message = data.error
      }
    } catch {
      /* response wasn't JSON — keep the status-based message */
    }
    throw new Error(message)
  }

  let data: unknown
  try {
    data = await res.json()
  } catch {
    throw new Error('响应格式异常')
  }
  const envelope = data as ExecutionFlowsResponse
  if (
    !envelope ||
    typeof envelope !== 'object' ||
    Array.isArray(envelope) ||
    typeof envelope.contractNo !== 'string' ||
    !Array.isArray(envelope.summaries) ||
    !Array.isArray(envelope.flows)
  ) {
    throw new Error('响应格式异常')
  }
  return envelope
}

/** GET /api/bindings/contracts 的台账行(报表页合同下拉用)。 */
export interface FlowContractOption {
  contractNo: string
  displayContractNo: string | null
  docType: string | null
  title: string | null
}

/** GET /api/bindings/contracts。响应信封 { contracts: [...] }, 逐项防御性规整(非对象项/缺 contractNo 跳过)。 */
export async function fetchFlowContracts(): Promise<FlowContractOption[]> {
  let res: Response
  try {
    res = await fetch('/api/bindings/contracts', {
      credentials: 'include',
    })
  } catch {
    throw new Error('网络错误，请稍后重试')
  }

  if (!res.ok) {
    let message = `请求失败（${res.status}）`
    try {
      const data = (await res.json()) as { ok?: unknown; error?: unknown }
      if (data && data.ok === false && typeof data.error === 'string' && data.error) {
        message = data.error
      }
    } catch {
      /* response wasn't JSON — keep the status-based message */
    }
    throw new Error(message)
  }

  let data: unknown
  try {
    data = await res.json()
  } catch {
    throw new Error('响应格式异常')
  }
  const envelope = data as { contracts?: unknown }
  const rawList =
    envelope && typeof envelope === 'object' && !Array.isArray(envelope) && Array.isArray(envelope.contracts)
      ? envelope.contracts
      : []
  const rows: FlowContractOption[] = []
  for (const raw of rawList) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const r = raw as Record<string, unknown>
    const contractNo = typeof r.contractNo === 'string' ? r.contractNo : ''
    if (!contractNo) continue
    const displayNo = typeof r.displayContractNo === 'string' ? r.displayContractNo : ''
    const docType = typeof r.docType === 'string' ? r.docType : ''
    const title = typeof r.title === 'string' ? r.title : ''
    rows.push({
      contractNo,
      displayContractNo: displayNo || contractNo,
      docType: docType || null,
      title: title || null,
    })
  }
  return rows
}
