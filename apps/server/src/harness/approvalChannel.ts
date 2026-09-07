// 外部审批适配层 seam（spec §7）。v1 仅 local：结构化日志，无外部行为。
// 飞书审批接入点：新增 LarkChannel 实现本接口，在 getApprovalChannel 按
// env.APPROVAL_CHANNEL 分发；callback 端点的 ticketId/approvalId 二选一语义
// 天然兼容外部审批回调。
import { env } from '../env.js';
import type { PendingApprovalRow } from './sessionStore.js';

export interface ApprovalChannel {
  readonly name: string;
  onTicketCreated(row: PendingApprovalRow): Promise<void>;
  onTicketResolved(row: PendingApprovalRow): Promise<void>;
}

const localChannel: ApprovalChannel = {
  name: 'local',
  async onTicketCreated(row) {
    console.log(JSON.stringify({ event: 'approval_ticket_created', channel: 'local',
      id: row.id, level: row.level, tool: row.tool_name, sessionId: row.session_id }));
  },
  async onTicketResolved(row) {
    console.log(JSON.stringify({ event: 'approval_ticket_resolved', channel: 'local',
      id: row.id, status: row.status }));
  },
};

let override: ApprovalChannel | undefined;
export function __setApprovalChannelForTests(ch?: ApprovalChannel) { override = ch; }

export function getApprovalChannel(): ApprovalChannel {
  if (override) return override;
  const configured = env.APPROVAL_CHANNEL ?? 'local';
  if (configured !== 'local') {
    console.warn(JSON.stringify({ event: 'approval_channel_unknown_fallback', configured }));
  }
  return localChannel;
}

export async function notifyApprovalCreated(row: PendingApprovalRow): Promise<void> {
  try { await getApprovalChannel().onTicketCreated(row); }
  catch (e) { console.warn(JSON.stringify({ event: 'approval_channel_notify_failed', phase: 'created', msg: String(e) })); }
}
export async function notifyApprovalResolved(row: PendingApprovalRow): Promise<void> {
  try { await getApprovalChannel().onTicketResolved(row); }
  catch (e) { console.warn(JSON.stringify({ event: 'approval_channel_notify_failed', phase: 'resolved', msg: String(e) })); }
}
