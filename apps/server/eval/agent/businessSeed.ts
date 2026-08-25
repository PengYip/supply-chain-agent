// Deterministic DB seed for the core agent eval dataset. The production tools
// are DB-only, so core scenarios need an in-memory contract ledger and
// materialized execution flows instead of the retired module-level seed.
import { buildLedgerEntryFromExtraction } from '../../src/pipeline/contractLedger.js';
import {
  saveBinding,
  upsertContractLedgerEntry,
  upsertExecutionFlow,
} from '../../src/pipeline/db/repositories.js';
import type { DbContext } from '../../src/pipeline/db/client.js';

const CONTRACT_NO = 'HT-2024-001';

function insertEvalDocument(ctx: DbContext, documentId: string, docType: '合同' | '货转单' | '发票'): void {
  const blockModel = JSON.stringify({
    docId: documentId,
    docType,
    modality: 'digital',
    blocks: [],
    sourceUri: `eval://${documentId}`,
    createdAt: new Date().toISOString(),
  });
  ctx.sqlite
    .prepare(
      `INSERT OR IGNORE INTO documents
         (id, doc_type, modality, source_uri, block_model, user_id, parse_status)
       VALUES (?, ?, 'digital', ?, ?, '', 'parsed')`,
    )
    .run(documentId, docType, `eval://${documentId}`, blockModel);
}

async function materializeFlow(
  ctx: DbContext,
  input: {
    documentId: string;
    flowType: '货物流' | '发票流';
    direction: 'in' | 'out';
    amount?: number;
    quantityTon?: number;
    unit?: string;
    voucherDate: string;
  },
): Promise<void> {
  insertEvalDocument(ctx, input.documentId, input.flowType === '发票流' ? '发票' : '货转单');
  const bindingId = await saveBinding(ctx, {
    documentId: input.documentId,
    contractNo: CONTRACT_NO,
    relation: 'primary',
    sourceRefs: [],
    confidence: 1,
    createdBy: 'eval-seed',
    status: 'confirmed',
    confirmationSource: 'human',
    proposedBy: 'agent',
  });
  await upsertExecutionFlow(ctx, {
    bindingId,
    documentId: input.documentId,
    contractNo: CONTRACT_NO,
    flowType: input.flowType,
    direction: input.direction,
    amount: input.amount ?? null,
    quantityTon: input.quantityTon ?? null,
    unit: input.unit ?? null,
    docType: input.flowType === '发票流' ? '发票' : '货转单',
    voucherDate: input.voucherDate,
    confidence: 1,
    createdBy: 'eval-seed',
  });
}

/** Seed the contract + flows used by datasets/core.yaml (each episode gets a fresh DB). */
export async function seedCoreBusinessState(ctx: DbContext): Promise<void> {
  insertEvalDocument(ctx, 'DOC-CONTRACT-HT-2024-001', '合同');
  const entry = buildLedgerEntryFromExtraction({
    documentId: 'DOC-CONTRACT-HT-2024-001',
    docType: '合同',
    contractType: '采购',
    fields: {
      合同号: { value: CONTRACT_NO, sourceSpans: [] },
      甲方: { value: '华盛集团', sourceSpans: [] },
      乙方: { value: '中石化销售有限公司', sourceSpans: [] },
      标的物: { value: '0#柴油', sourceSpans: [] },
      数量: { value: 800, sourceSpans: [] },
      单位: { value: '吨', sourceSpans: [] },
      金额: { value: 2860000, sourceSpans: [] },
      币种: { value: 'CNY', sourceSpans: [] },
      付款条款: { value: '货到验收后 30 天内付款', sourceSpans: [] },
    },
    fieldMeta: {
      合同号: { strength: 'exact', confidence: 0.99 },
      甲方: { strength: 'exact', confidence: 0.98 },
      乙方: { strength: 'exact', confidence: 0.98 },
      标的物: { strength: 'exact', confidence: 0.97 },
      数量: { strength: 'exact', confidence: 0.98 },
      单位: { strength: 'exact', confidence: 0.99 },
      金额: { strength: 'exact', confidence: 0.98 },
      币种: { strength: 'exact', confidence: 0.99 },
      付款条款: { strength: 'exact', confidence: 0.96 },
    },
  });
  if (!entry) throw new Error('core eval ledger seed could not be built');
  await upsertContractLedgerEntry(ctx, entry);

  // Goods total is 793 tons against an 800-ton ledger, preserving the core
  // reconciliation anomaly without a hardcoded tool-side counterparty value.
  await materializeFlow(ctx, { documentId: 'DOC-GOODS-0881', flowType: '货物流', direction: 'in', quantityTon: 300, unit: '吨', voucherDate: '2024-07-15' });
  await materializeFlow(ctx, { documentId: 'DOC-GOODS-0882', flowType: '货物流', direction: 'in', quantityTon: 250, unit: '吨', voucherDate: '2024-07-28' });
  await materializeFlow(ctx, { documentId: 'DOC-GOODS-0883', flowType: '货物流', direction: 'in', quantityTon: 200, unit: '吨', voucherDate: '2024-08-12' });
  await materializeFlow(ctx, { documentId: 'DOC-GOODS-0884', flowType: '货物流', direction: 'in', quantityTon: 43, unit: '吨', voucherDate: '2024-08-15' });

  // Invoice total is 2,835,000 against a 2,860,000 ledger. The first two
  // invoices share document IDs with goods flows; 0883/0884 remain missing.
  await materializeFlow(ctx, { documentId: 'DOC-GOODS-0881', flowType: '发票流', direction: 'in', amount: 858000, voucherDate: '2024-07-15' });
  await materializeFlow(ctx, { documentId: 'DOC-GOODS-0882', flowType: '发票流', direction: 'in', amount: 715000, voucherDate: '2024-07-28' });
  await materializeFlow(ctx, { documentId: 'DOC-INVOICE-RECON-001', flowType: '发票流', direction: 'in', amount: 1262000, voucherDate: '2024-08-20' });
}
