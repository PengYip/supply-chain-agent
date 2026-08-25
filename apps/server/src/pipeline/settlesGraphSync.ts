// settles 边投影(spec 2026-08-25 方案A §3.3): Document-[settles {relation,
// direction}]->Contract。relation 六向词来自 domain/tradeSemantics.
// settlesRelationFor, 由 execution_flows(flowType x direction)确定性派生;
// 白名单外/方向未知时上游根本不调用本模块。与 bindingGraphSync 同模式:
// NEO4J_PASSWORD 门禁 -> skipped; 驱动错误 -> failed; 永不抛出, 绝不阻塞绑定
// 确认主流程。io 可注入, 单测无需 Neo4j。
import { createEntity, mergeEdge, removeEdge, findEntities } from '../graph/repo.js';
import { normalizeName } from '../graph/normalize.js';

export type GraphSyncOutcome = 'ok' | 'skipped' | 'failed';
export interface SettlesSyncResult { outcome: GraphSyncOutcome; reason?: string }

export interface SettlesGraphSyncIo {
  createEntity(i: { kind: string; name: string; props?: Record<string, unknown> }): Promise<{ elementId: string }>;
  mergeEdge(i: { srcId: string; dstId: string; kind: string; props?: Record<string, unknown>; confidence?: number }): Promise<unknown>;
  removeEdge(i: { srcId: string; kind: string; dstId: string }): Promise<number>;
  findEntityByName(kind: string, name: string): Promise<{ elementId: string } | null>;
}

export const defaultSettlesGraphSyncIo: SettlesGraphSyncIo = {
  createEntity: (i) => createEntity(i),
  mergeEdge: (i) => mergeEdge(i),
  removeEdge: (i) => removeEdge(i),
  findEntityByName: async (kind, name) => {
    const hits = await findEntities({ kind, name, exact: true });
    return hits[0] ?? null;
  },
};

export const SETTLES_EDGE = 'settles';

async function ensureNode(
  io: SettlesGraphSyncIo, kind: string, name: string,
  createFallback: () => Promise<{ elementId: string }>,
): Promise<{ elementId: string }> {
  const found = await io.findEntityByName(kind, name);
  if (found) return found;
  return createFallback();
}

export interface SyncSettlesEdgeInput {
  docId: string;
  docType?: string | null;
  sourceUri?: string | null;
  contractNo: string;
  /** 六向受控词(tradeSemantics.settlesRelationFor 派生), 空 -> failed。 */
  relation: string;
  direction: 'in' | 'out';
  amount?: number | null;
  confidence: number;
}

export async function syncSettlesEdge(
  input: SyncSettlesEdgeInput,
  io: SettlesGraphSyncIo = defaultSettlesGraphSyncIo,
): Promise<SettlesSyncResult> {
  if (!process.env.NEO4J_PASSWORD) return { outcome: 'skipped', reason: 'NEO4J_PASSWORD not set' };
  try {
    // 节点名与 graphWriter/bindingGraphSync 同键: Contract.name = normalizeName(合同号)。
    const contractName = normalizeName(input.contractNo);
    if (!contractName) return { outcome: 'failed', reason: 'contractNo normalized to empty' };
    if (!input.relation) return { outcome: 'failed', reason: 'settles relation is empty' };
    // Document 节点走 createEntity(MERGE 幂等): ON MATCH SET 回填 docType/sourceUri,
    // 兜底节点缺属性时自愈(与 bindingGraphSync 2026-08-18 语义一致)。
    const docNode = await io.createEntity({
      kind: 'Document', name: input.docId,
      props: {
        docId: input.docId,
        ...(input.docType ? { docType: input.docType } : {}),
        ...(input.sourceUri ? { sourceUri: input.sourceUri } : {}),
      },
    });
    const contractNode = await ensureNode(io, 'Contract', contractName,
      () => io.createEntity({ kind: 'Contract', name: contractName, props: { rawName: input.contractNo } }));
    await io.mergeEdge({
      srcId: docNode.elementId, dstId: contractNode.elementId, kind: SETTLES_EDGE,
      confidence: input.confidence,
      props: {
        relation: input.relation, direction: input.direction, source: 'workbench',
        ...(input.amount != null ? { amount: input.amount } : {}),
      },
    });
    return { outcome: 'ok' };
  } catch (e) {
    return { outcome: 'failed', reason: e instanceof Error ? e.message : String(e) };
  }
}

export async function removeSettlesEdge(
  input: { docId: string; contractNo: string },
  io: SettlesGraphSyncIo = defaultSettlesGraphSyncIo,
): Promise<SettlesSyncResult> {
  if (!process.env.NEO4J_PASSWORD) return { outcome: 'skipped', reason: 'NEO4J_PASSWORD not set' };
  try {
    const contractName = normalizeName(input.contractNo);
    if (!contractName) return { outcome: 'failed', reason: 'contractNo normalized to empty' };
    const docNode = await io.findEntityByName('Document', input.docId);
    const contractNode = await io.findEntityByName('Contract', contractName);
    if (!docNode || !contractNode) return { outcome: 'ok', reason: 'nodes missing (nothing to remove)' };
    await io.removeEdge({ srcId: docNode.elementId, kind: SETTLES_EDGE, dstId: contractNode.elementId });
    return { outcome: 'ok' };
  } catch (e) {
    return { outcome: 'failed', reason: e instanceof Error ? e.message : String(e) };
  }
}
