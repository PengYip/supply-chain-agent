import { tool } from 'ai';
import { z } from 'zod';
import {
  findContract,
  findOrdersByContract,
  type Contract,
  type Order,
} from '../data/seed.js';
import type { DbContext } from '../pipeline/db/client.js';
import {
  findContractLedgerByNo,
  listContractLedgerEntries,
} from '../pipeline/db/repositories.js';
import { rollupProject } from '../pipeline/projectRollup.js';

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
//
// 枚举模式(2026-08-25): 不带 contractNo 调用 -> 返回台账全部合同的摘要列表。
// 动机: "系统里都录入了哪些合同"是枚举聚合语义, recall_documents/graph_* 这类
// 相关性检索给不出"找全"的保证; 台账才是合同的 SSOT, 直接在这里收敛。
// 截断显式声明(超过 LIMIT 条时返回 truncated 标记), 不静默丢弃。

const ENUMERATE_LIMIT = 50;

const contractSchema = z.object({
  contractNo: z
    .string()
    .optional()
    .describe(
      '合同号，如 HT-2024-001。传入=点查该合同详情；不传=枚举台账中全部合同的摘要列表',
    ),
});

export function buildQueryContractTool(deps?: { ctx?: DbContext; userId?: string }) {
  return tool({
    description:
      '查询合同信息，两种模式：传 contractNo 按号点查该合同的基本信息、金额、状态、对方客商（台账优先 source=ledger，未命中回退演示种子 source=seed）；不传 contractNo 则枚举台账中全部合同的摘要列表（编号/类型/标题/来源文档）。用于"系统里都录入了哪些合同/盘点一下合同"等枚举类问题必须用枚举模式，不要用 recall_documents 反复检索；找合同相关原文片段才用 recall_documents。',
    inputSchema: contractSchema,
    execute: async ({ contractNo }) => {
      // 枚举模式: 不带合同号 -> 台账全量摘要(按 updated_at DESC)。
      if (!contractNo) {
        if (!deps?.ctx) {
          return { notConfigured: true as const, reason: 'enumerate mode requires DB context' };
        }
        const entries = await listContractLedgerEntries(deps.ctx, deps.userId);
        const truncated = entries.length > ENUMERATE_LIMIT;
        const shown = entries.slice(0, ENUMERATE_LIMIT);
        return {
          source: 'ledger' as const,
          mode: 'enumerate' as const,
          count: shown.length,
          totalInLedger: entries.length,
          ...(truncated
            ? {
                truncated: true as const,
                note: `仅返回前 ${ENUMERATE_LIMIT} 条(按更新时间倒序)，请让用户缩小范围`,
              }
            : {}),
          contracts: shown.map((e) => ({
            contractNo: e.displayContractNo,
            docType: e.docType,
            title: e.title,
            documentId: e.documentId,
            overallConfidence: e.overallConfidence,
            needsReview: e.needsReview,
          })),
        };
      }
      // 点查模式: Ledger-first, 录入的合同经抽取回写后在此可查。
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
