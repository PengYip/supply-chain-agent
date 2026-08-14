import type { LanguageModel } from 'ai';

// Minimal fake streaming language model for offline runStream/runSession tests.
//
// AI SDK 6 note: `LanguageModel` (the type of RunStreamOpts.model) is the union
// GlobalProviderModelId | LanguageModelV3 | LanguageModelV2. This fake follows
// the proven LanguageModelV2 shape already used by test/harness/e2e-loop.test.ts:
//   - text parts are { type: 'text-start'|'text-delta'|'text-end', id, delta? }
//   - finish part carries usage { inputTokens, outputTokens, totalTokens }
// (The v1 shapes `textDelta` / `promptTokens` from AI SDK <5 do not exist here.)
//
// doStream emits text-start, one text-delta per chunk, text-end, then a
// 'stop' finish. Injected via the model seam so tests need no network or key.
export function fakeStreamingModel(textChunks: string[] = ['hello']): LanguageModel {
  const model = {
    specificationVersion: 'v2' as const,
    provider: 'fake',
    modelId: 'fake-model',
    supportedUrls: {} as Record<string, RegExp[]>,
    async doGenerate() {
      throw new Error('fakeStreamingModel does not implement doGenerate');
    },
    async doStream() {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'text-start', id: 't-0' });
          for (const chunk of textChunks) {
            controller.enqueue({ type: 'text-delta', id: 't-0', delta: chunk });
          }
          controller.enqueue({ type: 'text-end', id: 't-0' });
          controller.enqueue({
            type: 'finish',
            finishReason: 'stop',
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          });
          controller.close();
        },
      });
      return { stream };
    },
  };
  return model as LanguageModel;
}
