import React, { useState, useMemo } from 'react'
import clsx from 'clsx'
import {
  FileText,
  ListChecks,
  Link2,
  Tag,
  Database,
  AlertTriangle,
  AlertCircle,
  CheckCircle2,
  MinusCircle,
  Loader2,
  Check,
  Save,
} from 'lucide-react'
import { submitReview, type ReviewCorrection } from '../api/review'

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
  tags: string[]
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
  <div className="flex items-center gap-1.5 text-textGray mb-1.5">
    {icon}
    <span className="text-[11px] font-medium tracking-wide">{children}</span>
  </div>
)

const ReviewStatusBadge: React.FC<{ status: DocumentReviewPayload['reviewStatus'] }> = ({
  status,
}) => {
  const map = {
    pending: { label: '待复核', cls: 'bg-amber/10 text-amber border-amber/30', Icon: AlertTriangle },
    corrected: {
      label: '已更正',
      cls: 'bg-steelBlue/10 text-steelBlue border-steelBlue/30',
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
  <span className="inline-flex items-center gap-0.5 text-[10px] text-amber bg-amber/10 border border-amber/30 rounded px-1 py-0.5 shrink-0">
    <AlertTriangle className="w-2.5 h-2.5" />
    建议复核
  </span>
)

const VectorizationStatus: React.FC<{ v: DocumentReviewPayload['vectorization'] }> = ({ v }) => {
  const map = {
    ok: { label: '已入库', cls: 'bg-success/10 text-success border-success/30', Icon: CheckCircle2 },
    skipped: {
      label: '已跳过',
      cls: 'bg-amber/10 text-amber border-amber/30',
      Icon: MinusCircle,
    },
    failed: { label: '失败', cls: 'bg-danger/10 text-danger border-danger/30', Icon: AlertCircle },
    unknown: {
      label: '未知',
      cls: 'bg-bgGray text-textGray border-borderGray',
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
        <span className="text-textGray">
          模式 <span className="font-mono text-steelBlue">{v?.mode || '--'}</span>
        </span>
        <span className="text-textGray">
          分块 <span className="font-mono text-steelBlue">
            {typeof v?.chunkCount === 'number' ? v.chunkCount : 0}
          </span>
        </span>
      </div>
      {v?.reason && (
        <div className="text-[11px] text-textGray italic mt-1 line-clamp-2">{v.reason}</div>
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
    vectorization,
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
    <div className="rounded-lg border border-borderGray bg-white p-3 mt-2">
      {/* Header: title + review status badge */}
      <div className="flex items-start gap-2.5 mb-3">
        <div className="w-6 h-6 rounded-full bg-deepSea/10 flex items-center justify-center shrink-0">
          <FileText className="w-3.5 h-3.5 text-deepSea" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-medium text-textDark truncate">
              单据复核 · {docType || '--'}
            </div>
            <ReviewStatusBadge status={reviewStatus} />
          </div>
          <div className="text-[11px] text-textGray mt-0.5">
            综合置信度 <span className="font-mono text-steelBlue">{pct(overallConfidence)}</span>
          </div>
        </div>
      </div>

      <div className="space-y-3">
        {/* 1. 业务类型 */}
        <div>
          <SectionLabel icon={<FileText className="w-3 h-3" />}>业务类型</SectionLabel>
          <div className="flex items-center gap-2 flex-wrap text-xs">
            <span className="text-textDark font-medium">{docType || '--'}</span>
            <span className="text-textGray">·</span>
            <span className="text-textGray">
              分类置信度{' '}
              <span className={clsx('font-mono', classificationLow ? 'text-amber' : 'text-steelBlue')}>
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
            <div className="text-xs text-textGray italic">暂无</div>
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
                        ? 'bg-steelBlue/5 border-steelBlue/40'
                        : flagged
                          ? 'bg-amber/5 border-amber/30'
                          : 'bg-bgGray/50 border-borderGray/50',
                    )}
                  >
                    <span className="text-textGray shrink-0 w-24 truncate">{f.name}</span>
                    {editable ? (
                      <input
                        type="text"
                        value={edited ?? String(f.value ?? '')}
                        onChange={(e) => updateField(f.name, e.target.value)}
                        spellCheck={false}
                        autoComplete="off"
                        className={clsx(
                          'flex-1 min-w-0 bg-transparent font-mono outline-none rounded px-1 -mx-1 transition-colors',
                          'placeholder:text-textGray/50',
                          changed
                            ? 'text-steelBlue'
                            : 'text-textDark focus:bg-white focus:ring-1 focus:ring-steelBlue/40',
                        )}
                      />
                    ) : (
                      <span className="text-textDark flex-1 min-w-0 truncate font-mono">
                        {String(f.value ?? '--')}
                      </span>
                    )}
                    <span className="text-textGray text-[11px] font-mono shrink-0">
                      {pct(f.confidence)}
                    </span>
                    {changed ? (
                      <span className="inline-flex items-center gap-0.5 text-[10px] text-steelBlue bg-steelBlue/10 border border-steelBlue/30 rounded px-1 py-0.5 shrink-0">
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
            <div className="text-xs text-textGray italic">暂无</div>
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
                        ? 'bg-amber/5 text-textDark border-amber/30'
                        : 'bg-bgGray/50 text-textDark border-borderGray/50',
                    )}
                  >
                    <span className="text-textGray">{role}</span>
                    <span className="font-medium">{r.name}</span>
                    <span className={clsx('font-mono', low ? 'text-amber' : 'text-steelBlue')}>
                      {pct(r.confidence)}
                    </span>
                  </span>
                )
              })}
            </div>
          )}
        </div>

        {/* 4. 文本TAG */}
        <div>
          <SectionLabel icon={<Tag className="w-3 h-3" />}>文本TAG</SectionLabel>
          {tags.length === 0 ? (
            <div className="text-xs text-textGray italic">暂无</div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {tags.map((t, i) => (
                <span
                  key={`${t}-${i}`}
                  className="inline-flex items-center text-[11px] px-2 py-0.5 rounded border bg-bgGray/50 text-textDark border-borderGray/50"
                >
                  {t}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* 5. 向量化入库状态 — semantic-recall health */}
        <div>
          <SectionLabel icon={<Database className="w-3 h-3" />}>向量化入库状态</SectionLabel>
          <VectorizationStatus v={vectorization} />
        </div>
      </div>

      {/* Action bar — only while pending. Once the user has acted (corrected /
          confirmed) the card is read-only. */}
      {editable && (
        <div className="mt-3 pt-3 border-t border-borderGray">
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
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-steelBlue text-white text-xs font-medium hover:bg-steelBlue/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
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
              <span className="text-[11px] text-textGray">处理中...</span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default DocumentReviewCard
