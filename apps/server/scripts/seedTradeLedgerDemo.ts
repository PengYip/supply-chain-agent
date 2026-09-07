// apps/server/scripts/seedTradeLedgerDemo.ts
// 台账红冲演示数据(roadmap Item 3 验收 2)：
//   6/15 收票 100 万(6/16 入库)；8/5 红冲 -100 万(追溯 6/15 生效) + REVERSE_ORIGIN 边。
//   红冲不失效原票：逆向负数自动轧差(docx 6.2)。
// 幂等：createdBy 标记探测，已存在即跳过。RUN(项目根)：
//   npx tsx apps/server/scripts/seedTradeLedgerDemo.ts --dry-run   # 预览
//   npx tsx apps/server/scripts/seedTradeLedgerDemo.ts            # 写入
// 注意：写入的是 .env 指向的库(10.10.0.2 为 PG)；本地默认 SQLite 文件。
// 用户归属：所有行以 ''(共享) 写入——repo 读取隔离为 (user_id = ? OR user_id = '')，
//   'demo-user' 行对所有真实用户不可见，'' 行全员共享可见。
import 'dotenv/config';
import { getDbContext } from '../src/pipeline/db/dbBackend.js';
import type { DbContext, PostgresDbContext } from '../src/pipeline/db/client.js';
import { insertTradeFact, insertOntologyEdge } from '../src/ontology/repo.js';

const MARKER = 'demo-trade-ledger';
const INVOICE = (amount: number, eventBizType: '正向' | '逆向') => ({
  invoiceNo: 'INV-1', invoiceType: '销项', eventBizType, amount, currency: 'CNY',
});

/** 已存在的 demo 行计数(createdBy 标记探测，幂等)。 */
async function countSeeded(ctx: DbContext): Promise<string> {
  if (ctx.backend === 'postgres') {
    const pg = ctx as PostgresDbContext;
    const res = await pg.pool.query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM trade_facts WHERE created_by = 'demo-trade-ledger'");
    return res.rows[0]!.n;
  }
  const row = ctx.sqlite.prepare(
    "SELECT COUNT(*) AS n FROM trade_facts WHERE created_by = 'demo-trade-ledger'",
  ).get() as { n: number };
  return String(row.n);
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const ctx = getDbContext();
  const existing = await countSeeded(ctx);
  if (existing !== '0') {
    console.log(`demo facts already seeded (${existing} rows), skip.`);
    return;
  }

  const original = {
    entityType: 'InvoiceEvent' as const,
    payload: INVOICE(1_000_000, '正向'),
    validAt: '2026-06-15', ingestedAt: '2026-06-16', createdBy: MARKER,
  };
  const reversal = {
    entityType: 'InvoiceEvent' as const,
    payload: INVOICE(-1_000_000, '逆向'),
    validAt: '2026-06-15', ingestedAt: '2026-08-05', createdBy: MARKER,
  };
  console.log(dryRun ? '[dry-run] would insert:' : 'inserting:', original, reversal);
  if (dryRun) return;

  const originalId = await insertTradeFact(ctx, original, '');
  const reversalId = await insertTradeFact(ctx, reversal, '');
  await insertOntologyEdge(ctx, {
    relation: 'REVERSE_ORIGIN', fromType: 'InvoiceEvent', fromId: reversalId,
    toType: 'InvoiceEvent', toId: originalId, params: { amount: 1_000_000 },
    validAt: '2026-06-15', ingestedAt: '2026-08-05', createdBy: MARKER,
  }, '');
  console.log('original =', originalId, ' reversal =', reversalId);
  console.log('验收 2 两个答案：');
  console.log(`  当时口径: curl -b <auth> 'http://localhost:3001/api/ontology/entities/InvoiceEvent/${originalId}?asOf=system&at=2026-07-31T23:59:59.000Z'  # netAmount = 1000000`);
  console.log(`  最新口径: curl -b <auth> 'http://localhost:3001/api/ontology/entities/InvoiceEvent/${originalId}'  # netAmount = 0`);
}

void main().catch((e) => { console.error(e); process.exit(1); });