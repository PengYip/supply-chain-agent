import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import type { ModelMessage, UIMessage } from 'ai';
import { startSessionRun, isRunning, abortSessionRun } from '../../src/harness/runManager.js';
import { runSession } from '../../src/harness/runSession.js';
import { subscribe } from '../../src/harness/sessionEvents.js';
import {
  getSessionStatus,
  createSession,
  loadSession,
  appendMessages,
  setSessionFavorite,
  setSessionStatus,
} from '../../src/harness/sessionStore.js';
import { sessionsRoute } from '../../src/routes/sessions.js';
import { fakeStreamingModel } from '../fakeLanguageModel.js';
import type { AuthEnv } from '../../src/lib/auth-middleware.js';

describe('background runtime integration (full chain)', () => {
  it('run survives subscriber disconnect: persists assistant + status flips busy->idle', async () => {
    const s = createSession('trader', 'u-int1');
    const parts: unknown[] = [];
    const unsub = subscribe(s.id, (e) => { if (e.type === 'message.part') parts.push(e); });

    const start = startSessionRun(s.id, 'u-int1', 'trader', (signal) =>
      runSession({
        sessionId: s.id,
        userId: 'u-int1',
        role: 'trader',
        messages: [{ role: 'user', content: 'hi' } as ModelMessage],
        auditTraceId: 't-int1',
        abortSignal: signal,
        model: fakeStreamingModel(['hel', 'lo']),
      }),
    );
    expect('runId' in start).toBe(true);
    expect(isRunning(s.id)).toBe(true);
    expect(getSessionStatus(s.id)?.status).toBe('busy');

    // Simulate switching session: disconnect the subscriber. The backend run
    // must NOT be interrupted — this is the core decoupling invariant.
    unsub();

    // Wait for the background run to finish.
    await new Promise((r) => setTimeout(r, 60));

    expect(isRunning(s.id)).toBe(false);
    expect(getSessionStatus(s.id)?.status).toBe('idle');
    // assistant persisted (onFinish fired, even though subscriber was gone).
    const loaded = loadSession(s.id);
    const assistant = (loaded?.messages ?? []).find((m: any) => m.role === 'assistant');
    expect(assistant).toBeTruthy();
  });

  it('two sessions run concurrently without cross-talk', async () => {
    const a = createSession('trader', 'u-int2');
    const b = createSession('trader', 'u-int2');

    startSessionRun(a.id, 'u-int2', 'trader', (signal) =>
      runSession({
        sessionId: a.id, userId: 'u-int2', role: 'trader',
        messages: [{ role: 'user', content: 'a' } as ModelMessage],
        auditTraceId: 't-a', abortSignal: signal, model: fakeStreamingModel(['a-resp']),
      }),
    );
    startSessionRun(b.id, 'u-int2', 'trader', (signal) =>
      runSession({
        sessionId: b.id, userId: 'u-int2', role: 'trader',
        messages: [{ role: 'user', content: 'b' } as ModelMessage],
        auditTraceId: 't-b', abortSignal: signal, model: fakeStreamingModel(['b-resp']),
      }),
    );

    expect(getSessionStatus(a.id)?.status).toBe('busy');
    expect(getSessionStatus(b.id)?.status).toBe('busy');

    await new Promise((r) => setTimeout(r, 80));

    expect(getSessionStatus(a.id)?.status).toBe('idle');
    expect(getSessionStatus(b.id)?.status).toBe('idle');
    // Each persisted its own assistant message (no cross-talk).
    const la = loadSession(a.id);
    const lb = loadSession(b.id);
    expect((la?.messages ?? []).find((m: any) => m.role === 'assistant')).toBeTruthy();
    expect((lb?.messages ?? []).find((m: any) => m.role === 'assistant')).toBeTruthy();
  });

  it('abort stops the run and status returns to idle', async () => {
    const s = createSession('trader', 'u-int3');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const start = startSessionRun(s.id, 'u-int3', 'trader', async (signal) => {
      signal.addEventListener('abort', () => release());
      await gate;
    });
    expect('runId' in start).toBe(true);
    expect(isRunning(s.id)).toBe(true);
    expect(abortSessionRun(s.id)).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(isRunning(s.id)).toBe(false);
    expect(getSessionStatus(s.id)?.status).toBe('idle');
  });

  it('GET /api/sessions returns status field in each session row', async () => {
    const s = createSession('trader', 'u-list');
    setSessionStatus(s.id, 'busy', 'run-list');

    const app = new Hono<AuthEnv>();
    app.use('*', async (c, next) => {
      c.set('user', { id: 'u-list', email: 't@t', role: 'trader' } as any);
      await next();
    });
    app.route('/api/sessions', sessionsRoute);

    const res = await app.request('http://test/api/sessions');
    expect(res.status).toBe(200);
    const json = await res.json();
    const row = json.sessions.find((r: { id: string }) => r.id === s.id);
    expect(row).toBeTruthy();
    expect(row.status).toBe('busy');
  });

  // Regression: the route once stripped `favorited` from listSessionsForUser
  // rows, so the sidebar star and the 已收藏 count never updated after a
  // favorite even though the favorite itself succeeded.
  it('GET /api/sessions returns favorited flag for the listing user', async () => {
    const s = createSession('trader', 'u-favlist');
    setSessionFavorite(s.id, 'u-favlist', 't@t', null);

    const app = new Hono<AuthEnv>();
    app.use('*', async (c, next) => {
      c.set('user', { id: 'u-favlist', email: 't@t', role: 'trader' } as any);
      await next();
    });
    app.route('/api/sessions', sessionsRoute);

    const res = await app.request('http://test/api/sessions');
    expect(res.status).toBe(200);
    const json = await res.json();
    const row = json.sessions.find((r: { id: string }) => r.id === s.id);
    expect(row).toBeTruthy();
    expect(row.favorited).toBe(true);
  });

  // 空会话治理: creating a new session purges the user's zero-message
  // leftovers; list rows carry messageCount so the sidebar can hide empties.
  it('POST /api/sessions purges empty leftovers; GET rows carry messageCount', async () => {
    const emptyOld = createSession('trader', 'u-purge2');
    const used = createSession('trader', 'u-purge2');
    appendMessages(used.id, [
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: '查合同' }] } as UIMessage,
    ]);

    const app = new Hono<AuthEnv>();
    app.use('*', async (c, next) => {
      c.set('user', { id: 'u-purge2', email: 't@t', role: 'trader' } as any);
      await next();
    });
    app.route('/api/sessions', sessionsRoute);

    const created = await app.request('http://test/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(created.status).toBe(201);

    const res = await app.request('http://test/api/sessions');
    const json = await res.json();
    const ids = json.sessions.map((r: { id: string }) => r.id);
    expect(ids).not.toContain(emptyOld.id);
    expect(ids).toContain(used.id);
    expect(json.sessions.find((r: { id: string }) => r.id === used.id).messageCount).toBe(1);
  });
});
