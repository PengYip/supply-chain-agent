// apps/server/test/pipeline/ontologyMaterialize.test.ts
// 实体化映射器(Wave 2 核心): execution_flows/settlement_records -> 本体事实 + ALLOCATE_TO 边
// + ontology_fact_id 幂等回写。:memory: + migrate; 本体读取走 repo 只读边界。
import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import { asOfBusinessTime } from '../../src/ontology/asof.js';
import { listTradeFactsAsOf, listOntologyEdgesAsOf, getTradeFactById } from '../../src/ontology/repo.js';
import {
  materializeDocumentOntology, materializeDocumentOntologySafe,
  materializeSettlementRecord, materializeSettlementRecordSafe,
} from '../../src/pipeline/ontologyMaterialize.js';

let ctx: DbContext;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
});

const BUSY = '2099-01-01T00:00:00.000Z';

const insertContract = (id: string, contractNo: string) => {
  ctx.sqlite.prepare(
    `INSERT INTO contract_ledger (id, contract_no, display_contract_no, doc_type, document_id,
        title, fields, field_meta, overall_confidence, needs_review, user_id, contract_type)
     VALUES (?, ?, ?, '合同', 'doc-1', '', '{}', '{}', 1, 0, '', '采购')`,
  ).run(id, contractNo, contractNo);
};

const insertDoc = (id: string) => {
  ctx.sqlite.prepare(
    `INSERT INTO documents (id, doc_type, modality, source_uri, block_model, user_id, review_status, parse_status)
     VALUES (?, '合同', 'text', '/ingest/x.pdf', 'raw', '', 'pending', 'uploaded')`,
  ).run(id);
};

const insertFlow = (r: {
  id: string; docId: string; contractNo: string; flowType: string; direction: 'in' | 'out';
  amount?: number | null; quantity?: number | null; unit?: string | null; voucherDate?: string | null;
}) => {
  ctx.sqlite.prepare(
    `INSERT INTO execution_flows (id, binding_id, document_id, contract_no, flow_type, direction,
        amount, quantity_ton, unit, doc_type, voucher_date, created_by, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '合同', ?, 'agent', '')`,
  ).run(r.id, `B-${r.id}`, r.docId, r.contractNo, r.flowType, r.direction,
    r.amount ?? null, r.quantity ?? null, r.unit ?? null, r.voucherDate ?? null);
};

const insertExtraction = (docId: string, fields: Record<string, unknown>) => {
  ctx.sqlite.prepare(
    `INSERT INTO extractions (id, document_id, doc_type, fields, field_meta, overall_confidence, needs_review, user_id)
     VALUES (?, ?, '合同', ?, '{}', 1, 0, '')`,
  ).run(`EX-${docId}`, docId, JSON.stringify(fields));
};

const factsOf = (entityType: string) =>
  listTradeFactsAsOf(ctx, asOfBusinessTime(BUSY), { entityType }, 'u1');
const edgesOf = (relation: string) =>
  listOntologyEdgesAsOf(ctx, asOfBusinessTime(BUSY), { relation }, 'u1');

const flowFactId = (id: string): string | null => {
  const r = ctx.sqlite.prepare('SELECT ontology_fact_id AS f FROM execution_flows WHERE id = ?').get(id) as { f: string | null };
  return r.f;
};

describe('materializeDocumentOntology (business-loop wave2)', () => {
  it('1) 货物流 in + quantity -> GoodsReceiptEvent 事实(documentId 回填) + ALLOCATE_TO(quantity,method:数量)边 + 回写; 重跑幂等', async () => {
    insertDoc('DOC-1');
    insertContract('CL-1', 'HT-1');
    insertFlow({ id: 'F-1', docId: 'DOC-1', contractNo: 'HT-1', flowType: '货物流', direction: 'in', quantity: 620, unit: '吨', voucherDate: '2026-09-01T00:00:00Z' });
    const res = await materializeDocumentOntology(ctx, 'DOC-1', 'u1');
    expect(res).toMatchObject({ attempted: 1, created: 1, edges: 1, skippedNoContract: 0, failures: [] });
    const facts = await factsOf('GoodsReceiptEvent');
    expect(facts).toHaveLength(1);
    expect(facts[0]!.payload).toMatchObject({ eventBizType: '正向', quantity: 620, unit: '吨' });
    expect(facts[0]!.documentId).toBe('DOC-1');
    const edges = await edgesOf('ALLOCATE_TO');
    expect(edges).toHaveLength(1);
    expect(edges[0]!.params).toMatchObject({ quantity: 620, method: '数量' });
    expect(edges[0]!.toId).toBe('CL-1');
    expect(flowFactId('F-1')).toBe(facts[0]!.id);
    // 幂等重跑: 已回写 flow 不再出现在待处理集
    const again = await materializeDocumentOntology(ctx, 'DOC-1', 'u1');
    expect(again.attempted).toBe(0);
    expect(again.created).toBe(0);
  });

  it('2) 资金流 out 无款项类型关键词 -> skippedPayment=1, 无事实无回写', async () => {
    insertDoc('DOC-2');
    insertContract('CL-1', 'HT-1');
    insertFlow({ id: 'F-2', docId: 'DOC-2', contractNo: 'HT-1', flowType: '资金流', direction: 'out', amount: 100_000 });
    const res = await materializeDocumentOntology(ctx, 'DOC-2', 'u1');
    expect(res).toMatchObject({ attempted: 1, created: 0, edges: 0, skippedPayment: 1, failures: [] });
    expect(await factsOf('PaymentEvent')).toHaveLength(0);
    expect(flowFactId('F-2')).toBeNull();
  });

  it('3) 资金流 out + extraction fields 含"预付款 30%" -> PaymentEvent(payType=预付, contractNo 归属)', async () => {
    insertDoc('DOC-3');
    insertContract('CL-1', 'HT-1');
    insertExtraction('DOC-3', { '款项类型': '预付款 30%' });
    insertFlow({ id: 'F-3', docId: 'DOC-3', contractNo: 'HT-1', flowType: '资金流', direction: 'out', amount: 100_000 });
    const res = await materializeDocumentOntology(ctx, 'DOC-3', 'u1');
    // 款/票归属走 payload.contractNo（注册表 ALLOCATE_TO 白名单不收 PaymentEvent），不建边
    expect(res).toMatchObject({ created: 1, edges: 0, skippedPayment: 0, failures: [] });
    const facts = await factsOf('PaymentEvent');
    expect(facts).toHaveLength(1);
    expect(facts[0]!.payload).toMatchObject({ payType: '预付', contractNo: 'HT-1', amount: 100_000 });
  });

  it('4) 发票流 in 无发票号 -> skippedInvoice=1', async () => {
    insertDoc('DOC-4');
    insertFlow({ id: 'F-4', docId: 'DOC-4', contractNo: 'HT-1', flowType: '发票流', direction: 'in', amount: 50_000 });
    const res = await materializeDocumentOntology(ctx, 'DOC-4', 'u1');
    expect(res).toMatchObject({ attempted: 1, created: 0, skippedInvoice: 1, failures: [] });
    expect(flowFactId('F-4')).toBeNull();
  });

  it('5) 发票流 out + extraction 发票号码 -> InvoiceEvent(invoiceType=销项, contractNo 归属)', async () => {
    insertDoc('DOC-5');
    insertContract('CL-1', 'HT-1');
    insertExtraction('DOC-5', { '发票号码': 'INV-9' });
    insertFlow({ id: 'F-5', docId: 'DOC-5', contractNo: 'HT-1', flowType: '发票流', direction: 'out', amount: 50_000 });
    const res = await materializeDocumentOntology(ctx, 'DOC-5', 'u1');
    // 票归属走 payload.contractNo（ALLOCATE_TO 白名单不收 InvoiceEvent），不建边
    expect(res).toMatchObject({ created: 1, edges: 0, failures: [] });
    const facts = await factsOf('InvoiceEvent');
    expect(facts).toHaveLength(1);
    expect(facts[0]!.payload).toMatchObject({ invoiceNo: 'INV-9', invoiceType: '销项', amount: 50_000, contractNo: 'HT-1' });
  });

  it('6) 合同台账无该 contract_no -> 事实 created=1 但 edges=0 skippedNoContract=1', async () => {
    insertDoc('DOC-6');
    insertFlow({ id: 'F-6', docId: 'DOC-6', contractNo: 'HT-NOPE', flowType: '货物流', direction: 'in', quantity: 100, unit: '吨' });
    const res = await materializeDocumentOntology(ctx, 'DOC-6', 'u1');
    expect(res).toMatchObject({ created: 1, edges: 0, skippedNoContract: 1, failures: [] });
    expect(await edgesOf('ALLOCATE_TO')).toHaveLength(0);
    expect(flowFactId('F-6')).not.toBeNull(); // 事实已产出并回写
  });
});

describe('materializeSettlementRecord (business-loop wave2)', () => {
  it('7) settlement_records -> SettlementEvent + 回写; 重跑幂等', async () => {
    insertContract('CL-1', 'HT-1');
    ctx.sqlite.prepare(
      `INSERT INTO settlement_records (id, contract_no, contract_ledger_id, settled_quantity, quantity_unit, currency, total_amount, created_by, user_id)
       VALUES ('SR-1', 'HT-1', 'CL-1', 620, '吨', 'CNY', 900000, 'agent', '')`,
    ).run();
    const record = {
      id: 'SR-1', contract_no: 'HT-1', contract_ledger_id: 'CL-1',
      settled_quantity: 620, quantity_unit: '吨', currency: 'CNY', total_amount: 900000, user_id: '',
    };
    const r1 = await materializeSettlementRecord(ctx, record, 'u1');
    expect(r1.factId).not.toBeNull();
    const facts = await factsOf('SettlementEvent');
    expect(facts).toHaveLength(1);
    expect(facts[0]!.payload).toMatchObject({ amount: 900000, currency: 'CNY', settledQuantity: 620, contractNo: 'HT-1' });
    // R10(2026-09-20): SettlementEvent 已补 contractNo 词汇——结算事实经 payload.contractNo 归属合同;
    // ALLOCATE_TO 白名单仍不收 SettlementEvent, 无归属边。
    expect(await edgesOf('ALLOCATE_TO')).toHaveLength(0);
    const wb = ctx.sqlite.prepare('SELECT ontology_fact_id AS f FROM settlement_records WHERE id = ?').get('SR-1') as { f: string };
    expect(wb.f).toBe(r1.factId);
    // 重跑幂等: 已回写 -> 返回同一 factId, 不产新事实
    const r2 = await materializeSettlementRecord(ctx, record, 'u1');
    expect(r2.factId).toBe(r1.factId);
    expect(await factsOf('SettlementEvent')).toHaveLength(1);
  });
});

describe('safe wrappers (business-loop wave2)', () => {
  it('8) materializeDocumentOntologySafe / materializeSettlementRecordSafe 吞错', async () => {
    await expect(materializeDocumentOntologySafe(ctx, 'DOC-404', 'u1')).resolves.toBeUndefined();
    await expect(materializeDocumentOntologySafe(null as never, 'DOC-404', 'u1')).resolves.toBeUndefined();
    const record = {
      id: 'SR-404', contract_no: 'X', contract_ledger_id: null,
      settled_quantity: null, quantity_unit: null, currency: null, total_amount: 1, user_id: '',
    };
    await expect(materializeSettlementRecordSafe(ctx, record, 'u1')).resolves.toBeUndefined();
  });
});

describe('R11 refresh-proof idempotency (wave2 final review)', () => {
  it('等价重建: refresh 删全重建同值流水 -> 复用原事实, 不增事实不增边', async () => {
    insertDoc('DOC-R1');
    insertContract('CL-1', 'HT-1');
    insertFlow({ id: 'F-1', docId: 'DOC-R1', contractNo: 'HT-1', flowType: '货物流', direction: 'in', quantity: 620, unit: '吨', voucherDate: '2026-09-01T00:00:00Z' });
    const r1 = await materializeDocumentOntology(ctx, 'DOC-R1', 'u1');
    expect(r1.created).toBe(1);
    const originalFactId = flowFactId('F-1')!;
    expect(originalFactId).not.toBeNull();
    expect(await edgesOf('ALLOCATE_TO')).toHaveLength(1);
    // 模拟 refresh: DELETE 全部流水 + 重建同值流水(新 id, ontology_fact_id 为空)
    ctx.sqlite.prepare('DELETE FROM execution_flows WHERE document_id = ?').run('DOC-R1');
    insertFlow({ id: 'F-1b', docId: 'DOC-R1', contractNo: 'HT-1', flowType: '货物流', direction: 'in', quantity: 620, unit: '吨', voucherDate: '2026-09-01T00:00:00Z' });
    const r2 = await materializeDocumentOntology(ctx, 'DOC-R1', 'u1');
    expect(r2.created).toBe(0); // 复用不计 created
    expect(r2.edges).toBe(0);
    expect(await factsOf('GoodsReceiptEvent')).toHaveLength(1); // 事实数不变
    expect(flowFactId('F-1b')).toBe(originalFactId); // 新流水指向原事实
    expect(await edgesOf('ALLOCATE_TO')).toHaveLength(1); // 边数不变(原边仍现行)
  });

  it('差异重建: 重建流水 amount 变化 -> 旧事实/旧边失效, 新事实/新边现行', async () => {
    insertDoc('DOC-R2');
    insertContract('CL-1', 'HT-1');
    insertFlow({ id: 'F-2', docId: 'DOC-R2', contractNo: 'HT-1', flowType: '货物流', direction: 'in', quantity: 620, unit: '吨', voucherDate: '2026-09-01T00:00:00Z' });
    const r1 = await materializeDocumentOntology(ctx, 'DOC-R2', 'u1');
    expect(r1.created).toBe(1);
    const oldFactId = flowFactId('F-2')!;
    const oldEdge = ctx.sqlite.prepare('SELECT id FROM ontology_edges WHERE from_id = ?').get(oldFactId) as { id: string };
    // 模拟 refresh: amount 变化
    ctx.sqlite.prepare('DELETE FROM execution_flows WHERE document_id = ?').run('DOC-R2');
    insertFlow({ id: 'F-2b', docId: 'DOC-R2', contractNo: 'HT-1', flowType: '货物流', direction: 'in', quantity: 620, unit: '吨', amount: 700, voucherDate: '2026-09-01T00:00:00Z' });
    const r2 = await materializeDocumentOntology(ctx, 'DOC-R2', 'u1');
    expect(r2.created).toBe(1);
    // 旧事实失效(审计链保留行)
    const old = await getTradeFactById(ctx, oldFactId, 'u1');
    expect(old?.invalidAt).not.toBeNull();
    // 旧边失效
    const oldEdgeRow = ctx.sqlite.prepare('SELECT invalid_at FROM ontology_edges WHERE id = ?').get(oldEdge.id) as { invalid_at: string | null };
    expect(oldEdgeRow.invalid_at).not.toBeNull();
    // 新事实现行 + 新边现行
    const currentFacts = await factsOf('GoodsReceiptEvent');
    expect(currentFacts).toHaveLength(1);
    expect(currentFacts[0]!.id).not.toBe(oldFactId);
    expect(currentFacts[0]!.payload).toMatchObject({ amount: 700, currency: 'CNY', quantity: 620 });
    const currentEdges = await edgesOf('ALLOCATE_TO');
    expect(currentEdges).toHaveLength(1);
    expect(currentEdges[0]!.fromId).toBe(currentFacts[0]!.id);
  });

  it('并发认领: 预置 fact_id 非空不在待处理集; 条件认领不覆盖已有值', async () => {
    insertDoc('DOC-R3');
    insertContract('CL-1', 'HT-1');
    insertFlow({ id: 'F-3', docId: 'DOC-R3', contractNo: 'HT-1', flowType: '货物流', direction: 'in', quantity: 620, unit: '吨' });
    // 预置认领(TF-PRESET 表示并发 materializer 已认领)
    ctx.sqlite.prepare('UPDATE execution_flows SET ontology_fact_id = ? WHERE id = ?').run('TF-PRESET', 'F-3');
    const r = await materializeDocumentOntology(ctx, 'DOC-R3', 'u1');
    expect(r.attempted).toBe(0);
    expect(r.created).toBe(0);
    expect(flowFactId('F-3')).toBe('TF-PRESET'); // 未被覆盖
    // 条件认领守卫: 已认领的 flow 再次认领不覆盖(WHERE ontology_fact_id IS NULL)
    const changes = ctx.sqlite.prepare(
      'UPDATE execution_flows SET ontology_fact_id = ? WHERE id = ? AND ontology_fact_id IS NULL',
    ).run('TF-OTHER', 'F-3').changes;
    expect(changes).toBe(0);
  });
});

describe('R12 multi-binding fact matching (wave2 final review round 2)', () => {
  it('多绑定首次: 同 doc 两笔货物流各绑定不同合同 -> 两事实两 ALLOCATE_TO 边, 无收敛', async () => {
    insertDoc('DOC-M1');
    insertContract('CL-1', 'HT-1');
    insertContract('CL-2', 'HT-2');
    insertFlow({ id: 'F-1', docId: 'DOC-M1', contractNo: 'HT-1', flowType: '货物流', direction: 'in', quantity: 620, unit: '吨', voucherDate: '2026-09-01T00:00:00Z' });
    insertFlow({ id: 'F-2', docId: 'DOC-M1', contractNo: 'HT-2', flowType: '货物流', direction: 'in', quantity: 620, unit: '吨', voucherDate: '2026-09-01T00:00:00Z' });
    const res = await materializeDocumentOntology(ctx, 'DOC-M1', 'u1');
    expect(res.created).toBe(2); // 无收敛
    const facts = await factsOf('GoodsReceiptEvent');
    expect(facts).toHaveLength(2);
    const edges = await edgesOf('ALLOCATE_TO');
    expect(edges).toHaveLength(2);
    // 两条流各自认领不同 fact id
    const f1Fact = flowFactId('F-1')!;
    const f2Fact = flowFactId('F-2')!;
    expect(f1Fact).not.toBe(f2Fact);
    // 边各指各合同(流-事实-边一一对应)
    expect(edges.find((e) => e.fromId === f1Fact)?.toId).toBe('CL-1');
    expect(edges.find((e) => e.fromId === f2Fact)?.toId).toBe('CL-2');
  });

  it('多绑定刷新: 重建两流(同值) -> 事实数不变, 两流各自认领原 fact id, 无新边', async () => {
    insertDoc('DOC-M2');
    insertContract('CL-1', 'HT-1');
    insertContract('CL-2', 'HT-2');
    insertFlow({ id: 'F-1', docId: 'DOC-M2', contractNo: 'HT-1', flowType: '货物流', direction: 'in', quantity: 620, unit: '吨', voucherDate: '2026-09-01T00:00:00Z' });
    insertFlow({ id: 'F-2', docId: 'DOC-M2', contractNo: 'HT-2', flowType: '货物流', direction: 'in', quantity: 620, unit: '吨', voucherDate: '2026-09-01T00:00:00Z' });
    await materializeDocumentOntology(ctx, 'DOC-M2', 'u1');
    const f1First = flowFactId('F-1')!;
    const f2First = flowFactId('F-2')!;
    expect(f1First).not.toBe(f2First);
    // 模拟 refresh: DELETE + 重建两流(同值, 新 id)
    ctx.sqlite.prepare('DELETE FROM execution_flows WHERE document_id = ?').run('DOC-M2');
    insertFlow({ id: 'F-1b', docId: 'DOC-M2', contractNo: 'HT-1', flowType: '货物流', direction: 'in', quantity: 620, unit: '吨', voucherDate: '2026-09-01T00:00:00Z' });
    insertFlow({ id: 'F-2b', docId: 'DOC-M2', contractNo: 'HT-2', flowType: '货物流', direction: 'in', quantity: 620, unit: '吨', voucherDate: '2026-09-01T00:00:00Z' });
    const res = await materializeDocumentOntology(ctx, 'DOC-M2', 'u1');
    expect(res.created).toBe(0); // 全部复用
    expect(res.edges).toBe(0);   // 无新边
    expect(await factsOf('GoodsReceiptEvent')).toHaveLength(2); // 事实数不变
    // 边目标优先配对: HT-1 流回 f1First, HT-2 流回 f2First(确定性)
    expect(flowFactId('F-1b')).toBe(f1First);
    expect(flowFactId('F-2b')).toBe(f2First);
    expect(await edgesOf('ALLOCATE_TO')).toHaveLength(2);
  });

  it('绑定移除: 只重建一流 -> 未被认领的旧事实失效、其边失效, 存活流事实现行', async () => {
    insertDoc('DOC-M3');
    insertContract('CL-1', 'HT-1');
    insertContract('CL-2', 'HT-2');
    insertFlow({ id: 'F-1', docId: 'DOC-M3', contractNo: 'HT-1', flowType: '货物流', direction: 'in', quantity: 620, unit: '吨', voucherDate: '2026-09-01T00:00:00Z' });
    insertFlow({ id: 'F-2', docId: 'DOC-M3', contractNo: 'HT-2', flowType: '货物流', direction: 'in', quantity: 620, unit: '吨', voucherDate: '2026-09-01T00:00:00Z' });
    await materializeDocumentOntology(ctx, 'DOC-M3', 'u1');
    const f1First = flowFactId('F-1')!;
    const f2First = flowFactId('F-2')!;
    // 模拟 refresh: 只重建 HT-1 那笔(HT-2 绑定被移除)
    ctx.sqlite.prepare('DELETE FROM execution_flows WHERE document_id = ?').run('DOC-M3');
    insertFlow({ id: 'F-1c', docId: 'DOC-M3', contractNo: 'HT-1', flowType: '货物流', direction: 'in', quantity: 620, unit: '吨', voucherDate: '2026-09-01T00:00:00Z' });
    const res = await materializeDocumentOntology(ctx, 'DOC-M3', 'u1');
    expect(res.created).toBe(0);
    expect(flowFactId('F-1c')).toBe(f1First); // 存活流认领原事实
    // 被移除绑定的旧事实失效(孤儿清扫)
    const removed = await getTradeFactById(ctx, f2First, 'u1');
    expect(removed?.invalidAt).not.toBeNull();
    // 其边失效
    const removedEdge = ctx.sqlite.prepare('SELECT invalid_at FROM ontology_edges WHERE from_id = ?').get(f2First) as { invalid_at: string | null };
    expect(removedEdge.invalid_at).not.toBeNull();
    // 存活事实现行
    expect((await getTradeFactById(ctx, f1First, 'u1'))?.invalidAt).toBeNull();
    const edges = await edgesOf('ALLOCATE_TO');
    expect(edges).toHaveLength(1);
    expect(edges[0]!.fromId).toBe(f1First);
  });
});

describe('R13 sequential-binding mode discrimination (wave2 final review round 3)', () => {
  it('顺序绑定主路径: 首流已认领后新增同实体流 -> plain insert, 不复用吞事实, TF-1 无恙', async () => {
    insertDoc('DOC-S1');
    insertContract('CL-1', 'HT-1');
    insertContract('CL-2', 'HT-2');
    insertFlow({ id: 'F-1', docId: 'DOC-S1', contractNo: 'HT-1', flowType: '货物流', direction: 'in', quantity: 620, unit: '吨', voucherDate: '2026-09-01T00:00:00Z' });
    const r1 = await materializeDocumentOntology(ctx, 'DOC-S1', 'u1');
    expect(r1.created).toBe(1);
    const tf1 = flowFactId('F-1')!;
    // 顺序绑定: 第二次确认新增第二笔流(contract B, 同实体同数量)——此时 F-1 已带 fact_id
    insertFlow({ id: 'F-2', docId: 'DOC-S1', contractNo: 'HT-2', flowType: '货物流', direction: 'in', quantity: 620, unit: '吨', voucherDate: '2026-09-01T00:00:00Z' });
    const r2 = await materializeDocumentOntology(ctx, 'DOC-S1', 'u1');
    expect(r2.created).toBe(1); // plain insert 独立新建
    const tf2 = flowFactId('F-2')!;
    expect(tf2).not.toBe(tf1); // 不复用吞事实
    expect((await getTradeFactById(ctx, tf1, 'u1'))?.invalidAt).toBeNull(); // TF-1 无恙
    // 两事实两 ALLOCATE_TO 边各指各合同
    expect(await factsOf('GoodsReceiptEvent')).toHaveLength(2);
    const edges = await edgesOf('ALLOCATE_TO');
    expect(edges).toHaveLength(2);
    expect(edges.find((e) => e.fromId === tf1)?.toId).toBe('CL-1');
    expect(edges.find((e) => e.fromId === tf2)?.toId).toBe('CL-2');
  });

  it('顺序绑定资金流版: 新增流 contractNo 不同 -> plain insert, 不触发差异换代, TF-1 无恙', async () => {
    insertDoc('DOC-S2');
    insertContract('CL-1', 'HT-1');
    insertContract('CL-2', 'HT-2');
    insertExtraction('DOC-S2', { '款项类型': '预付款' });
    insertFlow({ id: 'F-1', docId: 'DOC-S2', contractNo: 'HT-1', flowType: '资金流', direction: 'out', amount: 100_000, voucherDate: '2026-09-01T00:00:00Z' });
    await materializeDocumentOntology(ctx, 'DOC-S2', 'u1');
    const tf1 = flowFactId('F-1')!;
    expect(tf1).not.toBeNull();
    // 顺序绑定: 新增第二笔资金流(contract B)——增量模式 plain insert
    insertFlow({ id: 'F-2', docId: 'DOC-S2', contractNo: 'HT-2', flowType: '资金流', direction: 'out', amount: 100_000, voucherDate: '2026-09-01T00:00:00Z' });
    const r2 = await materializeDocumentOntology(ctx, 'DOC-S2', 'u1');
    expect(r2.created).toBe(1);
    const tf2 = flowFactId('F-2')!;
    expect(tf2).not.toBe(tf1);
    expect((await getTradeFactById(ctx, tf1, 'u1'))?.invalidAt).toBeNull(); // TF-1 无恙(不误失效)
    const facts = await factsOf('PaymentEvent');
    expect(facts).toHaveLength(2);
    expect(facts.find((f) => f.id === tf2)?.payload).toMatchObject({ contractNo: 'HT-2' });
  });
});
