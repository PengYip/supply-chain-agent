// 事件登记表单 API 契约测试（2026-09-08 事件登记入口验收）：
// 服务端 400（invalid_body/invalid_event）必须映射为 TradeEventValidationError
// 携带字段级 detail —— EventRegisterDrawer 的失败分支依赖它渲染字段级错误，
// 且失败时仅 setState 错误、不触碰 values、不调 onClose（组件内联保证）。
import { describe, it, expect, afterEach, vi } from 'vitest';
import { submitTradeEvent, TradeEventValidationError } from './tradeEvents';

function stubFetchOnce(status: number, body: unknown) {
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('submitTradeEvent 服务端 400 映射', () => {
  it('invalid_event（注册表语义预检，如漏填 payType）映射为字段级校验错误', async () => {
    stubFetchOnce(400, {
      error: 'invalid_event',
      detail: { formErrors: [], fieldErrors: { payType: ['Required'] } },
    });
    const err = await submitTradeEvent({ entityType: 'PaymentEvent', amount: 1 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TradeEventValidationError);
    const detail = (err as TradeEventValidationError).detail;
    expect(detail.fieldErrors.payType).toEqual(['Required']);
    expect(detail.formErrors).toEqual([]);
  });

  it('invalid_body（inputSchema strict）同样映射为字段级校验错误', async () => {
    stubFetchOnce(400, {
      error: 'invalid_body',
      detail: { formErrors: [], fieldErrors: { phantomField: ['未注册字段：phantomField'] } },
    });
    const err = await submitTradeEvent({ phantomField: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TradeEventValidationError);
    expect((err as TradeEventValidationError).detail.fieldErrors.phantomField).toEqual([
      '未注册字段：phantomField',
    ]);
  });

  it('非校验类错误（如 session_busy）保持普通 Error，错误信息含服务端 error 字段', async () => {
    stubFetchOnce(409, { error: 'session_busy', activeRunId: null });
    const err = await submitTradeEvent({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TradeEventValidationError);
    expect((err as Error).message).toContain('session_busy');
  });
});
