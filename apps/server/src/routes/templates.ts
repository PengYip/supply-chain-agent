// 模板上下文 API(spec 2026-08-26 §4.1): 绑定工作台双下拉的数据源。
import { Hono } from 'hono';
import type { AuthEnv } from '../lib/auth-middleware.js';
import { getDbContext } from '../pipeline/db/dbBackend.js';
import {
  listActiveEdgeRules, listContractLedgerEntries, listTemplateTypes,
  listMembershipsByProject, listProjects, getDocumentMeta,
} from '../pipeline/db/repositories.js';
import { ancestorChain, matchEdgeRule } from '../pipeline/templateGuard.js';
import { bindingRelationFor } from '../domain/tradeSemantics.js';
import type { VoucherType } from '../pipeline/schemas/vouchers.js';

export const templatesRoute = new Hono<AuthEnv>();

const CONTRACT_TYPE_NAMES = ['采购', '销售', '物流', '租赁', '服务', '其他'];

templatesRoute.get('/context', async (c) => {
  const user = c.get('user')!;
  const documentId = c.req.query('documentId');
  if (!documentId) return c.json({ error: 'documentId 必填' }, 400);
  const ctx = getDbContext();

  const meta = await getDocumentMeta(ctx, documentId, user.id);
  if (!meta) return c.json({ error: 'document not found' }, 404);
  const docType = meta.docType;

  const [types, rules, projects, ledger] = await Promise.all([
    listTemplateTypes(ctx),
    listActiveEdgeRules(ctx),
    listProjects(ctx, user.id),
    listContractLedgerEntries(ctx, user.id),
  ]);
  const byId = new Map(types.map((t) => [t.id, t]));
  const nameOf = (id: string) => byId.get(id)?.name ?? null;

  const docTypeId = byId.get(`dt-${docType}`)?.id ?? null;
  const sourceChain = ancestorChain(docTypeId, byId);
  const typeChain = sourceChain.map((id) => nameOf(id)!).filter(Boolean);

  // binds 派生词: 先取激活 binds 规则词表首词(规则驱动, 覆盖 立项书/付款单等
  // 不在 bindingRelationByVoucherType 映射的类型), 无规则再回退 bindingRelationFor
  // (兜底规则 er-bind-fallback vocab=['凭证'] 保证 legacy 行为不变)。
  const bindsRule = matchEdgeRule({ rules, sourceChain, targetChain: [''], edgeType: 'binds' });
  const bindsRelation = bindsRule && bindsRule.allowedVocab.length > 0
    ? bindsRule.allowedVocab[0]!
    : bindingRelationFor(docType as VoucherType);

  // 绑定目标类型(裁决 #1): 读 dt-{docType} 的 props.bindsTargetKind, 缺省 'Contract'。
  const bindsTargetKind = (byId.get(`dt-${docType}`)?.props.bindsTargetKind === 'Project') ? 'Project' : 'Contract';

  // settles 词表: 匹配激活 settles 规则。
  const settlesRule = matchEdgeRule({ rules, sourceChain, targetChain: [''], edgeType: 'settles' });
  const settlesVocab = settlesRule ? settlesRule.allowedVocab : null;

  // 允许的合同类型: 对六个合同类型逐一试 binds 匹配, 命中即允许。
  const allowedContractTypes = CONTRACT_TYPE_NAMES.filter((ct) => {
    const chain = ancestorChain(byId.get(`ct-${ct}`)?.id ?? null, byId);
    return matchEdgeRule({ rules, sourceChain, targetChain: chain, edgeType: 'binds' }) !== null;
  });

  // 项目-合同树: memberships(confirmed) join 台账。
  const allowed = (ct: string | null) =>
    ct === null || allowedContractTypes.length === 0 || allowedContractTypes.includes(ct);
  const contractRow = (no: string, ct: string | null) =>
    ({ contractNo: no, contractType: ct, allowed: allowed(ct) });

  const assigned = new Set<string>();
  const projectBlocks = [];
  for (const p of projects) {
    const ms = await listMembershipsByProject(ctx, p.code, user.id, 'confirmed');
    const nos = ms.map((m) => m.contractNo);
    for (const n of nos) assigned.add(n);
    // 当前项目自己的成员合同(全局 assigned 仅用于最后 unassignedContracts 计算)。
    const contracts = ledger
      .filter((l) => nos.includes(l.contractNo))
      .map((l) => contractRow(l.contractNo, l.contractType ?? null));
    projectBlocks.push({ code: p.code, name: p.name, contracts });
  }
  const unassignedContracts = ledger
    .filter((l) => !assigned.has(l.contractNo))
    .map((l) => contractRow(l.contractNo, l.contractType ?? null));

  return c.json({
    documentId, docType, typeChain, bindsRelation, bindsTargetKind, settlesVocab,
    allowedContractTypes, projects: projectBlocks, unassignedContracts,
  });
});
