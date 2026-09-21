// @vitest-environment jsdom
// WriteoffView 空模式行隐藏(wave6 Task 3): 无该类事实(资金与目标两侧均空)的核销
// 模式折叠不渲染 tab(读侧 writeoffModeRelations 已自动纳入 WRITE_OFF_SETTLEMENT,
// 空数据时会产生空模式行); 有数据时照常渲染。API 层 vi.mock, 纯前端行为。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { WriteoffView } from './WriteoffView';
import type { WriteoffOverview, WriteoffMode, WriteoffBalanceRow } from '../../api/writeoff';

const fetchWriteoffOverviewMock = vi.fn<() => Promise<WriteoffOverview>>();

vi.mock('../../api/writeoff', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/writeoff')>();
  return { ...actual, fetchWriteoffOverview: () => fetchWriteoffOverviewMock() };
});

function row(
  id: string, entityType: string, amount: number, remaining: number,
  status: 'none' | 'partial' | 'full' = 'none',
): WriteoffBalanceRow {
  return {
    id, entityType, label: id, currency: 'CNY',
    amount, applied: amount - remaining, remaining, validAt: null, status,
  };
}

function mode(relation: string, funds: WriteoffBalanceRow[], targets: WriteoffBalanceRow[]): WriteoffMode {
  return { relation, description: '', srcTypes: [], dstTypes: [], funds, targets };
}

beforeEach(() => {
  fetchWriteoffOverviewMock.mockReset();
});

afterEach(cleanup);

describe('WriteoffView 空模式行隐藏 (wave6)', () => {
  it('无该类事实(资金/目标均空)的 WRITE_OFF_SETTLEMENT 模式折叠, 不渲染空模式 tab', async () => {
    fetchWriteoffOverviewMock.mockResolvedValue({
      asOf: new Date().toISOString(),
      modes: [
        mode('WRITE_OFF', [row('P-1', 'PaymentEvent', 100, 100)], [row('I-1', 'InvoiceEvent', 60, 60)]),
        mode('OFFSET_SETTLE', [row('P-2', 'PaymentEvent', 100, 80)], [row('S-1', 'SettlementEvent', 80, 80)]),
        mode('WRITE_OFF_SETTLEMENT', [], []),
      ],
    });
    render(<WriteoffView />);
    await waitFor(() => expect(screen.getByText('票款核销')).toBeTruthy());
    // 有数据模式 tab 照常渲染
    expect(screen.getByText('预付冲抵')).toBeTruthy();
    // 空模式 tab 不渲染(WRITE_OFF_SETTLEMENT 无该类事实 -> 折叠)
    expect(screen.queryByText('WRITE_OFF_SETTLEMENT')).toBeNull();
  });

  it('有结算核销数据时 WRITE_OFF_SETTLEMENT 模式 tab 照常渲染', async () => {
    fetchWriteoffOverviewMock.mockResolvedValue({
      asOf: new Date().toISOString(),
      modes: [
        mode('WRITE_OFF', [row('P-1', 'PaymentEvent', 100, 100)], [row('I-1', 'InvoiceEvent', 60, 60)]),
        mode('WRITE_OFF_SETTLEMENT',
          [row('P-2', 'PaymentEvent', 100, 80)],
          [row('S-1', 'SettlementEvent', 80, 80)]),
      ],
    });
    render(<WriteoffView />);
    await waitFor(() => expect(screen.getByText('WRITE_OFF_SETTLEMENT')).toBeTruthy());
    expect(screen.getByText('票款核销')).toBeTruthy();
  });
});