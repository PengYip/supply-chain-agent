import { z } from 'zod';
import { tool } from 'ai';
import { buildLinkContractsTool, buildLinkProjectsTool, buildLinkAmendsTool } from './graphLinkTools.js';
import type { GraphLinkToolDeps } from './graphLinkTools.js';

// link_documents (tool-inventory methodology 阶段2b, 2026-08-28): single L2
// surface for the three GraphLinkKind relations (correlates/relates/amends).
// The three builders were one implementation split three ways; delegation keeps
// their execute bodies (idempotency, SSOT write + best-effort edge projection,
// needsApproval semantics) unchanged. Writes keep dedicated audit records via
// the central withAudit choke point.

export function buildLinkDocumentsTool(deps: GraphLinkToolDeps) {
  const contracts = buildLinkContractsTool(deps);
  const projects = buildLinkProjectsTool(deps);
  const amends = buildLinkAmendsTool(deps);

  return tool({
    description:
      '建立单据/项目间的业务关系(L2, 需人工授权), 用 relation 区分: ' +
      'correlates=采购合同与销售合同背靠背对应(必传 purchaseContractNo/salesContractNo, 可选 share/allocatedAmount/allocatedQuantity/note; 允许一对多/多对一分别建多条); ' +
      'relates=两个项目业务关联(必传 srcProjectCode/dstProjectCode, 可选 type/note); ' +
      'amends=补充合同修订基础合同(必传 docId=已入库补充合同文档 id + baseContractNo, 可选 note)。' +
      '幂等: 同一对重复提交只更新属性。不做金额分摊录入(分摊走工作台 PATCH /api/graph/links/:id/props)。' +
      '合同号用台账规范化形式(大写无空格)。' +
      '调用示例: 1) 背靠背 {relation: "correlates", purchaseContractNo: "CG-001", salesContractNo: "XS-001"}; ' +
      '2) 补充合同 {relation: "amends", docId: "DOC-xxx", baseContractNo: "CJXC-2025-001"}。',
    inputSchema: z.object({
      relation: z
        .enum(['correlates', 'relates', 'amends'])
        .describe('correlates=合同背靠背对应; relates=项目关联; amends=补充合同修订'),
      purchaseContractNo: z.string().optional().describe('relation=correlates 必填: 采购合同号(主体买进的一方)'),
      salesContractNo: z.string().optional().describe('relation=correlates 必填: 销售合同号(主体卖出的一方)'),
      share: z.number().min(0).max(1).optional().describe('relation=correlates 可选: 对应份额 0-1'),
      allocatedAmount: z.number().optional().describe('relation=correlates 可选: 分摊金额'),
      allocatedQuantity: z.number().optional().describe('relation=correlates 可选: 分摊数量'),
      srcProjectCode: z.string().optional().describe('relation=relates 必填: 项目 A 编号'),
      dstProjectCode: z.string().optional().describe('relation=relates 必填: 项目 B 编号'),
      type: z.string().max(50).optional().describe('relation=relates 可选: 关联类型, 如 同一生意拆分'),
      docId: z.string().optional().describe('relation=amends 必填: 补充合同文档 id(已入库)'),
      baseContractNo: z.string().optional().describe('relation=amends 必填: 被修订的基础合同号'),
      note: z.string().max(500).optional().describe('备注'),
    }),
    execute: async (input, opts) => {
      const { relation, purchaseContractNo, salesContractNo, share, allocatedAmount, allocatedQuantity, srcProjectCode, dstProjectCode, type, docId, baseContractNo, note } = input;
      switch (relation) {
        case 'correlates':
          if (!purchaseContractNo || !salesContractNo) {
            return { error: 'relation=correlates 需要 purchaseContractNo 与 salesContractNo' };
          }
          return contracts.execute!(
            { purchaseContractNo, salesContractNo, share, allocatedAmount, allocatedQuantity, note },
            opts,
          );
        case 'relates':
          if (!srcProjectCode || !dstProjectCode) {
            return { error: 'relation=relates 需要 srcProjectCode 与 dstProjectCode' };
          }
          return projects.execute!({ srcProjectCode, dstProjectCode, type, note }, opts);
        case 'amends':
          if (!docId || !baseContractNo) {
            return { error: 'relation=amends 需要 docId(补充合同文档 id) 与 baseContractNo' };
          }
          return amends.execute!({ docId, baseContractNo, note }, opts);
      }
    },
  });
}
