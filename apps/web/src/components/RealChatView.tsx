import React, { useCallback, useMemo, useRef, useEffect, useState } from 'react'
import { useSessionMessages } from '../hooks/useSessionMessages'
import { Send, Sparkles, ShieldCheck, Loader2, AlertCircle, LogOut, Paperclip, Check, Star } from 'lucide-react'
import { getFavorite, setFavorite, clearFavorite, type FavoriteProbe } from '../api/favorites'
import { RealMessageItem, ErrorMessage } from './RealMessageItem'
import { HumanAgentStatusBar } from './HumanAgentStatusBar'
import { useHumanAgentStatus } from '../hooks/useHumanAgentStatus'
import { type ContextFile } from '../hooks/useFiles'
import { type DocParseState } from '../api/process'
import {
  buildRenderItems,
  parseEscalateArgs,
  escalateCategoryLabel,
  severityLabel,
  severityBadgeClass,
  type EscalateCategory,
  type EscalateSeverity,
} from '../utils/realChatUtils'
import { authClient } from '../lib/auth'
import clsx from 'clsx'

/** Per-file parse status segment shown inside a context chip. Extends the
 *  existing chip (no restyle): spinner+解析中 in flight, green check+已解析,
 *  amber 需OCR, red 解析失败. needs_ocr keeps the file referenced; no
 *  auto-retry in v1. */
function ContextChipStatus({ state }: { state?: DocParseState }) {
  if (!state) return null
  const base: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 3,
    fontSize: 11,
    lineHeight: 1,
    whiteSpace: 'nowrap',
  }
  if (state === 'parsing') {
    return (
      <span style={{ ...base, color: '#6b7280' }}>
        <Loader2 size={11} className="animate-spin" />
        解析中
      </span>
    )
  }
  if (state === 'parsed') {
    return (
      <span style={{ ...base, color: '#16a34a' }}>
        <Check size={11} />
        已解析
      </span>
    )
  }
  if (state === 'needs_ocr') {
    return <span style={{ ...base, color: '#d97706' }}>需OCR</span>
  }
  return (
    <span style={{ ...base, color: '#dc2626' }}>
      <AlertCircle size={11} />
      解析失败
    </span>
  )
}

/** L3 人工复核卡（挂在输入框上方）：结构化问答式交互 —— 问题 + 两个带说明
 *  的处理选项 + 可选补充意见，单次提交。选项与意见构成一条原子化的人工
 *  判断：提交前可完整核对，补充意见原文作为 reason 传给 Agent。
 *  「暂不处理」是本地逃生口：仅隐藏本卡，不回调后端，工单保持 pending。
 *  视觉上是 L2 SoftGateCard 的姊妹卡（同布局语法），配色用 deepSea 区分
 *  「人工复核」与 L2 的琥珀色「操作确认」。 */
const HumanReviewCard: React.FC<{
  ticketId: string
  issueText: string
  severity?: EscalateSeverity
  category?: EscalateCategory
  choice: 'approve' | 'deny' | null
  onChoice: (choice: 'approve' | 'deny') => void
  note: string
  onNoteChange: (note: string) => void
  onSubmit: () => void
  onDismiss: () => void
  loading: boolean
  error: string | null
}> = ({ ticketId, issueText, severity, category, choice, onChoice, note, onNoteChange, onSubmit, onDismiss, loading, error }) => {
  // 保守默认原则：高风险工单推荐驳回（先停止，人工核查后再继续），
  // 其余（medium/low/未知）推荐通过。推荐只影响排序与标识，不代替选择，
  // 提交前仍需人工显式选中。
  const recommended: 'approve' | 'deny' = severity === 'high' ? 'deny' : 'approve'
  const baseOptions: Array<{ value: 'approve' | 'deny'; label: string; description: string }> = [
    {
      value: 'approve',
      label: '通过，继续处理',
      description: '确认无误或已补充信息，Agent 按人工判断继续',
    },
    {
      value: 'deny',
      label: '驳回，停止该操作',
      description: '该工单对应的操作不执行，Agent 停止后续尝试并如实转达',
    },
  ]
  // 推荐项排在首位（高风险时「驳回」在前）。
  const options = recommended === 'deny' ? [baseOptions[1], baseOptions[0]] : baseOptions
  return (
    <div className="mb-3 rounded-lg border border-deepSea/30 bg-deepSea/5 p-3">
      {/* 头部：图标 + 标题 + 工单号 + 分类/严重度徽章 */}
      <div className="flex items-start gap-2.5">
        <div className="w-6 h-6 rounded-full bg-deepSea/10 flex items-center justify-center shrink-0">
          <ShieldCheck className="w-3.5 h-3.5 text-deepSea" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-textDark">人工复核</span>
            <span className="text-[11px] font-mono text-steelBlue bg-white rounded px-1.5 py-0.5 border border-borderGray">
              {ticketId}
            </span>
            {category && (
              <span className="text-[11px] leading-none rounded-full px-2 py-1 bg-white text-deepSea border border-deepSea/20">
                {escalateCategoryLabel(category)}
              </span>
            )}
            {severity && (
              <span className={clsx('text-[11px] leading-none rounded-full px-2 py-1 border', severityBadgeClass(severity))}>
                {severityLabel(severity)}
              </span>
            )}
          </div>
          {issueText && (
            <p className="text-[13px] text-textDark leading-relaxed mt-1.5 break-words">{issueText}</p>
          )}
        </div>
      </div>

      {/* 处理方式：单选项 + 一行说明（选中态在提交前保持可视区分） */}
      <div className="mt-3 space-y-2">
        {options.map((opt) => {
          const selected = choice === opt.value
          return (
            <button
              key={opt.value}
              type="button"
              disabled={loading}
              onClick={() => onChoice(opt.value)}
              className={clsx(
                'w-full text-left rounded-lg border px-3 py-2 flex items-start gap-2.5 transition-colors',
                selected
                  ? 'border-deepSea bg-white ring-1 ring-deepSea/30'
                  : 'border-borderGray bg-white/70 hover:border-steelBlue',
                loading && 'cursor-not-allowed opacity-70',
              )}
            >
              <span
                className={clsx(
                  'w-3.5 h-3.5 rounded-full border-2 mt-0.5 shrink-0 flex items-center justify-center',
                  selected ? 'border-deepSea' : 'border-borderGray',
                )}
              >
                {selected && <span className="w-1.5 h-1.5 rounded-full bg-deepSea" />}
              </span>
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-[13px] font-medium text-textDark">{opt.label}</span>
                  {opt.value === recommended && (
                    <span className="text-[10px] leading-none rounded-full px-1.5 py-0.5 bg-deepSea/5 text-deepSea border border-deepSea/20">
                      推荐
                    </span>
                  )}
                </span>
                <span className="block text-[11px] text-textGray leading-relaxed mt-0.5">{opt.description}</span>
              </span>
            </button>
          )
        })}
      </div>

      {/* 补充意见：原文作为人工判断依据（reason）注入 Agent 恢复指令 */}
      <div className="mt-3">
        <div className="text-[11px] text-textGray mb-1">
          补充意见（可选）— 会作为人工判断依据直接传给 Agent
        </div>
        <textarea
          value={note}
          onChange={(e) => onNoteChange(e.target.value)}
          disabled={loading}
          rows={2}
          placeholder="例如：平仓基准价 P=812 元/吨，硫分 0.8%，请按此计算"
          className="w-full rounded-lg border border-borderGray bg-white p-2 text-xs text-textDark placeholder:text-textGray focus:outline-none focus:border-steelBlue resize-none disabled:opacity-70"
        />
      </div>

      {error && (
        <div className="mt-2 text-[11px] text-danger flex items-start gap-1">
          <AlertCircle className="w-3 h-3 shrink-0 mt-0.5" />
          <span className="break-all">{error}</span>
        </div>
      )}

      <div className="mt-3 flex items-center gap-3">
        <div className="flex-1 min-w-0">
          {!choice && !loading && <span className="text-[11px] text-textGray">请选择一种处理方式</span>}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          disabled={loading}
          className={clsx(
            'shrink-0 text-[11px] text-textGray hover:text-textDark transition-colors',
            loading && 'cursor-not-allowed opacity-50',
          )}
        >
          暂不处理
        </button>
        <button
          type="button"
          onClick={onSubmit}
          disabled={!choice || loading}
          className={clsx(
            'shrink-0 inline-flex items-center gap-1 px-3.5 py-1.5 rounded-md text-xs font-medium transition-colors',
            !choice || loading
              ? 'bg-borderGray text-textGray cursor-not-allowed'
              : 'bg-deepSea text-white hover:bg-deepSea/90',
          )}
        >
          {loading ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              提交中...
            </>
          ) : (
            <>
              <ShieldCheck className="w-3.5 h-3.5" />
              提交复核结果
            </>
          )}
        </button>
      </div>
    </div>
  )
}

export const RealChatView: React.FC<{
  onSignOut?: () => void;
  sessionId?: string | null;
  contextFiles: ContextFile[];
  setContextFiles: React.Dispatch<React.SetStateAction<ContextFile[]>>;
  /** Phase 5: called when a chat turn finishes so the sidebar can refresh
   *  (a newly-generated session title appears). */
  onSessionChanged?: () => void;
  /** Called when the composer auto-created a session on the welcome screen
   *  so the app can make it active (sidebar + SSE follow). */
  onSessionCreated?: (id: string) => void;
  /** Called after an upload lands so App's shared file list (and the file
   *  panel) shows the new object. */
  onFilesChanged?: () => void;
  /** Per-docId parse state for referenced files, shown on the context chips
   *  (owned by App, where 添加到对话 fires the parse). */
  docParseStates: Record<string, DocParseState>;
}> = ({ onSignOut, sessionId, contextFiles, setContextFiles, onSessionChanged, onSessionCreated, onFilesChanged, docParseStates }) => {
  const [input, setInput] = useState('')

  // 对话收藏: probe + header affordance for the CURRENT session. Self-contained
  // here (no prop threading from App) — mutations notify App via
  // onSessionChanged so the sidebar list re-fetches fresh favorited flags.
  const [favProbe, setFavProbe] = useState<FavoriteProbe | null>(null)
  const [favBusy, setFavBusy] = useState(false)
  const [favMenuOpen, setFavMenuOpen] = useState(false)
  const [favNoteDraft, setFavNoteDraft] = useState('')

  useEffect(() => {
    setFavMenuOpen(false)
    if (!sessionId) {
      setFavProbe(null)
      return
    }
    let alive = true
    void getFavorite(sessionId).then((p) => {
      if (alive) setFavProbe(p)
    })
    return () => {
      alive = false
    }
  }, [sessionId])

  // Star click: not favorited -> favorite + open the note editor right away;
  // already favorited -> toggle the note editor (unfavorite lives inside it,
  // so a stray click cannot silently drop a favorite + its feedback note).
  const handleHeaderStar = async () => {
    if (!sessionId || favBusy) return
    if (favProbe?.favorited) {
      setFavNoteDraft(favProbe.note ?? '')
      setFavMenuOpen((v) => !v)
      return
    }
    setFavBusy(true)
    try {
      await setFavorite(sessionId)
      setFavProbe({ sessionId, favorited: true, note: null, updatedAt: new Date().toISOString() })
      setFavNoteDraft('')
      setFavMenuOpen(true)
      onSessionChanged?.()
    } catch { /* probe stays stale-free: re-probe on failure */
      void getFavorite(sessionId).then((p) => setFavProbe(p))
    } finally {
      setFavBusy(false)
    }
  }

  const handleUnfavorite = async () => {
    if (!sessionId || favBusy) return
    setFavBusy(true)
    try {
      await clearFavorite(sessionId)
      setFavProbe({ sessionId, favorited: false, note: null, updatedAt: null })
      setFavMenuOpen(false)
      onSessionChanged?.()
    } finally {
      setFavBusy(false)
    }
  }

  const handleSaveFavNote = async () => {
    if (!sessionId || favBusy) return
    setFavBusy(true)
    try {
      await setFavorite(sessionId, favNoteDraft)
      const note = favNoteDraft.trim() || null
      setFavProbe((p) => (p ? { ...p, note, updatedAt: new Date().toISOString() } : p))
      setFavMenuOpen(false)
      onSessionChanged?.()
    } finally {
      setFavBusy(false)
    }
  }

  // File upload state. Uploads POST to /api/files — storage-only; parsing
  // activates when the file is added to a conversation as a reference.
  const [uploadState, setUploadState] = useState<'idle' | 'uploading' | 'success' | 'error'>('idle')
  const [uploadMsg, setUploadMsg] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

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
      const data = (await res.json()) as { filename?: string }
      setUploadState('success')
      setUploadMsg(`已上传「${data.filename ?? file.name}」，可在右侧文件管理中添加到对话`)
      // Storage-only: no agent turn, no auto-parse here. Refresh the shared
      // file list so the new object (with its 未解析 badge) shows immediately.
      onFilesChanged?.()
    } catch (err) {
      setUploadState('error')
      setUploadMsg(err instanceof Error ? err.message : String(err))
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }, [onFilesChanged])
  // Mirror the latest contextFiles into a ref so the upload-triggered system
  // prompt and sendMessage always read the current value.
  const contextFilesRef = useRef(contextFiles)
  useEffect(() => { contextFilesRef.current = contextFiles }, [contextFiles])

  const { messages, status, error, sendMessage } = useSessionMessages(sessionId ?? null, {
    onSessionCreated: (id) => onSessionCreated?.(id),
  })
  const liveSessionId = sessionId ?? null
  const isBusy = status === 'busy'
  const isStreaming = isBusy

  // Phase 5: refresh the sidebar when a run finishes (isBusy transitions to
  // false). Uses a ref so it only fires on the transition, not on mount.
  const prevBusyRef = useRef(false)
  const onSessionChangedRef = useRef(onSessionChanged)
  onSessionChangedRef.current = onSessionChanged
  useEffect(() => {
    const wasBusy = prevBusyRef.current
    prevBusyRef.current = isBusy
    if (wasBusy !== isBusy) {
      // Refresh the sidebar on BOTH edges: run start (busy badge appears via
      // GET /api/sessions status) and run end (badge clears, title may appear).
      onSessionChangedRef.current?.()
    }
    if (wasBusy && !isBusy) {
      // Title generation is a fire-and-forget second LLM call that finishes
      // ~1-3s AFTER the run ends. The immediate refresh above races ahead of
      // the title being written, so schedule a delayed second refresh.
      const t = window.setTimeout(() => onSessionChangedRef.current?.(), 4000)
      return () => window.clearTimeout(t)
    }
  }, [isBusy])

  // When switching back to a session whose run ENDED while we were viewing
  // another session, nobody was subscribed to its SSE to refresh the sidebar —
  // the busy badge would stay stale forever. Always refresh on session switch.
  useEffect(() => {
    onSessionChangedRef.current?.()
  }, [sessionId])

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
            return {
              kind: 'L3' as const,
              ticketId: output.ticketId,
              // 携带工具入参（issue/category/severity）与阻断消息，供复核卡展示。
              toolName: typeof part.toolName === 'string' ? part.toolName : '',
              args: part.input,
              message: typeof output.message === 'string' ? output.message : undefined,
            }
          }
        }
      }
    }
    return null
  }, [messages])

  const [callbackState, setCallbackState] = useState<'idle' | 'loading' | 'success' | 'error'>('idle')
  const [callbackError, setCallbackError] = useState<string | null>(null)
  const [lastApprovalApproved, setLastApprovalApproved] = useState(true)
  const [lastApprovalKind, setLastApprovalKind] = useState<'L2' | 'L3'>('L3')
  // 复核卡的选项与补充意见（choice + note 作为一条人工判断原子提交）。
  const [reviewChoice, setReviewChoice] = useState<'approve' | 'deny' | null>(null)
  const [reviewNote, setReviewNote] = useState('')
  // 已「暂不处理」的 L3 工单集合（按 ticketId 记忆）：忽略只是本地隐藏复核
  // 卡，不回调后端，工单在服务端仍处 pending；新工单不在集合内，照常亮卡。
  const [dismissedTickets, setDismissedTickets] = useState<Set<string>>(new Set())
  const [sendError, setSendError] = useState<string | null>(null)

  // 当前待处理项的唯一键：切换工单 / 切换会话时用于复位复核卡。
  const pendingKey =
    pendingApproval === null
      ? null
      : pendingApproval.kind === 'L3'
        ? pendingApproval.ticketId
        : pendingApproval.approvalId

  // 上一张已成功回调的工单键。工单变化时若上一单已 success，则重新亮卡
  // （否则同一会话内的第二次升级工单永远不会出现复核卡）。
  const lastResolvedKeyRef = useRef<string | null>(null)

  // 待处理工单变化（新工单 / 已解除 / 切会话）：清空上一单的选项、意见与错误。
  useEffect(() => {
    setReviewChoice(null)
    setReviewNote('')
    setCallbackError(null)
    if (pendingKey && lastResolvedKeyRef.current && pendingKey !== lastResolvedKeyRef.current) {
      setCallbackState('idle')
    }
  }, [pendingKey])

  // 切换会话：忽略集合复位（回到会话时重新提供复核入口）。同一会话内忽略
  // 按 ticketId 持续记忆，不随工单流转丢失。
  useEffect(() => {
    setDismissedTickets(new Set())
  }, [sessionId])

  const postApproval = async (
    body: { approvalId?: string; ticketId?: string; approved: boolean },
    reason?: string,
  ) => {
    if (!sessionId || callbackState === 'loading') return
    setCallbackState('loading')
    setCallbackError(null)
    try {
      const trimmedReason = reason?.trim()
      const res = await fetch('/api/approval/callback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-session-id': sessionId },
        body: JSON.stringify({
          ...body,
          // 人工补充意见优先作为 reason 原文传给 Agent；为空时回退默认文案。
          reason: trimmedReason || (body.approved ? '用户确认执行' : '用户拒绝执行'),
        }),
      })
      if (!res.ok) {
        const text = await res.text()
        let detail = text
        let approvalResolved = false
        try {
          const json = JSON.parse(text)
          detail = json.error || JSON.stringify(json)
          approvalResolved = json.approvalResolved === true
        } catch {}
        if (res.status === 409) {
          throw new Error(
            approvalResolved
              ? '复核结果已记录，但会话正忙，稍后重发消息即可恢复'
              : '会话正忙，请稍后重试',
          )
        }
        throw new Error(`${res.status}: ${detail}`)
      }
      // 200: fire-and-forget. The resume run streams over SSE (run.started ->
      // message.part -> run.finished), which useSessionMessages already
      // renders; the approval card clears when the tool part reaches
      // output-available. No local stream merge is needed anymore.
      setLastApprovalApproved(body.approved)
      setLastApprovalKind(body.ticketId ? 'L3' : 'L2')
      lastResolvedKeyRef.current = body.ticketId ?? body.approvalId ?? null
      setCallbackState('success')
    } catch (err) {
      console.error('[approval callback] failed:', err)
      setCallbackError(err instanceof Error ? err.message : String(err))
      setCallbackState('error')
    }
  }

  const handleSubmitReview = () => {
    if (!pendingApproval || pendingApproval.kind !== 'L3' || !reviewChoice || callbackState === 'loading') return
    void postApproval(
      { ticketId: pendingApproval.ticketId, approved: reviewChoice === 'approve' },
      reviewNote,
    )
  }

  // 复核卡展示数据：escalate 入参优先（issue 是抛给人的问题），缺失时回退
  // 到工具返回的 blocked.message。
  const pendingL3 = pendingApproval && pendingApproval.kind === 'L3' ? pendingApproval : null
  const escalateInfo = pendingL3 ? parseEscalateArgs(pendingL3.args) : null
  const issueText = pendingL3 ? (escalateInfo?.issue || pendingL3.message || '').trim() : ''

  // 暂不处理：忽略不等于驳回 —— 仅本地隐藏复核卡，不 POST 回调，工单在
  // 服务端保持 pending（L3 不阻塞对话，可继续聊天）。
  const isDismissed = pendingL3 !== null && dismissedTickets.has(pendingL3.ticketId)

  const handleDismissReview = () => {
    if (!pendingL3 || callbackState === 'loading') return
    setDismissedTickets((prev) => new Set(prev).add(pendingL3.ticketId))
  }

  // 重新打开：移除忽略标记。已选选项/已填意见原样保留（半成品判断不丢失）。
  const handleReopenReview = () => {
    if (!pendingL3) return
    setDismissedTickets((prev) => {
      const next = new Set(prev)
      next.delete(pendingL3.ticketId)
      return next
    })
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
    // contextFiles travel as a PER-CALL argument from this submit-time
    // snapshot (useSessionMessages reads them synchronously from the closure,
    // so there is no transport-ref race). Clear after the call resolves so
    // the files belong to THIS turn only.
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
          {/* 对话收藏: current-session star + feedback-note editor */}
          {sessionId && (
            <div className="relative shrink-0">
              <button
                type="button"
                title={favProbe?.favorited ? '已收藏（点击编辑反馈备注）' : '收藏本会话'}
                onClick={handleHeaderStar}
                disabled={favBusy}
                className={clsx(
                  'p-1.5 rounded-lg transition-colors',
                  favProbe?.favorited
                    ? 'text-amber hover:bg-amber/10'
                    : 'text-textGray hover:text-textDark hover:bg-bgGray',
                )}
              >
                <Star className="w-4 h-4" fill={favProbe?.favorited ? 'currentColor' : 'none'} />
              </button>
              {favMenuOpen && favProbe?.favorited && (
                <div className="absolute right-0 top-full mt-2 w-72 rounded-lg border border-borderGray bg-white p-3 shadow-lg z-30">
                  <div className="text-xs font-medium text-textDark mb-1.5">反馈备注（可选）</div>
                  <div className="text-[11px] text-textGray mb-2">记录这条对话的价值或问题，汇总在收藏页供产品迭代参考。</div>
                  <textarea
                    value={favNoteDraft}
                    onChange={(e) => setFavNoteDraft(e.target.value)}
                    disabled={favBusy}
                    rows={3}
                    placeholder="例如：三单匹配对账结果准确，但发票金额识别有误"
                    className="w-full rounded-lg border border-borderGray bg-white p-2 text-xs text-textDark placeholder:text-textGray focus:outline-none focus:border-steelBlue resize-none disabled:opacity-70"
                  />
                  <div className="mt-2 flex items-center justify-between">
                    <button
                      type="button"
                      onClick={handleUnfavorite}
                      disabled={favBusy}
                      className="text-[11px] text-danger hover:text-danger/80 transition-colors disabled:opacity-50"
                    >
                      取消收藏
                    </button>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setFavMenuOpen(false)}
                        disabled={favBusy}
                        className="px-2.5 py-1 rounded-md text-[11px] text-textGray hover:text-textDark transition-colors"
                      >
                        收起
                      </button>
                      <button
                        type="button"
                        onClick={handleSaveFavNote}
                        disabled={favBusy}
                        className={clsx(
                          'px-3 py-1 rounded-md text-[11px] font-medium text-white transition-colors',
                          favBusy ? 'bg-borderGray cursor-not-allowed' : 'bg-deepSea hover:bg-deepSea/90',
                        )}
                      >
                        {favBusy ? '保存中...' : '保存备注'}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
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
          {pendingL3 && callbackState !== 'success' && !isDismissed && (
            <HumanReviewCard
              ticketId={pendingL3.ticketId}
              issueText={issueText}
              severity={escalateInfo?.severity}
              category={escalateInfo?.category}
              choice={reviewChoice}
              onChoice={setReviewChoice}
              note={reviewNote}
              onNoteChange={setReviewNote}
              onSubmit={handleSubmitReview}
              onDismiss={handleDismissReview}
              loading={callbackState === 'loading'}
              error={callbackError}
            />
          )}
          {pendingL3 && callbackState !== 'success' && isDismissed && (
            <div className="mb-3 rounded-lg border border-borderGray bg-white px-3 py-2 flex items-center gap-2 text-[11px] text-textGray">
              <ShieldCheck className="w-3.5 h-3.5 text-steelBlue shrink-0" />
              <span className="break-all">
                有 1 条待复核工单 <span className="font-mono">{pendingL3.ticketId}</span>
              </span>
              <button
                type="button"
                onClick={handleReopenReview}
                className="ml-auto shrink-0 text-steelBlue hover:text-deepSea transition-colors"
              >
                重新打开
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
              <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
              {lastApprovalKind === 'L3'
                ? (lastApprovalApproved ? '复核意见已提交，Agent 已继续处理' : '已驳回该工单，Agent 将停止该操作')
                : (lastApprovalApproved ? '已确认执行，新消息已追加到对话' : '已拒绝执行该操作')}
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
                  <ContextChipStatus state={docParseStates[f.docId]} />
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
            L2 写操作（如 bind_document 绑定单据）需你确认后执行；付款/退款等资金操作不在系统内执行，需要人工处理时会生成人工工单转人工复核。
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
