// 工作台候选绑定编排(spec §5.1 /candidates): 读最新抽取 -> 锚点(图片凭证走
// extractAnchors, 其余走 buildAnchorsFromFields) -> 台账全量喂给纯函数
// generateBindingProposals -> 纯计算, 不落库。弱候选(route 'none')一并返回。
import type { DbContext } from './db/client.js';
import {
  loadLatestExtractionByDocId, listContractLedgerEntries, listBindingsForUser,
  listTemplateTypes, listActiveEdgeRules,
} from './db/repositories.js';
import { generateBindingProposals, buildAnchorsFromFields, type BindingEvidence } from './bindingProposal.js';
import { extractAnchors, type VoucherAnchors } from './schemas/vouchers.js';
import { ancestorChain, matchEdgeRule } from './templateGuard.js';
import type { ContractLedgerEntry } from './contractLedger.js';

const VOUCHER_TYPES = new Set(['货转单', '付款凭证', '化验报告']);

export interface BindingCandidate {
  contractNo: string;
  score: number;
  route: 'auto_rule' | 'human' | 'none';
  evidence: BindingEvidence;
  existingBindingId: string | null;
  ledger: { contractNo: string; displayContractNo: string; title: string; docType: string } | null;
}

export interface BindingCandidatesResult {
  hasExtraction: boolean;
  anchors: VoucherAnchors;
  candidates: BindingCandidate[];
}

export async function buildBindingCandidates(
  ctx: DbContext, docId: string, userId?: string,
): Promise<BindingCandidatesResult> {
  const extraction = await loadLatestExtractionByDocId(ctx, docId, userId);
  if (!extraction) return { hasExtraction: false, anchors: {}, candidates: [] };

  const fields = extraction.fields as Record<string, { value: string | number; sourceSpans: unknown[] }>;
  const anchors: VoucherAnchors = VOUCHER_TYPES.has(extraction.docType)
    ? extractAnchors(extraction.docType as '货转单' | '付款凭证' | '化验报告', fields)
    : buildAnchorsFromFields(extraction.docType, fields);

  const hasAnyAnchor = anchors.contractNo !== undefined || anchors.buyer !== undefined
    || anchors.seller !== undefined || anchors.amount !== undefined
    || anchors.quantityTon !== undefined || anchors.date !== undefined;
  if (!hasAnyAnchor) return { hasExtraction: true, anchors, candidates: [] };

  const ledger = await listContractLedgerEntries(ctx, userId);
  // anchorWeights 接线(终审遗留②): 读 docType 激活 binds 规则的 anchorWeights,
  // 非空传第三参, null 回退缺省(不传 = WEIGHTS 缺省行为)。
  const [types, rules] = await Promise.all([listTemplateTypes(ctx), listActiveEdgeRules(ctx)]);
  const byId = new Map(types.map((t) => [t.id, t]));
  const chain = ancestorChain(byId.get(`dt-${extraction.docType}`)?.id ?? null, byId);
  const rule = matchEdgeRule({ rules, sourceChain: chain, targetChain: [''], edgeType: 'binds' });
  const weights = rule?.anchorWeights ?? undefined;
  const proposals = generateBindingProposals(anchors, ledger, weights);
  const bindings = await listBindingsForUser(ctx, userId);
  const activeByKey = new Map<string, string>();
  for (const b of bindings) {
    if (b.documentId === docId && b.status !== 'rejected') activeByKey.set(b.contractNo, b.id);
  }
  const ledgerByNo = new Map<string, ContractLedgerEntry>();
  for (const l of ledger) ledgerByNo.set(l.contractNo, l);

  const candidates: BindingCandidate[] = proposals
    .map((p) => {
      const l = ledgerByNo.get(p.contractNo);
      return {
        contractNo: p.contractNo,
        score: p.score,
        route: p.route,
        evidence: p.evidence,
        existingBindingId: activeByKey.get(p.contractNo) ?? null,
        ledger: l ? { contractNo: l.contractNo, displayContractNo: l.displayContractNo, title: l.title, docType: l.docType } : null,
      };
    })
    .sort((a, b) => b.score - a.score);
  return { hasExtraction: true, anchors, candidates };
}
