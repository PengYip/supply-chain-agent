import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  syncGraphLinkEdge,
  removeGraphLinkEdge,
  CORRELATES_EDGE,
  RELATES_EDGE,
  type GraphLinkSyncIo,
} from '../../src/pipeline/graphLinkSync.js';

// correlates/relates 边同步(spec 2026-08-25 方案A §3.3/§6)。与 binding/settles
// 同模式: 门禁 -> skipped; 归一化空键 -> failed; io 抛错 -> failed 不上抛。

function makeIo() {
  const nodes = new Map<string, string>();
  let seq = 0;
  const edges: Array<{ srcId: string; dstId: string; kind: string; props?: Record<string, unknown> }> = [];
  const idOf = (kind: string, name: string) => {
    const key = `${kind}:${name}`;
    if (!nodes.has(key)) nodes.set(key, `e${seq++}`);
    return { elementId: nodes.get(key)! };
  };
  const io: GraphLinkSyncIo = {
    createEntity: async (i) => idOf(i.kind, i.name),
    mergeEdge: async (i) => {
      edges.push({ srcId: i.srcId, dstId: i.dstId, kind: i.kind, props: i.props });
      return {};
    },
    removeEdge: async (i) => {
      for (let k = 0; k < edges.length; k++) {
        if (edges[k]!.srcId === i.srcId && edges[k]!.kind === i.kind && edges[k]!.dstId === i.dstId) {
          edges.splice(k, 1);
          return 1;
        }
      }
      return 0;
    },
    findEntityByName: async (kind, name) =>
      nodes.has(`${kind}:${name}`) ? { elementId: nodes.get(`${kind}:${name}`)! } : null,
  };
  return { io, edges };
}

const prevPwd = process.env.NEO4J_PASSWORD;
beforeEach(() => { process.env.NEO4J_PASSWORD = 'test'; });
afterEach(() => {
  if (prevPwd === undefined) delete process.env.NEO4J_PASSWORD;
  else process.env.NEO4J_PASSWORD = prevPwd;
});

describe('syncGraphLinkEdge', () => {
  it('NEO4J_PASSWORD 未设 -> skipped 且不触 io', async () => {
    delete process.env.NEO4J_PASSWORD;
    const { io, edges } = makeIo();
    const r = await syncGraphLinkEdge({
      kind: 'correlates', srcKind: 'Contract', srcKey: 'CG-1',
      dstKind: 'Contract', dstKey: 'XS-1', props: {}, confirmationSource: 'human', confidence: 1,
    }, io);
    expect(r.outcome).toBe('skipped');
    expect(edges).toHaveLength(0);
  });

  it('correlates: 合同号归一化(全角/空白剥离)后 MERGE 边, props 带 confirmationSource/source', async () => {
    const { io, edges } = makeIo();
    const r = await syncGraphLinkEdge({
      kind: 'correlates',
      srcKind: 'Contract', srcKey: 'ｃｇ－１', // 全角 -> CG-1
      dstKind: 'Contract', dstKey: 'xs-1',
      props: { share: 0.5 }, confirmationSource: 'agent', confidence: 0.9,
    }, io);
    expect(r.outcome).toBe('ok');
    expect(edges).toHaveLength(1);
    expect(edges[0]!.kind).toBe(CORRELATES_EDGE);
    expect(edges[0]!.props).toMatchObject({ share: 0.5, confirmationSource: 'agent', source: 'link_workbench' });
  });

  it('relates: 项目码归一化, Project 节点间建边', async () => {
    const { io, edges } = makeIo();
    const r = await syncGraphLinkEdge({
      kind: 'relates',
      srcKind: 'Project', srcKey: 'p-2026-01',
      dstKind: 'Project', dstKey: 'P-2026-02',
      props: { type: '同一生意拆分' }, confirmationSource: 'human', confidence: 1,
    }, io);
    expect(r.outcome).toBe('ok');
    expect(edges[0]!.kind).toBe(RELATES_EDGE);
  });

  it('归一化空键 -> failed 不触图', async () => {
    const { io, edges } = makeIo();
    const r = await syncGraphLinkEdge({
      kind: 'correlates', srcKind: 'Contract', srcKey: '   ',
      dstKind: 'Contract', dstKey: 'XS-1', props: {}, confirmationSource: 'human', confidence: 1,
    }, io);
    expect(r.outcome).toBe('failed');
    expect(edges).toHaveLength(0);
  });

  it('io 抛错 -> failed 不上抛', async () => {
    const boom: GraphLinkSyncIo = {
      ...makeIo().io,
      createEntity: async () => { throw new Error('driver down'); },
    };
    const r = await syncGraphLinkEdge({
      kind: 'relates', srcKind: 'Project', srcKey: 'P1',
      dstKind: 'Project', dstKey: 'P2', props: {}, confirmationSource: 'human', confidence: 1,
    }, boom);
    expect(r.outcome).toBe('failed');
    expect(r.reason).toContain('driver down');
  });
});

describe('removeGraphLinkEdge', () => {
  it('节点缺失 -> ok(nothing to remove)', async () => {
    const { io } = makeIo();
    const r = await removeGraphLinkEdge({
      kind: 'correlates', srcKind: 'Contract', srcKey: 'NOPE-1',
      dstKind: 'Contract', dstKey: 'NOPE-2',
    }, io);
    expect(r.outcome).toBe('ok');
  });

  it('按 triple 删边', async () => {
    const holder = makeIo();
    await syncGraphLinkEdge({
      kind: 'correlates', srcKind: 'Contract', srcKey: 'CG-1',
      dstKind: 'Contract', dstKey: 'XS-1', props: {}, confirmationSource: 'human', confidence: 1,
    }, holder.io);
    expect(holder.edges).toHaveLength(1);
    const r = await removeGraphLinkEdge({
      kind: 'correlates', srcKind: 'Contract', srcKey: 'CG-1',
      dstKind: 'Contract', dstKey: 'XS-1',
    }, holder.io);
    expect(r.outcome).toBe('ok');
    expect(holder.edges).toHaveLength(0);
  });
});
