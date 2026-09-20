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
import type { DbContext, PostgresDbContext } from '../src/pipeline/db/client.js';

const USER_SHARED_SCOPE = "(user_id = '' OR user_id IS NULL)";

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

/** 待回填 document 分组(dry-run 统计与实跑共用的查询口径, 双后端)。 */
async function listPendingDocIds(ctx: DbContext, limit: number): Promise<string[]> {
  const sql = `SELECT DISTINCT document_id FROM execution_flows
                WHERE ontology_fact_id IS NULL AND ${USER_SHARED_SCOPE}
                ORDER BY document_id LIMIT ?`;
  if (ctx.backend === 'postgres') {
    const res = await (ctx as PostgresDbContext).pool.query(
      numberPlaceholders(sql), [limit],
    );
    return (res.rows as Array<{ document_id: string }>).map((r) => r.document_id);
  }
  return (ctx.sqlite.prepare(sql).all(limit) as Array<{ document_id: string }>)
    .map((r) => r.document_id);
}

/** 待回填 settlement 行(dry-run 统计与实跑共用的查询口径, 双后端)。 */
async function listPendingSettlements(
  ctx: DbContext, limit: number,
): Promise<SettlementRecordInput[]> {
  const sql = `SELECT id, contract_no, contract_ledger_id, settled_quantity, quantity_unit,
                      currency, total_amount, user_id
                 FROM settlement_records
                WHERE ontology_fact_id IS NULL AND ${USER_SHARED_SCOPE}
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
                WHERE ontology_fact_id IS NULL AND ${USER_SHARED_SCOPE}`;
  return ctx.backend === 'postgres' ? countByPg(ctx as PostgresDbContext, sql) : countBySqlite(ctx, sql);
}

function countPendingSettlements(ctx: DbContext): Promise<number> {
  const sql = `SELECT COUNT(*) AS n FROM settlement_records
                WHERE ontology_fact_id IS NULL AND ${USER_SHARED_SCOPE}`;
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

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const limit = parseLimit();
  const ctx = getDbContext();
  console.log(`[backfill] backend=${ctx.backend} dryRun=${dryRun} limit=${limit}`);

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
    sum.documents = (await listPendingDocIds(ctx, limit)).length;
    sum.settlements = (await listPendingSettlements(ctx, limit)).length;
    console.log(JSON.stringify(sum, null, 2));
    console.log('[backfill] dry-run complete; nothing written.');
    return;
  }

  const t0 = performance.now();
  // 1. execution_flows 按 document 分组回填。
  const docIds = await listPendingDocIds(ctx, limit);
  for (const docId of docIds) {
    try {
      const res = await materializeDocumentOntology(ctx, docId);
      sum.documents += 1;
      addResult(sum, res);
      if (res.failures.length > 0) {
        console.error(`[backfill] doc ${docId} partial failures:`, res.failures);
      }
    } catch (e) {
      console.error(`[backfill] FAILED doc ${docId}:`, e instanceof Error ? e.message : e);
    }
  }

  // 2. settlement_records 逐行回填。
  const settlements = await listPendingSettlements(ctx, limit);
  for (const record of settlements) {
    try {
      const res = await materializeSettlementRecord(ctx, record);
      sum.settlements += 1;
      // R11 终审: created 只计新产事实(幂等复用/resource 复用不进 created)。
      if (res.created) sum.created += 1;
    } catch (e) {
      console.error(`[backfill] FAILED settlement ${record.id}:`, e instanceof Error ? e.message : e);
    }
  }

  // 3. 末尾一次图投影收敛(await, 脚本要收尾; 非 fire-and-forget)。
  try {
    const graph = await syncOntologyGraph({ ctx });
    console.log(`[backfill] graph sync status=${graph.status} nodes=${graph.nodeCount} edges=${graph.edgeCount}`);
  } catch (e) {
    console.error('[backfill] graph sync failed (non-fatal):', e instanceof Error ? e.message : e);
  }

  console.log(
    `[backfill] DONE in ${Math.round(performance.now() - t0)}ms: documents=${sum.documents} settlements=${sum.settlements}`,
  );
  console.log(JSON.stringify(sum, null, 2));
}

main().catch((e) => {
  console.error('[backfill] fatal:', e);
  process.exit(1);
});
