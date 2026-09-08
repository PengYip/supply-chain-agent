// 事件登记表单入口路由（对话外的第二个客户端, 2026-09-08）：POST / 提交 ->
// chat 后台管道 -> create_trade_event（L2 审批）-> insertTradeFact 唯一写入边界。
// 完全镜像核销工作台先例（routes/writeoff.ts）：同一会话/场景/审批/审计路径，
// 禁止路由直调 insertTradeFact。GET /schema 是表单字段投影（inputSchema SSOT 反射）。
import { Hono } from 'hono';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { ModelMessage } from 'ai';
import type { AuthEnv } from '../lib/auth-middleware.js';
import { getDbContext } from '../pipeline/db/dbBackend.js';
import { entitySchema } from '../ontology/index.js';
import {
  CreateTradeEventInputSchema, tradeEventFormSchemaJson,
} from '../ontology/eventTools.js';
import { createSession, setSessionTitle, appendMessages } from '../harness/sessionStore.js';
import { startSessionRun } from '../harness/runManager.js';
import { runSession } from '../harness/runSession.js';
import { fieldLevelErrors } from '../lib/zodFieldErrors.js';

export const tradeEventsRoute = new Hono<AuthEnv>();

tradeEventsRoute.use('*', async (c, next) => {
  if (!c.get('user')) return c.json({ error: 'unauthorized' }, 401);
  await next();
});

/** GET /schema — 表单字段投影（字段/枚举全部反射自 create_trade_event inputSchema）。 */
tradeEventsRoute.get('/schema', (c) => c.json(tradeEventFormSchemaJson()));

export type TradeEventInput = z.infer<typeof CreateTradeEventInputSchema>;

/** 固定指令模板：逐字 JSON + 场景关键词（结算域 -> settlement；后台 run 的首轮场景
 *  由下方 runSession 显式指定，关键词兜底的是审批恢复轮 —— resume 带 skipStatusMessage，
 *  自动检测扫到的末尾 user 消息正是本指令，命中与否决定恢复轮工具可见性）+ 禁改数字纪律。
 *  与核销工作台模板同构。 */
export function buildTradeEventInstruction(input: TradeEventInput): string {
  const { entityType, ...fields } = input;
  return [
    `[事件登记·表单提交] 用户已在实体台账表单完成字段录入（结算域操作，登记 ${entityType} 事实）。`,
    '请立即调用 create_trade_event 工具，input 参数使用以下 JSON（逐字传递，禁止修改、四舍五入或增删任何字段与数字）：',
    JSON.stringify({ entityType, ...fields }),
    '调用成功后，用一两句话向用户复述登记结果（事件类型、金额与业务时间），并提醒等待审批中心批准后生效。',
    '若工具返回校验错误（status=invalid），原样转述 detail 给用户并停止；禁止自行调整数字后重试。',
  ].join('\n');
}

tradeEventsRoute.post('/', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);

  let json: unknown;
  try { json = await c.req.json(); } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  // inputSchema SSOT：与 create_trade_event 工具同一 zod（strict：注册表外字段快速失败），
  // 字段级错误回传表单回显。
  const parsed = CreateTradeEventInputSchema.strict().safeParse(json);
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', detail: fieldLevelErrors(parsed.error) }, 400);
  }
  const input = parsed.data;

  // 注册表语义预检（快速失败，省一次 LLM 轮次；权威校验仍在工具 execute/写入边界）：
  // entityType 判别 -> 实体 strict schema（含 逆向=负数金额规则）。
  const { entityType, validAt, ...payload } = input;
  const entityCheck = entitySchema(entityType).safeParse(payload);
  if (!entityCheck.success) {
    return c.json({ error: 'invalid_event', detail: fieldLevelErrors(entityCheck.error) }, 400);
  }

  // 建 backstage 会话：标题先行，指令作为首条消息持久化，随后后台 run（照核销先例）。
  const session = await createSession('trader', user.id);
  await setSessionTitle(session.id, `事件登记 ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`);
  const instruction = buildTradeEventInstruction(input);
  const instructionUIMsg = {
    id: randomUUID(),
    role: 'user' as const,
    parts: [{ type: 'text' as const, text: instruction }],
  };
  await appendMessages(session.id, [instructionUIMsg]);

  // ticketId = 工单号，同时作为本次后台 run 的审计 trace id（usage-audit 可对账）。
  const ticketId = randomUUID();
  console.log(JSON.stringify({ event: 'trade_event_submit', ticketId, sessionId: session.id, entityType: input.entityType }));

  const messages: ModelMessage[] = [{ role: 'user', content: instruction }];
  const start = await startSessionRun(session.id, user.id, 'trader', (signal) =>
    runSession({
      sessionId: session.id,
      userId: user.id,
      role: 'trader',
      messages,
      auditTraceId: ticketId,
      abortSignal: signal,
      // 标题已手动设置，跳过首轮 title-gen。
      isFirstTurn: false,
      // 显式钉 settlement：首轮 runStream 会在指令尾部追加 <agent_status> 状态消息
      // （role:'user'），detectScenario 只扫末尾 user 消息，对状态文本落 entry，
      // create_trade_event 不可见 -> 模型只能 escalate_to_human（2026-09-08 事故）。
      scenario: 'settlement',
    }),
  );
  if ('conflict' in start) {
    return c.json({ error: 'session_busy', activeRunId: null }, 409);
  }
  return c.json(
    { ticketId, sessionId: session.id, runId: start.runId, status: 'busy' },
    { status: 200, headers: { 'x-session-id': session.id } },
  );
});
