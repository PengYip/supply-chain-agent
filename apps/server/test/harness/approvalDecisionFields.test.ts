import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';

const { createSession, recordPendingApproval, resolveApproval, getPending } =
  await import('../../src/harness/sessionStore.js');

const uid = (p: string) => `${p}-${randomUUID().slice(0, 8)}`;

describe('approval decision fields', () => {
  it('resolveApproval 记录决策人与理由', async () => {
    // createSession 签名以 sessionStore.ts facade 为准: createSession(role, userId?)
    // 返回 { id, role } —— 用返回值作为 sessionId（同 approvalCallbackBackground.test.ts）
    const s = await createSession('trader');

    const approvalId = `ap_${uid('dec')}`;
    await recordPendingApproval({
      sessionId: s.id,
      level: 'L2',
      toolName: 'bind_document',
      toolCallId: `call_${uid('c')}`,
      input: { contractNo: 'XYXD-2209-094' },
      approvalId,
    });

    const row0 = await getPending(approvalId);
    expect(row0?.status).toBe('pending');
    expect(row0?.decided_by ?? null).toBeNull();

    await resolveApproval(row0!.id, 'approved', { decidedBy: 'u1', reason: '已核对合同' });

    const row = await getPending(approvalId);
    expect(row?.status).toBe('approved');
    expect(row?.decided_by).toBe('u1');
    expect(row?.reason).toBe('已核对合同');
    expect(row?.decided_at).toBeTruthy();
  });

  it('无 decision 参数时新列保持 null（向后兼容）', async () => {
    const s = await createSession('trader');
    const ticketId = `ESC-${uid('t')}`;
    await recordPendingApproval({
      sessionId: s.id, level: 'L3', toolName: 'escalate_to_human',
      input: { issue: '付款金额超限' }, ticketId,
    });
    const row0 = await getPending(ticketId)!;
    await resolveApproval(row0.id, 'denied');
    const row = await getPending(ticketId)!;
    expect(row.status).toBe('denied');
    expect(row.decided_by ?? null).toBeNull();
  });
});