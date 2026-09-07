// 核销工作台路由（roadmap Item 5）：GET /overview 只读聚合。
// 挂载：index.ts `app.use('/api/writeoff/*', requireAuth)` + `app.route('/api/writeoff', writeoffRoute)`。
// 独立文件（与 Item 4 并行分区约定：不改 routes/ontology.ts）。
import { Hono } from 'hono';
import type { AuthEnv } from '../lib/auth-middleware.js';
import { getDbContext } from '../pipeline/db/dbBackend.js';
import { getWriteoffOverview } from '../ontology/writeoff.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { type ModelMessage } from 'ai';
import { createSession, setSessionTitle, appendMessages } from '../harness/sessionStore.js';
import { startSessionRun } from '../harness/runManager.js';
import { runSession } from '../harness/runSession.js';
import { validateAllocationPlan, type AllocationItem, type AllocationViolation } from '../ontology/writeoff.js';

export const writeoffRoute = new Hono<AuthEnv>();

writeoffRoute.use('*', async (c, next) => {
  if (!c.get('user')) return c.json({ error: 'unauthorized' }, 401);
  await next();
});

writeoffRoute.get('/overview', async (c) => {
  const user = c.get('user')!;
  try {
    const overview = await getWriteoffOverview(getDbContext(), user.id);
    return c.json(overview);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error('[writeoff] overview failed:', detail);
    return c.json({ error: 'overview failed', detail }, 500);
  }
});

// ---- POST /submit：工作台提交 -> chat 后台管道 -> L2 审批（不直接落边） ----

const SubmitSchema = z.object({
  relation: z.enum(['WRITE_OFF', 'OFFSET_SETTLE']),
  items: z.array(z.object({
    srcId: z.string().min(1),
    dstId: z.string().min(1),
    amount: z.number().positive(),
    partial: z.boolean().optional(),
    batch: z.string().optional(),
  })).min(1).max(50),
});

/** 固定指令模板：逐字 JSON + 场景关键词（核销/冲抵/票款/结算 -> settlement，审批恢复轮次
 *  的工具可见性依赖此命中，见 scenarios.ts SETTLEMENT_RE）+ 禁改数字纪律。 */
export function buildWriteoffInstruction(
  relation: 'WRITE_OFF' | 'OFFSET_SETTLE',
  items: AllocationItem[],
): string {
  const toolName = relation === 'WRITE_OFF' ? 'create_writeoff' : 'create_offset';
  const actionLabel = relation === 'WRITE_OFF' ? '票款核销' : '预付冲抵（冲抵结算）';
  return [
    `[核销工作台提交·${actionLabel}] 用户已在工作台完成勾选与金额分配（结算域操作）。`,
    `请立即调用 ${toolName} 工具，items 参数使用以下 JSON 数组（逐字传递，禁止修改、四舍五入、拆分或合并任何条目与数字）：`,
    JSON.stringify(items),
    `调用成功后，用一两句话向用户复述${actionLabel}结果（合计金额与影响的单据），并提醒等待审批中心批准。`,
    '若工具返回校验错误（status=invalid），原样转述 violations 给用户并停止；禁止自行调整数字后重试。',
  ].join('\n');
}

writeoffRoute.post('/submit', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);

  let json: unknown;
  try { json = await c.req.json(); } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const parsed = SubmitSchema.safeParse(json);
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', detail: parsed.error.flatten() }, 400);
  }
  const { relation, items } = parsed.data;

  // 计划级守恒预检（快速失败，省一次 LLM 轮次；权威校验在工具 execute）。
  const violations: AllocationViolation[] =
    await validateAllocationPlan(getDbContext(), relation, items, user.id);
  if (violations.length > 0) {
    return c.json({ error: 'allocation_violations', violations }, 400);
  }

  // 建 backstage 会话：标题先行，指令作为首条消息持久化，随后后台 run。
  const session = await createSession('trader', user.id);
  await setSessionTitle(session.id, `核销提交 ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`);
  const instruction = buildWriteoffInstruction(relation, items);
  const instructionUIMsg = {
    id: randomUUID(),
    role: 'user' as const,
    parts: [{ type: 'text' as const, text: instruction }],
  };
  await appendMessages(session.id, [instructionUIMsg]);

  const auditTraceId = randomUUID();
  console.log(JSON.stringify({ event: 'writeoff_submit', traceId: auditTraceId, sessionId: session.id, relation, itemCount: items.length }));

  const messages: ModelMessage[] = [{ role: 'user', content: instruction }];
  const start = await startSessionRun(session.id, user.id, 'trader', (signal) =>
    runSession({
      sessionId: session.id,
      userId: user.id,
      role: 'trader',
      messages,
      auditTraceId,
      abortSignal: signal,
      // 标题已手动设置，跳过首轮 title-gen。
      isFirstTurn: false,
    }),
  );
  if ('conflict' in start) {
    return c.json({ error: 'session_busy', activeRunId: null }, 409);
  }
  return c.json({ sessionId: session.id, runId: start.runId, status: 'busy' },
    { status: 200, headers: { 'x-session-id': session.id } });
});