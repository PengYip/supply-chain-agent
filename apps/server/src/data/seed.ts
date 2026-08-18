// In-memory seed data for the supply-chain agent MVP (Phase 2).
// Simplified from the frontend mock (src/data/mock.ts) -- only fields needed by
// the 3 read tools are kept. This module does NOT import frontend code (different
// package); data is inlined here so the backend stays self-contained.
//
// MVP: in-memory only. Postgres persistence is deferred to a later phase.

export interface Contract {
  contractNo: string;
  title: string;
  type: '采购' | '销售';
  commodity: string;
  spec: string;
  counterparty: string;
  signedDate: string;
  quantity: number;
  unit: string;
  unitPrice: number; // CNY per unit
  amount: number; // CNY total
  currency: 'CNY';
  deliveryPlace: string;
  paymentTerms: string;
  status: '执行中' | '已完成' | '已归档';
  // Document ids linked to this contract (bill of lading, invoice, etc.).
  // Mutated in-memory by the link_document write tool.
  linkedDocuments: string[];
}

export interface OcrField {
  name: string;
  ocrValue: string;
  confidence: number; // 0..1; <0.7 => needsReview, >=0.9 => autoAccepted
  note?: string;
}

export interface DocumentRecord {
  id: string;
  type: '提单' | '发票' | '装箱单' | '其他';
  content: string;
  // Mock field-level OCR data for verify_document_fields (T4). Demonstrates
  // per-field confidence variance, including at least one low-confidence field.
  ocrFields?: OcrField[];
}

export interface Order {
  orderNo: string;
  contractNo: string;
  commodity: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  amount: number; // CNY
  deliveryStatus: '已发货' | '待发货' | '部分发货' | '已完成';
  shippedQuantity: number;
  // null => 缺发票号: the "uncertainty" scenario the prototype must surface.
  invoiceNo: string | null;
  invoiceStatus: '已开票' | '未开票';
  updateTime: string;
}

export interface InventoryLine {
  warehouse: string;
  commodity: string;
  quantity: number;
  unit: string;
  availableQuantity: number;
  inTransit: number;
  asOfDate: string;
}

// Central contract HT-2024 (diesel procurement, amount 2,860,000 CNY,
// counterparty 华盛集团). 4 related orders + corresponding inventory.
export const contracts: Contract[] = [
  {
    contractNo: 'HT-2024-001',
    title: '0# 柴油采购合同',
    type: '采购',
    commodity: '0# 柴油',
    spec: '0#',
    counterparty: '华盛集团',
    signedDate: '2024-06-01',
    quantity: 1000,
    unit: '吨',
    unitPrice: 2860,
    amount: 2860000,
    currency: 'CNY',
    deliveryPlace: '张家港',
    paymentTerms: '货到验收后 30 天内付款',
    status: '执行中',
    linkedDocuments: ['BL-2024-0815-001'],
  },
];

// Documents available to be linked to a contract (Phase 3a: link_document target).
// T4 verify_document_fields reads `ocrFields` (mock OCR; not a real OCR engine).
export const documents: DocumentRecord[] = [
  {
    id: 'BL-2024-0920-002',
    type: '提单',
    content: '提单 BL-2024-0920-002：0# 柴油 500 吨，装货港 宁波，卸货港 张家港，收货人 华盛集团。',
    ocrFields: [
      { name: '收货人', ocrValue: '华盛集团', confidence: 0.98 },
      { name: '品名', ocrValue: '0# 柴油', confidence: 0.96 },
      {
        name: '数量(吨)',
        ocrValue: '49X0',
        confidence: 0.61,
        note: 'OCR 歧义，疑似 4950 或 4980',
      },
      { name: '金额(元)', ocrValue: '1,425,700', confidence: 0.95 },
      { name: '装货港', ocrValue: '宁波', confidence: 0.97 },
      { name: '卸货港', ocrValue: '张家港', confidence: 0.99 },
    ],
  },
  {
    id: 'FP-2024-0920-009',
    type: '发票',
    content: '增值税专用发票 FP-2024-0920-009：购方 华盛集团，金额 1,430,000 元，税额 18,590 元。',
    ocrFields: [
      { name: '发票号', ocrValue: 'FP-2024-0920-009', confidence: 0.99 },
      { name: '购方名称', ocrValue: '华盛集团', confidence: 0.97 },
      { name: '金额(元)', ocrValue: '1,430,000', confidence: 0.96 },
      { name: '税额(元)', ocrValue: '18,590', confidence: 0.94 },
      {
        name: '开票日期',
        ocrValue: '2024-09-2X',
        confidence: 0.58,
        note: '日期末位 OCR 模糊，疑似 2024-09-20 或 2024-09-27',
      },
    ],
  },
];

export const orders: Order[] = [
  {
    orderNo: 'ORD-2024-0881',
    contractNo: 'HT-2024-001',
    commodity: '0# 柴油',
    quantity: 300,
    unit: '吨',
    unitPrice: 2860,
    amount: 858000,
    deliveryStatus: '已完成',
    shippedQuantity: 300,
    invoiceNo: 'FP-2407-001',
    invoiceStatus: '已开票',
    updateTime: '2024-07-15',
  },
  {
    orderNo: 'ORD-2024-0882',
    contractNo: 'HT-2024-001',
    commodity: '0# 柴油',
    quantity: 250,
    unit: '吨',
    unitPrice: 2860,
    amount: 715000,
    deliveryStatus: '已完成',
    shippedQuantity: 250,
    invoiceNo: 'FP-2407-002',
    invoiceStatus: '已开票',
    updateTime: '2024-07-28',
  },
  {
    orderNo: 'ORD-2024-0883',
    contractNo: 'HT-2024-001',
    commodity: '0# 柴油',
    quantity: 250,
    unit: '吨',
    unitPrice: 2860,
    amount: 715000,
    deliveryStatus: '已发货',
    shippedQuantity: 250,
    invoiceNo: null, // 缺发票号 (uncertainty scenario)
    invoiceStatus: '未开票',
    updateTime: '2024-08-12',
  },
  {
    orderNo: 'ORD-2024-0884',
    contractNo: 'HT-2024-001',
    commodity: '0# 柴油',
    quantity: 200,
    unit: '吨',
    unitPrice: 2860,
    amount: 572000,
    deliveryStatus: '待发货',
    shippedQuantity: 0,
    invoiceNo: null,
    invoiceStatus: '未开票',
    updateTime: '2024-08-15',
  },
];

export const inventory: InventoryLine[] = [
  {
    warehouse: '张家港仓库',
    commodity: '0# 柴油',
    quantity: 12000,
    unit: '吨',
    availableQuantity: 9500,
    inTransit: 500,
    asOfDate: '2024-08-15',
  },
  {
    warehouse: '连云港仓库',
    commodity: '0# 柴油',
    quantity: 8000,
    unit: '吨',
    availableQuantity: 8000,
    inTransit: 0,
    asOfDate: '2024-08-15',
  },
];

// ---- lookup helpers (prefix + case tolerant, so "HT-2024" matches "HT-2024-001") ----

export function findContract(contractNo: string): Contract | undefined {
  const key = contractNo.trim().toLowerCase();
  if (!key) return undefined;
  return (
    contracts.find((c) => c.contractNo.toLowerCase() === key) ??
    contracts.find((c) => c.contractNo.toLowerCase().startsWith(key))
  );
}

export function findOrdersByContract(contractNo: string): Order[] {
  const contract = findContract(contractNo);
  if (!contract) return [];
  return orders.filter((o) => o.contractNo === contract.contractNo);
}

export function findDocument(documentId: string): DocumentRecord | undefined {
  return documents.find((d) => d.id === documentId);
}

// In-memory write used by the link_document tool (L2). Mutates the contract's
// linkedDocuments list and returns a change record. No persistence (Postgres
// comes in a later phase).
export function linkDocumentToContract(
  contractNo: string,
  documentId: string,
):
  | { ok: true; contractNo: string; changeId: string; linkedAt: string }
  | { ok: false; reason: 'contract_not_found' } {
  const contract = findContract(contractNo);
  if (!contract) return { ok: false, reason: 'contract_not_found' };
  const changeId = `CHG-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 6)}`;
  const linkedAt = new Date().toISOString();
  contract.linkedDocuments.push(documentId);
  return { ok: true, contractNo: contract.contractNo, changeId, linkedAt };
}
