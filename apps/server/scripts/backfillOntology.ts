// One-off backfill: materialize pending execution_flows / settlement_records
// into ontology facts + ALLOCATE_TO edges + graph sync (business-loop Wave 2).
//
// WHY: 单据确认/绑定确认/结算确认钩子(Task 4)只覆盖新确认路径; 钩子上线前已确认
// 的存量 flow/settlement 行需要一次性回填为本体事实, 打通"管线不写本体"的存量断点。
//
// RUN (on the server, project root):
//   npm run backfill:ontology --workspace apps/server -- --dry-run   # preview
//   npm run backfill:ontology --workspace apps/server -- --limit 500 # bounded apply
//   npm run backfill:ontology --workspace apps/server                # apply all
//
// 只调用 Task 3/4 已产出并测试覆盖的 materialize 函数, 不在脚本内重写映射逻辑。
// Safe to re-run: 只处理 ontology_fact_id IS NULL 的待回填行, 完成一趟即 no-op。
import 'dotenv/config';
import { performance } from 'node:perf_hooks';
import { getDbContext } from '../src/pipeline/db/dbBackend.js';
import { numberPlaceholders } from '../src/ontology/asof.js';
import {
  materializeDocumentOntology,
  materializeSettlementRecord,
  type MaterializeResult,
  type SettlementRecordInput,
} from '../src/pipeline/ontologyMaterialize.js';
import { syncOntologyGraph } from '../src/ontology/graphSync.js';
import { closeNeo4j } from '../src/graph/neo4j.js';
import type { DbContext, PostgresDbContext } from '../src/pipeline/db/client.js';
import { withWatchdog, WatchdogTimeoutError } from './lib/watchdog.js';

interface BackfillSummary {
  documents: number;
  settlements: number;
  created: number;
  edges: number;
  skippedPayment: number;
  skippedInvoice: number;
  skippedNoMap: number;
  skippedNoContract: number;
  dryRun: boolean;
}

function parseLimit(): number {
  const idx = process.argv.indexOf('--limit');
  if (idx === -1) return 200;
  const raw = process.argv[idx + 1];
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 200;
}

async function countBySqlite(
  ctx: Extract<DbContext, { backend: 'sqlite' }>,
  sql: string,
): Promise<number> {
  const r = ctx.sqlite.prepare(sql).get() as { n: number };
  return r.n;
}

async function countByPg(ctx: PostgresDbContext, sql: string): Promise<number> {
  const res = await ctx.pool.query(sql);
  return Number(res.rows[0]?.n ?? 0);
}

/** 待回填 (document_id, user_id) 分组(dry-run 统计与实跑共用口径, 无 user 过滤——
 *  R14: 按属主 user_id 枚举, 不漏掉真实 user_id 的 pending 行)。 */
interface PendingDocGroup {
  docId: string;
  /** 属主 user_id; 共享行(NULL/'')归一为空串。 */
  userId: string;
}

async function listPendingDocGroups(ctx: DbContext, limit: number): Promise<PendingDocGroup[]> {
  const sql = `SELECT DISTINCT document_id, user_id FROM execution_flows
                WHERE ontology_fact_id IS NULL
                ORDER BY document_id, user_id LIMIT ?`;
  if (ctx.backend === 'postgres') {
    const res = await (ctx as PostgresDbContext).pool.query(
      numberPlaceholders(sql), [limit],
    );
    return (res.rows as Array<{ document_id: string; user_id: string | null }>)
      .map((r) => ({ docId: r.document_id, userId: r.user_id ?? '' }));
  }
  return (ctx.sqlite.prepare(sql).all(limit) as Array<{ document_id: string; user_id: string | null }>)
    .map((r) => ({ docId: r.document_id, userId: r.user_id ?? '' }));
}

/** 待回填 settlement 行(dry-run 统计与实跑共用的查询口径, 无 user 过滤)。 */
async function listPendingSettlements(
  ctx: DbContext, limit: number,
): Promise<SettlementRecordInput[]> {
  const sql = `SELECT id, contract_no, contract_ledger_id, settled_quantity, quantity_unit,
                      currency, total_amount, user_id
                 FROM settlement_records
                WHERE ontology_fact_id IS NULL
                ORDER BY created_at, id LIMIT ?`;
  if (ctx.backend === 'postgres') {
    const res = await (ctx as PostgresDbContext).pool.query(
      numberPlaceholders(sql), [limit],
    );
    return res.rows as SettlementRecordInput[];
  }
  return ctx.sqlite.prepare(sql).all(limit) as SettlementRecordInput[];
}

function countPendingFlows(ctx: DbContext): Promise<number> {
  const sql = `SELECT COUNT(*) AS n FROM execution_flows
                WHERE ontology_fact_id IS NULL`;
  return ctx.backend === 'postgres' ? countByPg(ctx as PostgresDbContext, sql) : countBySqlite(ctx, sql);
}

function countPendingSettlements(ctx: DbContext): Promise<number> {
  const sql = `SELECT COUNT(*) AS n FROM settlement_records
                WHERE ontology_fact_id IS NULL`;
  return ctx.backend === 'postgres' ? countByPg(ctx as PostgresDbContext, sql) : countBySqlite(ctx, sql);
}

function addResult(sum: BackfillSummary, r: MaterializeResult): void {
  sum.created += r.created;
  sum.edges += r.edges;
  sum.skippedPayment += r.skippedPayment;
  sum.skippedInvoice += r.skippedInvoice;
  sum.skippedNoMap += r.skippedNoMap;
  sum.skippedNoContract += r.skippedNoContract;
}

/**
 * 确定性资源收尾(R16 根因之一): 脚本无收尾会让 Neo4j driver 连接 + PG pool /
 * SQLite 句柄悬挂事件循环, 叠加慢查询无界 await 形成"脚本末尾挂起"。这里
 * best-effort 关闭全部资源 —— 任一失败只 warn, 绝不遮蔽主流程结果。
 */
async function closeResources(ctx: DbContext): Promise<void> {
  try {
    await closeNeo4j();
  } catch (e) {
    console.warn('[backfill] neo4j driver close failed:', e instanceof Error ? e.message : e);
  }
  try {
    if (ctx.backend === 'postgres') {
      await ctx.pool.end();
    } else {
      ctx.sqlite.close();
    }
  } catch (e) {
    console.warn('[backfill] db context close failed:', e instanceof Error ? e.message : e);
  }
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const limit = parseLimit();
  const ctx = getDbContext();
  console.log(`[backfill] backend=${ctx.backend} dryRun=${dryRun} limit=${limit}`);

  // 正常 / 异常 / dry-run 路径都走收尾(dry-run 也开了 ctx)。
  try {
    const [pendingFlows, pendingSettlements] = await Promise.all([
      countPendingFlows(ctx),
      countPendingSettlements(ctx),
    ]);
    console.log(`[backfill] pending flows=${pendingFlows} settlements=${pendingSettlements}`);

    const sum: BackfillSummary = {
      documents: 0,
      settlements: 0,
      created: 0,
      edges: 0,
      skippedPayment: 0,
      skippedInvoice: 0,
      skippedNoMap: 0,
      skippedNoContract: 0,
      dryRun,
    };

    if (dryRun) {
      // dry-run 分支零写副作用: 只数待处理行, 不调 materialize, 连图同步都不做。
      sum.documents = (await listPendingDocGroups(ctx, limit)).length;
      sum.settlements = (await listPendingSettlements(ctx, limit)).length;
      console.log(JSON.stringify(sum, null, 2));
      console.log('[backfill] dry-run complete; nothing written.');
      return;
    }

    const t0 = performance.now();
    // R15: 收集本次成功物化的 distinct 属主 uid——末尾图同步按属主投影
    // (脚本缺 uid 只投影共享行, dev 实证 nodes=0)。
    const ownerUids = new Set<string>();
    // 1. execution_flows 按 (document_id, user_id) 属主分组回填——R14: 逐组带属主 uid,
    //    materializer 按该 uid 的口径消费该组的 pending 流(owner + 共享行)。
    const groups = await listPendingDocGroups(ctx, limit);
    const tDocs = performance.now();
    for (const g of groups) {
      try {
        const res = await materializeDocumentOntology(ctx, g.docId, g.userId);
        sum.documents += 1;
        addResult(sum, res);
        if (res.attempted > 0) ownerUids.add(g.userId);
        if (res.failures.length > 0) {
          console.error(`[backfill] doc ${g.docId} (user=${g.userId}) partial failures:`, res.failures);
        }
      } catch (e) {
        console.error(`[backfill] FAILED doc ${g.docId} (user=${g.userId}):`, e instanceof Error ? e.message : e);
      }
    }
    console.log(`[backfill] documents loop done: processed=${groups.length} in ${Math.round(performance.now() - tDocs)}ms`);

    // 2. settlement_records 逐行回填(带属主 uid)。
    const settlements = await listPendingSettlements(ctx, limit);
    const tSettlements = performance.now();
    for (const record of settlements) {
      try {
        const res = await materializeSettlementRecord(ctx, record, record.user_id ?? '');
        sum.settlements += 1;
        if (res.created) {
          sum.created += 1; // R11 终审: created 只计新产事实(幂等复用/resource 复用不进 created)。
          ownerUids.add(record.user_id ?? '');
        }
      } catch (e) {
        console.error(`[backfill] FAILED settlement ${record.id}:`, e instanceof Error ? e.message : e);
      }
    }
    console.log(`[backfill] settlements loop done: processed=${settlements.length} in ${Math.round(performance.now() - tSettlements)}ms`);

    // 3. 末尾图投影收敛(await, 脚本要收尾; 非 fire-and-forget)。R15: 逐属主投影,
    //    无属主时保持现状(uid 缺省)。R16: 每个 sync 包看门狗 —— Neo4j session.run
    //    无查询级超时(acquisitionTimeout 只管池等待), 慢/卡查询窗口期形成无界 await;
    //    看门狗把该失败形态变成可观测的超时错误, 按 non-fatal 继续, 不中断其余属主。
    const GRAPH_SYNC_BUDGET_MS = 120_000;
    const graphSyncTargets: Array<{ userId: string | null }> =
      ownerUids.size === 0 ? [{ userId: null }] : [...ownerUids].map((uid) => ({ userId: uid }));
    console.log(`[backfill] graph sync start: ownerUids=${ownerUids.size} targets=${graphSyncTargets.length}`);
    for (const target of graphSyncTargets) {
      const label = target.userId === null ? 'shared' : `user=${target.userId}`;
      try {
        const graph = await withWatchdog(
          target.userId === null
            ? syncOntologyGraph({ ctx })
            : syncOntologyGraph({ ctx, userId: target.userId }),
          GRAPH_SYNC_BUDGET_MS,
          `graph sync (${label})`,
        );
        console.log(`[backfill] graph sync ${label} status=${graph.status} nodes=${graph.nodeCount} edges=${graph.edgeCount}`);
      } catch (e) {
        if (e instanceof WatchdogTimeoutError) {
          console.error(`[backfill] graph sync ${label} timed out after ${GRAPH_SYNC_BUDGET_MS / 1000}s (non-fatal)`);
        } else {
          console.error(`[backfill] graph sync ${label} failed (non-fatal): ${e instanceof Error ? e.message : e}`);
        }
      }
    }

    console.log(
      `[backfill] DONE in ${Math.round(performance.now() - t0)}ms: documents=${sum.documents} settlements=${sum.settlements}`,
    );
    console.log(JSON.stringify(sum, null, 2));
  } finally {
    await closeResources(ctx);
  }
}

main().catch((e) => {
  console.error('[backfill] fatal:', e);
  process.exit(1);
});
