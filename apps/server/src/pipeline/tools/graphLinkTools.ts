// link_contracts / link_projects — L2 工具(spec 2026-08-25 方案A §6)。
//
// 把人/Agent 判断的背靠背购销对应(correlates)与项目级关联(relates)落
// graph_links SSOT(status=confirmed, confirmationSource='agent'), 图边投影
// 走 graphLinkSync best-effort(NEO4J_PASSWORD 未设 -> skipped, 业务写不受阻)。
// 注册处标 needsApproval: true(v6 软门控)—— chat 内 HITL 审批后执行;
// 工作台人工通道走 /api/graph/links(confirmationSource='human')。
//
// 边界: 不做金额分摊录入(分摊走工作台 PATCH /api/graph/links/:id/props);
// 不校验合同存在性(图上 ensureNode 兜底建 Contract/Project 节点, 与
// bindingGraphSync 同语义)。
import { tool } from 'ai';
import { z } from 'zod';
import type { DbContext } from '../db/client.js';
import {
  saveGraphLink, findGraphLinkByTriple, setGraphLinkGraphStatus,
} from '../db/repositories.js';
import { syncGraphLinkEdge } from '../graphLinkSync.js';

export interface GraphLinkToolDeps {
  ctx: DbContext;
  userId?: string;
}

async function upsertLinkAndSync(
  deps: GraphLinkToolDeps,
  input: {
    kind: 'correlates' | 'relates';
    srcKind: 'Contract' | 'Project'; srcKey: string;
    dstKind: 'Contract' | 'Project'; dstKey: string;
    props: Record<string, unknown>;
  },
): Promise<{ linkId: string; graphSync: string }> {
  const linkId = await saveGraphLink(deps.ctx, {
    kind: input.kind,
    srcKind: input.srcKind, srcKey: input.srcKey,
    dstKind: input.dstKind, dstKey: input.dstKey,
    props: input.props,
    status: 'confirmed', confirmationSource: 'agent', createdBy: 'agent',
  }, deps.userId);
  const sync = await syncGraphLinkEdge({
    kind: input.kind,
    srcKind: input.srcKind, srcKey: input.srcKey,
    dstKind: input.dstKind, dstKey: input.dstKey,
    props: input.props,
    confirmationSource: 'agent',
    confidence: 0.8,
  });
  await setGraphLinkGraphStatus(
    deps.ctx, linkId,
    sync.outcome === 'ok'
      ? { status: 'ok', syncedAt: new Date().toISOString() }
      : { status: sync.outcome, ...(sync.reason ? { reason: sync.reason } : {}), syncedAt: new Date().toISOString() },
    deps.userId,
  );
  return { linkId, graphSync: sync.outcome };
}

export function buildLinkContractsTool(deps: GraphLinkToolDeps) {
  return tool({
    description:
      '建立采购合同与销售合同之间的背靠背购销对应(correlates)。什么时候用: 用户说' +
      '"这张采购的货用于那张销售""把采购合同X和销售合同Y对应起来"时调用; 允许一对多/' +
      '多对一(分别建多条)。L2 操作: 调用需附带人工授权(needsApproval)。幂等: 同一' +
      '对合同重复提交只更新份额等属性。不做金额分摊录入——分摊请走工作台 ' +
      'PATCH /api/graph/links/:id/props。合同号用台账规范化形式(CJXC-... 大写无空格)。',
    inputSchema: z.object({
      purchaseContractNo: z.string().min(1).describe('采购合同号(主体买进的一方)'),
      salesContractNo: z.string().min(1).describe('销售合同号(主体卖出的一方)'),
      share: z.number().min(0).max(1).optional().describe('对应份额 0-1, 如 0.5 = 一半数量对应'),
      note: z.string().max(500).optional().describe('备注(如批次/业务线索)'),
    }),
    execute: async ({ purchaseContractNo, salesContractNo, share, note }) => {
      const props: Record<string, unknown> = {};
      if (share !== undefined) props.share = share;
      if (note !== undefined) props.note = note;
      const { linkId, graphSync } = await upsertLinkAndSync(deps, {
        kind: 'correlates',
        srcKind: 'Contract', srcKey: purchaseContractNo,
        dstKind: 'Contract', dstKey: salesContractNo,
        props,
      });
      const row = await findGraphLinkByTriple(deps.ctx,
        { kind: 'correlates', srcKey: purchaseContractNo, dstKey: salesContractNo }, deps.userId);
      return {
        status: 'ok' as const,
        linkId,
        purchaseContractNo: row?.srcKey ?? purchaseContractNo,
        salesContractNo: row?.dstKey ?? salesContractNo,
        graphSync,
      };
    },
  });
}

export function buildLinkProjectsTool(deps: GraphLinkToolDeps) {
  return tool({
    description:
      '建立两个项目之间的业务关联(relates)。什么时候用: 用户说"这两个项目是同一单生意' +
      '拆的""项目A和项目B关联"时调用。L2 操作: 调用需附带人工授权(needsApproval)。' +
      '幂等: 同一对项目重复提交只更新关联类型等属性。',
    inputSchema: z.object({
      srcProjectCode: z.string().min(1).describe('项目 A 的项目编号'),
      dstProjectCode: z.string().min(1).describe('项目 B 的项目编号'),
      type: z.string().max(50).optional().describe('关联类型, 如 同一生意拆分/母子项目'),
      note: z.string().max(500).optional().describe('备注'),
    }),
    execute: async ({ srcProjectCode, dstProjectCode, type, note }) => {
      const props: Record<string, unknown> = {};
      if (type !== undefined) props.type = type;
      if (note !== undefined) props.note = note;
      const { linkId, graphSync } = await upsertLinkAndSync(deps, {
        kind: 'relates',
        srcKind: 'Project', srcKey: srcProjectCode,
        dstKind: 'Project', dstKey: dstProjectCode,
        props,
      });
      return { status: 'ok' as const, linkId, graphSync };
    },
  });
}
