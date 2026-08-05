import type { Context } from '@opentelemetry/api';
import type {
  ReadableSpan,
  Span,
  SpanProcessor,
} from '@opentelemetry/sdk-trace-base';

// Maps AI SDK 6 `ai.*` content attributes onto the OpenTelemetry GenAI
// semantic-convention attributes (`gen_ai.*`) that Langfuse uses to populate a
// generation observation's Input/Output fields.
//
// Why this is needed: AI SDK 6.0.x emits the prompt as `ai.prompt.messages` and
// the response as `ai.response.text`, plus a few `gen_ai.request.*` /
// `gen_ai.response.*` metadata attributes -- but it does NOT emit
// `gen_ai.input.messages` / `gen_ai.output.messages`. Langfuse (3.68) only fills
// a generation's Input/Output from those gen_ai.* message attributes, so without
// enrichment the UI shows Input: null / Output: null even though the content is
// present in the span attributes (tokens/latency work because their attribute
// names are unchanged).
//
// recordInputs/recordOutputs cannot fix this: they default to true (the AI SDK
// only suppresses when explicitly false), and the ai.* attributes are already
// being sent -- the gap is purely the attribute NAME, which this enricher closes.

function enrich(span: ReadableSpan): void {
  // `span.attributes` is typed readonly but is mutable at runtime (the
  // @langfuse/otel media handler mutates it the same way). Mutating here, right
  // before the delegate exports, is safe.
  const attrs = span.attributes as Record<string, unknown>;

  // Langfuse (3.68) populates a generation's Input/Output fields from these
  // span attributes (in priority order): `langfuse.observation.input/output`
  // (native, highest precedence), `gen_ai.prompt`/`gen_ai.completion`,
  // `input.value`/`output.value`. It does NOT map `gen_ai.input.messages` /
  // `gen_ai.output.messages`. AI SDK 6 emits the content as `ai.prompt.messages`
  // (a JSON string of messages) and `ai.response.text` (plain string), so we
  // alias them onto the attributes Langfuse actually reads.
  const promptMessages = attrs['ai.prompt.messages'];
  const responseText = attrs['ai.response.text'];
  const setIfAbsent = (key: string, value: unknown): void => {
    if (value !== undefined && value !== null && attrs[key] === undefined) {
      attrs[key] = value;
    }
  };

  if (typeof promptMessages === 'string') {
    setIfAbsent('langfuse.observation.input', promptMessages);
    setIfAbsent('gen_ai.prompt', promptMessages);
  }
  if (typeof responseText === 'string') {
    setIfAbsent('langfuse.observation.output', responseText);
    setIfAbsent('gen_ai.completion', responseText);
  }

  // Tool-call spans (ai.toolCall): surface args/result as input/output too, so
  // the nested execute_tool nodes in the trace tree are inspectable in the UI.
  const toolArgs = attrs['ai.toolCall.args'];
  const toolResult = attrs['ai.toolCall.result'];
  if (typeof toolArgs === 'string') {
    setIfAbsent('langfuse.observation.input', toolArgs);
  }
  if (typeof toolResult === 'string') {
    setIfAbsent('langfuse.observation.output', toolResult);
  }
}

// A delegating SpanProcessor that enriches each AI SDK span with the
// Langfuse-native + GenAI attributes (langfuse.observation.input/output,
// gen_ai.prompt/gen_ai.completion) derived from ai.* content, then forwards to
// the wrapped processor (the LangfuseSpanProcessor). Enrichment runs
// synchronously in onEnd before the delegate sees the span, so the alias
// attributes are guaranteed to be present at export time.
export class GenAiSemConvEnricher implements SpanProcessor {
  constructor(private readonly delegate: SpanProcessor) {}

  onStart(span: Span, parentContext: Context): void {
    this.delegate.onStart(span, parentContext);
  }

  onEnd(span: ReadableSpan): void {
    try {
      enrich(span);
    } catch {
      // Enrichment must never block span export.
    }
    this.delegate.onEnd(span);
  }

  async shutdown(): Promise<void> {
    await this.delegate.shutdown();
  }

  async forceFlush(): Promise<void> {
    await this.delegate.forceFlush();
  }
}
