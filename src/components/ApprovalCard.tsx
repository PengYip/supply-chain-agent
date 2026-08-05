import React, { useState } from 'react'
import { CheckCircle2, AlertCircle, XCircle, ArrowRightLeft, Clock, ShieldCheck, UserCheck, Shield } from 'lucide-react'
import { type ApprovalDetail } from '../data/mock'
import { Button } from './ui/Card'
import { ToolTagList } from './ui/ToolTag'
import clsx from 'clsx'

interface ApprovalCardProps {
  detail: ApprovalDetail
  tools?: string[]
  onClose?: () => void
  variant?: 'interactive' | 'readonly'
}

const confirmLabel = (detail: ApprovalDetail): string => {
  const purpose = detail.purpose || ''
  const amountText = `¥${(detail.amount / 10000).toFixed(0)} 万`
  if (purpose.includes('挂接')) return `确认挂接`
  if (purpose.includes('退款')) return `确认退款 ${amountText}`
  return `确认付款 ${amountText}`
}

export const ApprovalCard: React.FC<ApprovalCardProps> = ({ detail, tools = [], onClose, variant = 'interactive' }) => {
  const [confirmed, setConfirmed] = useState(false)
  const [comment, setComment] = useState('')
  const [submitted, setSubmitted] = useState<'idle' | 'approved' | 'rejected' | 'transferred'>('idle')

  const handleApprove = () => {
    if (!confirmed) return
    setSubmitted('approved')
    setTimeout(() => onClose?.(), 900)
  }

  const handleReject = () => {
    setSubmitted('rejected')
    setTimeout(() => onClose?.(), 900)
  }

  const handleTransfer = () => {
    setSubmitted('transferred')
    setTimeout(() => onClose?.(), 900)
  }

  if (submitted !== 'idle') {
    return (
      <div className="rounded-lg border border-borderGray bg-white p-6 text-center animate-fade-in">
        <CheckCircle2 className={clsx(
          'w-10 h-10 mx-auto mb-3',
          submitted === 'approved' ? 'text-success' : submitted === 'rejected' ? 'text-danger' : 'text-steelBlue'
        )} />
        <div className="text-base font-medium text-textDark">
          {submitted === 'approved' ? '审批已通过' : submitted === 'rejected' ? '审批已拒绝' : '已转交处理'}
        </div>
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-borderGray bg-white overflow-hidden">
      <div className="px-3 py-2 border-b border-borderGray bg-deepSea/5 flex items-center gap-2">
        <ShieldCheck className="w-4 h-4 text-steelBlue" />
        <span className="text-sm font-medium text-textDark">{detail.purpose || '付款审批确认'}</span>
        <span className="ml-auto text-xs px-1.5 py-0.5 rounded bg-danger/10 text-danger">高风险</span>
      </div>
      <div className="p-4 space-y-4">
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <div className="text-xs text-textGray">合同编号</div>
            <div className="font-mono text-textDark mt-0.5">{detail.contractNo}</div>
          </div>
          <div>
            <div className="text-xs text-textGray">收款方</div>
            <div className="text-textDark mt-0.5">{detail.payee}</div>
          </div>
          <div>
            <div className="text-xs text-textGray">付款金额</div>
            <div className="font-mono text-lg font-bold text-danger mt-0.5">{(detail.amount / 10000).toFixed(0)} 万元</div>
          </div>
          <div>
            <div className="text-xs text-textGray">付款方式</div>
            <div className="text-textDark mt-0.5">{detail.payMethod}</div>
          </div>
          <div>
            <div className="text-xs text-textGray">账户尾号</div>
            <div className="font-mono text-textDark mt-0.5">{detail.accountTail}</div>
          </div>
          {detail.purpose && (
            <div>
              <div className="text-xs text-textGray">用途</div>
              <div className="text-textDark mt-0.5">{detail.purpose}</div>
            </div>
          )}
        </div>

        <div className="rounded-lg border border-borderGray bg-bgGray p-3">
          <div className="text-xs text-textGray mb-2">AI 校验结果</div>
          <div className="space-y-2">
            {detail.checks.map((check, idx) => (
              <div key={idx} className="flex items-start gap-2 text-sm">
                {check.ok ? (
                  <CheckCircle2 className="w-4 h-4 text-success shrink-0 mt-0.5" />
                ) : check.warn ? (
                  <AlertCircle className="w-4 h-4 text-warning shrink-0 mt-0.5" />
                ) : (
                  <XCircle className="w-4 h-4 text-danger shrink-0 mt-0.5" />
                )}
                <span className={clsx(check.warn ? 'text-warning' : check.ok ? 'text-textDark' : 'text-danger')}>
                  {check.label}
                </span>
              </div>
            ))}
          </div>
        </div>

        {tools.length > 0 && (
          <div className="flex items-center gap-2 pt-1">
            <span className="text-[11px] text-textGray">涉及工具：</span>
            <ToolTagList tools={tools} needsApproval />
          </div>
        )}

        {detail.dutyNote && (
          <div className="flex items-start gap-2 p-2.5 rounded-lg bg-steelBlue/10 border border-steelBlue/20 text-xs text-steelBlue">
            <UserCheck className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{detail.dutyNote}</span>
          </div>
        )}

        {variant === 'interactive' && (
          <>
            <div>
              <label className="block text-xs text-textGray mb-1">审批意见</label>
              <textarea
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="请输入审批意见..."
                className="w-full h-20 p-2 rounded border border-borderGray text-sm focus:outline-none focus:border-steelBlue resize-none"
              />
            </div>

            <div className="flex items-start gap-2 p-2 rounded bg-warning/10 border border-warning/20 text-sm">
              <input
                id="confirm"
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
                className="w-4 h-4 accent-amber mt-0.5"
              />
              <label htmlFor="confirm" className="text-warning cursor-pointer text-sm">
                我已核对金额与收款账户，确认本次付款
              </label>
            </div>

            <div className="flex items-center gap-2 pt-1">
              <Button variant="primary" disabled={!confirmed} onClick={handleApprove}>
                {confirmLabel(detail)}
              </Button>
              <Button variant="danger" onClick={handleReject}>
                拒绝
              </Button>
              <Button variant="secondary" onClick={handleTransfer}>
                <ArrowRightLeft className="w-4 h-4 mr-1" />
                转交
              </Button>
              <Button variant="ghost" onClick={onClose}>
                <Clock className="w-4 h-4 mr-1" />
                稍后处理
              </Button>
            </div>
            <div className="flex items-start gap-1.5 text-[11px] text-textGray pt-1">
              <Shield className="w-3 h-3 shrink-0 mt-0.5" />
              此操作将记录在审计日志中，供后续合规审计与责任追溯。
            </div>
          </>
        )}
      </div>
    </div>
  )
}
