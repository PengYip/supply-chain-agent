import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeDocumentGraph, type GraphWriterIo } from '../../src/graph/graphWriter.js';

function mkIo(opts: { failEntity?: string; failEdge?: string } = {}): GraphWriterIo & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    createEntity: async ({ kind, name }) => {
      calls.push(`create:${kind}:${name}`);
      if (opts.failEntity && name.includes(opts.failEntity)) throw new Error('boom');
      return { elementId: `el-${kind}-${name}`, kind, name, props: {}, created: true };
    },
    mergeEdge: async ({ srcId, dstId, kind }) => {
      calls.push(`edge:${srcId}-${kind}->${dstId}`);
      if (opts.failEdge && kind === opts.failEdge) throw new Error('edge-boom');
      return {};
    },
  };
}

const input = {
  docId: 'DOC-1',
  docType: '发票',
  sourceUri: 'file:///inv.pdf',
  entities: [
    { kind: 'Party' as const, name: '中石化集团有限公司', role: '卖方', confidence: 0.9 },
    { kind: 'Contract' as const, name: 'HT-1', confidence: 0.95 },
  ],
  edges: [
    { type: 'party' as const, dstKind: 'Party' as const, dstName: '中石化集团有限公司', role: '卖方', confidence: 0.9 },
    { type: 'references' as const, dstKind: 'Contract' as const, dstName: 'HT-1', confidence: 0.95 },
    { type: 'executes' as const, dstKind: 'Contract' as const, dstName: 'HT-1', confidence: 0.95 },
  ],
};

describe('writeDocumentGraph (fake io)', () => {
  // 3 fake-io cases run the gate-OPEN path of writeDocumentGraph, which checks
  // process.env.NEO4J_PASSWORD. Self-manage a sentinel so the suite passes in CI
  // (no NEO4J_PASSWORD) too; the "skipped" case below still exercises the
  // gate-CLOSED path by deleting and restoring the var.
  let prevPassword: string | undefined;
  beforeAll(() => {
    prevPassword = process.env.NEO4J_PASSWORD;
    process.env.NEO4J_PASSWORD = 'graphwriter-test-dummy';
  });
  afterAll(() => {
    if (prevPassword !== undefined) process.env.NEO4J_PASSWORD = prevPassword;
    else delete process.env.NEO4J_PASSWORD;
  });

  it('写 Document + 归一化实体 + 全部边，status ok', async () => {
    const io = mkIo();
    const res = await writeDocumentGraph(input, io);
    expect(res.status).toBe('ok');
    expect(res.nodeCount).toBe(3); // Document + Party + Contract
    expect(res.edgeCount).toBe(3);
    expect(io.calls).toContain('create:Party:中石化'); // 后缀已剥
    expect(res.failures).toEqual([]);
    // writtenEntities 为归一化后的实际写入清单（与 createEntity 同名）。
    expect(res.writtenEntities).toEqual([
      { kind: 'Party', name: '中石化', role: '卖方' },
      { kind: 'Contract', name: 'HT-1' },
    ]);
  });

  it('NEO4J_PASSWORD 未设时整体 skipped，零 io 调用', async () => {
    const prev = process.env.NEO4J_PASSWORD;
    delete process.env.NEO4J_PASSWORD;
    try {
      const io = mkIo();
      const res = await writeDocumentGraph(input, io);
      expect(res.status).toBe('skipped');
      expect(res.reason).toContain('NEO4J_PASSWORD');
      expect(io.calls).toHaveLength(0);
      expect(res.writtenEntities).toEqual([]);
    } finally {
      if (prev !== undefined) process.env.NEO4J_PASSWORD = prev;
    }
  });

  it('实体失败被隔离：依赖边记失败，其余照写，status partial', async () => {
    const io = mkIo({ failEntity: '中石化' });
    const res = await writeDocumentGraph(input, io);
    expect(res.status).toBe('partial');
    expect(res.edgeCount).toBe(2); // references + executes 仍落地
    expect(res.failures.some((f) => f.includes('Party'))).toBe(true);
    expect(res.failures.some((f) => f.startsWith('edge party->'))).toBe(true);
    // 只收集成功创建的实体。
    expect(res.writtenEntities).toEqual([{ kind: 'Contract', name: 'HT-1' }]);
  });

  it('Document 节点本身创建失败时 status failed 并带 reason', async () => {
    const io = mkIo({ failEntity: 'DOC-1' });
    const res = await writeDocumentGraph(input, io);
    expect(res.status).toBe('failed');
    expect(res.reason).toBe('boom');
    expect(res.writtenEntities).toEqual([]);
  });

  it('归一化后同名的重复实体去重：只收集一次', async () => {
    const io = mkIo();
    const res = await writeDocumentGraph(
      {
        ...input,
        entities: [
          { kind: 'Party' as const, name: '中石化集团有限公司', role: '卖方', confidence: 0.9 },
          { kind: 'Party' as const, name: '中石化', role: '买方', confidence: 0.8 },
          { kind: 'Contract' as const, name: 'HT-1', confidence: 0.95 },
        ],
      },
      io,
    );
    expect(res.status).toBe('ok');
    expect(res.writtenEntities).toEqual([
      { kind: 'Party', name: '中石化', role: '卖方' },
      { kind: 'Contract', name: 'HT-1' },
    ]);
    expect(io.calls.filter((c) => c.startsWith('create:Party:中石化'))).toHaveLength(1);
  });

  it('contractType 透传: Document 与 Contract 实体 props 都带; null 时 key 不出现', async () => {
    function mkPropsIo() {
      const created: Array<{ kind: string; name: string; props: Record<string, unknown> }> = [];
      const io: GraphWriterIo = {
        createEntity: async ({ kind, name, props }) => {
          created.push({ kind, name, props: props ?? {} });
          return { elementId: `el-${kind}-${name}`, kind, name, props: props ?? {}, created: true };
        },
        mergeEdge: async () => ({}),
      };
      return { io, created };
    }

    const withType = mkPropsIo();
    await writeDocumentGraph({ ...input, contractType: '销售' }, withType.io);
    const docNode = withType.created.find((c) => c.kind === 'Document');
    const contractNode = withType.created.find((c) => c.kind === 'Contract');
    expect(docNode?.props.contractType).toBe('销售');
    expect(contractNode?.props.contractType).toBe('销售');

    const nullType = mkPropsIo();
    await writeDocumentGraph({ ...input, contractType: null }, nullType.io);
    for (const c of nullType.created) {
      expect(c.props).not.toHaveProperty('contractType');
    }
  });
});
