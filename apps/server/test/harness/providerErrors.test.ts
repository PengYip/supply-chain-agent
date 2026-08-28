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

  it('generic provider errors do NOT hit provider_arrears', () => {
    const e = new Error('Invalid request: model not found') as any;
    e.statusCode = 400;
    const r = classifyProviderError(e);
    expect(r.code).toBeNull();
    expect(r.userMessage).toBeNull();
  });

  it('network failure / plain string throw do NOT hit provider_arrears', () => {
    expect(classifyProviderError(new Error('fetch failed')).code).toBeNull();
    expect(classifyProviderError('boom').code).toBeNull();
    expect(classifyProviderError(undefined).code).toBeNull();
  });
});
