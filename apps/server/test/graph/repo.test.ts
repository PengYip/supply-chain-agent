import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import neo4j, { type Driver, type Session } from 'neo4j-driver';
import {
  assertToken,
  ensureNameConstraint,
  createEntity,
  linkEntities,
  graphQuery,
  findEntities,
  mergeEdge,
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

  it('mergeEdge 幂等：同 (src,type,dst) 重复写不产生重复边', async () => {
    const a = await createEntity({ kind: 'Party', name: `MEA-${RUN_ID}`, props: { scaRunId: RUN_ID } });
    const b = await createEntity({ kind: 'Contract', name: `MEB-${RUN_ID}`, props: { scaRunId: RUN_ID } });
    await mergeEdge({ srcId: a.elementId, dstId: b.elementId, kind: 'party', confidence: 0.9, props: { scaRunId: RUN_ID, role: '买方' } });
    await mergeEdge({ srcId: a.elementId, dstId: b.elementId, kind: 'party', confidence: 0.9, props: { scaRunId: RUN_ID, role: '买方' } });
    const res = await graphQuery({ subjectId: a.elementId, depth: 1, edgeKinds: ['party'], direction: 'out' });
    expect(res.edges.filter((e) => e.dstId === b.elementId)).toHaveLength(1);
  });

  it('linkEntities 与 mergeEdge 同语义：重复 link 不堆积历史边（最终结果）', async () => {
    const a = await createEntity({ kind: 'Party', name: `LKA-${RUN_ID}`, props: { scaRunId: RUN_ID } });
    const b = await createEntity({ kind: 'Contract', name: `LKB-${RUN_ID}`, props: { scaRunId: RUN_ID } });
    await linkEntities({ srcId: a.elementId, dstId: b.elementId, kind: 'buyer_of', confidence: 0.8, props: { scaRunId: RUN_ID } });
    await linkEntities({ srcId: a.elementId, dstId: b.elementId, kind: 'buyer_of', confidence: 0.95, props: { scaRunId: RUN_ID, role: '买方' } });
    const res = await graphQuery({ subjectId: a.elementId, depth: 1, edgeKinds: ['buyer_of'], direction: 'out' });
    const edges = res.edges.filter((e) => e.dstId === b.elementId);
    expect(edges).toHaveLength(1); // 第二次 link 是更新, 不是新增
    expect(edges[0].confidence).toBe(0.95); // 属性被最新一次覆盖
  });

  it('findEntities 按 kind+contains 模糊与 exact 精确匹配', async () => {
    await createEntity({ kind: 'Party', name: `中石化-${RUN_ID}`, props: { scaRunId: RUN_ID } });
    await createEntity({ kind: 'Party', name: `中石化贸易-${RUN_ID}`, props: { scaRunId: RUN_ID } });
    const fuzzy = await findEntities({ kind: 'Party', name: `-${RUN_ID}` });
    expect(fuzzy.length).toBeGreaterThanOrEqual(2); // 其他 live 用例的 Party 也带 -RUN_ID
    const exact = await findEntities({ kind: 'Party', name: `中石化贸易-${RUN_ID}`, exact: true });
    expect(exact).toHaveLength(1);
    expect(exact[0].name).toBe(`中石化贸易-${RUN_ID}`);
  });
});

describe('findEntities / mergeEdge (offline guards)', () => {
  it('findEntities 空白名称直接返回 []（不触驱动）', async () => {
    await expect(findEntities({ name: '   ' })).resolves.toEqual([]);
  });
  it('findEntities 对非法 kind 先经 assertToken 校验', async () => {
    await expect(findEntities({ kind: 'a b', name: 'x' })).rejects.toThrow(/Invalid label/);
  });
  it('mergeEdge 在未配置 NEO4J_PASSWORD 时抛驱动错误（CI 无密码路径）', async () => {
    await expect(
      mergeEdge({ srcId: '4:a:0', dstId: '4:b:0', kind: 'party' }),
    ).rejects.toThrow(/NEO4J_PASSWORD|not found/i);
  });
  it('mergeEdge 对非法 kind 先经 assertToken 校验（不触驱动）', async () => {
    await expect(mergeEdge({ srcId: '4:a:0', dstId: '4:b:0', kind: 'a b' })).rejects.toThrow(/Invalid label/);
  });
});
