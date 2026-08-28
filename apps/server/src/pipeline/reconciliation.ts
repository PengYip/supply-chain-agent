// 对账桥(spec 2026-08-25 方案A §2/§5): SQL 精确聚合 -> 物化回写。
// R1 数量守恒 / R2 开票收付平衡 / R3 额度占用全部在关系库计算(守恒判定
// 一律以 SQL 为准, 图上聚合仅作展示); 结果落两处:
//   1) quotas.used_amount / computed_at(关系库物化, query_quota_usage 读它)
//   2) 图节点属性(Quota.used / Project.rollup, best-effort, 永不阻塞)
// 与其他 graphSync 同铁律: 图回写失败只 console.warn, 绝不抛出。
import {
  listQuotas, listProjects, listMembershipsByProject,
  listContractLedgerEntries, findContractLedgerByNo,
  updateQuotaUsed, type QuotaRow,
} from './db/repositories.js';
import { rollupProject } from './projectRollup.js';
import { isEmptyValue, firstNonEmpty } from './fieldValue.js';
import { writeQuotaUsageToGraph } from './quotaGraphSync.js';
import { updateNodeProps, findEntities } from '../graph/repo.js';
import { normalizeCompanyName } from '../domain/flowDirection.js';
import type { ContractLedgerEntry } from './contractLedger.js';
import type { DbContext } from './db/client.js';

export interface ReconcileAlert { level: 'warn' | 'info'; code: string; message: string }

export interface QuotaUsageRow {
  quotaId: string;
  scope: 'counterparty' | 'project';
  ownerKey: string;
  ownerLabel: string;
  limitAmount: number;
  currency: string | null;
  period: string | null;
  used: number;
  remaining: number;
  overLimit: boolean;
}

export interface ProjectReconcileRow {
  code: string;
  name: string;
  grossMargin: number;
  quantityGap: number;
  receivableOpen: number;
  payableOpen: number;
  checks: ReconcileAlert[];
}

export interface ReconcileReport {
  generatedAt: string;
  quotas: QuotaUsageRow[];
  projects: ProjectReconcileRow[];
  alerts: ReconcileAlert[];
}

export interface ReconcileGraphIo {
  writeQuotaUsage(i: { quotaId: string; used: number; remaining: number; overLimit: boolean }): Promise<void>;
  writeProjectRollup(i: {
    projectCode: string; grossMargin: number; quantityGap: number;
    receivableOpen: number; payableOpen: number;
  }): Promise<void>;
}

/** 图回写默认实现: best-effort, 门禁/错误均安静跳过(门禁在 sync 内部)。 */
export const defaultReconcileGraphIo: ReconcileGraphIo = {
  writeQuotaUsage: async (i) => {
    try {
      await writeQuotaUsageToGraph(i);
    } catch (e) {
      console.warn('[reconcile] writeQuotaUsage failed:', e instanceof Error ? e.message : e);
    }
  },
  writeProjectRollup: async (i) => {
    try {
      if (!process.env.NEO4J_PASSWORD) return;
      const hits = await findEntities({ kind: 'Project', name: i.projectCode, exact: true });
      const node = hits[0];
      if (!node) return; // 项目未同步进图 -> 无处可写, 安静跳过
      await updateNodeProps({
        elementId: node.elementId,
        props: {
          balance: i.grossMargin,
          quantityGap: i.quantityGap,
          receivableOpen: i.receivableOpen,
          payableOpen: i.payableOpen,
          reconciledAt: new Date().toISOString(),
        },
      });
    } catch (e) {
      console.warn('[reconcile] writeProjectRollup failed:', e instanceof Error ? e.message : e);
    }
  },
};

function parseAmount(raw: string | number | undefined): number | null {
  if (raw === undefined || isEmptyValue(raw)) return null;
  const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/[,，\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function ledgerAmount(entry: ContractLedgerEntry | null): number | null {
  return parseAmount(entry?.fields['金额']?.value);
}

/**
 * R3-对手方: owner 归一化(normalizeCompanyName)命中台账买方(买方|甲方)或
 * 卖方(卖方|乙方)任一侧 -> 计入该条金额。台账按 contract_no 唯一, 每条
 * 合同天然只计一次; 金额缺失跳过(不猜)。
 */
export function computeCounterpartyUsage(
  ownerKey: string, entries: ContractLedgerEntry[],
): number {
  const owner = normalizeCompanyName(ownerKey);
  if (!owner) return 0;
  let used = 0;
  for (const e of entries) {
    const buyer = normalizeCompanyName(String(firstNonEmpty([e.fields['买方']?.value, e.fields['甲方']?.value]) ?? ''));
    const seller = normalizeCompanyName(String(firstNonEmpty([e.fields['卖方']?.value, e.fields['乙方']?.value]) ?? ''));
    if (buyer !== owner && seller !== owner) continue;
    const amount = ledgerAmount(e);
    if (amount === null) continue;
    used += amount;
  }
  return used;
}

/** R3-项目: confirmed membership 的台账金额求和(缺金额跳过)。 */
export async function computeProjectUsage(
  ctx: DbContext, projectCode: string, userId?: string,
): Promise<number> {
  const memberships = await listMembershipsByProject(ctx, projectCode, userId);
  let used = 0;
  for (const m of memberships) {
    if (m.status !== 'confirmed') continue;
    const amount = ledgerAmount(await findContractLedgerByNo(ctx, m.contractNo, userId));
    if (amount === null) continue;
    used += amount;
  }
  return used;
}

export interface ReconcileQuotaResult {
  used: number;
  remaining: number;
  overLimit: boolean;
}

/**
 * 单条额度重算(路由 create/patch 即时复用): 算占用 -> 落 DB -> 图回写。
 * 返回 used/remaining/overLimit 供调用方直接返回给前端。
 */
export async function reconcileQuotaOne(
  ctx: DbContext, quota: QuotaRow, io: ReconcileGraphIo = defaultReconcileGraphIo,
): Promise<ReconcileQuotaResult> {
  const entries = await listContractLedgerEntries(ctx, quota.userId || undefined);
  const used = quota.scope === 'counterparty'
    ? computeCounterpartyUsage(quota.ownerKey, entries)
    : await computeProjectUsage(ctx, quota.ownerKey, quota.userId || undefined);
  const remaining = quota.limitAmount - used;
  const overLimit = remaining < 0;
  await updateQuotaUsed(ctx, quota.id, used, new Date().toISOString(), quota.userId || undefined);
  await io.writeQuotaUsage({ quotaId: quota.id, used, remaining, overLimit });
  return { used, remaining, overLimit };
}

/** 全量对账: 所有 active 额度(R3) + 所有项目(R1/R2) -> ReconcileReport。 */
export async function reconcileAll(
  ctx: DbContext, userId?: string, io: ReconcileGraphIo = defaultReconcileGraphIo,
): Promise<ReconcileReport> {
  const alerts: ReconcileAlert[] = [];
  const generatedAt = new Date().toISOString();

  // ---- R3 额度占用 ----
  const quotas = await listQuotas(ctx, { userId });
  const entries = await listContractLedgerEntries(ctx, userId);
  const quotaRows: QuotaUsageRow[] = [];
  for (const q of quotas) {
    const used = q.scope === 'counterparty'
      ? computeCounterpartyUsage(q.ownerKey, entries)
      : await computeProjectUsage(ctx, q.ownerKey, userId);
    const remaining = q.limitAmount - used;
    const overLimit = remaining < 0;
    await updateQuotaUsed(ctx, q.id, used, generatedAt, userId);
    await io.writeQuotaUsage({ quotaId: q.id, used, remaining, overLimit });
    quotaRows.push({
      quotaId: q.id, scope: q.scope, ownerKey: q.ownerKey, ownerLabel: q.ownerLabel,
      limitAmount: q.limitAmount, currency: q.currency, period: q.period,
      used, remaining, overLimit,
    });
    if (overLimit) {
      alerts.push({
        level: 'warn', code: 'quota_over_limit',
        message: `额度超限: ${q.ownerLabel || q.ownerKey} 占用 ${used} 超过限额 ${q.limitAmount}(${q.scope === 'counterparty' ? '对手方授信' : '项目限额'})`,
      });
    }
  }

  // ---- R1/R2 项目守恒 ----
  const projectRows: ProjectReconcileRow[] = [];
  const projects = await listProjects(ctx, userId);
  for (const p of projects) {
    const rollup = await rollupProject(ctx, p.code, userId);
    if (!rollup) continue;
    const quantityGap = rollup.flows.货物流.inTon - rollup.flows.货物流.outTon;
    const { grossMargin, receivableOpen, payableOpen } = rollup.metrics;
    const checks: ReconcileAlert[] = [];
    if (Math.abs(quantityGap) > 0.01) {
      checks.push({ level: 'info', code: 'qty_gap', message: `数量未平: ${quantityGap > 0 ? '+' : ''}${quantityGap.toFixed(2)} 吨(项目 ${p.code})` });
    }
    if (Math.abs(receivableOpen) > 0.01) {
      checks.push({ level: 'warn', code: 'receivable_open', message: `应收未收: ${receivableOpen.toFixed(2)}(项目 ${p.code})` });
    }
    if (Math.abs(payableOpen) > 0.01) {
      checks.push({ level: 'warn', code: 'payable_open', message: `应付未付: ${payableOpen.toFixed(2)}(项目 ${p.code})` });
    }
    await io.writeProjectRollup({ projectCode: p.code, grossMargin, quantityGap, receivableOpen, payableOpen });
    projectRows.push({
      code: p.code, name: p.name,
      grossMargin, quantityGap, receivableOpen, payableOpen, checks,
    });
    alerts.push(...checks);
  }

  return { generatedAt, quotas: quotaRows, projects: projectRows, alerts };
}
