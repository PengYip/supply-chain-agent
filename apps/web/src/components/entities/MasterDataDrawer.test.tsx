// @vitest-environment jsdom
// MasterDataDrawer 组件断言：主数据登记提交只携带非空字段 + entityType，
// 登记成功后回调 onSaved 驱动台账刷新；必填缺失在客户端拦截不发请求。
// 2026-09-09 主体身份：change 模式（supersede 换代）与 TradeGoods 键值袋编辑区。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MasterDataDrawer } from './MasterDataDrawer';
import type { MasterDataSubmitResult, MasterDataTypeFormDTO } from '../../api/ontology';

type SubmitFn = (input: Record<string, string | number>) => Promise<MasterDataSubmitResult>;
const submitMock = vi.fn<SubmitFn>();
type ChangeFn = (input: { prevFactId: string; payload: Record<string, string | number>; validAt?: string }) => Promise<{ newId: string; prevFactId: string; invalidAt: string }>;
const changeMock = vi.fn<ChangeFn>();

vi.mock('../../api/ontology', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/ontology')>();
  return {
    ...actual,
    submitMasterData: (input: Record<string, string | number>) => submitMock(input),
    changeMasterData: (input: { prevFactId: string; payload: Record<string, string | number> }) => changeMock(input),
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
  changeMock.mockReset();
  onSaved.mockReset();
  submitMock.mockResolvedValue({ id: 'TF-1', entityType: 'TradeGoods' });
  changeMock.mockResolvedValue({ newId: 'TF-2', prevFactId: 'TF-1', invalidAt: '2026-09-09T00:00:00.000Z' });
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

  it('自定义属性键值编辑区：增行填键值提交并入 payload.attributes，删行剔除', async () => {
    renderDrawer();
    fireEvent.change(await screen.findByLabelText('name必填'), { target: { value: '螺纹钢' } });
    fireEvent.change(screen.getByLabelText('commodityCode必填'), { target: { value: 'HRB400E' } });
    fireEvent.click(screen.getByRole('button', { name: '加一条' }));
    fireEvent.change(screen.getByLabelText('属性键 1'), { target: { value: '牌号' } });
    fireEvent.change(screen.getByLabelText('属性值 1'), { target: { value: 'HRB400E' } });
    fireEvent.click(screen.getByRole('button', { name: '加一条' }));
    fireEvent.click(screen.getByRole('button', { name: '删除属性 2' })); // 空行删除
    fireEvent.click(screen.getByRole('button', { name: '登记' }));
    await screen.findByText('登记成功，商品已写入台账。');
    expect(submitMock.mock.calls[0]![0]['attributes']).toEqual({ '牌号': 'HRB400E' });
  });

  it('自定义属性空键行提交时剔除，重复键客户端拒绝', async () => {
    renderDrawer();
    fireEvent.change(await screen.findByLabelText('name必填'), { target: { value: '螺纹钢' } });
    fireEvent.change(screen.getByLabelText('commodityCode必填'), { target: { value: 'X' } });
    fireEvent.click(screen.getByRole('button', { name: '加一条' }));
    fireEvent.change(screen.getByLabelText('属性键 1'), { target: { value: '牌号' } });
    fireEvent.change(screen.getByLabelText('属性值 1'), { target: { value: 'A' } });
    fireEvent.click(screen.getByRole('button', { name: '加一条' }));
    fireEvent.change(screen.getByLabelText('属性键 2'), { target: { value: '牌号' } });
    fireEvent.change(screen.getByLabelText('属性值 2'), { target: { value: 'B' } });
    fireEvent.click(screen.getByRole('button', { name: '登记' }));
    await screen.findByText(/自定义属性键重复/);
    expect(submitMock).not.toHaveBeenCalled();
  });

  describe('change 模式（spec 主体身份 §4：supersede 换代）', () => {
    const partyType: MasterDataTypeFormDTO = {
      name: 'Counterparty',
      label: '交易对手',
      description: '与本方发生业务往来的外部企业。',
      fields: [
        { name: 'uscc', kind: 'string', required: true, description: '统一社会信用代码' },
        { name: 'name', kind: 'string', required: true, description: '企业名' },
        { name: 'role', kind: 'string', required: true, description: '角色' },
        { name: 'bankAccount', kind: 'string', required: false, description: '收款账号' },
      ],
    };

    function renderChange() {
      return render(
        <MasterDataDrawer
          masterType={partyType}
          changeTarget={{
            prevFactId: 'TF-old',
            current: { uscc: '91130000MA0A0000XA', name: '某钢铁有限公司', role: '供应商', bankAccount: '6222000011112222' },
          }}
          onClose={() => {}}
          onSaved={onSaved}
        />,
      );
    }

    it('头部为变更文案，uscc 只读（主体锚不可变更），预填现行值', () => {
      renderChange();
      expect(screen.getByText('变更交易对手')).toBeTruthy();
      const uscc = screen.getByLabelText(/uscc/) as HTMLInputElement;
      expect(uscc.disabled).toBe(true);
      expect((screen.getByLabelText(/name/) as HTMLInputElement).value).toBe('某钢铁有限公司');
      expect((screen.getByLabelText(/bankAccount/) as HTMLInputElement).value).toBe('6222****2222'); // 脱敏回显
    });

    it('提交走 changeMasterData：掩码未改还原原值，不含 entityType', async () => {
      renderChange();
      fireEvent.change(screen.getByLabelText(/name/), { target: { value: '某钢铁集团股份有限公司' } });
      fireEvent.click(screen.getByRole('button', { name: '提交变更' }));
      await screen.findByText(/变更已提交/);
      expect(changeMock).toHaveBeenCalledTimes(1);
      expect(changeMock.mock.calls[0]![0].prevFactId).toBe('TF-old');
      expect(changeMock.mock.calls[0]![0].payload).toEqual({
        uscc: '91130000MA0A0000XA',
        name: '某钢铁集团股份有限公司',
        role: '供应商',
        bankAccount: '6222000011112222', // 未修改的掩码 -> 还原原始值
      });
      expect(onSaved).toHaveBeenCalledTimes(1);
      expect(submitMock).not.toHaveBeenCalled();
    });
  });
});
