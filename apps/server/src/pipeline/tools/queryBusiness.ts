import { z } from 'zod';
import { tool } from 'ai';
import type { DbContext } from '../db/client.js';
import { listUnboundVoucherDocs } from '../db/repositories.js';
import { buildQueryContractTool, buildProjectRollupTool } from '../../tools/queries.js';
import { buildQueryExecutionFlowsTool } from '../executionFlow.js';
import { buildQueryQuotaUsageTool } from './quotaTools.js';
import { buildTemplateOverviewTool } from './templateOverviewTool.js';

// query_business (tool-inventory methodology 阶段2, 2026-08-28): the single
// structured-SSOT read entry. Absorbs query_contract / query_execution_flows /
// query_quota_usage / project_rollup / template_overview (functionally similar,
// overlapping scenarios, simple params -> unified entry + entity discriminator,
// per docs/tool-design-methodology.md). The five builders stay intact and are
// DELEGATED to 1:1 -- their execute bodies (including notConfigured / seed
// fallback / truncation semantics) are unchanged, only the mounted surface
// collapses. Writes (manage_quota / manage_template) keep their own L2 tools:
// dedicated audit granularity is a hard requirement for business writes.

export interface QueryBusinessDeps {
  ctx: DbContext;
  userId?: string;
}

export function buildQueryBusinessTool(deps: QueryBusinessDeps) {
  const contractTool = buildQueryContractTool(deps);
  const flowsTool = buildQueryExecutionFlowsTool(deps);
  const quotaTool = buildQueryQuotaUsageTool(deps);
  const projectTool = buildProjectRollupTool(deps);
  const templateTool = buildTemplateOverviewTool(deps);

  return tool({
    description:
      '结构化业务数据统一查询入口, 用 entity 区分查什么: ' +
      'contract=合同台账(不传 contractNo=枚举台账全部合同摘要, "系统里都录入了哪些合同"类盘点问题必须用它; ' +
      '传 contractNo=点查该合同详情, 台账优先 source=ledger, 未命中回退演示种子); ' +
      'flow=某合同的六向执行流水(资金/货物/发票 x 进/出)汇总与逐笔明细(必传 contractNo); ' +
      'quota=两层额度占用(只读对账桥物化结果, 可选 scope/ownerName/projectCode 过滤); ' +
      'project=按项目编号汇总合同金额/毛差/应收应付/流水/校验提示(必传 projectCode); ' +
      'template=单据模板类型层级与允许挂接的合同类型词表(可选 docType, 缺省返回全层级); ' +
      'unbound_docs=悬空凭证清单(已解析但未绑定合同的凭证类单据, 它们不参与 recall_documents 检索, 本清单是其唯一批量发现入口, 供人工确认合同号后用 bind_document 补绑)。' +
      '这些都是结构化台账/物化数据, 不要用 recall_documents 检索替代; 找单据原文片段才用 recall_documents。' +
      '查具体合同条款时两步走: 先用 entity="contract" 命中合同, 再用 recall_documents 传 contractNo 加条款关键词(如交货/违约/质量)检索原文片段作答, 以返回的 document_id 说明出处。' +
      '调用示例: 1) 盘点合同 {entity: "contract"}; ' +
      '2) 查合同执行流水 {entity: "flow", contractNo: "CJXC-2025-001"}; ' +
      '3) 项目概况 {entity: "project", projectCode: "PRJ-2026-001"}。',
    inputSchema: z.object({
      entity: z
        .enum(['contract', 'flow', 'quota', 'project', 'template', 'unbound_docs'])
        .describe('查什么: contract=合同台账; flow=执行流水; quota=额度占用; project=项目汇总; template=模板词表; unbound_docs=悬空凭证清单'),
      contractNo: z
        .string()
        .optional()
        .describe('entity=contract 时可选(缺省=枚举全部); entity=flow 时必填'),
      projectCode: z
        .string()
        .optional()
        .describe('entity=project 时必填(如 PRJ-2026-001); entity=quota 时可选过滤'),
      scope: z
        .enum(['counterparty', 'project'])
        .optional()
        .describe('entity=quota 可选: counterparty=对手方授信; project=项目限额'),
      ownerName: z
        .string()
        .optional()
        .describe('entity=quota 可选: 按对手方名过滤(包含匹配)'),
      docType: z
        .string()
        .optional()
        .describe('entity=template 可选: 单据类型名(如 收货单/发票); 缺省返回全层级'),
    }),
    execute: async (input, opts) => {
      switch (input.entity) {
        case 'contract':
          return contractTool.execute!({ contractNo: input.contractNo }, opts);
        case 'flow':
          if (!input.contractNo || input.contractNo.trim().length === 0) {
            return { error: 'entity=flow 需要 contractNo(台账规范化后的合同号)' };
          }
          return flowsTool.execute!({ contractNo: input.contractNo }, opts);
        case 'quota':
          return quotaTool.execute!(
            { scope: input.scope, ownerName: input.ownerName, projectCode: input.projectCode },
            opts,
          );
        case 'project':
          if (!input.projectCode || input.projectCode.trim().length === 0) {
            return { error: 'entity=project 需要 projectCode(如 PRJ-2026-001)' };
          }
          return projectTool.execute!({ projectCode: input.projectCode }, opts);
        case 'template':
          return templateTool.execute!({ docType: input.docType }, opts);
        case 'unbound_docs': {
          const docs = await listUnboundVoucherDocs(deps.ctx, deps.userId);
          return {
            status: 'ok' as const,
            entity: 'unbound_docs' as const,
            count: docs.length,
            docs,
            usage:
              '悬空凭证=已完成解析但未绑定合同的凭证类单据(对 recall 检索不可见)。' +
              '处理: 与用户逐份确认归属合同号后调用 bind_document(L2, 需用户确认; ' +
              'sourceSpan 可传 {blockId:"",start:0,end:0} 占位, 并向用户说明本次绑定依据用户口述/凭证信息)。' +
              'hasExtraction=false 的单据建议先 extract_fields 抽取后再绑定。',
          };
        }
      }
    },
  });
}
