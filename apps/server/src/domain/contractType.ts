// 合同类型派生(spec 2026-08-20 §3.2)。纯函数: 台账写回、复核快照、图提交三处
// 消费同一规则, 保证不漂移(与 deriveProposedEdges 同原则)。
// 优先级: 合同类型字段 > 非方向标题关键词(物流/租赁/服务) > 主体侧别 > 方向标题关键词。
// '购销合同' 这类无方向写法有意不映射 —— 方向留给确定性锚点(主体侧别)。
import { resolveSelfSide, type PartySide } from './flowDirection.js';
import { TRADE_VOCAB, type ContractType, type TradeVocabulary } from './tradeSemantics.js';

export type ContractTypeSource = 'field' | 'side' | 'keyword';

export interface ContractTypeDerivation {
  contractType: ContractType | null;
  source: ContractTypeSource | null;
  /** 字段与主体侧别的采购/销售方向相反时 true(复核卡黄条)。 */
  conflict: boolean;
}

/** 最小字段投影(ExtractedField 与 ReviewSnapshot.fields 均满足)。 */
export interface ContractTypeFieldInput {
  name: string;
  value: string | number;
}

/** 无方向语义的类型: 标题命中时优先于主体侧别, 也不参与冲突判定。 */
const NON_DIRECTIONAL: readonly ContractType[] = ['物流', '租赁', '服务'];

function matchKeyword(title: string, vocab: TradeVocabulary): ContractType | null {
  if (!title) return null;
  for (const [type, words] of Object.entries(vocab.contractTypeKeywords) as Array<
    [Exclude<ContractType, '其他'>, readonly string[]]
  >) {
    if (words.some((w) => title.includes(w))) return type;
  }
  return null;
}

export function deriveContractType(args: {
  docType: string;
  fields: ContractTypeFieldInput[];
  selfPartyNames: string[];
  vocab?: TradeVocabulary;
}): ContractTypeDerivation {
  const vocab = args.vocab ?? TRADE_VOCAB;
  if (args.docType !== '合同') return { contractType: null, source: null, conflict: false };

  const byName = new Map(
    args.fields.map((f) => [f.name, typeof f.value === 'string' ? f.value.trim() : String(f.value)]),
  );

  // 主体侧别(确定性): 买方|甲方 / 卖方|乙方 锚点哪侧命中主体名单。
  const side: PartySide | null = resolveSelfSide(args.selfPartyNames, {
    buyer: byName.get('买方') ?? byName.get('甲方') ?? '',
    seller: byName.get('卖方') ?? byName.get('乙方') ?? '',
  });
  const sideType = side ? vocab.contractTypeBySide[side] : null;

  // 文档自带 合同类型 字段(受控值或别名映射; 人工修正以 confidence 1.0 落此字段)。
  const raw = byName.get('合同类型') ?? '';
  const fieldType = raw
    ? vocab.contractTypeByAlias[raw] ??
      (vocab.contractTypes.includes(raw as ContractType) ? (raw as ContractType) : null)
    : null;

  // 标题关键词: 非方向类型(物流/租赁/服务)优先于侧别, 方向类型(采购/销售)最后兜底。
  const keywordType = matchKeyword(byName.get('合同名称') ?? byName.get('标的物') ?? '', vocab);
  const keywordNonDirectional =
    keywordType && NON_DIRECTIONAL.includes(keywordType) ? keywordType : null;

  const contractType = fieldType ?? keywordNonDirectional ?? sideType ?? keywordType ?? null;
  const source =
    contractType === null
      ? null
      : fieldType !== null
        ? 'field'
        : contractType === keywordNonDirectional
          ? 'keyword'
          : contractType === sideType
            ? 'side'
            : 'keyword';
  // 冲突只看方向类型交叉(字段销售/侧别采购 这类); 物流等非方向类型不算。
  const conflict =
    fieldType !== null &&
    sideType !== null &&
    fieldType !== sideType &&
    (fieldType === '采购' || fieldType === '销售') &&
    (sideType === '采购' || sideType === '销售');

  return { contractType, source, conflict };
}
