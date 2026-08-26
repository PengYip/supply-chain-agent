// correlates/relates 边同步(spec 2026-08-25 方案A §3.3/§6)。graph_links 表是
// 提案-确认 SSOT, 本模块把确认后的关联投影到图。与 bindingGraphSync/settles
// GraphSync 同模式: NEO4J_PASSWORD 门禁 -> skipped; 驱动错误 -> failed; 永不
// 抛出, 绝不阻塞业务主流程。io 可注入, 单测无需 Neo4j。
//
// 键归一化(与既有节点命名约定收敛, 见 Global Constraints):
//   correlates -> Contract.name = normalizeName(normalizeContractNo(key))
//   relates    -> Project.name  = normalizeProjectCode(key)
import { createEntity, mergeEdge, removeEdge, findEntities } from '../graph/repo.js';
import { normalizeName } from '../graph/normalize.js';
import { normalizeContractNo } from './contractLedger.js';
import { normalizeProjectCode } from './db/repositories.js';
import { GRAPH_TRADE_EDGES } from '../domain/tradeSemantics.js';

export const CORRELATES_EDGE = GRAPH_TRADE_EDGES.correlates;
export const RELATES_EDGE = GRAPH_TRADE_EDGES.relates;

export type GraphLinkKind = 'correlates' | 'relates' | 'amends';

export interface GraphLinkSyncIo {
  createEntity(i: { kind: string; name: string; props?: Record<string, unknown> }): Promise<{ elementId: string }>;
  mergeEdge(i: { srcId: string; dstId: string; kind: string; props?: Record<string, unknown>; confidence?: number }): Promise<unknown>;
  removeEdge(i: { srcId: string; kind: string; dstId: string }): Promise<number>;
  findEntityByName(kind: string, name: string): Promise<{ elementId: string } | null>;
}

export const defaultGraphLinkSyncIo: GraphLinkSyncIo = {
  createEntity: (i) => createEntity(i),
  mergeEdge: (i) => mergeEdge(i),
  removeEdge: (i) => removeEdge(i),
  findEntityByName: async (kind, name) => {
    const hits = await findEntities({ kind, name, exact: true });
    return hits[0] ?? null;
  },
};

async function ensureNode(
  io: GraphLinkSyncIo, kind: string, name: string,
): Promise<{ elementId: string }> {
  const found = await io.findEntityByName(kind, name);
  if (found) return found;
  return io.createEntity({ kind, name });
}

/** kind -> 节点键归一化(correlates/amends=合同号双归一, relates=项目码; amends src 为 docId 原样)。空串 = 不可用键。 */
function normalizeKey(kind: GraphLinkKind, key: string): string {
  if (kind === 'relates') return normalizeProjectCode(key);
  return normalizeName(normalizeContractNo(key));
}

export interface SyncGraphLinkEdgeInput {
  kind: GraphLinkKind;
  srcKind: 'Contract' | 'Project' | 'Document';
  srcKey: string;
  dstKind: 'Contract' | 'Project' | 'Document';
  dstKey: string;
  props: Record<string, unknown>;
  confirmationSource: 'human' | 'agent';
  confidence: number;
}

function edgeResult(reason?: string) {
  return reason ? { outcome: 'failed' as const, reason } : { outcome: 'ok' as const };
}

export async function syncGraphLinkEdge(
  input: SyncGraphLinkEdgeInput,
  io: GraphLinkSyncIo = defaultGraphLinkSyncIo,
): Promise<{ outcome: 'ok' | 'skipped' | 'failed'; reason?: string }> {
  if (!process.env.NEO4J_PASSWORD) return { outcome: 'skipped', reason: 'NEO4J_PASSWORD not set' };
  try {
    const srcName = normalizeKey(input.kind, input.srcKey);
    const dstName = normalizeKey(input.kind, input.dstKey);
    if (!srcName) return { outcome: 'failed', reason: `srcKey normalized to empty (${input.srcKey})` };
    if (!dstName) return { outcome: 'failed', reason: `dstKey normalized to empty (${input.dstKey})` };
    const srcNode = await ensureNode(io, input.srcKind, srcName);
    const dstNode = await ensureNode(io, input.dstKind, dstName);
    await io.mergeEdge({
      srcId: srcNode.elementId, dstId: dstNode.elementId,
      kind: input.kind === 'correlates' ? CORRELATES_EDGE : input.kind === 'relates' ? RELATES_EDGE : 'amends',
      confidence: input.confidence,
      props: { ...input.props, confirmationSource: input.confirmationSource, source: 'link_workbench' },
    });
    return edgeResult();
  } catch (e) {
    return { outcome: 'failed', reason: e instanceof Error ? e.message : String(e) };
  }
}

export interface RemoveGraphLinkEdgeInput {
  kind: GraphLinkKind;
  srcKind: 'Contract' | 'Project';
  srcKey: string;
  dstKind: 'Contract' | 'Project';
  dstKey: string;
}

export async function removeGraphLinkEdge(
  input: RemoveGraphLinkEdgeInput,
  io: GraphLinkSyncIo = defaultGraphLinkSyncIo,
): Promise<{ outcome: 'ok' | 'skipped' | 'failed'; reason?: string }> {
  if (!process.env.NEO4J_PASSWORD) return { outcome: 'skipped', reason: 'NEO4J_PASSWORD not set' };
  try {
    const srcName = normalizeKey(input.kind, input.srcKey);
    const dstName = normalizeKey(input.kind, input.dstKey);
    if (!srcName || !dstName) return { outcome: 'failed', reason: 'key normalized to empty' };
    const srcNode = await io.findEntityByName(input.srcKind, srcName);
    const dstNode = await io.findEntityByName(input.dstKind, dstName);
    if (!srcNode || !dstNode) return { outcome: 'ok', reason: 'nodes missing (nothing to remove)' };
    await io.removeEdge({
      srcId: srcNode.elementId,
      kind: input.kind === 'correlates' ? CORRELATES_EDGE : input.kind === 'relates' ? RELATES_EDGE : 'amends',
      dstId: dstNode.elementId,
    });
    return edgeResult();
  } catch (e) {
    return { outcome: 'failed', reason: e instanceof Error ? e.message : String(e) };
  }
}
