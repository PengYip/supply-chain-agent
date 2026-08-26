// 工作台绑定 -> Neo4j binds 边同步(spec 2026-08-18 §5.2)。业务写入永不
// 被图同步阻塞: 未配置 -> 'skipped'; 驱动错误 -> 'failed'(带 reason), 调用方
// 落 bindings.graph_status 供前端角标/重试。io 可注入, 单测无需 Neo4j。
import { createEntity, mergeEdge, removeEdge, findEntities } from '../graph/repo.js';
import { normalizeName } from '../graph/normalize.js';

export type GraphSyncOutcome = 'ok' | 'skipped' | 'failed';
export interface BindingGraphSyncResult { outcome: GraphSyncOutcome; reason?: string }

export interface BindingGraphSyncIo {
  createEntity(i: { kind: string; name: string; props?: Record<string, unknown> }): Promise<{ elementId: string }>;
  mergeEdge(i: { srcId: string; dstId: string; kind: string; props?: Record<string, unknown>; confidence?: number }): Promise<unknown>;
  removeEdge(i: { srcId: string; kind: string; dstId: string }): Promise<number>;
  findEntityByName(kind: string, name: string): Promise<{ elementId: string } | null>;
}

export const defaultBindingGraphSyncIo: BindingGraphSyncIo = {
  createEntity: (i) => createEntity(i),
  mergeEdge: (i) => mergeEdge(i),
  removeEdge: (i) => removeEdge(i),
  findEntityByName: async (kind, name) => {
    const hits = await findEntities({ kind, name, exact: true });
    return hits[0] ?? null;
  },
};

export const BINDS_EDGE = 'binds';

async function ensureNode(
  io: BindingGraphSyncIo, kind: string, name: string,
  createFallback: () => Promise<{ elementId: string }>,
): Promise<{ elementId: string }> {
  const found = await io.findEntityByName(kind, name);
  if (found) return found;
  return createFallback();
}

export async function syncBindingEdge(
  input: { docId: string; docType?: string; sourceUri?: string | null; contractNo: string; relation: string; bindingId: string; confidence: number; templateVersion?: number },
  io: BindingGraphSyncIo = defaultBindingGraphSyncIo,
): Promise<BindingGraphSyncResult> {
  if (!process.env.NEO4J_PASSWORD) return { outcome: 'skipped', reason: 'NEO4J_PASSWORD not set' };
  try {
    // 节点名与 graphWriter 一致: Document.name = docId; Contract.name = normalizeName(合同号)。
    const contractName = normalizeName(input.contractNo);
    if (!contractName) return { outcome: 'failed', reason: 'contractNo normalized to empty' };
    // Document 节点直接走 createEntity（MERGE 幂等）：ON MATCH SET 会把
    // sourceUri/docType 回填进既有节点——绑定先于抽取确认发生时，兜底节点缺
    // sourceUri，前端只能显示 docId；回填后自愈（2026-08-18）。
    const docNode = await io.createEntity({
      kind: 'Document',
      name: input.docId,
      props: {
        docId: input.docId,
        ...(input.docType ? { docType: input.docType } : {}),
        ...(input.sourceUri ? { sourceUri: input.sourceUri } : {}),
      },
    });
    const contractNode = await ensureNode(io, 'Contract', contractName,
      () => io.createEntity({ kind: 'Contract', name: contractName, props: { rawName: input.contractNo } }));
    await io.mergeEdge({
      srcId: docNode.elementId,
      dstId: contractNode.elementId,
      kind: BINDS_EDGE,
      confidence: input.confidence,
      props: { bindingId: input.bindingId, relation: input.relation, source: 'workbench', ...(input.templateVersion ? { templateVersion: input.templateVersion } : {}) },
    });
    return { outcome: 'ok' };
  } catch (e) {
    return { outcome: 'failed', reason: e instanceof Error ? e.message : String(e) };
  }
}

export async function removeBindingEdge(
  input: { docId: string; contractNo: string },
  io: BindingGraphSyncIo = defaultBindingGraphSyncIo,
): Promise<BindingGraphSyncResult> {
  if (!process.env.NEO4J_PASSWORD) return { outcome: 'skipped', reason: 'NEO4J_PASSWORD not set' };
  try {
    const contractName = normalizeName(input.contractNo);
    if (!contractName) return { outcome: 'failed', reason: 'contractNo normalized to empty' };
    const docNode = await io.findEntityByName('Document', input.docId);
    const contractNode = await io.findEntityByName('Contract', contractName);
    if (!docNode || !contractNode) return { outcome: 'ok', reason: 'nodes missing (nothing to remove)' };
    await io.removeEdge({ srcId: docNode.elementId, kind: BINDS_EDGE, dstId: contractNode.elementId });
    return { outcome: 'ok' };
  } catch (e) {
    return { outcome: 'failed', reason: e instanceof Error ? e.message : String(e) };
  }
}
