// Backend graph REST surface. Mounted at /api/graph in index.ts and
// gated there by requireAuth (any authenticated role may read; no requireRole).
// GET endpoints (read-only):
//   GET /documents — the current user's documents that have a graph node
//   GET /query     — bounded traversal from a subject elementId (Neo4j elementId)
//   GET /entities  — kind+name entity search (CONTAINS / exact)
//   GET /resolve   — docId + contractNo -> graph nodes (binding workbench link)
// Link workbench writes (spec 2026-08-25 方案A §6, graph_links 是 SSOT):
//   GET/POST /links* — correlates/relates/amends 提案-确认 + props 分摊录入通道
// Neo4j unconfigured (NEO4J_PASSWORD unset) or unreachable -> 503 with a clear
// Chinese message; the frontend surfaces it as "graph service unavailable".
// Link writes NEVER hard-fail on graph sync: outcome 落 graph_status 供重试。

import { Hono } from 'hono';
import { Neo4jError } from 'neo4j-driver';
import { z } from 'zod';
import type { AuthEnv } from '../lib/auth-middleware.js';
import { getDbContext } from '../pipeline/db/dbBackend.js';
import type { DbContext } from '../pipeline/db/client.js';
import {
  listUserDocuments,
  saveGraphLink,
  findGraphLinkById,
  findGraphLinkByTriple,
  listGraphLinkProposals,
  listGraphLinks,
  updateGraphLinkStatus,
  updateGraphLinkProps,
  setGraphLinkGraphStatus,
  type BindingGraphStatus,
  type GraphLinkRow,
} from '../pipeline/db/repositories.js';
import {
  graphQuery,
  findEntities,
  listDocumentNodes,
  graphLabelCounts,
  type GraphEntity,
} from '../graph/repo.js';
import { normalizeName } from '../graph/normalize.js';
import { syncGraphLinkEdge, removeGraphLinkEdge, type GraphLinkKind } from '../pipeline/graphLinkSync.js';

export const graphRoute = new Hono<AuthEnv>();

// One DbContext per call (getDbContext itself is a singleton in dbBackend, so
// this stays cheap); no local caching so per-user/test context swaps are seen.
function ctx(): DbContext {
  return getDbContext();
}

/** True when the failure means the graph store is missing or unusable (as
 *  opposed to a bad request): NEO4J_PASSWORD unset (getDriver throws a plain
 *  Error with a distinctive message) or a driver-level failure (connect / auth /
 *  service unavailable, which neo4j-driver surfaces as Neo4jError). */
function isGraphUnavailable(e: unknown): boolean {
  if (e instanceof Error && e.message.includes('NEO4J_PASSWORD not set')) return true;
  return e instanceof Neo4jError;
}

function errDetail(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const querySchema = z.object({
  subject: z.string().min(1, 'subject 必填'),
  depth: z.coerce.number().int().min(1).max(5).default(2),
  direction: z.enum(['out', 'in', 'both']).default('both'),
});

const entitiesSchema = z.object({
  kind: z.string().optional(),
  name: z.string().default(''),
  exact: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

const resolveSchema = z.object({
  docId: z.string().min(1).optional(),
  contractNo: z.string().min(1).optional(),
});

/** GET /api/graph/documents — list the current user's graph-backed documents. */
graphRoute.get('/documents', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);

  const docs = await listUserDocuments(ctx(), user.id);
  let nodes: GraphEntity[] = [];
  if (docs.length > 0) {
    try {
      nodes = await listDocumentNodes(docs.map((d) => d.id));
    } catch (e) {
      if (isGraphUnavailable(e)) {
        return c.json({ error: '图谱服务未配置或不可用' }, 503);
      }
      console.error('[graph] listDocumentNodes failed:', errDetail(e));
      return c.json({ error: 'documents query failed', detail: errDetail(e) }, 500);
    }
  }
  const byId = new Map(nodes.map((n) => [n.name, n]));
  // Only docs that have a graph node (graph_status written) are returned; the
  // frontend aligns the rest by itself. sourceUri/docType ride along so the
  // doc list and canvas node cards can show file names + business type even
  // when the graph node's own props are stale (pre-backfill).
  const documents = docs
    .filter((d) => byId.has(d.id))
    .map((d) => {
      const node = byId.get(d.id);
      return {
        docId: d.id,
        elementId: node?.elementId ?? '',
        kind: node?.kind ?? 'Document',
        name: node?.name ?? d.id,
        props: node?.props ?? {},
        docType: d.docType ?? '',
        sourceUri: d.sourceUri ?? '',
        createdAt: d.createdAt,
      };
    });
  return c.json({ documents });
});

/** GET /api/graph/query?subject=&depth=&direction= — bounded graph traversal. */
graphRoute.get('/query', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);

  const parsed = querySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json(
      {
        error: 'invalid query params',
        detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      },
      400,
    );
  }
  const { subject, depth, direction } = parsed.data;
  try {
    const res = await graphQuery({ subjectId: subject, depth, direction });
    return c.json(res);
  } catch (e) {
    if (isGraphUnavailable(e)) {
      return c.json({ error: '图谱服务未配置或不可用' }, 503);
    }
    if (e instanceof Error && e.message.startsWith('graphQuery: subject not found')) {
      return c.json({ error: 'subject not found', subject }, 404);
    }
    console.error('[graph] graphQuery failed:', errDetail(e));
    return c.json({ error: 'graph query failed', detail: errDetail(e) }, 500);
  }
});

/** GET /api/graph/entities?kind=&name=&exact= — kind+name entity search. */
graphRoute.get('/entities', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);

  const parsed = entitiesSchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json(
      {
        error: 'invalid query params',
        detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      },
      400,
    );
  }
  const { kind, name, exact } = parsed.data;
  try {
    const entities = await findEntities({ kind, name, exact });
    return c.json({ entities });
  } catch (e) {
    if (isGraphUnavailable(e)) {
      return c.json({ error: '图谱服务未配置或不可用' }, 503);
    }
    console.error('[graph] findEntities failed:', errDetail(e));
    return c.json({ error: 'entities query failed', detail: errDetail(e) }, 500);
  }
});

/** GET /api/graph/resolve?docId=&contractNo= — resolve a binding's endpoints to
 *  graph nodes. Binding workbench uses this to locate the mini-graph center:
 *  doc = Document node with name === docId; contract = Contract node with
 *  name === normalizeName(contractNo) (same convention as bindingGraphSync /
 *  graphWriter). Either side may be null when the binding has not been synced
 *  (graph_status failed/skipped) — the frontend shows "未同步到图谱". */
graphRoute.get('/resolve', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);

  const parsed = resolveSchema.safeParse(c.req.query());
  if (!parsed.success || (!parsed.data?.docId && !parsed.data?.contractNo)) {
    return c.json({ error: 'docId 与 contractNo 至少提供一个' }, 400);
  }
  const { docId, contractNo } = parsed.data;
  try {
    let doc: GraphEntity | null = null;
    let contract: GraphEntity | null = null;
    if (docId) {
      // Document.name = docId (exact); findEntities caps at 10, take first hit.
      const hits = await findEntities({ kind: 'Document', name: docId, exact: true });
      doc = hits[0] ?? null;
    }
    if (contractNo) {
      const normalized = normalizeName(contractNo);
      if (normalized) {
        const hits = await findEntities({ kind: 'Contract', name: normalized, exact: true });
        contract = hits[0] ?? null;
      }
    }
    return c.json({ doc, contract });
  } catch (e) {
    if (isGraphUnavailable(e)) {
      return c.json({ error: '图谱服务未配置或不可用' }, 503);
    }
    console.error('[graph] resolve failed:', errDetail(e));
    return c.json({ error: 'resolve query failed', detail: errDetail(e) }, 500);
  }
});

/** GET /api/graph/schema — 全部 label 计数(图例徽标, 60s 服务端缓存)。 */
graphRoute.get('/schema', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  try {
    const labels = await graphLabelCounts();
    return c.json({ labels });
  } catch (e) {
    if (isGraphUnavailable(e)) {
      return c.json({ error: '图谱服务未配置或不可用' }, 503);
    }
    console.error('[graph] graphLabelCounts failed:', errDetail(e));
    return c.json({ error: 'schema query failed', detail: errDetail(e) }, 500);
  }
});

// ---- Link workbench(spec 2026-08-25 方案A §6): /api/graph/links -------------
//
// graph_links 是 SSOT, 图上的 correlates/relates 边只是确认后的投影。图同步
// 永不阻塞业务写: outcome 落 graph_status(前端角标/重试)。服务端按 kind 强制
// 节点类型(correlates=Contract/Contract, relates=Project/Project), 防乱配。

const LINK_KINDS: Record<GraphLinkKind, { srcKind: 'Contract' | 'Project' | 'Document'; dstKind: 'Contract' | 'Project' | 'Document' }> = {
  correlates: { srcKind: 'Contract', dstKind: 'Contract' },
  relates: { srcKind: 'Project', dstKind: 'Project' },
  amends: { srcKind: 'Document', dstKind: 'Contract' },
};

/** props 白名单: share/type/note + Phase 3 分摊键。其余键在路由层剥离。 */
const linkPropsSchema = z.object({
  share: z.number().min(0).max(1).optional(),
  type: z.string().max(50).optional(),
  note: z.string().max(500).optional(),
  allocatedAmount: z.number().optional(),
  allocatedQuantity: z.number().optional(),
}).strip();

const linkCreateSchema = z.object({
  kind: z.enum(['correlates', 'relates', 'amends']),
  srcKey: z.string().min(1, 'srcKey 必填'),
  srcLabel: z.string().optional(),
  dstKey: z.string().min(1, 'dstKey 必填'),
  dstLabel: z.string().optional(),
  props: linkPropsSchema.optional(),
  confidence: z.number().min(0).max(1).optional(),
});

function linkGraphStatus(outcome: 'ok' | 'skipped' | 'failed', reason?: string): BindingGraphStatus {
  return outcome === 'ok'
    ? { status: 'ok', syncedAt: new Date().toISOString() }
    : { status: outcome, ...(reason ? { reason } : {}), syncedAt: new Date().toISOString() };
}

function linkRowJson(r: GraphLinkRow) {
  return {
    id: r.id, kind: r.kind,
    srcKind: r.srcKind, srcKey: r.srcKey, srcLabel: r.srcLabel,
    dstKind: r.dstKind, dstKey: r.dstKey, dstLabel: r.dstLabel,
    props: r.props, confidence: r.confidence,
    status: r.status, confirmationSource: r.confirmationSource,
    createdAt: r.createdAt, graphStatus: r.graphStatus,
  };
}

/** confirmed 行的边同步(工作台直建/确认/props 更新共用)。 */
async function syncLinkEdgeForRow(db: DbContext, userId: string, row: GraphLinkRow) {
  const sync = await syncGraphLinkEdge({
    kind: row.kind as GraphLinkKind,
    srcKind: row.srcKind as 'Contract' | 'Project' | 'Document', srcKey: row.srcKey,
    dstKind: row.dstKind as 'Contract' | 'Project' | 'Document', dstKey: row.dstKey,
    props: row.props,
    confirmationSource: (row.confirmationSource === 'agent' ? 'agent' : 'human'),
    confidence: row.confidence,
  });
  await setGraphLinkGraphStatus(db, row.id, linkGraphStatus(sync.outcome, sync.reason), userId);
  return sync;
}

/** GET /api/graph/links — 当前列表(默认排除 rejected)。 */
graphRoute.get('/links', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const rows = await listGraphLinks(ctx(), user.id);
  return c.json({ links: rows.filter((r) => r.status !== 'rejected').map(linkRowJson) });
});

/** GET /api/graph/links/proposals — 待确认提案。 */
graphRoute.get('/links/proposals', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const rows = await listGraphLinkProposals(ctx(), user.id);
  return c.json({ proposals: rows.map(linkRowJson) });
});

/** POST /api/graph/links — 人工作台直建 confirmed(human), triple 幂等。 */
graphRoute.post('/links', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const parsed = linkCreateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'invalid body', detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) }, 400);
  }
  const { kind, srcKey, dstKey } = parsed.data;
  const db = ctx();
  const kinds = LINK_KINDS[kind];
  const existing = await findGraphLinkByTriple(db, { kind, srcKey, dstKey }, user.id);
  if (existing && existing.status !== 'rejected') {
    // 幂等重试入口: 更新 label/props 并对 confirmed 行重跑边同步。
    const linkId = await saveGraphLink(db, {
      kind, srcKind: kinds.srcKind, srcKey, srcLabel: parsed.data.srcLabel,
      dstKind: kinds.dstKind, dstKey, dstLabel: parsed.data.dstLabel,
      props: parsed.data.props, confidence: parsed.data.confidence,
      status: existing.status, confirmationSource: existing.confirmationSource, createdBy: user.id,
    }, user.id);
    let graphSync = 'ok';
    if (existing.status === 'confirmed') {
      const row = await findGraphLinkById(db, linkId, user.id);
      if (row) graphSync = (await syncLinkEdgeForRow(db, user.id, row)).outcome;
    }
    return c.json({ ok: true, linkId, existing: true, graphSync });
  }
  const linkId = await saveGraphLink(db, {
    kind, srcKind: kinds.srcKind, srcKey, srcLabel: parsed.data.srcLabel,
    dstKind: kinds.dstKind, dstKey, dstLabel: parsed.data.dstLabel,
    props: parsed.data.props, confidence: parsed.data.confidence,
    status: 'confirmed', confirmationSource: 'human', createdBy: user.id,
  }, user.id);
  const row = await findGraphLinkById(db, linkId, user.id);
  const graphSync = row ? (await syncLinkEdgeForRow(db, user.id, row)).outcome : 'ok';
  return c.json({ ok: true, linkId, graphSync });
});

const linkIdSchema = z.object({ id: z.string().min(1) });

/** POST /api/graph/links/confirm — proposed -> confirmed(human) + 边同步。 */
graphRoute.post('/links/confirm', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const parsed = linkIdSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid body' }, 400);
  const db = ctx();
  const row = await findGraphLinkById(db, parsed.data.id, user.id);
  if (!row) return c.json({ error: 'link not found', id: parsed.data.id }, 404);
  if (row.status !== 'proposed') return c.json({ error: `link status is ${row.status}, expected proposed`, id: row.id }, 409);
  const ok = await updateGraphLinkStatus(db, row.id, 'confirmed', 'human', user.id);
  if (!ok) return c.json({ error: 'concurrent state change', id: row.id }, 409);
  const fresh = await findGraphLinkById(db, row.id, user.id);
  const sync = fresh ? await syncLinkEdgeForRow(db, user.id, fresh) : { outcome: 'skipped' as const };
  return c.json({ ok: true, linkId: row.id, graphSync: sync.outcome });
});

/** POST /api/graph/links/reject — proposed -> rejected。 */
graphRoute.post('/links/reject', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const parsed = linkIdSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid body' }, 400);
  const db = ctx();
  const row = await findGraphLinkById(db, parsed.data.id, user.id);
  if (!row) return c.json({ error: 'link not found', id: parsed.data.id }, 404);
  if (row.status !== 'proposed') return c.json({ error: `link status is ${row.status}, expected proposed`, id: row.id }, 409);
  const ok = await updateGraphLinkStatus(db, row.id, 'rejected', 'human', user.id);
  if (!ok) return c.json({ error: 'concurrent state change', id: row.id }, 409);
  return c.json({ ok: true, linkId: row.id });
});

/** POST /api/graph/links/remove — confirmed -> rejected + 删边(幂等)。 */
graphRoute.post('/links/remove', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const parsed = linkIdSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid body' }, 400);
  const db = ctx();
  const row = await findGraphLinkById(db, parsed.data.id, user.id);
  if (!row) return c.json({ error: 'link not found', id: parsed.data.id }, 404);
  if (row.status !== 'confirmed') return c.json({ error: `link status is ${row.status}, expected confirmed`, id: row.id }, 409);
  const ok = await updateGraphLinkStatus(db, row.id, 'rejected', 'human', user.id);
  if (!ok) return c.json({ error: 'concurrent state change', id: row.id }, 409);
  let graphSync = 'ok';
  try {
    const sync = await removeGraphLinkEdge({
      kind: row.kind as GraphLinkKind,
      srcKind: row.srcKind as 'Contract' | 'Project' | 'Document', srcKey: row.srcKey,
      dstKind: row.dstKind as 'Contract' | 'Project' | 'Document', dstKey: row.dstKey,
    });
    graphSync = sync.outcome;
  } catch (e) {
    console.warn('[graphLinks] remove 删边失败:', errDetail(e));
    graphSync = 'failed';
  }
  return c.json({ ok: true, linkId: row.id, graphSync });
});

const linkPropsPatchSchema = z.object({ props: linkPropsSchema });

/** PATCH /api/graph/links/:id/props — 白名单键合并; confirmed 行重同步边。
 *  Phase 3 分摊录入通道(allocatedAmount/allocatedQuantity, HITL)。 */
graphRoute.patch('/links/:id/props', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const parsed = linkPropsPatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid body' }, 400);
  const id = c.req.param('id');
  const db = ctx();
  const row = await findGraphLinkById(db, id, user.id);
  if (!row || row.status === 'rejected') return c.json({ error: 'link not found', id }, 404);
  const patch = Object.fromEntries(Object.entries(parsed.data.props).filter(([, v]) => v !== undefined));
  const ok = await updateGraphLinkProps(db, id, patch, user.id);
  if (!ok) return c.json({ error: 'props update failed', id }, 409);
  let graphSync = 'ok';
  if (row.status === 'confirmed') {
    const fresh = await findGraphLinkById(db, id, user.id);
    if (fresh) graphSync = (await syncLinkEdgeForRow(db, user.id, fresh)).outcome;
  }
  return c.json({ ok: true, linkId: id, graphSync });
});
