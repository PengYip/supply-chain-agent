import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react'
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
  Bookmark,
  Boxes,
  CheckCircle2,
  Combine,
  Crop,
  FileStack,
  MinusCircle,
  Loader2,
  Check,
  RefreshCw,
  Save,
  Share2,
  PenLine,
  Info,
  Split,
} from 'lucide-react'
import { submitReview, fetchReviewSnapshot, type ReviewCorrection } from '../api/review'
import { correctDocumentType, DOC_TYPE_FALLBACK, fetchActiveDocTypes } from '../api/documentType'
import {
  BatchApiError,
  fetchDocumentUnitPreview,
  listDocumentUnits,
  mergeUnits,
  parseBoundUnitIndexes,
  reextractUnit,
  resplitDocument,
  unitReviewStatusBadge,
  unitStatusBadge,
  type BatchLineage,
  type BatchUnitSummary,
  type ReextractUnitBody,
} from '../api/documents'
import { businessTypeTag } from '../lib/businessTypeTag'
import { buildReviewQueueFromUnits, requestOpenReview, requestRefreshContainers } from '../lib/reviewModal'

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
  /** 合同类型派生结果（主体视角, spec 2026-08-20）。null/缺失 = 非合同或未识别，
   *  复核卡不渲染该区；conflict=true 表示字段方向与主体侧别相反，需人工确认。 */
  contractType?: {
    contractType: string | null
    source: 'field' | 'side' | 'keyword' | null
    conflict: boolean
  } | null
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
  /** 两遍读数共识分歧（批量拆分 unit 子单据，P2 已强制 needs_review）；
   *  普通文档缺失或为空数组，渲染与现状零差异。 */
  warnings?: string[]
  /** 批量拆分谱系块： role='container' 时整卡切「拆分清单」导航形态；
   *  role='unit' 时在图入库状态后增渲染「来源与拆分」区块；普通文档
   *  null/缺失（api/review.ts 反向引用本类型，自动获得扩展）。 */
  batch?: BatchLineage | null
}

const LOW_CONFIDENCE = 0.7

/** 合同类文档判定(轻量引导条按此分叉; 与模板 doc_type 种子名对齐)。 */
const CONTRACT_DOC_TYPES = new Set(['合同', '补充合同'])

/** 单 unit 重抽可覆盖的旋回方向(契约: 0|90|180|270)。 */
const REEXTRACT_ROTATIONS = [0, 90, 180, 270] as const

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

/** 合同类型派生来源的可读名（快照 contractType.source）。 */
const CONTRACT_TYPE_SOURCE_LABEL: Record<string, string> = {
  field: '字段',
  side: '主体侧别',
  keyword: '标题关键词',
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

/** A parsed row of a table-shaped field value (see parseTableField). Values
 *  are whatever JSON.parse produced; nested objects/arrays only get display
 *  treatment (compact JSON text). */
type TableFieldRow = Record<string, unknown>

/** A field value is "table-shaped" iff it is a string that JSON.parses to a
 *  non-empty Array whose every element is a non-null plain object — the
 *  persistence shape the backend (documentEntry saveExtraction) writes for
 *  array/object fields via compact JSON.stringify (化验报告「指标」、货转单/
 *  汽运磅单「明细行」等). Returns the parsed rows, or null for anything else
 *  (parse failure / empty array / non-object rows) so the caller falls back
 *  to the existing single-line rendering byte-for-byte. */
const parseTableField = (raw: string): TableFieldRow[] | null => {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed.startsWith('[')) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null
  for (const row of parsed) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) return null
  }
  return parsed as TableFieldRow[]
}

/** Union of row keys in first-seen order (JSON.parse preserves document
 *  order, so leading keys like 基准 keep their natural position; rows may
 *  have heterogeneous keys). Key names map 1:1 to correction keys — headers
 *  show them verbatim, never renamed or stripped. */
const tableFieldColumns = (rows: TableFieldRow[]): string[] => {
  const cols: string[] = []
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!cols.includes(key)) cols.push(key)
    }
  }
  return cols
}

/** Display text for one cell: null/undefined -> '--'; nested objects/arrays
 *  fall back to compact JSON text (display-only). */
const tableCellText = (v: unknown): string => {
  if (v === null || v === undefined) return '--'
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

/** Coerce an edited cell string back to a JSON value, deterministically,
 *  guided by the ORIGINAL cell's type:
 *  - empty input -> null (the '--' no-value state)
 *  - original number -> Number(input) when finite, else the raw string
 *  - original null/undefined -> finite numbers become numbers (numeric
 *    columns like 灰分_百分比 often start null), else the raw string
 *  - original string -> the raw string */
const coerceTableCell = (original: unknown, edited: string): string | number | null => {
  if (edited.trim() === '') return null
  if (typeof original === 'string') return edited
  const n = Number(edited)
  return Number.isFinite(n) ? n : edited
}

/** Loose cell equality for per-cell changed highlighting: the same literal
 *  across string/number ("18.2" typed over 18.2 mid-edit) counts as equal. */
const tableCellEquals = (a: unknown, b: unknown): boolean => {
  if (a === b) return true
  if (a === null || a === undefined) return b === null || b === undefined
  if (typeof a === 'object' || b === null || typeof b === 'object') {
    return JSON.stringify(a) === JSON.stringify(b)
  }
  return String(a) === String(b)
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

/** 表格型结构化字段的渲染块：标签行（字段名 + 行数 + 置信度 + 复核/已改
 *  徽标，与单行字段同款信息）+ 下方占满整行宽度的紧凑迷你表格。可编辑时
 *  单元格为输入框：键入期间按原文保存（避免 "18." 这类中间态被数字强转
 *  吃掉小数点），失焦时按原始单元格类型 coerce 回数字/字符串/null，由父
 *  级把整行数组序列化回紧凑 JSON 写入 edits 缓冲。只读态渲染纯文本格。 */
const TableFieldValue: React.FC<{
  label: string
  confidence: number
  editable: boolean
  rows: TableFieldRow[]
  /** 解析自字段原值的行（未编辑时与 rows 同源）；用于逐格「已改」高亮与
   *  失焦 coerce 的类型基准。 */
  origRows: TableFieldRow[] | null
  changed: boolean
  flagged: boolean
  onCellChange: (rowIndex: number, key: string, raw: string, commit: boolean) => void
}> = ({ label, confidence, editable, rows, origRows, changed, flagged, onCellChange }) => {
  const cols = tableFieldColumns(rows)
  const cellChanged = (r: number, key: string): boolean => {
    if (!origRows) return false
    const origRow = origRows[r]
    if (!origRow || !(key in origRow)) return true
    return !tableCellEquals(origRow[key], rows[r][key])
  }
  return (
    <div
      className={clsx(
        'text-xs px-2 py-1.5 rounded border transition-colors min-w-0',
        changed
          ? 'bg-primary-500/5 border-primary-500/40'
          : flagged
            ? 'bg-warning/5 border-warning/30'
            : 'bg-surface/50 border-line/50',
      )}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-ink-soft shrink-0 truncate">{label}</span>
        <span className="text-[10px] font-mono text-ink-soft/70 shrink-0">
          {rows.length} 行
        </span>
        <span className="ml-auto text-ink-soft text-[11px] font-mono shrink-0">
          {pct(confidence)}
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
      <div className="mt-1.5 overflow-x-auto rounded border border-line/50 bg-surface/50">
        <table className="w-full min-w-max border-collapse text-xs">
          <thead>
            <tr className="border-b border-line/50">
              {cols.map((c) => (
                <th
                  key={c}
                  className="text-left font-medium text-ink-soft whitespace-nowrap px-2 py-1 bg-white/40"
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri} className="border-b border-line/30 last:border-b-0">
                {cols.map((key) => {
                  const v = row[key]
                  if (!editable) {
                    return (
                      <td key={key} className="px-2 py-1 whitespace-nowrap">
                        <span
                          className={clsx(
                            'font-mono',
                            v === null || v === undefined ? 'text-ink-soft/60' : 'text-ink',
                          )}
                        >
                          {tableCellText(v)}
                        </span>
                      </td>
                    )
                  }
                  const touched = cellChanged(ri, key)
                  const text = v === null || v === undefined ? '' : tableCellText(v)
                  return (
                    <td key={key} className="px-1 py-0.5 whitespace-nowrap">
                      <input
                        type="text"
                        size={10}
                        value={text}
                        placeholder="--"
                        onChange={(e) => onCellChange(ri, key, e.target.value, false)}
                        onBlur={(e) => onCellChange(ri, key, e.target.value, true)}
                        spellCheck={false}
                        autoComplete="off"
                        className={clsx(
                          'w-full bg-transparent font-mono outline-none rounded px-1 py-0.5 transition-colors',
                          'placeholder:text-ink-soft/50',
                          touched
                            ? 'text-primary-500'
                            : 'text-ink focus:bg-white focus:ring-1 focus:ring-primary-500/40',
                        )}
                      />
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

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

/** 拆分清单的单行子单据： 序号 / 类型徽标 / 解析状态 / 复核状态 / 待复核
 *  标记 / 「复核」入口。与文件树 UnitRow 共用 api/documents 的徽标语言。
 *  合并修正模式下整行变为可勾选（隐藏「复核」）。 */
const ContainerUnitRow: React.FC<{
  unit: BatchUnitSummary
  mergeMode?: boolean
  selected?: boolean
  onToggleMerge?: () => void
  /** 免登录分享宿主隐藏登录态「复核」入口。 */
  readOnly?: boolean
  /** 打开子单据复核的回调(容器清单宿主传入以携带同组队列,启用弹窗翻页
   *  与确认后自动前进;缺省回落无队列的全局通道)。 */
  onOpenReview?: (docId: string) => void
}> = ({ unit, mergeMode = false, selected = false, onToggleMerge, readOnly = false, onOpenReview }) => {
  const typeTag = businessTypeTag(unit.childDocType ?? unit.detectedFormType)
  const status = unitStatusBadge(unit.unitStatus)
  // 复核状态缺字段(旧版 /units 响应)时: 有子单据按「待复核」兜底(安全侧),
  // 无子单据才是真正的「未生成」。
  const review = unitReviewStatusBadge(
    unit.reviewStatus ?? (unit.docId ? 'pending' : null),
  )
  const docId = unit.docId
  const clickable = mergeMode && typeof onToggleMerge === 'function'
  return (
    <div
      onClick={clickable ? onToggleMerge : undefined}
      title={clickable ? (selected ? '取消选择该子单据' : '选择该子单据参与合并') : undefined}
      className={clsx(
        'flex items-center gap-2 px-2 py-1.5 text-xs transition-colors',
        clickable && 'cursor-pointer',
        selected ? 'bg-primary/5' : clickable && 'hover:bg-surface',
      )}
    >
      {mergeMode && (
        <span
          aria-hidden
          className={clsx(
            'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border transition-colors',
            selected ? 'border-primary bg-primary text-white' : 'border-line bg-white',
          )}
        >
          {selected && <Check className="h-2.5 w-2.5" />}
        </span>
      )}
      <span className="shrink-0 font-mono text-[11px] text-ink-soft">
        #{unit.unitIndex}
      </span>
      {typeTag ? (
        <span
          title={`业务类型：${typeTag.text}`}
          className={clsx(
            'max-w-[110px] shrink-0 truncate rounded border px-1.5 py-px text-[10px] leading-4',
            typeTag.className,
          )}
        >
          {typeTag.text}
        </span>
      ) : (
        <span className="max-w-[110px] shrink-0 truncate text-[10px] text-ink-soft">
          {unit.detectedFormType || '未识别'}
        </span>
      )}
      <span className={clsx('shrink-0 whitespace-nowrap rounded px-1.5 py-px text-[10px]', status.className)}>
        {status.label}
      </span>
      <span className={clsx('shrink-0 whitespace-nowrap rounded px-1.5 py-px text-[10px]', review.className)}>
        {review.label}
      </span>
      {unit.needsReview && <FlagBadge />}
      <span className="ml-auto shrink-0">
        {!mergeMode && !readOnly &&
          (docId ? (
            <button
              type="button"
              onClick={() => (onOpenReview ?? requestOpenReview)(docId)}
              title="打开该子单据的复核卡"
              className="cursor-pointer whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-medium text-primary transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
            >
              复核
            </button>
          ) : (
            <span className="whitespace-nowrap text-[11px] text-ink-soft/70" title="子单据尚未生成">
              --
            </span>
          ))}
      </span>
    </div>
  )
}

/** 409 unit_bound 的被绑定清单行（重拆/重抽/合并共用）。 */
const BoundUnitList: React.FC<{ indexes: number[] }> = ({ indexes }) => (
  <ul className="space-y-0.5 text-[11px] text-danger">
    {indexes.map((idx) => (
      <li key={idx} className="font-mono">
        第 {idx} 份已挂合同绑定
      </li>
    ))}
  </ul>
)

/** 单据组（container）复核卡的「拆分清单」形态： 头部「单据组 · N 份单据」
 *  + 待复核计数 chip，列表行为每份子单据提供「复核」入口（打开全局复核
 *  弹窗）。container 无抽取（字段/关系/图/向量都在 unit 子单据上），标准
 *  抽取区块与复核操作条全部不渲染。底部为修正入口： 重新拆分（存在已绑定
 *  unit 时 409，红色警示 + 强制勾选后带 force 重试）与合并修正（多选
 *  >=2 行确认合并）。units 清单自管： 初始来自快照，修正成功后就地重拉
 *  （弹窗/聊天两种宿主都能看到最新清单），并经 requestRefreshContainers
 *  通知文件树刷新。 */
const ContainerSplitCard: React.FC<{
  docId: string
  batch: BatchLineage
  /** 免登录分享宿主只展示谱系清单，隐藏修正入口。 */
  readOnly?: boolean
}> = ({ docId, batch, readOnly = false }) => {
  const [units, setUnits] = useState<BatchUnitSummary[]>(() =>
    Array.isArray(batch.units) ? batch.units : [],
  )
  const [unitCount, setUnitCount] = useState(() =>
    typeof batch.unitCount === 'number'
      ? batch.unitCount
      : Array.isArray(batch.units)
        ? batch.units.length
        : 0,
  )
  const [needsReviewCount, setNeedsReviewCount] = useState(() =>
    typeof batch.needsReviewCount === 'number'
      ? batch.needsReviewCount
      : Array.isArray(batch.units)
        ? batch.units.filter((u) => u.needsReview).length
        : 0,
  )

  /** 修正操作成功后就地重拉清单; 失败静默保留旧清单(下次操作会再拉)。 */
  const reloadUnits = useCallback(async () => {
    try {
      const fresh = await listDocumentUnits(docId)
      setUnits(fresh)
      setUnitCount(fresh.length)
      setNeedsReviewCount(fresh.filter((u) => u.needsReview).length)
    } catch {
      /* 保留旧清单 */
    }
  }, [docId])

  /** 打开子单据复核并携带同组完整队列(按当前清单序): 弹窗进入翻页模式,
   *  确认/更正后自动前进到下一个待复核。依赖 units —— 重拆/合并后就地
   *  重拉的清单会即时反映到后续打开的队列里。 */
  const openUnitReview = useCallback(
    (unitDocId: string) => {
      requestOpenReview(unitDocId, buildReviewQueueFromUnits(units))
    },
    [units],
  )

  // -- 重新拆分 --
  const [resplitOpen, setResplitOpen] = useState(false)
  const [resplitBusy, setResplitBusy] = useState(false)
  const [resplitError, setResplitError] = useState<string | null>(null)
  /** 409 unit_bound 时被绑定的 unitIndex 清单(null = 尚未遇到绑定冲突)。 */
  const [resplitBound, setResplitBound] = useState<number[] | null>(null)
  const [resplitForce, setResplitForce] = useState(false)
  const [resplitDone, setResplitDone] = useState<string | null>(null)

  const runResplit = async () => {
    if (resplitBusy) return
    setResplitBusy(true)
    setResplitError(null)
    try {
      const res = await resplitDocument(docId, resplitBound !== null && resplitForce)
      setResplitDone(`已重新拆分为 ${res.unitCount} 份子单据`)
      setResplitOpen(false)
      setResplitBound(null)
      setResplitForce(false)
      requestRefreshContainers()
      void reloadUnits()
    } catch (e) {
      if (e instanceof BatchApiError && e.code === 'unit_bound') {
        setResplitBound(parseBoundUnitIndexes(e.detail))
        setResplitError(e.message || '存在已挂合同绑定的子单据')
      } else {
        setResplitError(e instanceof Error && e.message ? e.message : '重新拆分失败，请重试')
      }
    } finally {
      setResplitBusy(false)
    }
  }

  // -- 合并修正 --
  const [mergeMode, setMergeMode] = useState(false)
  const [selectedUnitIds, setSelectedUnitIds] = useState<Set<string>>(() => new Set())
  const [mergeConfirmOpen, setMergeConfirmOpen] = useState(false)
  const [mergeBusy, setMergeBusy] = useState(false)
  const [mergeError, setMergeError] = useState<string | null>(null)
  const [mergeBound, setMergeBound] = useState<number[] | null>(null)
  const [mergeDone, setMergeDone] = useState<string | null>(null)

  const toggleMergeSelect = useCallback((unitId: string) => {
    setSelectedUnitIds((prev) => {
      const next = new Set(prev)
      if (next.has(unitId)) next.delete(unitId)
      else next.add(unitId)
      return next
    })
  }, [])

  const selectedUnits = units.filter((u) => selectedUnitIds.has(u.unitId))

  const enterMergeMode = () => {
    setSelectedUnitIds(new Set())
    setMergeConfirmOpen(false)
    setMergeError(null)
    setMergeBound(null)
    setMergeDone(null)
    setMergeMode(true)
  }

  const exitMergeMode = () => {
    setMergeMode(false)
    setSelectedUnitIds(new Set())
    setMergeConfirmOpen(false)
    setMergeError(null)
    setMergeBound(null)
  }

  const runMerge = async () => {
    if (mergeBusy || selectedUnitIds.size < 2) return
    setMergeBusy(true)
    setMergeError(null)
    try {
      await mergeUnits(docId, [...selectedUnitIds])
      setMergeDone('已合并为一份子单据')
      exitMergeMode()
      requestRefreshContainers()
      void reloadUnits()
    } catch (e) {
      if (e instanceof BatchApiError && e.code === 'unit_bound') {
        setMergeBound(parseBoundUnitIndexes(e.detail))
        setMergeError(e.message || '所选子单据中存在已挂合同绑定的单据')
      } else {
        setMergeError(e instanceof Error && e.message ? e.message : '合并失败，请重试')
      }
    } finally {
      setMergeBusy(false)
    }
  }

  // 复核进度一览(行内徽标之外的汇总答案): 已复核 = confirmed + corrected;
  // 未生成 = 无子单据(docId null) —— 复核状态缺字段的旧响应按「待复核」
  // 兜底(见 ContainerUnitRow), 不计入已复核也不算未生成。
  const reviewedCount = units.filter(
    (u) => u.reviewStatus === 'confirmed' || u.reviewStatus === 'corrected',
  ).length
  const ungeneratedCount = units.filter((u) => !u.docId).length

  return (
    <div className="rounded-lg border border-line bg-white p-3 mt-2">
      {/* 头部： 容器图标 + 单据组标题 + 待复核计数 chip + 复核进度 */}
      <div className="flex items-start gap-2.5 mb-3">
        <div className="w-6 h-6 rounded-full border border-dashed border-[#A9BCCD] bg-[#F2F6FA] flex items-center justify-center shrink-0">
          <Boxes className="w-3.5 h-3.5 text-[#35719C]" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-medium text-ink truncate">
              单据组 · {unitCount} 份单据
            </div>
            {needsReviewCount > 0 && (
              <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded border shrink-0 bg-warning/10 text-warning border-warning/30">
                <AlertTriangle className="w-3 h-3" />
                {needsReviewCount} 份待复核
              </span>
            )}
          </div>
          <div className="text-[11px] text-ink-soft mt-0.5">
            该文件已按单据拆分为多份子单据，请逐份复核
          </div>
          {units.length > 0 && (
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-[11px] text-ink-soft">
                已复核{' '}
                <span
                  className={clsx(
                    'font-mono',
                    reviewedCount === units.length ? 'text-success' : 'text-ink',
                  )}
                >
                  {reviewedCount}
                </span>{' '}
                / {units.length}
              </span>
              <span className="h-1 w-24 overflow-hidden rounded-full bg-line" aria-hidden>
                <span
                  className={clsx(
                    'block h-full rounded-full transition-all duration-500',
                    units.length > 0 && reviewedCount === units.length ? 'bg-success' : 'bg-primary',
                  )}
                  style={{
                    width: `${units.length > 0 ? Math.round((reviewedCount / units.length) * 100) : 0}%`,
                }}
                />
              </span>
              {ungeneratedCount > 0 && (
                <span className="text-[10px] text-ink-soft">
                  另有 {ungeneratedCount} 份未生成
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 子单据清单（合并修正模式下每行变为可勾选） */}
      {units.length === 0 ? (
        <div className="text-xs text-ink-soft italic">暂无子单据</div>
      ) : (
        <div
          className={clsx(
            'rounded-md border divide-y',
            mergeMode ? 'border-primary/30 divide-line/60' : 'border-line/60 divide-line/60',
          )}
        >
          {units.map((u) => (
            <ContainerUnitRow
              key={u.unitId}
              unit={u}
              mergeMode={mergeMode}
              selected={selectedUnitIds.has(u.unitId)}
              onToggleMerge={() => toggleMergeSelect(u.unitId)}
              readOnly={readOnly}
              onOpenReview={openUnitReview}
            />
          ))}
        </div>
      )}

      {/* 底部： 拆分修正入口（重新拆分 / 合并修正） */}
      {!readOnly && (
        <div className="mt-3 pt-3 border-t border-line">
          {mergeMode ? (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-ink font-medium">合并修正</span>
              <span className="text-ink-soft">
                已选 {selectedUnitIds.size} 份（建议选择相邻的单据，至少 2 份）
              </span>
              <span className="ml-auto flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setMergeConfirmOpen(true)}
                  disabled={selectedUnitIds.size < 2}
                  title={selectedUnitIds.size < 2 ? '至少选择 2 份子单据' : ''}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-primary-500 text-white text-xs font-medium hover:bg-primary-500/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  <Combine className="w-3.5 h-3.5" />
                  合并所选{selectedUnitIds.size > 0 ? ` (${selectedUnitIds.size})` : ''}
                </button>
                <button
                  type="button"
                  onClick={exitMergeMode}
                  disabled={mergeBusy}
                  className="px-2 py-1.5 text-xs text-ink-soft hover:text-ink disabled:opacity-50 transition-colors"
                >
                  退出
                </button>
              </span>
            </div>
            {mergeConfirmOpen && (
              <div className="rounded border border-line bg-surface/50 px-2.5 py-2 space-y-1.5 text-xs">
                <div className="text-ink font-medium">
                  确认合并以下 {selectedUnits.length} 份子单据？
                </div>
                <ul className="space-y-0.5">
                  {selectedUnits.map((u) => (
                    <li key={u.unitId} className="flex items-center gap-1.5">
                      <span className="shrink-0 font-mono text-[11px] text-ink-soft">
                        #{u.unitIndex}
                      </span>
                      <span className="truncate">
                        {u.childDocType ?? u.detectedFormType ?? '未识别'}
                      </span>
                    </li>
                  ))}
                </ul>
                <div className="text-ink-soft leading-relaxed">
                  将把所选子单据合并为一份：原有抽取与复核结果会被删除，合并后重新抽取。建议仅合并相邻且属于同一类单据的行。
                </div>
                {mergeBound !== null ? (
                  <div className="rounded border border-danger/30 bg-danger/5 px-2 py-1.5 space-y-1">
                    <div className="flex items-start gap-1.5 text-danger">
                      <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                      <span className="leading-relaxed">
                        所选子单据中存在已挂合同绑定的单据，需先在绑定工作台解除绑定后才能合并：
                      </span>
                    </div>
                    <BoundUnitList indexes={mergeBound} />
                  </div>
                ) : (
                  mergeError && (
                    <div className="flex items-start gap-1.5 text-danger bg-danger/5 border border-danger/30 rounded px-2 py-1.5">
                      <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                      <span className="leading-relaxed">{mergeError}</span>
                    </div>
                  )
                )}
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void runMerge()}
                    disabled={mergeBusy}
                    className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-primary-500 text-white text-xs font-medium hover:bg-primary-500/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {mergeBusy ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Check className="w-3.5 h-3.5" />
                    )}
                    {mergeBusy ? '合并中...' : '确认合并'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setMergeConfirmOpen(false)}
                    disabled={mergeBusy}
                    className="px-2 py-1.5 text-xs text-ink-soft hover:text-ink disabled:opacity-50"
                  >
                    取消
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setResplitOpen((v) => !v)
                  setResplitError(null)
                  setResplitBound(null)
                  setResplitForce(false)
                }}
                disabled={resplitBusy}
                title="删除现有子单据及其抽取、复核、绑定与向量，重新检测拆分"
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md border border-line bg-surface text-ink text-xs font-medium transition-colors hover:border-danger/50 hover:text-danger disabled:opacity-50"
              >
                <Split className="w-3.5 h-3.5" />
                重新拆分
              </button>
              <button
                type="button"
                onClick={enterMergeMode}
                title="将多份子单据合并为一份（建议相邻单据）"
                className="inline-flex items-center gap-1 px-2 py-1.5 text-xs text-ink-soft transition-colors hover:text-ink"
              >
                <Combine className="w-3.5 h-3.5" />
                合并修正
              </button>
              {resplitDone && (
                <span className="text-[11px] text-success">{resplitDone}</span>
              )}
              {mergeDone && (
                <span className="text-[11px] text-success">{mergeDone}</span>
              )}
            </div>
            {resplitOpen && (
              <div className="mt-2 rounded border border-warning/40 bg-warning/5 px-2.5 py-2 space-y-1.5 text-xs">
                <div className="text-ink font-medium">确认重新拆分？</div>
                <div className="text-ink-soft leading-relaxed">
                  将删除现有 {unitCount} 份子单据及其抽取、复核、绑定与向量入库结果，并按检测器重新拆分该文件。
                </div>
                {resplitBound !== null && (
                  <div className="rounded border border-danger/30 bg-danger/5 px-2 py-1.5 space-y-1">
                    <div className="flex items-start gap-1.5 text-danger">
                      <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                      <span className="leading-relaxed">
                        以下子单据已挂合同绑定，重新拆分会解除其绑定：
                      </span>
                    </div>
                    {resplitBound.length > 0 && <BoundUnitList indexes={resplitBound} />}
                  </div>
                )}
                {resplitBound !== null && (
                  <label className="flex items-start gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={resplitForce}
                      onChange={(e) => setResplitForce(e.target.checked)}
                      disabled={resplitBusy}
                      className="mt-0.5 accent-primary"
                    />
                    <span className="leading-relaxed">强制重拆：解除上述绑定并继续</span>
                  </label>
                )}
                {resplitError && resplitBound === null && (
                  <div className="flex items-start gap-1.5 text-danger bg-danger/5 border border-danger/30 rounded px-2 py-1.5">
                    <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                    <span className="leading-relaxed">{resplitError}</span>
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void runResplit()}
                    disabled={resplitBusy || (resplitBound !== null && !resplitForce)}
                    title={resplitBound !== null && !resplitForce ? '需勾选「强制重拆」后才能继续' : ''}
                    className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-danger text-white text-xs font-medium hover:bg-danger/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {resplitBusy ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Split className="w-3.5 h-3.5" />
                    )}
                    {resplitBusy ? '重新拆分中...' : '确认重新拆分'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setResplitOpen(false)
                      setResplitError(null)
                      setResplitBound(null)
                      setResplitForce(false)
                    }}
                    disabled={resplitBusy}
                    className="px-2 py-1.5 text-xs text-ink-soft hover:text-ink disabled:opacity-50"
                  >
                    取消
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
      )}
    </div>
  )
}

/** unit 子单据的「来源与拆分」明细： 来源文件 / 页区间 / 区域数 / 旋回方向 /
 *  共识状态。字段缺失退化为「--」但不隐藏区块——区块本身是「这份数据从哪
 *  来」的锚点。共识状态读 warnings（快照级，两遍读数分歧已强制复核）。 */
const UnitLineagePanel: React.FC<{ batch: BatchLineage; warnings?: string[] }> = ({
  batch,
  warnings,
}) => {
  const pageRange =
    typeof batch.pageStart === 'number' && typeof batch.pageEnd === 'number'
      ? batch.pageStart === batch.pageEnd
        ? `p${batch.pageStart}`
        : `p${batch.pageStart}-p${batch.pageEnd}`
      : '--'
  const warningCount = warnings?.length ?? 0
  const rows: Array<{ label: string; value: string; mono?: boolean }> = [
    { label: '来源文件', value: batch.parentFileName || '--' },
    { label: '页区间', value: pageRange, mono: true },
    {
      label: '区域数',
      value: typeof batch.regionCount === 'number' ? String(batch.regionCount) : '--',
      mono: true,
    },
    {
      label: '旋回方向',
      value: typeof batch.rotationDeg === 'number' ? `${batch.rotationDeg}°` : '--',
      mono: true,
    },
    {
      label: '共识状态',
      value:
        warningCount > 0
          ? `${warningCount} 条读数分歧（已强制复核）`
          : '两遍读数一致',
    },
  ]
  return (
    <div className="rounded border border-line/50 bg-surface/50 px-2 py-1.5 space-y-1">
      {rows.map((r) => (
        <div key={r.label} className="flex items-baseline gap-2 text-xs">
          <span className="text-ink-soft shrink-0 w-16">{r.label}</span>
          <span
            title={r.value}
            className={clsx('min-w-0 break-words', r.mono ? 'font-mono text-primary-500' : 'text-ink')}
          >
            {r.value}
          </span>
        </div>
      ))}
    </div>
  )
}

export const DocumentReviewCard: React.FC<{
  payload: DocumentReviewPayload
  /** Optional callback fired after a successful review POST, with the updated
   *  snapshot. Lets a parent (e.g. a chat log) react to status changes; purely
   *  optional — the card manages its own state otherwise. */
  onUpdated?: (snapshot: DocumentReviewPayload) => void
  /** Optional: jump to the bindings workbench focused on this document.
   *  Provided only when the host can navigate (chat view wires it to App's
   *  openBindingsForDoc); omitted -> the button does not render. */
  onOpenBindings?: (docId: string) => void
  /** 免登录分享宿主传入 true：完整展示快照内容，但不水合最新状态、
   *  不调用登录态接口、不显示更正/确认/重拆/重抽等交互。 */
  readOnly?: boolean
  /** 可选: 单 unit 重抽成功且生成新子单据(docId 更换)后的回调。弹窗宿主
   *  (ReviewModal)传入以把队列中旧 docId 项替换为新 docId 并导航过去;
   *  缺省(聊天宿主等)回落 requestOpenReview 打开新单据复核弹窗。 */
  onReextracted?: (newDocId: string) => void
}> = ({ payload, onUpdated, onOpenBindings, readOnly = false, onReextracted }) => {
  // The card owns its current state so it can optimistic-update after a POST
  // without needing the parent to re-render the tool result. Initialised once
  // from `payload` (tool results are immutable once the step completes).
  const [snapshot, setSnapshot] = useState<DocumentReviewPayload>(payload)
  // 最新 snapshot 镜像: 改类型 PATCH 在途期间 snapshot 可能被并发更新(如并行
  // 提交字段更正/确认), 异步回调里须从 ref 取最新值展开, 避免 stale closure
  // 把父组件经 onUpdated 回滚到旧字段(照 RealChatView contextFilesRef 模式)。
  const snapshotRef = useRef(snapshot)
  useEffect(() => { snapshotRef.current = snapshot }, [snapshot])
  // 历史会话水合: 聊天历史里的工具结果是 present_document_review 运行时刻的
  // 不可变快照, 事后在别处确认/更正过的文档恢复时仍显示 pending。挂载且可编辑
  // 时向服务端拉取一次当前快照, 状态已推进则采纳(404/网络失败静默保留原状)。
  // 依赖仅 docId/初始状态: 挂载后拉一次, 用户本地操作不受影响。
  useEffect(() => {
    if (readOnly || payload.reviewStatus !== 'pending') return
    let cancelled = false
    fetchReviewSnapshot(payload.docId)
      .then((res) => {
        if (cancelled || res.snapshot.reviewStatus === 'pending') return
        setSnapshot((prev) =>
          prev.reviewStatus === 'pending' ? res.snapshot : prev,
        )
      })
      .catch(() => { /* 文档已删除或网络失败: 保留历史快照展示 */ })
    return () => { cancelled = true }
  }, [payload.docId, payload.reviewStatus, readOnly])
  // Per-field edit buffer, keyed by field name. Holds raw input strings; values
  // are only present for fields the user has touched.
  const [edits, setEdits] = useState<Record<string, string>>({})
  // Which action is in-flight ('corrections' | 'confirm' | 'none'). Both buttons
  // are disabled while a request is running to prevent double-submit.
  const [submitting, setSubmitting] = useState<'none' | 'corrections' | 'confirm'>('none')
  const [error, setError] = useState<string | null>(null)

  // -- 类型修正(入口前移, 与绑定工作台共用 PATCH /api/documents/:docId/type):
  //    词表懒加载一次; 下拉选中即提交; 成功就地更新 docType 并回显流水刷新数。 --
  const [typeEditing, setTypeEditing] = useState(false)
  const [typeOptions, setTypeOptions] = useState<string[] | null>(null)
  const [typeOptionsLoading, setTypeOptionsLoading] = useState(false)
  const [typePending, setTypePending] = useState(false)
  const [typeResult, setTypeResult] = useState<{ ok: boolean; text: string; detail?: string } | null>(null)
  const typeResultTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 改类型成功且类型实际变化后的行内引导条: 字段仍是旧类型提取结果, 引导
   *  按新类型重抽(unit)或降级提示(普通文档)。再次改类型成功时被新值替换,
   *  重抽成功/卡片关闭(卸载)时清除。 */
  const [staleType, setStaleType] = useState<{ newType: string; oldType: string } | null>(null)

  // 卸载时清掉结果自动消失的定时器。
  useEffect(() => {
    return () => {
      if (typeResultTimerRef.current) clearTimeout(typeResultTimerRef.current)
    }
  }, [])

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
    contractType,
    graphStatus,
    reviewStatus,
    warnings,
    batch,
  } = snapshot || {}

  const editable = !readOnly && reviewStatus === 'pending'
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

  /** 懒加载激活词表(共用): 改类型下拉与单 unit 重抽的业务类型覆盖项共用
   *  同一份词表; 首次拉取, 失败静默置 null(调用方各自兜底)。 */
  const ensureTypeOptions = useCallback(async () => {
    if (typeOptions || typeOptionsLoading) return
    setTypeOptionsLoading(true)
    try {
      setTypeOptions(await fetchActiveDocTypes())
    } catch {
      setTypeOptions(null)
    } finally {
      setTypeOptionsLoading(false)
    }
  }, [typeOptions, typeOptionsLoading])

  /** 打开改类型下拉: 首次懒加载激活词表(失败静默用兜底词表, 入口不因此关闭)。 */
  const handleOpenTypeEdit = async () => {
    setTypeResult(null)
    setTypeEditing(true)
    void ensureTypeOptions()
  }

  /** 下拉选中即提交(与绑定工作台一致, 不做二次确认); 值由 snapshot.docType 驱动,
   *  失败不改本地状态, 下拉自动回显原值。 */
  const handleChangeType = async (nextType: string) => {
    if (typePending || !nextType || nextType === docType) return
    const oldType = docType
    setTypePending(true)
    setTypeResult(null)
    try {
      const res = await correctDocumentType(snapshot.docId, nextType)
      const applied = res.docType || nextType
      // 类型修正后回填向量回溯结果(缺失则保留原状态, 兼容旧后端)。
      setSnapshot((s) => ({
        ...s,
        docType: applied,
        ...(res.vectorization ? { vectorization: res.vectorization } : {}),
      }))
      // 类型实际变化 -> 字段仍是旧类型提取结果(updateDocumentType 只改标签不
      // 重抽), 行内引导按新类型重抽(unit)或降级提示(普通文档)。再次改类型
      // 成功时被新值替换, 即「再次改类型清除」。
      if (applied !== oldType) {
        setStaleType({ newType: applied, oldType: oldType || '未识别' })
      }
      const skipNote =
        res.skipped.length > 0
          ? `（${res.skipped.length} 项流水未生成）`
          : ''
      const text =
        res.refreshedFlows > 0
          ? `已改为「${applied}」，刷新 ${res.refreshedFlows} 条关联流水${skipNote}`
          : `已改为「${applied}」${skipNote}`
      const detail = res.skipped
        .map((s) => (s.contractNo ? `${s.contractNo}: ${s.reason}` : s.reason))
        .join('\n')
      setTypeResult({ ok: true, text, ...(detail ? { detail } : {}) })
      // 从 ref 展开最新值, 只覆盖 docType/vectorization: snapshot 变量是本回调
      // 创建时的 stale closure, 并行写操作(提交更正/确认)后的字段不能被旧值冲掉。
      onUpdated?.({
        ...snapshotRef.current,
        docType: applied,
        ...(res.vectorization ? { vectorization: res.vectorization } : {}),
      })
    } catch (e) {
      setTypeResult({
        ok: false,
        text: e instanceof Error ? e.message : '类型修正失败，请重试',
      })
    } finally {
      setTypePending(false)
      if (typeResultTimerRef.current) clearTimeout(typeResultTimerRef.current)
      typeResultTimerRef.current = setTimeout(() => setTypeResult(null), 6000)
    }
  }

  // -- 拆分修正(单 unit 重抽): 仅 unit 子单据渲染, 与复核操作条并列 --
  // 覆盖项: 业务类型(激活词表)/旋回方向(0/90/180/270,默认不覆盖); 已绑定
  // unit 首次提交会 409, 红色警示 + 强制勾选后带 force 重试。快照谱系不带
  // unitId, 提交时经容器清单按 unitIndex 反查(GET /api/documents/:docId/units)。
  // 注意: 这些 hooks 必须在下方 container 变体的条件 return 之前声明
  // (rules-of-hooks), container 载荷下状态闲置不用。
  const [reextractOpen, setReextractOpen] = useState(false)
  const [reextractDocType, setReextractDocType] = useState('')
  const [reextractRotation, setReextractRotation] = useState('')
  const [reextractForce, setReextractForce] = useState(false)
  const [reextractBusy, setReextractBusy] = useState(false)
  const [reextractError, setReextractError] = useState<string | null>(null)
  /** 409 unit_bound 时被绑定的 unitIndex 清单(null = 尚未遇到绑定冲突)。 */
  const [reextractBound, setReextractBound] = useState<number[] | null>(null)

  const unitFlagged =
    (warnings?.length ?? 0) > 0 || fields.some((f) => f.needsReview)

  const runReextract = async (docTypeOverride?: string) => {
    if (reextractBusy || !batch || batch.role !== 'unit') return
    const parentDocId = batch.parentDocumentId
    if (!parentDocId) {
      setReextractError('缺少拆分谱系信息（来源单据组），无法重抽')
      return
    }
    setReextractBusy(true)
    setReextractError(null)
    try {
      const containerUnits = await listDocumentUnits(parentDocId)
      const row = containerUnits.find((u) => u.unitIndex === batch.unitIndex)
      if (!row) throw new Error('未在单据组中找到该子单据（可能已被合并或重新拆分）')
      const rot = REEXTRACT_ROTATIONS.find((r) => String(r) === reextractRotation)
      const effectiveDocType = docTypeOverride ?? reextractDocType
      const body: ReextractUnitBody = {
        ...(effectiveDocType ? { docType: effectiveDocType } : {}),
        ...(rot !== undefined ? { rotationDeg: rot } : {}),
        ...(reextractForce ? { force: true } : {}),
      }
      const res = await reextractUnit(parentDocId, row.unitId, body)
      requestRefreshContainers()
      // 重抽成功: 字段已按新类型重建, 引导条使命完成。
      setStaleType(null)
      if (res.docId) {
        // 弹窗宿主: 经 onReextracted 把队列中旧 docId 替换为新 docId 并导航
        // (key 化重挂载自动重拉); 聊天宿主: 打开弹窗查看重抽结果。
        if (onReextracted) {
          onReextracted(res.docId)
        } else {
          requestOpenReview(res.docId)
        }
      } else {
        setReextractError('重抽已完成，但未返回新单据编号，请从文件树重新打开')
      }
    } catch (e) {
      if (e instanceof BatchApiError && e.code === 'unit_bound') {
        setReextractBound(parseBoundUnitIndexes(e.detail))
        setReextractError(e.message || '该子单据已挂合同绑定')
        // 引导条路径(重抽面板未展开)触发 409 时展开面板, 让绑定警示与
        // 「强制重抽」勾选可见; 面板内路径本已展开, 此调用为 no-op。
        setReextractOpen(true)
      } else {
        setReextractError(e instanceof Error && e.message ? e.message : '重新抽取失败，请重试')
      }
    } finally {
      setReextractBusy(false)
    }
  }

  // -- 原片预览(仅 unit 子单据): 拆分器裁切+旋正后的原片区域, 字段抽取
  //    的「地面真值」—— 复核时先看原片再核字段。挂载即拉一次
  //    (fetchDocumentUnitPreview 任何失败返回 null), 失败静默占位、不阻断
  //    复核; objectURL 在卸载时回收。 --
  const [unitPreview, setUnitPreview] = useState<
    { state: 'loading' } | { state: 'ok'; url: string } | { state: 'unavailable' }
  >({ state: readOnly ? 'unavailable' : 'loading' })
  const [unitPreviewLarge, setUnitPreviewLarge] = useState(false)
  const isUnitDoc = batch?.role === 'unit'
  useEffect(() => {
    if (!isUnitDoc || readOnly) return
    let cancelled = false
    let objectUrl: string | null = null
    void fetchDocumentUnitPreview(payload.docId).then((blob) => {
      if (cancelled) return
      if (!blob) {
        setUnitPreview({ state: 'unavailable' })
        return
      }
      objectUrl = URL.createObjectURL(blob)
      setUnitPreview({ state: 'ok', url: objectUrl })
    })
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [isUnitDoc, payload.docId, readOnly])

  // -- 单据组(container)变体： 整卡切「拆分清单」导航形态 --
  // container 无抽取（字段/关系/图/向量都在 unit 子单据上），业务类型固定
  // 「单据组」（跳过分类器，词表也不允许改向），标准区块与复核操作条全部
  // 不渲染。谱系角色对同一 docId 不可变，条件分支挂在所有 hooks 之后，不
  // 违反 hooks 规则。
  if (batch?.role === 'container') {
    return <ContainerSplitCard docId={snapshot.docId} batch={batch} readOnly={readOnly} />
  }

  const warningCount = warnings?.length ?? 0

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
            <div className="flex shrink-0 items-center gap-1.5">
              {onOpenBindings && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    onOpenBindings(snapshot.docId)
                  }}
                  title="前往绑定工作台查看该文件与合同的绑定关系"
                  aria-label="前往绑定工作台"
                  className="inline-flex items-center gap-1 rounded border border-line bg-surface px-1.5 py-0.5 text-[11px] text-ink-soft transition-colors hover:border-primary hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                >
                  <Link2 className="h-3 w-3" />
                  去绑定
                </button>
              )}
              <ReviewStatusBadge status={reviewStatus} />
            </div>
          </div>
          <div className="text-[11px] text-ink-soft mt-0.5">
            综合置信度 <span className="font-mono text-primary-500">{pct(overallConfidence)}</span>
          </div>
        </div>
      </div>

      <div className="space-y-3">
        {/* 0. 原片预览 — 仅 unit 子单据： 拆分器裁切+旋正后的原片区域，
            字段抽取的地面真值。置于区块最前（先看原片再核字段，同屏共见）；
            点击放大；端点未部署/拉取失败时静默占位，不阻断复核。普通文档
            与 container 不渲染，渲染零差异。 */}
        {isUnitDoc && (
          <div>
            <SectionLabel icon={<Crop className="w-3 h-3" />}>原片预览</SectionLabel>
            {unitPreview.state === 'loading' && (
              <div className="flex h-40 items-center justify-center rounded border border-line/50 bg-surface/50">
                <Loader2 className="h-4 w-4 animate-spin text-ink-soft" />
              </div>
            )}
            {unitPreview.state === 'unavailable' && (
              <div className="flex h-20 items-center justify-center rounded border border-dashed border-line/60 bg-surface/40 text-[11px] text-ink-soft">
                原片暂不可用（不影响复核）
              </div>
            )}
            {unitPreview.state === 'ok' && (
              <button
                type="button"
                onClick={() => setUnitPreviewLarge(true)}
                title="点击放大查看原片"
                className="block w-full cursor-zoom-in overflow-hidden rounded border border-line/50 bg-surface/50 transition-colors hover:border-primary/40"
              >
                <img
                  src={unitPreview.url}
                  alt="子单据原片（拆分裁切区域）"
                  className="mx-auto max-h-64 w-auto object-contain"
                />
              </button>
            )}
            <div className="mt-1 text-[10px] text-ink-soft">
              拆分器裁切并旋正后的原片区域，字段抽取以此为依据
            </div>
          </div>
        )}

        {/* 1. 业务类型 */}
        <div>
          <SectionLabel icon={<FileText className="w-3 h-3" />}>业务类型</SectionLabel>
          {typeEditing ? (
            <div className="flex items-center gap-2 flex-wrap text-xs">
              <select
                value={docType ?? ''}
                onChange={(e) => void handleChangeType(e.target.value)}
                disabled={typePending || typeOptionsLoading}
                aria-label="修正文档类型"
                className="h-7 min-w-0 flex-1 max-w-56 rounded-md border border-line bg-white px-2 text-xs text-ink focus:border-primary focus:outline-none disabled:opacity-50"
              >
                {(!docType || docType === '') && <option value="">未识别</option>}
                {(docType && typeOptions && !typeOptions.includes(docType) ? [docType, ...typeOptions] : (typeOptions ?? []))
                  .filter(Boolean)
                  .map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
              </select>
              {(typePending || typeOptionsLoading) && (
                <Loader2 className="w-3.5 h-3.5 animate-spin text-ink-soft shrink-0" />
              )}
              {!typePending && !typeOptionsLoading && (
                <button
                  type="button"
                  onClick={() => setTypeEditing(false)}
                  className="text-[11px] text-ink-soft hover:text-ink shrink-0"
                >
                  收起
                </button>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-2 flex-wrap text-xs">
              <span className="text-ink font-medium">{docType || '--'}</span>
              {!readOnly && (
                <button
                  type="button"
                  onClick={() => void handleOpenTypeEdit()}
                  disabled={typePending}
                  title="修正文档类型（绑定建议与关联流水将自动刷新）"
                  className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-primary hover:bg-primary/10 disabled:opacity-50 transition-colors"
                >
                  <PenLine className="w-3 h-3" />
                  改类型
                </button>
              )}
              <span className="text-ink-soft">·</span>
              <span className="text-ink-soft">
                分类置信度{' '}
                <span className={clsx('font-mono', classificationLow ? 'text-warning' : 'text-primary-500')}>
                  {pct(classificationConfidence)}
                </span>
              </span>
              {classificationLow && <FlagBadge />}
            </div>
          )}
          {typeResult && (
            <div
              title={typeResult.detail}
              className={clsx(
                'mt-1.5 flex items-start gap-1.5 text-[11px] rounded px-2 py-1 border',
                typeResult.ok
                  ? 'text-success bg-success/5 border-success/30'
                  : 'text-danger bg-danger/5 border-danger/30',
              )}
            >
              {typeResult.ok ? (
                <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              ) : (
                <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              )}
              <span className="leading-relaxed">{typeResult.text}</span>
            </div>
          )}
          {/* 改类型成功后的行内引导条: 字段仍是旧类型提取结果。unit 子单据可
              一键按新类型重抽(复用现有重抽逻辑, 不传旋回=保持默认); 普通文档
              降级提示不支持按类型重抽。再次改类型成功时被新值替换。 */}
          {staleType && !readOnly && (
            <div className="mt-1.5 flex items-start gap-1.5 text-[11px] rounded px-2 py-1.5 border border-warning/30 bg-warning/5 text-warning">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <div className="min-w-0 flex-1 leading-relaxed">
                {batch?.role === 'unit' ? (
                  <span>
                    业务类型已改为「{staleType.newType}」，当前字段仍是旧类型（
                    {staleType.oldType}）的提取结果
                    <button
                      type="button"
                      onClick={() => {
                        // 预置面板类型为改后新类型并展开(409 绑定警示/强制勾选
                        // 可见), 随后立即按新类型重抽。
                        setReextractDocType(staleType.newType)
                        setReextractOpen(true)
                        void runReextract(staleType.newType)
                      }}
                      disabled={reextractBusy}
                      title="删除该子单据现有抽取与复核结果，按新业务类型重新抽取"
                      className="ml-2 inline-flex items-center gap-1 rounded border border-warning/40 bg-white px-2 py-0.5 font-medium text-warning transition-colors hover:bg-warning/10 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {reextractBusy ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : (
                        <RefreshCw className="w-3 h-3" />
                      )}
                      {reextractBusy ? '重新抽取中...' : '按新类型重新提取'}
                    </button>
                  </span>
                ) : (
                  <span>
                    当前字段仍为旧类型提取结果；此类文档暂不支持按类型重抽
                  </span>
                )}
              </div>
            </div>
          )}
        </div>

        {/* 1.5 合同文档下一步引导 — 心智模型收敛(轻量版): 合同不需要像凭证那样
            「绑定到合同」, 它完成抽取后自动进台账, 真正的下一步是挂项目/挂单据。 */}
        {CONTRACT_DOC_TYPES.has(docType ?? '') && (
          <div className="flex items-start gap-1.5 text-xs text-ink-soft bg-surface/50 border border-line/50 rounded px-2 py-1.5">
            <Info className="w-3.5 h-3.5 shrink-0 mt-0.5 text-primary" />
            <span className="leading-relaxed">
              合同完成抽取后自动进入合同台账。下一步：到「项目」页把它挂到项目；发票、货转单等执行单据在「绑定」页挂到该合同。
            </span>
          </div>
        )}

        {/* 1.6 合同类型 — 主体视角派生（spec 2026-08-20）; null = 非合同或未识别,
            不渲染该区。conflict=true 时黄条提示人工确认方向。 */}
        {contractType?.contractType && (
          <div>
            <SectionLabel icon={<Bookmark className="w-3 h-3" />}>合同类型</SectionLabel>
            <div className="flex items-center gap-2 flex-wrap text-xs">
              <span className="inline-flex items-center text-[11px] px-2 py-0.5 rounded border bg-surface/50 text-ink border-line/50">
                {contractType.contractType}
              </span>
              <span className="text-ink-soft">
                来源{' '}
                <span className="font-mono text-primary-500">
                  {CONTRACT_TYPE_SOURCE_LABEL[contractType.source ?? ''] ?? '未识别'}
                </span>
              </span>
            </div>
            {contractType.conflict && (
              <div className="mt-1.5 flex items-start gap-1.5 text-xs text-warning bg-warning/5 border border-warning/30 rounded px-2 py-1.5">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <span className="leading-relaxed">合同类型与主体方向不一致，请人工确认</span>
              </div>
            )}
          </div>
        )}

        {/* 2. 结构化字段 — core value: flag needsReview / low confidence.
            Editable when pending; read-only otherwise. */}
        <div>
          <SectionLabel icon={<ListChecks className="w-3 h-3" />}>结构化字段</SectionLabel>
          {/* 批量拆分 unit 的两遍读数共识分歧（P2 已强制 needs_review）：
              逐条列出，用户核对字段时对照原始分歧描述。普通文档 warningCount
              为 0，不渲染，与现状零差异。 */}
          {warningCount > 0 && (
            <div className="mb-2 flex items-start gap-1.5 text-xs text-warning bg-warning/5 border border-warning/30 rounded px-2 py-1.5">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <div className="min-w-0 leading-relaxed">
                <div className="font-medium">两遍读数存在 {warningCount} 条分歧，已按强制复核处理：</div>
                <ul className="mt-0.5 space-y-0.5">
                  {(warnings ?? []).map((w, i) => (
                    <li key={i} className="font-mono text-[11px] break-words">
                      {typeof w === 'string' ? w : ''}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
          {fields.length === 0 ? (
            <div className="text-xs text-ink-soft italic">暂无</div>
          ) : (
            <div className="space-y-1">
              {fields.map((f, i) => {
                const flagged =
                  f.needsReview ||
                  (typeof f.confidence === 'number' && f.confidence < LOW_CONFIDENCE)
                const edited = edits[f.name]
                const originalText = String(f.value ?? '')
                const changed = edited !== undefined && edited !== originalText
                // 表格型字段：数组/对象字段值（后端紧凑 JSON 持久化）解析为对象
                // 行渲染成可编辑迷你表格；解析失败/空数组/非对象行回落下方既有
                // 单行渲染，普通字段零差异。
                const tableRows = parseTableField(edited ?? originalText)
                if (tableRows) {
                  const origRows = parseTableField(originalText)
                  const handleCell = (
                    rowIndex: number,
                    key: string,
                    raw: string,
                    commit: boolean,
                  ) => {
                    const next = tableRows.map((row, idx) => {
                      if (idx !== rowIndex) return row
                      const value = commit
                        ? coerceTableCell(origRows?.[rowIndex]?.[key], raw)
                        : raw.trim() === ''
                          ? null
                          : raw
                      return { ...row, [key]: value }
                    })
                    // 整表序列化回紧凑 JSON 写入 edits 缓冲：后端同样以紧凑
                    // JSON 持久化，未改动的表格 round-trip 后字符串相等，不会
                    // 被误标「已改」；corrections 计算与提交链路零改动。
                    updateField(f.name, JSON.stringify(next))
                  }
                  return (
                    <TableFieldValue
                      key={`${f.name}-${i}`}
                      label={f.name}
                      confidence={f.confidence}
                      editable={editable}
                      rows={tableRows}
                      origRows={origRows}
                      changed={changed}
                      flagged={flagged}
                      onCellChange={handleCell}
                    />
                  )
                }
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
                        value={edited ?? originalText}
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

        {/* 8. 来源与拆分 — 批量拆分 unit 子单据的谱系回链（Phase 3）： 来源
            文件 / 页区间 / 区域数 / 旋回方向 / 共识状态。普通文档（batch 缺失
            或 role 非 unit）不渲染，与现状零差异。 */}
        {batch?.role === 'unit' && (
          <div>
            <SectionLabel icon={<FileStack className="w-3 h-3" />}>来源与拆分</SectionLabel>
            <UnitLineagePanel batch={batch} warnings={warnings} />
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

      {/* 拆分修正（单 unit 重抽）— 仅 unit 子单据渲染，与复核操作条并列；
          已确认/已更正的子单据同样可重抽（覆盖现读数走强制勾选）。普通
          文档（batch 缺失或非 unit）不渲染，与现状零差异。 */}
      {!readOnly && batch?.role === 'unit' && (
        <div className="mt-3 pt-3 border-t border-line">
          {reextractOpen ? (
            <div className="space-y-1.5 text-xs">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-ink font-medium">重新抽取这份单据</span>
                <span className="text-ink-soft truncate">
                  （来源 {batch.parentFileName || '--'} 第 {batch.unitIndex ?? '--'} 份）
                </span>
                <button
                  type="button"
                  onClick={() => setReextractOpen(false)}
                  disabled={reextractBusy}
                  className="ml-auto shrink-0 text-[11px] text-ink-soft hover:text-ink disabled:opacity-50"
                >
                  收起
                </button>
              </div>
              <div className="flex items-start gap-1.5 text-ink-soft bg-surface/50 border border-line/50 rounded px-2 py-1.5">
                <Info className="w-3.5 h-3.5 shrink-0 mt-0.5 text-primary" />
                <span className="leading-relaxed">
                  重新抽取将删除该子单据现有的抽取与复核结果，并按下列覆盖项重新处理。
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-1.5">
                  <span className="text-ink-soft">业务类型</span>
                  <select
                    value={reextractDocType}
                    onChange={(e) => setReextractDocType(e.target.value)}
                    disabled={reextractBusy || typeOptionsLoading}
                    aria-label="重抽时覆盖业务类型"
                    className="h-7 rounded-md border border-line bg-white px-2 text-xs text-ink focus:border-primary focus:outline-none disabled:opacity-50"
                  >
                    <option value="">不覆盖</option>
                    {(typeOptions ?? DOC_TYPE_FALLBACK).map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </label>
                <label className="flex items-center gap-1.5">
                  <span className="text-ink-soft">旋回方向</span>
                  <select
                    value={reextractRotation}
                    onChange={(e) => setReextractRotation(e.target.value)}
                    disabled={reextractBusy}
                    aria-label="重抽时覆盖旋回方向"
                    className="h-7 rounded-md border border-line bg-white px-2 text-xs text-ink focus:border-primary focus:outline-none disabled:opacity-50"
                  >
                    <option value="">不覆盖</option>
                    <option value="0">0°</option>
                    <option value="90">90°</option>
                    <option value="180">180°</option>
                    <option value="270">270°</option>
                  </select>
                </label>
                {typeOptionsLoading && (
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-ink-soft shrink-0" />
                )}
              </div>
              {unitFlagged && (
                <div className="text-[11px] text-warning leading-relaxed">
                  该单据带有读数分歧或低置信标记，重抽将覆盖现有读数。
                </div>
              )}
              {reextractBound !== null && (
                <div className="rounded border border-danger/30 bg-danger/5 px-2 py-1.5 space-y-1">
                  <div className="flex items-start gap-1.5 text-danger">
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                    <span className="leading-relaxed">
                      该子单据已挂合同绑定，重抽会解除其绑定：
                    </span>
                  </div>
                  {reextractBound.length > 0 && <BoundUnitList indexes={reextractBound} />}
                </div>
              )}
              {reextractBound !== null && (
                <label className="flex items-start gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={reextractForce}
                    onChange={(e) => setReextractForce(e.target.checked)}
                    disabled={reextractBusy}
                    className="mt-0.5 accent-primary"
                  />
                  <span className="leading-relaxed">强制重抽：解除该子单据的合同绑定并继续</span>
                </label>
              )}
              {reextractError && reextractBound === null && (
                <div className="flex items-start gap-1.5 text-danger bg-danger/5 border border-danger/30 rounded px-2 py-1.5">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <span className="leading-relaxed">{reextractError}</span>
                </div>
              )}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void runReextract()}
                  disabled={reextractBusy || (reextractBound !== null && !reextractForce)}
                  title={reextractBound !== null && !reextractForce ? '需勾选「强制重抽」后才能继续' : ''}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-primary-500 text-white text-xs font-medium hover:bg-primary-500/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {reextractBusy ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="w-3.5 h-3.5" />
                  )}
                  {reextractBusy ? '重新抽取中...' : '重新抽取'}
                </button>
                {reextractBusy && (
                  <span className="text-[11px] text-ink-soft">处理中...</span>
                )}
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                setReextractOpen(true)
                setReextractError(null)
                setReextractBound(null)
                void ensureTypeOptions()
              }}
              title="删除该子单据现有抽取与复核结果，按覆盖项重新抽取"
              className="inline-flex items-center gap-1 rounded border border-line bg-surface px-1.5 py-0.5 text-[11px] text-ink-soft transition-colors hover:border-primary hover:text-primary"
            >
              <RefreshCw className="w-3 h-3" />
              拆分修正（重新抽取）
            </button>
          )}
        </div>
      )}

      {/* 原片放大灯箱： 点击遮罩任意处关闭（含图片本身）; 不抢 Esc ——
          宿主弹窗(ReviewModal)的 Esc 语义保持「关闭整个复核弹窗」。 */}
      {unitPreviewLarge && unitPreview.state === 'ok' && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="原片放大预览"
          onClick={() => setUnitPreviewLarge(false)}
          className="fixed inset-0 z-modal flex cursor-zoom-out items-center justify-center bg-ink/80 p-6 animate-fade-in"
        >
          <img
            src={unitPreview.url}
            alt="子单据原片（放大）"
            className="max-h-[88vh] max-w-full rounded-lg bg-white shadow-2xl"
          />
        </div>
      )}
    </div>
  )
}

export default DocumentReviewCard
