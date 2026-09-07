import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';

const { createSession, recordPendingApproval, getPending, appendSideEffect } =
  await import('../../src/harness/sessionStore.js');
import type { SideEffect } from '../../src/harness/sessionStore.js';

const uid = (p: string) => `${p}-${randomUUID().slice(0, 8)}`;
const fx = (n: number): SideEffect => ({
  target: `toolCall:call_${n}`, action: 'bind_document', ok: true,
  detail: `{"n":${n}}`, at: new Date().toISOString(),
});

describe('appendSideEffect', () => {
  it('按 toolCallId 追加并可读回', async () => {
    // createSession 签名以 sessionStore.ts facade 为准: createSession(role, userId?)
    const s = await createSession('trader');
    const toolCallId = `call_${uid('c')}`;
    const approvalId = `ap_${uid('a')}`;
    await recordPendingApproval({ sessionId: s.id, level: 'L2', toolName: 'bind_document',
      toolCallId, input: {}, approvalId });

    await appendSideEffect(toolCallId, fx(1));
    await appendSideEffect(toolCallId, fx(2));

    const row = await getPending(approvalId)!;
    const arr = JSON.parse(row.side_effect_results!) as SideEffect[];
    expect(arr).toHaveLength(2);
    expect(arr[0].action).toBe('bind_document');
    expect(arr[1].target).toContain('call_2');
  });

  it('未知 toolCallId no-op', async () => {
    await expect(appendSideEffect('call_nonexistent', fx(9))).resolves.toBeUndefined();
  });
});