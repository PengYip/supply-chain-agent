import { describe, it, expect, vi, afterEach } from 'vitest';

const { notifyApprovalCreated, notifyApprovalResolved, getApprovalChannel, __setApprovalChannelForTests } =
  await import('../../src/harness/approvalChannel.js');

const row = { id: 'r1', session_id: 's1', level: 'L2', tool_name: 'bind_document',
  tool_call_id: 'c1', input_json: '{}', ticket_id: null, approval_id: 'a1',
  status: 'pending', created_at: new Date().toISOString() } as never;

// 通道注入只存活于单个用例：中途失败也不会把 override 泄漏给后续用例。
afterEach(() => __setApprovalChannelForTests(undefined));

describe('approvalChannel', () => {
  it('默认 local 通道', () => {
    expect(getApprovalChannel().name).toBe('local');
  });
  it('通道抛错时 notify 吞掉不外抛', async () => {
    __setApprovalChannelForTests({
      name: 'boom',
      onTicketCreated: async () => { throw new Error('x'); },
      onTicketResolved: async () => { throw new Error('x'); },
    });
    await expect(notifyApprovalCreated(row)).resolves.toBeUndefined();
    await expect(notifyApprovalResolved(row)).resolves.toBeUndefined();
  });
  it('通知正常通道', async () => {
    const spy = vi.fn();
    __setApprovalChannelForTests({ name: 'spy', onTicketCreated: spy, onTicketResolved: spy });
    await notifyApprovalCreated(row);
    expect(spy).toHaveBeenCalledWith(row);
  });
});
