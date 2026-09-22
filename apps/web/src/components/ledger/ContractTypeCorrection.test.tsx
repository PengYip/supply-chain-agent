// @vitest-environment jsdom
// ContractTypeCorrection 冒烟(business-loop Wave 7)：待消歧引导(空/歧义值)/
// 受控六值选择(禁自由文本)/选择提交/成功反馈(refreshedFlows=张口径)/失败反馈。
// API 层 vi.mock，纯前端行为不依赖后端。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { ContractTypeCorrection } from './ContractTypeCorrection';
import { CONTRACT_TYPE_OPTIONS, type ContractTypeChangeResult } from '../../api/contracts';

const patchMock = vi.fn<(no: string, t: string) => Promise<ContractTypeChangeResult>>();

vi.mock('../../api/contracts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/contracts')>();
  return {
    ...actual,
    patchContractType: (no: string, t: string) => patchMock(no, t),
  };
});

function okResult(overrides: Partial<ContractTypeChangeResult> = {}): ContractTypeChangeResult {
  return {
    ok: true,
    contractNo: 'XYRL-2022-225',
    contractType: '采购',
    refreshedDocuments: 2,
    refreshedFlows: 2,
    failed: 0,
    skipped: [],
    ...overrides,
  };
}

beforeEach(() => {
  patchMock.mockReset();
  patchMock.mockImplementation(async (_no, t) => okResult({ contractType: t }));
});

afterEach(cleanup);

describe('ContractTypeCorrection (business-loop wave7)', () => {
  it('类型为空: 默认展开待消歧引导 + 受控六值选择器(无自由文本)', () => {
    render(<ContractTypeCorrection contractNo="XYRL-2022-225" currentType={null} />);
    // 引导文案接地气: 分不出方向 -> 流水跳过
    expect(screen.getByTestId('contract-type-editor')).toBeTruthy();
    expect(screen.getByText(/分不出采购还是销售/)).toBeTruthy();
    expect(screen.getByText(/执行流水会因此跳过/)).toBeTruthy();
    // 受控值: select 恰好六个选项, 值 = 白名单
    const select = screen.getByTestId('contract-type-select') as HTMLSelectElement;
    const options = Array.from(select.options).filter((o) => o.value !== '');
    expect(options.map((o) => o.value)).toEqual([...CONTRACT_TYPE_OPTIONS]);
    // 无文本输入位
    expect(screen.queryByRole('textbox')).toBeNull();
    // 未选择时保存禁用(不喂空值给后端)
    expect((screen.getByTestId('contract-type-submit') as HTMLButtonElement).disabled).toBe(true);
  });

  it('类型为歧义值(购销合同): 同样给待消歧引导, 文案点出当前值', () => {
    render(<ContractTypeCorrection contractNo="XYRL-2022-225" currentType="购销合同" />);
    expect(screen.getByTestId('contract-type-editor')).toBeTruthy();
    expect(screen.getByText(/「购销合同」/)).toBeTruthy();
  });

  it('选择并提交: 调 patchContractType(正确参数), 成功反馈按"张单据"口径并通知父级', async () => {
    const onChanged = vi.fn();
    render(<ContractTypeCorrection contractNo="XYRL-2022-225" currentType={null} onChanged={onChanged} />);
    fireEvent.change(screen.getByTestId('contract-type-select'), { target: { value: '采购' } });
    fireEvent.click(screen.getByTestId('contract-type-submit'));
    await waitFor(() => expect(patchMock).toHaveBeenCalledWith('XYRL-2022-225', '采购'));
    // refreshedFlows=2 -> "已重建 2 张单据的执行流水"(文档数口径, 不是"条")
    expect(await screen.findByTestId('contract-type-result')).toBeTruthy();
    expect(screen.getByText(/已改为「采购」/)).toBeTruthy();
    expect(screen.getByText(/已重建 2 张单据的执行流水/)).toBeTruthy();
    expect(screen.queryByText(/条流水/)).toBeNull();
    expect(onChanged).toHaveBeenCalled();
  });

  it('成功反馈的 0 重建分支: 无已确认绑定时如实说"没有流水需要重建"', async () => {
    patchMock.mockImplementation(async (_no, t) => okResult({ contractType: t, refreshedDocuments: 0, refreshedFlows: 0 }));
    render(<ContractTypeCorrection contractNo="C-1" currentType={null} />);
    fireEvent.change(screen.getByTestId('contract-type-select'), { target: { value: '销售' } });
    fireEvent.click(screen.getByTestId('contract-type-submit'));
    await waitFor(() => expect(screen.getByTestId('contract-type-result')).toBeTruthy());
    expect(screen.getByText(/没有流水需要重建/)).toBeTruthy();
  });

  it('W8 T4 同部署兜底: 旧服务端仅返 refreshedFlows -> 消费切 refreshedDocuments ?? refreshedFlows, 反馈仍按张渲染', async () => {
    patchMock.mockImplementation(async (_no, t) => {
      const base = okResult({ contractType: t });
      return { ...base, refreshedDocuments: undefined as never } as ContractTypeChangeResult;
    });
    render(<ContractTypeCorrection contractNo="C-FB" currentType={null} />);
    fireEvent.change(screen.getByTestId('contract-type-select'), { target: { value: '采购' } });
    fireEvent.click(screen.getByTestId('contract-type-submit'));
    await waitFor(() => expect(screen.getByTestId('contract-type-result')).toBeTruthy());
    expect(screen.getByText(/已重建 2 张单据的执行流水/)).toBeTruthy();
  });

  it('失败反馈: 404(非本人台账行)显示接地气错误, 不触发 onChanged, 可重试', async () => {
    const onChanged = vi.fn();
    patchMock.mockRejectedValueOnce(new Error('未找到可修正的合同台账行'));
    render(<ContractTypeCorrection contractNo="C-404" currentType={null} onChanged={onChanged} />);
    fireEvent.change(screen.getByTestId('contract-type-select'), { target: { value: '采购' } });
    fireEvent.click(screen.getByTestId('contract-type-submit'));
    await waitFor(() => expect(screen.getByTestId('contract-type-error')).toBeTruthy());
    expect(screen.getByTestId('contract-type-error').textContent).toContain('未找到可修正的合同台账行');
    expect(onChanged).not.toHaveBeenCalled();
    // 编辑器仍在, 修正后可重试
    expect(screen.getByTestId('contract-type-editor')).toBeTruthy();
    fireEvent.click(screen.getByTestId('contract-type-submit'));
    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(2));
  });

  it('类型已是受控值: 收起为一行小字 + 安静的「修正」入口, 点开才有选择器', () => {
    render(<ContractTypeCorrection contractNo="C-2" currentType="销售" />);
    expect(screen.getByText('合同类型')).toBeTruthy();
    expect(screen.getByText('销售')).toBeTruthy();
    expect(screen.queryByTestId('contract-type-editor')).toBeNull();
    expect(screen.queryByText(/分不出采购还是销售/)).toBeNull();
    fireEvent.click(screen.getByTestId('contract-type-edit-trigger'));
    expect(screen.getByTestId('contract-type-editor')).toBeTruthy();
    // 从受控值打开: 提供「取消」回退
    expect(screen.getByText('取消')).toBeTruthy();
  });

  it('受控值态完整流程: 打开修正 -> 选新值 -> 保存 -> patch 调用 + onChanged + 成功反馈', async () => {
    const onChanged = vi.fn();
    render(<ContractTypeCorrection contractNo="C-2" currentType="销售" onChanged={onChanged} />);
    fireEvent.click(screen.getByTestId('contract-type-edit-trigger'));
    fireEvent.change(screen.getByTestId('contract-type-select'), { target: { value: '物流' } });
    fireEvent.click(screen.getByTestId('contract-type-submit'));
    await waitFor(() => expect(patchMock).toHaveBeenCalledWith('C-2', '物流'));
    expect(await screen.findByTestId('contract-type-result')).toBeTruthy();
    expect(screen.getByText(/已改为「物流」/)).toBeTruthy();
    expect(screen.getByText(/已重建 2 张单据的执行流水/)).toBeTruthy();
    expect(onChanged).toHaveBeenCalled();
  });
});
