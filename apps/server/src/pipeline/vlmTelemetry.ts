// VLM OTel span 发射(2026-09-02): VLM 是裸 fetch, OTel 自动埋点盖不住, 手工
// GenAI span 让 Langfuse 统一展示为 generation; prompt 仅文本不含 base64。
//
// 与 usageAudit.recordLlmCall 同一契约: fire-and-forget, 永不抛错, 绝不阻断
// 业务路径。属性构建是纯函数(vlmSpanAttributes), 单测直接断言; span 发射保持
// 薄封装(单测环境无 exporter, tracer 为 no-op, 一切惰性)。
import { trace, SpanStatusCode, type Attributes } from '@opentelemetry/api';
import { env } from '../env.js';

export type VlmUsageKind = 'vlm_extract' | 'vlm_classify' | 'vlm_batch_split';

/** VLM 响应 usage(OpenAI 兼容字段名)。 */
export interface VlmUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface VlmSpanArgs {
  kind: VlmUsageKind;
  usage?: VlmUsage;
  /** prompt 文本(仅文本, 绝不含 base64 图片载荷)。 */
  prompt: string;
  /** 成功时的响应内容; 错误路径不传。 */
  content?: string;
  err?: unknown;
}

/**
 * GenAI 语义约定属性(纯函数)。映射:
 *  - gen_ai.operation.name = 'generate'
 *  - gen_ai.system = 'bailian'(阿里云百炼 MaaS)
 *  - gen_ai.request.model = 模型名
 *  - gen_ai.usage.input_tokens/output_tokens/total_tokens = usage 映射
 *  - operation.name = 'vlm.<kind>'(镜像 chat 的 'ai.streamText role-*-chat')
 *  - gen_ai.prompt / gen_ai.completion = 文本输入输出(Langfuse 据此填 Input/Output)
 */
export function vlmSpanAttributes(
  kind: VlmUsageKind,
  model: string,
  usage: VlmUsage | undefined,
  prompt: string,
  content?: string,
): Attributes {
  const attrs: Attributes = {
    'gen_ai.operation.name': 'generate',
    'gen_ai.system': 'bailian',
    'gen_ai.request.model': model,
    'operation.name': `vlm.${kind}`,
    'gen_ai.prompt': prompt,
  };
  if (usage?.prompt_tokens !== undefined) {
    attrs['gen_ai.usage.input_tokens'] = usage.prompt_tokens;
  }
  if (usage?.completion_tokens !== undefined) {
    attrs['gen_ai.usage.output_tokens'] = usage.completion_tokens;
  }
  if (usage?.total_tokens !== undefined) {
    attrs['gen_ai.usage.total_tokens'] = usage.total_tokens;
  }
  if (content !== undefined) {
    attrs['gen_ai.completion'] = content;
  }
  return attrs;
}

/** 每次 VLM 调用发一个 GenAI span(span 名 = kind)。fire-and-forget, 永不抛错。 */
export function emitVlmUsageSpan(args: VlmSpanArgs): void {
  try {
    const span = trace
      .getTracer('sca-vlm')
      .startSpan(args.kind, {
        attributes: vlmSpanAttributes(args.kind, env.VLM_MODEL, args.usage, args.prompt, args.content),
      });
    if (args.err !== undefined) {
      span.recordException(args.err instanceof Error ? args.err : String(args.err));
      span.setStatus({ code: SpanStatusCode.ERROR });
    }
    span.end();
  } catch {
    // 遥测失败绝不阻断业务路径。
  }
}