// DeepSeek account balance probe (dual-provider error work, 2026-09-02).
// Endpoint: GET {OPENAI_BASE_URL}/user/balance with the chat API key. Response
// shape: { is_available: boolean, balance_infos: [{ currency, total_balance, }] }.
//
// Fault-isolated by contract: ANY failure resolves null and callers skip
// quietly — non-DeepSeek base URL (the endpoint is DeepSeek-specific; other
// OpenAI-compatible gateways 404 it), network error, ~5s timeout, non-200
// (incl. 401 for CI's dummy key and 404), malformed body. Call sites:
//  - index.ts boot: log the balance / warn loudly on is_available=false
//  - runSession: fire-and-forget re-check when a chat error classifies as
//    provider_arrears, so pm2 logs show the actual balance next to the error.

import { env } from '../env.js';

export interface DeepseekBalance {
  /** DeepSeek is_available: false means calls will fail (arrears/suspended). */
  available: boolean;
  /** e.g. 'CNY'. Null when the response omits balance_infos. */
  currency: string | null;
  /** e.g. '110.00'. String as returned by the API (do not parseFloat for display). */
  totalBalance: string | null;
}

const DEFAULT_TIMEOUT_MS = 5000;

export async function fetchDeepseekBalance(
  opts: {
    baseUrl?: string;
    apiKey?: string;
    timeoutMs?: number;
    /** Test seam. Defaults to global fetch. */
    fetchImpl?: typeof fetch;
  } = {},
): Promise<DeepseekBalance | null> {
  const baseUrl = opts.baseUrl ?? env.OPENAI_BASE_URL;
  const apiKey = opts.apiKey ?? env.OPENAI_API_KEY;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    // Silent skip for non-DeepSeek chat providers (Qwen/gateways): probing
    // them would be pointless 404 noise.
    let host = '';
    try {
      host = new URL(baseUrl).hostname;
    } catch {
      return null;
    }
    if (!/deepseek/i.test(host)) return null;
    const res = await doFetch(`${baseUrl.replace(/\/+$/, '')}/user/balance`, {
      method: 'GET',
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    // 401 (CI dummy key) / 404 (gateway) / 5xx -> skip quietly.
    if (!res.ok) return null;
    const data = (await res.json()) as {
      is_available?: boolean;
      balance_infos?: Array<{ currency?: string; total_balance?: string }>;
    };
    const info = Array.isArray(data.balance_infos) ? data.balance_infos[0] : undefined;
    return {
      available: data.is_available === true,
      currency: typeof info?.currency === 'string' ? info.currency : null,
      totalBalance: typeof info?.total_balance === 'string' ? info.total_balance : null,
    };
  } catch {
    // Network error / abort (timeout) / malformed JSON -> skip quietly.
    return null;
  }
}

/** Formats one log line fragment, e.g. `可用=true, CNY 总额=110.00`. */
export function formatDeepseekBalance(b: DeepseekBalance): string {
  const amount = b.currency ? `, ${b.currency} 总额=${b.totalBalance ?? '?'}` : '';
  return `可用=${b.available}${amount}`;
}
