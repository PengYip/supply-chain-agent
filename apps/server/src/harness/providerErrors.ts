// Provider-level run-error classification for background runs. runManager
// calls classifyProviderError on a failed run and attaches the verdict to the
// run.error SSE event (code + user-facing message). The only verdict today is
// 'provider_arrears': DeepSeek returns HTTP 402 "Insufficient Balance"
// (AI SDK APICallError exposes statusCode/responseBody), while Qwen/DashScope
// OpenAI-compatible endpoints answer with an "Arrearage" error code or quota
// wording in the body. Extend with new codes here as new cases appear.

export interface ProviderErrorInfo {
  code: 'provider_arrears' | null;
  userMessage: string | null;
}

const ARREARS_RE = /insufficient balance|arrearage|欠费|余额不足|exceeded your current quota/i;
const ARREARS_USER_MESSAGE = 'AI 模型服务欠费，请联系管理员充值后重试。';

export function classifyProviderError(err: unknown): ProviderErrorInfo {
  const e = err as
    | { message?: string; statusCode?: number; status?: number; responseBody?: string }
    | undefined;
  const message = typeof e?.message === 'string' ? e.message : String(err ?? '');
  const body = typeof e?.responseBody === 'string' ? e.responseBody : '';
  const status = e?.statusCode ?? e?.status;
  if (status === 402 || ARREARS_RE.test(message) || ARREARS_RE.test(body)) {
    return { code: 'provider_arrears', userMessage: ARREARS_USER_MESSAGE };
  }
  return { code: null, userMessage: null };
}
