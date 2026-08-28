// Stable pipeline contract: every ingest adapter normalizes to BlockModel;
// every downstream stage (extraction, validation, confidence) consumes BlockModel.

export type DocType =
  | '合同' | '补充合同' | '立项书' | '履约凭证'
  | '重量凭证'
  | '结算单' | '质检报告' | '化验报告' | '货转单' | '提单' | '装箱单'
  | '运输凭证' | '收货单' | '发货单' | '汽运磅单' | '火运大票' | '轨道衡称重单' | '水尺计重单' | '派船通知单'
  | '资金凭证' | '付款单' | '付款凭证'
  | '发票凭证' | '发票' | '进项票' | '销项票'
  | '其他';
export type Modality = 'digital' | 'scanned';
export type BlockType = 'text' | 'kv' | 'table_row' | 'figure';

export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Block {
  /** Stable id within the document, e.g. "b3". Used by SourceSpan.blockId. */
  id: string;
  type: BlockType;
  /** Normalized text content. SourceSpan offsets index into this string. */
  text: string;
  /** 1-indexed page number. */
  page: number;
  /** Layout box; null for born-digital where layout is unknown. */
  bbox: BBox | null;
  /** OCR confidence 0..1; 1.0 for born-digital text. */
  ocrConfidence: number;
  /** Nested blocks (e.g. table rows under a table). */
  children?: Block[];
}

export interface BlockModel {
  docId: string;
  docType: DocType;
  modality: Modality;
  blocks: Block[];
  /** Path/URI of the original file. */
  sourceUri: string;
  /** ISO timestamp. */
  createdAt: string;
}

/** A grounded reference into a Block. Offsets are into Block.text. */
export interface SourceSpan {
  blockId: string;
  /** Inclusive char offset into Block.text. */
  start: number;
  /** Exclusive char offset into Block.text. */
  end: number;
  page?: number;
}
