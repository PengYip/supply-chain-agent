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

describe('listApprovals audit filters (roadmap Item 6)', () => {
  it('toolName 精确过滤', async () => {
    const s = await createSession('trader', 'u1');
    const bindId = `ap_${uid('a')}`;
    await recordPendingApproval({ sessionId: s.id, level: 'L2', toolName: 'bind_document',
      toolCallId: `call_${uid('c')}`, input: {}, approvalId: bindId });
    const escId = `ESC-${uid('t')}`;
    await recordPendingApproval({ sessionId: s.id, level: 'L3', toolName: 'escalate_to_human',
      toolCallId: `call_${uid('c')}`, input: {}, ticketId: escId });
    // 共享文件库：不假设空库，只断言过滤语义（命中集全为该工具且含本用例种子）
    const onlyBind = await listApprovals({ userId: 'u1', toolName: 'bind_document' });
    expect(onlyBind.length).toBeGreaterThan(0);
    expect(onlyBind.every((i) => i.tool_name === 'bind_document')).toBe(true);
    expect(onlyBind.map((i) => i.approval_id)).toContain(bindId);
    expect(onlyBind.some((i) => i.tool_name === 'escalate_to_human')).toBe(false);
    const onlyEsc = await listApprovals({ userId: 'u1', toolName: 'escalate_to_human' });
    expect(onlyEsc.every((i) => i.tool_name === 'escalate_to_human')).toBe(true);
    expect(onlyEsc.map((i) => i.ticket_id)).toContain(escId);
  });

  it('decidedBy 过滤只中本人决策的已决票据', async () => {
    const s = await createSession('trader', 'u1');
    const approvalId = `ap_${uid('a')}`;
    await recordPendingApproval({ sessionId: s.id, level: 'L2', toolName: 'bind_document',
      toolCallId: `call_${uid('c')}`, input: {}, approvalId });
    await resolveApproval((await getPending(approvalId))!.id, 'approved', { decidedBy: 'boss-1' });
    expect(await listApprovals({ userId: 'u1', decidedBy: 'boss-1' })).toHaveLength(1);
    expect(await listApprovals({ userId: 'u1', decidedBy: 'nobody' })).toHaveLength(0);
    // pending 行 decided_by 为 NULL，不中任何 decidedBy 过滤
    const approvalId2 = `ap_${uid('a')}`;
    await recordPendingApproval({ sessionId: s.id, level: 'L2', toolName: 'bind_document',
      toolCallId: `call_${uid('c')}`, input: {}, approvalId: approvalId2 });
    expect(await listApprovals({ userId: 'u1', decidedBy: 'boss-1' })).toHaveLength(1);
  });

  it('createdFrom/createdTo 时间窗过滤（UTC ISO 字典序）', async () => {
    const s = await createSession('trader', 'u1');
    const ticketId = `ESC-${uid('t')}`;
    await recordPendingApproval({ sessionId: s.id, level: 'L3', toolName: 'escalate_to_human',
      input: {}, ticketId });
    const mine = (await listApprovals({ userId: 'u1' })).find((i) => i.ticket_id === ticketId)!;
    const createdAt = mine.created_at;
    // 边界含入：[createdAt, createdAt] 命中自身
    const atBoth = await listApprovals({ userId: 'u1', createdFrom: createdAt, createdTo: createdAt });
    expect(atBoth.map((i) => i.ticket_id)).toContain(ticketId);
    expect(await listApprovals({ userId: 'u1', createdFrom: createdAt }).then((r) => r.map((i) => i.ticket_id)))
      .toContain(ticketId);
    const after = new Date(new Date(createdAt).getTime() + 60_000).toISOString();
    const before = new Date(new Date(createdAt).getTime() - 60_000).toISOString();
    expect((await listApprovals({ userId: 'u1', createdFrom: after })).map((i) => i.ticket_id))
      .not.toContain(ticketId);
    expect((await listApprovals({ userId: 'u1', createdTo: before })).map((i) => i.ticket_id))
      .not.toContain(ticketId);
  });

  it('过滤条件可组合（status+toolName）', async () => {
    const s = await createSession('trader', 'u1');
    const approvalId = `ap_${uid('a')}`;
    await recordPendingApproval({ sessionId: s.id, level: 'L2', toolName: 'bind_document',
      toolCallId: `call_${uid('c')}`, input: {}, approvalId });
    await recordPendingApproval({ sessionId: s.id, level: 'L2', toolName: 'bind_document',
      toolCallId: `call_${uid('c')}`, input: {}, approvalId: `ap_${uid('a')}` });
    await resolveApproval((await getPending(approvalId))!.id, 'denied', { decidedBy: 'u1' });
    const rows = await listApprovals({ userId: 'u1', status: 'denied', toolName: 'bind_document' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('denied');
  });
});
