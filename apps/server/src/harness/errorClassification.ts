/**
 * Retryable-error classification table (book Ch5:184 "先分类再计数" + Ch5:196
 * "把错误变成模型的输入"). Maps a thrown tool error to a {retryable, category}
 * verdict so the model can decide whether to retry (retryable=true: transient —
 * timeout, network, overload) or change strategy (retryable=false: the same call
 * will fail identically — bad args, permission, not-found, business logic).
 *
 * Retryable categories: timeout, network (ECONNRESET/ETIMEDOUT/ENOTFOUND/fetch),
 * overload (429/503), transient provider/store errors.
 * Non-retryable: invalid_args (zod/schema), permission (403/auth), not_found,
 * unknown (conservative default — don't amplify a mystery error with retries).
 */
export type ErrorCategory =
  | 'timeout' | 'network' | 'overload'
  | 'invalid_args' | 'permission' | 'not_found' | 'unknown';

export interface ClassifiedError {
  retryable: boolean;
  category: ErrorCategory;
  message: string;
}

const NETWORK_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'UND_ERR_SOCKET', 'FetchError']);
const TIMEOUT_RE = /timed? ?out|timeout|ETIMEDOUT/i;
const OVERLOAD_RE = /429|too many requests|rate limit|overload|503|service unavailable|capacity/i;
const PERM_RE = /forbidden|403|unauthorized|401|not allowed|permission/i;
const NOTFOUND_RE = /not found|404|no such|does not exist|unknown/i;
const ZOD_NAMES = new Set(['ZodError', 'ValidationError']);

export function classifyToolError(err: unknown): ClassifiedError {
  const e = err as { message?: string; code?: string | number; status?: number; name?: string } | undefined;
  const message = (e?.message ?? String(err)).slice(0, 500);
  const code = e?.code;
  const status = e?.status;
  const name = e?.name ?? '';

  // 1. Explicit network error codes.
  if (typeof code === 'string' && NETWORK_CODES.has(code)) {
    return { retryable: true, category: 'network', message };
  }
  // 2. Timeout (message-based; our tool_timeout result is produced in withAudit,
  //    but native fetch/neo4j timeouts surface as thrown errors too).
  if (TIMEOUT_RE.test(message) || code === 'ETIMEDOUT') {
    return { retryable: true, category: 'timeout', message };
  }
  // 3. Overload / rate-limit (status or message).
  if (status === 429 || status === 503 || OVERLOAD_RE.test(message)) {
    return { retryable: true, category: 'overload', message };
  }
  // 4. Invalid args (schema/zod).
  if (ZOD_NAMES.has(name) || /invalid (input|args|params)|expected .+ received|validation failed/i.test(message)) {
    return { retryable: false, category: 'invalid_args', message };
  }
  // 5. Permission.
  if (status === 403 || status === 401 || PERM_RE.test(message)) {
    return { retryable: false, category: 'permission', message };
  }
  // 6. Not found.
  if (status === 404 || NOTFOUND_RE.test(message)) {
    return { retryable: false, category: 'not_found', message };
  }
  // 7. Conservative default: non-retryable (don't amplify a mystery error).
  return { retryable: false, category: 'unknown', message };
}
