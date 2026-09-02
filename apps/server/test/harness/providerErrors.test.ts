import { describe, it, expect } from 'vitest';
import { classifyProviderError } from '../../src/harness/providerErrors.js';

describe('classifyProviderError', () => {
  it('DeepSeek-style 402 APICallError hits provider_arrears', () => {
    const e = new Error('Insufficient Balance') as any;
    e.name = 'APICallError';
    e.statusCode = 402;
    const r = classifyProviderError(e);
    expect(r.code).toBe('provider_arrears');
    expect(r.userMessage).toContain('欠费');
    expect(r.userMessage).toContain('管理员');
    expect(r.shortLabel).toBe('欠费');
  });

  it('message wording "Insufficient Balance" hits even without statusCode', () => {
    const r = classifyProviderError(new Error('402: Insufficient Balance'));
    expect(r.code).toBe('provider_arrears');
  });

  it('DashScope Arrearage responseBody hits provider_arrears', () => {
    const e = new Error('Request failed') as any;
    e.responseBody = '{"error":{"code":"Arrearage","message":"账户已欠费"}}';
    expect(classifyProviderError(e).code).toBe('provider_arrears');
  });

  it('Chinese 欠费 message hits provider_arrears', () => {
    expect(classifyProviderError(new Error('调用失败：账户欠费，请充值')).code).toBe('provider_arrears');
  });

  it('OpenAI-style quota wording hits provider_arrears', () => {
    expect(
      classifyProviderError(new Error('You have exceeded your current quota, please check your plan and billing details.')).code,
    ).toBe('provider_arrears');
  });

  it('generic provider errors do NOT hit provider_arrears (dual table: 400 -> bad_request)', () => {
    const e = new Error('Invalid request: model not found') as any;
    e.statusCode = 400;
    const r = classifyProviderError(e);
    // Updated for the dual-provider table (2026-09-02): 400 now maps to
    // provider_bad_request. Original intent preserved: NOT arrears. Note
    // "model not found" (spaced) deliberately does NOT match the bailian
    // code `model_not_found` (underscored) nor "Model not exist".
    expect(r.code).not.toBe('provider_arrears');
    expect(r.code).toBe('provider_bad_request');
    expect(r.userMessage).toBeTruthy();
  });

  it('network failure / plain string throw stay unclassified', () => {
    expect(classifyProviderError(new Error('fetch failed')).code).toBeNull();
    expect(classifyProviderError('boom').code).toBeNull();
    expect(classifyProviderError(undefined).code).toBeNull();
    expect(classifyProviderError(new Error('fetch failed')).userMessage).toBeNull();
    expect(classifyProviderError(new Error('fetch failed')).shortLabel).toBeNull();
  });

  // ---- Part 1: dual-provider table (2026-09-02) ----------------------------

  it('DeepSeek status-code table: 400/401/402/422/429/500/503 all classify with actionable labels', () => {
    const mk = (statusCode: number) => Object.assign(new Error('Request failed'), { statusCode });
    expect(classifyProviderError(mk(400)).code).toBe('provider_bad_request');
    expect(classifyProviderError(mk(401)).code).toBe('provider_auth');
    expect(classifyProviderError(mk(402)).code).toBe('provider_arrears');
    expect(classifyProviderError(mk(422)).code).toBe('provider_bad_request');
    expect(classifyProviderError(mk(429)).code).toBe('provider_rate_limit');
    expect(classifyProviderError(mk(500)).code).toBe('provider_server');
    expect(classifyProviderError(mk(503)).code).toBe('provider_server');
    for (const status of [400, 401, 402, 422, 429, 500, 503]) {
      const r = classifyProviderError(mk(status));
      expect(r.userMessage).toBeTruthy();
      expect(r.shortLabel).toBeTruthy();
    }
  });

  it('bailian body error codes classify via responseBody {error:{code,message}}', () => {
    const mk = (code: string, message = 'x') => {
      const e = new Error('Request failed') as any;
      e.responseBody = JSON.stringify({ error: { code, message } });
      return e;
    };
    // 欠费
    expect(classifyProviderError(mk('Arrearage')).code).toBe('provider_arrears');
    expect(classifyProviderError(mk('isv.OUT_OF_SERVICE')).code).toBe('provider_arrears');
    // 额度/账单
    expect(classifyProviderError(mk('Throttling.AllocationQuota')).code).toBe('provider_quota');
    expect(classifyProviderError(mk('insufficient_quota')).code).toBe('provider_quota');
    expect(classifyProviderError(mk('AllocationQuota.FreeTierOnly')).code).toBe('provider_quota');
    expect(classifyProviderError(mk('PrepaidBillOverdue')).code).toBe('provider_quota');
    expect(classifyProviderError(mk('PostpaidBillOverdue')).code).toBe('provider_quota');
    // 限流
    expect(classifyProviderError(mk('Throttling.RateQuota')).code).toBe('provider_rate_limit');
    expect(classifyProviderError(mk('Throttling.BurstRate')).code).toBe('provider_rate_limit');
    expect(classifyProviderError(mk('Throttling.Concurrency')).code).toBe('provider_rate_limit');
    // 认证
    expect(classifyProviderError(mk('invalid_api_key')).code).toBe('provider_auth');
    expect(classifyProviderError(mk('InvalidApiKey')).code).toBe('provider_auth');
    // 模型不存在/未开通
    expect(classifyProviderError(mk('model_not_found')).code).toBe('provider_model');
    expect(classifyProviderError(mk('x', 'Model not exist')).code).toBe('provider_model');
    expect(classifyProviderError(mk('x', 'The product is not activated')).code).toBe('provider_model');
    // 内容安全拦截(绿网)
    expect(classifyProviderError(mk('DataInspectionFailed')).code).toBe('provider_content_blocked');
    expect(classifyProviderError(mk('data_inspection_failed')).code).toBe('provider_content_blocked');
    expect(classifyProviderError(mk('x', 'Your request contains inappropriate content')).code).toBe('provider_content_blocked');
    // 服务端异常
    expect(classifyProviderError(mk('RequestTimeOut')).code).toBe('provider_server');
    expect(classifyProviderError(mk('ModelUnavailable')).code).toBe('provider_server');
    expect(classifyProviderError(mk('InternalError')).code).toBe('provider_server');
  });

  it('bailian codes match via message substrings alone (defensive, no responseBody)', () => {
    expect(classifyProviderError(new Error('DataInspectionFailed: 输出内容被绿网拦截')).code).toBe('provider_content_blocked');
    expect(classifyProviderError(new Error('Error: Throttling.RateQuota, please retry later')).code).toBe('provider_rate_limit');
    expect(classifyProviderError(new Error('402 arrearage: account suspended')).code).toBe('provider_arrears');
  });

  it('AI SDK surfaced error.code property matches too', () => {
    const e = Object.assign(new Error('The requested model is unavailable'), { code: 'ModelUnavailable' });
    expect(classifyProviderError(e).code).toBe('provider_server');
  });

  it('precedence: specific bailian code beats generic status mapping', () => {
    // bailian answers 400 with DataInspectionFailed -> content-block, not bad_request.
    const e = Object.assign(new Error('request failed'), {
      statusCode: 400,
      responseBody: '{"error":{"code":"DataInspectionFailed","message":"content blocked"}}',
    });
    expect(classifyProviderError(e).code).toBe('provider_content_blocked');
    // 429 + arrears body: arrears is the more specific/fatal verdict.
    const e2 = Object.assign(new Error('request failed'), {
      statusCode: 429,
      responseBody: '{"error":{"code":"Arrearage","message":"账户已欠费"}}',
    });
    expect(classifyProviderError(e2).code).toBe('provider_arrears');
  });

  it('every category carries an actionable Chinese label pair', () => {
    const cases: Array<[unknown, RegExp, RegExp]> = [
      [Object.assign(new Error('x'), { statusCode: 402 }), /充值/, /欠费/],
      [Object.assign(new Error('x'), { responseBody: '{"error":{"code":"insufficient_quota"}}' }), /额度|账单/, /额度/],
      [Object.assign(new Error('x'), { statusCode: 429 }), /限流|频繁/, /限流/],
      [Object.assign(new Error('x'), { statusCode: 401 }), /认证|API Key/, /认证失败/],
      [Object.assign(new Error('x'), { responseBody: '{"error":{"code":"model_not_found"}}' }), /不存在|未开通/, /模型/],
      [Object.assign(new Error('x'), { responseBody: '{"error":{"code":"DataInspectionFailed"}}' }), /内容安全|拦截/, /拦截/],
      [Object.assign(new Error('x'), { statusCode: 503 }), /异常|繁忙|重试/, /服务端异常/],
      [Object.assign(new Error('x'), { statusCode: 400 }), /格式|参数/, /参数/],
    ];
    for (const [err, msgRe, labelRe] of cases) {
      const r = classifyProviderError(err);
      expect(r.code).toBeTruthy();
      expect(r.userMessage ?? '').toMatch(msgRe);
      expect(r.shortLabel ?? '').toMatch(labelRe);
    }
  });

  it('never throws on hostile inputs', () => {
    expect(() => classifyProviderError(null)).not.toThrow();
    expect(() => classifyProviderError(42)).not.toThrow();
    expect(() => classifyProviderError({ responseBody: '{{{not json' })).not.toThrow();
    expect(() => classifyProviderError({ responseBody: '{"error":{"code":123}}' })).not.toThrow();
    expect(classifyProviderError({ responseBody: '{{{not json' }).code).toBeNull();
  });
});
