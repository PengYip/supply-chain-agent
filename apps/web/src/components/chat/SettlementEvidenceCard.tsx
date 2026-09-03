// 结算取证卡(2026-09-01 结算引擎取证步骤的专属渲染):
// gather_settlement_evidence 的结果在聊天工具步里用结构化卡片呈现——
// 合同头 + 结算口径摘要(节点权威聚合的权威数字, 把「勿逐行累加流水」的
// 口径约束可视化为界面提示) + 执行流水(逐行可溯源到单据复核弹窗) +
// 质量凭证(已确认绑定) + 待确认绑定警示 + 历史结算 + 口径说明折叠。
// 纯展示: 不发请求、不做计算; 数字与口径全部来自工具返回, 溯源跳转复用
// lib/reviewModal 总线。后端 settlementTools.ts 为契约 SSOT, 本文件只做
// 防御性 narrowing(字段缺失/形状异常退化为占位或不渲染, 不抛错)。
import React, { useState } from 'react'
import clsx from 'clsx'
import {
  AlertTriangle,
  ArrowLeftRight,
  ChevronDown,
  FlaskConical,
  History,
  Info,
  Layers,
  Scale,
  Ship,
  Train,
  TrendingUp,
  Truck,
} from 'lucide-react'
import {
  flowDirectionLabel,
  formatFlowQuantity,
  type FlowDirection,
  type FlowType,
} from '../../api/flows'
import { requestOpenReview } from '../../lib/reviewModal'

// ── 展示向的载荷契约(parseSettlementEvidence 的产物, 卡片只消费它) ──────

export interface SettlementFieldEntry {
  name: string
  value: string
}

export interface SettlementFlowRow {
  flowId: string
  documentId: string
  flowType: string
  direction: string
  quantityTon: number | null
  quantityValue: number | null
  unit: string | null
  docType: string
  voucherDate: string | null
}

export interface SettlementContractInfo {
  documentId: string
  displayContractNo: string
  title: string | null
  contractType: string | null
  fields: SettlementFieldEntry[]
}

export interface SettlementProgressInfo {
  basis: { quantity: number; unit: string } | null
  deliveredMassKg: number | null
  deliveredCountPools: Array<{ unit: string; count: number }>
  actualMassKg: number | null
  noticeMassKg: number | null
  progressRatio: number | null
  reason: string | null
  /** 口径明细(additive, 后端 1a0fe85 起): 每条流水的计入/排除归类;
   *  旧聊天历史无此字段 -> 空数组, 对应区块整体不渲染。 */
  contributions: SettlementContribution[]
  /** 计入流水按运输方式分组(additive); 旧结果/无计入流水 -> 空数组。 */
  transportModes: SettlementTransportModeGroup[]
}

/** executionProgress.contributions 的单行(计入/排除归类, delivered 构成溯源)。 */
export interface SettlementContribution {
  flowId: string
  docType: string
  tier: 'actual' | 'notice'
  counted: boolean
  excludeReason: string | null
  /** counted 且 mass: 规范值(千克)。 */
  massKg: number | null
  /** counted 且 count: 池单位 + 原值。 */
  countUnit: string | null
  countValue: number | null
}

/** executionProgress.transportModes 的单组(仅计入口径)。 */
export interface SettlementTransportModeGroup {
  mode: string
  flowCount: number
  massKg: number | null
  countPools: Array<{ unit: string; count: number }>
  docTypes: Array<{ docType: string; count: number }>
}

export interface SettlementQualityDoc {
  documentId: string
  docType: string
  fields: SettlementFieldEntry[]
}

export interface SettlementPendingQualityDoc {
  documentId: string
  docType: string
  confidence: number | null
}

export interface SettlementRecordItem {
  id: string
  settledQuantity: number | null
  quantityUnit: string | null
  basePrice: number | null
  currency: string | null
  totalAmount: number | null
  notes: string | null
  createdAt: string | null
  adjustmentCount: number
}

export interface SettlementEvidencePayload {
  contractNo: string
  contract: SettlementContractInfo | null
  flows: SettlementFlowRow[]
  progress: SettlementProgressInfo
  qualityDocs: SettlementQualityDoc[]
  pendingQualityDocs: SettlementPendingQualityDoc[]
  settlements: SettlementRecordItem[]
  usage: string
}

// ── 防御性解析 ──────────────────────────────────────────────────────────

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.length > 0 ? v : null

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null

/** Record<string,unknown> → 可展示的标量键值对: 标量直接取; 台账/抽取字段的
 *  {value: 标量} 惯例形态取内层; 数组/嵌套对象折叠为截断 JSON(保留可溯源性,
 *  不静默丢弃)。 */
function extractScalarFields(raw: unknown): SettlementFieldEntry[] {
  const rec = asRecord(raw)
  if (!rec) return []
  const out: SettlementFieldEntry[] = []
  for (const [name, v] of Object.entries(rec)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      out.push({ name, value: String(v) })
      continue
    }
    const inner = asRecord(v)?.value
    if (typeof inner === 'string' || typeof inner === 'number' || typeof inner === 'boolean') {
      out.push({ name, value: String(inner) })
      continue
    }
    const folded = safeJson(v)
    out.push({
      name,
      value: folded.length > 48 ? `${folded.slice(0, 48)}…` : folded,
    })
  }
  return out
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v)
  } catch {
    return String(v)
  }
}

/** Record<string, number> 形态(计数池/docType 构成) → 键值对; 值非数值的条目跳过。 */
function numberRecordEntries(raw: unknown): Array<{ key: string; value: number }> {
  const rec = asRecord(raw)
  if (!rec) return []
  const out: Array<{ key: string; value: number }> = []
  for (const [key, v] of Object.entries(rec)) {
    const n = num(v)
    if (n !== null) out.push({ key, value: n })
  }
  return out
}

/** narrowing gather_settlement_evidence 的成功返回; 非 ok/error 形状或其他
 *  工具一律返回 null(调用方回落通用结果框)。 */
export function parseSettlementEvidence(
  toolName: string,
  result: unknown,
): SettlementEvidencePayload | null {
  if (toolName !== 'gather_settlement_evidence') return null
  const r = asRecord(result)
  if (!r || r.status !== 'ok') return null
  const contractNo = str(r.contractNo)
  if (!contractNo) return null

  const rawContract = asRecord(r.contract)
  const contract: SettlementContractInfo | null = rawContract
    ? {
        documentId: str(rawContract.documentId) ?? '',
        displayContractNo: str(rawContract.displayContractNo) ?? contractNo,
        title: str(rawContract.title),
        contractType: str(rawContract.contractType),
        fields: extractScalarFields(rawContract.fields),
      }
    : null

  const flows: SettlementFlowRow[] = (Array.isArray(r.flows) ? r.flows : [])
    .map((raw): SettlementFlowRow | null => {
      const f = asRecord(raw)
      if (!f) return null
      const flowId = str(f.flowId)
      if (!flowId) return null
      return {
        flowId,
        documentId: str(f.documentId) ?? '',
        flowType: str(f.flowType) ?? '',
        direction: str(f.direction) ?? '',
        quantityTon: num(f.quantityTon),
        quantityValue: num(f.quantityValue),
        unit: str(f.unit),
        docType: str(f.docType) ?? '未知单据',
        voucherDate: str(f.voucherDate),
      }
    })
    .filter((f): f is SettlementFlowRow => f !== null)

  const p = asRecord(r.executionProgress)
  const basisRec = p ? asRecord(p.basis) : null
  const basis =
    basisRec && num(basisRec.quantity) !== null && str(basisRec.unit)
      ? { quantity: num(basisRec.quantity) as number, unit: str(basisRec.unit) as string }
      : null
  const delivered = p ? asRecord(p.delivered) : null
  const nodes = delivered ? asRecord(delivered.nodes) : null
  const countPools: Array<{ unit: string; count: number }> = []
  const poolsRec = delivered ? asRecord(delivered.countPools) : null
  if (poolsRec) {
    for (const [unit, v] of Object.entries(poolsRec)) {
      const count = num(v)
      if (count !== null) countPools.push({ unit, count })
    }
  }
  const contributions: SettlementContribution[] = (
    Array.isArray(p?.contributions) ? p.contributions : []
  )
    .map((raw): SettlementContribution | null => {
      const c = asRecord(raw)
      if (!c) return null
      return {
        flowId: str(c.flowId) ?? '',
        docType: str(c.docType) ?? '',
        tier: c.tier === 'notice' ? 'notice' : 'actual',
        counted: c.counted === true,
        excludeReason: str(c.excludeReason),
        massKg: num(c.massKg),
        countUnit: str(c.countUnit),
        countValue: num(c.countValue),
      }
    })
    .filter((c): c is SettlementContribution => c !== null)

  const transportModes: SettlementTransportModeGroup[] = (
    Array.isArray(p?.transportModes) ? p.transportModes : []
  )
    .map((raw): SettlementTransportModeGroup | null => {
      const g = asRecord(raw)
      if (!g) return null
      const mode = str(g.mode)
      if (!mode) return null
      return {
        mode,
        flowCount: num(g.flowCount) ?? 0,
        massKg: num(g.massKg),
        countPools: numberRecordEntries(g.countPools).map(({ key, value }) => ({
          unit: key,
          count: value,
        })),
        docTypes: numberRecordEntries(g.docTypes).map(({ key, value }) => ({
          docType: key,
          count: value,
        })),
      }
    })
    .filter((g): g is SettlementTransportModeGroup => g !== null)

  const progress: SettlementProgressInfo = {
    basis,
    deliveredMassKg: delivered ? num(delivered.massKg) : null,
    deliveredCountPools: countPools,
    actualMassKg: nodes ? num(nodes.actualMassKg) : null,
    noticeMassKg: nodes ? num(nodes.noticeMassKg) : null,
    progressRatio: p ? num(p.progress) : null,
    reason: p ? str(p.reason) : null,
    contributions,
    transportModes,
  }

  const qualityDocs: SettlementQualityDoc[] = (Array.isArray(r.qualityDocs) ? r.qualityDocs : [])
    .map((raw): SettlementQualityDoc | null => {
      const d = asRecord(raw)
      if (!d) return null
      const documentId = str(d.documentId)
      if (!documentId) return null
      return {
        documentId,
        docType: str(d.docType) ?? '质量凭证',
        fields: extractScalarFields(d.fields),
      }
    })
    .filter((d): d is SettlementQualityDoc => d !== null)

  const pendingQualityDocs: SettlementPendingQualityDoc[] = (
    Array.isArray(r.pendingQualityDocs) ? r.pendingQualityDocs : []
  )
    .map((raw): SettlementPendingQualityDoc | null => {
      const d = asRecord(raw)
      if (!d) return null
      const documentId = str(d.documentId)
      if (!documentId) return null
      return {
        documentId,
        docType: str(d.docType) ?? '质量凭证',
        confidence: num(d.confidence),
      }
    })
    .filter((d): d is SettlementPendingQualityDoc => d !== null)

  const settlements: SettlementRecordItem[] = (
    Array.isArray(r.settlements) ? r.settlements : []
  ).map((raw, i): SettlementRecordItem => {
    const s = asRecord(raw) ?? {}
    return {
      id: str(s.id) ?? `row-${i}`,
      settledQuantity: num(s.settledQuantity),
      quantityUnit: str(s.quantityUnit),
      basePrice: num(s.basePrice),
      currency: str(s.currency),
      totalAmount: num(s.totalAmount),
      notes: str(s.notes),
      createdAt: str(s.createdAt),
      adjustmentCount: Array.isArray(s.adjustments) ? s.adjustments.length : 0,
    }
  })

  return {
    contractNo,
    contract,
    flows,
    progress,
    qualityDocs,
    pendingQualityDocs,
    settlements,
    usage: str(r.usage) ?? '',
  }
}

// ── 展示辅助 ────────────────────────────────────────────────────────────

/** 千克(规范质量层) → 吨读数, 最多 3 位小数。 */
const fmtTon = (kg: number): string =>
  (kg / 1000).toLocaleString('zh-CN', { maximumFractionDigits: 3 })

const fmtNum = (n: number): string => n.toLocaleString('zh-CN', { maximumFractionDigits: 2 })

const fmtAmount = (n: number | null, currency: string | null): string => {
  if (n === null) return '--'
  const body = n.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
  if (!currency || currency === 'CNY') return `${body} 元`
  return `${currency} ${body}`
}

/** executionProgress.reason 的已知值文案; 未知值原样展示。 */
const PROGRESS_REASON_LABEL: Record<string, string> = {
  'no-contract-basis': '合同台账未提供可解析的数量基准，无法计算执行进度',
  'dimension-mismatch': '流水量纲（计数）与合同基准（质量）不一致，进度不可比',
  'unit-pool-missing': '流水缺少与基准同单位的计数，进度暂缺',
}

/** contributions.excludeReason 的已知值文案(措辞对齐后端 executionProgress.ts 注释);
 *  warn=true 为数据问题(数量/单位缺失), false 为防双计的正常口径排除。
 *  未知 reason 原样展示。 */
const EXCLUDE_REASON_META: Record<string, { label: string; title: string; warn: boolean }> = {
  'no-valid-quantity': {
    label: '无有效数量',
    title: '数量量纲缺失或未知，未计入',
    warn: true,
  },
  'no-canonical': {
    label: '无法归一化量纲',
    title: '质量量纲但单位未注册，规范值缺失，未计入（物化层不猜）',
    warn: true,
  },
  'no-unit': {
    label: '缺单位',
    title: '计数量纲但缺单位，不能成池，未计入',
    warn: true,
  },
  'covered-by-actual': {
    label: '已被实重覆盖',
    title: '预告凭证被同批实重凭证覆盖，该批次按实重计入（不双计）',
    warn: false,
  },
  'covered-by-notice': {
    label: '已被预告覆盖',
    title: '实重层未成为合计基准，该批次按预告计入',
    warn: false,
  },
}

/** 运输方式图标(mode 为后端固定词表 火车/汽车/船舶/其他, 未映射的不渲染图标)。 */
const TRANSPORT_MODE_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  火车: Train,
  汽车: Truck,
  船舶: Ship,
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

// ── 卡片 ────────────────────────────────────────────────────────────────

/** 执行流水默认折叠行数: 超出折叠为「展开全部」, 展开后滚动区阅读
 *  (数百行时避免一次性撑爆聊天气泡; 行本身不可聚合——聚合口径只有
 *  节点权威聚合一种, 见摘要区提示)。 */
const FLOW_COLLAPSE_THRESHOLD = 8

/** 口径明细默认折叠行数(与执行流水行为一致)。 */
const CONTRIBUTION_COLLAPSE_THRESHOLD = 8

/** 运输方式分组行: 模式(图标+名) / 条数 / 质量(或计数池) / docType 构成。 */
const TransportModeRow: React.FC<{ group: SettlementTransportModeGroup }> = ({ group }) => {
  const ModeIcon = TRANSPORT_MODE_ICON[group.mode]
  const massText =
    group.massKg !== null && group.massKg > 0 ? `${fmtTon(group.massKg)} 吨` : null
  const poolsText = group.countPools.length > 0
    ? group.countPools.map((p) => `${fmtNum(p.count)} ${p.unit}`).join(' · ')
    : null
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1.5 text-xs">
      <span className="inline-flex shrink-0 items-center gap-1 font-medium text-ink">
        {ModeIcon && <ModeIcon className="h-3 w-3 text-ink-soft" />}
        {group.mode}
      </span>
      <span className="shrink-0 text-ink-soft">{group.flowCount} 笔</span>
      {massText && <span className="shrink-0 font-mono text-primary-500">{massText}</span>}
      {poolsText && <span className="shrink-0 font-mono text-primary-500">{poolsText}</span>}
      <span className="ml-auto flex flex-wrap justify-end gap-1">
        {group.docTypes.map((d) => (
          <span
            key={d.docType}
            className="shrink-0 rounded border border-line/50 bg-surface/50 px-1.5 py-px text-[10px] text-ink"
          >
            {d.docType} x{d.count}
          </span>
        ))}
      </span>
    </div>
  )
}

/** 口径明细行: 节点层(实重/预告) + 单据类型 + 数量 + 计入/未计入(排除原因)。 */
const ContributionRow: React.FC<{ c: SettlementContribution }> = ({ c }) => {
  const reasonMeta = c.excludeReason ? EXCLUDE_REASON_META[c.excludeReason] : undefined
  const qtyText =
    c.counted && c.massKg !== null
      ? `${fmtTon(c.massKg)} 吨`
      : c.counted && c.countValue !== null
        ? `${fmtNum(c.countValue)}${c.countUnit ? ` ${c.countUnit}` : ''}`
        : null
  return (
    <div className="flex items-center gap-2 px-2 py-1.5 text-xs">
      <span
        className={clsx(
          'shrink-0 whitespace-nowrap rounded px-1.5 py-px text-[10px]',
          c.tier === 'actual' ? 'bg-primary-500/10 text-primary-500' : 'bg-surface text-ink-soft',
        )}
        title={c.tier === 'actual' ? '实重节点（权威）' : '预告节点'}
      >
        {c.tier === 'actual' ? '实重' : '预告'}
      </span>
      <span className="min-w-0 flex-1 truncate text-ink">{c.docType || '--'}</span>
      {qtyText && <span className="shrink-0 font-mono text-[11px] text-ink">{qtyText}</span>}
      <span
        title={c.counted ? '已计入已交付量' : (reasonMeta?.title ?? c.excludeReason ?? undefined)}
        className={clsx(
          'ml-auto shrink-0 whitespace-nowrap rounded px-1.5 py-px text-[10px]',
          c.counted
            ? 'bg-success/10 text-success'
            : reasonMeta?.warn
              ? 'bg-warning/10 text-warning'
              : 'bg-surface text-ink-soft',
        )}
      >
        {c.counted ? '计入' : `未计入 · ${reasonMeta?.label ?? c.excludeReason ?? '未知原因'}`}
      </span>
    </div>
  )
}

const FlowListRow: React.FC<{ flow: SettlementFlowRow; readOnly?: boolean }> = ({
  flow,
  readOnly = false,
}) => {
  // 六向词汇映射复用 api/flows 的 SSOT(未知组合回落 原样拼接)
  const dirLabel = flowDirectionLabel(flow.flowType as FlowType, flow.direction as FlowDirection)
  const qtyValue = flow.quantityValue ?? flow.quantityTon
  const qtyUnit = flow.unit ?? (flow.quantityValue === null && flow.quantityTon !== null ? '吨' : null)
  const canOpen = !readOnly && flow.documentId.length > 0
  return (
    <button
      type="button"
      disabled={!canOpen}
      onClick={() => requestOpenReview(flow.documentId)}
      title={
        canOpen
          ? `打开关联单据的复核卡（${flow.flowType || '流水'} ${flow.flowId}）`
          : '该流水无关联单据'
      }
      className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs transition-colors hover:bg-surface disabled:cursor-default disabled:opacity-70 disabled:hover:bg-transparent"
    >
      <span className="w-[76px] shrink-0 truncate font-mono text-[11px] text-ink-soft">
        {flow.voucherDate ? flow.voucherDate.slice(0, 10) : '--'}
      </span>
      <span className="max-w-[110px] shrink-0 truncate rounded border border-line/50 bg-surface/50 px-1.5 py-px text-[10px] leading-4 text-ink">
        {flow.docType}
      </span>
      <span
        className={clsx(
          'shrink-0 whitespace-nowrap rounded px-1.5 py-px text-[10px]',
          flow.direction === 'in'
            ? 'bg-primary-500/10 text-primary-500'
            : 'bg-surface text-ink-soft',
        )}
      >
        {dirLabel}
      </span>
      <span className="ml-auto shrink-0 font-mono text-[11px] text-ink">
        {formatFlowQuantity(qtyValue, qtyUnit)}
      </span>
    </button>
  )
}

export const SettlementEvidenceCard: React.FC<{
  payload: SettlementEvidencePayload
  /** 免登录分享宿主隐藏登录态复核入口，其余结构化内容照常展示。 */
  readOnly?: boolean
}> = ({ payload, readOnly = false }) => {
  const { contractNo, contract, flows, progress, qualityDocs, pendingQualityDocs, settlements, usage } =
    payload
  const [flowsExpanded, setFlowsExpanded] = useState(false)
  const [detailExpanded, setDetailExpanded] = useState(false)
  const [fieldsOpen, setFieldsOpen] = useState(false)
  const [usageOpen, setUsageOpen] = useState(false)

  const deliveredMain =
    progress.deliveredMassKg !== null
      ? `${fmtTon(progress.deliveredMassKg)} 吨`
      : progress.deliveredCountPools.length > 0
        ? progress.deliveredCountPools.map((p) => `${fmtNum(p.count)} ${p.unit}`).join(' · ')
        : null
  const ratio = progress.progressRatio
  const reasonLabel = progress.reason
    ? (PROGRESS_REASON_LABEL[progress.reason] ?? progress.reason)
    : null
  const contractSubtitle = [
    contract && contract.displayContractNo !== contractNo ? contract.displayContractNo : null,
    contract?.title,
    contract?.contractType,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="rounded-lg border border-line bg-white p-3 mt-2 space-y-3">
      {/* 头部: 合同号 + 台账标题/类型; 台账缺失时红色警示(结算缺少定价依据) */}
      <div className="flex items-start gap-2.5">
        <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
          <Scale className="w-3.5 h-3.5 text-primary" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-ink truncate">结算取证 · {contractNo}</div>
          {contractSubtitle && (
            <div className="text-[11px] text-ink-soft mt-0.5 truncate" title={contractSubtitle}>
              {contractSubtitle}
            </div>
          )}
        </div>
      </div>
      {!contract && (
        <div className="flex items-start gap-1.5 text-xs text-danger bg-danger/5 border border-danger/30 rounded px-2 py-1.5">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span className="leading-relaxed">
            未找到合同台账——缺少定价与条款依据，请先完成合同抽取与绑定，再发起结算取证。
          </span>
        </div>
      )}

      {/* 1. 结算口径摘要: 权威数字 + 口径约束可视化(防止用户逐行累加 flows) */}
      <div>
        <SectionLabel icon={<TrendingUp className="w-3 h-3" />}>结算口径摘要</SectionLabel>
        <div className="mb-1.5 flex items-start gap-1.5 rounded border border-primary/20 bg-primary/5 px-2 py-1.5 text-xs text-ink leading-relaxed">
          <Info className="w-3.5 h-3.5 shrink-0 mt-0.5 text-primary" />
          <span>
            已交付量以节点权威聚合为准：同批货的实重凭证覆盖预告凭证，不重复累计。
            逐行累加下方流水会双计，请勿自行求和。
          </span>
        </div>
        <div className="rounded border border-line/50 bg-surface/50 px-2 py-1.5 space-y-1 text-xs">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <span className="text-ink">
              已交付{' '}
              <span className="font-mono font-medium text-primary-500">
                {deliveredMain ?? '暂无已发生量'}
              </span>
            </span>
            {progress.deliveredMassKg !== null &&
              (progress.actualMassKg !== null || progress.noticeMassKg !== null) && (
                <span
                  className="text-[11px] text-ink-soft"
                  title="节点分层：实重凭证为权威，预告凭证仅在未被实重覆盖时计入"
                >
                  实重凭证 {progress.actualMassKg !== null ? `${fmtTon(progress.actualMassKg)} 吨` : '--'}
                  {' · '}
                  预告凭证 {progress.noticeMassKg !== null ? `${fmtTon(progress.noticeMassKg)} 吨` : '--'}
                </span>
              )}
          </div>
          {progress.deliveredCountPools.length > 0 && (
            <div className="text-ink">
              计数口径{' '}
              <span className="font-mono text-primary-500">
                {progress.deliveredCountPools.map((p) => `${fmtNum(p.count)} ${p.unit}`).join(' · ')}
              </span>
            </div>
          )}
          {progress.basis ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-ink-soft">
                合同基准{' '}
                <span className="font-mono">
                  {fmtNum(progress.basis.quantity)} {progress.basis.unit}
                </span>
              </span>
              {ratio !== null ? (
                <>
                  <span className="h-1 w-24 overflow-hidden rounded-full bg-line" aria-hidden>
                    <span
                      className="block h-full rounded-full bg-primary transition-all duration-500"
                      style={{ width: `${Math.min(100, Math.max(0, ratio) * 100)}%` }}
                    />
                  </span>
                  <span
                    className={clsx(
                      'font-mono text-[11px]',
                      ratio > 1 ? 'text-warning' : 'text-primary-500',
                    )}
                    title={ratio > 1 ? '已超出合同基准数量' : undefined}
                  >
                    {Math.round(ratio * 100)}%
                  </span>
                </>
              ) : (
                reasonLabel && <span className="text-[11px] text-warning">{reasonLabel}</span>
              )}
            </div>
          ) : (
            <div className="text-[11px] text-ink-soft">
              {reasonLabel ?? '合同台账未提供数量基准，无法计算执行进度'}
            </div>
          )}
        </div>
      </div>

      {/* 1.5 运输方式分组(口径透明化, additive): 仅计入口径的流水; 旧结果无
          transportModes 字段 -> 空数组, 区块整体不渲染(回归零差异)。 */}
      {progress.transportModes.length > 0 && (
        <div>
          <SectionLabel icon={<Truck className="w-3 h-3" />}>运输方式分组</SectionLabel>
          <div className="text-[11px] text-ink-soft mb-1.5">仅统计计入口径的流水</div>
          <div className="rounded-md border border-line/60 divide-y divide-line/60">
            {progress.transportModes.map((g) => (
              <TransportModeRow key={g.mode} group={g} />
            ))}
          </div>
        </div>
      )}

      {/* 1.6 口径明细(口径透明化, additive): 每条流水对已交付量的计入/排除
          归类——「已被覆盖」是防双计的正常口径, 不是数据错误。旧结果无
          contributions 字段 -> 空数组, 区块整体不渲染。 */}
      {progress.contributions.length > 0 && (
        <div>
          <SectionLabel icon={<Layers className="w-3 h-3" />}>
            口径明细 (计入 {progress.contributions.filter((c) => c.counted).length} / 共{' '}
            {progress.contributions.length})
          </SectionLabel>
          <div
            className={clsx(
              'rounded-md border border-line/60 divide-y divide-line/60',
              detailExpanded &&
                progress.contributions.length > CONTRIBUTION_COLLAPSE_THRESHOLD &&
                'max-h-72 overflow-y-auto',
            )}
          >
            {(detailExpanded
              ? progress.contributions
              : progress.contributions.slice(0, CONTRIBUTION_COLLAPSE_THRESHOLD)
            ).map((c, i) => (
              <ContributionRow key={c.flowId || `c-${i}`} c={c} />
            ))}
          </div>
          {progress.contributions.length > CONTRIBUTION_COLLAPSE_THRESHOLD && (
            <button
              type="button"
              onClick={() => setDetailExpanded((v) => !v)}
              className="mt-1 text-[11px] text-primary-500 hover:text-primary transition-colors"
            >
              {detailExpanded
                ? '收起明细'
                : `展开全部 ${progress.contributions.length} 行`}
            </button>
          )}
        </div>
      )}

      {/* 2. 执行流水: 逐行可溯源(点击打开该单据的复核弹窗); 长列表折叠+滚动 */}
      <div>
        <SectionLabel icon={<ArrowLeftRight className="w-3 h-3" />}>执行流水 ({flows.length})</SectionLabel>
        <div className="text-[11px] text-ink-soft mb-1.5">
          行内数量为单据原始读数，汇总口径以上方摘要为准，勿直接求和
        </div>
        {flows.length === 0 ? (
          <div className="text-xs text-ink-soft italic">暂无执行流水</div>
        ) : (
          <>
            <div
              className={clsx(
                'rounded-md border border-line/60 divide-y divide-line/60',
                flowsExpanded && flows.length > FLOW_COLLAPSE_THRESHOLD && 'max-h-72 overflow-y-auto',
              )}
            >
              {(flowsExpanded ? flows : flows.slice(0, FLOW_COLLAPSE_THRESHOLD)).map((f) => (
                <FlowListRow key={f.flowId} flow={f} readOnly={readOnly} />
              ))}
            </div>
            {flows.length > FLOW_COLLAPSE_THRESHOLD && (
              <button
                type="button"
                onClick={() => setFlowsExpanded((v) => !v)}
                className="mt-1 text-[11px] text-primary-500 hover:text-primary transition-colors"
              >
                {flowsExpanded ? '收起流水' : `展开全部 ${flows.length} 行`}
              </button>
            )}
          </>
        )}
      </div>

      {/* 3. 质量凭证(仅 confirmed 绑定参与结算): 化验字段摘要 + 复核入口 */}
      <div>
        <SectionLabel icon={<FlaskConical className="w-3 h-3" />}>
          质量凭证 · 已确认绑定 ({qualityDocs.length})
        </SectionLabel>
        {qualityDocs.length === 0 ? (
          <div className="text-xs text-ink-soft italic">暂无已确认绑定的质量凭证</div>
        ) : (
          <div className="space-y-1.5">
            {qualityDocs.map((q) => (
              <div key={q.documentId} className="rounded border border-line/50 bg-surface/50 px-2 py-1.5">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-ink truncate">{q.docType}</span>
                  {!readOnly && (
                    <button
                      type="button"
                      onClick={() => requestOpenReview(q.documentId)}
                      title="打开该质量凭证的复核卡"
                      className="ml-auto shrink-0 cursor-pointer whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-medium text-primary transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                    >
                      复核
                    </button>
                  )}
                </div>
                {q.fields.length > 0 ? (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {q.fields.slice(0, 8).map((fld) => (
                      <span
                        key={fld.name}
                        className="rounded border border-line/50 bg-white/60 px-1.5 py-px text-[10px]"
                      >
                        <span className="text-ink-soft">{fld.name}</span>
                        <span className="ml-1 font-mono text-ink" title={fld.value}>
                          {fld.value}
                        </span>
                      </span>
                    ))}
                    {q.fields.length > 8 && (
                      <span className="text-[10px] text-ink-soft">等 {q.fields.length} 项</span>
                    )}
                  </div>
                ) : (
                  <div className="mt-0.5 text-[11px] text-ink-soft">无化验指标字段</div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 3.5 待确认绑定警示: 确认前不入算(结算端硬门槛) */}
      {pendingQualityDocs.length > 0 && (
        <div className="rounded border border-warning/30 bg-warning/5 px-2 py-1.5">
          <div className="flex items-start gap-1.5 text-xs text-warning">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span className="leading-relaxed">
              {pendingQualityDocs.length}{' '}
              张质量凭证的绑定待确认——确认前不计入质量指标与结算计算。请先确认其与合同的绑定，再重新取证。
            </span>
          </div>
          <div className="mt-1.5 space-y-0.5">
            {pendingQualityDocs.map((d) => (
              <div key={d.documentId} className="flex items-center gap-2 text-[11px]">
                <span className="text-ink">{d.docType}</span>
                {d.confidence !== null && (
                  <span className="font-mono text-ink-soft">
                    置信度 {Math.round(d.confidence * 100)}%
                  </span>
                )}
                {!readOnly && (
                  <button
                    type="button"
                    onClick={() => requestOpenReview(d.documentId)}
                    title="打开该单据的复核卡核对内容"
                    className="ml-auto shrink-0 cursor-pointer whitespace-nowrap text-primary hover:underline"
                  >
                    复核单据
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 4. 历史结算: 已确认的结算台账行(金额锚点) */}
      <div>
        <SectionLabel icon={<History className="w-3 h-3" />}>历史结算 ({settlements.length})</SectionLabel>
        {settlements.length === 0 ? (
          <div className="text-xs text-ink-soft italic">暂无已确认的结算记录</div>
        ) : (
          <div className="rounded-md border border-line/60 divide-y divide-line/60">
            {settlements.map((s) => (
              <div
                key={s.id}
                className="flex items-center gap-2 px-2 py-1.5 text-xs"
                title={s.notes ?? undefined}
              >
                <span className="w-[76px] shrink-0 font-mono text-[11px] text-ink-soft">
                  {s.createdAt ? s.createdAt.slice(0, 10) : '--'}
                </span>
                <span className="shrink-0 font-mono text-ink">
                  {s.settledQuantity !== null
                    ? `${fmtNum(s.settledQuantity)}${s.quantityUnit ? ` ${s.quantityUnit}` : ''}`
                    : '--'}
                </span>
                {s.basePrice !== null && (
                  <span className="shrink-0 text-[11px] text-ink-soft">
                    单价 {fmtNum(s.basePrice)}
                  </span>
                )}
                {s.adjustmentCount > 0 && (
                  <span className="shrink-0 rounded bg-warning/10 px-1 py-px text-[10px] text-warning">
                    含 {s.adjustmentCount} 项调整
                  </span>
                )}
                <span className="ml-auto shrink-0 font-mono font-medium text-ink">
                  {fmtAmount(s.totalAmount, s.currency)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 合同台账字段(定价/条款原文的溯源): 折叠展示 */}
      {contract && contract.fields.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setFieldsOpen((v) => !v)}
            aria-expanded={fieldsOpen}
            className="flex w-full items-center gap-1.5 text-ink-soft cursor-pointer select-none"
          >
            <ChevronDown
              className={clsx('w-3 h-3 shrink-0 transition-transform', fieldsOpen && 'rotate-180')}
            />
            <span className="text-[11px] font-medium tracking-wide">
              合同台账字段 ({contract.fields.length})
            </span>
          </button>
          {fieldsOpen && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {contract.fields.map((f) => (
                <span
                  key={f.name}
                  className="rounded border border-line/50 bg-surface/50 px-1.5 py-px text-[10px]"
                >
                  <span className="text-ink-soft">{f.name}</span>
                  <span className="ml-1 font-mono text-ink" title={f.value}>
                    {f.value}
                  </span>
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 口径说明(usage 原文): 折叠呈现, 展开保留原文 */}
      {usage && (
        <div className="pt-3 border-t border-line">
          <button
            type="button"
            onClick={() => setUsageOpen((v) => !v)}
            aria-expanded={usageOpen}
            className="flex items-center gap-1.5 text-ink-soft cursor-pointer select-none"
          >
            <Info className="w-3 h-3 shrink-0" />
            <span className="text-[11px] font-medium tracking-wide">结算口径说明</span>
            <ChevronDown
              className={clsx('w-3 h-3 shrink-0 transition-transform', usageOpen && 'rotate-180')}
            />
          </button>
          {usageOpen && (
            <div className="mt-1.5 text-[11px] text-ink-soft leading-relaxed whitespace-pre-wrap break-words">
              {usage}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default SettlementEvidenceCard
