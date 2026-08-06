import { tool } from 'ai';
import { z } from 'zod';
import {
  findContract,
  findOrdersByContract,
  type Contract,
  type Order,
} from '../data/seed.js';

// NOTE: AI SDK 6 renamed the tool schema field `parameters` -> `inputSchema`
// (v5 used `parameters`). The execute signature is `async (input, options)`.
//
// H4: per-tool audit recording was removed -- every tool call is now wrapped
// centrally by `withAudit` in src/harness/agent.ts (buildGatedTools), so this
// file no longer needs its own recordCall helper or auditRecorder import.

// ---- query_contract ---------------------------------------------------------

const contractSchema = z.object({
  contractNo: z.string().describe('合同号，如 HT-2024-001'),
});

export const queryContract = tool({
  description:
    '按合同号查询合同基本信息、金额、状态、对方客商。用于任何关于具体合同的问题。',
  inputSchema: contractSchema,
  execute: async ({ contractNo }) => {
    const contract: Contract | undefined = findContract(contractNo);
    const result = contract
      ? { ...contract }
      : { notFound: true, contractNo };
    return result;
  },
});

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
