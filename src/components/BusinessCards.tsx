import React, { useState } from 'react'
import {
  FileText,
  Package,
  DollarSign,
  MapPin,
  Calendar,
  CheckCircle2,
  AlertCircle,
  Clock,
  ArrowRight,
  Link2,
  Edit3,
  RotateCcw,
  Check,
  X,
  ScanLine,
  Minus,
} from 'lucide-react'
import {
  DEFAULT_CONTRACT_SUMMARY,
  HITL_CONTRACT_SUMMARY,
  MOCK_ORDERS,
  HITL_ORDERS,
  HITL_OCR_FIELDS,
  MOCK_DOCUMENT_FIELDS,
  CURRENT_BL_NO,
} from '../data/mock'
import type { ArtifactReference, OCRFieldRow } from '../data/mock'
import clsx from 'clsx'

interface ContractCardProps {
  variant?: 'default' | 'hitl'
}

export const ContractCard: React.FC<ContractCardProps> = ({ variant = 'default' }) => {
  const c = variant === 'hitl' ? HITL_CONTRACT_SUMMARY : DEFAULT_CONTRACT_SUMMARY
  const unavailable = (c as unknown as { unavailable?: { label: string; reason: string; tool?: string }[] }).unavailable || []
  return (
    <div className="rounded-lg border border-borderGray bg-white overflow-hidden">
      <div className="px-3 py-2 border-b border-borderGray bg-deepSea/5 flex items-center gap-2">
        <FileText className="w-4 h-4 text-steelBlue" />
        <span className="text-sm font-medium text-textDark">合同执行摘要</span>
        <span className="ml-auto text-xs px-1.5 py-0.5 rounded bg-success/10 text-success">{c.status}</span>
      </div>
      <div className="p-3 grid grid-cols-2 gap-3 text-sm">
        <div>
          <div className="text-xs text-textGray">合同编号</div>
          <div className="font-mono font-medium text-textDark mt-0.5">{c.no}</div>
        </div>
        <div>
          <div className="text-xs text-textGray">签约日期</div>
          <div className="font-medium text-textDark mt-0.5 flex items-center gap-1">
            <Calendar className="w-3 h-3 text-textGray" /> {c.date}
          </div>
        </div>
        <div>
          <div className="text-xs text-textGray">甲方</div>
          <div className="font-medium text-textDark mt-0.5">{c.partyA}</div>
        </div>
        <div>
          <div className="text-xs text-textGray">乙方</div>
          <div className="font-medium text-textDark mt-0.5">{c.partyB}</div>
        </div>
        <div>
          <div className="text-xs text-textGray">货物</div>
          <div className="font-medium text-textDark mt-0.5">{c.goods}</div>
        </div>
        <div>
          <div className="text-xs text-textGray">数量</div>
          <div className="font-medium text-textDark mt-0.5">{c.quantity.toLocaleString()} {c.unit}</div>
        </div>
        <div>
          <div className="text-xs text-textGray">单价</div>
          <div className="font-medium text-textDark mt-0.5">{c.price.toLocaleString()} 元/吨</div>
        </div>
        <div>
          <div className="text-xs text-textGray">总金额</div>
          <div className="font-mono font-medium text-textDark mt-0.5">{c.amount.toLocaleString()} 元</div>
        </div>
        <div className="col-span-2">
          <div className="text-xs text-textGray">交货地 / 付款方式</div>
          <div className="font-medium text-textDark mt-0.5 flex items-center gap-3">
            <span className="flex items-center gap-1"><MapPin className="w-3 h-3 text-textGray" /> {c.delivery}</span>
            <span className="flex items-center gap-1"><DollarSign className="w-3 h-3 text-textGray" /> {c.payMethod}</span>
          </div>
        </div>
      </div>
      {unavailable.length > 0 && (
        <div className="px-3 py-2 border-t border-borderGray bg-bgGray">
          <div className="text-[11px] text-textGray mb-1.5 flex items-center gap-1">
            <Minus className="w-3 h-3" /> 以下字段暂不可获取
          </div>
          <div className="grid grid-cols-2 gap-2">
            {unavailable.map((item) => (
              <div key={item.label} className="text-xs">
                <span className="text-textGray">{item.label}：</span>
                <span className="text-textGray/80 font-mono">—</span>
                <div className="text-[10px] text-textGray/60 mt-0.5">({item.tool || item.reason})</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

interface OrderTimelineProps {
  variant?: 'default' | 'hitl'
}

export const OrderTimeline: React.FC<OrderTimelineProps> = ({ variant = 'default' }) => {
  const orders = variant === 'hitl' ? HITL_ORDERS : MOCK_ORDERS
  return (
    <div className="rounded-lg border border-borderGray bg-white overflow-hidden">
      <div className="px-3 py-2 border-b border-borderGray bg-deepSea/5 flex items-center gap-2">
        <Package className="w-4 h-4 text-steelBlue" />
        <span className="text-sm font-medium text-textDark">订单执行时间线</span>
      </div>
      <div className="p-3 space-y-3">
        {orders.map((order, idx) => (
          <div key={order.id} className="flex items-start gap-3">
            <div className="relative flex flex-col items-center">
              <div className={clsx(
                'w-2.5 h-2.5 rounded-full border-2 border-white',
                order.status === '已完成' ? 'bg-success' : order.status === '已发货' ? 'bg-steelBlue' : 'bg-warning'
              )} />
              {idx !== orders.length - 1 && <div className="w-px flex-1 min-h-[24px] bg-borderGray mt-1" />}
            </div>
            <div className="flex-1 pb-2">
              <div className="flex items-center justify-between">
                <span className="font-mono text-sm font-medium text-textDark">{order.id}</span>
                <span className={clsx(
                  'text-xs px-1.5 py-0.5 rounded',
                  order.status === '已完成' ? 'bg-success/10 text-success'
                  : order.status === '已发货' ? 'bg-steelBlue/10 text-steelBlue'
                  : 'bg-warning/10 text-warning'
                )}>{order.status}</span>
              </div>
              <div className="text-xs text-textGray mt-0.5">
                {order.customer} · {order.product} · {order.quantity.toLocaleString()} {order.unit}
              </div>
              <div className="text-xs text-textGray mt-0.5 flex items-center gap-1">
                <Clock className="w-3 h-3" /> {order.updateTime}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export const ReconciliationDiff: React.FC<{ payload?: unknown }> = ({ payload }) => {
  const data = (payload as { rows?: { item: string; erp: string; finance: string; diff: string; status: string }[]; summary?: string } | undefined)?.rows || []
  const summary = (payload as { summary?: string } | undefined)?.summary || ''
  return (
    <div className="rounded-lg border border-borderGray bg-white overflow-hidden">
      <div className="px-3 py-2 border-b border-borderGray bg-deepSea/5 flex items-center gap-2">
        <DollarSign className="w-4 h-4 text-steelBlue" />
        <span className="text-sm font-medium text-textDark">对账草稿</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-bgGray text-textGray">
            <tr>
              <th className="text-left px-3 py-2 font-medium">对账项</th>
              <th className="text-left px-3 py-2 font-medium">ERP</th>
              <th className="text-left px-3 py-2 font-medium">财务</th>
              <th className="text-right px-3 py-2 font-medium">差异</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-borderGray">
            {data.map((row, idx) => (
              <tr key={idx} className="hover:bg-bgGray/50">
                <td className="px-3 py-2 text-textDark">{row.item}</td>
                <td className="px-3 py-2 font-mono text-textGray">{row.erp}</td>
                <td className="px-3 py-2 font-mono text-textGray">{row.finance}</td>
                <td className="px-3 py-2 text-right font-mono">
                  <span className={clsx(
                    row.status === 'ok' ? 'text-success' : 'text-warning'
                  )}>{row.diff}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {summary && (
        <div className="px-3 py-2 border-t border-borderGray text-xs text-warning flex items-start gap-1.5">
          <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          {summary}
        </div>
      )}
    </div>
  )
}

export const LinkedDocuments: React.FC = () => {
  return (
    <div className="rounded-lg border border-borderGray bg-white overflow-hidden">
      <div className="px-3 py-2 border-b border-borderGray bg-deepSea/5 flex items-center gap-2">
        <Link2 className="w-4 h-4 text-steelBlue" />
        <span className="text-sm font-medium text-textDark">已挂接单据</span>
      </div>
      <div className="p-3 space-y-2">
        <div className="flex items-center justify-between text-sm">
          <div className="flex items-center gap-2">
            <FileText className="w-4 h-4 text-steelBlue" />
            <span className="text-textDark">合同 HT-2024.pdf</span>
          </div>
          <button className="text-xs text-steelBlue hover:text-deepSea">查看原件</button>
        </div>
        <div className="flex items-center justify-between text-sm">
          <div className="flex items-center gap-2">
            <FileText className="w-4 h-4 text-success" />
            <span className="text-textDark">提单 {CURRENT_BL_NO}</span>
          </div>
          <span className="text-xs text-success flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> 已挂接</span>
        </div>
        <div className="flex items-center justify-between text-sm">
          <div className="flex items-center gap-2">
            <FileText className="w-4 h-4 text-steelBlue" />
            <span className="text-textDark">发票 FP-202408</span>
          </div>
          <button className="text-xs text-steelBlue hover:text-deepSea">查看原件</button>
        </div>
      </div>
    </div>
  )
}

export const FieldConfidenceList: React.FC = () => {
  return (
    <div className="rounded-lg border border-borderGray bg-white overflow-hidden">
      <div className="px-3 py-2 border-b border-borderGray bg-deepSea/5 flex items-center gap-2">
        <CheckCircle2 className="w-4 h-4 text-steelBlue" />
        <span className="text-sm font-medium text-textDark">OCR 字段置信度</span>
      </div>
      <div className="p-3 grid grid-cols-2 gap-2">
        {MOCK_DOCUMENT_FIELDS.slice(0, 6).map((field) => (
          <div key={field.key} className="flex items-center justify-between text-xs">
            <span className="text-textGray">{field.label}</span>
            <span className="flex items-center gap-1">
              <span className={clsx(
                'w-1.5 h-1.5 rounded-full',
                field.confidence === 'high' ? 'bg-success' : field.confidence === 'medium' ? 'bg-warning' : 'bg-danger'
              )} />
              <span className="text-textDark">{field.value}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

interface OCRFieldCheckCardProps {
  rows?: OCRFieldRow[]
}

export const OCRFieldCheckCard: React.FC<OCRFieldCheckCardProps> = ({ rows = HITL_OCR_FIELDS }) => {
  const [fields, setFields] = useState(rows)
  const [manualEdit, setManualEdit] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')

  const handleConfirm = (key: string, value: string) => {
    setFields((prev) => prev.map((f) => (f.key === key ? { ...f, extractedValue: value, correctValue: value, status: 'auto' as const } : f)))
  }

  const handleReOCR = (key: string) => {
    setFields((prev) => prev.map((f) => (f.key === key ? { ...f, extractedValue: '4950 吨', confidence: 0.94, status: 'auto' as const } : f)))
  }

  return (
    <div className="rounded-lg border border-borderGray bg-white overflow-hidden">
      <div className="px-3 py-2 border-b border-borderGray bg-deepSea/5 flex items-center gap-2">
        <ScanLine className="w-4 h-4 text-steelBlue" />
        <span className="text-sm font-medium text-textDark">提单 BL-20240815-001 字段核验</span>
      </div>
      <div className="p-0">
        <table className="w-full text-xs">
          <thead className="bg-bgGray text-textGray">
            <tr>
              <th className="text-left px-3 py-2 font-medium">字段</th>
              <th className="text-left px-3 py-2 font-medium">OCR 抽取值</th>
              <th className="text-left px-3 py-2 font-medium">置信度</th>
              <th className="text-right px-3 py-2 font-medium">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-borderGray">
            {fields.map((field) => (
              <tr key={field.key} className="hover:bg-bgGray/30">
                <td className="px-3 py-2 text-textDark font-medium">{field.label}</td>
                <td className="px-3 py-2 text-textDark">
                  {field.status === 'manual' && field.correctValue ? (
                    <span className="line-through text-textGray mr-1">{field.extractedValue}</span>
                  ) : null}
                  <span className={field.status === 'manual' ? 'text-warning' : ''}>{field.correctValue || field.extractedValue}</span>
                </td>
                <td className="px-3 py-2">
                  <span className={clsx(
                    'px-1.5 py-0.5 rounded-full text-[10px]',
                    field.confidence >= 0.9 ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning'
                  )}>
                    {(field.confidence * 100).toFixed(0)}%
                  </span>
                </td>
                <td className="px-3 py-2 text-right">
                  {field.status === 'auto' ? (
                    <span className="inline-flex items-center gap-1 text-success text-[10px]">
                      <CheckCircle2 className="w-3 h-3" /> 自动接受
                    </span>
                  ) : field.status === 'manual' ? (
                    <div className="flex items-center justify-end gap-1">
                      {manualEdit === field.key ? (
                        <>
                          <input
                            type="text"
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            className="w-16 px-1 py-0.5 border border-borderGray rounded text-[10px]"
                            onKeyDown={(e) => e.key === 'Enter' && handleConfirm(field.key, editValue)}
                          />
                          <button onClick={() => handleConfirm(field.key, editValue)} className="p-0.5 rounded hover:bg-bgGray text-success"><Check className="w-3 h-3" /></button>
                          <button onClick={() => setManualEdit(null)} className="p-0.5 rounded hover:bg-bgGray text-textGray"><X className="w-3 h-3" /></button>
                        </>
                      ) : (
                        <>
                          <button
                            onClick={() => {
                              setEditValue(field.correctValue || field.extractedValue)
                              setManualEdit(field.key)
                            }}
                            className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-steelBlue/10 text-steelBlue hover:bg-steelBlue/20"
                          >
                            <Edit3 className="w-3 h-3" /> 修正
                          </button>
                          <button onClick={() => handleConfirm(field.key, '4950 吨')} className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-success/10 text-success hover:bg-success/20">
                            <Check className="w-3 h-3" /> 4950
                          </button>
                          <button onClick={() => handleReOCR(field.key)} className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-warning/10 text-warning hover:bg-warning/20">
                            <RotateCcw className="w-3 h-3" /> OCR
                          </button>
                        </>
                      )}
                    </div>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-danger text-[10px]">
                      <AlertCircle className="w-3 h-3" /> 识别失败
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="px-3 py-2 border-t border-borderGray bg-bgGray text-[10px] text-textGray">
        黄色字段为置信度低于 0.9 或格式异常，需人工确认后方可落库。
      </div>
    </div>
  )
}

export const ArtifactRenderer: React.FC<{ artifact: ArtifactReference }> = ({ artifact }) => {
  if (artifact.type === 'contract_summary') return <ContractCard variant={artifact.payload === 'hitl-contract' ? 'hitl' : 'default'} />
  if (artifact.type === 'order_status') return <OrderTimeline variant={artifact.payload === 'hitl-orders' ? 'hitl' : 'default'} />
  if (artifact.type === 'reconciliation') return <ReconciliationDiff payload={artifact.payload} />
  if (artifact.type === 'reconciliation_draft') return <ReconciliationDiff payload={artifact.payload} />
  if (artifact.type === 'linked_documents') return (
    <div className="space-y-3">
      <LinkedDocuments />
      <FieldConfidenceList />
    </div>
  )
  if (artifact.type === 'ocr_field_check') return <OCRFieldCheckCard />
  return null
}

export const BusinessObjectPreview: React.FC<{ type: string; businessNo: string }> = ({ type, businessNo }) => {
  return (
    <div className="flex items-center gap-2 text-sm text-textGray">
      <span className="px-1.5 py-0.5 rounded bg-steelBlue/10 text-steelBlue text-xs font-medium">
        {type === 'contract' ? '合同' : type === 'order' ? '订单' : type === 'settlement' ? '对账' : '单据'}
      </span>
      <span className="font-mono text-textDark">{businessNo}</span>
      <ArrowRight className="w-3 h-3 text-textGray" />
      <span className="text-xs">已绑定</span>
    </div>
  )
}
