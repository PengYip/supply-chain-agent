import { generateObject, type LanguageModel } from 'ai';
import { z } from 'zod';
import type { Block, DocType } from './types.js';
import type { TemplateTypeRow } from './db/repositories.js';

/** Injected small-model handle (same seam as ExtractionDeps). */
export interface ClassifierDeps {
  model: LanguageModel;
}

/** 两阶段候选词表: 粗类(顶层四类) + 各粗类的细类候选(模板表动态派生)。 */
export interface ClassifierVocab {
  coarse: string[];
  fineByCoarse: Record<string, string[]>;
}

export interface ClassifierInput {
  blocks: Block[];
  /** Caller-supplied best guess; used verbatim when no model is wired or the
   *  LLM call fails. Defaults to '其他' when undefined. */
  hint?: DocType;
  /** 模板派生词表(缺省用内置粗类 + 空细类, 保持单阶段兼容)。 */
  vocab?: ClassifierVocab;
}

export interface ClassifierResult {
  docType: DocType;
  confidence: number;
  /** 'classified' = LLM decided; 'hint' = no model, used the hint; 'fallback' =
   *  LLM errored / unparseable, fell back to the hint at confidence 0. */
  source: 'classified' | 'hint' | 'fallback';
}

/** 八类单据词汇表(legacy SSOT, 向后兼容; P2 起分类器候选词表由模板表生成)。 */
export const DOC_TYPES = ['合同', '发票', '提单', '装箱单', '货转单', '化验报告', '付款凭证', '其他'] as const satisfies readonly DocType[];

/** 粗类 = 顶层四类(spec §3.1 v2 树顶层)。 */
const DEFAULT_COARSE = ['合同', '立项书', '履约凭证', '其他'];

/** 从模板类型树派生两阶段词表: 粗类固定四类, 细类 = 各粗类的全部后代(含中间层)。 */
export function buildClassifierVocab(types: TemplateTypeRow[]): ClassifierVocab {
  const byId = new Map(types.map((t) => [t.id, t]));
  // 排除 alias 类型(props.aliasOf 标记, 如 提单/装箱单=货转单别名): 不进细类候选。
  const docTypes = types.filter((t) => t.kind === 'doc_type' && !t.props.aliasOf);
  const childrenOf = (id: string | null) => docTypes.filter((t) => t.parentId === id).map((t) => t.name);
  const descendants = (name: string): string[] => {
    const out: string[] = [];
    const stack = [...childrenOf(byId.get(`dt-${name}`)?.id ?? null)];
    while (stack.length) {
      const n = stack.pop()!;
      out.push(n);
      stack.push(...childrenOf(byId.get(`dt-${n}`)?.id ?? null));
    }
    return out;
  };
  const fineByCoarse: Record<string, string[]> = {};
  for (const c of DEFAULT_COARSE) {
    const fine = descendants(c);
    if (fine.length) fineByCoarse[c] = fine;
  }
  return { coarse: DEFAULT_COARSE, fineByCoarse };
}

function buildCoarsePrompt(coarse: string[]): string {
  return [
    '你是供应链单据分类器。只依据给定原文判断这份单据属于哪个粗类。',
    `粗类取值: ${coarse.join(' / ')}。`,
    'confidence 是自评置信度 (0..1); 不确定就给较低值。',
    '严禁凭空臆造原文中不存在的单据类型信号。',
    '严格以 JSON 格式输出, 不要包含任何注释或解释文字。',
    '输出结构: {"docType": "履约凭证", "confidence": 0.9}',
  ].join('\n');
}

function buildFinePrompt(coarse: string, fine: string[]): string {
  return [
    `这份单据已判定为「${coarse}」。请进一步判定其细类。`,
    `细类取值: ${fine.join(' / ')}。`,
    'confidence 是自评置信度 (0..1); 不确定就给较低值。',
    '严禁凭空臆造原文中不存在的单据类型信号。',
    '严格以 JSON 格式输出, 不要包含任何注释或解释文字。',
    '输出结构: {"docType": "收货单", "confidence": 0.85}',
  ].join('\n');
}

const MAX_CLASSIFY_CHARS = 2000;

/** Bounded blocks->prompt: join block texts, cap at MAX_CLASSIFY_CHARS. */
function blocksToPrompt(blocks: Block[]): string {
  const text = blocks.map((b) => b.text).join('\n').slice(0, MAX_CLASSIFY_CHARS);
  return `原文片段:\n${text}`;
}

/**
 * 两阶段分类: 粗类(合同/立项书/履约凭证/其他) -> 细类(模板表动态候选)。
 * 细类失败回退粗类; 粗类失败回退 hint(现 fallback 语义不变)。
 */
export async function classifyDocument(
  deps: ClassifierDeps,
  input: ClassifierInput,
): Promise<ClassifierResult> {
  const hint: DocType = input.hint ?? '其他';
  const vocab = input.vocab ?? { coarse: DEFAULT_COARSE, fineByCoarse: {} };
  try {
    const coarseSchema = z.object({
      docType: z.enum(vocab.coarse as [string, ...string[]]),
      confidence: z.number().min(0).max(1),
    });
    const coarse = await generateObject({
      model: deps.model,
      schema: coarseSchema,
      system: buildCoarsePrompt(vocab.coarse),
      prompt: blocksToPrompt(input.blocks),
      providerOptions: { openai: { structuredOutputs: false } },
    });
    const fineCandidates = vocab.fineByCoarse[coarse.object.docType] ?? [];
    if (fineCandidates.length === 0) {
      return { docType: coarse.object.docType as DocType, confidence: coarse.object.confidence, source: 'classified' };
    }
    try {
      const fineSchema = z.object({
        docType: z.enum(fineCandidates as [string, ...string[]]),
        confidence: z.number().min(0).max(1),
      });
      const fine = await generateObject({
        model: deps.model,
        schema: fineSchema,
        system: buildFinePrompt(coarse.object.docType, fineCandidates),
        prompt: blocksToPrompt(input.blocks),
        providerOptions: { openai: { structuredOutputs: false } },
      });
      return { docType: fine.object.docType as DocType, confidence: fine.object.confidence, source: 'classified' };
    } catch {
      // 细类失败 -> 回退粗类(仍是 LLM 判定, source 保持 'classified')。
      return { docType: coarse.object.docType as DocType, confidence: coarse.object.confidence, source: 'classified' };
    }
  } catch {
    return { docType: hint, confidence: 0, source: 'fallback' };
  }
}

/** Offline degrade path (unchanged): hint verbatim at confidence 0, source 'hint'. */
export function classifyDocumentWithoutModel(input: ClassifierInput): ClassifierResult {
  return { docType: input.hint ?? '其他', confidence: 0, source: 'hint' };
}
