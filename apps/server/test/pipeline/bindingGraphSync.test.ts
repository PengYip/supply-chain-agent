import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { syncBindingEdge, removeBindingEdge, type BindingGraphSyncIo } from '../../src/pipeline/bindingGraphSync.js';

function makeIo() {
  const nodes = new Map<string, string>(); // `${kind}:${name}` -> elementId
  const edges = new Set<string>(); // `${srcId}|binds|${dstId}`
  let seq = 0;
  const id = (kind: string, name: string) => {
    const key = `${kind}:${name}`;
    if (!nodes.has(key)) nodes.set(key, `e${seq++}`);
    return { elementId: nodes.get(key)! };
  };
  const io: BindingGraphSyncIo = {
    createEntity: async (i) => id(i.kind, i.name),
    mergeEdge: async (i) => { edges.add(`${i.srcId}|${i.kind}|${i.dstId}`); return {}; },
    removeEdge: async (i) => {
      const key = `${i.srcId}|${i.kind}|${i.dstId}`;
      if (!edges.has(key)) return 0;
      edges.delete(key);
      return 1;
    },
    findEntityByName: async (kind, name) => nodes.get(`${kind}:${name}`)
      ? { elementId: nodes.get(`${kind}:${name}`)! } : null,
  };
  return { io, nodes, edges };
}

const prevPwd = process.env.NEO4J_PASSWORD;
beforeEach(() => { process.env.NEO4J_PASSWORD = 'test'; });
afterEach(() => {
  if (prevPwd === undefined) delete process.env.NEO4J_PASSWORD;
  else process.env.NEO4J_PASSWORD = prevPwd;
});

describe('syncBindingEdge', () => {
  it('未配置 -> skipped', async () => {
    delete process.env.NEO4J_PASSWORD;
    const r = await syncBindingEdge({ docId: 'D1', contractNo: 'HT-1', relation: '付款', bindingId: 'B1', confidence: 1 });
    expect(r.outcome).toBe('skipped');
  });

  it('正常写入: Document/Contract 节点 + binds 边', async () => {
    const { io, edges } = makeIo();
    const r = await syncBindingEdge({ docId: 'D1', docType: '发票', contractNo: 'HT-1', relation: '付款', bindingId: 'B1', confidence: 0.9 }, io);
    expect(r.outcome).toBe('ok');
    expect(edges.size).toBe(1);
    expect([...edges][0]).toContain('binds');
  });

  it('已有 Contract 节点(如 HT-2024-001)复用不重建', async () => {
    const { io, nodes } = makeIo();
    nodes.set('Contract:HT-2024-001', 'existing-eid');
    const r = await syncBindingEdge({ docId: 'D1', contractNo: 'HT-2024-001', relation: 'x', bindingId: 'B1', confidence: 1 }, io);
    expect(r.outcome).toBe('ok');
    expect(nodes.get('Contract:HT-2024-001')).toBe('existing-eid');
  });

  it('io 抛错 -> failed + reason, 不抛出', async () => {
    const io = { ...makeIo().io, mergeEdge: async () => { throw new Error('boom'); } };
    const r = await syncBindingEdge({ docId: 'D1', contractNo: 'HT-1', relation: 'x', bindingId: 'B1', confidence: 1 }, io);
    expect(r.outcome).toBe('failed');
    expect(r.reason).toBe('boom');
  });
});

describe('removeBindingEdge', () => {
  it('同步后可解绑删边; 无边时也返回 ok', async () => {
    const { io, edges } = makeIo();
    await syncBindingEdge({ docId: 'D1', contractNo: 'HT-1', relation: 'x', bindingId: 'B1', confidence: 1 }, io);
    expect(edges.size).toBe(1);
    const r = await removeBindingEdge({ docId: 'D1', contractNo: 'HT-1' }, io);
    expect(r.outcome).toBe('ok');
    expect(edges.size).toBe(0);
    const again = await removeBindingEdge({ docId: 'D1', contractNo: 'HT-1' }, io);
    expect(again.outcome).toBe('ok');
  });
});
