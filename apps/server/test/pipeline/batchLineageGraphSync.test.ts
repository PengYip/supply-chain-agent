import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import {
  createDocumentStub,
  setDocumentBatchRole,
  saveDocumentUnits,
} from '../../src/pipeline/db/repositories.js';
import { syncBatchLineageGraph } from '../../src/pipeline/batchLineageGraphSync.js';
import type { GraphWriterIo } from '../../src/graph/graphWriter.js';

// P3 谱系图同步(container -> CONTAINS -> unit)。io 全注入, 无需 Neo4j;
// NEO4J_PASSWORD 门禁与 graphCommit.test.ts 同款自管理哨兵。

/** MERGE 去重语义的 fake io: 节点按 kind:name 去重, 边按 src->dst 去重(SET 更新)。 */
function fakeIo() {
  const nodes = new Map<string, { kind: string; name: string; props: Record<string, unknown> }>();
  const edges = new Map<string, Record<string, unknown>>();
  const io: GraphWriterIo = {
    createEntity: async ({ kind, name, props }) => {
      const key = `${kind}:${name}`;
      const existing = nodes.get(key);
      if (existing) {
        return { elementId: `el-${key}`, kind, name, props: existing.props, created: false };
      }
      nodes.set(key, { kind, name, props: props ?? {} });
      return { elementId: `el-${key}`, kind, name, props: props ?? {}, created: true };
    },
    mergeEdge: async () => ({}),
    mergeContainsEdge: async (i) => {
      edges.set(`${i.srcId}->${i.dstId}`, { ...i.props });
    },
  };
  return { io, nodes, edges };
}

describe('syncBatchLineageGraph (P3)', () => {
  let ctx: DbContext;
  beforeEach(() => {
    ctx = createDb(':memory:');
    migrate(ctx.sqlite);
  });

  /** container + 2 已回填 child 的 unit(单页 p1 / 跨页 p2-p3)+ 1 个 pending(无 child)。 */
  async function seedContainer(): Promise<string> {
    const sourceUri = 'file:///batch.pdf';
    const { docId: containerId } = await createDocumentStub(ctx, { sourceUri, userId: 'u1' });
    await setDocumentBatchRole(ctx, containerId, 'container');
    const pending: Array<{ childDocumentId?: string; pageStart: number; pageEnd: number; unitIndex: number; docType: string }> = [];
    const children: string[] = [];
    for (let i = 0; i < 2; i++) {
      const { docId } = await createDocumentStub(ctx, { sourceUri, userId: 'u1' });
      await setDocumentBatchRole(ctx, docId, 'unit');
      children.push(docId);
    }
    await saveDocumentUnits(ctx, [
      { parentDocumentId: containerId, childDocumentId: children[0], unitIndex: 1, docType: '汽运磅单', pageStart: 1, pageEnd: 1 },
      { parentDocumentId: containerId, childDocumentId: children[1], unitIndex: 2, docType: '质检报告', pageStart: 2, pageEnd: 3 },
      // 无 child 的检测审计行(status=pending) -> 跳过。
      { parentDocumentId: containerId, unitIndex: 3, docType: '其他', pageStart: 4, pageEnd: 4 },
    ]);
    void pending;
    return containerId;
  }

  it('NEO4J_PASSWORD 未设 -> skipped, 不触 io', async () => {
    const prev = process.env.NEO4J_PASSWORD;
    delete process.env.NEO4J_PASSWORD;
    try {
      const { io, nodes, edges } = fakeIo();
      const outcome = await syncBatchLineageGraph(ctx, 'DOC-x', io);
      expect(outcome).toBe('skipped');
      expect(nodes.size).toBe(0);
      expect(edges.size).toBe(0);
    } finally {
      if (prev !== undefined) process.env.NEO4J_PASSWORD = prev;
    }
  });

  it('container: 建 container/unit 节点 + CONTAINS 边(props unitIndex/pages), container 节点无 docType', async () => {
    const prev = process.env.NEO4J_PASSWORD;
    process.env.NEO4J_PASSWORD = 'batch-lineage-test';
    try {
      const containerId = await seedContainer();
      const { io, nodes, edges } = fakeIo();
      const outcome = await syncBatchLineageGraph(ctx, containerId, io);
      expect(outcome).toBe('ok');
      // pending 行(无 child)跳过: 1 container + 2 unit。
      expect(nodes.size).toBe(3);
      const containerNode = [...nodes.values()].find((n) => n.props.batchRole === 'container')!;
      expect(containerNode.name).toBe(containerId);
      expect(containerNode.props.docId).toBe(containerId);
      expect(containerNode.props.sourceUri).toBe('file:///batch.pdf');
      // 已拍板决策 3: container 节点不携带业务 docType prop。
      expect(containerNode.props.docType).toBeUndefined();
      const unitNodes = [...nodes.values()].filter((n) => n.props.batchRole === 'unit');
      expect(unitNodes).toHaveLength(2);
      for (const u of unitNodes) {
        expect(u.props.docId).toBeDefined();
        expect(u.props.docType).toBeUndefined();
      }
      expect(edges.size).toBe(2);
      const propsList = [...edges.values()];
      expect(propsList).toContainEqual({ unitIndex: 1, pages: 'p1' });
      expect(propsList).toContainEqual({ unitIndex: 2, pages: 'p2-p3' });
    } finally {
      if (prev !== undefined) process.env.NEO4J_PASSWORD = prev;
      else delete process.env.NEO4J_PASSWORD;
    }
  });

  it('重复调用幂等: MERGE 去重语义下节点与边数量不增', async () => {
    const prev = process.env.NEO4J_PASSWORD;
    process.env.NEO4J_PASSWORD = 'batch-lineage-test';
    try {
      const containerId = await seedContainer();
      const { io, nodes, edges } = fakeIo();
      await syncBatchLineageGraph(ctx, containerId, io);
      const first = await syncBatchLineageGraph(ctx, containerId, io);
      expect(first).toBe('ok');
      expect(nodes.size).toBe(3);
      expect(edges.size).toBe(2);
    } finally {
      if (prev !== undefined) process.env.NEO4J_PASSWORD = prev;
      else delete process.env.NEO4J_PASSWORD;
    }
  });

  it('io 抛错 -> failed(不抛出)', async () => {
    const prev = process.env.NEO4J_PASSWORD;
    process.env.NEO4J_PASSWORD = 'batch-lineage-test';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const containerId = await seedContainer();
      const io: GraphWriterIo = {
        createEntity: async () => { throw new Error('neo4j down'); },
        mergeEdge: async () => ({}),
      };
      const outcome = await syncBatchLineageGraph(ctx, containerId, io);
      expect(outcome).toBe('failed');
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      if (prev !== undefined) process.env.NEO4J_PASSWORD = prev;
      else delete process.env.NEO4J_PASSWORD;
    }
  });
});
