// 本体 -> Neo4j 投影(spec 2026-09-09)。铁律沿 graphWriter: SSOT 在关系库
// (trade_facts/ontology_edges), 图只承载最新业务口径(asOfBusinessTime(now), 与
// 台账列表同口径); 双时间轴切片/红冲净额轧差判定一律以 SQL 为准。幂等 MERGE
// 收敛; NEO4J_PASSWORD 未设 -> skipped; 投影失败逐条容错, fire-and-forget 包装
// (syncOntologyGraphSafe)保证永不阻塞业务写入。
//
// 图对象(spec §2.1):
//   trade_facts 行 -> 节点 label=实体类型(7 事件 + 3 主数据), name=TF id,
//                     props=payload 展平 + userId/validAt/ingestedAt/createdBy
//   ontology_edges 行 -> 关系 type=关系名(ALLOCATE_TO 等 8 种), props=params
//                        + edgeId/userId/validAt
//   TradeContract 端点   -> 桥到既有 (:Contract {name: normalizeName(contract_no)})
//   收/发货单据源端点     -> 桥到既有 (:Document {name: docId}), 不重复建节点
import type { DbContext } from '../pipeline/db/client.js';
import { effectiveUserId } from '../pipeline/db/repositories.js';
import {
  createEntity,
  mergeEdge,
  findEntities,
  pruneFactNodes,
  type GraphEntity,
} from '../graph/repo.js';
import { normalizeName } from '../graph/normalize.js';
import { asOfBusinessTime } from './asof.js';
import {
  listTradeFactsAsOf,
  listOntologyEdgesAsOf,
  type OntologyEdgeRow,
  type TradeFactRow,
} from './repo.js';
import { findContractRowById, findDocRowById } from './projection.js';

/** 建事实节点的实体 label(7 事件 + 3 主数据)。TradeContract 走 Contract 桥不建
 *  节点; 收/发货的 documents 源伪事件保持 Document 表示(spec §2.1)。 */
export const FACT_NODE_LABELS = [
  'GoodsReceiptEvent', 'GoodsDeliveryEvent', 'SettlementEvent', 'InvoiceEvent',
  'PaymentEvent', 'CollectionEvent', 'ServiceCostEvent',
  'TradeGoods', 'Counterparty', 'OrgUnit',
] as const;
type FactNodeLabel = (typeof FACT_NODE_LABELS)[number];

/** 单表扫描上限(与 projection.SOURCE_ROW_CAP 同口径的本地常量, 避免 ontology ->
 *  projection 私有常量依赖)。超限置 truncated 并跳过 prune 防误删。 */
const SYNC_ROW_CAP = 500;

export interface GraphSyncIo {
  createEntity(input: { kind: string; name: string; props?: Record<string, unknown> }): Promise<GraphEntity & { created: boolean }>;
  mergeEdge(input: { srcId: string; dstId: string; kind: string; props?: Record<string, unknown>; confidence?: number }): Promise<unknown>;
  findEntities(input: { kind?: string; name: string; exact?: boolean; limit?: number }): Promise<GraphEntity[]>;
  /** prune 槽位可选: 既有测试 fake 可不实现(不触发 prune 断言)。 */
  pruneFactNodes?(input: { label: string; keepIds: string[]; userId: string }): Promise<number>;
}

export const defaultGraphSyncIo: GraphSyncIo = {
  createEntity: (i) => createEntity(i),
  mergeEdge: (i) => mergeEdge(i),
  findEntities: (i) => findEntities(i),
  pruneFactNodes: (i) => pruneFactNodes(i.label, i.keepIds, i.userId),
};

/** DB 读取槽位可注入(测试沿 neighbors 范式用 :memory: 真库, 桥读取可 fake)。 */
export interface SyncOntologyGraphDeps {
  ctx: DbContext;
  userId?: string;
  io?: GraphSyncIo;
  /** 单表扫描上限, 默认 SYNC_ROW_CAP。 */
  cap?: number;
  findDocRow?: typeof findDocRowById;
  findContractRow?: typeof findContractRowById;
}

export interface GraphSyncResult {
  status: 'ok' | 'partial' | 'skipped';
  nodeCount: number;
  edgeCount: number;
  /** prune 收敛删除的陈旧事实节点数(truncated 时恒 0)。 */
  prunedCount: number;
  truncated: boolean;
  failures: string[];
}

export function isOntologyGraphConfigured(): boolean {
  return Boolean(process.env.NEO4J_PASSWORD);
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * 全量幂等投影(spec 2026-09-09 §2.2): 1) 事实节点 upsert 2) 关系投影(端点解析:
 * 事实节点直取 / TradeContract->Contract 桥 / 收发单据源->Document 桥, 解析失败
 * 逐条记 failures 跳过) 3) prune 收敛(truncated/userId 双守卫)。
 * 永不抛出——调用方(L2 工具钩子/回填路由)分别以 fire-and-forget / 500 兜底。
 */
export async function syncOntologyGraph(deps: SyncOntologyGraphDeps): Promise<GraphSyncResult> {
  if (!isOntologyGraphConfigured()) {
    return { status: 'skipped', nodeCount: 0, edgeCount: 0, prunedCount: 0, truncated: false, failures: [] };
  }
  const io = deps.io ?? defaultGraphSyncIo;
  const cap = deps.cap ?? SYNC_ROW_CAP;
  const uid = effectiveUserId(deps.userId);
  const failures: string[] = [];

  const pred = asOfBusinessTime(new Date().toISOString());
  const facts: TradeFactRow[] = await listTradeFactsAsOf(deps.ctx, pred, {}, uid);
  const edges: OntologyEdgeRow[] = await listOntologyEdgesAsOf(deps.ctx, pred, {}, uid);
  const truncated = facts.length >= cap || edges.length >= cap;
  const factSlice = facts.slice(0, cap);
  const edgeSlice = edges.slice(0, cap);

  // 1. 事实节点 upsert: label=实体类型, name=TF id(name 唯一约束体系), 幂等 MERGE。
  const nodeIdByKey = new Map<string, string>(); // `${entityType}:${id}` -> elementId
  const keepByLabel = new Map<string, Set<string>>();
  for (const fact of factSlice) {
    const props: Record<string, unknown> = {
      ...fact.payload,
      userId: fact.userId,
      validAt: fact.validAt,
      ingestedAt: fact.ingestedAt,
      createdBy: fact.createdBy,
    };
    try {
      const node = await io.createEntity({ kind: fact.entityType, name: fact.id, props });
      nodeIdByKey.set(`${fact.entityType}:${fact.id}`, node.elementId);
      if (FACT_NODE_LABELS.includes(fact.entityType as FactNodeLabel)) {
        const keep = keepByLabel.get(fact.entityType) ?? new Set<string>();
        keep.add(fact.id);
        keepByLabel.set(fact.entityType, keep);
      }
    } catch (e) {
      failures.push(`node ${fact.entityType}/${fact.id}: ${msg(e)}`);
    }
  }

  // 2. 端点解析: 事实节点直取 nodeMap; 桥端点按归一化名/单据 id 找既有图节点。
  const resolveEndpoint = async (type: string, id: string): Promise<string | null> => {
    const direct = nodeIdByKey.get(`${type}:${id}`);
    if (direct) return direct;
    if (type === 'TradeContract') {
      const row = await (deps.findContractRow ?? findContractRowById)(deps.ctx, id, uid);
      const contractNo = String(row?.fields['contractNo'] ?? '');
      if (!row || !contractNo) return null;
      const hits = await io.findEntities({ kind: 'Contract', name: normalizeName(contractNo), exact: true });
      return hits[0]?.elementId ?? null;
    }
    if (type === 'GoodsReceiptEvent' || type === 'GoodsDeliveryEvent') {
      const row = await (deps.findDocRow ?? findDocRowById)(deps.ctx, id, type, uid);
      if (!row) return null;
      const hits = await io.findEntities({ kind: 'Document', name: row.id, exact: true });
      return hits[0]?.elementId ?? null;
    }
    return null;
  };

  let edgeCount = 0;
  for (const edge of edgeSlice) {
    try {
      const srcId = await resolveEndpoint(edge.fromType, edge.fromId);
      const dstId = await resolveEndpoint(edge.toType, edge.toId);
      if (!srcId || !dstId) {
        failures.push(
          `edge ${edge.relation} ${edge.fromType}/${edge.fromId} -> ${edge.toType}/${edge.toId}:` +
          ' endpoint not resolved in graph (bridge anchor missing or beyond cap)',
        );
        continue;
      }
      await io.mergeEdge({
        srcId,
        dstId,
        kind: edge.relation,
        props: { ...edge.params, edgeId: edge.id, userId: edge.userId, validAt: edge.validAt },
      });
      edgeCount += 1;
    } catch (e) {
      failures.push(`edge ${edge.relation}/${edge.id}: ${msg(e)}`);
    }
  }

  // 3. prune 收敛: 仅事实 label; truncated 跳过(防超限误删); userId 匹配含共享 ''
  // 行(与 repo 读路径同口径), 其他用户节点不受影响(spec §2.2)。
  let prunedCount = 0;
  if (!truncated) {
    for (const label of FACT_NODE_LABELS) {
      const keepIds = [...(keepByLabel.get(label) ?? [])];
      try {
        prunedCount += await io.pruneFactNodes?.({ label, keepIds, userId: uid }) ?? 0;
      } catch (e) {
        failures.push(`prune ${label}: ${msg(e)}`);
      }
    }
  }

  return {
    status: failures.length === 0 ? 'ok' : 'partial',
    nodeCount: nodeIdByKey.size,
    edgeCount,
    prunedCount,
    truncated,
    failures,
  };
}

/**
 * fire-and-forget 安全包装(L2 工具钩子/主数据端点用): 图未配置静默返回; 任何
 * 错误只 warn——图投影失败绝不影响登记/核销的写入结果(铁律: 图写入永不阻塞)。
 * io 可注入(测试); 缺省走真实图。
 */
export async function syncOntologyGraphSafe(
  ctx: DbContext,
  userId?: string,
  io?: GraphSyncIo,
): Promise<void> {
  if (!isOntologyGraphConfigured()) return;
  try {
    const res = await syncOntologyGraph({ ctx, userId, ...(io ? { io } : {}) });
    if (res.status === 'partial') {
      console.warn(
        `[ontology/graphSync] partial projection (${res.failures.length} failures):`,
        res.failures.slice(0, 3),
      );
    }
  } catch (e) {
    console.warn('[ontology/graphSync] projection skipped:', msg(e));
  }
}
