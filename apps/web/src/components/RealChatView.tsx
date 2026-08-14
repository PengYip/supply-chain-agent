import React, { useCallback, useMemo, useRef, useEffect, useState } from 'react'
import { generateId, parseJsonEventStream, readUIMessageStream, uiMessageChunkSchema } from 'ai'
import type { UIMessage, UIMessageChunk } from 'ai'
import { useSessionMessages } from '../hooks/useSessionMessages'
import { Send, Sparkles, ShieldCheck, Loader2, AlertCircle, LogOut, Paperclip } from 'lucide-react'
import { RealMessageItem, ErrorMessage } from './RealMessageItem'
import { HumanAgentStatusBar } from './HumanAgentStatusBar'
import { useHumanAgentStatus } from '../hooks/useHumanAgentStatus'
import { type ContextFile } from '../hooks/useFiles'
import { buildRenderItems } from '../utils/realChatUtils'
import { authClient } from '../lib/auth'
import clsx from 'clsx'

export const RealChatView: React.FC<{
  onSignOut?: () => void;
  sessionId?: string | null;
  contextFiles: ContextFile[];
  setContextFiles: React.Dispatch<React.SetStateAction<ContextFile[]>>;
  /** Phase 5: called when a chat turn finishes so the sidebar can refresh
   *  (a newly-generated session title appears). */
  onSessionChanged?: () => void;
}> = ({ onSignOut, sessionId, contextFiles, setContextFiles, onSessionChanged }) => {
  const [input, setInput] = useState('')

  // Phase 3: file upload state. Uploads POST to /api/files (MinIO + ingest bridge).
  const [uploadState, setUploadState] = useState<'idle' | 'uploading' | 'success' | 'error'>('idle')
  const [uploadMsg, setUploadMsg] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const sendMessageRef = useRef<((msg: { text: string }) => void) | null>(null)

  const handleFileUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    // Client guard: reject oversized uploads before POSTing. Keep in sync with
    // the server default (env.MAX_UPLOAD_BYTES); the server re-checks and
    // returns 413, so this is a latency/UX guard, not the enforcement edge.
    const MAX_UPLOAD_BYTES = 25 * 1024 * 1024
    if (file.size > MAX_UPLOAD_BYTES) {
      setUploadState('error')
      setUploadMsg(`文件过大（${(file.size / 1024 / 1024).toFixed(1)} MiB），上限为 25 MiB`)
      if (fileInputRef.current) fileInputRef.current.value = ''
      return
    }
    setUploadState('uploading')
    setUploadMsg(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch('/api/files', {
        method: 'POST',
        body: fd,
        credentials: 'include',
      })
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string; detail?: string }
        throw new Error(j.error || j.detail || `upload failed (${res.status})`)
      }
      const data = (await res.json()) as { docId?: string; filename?: string }
      setUploadState('success')
      setUploadMsg(
        `已上传: ${data.filename ?? file.name}${data.docId ? ` (docId ${data.docId})` : ''}`,
      )
      if (data.docId && sendMessageRef.current) {
        sendMessageRef.current({ text: `[系统提示] 已上传文件 "${data.filename ?? file.name}"（docId: ${data.docId}），系统已自动完成录入(ingest)与索引，无需再调 ingest_document。请直接对该 docId 调用 extract_fields 抽取业务字段，再调用 present_document_review 向用户呈现五维复核卡。` })
      }
    } catch (err) {
      setUploadState('error')
      setUploadMsg(err instanceof Error ? err.message : String(err))
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }, [])
  // Mirror the latest contextFiles into a ref so the upload-triggered system
  // prompt and sendMessage always read the current value.
  const contextFilesRef = useRef(contextFiles)
  useEffect(() => { contextFilesRef.current = contextFiles }, [contextFiles])

  const { messages, status, error, sendMessage, setMessages } = useSessionMessages(sessionId ?? null)
  const liveSessionId = sessionId ?? null
  const isBusy = status === 'busy'
  const isStreaming = isBusy
  sendMessageRef.current = (msg: { text: string }) => { void sendMessage(msg.text) }

  // Phase 5: refresh the sidebar when a run finishes (isBusy transitions to
  // false). Uses a ref so it only fires on the transition, not on mount.
  const prevBusyRef = useRef(false)
  const onSessionChangedRef = useRef(onSessionChanged)
  onSessionChangedRef.current = onSessionChanged
  useEffect(() => {
    const wasBusy = prevBusyRef.current
    prevBusyRef.current = isBusy
    if (wasBusy && !isBusy) {
      // Run just finished: refresh sidebar for new title, with a delayed
      // second refresh because title-gen is a fire-and-forget second LLM call.
      onSessionChangedRef.current?.()
      const t = window.setTimeout(() => onSessionChangedRef.current?.(), 4000)
      return () => window.clearTimeout(t)
    }
  }, [isBusy])

  const handleApprove = (id: string) => {
    void postApproval({ approvalId: id, approved: true })
  }

  const handleDeny = (id: string) => {
    void postApproval({ approvalId: id, approved: false })
  }

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
  const [lastApprovalApproved, setLastApprovalApproved] = useState(true)
  const [sendError, setSendError] = useState<string | null>(null)

  const postApproval = async (body: { approvalId?: string; ticketId?: string; approved: boolean }) => {
    if (!sessionId || callbackState === 'loading') return
    setCallbackState('loading')
    setCallbackError(null)
    try {
      const res = await fetch('/api/approval/callback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-session-id': sessionId },
        body: JSON.stringify({ ...body, reason: body.approved ? '用户确认执行' : '用户拒绝执行' }),
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
      setLastApprovalApproved(body.approved)
      setCallbackState('success')
      return
    }
      const chunkStream = parseJsonEventStream({ stream: res.body, schema: uiMessageChunkSchema })
      const parsedStream = chunkStream.pipeThrough(
        new TransformStream({
          transform(chunk, controller) {
            if (!chunk.success) {
              controller.error((chunk as { error: unknown }).error)
              return
            }
            controller.enqueue(chunk.value as UIMessageChunk)
          },
        }),
      ) as unknown as ReadableStream<UIMessageChunk>

      let streamingId: string | null = null
      for await (const raw of readUIMessageStream({ stream: parsedStream })) {
        const msg = { ...raw, id: raw.id || generateId() } as UIMessage
        if (streamingId) {
          setMessages((prev) => prev.map((m) => (m.id === streamingId ? msg : m)))
        } else {
          streamingId = msg.id
          setMessages((prev) => [...prev, msg])
        }
      }
      setLastApprovalApproved(body.approved)
      setCallbackState('success')
    } catch (err) {
      console.error('[approval callback] failed:', err)
      setCallbackError(err instanceof Error ? err.message : String(err))
      setCallbackState('error')
    }
  }

  const handleApprovalCallback = async () => {
    if (!pendingApproval || callbackState === 'loading') return
    if (pendingApproval.kind === 'L3') {
      void postApproval({ ticketId: pendingApproval.ticketId, approved: true })
    } else {
      void postApproval({ approvalId: pendingApproval.approvalId, approved: true })
    }
  }

  const renderItems = useMemo(() => buildRenderItems(messages as unknown[]), [messages])
  const bottomRef = useRef<HTMLDivElement>(null)

  // Poll agent status only while a real session exists (real mode only).
  const agentStatus = useHumanAgentStatus(liveSessionId, isStreaming)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [renderItems, status])

  const removeFromConversation = useCallback((key: string) => {
    setContextFiles((prev) => prev.filter((f) => f.key !== key))
  }, [setContextFiles])

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const text = input.trim()
    if (!text || isBusy) return
    setInput('')
    setSendError(null)
    // sendMessage reads contextFiles synchronously from the closure and
    // consumes them for THIS turn only. Clear after the call resolves so the
    // files do not linger for the next message.
    const res = await sendMessage(text, { contextFiles })
    if (res.error) {
      // Restore the draft so the user does not lose their text.
      setInput(text)
      setSendError(res.error === 'session_busy' ? '会话正在处理上一条消息，请稍候再发送' : `发送失败：${res.error}`)
    }
    setContextFiles([])
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
            status === 'idle' ? 'bg-success/10 text-success border-success/20'
            : status === 'interrupted' ? 'bg-amber/10 text-amber border-amber/20'
            : error ? 'bg-danger/10 text-danger border-danger/20'
            : 'bg-amber/10 text-amber border-amber/20'
          )}>
            {status === 'busy' ? '生成中'
            : status === 'interrupted' ? '已中断'
            : error ? '出错'
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
      <HumanAgentStatusBar sessionId={liveSessionId} status={agentStatus} />

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
          <ErrorMessage error={error ? new Error(error) : null} />
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
            <div className={clsx(
              'mb-3 rounded-lg border px-3 py-2 text-xs flex items-center gap-1.5',
              lastApprovalApproved
                ? 'border-success/20 bg-success/5 text-success'
                : 'border-borderGray bg-bgGray text-textGray',
            )}>
              <ShieldCheck className="w-3.5 h-3.5" />
              {lastApprovalApproved ? '审批已通过，新消息已追加到对话' : '已拒绝执行该操作'}
            </div>
          )}
          {sendError && (
            <div className="mb-3 rounded-lg border border-danger/20 bg-danger/5 px-3 py-2 text-xs text-danger flex items-center gap-1.5">
              <AlertCircle className="w-3.5 h-3.5 shrink-0" />
              <span className="break-all">{sendError}</span>
            </div>
          )}
          {contextFiles.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, padding: '4px 8px', borderBottom: '1px solid #eee', marginBottom: 8 }}>
              {contextFiles.map((f) => (
                <span key={f.key} style={{ background: '#e3f2fd', border: '1px solid #90caf9', borderRadius: 3, padding: '2px 6px', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  {f.filename}
                  <span onClick={() => removeFromConversation(f.key)} style={{ cursor: 'pointer', color: '#666' }}>x</span>
                </span>
              ))}
            </div>
          )}
          <form onSubmit={onSubmit} className="flex items-end gap-2">
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              onChange={handleFileUpload}
              accept=".pdf,.txt,.md,.docx,.json"
            />
            <button
              type="button"
              title="上传文件"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadState === 'uploading'}
              className="h-10 w-10 shrink-0 rounded-lg border border-borderGray flex items-center justify-center text-textGray hover:text-textDark hover:bg-bgGray disabled:opacity-50"
            >
              {uploadState === 'uploading' ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Paperclip className="w-4 h-4" />
              )}
            </button>
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
          {uploadMsg && (
            <div
              className={clsx(
                'mt-2 text-[11px] flex items-center gap-1.5',
                uploadState === 'error' ? 'text-danger' : 'text-success',
              )}
            >
              {uploadState === 'error' ? (
                <AlertCircle className="w-3 h-3 shrink-0" />
              ) : (
                <ShieldCheck className="w-3 h-3 shrink-0" />
              )}
              <span className="break-all">{uploadMsg}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default RealChatView
