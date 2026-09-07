// apps/web/src/api/overview.ts
// 总览工作台数据源（roadmap Item 7）：GET /api/overview 聚合载荷。

export type CardResult<T> = { status: 'ok'; data: T } | { status: 'error'; error: string };

export interface OverReceiptAnomalyDTO {
  contractId: string; contractNo: string; contractQty: number; receivedQty: number;
}
export interface PaymentBlockRecordDTO {
  id: string; ticketId: string | null; reason: string | null; createdAt: string;
}

export interface OverviewCardsDTO {
  pendingApprovals: CardResult<{ count: number }>;
  overReceipt: CardResult<{ anomalies: OverReceiptAnomalyDTO[]; scannedContracts: number }>;
  paymentBlocks: CardResult<{ records: PaymentBlockRecordDTO[]; scanLimit: number }>;
  executionRate: CardResult<{ total: number; executed: number; rate: number | null }>;
  pendingWriteoff: CardResult<{ amount: number; rows: number }>;
}

export interface OverviewPayloadDTO {
  source: 'local' | 'cube';
  asOf: string;
  note: string | null;
  cards: OverviewCardsDTO | null;
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

export function fetchOverview(): Promise<OverviewPayloadDTO> {
  return request<OverviewPayloadDTO>('/api/overview');
}
