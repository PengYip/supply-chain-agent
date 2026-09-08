// @vitest-environment jsdom
// MasterDataDrawer 组件断言：主数据登记提交只携带非空字段 + entityType，
// 登记成功后回调 onSaved 驱动台账刷新；必填缺失在客户端拦截不发请求。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MasterDataDrawer } from './MasterDataDrawer';
import type { MasterDataSubmitResult, MasterDataTypeFormDTO } from '../../api/ontology';

type SubmitFn = (input: Record<string, string | number>) => Promise<MasterDataSubmitResult>;
const submitMock = vi.fn<SubmitFn>();

vi.mock('../../api/ontology', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/ontology')>();
  return {
    ...actual,
    submitMasterData: (input: Record<string, string | number>) => submitMock(input),
  };
});

const masterType: MasterDataTypeFormDTO = {
  name: 'TradeGoods',
  label: '商品',
  description: '合同与事件中流转货物的品类口径。',
  fields: [
    { name: 'name', kind: 'string', required: true, description: '商品名' },
    { name: 'commodityCode', kind: 'string', required: true, description: '商品码；v1 开放词汇自由填写' },
    { name: 'spec', kind: 'string', required: false, description: '规格品位（选填）' },
  ],
};

const onSaved = vi.fn();

function renderDrawer() {
  return render(<MasterDataDrawer masterType={masterType} onClose={() => {}} onSaved={onSaved} />);
}

beforeEach(() => {
  submitMock.mockReset();
  onSaved.mockReset();
  submitMock.mockResolvedValue({ id: 'TF-1', entityType: 'TradeGoods' });
});

afterEach(cleanup);

describe('MasterDataDrawer', () => {
  it('头部显示类型与注册表说明，必填字段带标记', async () => {
    renderDrawer();
    expect(screen.getByText('登记商品')).toBeTruthy();
    expect(screen.getByText('合同与事件中流转货物的品类口径。')).toBeTruthy();
    // label 文本跨元素拼接（name + 必填 span），用 getByLabelText 断言
    expect(screen.getByLabelText('name必填')).toBeTruthy();
    expect(screen.getByLabelText('commodityCode必填')).toBeTruthy();
    expect(screen.queryByLabelText('spec必填')).toBeNull();
  });

  it('必填缺失客户端拦截：不发请求不回调 onSaved', async () => {
    renderDrawer();
    fireEvent.change(await screen.findByLabelText('name必填'), { target: { value: '动力煤' } });
    fireEvent.click(screen.getByRole('button', { name: '登记' }));
    await screen.findByText(/必填字段为空/);
    expect(submitMock).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('提交携带 entityType + 非空字段（选填空值剔除），成功提示并回调 onSaved', async () => {
    renderDrawer();
    fireEvent.change(await screen.findByLabelText('name必填'), { target: { value: '动力煤' } });
    fireEvent.change(screen.getByLabelText('commodityCode必填'), { target: { value: ' 5500K ' } });
    fireEvent.click(screen.getByRole('button', { name: '登记' }));
    await screen.findByText('登记成功，商品已写入台账。');
    expect(submitMock).toHaveBeenCalledTimes(1);
    expect(submitMock.mock.calls[0]![0]).toEqual({
      entityType: 'TradeGoods',
      name: '动力煤',
      commodityCode: '5500K',
    });
    expect(onSaved).toHaveBeenCalledTimes(1);
  });
});
