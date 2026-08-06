import { eq } from 'drizzle-orm';
import { documents, extractions, bindings } from './schema.js';
import type { DbContext } from './client.js';
import type { BlockModel, DocType, SourceSpan } from '../types.js';
import type { SpanMatchStrength } from '../spanValidator.js';

export interface ExtractionInput {
  documentId: string;
  docType: DocType;
  fields: Record<string, { value: string | number; sourceSpans: SourceSpan[] }>;
  fieldMeta: Record<string, { strength: SpanMatchStrength; confidence: number }>;
  overallConfidence: number;
  needsReview: boolean;
}

export interface BindingInput {
  documentId: string;
  contractNo: string;
  relation: string;
  sourceRefs: SourceSpan[];
  confidence: number;
  createdBy: string;
}

export interface BindingRow {
  id: string;
  documentId: string;
  contractNo: string;
  relation: string;
  sourceRefs: SourceSpan[];
  confidence: number;
  createdBy: string;
}

const rid = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

export function saveDocument(ctx: DbContext, model: BlockModel): string {
  ctx.db.insert(documents).values({
    id: model.docId,
    docType: model.docType,
    modality: model.modality,
    sourceUri: model.sourceUri,
    blockModel: JSON.stringify(model),
  }).run();
  return model.docId;
}

export function loadDocument(ctx: DbContext, docId: string): BlockModel | null {
  const row = ctx.db.select().from(documents).where(eq(documents.id, docId)).all()[0];
  return row ? (JSON.parse(row.blockModel) as BlockModel) : null;
}

export function saveExtraction(ctx: DbContext, input: ExtractionInput): string {
  const id = rid('EX');
  ctx.db.insert(extractions).values({
    id,
    documentId: input.documentId,
    docType: input.docType,
    fields: JSON.stringify(input.fields),
    fieldMeta: JSON.stringify(input.fieldMeta),
    overallConfidence: input.overallConfidence,
    needsReview: input.needsReview,
  }).run();
  return id;
}

export function saveBinding(ctx: DbContext, input: BindingInput): string {
  const id = rid('BD');
  ctx.db.insert(bindings).values({
    id,
    documentId: input.documentId,
    contractNo: input.contractNo,
    relation: input.relation,
    sourceRefs: JSON.stringify(input.sourceRefs),
    confidence: input.confidence,
    createdBy: input.createdBy,
  }).run();
  return id;
}

export function listBindingsForContract(ctx: DbContext, contractNo: string): BindingRow[] {
  return ctx.db.select().from(bindings).where(eq(bindings.contractNo, contractNo)).all().map((r) => ({
    id: r.id,
    documentId: r.documentId,
    contractNo: r.contractNo,
    relation: r.relation,
    sourceRefs: JSON.parse(r.sourceRefs) as SourceSpan[],
    confidence: r.confidence,
    createdBy: r.createdBy,
  }));
}
