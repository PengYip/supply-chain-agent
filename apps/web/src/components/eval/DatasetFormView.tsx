// apps/web/src/components/eval/DatasetFormView.tsx
// 双模式数据集编辑器的表单视图: 场景手风琴 + 五个分节 (基本/Persona/审批策略/Verifiers/Rubric)。
// 表单组件只经 yamlFormBridge 接触 yaml 库; text 为共享 YAML 文本单一真源。
import { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { ChevronDown, ChevronRight, Plus, X } from 'lucide-react'
import type { Document } from 'yaml'
import {
  parseDatasetYaml, getIn, setIn, appendListItem, removeListItem, docToText, getAnchorKeyPath,
} from './yamlFormBridge'

const inputCls = 'rounded border border-borderGray bg-white px-2 py-1 text-sm text-textDark disabled:opacity-50 disabled:bg-bgGray'
const textareaCls = 'w-full rounded border border-borderGray bg-white px-2 py-1 text-sm text-textDark disabled:opacity-50 disabled:bg-bgGray'
const btnCls = 'inline-flex items-center gap-1 rounded border border-borderGray bg-white px-2 py-1 text-xs text-textGray hover:text-deepSea disabled:opacity-50'

// ---- 读取助手: yaml v2 的 getIn 对集合路径返回 YAMLSeq/YAMLMap 节点, 需 toJS(doc) 转普通数组 ----
function readList(doc: Document, path: (string | number)[]): unknown[] {
  const v = getIn(doc, path)
  if (Array.isArray(v)) return v
  const node = v as { toJS?: (d: unknown) => unknown } | null
  if (node && typeof node.toJS === 'function') {
    const js = node.toJS(doc)
    return Array.isArray(js) ? js : []
  }
  return []
}

function readStr(doc: Document, path: (string | number)[], fallback = ''): string {
  const v = getIn(doc, path)
  return typeof v === 'string' ? v : fallback
}

function readNumStr(doc: Document, path: (string | number)[]): string {
  const v = getIn(doc, path)
  return typeof v === 'number' ? String(v) : ''
}

const OPS = ['>', '<', '>=', '<=', '==', '!='] as const
const ANCHORS: Array<[string, string]> = [
  ['4', '4 档(优秀)'],
  ['3', '3 档(良好)'],
  ['2', '2 档(合格)'],
  ['1', '1 档(不合格)'],
]

// 数值输入: 失焦 coerce, NaN 或 <min 回退显示原值不写回。
function CoerceNumberInput({ value, onCommit, readOnly, min, className }: {
  value: string
  onCommit: (n: number) => void
  readOnly: boolean
  min?: number
  className?: string
}) {
  const [local, setLocal] = useState(value)
  useEffect(() => setLocal(value), [value])
  return (
    <input
      type="number"
      value={local}
      disabled={readOnly}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={() => {
        if (local.trim() === '') { setLocal(value); return }
        const n = Number(local)
        if (Number.isNaN(n) || (min != null && n < min)) { setLocal(value); return }
        onCommit(n)
      }}
      className={className ?? inputCls}
    />
  )
}

// 字符串标签组 (capability / mustAppear / forbidden / keywordInReply): 标签 + 增删。
function TagGroup({ doc, path, readOnly, onChange, label, placeholder }: {
  doc: Document
  path: (string | number)[]
  readOnly: boolean
  onChange: () => void
  label: string
  placeholder?: string
}) {
  const [input, setInput] = useState('')
  const items = readList(doc, path)
  const add = () => {
    const v = input.trim()
    if (!v) return
    appendListItem(doc, path, v)
    setInput('')
    onChange()
  }
  return (
    <div>
      <div className="text-xs text-textGray mb-1">{label}</div>
      <div className="flex flex-wrap gap-1.5 mb-1.5">
        {items.map((it, i) => (
          <span key={i} className="inline-flex items-center gap-1 rounded bg-bgGray border border-borderGray px-1.5 py-0.5 text-xs text-textDark">
            {String(it)}
            {!readOnly && (
              <button type="button" aria-label="移除" onClick={() => { removeListItem(doc, path, i); onChange() }}
                className="text-textGray hover:text-danger">
                <X className="h-3 w-3" aria-hidden />
              </button>
            )}
          </span>
        ))}
      </div>
      {!readOnly && (
        <div className="flex gap-1.5">
          <input value={input} onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add() } }}
            placeholder={placeholder ?? '输入后回车或点添加'} className={inputCls} />
          <button type="button" onClick={add} className={btnCls}><Plus className="h-3 w-3" aria-hidden /> 添加</button>
        </div>
      )}
    </div>
  )
}

// 字符串条目列表 (persona.facts): 每条 text 输入 + 删, 底部添加。
function StringListField({ doc, path, readOnly, onChange, label, placeholder }: {
  doc: Document
  path: (string | number)[]
  readOnly: boolean
  onChange: () => void
  label: string
  placeholder?: string
}) {
  const [input, setInput] = useState('')
  const items = readList(doc, path)
  const add = () => {
    const v = input.trim()
    if (!v) return
    appendListItem(doc, path, v)
    setInput('')
    onChange()
  }
  return (
    <div>
      <div className="text-xs text-textGray mb-1">{label}</div>
      <div className="space-y-1.5">
        {items.map((it, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <input value={String(it)} disabled={readOnly}
              onChange={(e) => { setIn(doc, [...path, i], e.target.value); onChange() }}
              placeholder={placeholder} className={clsx(inputCls, 'flex-1')} />
            {!readOnly && (
              <button type="button" aria-label="删除" onClick={() => { removeListItem(doc, path, i); onChange() }}
                className="text-textGray hover:text-danger">
                <X className="h-3.5 w-3.5" aria-hidden />
              </button>
            )}
          </div>
        ))}
      </div>
      {!readOnly && (
        <div className="flex gap-1.5 mt-1.5">
          <input value={input} onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add() } }}
            placeholder={placeholder ?? '新增一条'} className={clsx(inputCls, 'flex-1')} />
          <button type="button" onClick={add} className={btnCls}><Plus className="h-3 w-3" aria-hidden /> 添加</button>
        </div>
      )}
    </div>
  )
}

// 结构化行表格 (verifiers 的 payments/paymentsAbsent/contractLinked, 审批 rules 复用)。
function RowsTable({ doc, path, readOnly, onChange, columns, newRow }: {
  doc: Document
  path: (string | number)[]
  readOnly: boolean
  onChange: () => void
  columns: Array<{ key: string; label: string; number?: boolean; options?: string[] }>
  newRow: Record<string, unknown>
}) {
  const rows = readList(doc, path)
  return (
    <div>
      <div className="rounded border border-borderGray overflow-x-auto mb-1.5">
        <table className="w-full text-xs">
          <thead className="bg-bgGray text-left text-textGray">
            <tr>
              {columns.map((c) => <th key={c.key} className="px-2 py-1 font-medium">{c.label}</th>)}
              {!readOnly && <th className="px-2 py-1 w-8" />}
            </tr>
          </thead>
          <tbody>
            {rows.map((_, r) => (
              <tr key={r} className="border-t border-borderGray">
                {columns.map((c) => (
                  <td key={c.key} className="px-2 py-1">
                    {c.options ? (
                      <select value={readStr(doc, [...path, r, c.key])} disabled={readOnly}
                        onChange={(e) => { setIn(doc, [...path, r, c.key], e.target.value); onChange() }}
                        className={clsx(inputCls, 'w-full')}>
                        {c.options.map((o) => <option key={o} value={o}>{o}</option>)}
                      </select>
                    ) : c.number ? (
                      <CoerceNumberInput value={readNumStr(doc, [...path, r, c.key])}
                        onCommit={(n) => { setIn(doc, [...path, r, c.key], n); onChange() }}
                        readOnly={readOnly} />
                    ) : (
                      <input value={readStr(doc, [...path, r, c.key])} disabled={readOnly}
                        onChange={(e) => { setIn(doc, [...path, r, c.key], e.target.value); onChange() }}
                        className={clsx(inputCls, 'w-full')} />
                    )}
                  </td>
                ))}
                {!readOnly && (
                  <td className="px-2 py-1">
                    <button type="button" aria-label="删除行" onClick={() => { removeListItem(doc, path, r); onChange() }}
                      className="text-textGray hover:text-danger">
                      <X className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!readOnly && (
        <button type="button" onClick={() => { appendListItem(doc, path, newRow); onChange() }} className={btnCls}>
          <Plus className="h-3 w-3" aria-hidden /> 添加行
        </button>
      )}
    </div>
  )
}

// ---- 分节 ----

function BasicSection({ doc, index, readOnly, onChange }: { doc: Document; index: number; readOnly: boolean; onChange: () => void }) {
  const base = ['scenarios', index] as (string | number)[]
  return (
    <section className="space-y-3">
      <div className="text-xs font-medium text-textGray">基本</div>
      <div className="flex items-center gap-2 flex-wrap">
        <input value={readStr(doc, [...base, 'id'])} disabled={readOnly}
          onChange={(e) => { setIn(doc, [...base, 'id'], e.target.value); onChange() }}
          placeholder="id" className={clsx(inputCls, 'w-56 font-mono')} />
        <select value={readNumStr(doc, [...base, 'tier'])} disabled={readOnly}
          onChange={(e) => { setIn(doc, [...base, 'tier'], Number(e.target.value)); onChange() }}
          className={inputCls}>
          <option value="" disabled>tier</option>
          <option value="1">Tier 1</option>
          <option value="2">Tier 2</option>
          <option value="3">Tier 3</option>
        </select>
        <label className="flex items-center gap-1.5 text-xs text-textGray">
          maxTurns
          <CoerceNumberInput value={readNumStr(doc, [...base, 'maxTurns'])} min={1}
            onCommit={(n) => { setIn(doc, [...base, 'maxTurns'], n); onChange() }}
            readOnly={readOnly} className={clsx(inputCls, 'w-20')} />
        </label>
      </div>
      <TagGroup doc={doc} path={[...base, 'capability']} readOnly={readOnly} onChange={onChange} label="capability" />
    </section>
  )
}

function PersonaSection({ doc, index, readOnly, onChange }: { doc: Document; index: number; readOnly: boolean; onChange: () => void }) {
  const base = ['scenarios', index, 'persona'] as (string | number)[]
  return (
    <section className="space-y-3">
      <div className="text-xs font-medium text-textGray">Persona</div>
      <StringListField doc={doc} path={[...base, 'facts']} readOnly={readOnly} onChange={onChange} label="facts" />
      <div>
        <div className="text-xs text-textGray mb-1">disclosure</div>
        <textarea rows={3} value={readStr(doc, [...base, 'disclosure'])} disabled={readOnly}
          onChange={(e) => { setIn(doc, [...base, 'disclosure'], e.target.value); onChange() }}
          className={textareaCls} />
      </div>
      <div>
        <div className="text-xs text-textGray mb-1">goal</div>
        <textarea rows={4} value={readStr(doc, [...base, 'goal'])} disabled={readOnly}
          onChange={(e) => { setIn(doc, [...base, 'goal'], e.target.value); onChange() }}
          className={textareaCls} />
      </div>
      <label className="flex items-center gap-1.5 text-xs text-textGray">
        patience
        <CoerceNumberInput value={readNumStr(doc, [...base, 'patience'])} min={1}
          onCommit={(n) => { setIn(doc, [...base, 'patience'], n); onChange() }}
          readOnly={readOnly} className={clsx(inputCls, 'w-20')} />
      </label>
    </section>
  )
}

function ApprovalSection({ doc, index, readOnly, onChange }: { doc: Document; index: number; readOnly: boolean; onChange: () => void }) {
  const base = ['scenarios', index, 'approvalPolicy'] as (string | number)[]
  return (
    <section className="space-y-3">
      <div className="text-xs font-medium text-textGray">审批策略</div>
      <label className="flex items-center gap-1.5 text-xs text-textGray">
        default
        <select value={readStr(doc, [...base, 'default'], 'approve')} disabled={readOnly}
          onChange={(e) => { setIn(doc, [...base, 'default'], e.target.value); onChange() }}
          className={inputCls}>
          <option value="approve">approve</option>
          <option value="reject">reject</option>
        </select>
      </label>
      <div>
        <div className="text-xs text-textGray mb-1">rules</div>
        <RowsTable
          doc={doc}
          path={[...base, 'rules']}
          readOnly={readOnly}
          onChange={onChange}
          columns={[
            { key: 'tool', label: 'tool' },
            { key: 'ifField', label: 'ifField' },
            { key: 'op', label: 'op', options: [...OPS] },
            { key: 'value', label: 'value', number: true },
            { key: 'action', label: 'action', options: ['approve', 'reject'] },
          ]}
          newRow={{ tool: 'bind_document', ifField: 'contractNo', op: '==', value: 'HT-2024-001', action: 'approve' }}
        />
      </div>
    </section>
  )
}

function VerifiersSection({ doc, index, readOnly, onChange }: { doc: Document; index: number; readOnly: boolean; onChange: () => void }) {
  const base = ['scenarios', index, 'verifiers'] as (string | number)[]
  return (
    <section className="space-y-3">
      <div className="text-xs font-medium text-textGray">Verifiers</div>
      <div>
        <div className="text-xs text-textGray mb-1">payments</div>
        <RowsTable doc={doc} path={[...base, 'payments']} readOnly={readOnly} onChange={onChange}
          columns={[{ key: 'contractNo', label: 'contractNo' }, { key: 'amount', label: 'amount', number: true }]}
          newRow={{ contractNo: '', amount: 0 }} />
      </div>
      <div>
        <div className="text-xs text-textGray mb-1">paymentsAbsent</div>
        <RowsTable doc={doc} path={[...base, 'paymentsAbsent']} readOnly={readOnly} onChange={onChange}
          columns={[{ key: 'contractNo', label: 'contractNo' }]}
          newRow={{ contractNo: '' }} />
      </div>
      <div>
        <div className="text-xs text-textGray mb-1">contractLinked</div>
        <RowsTable doc={doc} path={[...base, 'contractLinked']} readOnly={readOnly} onChange={onChange}
          columns={[{ key: 'contractNo', label: 'contractNo' }, { key: 'documentId', label: 'documentId' }]}
          newRow={{ contractNo: '', documentId: '' }} />
      </div>
      <TagGroup doc={doc} path={[...base, 'mustAppear']} readOnly={readOnly} onChange={onChange} label="mustAppear" />
      <TagGroup doc={doc} path={[...base, 'forbidden']} readOnly={readOnly} onChange={onChange} label="forbidden" />
      <TagGroup doc={doc} path={[...base, 'keywordInReply']} readOnly={readOnly} onChange={onChange} label="keywordInReply" />
    </section>
  )
}

function RubricSection({ doc, index, readOnly, onChange }: { doc: Document; index: number; readOnly: boolean; onChange: () => void }) {
  const dims = readList(doc, ['scenarios', index, 'rubric', 'dimensions'])
  const vetoPath = ['scenarios', index, 'rubric', 'veto'] as (string | number)[]
  const hasVeto = getIn(doc, [...vetoPath, 'hallucination']) !== undefined
  return (
    <section className="space-y-3">
      <div className="text-xs font-medium text-textGray">Rubric</div>
      <div className="space-y-2.5">
        {dims.map((_, d) => {
          const base = ['scenarios', index, 'rubric', 'dimensions', d] as (string | number)[]
          const scoring = [...base, 'scoring'] as (string | number)[]
          return (
            <div key={d} className="rounded-lg border border-borderGray bg-bgGray/40 p-3 space-y-2.5">
              <div className="flex items-center gap-2">
                <input value={readStr(doc, [...base, 'name'])} disabled={readOnly}
                  onChange={(e) => { setIn(doc, [...base, 'name'], e.target.value); onChange() }}
                  placeholder="维度名" className={clsx(inputCls, 'flex-1')} />
                <select value={readStr(doc, [...base, 'weight'])} disabled={readOnly}
                  onChange={(e) => { setIn(doc, [...base, 'weight'], e.target.value); onChange() }}
                  className={inputCls}>
                  <option value="essential">essential</option>
                  <option value="important">important</option>
                  <option value="optional">optional</option>
                </select>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {ANCHORS.map(([key, label]) => {
                  // 锚点键可能为 int (4:) 或 quoted string ("4:"), 经 bridge 探测键型寻址。
                  const anchorPath = getAnchorKeyPath(doc, scoring, key)
                  return (
                    <div key={key}>
                      <div className="text-xs text-textGray mb-1">{label}</div>
                      <textarea rows={3} value={readStr(doc, anchorPath)} disabled={readOnly}
                        onChange={(e) => { setIn(doc, anchorPath, e.target.value); onChange() }}
                        className={textareaCls} />
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
        {dims.length === 0 && <div className="text-xs text-textGray">无维度。</div>}
      </div>
      {hasVeto && (
        <div>
          <div className="text-xs text-textGray mb-1">veto.hallucination</div>
          <textarea rows={3} value={readStr(doc, [...vetoPath, 'hallucination'])} disabled={readOnly}
            onChange={(e) => { setIn(doc, [...vetoPath, 'hallucination'], e.target.value); onChange() }}
            className={textareaCls} />
        </div>
      )}
    </section>
  )
}

// ---- 场景卡片 (手风琴) ----

function ScenarioCard({ doc, index, readOnly, onChange }: { doc: Document; index: number; readOnly: boolean; onChange: () => void }) {
  const [open, setOpen] = useState(false)
  const id = readStr(doc, ['scenarios', index, 'id'])
  const tier = getIn(doc, ['scenarios', index, 'tier'])
  const commit = () => onChange()
  return (
    <div className="rounded-lg border border-borderGray bg-white">
      <button type="button" onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-4 py-2.5 text-left hover:bg-bgGray/60">
        <span className="font-mono text-sm text-textDark flex-1 truncate">{id || `场景 ${index + 1}`}</span>
        {typeof tier === 'number' && (
          <span className="rounded bg-deepSea/10 text-deepSea border border-deepSea/20 px-1.5 py-0.5 text-xs">T{tier}</span>
        )}
        {open ? <ChevronDown className="h-4 w-4 text-textGray shrink-0" aria-hidden /> : <ChevronRight className="h-4 w-4 text-textGray shrink-0" aria-hidden />}
      </button>
      {open && (
        <div className="px-4 py-3 border-t border-borderGray space-y-5">
          <BasicSection doc={doc} index={index} readOnly={readOnly} onChange={commit} />
          <PersonaSection doc={doc} index={index} readOnly={readOnly} onChange={commit} />
          <ApprovalSection doc={doc} index={index} readOnly={readOnly} onChange={commit} />
          <VerifiersSection doc={doc} index={index} readOnly={readOnly} onChange={commit} />
          <RubricSection doc={doc} index={index} readOnly={readOnly} onChange={commit} />
        </div>
      )}
    </div>
  )
}

// ---- 主组件 ----

export function DatasetFormView({ text, onChangeText, readOnly }: {
  text: string
  onChangeText: (next: string) => void
  readOnly: boolean
}) {
  const parsed = useMemo(() => parseDatasetYaml(text), [text])
  if (!parsed.ok || !parsed.doc) {
    return (
      <div className="rounded-lg border border-danger/25 bg-danger/5 px-4 py-3 text-sm text-danger">
        YAML 解析失败: {parsed.error}
      </div>
    )
  }
  const doc = parsed.doc
  const count = readList(doc, ['scenarios']).length
  const commit = () => onChangeText(docToText(doc))
  return (
    <div className="space-y-3">
      {Array.from({ length: count }, (_, i) => (
        <ScenarioCard key={i} doc={doc} index={i} readOnly={readOnly} onChange={commit} />
      ))}
      {count === 0 && <div className="text-sm text-textGray">数据集暂无场景。</div>}
    </div>
  )
}
