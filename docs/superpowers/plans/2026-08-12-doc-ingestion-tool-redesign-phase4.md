# Phase 4 — Relation Graph Layer (Neo4j-primary) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a heterogeneous entity graph backed by the existing Neo4j instance on ubuntu-server, exposed via three L2 agent tools (`create_entity`, `link_entities`, `graph_query`), and retire the volatile in-memory `link_document` tool plus two orphaned Postgres-only tables.

**Architecture:** Neo4j is the sole graph store (no SQLite graph tables). A lazy process-wide driver singleton (`graph/neo4j.ts`) connects to the existing ubuntu-server Neo4j. A Cypher repository (`graph/repo.ts`) implements three operations with open-schema (open-string `kind`, JSON `props`) using injection-safe `$($kind)` dynamic labels/types (Neo4j 5.26+) with a validated-token interpolation fallback. Three L2 tools wrap the repo and register in the four harness places (registry, permissions, context-contract, approval stamp). Extraction-byproduct is deferred (only 合同 has a field schema today).

**Tech Stack:** TypeScript, `neo4j-driver@6.2.0`, AI SDK 6, Hono, vitest, existing Neo4j 5.x instance on ubuntu-server.

## Global Constraints

- **neo4j-driver 6.2.0.** Use ONLY `session.executeRead(fn)` / `session.executeWrite(fn)` — `readTransaction`/`writeTransaction` were removed in 6.x. Only `Neo4jError` exists in 6.x (no `ServiceUnavailableError` etc.); use `neo4j.isRetryableError(err)`. Node ≥18.
- **Neo4j connection.** All environments (dev / CI / prod) connect to the existing Neo4j instance on ubuntu-server over the network. Env keys (flat, zod, permissive): `NEO4J_URL` (default `bolt://localhost:7687`), `NEO4J_USER` (default `neo4j`), `NEO4J_PASSWORD` (default `''`). Graph integration tests gate on `describe.skipIf(!process.env.NEO4J_PASSWORD)` — they RUN when the password is set (per user decision, all envs set it) and SKIP only as an offline-dev safety net. This is a TEST guard, not a runtime degrade.
- **Runtime behavior (no silent degrade).** `getDriver()` throws if `NEO4J_PASSWORD` is unset; boot calls `verifyConnectivity()` and **logs a warning on failure but does not crash** (so chat/ingest keep working if Neo4j is briefly unreachable). Graph tool `execute()` calls `getDriver()` and surfaces any `Neo4jError` as a structured tool error — it never silently no-ops.
- **elementId is node identity.** Use the string `node.elementId` (NOT the deprecated integer `identity`). Match via `WHERE elementId(n) = $id`. The durable business key is `(kind, name)` backed by a unique constraint.
- **Dynamic labels/types.** Primary path uses `$($kind)` parameter form (injection-safe, requires Neo4j server ≥5.26 — **ops must confirm via `RETURN version()`**). Fallback for <5.26: `assertToken` whitelist + interpolation. Constraint DDL ALWAYS uses `assertToken` interpolation (constraints cannot use `$()`). Property VALUES are always `$params` (never interpolated).
- **AI SDK 6.** Tools use `inputSchema` (not `parameters`); L2 via `needsApproval: true` stamped at registry registration (NOT v7 `toolApproval`).
- **Tool registration = 4 places per tool:** `roleToolRegistry.ts` (`getToolsForRole` append + `TRADER_CTX_TOOL_NAMES` array), `needsApproval: true` stamp, `permissionGate.ts` `registerPermission('name','L2')`, `contextContract.ts` `TOOL_CONTEXT_CONTRACTS` entry. `assertAllToolsContracted` (`agent.ts:71`) hard-fails at boot if any registered tool lacks a contract.
- **Graph contract posture.** `create_entity`/`link_entities`/`graph_query` take and return agent-supplied strings only (no document-derived text) → contract `{ output:'raw', budget:'full', signal:'env', persist:'graph', risk:{ level:'L2', injection:'safe' } }`. (If a future variant surfaces extracted text, switch `output:'tagged'` + `injection:'external'` per `tagExternal`.)
- **Test isolation.** Graph integration tests tag every created node with `scaRunId: $runId` (`runId = sca-test-${pid}-${Date.now()}`) and run `MATCH (n {scaRunId:$runId}) DETACH DELETE n` in `beforeAll`/`afterAll`. NEVER run a full `MATCH (n) DETACH DELETE n`. NEVER assume a separate database (Enterprise-only).
- **No emoji** in code or comments. Backend = `apps/server/` (root `server/` is stale — ignore). Verification order: build → lint → test. Non-graph tests use `OPENAI_API_KEY=ci-dummy-key` (env.ts zod-parses at import).

## Pre-flight ops check (do once, before Task 1)

- [ ] On ubuntu-server: `cypher-shell -u neo4j -p <pass> "RETURN version()"` → confirm ≥ `5.26`. If lower, Plan D still works (assertToken fallback) but flag it to the team. Record the actual version in `.superpowers/sdd/progress.md`.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `apps/server/src/graph/neo4j.ts` (NEW) | Lazy driver singleton, `getDriver()`, `closeNeo4j()` | T1 |
| `apps/server/src/env.ts` (MODIFY) | Add `NEO4J_URL` / `NEO4J_USER` / `NEO4J_PASSWORD` zod keys | T1 |
| `apps/server/src/index.ts` (MODIFY) | Boot `verifyConnectivity()` (warn-on-fail); `closeNeo4j()` on SIGTERM/SIGINT | T1 |
| `apps/server/test/graph/neo4j.test.ts` (NEW) | Connectivity test (skip-guarded) | T1 |
| `apps/server/src/graph/repo.ts` (NEW) | `assertToken`, `ensureNameConstraint`, `createEntity`, `linkEntities`, `graphQuery` + types | T2 |
| `apps/server/test/graph/repo.test.ts` (NEW) | Live Neo4j repo tests (skip-guarded, run-id cleanup) | T2 |
| `apps/server/src/graph/tools.ts` (NEW) | `buildCreateEntityTool`, `buildLinkEntitiesTool`, `buildGraphQueryTool` | T3 |
| `apps/server/src/harness/roleToolRegistry.ts` (MODIFY) | Append 3 tools to `getToolsForRole` + `TRADER_CTX_TOOL_NAMES` | T3 |
| `apps/server/src/harness/permissionGate.ts` (MODIFY) | `registerPermission` ×3 at L2 | T3 |
| `apps/server/src/harness/contextContract.ts` (MODIFY) | 3 contract entries | T3 |
| `apps/server/test/graph/tools.test.ts` (NEW) | Tool execute tests + `assertAllToolsContracted` passes | T3 |
| `apps/server/src/tools/writes.ts` (MODIFY) | Remove `linkDocument` tool export | T4 |
| `apps/server/src/harness/roleToolRegistry.ts` (MODIFY) | Remove `link_document` from `BASE_TOOLS_FOR_ROLE` | T4 |
| `apps/server/src/harness/permissionGate.ts` (MODIFY) | Remove `link_document` registration | T4 |
| `apps/server/src/harness/contextContract.ts` (MODIFY) | Remove `link_document` contract entry | T4 |
| `apps/server/src/pipeline/db/postgres-schema.ts` (MODIFY) | Delete orphaned `document_relation` + `doc_contract` tables | T4 |
| pin-count tests (MODIFY) | Update exact tool-count assertions (−1 then +3 = net +2) | T3/T4 |

**Cross-task interface contract:**
- T1 produces `getDriver(): Driver`, `closeNeo4j(): Promise<void>`.
- T2 types: `EntityKind = string`; `GraphEntity = { elementId: string; kind: string; name: string; props: Record<string, unknown> }`; `GraphEdge = { elementId: string; type: string; srcId: string; dstId: string; props: Record<string, unknown>; confidence: number }`; `GraphQueryResult = { subject: GraphEntity; nodes: GraphEntity[]; edges: GraphEdge[] }`.
- T2 functions: `createEntity({kind,name,props?})`, `linkEntities({srcId,dstId,kind,props?,confidence?,sourceSpan?})`, `graphQuery({subjectId,depth?,edgeKinds?,direction?})`, `ensureNameConstraint(kind)`, `assertToken(kind,what)`.
- T3 tools wrap T2 functions; return shapes: create_entity → `{elementId,kind,name,created}`; link_entities → `{edgeId,type,srcId,dstId}`; graph_query → `{subject,nodes,edges}`.

---

### Task 1: Neo4j driver singleton + env config + boot wiring

**Files:**
- Create: `apps/server/src/graph/neo4j.ts`
- Modify: `apps/server/src/env.ts`, `apps/server/src/index.ts`
- Test: `apps/server/test/graph/neo4j.test.ts`

**Interfaces:**
- Produces: `getDriver(): Driver`, `closeNeo4j(): Promise<void>`.

- [ ] **Step 1: Add the dependency**

Run: `npm install neo4j-driver@6.2.0 --workspace apps/server`
Expected: `neo4j-driver` appears in `apps/server/package.json` dependencies.

- [ ] **Step 2: Add env keys**

In `apps/server/src/env.ts`, inside the `EnvSchema = z.object({...})`, add a Neo4j block (flat keys, permissive defaults — mirror the MinIO block at `env.ts:39-44`):

```ts
NEO4J_URL: z.string().default('bolt://localhost:7687'),
NEO4J_USER: z.string().default('neo4j'),
NEO4J_PASSWORD: z.string().default(''),
```

- [ ] **Step 3: Write the failing test**

Create `apps/server/test/graph/neo4j.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import neo4j from 'neo4j-driver';
import { getDriver, closeNeo4j } from '../../src/graph/neo4j.js';

const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD ?? '';
const NEO4J_URL = process.env.NEO4J_URL ?? 'bolt://localhost:7687';
const NEO4J_USER = process.env.NEO4J_USER ?? 'neo4j';

describe.skipIf(!NEO4J_PASSWORD)('neo4j driver singleton (live)', () => {
  it('getDriver returns a connected driver and is a singleton', async () => {
    const d1 = getDriver();
    const d2 = getDriver();
    expect(d1).toBe(d2); // singleton
    await d1.verifyConnectivity(); // throws if unreachable
    await closeNeo4j();
  });

  it('closeNeo4j resets the singleton so the next getDriver creates a new one', async () => {
    const d1 = getDriver();
    await closeNeo4j();
    const d2 = getDriver();
    expect(d2).not.toBe(d1);
    await d2.verifyConnectivity();
    await closeNeo4j();
  });
});

describe('neo4j driver (offline)', () => {
  it('getDriver throws when NEO4J_PASSWORD is empty', async () => {
    const orig = process.env.NEO4J_PASSWORD;
    process.env.NEO4J_PASSWORD = '';
    try {
      await closeNeo4j(); // ensure singleton cleared
      expect(() => getDriver()).toThrow(/NEO4J_PASSWORD/);
    } finally {
      process.env.NEO4J_PASSWORD = orig;
      await closeNeo4j();
    }
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npm test --workspace apps/server -- test/graph/neo4j.test.ts`
Expected: FAIL — cannot resolve `../../src/graph/neo4j.js`.

- [ ] **Step 5: Implement the singleton**

Create `apps/server/src/graph/neo4j.ts`:

```ts
import neo4j, { type Driver } from 'neo4j-driver';

let driver: Driver | null = null;

export function getDriver(): Driver {
  if (!driver) {
    const url = process.env.NEO4J_URL ?? 'bolt://localhost:7687';
    const user = process.env.NEO4J_USER ?? 'neo4j';
    const pass = process.env.NEO4J_PASSWORD ?? '';
    if (!pass) throw new Error('NEO4J_PASSWORD not set; graph tools unavailable');
    driver = neo4j.driver(url, neo4j.auth.basic(user, pass), {
      connectionTimeout: 5000,
      connectionAcquisitionTimeout: 10000,
      maxConnectionPoolSize: 50,
      maxTransactionRetryTime: 10000,
      disableLosslessIntegers: true,
    });
  }
  return driver;
}

export async function closeNeo4j(): Promise<void> {
  if (driver) {
    await driver.close();
    driver = null;
  }
}
```

- [ ] **Step 6: Run test to verify it passes**

Run (with creds): `NEO4J_URL=<ubuntu-server> NEO4J_USER=neo4j NEO4J_PASSWORD=<pass> npm test --workspace apps/server -- test/graph/neo4j.test.ts`
Run (without creds): same command with `NEO4J_PASSWORD=` → the live `describe.skipIf` block skips, the offline block passes.
Expected: PASS (or skip when no password).

- [ ] **Step 7: Wire boot + graceful shutdown**

In `apps/server/src/index.ts`, after `migrateOnStartup()` / `ensureBucket()` and before `serve(...)`, add a best-effort connectivity check (warn, do not crash):

```ts
import { getDriver, closeNeo4j } from './graph/neo4j.js';
// ... after ensureBucket(), before serve():
if (process.env.NEO4J_PASSWORD) {
  try {
    await getDriver().verifyConnectivity();
    console.log('[boot] neo4j connectivity ok');
  } catch (e) {
    console.warn('[boot] neo4j unreachable, graph tools will error per-call:', (e as Error).message);
  }
}
process.on('SIGTERM', async () => { await closeNeo4j(); });
process.on('SIGINT', async () => { await closeNeo4j(); });
```

(Place the `process.on` registrations once at module top-level; keep them idempotent. Match the existing index.ts style — do not reorder the instrumentation import which must stay first.)

- [ ] **Step 8: Commit**

```bash
git add apps/server/package.json apps/server/src/graph/neo4j.ts apps/server/src/env.ts \
        apps/server/src/index.ts apps/server/test/graph/neo4j.test.ts
git commit -m "feat: add neo4j driver singleton + env config + boot wiring"
```

---

### Task 2: Graph repository (Cypher operations)

**Files:**
- Create: `apps/server/src/graph/repo.ts`
- Test: `apps/server/test/graph/repo.test.ts`

**Interfaces:**
- Consumes: `getDriver` (T1).
- Produces: types `GraphEntity`, `GraphEdge`, `GraphQueryResult`, `Direction`; functions `assertToken`, `ensureNameConstraint`, `createEntity`, `linkEntities`, `graphQuery`.

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/graph/repo.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import neo4j, { type Driver, type Session } from 'neo4j-driver';
import {
  assertToken,
  ensureNameConstraint,
  createEntity,
  linkEntities,
  graphQuery,
} from '../../src/graph/repo.js';

const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD ?? '';
const NEO4J_URL = process.env.NEO4J_URL ?? 'bolt://localhost:7687';
const NEO4J_USER = process.env.NEO4J_USER ?? 'neo4j';
const RUN_ID = `sca-test-${process.pid}-${Date.now()}`;
const skip = !NEO4J_PASSWORD;

let driver: Driver;
let session: Session;

describe('assertToken (offline)', () => {
  it('accepts a valid Cypher identifier', () => {
    expect(assertToken('Party', 'label')).toBe('Party');
    expect(assertToken('buyer_of', 'relType')).toBe('buyer_of');
  });
  it('rejects non-identifier input', () => {
    expect(() => assertToken('a b', 'label')).toThrow();
    expect(() => assertToken("';--", 'relType')).toThrow();
    expect(() => assertToken('', 'label')).toThrow();
  });
});

describe.skipIf(skip)('graph repo (live Neo4j)', () => {
  beforeAll(async () => {
    driver = neo4j.driver(NEO4J_URL, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD), { connectionTimeout: 5000 });
    session = driver.session();
    await driver.verifyConnectivity();
    await session.executeWrite((tx) => tx.run('MATCH (n {scaRunId:$runId}) DETACH DELETE n', { runId: RUN_ID }));
  }, 30_000);

  afterAll(async () => {
    try {
      await session.executeWrite((tx) => tx.run('MATCH (n {scaRunId:$runId}) DETACH DELETE n', { runId: RUN_ID }));
    } finally {
      await session.close();
      await driver.close();
    }
  }, 30_000);

  it('createEntity is idempotent on (kind,name) and reports created vs matched', async () => {
    await ensureNameConstraint('Party');
    const a = await createEntity({ kind: 'Party', name: 'ACME', props: { scaRunId: RUN_ID, country: 'CN' } });
    const b = await createEntity({ kind: 'Party', name: 'ACME', props: { scaRunId: RUN_ID, country: 'CN' } });
    expect(a.elementId).toBe(b.elementId); // same node
    expect(a.kind).toBe('Party');
    expect(a.name).toBe('ACME');
    // first call created, second matched — created flag is observable via two distinct names:
    const c = await createEntity({ kind: 'Party', name: 'Globex', props: { scaRunId: RUN_ID } });
    expect(c.elementId).not.toBe(a.elementId);
  });

  it('linkEntities connects two existing nodes by elementId', async () => {
    const buyer = await createEntity({ kind: 'Party', name: `Buyer-${RUN_ID}`, props: { scaRunId: RUN_ID } });
    const contract = await createEntity({ kind: 'Contract', name: `C-${RUN_ID}`, props: { scaRunId: RUN_ID } });
    const edge = await linkEntities({
      srcId: buyer.elementId,
      dstId: contract.elementId,
      kind: 'buyer_of',
      confidence: 0.9,
      props: { scaRunId: RUN_ID },
    });
    expect(edge.type).toBe('buyer_of');
    expect(edge.srcId).toBe(buyer.elementId);
    expect(edge.dstId).toBe(contract.elementId);
  });

  it('linkEntities errors when a referenced node does not exist', async () => {
    await expect(
      linkEntities({ srcId: '4:nonexistent:0', dstId: '4:nonexistent:1', kind: 'x', props: {} }),
    ).rejects.toThrow(/not found|no rows/i);
  });

  it('graphQuery returns the subject + 1-hop neighborhood, depth-bounded and deduped', async () => {
    const buyer = await createEntity({ kind: 'Party', name: `QBuyer-${RUN_ID}`, props: { scaRunId: RUN_ID } });
    const contract = await createEntity({ kind: 'Contract', name: `QC-${RUN_ID}`, props: { scaRunId: RUN_ID } });
    await linkEntities({ srcId: buyer.elementId, dstId: contract.elementId, kind: 'buyer_of', props: { scaRunId: RUN_ID } });
    const res = await graphQuery({ subjectId: buyer.elementId, depth: 2 });
    expect(res.subject.elementId).toBe(buyer.elementId);
    const neighborIds = res.nodes.map((n) => n.elementId);
    expect(neighborIds).toContain(contract.elementId);
    expect(res.edges.some((e) => e.type === 'buyer_of')).toBe(true);
  });

  it('graphQuery filters by edgeKinds and respects direction', async () => {
    const a = await createEntity({ kind: 'Party', name: `DirA-${RUN_ID}`, props: { scaRunId: RUN_ID } });
    const b = await createEntity({ kind: 'Party', name: `DirB-${RUN_ID}`, props: { scaRunId: RUN_ID } });
    await linkEntities({ srcId: a.elementId, dstId: b.elementId, kind: 'related_party', props: { scaRunId: RUN_ID } });
    const out = await graphQuery({ subjectId: a.elementId, depth: 1, edgeKinds: ['related_party'], direction: 'out' });
    expect(out.nodes.map((n) => n.elementId)).toContain(b.elementId);
    const inward = await graphQuery({ subjectId: a.elementId, depth: 1, edgeKinds: ['related_party'], direction: 'in' });
    expect(inward.nodes.map((n) => n.elementId)).not.toContain(b.elementId); // a is the source, not target
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `NEO4J_PASSWORD=<pass> NEO4J_URL=<ubuntu-server> npm test --workspace apps/server -- test/graph/repo.test.ts`
Expected: FAIL — `../../src/graph/repo.js` not resolvable. (The offline `assertToken` block also fails.)

- [ ] **Step 3: Implement the repository**

Create `apps/server/src/graph/repo.ts`:

```ts
import neo4j, { type Node, type Relationship } from 'neo4j-driver';
import { getDriver } from './neo4j.js';

/**
 * Relation graph layer (design §7). Neo4j-primary, open schema: node label and
 * relationship type are open strings (validated identifiers); props are JSON.
 * Dynamic labels/types use the injection-safe $($kind) form (Neo4j >= 5.26);
 * assertToken + interpolation is the <5.26 fallback and is always used for
 * constraint DDL (which cannot use $($kind)).
 */

export type EntityKind = string;
export type Direction = 'out' | 'in' | 'both';

export interface GraphEntity {
  elementId: string;
  kind: string;
  name: string;
  props: Record<string, unknown>;
}
export interface GraphEdge {
  elementId: string;
  type: string;
  srcId: string;
  dstId: string;
  props: Record<string, unknown>;
  confidence: number;
}
export interface GraphQueryResult {
  subject: GraphEntity;
  nodes: GraphEntity[];
  edges: GraphEdge[];
}

const TOKEN_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function assertToken(kind: string, what: 'label' | 'relType'): string {
  if (!TOKEN_RE.test(kind)) {
    throw new Error(`Invalid ${what} '${kind}' — must match ${TOKEN_RE}`);
  }
  return kind;
}

const ensuredConstraints = new Set<string>();
export async function ensureNameConstraint(kind: string): Promise<void> {
  const label = assertToken(kind, 'label');
  if (ensuredConstraints.has(label)) return;
  const session = getDriver().session();
  try {
    await session.executeWrite((txc) =>
      txc.run(
        `CREATE CONSTRAINT sca_name_${label} IF NOT EXISTS FOR (n:${label}) REQUIRE n.name IS UNIQUE`,
      ),
    );
    ensuredConstraints.add(label);
  } finally {
    await session.close();
  }
}

function nodeToEntity(n: Node): GraphEntity {
  const labels: string[] = n.labels;
  const props = (n.properties ?? {}) as Record<string, unknown>;
  return {
    elementId: n.elementId,
    kind: labels[0] ?? '',
    name: String(props.name ?? ''),
    props,
  };
}
function relToEdge(r: Relationship): GraphEdge {
  const props = (r.properties ?? {}) as Record<string, unknown>;
  return {
    elementId: r.elementId,
    type: r.type,
    srcId: r.startNodeElementId,
    dstId: r.endNodeElementId,
    props,
    confidence: typeof props.confidence === 'number' ? props.confidence : 0,
  };
}

export interface CreateEntityInput {
  kind: string;
  name: string;
  props?: Record<string, unknown>;
}
export async function createEntity(input: CreateEntityInput): Promise<GraphEntity & { created: boolean }> {
  await ensureNameConstraint(input.kind);
  const cypher = `
    MERGE (n:$($kind) {name: $name})
    ON CREATE SET n += $props, n.createdAt = datetime()
    ON MATCH  SET n += $props
    RETURN elementId(n) AS elementId, labels(n) AS labels, n AS node
  `;
  const session = getDriver().session();
  try {
    const { records, summary } = await session.executeWrite(async (txc) => {
      const result = await txc.run(cypher, {
        kind: input.kind,
        name: input.name,
        props: input.props ?? {},
      });
      return result;
    });
    const rec = records[0];
    const node = rec.get('node') as Node;
    const created = summary.counters.updates().nodesCreated === 1;
    const entity = nodeToEntity(node);
    return { ...entity, created };
  } finally {
    await session.close();
  }
}

export interface LinkEntitiesInput {
  srcId: string;
  dstId: string;
  kind: string;
  props?: Record<string, unknown>;
  confidence?: number;
  sourceSpan?: unknown;
}
export async function linkEntities(input: LinkEntitiesInput): Promise<GraphEdge> {
  const cypher = `
    MATCH (a) WHERE elementId(a) = $srcId
    MATCH (b) WHERE elementId(b) = $dstId
    CREATE (a)-[r:$($kind)]->(b)
    SET r += $props, r.confidence = $confidence, r.createdAt = datetime()
    RETURN r AS rel
  `;
  const props = { ...(input.props ?? {}) };
  if (input.sourceSpan !== undefined) props.sourceSpan = input.sourceSpan;
  const session = getDriver().session();
  try {
    const { records } = await session.executeWrite(async (txc) => {
      const result = await txc.run(cypher, {
        srcId: input.srcId,
        dstId: input.dstId,
        kind: input.kind,
        props,
        confidence: input.confidence ?? 0,
      });
      return result;
    });
    if (records.length === 0) {
      throw new Error(`linkEntities: src or dst node not found (src=${input.srcId} dst=${input.dstId})`);
    }
    return relToEdge(records[0].get('rel') as Relationship);
  } finally {
    await session.close();
  }
}

const DIR_TEMPLATES: Record<Direction, string> = {
  out: '-[:$($edgeKinds)]->',
  in: '<-[:$($edgeKinds)]-',
  both: '-[:$($edgeKinds)]-',
};
function buildTraversal(direction: Direction, depth: number, withKinds: boolean): string {
  const d = Math.min(Math.max(Math.trunc(depth) || 1, 1), 5);
  const tmpl = DIR_TEMPLATES[direction];
  const rel = withKinds ? tmpl : tmpl.replace('[:$($edgeKinds)]', '[]');
  return `(subject)${rel}{1,${d}}(m)`;
}

export interface GraphQueryInput {
  subjectId: string;
  depth?: number;
  edgeKinds?: string[];
  direction?: Direction;
}
export async function graphQuery(input: GraphQueryInput): Promise<GraphQueryResult> {
  const depth = input.depth ?? 2;
  const direction: Direction = input.direction ?? 'both';
  const edgeKinds = input.edgeKinds ?? [];
  const withKinds = edgeKinds.length > 0;
  const traversal = buildTraversal(direction, depth, withKinds);
  const subjectCypher = `MATCH (subject) WHERE elementId(subject) = $subjectId RETURN subject AS subject`;
  const neighborhoodCypher = `
    MATCH (subject) WHERE elementId(subject) = $subjectId
    OPTIONAL MATCH p = ${traversal}
    WITH subject, m, p WHERE m IS NOT NULL
    UNWIND relationships(p) AS rel
    WITH subject, m, rel
    RETURN collect(DISTINCT m) AS nodes, collect(DISTINCT rel) AS edges
  `;
  const session = getDriver().session({ defaultAccessMode: neo4j.session.READ });
  try {
    let subjectEntity: GraphEntity | null = null;
    const nodeMap = new Map<string, GraphEntity>();
    const edgeMap = new Map<string, GraphEdge>();
    await session.executeRead(async (txc) => {
      const subjRes = await txc.run(subjectCypher, { subjectId: input.subjectId });
      if (subjRes.records.length === 0) {
        throw new Error(`graphQuery: subject not found (subjectId=${input.subjectId})`);
      }
      const subjNode = subjRes.records[0].get('subject') as Node;
      subjectEntity = nodeToEntity(subjNode);
      const params: Record<string, unknown> = { subjectId: input.subjectId };
      if (withKinds) params.edgeKinds = edgeKinds;
      const nbrRes = await txc.run(neighborhoodCypher, params);
      for (const rec of nbrRes.records) {
        const nodes = (rec.get('nodes') as Node[] | null) ?? [];
        const edges = (rec.get('edges') as Relationship[] | null) ?? [];
        for (const n of nodes) {
          const e = nodeToEntity(n);
          nodeMap.set(e.elementId, e);
        }
        for (const r of edges) {
          const ed = relToEdge(r);
          edgeMap.set(ed.elementId, ed);
        }
      }
    });
    return {
      subject: subjectEntity as unknown as GraphEntity,
      nodes: [...nodeMap.values()],
      edges: [...edgeMap.values()],
    };
  } finally {
    await session.close();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `NEO4J_PASSWORD=<pass> NEO4J_URL=<ubuntu-server> npm test --workspace apps/server -- test/graph/repo.test.ts`
Expected: PASS (assertToken offline block always runs; live block runs with creds, skips without).
Then full suite to confirm no regressions: `OPENAI_API_KEY=ci-dummy-key npm test` (graph block skips when no Neo4j creds; rest green).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/graph/repo.ts apps/server/test/graph/repo.test.ts
git commit -m "feat: add neo4j graph repository (create/link/query) with open schema"
```

---

### Task 3: Three L2 agent tools + harness registration

**Files:**
- Create: `apps/server/src/graph/tools.ts`
- Modify: `apps/server/src/harness/roleToolRegistry.ts`, `apps/server/src/harness/permissionGate.ts`, `apps/server/src/harness/contextContract.ts`
- Test: `apps/server/test/graph/tools.test.ts`

**Interfaces:**
- Consumes: `createEntity`, `linkEntities`, `graphQuery` (T2); the existing 4-place registration pattern (mirror `bind_document`).
- Produces: `buildCreateEntityTool`, `buildLinkEntitiesTool`, `buildGraphQueryTool`.

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/graph/tools.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { tool } from 'ai';
import {
  buildCreateEntityTool,
  buildLinkEntitiesTool,
  buildGraphQueryTool,
} from '../../src/graph/tools.js';
import { assertAllToolsContracted } from '../../src/harness/contextContract.js';

const callCtx = { messages: [], toolCallId: 't', abortSignal: undefined } as any;

describe('graph tool schemas', () => {
  it('create_entity has inputSchema {kind,name,props?} and is L2-safe', () => {
    const t = buildCreateEntityTool();
    expect(t.inputSchema).toBeDefined();
    const parse = (t.inputSchema as any).safeParse({ kind: 'Party', name: 'ACME' });
    expect(parse.success).toBe(true);
  });
  it('link_entities requires srcId,dstId,kind', () => {
    const t = buildLinkEntitiesTool();
    const bad = (t.inputSchema as any).safeParse({ kind: 'x' });
    expect(bad.success).toBe(false);
    const good = (t.inputSchema as any).safeParse({ srcId: 'a', dstId: 'b', kind: 'buyer_of' });
    expect(good.success).toBe(true);
  });
  it('graph_query requires subjectId', () => {
    const t = buildGraphQueryTool();
    const good = (t.inputSchema as any).safeParse({ subject: '4:x:0' });
    expect(good.success).toBe(true);
    const bad = (t.inputSchema as any).safeParse({});
    expect(bad.success).toBe(false);
  });
});

describe('graph tool contracts are registered', () => {
  it('create_entity / link_entities / graph_query all have context contracts', () => {
    const names = ['create_entity', 'link_entities', 'graph_query'];
    // assertAllToolsContracted throws if any name in the list lacks a contract
    expect(() => assertAllToolsContracted(names)).not.toThrow();
  });
});
```

(The `describe.skipIf(!NEO4J_PASSWORD)` live-execute tests of these tools are covered by repo.test.ts in T2 — the tools are thin Cypher wrappers. T3 verifies schema shape + contract registration.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace apps/server -- test/graph/tools.test.ts`
Expected: FAIL — `../../src/graph/tools.js` not resolvable; contracts not registered.

- [ ] **Step 3: Implement the tools**

Create `apps/server/src/graph/tools.ts`:

```ts
import { tool } from 'ai';
import { z } from 'zod';
import { createEntity, linkEntities, graphQuery } from './repo.js';

export function buildCreateEntityTool() {
  return tool({
    description:
      '创建一个非文档实体节点 (如 Party 买方/卖方, Commodity 商品, Contract 合同). 按 kind+name 去重, 已存在则返回既有 elementId. props 为开放的属性 map.',
    inputSchema: z.object({
      kind: z.string().min(1).describe('实体类型, 如 Party/Commodity/Contract (开放字符串)'),
      name: z.string().min(1).describe('实体名称, 作为同类去重键'),
      props: z.record(z.string(), z.unknown()).optional().describe('开放属性'),
    }),
    execute: async ({ kind, name, props }) => {
      const e = await createEntity({ kind, name, props });
      return {
        status: 'ok' as const,
        elementId: e.elementId,
        kind: e.kind,
        name: e.name,
        created: e.created,
      };
    },
  });
}

export function buildLinkEntitiesTool() {
  return tool({
    description:
      '在两个已存在的实体之间创建一条有向关系 (如 buyer_of / plays_role / references). src/dst 必须是 create_entity 返回的 elementId. 不会隐式创建节点.',
    inputSchema: z.object({
      srcId: z.string().min(1).describe('源实体 elementId'),
      dstId: z.string().min(1).describe('目标实体 elementId'),
      kind: z.string().min(1).describe('关系类型 (开放字符串, 如 buyer_of)'),
      props: z.record(z.string(), z.unknown()).optional(),
      confidence: z.number().min(0).max(1).optional(),
      sourceSpan: z.unknown().optional(),
    }),
    execute: async ({ srcId, dstId, kind, props, confidence, sourceSpan }) => {
      const edge = await linkEntities({ srcId, dstId, kind, props, confidence, sourceSpan });
      return {
        status: 'ok' as const,
        edgeId: edge.elementId,
        type: edge.type,
        srcId: edge.srcId,
        dstId: edge.dstId,
      };
    },
  });
}

export function buildGraphQueryTool() {
  return tool({
    description:
      '从某个实体出发, 在图中做有界遍历 (默认深度 2), 返回邻接节点与边的摘要 (不含原始文档文本). 用于回答 "这份合同关联了哪些实体" 一类问题.',
    inputSchema: z.object({
      subject: z.string().min(1).describe('起始实体 elementId'),
      depth: z.number().int().min(1).max(5).optional().describe('遍历深度, 默认 2'),
      edgeKinds: z.array(z.string().min(1)).optional().describe('仅遍历这些关系类型'),
      direction: z.enum(['out', 'in', 'both']).optional().describe('方向, 默认 both'),
    }),
    execute: async ({ subject, depth, edgeKinds, direction }) => {
      const res = await graphQuery({ subjectId: subject, depth, edgeKinds, direction });
      return {
        status: 'ok' as const,
        subject: { elementId: res.subject.elementId, kind: res.subject.kind, name: res.subject.name },
        nodes: res.nodes.map((n) => ({ elementId: n.elementId, kind: n.kind, name: n.name })),
        edges: res.edges.map((e) => ({ type: e.type, srcId: e.srcId, dstId: e.dstId, confidence: e.confidence })),
      };
    },
  });
}
```

- [ ] **Step 4: Register the tools in all four places**

(a) `apps/server/src/harness/roleToolRegistry.ts`:
- Add `'create_entity'`, `'link_entities'`, `'graph_query'` to the `TRADER_CTX_TOOL_NAMES` array.
- In `getToolsForRole`, append (next to `bind_document`):
```ts
{ ...buildCreateEntityTool(), name: 'create_entity', needsApproval: true },
{ ...buildLinkEntitiesTool(), name: 'link_entities', needsApproval: true },
{ ...buildGraphQueryTool(), name: 'graph_query', needsApproval: true },
```
(import from `'../graph/tools.js'`.)

(b) `apps/server/src/harness/permissionGate.ts`:
```ts
registerPermission('create_entity', 'L2');
registerPermission('link_entities', 'L2');
registerPermission('graph_query', 'L2');
```

(c) `apps/server/src/harness/contextContract.ts` — add three entries mirroring `bind_document`:
```ts
create_entity: { output: 'raw', budget: 'full', signal: 'env', persist: 'graph', risk: { level: 'L2', injection: 'safe' } },
link_entities: { output: 'raw', budget: 'full', signal: 'env', persist: 'graph', risk: { level: 'L2', injection: 'safe' } },
graph_query:   { output: 'raw', budget: 'full', signal: 'env', persist: 'graph', risk: { level: 'L2', injection: 'safe' } },
```

- [ ] **Step 5: Update pin-count assertions**

Grep for exact tool-count assertions that `bind_document`/`tag_document` bumped in earlier phases (`contextContract.test.ts` EXPECTED_TOOLS, `e2e-loop.test.ts` length, `integration-recall.test.ts` length). Bump them by **+3** (three new tools). Preserve exact-match semantics (`toHaveLength(N+3)`, not `>=`).

- [ ] **Step 6: Run tests to verify they pass**

Run: `OPENAI_API_KEY=ci-dummy-key npm test --workspace apps/server -- test/graph/tools.test.ts`
Then full suite: `OPENAI_API_KEY=ci-dummy-key npm test`
Expected: PASS; `assertAllToolsContracted` does not throw at boot; the bumped pin-count tests pass.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/graph/tools.ts apps/server/src/harness/roleToolRegistry.ts \
        apps/server/src/harness/permissionGate.ts apps/server/src/harness/contextContract.ts \
        apps/server/test/graph/tools.test.ts apps/server/test/harness/contextContract.test.ts \
        apps/server/test/e2e-loop.test.ts apps/server/test/integration-recall.test.ts
git commit -m "feat: add create_entity/link_entities/graph_query L2 tools + registration"
```

---

### Task 4: Retire `link_document` tool + delete orphaned PG tables

**Files:**
- Modify: `apps/server/src/tools/writes.ts`, `apps/server/src/harness/roleToolRegistry.ts`, `apps/server/src/harness/permissionGate.ts`, `apps/server/src/harness/contextContract.ts`, `apps/server/src/pipeline/db/postgres-schema.ts`
- Update pin-count tests (−1, after the +3 from T3).

**Scope note:** `bind_document` DUAL-WRITES to `linkDocumentToContract` in `seed.ts` (documentEntry.ts:363) — that function stays. We only remove the `link_document` TOOL and its registration. The orphaned PG tables `document_relation` + `doc_contract` are dead code (no repo fn writes them).

- [ ] **Step 1: Write the failing test**

There is no new behavior to test; this task is a deletion + registration reconciliation. The load-bearing assertion is that `link_document` is no longer in the live toolset AND `assertAllToolsContracted` still passes. Add to `apps/server/test/harness/contextContract.test.ts` (or the existing toolset test):

```ts
it('link_document is no longer a registered trader tool', () => {
  const names = TRADER_CTX_TOOL_NAMES; // adjust import to the exported array, or read via getToolsForRole
  expect(names).not.toContain('link_document');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace apps/server -- test/harness/contextContract.test.ts`
Expected: FAIL — `link_document` still present.

- [ ] **Step 3: Remove `link_document`**

(a) `apps/server/src/tools/writes.ts` — delete the `linkDocument = tool({...})` export (and its `linkDocumentToContract` import if now unused).

(b) `apps/server/src/harness/roleToolRegistry.ts` — remove the `{ ...linkDocument, name: 'link_document' }` entry from `BASE_TOOLS_FOR_ROLE.trader` (or wherever it's appended) and the `linkDocument` import.

(c) `apps/server/src/harness/permissionGate.ts` — remove the `registerPermission('link_document', 'L2')` line.

(d) `apps/server/src/harness/contextContract.ts` — remove the `link_document: {...}` entry from `TOOL_CONTEXT_CONTRACTS`.

- [ ] **Step 4: Delete orphaned Postgres-only tables**

In `apps/server/src/pipeline/db/postgres-schema.ts`, delete the `document_relation` table definition (~lines 211-234) and the `doc_contract` table definition (~lines 176-194). Grep the repo for any remaining references and remove them (there should be none — they were orphaned).

- [ ] **Step 5: Update pin-count assertions (−1)**

The T3 bump added +3; this task removes −1, for a net +2 vs the Phase 3 tip (`9f41ec4`). Update the exact-count assertions in `contextContract.test.ts`, `e2e-loop.test.ts`, `integration-recall.test.ts` to reflect `link_document`'s removal.

- [ ] **Step 6: Run full suite to verify**

Run: `OPENAI_API_KEY=ci-dummy-key npm test`
Expected: PASS; `assertAllToolsContracted` passes; no test references `link_document`; `tsc --noEmit` 0 errors (no dangling imports from the deletion).

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/tools/writes.ts apps/server/src/harness/roleToolRegistry.ts \
        apps/server/src/harness/permissionGate.ts apps/server/src/harness/contextContract.ts \
        apps/server/src/pipeline/db/postgres-schema.ts apps/server/test
git commit -m "chore: retire volatile link_document tool + delete orphaned PG graph tables"
```

---

## Final verification

After all four tasks land, in this order (AGENTS.md):

- [ ] **Build:** `npm run build` — both workspaces succeed (`neo4j-driver` types resolve; no dangling imports from the `link_document`/PG-table deletions).
- [ ] **Lint:** `npm run lint` — exit 0; no new warnings beyond the pre-existing 4 unused-vars.
- [ ] **Test (offline):** `OPENAI_API_KEY=ci-dummy-key npm test` — graph integration tests SKIP (no Neo4j creds); all other suites green; pin-count assertions match the net +2.
- [ ] **Test (live, manual, with creds):** `NEO4J_URL=<ubuntu-server> NEO4J_USER=neo4j NEO4J_PASSWORD=<pass> OPENAI_API_KEY=ci-dummy-key npm test --workspace apps/server -- test/graph/` — the Neo4j repo/tool/connectivity tests RUN and pass against the real instance.

## Notes / out-of-scope (do not implement in Phase 4)

- **Extraction-byproduct auto-graphing is DEFERRED** (per oracle; user did not override). Only 合同 has `ContractSchema` today; auto-graphing 合同-only would produce a lopsided graph. Revisit after 发票/提单/装箱单 extraction schemas exist.
- **Superseding `bind_document` is DEFERRED.** `bind_document` is KEPT alongside the new tools (it still dual-writes to `bindings` + the in-memory `seed.ts` graph). Deprecate it in a later phase once the agent reliably uses `create_entity(Contract)` + `link_entities(plays_role)`.
- **`read_document`, MCP ingestion, graph algorithms** — all out of scope (§12).
- **Neo4j dev docker service** — NOT added (per user decision: use the existing ubuntu-server instance, not local docker). The `docker-compose.yml` disk-gate stays unresolved and is irrelevant to this phase.
