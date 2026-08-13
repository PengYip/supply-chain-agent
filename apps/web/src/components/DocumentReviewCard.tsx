import React from 'react'
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
} from 'lucide-react'

/** Shape of the `present_document_review` tool output. This card is informational
 *  and read-only by design — corrections flow through chat (update_document_fields
 *  plus its own SoftGateCard), never through buttons here. See task-9 brief. */
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

export const DocumentReviewCard: React.FC<{ payload: DocumentReviewPayload }> = ({ payload }) => {
  const {
    docType,
    classificationConfidence,
    fields = [],
    overallConfidence,
    proposedRelationships = [],
    tags = [],
    vectorization,
    reviewStatus,
  } = payload || {}

  const classificationLow =
    typeof classificationConfidence === 'number' && classificationConfidence < LOW_CONFIDENCE

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

        {/* 2. 结构化字段 — core value: flag needsReview / low confidence */}
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
                return (
                  <div
                    key={`${f.name}-${i}`}
                    className={clsx(
                      'flex items-center gap-2 text-xs px-2 py-1.5 rounded border',
                      flagged
                        ? 'bg-amber/5 border-amber/30'
                        : 'bg-bgGray/50 border-borderGray/50',
                    )}
                  >
                    <span className="text-textGray shrink-0 w-24 truncate">{f.name}</span>
                    <span className="text-textDark flex-1 min-w-0 truncate font-mono">
                      {String(f.value ?? '--')}
                    </span>
                    <span className="text-textGray text-[11px] font-mono shrink-0">
                      {pct(f.confidence)}
                    </span>
                    {flagged && <FlagBadge />}
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
    </div>
  )
}

export default DocumentReviewCard
