import { generateObject, type LanguageModel } from 'ai';
import { z } from 'zod';
import type { Block, DocType } from './types.js';
import type { TemplateTypeRow } from './db/repositories.js';
import { recordLlmCall } from '../harness/usageAudit.js';

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
  /** Optional owning document id, prefixed onto the usage-audit input preview. */
  docId?: string;
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
  // 同步排除 isActive=false 的置灰类型(与 bindings.ts docTypes 下拉过滤对称, 小修 2),
  // 置灰类型仍是活跃文档的合法历史值, 但不再作为新分类候选。
  const docTypes = types.filter((t) => t.kind === 'doc_type' && !t.props.aliasOf && t.isActive);
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
    // 单子类短路曾把粗类硬映射到唯一子类(合同全部误落 补充合同, 2026-09-02 事故),
    // 粗类自身进候选让细类阶段真正判别。
    if (fine.length) fineByCoarse[c] = [c, ...fine];
  }
  return { coarse: DEFAULT_COARSE, fineByCoarse };
}

/**
 * 粗类四选一的 system prompt。导出供测试做字符串断言(Bug A: 8 份合同全被判
 * 「补充合同」的根因是 prompt 缺判别说明, 模型见标题含"补充协议"就输出子类名
 * 或保守拐走)。判别说明随子类语义演进维护在这里。
 */
export function buildCoarsePrompt(coarse: string[]): string {
  return [
    '你是供应链单据分类器。只依据给定原文判断这份单据属于哪个粗类。',
    `粗类只允许输出以下${coarse.length}个值之一, 不得输出细类或其他名称: ${coarse.join(' / ')}。`,
    '判别说明:',
    '- 粗类看大类不看细类: 文件名或标题含"补充协议"/"补充合同"的单据仍属"合同"粗类(补充合同是合同的子类, 细类阶段才会落到补充合同)。',
    '- 出库单/收货单/发货单/结算凭证等履约过程凭证一律归"履约凭证"粗类。',
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
    `- 原文没有明确的细类特征时选粗类本身(如「${coarse}」), 不要强行落到子类。`,
    `- 只有标题或正文明确出现"补充协议"/"补充合同"字样才选「补充合同」; 普通买卖/采购/销售合同选「合同」。`,
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
  const t0 = performance.now();
  let coarseMs: number | null = null;
  // Usage audit (2026-09-02): record every classification LLM call (coarse +
  // fine) so DeepSeek spend is attributable. Fire-and-forget (never throws).
  const docId = input.docId;
  const auditInput = (docId ? `doc:${docId} ` : '') + blocksToPrompt(input.blocks);
  const modelId = (deps.model as { modelId?: string }).modelId ?? '';
  const auditClassify = (
    start: number,
    res?: { usage?: { inputTokens?: number | null; outputTokens?: number | null; totalTokens?: number | null }; finishReason?: string; object: unknown },
    err?: unknown,
  ) => {
    recordLlmCall({
      kind: 'classification',
      model: modelId,
      inputTokens: res?.usage?.inputTokens ?? null,
      outputTokens: res?.usage?.outputTokens ?? null,
      totalTokens: res?.usage?.totalTokens ?? null,
      inputText: auditInput,
      outputText: res ? JSON.stringify(res.object) : undefined,
      durationMs: Math.round(performance.now() - start),
      finishReason: res?.finishReason ?? undefined,
      status: err ? 'error' : 'ok',
      error: err ? (err instanceof Error ? err.message : String(err)) : undefined,
    });
  };
  try {
    const coarseSchema = z.object({
      docType: z.enum(vocab.coarse as [string, ...string[]]),
      confidence: z.number().min(0).max(1),
    });
    const coarseStart = performance.now();
    let coarse: { object: { docType: string; confidence: number }; usage?: { inputTokens?: number | null; outputTokens?: number | null; totalTokens?: number | null }; finishReason?: string };
    try {
      coarse = await generateObject({
        model: deps.model,
        schema: coarseSchema,
        system: buildCoarsePrompt(vocab.coarse),
        prompt: blocksToPrompt(input.blocks),
        // 2026-09-02: 关闭 thinking(确定性分类, 推理 token 按输出计费)。
        providerOptions: {
          openai: { structuredOutputs: false },
          deepseek: { thinking: { type: 'disabled' } },
        },
        // 2026-09-02: 解析 LLM 调用接入 Langfuse 观测(Tier 1)。
        experimental_telemetry: {
          isEnabled: true,
          recordInputs: true,
          recordOutputs: true,
          functionId: 'pipeline.classification',
          metadata: docId ? { docId } : {},
        },
      });
      auditClassify(coarseStart, coarse);
    } catch (e) {
      auditClassify(coarseStart, undefined, e);
      throw e;
    }
    coarseMs = Math.round(performance.now() - coarseStart);
    const fineCandidates = vocab.fineByCoarse[coarse.object.docType] ?? [];
    if (fineCandidates.length === 0) {
      console.log(
        `[perf-classify] coarse=${coarseMs}ms fine=skipped -> ${coarse.object.docType}`,
      );
      return { docType: coarse.object.docType as DocType, confidence: coarse.object.confidence, source: 'classified' };
    }
    // Single fine candidate => the LLM call cannot change the outcome; skip it
    // (saves one full generateObject round-trip per such doc type).
    if (fineCandidates.length === 1) {
      const only = fineCandidates[0]!;
      console.log(
        `[perf-classify] coarse=${coarseMs}ms fine=single-candidate -> ${only}`,
      );
      return { docType: only as DocType, confidence: coarse.object.confidence, source: 'classified' };
    }
    try {
      const fineSchema = z.object({
        docType: z.enum(fineCandidates as [string, ...string[]]),
        confidence: z.number().min(0).max(1),
      });
      const fineStart = performance.now();
      let fine: { object: { docType: string; confidence: number }; usage?: { inputTokens?: number | null; outputTokens?: number | null; totalTokens?: number | null }; finishReason?: string };
      try {
        fine = await generateObject({
          model: deps.model,
          schema: fineSchema,
          system: buildFinePrompt(coarse.object.docType, fineCandidates),
          prompt: blocksToPrompt(input.blocks),
          // 2026-09-02: 关闭 thinking(确定性分类, 推理 token 按输出计费)。
          providerOptions: {
            openai: { structuredOutputs: false },
            deepseek: { thinking: { type: 'disabled' } },
          },
          // 2026-09-02: 解析 LLM 调用接入 Langfuse 观测(Tier 1)。
          experimental_telemetry: {
            isEnabled: true,
            recordInputs: true,
            recordOutputs: true,
            functionId: 'pipeline.classification',
            metadata: docId ? { docId } : {},
          },
        });
        auditClassify(fineStart, fine);
      } catch (e) {
        auditClassify(fineStart, undefined, e);
        throw e;
      }
      console.log(
        `[perf-classify] coarse=${coarseMs}ms fine=${Math.round(performance.now() - fineStart)}ms`
        + ` total=${Math.round(performance.now() - t0)}ms -> ${fine.object.docType}`,
      );
      return { docType: fine.object.docType as DocType, confidence: fine.object.confidence, source: 'classified' };
    } catch {
      // 细类失败 -> 回退粗类(仍是 LLM 判定, source 保持 'classified')。
      console.log(`[perf-classify] coarse=${coarseMs}ms fine=failed -> ${coarse.object.docType}`);
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
