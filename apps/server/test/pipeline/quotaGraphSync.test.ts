import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  syncQuotaGraph,
  removeQuotaGrantedEdge,
  writeQuotaUsageToGraph,
  GRANTED_EDGE,
  type QuotaGraphSyncIo,
} from '../../src/pipeline/quotaGraphSync.js';

// granted 边投影(spec 2026-08-25 方案A §3.3): Party/Project -granted-> Quota。
// Quota 节点 name=`quota:${id}`; 用量回写走 updateNodeProps(不动 name/唯一键)。
// 门禁/错误语义与 graphLinkSync 一致。

function makeIo() {
  const nodes = new Map<string, string>();
  let seq = 0;
  const edges: Array<{ srcId: string; dstId: string; kind: string; props?: Record<string, unknown> }> = [];
  const propUpdates: Array<{ elementId: string; props: Record<string, unknown> }> = [];
  const idOf = (kind: string, name: string) => {
    const key = `${kind}:${name}`;
    if (!nodes.has(key)) nodes.set(key, `e${seq++}`);
    return { elementId: nodes.get(key)! };
  };
  const io: QuotaGraphSyncIo = {
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
    updateNodeProps: async (i) => {
      propUpdates.push({ elementId: i.elementId, props: i.props });
    },
  };
  return { io, edges, propUpdates };
}

const prevPwd = process.env.NEO4J_PASSWORD;
beforeEach(() => { process.env.NEO4J_PASSWORD = 'test'; });
afterEach(() => {
  if (prevPwd === undefined) delete process.env.NEO4J_PASSWORD;
  else process.env.NEO4J_PASSWORD = prevPwd;
});

describe('syncQuotaGraph', () => {
  it('NEO4J_PASSWORD 未设 -> skipped 不触 io', async () => {
    delete process.env.NEO4J_PASSWORD;
    const { io, edges } = makeIo();
    const r = await syncQuotaGraph({
      quotaId: 'Q1', scope: 'counterparty', ownerKey: '中石化', ownerLabel: '中石化',
      limitAmount: 100,
    }, io);
    expect(r.outcome).toBe('skipped');
    expect(edges).toHaveLength(0);
  });

  it('counterparty: owner 归一化为 Party, Quota 节点 name=quota:id, granted 边指向 Quota', async () => {
    const { io, edges } = makeIo();
    const r = await syncQuotaGraph({
      quotaId: 'Q1', scope: 'counterparty',
      ownerKey: ' 中石化股份有限公司 ', ownerLabel: '中石化',
      limitAmount: 1000000, currency: 'CNY', period: '2026',
    }, io);
    expect(r.outcome).toBe('ok');
    expect(edges).toHaveLength(1);
    expect(edges[0]!.kind).toBe(GRANTED_EDGE);
    expect(edges[0]!.srcId).toBe(io.findEntityByName ? (await io.findEntityByName('Party', '中石化'))!.elementId : '');
    const quota = await io.findEntityByName('Quota', 'quota:Q1');
    expect(quota).not.toBeNull();
    expect(edges[0]!.dstId).toBe(quota!.elementId);
  });

  it('project: owner 归一化为 Project(normalizeProjectCode)', async () => {
    const { io, edges } = makeIo();
    const r = await syncQuotaGraph({
      quotaId: 'Q2', scope: 'project', ownerKey: 'p-2026-01', ownerLabel: '',
      limitAmount: 500000,
    }, io);
    expect(r.outcome).toBe('ok');
    const proj = await io.findEntityByName('Project', 'P-2026-01');
    expect(proj).not.toBeNull();
    expect(edges[0]!.srcId).toBe(proj!.elementId);
  });

  it('归一化空键 -> failed 不触图', async () => {
    const { io, edges } = makeIo();
    const r = await syncQuotaGraph({
      quotaId: 'Q3', scope: 'counterparty', ownerKey: '   ', ownerLabel: '',
      limitAmount: 1,
    }, io);
    expect(r.outcome).toBe('failed');
    expect(edges).toHaveLength(0);
  });

  it('io 抛错 -> failed 不上抛', async () => {
    const boom: QuotaGraphSyncIo = {
      ...makeIo().io,
      createEntity: async () => { throw new Error('driver down'); },
    };
    const r = await syncQuotaGraph({
      quotaId: 'Q4', scope: 'counterparty', ownerKey: 'X 公司', ownerLabel: '',
      limitAmount: 1,
    }, boom);
    expect(r.outcome).toBe('failed');
    expect(r.reason).toContain('driver down');
  });
});

describe('removeQuotaGrantedEdge', () => {
  it('只删 granted 边, Quota 节点保留', async () => {
    const { io, edges } = makeIo();
    await syncQuotaGraph({
      quotaId: 'Q1', scope: 'counterparty', ownerKey: '中石化', ownerLabel: '',
      limitAmount: 1,
    }, io);
    expect(edges).toHaveLength(1);
    const r = await removeQuotaGrantedEdge({ quotaId: 'Q1', scope: 'counterparty', ownerKey: '中石化' }, io);
    expect(r.outcome).toBe('ok');
    expect(edges).toHaveLength(0);
    expect(await io.findEntityByName('Quota', 'quota:Q1')).not.toBeNull();
  });
});

describe('writeQuotaUsageToGraph', () => {
  it('Quota 节点存在 -> updateNodeProps 写 used/remaining/overLimit/usageComputedAt', async () => {
    const { io, propUpdates } = makeIo();
    await syncQuotaGraph({
      quotaId: 'Q1', scope: 'counterparty', ownerKey: '中石化', ownerLabel: '',
      limitAmount: 100,
    }, io);
    const r = await writeQuotaUsageToGraph({ quotaId: 'Q1', used: 120, remaining: -20, overLimit: true }, io);
    expect(r.outcome).toBe('ok');
    // syncQuotaGraph 定义同步时已写一次节点 props, 用量回写是第二次。
    expect(propUpdates).toHaveLength(2);
    expect(propUpdates[1]!.props).toMatchObject({
      used: 120, remaining: -20, overLimit: true,
    });
    expect(typeof propUpdates[1]!.props.usageComputedAt).toBe('string');
  });

  it('Quota 节点不存在 -> ok(nothing to write)', async () => {
    const { io, propUpdates } = makeIo();
    const r = await writeQuotaUsageToGraph({ quotaId: 'NOPE', used: 1, remaining: 1, overLimit: false }, io);
    expect(r.outcome).toBe('ok');
    expect(propUpdates).toHaveLength(0);
  });
});
