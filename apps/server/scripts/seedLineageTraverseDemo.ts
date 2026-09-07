// apps/server/scripts/seedLineageTraverseDemo.ts
// 链路穿透演示数据(roadmap Item 4 验收 1/2)：
//   合同 C1；服务费桥(保 2 跳可达发票/付款, D9)：S -ALLOCATE_TO-> C1、
//   S -CORRESPONDS_TO-> I1、S -TRIGGERS-> P1；
//   完整主链(保 depth=3 一眼可穿)：R(收货) -ALLOCATE_TO-> C1、R -FEEDS_INTO-> St、
//   St -CORRESPONDS_TO-> I1；核销/冲抵带参：P1 -WRITE_OFF-> I1、P1 -OFFSET_SETTLE-> St；
//   红冲：I2 -REVERSE_ORIGIN-> I1(逆向负数)。
// 幂等：created_by 标记探测，已存在即跳过。RUN(项目根)：
//   npx tsx apps/server/scripts/seedLineageTraverseDemo.ts --dry-run   # 预览
//   npx tsx apps/server/scripts/seedLineageTraverseDemo.ts            # 写入
// 注意：写入的是 .env 指向的库(10.10.0.2 为 PG)；本地默认 SQLite。
// 事实/边一律走 insertTradeFact/insertOntologyEdge(M-1 strict 边界)；
// 合同行无写入 API，直插 contract_ledger(与 projection 测试同形态, user_id='' 共享域)。
import 'dotenv/config';
import { getDbContext } from '../src/pipeline/db/dbBackend.js';
import type { DbContext } from '../src/pipeline/db/client.js';
import type { TradeFactInput, OntologyEdgeInput } from '../src/ontology/repo.js';
import { insertTradeFact, insertOntologyEdge } from '../src/ontology/repo.js';

const MARKER = 'demo-lineage';
const CONTRACT_ID = 'C-DEMO-LIN';
const CONTRACT_NO = 'HT-DEMO-LIN-001';

async function countSeeded(ctx: DbContext): Promise<string> {
  if (ctx.backend === 'postgres') {
    const pg = ctx as { pool: { query: (sql: string) => Promise<{ rows: Array<{ n: string }> }> } };
    const res = await pg.pool.query(
      `SELECT COUNT(*)::text AS n FROM ontology_edges WHERE created_by = '${MARKER}'`);
    return res.rows[0]!.n;
  }
  const sqlite = ctx as { sqlite: { prepare: (sql: string) => { get: () => { n: number } } } };
  return String(sqlite.sqlite
    .prepare(`SELECT COUNT(*) AS n FROM ontology_edges WHERE created_by = '${MARKER}'`).get().n);
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const ctx = getDbContext();
  const existing = await countSeeded(ctx);
  if (existing !== '0') {
    console.log(`demo lineage already seeded (${existing} edges), skip.`);
    return;
  }

  const plan = [
    `contract ${CONTRACT_ID} (${CONTRACT_NO})`,
    'R 收货 500,000 + ALLOCATE_TO->C1 + FEEDS_INTO->St',
    'St 结算 600,000 + CORRESPONDS_TO->I1',
    'I1 发票 800,000(正向)',
    'I2 红冲 -800,000 + REVERSE_ORIGIN->I1',
    'P1 付款 300,000(预付) + WRITE_OFF->I1 + OFFSET_SETTLE->St',
    'S 服务费 50,000 + ALLOCATE_TO->C1 + CORRESPONDS_TO->I1 + TRIGGERS->P1',
  ];
  console.log(dryRun ? '[dry-run] would insert:' : 'inserting:');
  for (const p of plan) console.log('  -', p);
  if (dryRun) return;

  // 合同行(共享域 user_id='')
  if (ctx.backend === 'postgres') {
    const pg = ctx as { pool: { query: (sql: string, vals: unknown[]) => Promise<unknown> } };
    await pg.pool.query(
      `INSERT INTO contract_ledger (id, contract_no, display_contract_no, doc_type, document_id,
          title, fields, field_meta, overall_confidence, needs_review, user_id, contract_type)
       VALUES ($1, $2, $2, '合同', 'doc-demo-lin', '链路穿透演示合同', '{}'::jsonb, '{}'::jsonb, 1, false, '', '采购')
       ON CONFLICT (id) DO NOTHING`,
      [CONTRACT_ID, CONTRACT_NO],
    );
  } else {
    const sqlite = ctx as { sqlite: { prepare: (sql: string) => { run: (...v: unknown[]) => unknown } } };
    sqlite.sqlite.prepare(
      `INSERT OR IGNORE INTO contract_ledger (id, contract_no, display_contract_no, doc_type, document_id,
          title, fields, field_meta, overall_confidence, needs_review, user_id, contract_type)
       VALUES (?, ?, ?, '合同', 'doc-demo-lin', '链路穿透演示合同', '{}', '{}', 1, 0, '', '采购')`,
    ).run(CONTRACT_ID, CONTRACT_NO, CONTRACT_NO);
  }

  const U = '';  // 共享域(与 seedTradeLedgerDemo 一致)
  const mk = (entityType: TradeFactInput['entityType'], payload: Record<string, unknown>, validAt: string) =>
    insertTradeFact(ctx, { entityType, payload, validAt, createdBy: MARKER } as TradeFactInput, U);

  const r = await mk('GoodsReceiptEvent',
    { eventBizType: '正向', amount: 500_000, currency: 'CNY', quantity: 100, unit: '吨' }, '2026-06-05');
  const st = await mk('SettlementEvent',
    { eventBizType: '正向', amount: 600_000, currency: 'CNY', settledQuantity: 100, unit: '吨' }, '2026-06-15');
  const i1 = await mk('InvoiceEvent',
    { invoiceNo: 'INV-LIN-1', invoiceType: '销项', eventBizType: '正向', amount: 800_000, currency: 'CNY' }, '2026-06-20');
  const i2 = await mk('InvoiceEvent',
    { invoiceNo: 'INV-LIN-1', invoiceType: '销项', eventBizType: '逆向', amount: -800_000, currency: 'CNY' }, '2026-06-20');
  const p1 = await mk('PaymentEvent',
    { eventBizType: '正向', amount: 300_000, currency: 'CNY', payType: '预付' }, '2026-06-25');
  const s = await mk('ServiceCostEvent',
    { eventBizType: '正向', amount: 50_000, currency: 'CNY', costType: '物流' }, '2026-06-01');

  const edge = (input: Omit<OntologyEdgeInput, 'createdBy'>) =>
    insertOntologyEdge(ctx, { ...input, createdBy: MARKER }, U);

  await edge({ relation: 'ALLOCATE_TO', fromType: 'GoodsReceiptEvent', fromId: r,
    toType: 'TradeContract', toId: CONTRACT_ID,
    params: { amount: 500_000, ratio: 0.625, method: '金额', batch: 'B-LIN-1' }, validAt: '2026-06-05' });
  await edge({ relation: 'FEEDS_INTO', fromType: 'GoodsReceiptEvent', fromId: r,
    toType: 'SettlementEvent', toId: st, validAt: '2026-06-15' });
  await edge({ relation: 'CORRESPONDS_TO', fromType: 'SettlementEvent', fromId: st,
    toType: 'InvoiceEvent', toId: i1, validAt: '2026-06-20' });
  await edge({ relation: 'REVERSE_ORIGIN', fromType: 'InvoiceEvent', fromId: i2,
    toType: 'InvoiceEvent', toId: i1,
    params: { amount: 800_000, reason: '开票信息有误' }, validAt: '2026-06-20', ingestedAt: '2026-08-05' });
  await edge({ relation: 'WRITE_OFF', fromType: 'PaymentEvent', fromId: p1,
    toType: 'InvoiceEvent', toId: i1,
    params: { amount: 300_000, partial: true, batch: 'WO-LIN-1' }, validAt: '2026-06-25' });
  await edge({ relation: 'OFFSET_SETTLE', fromType: 'PaymentEvent', fromId: p1,
    toType: 'SettlementEvent', toId: st,
    params: { amount: 200_000, batch: 'OS-LIN-1' }, validAt: '2026-06-25' });
  await edge({ relation: 'ALLOCATE_TO', fromType: 'ServiceCostEvent', fromId: s,
    toType: 'TradeContract', toId: CONTRACT_ID,
    params: { amount: 50_000, method: '定额' }, validAt: '2026-06-01' });
  await edge({ relation: 'CORRESPONDS_TO', fromType: 'ServiceCostEvent', fromId: s,
    toType: 'InvoiceEvent', toId: i1, validAt: '2026-06-20' });
  await edge({ relation: 'TRIGGERS', fromType: 'ServiceCostEvent', fromId: s,
    toType: 'PaymentEvent', toId: p1, validAt: '2026-06-25' });

  console.log(`contract = ${CONTRACT_ID} (${CONTRACT_NO})`);
  console.log('验收 1(2 跳可达发票/付款)：');
  console.log(`  curl -b <auth> 'http://localhost:3001/api/ontology/graph/neighbors?type=TradeContract&id=${CONTRACT_ID}&depth=2'`);
  console.log('验收 4(深度上限)：');
  console.log(`  curl -b <auth> '...&depth=4'  # 预期 400`);
}
void main().catch((e) => { console.error(e); process.exit(1); });