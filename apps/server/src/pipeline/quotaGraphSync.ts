// granted 边投影(spec 2026-08-25 方案A §3.3/§6)。quotas 表是两层额度的
// SSOT, 本模块把额度挂载投影到图: (Party|Project)-[granted]->(Quota)。
// Quota 节点 name=`quota:${id}`(生成 id 不进 name 唯一约束体系, 见 spec §9
// 键设计); 用量回写走 updateNodeProps(不动 name)。与 graphLinkSync 同模式:
// NEO4J_PASSWORD 门禁 -> skipped; 驱动错误 -> failed; 永不抛出。
//
// 键归一化(与既有节点命名约定收敛):
//   counterparty -> Party.name    = normalizeName(ownerKey)
//   project      -> Project.name = normalizeProjectCode(ownerKey)
import { createEntity, mergeEdge, removeEdge, findEntities, updateNodeProps } from '../graph/repo.js';
import { normalizeName } from '../graph/normalize.js';
import { normalizeProjectCode } from './db/repositories.js';
import { GRAPH_TRADE_EDGES } from '../domain/tradeSemantics.js';

export const GRANTED_EDGE = GRAPH_TRADE_EDGES.granted;

export type QuotaScopeKind = 'counterparty' | 'project';

export interface QuotaGraphSyncIo {
  createEntity(i: { kind: string; name: string; props?: Record<string, unknown> }): Promise<{ elementId: string }>;
  mergeEdge(i: { srcId: string; dstId: string; kind: string; props?: Record<string, unknown> }): Promise<unknown>;
  removeEdge(i: { srcId: string; kind: string; dstId: string }): Promise<number>;
  findEntityByName(kind: string, name: string): Promise<{ elementId: string } | null>;
  updateNodeProps(i: { elementId: string; props: Record<string, unknown> }): Promise<void>;
}

export const defaultQuotaGraphSyncIo: QuotaGraphSyncIo = {
  createEntity: (i) => createEntity(i),
  mergeEdge: (i) => mergeEdge(i),
  removeEdge: (i) => removeEdge(i),
  findEntityByName: async (kind, name) => {
    const hits = await findEntities({ kind, name, exact: true });
    return hits[0] ?? null;
  },
  updateNodeProps: (i) => updateNodeProps(i),
};

async function ensureNode(
  io: QuotaGraphSyncIo, kind: string, name: string,
): Promise<{ elementId: string }> {
  const found = await io.findEntityByName(kind, name);
  if (found) return found;
  return io.createEntity({ kind, name });
}

/** scope -> owner 节点 kind 与归一化键。空串 = 不可用键。 */
function ownerNodeName(scope: QuotaScopeKind, ownerKey: string): string {
  return scope === 'counterparty' ? normalizeName(ownerKey) : normalizeProjectCode(ownerKey);
}

function ownerKind(scope: QuotaScopeKind): 'Party' | 'Project' {
  return scope === 'counterparty' ? 'Party' : 'Project';
}

function edgeResult(reason?: string) {
  return reason ? { outcome: 'failed' as const, reason } : { outcome: 'ok' as const };
}

export interface SyncQuotaGraphInput {
  quotaId: string;
  scope: QuotaScopeKind;
  ownerKey: string;
  ownerLabel: string;
  limitAmount: number;
  currency?: string | null;
  period?: string | null;
}

export async function syncQuotaGraph(
  input: SyncQuotaGraphInput,
  io: QuotaGraphSyncIo = defaultQuotaGraphSyncIo,
): Promise<{ outcome: 'ok' | 'skipped' | 'failed'; reason?: string }> {
  if (!process.env.NEO4J_PASSWORD) return { outcome: 'skipped', reason: 'NEO4J_PASSWORD not set' };
  try {
    const ownerName = ownerNodeName(input.scope, input.ownerKey);
    if (!ownerName) return { outcome: 'failed', reason: `ownerKey normalized to empty (${input.ownerKey})` };
    const owner = await ensureNode(io, ownerKind(input.scope), ownerName);
    const quotaName = `quota:${input.quotaId}`;
    const quota = await ensureNode(io, 'Quota', quotaName);
    await io.mergeEdge({
      srcId: owner.elementId,
      dstId: quota.elementId,
      kind: GRANTED_EDGE,
      props: { scope: input.scope, ownerLabel: input.ownerLabel, source: 'quota_store' },
    });
    // Quota 节点属性跟额度定义走(每次同步刷新, MERGE 语义幂等)。
    await io.updateNodeProps({
      elementId: quota.elementId,
      props: {
        quotaId: input.quotaId,
        scope: input.scope,
        limitAmount: input.limitAmount,
        currency: input.currency ?? null,
        period: input.period ?? null,
        ownerLabel: input.ownerLabel,
      },
    });
    return edgeResult();
  } catch (e) {
    return { outcome: 'failed', reason: e instanceof Error ? e.message : String(e) };
  }
}

export interface RemoveQuotaGrantedEdgeInput {
  quotaId: string;
  scope: QuotaScopeKind;
  ownerKey: string;
}

/** 只删 granted 边; Quota 节点保留作历史(deactivate 语义, spec §3.3)。 */
export async function removeQuotaGrantedEdge(
  input: RemoveQuotaGrantedEdgeInput,
  io: QuotaGraphSyncIo = defaultQuotaGraphSyncIo,
): Promise<{ outcome: 'ok' | 'skipped' | 'failed'; reason?: string }> {
  if (!process.env.NEO4J_PASSWORD) return { outcome: 'skipped', reason: 'NEO4J_PASSWORD not set' };
  try {
    const ownerName = ownerNodeName(input.scope, input.ownerKey);
    if (!ownerName) return { outcome: 'failed', reason: 'ownerKey normalized to empty' };
    const owner = await io.findEntityByName(ownerKind(input.scope), ownerName);
    const quota = await io.findEntityByName('Quota', `quota:${input.quotaId}`);
    if (!owner || !quota) return { outcome: 'ok', reason: 'nodes missing (nothing to remove)' };
    await io.removeEdge({ srcId: owner.elementId, kind: GRANTED_EDGE, dstId: quota.elementId });
    return edgeResult();
  } catch (e) {
    return { outcome: 'failed', reason: e instanceof Error ? e.message : String(e) };
  }
}

export interface WriteQuotaUsageInput {
  quotaId: string;
  used: number;
  remaining: number;
  overLimit: boolean;
}

/** 对账桥用量物化回写(Quota 节点缺省时静默 ok——图未同步不是错误)。 */
export async function writeQuotaUsageToGraph(
  input: WriteQuotaUsageInput,
  io: QuotaGraphSyncIo = defaultQuotaGraphSyncIo,
): Promise<{ outcome: 'ok' | 'skipped' | 'failed'; reason?: string }> {
  if (!process.env.NEO4J_PASSWORD) return { outcome: 'skipped', reason: 'NEO4J_PASSWORD not set' };
  try {
    const quota = await io.findEntityByName('Quota', `quota:${input.quotaId}`);
    if (!quota) return { outcome: 'ok', reason: 'quota node missing (nothing to write)' };
    await io.updateNodeProps({
      elementId: quota.elementId,
      props: {
        used: input.used,
        remaining: input.remaining,
        overLimit: input.overLimit,
        usageComputedAt: new Date().toISOString(),
      },
    });
    return edgeResult();
  } catch (e) {
    return { outcome: 'failed', reason: e instanceof Error ? e.message : String(e) };
  }
}
