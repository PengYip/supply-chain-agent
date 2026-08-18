// 绑定工作台 REST 面(spec 2026-08-18 §5.1)。挂在 /api/bindings(requireAuth,
// index.ts)。写操作页面直连 + 前端二次确认, 不走对话审批链路。
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../lib/auth-middleware.js';
import { getDbContext } from '../pipeline/db/dbBackend.js';
import type { DbContext } from '../pipeline/db/client.js';
import {
  listUserDocuments, listBindingsForUser, listBindingProposals, listContractLedgerEntries,
} from '../pipeline/db/repositories.js';
import { buildBindingCandidates } from '../pipeline/bindingCandidates.js';

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
  const documents = docs.map((d) => ({
    docId: d.id,
    fileName: (d.sourceUri ?? '').split('/').pop() ?? d.sourceUri ?? '',
    docType: d.docType,
    createdAt: d.createdAt,
    bindings: byDoc.get(d.id) ?? [],
  }));
  return c.json({ documents });
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
