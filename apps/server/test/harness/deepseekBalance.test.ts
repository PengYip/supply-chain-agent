import { describe, it, expect, vi } from 'vitest';
import { fetchDeepseekBalance, formatDeepseekBalance } from '../../src/harness/deepseekBalance.js';

const OK_BODY = {
  is_available: true,
  balance_infos: [{ currency: 'CNY', total_balance: '110.00' }],
};

describe('fetchDeepseekBalance (mocked fetch, fault-isolated)', () => {
  it('200 -> balance parsed; trailing slash in base URL normalized', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(OK_BODY), { status: 200 }));
    const b = await fetchDeepseekBalance({ baseUrl: 'https://api.deepseek.com/', apiKey: 'k', fetchImpl });
    expect(b).toEqual({ available: true, currency: 'CNY', totalBalance: '110.00' });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.deepseek.com/user/balance',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('is_available=false -> available:false (amounts still surfaced)', async () => {
    const body = { is_available: false, balance_infos: [{ currency: 'CNY', total_balance: '0.00' }] };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
    const b = await fetchDeepseekBalance({ baseUrl: 'https://api.deepseek.com', apiKey: 'k', fetchImpl });
    expect(b).toEqual({ available: false, currency: 'CNY', totalBalance: '0.00' });
  });

  it('401 (CI dummy key) -> null, skip quietly', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"error":"unauthorized"}', { status: 401 }));
    const b = await fetchDeepseekBalance({ baseUrl: 'https://api.deepseek.com', apiKey: 'ci-dummy-key', fetchImpl });
    expect(b).toBeNull();
  });

  it('404 -> null, skip quietly', async () => {
    const fetchImpl = vi.fn(async () => new Response('not found', { status: 404 }));
    const b = await fetchDeepseekBalance({ baseUrl: 'https://api.deepseek.com', apiKey: 'k', fetchImpl });
    expect(b).toBeNull();
  });

  it('network rejection -> null (never throws)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const b = await fetchDeepseekBalance({ baseUrl: 'https://api.deepseek.com', apiKey: 'k', fetchImpl });
    expect(b).toBeNull();
  });

  it('timeout (abort signal fires) -> null', async () => {
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('This operation was aborted')));
        }),
    );
    const b = await fetchDeepseekBalance({
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'k',
      timeoutMs: 20,
      fetchImpl,
    });
    expect(b).toBeNull();
  });

  it('malformed JSON body (200) -> null', async () => {
    const fetchImpl = vi.fn(async () => new Response('{{{not json', { status: 200 }));
    const b = await fetchDeepseekBalance({ baseUrl: 'https://api.deepseek.com', apiKey: 'k', fetchImpl });
    expect(b).toBeNull();
  });

  it('non-DeepSeek base URL -> null and fetch never called (silent skip)', async () => {
    const fetchImpl = vi.fn();
    const b = await fetchDeepseekBalance({
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKey: 'k',
      fetchImpl,
    });
    expect(b).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('formatDeepseekBalance', () => {
  it('renders the boot/diagnostic line fragment', () => {
    expect(formatDeepseekBalance({ available: true, currency: 'CNY', totalBalance: '110.00' })).toBe(
      '可用=true, CNY 总额=110.00',
    );
    expect(formatDeepseekBalance({ available: false, currency: null, totalBalance: null })).toBe('可用=false');
  });
});
