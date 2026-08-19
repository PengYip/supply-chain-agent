// 自主体候选建议(selfPartyCandidates): 从用户可见文档的最新抽取中确定性汇总
// 候选公司名。读时计算(路由 GET /api/parties), 不落库、无 LLM。候选 = 出现在
// 任何凭证 买方/卖方(含别名)字段里的公司名, 剔除已在有效名单(归一化比较)里的。
//
// 价值: 名单管理的引导体验 —— 不用手敲公司名, 从已有凭证里点选; 同一次抽取
// 的买卖双方各自独立计入 docCount。

import type { DbContext } from './db/client.js';
import { listUserDocuments, loadLatestExtractionByDocId } from './db/repositories.js';
import { PARTY_FIELD_ALIASES } from './bindingProposal.js';
import { normalizeCompanyName } from '../domain/flowDirection.js';

export interface SelfPartyCandidate {
  /** 候选名 = 出现次数最多的原始形式(平局取先出现者)。 */
  name: string;
  docCount: number;
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
  lastSeenAt: string | null;
  isContractParty: boolean;
  documentIds: string[];
}

/**
 * 纯函数候选汇总。effectiveNames 为归一化后的有效名单(来自
 * getEffectiveSelfPartyNames); 归一化形式命中者剔除。排序: docCount 降序,
 * 再 name(候选原始名)升序。上限 20。
 */
export function buildSelfPartyCandidates(
  snapshots: CandidateSnapshot[],
  effectiveNames: string[],
): SelfPartyCandidate[] {
  const effective = new Set(effectiveNames);
  const byNorm = new Map<string, CandidateAgg>();

  for (const s of snapshots) {
    const rawValues: string[] = [];
    const buyer = firstFieldValue(s.fields, PARTY_FIELD_ALIASES.buyer);
    const seller = firstFieldValue(s.fields, PARTY_FIELD_ALIASES.seller);
    if (buyer) rawValues.push(buyer);
    if (seller) rawValues.push(seller);

    for (const raw of rawValues) {
      const norm = normalizeCompanyName(raw);
      if (!norm || effective.has(norm)) continue;
      let agg = byNorm.get(norm);
      if (!agg) {
        agg = {
          norm,
          rawCounts: new Map(),
          docCount: 0,
          lastSeenAt: null,
          isContractParty: false,
          documentIds: [],
        };
        byNorm.set(norm, agg);
      }
      agg.rawCounts.set(raw, (agg.rawCounts.get(raw) ?? 0) + 1);
      agg.docCount += 1;
      if (agg.lastSeenAt === null || s.createdAt > agg.lastSeenAt) agg.lastSeenAt = s.createdAt;
      if (s.docType === '合同') agg.isContractParty = true;
      if (agg.documentIds.length < DOCUMENT_IDS_CAP) agg.documentIds.push(s.docId);
    }
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
