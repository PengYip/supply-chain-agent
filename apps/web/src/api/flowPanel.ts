// 对账面板(spec 2026-09-09 §15)只读 API 客户端。类型与后端
// apps/server/src/pipeline/flowPanel.ts 的 DTO 镜像同构; 信封/错误处理对齐 api/ontology.ts。

export type FlowLane = 'goods' | 'title' | 'funds' | 'invoice';
export type MilestoneStatus = 'done' | 'ongoing' | 'pending' | 'abnormal';
export type FlowNode = '上游' | '在途' | '我方' | '下游';

export interface FlowPanelAmount { value: number; currency: string }

export interface FlowPanelBreakdownRow {
  label: string;
  quantity: { value: number; unit: string } | null;
  amount: FlowPanelAmount | null;
  date: string | null;
  evidenceIds: string[];
  documentId: string | null;
}

export interface FlowPanelMilestone {
  key: string;
  lane: FlowLane;
  node: FlowNode;
  label: string;
  status: MilestoneStatus;
  quantity: { value: number; unit: string } | null;
  amount: FlowPanelAmount | null;
  date: string | null;
  count: number;
  evidenceIds: string[];
  note: string | null;
  breakdown: FlowPanelBreakdownRow[];
}

export interface TitleTransferPoint {
  factId: string;
  direction: 'in' | 'out';
  caliber: string;
  at: string;
  quantity: { value: number; unit: string } | null;
  documentId: string | null;
}

export type FlowPanelAlertCode =
  | 'delivery-overdue' | 'draft-survey-tolerance' | 'invoice-funds-mismatch';

export interface FlowPanelAlert {
  code: FlowPanelAlertCode;
  level: 'warn' | 'info';
  message: string;
  evidenceIds: string[];
  milestoneKeys: string[];
}

export interface FlowPanelContractRef { contractNo: string; displayContractNo: string; title: string }

export interface FlowPanelDocRef { fileName: string; minioKey: string | null }

export interface FlowPanelResponse {
  contractNo: string;
  displayContractNo: string;
  contractTitle: string;
  /** 台账「金额」字段解析(款/票泳道总进度的分母); 解析不出为 null。 */
  contractAmount: number | null;
  asOf: string;
  basis: { quantity: number; unit: string } | null;
  progress: number | null;
  progressReason: string | null;
  goods: FlowPanelMilestone[];
  title: {
    currentHolder: '上游' | '我方' | '下游' | null;
    note: string | null;
    transferPoints: TitleTransferPoint[];
    milestones: FlowPanelMilestone[];
  };
  funds: FlowPanelMilestone[];
  invoice: FlowPanelMilestone[];
  alerts: FlowPanelAlert[];
  netPosition: {
    currencies: Array<{ currency: string; paid: number; received: number; netOccupancy: number }>;
    invoices: Array<{ currency: string; inAmount: number; outAmount: number }>;
  };
  correlates: FlowPanelContractRef[];
  documents: Record<string, FlowPanelDocRef>;
}

async function request<T>(url: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: 'include' });
  } catch {
    throw new Error('网络错误，请稍后重试');
  }
  if (!res.ok) {
    let message = `请求失败（${res.status}）`;
    try {
      const data = (await res.json()) as { error?: string; detail?: string };
      if (data?.error) message = data.detail ? `${data.error}：${data.detail}` : data.error;
    } catch { /* 非 JSON 响应，保留状态码消息 */ }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export function fetchFlowPanel(contractNo: string): Promise<FlowPanelResponse> {
  return request<FlowPanelResponse>(`/api/contracts/${encodeURIComponent(contractNo)}/flow-panel`);
}
