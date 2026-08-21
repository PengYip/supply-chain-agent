import { describe, it, expect } from 'vitest';
import type { ModelMessage } from 'ai';
import { runSession } from '../../src/harness/runSession.js';
import { fakeStreamingModel } from '../fakeLanguageModel.js';
import { subscribe } from '../../src/harness/sessionEvents.js';
import { createSession, loadSession } from '../../src/harness/sessionStore.js';

describe('runSession', () => {
  it('consumes fullStream, emits message.part, persists on finish (R1)', async () => {
    const s = await createSession('trader', 'u1');
    const parts: unknown[] = [];
    subscribe(s.id, (e) => {
      if (e.type === 'message.part') parts.push(e);
    });
    const messages: ModelMessage[] = [{ role: 'user', content: 'hi' }];

    await runSession({
      sessionId: s.id,
      userId: 'u1',
      role: 'trader',
      messages,
      auditTraceId: 't1',
      abortSignal: new AbortController().signal,
      model: fakeStreamingModel(['hel', 'lo']),
    });

    // R1 core: fullStream consumed + parts emitted.
    expect(parts.length).toBeGreaterThan(0);
    // assistant message persisted (onFinish fired).
    const loaded = await loadSession(s.id);
    const assistant = (loaded?.messages ?? []).find((m: any) => m.role === 'assistant');
    expect(assistant).toBeTruthy();
    // Note: status lifecycle is no longer runSession's responsibility (Task 7a
    // delegates it to RunManager), so we do not assert on it here.
  });

  it('abort signal stops the run and it resolves without hanging', async () => {
    const s = await createSession('trader', 'u-abort');
    const controller = new AbortController();
    controller.abort(); // pre-aborted signal
    const messages: ModelMessage[] = [{ role: 'user', content: 'hi' }];

    const runPromise = runSession({
      sessionId: s.id,
      userId: 'u-abort',
      role: 'trader',
      messages,
      auditTraceId: 't-abort',
      abortSignal: controller.signal,
      model: fakeStreamingModel(['hel', 'lo']),
    });

    // Key assertion: with a pre-aborted signal the run must not hang. AI SDK 6
    // streamText emits an 'abort' stream part and closes instead of throwing, so
    // runSession resolves normally (reaching this line = pass).
    await runPromise;
  });
});
