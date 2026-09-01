// 结算引擎工具对(spec 2026-08-27 §15, 用户简化架构):
//   gather_settlement_evidence (L1 只读): 一次取齐合同条款 + 数量流水(节点权威
//     聚合后的进度块) + 质量凭证 + 历史结算, 供模型按合同条款计算结算。
//   confirm_settlement (L2, 注册处 needsApproval: true): 模型把计算结果提交人工
//     确认, 确认通过后落 settlement_records 台账(金额锚点)。
// 分工边界(有意为之): 数值计算由 LLM 完成(用户实测准确), 本模块不做算术、
// 不改写任何提交数字; 确定性保证来自 L2 人工确认 + 凭证溯源 id 落库。
import { tool } from 'ai';
import { z } from 'zod';
import type { DbContext } from '../db/client.js';
import {
  findContractLedgerByNo,
  listExecutionFlows,
  listBindingsForContract,
  loadLatestExtractionByDocId,
  listSettlementRecords,
  insertSettlementRecord,
} from '../db/repositories.js';
import { computeExecutionProgress } from '../executionProgress.js';

export interface SettlementToolDeps {
  ctx: DbContext;
  userId?: string;
}

/** 质量凭证单据类型(化验指标来自这些抽取行)。 */
const QUALITY_DOC_TYPES = new Set(['质检报告', '化验报告']);

function err(message: string) {
  return { status: 'error' as const, error: message };
}

export function buildGatherSettlementEvidenceTool(deps: SettlementToolDeps) {
  return tool({
    description:
      '取齐某合同的结算依据(只读, 计算前的取证步骤)。返回: 合同台账字段(定价/付款条款原文)、' +
      '执行流水(含数量/单据类型/凭证日期)、executionProgress(节点权威聚合后的已交付量, 预告凭证' +
      '与实重凭证不双计)、质量凭证(仅 confirmed 绑定的质检报告/化验报告化验指标; 待确认绑定的单列 pendingQualityDocs)、已确认结算记录。' +
      '什么时候用: 用户要求"算结算/结这个合同的账/出结算单"时, 必须先调用本工具取证, ' +
      '再依据合同条款原文计算, 把结果完整展示给用户确认。' +
      '边界: 本工具不做任何计算, 只给证据; 计算数值必须能在返回的凭证字段中溯源。' +
      '不要跳过本工具直接凭记忆报结算数。',
    inputSchema: z.object({
      contractNo: z.string().min(1).describe('合同号(台账规范化后的形式, 如 CJXC-...)'),
    }),
    execute: async ({ contractNo }) => {
      const { ctx, userId } = deps;
      let ledger: Awaited<ReturnType<typeof findContractLedgerByNo>> = null;
      try {
        ledger = await findContractLedgerByNo(ctx, contractNo, userId);
      } catch {
        ledger = null;
      }
      const flows = await listExecutionFlows(ctx, contractNo, userId);
      const settlements = await listSettlementRecords(ctx, contractNo, userId);
      const bindings = await listBindingsForContract(ctx, contractNo);
      // 结算端硬门槛(2026-09-01): 参与结算计算的质量凭证必须来自 confirmed 绑定
      // (金额锚点不容推断归属); proposed 绑定的质量凭证单列 pendingQualityDocs,
      // 提示先确认绑定再纳入计算。rejected 不参与。
      const confirmedBindings = bindings.filter((b) => b.status === 'confirmed');
      const pendingBindings = bindings.filter((b) => b.status === 'proposed');
      const qualityDocs: Array<{
        documentId: string;
        extractionId: string;
        docType: string;
        fields: Record<string, unknown>;
      }> = [];
      for (const b of confirmedBindings) {
        const ext = await loadLatestExtractionByDocId(ctx, b.documentId, userId);
        if (ext && QUALITY_DOC_TYPES.has(ext.docType)) {
          qualityDocs.push({
            documentId: b.documentId,
            extractionId: ext.id,
            docType: ext.docType,
            fields: ext.fields as Record<string, unknown>,
          });
        }
      }
      const pendingQualityDocs: Array<{ documentId: string; docType: string; confidence: number }> = [];
      for (const b of pendingBindings) {
        const ext = await loadLatestExtractionByDocId(ctx, b.documentId, userId);
        if (ext && QUALITY_DOC_TYPES.has(ext.docType)) {
          pendingQualityDocs.push({
            documentId: b.documentId,
            docType: ext.docType,
            confidence: b.confidence,
          });
        }
      }
      return {
        status: 'ok' as const,
        contractNo,
        contract: ledger
          ? {
              documentId: ledger.documentId,
              displayContractNo: ledger.displayContractNo,
              title: ledger.title,
              contractType: ledger.contractType,
              fields: ledger.fields,
            }
          : null,
        flows: flows.map((f) => ({
          flowId: f.id,
          documentId: f.documentId,
          flowType: f.flowType,
          direction: f.direction,
          quantityTon: f.quantityTon,
          quantityValue: f.quantityValue ?? null,
          quantityDimension: f.quantityDimension ?? null,
          quantityCanonical: f.quantityCanonical ?? null,
          unit: f.unit ?? null,
          docType: f.docType,
          voucherDate: f.voucherDate,
          extractionId: f.extractionId ?? null,
        })),
        executionProgress: computeExecutionProgress(flows, ledger?.fields ?? null),
        qualityDocs,
        pendingQualityDocs,
        settlements,
        usage:
          '结算口径: 数量以 executionProgress.delivered 为准(勿逐行累加 flows, 会双计预告与实重); ' +
          '价格按 contract.fields 中定价/质量条款计算; 每个数字标注来源(流水 id/抽取 id); ' +
          'executionProgress.contributions 为每条流水的计入/排除明细(排除带 excludeReason 原因), ' +
          'executionProgress.transportModes 为计入流水按运输方式(火车/汽车/船舶/其他)的分组(条数/质量合计/计数池/docType 构成), ' +
          '两者可用于向用户解释结算口径(为何这笔计入/那笔排除); ' +
          'qualityDocs 仅含 confirmed 绑定的质量凭证; pendingQualityDocs 非空时必须先提示用户确认绑定(bind_document)再纳入计算; ' +
          '结果先完整展示给用户, 用户确认后才调用 confirm_settlement。',
      };
    },
  });
}

export function buildConfirmSettlementTool(deps: SettlementToolDeps) {
  return tool({
    description:
      '把用户已确认的结算结果写入结算台账(L2 操作: 调用需附带人工授权, 注册处 needsApproval)。' +
      '什么时候用: 已调用 gather_settlement_evidence 取证、按合同条款算出结算、并把完整结果' +
      '(数量/单价/奖罚/总额/依据)展示给用户、用户明确说"确认/没问题/就这样结"之后, 调用一次。' +
      '边界: 不校验算术(数值以你向用户展示并被确认的为准); 不修改已确认记录(修正=确认一条新行); ' +
      '重复调用会产生重复台账行, 一次确认只调用一次; 没有合同台账时拒绝。' +
      '返回: {status, settlementId, record}。',
    inputSchema: z.object({
      contractNo: z.string().min(1).describe('合同号(与取证时一致)'),
      settledQuantity: z.number().finite().describe('结算数量(与向用户展示的数值完全一致, 不做换算)'),
      quantityUnit: z.string().min(1).describe('数量单位, 如 吨'),
      basePrice: z.number().finite().nullable().describe('基准单价(元/单位); 合同未约定价格时给 null'),
      currency: z.string().min(1).nullable().describe('币种, 如 CNY; 未知给 null'),
      totalAmount: z.number().finite().describe('结算总金额'),
      adjustments: z
        .array(z.object({ label: z.string().min(1), amount: z.number().finite() }))
        .max(50)
        .default([])
        .describe('价差/奖罚明细, 如 [{label:"水分扣重", amount:-1234.5}, {label:"硫分奖罚", amount:-200}]'),
      basisFlowIds: z.array(z.string()).max(200).default([]).describe('依据的执行流水 id(取证返回的 flowId)'),
      basisExtractionIds: z.array(z.string()).max(200).default([]).describe('依据的抽取行 id(含化验指标/凭证字段)'),
      notes: z.string().max(2000).nullable().describe('结算口径说明(如"按 3 月轨道衡实重+化验扣水")'),
    }),
    execute: async (input) => {
      const { ctx, userId } = deps;
      let ledger: Awaited<ReturnType<typeof findContractLedgerByNo>> = null;
      try {
        ledger = await findContractLedgerByNo(ctx, input.contractNo, userId);
      } catch {
        ledger = null;
      }
      if (!ledger) return err(`未找到合同台账 ${input.contractNo}; 结算必须挂在已有合同上(先绑定合同并确认)`);

      // 依据可溯性软校验: basisFlowIds 必须属于该合同的流水, 防止跨合同张冠李戴。
      const flows = await listExecutionFlows(ctx, input.contractNo, userId);
      const flowIdSet = new Set(flows.map((f) => f.id));
      const unknownFlowIds = input.basisFlowIds.filter((id) => !flowIdSet.has(id));
      if (unknownFlowIds.length > 0) {
        return err(`basisFlowIds 含非本合同流水: ${unknownFlowIds.join(', ')}(请以 gather_settlement_evidence 返回为准)`);
      }

      const settlementId = await insertSettlementRecord(
        ctx,
        {
          contractNo: input.contractNo,
          contractLedgerId: ledger.documentId,
          settledQuantity: input.settledQuantity,
          quantityUnit: input.quantityUnit,
          basePrice: input.basePrice,
          currency: input.currency,
          totalAmount: input.totalAmount,
          adjustments: input.adjustments,
          basisFlowIds: input.basisFlowIds,
          basisExtractionIds: input.basisExtractionIds,
          notes: input.notes,
          createdBy: 'agent',
        },
        userId,
      );
      return {
        status: 'ok' as const,
        settlementId,
        record: {
          settlementId,
          contractNo: input.contractNo,
          settledQuantity: input.settledQuantity,
          quantityUnit: input.quantityUnit,
          basePrice: input.basePrice,
          totalAmount: input.totalAmount,
          adjustments: input.adjustments,
          status: 'confirmed',
        },
      };
    },
  });
}
