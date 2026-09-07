// apps/server/src/ontology/neighbors.ts
// 链路穿透核心(roadmap Item 4)：本体边 BFS(ontology_edges) + 文档血缘(Neo4j)锚点层融合。
// 只读：本模块零裸 SQL——全部经 repo/projection 既有双后端读路径。
// 边读取口径 = 最新业务口径(asOfBusinessTime(now))，与台账列表一致；
// as-of 时间切片穿透 deferred(详情抽屉已具备两口径)。
import type { DbContext } from '../pipeline/db/client.js';
import { effectiveUserId } from '../pipeline/db/repositories.js';
import { asOfBusinessTime } from './asof.js';
import type { OntologyEntityName } from './index.js';
import { getTradeFactById, listOntologyEdgesAsOf } from './repo.js';
import {
  factToEntity, findContractRowById, findDocRowById, type ProjectedEntity,
} from './projection.js';

export interface NeighborRef {
  type: string;
  id: string;
}

export interface NeighborNode {
  id: string;
  /** 注册表实体名 | 'Document'(血缘节点) */
  entityType: string;
  label: string;
  source: 'contract_ledger' | 'documents' | 'trade_facts' | 'neo4j' | 'unresolved';
  props?: Record<string, unknown>;
}

export interface NeighborEdge {
  id: string;
  relation: string;
  origin: 'ontology' | 'lineage';
  fromType: string;
  fromId: string;
  toType: string;
  toId: string;
  params: Record<string, unknown>;
  validAt: string | null;
}

export interface OntologyNeighbors {
  anchor: NeighborRef;
  anchorNode: NeighborNode;
  /** 邻接节点(不含锚点)；血缘 Document 节点(Task 3 起以 source:'neo4j' 并入) */
  nodes: NeighborNode[];
  edges: NeighborEdge[];
  truncated: boolean;
}

/** 防全图爆炸(验收 4)：深度上限(3)之外的响应规模双保险。 */
export const MAX_NEIGHBOR_NODES = 200;
export const MAX_NEIGHBOR_EDGES = 500;
export const MAX_NEIGHBOR_DEPTH = 3;

const refKey = (type: string, id: string) => `${type} ${id}`;

function toNode(e: ProjectedEntity): NeighborNode {
  return { id: e.id, entityType: e.entityType, label: e.label, source: e.source };
}

/** 最佳努力解析引用 -> 展示节点。三源顺序与台账详情一致(事实优先、收发再探单据、合同走台账)。
 *  与详情端点不同(D8)：强制 type 匹配——事实校验 entityType、单据校验 doc_type，
 *  不符按未解析处理(label=id)，绝不返回错型数据。 */
async function resolveBrief(ctx: DbContext, ref: NeighborRef, uid: string): Promise<NeighborNode> {
  if (ref.type === 'TradeContract') {
    const e = await findContractRowById(ctx, ref.id, uid);
    if (e) return toNode(e);
  } else {
    const fact = await getTradeFactById(ctx, ref.id, uid);
    if (fact && fact.entityType === ref.type) return toNode(factToEntity(fact));
    if (ref.type === 'GoodsReceiptEvent' || ref.type === 'GoodsDeliveryEvent') {
      const e = await findDocRowById(
        ctx, ref.id, ref.type as 'GoodsReceiptEvent' | 'GoodsDeliveryEvent', uid);
      if (e) return toNode(e);
    }
  }
  return { id: ref.id, entityType: ref.type, label: ref.id, source: 'unresolved' };
}

/** 本体边 BFS：全量边(最新业务口径, 用户隔离)加载后内存遍历——repo 无按端点查询，
 *  且 projection.reverseOriginCluster 已确立该先例(D6)。BFS 只收集节点，
 *  边集 = 两端均在可达集内的诱导边(语义显然正确)。 */
export async function getOntologyNeighbors(
  ctx: DbContext,
  input: { type: OntologyEntityName; id: string; depth: number },
  userId?: string,
  opts: { maxNodes?: number; maxEdges?: number } = {},
): Promise<OntologyNeighbors> {
  const uid = effectiveUserId(userId);
  const maxNodes = opts.maxNodes ?? MAX_NEIGHBOR_NODES;
  const maxEdges = opts.maxEdges ?? MAX_NEIGHBOR_EDGES;
  const depth = Math.min(Math.max(Math.trunc(input.depth) || 1, 1), MAX_NEIGHBOR_DEPTH);
  const anchor: NeighborRef = { type: input.type, id: input.id };

  const allEdges = await listOntologyEdgesAsOf(ctx, asOfBusinessTime(new Date().toISOString()), {}, uid);

  const seen = new Map<string, NeighborRef>([[refKey(anchor.type, anchor.id), anchor]]);
  let frontier: NeighborRef[] = [anchor];
  for (let hop = 0; hop < depth && frontier.length > 0; hop += 1) {
    const frontierKeys = new Set(frontier.map((r) => refKey(r.type, r.id)));
    const next: NeighborRef[] = [];
    for (const e of allEdges) {
      const fk = refKey(e.fromType, e.fromId);
      const tk = refKey(e.toType, e.toId);
      if (frontierKeys.has(fk) && !seen.has(tk)) {
        seen.set(tk, { type: e.toType, id: e.toId });
        next.push({ type: e.toType, id: e.toId });
      }
      if (frontierKeys.has(tk) && !seen.has(fk)) {
        seen.set(fk, { type: e.fromType, id: e.fromId });
        next.push({ type: e.fromType, id: e.fromId });
      }
    }
    frontier = next;
  }

  const induced = allEdges.filter(
    (e) => seen.has(refKey(e.fromType, e.fromId)) && seen.has(refKey(e.toType, e.toId)),
  );

  const truncated = induced.length > maxEdges || seen.size - 1 > maxNodes;
  const edgeOut: NeighborEdge[] = induced.slice(0, maxEdges).map((e) => ({
    id: e.id,
    relation: e.relation,
    origin: 'ontology' as const,
    fromType: e.fromType,
    fromId: e.fromId,
    toType: e.toType,
    toId: e.toId,
    params: e.params,
    validAt: e.validAt,
  }));

  const refs = [...seen.values()].slice(1, maxNodes + 1);
  const nodes: NeighborNode[] = [];
  for (const ref of refs) {
    nodes.push(await resolveBrief(ctx, ref, uid));
  }

  const anchorNode = await resolveBrief(ctx, anchor, uid);
  return { anchor, anchorNode, nodes, edges: edgeOut, truncated };
}
