// 项目维度统计汇总(spec 2026-08-20 §5)。纯读: memberships(SSOT) + 合同台账 +
// 执行流水 -> 单项目口径的合同面/六向流水/指标/校验。不查 Neo4j —— 报表不依赖图。
import {
  findProjectByCode, findContractLedgerByNo, listMembershipsByProject,
  summarizeExecutionFlows, listExecutionFlows, normalizeProjectCode,
  type ProjectMembershipRow, type ExecutionFlowSummary, type ExecutionFlowRow,
} from './db/repositories.js';
import { computeExecutionProgress, type ExecutionProgress } from './executionProgress.js';
import { getEffectiveSelfPartyNames } from './executionFlow.js';
import { resolveSelfSide } from '../domain/flowDirection.js';
import type { ContractLedgerEntry } from './contractLedger.js';
import type { DbContext } from './db/client.js';

export interface RollupContract {
  contractNo: string;
  displayContractNo: string;
  role: string;              // 合同类型
  title: string | null;
  amount: number | null;
  currency: string | null;
  counterparty: string | null;
  /** 合同面执行块(spec 2026-08-27 台账整合): 六向汇总 + 数量口径进度 + 逐笔笔数。 */
  execution: ContractExecution;
}

/** 单合同执行块: summaries 只含本合同(形状同 /api/bindings/flows); progress 复用
 *  computeExecutionProgress(基准=台账 数量+单位, 量纲不一致如实降级)。 */
export interface ContractExecution {
  summaries: ExecutionFlowSummary[];
  progress: ExecutionProgress;
  flowCount: number;
}

export interface RollupFlows {
  资金流: { in: number; out: number };
  发票流: { in: number; out: number };
  货物流: { inTon: number; outTon: number };
}

export interface RollupCheck { level: 'warn' | 'info'; code: string; message: string }

export interface ProjectRollup {
  project: { code: string; name: string };
  contracts: RollupContract[];
  pendingMemberships: Array<{ contractNo: string; role: string | null }>;
  flows: RollupFlows;
  metrics: {
    salesAmount: number; purchaseAmount: number; expenseAmount: number;
    grossMargin: number;
    receivableOpen: number;
    payableOpen: number;
  };
  checks: RollupCheck[];
}

const EXPENSE_ROLES = new Set(['物流', '租赁', '服务']);

function parseAmount(raw: string | number | undefined): number | null {
  if (raw === undefined) return null;
  const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/[,，\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function counterpartyOf(entry: ContractLedgerEntry | null | undefined, selfNames: string[]): string | null {
  if (!entry) return null;
  const buyer = String(entry.fields['买方']?.value ?? entry.fields['甲方']?.value ?? '').trim();
  const seller = String(entry.fields['卖方']?.value ?? entry.fields['乙方']?.value ?? '').trim();
  if (!buyer || !seller) return null;
  const side = resolveSelfSide(selfNames, { buyer, seller });
  if (!side) return null;
  return side === 'buyer' ? seller : buyer;
}

export function buildRollup(args: {
  project: { code: string; name: string };
  memberships: ProjectMembershipRow[];
  ledgers: Map<string, ContractLedgerEntry | null>;
  flowSummaries: ExecutionFlowSummary[];
  /** 每合同流水行(计算数量口径进度); 空数组 = 无流水。 */
  flowRows: Map<string, ExecutionFlowRow[]>;
  selfPartyNames: string[];
}): ProjectRollup {
  const checks: RollupCheck[] = [];
  const contracts: RollupContract[] = [];
  const pendingMemberships: Array<{ contractNo: string; role: string | null }> = [];

  let salesAmount = 0;
  let purchaseAmount = 0;
  let expenseAmount = 0;

  for (const m of args.memberships) {
    if (m.status !== 'confirmed') {
      if (m.status === 'proposed') pendingMemberships.push({ contractNo: m.contractNo, role: m.role });
      continue;
    }
    const entry = args.ledgers.get(m.contractNo) ?? null;
    const amount = parseAmount(entry?.fields['金额']?.value);
    const currencyRaw = entry?.fields['币种']?.value;
    const flowRows = args.flowRows.get(m.contractNo) ?? [];
    contracts.push({
      contractNo: m.contractNo,
      displayContractNo: entry?.displayContractNo ?? m.contractNo,
      role: m.role ?? '未分类',
      title: entry?.title ?? null,
      amount,
      currency: currencyRaw === undefined ? null : String(currencyRaw),
      counterparty: counterpartyOf(entry, args.selfPartyNames),
      execution: {
        summaries: args.flowSummaries.filter((s) => s.contractNo === m.contractNo),
        progress: computeExecutionProgress(flowRows, entry?.fields ?? null),
        flowCount: flowRows.length,
      },
    });
    if (amount === null) {
      checks.push({ level: 'warn', code: 'amount_missing', message: `合同 ${m.contractNo} 无台账金额${entry ? '(金额字段缺失)' : '(台账缺失)'}` });
    } else if (m.role === '采购') {
      purchaseAmount += amount;
    } else if (m.role === '销售') {
      salesAmount += amount;
    } else if (EXPENSE_ROLES.has(m.role ?? '')) {
      expenseAmount += amount;
    }
  }

  // 六向流水聚合: 资金流/发票流按 totalAmount, 货物流按 totalQuantityTon。
  const flows: RollupFlows = {
    资金流: { in: 0, out: 0 },
    发票流: { in: 0, out: 0 },
    货物流: { inTon: 0, outTon: 0 },
  };
  const roleByContractNo = new Map(args.memberships.filter((m) => m.status === 'confirmed').map((m) => [m.contractNo, m.role ?? '']));
  for (const s of args.flowSummaries) {
    if (s.flowType === '资金流' || s.flowType === '发票流') {
      const bucket = flows[s.flowType];
      if (s.direction === 'in') bucket.in += s.totalAmount ?? 0;
      else bucket.out += s.totalAmount ?? 0;
    } else if (s.flowType === '货物流') {
      if (s.direction === 'in') flows.货物流.inTon += s.totalQuantityTon ?? 0;
      else flows.货物流.outTon += s.totalQuantityTon ?? 0;
    }
    // 类型-方向交叉校验
    const role = roleByContractNo.get(s.contractNo);
    if (s.flowType === '发票流' && (s.totalAmount ?? 0) > 0) {
      if (role === '销售' && s.direction === 'in') {
        checks.push({ level: 'warn', code: 'type_direction_mismatch', message: `销售合同 ${s.contractNo} 收到进项发票 ${s.totalAmount}` });
      } else if (role === '采购' && s.direction === 'out') {
        checks.push({ level: 'warn', code: 'type_direction_mismatch', message: `采购合同 ${s.contractNo} 开出销项发票 ${s.totalAmount}` });
      }
    }
  }
  const qtyNet = flows.货物流.inTon - flows.货物流.outTon;
  if (Math.abs(qtyNet) > 0.01) {
    checks.push({ level: 'info', code: 'qty_gap', message: `货物流净量未平: ${qtyNet > 0 ? '+' : ''}${qtyNet.toFixed(2)} 吨` });
  }

  const metrics = {
    salesAmount,
    purchaseAmount,
    expenseAmount,
    grossMargin: salesAmount - purchaseAmount - expenseAmount,
    receivableOpen: salesAmount - flows.发票流.out - flows.资金流.in,
    payableOpen: purchaseAmount - flows.发票流.in - flows.资金流.out,
  };
  return { project: args.project, contracts, pendingMemberships, flows, metrics, checks };
}

export async function rollupProject(
  ctx: DbContext,
  code: string,
  userId?: string,
): Promise<ProjectRollup | null> {
  const project = await findProjectByCode(ctx, normalizeProjectCode(code), userId);
  if (!project) return null;
  const memberships = await listMembershipsByProject(ctx, project.code, userId);
  const ledgers = new Map<string, ContractLedgerEntry | null>();
  const flowSummaries: ExecutionFlowSummary[] = [];
  const flowRows = new Map<string, ExecutionFlowRow[]>();
  for (const m of memberships) {
    if (m.status !== 'confirmed') continue;
    ledgers.set(m.contractNo, await findContractLedgerByNo(ctx, m.contractNo, userId));
    flowRows.set(m.contractNo, await listExecutionFlows(ctx, m.contractNo, userId));
    flowSummaries.push(...(await summarizeExecutionFlows(ctx, m.contractNo, userId)));
  }
  return buildRollup({
    project: { code: project.code, name: project.name },
    memberships,
    ledgers,
    flowSummaries,
    flowRows,
    selfPartyNames: await getEffectiveSelfPartyNames(ctx),
  });
}
