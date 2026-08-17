import { describe, it, expect } from 'vitest';
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
  it('写 Document + 归一化实体 + 全部边，status ok', async () => {
    const io = mkIo();
    const res = await writeDocumentGraph(input, io);
    expect(res.status).toBe('ok');
    expect(res.nodeCount).toBe(3); // Document + Party + Contract
    expect(res.edgeCount).toBe(3);
    expect(io.calls).toContain('create:Party:中石化'); // 后缀已剥
    expect(res.failures).toEqual([]);
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
  });

  it('Document 节点本身创建失败时 status failed 并带 reason', async () => {
    const io = mkIo({ failEntity: 'DOC-1' });
    const res = await writeDocumentGraph(input, io);
    expect(res.status).toBe('failed');
    expect(res.reason).toBe('boom');
  });
});
