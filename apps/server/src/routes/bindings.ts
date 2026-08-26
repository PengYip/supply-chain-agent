// 绑定工作台 REST 面(spec 2026-08-18 §5.1)。挂在 /api/bindings(requireAuth,
// index.ts)。写操作页面直连 + 前端二次确认, 不走对话审批链路。
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../lib/auth-middleware.js';
import { getDbContext } from '../pipeline/db/dbBackend.js';
import type { DbContext } from '../pipeline/db/client.js';
import {
  listUserDocuments, listBindingsForUser, listBindingProposals, listContractLedgerEntries,
  findBindingById, updateBindingStatus, saveBinding, findBindingByDocAndContract,
  listBindingsForContract, setBindingGraphStatus, getDocumentMeta, type BindingGraphStatus,
  listExecutionFlows, summarizeExecutionFlows, getDocumentSourcesByIds, hasContractDocBinding,
  findContractLedgerByNo, listTemplateTypes, listActiveEdgeRules,
} from '../pipeline/db/repositories.js';
import { buildBindingCandidates } from '../pipeline/bindingCandidates.js';
import { syncBindingEdge, removeBindingEdge, type GraphSyncOutcome } from '../pipeline/bindingGraphSync.js';
import { syncSettlesEdge, removeSettlesEdge } from '../pipeline/settlesGraphSync.js';
import { settlesRelationFor } from '../domain/tradeSemantics.js';
import { materializeExecutionFlow, retractExecutionFlow, getEffectiveSelfPartyNames } from '../pipeline/executionFlow.js';
import { validateEdge, ancestorChain, matchEdgeRule } from '../pipeline/templateGuard.js';
import { parseFileKey } from './files.js';

export const bindingsRoute = new Hono<AuthEnv>();

function ctx(): DbContext { return getDbContext(); }

bindingsRoute.use('*', async (c, next) => {
  if (!c.get('user')) return c.json({ error: 'unauthorized' }, 401);
  await next();
});

/** GET /overview — 每文档绑定状态总览(前端按未绑定/已绑定分组)。 */
bindingsRoute.get('/overview', async (c) => {
  const user = c.get('user')!;
  const [docs, bindings] = await Promise.all([
    listUserDocuments(ctx(), user.id),
    listBindingsForUser(ctx(), user.id),
  ]);
  const byDoc = new Map<string, Array<Record<string, unknown>>>();
  for (const b of bindings) {
    if (b.status === 'rejected') continue;
    const list = byDoc.get(b.documentId) ?? [];
    list.push({
      bindingId: b.id, contractNo: b.contractNo, relation: b.relation,
      status: b.status, confidence: b.confidence,
      confirmationSource: b.confirmationSource, graphStatus: b.graphStatus,
    });
    byDoc.set(b.documentId, list);
  }
  const documents = docs.map((d) => {
    // 目录上下文(2026-08-25): 绑定工作台需要展示文件所在文件夹, 便于按业务链
    // (如 汽运业务资料/煤焦化/2.发运单据)精确配对。minio_key 缺失时回退 '/'。
    const parsed = d.minioKey ? parseFileKey(d.minioKey, user.id) : null;
    return {
      docId: d.id,
      fileName: parsed?.name ?? (d.sourceUri ?? '').split('/').pop() ?? d.sourceUri ?? '',
      directory: parsed?.directory ?? '/',
      docType: d.docType,
      createdAt: d.createdAt,
      bindings: byDoc.get(d.id) ?? [],
    };
  });
  // 单据类型词汇表(模板派生: 激活的 doc_type 类型名), 前端据此渲染 docType
  // 下拉/徽章, 不必硬编码。
  const templateTypes = await listTemplateTypes(ctx());
  const docTypes = templateTypes.filter((t) => t.kind === 'doc_type' && t.isActive).map((t) => t.name);
  return c.json({ documents, docTypes });
});

/** GET /proposals — 现有 status=proposed 建议行。 */
bindingsRoute.get('/proposals', async (c) => {
  const user = c.get('user')!;
  const rows = await listBindingProposals(ctx(), user.id);
  return c.json({
    proposals: rows.map((r) => ({
      bindingId: r.id, documentId: r.documentId, docType: r.docType, fileName: r.fileName,
      contractNo: r.contractNo, relation: r.relation, confidence: r.confidence,
      evidence: r.evidence, graphStatus: r.graphStatus,
    })),
  });
});

const candidatesSchema = z.object({ documentId: z.string().min(1, 'documentId 必填') });

/** GET /candidates?documentId= — 按需生成候选(纯计算, 不落库)。 */
bindingsRoute.get('/candidates', async (c) => {
  const user = c.get('user')!;
  const parsed = candidatesSchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ error: 'invalid query params', detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) }, 400);
  }
  const res = await buildBindingCandidates(ctx(), parsed.data.documentId, user.id);
  return c.json(res);
});

/** GET /contracts — 合同台账(手动绑定下拉)。 */
bindingsRoute.get('/contracts', async (c) => {
  const user = c.get('user')!;
  const entries = await listContractLedgerEntries(ctx(), user.id);
  return c.json({
    contracts: entries.map((e) => ({
      contractNo: e.contractNo, displayContractNo: e.displayContractNo,
      docType: e.docType, title: e.title, overallConfidence: e.overallConfidence,
    })),
  });
});

const flowsQuerySchema = z.object({ contractNo: z.string().min(1, 'contractNo 必填') });

/** GET /flows?contractNo= — 某合同的执行流水六向汇总 + 逐笔明细(只读)。 */
bindingsRoute.get('/flows', async (c) => {
  const user = c.get('user')!;
  const parsed = flowsQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ error: 'invalid query params', detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) }, 400);
  }
  const contractNo = parsed.data.contractNo;
  const [summaries, flows] = await Promise.all([
    summarizeExecutionFlows(ctx(), contractNo, user.id),
    listExecutionFlows(ctx(), contractNo, user.id),
  ]);
  // 溯源列展示文件名 + 点击预览: 批量补文档来源(路径末段 + MinIO key)。
  const docIds = [...new Set(flows.map((f) => f.documentId).filter((id) => id.length > 0))];
  const sources = await getDocumentSourcesByIds(ctx(), docIds);
  const sourceById = new Map(sources.map((s) => [s.id, s]));
  const flowsWithSource = flows.map((f) => {
    const s = sourceById.get(f.documentId);
    return {
      ...f,
      documentFileName: s ? (s.sourceUri.split('/').pop() ?? s.sourceUri) : null,
      documentMinioKey: s?.minioKey ?? null,
    };
  });
  // 有效自主体名单是否非空(DB ∪ env)。前端据此提示"未配置名单时流水不会物化"。
  const selfPartiesConfigured = (await getEffectiveSelfPartyNames(ctx())).length > 0;
  return c.json({ contractNo, summaries, flows: flowsWithSource, selfPartiesConfigured });
});

// ---- 写端点(spec §5.2) ------------------------------------------------------
//
// 图同步永不阻塞业务写: 同步结果持久化到 bindings.graph_status, 前端按角标
// 展示并允许重试(确认/手动创建会再次同步; unbind 幂等删边)。

const bindingIdSchema = z.object({ bindingId: z.string().min(1) });

async function graphStatusFor(outcome: GraphSyncOutcome, reason?: string): Promise<BindingGraphStatus> {
  return outcome === 'ok'
    ? { status: 'ok', syncedAt: new Date().toISOString() }
    : { status: outcome, ...(reason ? { reason } : {}), syncedAt: new Date().toISOString() };
}

/** syncBindingEdge + 查 documents 行带上 sourceUri/docType：同步时把这些回填进
 *  Document 图节点（ON MATCH SET），兜底节点缺 sourceUri 导致前端显示 docId 的
 *  问题由此自愈。meta 读取失败不阻断同步。 */
async function syncBindingEdgeWithMeta(
  db: DbContext,
  userId: string,
  input: { docId: string; contractNo: string; relation: string; bindingId: string; confidence: number; templateVersion?: number },
) {
  let meta: Awaited<ReturnType<typeof getDocumentMeta>> = null;
  try {
    meta = await getDocumentMeta(db, input.docId, userId);
  } catch {
    // 行读不到（已删除等）不阻断图同步，仅少回填两个属性
  }
  return syncBindingEdge({
    ...input,
    ...(meta?.docType ? { docType: meta.docType } : {}),
    ...(meta?.sourceUri ? { sourceUri: meta.sourceUri } : {}),
  });
}

/** syncSettlesEdge + 查 documents 行回填 docType/sourceUri（与 binds 同款兜底）。 */
async function syncSettlesEdgeWithMeta(
  db: DbContext,
  userId: string,
  input: { docId: string; contractNo: string; relation: string; direction: 'in' | 'out'; amount?: number | null; confidence: number },
) {
  let meta: Awaited<ReturnType<typeof getDocumentMeta>> = null;
  try {
    meta = await getDocumentMeta(db, input.docId, userId);
  } catch {
    // 行读不到不阻断 settles 同步, 仅少回填两个属性
  }
  return syncSettlesEdge({
    ...input,
    ...(meta?.docType ? { docType: meta.docType } : {}),
    ...(meta?.sourceUri ? { sourceUri: meta.sourceUri } : {}),
  });
}

/** 方向编码类型: 类型自带 settles 方向(单方向词表), 确认后直接落 settles 边。 */
async function syncSettlesByType(
  db: DbContext, userId: string,
  input: { documentId: string; contractNo: string; confidence: number },
): Promise<void> {
  let meta: Awaited<ReturnType<typeof getDocumentMeta>> = null;
  try { meta = await getDocumentMeta(db, input.documentId, userId); } catch { return; }
  if (!meta?.docType) return;
  const [types, rules] = await Promise.all([listTemplateTypes(db), listActiveEdgeRules(db)]);
  const byId = new Map(types.map((t) => [t.id, t]));
  const chain = ancestorChain(byId.get(`dt-${meta.docType}`)?.id ?? null, byId);
  const rule = matchEdgeRule({ rules, sourceChain: chain, targetChain: [''], edgeType: 'settles' });
  if (!rule || rule.allowedVocab.length !== 1) return; // 仅单方向类型走此路径
  const relation = rule.allowedVocab[0]!; // length===1 保证非空
  const direction = (relation === '收款' || relation === '收货' || relation === '收票') ? 'in' : 'out';
  const sync = await syncSettlesEdgeWithMeta(db, userId, {
    docId: input.documentId, contractNo: input.contractNo, relation,
    direction: direction as 'in' | 'out', confidence: input.confidence,
  });
  if (sync.outcome === 'failed') {
    console.warn('[settlesGraphSync] settles 边同步失败:', sync.reason);
  }
}

/**
 * 执行流水物化成功后的 settles 边同步(spec 方案A §3.3): 六向 relation 由
 * (flowType, direction)确定性派生; 白名单外/方向未判出(返回 null 或 relation
 * 为空)安静跳过。失败仅告警, 绝不影响确认/创建主流程。
 */
async function syncSettlesAfterFlow(
  db: DbContext,
  userId: string,
  input: { documentId: string; contractNo: string; confidence: number },
  settled: NonNullable<Awaited<ReturnType<typeof materializeExecutionFlow>>>,
) {
  const relation = settlesRelationFor(settled.flowType, settled.direction);
  if (!relation) return;
  // 交叉验证(spec v2): 类型自带 settles 方向 × flowType×direction 派生。
  // 派生 relation 不在该 docType 激活 settles 词表内 -> 类型方向与派生矛盾, 跳过。
  let meta: Awaited<ReturnType<typeof getDocumentMeta>> = null;
  try { meta = await getDocumentMeta(db, input.documentId, userId); } catch { /* 缺 meta 放行 */ }
  if (meta?.docType) {
    const [types, rules] = await Promise.all([listTemplateTypes(db), listActiveEdgeRules(db)]);
    const byId = new Map(types.map((t) => [t.id, t]));
    const chain = ancestorChain(byId.get(`dt-${meta.docType}`)?.id ?? null, byId);
    const rule = matchEdgeRule({ rules, sourceChain: chain, targetChain: [''], edgeType: 'settles' });
    if (rule && rule.allowedVocab.length > 0 && !rule.allowedVocab.includes(relation)) {
      console.warn(`[templateGuard] settles 交叉验证不通过(跳过): doc=${input.documentId} relation=${relation} 不在 ${meta.docType} 词表 ${rule.allowedVocab.join('/')}`);
      return;
    }
  }
  const sync = await syncSettlesEdgeWithMeta(db, userId, {
    docId: input.documentId, contractNo: input.contractNo, relation,
    direction: settled.direction as 'in' | 'out', amount: settled.amount,
    confidence: input.confidence,
  });
  if (sync.outcome === 'failed') {
    console.warn('[settlesGraphSync] settles 边同步失败:', sync.reason);
  }
}

/** 模板门禁(spec 2026-08-26 §4.1/§4.3): 绑定落库前校验类型组合。
 *  文档 meta 缺失(已删)或 docType 未登记 -> passthrough(行为零变化)。
 *  relation 软校验: 词表外仅 console.warn, Phase 2 转硬。 */
async function templateGate(
  db: DbContext, userId: string,
  input: { documentId: string; contractNo: string; relation?: string | null },
): Promise<{ ok: true; templateVersion: number | null } | { ok: false; reason: string }> {
  let meta: Awaited<ReturnType<typeof getDocumentMeta>> = null;
  try { meta = await getDocumentMeta(db, input.documentId, userId); } catch { /* 缺 meta 放行 */ }
  if (!meta?.docType) return { ok: true, templateVersion: null };
  let contractType: string | null | undefined;
  try {
    const ledgerRow = await findContractLedgerByNo(db, input.contractNo);
    contractType = ledgerRow?.contractType ?? null;
  } catch { contractType = null; }
  const g = await validateEdge(db, { docType: meta.docType, contractType, edgeType: 'binds', relation: input.relation ?? undefined });
  if (!g.ok) return { ok: false, reason: g.reason };
  if (g.relationInVocab === false) {
    console.warn(`[templateGuard] relation 在词表外(软校验, 不阻断): doc=${input.documentId} contract=${input.contractNo}`);
  }
  return { ok: true, templateVersion: g.templateVersion > 0 ? g.templateVersion : null };
}

/** confirm 单条(内部, batch 复用)。前置: 行存在且 status='proposed'。 */
async function confirmOne(db: DbContext, userId: string, bindingId: string) {
  const row = await findBindingById(db, bindingId, userId);
  if (!row) return { status: 404 as const, body: { error: 'binding not found', bindingId } };
  if (row.status !== 'proposed') return { status: 409 as const, body: { error: `binding status is ${row.status}, expected proposed`, bindingId } };
  const gate = await templateGate(db, userId, { documentId: row.documentId, contractNo: row.contractNo, relation: row.relation });
  if (!gate.ok) {
    return { status: 409 as const, body: { error: gate.reason, guard: 'template' as const, bindingId } };
  }
  const updated = await updateBindingStatus(db, bindingId, 'confirmed', 'human', userId);
  if (!updated) return { status: 409 as const, body: { error: 'concurrent state change', bindingId } };
  // 执行流水物化(hook): 确认成功后用最新抽取行落执行流水; 失败仅告警, 绝不影响确认结果。
  try {
    const settled = await materializeExecutionFlow(db, {
      documentId: row.documentId, contractNo: row.contractNo, bindingId: row.id,
      confidence: row.confidence, createdBy: 'human',
    }, userId);
    if (settled) {
      await syncSettlesAfterFlow(db, userId,
        { documentId: row.documentId, contractNo: row.contractNo, confidence: row.confidence }, settled);
    }
  } catch (e) {
    console.warn('[executionFlow] 确认绑定物化执行流水失败:', (e as Error).message);
  }
  // 方向编码类型(白名单外, 无流水物化): 类型自带 settles 方向, 直接落 settles 边。
  await syncSettlesByType(db, userId,
    { documentId: row.documentId, contractNo: row.contractNo, confidence: row.confidence });
  const sync = await syncBindingEdgeWithMeta(db, userId, {
    docId: row.documentId, contractNo: row.contractNo, relation: row.relation,
    bindingId: row.id, confidence: row.confidence,
    templateVersion: gate.templateVersion ?? undefined,
  });
  const gs = await graphStatusFor(sync.outcome, sync.reason);
  await setBindingGraphStatus(db, bindingId, gs, userId);
  return { status: 200 as const, body: { ok: true, bindingId, graphSync: sync.outcome, ...(sync.reason ? { graphReason: sync.reason } : {}) } };
}

bindingsRoute.post('/confirm', async (c) => {
  const user = c.get('user')!;
  const parsed = bindingIdSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid body' }, 400);
  const r = await confirmOne(ctx(), user.id, parsed.data.bindingId);
  return c.json(r.body, r.status);
});

bindingsRoute.post('/reject', async (c) => {
  const user = c.get('user')!;
  const parsed = bindingIdSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid body' }, 400);
  const db = ctx();
  const row = await findBindingById(db, parsed.data.bindingId, user.id);
  if (!row) return c.json({ error: 'binding not found' }, 404);
  if (row.status !== 'proposed') return c.json({ error: `binding status is ${row.status}, expected proposed` }, 409);
  const ok = await updateBindingStatus(db, parsed.data.bindingId, 'rejected', 'human', user.id);
  if (!ok) return c.json({ error: 'concurrent state change' }, 409);
  return c.json({ ok: true, bindingId: parsed.data.bindingId });
});

const createSchema = z.object({
  documentId: z.string().min(1),
  contractNo: z.string().min(1),
  relation: z.string().min(1),
  note: z.string().optional(),
});

/** 手动创建绑定(upsert 语义, spec §7 幂等)。 */
bindingsRoute.post('/', async (c) => {
  const user = c.get('user')!;
  const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid body', detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) }, 400);
  const { documentId, contractNo, relation } = parsed.data;
  const db = ctx();
  const existing = await findBindingByDocAndContract(db, documentId, contractNo, user.id);
  if (existing && existing.status !== 'rejected') {
    // 重试同步入口(前端 graph_status 非 ok 时幂等调用): confirmed 行重跑
    // syncBindingEdge 并落真实 graph_status; proposed 行尚未确认, 不该有边, 直接返回。
    if (existing.status === 'confirmed') {
      const sync = await syncBindingEdgeWithMeta(db, user.id, {
        docId: documentId, contractNo, relation: existing.relation,
        bindingId: existing.id, confidence: existing.confidence,
      });
      const gs = await graphStatusFor(sync.outcome, sync.reason);
      await setBindingGraphStatus(db, existing.id, gs, user.id);
      return c.json({ ok: true, bindingId: existing.id, existing: true, graphSync: sync.outcome, ...(sync.reason ? { graphReason: sync.reason } : {}) });
    }
    return c.json({ ok: true, bindingId: existing.id, existing: true, graphSync: 'ok' });
  }
  // 业务顺序门禁(2026-08-25): 执行类单据(非合同文件)绑定前, 目标合同必须已挂
  // 合同类型文件(先建立合同实体锚点)。合同文件本身不受限——它是链条第一步。
  const srcMeta = await getDocumentMeta(db, documentId, user.id);
  if (srcMeta && srcMeta.docType !== '合同') {
    const established = await hasContractDocBinding(db, contractNo, user.id);
    if (!established) {
      return c.json(
        { error: '该合同尚未绑定合同类型文件：请先在左侧选择合同文件，手动创建到该合同的绑定（关系选"引用"），再绑定执行类单据' },
        409,
      );
    }
  }
  // 模板门禁(spec 2026-08-26 §4.3): 类型组合校验, 拒绝 409 + guard:'template'。
  const gate = await templateGate(db, user.id, { documentId, contractNo, relation });
  if (!gate.ok) {
    return c.json({ error: gate.reason, guard: 'template' }, 409);
  }
  const bindingId = await saveBinding(db, {
    documentId, contractNo, relation, sourceRefs: [],
    confidence: 1, createdBy: user.id,
    status: 'confirmed', confirmationSource: 'human', proposedBy: 'agent',
  }, user.id);
  // 执行流水物化(hook): 手动创建 confirmed 绑定后物化; 失败仅告警, 绝不影响创建结果。
  try {
    const settled = await materializeExecutionFlow(db, {
      documentId, contractNo, bindingId,
      confidence: 1, createdBy: user.id,
    }, user.id);
    if (settled) {
      await syncSettlesAfterFlow(db, user.id,
        { documentId, contractNo, confidence: 1 }, settled);
    }
  } catch (e) {
    console.warn('[executionFlow] 手动创建绑定物化执行流水失败:', (e as Error).message);
  }
  // 方向编码类型(白名单外, 无流水物化): 类型自带 settles 方向, 直接落 settles 边。
  await syncSettlesByType(db, user.id, { documentId, contractNo, confidence: 1 });
  const sync = await syncBindingEdgeWithMeta(db, user.id, { docId: documentId, contractNo, relation, bindingId, confidence: 1, templateVersion: gate.templateVersion ?? undefined });
  const gs = await graphStatusFor(sync.outcome, sync.reason);
  await setBindingGraphStatus(db, bindingId, gs, user.id);
  return c.json({ ok: true, bindingId, graphSync: sync.outcome, ...(sync.reason ? { graphReason: sync.reason } : {}) });
});

bindingsRoute.post('/unbind', async (c) => {
  const user = c.get('user')!;
  const parsed = bindingIdSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid body' }, 400);
  const db = ctx();
  const row = await findBindingById(db, parsed.data.bindingId, user.id);
  if (!row) return c.json({ error: 'binding not found' }, 404);
  if (row.status !== 'confirmed') return c.json({ error: `binding status is ${row.status}, expected confirmed` }, 409);
  const ok = await updateBindingStatus(db, row.id, 'rejected', 'human', user.id);
  if (!ok) return c.json({ error: 'concurrent state change' }, 409);
  // 执行流水撤销(hook): 解绑后撤销该 binding 的执行流水; 失败仅告警, 绝不影响解绑结果。
  try {
    await retractExecutionFlow(db, row.id, user.id);
  } catch (e) {
    console.warn('[executionFlow] 解绑撤销执行流水失败:', (e as Error).message);
  }
  // 共享边守卫(spec §5.2): 同 (doc, contract) 还有其他 confirmed 行 -> 不删边。
  const siblings = (await listBindingsForContract(db, row.contractNo))
    .filter((b) => b.documentId === row.documentId && b.id !== row.id && b.status === 'confirmed');
  let graphSync: GraphSyncOutcome = 'ok';
  if (siblings.length === 0) {
    const sync = await removeBindingEdge({ docId: row.documentId, contractNo: row.contractNo });
    graphSync = sync.outcome;
    // settles 边同款守卫下删除(失败仅告警, 不影响解绑结果)。
    try {
      await removeSettlesEdge({ docId: row.documentId, contractNo: row.contractNo });
    } catch (e) {
      console.warn('[settlesGraphSync] 解绑删 settles 边失败:', (e as Error).message);
    }
  }
  return c.json({ ok: true, bindingId: row.id, graphSync });
});

const batchSchema = z.object({ bindingIds: z.array(z.string().min(1)).min(1) });

bindingsRoute.post('/batch-confirm', async (c) => {
  const user = c.get('user')!;
  const parsed = batchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid body' }, 400);
  const db = ctx();
  const results: Array<{ bindingId: string; ok: true; graphSync: string } | { bindingId: string; ok: false; error: string }> = [];
  for (const bindingId of parsed.data.bindingIds) {
    const r = await confirmOne(db, user.id, bindingId);
    if (r.status === 200) results.push({ bindingId, ok: true, graphSync: String(r.body.graphSync) });
    else results.push({ bindingId, ok: false, error: String((r.body as { error: string }).error) });
  }
  return c.json({ results });
});
