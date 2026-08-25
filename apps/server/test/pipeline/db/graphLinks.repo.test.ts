import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate } from '../../../src/pipeline/db/client.js';
import {
  saveGraphLink,
  findGraphLinkById,
  findGraphLinkByTriple,
  listGraphLinkProposals,
  listGraphLinks,
  updateGraphLinkStatus,
  updateGraphLinkProps,
  setGraphLinkGraphStatus,
} from '../../../src/pipeline/db/repositories.js';

// graph_links 存储(spec 2026-08-25 方案A §3.3): correlates/relates 关联提案。
// triple 唯一(kind+src_key+dst_key+user_id)幂等 upsert; 状态机 proposed ->
// confirmed|rejected; props 为 JSON 自由属性(白名单在路由层裁剪)。

let ctx: ReturnType<typeof createDb>;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
});

async function seed(overrides: Partial<Parameters<typeof saveGraphLink>[1]> = {}) {
  return saveGraphLink(ctx, {
    kind: 'correlates',
    srcKind: 'Contract', srcKey: 'CG-1', srcLabel: '采购一号',
    dstKind: 'Contract', dstKey: 'XS-1', dstLabel: '销售一号',
    props: { share: 1 },
    confidence: 0.9,
    createdBy: 'agent',
    ...overrides,
  }, 'u1');
}

describe('graph_links repo', () => {
  it('save->find roundtrip; 默认 proposed + 空 graphStatus', async () => {
    const id = await seed();
    const row = await findGraphLinkById(ctx, id, 'u1');
    expect(row?.status).toBe('proposed');
    expect(row?.props).toEqual({ share: 1 });
    expect(row?.graphStatus).toBeNull();
    expect(row?.srcLabel).toBe('采购一号');
    expect(row?.confirmationSource).toBeNull();
  });

  it('同 triple 再保存 -> 幂等复活更新(confirmed/human)', async () => {
    const first = await seed();
    const second = await saveGraphLink(ctx, {
      kind: 'correlates',
      srcKind: 'Contract', srcKey: 'CG-1', srcLabel: '采购一号',
      dstKind: 'Contract', dstKey: 'XS-1', dstLabel: '销售一号',
      props: { share: 0.5 },
      status: 'confirmed', confirmationSource: 'human', createdBy: 'u1',
    }, 'u1');
    expect(second).toBe(first);
    const row = await findGraphLinkById(ctx, first, 'u1');
    expect(row?.status).toBe('confirmed');
    expect(row?.confirmationSource).toBe('human');
    expect(row?.props).toEqual({ share: 0.5 });
  });

  it('findGraphLinkByTriple 命中与未命中', async () => {
    await seed();
    const hit = await findGraphLinkByTriple(ctx, { kind: 'correlates', srcKey: 'CG-1', dstKey: 'XS-1' }, 'u1');
    expect(hit?.dstKey).toBe('XS-1');
    const miss = await findGraphLinkByTriple(ctx, { kind: 'correlates', srcKey: 'CG-9', dstKey: 'XS-1' }, 'u1');
    expect(miss).toBeNull();
  });

  it('confirm/reject 状态机 + proposals 过滤', async () => {
    const id = await seed();
    expect(await listGraphLinkProposals(ctx, 'u1')).toHaveLength(1);
    await updateGraphLinkStatus(ctx, id, 'rejected', 'human', 'u1');
    expect((await findGraphLinkById(ctx, id, 'u1'))?.status).toBe('rejected');
    expect(await listGraphLinkProposals(ctx, 'u1')).toHaveLength(0);
    // rejected -> confirmed 允许(工作台重新关联路径)
    expect(await updateGraphLinkStatus(ctx, id, 'confirmed', 'human', 'u1')).toBe(true);
    expect((await findGraphLinkById(ctx, id, 'u1'))?.status).toBe('confirmed');
  });

  it('props merge(patch 与既有键合并) + graphStatus 落库', async () => {
    const id = await seed();
    await updateGraphLinkProps(ctx, id, { allocatedAmount: 100 }, 'u1');
    expect((await findGraphLinkById(ctx, id, 'u1'))?.props).toEqual({ share: 1, allocatedAmount: 100 });
    await setGraphLinkGraphStatus(ctx, id, { status: 'skipped', reason: 'NEO4J_PASSWORD not set' }, 'u1');
    expect((await findGraphLinkById(ctx, id, 'u1'))?.graphStatus?.status).toBe('skipped');
    await setGraphLinkGraphStatus(ctx, id, { status: 'ok', syncedAt: '2026-08-25T00:00:00Z' }, 'u1');
    expect((await findGraphLinkById(ctx, id, 'u1'))?.graphStatus?.status).toBe('ok');
  });

  it('listGraphLinks 按 createdAt 倒序返回全部', async () => {
    await seed();
    await saveGraphLink(ctx, { kind: 'relates', srcKind: 'Project', srcKey: 'P1', dstKind: 'Project', dstKey: 'P2', createdBy: 'agent' }, 'u1');
    const rows = await listGraphLinks(ctx, 'u1');
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.kind)).toContain('relates');
  });

  it('用户隔离: u2 看不到 u1 的行', async () => {
    const id = await seed();
    expect(await findGraphLinkById(ctx, id, 'u2')).toBeNull();
    expect(await listGraphLinks(ctx, 'u2')).toHaveLength(0);
  });
});
