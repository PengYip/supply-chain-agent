import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate } from '../../../src/pipeline/db/client.js';
import {
  findQuotaById, listQuotas, upsertContractLedgerEntry,
} from '../../../src/pipeline/db/repositories.js';
import { buildLedgerEntryFromExtraction, type ContractLedgerEntry } from '../../../src/pipeline/contractLedger.js';
import { buildManageQuotaTool, buildQueryQuotaUsageTool } from '../../../src/pipeline/tools/quotaTools.js';
import { isSoftGate, isReadonly } from '../../../src/harness/permissionGate.js';

// manage_quota(L2)/query_quota_usage(L1) 工具(spec 方案A §6)。execute 走
// :memory: db + 无 Neo4j(图同步 skipped 不受阻)。

const span = { blockId: 'b1', start: 0, end: 4 };
function ledger(contractNo: string, fields: Record<string, string | number>): ContractLedgerEntry {
  const names = Object.keys(fields);
  return buildLedgerEntryFromExtraction({
    documentId: `DOC-${contractNo}`,
    docType: '合同',
    fields: {
      合同号: { value: contractNo, sourceSpans: [span] },
      ...Object.fromEntries(names.map((n) => [n, { value: fields[n], sourceSpans: [span] }])),
    },
    fieldMeta: Object.fromEntries(
      ['合同号', ...names].map((n) => [n, { strength: 'exact' as const, confidence: 0.95 }]),
    ),
  })!;
}

let ctx: ReturnType<typeof createDb>;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
  delete process.env.NEO4J_PASSWORD;
});

async function call(tool: { execute?: (input: unknown, opts: unknown) => Promise<unknown> }, input: unknown) {
  return tool.execute!(input, { toolCallId: 't1', messages: [] as never[] });
}

describe('manage_quota 工具', () => {
  it('create(counterparty): 建行 + 即时占用 + graphSync=skipped', async () => {
    await upsertContractLedgerEntry(ctx, ledger('HT-1', { 甲方: '我方', 乙方: '中石化股份有限公司', 金额: 100 }));
    const tool = buildManageQuotaTool({ ctx, userId: 'u1' });
    const res = await call(tool, {
      action: 'create', scope: 'counterparty', ownerName: '中石化股份有限公司', limitAmount: 80,
    }) as { status: string; quotaId: string; used: number; overLimit: boolean; graphSync: string };
    expect(res.status).toBe('ok');
    expect(res.used).toBe(100);
    expect(res.overLimit).toBe(true);
    expect(res.graphSync).toBe('skipped');
    const row = await findQuotaById(ctx, res.quotaId, 'u1');
    expect(row?.scope).toBe('counterparty');
    expect(row?.ownerKey).toBe('中石化股份有限公司');
  });

  it('create(project): projectCode 必填路径', async () => {
    const tool = buildManageQuotaTool({ ctx, userId: 'u1' });
    const res = await call(tool, {
      action: 'create', scope: 'project', projectCode: 'P-2026-01', limitAmount: 500,
    }) as { status: string };
    expect(res.status).toBe('ok');
    const rows = await listQuotas(ctx, { userId: 'u1' });
    expect(rows[0]!.ownerKey).toBe('P-2026-01');
  });

  it('create 缺 limitAmount / owner 与 projectCode 同时给 -> 报错', async () => {
    const tool = buildManageQuotaTool({ ctx, userId: 'u1' });
    const r1 = await call(tool, { action: 'create', scope: 'counterparty', ownerName: 'X' }) as { status: string; error?: string };
    expect(r1.status).toBe('error');
    const r2 = await call(tool, { action: 'create', scope: 'project', projectCode: 'P1', ownerName: 'X', limitAmount: 1 }) as { status: string; error?: string };
    expect(r2.status).toBe('error');
  });

  it('update_limit + deactivate', async () => {
    const created = await call(buildManageQuotaTool({ ctx, userId: 'u1' }), {
      action: 'create', scope: 'counterparty', ownerName: 'A 公司', limitAmount: 10,
    }) as { quotaId: string };
    const upd = await call(buildManageQuotaTool({ ctx, userId: 'u1' }), {
      action: 'update_limit', quotaId: created.quotaId, limitAmount: 99,
    }) as { status: string; limitAmount: number };
    expect(upd.status).toBe('ok');
    expect(upd.limitAmount).toBe(99);
    const off = await call(buildManageQuotaTool({ ctx, userId: 'u1' }), {
      action: 'deactivate', quotaId: created.quotaId,
    }) as { status: string; graphSync: string };
    expect(off.status).toBe('ok');
    expect(off.graphSync).toBe('skipped');
    expect((await findQuotaById(ctx, created.quotaId, 'u1'))?.status).toBe('inactive');
  });

  it('权限注册: manage_quota=L2 软门控', () => {
    expect(isSoftGate('manage_quota')).toBe(true);
    expect(isReadonly('manage_quota')).toBe(false);
  });
});

describe('query_quota_usage 工具', () => {
  it('读物化 used/remaining/overLimit + 过滤', async () => {
    await upsertContractLedgerEntry(ctx, ledger('HT-1', { 甲方: '我方', 乙方: '中石化股份有限公司', 金额: 100 }));
    await call(buildManageQuotaTool({ ctx, userId: 'u1' }), {
      action: 'create', scope: 'counterparty', ownerName: '中石化股份有限公司', limitAmount: 80,
    });
    const tool = buildQueryQuotaUsageTool({ ctx, userId: 'u1' });
    const res = await call(tool, {}) as { status: string; quotas: Array<{ used: number; remaining: number; overLimit: boolean }> };
    expect(res.status).toBe('ok');
    expect(res.quotas).toHaveLength(1);
    expect(res.quotas[0]!.used).toBe(100);
    expect(res.quotas[0]!.overLimit).toBe(true);
    const empty = await call(buildQueryQuotaUsageTool({ ctx, userId: 'u1' }), { scope: 'project' }) as { quotas: unknown[] };
    expect(empty.quotas).toHaveLength(0);
  });

  it('权限注册: query_quota_usage=L1 只读', () => {
    expect(isReadonly('query_quota_usage')).toBe(true);
    expect(isSoftGate('query_quota_usage')).toBe(false);
  });
});
