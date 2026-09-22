// @vitest-environment jsdom
// GapsPanel 渲染冒烟(business-loop Wave 4)：四块 tiles(含 null 待登记弱化态) /
// 四组明细行(code+basis+口径提示角标) / checks 默认收起可展开 / projectNo
// 过滤显式应用触发重取。API 层 vi.mock，纯前端行为不依赖后端。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { GapsPanel } from './GapsPanel';
import type { GapContractRowDTO, GapsReportDTO } from '../../api/ontology';

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

describe('GapsPanel ④⑥ 负值语义角标 (wave7 sweep)', () => {
  it('④ 负值出「预收」、⑥ 负值出「超收」', async () => {
    fetchGapsMock.mockResolvedValue(fixture({
      groups: [
        {
          key: 'recv', label: '应收缺口', desc: '销售侧结算/发货/开票与收款的勾稽',
          items: [
            { code: '④', label: '结算未收', amt: -15000.5, basis: 'Σ销结算 − Σ收款' },
            { code: '⑥', label: '开票未收', amt: -300, basis: '净销项 − Σ收款' },
          ],
        },
      ],
    }));
    render(<GapsPanel />);
    await waitFor(() => expect(screen.getByText('结算未收')).toBeTruthy());
    expect(screen.getByText('预收')).toBeTruthy();
    expect(screen.getByText('超收')).toBeTruthy();
    // 角标带语义 hint tooltip(收款超结算 / 收款超开票)。
    expect(screen.getByText('预收').getAttribute('title')).toBe('收款超结算');
    expect(screen.getByText('超收').getAttribute('title')).toBe('收款超开票');
  });

  it('正值 / 空值不出角标', async () => {
    fetchGapsMock.mockResolvedValue(fixture({
      groups: [
        {
          key: 'recv', label: '应收缺口', desc: '销售侧结算/发货/开票与收款的勾稽',
          items: [
            { code: '④', label: '结算未收', amt: 5000, basis: 'Σ销结算 − Σ收款' },
            { code: '⑥', label: '开票未收', amt: null, basis: '净销项 − Σ收款', missingInputs: ['销项金额'] },
          ],
        },
      ],
    }));
    render(<GapsPanel />);
    await waitFor(() => expect(screen.getByText('结算未收')).toBeTruthy());
    expect(screen.queryByText('预收')).toBeNull();
    expect(screen.queryByText('超收')).toBeNull();
    // 空值行显示待登记弱化态, 同样无角标。
    expect(screen.getAllByText('待登记').length).toBeGreaterThan(0);
  });
});

// Wave 8 T3: 按合同下钻区块(consumes T2 report.contracts)。
function contractRow(overrides: Partial<GapContractRowDTO> = {}): GapContractRowDTO {
  return {
    contractNo: 'XYRL-2022-225',
    side: 'buy',
    receiptsQty: 3357.46,
    deliveriesQty: 0,
    settlements: 3460988,
    invoicesIn: 300000,
    invoicesOut: 0,
    payments: 250000,
    collections: 0,
    receiptsQtyMissing: false,
    deliveriesQtyMissing: false,
    paymentsMissing: false,
    ...overrides,
  };
}

describe('GapsPanel 按合同下钻 (wave8)', () => {
  it('默认收起, 展开后渲染合同行与七列量额(千分位)', async () => {
    fetchGapsMock.mockResolvedValue(fixture({
      contracts: [
        contractRow(),
        contractRow({
          contractNo: 'GMNH-JBKZ-2025', side: 'sell', receiptsQty: 0, deliveriesQty: 2156.2,
          settlements: 1988765.4, invoicesIn: 0, invoicesOut: 1800000, payments: 0, collections: 950000,
        }),
      ],
    }));
    render(<GapsPanel />);
    await waitFor(() => expect(screen.getByText('按合同')).toBeTruthy());
    // 头部计数(2 份), 默认收起: 表格不渲染。
    expect(screen.getByText('2 份')).toBeTruthy();
    expect(screen.queryByTestId('gaps-contracts')!.querySelector('table')).toBeNull();
    fireEvent.click(screen.getByText('按合同'));
    // 行内容: 合同号 + 数值千分位(吨/额列各抽一个)。
    expect(await screen.findByText('XYRL-2022-225')).toBeTruthy();
    expect(screen.getByText('GMNH-JBKZ-2025')).toBeTruthy();
    expect(screen.getAllByText('3,357.46').length).toBeGreaterThan(0);
    expect(screen.getAllByText('1,988,765.4').length).toBeGreaterThan(0);
    // 列头齐全(收货量/发货量/结算/进项/销项/付款/收款)。
    for (const h of ['收货量', '发货量', '结算', '进项', '销项', '付款', '收款']) {
      expect(screen.getByText(h, { selector: 'th' })).toBeTruthy();
    }
  });

  it('侧别徽标: buy=购 / sell=销 / null=未定侧(带无法判定 tooltip)', async () => {
    fetchGapsMock.mockResolvedValue(fixture({
      contracts: [
        contractRow(),
        contractRow({ contractNo: 'C-SELL', side: 'sell' }),
        contractRow({ contractNo: 'C-99', side: null, receiptsQty: 120.5, receiptsQtyMissing: true }),
      ],
    }));
    render(<GapsPanel />);
    await waitFor(() => expect(screen.getByText('按合同')).toBeTruthy());
    fireEvent.click(screen.getByText('按合同'));
    expect(await screen.findByText('C-99')).toBeTruthy();
    // 徽标文本精确匹配(购/销 为单字, 不与组描述里的采购/销售串匹配)。
    expect(screen.getByText('购', { selector: 'span' })).toBeTruthy();
    expect(screen.getByText('销', { selector: 'span' })).toBeTruthy();
    const unknown = screen.getByText('未定侧');
    expect(unknown.getAttribute('title')).toContain('合同侧别无法判定');
  });

  it('missing 口径: 数值照显但弱化, 挂「缺」角标 + tooltip; 无 missing 列不出角标', async () => {
    fetchGapsMock.mockResolvedValue(fixture({
      contracts: [
        contractRow({ paymentsMissing: true, receiptsQtyMissing: true }),
      ],
    }));
    render(<GapsPanel />);
    await waitFor(() => expect(screen.getByText('按合同')).toBeTruthy());
    fireEvent.click(screen.getByText('按合同'));
    expect(await screen.findByText('XYRL-2022-225')).toBeTruthy();
    // 两处 missing(收货量+付款) -> 两个「缺」角标, tooltip 点明口径与不可信。
    const chips = screen.getAllByText('缺');
    expect(chips.length).toBe(2);
    const titles = chips.map((el) => el.getAttribute('title') ?? '');
    expect(titles.some((t) => t.includes('收货量口径缺输入'))).toBe(true);
    expect(titles.some((t) => t.includes('付款口径缺输入'))).toBe(true);
    expect(titles.every((t) => t.includes('不可作对账依据'))).toBe(true);
    // 数值照显(不归零不隐藏)。
    expect(screen.getAllByText('3,357.46').length).toBeGreaterThan(0);
  });

  it('空态安静不占位: contracts 缺省或空数组 -> 区块整块不渲染', async () => {
    // 缺省(beforeEach 默认 fixture 无 contracts 字段, 兼容旧响应形状)
    render(<GapsPanel />);
    await waitFor(() => expect(screen.getByText('存货结存')).toBeTruthy());
    expect(screen.queryByText('按合同')).toBeNull();
    cleanup();
    // 显式空数组
    fetchGapsMock.mockResolvedValueOnce(fixture({ contracts: [] }));
    render(<GapsPanel />);
    await waitFor(() => expect(screen.getByText('存货结存')).toBeTruthy());
    expect(screen.queryByText('按合同')).toBeNull();
  });

  it('projectNo 过滤联动: 区块头部注明范围', async () => {
    fetchGapsMock.mockResolvedValue(fixture({
      scope: 'PRJ-2026-01',
      contracts: [contractRow()],
    }));
    render(<GapsPanel />);
    await waitFor(() => expect(screen.getByText('按合同')).toBeTruthy());
    expect(screen.getByText(/1 份 · 项目 PRJ-2026-01/)).toBeTruthy();
  });
});
