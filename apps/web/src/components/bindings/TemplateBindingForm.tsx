import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { Keyboard, ListFilter, Loader2 } from 'lucide-react';
import type { OverviewDoc } from '../../hooks/useBindings';
import type { TemplateContext, TemplateContractRef } from '../../api/templateContext';
import {
  buildProjectOptions, deriveRelation, contractDisableReason, filterContracts, needsFilter,
  validateManualContractNo,
} from '../../lib/bindingFormModel';

interface TemplateBindingFormProps {
  doc: OverviewDoc;
  context: TemplateContext;                    // 已就绪的 context(加载/降级由父级处理)
  establishedContracts: Set<string>;
  pending: boolean;                            // pending.has('manual')
  onSubmit: (p: { contractNo: string; relation: string; note?: string }) => Promise<boolean>;
  onCancel: () => void;
}

const inputCls =
  'mt-1 h-8 w-full rounded-md border border-line bg-white px-2.5 text-[12px] text-ink focus:border-primary focus:outline-none';

/** 模板驱动双下拉绑定表单(§0 设计规格): 选项目 -> 选合同, relation 只读派生。
 *  立项书(bindsTargetKind='Project')分支: 单步项目选择, contractNo 提交项目码。 */
export function TemplateBindingForm({
  doc,
  context,
  establishedContracts,
  pending,
  onSubmit,
  onCancel,
}: TemplateBindingFormProps) {
  const isProjectTarget = context.bindsTargetKind === 'Project';
  const isExecutionDoc = doc.docType !== '合同';
  const relation = deriveRelation(context);

  // 立项书分支: 项目单选
  const [projectCode, setProjectCode] = useState('');
  // 双下拉: 项目 select + 合同 listbox
  const [selectedProjectKey, setSelectedProjectKey] = useState('');
  const [selectedContract, setSelectedContract] = useState('');
  const [chosenWord, setChosenWord] = useState('');
  const [note, setNote] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [filterText, setFilterText] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  // 自定义编号入口: 台账/模板下拉只能选已有编号; 漂浮合同文件可能尚未解析出
  // 合同号, 因此合同文件允许手工建一个新合同编号(执行类单据仍受台账门禁)。
  const [manualInputOpen, setManualInputOpen] = useState(false);
  const [manualContractNo, setManualContractNo] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  const projectOptions = useMemo(() => buildProjectOptions(context), [context]);
  const currentProject = projectOptions.find((o) => o.key === selectedProjectKey);
  const contracts = useMemo(() => currentProject?.contracts ?? [], [currentProject]);
  const activeContractNo = manualContractNo.trim() || selectedContract;
  const showFilter = needsFilter(contracts);
  const filtered = useMemo(
    () => (showFilter ? filterContracts(contracts, filterText) : contracts),
    [contracts, filterText, showFilter],
  );

  // 点击外部关闭 listbox(照 ContractSearchBar 模式)。
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setListOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  // 列表变化时收敛 activeIndex。
  useEffect(() => {
    setActiveIndex((i) => (filtered.length === 0 ? 0 : Math.min(i, filtered.length - 1)));
  }, [filtered.length]);

  const disableReason = (c: TemplateContractRef): string | null =>
    contractDisableReason(c, {
      docType: doc.docType,
      isExecutionDoc,
      // P3 hotfix: established 集合语义已改为台账行存在(父级 contracts 即台账)。
      inLedger: establishedContracts.has(c.contractNo),
    });

  const chooseContract = (c: TemplateContractRef) => {
    if (disableReason(c)) return; // 禁用行 Enter 拦截
    setSelectedContract(c.contractNo);
    setManualContractNo('');
    setManualInputOpen(false);
    setListOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    // 中文输入法组合期间不响应导航/选中。
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (!listOpen && (e.key === 'ArrowDown' || e.key === 'Enter')) {
      // 触发按钮上 Enter 会继续触发原生 click(toggle), 必须 preventDefault 防双触发。
      e.preventDefault();
      setListOpen(true);
      return;
    }
    if (e.key === 'ArrowDown' && filtered.length > 0) {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % filtered.length);
    } else if (e.key === 'ArrowUp' && filtered.length > 0) {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + filtered.length) % filtered.length);
    } else if (e.key === 'Enter' && listOpen && !manualInputOpen && filtered[activeIndex]) {
      e.preventDefault();
      chooseContract(filtered[activeIndex]!);
    } else if (e.key === 'Escape') {
      setListOpen(false);
    }
  };

  const resetForm = () => {
    setProjectCode('');
    setSelectedProjectKey('');
    setSelectedContract('');
    setChosenWord('');
    setNote('');
    setFormError(null);
    setFilterText('');
    setListOpen(false);
    setManualInputOpen(false);
    setManualContractNo('');
  };

  // 切文档时重置全部选择态(QA #8: 不残留旧文档的项目/合同/方向)。
  useEffect(() => {
    setProjectCode('');
    setSelectedProjectKey('');
    setSelectedContract('');
    setChosenWord('');
    setNote('');
    setFormError(null);
    setFilterText('');
    setListOpen(false);
    setManualInputOpen(false);
    setManualContractNo('');
  }, [context.documentId]);

  const submit = async () => {
    if (isProjectTarget) {
      if (!projectCode) {
        setFormError('请选择项目');
        return;
      }
      setFormError(null);
      const ok = await onSubmit({ contractNo: projectCode, relation: '立项', note: note.trim() || undefined });
      if (ok) {
        resetForm();
        onCancel();
      }
      return;
    }
    if (!activeContractNo && !selectedProjectKey) {
      setFormError('请选择项目');
      return;
    }
    if (!activeContractNo) {
      setFormError('请选择合同');
      return;
    }
    if (manualInputOpen) {
      const manual = validateManualContractNo(manualContractNo, {
        isExecutionDoc,
        inLedger: establishedContracts.has(manualContractNo.trim()),
      });
      if (manual.error) {
        setFormError(manual.error);
        return;
      }
    }
    if (relation.needsChoice && !chosenWord) {
      setFormError('请选择绑定方向');
      return;
    }
    const word = relation.needsChoice ? chosenWord : relation.word;
    setFormError(null);
    const ok = await onSubmit({ contractNo: activeContractNo, relation: word, note: note.trim() || undefined });
    if (ok) {
      resetForm();
      onCancel();
    }
  };

  return (
    <div className="animate-fade-in space-y-3">
      {/* typeChain 面包屑(§0.5) */}
      <div className="text-[11px] text-ink-soft">
        单据类型：{context.typeChain.join(' ⊂ ')}
      </div>

      {isProjectTarget ? (
        /* 立项书分支(§0.8): 单步项目选择, contractNo 提交项目码 */
        <div>
          <label className="text-[11px] font-medium text-ink-soft">① 项目</label>
          <div className="mt-1 space-y-1">
            {context.projects.length === 0 ? (
              <div className="rounded-md bg-surface px-3 py-2 text-[12px] leading-5 text-ink-soft">
                暂无项目，请先在项目工作台创建
              </div>
            ) : (
              context.projects.map((p) => (
                <label
                  key={p.code}
                  className={clsx(
                    'flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-[12px]',
                    projectCode === p.code
                      ? 'border-primary/40 bg-primary/10 text-ink'
                      : 'border-line bg-white text-ink hover:bg-surface',
                  )}
                >
                  <input
                    type="radio"
                    name="project-target"
                    checked={projectCode === p.code}
                    onChange={() => setProjectCode(p.code)}
                    className="h-3.5 w-3.5 accent-primary"
                  />
                  <span className="truncate">{p.name}</span>
                  <span className="ml-auto shrink-0 font-mono text-[10px] text-ink-soft">{p.code}</span>
                </label>
              ))
            )}
          </div>
        </div>
      ) : (
        <>
          {/* ① 项目(原生 select, §0.2) */}
          <div>
            <label className="text-[11px] font-medium text-ink-soft">① 项目</label>
            <select
              value={selectedProjectKey}
              onChange={(e) => {
                setSelectedProjectKey(e.target.value);
                setSelectedContract('');
                setManualContractNo('');
                setManualInputOpen(false);
                setFilterText('');
                setListOpen(false);
              }}
              className={inputCls}
            >
              <option value="">请选择项目</option>
              {projectOptions.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          {/* ② 合同(过滤框 + listbox 向上展开, §0.3) */}
          <div ref={rootRef}>
            <label className="text-[11px] font-medium text-ink-soft">② 合同</label>
            {manualInputOpen ? (
              <input
                type="text"
                value={manualContractNo}
                onChange={(e) => {
                  setManualContractNo(e.target.value);
                  setSelectedContract('');
                  setListOpen(false);
                }}
                placeholder="输入自定义合同编号"
                aria-label="自定义合同编号"
                autoFocus
                className={inputCls}
              />
            ) : (
              <>
                {showFilter && (
                  <input
                    type="text"
                    value={filterText}
                    onChange={(e) => setFilterText(e.target.value)}
                    onKeyDown={onKeyDown}
                    onFocus={() => setListOpen(true)}
                    placeholder="过滤合同号"
                    aria-label="过滤合同"
                    className={inputCls}
                  />
                )}
                <div className="relative mt-1">
                  <button
                    type="button"
                    onClick={() => setListOpen((v) => !v)}
                    onKeyDown={onKeyDown}
                    className={clsx(inputCls, 'text-left')}
                  >
                    {activeContractNo || '请选择合同'}
                  </button>
                  {listOpen && (
                    <div className="absolute bottom-full z-30 mb-1 max-h-72 w-full overflow-auto rounded-md border border-line bg-white py-1 shadow-card animate-fade-in">
                      {filtered.length === 0 ? (
                        <div className="px-3 py-2 text-[12px] text-ink-soft">无匹配合同</div>
                      ) : (
                        filtered.map((c, i) => {
                          const reason = disableReason(c);
                          const disabled = reason !== null;
                          return (
                            <button
                              key={c.contractNo}
                              type="button"
                              disabled={disabled}
                              title={reason ?? undefined}
                              onMouseEnter={() => setActiveIndex(i)}
                              onClick={() => chooseContract(c)}
                              className={clsx(
                                'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px]',
                                i === activeIndex ? 'bg-primary/10' : '',
                                disabled ? 'cursor-not-allowed opacity-50' : 'text-ink hover:bg-surface',
                              )}
                            >
                              <span className="truncate font-mono">{c.contractNo}</span>
                              {c.contractType && (
                                <span className="shrink-0 rounded border border-primary/20 bg-primary/10 px-1.5 py-px text-[10px] text-primary-500">
                                  {c.contractType}
                                </span>
                              )}
                            </button>
                          );
                        })
                      )}
                    </div>
                  )}
                </div>
              </>
            )}
            <div className="mt-1 flex justify-end">
              <button
                type="button"
                onClick={() => {
                  const next = !manualInputOpen;
                  setManualInputOpen(next);
                  setListOpen(false);
                  if (next) setSelectedContract('');
                  else setManualContractNo('');
                }}
                aria-expanded={manualInputOpen}
                className="inline-flex h-6 items-center gap-1 rounded-md border border-line bg-white px-2 text-[11px] text-ink-soft transition-colors hover:border-primary/30 hover:text-primary-500"
              >
                {manualInputOpen
                  ? <ListFilter className="h-3 w-3" aria-hidden />
                  : <Keyboard className="h-3 w-3" aria-hidden />}
                {manualInputOpen ? '从合同列表选择' : '手动输入编号'}
              </button>
            </div>
            {activeContractNo && (
              <div className="mt-1 flex items-center gap-1 text-[11px] text-ink-soft">
                <span className="truncate">已选 {activeContractNo}</span>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedContract('');
                    setManualContractNo('');
                  }}
                  className="text-danger hover:underline"
                >
                  清除
                </button>
              </div>
            )}
          </div>
        </>
      )}

      {/* 绑定关系(§0.4): 只读 chip / needsChoice 时 pill 组 */}
      <div>
        <label className="text-[11px] font-medium text-ink-soft">绑定关系</label>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {relation.needsChoice ? (
            relation.vocab.map((w) => (
              <button
                key={w}
                type="button"
                onClick={() => setChosenWord(w)}
                className={clsx(
                  'rounded border px-2 py-0.5 text-[11px] transition-colors',
                  chosenWord === w
                    ? 'border-primary/40 bg-primary/10 text-primary-500'
                    : 'border-line bg-white text-ink-soft hover:bg-surface',
                )}
              >
                {w}
              </button>
            ))
          ) : (
            <span className="rounded border border-primary/20 bg-primary/10 px-1.5 py-px text-[10px] text-primary-500">
              {relation.word}
            </span>
          )}
        </div>
        {context.settlesVocab === null && (
          <div className="mt-1 text-[11px] leading-4 text-ink-soft">该类型单据绑定后不产生履约流水</div>
        )}
      </div>

      {/* 备注 */}
      <div>
        <label className="text-[11px] font-medium text-ink-soft">备注（选填）</label>
        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="补充说明，便于后续审计"
          className={inputCls}
        />
      </div>

      {formError && <div className="text-[12px] text-danger">{formError}</div>}

      <div className="flex items-center justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="h-7 rounded-md border border-line bg-white px-3 text-[12px] text-ink-soft hover:bg-surface"
        >
          取消
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={pending}
          className="flex h-7 items-center gap-1 rounded-md bg-primary px-3 text-[12px] font-medium text-white transition-colors hover:bg-primary-800 disabled:opacity-50"
        >
          {pending && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
          创建绑定
        </button>
      </div>
    </div>
  );
}
