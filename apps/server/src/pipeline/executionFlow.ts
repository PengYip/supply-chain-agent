// 执行流水物化(executionFlow): 绑定确认时的旁路 byproduct。
//
// 一条 binding 变为 confirmed(人工确认 / auto_rule 自动确认 / 手动创建 / agent 确认)
// 时, 用该凭证的最新抽取行物化一条"执行流水"落库。六向(收款/付款/收货/发货/收票/开票)
// 的方向语义按三级链判定(spec 2026-08-27 §5): 主体锚点(买/卖方命中自主主体名单,
// env.SELF_PARTY_NAMES ∪ self_parties) -> 合同类型兜底(台账 contract_type) ->
// 方向编码类型自带方向; 全判不出则安静跳过, 不猜测。
//
// 白名单(spec §6): 资金流=付款凭证; 货物流=货转单/收货单/发货单/汽运磅单/火运大票/
// 派船通知单; 发票流=发票/进项票/销项票; 其余(合同/立项书/化验报告/付款单/结算单/
// 提单/装箱单/其他)返回 null 不物化——付款单是申请非支付证据, 结算单为合同级汇总,
// 语义待定; 提单/装箱单待 Phase 2 并入类型树后再接。
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
  retractExecutionFlowsForDocument,
  listConfirmedBindingsForDocument,
  summarizeExecutionFlows,
  listExecutionFlows,
  listSelfParties,
  type ExtractionRow,
} from './db/repositories.js';
import { anchorsForExtraction } from './bindingProposal.js';
import type { VoucherAnchors } from './schemas/vouchers.js';
import { computeExecutionProgress } from './executionProgress.js';
import {
  FLOW_ADAPTERS,
  CONTRACT_TYPE_FLOW_DIRECTION,
  type FlowFamily,
} from '../domain/tradeSemantics.js';
import { findContractLedgerByNo } from './db/repositories.js';
import {
  parseSelfPartyNames,
  normalizeCompanyName,
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

/**
 * 物化成功时的流信息投影(spec 2026-08-25 方案A §3.3): settles 边同步据此派生
 * 六向 relation(flowType x direction), amount 随边落 props。null = 未物化。
 */
export interface MaterializedFlow {
  flowId: string;
  flowType: string;
  direction: FlowDirection;
  amount: number | null;
}

/** 图片凭证(封闭 schema, extractAnchors 路径)的流族映射。
 *  化验报告(质检)非六向履约动作, 不物化。 */
const IMAGE_VOUCHER_FLOW_TYPE: Record<string, string> = {
  付款凭证: '资金流',
  货转单: '货物流',
};

/**
 * docType -> 流族(spec 2026-08-27 §6): 图片凭证映射 + 适配表(flowFamily)。
 * 白名单外(合同/立项书/化验报告/付款单/结算单/提单/装箱单/其他)返回 undefined 不物化。
 */
export function flowTypeFor(docType: string): string | undefined {
  return IMAGE_VOUCHER_FLOW_TYPE[docType] ?? FLOW_ADAPTERS[docType]?.flowFamily;
}

/**
 * 有效自主体名单: DB 侧(self_parties)与 env.SELF_PARTY_NAMES 的并集, 按
 * 归一化形式去重。返回归一化列表(resolveSelfSide 期望归一化输入)。env 退化为
 * 引导通道: DB 名单为空时 env 仍生效, 两者可同时存在。
 */
export async function getEffectiveSelfPartyNames(ctx: DbContext): Promise<string[]> {
  const rows = await listSelfParties(ctx);
  const envNames = parseSelfPartyNames(env.SELF_PARTY_NAMES);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of envNames) {
    if (n && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  for (const r of rows) {
    const n = normalizeCompanyName(r.name);
    if (n && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

/**
 * 方向三级判定(spec 2026-08-27 §5): 主体锚点 -> 合同类型兜底 -> 类型自带方向。
 * 全部判不出返回 null(宁可空缺不猜)。
 */
async function resolveFlowDirection(
  ctx: DbContext,
  args: {
    docType: string;
    flowFamily: string;
    anchors: VoucherAnchors;
    contractNo: string;
    userId?: string;
    selfPartyNames: string[];
  },
): Promise<FlowDirection | null> {
  // 第 1 级: 主体锚点(最具体证据, 命中即用, 不被类型语义覆盖)。
  const side = resolveSelfSide(args.selfPartyNames, args.anchors);
  if (side) {
    if (args.flowFamily === '资金流') return moneyDirectionFor(side);
    if (args.flowFamily === '货物流') return goodsDirectionFor(side);
    return invoiceDirectionFor(side);
  }
  // 第 2 级: 合同类型兜底(采购: 货物收/资金付/发票收; 销售: 反向)。
  let contractType: string | null | undefined;
  try {
    contractType = (await findContractLedgerByNo(ctx, args.contractNo, args.userId))?.contractType ?? null;
  } catch {
    contractType = null;
  }
  if (contractType === '采购' || contractType === '销售') {
    return CONTRACT_TYPE_FLOW_DIRECTION[contractType][args.flowFamily as FlowFamily] ?? null;
  }
  // 第 3 级: 方向编码类型自带方向(收货单=in/发货单=out/进项票=in/销项票=out)。
  return FLOW_ADAPTERS[args.docType]?.codedDirection ?? null;
}

/**
 * 物化一条执行流水。安静旁路: 返回 null 表示本次不物化(无抽取/白名单外/方向未知),
 * 绝不抛错。selfPartyNames 可注入(测试用), 缺省取有效名单(getEffectiveSelfPartyNames:
 * DB 名单 ∪ env.SELF_PARTY_NAMES, 归一化去重)。
 */
export async function materializeExecutionFlow(
  ctx: DbContext,
  input: MaterializeInput,
  userId?: string,
  selfPartyNames?: string[],
): Promise<MaterializedFlow | null> {
  const extraction = await loadLatestExtractionByDocId(ctx, input.documentId, userId);
  if (!extraction) return null;

  const flowType = flowTypeFor(extraction.docType);
  if (!flowType) return null;
  // 锚点: 分支假设集中anchorsForExtraction(bindingProposal)——图片凭证(付款凭证/
  // 货转单)走 extractAnchors; 其余适配表类型走字段路径(quantity 带量纲投影)。
  const anchors = anchorsForExtraction(extraction.docType, extraction.fields);

  const names = selfPartyNames ?? (await getEffectiveSelfPartyNames(ctx));
  const direction = await resolveFlowDirection(ctx, {
    docType: extraction.docType,
    flowFamily: flowType,
    anchors,
    contractNo: input.contractNo,
    userId,
    selfPartyNames: names,
  });
  if (!direction) {
    // 三级方向链全判不出: 安静跳过, 不猜测。
    console.debug('[executionFlow] 方向无法判定, 跳过物化:', input.contractNo, input.documentId);
    return null;
  }

  const flowId = await upsertExecutionFlow(
    ctx,
    {
      bindingId: input.bindingId,
      documentId: input.documentId,
      contractNo: input.contractNo,
      flowType,
      direction,
      amount: anchors.amount ?? null,
      quantityTon: anchors.quantityTon ?? null,
      // 数量单位独立建模: '_吨' 后缀字段确定为吨; 裸 '数量' 不带单位语义, 留 null 不猜测。
      unit: anchors.quantityUnit ?? null,
      // 通用物化层(spec 2026-08-27): 数量原值/量纲/规范值; 未知单位留 NULL 不猜测。
      quantityValue: anchors.quantity?.value ?? null,
      quantityDimension: anchors.quantity?.dimension ?? null,
      quantityCanonical: anchors.quantity?.canonical ?? null,
      docType: extraction.docType,
      voucherDate: anchors.date ?? null,
      // 溯源: 这行流水来自哪次抽取(修正重建后指向新行, 审计线索)。
      extractionId: extraction.id,
      confidence: input.confidence,
      createdBy: input.createdBy,
    },
    userId,
  );
  return { flowId, flowType, direction, amount: anchors.amount ?? null };
}

/**
 * 复核修正后的防漂移重建(移植自 CodeX-2): 先撤回该文档名下全部流水行,
 * 再按最新抽取对每条 confirmed 绑定重新物化。抽取字段被人工修正
 * (applyDocumentCorrections)或重抽取后由调用方触发; 白名单外/方向判不出
 * 的绑定重物化自然落空 -> 旧流水被清掉, 流水表始终反映最新抽取, 不漂移。
 * 单条失败仅告警, 不中断其余绑定(旁路语义与物化一致)。
 *
 * F2 跳过原因: 返回 skipped 数组解释"为什么没有物化"(前端据此提示用户,
 * 例如名单双侧命中导致方向判不出)。物化语义不变 —— materializeExecutionFlow
 * 保持安静 null 契约; 原因通过 introspection 计算(单次加载抽取 + 名单,
 * 白名单/方向判定与物化同源), 不把状态穿进 materialize。
 */
export type SkipReason =
  | 'direction-undeterminable'
  | 'not-whitelisted'
  | 'no-confirmed-binding';

export interface RefreshSkipEntry {
  bindingId: string | null;
  contractNo: string | null;
  reason: SkipReason;
}

export interface RefreshResult {
  retracted: number;
  materialized: number;
  skipped: RefreshSkipEntry[];
}

export async function refreshExecutionFlowsForDocument(
  ctx: DbContext,
  documentId: string,
  userId?: string,
  selfPartyNames?: string[],
): Promise<RefreshResult> {
  const retracted = await retractExecutionFlowsForDocument(ctx, documentId, userId);
  const bindings = await listConfirmedBindingsForDocument(ctx, documentId, userId);
  const skipped: RefreshSkipEntry[] = [];
  if (bindings.length === 0) {
    return {
      retracted,
      materialized: 0,
      skipped: [{ bindingId: null, contractNo: null, reason: 'no-confirmed-binding' }],
    };
  }

  // 跳过原因 introspection(不改变物化语义): 单次加载抽取 + 名单, 白名单/方向
  // 判定与 materializeExecutionFlow 同源(三级方向链)。物化内部仍会再加载一次
  // 抽取(双加载可接受, 保持非侵入)。introspection 失败(抽取加载抛错) -> 原因
  // 未知, 不记录跳过原因, 仅按原路径物化。无抽取行 -> 无法确认白名单成员 ->
  // not-whitelisted。
  let extraction: ExtractionRow | null = null;
  let introspectionOk = true;
  try {
    extraction = await loadLatestExtractionByDocId(ctx, documentId, userId);
  } catch {
    introspectionOk = false;
  }
  const names = selfPartyNames ?? (await getEffectiveSelfPartyNames(ctx));
  const flowType = extraction ? flowTypeFor(extraction.docType) : undefined;
  const anchors = extraction
    ? anchorsForExtraction(extraction.docType, extraction.fields)
    : undefined;

  let materialized = 0;
  for (const b of bindings) {
    try {
      if (introspectionOk) {
        if (!flowType) {
          skipped.push({ bindingId: b.id, contractNo: b.contractNo, reason: 'not-whitelisted' });
          continue;
        }
        if (extraction && anchors) {
          const direction = await resolveFlowDirection(ctx, {
            docType: extraction.docType,
            flowFamily: flowType,
            anchors,
            contractNo: b.contractNo,
            userId,
            selfPartyNames: names,
          });
          if (!direction) {
            skipped.push({ bindingId: b.id, contractNo: b.contractNo, reason: 'direction-undeterminable' });
            continue;
          }
        }
      }
      const materializedFlow = await materializeExecutionFlow(
        ctx,
        {
          documentId,
          contractNo: b.contractNo,
          bindingId: b.id,
          confidence: b.confidence,
          createdBy: 'review-refresh',
        },
        userId,
        selfPartyNames,
      );
      if (materializedFlow) materialized += 1;
    } catch (e) {
      console.warn('[executionFlow] 重建流水失败(跳过该绑定):', b.id, (e as Error).message);
    }
  }
  return { retracted, materialized, skipped };
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
      '查询某合同的执行流水六向汇总(收款/付款/收货/发货/收票/开票)与逐笔明细, 每笔可回溯凭证文档; ' +
      '另附 executionProgress 执行进度块(基准=台账合同数量+单位, 量纲不一致时如实说明; ' +
      '同批货的预告凭证(发货单/派船通知单)与实重凭证(轨道衡/磅单/收货单)不重复累计, 取 max(实重, 预告), ' +
      '分层明细在 delivered.nodes).' +
      '用途: 用户问"这个合同收/付了多少钱""货发了多少""开了多少票""合同执行到什么程度"时调用, ' +
      '输出按流向汇总的执行情况与每笔流水的凭证出处。回答"发了多少货/执行进度"以 executionProgress 为准, ' +
      '不要自己把 flows 的数量逐行相加(会双计预告与实重)。',
    inputSchema: z.object({
      contractNo: z.string().min(1).describe('合同号(台账规范化后的 CJXC-... 形式)'),
    }),
    execute: async ({ contractNo }) => {
      const [summaries, flows] = await Promise.all([
        summarizeExecutionFlows(deps.ctx, contractNo, deps.userId),
        listExecutionFlows(deps.ctx, contractNo, deps.userId),
      ]);
      // 执行进度(spec 2026-08-27 §9): 基准=台账合同数量+单位; 量纲不一致如实报 mismatch。
      let ledgerFields: Record<string, { value: string | number }> | null = null;
      try {
        ledgerFields = (await findContractLedgerByNo(deps.ctx, contractNo, deps.userId))?.fields ?? null;
      } catch {
        ledgerFields = null;
      }
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
          unit: f.unit ?? null,
          voucherDate: f.voucherDate,
          docType: f.docType,
          extractionId: f.extractionId ?? null,
        })),
        executionProgress: computeExecutionProgress(flows, ledgerFields),
      };
    },
  });
}
