// manage_quota(L2) / query_quota_usage(L1) 工具(spec 2026-08-25 方案A §6)。
//
// manage_quota 把两层额度(对手方授信/项目限额)落 quotas SSOT, 图投影走
// quotaGraphSync best-effort, 创建/调整后即时重算占用(reconcileQuotaOne)。
// 注册处标 needsApproval: true(v6 软门控)——chat 内 HITL 审批后执行;
// 工作台人工通道走 /api/quotas。query_quota_usage 是纯读: 读 DB 已物化
// used/remaining/overLimit(对账产物), 不触发重算。
import { tool } from 'ai';
import { z } from 'zod';
import type { DbContext } from '../db/client.js';
import {
  saveQuota, findQuotaById, listQuotas, updateQuota,
} from '../db/repositories.js';
import { normalizeProjectCode } from '../db/repositories.js';
import { syncQuotaGraph, removeQuotaGrantedEdge } from '../quotaGraphSync.js';
import { reconcileQuotaOne } from '../reconciliation.js';
import { normalizeName } from '../../graph/normalize.js';

export interface QuotaToolDeps {
  ctx: DbContext;
  userId?: string;
}

function err(message: string) {
  return { status: 'error' as const, error: message };
}

/** owner 定位: scope=counterparty 用 ownerName(归一化前后原样存, 匹配走
 *  normalizeCompanyName); scope=project 用 projectCode(normalizeProjectCode)。 */
function ownerKeyOf(scope: 'counterparty' | 'project', ownerName?: string, projectCode?: string): { key: string; label: string } | null {
  if (scope === 'counterparty') {
    if (!ownerName || !ownerName.trim()) return null;
    return { key: ownerName.trim(), label: ownerName.trim() };
  }
  const code = normalizeProjectCode(projectCode ?? '');
  if (!code) return null;
  return { key: code, label: code };
}

export function buildManageQuotaTool(deps: QuotaToolDeps) {
  return tool({
    description:
      '管理金融额度(两层): scope=counterparty 为对手方授信(需 ownerName), scope=project 为项目限额(需 projectCode)。' +
      '什么时候用: 用户说"给中石化设 500 万授信""这个项目限额 300 万""停用某条额度"时调用。' +
      'action=create 新建(update 时改限额用 update_limit, 停用用 deactivate)。L2 操作: 调用需附带人工授权。' +
      '创建/调整后立即返回当前占用 used 与 overLimit(超限标记)。占用由对账桥按合同台账金额计算。',
    inputSchema: z.object({
      action: z.enum(['create', 'update_limit', 'deactivate']).describe('create=新建额度; update_limit=改限额; deactivate=停用'),
      scope: z.enum(['counterparty', 'project']).optional().describe('counterparty=对手方授信; project=项目限额'),
      ownerName: z.string().min(1).optional().describe('对手方企业名(scope=counterparty 时必填)'),
      projectCode: z.string().min(1).optional().describe('项目编号(scope=project 时必填)'),
      limitAmount: z.number().positive().optional().describe('额度上限金额(create/update_limit 必填)'),
      currency: z.string().max(10).optional().describe('币种, 如 CNY/USD'),
      period: z.string().max(50).optional().describe('期间, 如 2026 / 2026H2'),
      quotaId: z.string().optional().describe('额度 ID(update_limit/deactivate 时必填)'),
    }),
    execute: async (input) => {
      const { ctx, userId } = deps;
      if (input.action === 'create') {
        const scope = input.scope;
        if (!scope) return err('create 需要 scope(counterparty/project)');
        if (input.limitAmount === undefined) return err('create 需要 limitAmount(正数)');
        const owner = ownerKeyOf(scope, input.ownerName, input.projectCode);
        if (!owner) return err(scope === 'counterparty' ? 'create 需要 ownerName' : 'create 需要 projectCode');
        if (scope === 'counterparty' && input.projectCode) return err('scope=counterparty 只接受 ownerName, 不要同时给 projectCode');
        if (scope === 'project' && input.ownerName) return err('scope=project 只接受 projectCode, 不要同时给 ownerName');
        const quotaId = await saveQuota(ctx, {
          scope, ownerKey: owner.key, ownerLabel: owner.label,
          limitAmount: input.limitAmount,
          currency: input.currency ?? null, period: input.period ?? null,
          createdBy: 'agent',
        }, userId);
        const sync = await syncQuotaGraph({
          quotaId, scope, ownerKey: owner.key, ownerLabel: owner.label,
          limitAmount: input.limitAmount, currency: input.currency ?? null, period: input.period ?? null,
        });
        const row = await findQuotaById(ctx, quotaId, userId);
        const usage = row ? await reconcileQuotaOne(ctx, row) : null;
        return {
          status: 'ok' as const, quotaId, scope, ownerKey: owner.key,
          limitAmount: input.limitAmount, graphSync: sync.outcome,
          ...(usage ?? { used: 0, remaining: input.limitAmount, overLimit: false }),
        };
      }
      if (input.action === 'update_limit') {
        if (!input.quotaId) return err('update_limit 需要 quotaId');
        if (input.limitAmount === undefined) return err('update_limit 需要 limitAmount');
        const row = await findQuotaById(ctx, input.quotaId, userId);
        if (!row || row.status !== 'active') return err(`额度不存在或已停用: ${input.quotaId}`);
        const ok = await updateQuota(ctx, row.id, { limitAmount: input.limitAmount }, userId);
        if (!ok) return err('额度更新失败');
        const sync = await syncQuotaGraph({
          quotaId: row.id, scope: row.scope, ownerKey: row.ownerKey, ownerLabel: row.ownerLabel,
          limitAmount: input.limitAmount, currency: row.currency, period: row.period,
        });
        const fresh = await findQuotaById(ctx, row.id, userId);
        const usage = fresh ? await reconcileQuotaOne(ctx, fresh) : null;
        return {
          status: 'ok' as const, quotaId: row.id, limitAmount: input.limitAmount,
          graphSync: sync.outcome, ...(usage ?? {}),
        };
      }
      // deactivate
      if (!input.quotaId) return err('deactivate 需要 quotaId');
      const row = await findQuotaById(ctx, input.quotaId, userId);
      if (!row) return err(`额度不存在: ${input.quotaId}`);
      if (row.status === 'active') {
        await updateQuota(ctx, row.id, { status: 'inactive' }, userId);
      }
      const sync = await removeQuotaGrantedEdge({ quotaId: row.id, scope: row.scope, ownerKey: row.ownerKey });
      return { status: 'ok' as const, quotaId: row.id, deactivated: true, graphSync: sync.outcome };
    },
  });
}

export function buildQueryQuotaUsageTool(deps: QuotaToolDeps) {
  return tool({
    description:
      '查询金融额度占用情况(只读)。什么时候用: 用户问"中石化的授信用了多少""这个项目额度还剩多少"' +
      '"哪些额度超限了"时调用。返回 DB 已物化的 used/remaining/overLimit(对账桥产物), 不触发重算。' +
      '可选过滤: scope(counterparty/project)、ownerName(对手方名, 模糊匹配)、projectCode。',
    inputSchema: z.object({
      scope: z.enum(['counterparty', 'project']).optional(),
      ownerName: z.string().optional().describe('按对手方名过滤(包含匹配)'),
      projectCode: z.string().optional().describe('按项目编号过滤(归一化后精确)'),
    }),
    execute: async (input) => {
      const rows = await listQuotas(deps.ctx, { scope: input.scope, userId: deps.userId });
      const projectCode = input.projectCode ? normalizeProjectCode(input.projectCode) : null;
      const ownerNeedle = input.ownerName ? normalizeName(input.ownerName) : null;
      const quotas = rows
        .filter((r) => {
          if (projectCode && (r.scope !== 'project' || r.ownerKey !== projectCode)) return false;
          if (ownerNeedle && (r.scope !== 'counterparty' || !normalizeName(r.ownerLabel).includes(ownerNeedle) && !normalizeName(r.ownerKey).includes(ownerNeedle))) return false;
          return true;
        })
        .map((r) => {
          const used = r.usedAmount;
          const remaining = r.limitAmount - used;
          return {
            quotaId: r.id, scope: r.scope, ownerKey: r.ownerKey, ownerLabel: r.ownerLabel,
            limitAmount: r.limitAmount, currency: r.currency, period: r.period,
            used, remaining, overLimit: remaining < 0, computedAt: r.computedAt,
          };
        });
      return { status: 'ok' as const, count: quotas.length, quotas };
    },
  });
}
