// @vitest-environment jsdom
// GapsPanel 渲染冒烟(business-loop Wave 4)：四块 tiles(含 null 待登记弱化态) /
// 四组明细行(code+basis+口径提示角标) / checks 默认收起可展开 / projectNo
// 过滤显式应用触发重取。API 层 vi.mock，纯前端行为不依赖后端。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { GapsPanel } from './GapsPanel';
import type { GapsReportDTO } from '../../api/ontology';

const fetchGapsMock = vi.fn<(projectNo?: string) => Promise<GapsReportDTO>>();

vi.mock('../../api/ontology', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/ontology')>();
  return { ...actual, fetchGaps: (projectNo?: string) => fetchGapsMock(projectNo) };
});

function fixture(overrides: Partial<GapsReportDTO> = {}): GapsReportDTO {
  return {
    scope: 'all',
    tiles: [
      { key: 'stock', label: '存货结存', qty: 1200.5, hint: '已采购未销售(数量, R18 全局口径)' },
      { key: 'recv', label: '应收未收', amt: null, hint: '发货口径(⑤ 发货未收)' },
      { key: 'pay', label: '应付未付', amt: 3210987.65, hint: '结算口径(⑦ 结算未付)' },
      { key: 'mis', label: '票款错配', amt: 0, hint: '付无票 + 收无票' },
    ],
    groups: [
      {
        key: 'stock', label: '存货缺口', desc: '采购收货与销售发货的数量/金额勾稽',
        items: [
          { code: '①', label: '已采购未销售', qty: 1200.5, basis: 'Σ收货 − Σ发货' },
          { code: '②', label: '已收货未结算', amt: null, basis: 'Σ购收amt − Σ购结算', missingInputs: ['购收金额'] },
        ],
      },
      {
        key: 'recv', label: '应收缺口', desc: '销售侧结算/发货/开票与收款的勾稽',
        items: [
          { code: '⑤', label: '发货未收', amt: null, basis: 'Σ销发amt − Σ收款', missingInputs: ['销发金额', '合同侧别无法判定: C-99'] },
        ],
      },
      {
        key: 'pay', label: '应付缺口', desc: '采购侧结算/收货/收票与付款的勾稽',
        items: [
          { code: '⑦', label: '结算未付', amt: 3210987.65, basis: 'Σ购结算 − Σ非预付付款' },
        ],
      },
      {
        key: 'mis', label: '票款错配', desc: '付款/收款与进销项票的绝对差异',
        items: [
          { code: '⑩', label: '付无票', amt: 0, basis: '|付款净 − Σ进项|' },
        ],
      },
    ],
    checks: ['① 1,201t = Σ收货 3,357 − Σ发货 2,156', '⑦ 3,210,988 = Σ购结算 3,460,988 − Σ非预付付款 250,000'],
    ...overrides,
  };
}

beforeEach(() => {
  fetchGapsMock.mockReset();
  // scope 跟随 projectNo 参数回显（组件显示 report.scope，mock 不回显则永远是 all）。
  fetchGapsMock.mockImplementation(async (pn) => fixture(pn ? { scope: pn } : {}));
});

afterEach(cleanup);

describe('GapsPanel (business-loop wave4)', () => {
  it('四块 tiles 摘要渲染；null 口径显示待登记弱化态与说明 tooltip', async () => {
    render(<GapsPanel />);
    await waitFor(() => expect(screen.getByText('存货结存')).toBeTruthy());
    expect(screen.getByText('应收未收')).toBeTruthy();
    expect(screen.getByText('应付未付')).toBeTruthy();
    // 「票款错配」同名出现两次: tile 标签 + mis 组头(与后端 groups[3].label 一致)
    expect(screen.getAllByText('票款错配').length).toBe(2);
    // 数值: 千分位(tile + 对应明细行各一次) + null 待登记
    expect(screen.getAllByText('1,200.5').length).toBe(2);
    expect(screen.getAllByText('3,210,987.65').length).toBe(2);
    expect(screen.getAllByText('待登记').length).toBeGreaterThan(0);
    // null tile 的 tooltip 汇集原因(销发金额 + 侧别无法判定)
    const tile = screen.getByText('应收未收').closest('div[class*="border-l-2"]');
    expect(tile?.getAttribute('title')).toContain('该口径数据未登记');
    expect(tile?.getAttribute('title')).toContain('销发金额');
  });

  it('四组明细行: code/label/basis 渲染, missingInputs 行带口径提示角标', async () => {
    render(<GapsPanel />);
    await waitFor(() => expect(screen.getByText('存货缺口')).toBeTruthy());
    expect(screen.getByText('应收缺口')).toBeTruthy();
    expect(screen.getByText('应付缺口')).toBeTruthy();
    expect(screen.getAllByText('票款错配').length).toBe(2);
    // 行内容
    expect(screen.getByText('已采购未销售')).toBeTruthy();
    expect(screen.getByText('Σ收货 − Σ发货')).toBeTruthy();
    // missingInputs 非空的行: 角标 + aria-label 原因清单
    const badges = screen.getAllByLabelText(/口径提示：/);
    expect(badges.length).toBe(2);
    expect(badges[1].getAttribute('aria-label')).toContain('合同侧别无法判定: C-99');
    // 组头右侧 headline(来自对应 tile)
    expect(screen.getByText('1,200.5 吨')).toBeTruthy();
  });

  it('勾稽校验说明默认收起, 点击展开', async () => {
    render(<GapsPanel />);
    await waitFor(() => expect(screen.getByText('勾稽校验说明')).toBeTruthy());
    expect(screen.queryByText(/Σ收货 3,357/)).toBeNull();
    fireEvent.click(screen.getByText('勾稽校验说明'));
    expect(await screen.findByText(/1,201t = Σ收货 3,357/)).toBeTruthy();
  });

  it('projectNo 过滤显式应用触发带参重取, 清除后复位', async () => {
    render(<GapsPanel />);
    await waitFor(() => expect(screen.getByText('存货结存')).toBeTruthy());
    expect(fetchGapsMock).toHaveBeenCalledWith(undefined);
    const input = screen.getByLabelText('项目编号过滤');
    fireEvent.change(input, { target: { value: 'PRJ-2026-01' } });
    fireEvent.click(screen.getByText('应用'));
    await waitFor(() => expect(fetchGapsMock).toHaveBeenCalledWith('PRJ-2026-01'));
    await waitFor(() => expect(screen.getByText('范围：项目 PRJ-2026-01')).toBeTruthy());
    fireEvent.click(screen.getByText('清除'));
    await waitFor(() => expect(screen.getByText('范围：全部合同')).toBeTruthy());
  });

  it('加载失败显示错误不炸', async () => {
    fetchGapsMock.mockRejectedValueOnce(new Error('请求失败（500）'));
    render(<GapsPanel />);
    await waitFor(() => expect(screen.getByText(/请求失败（500）/)).toBeTruthy());
  });
});
