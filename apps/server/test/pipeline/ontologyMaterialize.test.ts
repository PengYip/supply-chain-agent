// apps/server/test/pipeline/ontologyMaterialize.test.ts
// 实体化映射器(Wave 2 核心): execution_flows/settlement_records -> 本体事实 + ALLOCATE_TO 边
// + ontology_fact_id 幂等回写。:memory: + migrate; 本体读取走 repo 只读边界。
import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate, type DbContext } from '../../src/pipeline/db/client.js';
import { asOfBusinessTime } from '../../src/ontology/asof.js';
import { listTradeFactsAsOf, listOntologyEdgesAsOf } from '../../src/ontology/repo.js';
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
    expect(facts[0]!.payload).toMatchObject({ amount: 900000, currency: 'CNY', settledQuantity: 620 });
    // 注册表 SSOT: SettlementEvent 无 contractNo 词汇、ALLOCATE_TO 白名单不收 SettlementEvent——
    // 结算事实经 contract_ledger_id 溯源(settlement_records 侧), 本体内无合同挂接。
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