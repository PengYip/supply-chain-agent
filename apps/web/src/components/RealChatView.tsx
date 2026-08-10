import React, { useCallback, useMemo, useRef, useEffect, useState } from 'react'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport, generateId, lastAssistantMessageIsCompleteWithApprovalResponses, lastAssistantMessageIsCompleteWithToolCalls, parseJsonEventStream, readUIMessageStream, uiMessageChunkSchema } from 'ai'
import type { UIMessage, UIMessageChunk } from 'ai'
import { Send, Sparkles, ShieldCheck, Loader2, AlertCircle, LogOut } from 'lucide-react'
import { RealMessageItem, ErrorMessage } from './RealMessageItem'
import { AgentStatusBar } from './AgentStatusBar'
import { useAgentStatus } from '../hooks/useAgentStatus'
import { buildRenderItems } from '../utils/realChatUtils'
import { authClient } from '../lib/auth'
import clsx from 'clsx'

export const RealChatView: React.FC<{ onSignOut?: () => void }> = ({ onSignOut }) => {
  const [input, setInput] = useState('')
  // sessionIdRef is read synchronously by the transport headers callback
  // (must be a ref, not state). We mirror it into `sessionId` state purely so
  // AgentStatusBar / useAgentStatus can react to it once the chat response
  // returns the id in the `x-session-id` header. The server reuses this id
  // for every request on this session, so the polled status path matches.
  const sessionIdRef = useRef<string | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)

  const fetchWrapper = useCallback<typeof fetch>(async (input, init) => {
    const res = await fetch(input, init)
    const sid = res.headers.get('x-session-id')
    if (sid && sid !== sessionIdRef.current) {
      sessionIdRef.current = sid
      setSessionId(sid)
    }
    return res
  }, [])

  const transport = useMemo(() => new DefaultChatTransport({
    api: '/api/chat',
    headers: () => (sessionIdRef.current ? { 'x-session-id': sessionIdRef.current } : {}) as Record<string, string>,
    body: { role: 'trader' },
    fetch: fetchWrapper,
  }), [fetchWrapper])
  const { messages, sendMessage, status, error, addToolApprovalResponse, setMessages } = useChat<UIMessage>({
    transport,
    sendAutomaticallyWhen: ({ messages }) =>
      lastAssistantMessageIsCompleteWithApprovalResponses({ messages }) ||
      lastAssistantMessageIsCompleteWithToolCalls({ messages }),
  })

  const handleApprove = (id: string) =>
    addToolApprovalResponse({ id, approved: true, reason: '用户确认执行' })

  const handleDeny = (id: string) =>
    addToolApprovalResponse({ id, approved: false, reason: '用户拒绝执行' })

  const pendingApproval = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg.role !== 'assistant') continue
      const parts = msg.parts as Array<Record<string, unknown>>
      for (let j = parts.length - 1; j >= 0; j--) {
        const part = parts[j]
        const type = typeof part.type === 'string' ? part.type : ''
        const isTool = type.startsWith('tool-') || type === 'dynamic-tool'
        if (!isTool) continue
        if (part.state === 'approval-requested') {
          const approval = part.approval as { id?: string } | undefined
          if (approval?.id) {
            return {
              kind: 'L2' as const,
              approvalId: approval.id,
              toolCallId: typeof part.toolCallId === 'string' ? part.toolCallId : approval.id,
            }
          }
        }
        if (part.state === 'output-available') {
          const output = part.output as Record<string, unknown> | undefined
          if (
            output?.status === 'blocked' &&
            output?.reason === 'requires_external_approval' &&
            typeof output?.ticketId === 'string'
          ) {
            return { kind: 'L3' as const, ticketId: output.ticketId }
          }
        }
      }
    }
    return null
  }, [messages])

  const [callbackState, setCallbackState] = useState<'idle' | 'loading' | 'success' | 'error'>('idle')
  const [callbackError, setCallbackError] = useState<string | null>(null)

  const handleApprovalCallback = async () => {
    if (!pendingApproval || callbackState === 'loading') return
    setCallbackState('loading')
    setCallbackError(null)

    try {
      const body =
        pendingApproval.kind === 'L3'
          ? { ticketId: pendingApproval.ticketId, approved: true, reason: '模拟审批通过' }
          : { approvalId: pendingApproval.approvalId, approved: true, reason: '模拟审批通过' }

      if (!sessionIdRef.current) {
        throw new Error('尚未建立会话，请先发送一条消息')
      }

      const res = await fetch('/api/approval/callback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-session-id': sessionIdRef.current },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const text = await res.text()
        let detail = text
        try {
          const json = JSON.parse(text)
          detail = json.error || JSON.stringify(json)
        } catch {}
        throw new Error(`${res.status}: ${detail}`)
      }

      const contentType = res.headers.get('content-type') || ''
      if (!contentType.includes('text/event-stream') || !res.body) {
        throw new Error('后端未返回 UIMessageStream')
      }

      const chunkStream = parseJsonEventStream({ stream: res.body, schema: uiMessageChunkSchema })
      const parsedStream = chunkStream.pipeThrough(
        new TransformStream({
          transform(chunk, controller) {
            if (!chunk.success) {
              controller.error(chunk.error)
              return
            }
            controller.enqueue(chunk.value as UIMessageChunk)
          },
        })
      ) as unknown as ReadableStream<UIMessageChunk>

      let streamingId: string | null = null
      for await (const raw of readUIMessageStream({ stream: parsedStream })) {
        const msg = { ...raw, id: raw.id || generateId() }
        if (streamingId) {
          setMessages((prev) => prev.map((m) => (m.id === streamingId ? msg : m)))
        } else {
          streamingId = msg.id
          setMessages((prev) => [...prev, msg])
        }
      }

      setCallbackState('success')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[approval callback] failed:', err)
      setCallbackError(msg)
      setCallbackState('error')
    }
  }

  const renderItems = useMemo(() => buildRenderItems(messages as unknown[]), [messages])
  const isStreaming = status === 'submitted' || status === 'streaming'
  const bottomRef = useRef<HTMLDivElement>(null)

  // Poll agent status only while a real session exists (real mode only).
  const agentStatus = useAgentStatus(sessionId)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [renderItems, status])

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const text = input.trim()
    if (!text || isStreaming) return
    setInput('')
    await sendMessage({ text })
  }

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-bgGray h-full">
      {/* Top strip */}
      <div className="h-14 bg-white border-b border-borderGray flex items-center justify-between px-4 shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-deepSea/10 flex items-center justify-center shrink-0">
            <Sparkles className="w-4 h-4 text-deepSea" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-medium text-textDark truncate">真实模式</div>
            <div className="text-xs text-textGray">DeepSeek + 真实工具调用</div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className={clsx(
            'text-xs px-2 py-1 rounded-full border',
            status === 'ready' ? 'bg-success/10 text-success border-success/20'
            : status === 'error' ? 'bg-danger/10 text-danger border-danger/20'
            : 'bg-amber/10 text-amber border-amber/20'
          )}>
            {status === 'submitted' ? '发送中'
            : status === 'streaming' ? '生成中'
            : status === 'error' ? '出错'
            : '就绪'}
          </span>
          <button
            type="button"
            title="退出登录"
            onClick={async () => {
              try {
                await authClient.signOut()
              } catch {
                /* best-effort */
              }
              onSignOut?.()
            }}
            className="p-1.5 rounded-lg hover:bg-bgGray text-textGray hover:text-textDark"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Agent status strip (real mode only) */}
      <AgentStatusBar sessionId={sessionId} status={agentStatus} />

      {/* Messages */}
      <div className="flex-1 overflow-auto p-4">
        <div className="max-w-3xl mx-auto space-y-5">
          {renderItems.length === 0 && (
            <div className="flex-1 flex flex-col items-center justify-center text-center px-6 py-12">
              <div className="w-12 h-12 rounded-2xl bg-deepSea/10 flex items-center justify-center mb-4">
                <Sparkles className="w-6 h-6 text-deepSea" />
              </div>
              <h3 className="text-base font-medium text-textDark mb-2">真实 DeepSeek 工具调用</h3>
              <p className="text-sm text-textGray mb-6 max-w-md">
                下方输入查询，AI 将自动调用后端真实工具（query_contract / query_orders / cross_check），所有数字来自工具返回，不编造。
              </p>
              <div className="flex flex-wrap justify-center gap-2">
                {[
                  '查合同 HT-2024-001',
                  '挂提单 BL-2024-0920-002 到合同 HT-2024-001',
                  '发起付款 50 万',
                  'HT-2024-001 和 HT-2024-002 金额对不上',
                  '核验提单 BL-2024-0920-002 字段',
                ].map((prompt) => (
                  <button
                    key={prompt}
                    onClick={() => setInput(prompt)}
                    className="flex items-center gap-1 px-3 py-1.5 rounded-full border border-borderGray bg-white text-sm text-textGray hover:border-amber hover:text-amber transition-colors"
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          )}
          {renderItems.map((item) => (
            <RealMessageItem
              key={item.id}
              item={item}
              isStreaming={isStreaming && item.role === 'assistant' && item.id === renderItems[renderItems.length - 1]?.id}
              onApprove={handleApprove}
              onDeny={handleDeny}
            />
          ))}
          <ErrorMessage error={error} />
          <div ref={bottomRef} />
        </div>
      </div>

      {/* Composer */}
      <div className="bg-white border-t border-borderGray p-4">
        <div className="max-w-3xl mx-auto">
          {pendingApproval && callbackState !== 'success' && (
            <div className="mb-3 rounded-lg border border-amber/30 bg-amber/5 p-2.5 flex items-start gap-2">
              <div className="w-6 h-6 rounded-full bg-amber/15 flex items-center justify-center shrink-0 mt-0.5">
                <ShieldCheck className="w-3.5 h-3.5 text-amber" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium text-textDark">
                  模拟审批通过 · {pendingApproval.kind === 'L3' ? `票据 ${pendingApproval.ticketId}` : `approval ${pendingApproval.approvalId.slice(0, 8)}`}
                </div>
                <div className="text-[11px] text-textGray mt-0.5">调试：POST /api/approval/callback</div>
                {callbackError && (
                  <div className="mt-1.5 text-[11px] text-danger flex items-start gap-1">
                    <AlertCircle className="w-3 h-3 shrink-0 mt-0.5" />
                    <span className="break-all">{callbackError}</span>
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={handleApprovalCallback}
                disabled={callbackState === 'loading'}
                className={clsx(
                  'shrink-0 inline-flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-medium transition-colors',
                  callbackState === 'loading'
                    ? 'bg-borderGray text-textGray cursor-not-allowed'
                    : 'bg-deepSea text-white hover:bg-deepSea/90'
                )}
              >
                {callbackState === 'loading' ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    审批处理中...
                  </>
                ) : (
                  <>
                    <ShieldCheck className="w-3.5 h-3.5" />
                    模拟审批通过
                  </>
                )}
              </button>
            </div>
          )}
          {callbackState === 'success' && (
            <div className="mb-3 rounded-lg border border-success/20 bg-success/5 px-3 py-2 text-xs text-success flex items-center gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5" />
              审批已通过，新消息已追加到对话
            </div>
          )}
          <form onSubmit={onSubmit} className="flex items-end gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  onSubmit(e)
                }
              }}
              placeholder="试试：查一下合同 HT-2024-001 的执行情况"
              rows={1}
              className="flex-1 min-h-[44px] max-h-[120px] p-2.5 rounded-lg border border-borderGray text-sm text-textDark placeholder:text-textGray focus:outline-none focus:border-steelBlue resize-none"
            />
            <button
              type="submit"
              disabled={!input.trim() || isStreaming}
              className={clsx(
                'h-10 px-3 rounded-lg flex items-center justify-center transition-colors',
                input.trim() && !isStreaming
                  ? 'bg-deepSea text-white hover:bg-opacity-90'
                  : 'bg-borderGray text-textGray cursor-not-allowed'
              )}
            >
              <Send className="w-4 h-4" />
            </button>
          </form>
          <div className="mt-2 text-[11px] text-textGray">
            L2 写操作（link_document / advance_contract_stage）需确认后执行；L3 资金操作（create_payment / refund_payment / modify_contract）需外部审批，不能在对话内直接完成。
          </div>
        </div>
      </div>
    </div>
  )
}

export default RealChatView
