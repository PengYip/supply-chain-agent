import { tool } from 'ai';
import { z } from 'zod';
import type { DbContext } from '../pipeline/db/client.js';
import {
  findContractLedgerByNo,
  listExecutionFlows,
  summarizeExecutionFlows,
  type ExecutionFlowDirection,
} from '../pipeline/db/repositories.js';
import { rollupProject } from '../pipeline/projectRollup.js';

// NOTE: AI SDK 6 renamed the tool schema field `parameters` -> `inputSchema`
// (v5 used `parameters`). The execute signature is `async (input, options)`.
//
// H4: per-tool audit recording was removed -- every tool call is now wrapped
// centrally by `withAudit` in src/harness/agent.ts (buildGatedTools), so this
// file no longer needs its own recordCall helper or auditRecorder import.

interface QueryToolDeps {
  ctx?: DbContext;
  userId?: string;
}

function parseLedgerNumber(raw: string | number | undefined): number | null {
  if (raw === undefined) return null;
  const value = typeof raw === 'number' ? raw : Number(String(raw).replace(/[,，\s]/g, ''));
  return Number.isFinite(value) ? value : null;
}

function roundDelta(value: number): number {
  return Number(value.toFixed(4));
}

// ---- query_contract ---------------------------------------------------------
// DB-only: contract_ledger 命中返回 source=ledger；未命中返回 notFound。

const contractSchema = z.object({
  contractNo: z.string().describe('合同号，如 HT-2024-001'),
});

export function buildQueryContractTool(deps?: { ctx?: DbContext; userId?: string }) {
  return tool({
    description:
      '按合同号查询合同台账中的基本信息、金额、状态、对方客商。数据来自录入文档抽取回写的 contract_ledger；未命中时如实返回 notFound。',
    inputSchema: contractSchema,
    execute: async ({ contractNo }) => {
      // Ledger-first: 录入的合同经抽取回写后在此可查, 解决"录入后查不到台账"。
      if (!deps?.ctx) return { notConfigured: true as const };
      const entry = await findContractLedgerByNo(deps.ctx, contractNo, deps.userId);
      if (entry) {
        const fields: Record<string, string | number> = {};
        for (const [name, f] of Object.entries(entry.fields)) {
          fields[name] = f.value;
        }
        return {
          source: 'ledger' as const,
          contractNo: entry.displayContractNo,
          docType: entry.docType,
          title: entry.title,
          documentId: entry.documentId,
          fields,
          overallConfidence: entry.overallConfidence,
          needsReview: entry.needsReview,
        };
      }
      return { notFound: true as const, contractNo };
    },
  });
}

// ---- project_rollup ----------------------------------------------------------
//
// 项目维度统计(spec 2026-08-20 §5): L1 只读, rollupProject 只读关系库
// (memberships + 台账 + 执行流水), 报表不依赖图。不传 deps.ctx -> notConfigured
// (与 buildQueryContractTool 的 builder 模式一致, 但无 seed 回退 —— 统计必须有库)。

const projectRollupSchema = z.object({
  projectCode: z.string().min(1).describe('项目编号，如 PRJ-2026-001'),
});

export function buildProjectRollupTool(deps?: { ctx?: DbContext; userId?: string }) {
  return tool({
    description:
      '按项目编号汇总该项目的销售/采购/费用合同金额、毛差、应收应付未清、六向执行流水(资金/货物/发票 x 进/出)与校验提示。用于"这个项目赚了多少/还差多少发票/项目概况"等报表类问题。',
    inputSchema: projectRollupSchema,
    execute: async ({ projectCode }) => {
      if (!deps?.ctx) return { notConfigured: true as const };
      const rollup = await rollupProject(deps.ctx, projectCode, deps.userId);
      if (!rollup) return { notFound: true as const, projectCode };
      return {
        project: rollup.project,
        contractCount: rollup.contracts.length,
        pendingCount: rollup.pendingMemberships.length,
        contracts: rollup.contracts.map((x) => ({
          contractNo: x.displayContractNo, role: x.role, counterparty: x.counterparty, amount: x.amount,
        })),
        flows: rollup.flows,
        metrics: rollup.metrics,
        checks: rollup.checks,
      };
    },
  });
}

// ---- query_orders -----------------------------------------------------------
// 系统没有 orders 表。保守口径：以 contract_ledger 确认合同存在，再把已确认绑定
// 物化出的 execution_flows 聚合成合同级执行视图；不虚构订单行。发票覆盖用
// “货物流 documentId 是否也存在发票流”识别，供缺票凭证排查。

const ordersSchema = z.object({
  contractNo: z.string().describe('合同号'),
});

export function buildQueryOrdersTool(deps?: QueryToolDeps) {
  return tool({
    description:
      '按合同号查询执行状态视图。系统没有订单表；结果由已确认绑定物化的 execution_flows 聚合，包含货物进出量、发票向流水、资金流、凭证绑定数，并识别有货物流但无同凭证发票流的单据。用于订单/执行/缺票类问题的合同级排查。',
    inputSchema: ordersSchema,
    execute: async ({ contractNo }) => {
      if (!deps?.ctx) return { notConfigured: true as const };
      const contract = await findContractLedgerByNo(deps.ctx, contractNo, deps.userId);
      if (!contract) return { notFound: true as const, contractNo };

      const [summaries, flows] = await Promise.all([
        summarizeExecutionFlows(deps.ctx, contract.contractNo, deps.userId),
        listExecutionFlows(deps.ctx, contract.contractNo, deps.userId),
      ]);
      const goodsRows = flows.filter((f) => f.flowType === '货物流');
      const invoiceRows = flows.filter((f) => f.flowType === '发票流');
      const invoiceDocumentIds = new Set(
        invoiceRows.map((f) => f.documentId),
      );
      const quantityByDirection = (direction: ExecutionFlowDirection) =>
        goodsRows.filter((f) => f.direction === direction)
          .reduce((sum, f) => sum + (f.quantityTon ?? 0), 0);
      const goodsUnits = new Set(goodsRows.map((f) => f.unit).filter((u): u is string => !!u));
      const invoiceSummary = (direction: ExecutionFlowDirection) =>
        summaries.find((s) => s.flowType === '发票流' && s.direction === direction) ?? null;

      return {
        contractNo: contract.displayContractNo,
        source: 'execution_flows' as const,
        granularity: 'contract-materialized-flows' as const,
        materializedBindingCount: new Set(flows.map((f) => f.bindingId)).size,
        flowSummaries: summaries,
        goods: {
          receivedQuantity: quantityByDirection('in'),
          shippedQuantity: quantityByDirection('out'),
          unit: goodsUnits.size === 1 ? [...goodsUnits][0]! : null,
          unknownUnitEntryCount: goodsRows.filter((f) => !f.unit).length,
          documents: goodsRows.map((f) => ({
            documentId: f.documentId,
            bindingId: f.bindingId,
            direction: f.direction,
            quantity: f.quantityTon,
            unit: f.unit,
            voucherDate: f.voucherDate,
            hasInvoiceFlow: invoiceDocumentIds.has(f.documentId),
          })),
        },
        invoices: {
          received: invoiceSummary('in'),
          issued: invoiceSummary('out'),
          documents: invoiceRows.map((f) => ({
            documentId: f.documentId,
            bindingId: f.bindingId,
            direction: f.direction,
            amount: f.amount,
            voucherDate: f.voucherDate,
          })),
        },
        missingInvoiceDocumentIds: goodsRows
          .map((f) => f.documentId)
          .filter((documentId) => !invoiceDocumentIds.has(documentId)),
      };
    },
  });
}

// ---- cross_check ------------------------------------------------------------

const crossCheckSchema = z.object({
  contractNo: z.string().describe('合同号'),
});

export function buildCrossCheckTool(deps?: QueryToolDeps) {
  return tool({
    description:
      '对账核对：比较合同台账(contract_ledger)金额/数量与已确认绑定物化的 execution_flows 同向汇总，输出差异、差异率与是否超过 0.5% 阈值。数量单位不明确时会标记 unit_ambiguous，不把未知单位当作确定差异。',
    inputSchema: crossCheckSchema,
    execute: async ({ contractNo }) => {
      if (!deps?.ctx) return { notConfigured: true as const };
      const contract = await findContractLedgerByNo(deps.ctx, contractNo, deps.userId);
      if (!contract) return { notFound: true as const, contractNo };

      const [summaries, flows] = await Promise.all([
        summarizeExecutionFlows(deps.ctx, contract.contractNo, deps.userId),
        listExecutionFlows(deps.ctx, contract.contractNo, deps.userId),
      ]);
      const expectedDirection = contract.contractType === '采购'
        ? 'in'
        : contract.contractType === '销售'
          ? 'out'
          : null;
      const amountSummary = expectedDirection
        ? summaries.find((s) => s.flowType === '发票流' && s.direction === expectedDirection)
        : undefined;
      const quantityRows = expectedDirection
        ? flows.filter((f) => f.flowType === '货物流' && f.direction === expectedDirection)
        : [];
      const flowQuantity = quantityRows.some((f) => f.quantityTon !== null)
        ? quantityRows.reduce((sum, f) => sum + (f.quantityTon ?? 0), 0)
        : null;
      const quantityUnits = new Set(quantityRows.map((f) => f.unit).filter((u): u is string => !!u));
      const ledgerUnitRaw = contract.fields['单位']?.value;
      const ledgerUnit = ledgerUnitRaw === undefined ? null : String(ledgerUnitRaw);
      const unitConsistent =
        quantityUnits.size === 1 && (ledgerUnit === null || ledgerUnit === [...quantityUnits][0]);
      const threshold = 0.005;

      const buildCheck = (args: {
        metric: 'amount' | 'quantity';
        ledgerValue: number | null;
        flowValue: number | null;
        unitConsistent?: boolean;
      }) => {
        const common = {
          metric: args.metric,
          ledgerValue: args.ledgerValue,
          flowValue: args.flowValue,
          flowDirection: expectedDirection,
        };
        if (expectedDirection === null) {
          return { ...common, status: 'direction_unknown' as const, diff: null, diffRatio: null, hasAnomaly: false };
        }
        if (args.ledgerValue === null) {
          return { ...common, status: 'ledger_value_missing' as const, diff: null, diffRatio: null, hasAnomaly: false };
        }
        if (args.flowValue === null) {
          return { ...common, status: 'flow_value_missing' as const, diff: null, diffRatio: null, hasAnomaly: false };
        }
        if (args.unitConsistent === false) {
          return { ...common, status: 'unit_ambiguous' as const, diff: null, diffRatio: null, hasAnomaly: false };
        }
        const diff = args.flowValue - args.ledgerValue;
        const diffRatio = roundDelta(args.ledgerValue === 0 ? 0 : diff / args.ledgerValue);
        return {
          ...common,
          status: 'complete' as const,
          diff,
          diffRatio,
          hasAnomaly: Math.abs(diffRatio) > threshold,
        };
      };

      const ledgerAmount = parseLedgerNumber(contract.fields['金额']?.value);
      const ledgerQuantity = parseLedgerNumber(contract.fields['数量']?.value);
      const checks = [
        buildCheck({
          metric: 'amount',
          ledgerValue: ledgerAmount,
          flowValue: amountSummary?.totalAmount ?? null,
        }),
        buildCheck({
          metric: 'quantity',
          ledgerValue: ledgerQuantity,
          flowValue: flowQuantity,
          unitConsistent,
        }),
      ];

      return {
        contractNo: contract.displayContractNo,
        source: { ledger: 'contract_ledger', flows: 'execution_flows' } as const,
        contractType: contract.contractType,
        expectedDirection,
        ledger: { amount: ledgerAmount, quantity: ledgerQuantity, unit: ledgerUnit },
        flowSummaries: summaries,
        checks,
        threshold,
        hasAnomaly: checks.some((check) => check.hasAnomaly),
      };
    },
  });
}
