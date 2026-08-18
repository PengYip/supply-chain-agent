// Backend graph REST surface (read-only). Mounted at /api/graph in index.ts and
// gated there by requireAuth (any authenticated role may read; no requireRole).
// Four GET endpoints:
//   GET /documents — the current user's documents that have a graph node
//   GET /query     — bounded traversal from a subject elementId (Neo4j elementId)
//   GET /entities  — kind+name entity search (CONTAINS / exact)
//   GET /resolve   — docId + contractNo -> graph nodes (binding workbench link)
// Neo4j unconfigured (NEO4J_PASSWORD unset) or unreachable -> 503 with a clear
// Chinese message; the frontend surfaces it as "graph service unavailable".

import { Hono } from 'hono';
import { Neo4jError } from 'neo4j-driver';
import { z } from 'zod';
import type { AuthEnv } from '../lib/auth-middleware.js';
import { getDbContext } from '../pipeline/db/dbBackend.js';
import type { DbContext } from '../pipeline/db/client.js';
import { listUserDocuments } from '../pipeline/db/repositories.js';
import {
  graphQuery,
  findEntities,
  listDocumentNodes,
  type GraphEntity,
} from '../graph/repo.js';
import { normalizeName } from '../graph/normalize.js';

export const graphRoute = new Hono<AuthEnv>();

// One DbContext reused across requests (same pipeline.db / Postgres as the agent,
// so graph rows align with the documents table).
let _ctx: DbContext | null = null;
function ctx(): DbContext {
  if (!_ctx) _ctx = getDbContext();
  return _ctx;
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
