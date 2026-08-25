import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate } from '../../../src/pipeline/db/client.js';
import { findGraphLinkByTriple } from '../../../src/pipeline/db/repositories.js';
import { buildLinkContractsTool, buildLinkProjectsTool } from '../../../src/pipeline/tools/graphLinkTools.js';
import { isSoftGate, isReadonly } from '../../../src/harness/permissionGate.js';

// L2 工具(spec 方案A §6): needsApproval 软门控由注册处标记; execute 落
// graph_links(confirmed/agent) + best-effort 边同步(无 Neo4j -> skipped)。

let ctx: ReturnType<typeof createDb>;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
  delete process.env.NEO4J_PASSWORD;
});

describe('link_contracts / link_projects 工具', () => {
  it('link_contracts: 落 confirmed/agent 行 + props(share/note), graphSync=skipped', async () => {
    const tool = buildLinkContractsTool({ ctx, userId: 'u1' });
    const res = await tool.execute!({ purchaseContractNo: 'CG-1', salesContractNo: 'XS-1', share: 0.5, note: '背靠背' }, {
      toolCallId: 't1', messages: [] as never[],
    }) as { status: string; linkId: string; graphSync: string };
    expect(res.status).toBe('ok');
    expect(res.graphSync).toBe('skipped');
    const row = await findGraphLinkByTriple(ctx, { kind: 'correlates', srcKey: 'CG-1', dstKey: 'XS-1' }, 'u1');
    expect(row?.status).toBe('confirmed');
    expect(row?.confirmationSource).toBe('agent');
    expect(row?.props).toEqual({ share: 0.5, note: '背靠背' });
    expect(row?.srcKind).toBe('Contract');
  });

  it('link_contracts: 重复提交幂等(同 linkId)', async () => {
    const tool = buildLinkContractsTool({ ctx, userId: 'u1' });
    const r1 = await tool.execute!({ purchaseContractNo: 'CG-1', salesContractNo: 'XS-1' }, { toolCallId: 't1', messages: [] as never[] }) as { linkId: string };
    const r2 = await tool.execute!({ purchaseContractNo: 'CG-1', salesContractNo: 'XS-1' }, { toolCallId: 't2', messages: [] as never[] }) as { linkId: string };
    expect(r2.linkId).toBe(r1.linkId);
  });

  it('link_projects: relates 行 + type/note props', async () => {
    const tool = buildLinkProjectsTool({ ctx, userId: 'u1' });
    const res = await tool.execute!({ srcProjectCode: 'P1', dstProjectCode: 'P2', type: '同一生意拆分' }, { toolCallId: 't1', messages: [] as never[] }) as { status: string };
    expect(res.status).toBe('ok');
    const row = await findGraphLinkByTriple(ctx, { kind: 'relates', srcKey: 'P1', dstKey: 'P2' }, 'u1');
    expect(row?.props).toEqual({ type: '同一生意拆分' });
    expect(row?.srcKind).toBe('Project');
  });

  it('权限注册: 两工具均为 L2 软门控', () => {
    expect(isSoftGate('link_contracts')).toBe(true);
    expect(isSoftGate('link_projects')).toBe(true);
    expect(isReadonly('link_contracts')).toBe(false);
  });
});
