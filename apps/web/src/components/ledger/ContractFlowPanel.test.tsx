// @vitest-environment jsdom
// ContractFlowPanel 组件断言(spec §15): 四泳道渲染/状态点语义/告警条/三级钻取
// (点状态点 -> 明细 -> 原始凭证)/背靠背 correlates chip 互切。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { ContractFlowPanel } from './ContractFlowPanel';
import type { FlowPanelMilestone, FlowPanelResponse } from '../../api/flowPanel';

const fetchFlowPanelMock = vi.fn<(no: string) => Promise<FlowPanelResponse>>();

vi.mock('../../api/flowPanel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/flowPanel')>();
  return { ...actual, fetchFlowPanel: (no: string) => fetchFlowPanelMock(no) };
});

vi.mock('../FilePreviewModal', () => ({
  FilePreviewModal: (props: { file: { name: string } }) => (
    <div data-testid="file-preview">{props.file.name}</div>
  ),
}));

const ms = (p: Partial<FlowPanelMilestone> & { key: string; lane: FlowPanelMilestone['lane']; node: FlowPanelMilestone['node'] }): FlowPanelMilestone => ({
  label: p.key,
  status: 'pending',
  quantity: null,
  amount: null,
  date: null,
  count: 0,
  evidenceIds: ['EF-1'],
  note: null,
  breakdown: [],
  ...p,
});

function fixture(overrides: Partial<FlowPanelResponse> = {}): FlowPanelResponse {
  return {
    contractNo: 'GMNH-1',
    displayContractNo: 'GMNH-JBKZ-20250303HNWH',
    contractTitle: '焦炭购销合同',
    contractAmount: 4000000,
    asOf: '2026-09-10T00:00:00.000Z',
    basis: { quantity: 20000, unit: '吨' },
    progress: 3357.46 / 20000,
    progressReason: null,
    goods: [
      ms({ key: 'upstream-ship', lane: 'goods', node: '上游', label: '上游发运', status: 'done', quantity: { value: 3357.46, unit: '吨' }, date: '2026-06-10', count: 1 }),
      ms({ key: 'in-transit', lane: 'goods', node: '在途', label: '在途', status: 'pending' }),
      ms({ key: 'receipt', lane: 'goods', node: '我方', label: '我方收货(实称)', status: 'abnormal', quantity: { value: 3357.46, unit: '吨' }, date: '2026-06-20', count: 1, breakdown: [{ label: '汽运磅单 2026-06-20', quantity: { value: 3357.46, unit: '吨' }, amount: null, date: '2026-06-20', evidenceIds: ['EF-A1'], documentId: 'D-A1' }] }),
      ms({ key: 'inventory', lane: 'goods', node: '我方', label: '库存/拆分', status: 'done', quantity: { value: 3357.46, unit: '吨' }, count: 1 }),
      ms({ key: 'out-ship', lane: 'goods', node: '我方', label: '我方发货', status: 'pending' }),
      ms({ key: 'downstream-sign', lane: 'goods', node: '下游', label: '下游签收', status: 'pending' }),
    ],
    title: {
      currentHolder: '我方',
      note: null,
      transferPoints: [{ factId: 'TF-1', direction: 'in', caliber: '签收转', at: '2026-06-20T00:00:00.000Z', quantity: { value: 3357.46, unit: '吨' }, documentId: null }],
      milestones: [ms({ key: 'title-in', lane: 'title', node: '我方', label: '货权转入我方', status: 'done', date: '2026-06-20', count: 1 })],
    },
    funds: [
      ms({ key: 'paid', lane: 'funds', node: '上游', label: '付出', status: 'done', amount: { value: 500000, currency: 'CNY' }, count: 1 }),
      ms({ key: 'settled', lane: 'funds', node: '我方', label: '结算', status: 'done', amount: { value: 3357460, currency: 'CNY' }, count: 1 }),
      ms({ key: 'received', lane: 'funds', node: '下游', label: '收到', status: 'pending' }),
    ],
    invoice: [
      ms({ key: 'invoice-in', lane: 'invoice', node: '上游', label: '进项(已收)', status: 'done', amount: { value: 300000, currency: 'CNY' }, count: 1 }),
      ms({ key: 'writeoff', lane: 'invoice', node: '我方', label: '核销状态', status: 'ongoing', amount: { value: 100000, currency: 'CNY' }, count: 1 }),
      ms({ key: 'invoice-out', lane: 'invoice', node: '下游', label: '销项(已开)', status: 'pending' }),
    ],
    alerts: [{ code: 'delivery-overdue', level: 'warn', message: '履约凭证 2026-07-05 超合同交货期 2026-06-30（超 5 天）', evidenceIds: ['EF-9'], milestoneKeys: ['receipt'] }],
    netPosition: {
      currencies: [{ currency: 'CNY', paid: 500000, received: 200000, netOccupancy: 300000 }],
      invoices: [{ currency: 'CNY', inAmount: 300000, outAmount: 0 }],
    },
    correlates: [{ contractNo: 'PEER-1', displayContractNo: 'PEER-1', title: '对偶销售合同' }],
    documents: { 'D-A1': { fileName: 'users_u1_uuid_汽运磅单.pdf', minioKey: 'users/u1/uuid_汽运磅单.pdf' } },
    ...overrides,
  };
}

function renderPanel(no = 'GMNH-1') {
  return render(<ContractFlowPanel contractNo={no} />);
}

beforeEach(() => {
  fetchFlowPanelMock.mockReset();
  fetchFlowPanelMock.mockImplementation(async (no) => fixture(
    no === 'PEER-1' ? { contractNo: 'PEER-1', displayContractNo: 'PEER-1', correlates: [] } : {},
  ));
});

afterEach(cleanup);

describe('ContractFlowPanel (spec §15)', () => {
  it('四泳道 + 共享节点轴 + 进度/告警条渲染', async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByText('上游发运')).toBeTruthy());
    for (const label of ['货', '权', '款', '票']) {
      expect(screen.getByTestId(`lane-label-${label}`)).toBeTruthy();
    }
    for (const node of ['上游', '在途', '我方', '下游']) {
      expect(screen.getByTestId(`axis-${node}`)).toBeTruthy();
    }
    // 各流进度摘要(当前/总进度): 货 16.79% + 3,357.46/20,000 吨; 款/票对合同额
    expect(screen.getByText(/16\.79%/)).toBeTruthy();
    expect(screen.getAllByText(/3,357\.46/).length).toBeGreaterThan(0);
    expect(screen.getByText(/50万 \/ 400万/)).toBeTruthy();
    expect(screen.getByText(/20万 \/ 400万/)).toBeTruthy();
    expect(screen.getByText(/30万 \/ 400万/)).toBeTruthy();
    // 告警条
    expect(screen.getByText(/超合同交货期/)).toBeTruthy();
    // 净占用(已付−已收=30万; 文本拆在多个 span, 进项 30万 同值, 断言存在即可)
    expect(screen.getByText(/净占用/)).toBeTruthy();
    expect(screen.getAllByText('30万').length).toBeGreaterThan(0);
  });

  it('状态点语义: 实心=完成/琥珀=进行中/空心=未发生/红圈=异常', async () => {
    const { container } = renderPanel();
    await waitFor(() => expect(screen.getByText('上游发运')).toBeTruthy());
    expect(container.querySelector('[data-milestone="upstream-ship"]')!.getAttribute('data-status')).toBe('done');
    expect(container.querySelector('[data-milestone="in-transit"]')!.getAttribute('data-status')).toBe('pending');
    expect(container.querySelector('[data-milestone="writeoff"]')!.getAttribute('data-status')).toBe('ongoing');
    // 后端告警联动: receipt 被 delivery-overdue 覆盖 -> abnormal 红圈
    expect(container.querySelector('[data-milestone="receipt"]')!.getAttribute('data-status')).toBe('abnormal');
  });

  it('权泳道: 归属色带 我方 + 转移时点(签收转)', async () => {
    const { container } = renderPanel();
    await waitFor(() => expect(screen.getByText(/签收转/)).toBeTruthy());
    expect(container.querySelector('[data-testid="title-band"]')!.getAttribute('data-holder')).toBe('我方');
  });

  it('三级钻取: 点状态点 -> 明细(逐笔+证据 id) -> 原始凭证', async () => {
    const { container } = renderPanel();
    await waitFor(() => expect(screen.getByText('上游发运')).toBeTruthy());
    fireEvent.click(container.querySelector('[data-milestone="receipt"]')!);
    expect(await screen.findByText('汽运磅单 2026-06-20')).toBeTruthy();
    expect(screen.getByText(/EF-A1/)).toBeTruthy();
    // 第三级: 凭证直达
    fireEvent.click(screen.getByTestId('evidence-D-A1'));
    expect(screen.getByTestId('file-preview')).toBeTruthy();
  });

  it('背靠背 correlates chip 互切: 点击后按对偶合同号重新拉取', async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByText('上游发运')).toBeTruthy());
    fireEvent.click(screen.getByTestId('correlate-PEER-1'));
    await waitFor(() => expect(fetchFlowPanelMock).toHaveBeenCalledWith('PEER-1'));
    await waitFor(() => expect(screen.getByText('PEER-1')).toBeTruthy());
  });

  it('加载失败显示错误不炸', async () => {
    fetchFlowPanelMock.mockRejectedValueOnce(new Error('请求失败（404）'));
    renderPanel();
    await waitFor(() => expect(screen.getByText(/请求失败（404）/)).toBeTruthy());
  });
});
