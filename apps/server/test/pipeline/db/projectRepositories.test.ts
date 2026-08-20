import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate } from '../../../src/pipeline/db/client.js';
import {
  createProject,
  findProjectByCode,
  listProjects,
  upsertProjectMembership,
  findMembershipById,
  listMembershipsByProject,
  listMembershipsByContract,
  updateMembershipStatus,
  setMembershipGraphStatus,
  normalizeProjectCode,
} from '../../../src/pipeline/db/repositories.js';

// 项目与归属关系仓储(Task 6, spec 2026-08-20 §4.1): projects / project_memberships
// 两张表的 SQLite 路径(PG 为 postgres-repositories 孪生)。contractNo 存
// normalizeContractNo 后的值(报表连接键), projectCode 存归一大写。
let ctx: ReturnType<typeof createDb>;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
});

describe('normalizeProjectCode', () => {
  it('trim + 大写', () => {
    expect(normalizeProjectCode(' prj-2026-001 ')).toBe('PRJ-2026-001');
  });
});

describe('createProject / findProjectByCode / listProjects', () => {
  it('创建成功返回行; 同 code 二次创建返回 null(幂等不抛)', async () => {
    const p = await createProject(ctx, { code: 'PRJ-2026-001', name: '曹妃甸项目' });
    expect(p).not.toBeNull();
    expect(p?.code).toBe('PRJ-2026-001');
    expect(p?.name).toBe('曹妃甸项目');
    expect(p?.status).toBe('active');

    const dup = await createProject(ctx, { code: 'prj-2026-001', name: '重复' }); // 归一后同 code
    expect(dup).toBeNull();
  });

  it('code 归一大写; findProjectByCode 大小写归一命中', async () => {
    await createProject(ctx, { code: 'PRJ-2026-001', name: '曹妃甸项目' });
    const hit = await findProjectByCode(ctx, 'prj-2026-001');
    expect(hit?.code).toBe('PRJ-2026-001');
    expect(await findProjectByCode(ctx, 'PRJ-404')).toBeNull();
  });

  it("listProjects 按 user 过滤, legacy 空串(未登录态)行对 scoped 调用者可见", async () => {
    await createProject(ctx, { code: 'PRJ-A', name: 'A', userId: 'u1' });
    await createProject(ctx, { code: 'PRJ-B', name: 'B' }); // unscoped -> ''
    expect((await listProjects(ctx, 'u1')).map((p) => p.code).sort()).toEqual(['PRJ-A', 'PRJ-B']);
    expect((await listProjects(ctx, 'u2')).map((p) => p.code)).toEqual(['PRJ-B']);
    expect((await listProjects(ctx)).map((p) => p.code).sort()).toEqual(['PRJ-A', 'PRJ-B']);
  });
});

describe('upsertProjectMembership / findMembershipById / list*', () => {
  it('幂等 upsert: 同 (contractNo, projectCode) 返回同 id, 字段更新为最新值', async () => {
    await createProject(ctx, { code: 'PRJ-1', name: '一' });
    const id1 = await upsertProjectMembership(ctx, {
      contractNo: 'ht-2026-001',
      projectCode: 'PRJ-1',
      role: '采购',
      status: 'proposed',
      proposedBy: 'system',
      confidence: 0.6,
      createdBy: 'system',
    });
    const id2 = await upsertProjectMembership(ctx, {
      contractNo: 'HT-2026-001', // 归一后同键
      projectCode: 'prj-1',
      role: '销售',
      status: 'confirmed',
      proposedBy: 'human',
      confirmationSource: 'human',
      confidence: 1,
      createdBy: 'u1',
    });
    expect(id2).toBe(id1);

    const m = await findMembershipById(ctx, id1);
    expect(m?.contractNo).toBe('HT-2026-001'); // normalizeContractNo 后大写
    expect(m?.projectCode).toBe('PRJ-1');
    expect(m?.role).toBe('销售');
    expect(m?.status).toBe('confirmed');
    expect(m?.proposedBy).toBe('human');
    expect(m?.confirmationSource).toBe('human');
    expect(m?.confidence).toBe(1);
  });

  it('listMembershipsByProject 命中 + status 过滤; listMembershipsByContract 命中', async () => {
    await createProject(ctx, { code: 'PRJ-1', name: '一' });
    const a = await upsertProjectMembership(ctx, {
      contractNo: 'HT-A', projectCode: 'PRJ-1', role: '采购',
      status: 'proposed', proposedBy: 'system', confidence: 0.5, createdBy: 'system',
    });
    await upsertProjectMembership(ctx, {
      contractNo: 'HT-B', projectCode: 'PRJ-1', role: '销售',
      status: 'confirmed', proposedBy: 'system', confidence: 0.7, createdBy: 'system',
    });

    const all = await listMembershipsByProject(ctx, 'prj-1');
    expect(all).toHaveLength(2);
    const confirmedOnly = await listMembershipsByProject(ctx, 'PRJ-1', undefined, 'confirmed');
    expect(confirmedOnly.map((m) => m.contractNo)).toEqual(['HT-B']);
    expect(a).toBeTruthy();

    const byContract = await listMembershipsByContract(ctx, 'ht-a');
    expect(byContract.map((m) => m.projectCode)).toEqual(['PRJ-1']);
  });

  it('updateMembershipStatus: proposed->confirmed 带 source; ->rejected; 未知 id null', async () => {
    await createProject(ctx, { code: 'PRJ-1', name: '一' });
    const id = await upsertProjectMembership(ctx, {
      contractNo: 'HT-A', projectCode: 'PRJ-1', role: '采购',
      proposedBy: 'system', createdBy: 'system',
    });
    const confirmed = await updateMembershipStatus(ctx, id, 'confirmed', 'human');
    expect(confirmed?.status).toBe('confirmed');
    expect(confirmed?.confirmationSource).toBe('human');

    const rejected = await updateMembershipStatus(ctx, id, 'rejected', null);
    expect(rejected?.status).toBe('rejected');

    expect(await updateMembershipStatus(ctx, 'PM-404', 'confirmed', 'human')).toBeNull();
  });

  it('setMembershipGraphStatus 落 JSON, 读回解析为对象', async () => {
    await createProject(ctx, { code: 'PRJ-1', name: '一' });
    const id = await upsertProjectMembership(ctx, {
      contractNo: 'HT-A', projectCode: 'PRJ-1', createdBy: 'system',
    });
    await setMembershipGraphStatus(ctx, id, { status: 'skipped', reason: 'NEO4J_PASSWORD not set' });
    const m = await findMembershipById(ctx, id);
    expect(m?.graphStatus).toEqual({ status: 'skipped', reason: 'NEO4J_PASSWORD not set' });
  });

  it('用户隔离: 他人 project/membership 行不可见', async () => {
    await createProject(ctx, { code: 'PRJ-A', name: 'A', userId: 'u1' });
    await upsertProjectMembership(ctx, {
      contractNo: 'HT-A', projectCode: 'PRJ-A', role: '采购',
      proposedBy: 'system', createdBy: 'system',
    }, 'u1');

    expect(await findProjectByCode(ctx, 'PRJ-A', 'u2')).toBeNull();
    expect(await listMembershipsByProject(ctx, 'PRJ-A', 'u2')).toEqual([]);
    expect(await listMembershipsByContract(ctx, 'HT-A', 'u2')).toEqual([]);
    // 本人可见。
    expect(await findProjectByCode(ctx, 'PRJ-A', 'u1')).not.toBeNull();
    expect(await listMembershipsByContract(ctx, 'HT-A', 'u1')).toHaveLength(1);
  });
});
