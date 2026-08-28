import { generateObject, type LanguageModel } from 'ai';
import { z } from 'zod';
import type { BlockModel, DocType, SourceSpan } from './types.js';
import { validateSpan, type SpanMatchStrength } from './spanValidator.js';
import { computeFieldConfidence, decisionForField } from './confidence.js';
import { REQUIRED_CONTRACT_FIELDS } from './schemas/contract.js';
import type { ProposedRelationship, ProposedEdge } from './db/repositories.js';
import { TRADE_VOCAB, type TradeVocabulary } from '../domain/tradeSemantics.js';

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
  /** 模板 props 驱动: 必填字段清单(缺省 [] = 现状合同特判)。 */
  requiredFields?: string[];
  /** 模板 props 驱动: 字段提示(别名/取值说明), 拼进提示词。 */
  fieldHints?: Record<string, string>;
}

export interface ExtractionResult {
  fields: ExtractedField[];
  overallConfidence: number;
  needsReview: boolean;
  missingRequired: string[];
  /** Candidate Party/Commodity relationships lifted from flat fields (Task 5). */
  proposedRelationships: ProposedRelationship[];
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
  // DeepSeek's JSON-mode response_format requires the prompt to contain "json".
  '严格以 JSON 格式输出, 不要包含任何注释或解释文字。',
  // JSON mode (no structured-output enforcement) lets the model pick a shape;
  // force the record form (object keyed by field name) that the schema requires.
  '输出结构 (fields 必须是 JSON 对象, 以字段名为键; 严禁使用数组):',
  '{"fields": {"合同号": {"value": "HT-2024-001", "sourceSpans": [{"blockId": "b0", "start": 0, "end": 11}]}}, "llmConsistency": 0.95}',
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

/** deriveProposedRelationships 的最小字段投影（ReviewSnapshot.fields 与 ExtractedField 均满足）。 */
export interface RelationshipFieldInput {
  name: string;
  value: string | number;
  confidence: number;
}

/** 纯函数：从扁平字段确定性派生实体提议，无 LLM 参与。 */
export function deriveProposedRelationships(
  fields: RelationshipFieldInput[],
  vocab: TradeVocabulary = TRADE_VOCAB,
): ProposedRelationship[] {
  const out: ProposedRelationship[] = [];
  for (const f of fields) {
    const val = typeof f.value === 'string' ? f.value.trim() : '';
    if (!val) continue;
    if (vocab.roleByField[f.name]) {
      out.push({ kind: 'Party', role: vocab.roleByField[f.name]!, name: val, confidence: f.confidence });
    } else if (vocab.commodityFields.has(f.name)) {
      out.push({ kind: 'Commodity', name: val, confidence: f.confidence });
    } else if (vocab.contractFields.has(f.name)) {
      out.push({ kind: 'Contract', name: val, confidence: f.confidence });
    } else if (vocab.projectFields.has(f.name)) {
      // 项目字段(编号/名称)各提升一条 Project 实体提议; 边侧(deriveProposedEdges)
      // 才做编号优先折叠, 实体提议保留全部候选(写入侧按归一化名 MERGE 去重)。
      out.push({ kind: 'Project', name: val, confidence: f.confidence });
    }
  }
  return out;
}

/** deriveProposedEdges 的最小字段投影（ReviewSnapshot.fields 与 ExtractedField 均满足）。 */
export interface EdgeFieldInput {
  name: string;
  value: string | number;
  confidence: number;
}

/** 项目标识字段中的「编号类」: 折叠 references->Project 边时优先于名称类(spec §4.2)。 */
const PROJECT_CODE_FIELDS = new Set(['项目编号', '项目号']);

/**
 * 纯函数：从扁平字段确定性派生 Document->实体边，无 LLM 参与。抽取时与确认时
 * （graphCommit）跑同一规则，复核卡展示与图写入不会漂移。
 */
export function deriveProposedEdges(
  docType: string,
  fields: EdgeFieldInput[],
  vocab: TradeVocabulary = TRADE_VOCAB,
): ProposedEdge[] {
  const out: ProposedEdge[] = [];
  const contractConf = new Map<string, number>();
  const contractOrder: string[] = [];
  // 项目字段折叠: 编号类(项目编号/项目号)优先于名称类, 同类取 confidence 最高者,
  // 只出一条 references->Project 边(与 contractFields 的折叠同思路)。
  let projectPick: { name: string; confidence: number; isCode: boolean } | null = null;
  for (const f of fields) {
    const val = typeof f.value === 'string' ? f.value.trim() : '';
    if (!val) continue;
    const role = vocab.roleByField[f.name];
    if (role) {
      out.push({ type: 'party', dstKind: 'Party', dstName: val, role, confidence: f.confidence });
    } else if (vocab.commodityFields.has(f.name)) {
      out.push({ type: 'commodity', dstKind: 'Commodity', dstName: val, confidence: f.confidence });
    } else if (vocab.contractFields.has(f.name)) {
      if (!contractConf.has(val)) contractOrder.push(val);
      contractConf.set(val, Math.max(contractConf.get(val) ?? 0, f.confidence));
    } else if (vocab.projectFields.has(f.name)) {
      const isCode = PROJECT_CODE_FIELDS.has(f.name);
      if (
        !projectPick ||
        (isCode && !projectPick.isCode) ||
        (isCode === projectPick.isCode && f.confidence > projectPick.confidence)
      ) {
        projectPick = { name: val, confidence: f.confidence, isCode };
      }
    }
  }
  if (projectPick) {
    out.push({ type: 'references', dstKind: 'Project', dstName: projectPick.name, confidence: projectPick.confidence });
  }
  for (const name of contractOrder) {
    const confidence = contractConf.get(name) ?? 0;
    out.push({ type: 'references', dstKind: 'Contract', dstName: name, confidence });
    if (vocab.executesDocTypes.has(docType)) {
      out.push({ type: 'executes', dstKind: 'Contract', dstName: name, confidence });
    }
  }
  return out;
}

export async function extractGroundedFields(
  deps: ExtractionDeps,
  input: ExtractionInput,
): Promise<ExtractionResult> {
  // 模板 props 驱动提示词: 保底字段清单 + 字段提示(别名/取值说明)动态拼接;
  // 无 props 时走原静态 prompt(缺省行为不变)。
  const required = input.requiredFields ?? (input.docType === '合同' ? REQUIRED_CONTRACT_FIELDS : []);
  const hints = input.fieldHints ?? {};
  const dynamicPrompt = [
    ...(required.length ? [`保底字段(必须逐个出现在输出中, 此规则优先于"原文不存在则不列"; 原文缺失时 value 置空字符串、sourceSpans 置空数组): ${required.join('、')}。真实缺失的保底字段列入 missingRequired。`] : []),
    ...(Object.keys(hints).length ? [`字段提示: ${Object.entries(hints).map(([k, v]) => `${k}(${v})`).join('; ')}。`] : []),
  ].join('\n');
  const system = dynamicPrompt ? `${GROUNDED_EXTRACTION_PROMPT}\n${dynamicPrompt}` : GROUNDED_EXTRACTION_PROMPT;
  const { object } = await generateObject({
    model: deps.model,
    schema: GroundedExtractionSchema,
    system,
    prompt: blocksToPrompt(input.blockModel),
    // DeepSeek's OpenAI-compatible API rejects response_format=json_schema
    // ("This response_format type is unavailable now"). Force JSON mode
    // (response_format=json_object + schema-in-prompt) via structuredOutputs:false.
    // This is the standard OpenAI-compatible-provider setting; it is a no-op for
    // providers that do not honor providerOptions.openai.
    providerOptions: { openai: { structuredOutputs: false } },
  });

  const grounded: GroundedField[] = Object.entries(object.fields).map(([name, v]) => ({
    name,
    value: v.value,
    sourceSpans: v.sourceSpans,
  }));

  const fields = attachConfidence(input.blockModel, grounded, object.llmConsistency);
  const padded = padTemplateFields(fields, required);
  const nonEmpty = padded.fields.filter((f) => !isEmptyValue(f.value));
  const overallConfidence = nonEmpty.length
    ? nonEmpty.reduce((s, f) => s + f.confidence, 0) / nonEmpty.length
    : 0;

  return {
    fields: padded.fields,
    overallConfidence: Math.round(overallConfidence * 1000) / 1000,
    needsReview: padded.fields.some((f) => f.needsReview) || padded.missingRequired.length > 0,
    missingRequired: padded.missingRequired,
    proposedRelationships: deriveProposedRelationships(padded.fields),
    llmRaw: object,
  };
}

/** 空值判定: 空串/纯空白 = 原文缺失(保底语义下的"存空")。 */
export function isEmptyValue(v: string | number): boolean {
  return typeof v === 'string' && v.trim().length === 0;
}

/** 确定性保底(spec 2026-08-28): 输出 ⊇ required 恒成立。模型漏抽的保底字段补
 *  空值占位(strength none/confidence 0/needsReview), 模型多抽的字段原样保留。
 *  required 为空数组时原样返回(no-op)。 */
export function padTemplateFields(
  fields: ExtractedField[],
  required: readonly string[],
): { fields: ExtractedField[]; missingRequired: string[] } {
  const present = new Map(fields.map((f) => [f.name, f] as const));
  const padded: ExtractedField[] = [];
  const missingRequired: string[] = [];
  for (const name of required) {
    const hit = present.get(name);
    if (!hit) {
      padded.push({
        name, value: '', sourceSpans: [],
        strength: 'none', confidence: 0,
        needsReview: true, autoAccepted: false, citedText: null,
      });
      missingRequired.push(name);
    } else if (isEmptyValue(hit.value)) {
      missingRequired.push(name);
    }
  }
  return { fields: required.length ? [...fields, ...padded] : fields, missingRequired };
}
