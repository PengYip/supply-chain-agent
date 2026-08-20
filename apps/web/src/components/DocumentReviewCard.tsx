import React, { useState, useMemo } from 'react'
import clsx from 'clsx'
import {
  FileText,
  ListChecks,
  Link2,
  Tag,
  Layers,
  ChevronDown,
  Database,
  AlertTriangle,
  AlertCircle,
  CheckCircle2,
  MinusCircle,
  Loader2,
  Check,
  Save,
  Share2,
} from 'lucide-react'
import { submitReview, type ReviewCorrection } from '../api/review'

/** One chunk classified under a semantic tag. `text` is server-capped (800
 *  chars + '...'); the card renders it verbatim, never truncated client-side. */
export type ChunkTagChunkDetail = {
  chunkIndex: number
  text: string
}

/** Per-tag grouping of the document's chunks, sorted by tag first-appearance;
 *  each tag's chunks are in chunkIndex order. */
export type ChunkTagDetail = {
  tag: string
  chunks: ChunkTagChunkDetail[]
}

/** Shape of the `present_document_review` tool output. When `reviewStatus` is
 *  `'pending'` the card is editable: each structured-field value can be
 *  corrected inline and submitted via the action bar (提交更正 / 确认无误),
 *  which POSTs to /api/documents/:docId/review. Once `'corrected'` or
 *  `'confirmed'` the card renders read-only with the status badge. */
export type DocumentReviewPayload = {
  docId: string
  docType: string
  classificationConfidence: number
  fields: Array<{
    name: string
    value: string | number
    confidence: number
    needsReview: boolean
  }>
  overallConfidence: number
  proposedRelationships: Array<{
    kind: 'Party' | 'Commodity' | 'Contract'
    role?: string
    name: string
    confidence: number
  }>
  proposedEdges?: Array<{
    type: 'party' | 'commodity' | 'references' | 'executes'
    dstKind: 'Party' | 'Commodity' | 'Contract'
    dstName: string
    role?: string
    confidence: number
  }>
  graphStatus?: {
    status: 'ok' | 'partial' | 'failed' | 'skipped'
    nodeCount: number
    edgeCount: number
    /** 确认时实际写入 Neo4j 的实体清单（归一化名）；skipped/failed 或旧数据无此字段。 */
    entities?: Array<{ kind: string; name: string; role?: string }>
    reason?: string
    failures?: string[]
    writtenAt: string
  } | null
  tags: string[]
  /** Chunk-level semantic tag groupings. null/undefined = the doc has no
   *  chunk tags (old docs, tagging failed, or docType 其他). Part of the
   *  snapshot: the review endpoint returns the same shape. */
  chunkTagDetails?: ChunkTagDetail[] | null
  vectorization: {
    status: 'ok' | 'skipped' | 'failed' | 'unknown'
    mode: string
    chunkCount: number
    reason?: string
  }
  reviewStatus: 'pending' | 'confirmed' | 'corrected'
}

const LOW_CONFIDENCE = 0.7

const pct = (n: unknown): string => {
  if (typeof n !== 'number' || !isFinite(n)) return '--'
  return `${Math.round(n * 100)}%`
}

const RELATIONSHIP_KIND_LABEL: Record<'Party' | 'Commodity' | 'Contract', string> = {
  Party: '主体',
  Commodity: '标的物',
  Contract: '合同',
}

const EDGE_TYPE_LABEL: Record<string, string> = {
  party: '当事方',
  commodity: '标的物',
  references: '引用合同',
  executes: '执行合同',
}

/** Preserve a field's original type when coercing an edited string back to a
 *  value for submission. Numeric fields parse back to numbers (falling back to
 *  the raw string when unparseable so the backend can reject/normalize). */
const coerceCorrectionValue = (original: string | number, edited: string): string | number => {
  if (typeof original === 'number') {
    const n = Number(edited)
    return Number.isFinite(n) ? n : edited
  }
  return edited
}

const SectionLabel: React.FC<{ icon: React.ReactNode; children: React.ReactNode }> = ({
  icon,
  children,
}) => (
  <div className="flex items-center gap-1.5 text-ink-soft mb-1.5">
    {icon}
    <span className="text-[11px] font-medium tracking-wide">{children}</span>
  </div>
)

const ReviewStatusBadge: React.FC<{ status: DocumentReviewPayload['reviewStatus'] }> = ({
  status,
}) => {
  const map = {
    pending: { label: '待复核', cls: 'bg-warning/10 text-warning border-warning/30', Icon: AlertTriangle },
    corrected: {
      label: '已更正',
      cls: 'bg-primary-500/10 text-primary-500 border-primary-500/30',
      Icon: CheckCircle2,
    },
    confirmed: {
      label: '已确认',
      cls: 'bg-success/10 text-success border-success/30',
      Icon: CheckCircle2,
    },
  } as const
  const entry = map[status] || map.pending
  const { Icon } = entry
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded border shrink-0',
        entry.cls,
      )}
    >
      <Icon className="w-3 h-3" />
      {entry.label}
    </span>
  )
}

const FlagBadge: React.FC = () => (
  <span className="inline-flex items-center gap-0.5 text-[10px] text-warning bg-warning/10 border border-warning/30 rounded px-1 py-0.5 shrink-0">
    <AlertTriangle className="w-2.5 h-2.5" />
    建议复核
  </span>
)

const VectorizationStatus: React.FC<{ v: DocumentReviewPayload['vectorization'] }> = ({ v }) => {
  const map = {
    ok: { label: '已入库', cls: 'bg-success/10 text-success border-success/30', Icon: CheckCircle2 },
    skipped: {
      label: '已跳过',
      cls: 'bg-warning/10 text-warning border-warning/30',
      Icon: MinusCircle,
    },
    failed: { label: '失败', cls: 'bg-danger/10 text-danger border-danger/30', Icon: AlertCircle },
    unknown: {
      label: '未知',
      cls: 'bg-surface text-ink-soft border-line',
      Icon: AlertCircle,
    },
  } as const
  const entry = map[v?.status] || map.unknown
  const { Icon } = entry
  return (
    <div className="text-xs">
      <div className="flex items-center gap-2 flex-wrap">
        <span
          className={clsx(
            'inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded border',
            entry.cls,
          )}
        >
          <Icon className="w-3 h-3" />
          {entry.label}
        </span>
        <span className="text-ink-soft">
          模式 <span className="font-mono text-primary-500">{v?.mode || '--'}</span>
        </span>
        <span className="text-ink-soft">
          分块 <span className="font-mono text-primary-500">
            {typeof v?.chunkCount === 'number' ? v.chunkCount : 0}
          </span>
        </span>
      </div>
      {v?.reason && (
        <div className="text-[11px] text-ink-soft italic mt-1 line-clamp-2">{v.reason}</div>
      )}
    </div>
  )
}

const GraphStatusView: React.FC<{ g: NonNullable<DocumentReviewPayload['graphStatus']> }> = ({ g }) => {
  const map = {
    ok: { label: '已入库', cls: 'bg-success/10 text-success border-success/30', Icon: CheckCircle2 },
    partial: { label: '部分入库', cls: 'bg-warning/10 text-warning border-warning/30', Icon: AlertTriangle },
    failed: { label: '失败', cls: 'bg-danger/10 text-danger border-danger/30', Icon: AlertCircle },
    skipped: { label: '未配置', cls: 'bg-surface text-ink-soft border-line', Icon: MinusCircle },
  } as const
  const entry = map[g?.status] || map.skipped
  const { Icon } = entry
  return (
    <div className="text-xs">
      <div className="flex items-center gap-2 flex-wrap">
        <span
          className={clsx(
            'inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded border',
            entry.cls,
          )}
        >
          <Icon className="w-3 h-3" />
          {entry.label}
        </span>
        <span className="text-ink-soft">
          节点 <span className="font-mono text-primary-500">{g?.nodeCount ?? 0}</span>
        </span>
        <span className="text-ink-soft">
          边 <span className="font-mono text-primary-500">{g?.edgeCount ?? 0}</span>
        </span>
      </div>
      {/* 确认时实际写入 Neo4j 的实体清单 chips；旧数据无 entities 时不渲染。 */}
      {(g?.entities?.length ?? 0) > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-1">
          {(g.entities ?? []).map((e, i) => (
            <span
              key={`${e.kind}-${e.name}-${i}`}
              className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded border bg-surface/50 text-ink border-line/50"
            >
              <span className="font-mono text-primary-500">{e.kind}</span>
              <span className="font-medium">{e.name}</span>
              {typeof e.role === 'string' && e.role.length > 0 && (
                <span className="text-ink-soft">({e.role})</span>
              )}
            </span>
          ))}
        </div>
      )}
      {g?.reason && (
        <div className="text-[11px] text-ink-soft italic mt-1 line-clamp-2">{g.reason}</div>
      )}
      {/* partial/failed 时 writeDocumentGraph 只填 failures 不设 reason：列表展示前 3 条。 */}
      {(g?.failures?.length ?? 0) > 0 && (
        <ul className="mt-1 space-y-0.5">
          {(g.failures ?? []).slice(0, 3).map((f, i) => (
            <li key={i} className="text-[11px] text-ink-soft italic line-clamp-1">
              {typeof f === 'string' ? f : ''}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Collapsible 「分段标签」 section: for each semantic tag, the chunks
 *  classified under it. Purely presentational in every reviewStatus state —
 *  owns only its own open/closed toggle, never touches the card's edit state
 *  or action bar. Absent data (null/undefined/empty) renders nothing:
 *  absence means the doc has no chunk tags, not a missing section. Default
 *  collapsed to keep the card scannable — chunk texts are bulky. */
const ChunkTagSection: React.FC<{ details: DocumentReviewPayload['chunkTagDetails'] }> = ({
  details,
}) => {
  const [open, setOpen] = useState(false)

  // Defensive: tolerate malformed entries (tool payload is external data).
  const entries = useMemo(
    () =>
      (Array.isArray(details) ? details : []).filter(
        (d): d is ChunkTagDetail =>
          !!d &&
          typeof d.tag === 'string' &&
          d.tag.length > 0 &&
          Array.isArray(d.chunks) &&
          d.chunks.length > 0,
      ),
    [details],
  )

  if (entries.length === 0) return null

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 text-ink-soft mb-1.5 cursor-pointer select-none"
      >
        <Layers className="w-3 h-3 shrink-0" />
        <span className="text-[11px] font-medium tracking-wide">
          分段标签 ({entries.length})
        </span>
        <ChevronDown
          className={clsx('w-3 h-3 shrink-0 transition-transform', open && 'rotate-180')}
        />
      </button>
      {open && (
        <div className="space-y-2">
          {entries.map((d, i) => (
            <div key={`${d.tag}-${i}`} className="space-y-1">
              <div className="flex items-center gap-1.5">
                <span className="inline-flex items-center text-[11px] px-2 py-0.5 rounded border bg-surface/50 text-ink border-line/50">
                  {d.tag}
                </span>
                <span className="text-[10px] text-ink-soft">{d.chunks.length} 段</span>
              </div>
              <div className="space-y-1">
                {d.chunks.map((c, j) => (
                  <div
                    key={`${c.chunkIndex}-${j}`}
                    className="flex items-start gap-2 px-2 py-1.5 rounded border bg-surface/50 border-line/50"
                  >
                    <span className="font-mono text-[10px] text-ink-soft shrink-0 mt-0.5">
                      #{typeof c.chunkIndex === 'number' ? c.chunkIndex : '--'}
                    </span>
                    <span className="flex-1 min-w-0 text-[11px] text-ink leading-relaxed whitespace-pre-wrap break-words max-h-36 overflow-y-auto">
                      {typeof c.text === 'string' ? c.text : ''}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export const DocumentReviewCard: React.FC<{
  payload: DocumentReviewPayload
  /** Optional callback fired after a successful review POST, with the updated
   *  snapshot. Lets a parent (e.g. a chat log) react to status changes; purely
   *  optional — the card manages its own state otherwise. */
  onUpdated?: (snapshot: DocumentReviewPayload) => void
}> = ({ payload, onUpdated }) => {
  // The card owns its current state so it can optimistic-update after a POST
  // without needing the parent to re-render the tool result. Initialised once
  // from `payload` (tool results are immutable once the step completes).
  const [snapshot, setSnapshot] = useState<DocumentReviewPayload>(payload)
  // Per-field edit buffer, keyed by field name. Holds raw input strings; values
  // are only present for fields the user has touched.
  const [edits, setEdits] = useState<Record<string, string>>({})
  // Which action is in-flight ('corrections' | 'confirm' | 'none'). Both buttons
  // are disabled while a request is running to prevent double-submit.
  const [submitting, setSubmitting] = useState<'none' | 'corrections' | 'confirm'>('none')
  const [error, setError] = useState<string | null>(null)

  const {
    docType,
    classificationConfidence,
    fields = [],
    overallConfidence,
    proposedRelationships = [],
    tags = [],
    chunkTagDetails,
    vectorization,
    proposedEdges,
    graphStatus,
    reviewStatus,
  } = snapshot || {}

  const editable = reviewStatus === 'pending'
  const busy = submitting !== 'none'

  const classificationLow =
    typeof classificationConfidence === 'number' && classificationConfidence < LOW_CONFIDENCE

  // Compute the real corrections (only fields whose string value actually
  // differs from the original), preserving original types for submission.
  const corrections: ReviewCorrection[] = useMemo(() => {
    if (!editable) return []
    const out: ReviewCorrection[] = []
    for (const f of fields) {
      const edited = edits[f.name]
      if (edited === undefined) continue
      if (edited === String(f.value ?? '')) continue
      out.push({ name: f.name, value: coerceCorrectionValue(f.value, edited) })
    }
    return out
  }, [editable, fields, edits])

  const hasChanges = corrections.length > 0

  const updateField = (name: string, value: string) => {
    setEdits((prev) => ({ ...prev, [name]: value }))
  }

  const handleSubmitCorrections = async () => {
    if (busy || corrections.length === 0) return
    setError(null)
    setSubmitting('corrections')
    try {
      const res = await submitReview(snapshot.docId, { corrections })
      setSnapshot(res.snapshot)
      setEdits({})
      onUpdated?.(res.snapshot)
    } catch (e) {
      setError(e instanceof Error ? e.message : '提交失败，请重试')
    } finally {
      setSubmitting('none')
    }
  }

  const handleConfirm = async () => {
    if (busy) return
    setError(null)
    setSubmitting('confirm')
    try {
      const res = await submitReview(snapshot.docId, { confirm: true })
      setSnapshot(res.snapshot)
      setEdits({})
      onUpdated?.(res.snapshot)
    } catch (e) {
      setError(e instanceof Error ? e.message : '确认失败，请重试')
    } finally {
      setSubmitting('none')
    }
  }

  return (
    <div className="rounded-lg border border-line bg-white p-3 mt-2">
      {/* Header: title + review status badge */}
      <div className="flex items-start gap-2.5 mb-3">
        <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
          <FileText className="w-3.5 h-3.5 text-primary" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-medium text-ink truncate">
              单据复核 · {docType || '--'}
            </div>
            <ReviewStatusBadge status={reviewStatus} />
          </div>
          <div className="text-[11px] text-ink-soft mt-0.5">
            综合置信度 <span className="font-mono text-primary-500">{pct(overallConfidence)}</span>
          </div>
        </div>
      </div>

      <div className="space-y-3">
        {/* 1. 业务类型 */}
        <div>
          <SectionLabel icon={<FileText className="w-3 h-3" />}>业务类型</SectionLabel>
          <div className="flex items-center gap-2 flex-wrap text-xs">
            <span className="text-ink font-medium">{docType || '--'}</span>
            <span className="text-ink-soft">·</span>
            <span className="text-ink-soft">
              分类置信度{' '}
              <span className={clsx('font-mono', classificationLow ? 'text-warning' : 'text-primary-500')}>
                {pct(classificationConfidence)}
              </span>
            </span>
            {classificationLow && <FlagBadge />}
          </div>
        </div>

        {/* 2. 结构化字段 — core value: flag needsReview / low confidence.
            Editable when pending; read-only otherwise. */}
        <div>
          <SectionLabel icon={<ListChecks className="w-3 h-3" />}>结构化字段</SectionLabel>
          {fields.length === 0 ? (
            <div className="text-xs text-ink-soft italic">暂无</div>
          ) : (
            <div className="space-y-1">
              {fields.map((f, i) => {
                const flagged =
                  f.needsReview ||
                  (typeof f.confidence === 'number' && f.confidence < LOW_CONFIDENCE)
                const edited = edits[f.name]
                const changed = edited !== undefined && edited !== String(f.value ?? '')
                return (
                  <div
                    key={`${f.name}-${i}`}
                    className={clsx(
                      'flex items-center gap-2 text-xs px-2 py-1.5 rounded border transition-colors',
                      changed
                        ? 'bg-primary-500/5 border-primary-500/40'
                        : flagged
                          ? 'bg-warning/5 border-warning/30'
                          : 'bg-surface/50 border-line/50',
                    )}
                  >
                    <span className="text-ink-soft shrink-0 w-24 truncate">{f.name}</span>
                    {editable ? (
                      <input
                        type="text"
                        value={edited ?? String(f.value ?? '')}
                        onChange={(e) => updateField(f.name, e.target.value)}
                        spellCheck={false}
                        autoComplete="off"
                        className={clsx(
                          'flex-1 min-w-0 bg-transparent font-mono outline-none rounded px-1 -mx-1 transition-colors',
                          'placeholder:text-ink-soft/50',
                          changed
                            ? 'text-primary-500'
                            : 'text-ink focus:bg-white focus:ring-1 focus:ring-primary-500/40',
                        )}
                      />
                    ) : (
                      <span className="text-ink flex-1 min-w-0 truncate font-mono">
                        {String(f.value ?? '--')}
                      </span>
                    )}
                    <span className="text-ink-soft text-[11px] font-mono shrink-0">
                      {pct(f.confidence)}
                    </span>
                    {changed ? (
                      <span className="inline-flex items-center gap-0.5 text-[10px] text-primary-500 bg-primary-500/10 border border-primary-500/30 rounded px-1 py-0.5 shrink-0">
                        <Check className="w-2.5 h-2.5" />
                        已改
                      </span>
                    ) : (
                      flagged && <FlagBadge />
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* 3. 待确认关系 */}
        <div>
          <SectionLabel icon={<Link2 className="w-3 h-3" />}>待确认关系</SectionLabel>
          {proposedRelationships.length === 0 ? (
            <div className="text-xs text-ink-soft italic">暂无</div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {proposedRelationships.map((r, i) => {
                const low =
                  typeof r.confidence === 'number' && r.confidence < LOW_CONFIDENCE
                const role = r.role || RELATIONSHIP_KIND_LABEL[r.kind] || r.kind
                return (
                  <span
                    key={`${r.kind}-${r.name}-${i}`}
                    className={clsx(
                      'inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded border',
                      low
                        ? 'bg-warning/5 text-ink border-warning/30'
                        : 'bg-surface/50 text-ink border-line/50',
                    )}
                  >
                    <span className="text-ink-soft">{role}</span>
                    <span className="font-medium">{r.name}</span>
                    <span className={clsx('font-mono', low ? 'text-warning' : 'text-primary-500')}>
                      {pct(r.confidence)}
                    </span>
                  </span>
                )
              })}
            </div>
          )}
          {(proposedEdges ?? []).length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-1.5">
              {(proposedEdges ?? []).map((e, i) => (
                <span
                  key={`${e.type}-${e.dstName}-${i}`}
                  className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded border bg-surface/50 text-ink border-line/50"
                >
                  <span className="text-ink-soft">
                    {EDGE_TYPE_LABEL[e.type] || e.type}
                    {e.role ? `(${e.role})` : ''}
                  </span>
                  <span className="font-medium">{e.dstName}</span>
                  <span className="font-mono text-primary-500">{pct(e.confidence)}</span>
                </span>
              ))}
            </div>
          )}
        </div>

        {/* 4. 文本TAG */}
        <div>
          <SectionLabel icon={<Tag className="w-3 h-3" />}>文本TAG</SectionLabel>
          {tags.length === 0 ? (
            <div className="text-xs text-ink-soft italic">暂无</div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {tags.map((t, i) => (
                <span
                  key={`${t}-${i}`}
                  className="inline-flex items-center text-[11px] px-2 py-0.5 rounded border bg-surface/50 text-ink border-line/50"
                >
                  {t}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* 5. 分段标签 — chunk-level semantic tags; collapsed by default,
            renders nothing when the payload carries no chunk tags. */}
        <ChunkTagSection details={chunkTagDetails} />

        {/* 6. 向量化入库状态 — semantic-recall health */}
        <div>
          <SectionLabel icon={<Database className="w-3 h-3" />}>向量化入库状态</SectionLabel>
          <VectorizationStatus v={vectorization} />
        </div>

        {/* 7. 图入库状态 — 确认时 Neo4j 写入结果（2026-08-17）；未确认（graphStatus 为
            null/undefined）时不渲染。 */}
        {graphStatus && (
          <div>
            <SectionLabel icon={<Share2 className="w-3 h-3" />}>图入库状态</SectionLabel>
            <GraphStatusView g={graphStatus} />
          </div>
        )}
      </div>

      {/* Action bar — only while pending. Once the user has acted (corrected /
          confirmed) the card is read-only. */}
      {editable && (
        <div className="mt-3 pt-3 border-t border-line">
          {error && (
            <div className="mb-2 flex items-start gap-1.5 text-xs text-danger bg-danger/5 border border-danger/30 rounded px-2 py-1.5">
              <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span className="leading-relaxed">{error}</span>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void handleSubmitCorrections()}
              disabled={busy || !hasChanges}
              title={hasChanges ? '' : '修改任意字段后即可提交更正'}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-primary-500 text-white text-xs font-medium hover:bg-primary-500/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {submitting === 'corrections' ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Save className="w-3.5 h-3.5" />
              )}
              提交更正{hasChanges ? ` (${corrections.length})` : ''}
            </button>
            <button
              type="button"
              onClick={() => void handleConfirm()}
              disabled={busy}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-success text-white text-xs font-medium hover:bg-success/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {submitting === 'confirm' ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Check className="w-3.5 h-3.5" />
              )}
              确认无误
            </button>
            {busy && (
              <span className="text-[11px] text-ink-soft">处理中...</span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default DocumentReviewCard
