// apps/web/src/components/eval/EvalDatasetEditor.tsx
import { useCallback, useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { Save, Play, Trash2, Copy, Plus } from 'lucide-react'
import {
  getEvalDataset, putEvalDataset, copyEvalDataset, deleteEvalDataset,
} from '../../api/evalDatasets'
import { useEvalDatasets } from '../../hooks/useEvalDatasets'
import { parseDatasetYaml } from './yamlFormBridge'
import { DatasetFormView } from './DatasetFormView'

// 最小合法单场景模板 (zod: scoring 锚点键需加引号)。
const NEW_DATASET_TEMPLATE = `scenarios:
  - id: my-first-scenario
    tier: 1
    persona:
      facts: ['我是华盛集团的采购经办']
      disclosure: '被问到才提供订单号'
      goal: '查询订单 ORD-2024-0881 状态'
      patience: 3
    rubric:
      dimensions:
        - name: 准确性
          weight: essential
          scoring:
            '4': 完全准确
            '1': 明显错误
`

export function EvalDatasetEditor({ onRunFromDataset }: { onRunFromDataset: (name: string) => void }) {
  const { datasets, loading, error, refresh } = useEvalDatasets()
  const [selected, setSelected] = useState<string | null>(null)
  const [builtin, setBuiltin] = useState(false)
  const [yaml, setYaml] = useState('')
  const [dirty, setDirty] = useState(false)
  const [loadingYaml, setLoadingYaml] = useState(false)
  const [saving, setSaving] = useState(false)
  const [busy, setBusy] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [scenarioCount, setScenarioCount] = useState<number | null>(null)
  const [copySource, setCopySource] = useState('core')
  const [copyName, setCopyName] = useState('')
  const [createName, setCreateName] = useState('')
  const [mode, setMode] = useState<'form' | 'yaml'>('form')

  // 双模式解析探测: form tab 禁用 + 已处 form 时非法文本自动回退 yaml。
  const parsed = useMemo(() => parseDatasetYaml(yaml), [yaml])
  useEffect(() => {
    if (mode === 'form' && !parsed.ok) setMode('yaml')
  }, [mode, parsed.ok])

  // 未保存内容离开页面时守卫。
  useEffect(() => {
    if (!dirty) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [dirty])

  const openDataset = useCallback(async (name: string) => {
    // dirty 时切换数据集会丢弃未保存修改, 先确认 (beforeunload 只管离开页面)。
    if (dirty && selected !== name && !window.confirm('当前有未保存的修改, 切换将丢弃。确定切换?')) return
    setLoadingYaml(true)
    setSaveError(null)
    setScenarioCount(null)
    try {
      const detail = await getEvalDataset(name)
      setSelected(detail.name)
      setBuiltin(detail.builtin)
      setYaml(detail.yaml)
      setDirty(false)
      // 打开数据集时表单态重置 (若新文本非法, 上面的回退 effect 会落回 yaml)。
      setMode('form')
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoadingYaml(false)
    }
    // dirty/selected 进 deps: 切换守卫需要当前值 (见函数首行)。
  }, [dirty, selected])

  const handleSave = async () => {
    if (!selected || builtin) return
    setSaving(true)
    setSaveError(null)
    try {
      const res = await putEvalDataset(selected, yaml)
      setScenarioCount(res.scenarioCount)
      setDirty(false)
      void refresh()
    } catch (e) {
      // 422 校验错误全文 (含场景定位) 直接展示。
      setSaveError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const handleCopy = async () => {
    const target = copyName.trim()
    if (!target || !copySource) return
    setBusy(true)
    setSaveError(null)
    try {
      await copyEvalDataset(copySource, target)
      setCopyName('')
      await refresh()
      await openDataset(target)
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const handleCreate = async () => {
    const name = createName.trim()
    if (!name) return
    // PUT 是 upsert, 撞名会静默覆盖已有数据集, 先预检。
    if (datasets.some((d) => d.name === name)) {
      setSaveError(`数据集 ${name} 已存在, 新建会覆盖其内容。请换一个名字。`)
      return
    }
    setBusy(true)
    setSaveError(null)
    try {
      await putEvalDataset(name, NEW_DATASET_TEMPLATE)
      setCreateName('')
      await refresh()
      await openDataset(name)
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async (name: string) => {
    if (busy) return
    if (!window.confirm(`确定删除数据集 ${name}? 该操作不可撤销。`)) return
    setBusy(true)
    setSaveError(null)
    try {
      await deleteEvalDataset(name)
      if (selected === name) {
        setSelected(null)
        setBuiltin(false)
        setYaml('')
        setDirty(false)
        setScenarioCount(null)
      }
      await refresh()
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="p-6 flex flex-col lg:flex-row gap-4 items-start">
      {/* 左列: 列表 + 复制 + 新建 */}
      <div className="w-full lg:w-72 shrink-0 space-y-3">
        <div className="rounded-lg border border-line bg-white">
          <div className="px-3 py-2 border-b border-line text-sm font-medium text-ink">数据集</div>
          {loading && <div className="px-3 py-2 text-xs text-ink-soft">加载中...</div>}
          {!loading && error && <div className="px-3 py-2 text-xs text-danger">{error}</div>}
          <div className="divide-y divide-line max-h-[45vh] overflow-auto">
            {datasets.map((d) => (
              <div key={d.name}
                className={clsx('flex items-center gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-surface/60', selected === d.name && 'bg-surface/60')}
                onClick={() => void openDataset(d.name)}>
                <span className="flex-1 font-mono text-xs text-ink truncate">{d.name}</span>
                {d.builtin && <span className="shrink-0 text-[10px] text-ink-soft border border-line rounded px-1">内置·只读</span>}
                {!d.builtin && (
                  <button type="button" aria-label={`删除 ${d.name}`} title="删除"
                    onClick={(e) => { e.stopPropagation(); void handleDelete(d.name) }}
                    className="shrink-0 text-ink-soft hover:text-danger">
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-lg border border-line bg-white p-3 space-y-2">
          <div className="text-xs text-ink-soft">复制数据集</div>
          <div className="flex gap-2">
            <select value={copySource} onChange={(e) => setCopySource(e.target.value)}
              className="flex-1 min-w-0 rounded border border-line bg-white px-1.5 py-1 text-xs text-ink">
              {datasets.map((d) => <option key={d.name} value={d.name}>{d.name}</option>)}
            </select>
            <input value={copyName} onChange={(e) => setCopyName(e.target.value)}
              placeholder="新名称" className="flex-1 min-w-0 rounded border border-line bg-white px-2 py-1 text-xs text-ink" />
          </div>
          <button type="button" onClick={() => void handleCopy()} disabled={busy || !copyName.trim()}
            className="inline-flex items-center gap-1 rounded border border-line bg-white px-2.5 py-1 text-xs text-ink-soft hover:text-primary disabled:opacity-50">
            <Copy className="h-3 w-3" aria-hidden /> 复制
          </button>
        </div>

        <div className="rounded-lg border border-line bg-white p-3 space-y-2">
          <div className="text-xs text-ink-soft">新建数据集 (最小合法模板)</div>
          <input value={createName} onChange={(e) => setCreateName(e.target.value)}
            placeholder="数据集名称" className="w-full rounded border border-line bg-white px-2 py-1 text-xs text-ink" />
          <button type="button" onClick={() => void handleCreate()} disabled={busy || !createName.trim()}
            className="inline-flex items-center gap-1 rounded bg-primary px-2.5 py-1 text-xs text-white hover:opacity-90 disabled:opacity-50">
            <Plus className="h-3 w-3" aria-hidden /> 新建
          </button>
        </div>
      </div>

      {/* 右列: YAML 编辑 */}
      <div className="flex-1 min-w-0">
        <div className="rounded-lg border border-line bg-white">
          <div className="px-4 py-2.5 border-b border-line flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-ink font-mono">{selected ?? '未选择数据集'}</span>
            {dirty && <span className="text-xs text-warning">未保存</span>}
            {selected && builtin && <span className="text-xs text-ink-soft">内置数据集只读, 可复制后编辑</span>}
            {selected && !builtin && scenarioCount != null && (
              <span className="text-xs text-ink-soft">场景数: {scenarioCount}</span>
            )}
            <span className="flex-1" />
            {selected && !builtin && (
              <button type="button" onClick={() => void handleSave()} disabled={saving || !dirty}
                className="inline-flex items-center gap-1 rounded bg-primary px-3 py-1.5 text-xs text-white hover:opacity-90 disabled:opacity-50">
                <Save className="h-3.5 w-3.5" aria-hidden /> {saving ? '保存中...' : '保存'}
              </button>
            )}
            {selected && (
              <button type="button" onClick={() => onRunFromDataset(selected)}
                className="inline-flex items-center gap-1 rounded border border-primary/30 bg-primary/5 px-3 py-1.5 text-xs text-primary hover:bg-primary/10">
                <Play className="h-3.5 w-3.5" aria-hidden /> 从此数据集运行
              </button>
            )}
          </div>
          {saveError && (
            <div className="px-4 py-2 text-xs text-danger border-b border-line whitespace-pre-wrap">{saveError}</div>
          )}
          <div className="flex items-center gap-1 px-4 pt-2 border-b border-line">
            <button type="button" onClick={() => setMode('form')} disabled={!parsed.ok}
              title={!parsed.ok ? 'YAML 解析失败, 无法切换到表单' : undefined}
              className={clsx('px-3 py-1.5 text-sm rounded-t-lg border-b-2 -mb-px',
                mode === 'form' ? 'text-primary border-primary font-medium' : 'text-ink-soft border-transparent hover:text-primary',
                !parsed.ok && 'disabled:opacity-50 disabled:hover:text-ink-soft disabled:cursor-not-allowed')}>
              表单
            </button>
            <button type="button" onClick={() => setMode('yaml')}
              className={clsx('px-3 py-1.5 text-sm rounded-t-lg border-b-2 -mb-px',
                mode === 'yaml' ? 'text-primary border-primary font-medium' : 'text-ink-soft border-transparent hover:text-primary')}>
              源码
            </button>
            {!parsed.ok && <span className="ml-2 text-xs text-danger">{parsed.error}</span>}
          </div>
          {loadingYaml ? (
            <div className="p-6 text-sm text-ink-soft">加载中...</div>
          ) : mode === 'form' && parsed.ok ? (
            <div className="p-4">
              <DatasetFormView
                text={yaml}
                onChangeText={(next) => { setYaml(next); setDirty(true) }}
                readOnly={builtin}
              />
            </div>
          ) : (
            <textarea
              value={yaml}
              readOnly={builtin}
              onChange={(e) => { setYaml(e.target.value); setDirty(true) }}
              spellCheck={false}
              placeholder="选择左侧数据集以编辑"
              className="w-full min-h-[60vh] p-4 font-mono text-xs text-ink bg-white outline-none resize-y"
            />
          )}
        </div>
      </div>
    </div>
  )
}
