import { describe, it, expect } from 'vitest';
import type { ModelMessage } from 'ai';
import { runSession } from '../../src/harness/runSession.js';
import { fakeStreamingModel } from '../fakeLanguageModel.js';
import { subscribe } from '../../src/harness/sessionEvents.js';
import { getSessionStatus, createSession, loadSession } from '../../src/harness/sessionStore.js';

describe('runSession', () => {
  it('consumes fullStream, emits message.part, persists on finish (R1)', async () => {
    const s = createSession('trader', 'u1');
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
    const loaded = loadSession(s.id);
    const assistant = (loaded?.messages ?? []).find((m: any) => m.role === 'assistant');
    expect(assistant).toBeTruthy();
    // status back to idle.
    expect(getSessionStatus(s.id)?.status).toBe('idle');
  });
});
