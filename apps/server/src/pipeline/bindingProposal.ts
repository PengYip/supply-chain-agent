// Phase B: 凭证绑定 proposal 生成器(纯函数, 无 DB 依赖)。
//
// 凭证入库时自动生成"绑定建议": 锚点(extractAnchors) -> 与 contract_ledger 匹配
// -> 多锚点评分 -> 阈值路由:
//   - auto_rule: 单据自带合同号与 ledger 精确匹配 -> 直接落 confirmed
//   - human:     推断分 >= 0.75 且与次高分差距 >= 0.05 -> 落 proposed 等人工确认
//   - none:      分数低或候选歧义 -> 不落 binding 行
//
// 关键实测约束: VLM 提取有非确定性(同一凭证两次提取出现"南证能源"vs"南征能源"),
// 实体匹配必须模糊容错(matchEntity), 不能精确字符串匹配。

import type { VoucherAnchors } from './schemas/vouchers.js';

// LedgerEntry 使用 contractLedger.ts 的真实形状(ContractLedgerEntry): fields 为
// Record<字段名, { value, sourceSpans }>, 合同字段按 ContractSchema 命名
// (甲方/乙方/数量/金额/签订日), 兼容可能的 买方/卖方 变体。
export interface LedgerFieldEntry {
  value: string | number;
  sourceSpans: unknown[];
}

/** 生成器所需的 ledger 子集(结构化兼容 ContractLedgerEntry)。 */
export interface LedgerEntryLike {
  contractNo: string;
  fields: Record<string, LedgerFieldEntry>;
}

export type BindingRoute = 'auto_rule' | 'human' | 'none';

export interface BindingEvidence {
  partyScore: number;
  timeScore: number;
  amountScore: number;
  qtyScore: number;
  details: string[];
}

export interface BindingProposal {
  contractNo: string;
  score: number;
  route: BindingRoute;
  evidence: BindingEvidence;
}

// ---- (a) 日期解析 ------------------------------------------------------------

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 解析单个日期(ISO/斜杠/紧凑/中文), 返回 'YYYY-MM-DD' 或 null。 */
function parseSingleDate(s: string): string | null {
  const t = s.trim();
  if (t.length === 0) return null;
  // ISO / 斜杠: 2023-04-11 | 2023/04/18 22:02(时间后缀忽略)。
  const iso = t.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T].*)?$/);
  if (iso) {
    const y = Number(iso[1]);
    const m = Number(iso[2]);
    const d = Number(iso[3]);
    if (y > 1900 && y < 2200 && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return `${y}-${pad2(m)}-${pad2(d)}`;
    }
    return null;
  }
  // 紧凑: 20230411
  const compact = t.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) {
    const y = Number(compact[1]);
    const m = Number(compact[2]);
    const d = Number(compact[3]);
    if (y > 1900 && y < 2200 && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return `${y}-${pad2(m)}-${pad2(d)}`;
    }
    return null;
  }
  // 中文: 2023年3月24日
  const cn = t.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日?$/);
  if (cn) {
    const y = Number(cn[1]);
    const m = Number(cn[2]);
    const d = Number(cn[3]);
    if (y > 1900 && y < 2200 && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return `${y}-${pad2(m)}-${pad2(d)}`;
    }
    return null;
  }
  return null;
}

/**
 * 中文/ISO 日期与区间解析。支持 "2023-04-11"、"20230411"、"2023年3月24日"、
 * "2023年3月24日-2023年3月27日"、"2023/04/18 22:02" 等。返回 ISO 日期
 * min/max(无区间则 min==max); 无法解析返回 null。
 */
export function parseCnDate(s: string): { min: string; max: string } | null {
  const t = s.trim();
  if (t.length === 0) return null;

  const direct = parseSingleDate(t);
  if (direct) return { min: direct, max: direct };

  // 区间分隔: 至/~ / —/–, 或 '-' (逐一尝试每个连字符位置)。
  const parts = t
    .split(/[至~—–]/u)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length >= 2) {
    const a = parseSingleDate(parts[0]!);
    const b = parseSingleDate(parts[1]!);
    if (a && b) return a <= b ? { min: a, max: b } : { min: b, max: a };
    return null;
  }
  for (let i = 1; i < t.length; i++) {
    if (t[i] !== '-') continue;
    const left = parseSingleDate(t.slice(0, i));
    const right = parseSingleDate(t.slice(i + 1));
    if (left && right) return left <= right ? { min: left, max: right } : { min: right, max: left };
  }
  return null;
}

// ---- (b) 主体模糊匹配 --------------------------------------------------------

/**
 * 实体名归一化: 去空白(含全角)、全角括号->半角、剥离括号段(如 (海南) 保留核心)、
 * 去公司后缀(有限公司/股份有限公司/有限责任公司/集团公司)。小写。
 */
export function normalizeEntityName(s: string): string {
  return s
    .replace(/[\s\u3000]+/g, '')
    .replace(/[（）]/g, (m) => (m === '（' ? '(' : ')'))
    .replace(/\([^)]*\)/g, '')
    .replace(/(有限公司|股份有限公司|有限责任公司|集团公司)$/u, '')
    .toLowerCase();
}

/**
 * 主体模糊匹配打分 0..1:
 * - 归一化后完全相等 1.0
 * - 一方包含另一方 0.9
 * - 核心段字符重合率 >= 0.7 且长度差 <= 2 -> 0.75(覆盖 南证/南征 单字差异)
 * - 否则 0
 */
export function matchEntity(a: string, b: string): number {
  const na = normalizeEntityName(a);
  const nb = normalizeEntityName(b);
  if (na.length === 0 || nb.length === 0) return 0;
  if (na === nb) return 1.0;
  if (na.includes(nb) || nb.includes(na)) return 0.9;
  if (Math.abs(na.length - nb.length) <= 2) {
    const shorter = na.length <= nb.length ? na : nb;
    const longer = na.length <= nb.length ? nb : na;
    let hits = 0;
    for (const ch of shorter) if (longer.includes(ch)) hits++;
    if (hits / longer.length >= 0.7) return 0.75;
  }
  return 0;
}

// ---- (c) 评分维度 ------------------------------------------------------------

function strField(fields: Record<string, LedgerFieldEntry>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = fields[k]?.value;
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  }
  return undefined;
}

function numField(fields: Record<string, LedgerFieldEntry>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = fields[k]?.value;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
      const n = Number(v.replace(/[,，\s]/g, ''));
      if (Number.isFinite(n)) return n;
    }
  }
  return undefined;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function isoToMs(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getTime();
}

/** 主体锚点评分(方向对: 凭证买方<->台账买方, 凭证卖方<->台账卖方; 错向=0)。 */
function scoreParty(
  anchors: VoucherAnchors,
  fields: Record<string, LedgerFieldEntry>,
): { score: number; detail: string } {
  const vb = anchors.buyer;
  const vs = anchors.seller;
  const lb = strField(fields, ['买方', '甲方']);
  const ls = strField(fields, ['卖方', '乙方']);

  if (!vb && !vs) return { score: 0.5, detail: '凭证缺少买卖双方锚点，中性分' };
  if (!lb && !ls) return { score: 0.5, detail: '合同台账缺少双方字段，中性分' };

  if (vb && vs && lb && ls) {
    const bB = matchEntity(vb, lb);
    const bS = matchEntity(vb, ls);
    const sB = matchEntity(vs, lb);
    const sS = matchEntity(vs, ls);
    const dirScore = (bB + sS) / 2;
    const crossScore = (bS + sB) / 2;
    if (dirScore < crossScore) {
      return { score: 0, detail: '买卖方向错配(凭证双方与台账双方反向匹配)' };
    }
    return {
      score: dirScore,
      detail: `买方匹配 ${bB.toFixed(2)}，卖方匹配 ${sS.toFixed(2)}`,
    };
  }

  // 单侧锚点: 无法判定方向, 取该侧与台账对应方(或缺位时另一侧)的最佳匹配。
  if (vb) {
    const target = lb ?? ls;
    if (!target) return { score: 0.5, detail: '合同台账缺少双方字段，中性分' };
    const s = matchEntity(vb, target);
    return { score: s, detail: lb ? `买方匹配 ${s.toFixed(2)}` : `买方与台账卖方匹配 ${s.toFixed(2)}(台账缺买方)` };
  }
  const target = ls ?? lb;
  if (!target) return { score: 0.5, detail: '合同台账缺少双方字段，中性分' };
  const s = matchEntity(vs!, target);
  return { score: s, detail: ls ? `卖方匹配 ${s.toFixed(2)}` : `卖方与台账买方匹配 ${s.toFixed(2)}(台账缺卖方)` };
}

/** 时间锚点评分: 凭证日期落在 [签订日-30天, 交货期max+30天] 内 -> 0.9, 否则 0.1。 */
function scoreTime(
  anchors: VoucherAnchors,
  fields: Record<string, LedgerFieldEntry>,
): { score: number; detail: string } {
  const vd = anchors.date;
  const voucherRange = vd ? parseCnDate(vd) : null;
  if (!voucherRange) return { score: 0.5, detail: '凭证日期无法解析，中性分' };

  const sign = strField(fields, ['签订日', '签署日期', '签约日期']);
  const signRange = sign ? parseCnDate(sign) : null;
  if (!signRange) return { score: 0.5, detail: '合同签订日无法解析，中性分' };

  const delivery = strField(fields, ['合同交货期', '交货日期', '交货期', '生效日']);
  const delRange = delivery ? parseCnDate(delivery) : null;

  const lowerMs = isoToMs(signRange.min) - 30 * DAY_MS;
  const upperRefMs = delRange ? isoToMs(delRange.max) : isoToMs(signRange.max);
  const upperMs = upperRefMs + 30 * DAY_MS;
  const vMin = isoToMs(voucherRange.min);
  const vMax = isoToMs(voucherRange.max);

  const within = vMin >= lowerMs && vMax <= upperMs;
  return {
    score: within ? 0.9 : 0.1,
    detail: within
      ? `凭证日期 ${vd} 在合同时间窗内(${signRange.min} ±30天)`
      : `凭证日期 ${vd} 超出合同时间窗 [${new Date(lowerMs).toISOString().slice(0, 10)}, ${new Date(upperMs).toISOString().slice(0, 10)}]`,
  };
}

/** 金额锚点评分: |凭证-合同|/合同 <= 0.2 -> 0.8, 否则 0.2; 任一侧缺失中性 0.5。 */
function scoreAmount(
  anchors: VoucherAnchors,
  fields: Record<string, LedgerFieldEntry>,
): { score: number; detail: string } {
  const ledger = numField(fields, ['金额', '合同金额', '总金额']);
  const v = anchors.amount;
  if (ledger === undefined || v === undefined) {
    return { score: 0.5, detail: '金额锚点或合同金额缺失，中性分' };
  }
  if (ledger === 0) return { score: 0.5, detail: '合同金额为 0，中性分' };
  const ratio = Math.abs(v - ledger) / ledger;
  return {
    score: ratio <= 0.2 ? 0.8 : 0.2,
    detail: `凭证金额 ${v} vs 合同金额 ${ledger}(偏差 ${(ratio * 100).toFixed(1)}%)`,
  };
}

/** 数量锚点评分: |凭证-合同|/合同 <= 0.1 -> 0.8, 否则 0.2; 任一侧缺失中性 0.5。 */
function scoreQty(
  anchors: VoucherAnchors,
  fields: Record<string, LedgerFieldEntry>,
): { score: number; detail: string } {
  const ledger = numField(fields, ['数量', '合同数量', '数量_吨']);
  const v = anchors.quantityTon;
  if (ledger === undefined || v === undefined) {
    return { score: 0.5, detail: '数量锚点或合同数量缺失，中性分' };
  }
  if (ledger === 0) return { score: 0.5, detail: '合同数量为 0，中性分' };
  const ratio = Math.abs(v - ledger) / ledger;
  return {
    score: ratio <= 0.1 ? 0.8 : 0.2,
    detail: `凭证数量 ${v} vs 合同数量 ${ledger}(偏差 ${(ratio * 100).toFixed(1)}%)`,
  };
}

// ---- (c) 生成器 --------------------------------------------------------------

/** 首个非空字段值(转 string)。 */
function firstStr(fields: Record<string, { value: string | number }>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = fields[k]?.value;
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return undefined;
}

/** 首个可解析为有限数的字段。 */
function firstNum(fields: Record<string, { value: string | number }>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = fields[k]?.value;
    if (v === undefined || v === null || String(v).trim() === '') continue;
    const n = Number(String(v).replace(/[,\s]/g, ''));
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/**
 * 通用文档(发票/提单/装箱单等, 无专用 voucher schema)的抽取字段 -> 绑定锚点。
 * 字段名取自抽取器约定(domain/tradeSemantics.ts REL_ROLE_BY_FIELD / KEY_FIELDS):
 * 三类图片凭证走 extractAnchors, 不要用本函数替代。
 */
export function buildAnchorsFromFields(
  _docType: string,
  fields: Record<string, { value: string | number }>,
): VoucherAnchors {
  const anchors: VoucherAnchors = {};
  const contractNo = firstStr(fields, ['合同号', '合同编号']);
  if (contractNo) anchors.contractNo = contractNo;
  const buyer = firstStr(fields, ['买方', '甲方', '收货人']);
  if (buyer) anchors.buyer = buyer;
  const seller = firstStr(fields, ['卖方', '乙方', '发货人']);
  if (seller) anchors.seller = seller;
  const date = firstStr(fields, ['日期', '开票日期', '签发日期', '签订日期']);
  if (date) anchors.date = date;
  const amount = firstNum(fields, ['金额', '价税合计', '合计金额']);
  if (amount !== undefined) anchors.amount = amount;
  const qty = firstNum(fields, ['数量', '重量_吨', '交货总量_吨']);
  if (qty !== undefined) anchors.quantityTon = qty;
  return anchors;
}

const WEIGHTS = { party: 0.5, time: 0.25, amount: 0.15, qty: 0.1 } as const;

/** 评分阈值: >= 0.75 且与次高差 >= 0.05 -> human。 */
const HUMAN_SCORE_THRESHOLD = 0.75;
const HUMAN_SCORE_GAP = 0.05;

/**
 * 生成绑定建议。对每个 ledger 条目按锚点打分; 合同号归一化精确命中且无其他
 * 条目共享同一合同号 -> 该候选 route='auto_rule' score=0.99; 否则加权评分后
 * 路由: top1 >= 0.75 且 (top1 - top2) >= 0.05 -> 'human'; 其余 'none'。
 * 锚点缺失的维度用 0.5 中性分。
 */
export function generateBindingProposals(
  anchors: VoucherAnchors,
  ledgerEntries: LedgerEntryLike[],
): BindingProposal[] {
  // 合同号精确命中(归一化): ledger.contract_no 已是 normalizeContractNo 后的值。
  const normalized = (anchors.contractNo ?? '').trim().toUpperCase();
  const exactMatches = normalized
    ? ledgerEntries.filter((l) => l.contractNo === normalized)
    : [];
  if (exactMatches.length === 1) {
    // 无其他条目共享同一归一化合同号 -> 直接 auto_rule。
    const shared = ledgerEntries.filter((l) => l.contractNo === normalized);
    if (shared.length === 1) {
      return [
        {
          contractNo: normalized,
          score: 0.99,
          route: 'auto_rule',
          evidence: {
            partyScore: 0.99,
            timeScore: 0.99,
            amountScore: 0.99,
            qtyScore: 0.99,
            details: [`单据自带合同号 ${normalized} 与合同台账精确匹配(自动确认)`],
          },
        },
      ];
    }
    // 多个条目共享同一合同号(跨 user 数据) -> 歧义, 走加权评分。
  }

  if (ledgerEntries.length === 0) return [];

  const scored = ledgerEntries.map((entry): BindingProposal => {
    const party = scoreParty(anchors, entry.fields);
    const time = scoreTime(anchors, entry.fields);
    const amount = scoreAmount(anchors, entry.fields);
    const qty = scoreQty(anchors, entry.fields);
    const score =
      WEIGHTS.party * party.score +
      WEIGHTS.time * time.score +
      WEIGHTS.amount * amount.score +
      WEIGHTS.qty * qty.score;
    return {
      contractNo: entry.contractNo,
      score,
      route: 'none', // 路由在下方统一判定
      evidence: {
        partyScore: party.score,
        timeScore: time.score,
        amountScore: amount.score,
        qtyScore: qty.score,
        details: [party.detail, time.detail, amount.detail, qty.detail].filter(Boolean),
      },
    };
  });

  scored.sort((a, b) => b.score - a.score);

  const top = scored[0]!;
  const second = scored[1];
  if (top.score >= HUMAN_SCORE_THRESHOLD && top.score - (second?.score ?? 0) >= HUMAN_SCORE_GAP) {
    top.route = 'human';
  }
  return scored;
}