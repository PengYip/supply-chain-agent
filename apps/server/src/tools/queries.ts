import { tool } from 'ai';
import { z } from 'zod';
import {
  findContract,
  findOrdersByContract,
  type Contract,
  type Order,
} from '../data/seed.js';
import type { DbContext } from '../pipeline/db/client.js';
import { findContractLedgerByNo } from '../pipeline/db/repositories.js';

// NOTE: AI SDK 6 renamed the tool schema field `parameters` -> `inputSchema`
// (v5 used `parameters`). The execute signature is `async (input, options)`.
//
// H4: per-tool audit recording was removed -- every tool call is now wrapped
// centrally by `withAudit` in src/harness/agent.ts (buildGatedTools), so this
// file no longer needs its own recordCall helper or auditRecorder import.

// ---- query_contract ---------------------------------------------------------
//
// 接线闭环: query_contract 现在是台账优先的 builder。当传入 DbContext 时, 先查
// 合同台账(contract_ledger, 由录入文档抽取成功回写), 命中返回 source=ledger;
// 未命中回退演示种子合同(source=seed)。不传 ctx 时纯 seed 行为(旧测试兼容)。

const contractSchema = z.object({
  contractNo: z.string().describe('合同号，如 HT-2024-001'),
});

export function buildQueryContractTool(deps?: { ctx?: DbContext; userId?: string }) {
  return tool({
    description:
      '按合同号查询合同基本信息、金额、状态、对方客商。可查到录入文档抽取回写的合同(source=ledger)与演示种子合同(source=seed)。用于任何关于具体合同的问题。',
    inputSchema: contractSchema,
    execute: async ({ contractNo }) => {
      // Ledger-first: 录入的合同经抽取回写后在此可查, 解决"录入后查不到台账"。
      if (deps?.ctx) {
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
      }
      const contract: Contract | undefined = findContract(contractNo);
      const result = contract
        ? { ...contract, source: 'seed' as const }
        : { notFound: true as const, contractNo };
      return result;
    },
  });
}

// 无 ctx = 纯 seed 行为, 兼容旧测试(不触 DB)。
export const queryContract = buildQueryContractTool();

// ---- query_orders -----------------------------------------------------------

const ordersSchema = z.object({
  contractNo: z.string().describe('合同号'),
});

export const queryOrders = tool({
  description:
    '查询某合同号下的所有订单及执行状态、发货、发票情况（含是否缺发票号）。',
  inputSchema: ordersSchema,
  execute: async ({ contractNo }) => {
    const contract = findContract(contractNo);
    const list: Order[] = contract ? findOrdersByContract(contractNo) : [];
    const result = contract
      ? { contractNo: contract.contractNo, count: list.length, orders: list }
      : { notFound: true, contractNo, count: 0, orders: list };
    return result;
  },
});

// ---- cross_check ------------------------------------------------------------

const crossCheckSchema = z.object({
  contractNo: z.string().describe('合同号'),
});

export const crossCheck = tool({
  description:
    '对账核对：对比我方账面与对方回执的数量差异。用于对账场景，判断差异是否超阈值。',
  inputSchema: crossCheckSchema,
  execute: async ({ contractNo }) => {
    const contract = findContract(contractNo);
    if (!contract) {
      const result = { notFound: true, contractNo };
      return result;
    }
    const list = findOrdersByContract(contractNo);
    const ourVolume = list.reduce((sum, o) => sum + o.shippedQuantity, 0);
    // Buyer-confirmed volume from the receipt system (seed value).
    const theirVolume = 793;
    const diff = ourVolume - theirVolume;
    const ratio = ourVolume === 0 ? 0 : diff / ourVolume;
    const threshold = 0.005; // 0.5%
    const result = {
      contractNo: contract.contractNo,
      ourVolume,
      theirVolume,
      diff,
      diffRatio: Number(ratio.toFixed(4)),
      threshold,
      hasAnomaly: Math.abs(ratio) > threshold,
      unit: contract.unit,
    };
    return result;
  },
});
