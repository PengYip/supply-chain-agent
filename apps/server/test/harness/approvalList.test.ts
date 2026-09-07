import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';

const { createSession, recordPendingApproval, resolveApproval, listApprovals, getPending } =
  await import('../../src/harness/sessionStore.js');
const { listApprovals: _l, getApprovalById } = await import('../../src/harness/sessionStore.js');

const uid = (p: string) => `${p}-${randomUUID().slice(0, 8)}`;

// fixture：createSession facade 签名为 createSession(role, userId?) —— userId 是
// 独立第二参（见 sessionStore.ts），按实际调整，断言不变
async function seed(userId: string | null) {
  const s = await createSession('trader', userId);
  const approvalId = `ap_${uid('a')}`;
  await recordPendingApproval({ sessionId: s.id, level: 'L2', toolName: 'bind_document',
    toolCallId: `call_${uid('c')}`, input: {}, approvalId });
  return { sid: s.id, approvalId };
}

describe('listApprovals ownership + filter', () => {
  it('只看到本人与 legacy(NULL) 会话的票据', async () => {
    const mine = await seed('u1');
    await seed('u2');          // 他人
    await seed(null);          // legacy

    const items = await listApprovals({ userId: 'u1', status: 'all', limit: 50 });
    const ids = items.map((i) => i.approval_id);
    expect(ids).toContain(mine.approvalId);
    expect(items.filter((i) => i.session_user_id === 'u2')).toHaveLength(0);
  });

  it('status 过滤 pending', async () => {
    const mine = await seed('u1');
    const row = await getPending(mine.approvalId)!;
    await resolveApproval(row.id, 'approved', { decidedBy: 'u1' });
    const pending = await listApprovals({ userId: 'u1', status: 'pending' });
    expect(pending.map((i) => i.approval_id)).not.toContain(mine.approvalId);
    const done = await listApprovals({ userId: 'u1', status: 'approved' });
    expect(done.map((i) => i.approval_id)).toContain(mine.approvalId);
  });
});

describe('getApprovalById', () => {
  it('按主键取行（含任意状态）', async () => {
    const mine = await seed('u1');
    const row = await getApprovalById((await getPending(mine.approvalId))!.id);
    expect(row?.approval_id).toBe(mine.approvalId);
  });
});