// @vitest-environment jsdom
// EventRegisterDrawer 组件断言：amount 与 currency 同缺同在的双向联动 +
// 数量-only 提交不携带空串字段（服务端 zod/注册表已严格，前端不得发空串）。
// 服务端 widget:'date' 投影见 apps/server/test/routes/tradeEventsRoutes.test.ts，
// 此处仅断言抽屉按投影渲染日期控件。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { EventRegisterDrawer } from './EventRegisterDrawer';
import type { TradeEventFormSchema, TradeEventSubmitResult } from '../../api/tradeEvents';

// .tsx 里类型实参用命名别名，避免内联箭头函数类型的解析歧义
type FetchSchemaFn = () => Promise<TradeEventFormSchema>;
type SubmitEventFn = (input: Record<string, string | number>) => Promise<TradeEventSubmitResult>;
const fetchSchemaMock = vi.fn<FetchSchemaFn>();
const submitMock = vi.fn<SubmitEventFn>();

vi.mock('../../api/tradeEvents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/tradeEvents')>();
  return {
    ...actual,
    fetchTradeEventFormSchema: () => fetchSchemaMock(),
    submitTradeEvent: (input: Record<string, string | number>) => submitMock(input),
  };
});

const schema: TradeEventFormSchema = {
  tool: 'create_trade_event',
  fields: [
    { name: 'entityType', kind: 'enum', required: true, options: ['GoodsReceiptEvent', 'PaymentEvent'], description: '事件类型（7 类之一）' },
    { name: 'eventBizType', kind: 'enum', required: true, options: ['正向', '逆向'], description: '业务方向' },
    { name: 'amount', kind: 'number', required: false, description: '金额；收货/发货可省略' },
    { name: 'currency', kind: 'string', required: false, formDefault: 'CNY', description: '币种；与 amount 同缺同在' },
    { name: 'validAt', kind: 'string', required: true, widget: 'date', description: '业务发生时间 ISO 日期' },
    { name: 'quantity', kind: 'number', required: false, description: '数量' },
    { name: 'unit', kind: 'string', required: false, description: '单位' },
  ],
};

function renderDrawer() {
  return render(
    <EventRegisterDrawer
      eventEntities={[{ name: 'GoodsReceiptEvent', label: '收货事件' }]}
      initialType="GoodsReceiptEvent"
      onClose={() => {}}
    />,
  );
}

const inputOf = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const awaitInputOf = async (label: string) => (await screen.findByLabelText(label)) as HTMLInputElement;

beforeEach(() => {
  fetchSchemaMock.mockReset();
  submitMock.mockReset();
  fetchSchemaMock.mockResolvedValue(schema);
  submitMock.mockResolvedValue({ ticketId: 'T-1', sessionId: 's1', runId: 'r1', status: 'busy' });
});

// vitest globals 未开启，RTL 不会自动 cleanup，须显式清理避免 DOM 跨用例泄漏
afterEach(cleanup);

describe('EventRegisterDrawer amount/currency 双向联动', () => {
  it('初始（amount 为空）：currency 禁用且清空，不预填 CNY', async () => {
    renderDrawer();
    const currency = await awaitInputOf('currency');
    expect(currency.disabled).toBe(true);
    expect(currency.value).toBe('');
  });

  it('方向一：amount 从有值到清空，currency 立即禁用并清空', async () => {
    renderDrawer();
    const amount = await screen.findByLabelText('amount');
    const currency = inputOf('currency');
    fireEvent.change(amount, { target: { value: '500' } });
    expect(currency.disabled).toBe(false);
    expect(currency.value).toBe('CNY');
    fireEvent.change(amount, { target: { value: '' } });
    expect(currency.disabled).toBe(true);
    expect(currency.value).toBe('');
  });

  it('方向二：amount 重新有值，currency 恢复可用并回到预填 CNY', async () => {
    renderDrawer();
    const amount = await screen.findByLabelText('amount');
    const currency = inputOf('currency');
    fireEvent.change(amount, { target: { value: '' } });
    expect(currency.disabled).toBe(true);
    fireEvent.change(amount, { target: { value: '800' } });
    expect(currency.disabled).toBe(false);
    expect(currency.value).toBe('CNY');
  });
});

describe('数量-only 收货提交（主用例）', () => {
  it('不携带 amount/currency，也不携带任何空串字段；validAt 按 date 控件渲染', async () => {
    renderDrawer();
    const validAt = await screen.findByLabelText('validAt必填');
    expect((validAt as HTMLInputElement).type).toBe('date');
    fireEvent.change(screen.getByLabelText('eventBizType必填'), { target: { value: '正向' } });
    fireEvent.change(validAt, { target: { value: '2026-06-25' } });
    fireEvent.change(screen.getByLabelText('quantity'), { target: { value: '100' } });
    fireEvent.change(screen.getByLabelText('unit'), { target: { value: '吨' } });
    fireEvent.click(screen.getByRole('button', { name: '提交审批' }));
    await screen.findByText('已提交，等待审批中心批准后写入台账。');
    expect(submitMock).toHaveBeenCalledTimes(1);
    const payload = submitMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload).toEqual({
      entityType: 'GoodsReceiptEvent',
      eventBizType: '正向',
      validAt: '2026-06-25',
      quantity: 100,
      unit: '吨',
    });
    expect('amount' in payload).toBe(false);
    expect('currency' in payload).toBe(false);
  });
});
