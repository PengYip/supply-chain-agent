import { describe, it, expect } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
import { withToolTimeout } from '../../src/harness/agent.js';

describe('withToolTimeout (per-tool timeout wrapper)', () => {
  it('returns a structured tool_timeout result when execute exceeds the timeout', async () => {
    const slow = tool({
      description: 'slow test tool',
      inputSchema: z.object({}),
      execute: async () => {
        await new Promise((r) => setTimeout(r, 200));
        return { ok: true };
      },
    });
    const wrapped = withToolTimeout(slow.execute!, 50);
    const out = await wrapped({} as any, {} as any);
    expect(out).toMatchObject({
      status: 'error',
      reason: 'tool_timeout',
      timeoutMs: 50,
    });
  });

  it('passes the normal result through when execute finishes in time', async () => {
    const fast = tool({
      description: 'fast test tool',
      inputSchema: z.object({}),
      execute: async () => ({ ok: true, value: 42 }),
    });
    const wrapped = withToolTimeout(fast.execute!, 1000);
    const out = await wrapped({} as any, {} as any);
    expect(out).toEqual({ ok: true, value: 42 });
  });
});
