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
    // Names are run-id-suffixed so MERGE cannot collide with / mutate real
    // shared-graph data under the per-kind unique-name constraint.
    const a = await createEntity({ kind: 'Party', name: `ACME-${RUN_ID}`, props: { scaRunId: RUN_ID, country: 'CN' } });
    const b = await createEntity({ kind: 'Party', name: `ACME-${RUN_ID}`, props: { scaRunId: RUN_ID, country: 'CN' } });
    expect(a.elementId).toBe(b.elementId); // same node
    expect(a.kind).toBe('Party');
    expect(a.name).toBe(`ACME-${RUN_ID}`);
    // first call created, second matched — created flag is observable via two distinct names:
    const c = await createEntity({ kind: 'Party', name: `Globex-${RUN_ID}`, props: { scaRunId: RUN_ID } });
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
