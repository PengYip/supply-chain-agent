import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  syncSettlesEdge,
  removeSettlesEdge,
  SETTLES_EDGE,
  type SettlesGraphSyncIo,
} from '../../src/pipeline/settlesGraphSync.js';

// settles 边投影(spec 2026-08-25 方案A §3.3): Document-[settles]->Contract。
// 门禁 -> skipped; relation 空 -> failed 不触图; io 抛错 -> failed 不上抛。

function makeIo() {
  const nodes = new Map<string, string>(); // `${kind}:${name}` -> elementId
  let seq = 0;
  const edges: Array<{ srcId: string; dstId: string; kind: string; props?: Record<string, unknown> }> = [];
  const removed: Array<{ srcId: string; kind: string; dstId: string }> = [];
  const idOf = (kind: string, name: string) => {
    const key = `${kind}:${name}`;
    if (!nodes.has(key)) nodes.set(key, `e${seq++}`);
    return { elementId: nodes.get(key)! };
  };
  const io: SettlesGraphSyncIo = {
    createEntity: async (i) => idOf(i.kind, i.name),
    mergeEdge: async (i) => {
      edges.push({ srcId: i.srcId, dstId: i.dstId, kind: i.kind, props: i.props });
      return {};
    },
    removeEdge: async (i) => {
      removed.push({ srcId: i.srcId, kind: i.kind, dstId: i.dstId });
      const before = edges.length;
      for (let k = 0; k < edges.length; k++) {
        if (edges[k]!.srcId === i.srcId && edges[k]!.kind === i.kind && edges[k]!.dstId === i.dstId) {
          edges.splice(k, 1);
          return 1;
        }
      }
      void before;
      return 0;
    },
    findEntityByName: async (kind, name) =>
      nodes.has(`${kind}:${name}`) ? { elementId: nodes.get(`${kind}:${name}`)! } : null,
  };
  return { io, edges, removed };
}

const prevPwd = process.env.NEO4J_PASSWORD;
beforeEach(() => { process.env.NEO4J_PASSWORD = 'test'; });
afterEach(() => {
  if (prevPwd === undefined) delete process.env.NEO4J_PASSWORD;
  else process.env.NEO4J_PASSWORD = prevPwd;
});

describe('syncSettlesEdge', () => {
  it('NEO4J_PASSWORD 未设 -> skipped 且不触 io', async () => {
    delete process.env.NEO4J_PASSWORD;
    const { io, edges } = makeIo();
    const r = await syncSettlesEdge({ docId: 'D1', contractNo: 'HT-1', relation: '付款', direction: 'out', confidence: 0.9 }, io);
    expect(r.outcome).toBe('skipped');
    expect(edges).toHaveLength(0);
  });

  it('ok: Document-[settles{relation,direction,amount,source}]->Contract', async () => {
    const { io, edges } = makeIo();
    const r = await syncSettlesEdge({ docId: 'D1', contractNo: 'HT-1', relation: '付款', direction: 'out', amount: 120.5, confidence: 0.9 }, io);
    expect(r.outcome).toBe('ok');
    expect(edges).toHaveLength(1);
    expect(edges[0]!.kind).toBe(SETTLES_EDGE);
    expect(edges[0]!.props).toMatchObject({ relation: '付款', direction: 'out', amount: 120.5, source: 'workbench' });
  });

  it('amount 为 null 时省略 amount 属性; docType/sourceUri 回填进 Document 节点 props', async () => {
    const { io, edges } = makeIo();
    await syncSettlesEdge({ docId: 'D1', docType: '发票', sourceUri: 'file:///a.pdf', contractNo: 'HT-1', relation: '收票', direction: 'in', confidence: 0.8 }, io);
    expect(edges[0]!.props).not.toHaveProperty('amount');
    expect(edges[0]!.props).toMatchObject({ relation: '收票', direction: 'in' });
  });

  it('relation 为空 -> failed 不触图', async () => {
    const { io, edges } = makeIo();
    const r = await syncSettlesEdge({ docId: 'D1', contractNo: 'HT-1', relation: '', direction: 'in', confidence: 1 }, io);
    expect(r.outcome).toBe('failed');
    expect(edges).toHaveLength(0);
  });

  it('合同号归一化为空 -> failed', async () => {
    const { io, edges } = makeIo();
    const r = await syncSettlesEdge({ docId: 'D1', contractNo: '   ', relation: '收款', direction: 'in', confidence: 1 }, io);
    expect(r.outcome).toBe('failed');
    expect(edges).toHaveLength(0);
  });

  it('io 抛错 -> failed 不上抛', async () => {
    const boom: SettlesGraphSyncIo = {
      ...makeIo().io,
      createEntity: async () => { throw new Error('driver down'); },
    };
    const r = await syncSettlesEdge({ docId: 'D1', contractNo: 'HT-1', relation: '收款', direction: 'in', confidence: 1 }, boom);
    expect(r.outcome).toBe('failed');
    expect(r.reason).toContain('driver down');
  });
});

describe('removeSettlesEdge', () => {
  it('节点缺失 -> ok(nothing to remove)', async () => {
    const { io } = makeIo();
    const r = await removeSettlesEdge({ docId: 'D-X', contractNo: 'HT-X' }, io);
    expect(r.outcome).toBe('ok');
  });

  it('幂等删边', async () => {
    const { io, removed } = makeIo();
    process.env.NEO4J_PASSWORD = 'test';
    await syncSettlesEdge({ docId: 'D1', contractNo: 'HT-1', relation: '付款', direction: 'out', confidence: 0.9 }, io);
    const r = await removeSettlesEdge({ docId: 'D1', contractNo: 'HT-1' }, io);
    expect(r.outcome).toBe('ok');
    expect(removed).toHaveLength(1);
    expect(removed[0]!.kind).toBe(SETTLES_EDGE);
  });
});
