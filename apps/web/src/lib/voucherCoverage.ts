/* ---------- 凭证齐套率纯函数(项目台账视图) ----------
 *
 * 口径: 一份合同的「齐套」= 五个履约维度各有至少一张已确认绑定的凭证。
 * 维度集合是对模板层激活 binds/settles 词表(引用/货权转移/付款/质检/收货/
 * 发货/收票/开票...)的前端归纳, 与项目 rollup 的六向流水(资金/发票/货物)
 * 对齐并补齐「合同文本/质检」两维。后端暂无「每类合同应有哪些凭证」的
 * 模板数据, 故五维对所有合同类型统一口径, 不区分采购/销售预期差异。
 *
 * 映射顺序: relation(绑定词, 含方向编码 settles 词)优先, 其次 docType 兜底。
 * 两个都映射不到(如 其他/凭证)不计入任何维度, 不虚增齐套率。
 */

export type VoucherDimensionKey = 'contract' | 'goods' | 'fund' | 'invoice' | 'quality';

export interface VoucherDimension {
  key: VoucherDimensionKey;
  label: string;
}

export const VOUCHER_DIMENSIONS: readonly VoucherDimension[] = [
  { key: 'contract', label: '合同文本' },
  { key: 'goods', label: '货权' },
  { key: 'fund', label: '资金' },
  { key: 'invoice', label: '发票' },
  { key: 'quality', label: '质检' },
];

/** 绑定 relation -> 维度(对齐 templateSeed 的激活词表)。 */
const RELATION_DIMENSION: Record<string, VoucherDimensionKey> = {
  引用: 'contract',
  货权转移: 'goods',
  收货: 'goods',
  发货: 'goods',
  付款: 'fund',
  收款: 'fund',
  付款申请: 'fund',
  收票: 'invoice',
  开票: 'invoice',
  质检: 'quality',
};

/** docType -> 维度(对齐模板 doc_type 种子 v2 的类型树)。 */
const DOC_TYPE_DIMENSION: Record<string, VoucherDimensionKey> = {
  合同: 'contract',
  补充合同: 'contract',
  货转单: 'goods',
  提单: 'goods',
  装箱单: 'goods',
  收货单: 'goods',
  发货单: 'goods',
  汽运磅单: 'goods',
  火运大票: 'goods',
  派船通知单: 'goods',
  运输凭证: 'goods',
  付款凭证: 'fund',
  付款单: 'fund',
  资金凭证: 'fund',
  发票: 'invoice',
  进项票: 'invoice',
  销项票: 'invoice',
  发票凭证: 'invoice',
  化验报告: 'quality',
  质检报告: 'quality',
};

/** 单条凭证条目: 调用方保证只传已确认绑定(齐套只认 confirmed)。 */
export interface VoucherEntry {
  relation: string;
  docType: string;
}

/** relation 优先、docType 兜底; 都未登记返回 null(不计入任何维度)。 */
export function dimensionOfEntry(entry: VoucherEntry): VoucherDimensionKey | null {
  return RELATION_DIMENSION[entry.relation] ?? DOC_TYPE_DIMENSION[entry.docType] ?? null;
}

export interface VoucherCoverage {
  /** 已覆盖的维度集合。 */
  covered: ReadonlySet<VoucherDimensionKey>;
  /** 未覆盖维度的中文标签(展示用, 顺序与 VOUCHER_DIMENSIONS 一致)。 */
  missingLabels: string[];
  /** 齐套率 0-1(covered / 全部维度数)。 */
  ratio: number;
}

/** 聚合一组合同的凭证条目 -> 维度覆盖。 */
export function coverageOf(entries: readonly VoucherEntry[]): VoucherCoverage {
  const covered = new Set<VoucherDimensionKey>();
  for (const e of entries) {
    const d = dimensionOfEntry(e);
    if (d) covered.add(d);
  }
  const missingLabels = VOUCHER_DIMENSIONS.filter((d) => !covered.has(d.key)).map((d) => d.label);
  const ratio = VOUCHER_DIMENSIONS.length === 0 ? 0 : covered.size / VOUCHER_DIMENSIONS.length;
  return { covered, missingLabels, ratio };
}

/** 每维度计数(卡片 chips 展示: 覆盖维度给张数, 未覆盖给 0)。 */
export function countByDimension(entries: readonly VoucherEntry[]): Map<VoucherDimensionKey, number> {
  const counts = new Map<VoucherDimensionKey, number>();
  for (const e of entries) {
    const d = dimensionOfEntry(e);
    if (d) counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  return counts;
}
