// 自主体候选建议(selfPartyCandidates): 从用户可见文档的最新抽取中确定性汇总
// 候选公司名。读时计算(路由 GET /api/parties), 不落库、无 LLM。候选 = 出现在
// 任何凭证 买方/卖方(含别名)字段里的公司名, 剔除已在有效名单(归一化比较)里的。
//
// 价值: 名单管理的引导体验 —— 不用手敲公司名, 从已有凭证里点选; 同一次抽取
// 的买卖双方各自独立计入 docCount。
//
// F1: 候选附带 buyerCount/sellerCount(该名作为买方类/卖方类字段值出现的文档数,
// 双侧命中计两侧), 前端据此展示"该主体在凭证里主要扮演买方还是卖方"。
//
// F2: 冲突检测 —— 有效名单同时命中某凭证的 buyer 与 seller 两侧时, 方向判定
// 必然 unknown(resolveSelfSide 双侧命中返回 null), 执行流水静默跳过。GET
// /api/parties 返回 conflicts 列表, 前端据此提示用户"名单把对手方也加进来了"。

import type { DbContext } from './db/client.js';
import {
  listUserDocuments,
  loadLatestExtractionByDocId,
  listDocumentIdsWithConfirmedBindings,
  getDocumentMeta,
} from './db/repositories.js';
import { PARTY_FIELD_ALIASES, buildAnchorsFromFields } from './bindingProposal.js';
import { extractAnchors, type VoucherType } from './schemas/vouchers.js';
import { normalizeCompanyName } from '../domain/flowDirection.js';

export interface SelfPartyCandidate {
  /** 候选名 = 出现次数最多的原始形式(平局取先出现者)。 */
  name: string;
  docCount: number;
  /** 作为买方类字段值(购买方名称/买方/甲方/收货人/受让方)出现的文档数。 */
  buyerCount: number;
  /** 作为卖方类字段值(销售方名称/卖方/乙方/发货人/转让方)出现的文档数。 */
  sellerCount: number;
  /** 出现该公司的文档中最大的 createdAt(ISO/库时间串, 字典序可比较)。 */
  lastSeenAt: string | null;
  /** 是否出现在任一 docType='合同' 文档的买卖双方字段里。 */
  isContractParty: boolean;
  /** 命中该公司的文档 id(最多前 5 个, 扫描序)。 */
  documentIds: string[];
}

/** 候选汇总的输入投影: 一份文档 + 其最新抽取的字段。 */
export interface CandidateSnapshot {
  docId: string;
  docType: string;
  createdAt: string;
  fields: Record<string, { value: string | number }>;
}

/** 六向执行流水白名单(与 executionFlow.FLOW_TYPE_BY_DOC_TYPE 语义一致)。 */
export const FLOW_DOCTYPES = new Set(['发票', '货转单', '付款凭证']);

/** 冲突行: 有效名单同时命中该凭证 buyer 与 seller 两侧。 */
export interface SelfPartyConflict {
  documentId: string;
  docType: string;
  buyer: string;
  seller: string;
}

/** 冲突检测的输入投影: 一份白名单内文档 + 其锚点(buyer/seller 原始值)。 */
export interface ConflictSnapshot {
  docId: string;
  docType: string;
  anchors: { buyer?: string; seller?: string };
}

const CANDIDATE_CAP = 20;
const DOCUMENT_IDS_CAP = 5;

/** 首个非空字段值(与 bindingProposal.firstStr 同语义, 键精确匹配, 无第二份别名拷贝)。 */
function firstFieldValue(
  fields: Record<string, { value: string | number }>,
  keys: readonly string[],
): string | undefined {
  for (const k of keys) {
    const v = fields[k]?.value;
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return undefined;
}

interface CandidateAgg {
  norm: string;
  /** 原始形式 -> 出现次数(候选名取计数最高者)。 */
  rawCounts: Map<string, number>;
  docCount: number;
  buyerCount: number;
  sellerCount: number;
  lastSeenAt: string | null;
  isContractParty: boolean;
  documentIds: string[];
}

/**
 * 纯函数候选汇总。effectiveNames 为归一化后的有效名单(来自
 * getEffectiveSelfPartyNames); 归一化形式命中者剔除。排序: docCount 降序,
 * 再 name(候选原始名)升序。上限 20。buyerCount/sellerCount 按字段类别独立
 * 计数: 同一文档里该名同时命中买方与卖方字段时, 两侧各计 1。
 */
export function buildSelfPartyCandidates(
  snapshots: CandidateSnapshot[],
  effectiveNames: string[],
): SelfPartyCandidate[] {
  const effective = new Set(effectiveNames);
  const byNorm = new Map<string, CandidateAgg>();

  const bump = (s: CandidateSnapshot, raw: string, side: 'buyer' | 'seller') => {
    const norm = normalizeCompanyName(raw);
    if (!norm || effective.has(norm)) return;
    let agg = byNorm.get(norm);
    if (!agg) {
      agg = {
        norm,
        rawCounts: new Map(),
        docCount: 0,
        buyerCount: 0,
        sellerCount: 0,
        lastSeenAt: null,
        isContractParty: false,
        documentIds: [],
      };
      byNorm.set(norm, agg);
    }
    agg.rawCounts.set(raw, (agg.rawCounts.get(raw) ?? 0) + 1);
    agg.docCount += 1;
    if (side === 'buyer') agg.buyerCount += 1;
    else agg.sellerCount += 1;
    if (agg.lastSeenAt === null || s.createdAt > agg.lastSeenAt) agg.lastSeenAt = s.createdAt;
    if (s.docType === '合同') agg.isContractParty = true;
    if (agg.documentIds.length < DOCUMENT_IDS_CAP) agg.documentIds.push(s.docId);
  };

  for (const s of snapshots) {
    const buyer = firstFieldValue(s.fields, PARTY_FIELD_ALIASES.buyer);
    const seller = firstFieldValue(s.fields, PARTY_FIELD_ALIASES.seller);
    if (buyer) bump(s, buyer, 'buyer');
    if (seller) bump(s, seller, 'seller');
  }

  const candidates = [...byNorm.values()].map((agg): SelfPartyCandidate => {
    let bestRaw = '';
    let bestCount = -1;
    for (const [raw, count] of agg.rawCounts) {
      // 平局保留先出现者(插入序), 确定性。
      if (count > bestCount) {
        bestCount = count;
        bestRaw = raw;
      }
    }
    return {
      name: bestRaw,
      docCount: agg.docCount,
      buyerCount: agg.buyerCount,
      sellerCount: agg.sellerCount,
      lastSeenAt: agg.lastSeenAt,
      isContractParty: agg.isContractParty,
      documentIds: agg.documentIds,
    };
  });

  candidates.sort((a, b) => {
    if (b.docCount !== a.docCount) return b.docCount - a.docCount;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return candidates.slice(0, CANDIDATE_CAP);
}

/**
 * 纯函数冲突检测。effectiveNames 为归一化后的有效名单。仅扫描白名单 docType
 * (发票/货转单/付款凭证); 名单归一化后同时命中 anchors.buyer 与 anchors.seller
 * 的文档产出冲突行(buyer/seller 为锚点原始值, 供前端展示)。确定性, 无 LLM。
 */
export function findSelfPartyConflicts(
  snapshots: ConflictSnapshot[],
  effectiveNames: string[],
): SelfPartyConflict[] {
  const effective = new Set(effectiveNames);
  const out: SelfPartyConflict[] = [];
  for (const s of snapshots) {
    if (!FLOW_DOCTYPES.has(s.docType)) continue;
    const buyer = s.anchors.buyer ? normalizeCompanyName(s.anchors.buyer) : '';
    const seller = s.anchors.seller ? normalizeCompanyName(s.anchors.seller) : '';
    if (buyer && seller && effective.has(buyer) && effective.has(seller)) {
      out.push({
        documentId: s.docId,
        docType: s.docType,
        buyer: s.anchors.buyer!,
        seller: s.anchors.seller!,
      });
    }
  }
  return out;
}

/**
 * IO 编排: 用户可见文档(与 /overview 同源 listUserDocuments 作用域) -> 每份
 * 最新抽取(无抽取的文档跳过) -> buildSelfPartyCandidates。effectiveNames 传入
 * 归一化后的有效名单(路由侧已算好, 避免重复扫描)。
 */
export async function buildSelfPartyCandidatesForUser(
  ctx: DbContext,
  userId: string,
  effectiveNames: string[],
): Promise<SelfPartyCandidate[]> {
  const docs = await listUserDocuments(ctx, userId);
  const snapshots: CandidateSnapshot[] = [];
  for (const d of docs) {
    const ex = await loadLatestExtractionByDocId(ctx, d.id, userId);
    if (!ex) continue;
    snapshots.push({
      docId: d.id,
      docType: ex.docType,
      createdAt: d.createdAt,
      fields: ex.fields as Record<string, { value: string | number }>,
    });
  }
  return buildSelfPartyCandidates(snapshots, effectiveNames);
}

/** 抽取行 fields({value, sourceSpans} 包装) -> extractAnchors 需要的裸值映射。 */
function unwrapFieldValues(
  fields: Record<string, { value: string | number; sourceSpans: unknown[] }>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) out[k] = v.value;
  return out;
}

/**
 * IO 编排: 持有 confirmed 绑定 + 白名单 docType 的文档 -> 最新抽取 -> 锚点
 * (发票走 buildAnchorsFromFields, 其余走 extractAnchors, 与 materializeExecutionFlow
 * 同源) -> findSelfPartyConflicts。effectiveNames 为归一化后的有效名单。
 */
export async function findSelfPartyConflictsForUser(
  ctx: DbContext,
  userId: string,
  effectiveNames: string[],
): Promise<SelfPartyConflict[]> {
  const docIds = await listDocumentIdsWithConfirmedBindings(ctx, userId);
  const snapshots: ConflictSnapshot[] = [];
  for (const docId of docIds) {
    const meta = await getDocumentMeta(ctx, docId, userId);
    if (!meta || !meta.docType || !FLOW_DOCTYPES.has(meta.docType)) continue;
    const ex = await loadLatestExtractionByDocId(ctx, docId, userId);
    if (!ex) continue;
    const anchors =
      ex.docType === '发票'
        ? buildAnchorsFromFields(ex.docType, ex.fields)
        : extractAnchors(ex.docType as VoucherType, unwrapFieldValues(ex.fields));
    snapshots.push({ docId, docType: ex.docType, anchors });
  }
  return findSelfPartyConflicts(snapshots, effectiveNames);
}