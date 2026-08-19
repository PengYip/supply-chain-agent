// 方向语义(domain/flowDirection): 本公司主体判定 + 四流方向推导。
//
// 供应链四流(货/资/票)的方向以"本公司是谁"为基准: 凭证锚点里的 buyer/seller
// 哪一侧命中本公司主体名单(env.SELF_PARTY_NAMES, 逗号分隔), 决定这笔业务对
// 我方是 收(in) 还是 付/发/开(out)。锚点语义来自 schemas/vouchers.ts 的
// extractAnchors 与 bindingProposal 的 buildAnchorsFromFields:
//   - 付款凭证: buyer=付款人, seller=收款人
//   - 货转单:   buyer=买方(收货), seller=卖方(发货)
//   - 发票类:   buyer=受票方(进项), seller=开票方(销项)
// 匹配规则: 去除全部空白(含全角)+拉丁大写后精确相等; 不做模糊匹配——OCR 的
// 写法变体请在名单里多列别名。方向判定宁可 unknown 不可猜。

export type PartySide = 'buyer' | 'seller';

/** 流方向, 以本公司为基准: in = 收(款/货/票), out = 付(款)/发(货)/开(票)。 */
export type FlowDirection = 'in' | 'out';

/** 方向判定的最小锚点投影(与 VoucherAnchors 的 buyer/seller 兼容)。 */
export interface DirectionAnchors {
  buyer?: string;
  seller?: string;
}

/** 公司名归一化: 去全部空白(含全角空格) + 拉丁字母大写; 不做其他模糊化。 */
export function normalizeCompanyName(name: string): string {
  return name.replace(/\s+/g, '').toUpperCase();
}

/** 解析 env.SELF_PARTY_NAMES(逗号分隔原始串)为归一化后的主体名单。 */
export function parseSelfPartyNames(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => normalizeCompanyName(s))
    .filter(Boolean);
}

/**
 * 判定本公司主体在凭证锚点的哪一侧。名单为空、两侧都未命中、或两侧同时
 * 命中(数据异常)时返回 null——方向未知, 上游应跳过方向语义而不是猜测。
 */
export function resolveSelfSide(
  selfPartyNames: string[],
  anchors: DirectionAnchors,
): PartySide | null {
  const names = new Set(selfPartyNames.map(normalizeCompanyName).filter(Boolean));
  if (names.size === 0) return null;
  const buyer = anchors.buyer ? normalizeCompanyName(anchors.buyer) : '';
  const seller = anchors.seller ? normalizeCompanyName(anchors.seller) : '';
  const buyerHit = buyer !== '' && names.has(buyer);
  const sellerHit = seller !== '' && names.has(seller);
  if (buyerHit === sellerHit) return null;
  return buyerHit ? 'buyer' : 'seller';
}

/** 资金流方向: 付款人(buyer 侧)付出 out, 收款人(seller 侧)收进 in。 */
export function moneyDirectionFor(side: PartySide): FlowDirection {
  return side === 'buyer' ? 'out' : 'in';
}

/** 货物流方向: 买方(buyer 侧)收货 in, 卖方(seller 侧)发货 out。 */
export function goodsDirectionFor(side: PartySide): FlowDirection {
  return side === 'buyer' ? 'in' : 'out';
}

/** 发票流方向: 受票方(buyer 侧)收票进项 in, 开票方(seller 侧)开票销项 out。 */
export function invoiceDirectionFor(side: PartySide): FlowDirection {
  return side === 'buyer' ? 'in' : 'out';
}
