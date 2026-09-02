// Provider-level run-error classification — DUAL-PROVIDER table (2026-09-02):
// the chat LLM is DeepSeek (dev) and the VLM (batch-split detection / voucher
// extraction / form classification) is bailian Qwen (dev AND prod), both via
// env-switched base URLs. Consumers:
//  - runManager: attaches the verdict to the run.error SSE event (code + label)
//  - runSession: describeStreamError audit tag + closing-text label
//  - pipeline VLM call sites (batch-split detect / voucher extraction / form
//    classify): classified warn lines BEFORE existing fallback branches
//    (pipeline -> harness imports are established: parseDocument/usageAudit).
// Matching covers BOTH HTTP status codes (DeepSeek semantics) AND bailian
// OpenAI-compatible body error codes: bailian errors arrive as JSON
// `{"error":{"code":"...","message":"..."}}` inside APICallError.responseBody;
// the AI SDK may additionally surface the code as `error.code`. Parsing is
// DEFENSIVE: malformed/missing bodies fall back to raw-substring matching and
// this function never throws.

export type ProviderErrorCode =
  | 'provider_arrears'         // DeepSeek 402 / bailian Arrearage | isv.OUT_OF_SERVICE
  | 'provider_quota'           // bailian 免费额度/账单: AllocationQuota family / *BillOverdue / insufficient_quota
  | 'provider_rate_limit'      // 429 / Throttling.RateQuota | BurstRate | Concurrency
  | 'provider_auth'            // 401 / invalid_api_key | InvalidApiKey
  | 'provider_model'           // model_not_found / "Model not exist" / "The product is not activated"
  | 'provider_content_blocked' // DataInspectionFailed / "inappropriate content" (绿网拦截)
  | 'provider_server'          // RequestTimeOut | ModelUnavailable | InternalError / 500 / 503
  | 'provider_bad_request';    // 400 / 422 请求格式或参数错误

export interface ProviderErrorInfo {
  code: ProviderErrorCode | null;
  /** User-facing actionable Chinese sentence (closing text / run.error label). */
  userMessage: string | null;
  /** Concise tag for warn lines, e.g. `[batch-split] VLM 调用失败(欠费), 回落整本解析`. */
  shortLabel: string | null;
}

const LABELS: Record<ProviderErrorCode, { userMessage: string; shortLabel: string }> = {
  provider_arrears: {
    userMessage: 'AI 模型服务欠费，请联系管理员充值后重试。',
    shortLabel: '欠费',
  },
  provider_quota: {
    userMessage: 'AI 模型服务免费额度已用尽或账单逾期，请联系管理员处理。',
    shortLabel: '额度/账单问题',
  },
  provider_rate_limit: {
    userMessage: 'AI 模型服务限流中(请求过于频繁)，请稍后重试。',
    shortLabel: '限流',
  },
  provider_auth: {
    userMessage: 'AI 模型服务认证失败，请联系管理员检查 API Key 配置。',
    shortLabel: '认证失败',
  },
  provider_model: {
    userMessage: 'AI 模型不存在或未开通，请联系管理员检查模型配置。',
    shortLabel: '模型不存在或未开通',
  },
  provider_content_blocked: {
    userMessage: 'AI 模型服务内容安全拦截：请调整输入内容后重试。',
    shortLabel: '内容安全拦截',
  },
  provider_server: {
    userMessage: 'AI 模型服务端异常(服务器故障或繁忙)，请稍后重试。',
    shortLabel: '服务端异常',
  },
  provider_bad_request: {
    userMessage: 'AI 模型服务拒绝了请求(格式或参数错误)，请联系管理员检查配置。',
    shortLabel: '格式或参数错误',
  },
};

// bailian/DashScope string codes + key message substrings (case-insensitive;
// rules are matched against code+message+body so the code may arrive via any
// of them). Order = precedence: the most specific/fatal verdict wins.
const RULES: Array<{ code: ProviderErrorCode; re: RegExp }> = [
  {
    // Arrearage / out-of-service are bailian's arrears family; the OpenAI
    // "exceeded your current quota" wording was classified arrears before the
    // dual table and keeps that verdict.
    code: 'provider_arrears',
    re: /arrearage|isv\.out_of_service|insufficient balance|余额不足|欠费|exceeded your current quota/i,
  },
  {
    // Content-safety (绿网) must win over generic status mapping: bailian
    // answers 400 with DataInspectionFailed.
    code: 'provider_content_blocked',
    re: /data_inspection_failed|datainspectionfailed|inappropriate content|内容安全/i,
  },
  {
    code: 'provider_model',
    re: /model_not_found|model not exist|the product is not activated|模型不存在|模型未开通/i,
  },
  {
    code: 'provider_quota',
    re: /throttling\.allocationquota|allocationquota\.freetieronly|insufficient_quota|prepaidbilloverdue|postpaidbilloverdue/i,
  },
  {
    code: 'provider_rate_limit',
    re: /throttling\.ratequota|throttling\.burstrate|throttling\.concurrency|too many requests|rate limit|速率上限|限流/i,
  },
  {
    code: 'provider_auth',
    re: /invalid[_ ]?api[_ ]?key|invalidapikey|unauthorized|认证失败|api ?key ?无效/i,
  },
  {
    code: 'provider_server',
    re: /requesttimeout|modelunavailable|internalerror|internal server error|service unavailable|服务器繁忙|服务端异常/i,
  },
];

// DeepSeek status-code semantics (bailian answers share the same HTTP layer,
// so the same mapping applies when no string code matched). 500/503 share one
// verdict: without provider context a bare 503 cannot be told apart between
// "DeepSeek 服务器繁忙" and "bailian 服务端异常", and both are actionable as
// "server-side trouble, retry later".
const STATUS_CODES: Partial<Record<number, ProviderErrorCode>> = {
  400: 'provider_bad_request',
  401: 'provider_auth',
  402: 'provider_arrears',
  422: 'provider_bad_request',
  429: 'provider_rate_limit',
  500: 'provider_server',
  503: 'provider_server',
};

export function classifyProviderError(err: unknown): ProviderErrorInfo {
  const e = err as
    | {
        message?: string;
        code?: unknown;
        statusCode?: number;
        status?: number;
        responseBody?: string;
      }
    | undefined;
  const message = typeof e?.message === 'string' ? e.message : String(err ?? '');
  const body = typeof e?.responseBody === 'string' ? e.responseBody : '';
  // Defensive body parse (never throws): {"error":{"code","message"}}.
  let bodyCode = '';
  let bodyMessage = '';
  if (body !== '') {
    try {
      const parsed = JSON.parse(body) as { error?: { code?: unknown; message?: unknown } };
      if (typeof parsed?.error?.code === 'string') bodyCode = parsed.error.code;
      if (typeof parsed?.error?.message === 'string') bodyMessage = parsed.error.message;
    } catch {
      // Not JSON — the raw-body substring pass below still applies.
    }
  }
  // AI SDK may surface the provider code directly as error.code.
  const directCode = typeof e?.code === 'string' ? e.code : '';
  const haystack = `${directCode}\n${bodyCode}\n${bodyMessage}\n${message}\n${body}`;
  for (const rule of RULES) {
    if (rule.re.test(haystack)) return { code: rule.code, ...LABELS[rule.code] };
  }
  const status = e?.statusCode ?? e?.status;
  const byStatus = typeof status === 'number' ? STATUS_CODES[status] : undefined;
  if (byStatus) return { code: byStatus, ...LABELS[byStatus] };
  return { code: null, userMessage: null, shortLabel: null };
}
