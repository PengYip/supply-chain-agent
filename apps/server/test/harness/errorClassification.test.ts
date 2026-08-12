import { describe, it, expect } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
import { classifyToolError } from '../../src/harness/errorClassification.js';
import { withAudit } from '../../src/harness/agent.js';
import { createFailureTracker } from '../../src/harness/compression.js';

describe('classifyToolError', () => {
  it('classifies timeout errors as retryable', () => {
    const r = classifyToolError(new Error('sandbox execute timed out after 30000ms'));
    expect(r.retryable).toBe(true);
    expect(r.category).toBe('timeout');
  });

  it('classifies network errors (ECONNRESET/ETIMEDOUT/fetch failed) as retryable', () => {
    const e = new Error('fetch failed') as any; e.code = 'ECONNRESET';
    expect(classifyToolError(e).retryable).toBe(true);
    expect(classifyToolError(e).category).toBe('network');
    const e2 = new Error('request failed') as any; e2.code = 'ETIMEDOUT';
    expect(classifyToolError(e2).category).toBe('network');
  });

  it('classifies overload (429/503) as retryable', () => {
    const e = new Error('Too Many Requests') as any; e.status = 429;
    expect(classifyToolError(e).retryable).toBe(true);
    expect(classifyToolError(e).category).toBe('overload');
    const e2 = new Error('Service Unavailable') as any; e2.status = 503;
    expect(classifyToolError(e2).category).toBe('overload');
  });

  it('classifies zod/schema validation as non-retryable invalid_args', () => {
    const e = new Error('Invalid input: expected string, received number') as any;
    e.name = 'ZodError';
    expect(classifyToolError(e).retryable).toBe(false);
    expect(classifyToolError(e).category).toBe('invalid_args');
  });

  it('classifies permission (403/Unauthorized) as non-retryable permission', () => {
    const e = new Error('Forbidden') as any; e.status = 403;
    expect(classifyToolError(e).retryable).toBe(false);
    expect(classifyToolError(e).category).toBe('permission');
  });

  it('classifies not-found as non-retryable', () => {
    const e = new Error('document not found') as any; e.status = 404;
    expect(classifyToolError(e).retryable).toBe(false);
    expect(classifyToolError(e).category).toBe('not_found');
  });

  it('falls back to unknown (retryable=false) for unrecognized errors', () => {
    expect(classifyToolError(new Error('something weird'))).toMatchObject({
      retryable: false, category: 'unknown',
    });
  });
});

describe('withAudit error catch path (integration)', () => {
  it('catches a thrown execute, returns a structured error result, AND trips the failure tracker', async () => {
    const failures = createFailureTracker(3);
    const throwing = tool({
      description: 'throwing tool',
      inputSchema: z.object({}),
      execute: async () => { throw new Error('boom'); },
    });
    const wrapped = withAudit('throwing_tool', throwing.execute!, failures);
    const out: any = await wrapped({} as any, {} as any);
    // (a) structured result reaches the model (Ch5:196).
    expect(out).toMatchObject({
      status: 'error',
      reason: 'tool_error',
      toolName: 'throwing_tool',
      retryable: false,
      category: 'unknown',
      message: 'boom',
    });
    // (b) the failure tracker still increments (breaker stays alive).
    expect(failures.consecutiveFailures).toBe(1);

    // 3 consecutive throws trip shouldStop.
    await wrapped({} as any, {} as any);
    await wrapped({} as any, {} as any);
    expect(failures.consecutiveFailures).toBe(3);
    expect(failures.shouldStop).toBe(true);
  });

  it('records success=true for a normal (non-error) result so the breaker resets', async () => {
    const failures = createFailureTracker(3);
    const ok = tool({
      description: 'ok tool',
      inputSchema: z.object({}),
      execute: async () => ({ ok: true, value: 42 }),
    });
    const wrapped = withAudit('ok_tool', ok.execute!, failures);
    const out: any = await wrapped({} as any, {} as any);
    expect(out).toEqual({ ok: true, value: 42 });
    expect(failures.consecutiveFailures).toBe(0); // success resets the streak
  });
});
