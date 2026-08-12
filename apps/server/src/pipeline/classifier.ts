import { generateObject, type LanguageModel } from 'ai';
import { z } from 'zod';
import type { Block, DocType } from './types.js';

/** Injected small-model handle (same seam as ExtractionDeps). */
export interface ClassifierDeps {
  model: LanguageModel;
}

export interface ClassifierInput {
  blocks: Block[];
  /** Caller-supplied best guess; used verbatim when no model is wired or the
   *  LLM call fails. Defaults to '其他' when undefined. */
  hint?: DocType;
}

export interface ClassifierResult {
  docType: DocType;
  confidence: number;
  /** 'classified' = LLM decided; 'hint' = no model, used the hint; 'fallback' =
   *  LLM errored / unparseable, fell back to the hint at confidence 0. */
  source: 'classified' | 'hint' | 'fallback';
}

const DOC_TYPES = ['合同', '发票', '提单', '装箱单', '其他'] as const;
const ClassifierSchema = z.object({
  docType: z.enum(DOC_TYPES),
  confidence: z.number().min(0).max(1),
});

const CLASSIFIER_PROMPT = [
  '你是供应链单据分类器。只依据给定原文判断这份单据属于哪一类。',
  '类别取值固定为五种之一: 合同 / 发票 / 提单 / 装箱单 / 其他。',
  'confidence 是你对本次分类的自评置信度 (0..1); 不确定就给较低值。',
  '严禁凭空臆造原文中不存在的单据类型信号。',
  '严格以 JSON 格式输出, 不要包含任何注释或解释文字。',
  '输出结构: {"docType": "发票", "confidence": 0.93}',
].join('\n');

const MAX_CLASSIFY_CHARS = 2000;

/** Bounded blocks->prompt: join block texts, cap at MAX_CLASSIFY_CHARS. */
function blocksToPrompt(blocks: Block[]): string {
  const text = blocks.map((b) => b.text).join('\n').slice(0, MAX_CLASSIFY_CHARS);
  return `原文片段:\n${text}`;
}

const clamp = (n: number) => Math.max(0, Math.min(1, n));

/**
 * L1 internal classification stage. Routing-classify: parsed blocks -> docType.
 * Uses the injected small model via DeepSeek-compatible JSON mode
 * (structuredOutputs:false, same as extraction.ts). On LLM error or schema
 * mismatch, degrades to the hint docType at confidence 0 (source 'fallback') so
 * ingest never hard-fails on classification.
 */
export async function classifyDocument(
  deps: ClassifierDeps,
  input: ClassifierInput,
): Promise<ClassifierResult> {
  const hint: DocType = input.hint ?? '其他';
  try {
    const { object } = await generateObject({
      model: deps.model,
      schema: ClassifierSchema,
      system: CLASSIFIER_PROMPT,
      prompt: blocksToPrompt(input.blocks),
      // DeepSeek rejects response_format=json_schema; force JSON object mode +
      // schema-in-prompt (no-op for providers that ignore providerOptions.openai).
      providerOptions: { openai: { structuredOutputs: false } },
    });
    return { docType: object.docType, confidence: clamp(object.confidence), source: 'classified' };
  } catch {
    return { docType: hint, confidence: 0, source: 'fallback' };
  }
}

/**
 * Offline degrade path used by ingestFile when no classifier model is wired
 * (tests, dev without a model). Returns the hint docType verbatim at confidence
 * 1 with source 'hint' so downstream stages see a confident, usable docType.
 */
export function classifyDocumentWithoutModel(input: ClassifierInput): ClassifierResult {
  return { docType: input.hint ?? '其他', confidence: 1, source: 'hint' };
}
