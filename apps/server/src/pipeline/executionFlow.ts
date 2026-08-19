// 执行流水物化(executionFlow): 绑定确认时的旁路 byproduct。
//
// 一条 binding 变为 confirmed(人工确认 / auto_rule 自动确认 / 手动创建 / agent 确认)
// 时, 用该凭证的最新抽取行物化一条"执行流水"落库。六向(收款/付款/收货/发货/收票/开票)
// 的方向语义来自 domain/flowDirection: 锚点 buyer/seller 哪一侧命中本公司主体名单
// (env.SELF_PARTY_NAMES) 决定 收(in)/付/发/开(out)。
//
// 白名单: 付款凭证->资金流、货转单->货物流、发票->发票流; 其余(合同/提单/装箱单/
// 化验报告/其他)返回 null -- 提单/装箱单/质检(化验报告)是未来扩展, 当前不参与执行流水。
//
// 物化是安静旁路: 无抽取、docType 白名单外、名单未配置或方向判不出时返回 null, 不抛错、
// 不影响绑定确认主流程; 同 bindingId 重复物化的幂等语义交由存储层 upsert 保证。

import { tool } from 'ai';
import { z } from 'zod';
import type { DbContext } from './db/client.js';
import {
  loadLatestExtractionByDocId,
  upsertExecutionFlow,
  retractExecutionFlowForBinding,
  summarizeExecutionFlows,
  listExecutionFlows,
} from './db/repositories.js';
import { extractAnchors, type VoucherType } from './schemas/vouchers.js';
import { buildAnchorsFromFields } from './bindingProposal.js';
import {
  parseSelfPartyNames,
  resolveSelfSide,
  moneyDirectionFor,
  goodsDirectionFor,
  invoiceDirectionFor,
  type FlowDirection,
} from '../domain/flowDirection.js';
import { env } from '../env.js';

export interface MaterializeInput {
  documentId: string;
  contractNo: string;
  bindingId: string;
  confidence: number;
  createdBy: string;
}

/** docType -> 执行流水流族。白名单外不物化(提单/装箱单/质检等未来扩展)。 */
const FLOW_TYPE_BY_DOC_TYPE: Record<string, string> = {
  付款凭证: '资金流',
  货转单: '货物流',
  发票: '发票流',
};

/** 抽取行 fields({value, sourceSpans} 包装) -> extractAnchors 需要的裸值映射。 */
function unwrapFieldValues(
  fields: Record<string, { value: string | number; sourceSpans: unknown[] }>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) out[k] = v.value;
  return out;
}

/**
 * 物化一条执行流水。安静旁路: 返回 null 表示本次不物化(无抽取/白名单外/方向未知),
 * 绝不抛错。selfPartyNames 可注入(测试用), 缺省读 env.SELF_PARTY_NAMES。
 */
export async function materializeExecutionFlow(
  ctx: DbContext,
  input: MaterializeInput,
  userId?: string,
  selfPartyNames?: string[],
): Promise<string | null> {
  const extraction = await loadLatestExtractionByDocId(ctx, input.documentId, userId);
  if (!extraction) return null;

  const flowType = FLOW_TYPE_BY_DOC_TYPE[extraction.docType];
  if (!flowType) return null;

  // 锚点: 图片凭证(付款凭证/货转单)走 extractAnchors; 发票(通用文档)走
  // buildAnchorsFromFields。白名单过滤后此处 docType 只会是两类图片凭证之一。
  const anchors =
    extraction.docType === '发票'
      ? buildAnchorsFromFields(extraction.docType, extraction.fields)
      : extractAnchors(extraction.docType as VoucherType, unwrapFieldValues(extraction.fields));

  const names = selfPartyNames ?? parseSelfPartyNames(env.SELF_PARTY_NAMES);
  const side = resolveSelfSide(names, anchors);
  if (!side) {
    // 名单未配置 / 两侧未命中 / 双侧命中: 方向未知, 安静跳过, 不猜测。
    console.debug('[executionFlow] 方向无法判定, 跳过物化:', input.contractNo, input.documentId);
    return null;
  }

  let direction: FlowDirection;
  if (flowType === '资金流') direction = moneyDirectionFor(side);
  else if (flowType === '货物流') direction = goodsDirectionFor(side);
  else direction = invoiceDirectionFor(side);

  return upsertExecutionFlow(
    ctx,
    {
      bindingId: input.bindingId,
      documentId: input.documentId,
      contractNo: input.contractNo,
      flowType,
      direction,
      amount: anchors.amount ?? null,
      quantityTon: anchors.quantityTon ?? null,
      docType: extraction.docType,
      voucherDate: anchors.date ?? null,
      confidence: input.confidence,
      createdBy: input.createdBy,
    },
    userId,
  );
}

/** 解绑/拒绝时撤销该 binding 的执行流水(转调存储层)。 */
export async function retractExecutionFlow(
  ctx: DbContext,
  bindingId: string,
  userId?: string,
): Promise<boolean> {
  return retractExecutionFlowForBinding(ctx, bindingId, userId);
}

/** buildQueryExecutionFlowsTool 的最小依赖面(照 documentEntry ToolDeps 只取 ctx/userId)。 */
export interface QueryFlowsToolDeps {
  ctx: DbContext;
  userId?: string;
}

/**
 * query_execution_flows — L1 只读工具。
 * 查询某合同的执行流水六向汇总(收款/付款/收货/发货/收票/开票)与逐笔明细,
 * 每笔可回溯凭证文档(bindingId/documentId)。只读, 不加 needsApproval。
 */
export function buildQueryExecutionFlowsTool(deps: QueryFlowsToolDeps) {
  return tool({
    description:
      '查询某合同的执行流水六向汇总(收款/付款/收货/发货/收票/开票)与逐笔明细, 每笔可回溯凭证文档。' +
      '用途: 用户问"这个合同收/付了多少钱""货发了多少""开了多少票"时调用, 输出按流向汇总的' +
      '执行情况与每笔流水的凭证出处。',
    inputSchema: z.object({
      contractNo: z.string().min(1).describe('合同号(台账规范化后的 CJXC-... 形式)'),
    }),
    execute: async ({ contractNo }) => {
      const [summaries, flows] = await Promise.all([
        summarizeExecutionFlows(deps.ctx, contractNo, deps.userId),
        listExecutionFlows(deps.ctx, contractNo, deps.userId),
      ]);
      return {
        contractNo,
        summaries,
        flows: flows.map((f) => ({
          flowId: f.id,
          bindingId: f.bindingId,
          documentId: f.documentId,
          flowType: f.flowType,
          direction: f.direction,
          amount: f.amount,
          quantityTon: f.quantityTon,
          voucherDate: f.voucherDate,
          docType: f.docType,
        })),
      };
    },
  });
}
