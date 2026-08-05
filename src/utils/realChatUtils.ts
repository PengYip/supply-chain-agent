export interface ToolCallStep {
  toolCallId: string
  toolName: string
  args: unknown
  status: 'running' | 'completed'
  result?: unknown
  blocked?: {
    reason: string
    ticketId: string
    message?: string
  }
}

// 按 parts 原始顺序交错的渲染段。文本段与工具段保持模型产出的时间顺序，
// 避免把工具调用统一挤到末尾（agent loop 通常是：先调工具→后总结文本）。
export type Segment =
  | { kind: 'text'; text: string }
  | { kind: 'tool-group'; steps: ToolCallStep[] }
  | {
      kind: 'approval-request'
      approvalId: string
      toolCallId: string
      toolName: string
      args: unknown
    }

export interface RenderItem {
  id: string
  role: 'user' | 'assistant'
  segments: Segment[]
}

const isBlockedOutput = (output: unknown): output is { status: 'blocked'; reason: string; ticketId: string; message?: string } => {
  if (output === null || typeof output !== 'object') return false
  const r = output as Record<string, unknown>
  return r.status === 'blocked' && r.reason === 'requires_external_approval' && typeof r.ticketId === 'string'
}

export const buildRenderItems = (messages: unknown[]): RenderItem[] => {
  const items: RenderItem[] = []

  for (const raw of messages) {
    const msg = raw as { id?: string; role?: string; parts?: unknown[] }
    const id = msg.id || `${Date.now()}-${Math.random()}`
    const role = msg.role === 'user' ? 'user' : 'assistant'
    const parts = (msg.parts || []) as Array<{
      type: string
      text?: string
      toolCallId?: string
      toolName?: string
      input?: unknown
      output?: unknown
      state?: string
      approval?: { id: string }
    }>

    const segments: Segment[] = []
    let textBuf = ''
    const flushText = () => {
      if (textBuf) {
        segments.push({ kind: 'text', text: textBuf })
        textBuf = ''
      }
    }

    for (const p of parts) {
      if (p.type === 'text' && typeof p.text === 'string') {
        textBuf += p.text
        continue
      }

      // AI SDK 6 L2 软确认门：工具处于 approval-requested 状态，等待用户确认。
      if (p.state === 'approval-requested' && p.approval?.id && p.toolCallId) {
        flushText()
        segments.push({
          kind: 'approval-request',
          approvalId: p.approval.id,
          toolCallId: p.toolCallId,
          toolName: p.toolName || p.type.replace(/^tool-/, ''),
          args: p.input,
        })
        continue
      }

      // AI SDK 6: 工具调用是单个 part，type 为 `tool-${name}` 或 `dynamic-tool`，含 toolCallId。
      // 字段 input/output/state；连续的工具 part 归入同一个 tool-group，保持时间顺序。
      // 见 node_modules/ai/dist/index.d.ts UIToolInvocation (line 1720) / ToolUIPart (line 1810)。
      if (p.toolCallId && (p.type === 'dynamic-tool' || p.type.startsWith('tool-'))) {
        flushText()
        const completed = p.state === 'output-available'
        const step: ToolCallStep = {
          toolCallId: p.toolCallId,
          toolName: p.toolName || p.type.replace(/^tool-/, ''),
          args: p.input,
          result: completed ? p.output : undefined,
          status: completed ? 'completed' : 'running',
        }

        // L3 外部审批门：工具 execute 返回 { status: 'blocked', reason: 'requires_external_approval', ticketId }
        if (completed && isBlockedOutput(p.output)) {
          step.blocked = {
            reason: p.output.reason,
            ticketId: p.output.ticketId,
            message: p.output.message,
          }
        }

        const last = segments[segments.length - 1]
        if (last && last.kind === 'tool-group') {
          last.steps.push(step)
        } else {
          segments.push({ kind: 'tool-group', steps: [step] })
        }
      }
    }
    flushText()

    if (role === 'assistant') {
      items.push({ id, role, segments })
    } else if (segments.length > 0) {
      // 用户消息只保留文本段（v6 下用户输入为 text part）
      items.push({ id, role, segments: segments.filter((s) => s.kind === 'text') })
    }
  }
  return items
}
