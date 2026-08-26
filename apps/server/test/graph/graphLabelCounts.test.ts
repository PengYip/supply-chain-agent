import { describe, it, expect, beforeEach, vi } from 'vitest';

const runMock = vi.fn();
const closeMock = vi.fn();
vi.mock('../../src/graph/neo4j.js', () => ({
  getDriver: () => ({
    session: () => ({
      run: runMock,
      close: closeMock,
    }),
  }),
}));

// 缓存有状态, 动态 import 以便 reset 后重新加载模块
async function loadFresh() {
  const mod = await import('../../src/graph/repo.js');
  return mod;
}

beforeEach(() => {
  vi.resetModules();
  runMock.mockReset();
  closeMock.mockReset();
  // MATCH (n) UNWIND labels(n) AS label RETURN label, count(n) AS count ORDER BY count DESC
  // 真实 Neo4j 会按 ORDER BY count DESC 返回降序记录, mock 模拟该顺序。
  runMock.mockResolvedValue({
    records: [
      { get: (k: string) => (k === 'label' ? 'Party' : 34) },
      { get: (k: string) => (k === 'label' ? 'Contract' : 12) },
    ],
  });
});

describe('graphLabelCounts', () => {
  it('单查询聚合 label 计数并降序', async () => {
    const { graphLabelCounts } = await loadFresh();
    const out = await graphLabelCounts();
    expect(out).toEqual([
      { label: 'Party', count: 34 },
      { label: 'Contract', count: 12 },
    ]);
    expect(runMock).toHaveBeenCalledTimes(1);
  });

  it('60s 内重复调用走缓存(不再查询); reset 后重新查询', async () => {
    const { graphLabelCounts, __resetLabelCountsCacheForTests } = await loadFresh();
    await graphLabelCounts();
    await graphLabelCounts();
    expect(runMock).toHaveBeenCalledTimes(1);
    __resetLabelCountsCacheForTests();
    await graphLabelCounts();
    expect(runMock).toHaveBeenCalledTimes(2);
  });

  it('neo4j Integer 形状(count.toNumber)也可解析', async () => {
    runMock.mockResolvedValue({
      records: [{ get: (k: string) => (k === 'label' ? 'Contract' : { toNumber: () => 7 }) }],
    });
    const { graphLabelCounts } = await loadFresh();
    expect((await graphLabelCounts())[0]?.count).toBe(7);
  });
});