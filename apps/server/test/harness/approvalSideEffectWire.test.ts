import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';

const { buildGatedTools } = await import('../../src/harness/agent.js');
const { createSession, recordPendingApproval, getPending, resolveApproval } =
  await import('../../src/harness/sessionStore.js');
const { createDb, migrate } = await import('../../src/pipeline/db/client.js');

const uid = (p: string) => `${p}-${randomUUID().slice(0, 8)}`;

// Local helper（brief 标注: 不存在于任何地方, 在测试内定义）:
// getPending → resolveApproval(..., 'approved')
async function resolveApprovalForTest(approvalId: string): Promise<void> {
  const row = await getPending(approvalId);
  await resolveApproval(row!.id, 'approved');
}

describe('L2 execute side-effect wire', () => {
  it('批准后的 execute 记录副作用（按 toolCallId）', async () => {
    // 造一条已批准的 L2 pending 行（createSession 签名以 facade 为准:
    // createSession(role, userId?)）
    const s = await createSession('trader');
    const toolCallId = `call_${uid('c')}`;
    const approvalId = `ap_${uid('a')}`;
    await recordPendingApproval({ sessionId: s.id, level: 'L2', toolName: 'bind_document',
      toolCallId, input: {}, approvalId });
    await resolveApprovalForTest(approvalId);

    // buildGatedTools 真实签名: buildGatedTools(role, deps?, failures?)。
    // bind_document 仅在 deps.ctx 存在时挂载（见 roleToolRegistry getToolsForRole），
    // 照抄 e2e-loop.test.ts 的 ctx 组装；返回 Record<string, Tool>，按键名取工具。
    const ctx = createDb(':memory:');
    migrate(ctx.sqlite);
    const tools = buildGatedTools('trader', { ctx, extraction: { model: {} as any } });
    const t = tools['bind_document'];
    expect(t).toBeTruthy();

    await (t as { execute: (i: unknown, o: { toolCallId: string }) => Promise<unknown> })
      .execute({}, { toolCallId });

    const row = await getPending(approvalId)!;
    const arr = JSON.parse(row.side_effect_results!) as Array<{ action: string; ok: boolean }>;
    expect(arr).toHaveLength(1);
    expect(arr[0].action).toBe('bind_document');
    expect(arr[0].ok).toBe(true);
  });
});