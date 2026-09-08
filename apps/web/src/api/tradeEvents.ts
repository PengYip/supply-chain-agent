// 事件登记表单入口 API（对话外的第二个客户端）：字段清单/枚举值全部来自服务端
// GET /api/trade-events/schema（create_trade_event inputSchema 反射投影），
// 提交走 POST /api/trade-events（后台会话 -> L2 审批 -> 唯一写入边界）。
export interface TradeEventFormField {
  name: string;
  kind: 'string' | 'number' | 'enum';
  required: boolean;
  widget?: 'date';
  options?: readonly string[];
  description: string;
  formDefault?: unknown;
}

export interface TradeEventFormSchema {
  tool: string;
  fields: TradeEventFormField[];
}

export interface TradeEventSubmitResult {
  ticketId: string;
  sessionId: string;
  runId: string;
  status: string;
}

/** 字段级校验错误（服务端 fieldLevelErrors 投影）。 */
export interface TradeEventFieldErrors {
  formErrors: string[];
  fieldErrors: Record<string, string[]>;
}

export class TradeEventValidationError extends Error {
  readonly detail: TradeEventFieldErrors;
  constructor(detail: TradeEventFieldErrors) {
    super('校验失败，请检查标红字段');
    this.detail = detail;
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: 'include', ...init });
  } catch {
    throw new Error('网络错误，请稍后重试');
  }
  if (!res.ok) {
    let message = `请求失败（${res.status}）`;
    try {
      const data = (await res.json()) as {
        error?: string;
        detail?: TradeEventFieldErrors | string;
      };
      if (data?.error === 'invalid_body' || data?.error === 'invalid_event') {
        const detail = (data.detail ?? { formErrors: [], fieldErrors: {} }) as TradeEventFieldErrors;
        throw new TradeEventValidationError({
          formErrors: detail.formErrors ?? [],
          fieldErrors: detail.fieldErrors ?? {},
        });
      }
      if (data?.error) {
        message = typeof data.detail === 'string' ? `${data.error}：${data.detail}` : data.error;
      }
    } catch (e) {
      if (e instanceof TradeEventValidationError) throw e;
      /* 非 JSON 响应，保留状态码消息 */
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export function fetchTradeEventFormSchema(): Promise<TradeEventFormSchema> {
  return request<TradeEventFormSchema>('/api/trade-events/schema');
}

export function submitTradeEvent(
  input: Record<string, string | number>,
): Promise<TradeEventSubmitResult> {
  return request<TradeEventSubmitResult>('/api/trade-events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}
