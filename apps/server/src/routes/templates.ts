// 模板上下文 API(spec 2026-08-26 §4.1): 绑定工作台双下拉的数据源。
// P4 Task 3 扩展: /api/templates 管理 REST(types/rules/versions 读 + CRUD/软禁用),
// 变更端点 requireRole('admin')(挂载级 requireAuth 在 index.ts /api/templates/*)。
// 业务规则全部在 templateManage.ts(统一写入面), 本文件是薄壳: zod parse -> 调用 -> 映射。
import { Hono } from 'hono';
import type { Context } from 'hono';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AuthEnv } from '../lib/auth-middleware.js';
import { requireRole } from '../lib/auth-middleware.js';
import { getDbContext } from '../pipeline/db/dbBackend.js';
import {
  listActiveEdgeRules, listContractLedgerEntries, listTemplateTypes,
  listMembershipsByProject, listProjects, getDocumentMeta,
  listAllEdgeRules, listTemplateTypesManaged, insertTemplateEdgeRule,
  bumpTemplateVersion,
} from '../pipeline/db/repositories.js';
import {
  createTemplateType, updateTemplateTypeProps, updateEdgeRuleVocab,
  setEdgeRuleActive, setTemplateTypeActive, listTemplateVersions,
  type ManageErrorCode,
} from '../pipeline/templateManage.js';
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

// ---- 管理 REST(Task 3) -------------------------------------------------------

const MANAGE_HTTP_STATUS: Record<ManageErrorCode, 400 | 404 | 409> = {
  not_found: 404, duplicate: 409, protected: 409, invalid: 400,
};

function manageFail(c: Context<AuthEnv>, r: { reason: string; code: ManageErrorCode }) {
  return c.json({ error: r.reason }, MANAGE_HTTP_STATUS[r.code]);
}

function currentUserOr401(c: Context<AuthEnv>) {
  const user = c.get('user');
  if (!user) return null;
  return user;
}

const CreateTypeBody = z.object({
  kind: z.enum(['doc_type', 'contract_type']),
  name: z.string().trim().min(1),
  parentIdName: z.string().trim().min(1).optional(),
  props: z.record(z.string(), z.unknown()).optional(),
});

const PatchTypeBody = z.object({
  parentIdName: z.string().trim().min(1).nullable().optional(),
  props: z.record(z.string(), z.unknown()).optional(),
});

const CreateRuleBody = z.object({
  sourceTypeId: z.string().min(1).optional(),
  sourceTypeName: z.string().trim().min(1).optional(),
  targetTypeId: z.string().optional(),
  edgeType: z.string().trim().min(1),
  allowedVocab: z.array(z.string()),
  isActive: z.boolean().optional(),
});

const PatchRuleBody = z.object({
  allowedVocab: z.array(z.string()).optional(),
  isActive: z.boolean().optional(),
});

async function parseJson(c: Context<AuthEnv>): Promise<unknown> {
  return c.req.json().catch(() => null);
}

/** 全量类型行(含 inactive 与 managed 元数据)。读放开到全部登录用户。 */
templatesRoute.get('/types', async (c) => {
  if (!currentUserOr401(c)) return c.json({ error: 'unauthorized' }, 401);
  const ctx = getDbContext();
  return c.json({ types: await listTemplateTypesManaged(ctx) });
});

/** 全量边规则行(含登记不启用)。读放开。 */
templatesRoute.get('/rules', async (c) => {
  if (!currentUserOr401(c)) return c.json({ error: 'unauthorized' }, 401);
  const ctx = getDbContext();
  return c.json({ rules: await listAllEdgeRules(ctx) });
});

/** 版本审计倒序(GET ?limit=, 默认 100 上限 500)。读放开。 */
templatesRoute.get('/versions', async (c) => {
  if (!currentUserOr401(c)) return c.json({ error: 'unauthorized' }, 401);
  const ctx = getDbContext();
  const q = Number(c.req.query('limit'));
  return c.json({ versions: await listTemplateVersions(ctx, Number.isFinite(q) ? q : 100) });
});

templatesRoute.post('/types', requireRole('admin'), async (c) => {
  const user = currentUserOr401(c);
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const parsed = CreateTypeBody.safeParse(await parseJson(c));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'invalid body' }, 400);
  const res = await createTemplateType(getDbContext(), user.id, parsed.data);
  if (!res.ok) return manageFail(c, res);
  return c.json({ id: res.data.id, templateVersion: res.templateVersion }, 201);
});

templatesRoute.patch('/types/:id', requireRole('admin'), async (c) => {
  const user = currentUserOr401(c);
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const parsed = PatchTypeBody.safeParse(await parseJson(c));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'invalid body' }, 400);
  const res = await updateTemplateTypeProps(getDbContext(), user.id, {
    typeId: c.req.param('id'), parentIdName: parsed.data.parentIdName, props: parsed.data.props,
  });
  if (!res.ok) return manageFail(c, res);
  return c.json({ id: res.data.id, templateVersion: res.templateVersion });
});

// 登记先行(spec §3.2): 允许悬空 sourceTypeId; 悬空不阻断但附 warnings 提示。
templatesRoute.post('/rules', requireRole('admin'), async (c) => {
  const user = currentUserOr401(c);
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const parsed = CreateRuleBody.safeParse(await parseJson(c));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'invalid body' }, 400);
  const b = parsed.data;
  // sourceTypeName 变体按 dt-{name} 约定归一(seed 同构); 缺失两源字段 -> invalid。
  const sourceTypeId = b.sourceTypeId ?? (b.sourceTypeName ? `dt-${b.sourceTypeName}` : undefined);
  if (!sourceTypeId) return c.json({ error: 'sourceTypeId 或 sourceTypeName 必填其一' }, 400);

  const warnings: string[] = [];
  const knownTypes = await listTemplateTypes(getDbContext());
  if (!knownTypes.some((t) => t.id === sourceTypeId)) {
    warnings.push('sourceTypeId 不存在（登记先行）');
  }

  const slug = b.edgeType.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 16) || 'custom';
  const id = `er-${slug}-${randomUUID().slice(0, 8)}`;
  const ctx = getDbContext();
  await insertTemplateEdgeRule(ctx, {
    id, sourceTypeId, targetTypeId: b.targetTypeId, edgeType: b.edgeType,
    allowedVocab: b.allowedVocab, isActive: b.isActive, managedBy: user.id,
  });
  const templateVersion = await bumpTemplateVersion(ctx, {
    changedBy: user.id, changeSummary: `rule.create ${id}`,
  });
  return c.json({ id, templateVersion, ...(warnings.length > 0 ? { warnings } : {}) }, 201);
});

// allowedVocab 与 isActive 可同请求一并提交; 两段各自落一条审计
// (vocab_update + activate/deactivate), templateVersion 返回末段版本号。
templatesRoute.patch('/rules/:id', requireRole('admin'), async (c) => {
  const user = currentUserOr401(c);
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const parsed = PatchRuleBody.safeParse(await parseJson(c));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'invalid body' }, 400);
  const ruleId = c.req.param('id');
  const ctx = getDbContext();
  let templateVersion: number | undefined;
  if (parsed.data.allowedVocab !== undefined) {
    const r = await updateEdgeRuleVocab(ctx, user.id, { ruleId, allowedVocab: parsed.data.allowedVocab });
    if (!r.ok) return manageFail(c, r);
    templateVersion = r.templateVersion;
  }
  if (parsed.data.isActive !== undefined) {
    const r = await setEdgeRuleActive(ctx, user.id, { ruleId, active: parsed.data.isActive });
    if (!r.ok) return manageFail(c, r);
    templateVersion = r.templateVersion;
  }
  if (templateVersion === undefined) return c.json({ error: '未提供任何变更字段(allowedVocab / isActive)' }, 400);
  return c.json({ id: ruleId, templateVersion });
});

/** 软禁用类型(永物理删, spec §5 删除保护)。响应附 inUseReasons 展示提示。
 *  先验存在与 kind(doc_type), 再走 setTemplateTypeActive -> 占用原因永远基于
 *  真实存在的行计算(er-bind-fallback 通配不会为不存在类型制造伪占用)。 */
templatesRoute.delete('/types/:id', requireRole('admin'), async (c) => {
  const user = currentUserOr401(c);
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const id = c.req.param('id');
  const ctx = getDbContext();
  const t = (await listTemplateTypes(ctx)).find((x) => x.id === id);
  if (!t || t.kind !== 'doc_type') return c.json({ error: `类型不存在: ${id}` }, 404);
  const res = await setTemplateTypeActive(ctx, user.id, { typeName: t.name, active: false });
  if (!res.ok) return manageFail(c, res);
  return c.json({ id: res.data.id, inUseReasons: res.data.inUseReasons ?? [], templateVersion: res.templateVersion });
});

templatesRoute.delete('/rules/:id', requireRole('admin'), async (c) => {
  const user = currentUserOr401(c);
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const res = await setEdgeRuleActive(getDbContext(), user.id, { ruleId: c.req.param('id'), active: false });
  if (!res.ok) return manageFail(c, res);
  return c.json({ id: res.data.id, templateVersion: res.templateVersion });
});
