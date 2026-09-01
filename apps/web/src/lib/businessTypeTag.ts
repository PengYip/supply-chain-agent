// 已解析业务类型的标签配色 SSOT: 按业务族群区分色系,但文本始终展示服务端
// 识别出的完整类型,避免把「轨道衡称重单」这类精确结果弱化成泛化标签。
// 文件树行(shell/FileTree)与复核卡拆分清单(DocumentReviewCard)共用。

export const BUSINESS_TYPE_TAG_STYLES: Array<{ types: string[]; className: string }> = [
  {
    types: ['合同', '补充合同', '立项书', '履约凭证'],
    className: 'border-[#F0D9B0] bg-[#FFFBF3] text-[#B45309]',
  },
  {
    types: ['发票', '发票凭证', '进项票', '销项票'],
    className: 'border-[#C7D6E3] bg-[#F5F8FF] text-[#1D4ED8]',
  },
  {
    types: [
      '提单', '装箱单', '货转单', '运输凭证', '收货单', '发货单',
      '汽运磅单', '火运大票', '轨道衡称重单', '水尺计重单', '派船通知单',
    ],
    className: 'border-[#B8DCE4] bg-[#F2FAFC] text-[#0E7490]',
  },
  {
    types: ['重量凭证'],
    className: 'border-[#CBD5E1] bg-[#F8FAFC] text-[#475569]',
  },
  {
    types: ['质检报告', '化验报告'],
    className: 'border-[#F2CEE0] bg-[#FEF5FA] text-[#BE185D]',
  },
  {
    types: ['结算单'],
    className: 'border-[#DDD0F0] bg-[#FAF7FF] text-[#7C3AED]',
  },
  {
    types: ['资金凭证', '付款单', '付款凭证'],
    className: 'border-[#CBE5D3] bg-[#F4FAF5] text-[#15803D]',
  },
  {
    // 单据组 = 批量拆分容器(一个物理文件拆成多份子单据),是结构概念而非
    // 业务类型: 取主色族的钢蓝灰 + 虚线边,与七个业务族群色系区分,读作
    // 「装载多份单据的容器」。
    types: ['单据组'],
    className: 'border-dashed border-[#A9BCCD] bg-[#F2F6FA] text-[#35719C]',
  },
];

/** 其他 = 上传兜底类型,不代表识别成功,因此不渲染业务类型标签。 */
export function businessTypeTag(
  businessType?: string | null,
): { text: string; className: string } | null {
  const text = businessType?.trim();
  if (!text || text === '其他') return null;
  const className =
    BUSINESS_TYPE_TAG_STYLES.find((entry) => entry.types.includes(text))?.className ??
    'border-line bg-surface text-ink-soft';
  return { text, className };
}
