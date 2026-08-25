import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate } from '../../../src/pipeline/db/client.js';
import {
  saveQuota,
  findQuotaById,
  listQuotas,
  updateQuota,
  updateQuotaUsed,
} from '../../../src/pipeline/db/repositories.js';

// quotas 存储(spec 2026-08-25 方案A §3.1 Quota): 两层额度(对手方授信/项目限额)。
// used_amount/computed_at 为对账桥物化结果, 写入只经 updateQuotaUsed。

let ctx: ReturnType<typeof createDb>;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
});

describe('quotas repo', () => {
  it('save->find roundtrip; 默认 active/usedAmount 0/computedAt null', async () => {
    const id = await saveQuota(ctx, {
      scope: 'counterparty', ownerKey: '中石化股份有限公司', ownerLabel: '中石化',
      limitAmount: 1000000, currency: 'CNY', period: '2026', createdBy: 'u1',
    }, 'u1');
    const row = await findQuotaById(ctx, id, 'u1');
    expect(row?.scope).toBe('counterparty');
    expect(row?.ownerKey).toBe('中石化股份有限公司');
    expect(row?.limitAmount).toBe(1000000);
    expect(row?.currency).toBe('CNY');
    expect(row?.usedAmount).toBe(0);
    expect(row?.computedAt).toBeNull();
    expect(row?.status).toBe('active');
    expect(row?.userId).toBe('u1');
  });

  it('updateQuota: limitAmount/currency/period 与 status->inactive', async () => {
    const id = await saveQuota(ctx, {
      scope: 'project', ownerKey: 'P-2026-01', ownerLabel: '一号项目',
      limitAmount: 500000, createdBy: 'u1',
    }, 'u1');
    const ok = await updateQuota(ctx, id, { limitAmount: 800000, period: '2026H2' }, 'u1');
    expect(ok).toBe(true);
    const row = await findQuotaById(ctx, id, 'u1');
    expect(row?.limitAmount).toBe(800000);
    expect(row?.period).toBe('2026H2');
    const ok2 = await updateQuota(ctx, id, { status: 'inactive' }, 'u1');
    expect(ok2).toBe(true);
    expect((await findQuotaById(ctx, id, 'u1'))?.status).toBe('inactive');
    // 未命中 id -> false
    expect(await updateQuota(ctx, 'Q-NONE', { limitAmount: 1 }, 'u1')).toBe(false);
  });

  it('updateQuotaUsed 持久化 used+computedAt', async () => {
    const id = await saveQuota(ctx, {
      scope: 'counterparty', ownerKey: 'A 公司', limitAmount: 100, createdBy: 'u1',
    }, 'u1');
    const ok = await updateQuotaUsed(ctx, id, 88.5, '2026-08-25T10:00:00Z', 'u1');
    expect(ok).toBe(true);
    const row = await findQuotaById(ctx, id, 'u1');
    expect(row?.usedAmount).toBe(88.5);
    expect(row?.computedAt).toBe('2026-08-25T10:00:00Z');
  });

  it('listQuotas: scope 过滤 + 默认仅 active + 用户隔离', async () => {
    await saveQuota(ctx, { scope: 'counterparty', ownerKey: 'A', limitAmount: 1, createdBy: 'u1' }, 'u1');
    const inactiveId = await saveQuota(ctx, { scope: 'counterparty', ownerKey: 'B', limitAmount: 2, createdBy: 'u1' }, 'u1');
    await updateQuota(ctx, inactiveId, { status: 'inactive' }, 'u1');
    await saveQuota(ctx, { scope: 'project', ownerKey: 'P-1', limitAmount: 3, createdBy: 'u1' }, 'u1');
    await saveQuota(ctx, { scope: 'counterparty', ownerKey: 'C', limitAmount: 4, createdBy: 'u2' }, 'u2');

    const active = await listQuotas(ctx, { userId: 'u1' });
    expect(active).toHaveLength(2); // inactive 不出现
    const cp = await listQuotas(ctx, { scope: 'counterparty', userId: 'u1' });
    expect(cp).toHaveLength(1);
    expect(cp[0]!.ownerKey).toBe('A');
    const u2 = await listQuotas(ctx, { userId: 'u2' });
    expect(u2).toHaveLength(1);
    expect(u2[0]!.ownerKey).toBe('C');
    // 含 inactive 显式开关
    const all = await listQuotas(ctx, { userId: 'u1', includeInactive: true });
    expect(all).toHaveLength(3);
  });
});
