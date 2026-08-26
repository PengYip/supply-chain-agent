import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { syncGraphLinkEdge, type GraphLinkSyncIo } from '../../src/pipeline/graphLinkSync.js';
import { buildLinkAmendsTool } from '../../src/pipeline/tools/graphLinkTools.js';
import { createDb, migrate } from '../../src/pipeline/db/client.js';
import { ensureTemplateSeed } from '../../src/pipeline/templateSeed.js';
import { listActiveEdgeRules } from '../../src/pipeline/db/repositories.js';

function makeIo() {
  const nodes = new Map<string, string>();
  const edges = new Set<string>();
  let seq = 0;
  const id = (kind: string, name: string) => {
    const key = `${kind}:${name}`;
    if (!nodes.has(key)) nodes.set(key, `e${seq++}`);
    return { elementId: nodes.get(key)! };
  };
  const io: GraphLinkSyncIo = {
    createEntity: async (i) => id(i.kind, i.name),
    mergeEdge: async (i) => { edges.add(`${i.srcId}|${i.kind}|${i.dstId}`); return {}; },
    removeEdge: async (i) => { const k = `${i.srcId}|${i.kind}|${i.dstId}`; if (!edges.has(k)) return 0; edges.delete(k); return 1; },
    findEntityByName: async (kind, name) => nodes.get(`${kind}:${name}`) ? { elementId: nodes.get(`${kind}:${name}`)! } : null,
  };
  return { io, nodes, edges };
}

const prevPwd = process.env.NEO4J_PASSWORD;
beforeEach(() => { process.env.NEO4J_PASSWORD = 'test'; });
afterEach(() => {
  if (prevPwd === undefined) delete process.env.NEO4J_PASSWORD;
  else process.env.NEO4J_PASSWORD = prevPwd;
});

describe('amends edge', () => {
  it('syncGraphLinkEdge amends: Document(补充合同) -> Contract(基础合同)', async () => {
    const { io, edges } = makeIo();
    const r = await syncGraphLinkEdge({
      kind: 'amends', srcKind: 'Document', srcKey: 'DOC-1',
      dstKind: 'Contract', dstKey: 'HT-2024-001',
      props: {}, confirmationSource: 'agent', confidence: 0.8,
    }, io);
    expect(r.outcome).toBe('ok');
    expect([...edges][0]).toContain('amends');
  });

  it('buildLinkAmendsTool 落 graph_links + 图同步', async () => {
    const ctx = createDb();
    migrate(ctx.sqlite);
    await ensureTemplateSeed(ctx);
    const tool = buildLinkAmendsTool({ ctx, userId: 'u1' });
    // 工具走默认 io(无注入点), NEO4J_PASSWORD 在位会连真实 Neo4j 挂起;
    // 临时删除使 syncGraphLinkEdge 走 skipped 路径(brief 注释"无真实 Neo4j"语义)。
    delete process.env.NEO4J_PASSWORD;
    const res = await tool.execute({ docId: 'DOC-1', baseContractNo: 'HT-2024-001' });
    expect(res.status).toBe('ok');
    expect(res.graphSync).toBe('skipped'); // 无真实 Neo4j
  });

  it('种子 er-amend-buchong 已激活', async () => {
    const ctx = createDb();
    migrate(ctx.sqlite);
    await ensureTemplateSeed(ctx);
    const rules = await listActiveEdgeRules(ctx);
    expect(rules.some((r) => r.id === 'er-amend-buchong' && r.isActive)).toBe(true);
  });
});