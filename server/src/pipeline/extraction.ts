import { generateObject, type LanguageModel } from 'ai';
import { z } from 'zod';
import type { BlockModel, DocType, SourceSpan } from './types.js';
import { validateSpan, type SpanMatchStrength } from './spanValidator.js';
import { computeFieldConfidence, decisionForField } from './confidence.js';
import { REQUIRED_CONTRACT_FIELDS } from './schemas/contract.js';

export interface GroundedField {
  name: string;
  value: string | number;
  sourceSpans: SourceSpan[];
}

export interface ExtractedField extends GroundedField {
  strength: SpanMatchStrength;
  confidence: number;
  needsReview: boolean;
  autoAccepted: boolean;
  citedText: string | null;
}

export interface ExtractionDeps {
  model: LanguageModel;
}

export interface ExtractionInput {
  blockModel: BlockModel;
  docType: DocType;
}

export interface ExtractionResult {
  fields: ExtractedField[];
  overallConfidence: number;
  needsReview: boolean;
  missingRequired: string[];
  llmRaw: unknown;
}

const GroundedValueSchema = z.object({
  value: z.union([z.string(), z.number()]),
  sourceSpans: z.array(z.object({
    blockId: z.string(),
    start: z.number().int(),
    end: z.number().int(),
  })),
});

const GroundedExtractionSchema = z.object({
  fields: z.record(z.string(), GroundedValueSchema),
  llmConsistency: z.number().min(0).max(1),
});

const GROUNDED_EXTRACTION_PROMPT = [
  '你是供应链单据字段抽取器。绝对禁止凭空生成数字或名称。',
  '从给定 BlockModel 中抽取业务字段。每个字段的值必须严格来自原文, 并给出精确的 sourceSpans (blockId + 在 block.text 中的字符起止)。',
  '若某字段在原文中不存在, 不要列入 fields。',
  'llmConsistency 是你对本次抽取整体内部一致性的自评 (0..1)。',
].join('\n');

function blocksToPrompt(blockModel: BlockModel): string {
  const lines = blockModel.blocks.map((b) => `[${b.id}] (page ${b.page}, conf ${b.ocrConfidence}) ${b.text}`);
  return `docType: ${blockModel.docType}\nblocks:\n${lines.join('\n')}`;
}

/** Pure: attach span validation + confidence to grounded fields. Exported for testing. */
export function attachConfidence(
  blockModel: BlockModel,
  grounded: GroundedField[],
  llmConsistency: number,
): ExtractedField[] {
  return grounded.map((f) => {
    // use the strongest span for this field
    let best: ExtractedField | null = null;
    for (const span of f.sourceSpans.length ? f.sourceSpans : [{ blockId: '', start: 0, end: 0 }]) {
      const v = validateSpan(String(f.value), span, blockModel.blocks);
      const candidate: ExtractedField = {
        ...f,
        strength: v.strength,
        confidence: computeFieldConfidence({
          blockOcrConfidence: blockModel.blocks.find((b) => b.id === span.blockId)?.ocrConfidence ?? 0,
          spanMatch: v.strength,
          llmConsistency,
        }),
        needsReview: false,
        autoAccepted: false,
        citedText: v.citedText,
      };
      const d = decisionForField(f.name, candidate.confidence);
      candidate.needsReview = d.needsReview;
      candidate.autoAccepted = d.autoAccepted;
      if (!best || candidate.confidence > best.confidence) best = candidate;
    }
    return best!;
  });
}

export async function extractGroundedFields(
  deps: ExtractionDeps,
  input: ExtractionInput,
): Promise<ExtractionResult> {
  const { object } = await generateObject({
    model: deps.model,
    schema: GroundedExtractionSchema,
    system: GROUNDED_EXTRACTION_PROMPT,
    prompt: blocksToPrompt(input.blockModel),
  });

  const grounded: GroundedField[] = Object.entries(object.fields).map(([name, v]) => ({
    name,
    value: v.value,
    sourceSpans: v.sourceSpans,
  }));

  const fields = attachConfidence(input.blockModel, grounded, object.llmConsistency);
  const overallConfidence = fields.length
    ? fields.reduce((s, f) => s + f.confidence, 0) / fields.length
    : 0;

  const required =
    input.docType === '合同'
      ? (REQUIRED_CONTRACT_FIELDS as readonly string[])
      : [];
  const present = new Set(fields.map((f) => f.name));
  const missingRequired = required.filter((r) => !present.has(r));

  return {
    fields,
    overallConfidence: Math.round(overallConfidence * 1000) / 1000,
    needsReview: fields.some((f) => f.needsReview) || missingRequired.length > 0,
    missingRequired,
    llmRaw: object,
  };
}
