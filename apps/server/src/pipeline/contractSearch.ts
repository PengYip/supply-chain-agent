// 合同台账搜索纯逻辑(spec 2026-08-26 §4.1): SQL 粗筛后的 JS 精排与打分。
// 依赖方向: contractSearch -> bindingProposal -> contractLedger, 无环。
import { normalizeContractNo, type ContractLedgerEntry } from './contractLedger.js';
import { matchEntity } from './bindingProposal.js';

export type ContractSearchField = 'contractNo' | 'buyer' | 'seller' | 'title';

export interface ContractSearchItem {
  contractNo: string;
  displayContractNo: string;
  title: string;
  buyer: string | null;
  seller: string | null;
  docType: string;
  overallConfidence: number;
  matchedField: ContractSearchField;
}

/** fields JSON 里的主体键: 买方侧优先 买方 回退 甲方(销售合同视角), 卖方同理。 */
const BUYER_KEYS = ['买方', '甲方'] as const;
const SELLER_KEYS = ['卖方', '乙方'] as const;

export function extractLedgerParty(
  entry: Pick<ContractLedgerEntry, 'fields'>,
  side: 'buyer' | 'seller',
): string | null {
  const keys = side === 'buyer' ? BUYER_KEYS : SELLER_KEYS;
  for (const k of keys) {
    const v = entry.fields[k]?.value;
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  }
  return null;
}

/**
 * 单条目打分(优先级从高到低, 命中即返回):
 * - 归一化合同号: 精确 1 / 前缀 0.95 / 包含 0.9
 * - displayContractNo 原文包含 0.85(兼容全角连字符等归一化会丢的输入)
 * - 买方/卖方: matchEntity(精确 1 / 包含 0.9 / 字符重合 0.75), 阈值 0.75
 * - 标题包含 0.6
 */
export function matchContractQuery(
  q: string,
  entry: ContractLedgerEntry,
): { field: ContractSearchField; score: number } | null {
  const raw = q.trim();
  if (!raw) return null;
  const nq = normalizeContractNo(raw);
  if (nq) {
    if (entry.contractNo === nq) return { field: 'contractNo', score: 1 };
    if (entry.contractNo.startsWith(nq)) return { field: 'contractNo', score: 0.95 };
    if (entry.contractNo.includes(nq)) return { field: 'contractNo', score: 0.9 };
  }
  const rawLower = raw.toLowerCase();
  if (entry.displayContractNo.toLowerCase().includes(rawLower)) {
    return { field: 'contractNo', score: 0.85 };
  }
  const buyer = extractLedgerParty(entry, 'buyer');
  if (buyer) {
    const m = matchEntity(raw, buyer);
    if (m >= 0.75) return { field: 'buyer', score: m };
  }
  const seller = extractLedgerParty(entry, 'seller');
  if (seller) {
    const m = matchEntity(raw, seller);
    if (m >= 0.75) return { field: 'seller', score: m };
  }
  if (entry.title && entry.title.toLowerCase().includes(rawLower)) {
    return { field: 'title', score: 0.6 };
  }
  return null;
}

export function toSearchItem(
  entry: ContractLedgerEntry,
  matchedField: ContractSearchField,
): ContractSearchItem {
  return {
    contractNo: entry.contractNo,
    displayContractNo: entry.displayContractNo,
    title: entry.title,
    buyer: extractLedgerParty(entry, 'buyer'),
    seller: extractLedgerParty(entry, 'seller'),
    docType: entry.docType,
    overallConfidence: entry.overallConfidence,
    matchedField,
  };
}

/** entries 需按 updated_at DESC 预排(SQL 层保证): 稳定排序使同分保持近者优先。 */
export function rankContractSearch(
  q: string,
  entries: ContractLedgerEntry[],
  limit: number,
): ContractSearchItem[] {
  const scored: Array<{ score: number; item: ContractSearchItem }> = [];
  for (const e of entries) {
    const m = matchContractQuery(q, e);
    if (!m) continue;
    scored.push({ score: m.score, item: toSearchItem(e, m.field) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.item);
}