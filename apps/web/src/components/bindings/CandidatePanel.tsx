import { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  FileSearch,
  Loader2,
  Plus,
  RefreshCw,
} from 'lucide-react';
import type { Anchors, ContractOption, OverviewDoc } from '../../hooks/useBindings';
import type { WorkbenchRow } from './BindingsView';

/** 关系类型常用值(对应服务端 bindingRelationFor 映射), 支持自定义。 */
const RELATION_PRESETS = ['货权转移', '付款', '质检', '凭证'];

const inputCls =
  'mt-1 h-8 w-full rounded-md border border-borderGray bg-white px-2.5 text-[12px] text-textDark focus:border-deepSea focus:outline-none';

function RouteBadge({ route }: { route: 'auto_rule' | 'human' | 'none' }) {
  const cfg =
    route === 'auto_rule'
      ? { label: '自动', cls: 'border-[#CBE5D3] bg-[#E9F4EC] text-[#15803D]' }
      : route === 'human'
        ? { label: '建议', cls: 'border-[#CFDCE6] bg-[#EBF1F5] text-steelBlue' }
        : { label: '弱候选', cls: 'border-[#E5E7EB] bg-[#F3F4F6] text-textGray' };
  return (
    <span className={clsx('shrink-0 rounded border px-1.5 py-px text-[10px]', cfg.cls)}>{cfg.label}</span>
  );
}

function scoreRatio(score: number): number {
  if (!Number.isFinite(score) || score <= 0) return 0;
  return Math.min(1, score);
}

interface CandidatePanelProps {
  doc: OverviewDoc | null;
  rows: WorkbenchRow[];
  anchors: Anchors | null;
  hasExtraction: boolean;
  loading: boolean;
  error: string | null;
  focusedKey: string | null;
  contracts: ContractOption[];
  batchErrors: Record<string, string>;
  pending: Set<string>;
  batchPending: boolean;
  onFocus: (key: string | null) => void;
  onConfirm: (row: WorkbenchRow) => void;
  onReject: (row: WorkbenchRow) => void;
  onBatchConfirm: (bindingIds: string[]) => void;
  onManualCreate: (p: { contractNo: string; relation: string; note?: string }) => Promise<boolean>;
  onRetryLoad: () => void;
}

export function CandidatePanel({
  doc,
  rows,
  anchors,
  hasExtraction,
  loading,
  error,
  focusedKey,
  contracts,
  batchErrors,
  pending,
  batchPending,
  onFocus,
  onConfirm,
  onReject,
  onBatchConfirm,
  onManualCreate,
  onRetryLoad,
}: CandidatePanelProps) {
  // 批量多选：文档/候选变化时回到默认(仅 auto_rule 默认勾选)。
  const [checked, setChecked] = useState<Set<string>>(new Set());
  useEffect(() => {
    setChecked(
      new Set(rows.filter((r) => r.bindingStatus === 'proposed' && r.bindingId && r.route === 'auto_rule').map((r) => r.bindingId!)),
    );
  }, [rows]);

  // 手动创建绑定表单(收起态只保留入口按钮)。
  const [manualOpen, setManualOpen] = useState(false);
  const [manualSearch, setManualSearch] = useState('');
  const [manualContract, setManualContract] = useState('');
  const [manualRelation, setManualRelation] = useState('');
  const [manualCustomRelation, setManualCustomRelation] = useState('');
  const [manualNote, setManualNote] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const manualPending = pending.has('manual');

  const confirmable = useMemo(
    () => rows.filter((r) => r.bindingStatus === 'proposed' && r.bindingId),
    [rows],
  );
  const checkedCount = confirmable.filter((r) => checked.has(r.bindingId!)).length;

  const filteredContracts = useMemo(() => {
    const q = manualSearch.trim().toLowerCase();
    if (!q) return contracts;
    return contracts.filter(
      (c) =>
        c.displayContractNo.toLowerCase().includes(q) ||
        c.contractNo.toLowerCase().includes(q) ||
        c.title.toLowerCase().includes(q),
    );
  }, [contracts, manualSearch]);

  const toggleChecked = (id: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const resetManualForm = () => {
    setManualSearch('');
    setManualContract('');
    setManualRelation('');
    setManualCustomRelation('');
    setManualNote('');
    setFormError(null);
  };

  const submitManual = async () => {
    if (!doc) return;
    const relation = manualRelation === '__custom' ? manualCustomRelation.trim() : manualRelation;
    if (!manualContract) {
      setFormError('请选择合同');
      return;
    }
    if (!relation) {
      setFormError('请选择或输入关系类型');
      return;
    }
    setFormError(null);
    const ok = await onManualCreate({
      contractNo: manualContract,
      relation,
      note: manualNote.trim() || undefined,
    });
    if (ok) {
      resetManualForm();
      setManualOpen(false);
    }
  };

  const anchorsEmpty =
    !anchors ||
    [anchors.contractNo, anchors.buyer, anchors.seller, anchors.date, anchors.amount, anchors.quantityTon].every(
      (v) => v === undefined || v === null || v === '',
    );

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-white">
      <div className="shrink-0 border-b border-borderGray px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-[15px] font-semibold text-textDark">候选合同</span>
          {doc && rows.length > 0 && <span className="text-[11px] text-textGray">{rows.length} 个候选</span>}
        </div>
        <div className="mt-0.5 text-[11px] text-textGray">点击候选行，右侧查看锚点对照与评分证据</div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!doc ? (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center">
            <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[#E8EEF4]">
              <FileSearch className="h-7 w-7 text-deepSea" aria-hidden />
            </span>
            <div className="mt-4 text-[14px] font-medium text-textDark">从左侧选择一个文档</div>
            <div className="mt-1 max-w-[320px] text-[12px] leading-5 text-textGray">
              查看系统为它生成的合同绑定建议（含评分证据），或直接手动创建绑定
            </div>
          </div>
        ) : error ? (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center">
            <AlertTriangle className="h-10 w-10 text-danger" aria-hidden />
            <div className="mt-3 text-[14px] font-medium text-textDark">候选生成失败</div>
            <div className="mt-1 max-w-[360px] break-all text-[12px] leading-5 text-danger">{error}</div>
            <button
              type="button"
              onClick={onRetryLoad}
              className="mt-4 flex items-center gap-1 rounded-md border border-borderGray bg-white px-3 py-1.5 text-[12px] text-textDark hover:bg-bgGray"
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden />
              重试
            </button>
          </div>
        ) : loading ? (
          <div className="space-y-2 p-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-[72px] animate-pulse rounded-lg bg-bgGray" />
            ))}
            <div className="pt-1 text-center text-[12px] text-textGray">候选计算中</div>
          </div>
        ) : !hasExtraction ? (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center">
            <FileSearch className="h-10 w-10 text-borderGray" aria-hidden />
            <div className="mt-3 text-[14px] font-medium text-textDark">尚未完成字段抽取</div>
            <div className="mt-1 max-w-[320px] text-[12px] leading-5 text-textGray">
              该文档还没有可用的抽取字段，无法自动生成候选；可在下方手动创建绑定
            </div>
          </div>
        ) : anchorsEmpty && rows.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center">
            <FileSearch className="h-10 w-10 text-borderGray" aria-hidden />
            <div className="mt-3 text-[14px] font-medium text-textDark">缺少可匹配字段</div>
            <div className="mt-1 max-w-[320px] text-[12px] leading-5 text-textGray">
              未识别到合同号、交易方、金额等锚点，建议在下方手动创建绑定
            </div>
          </div>
        ) : rows.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center">
            <FileSearch className="h-10 w-10 text-borderGray" aria-hidden />
            <div className="mt-3 text-[14px] font-medium text-textDark">暂无候选合同</div>
            <div className="mt-1 max-w-[320px] text-[12px] leading-5 text-textGray">
              台账中未找到可与该文档匹配的合同，可在下方手动创建绑定
            </div>
          </div>
        ) : (
          rows.map((row, i) => {
            const focused = row.key === focusedKey;
            const pct = Math.round(scoreRatio(row.score) * 100);
            const batchError = row.bindingId ? batchErrors[row.bindingId] : undefined;
            const isPending = !!row.bindingId && pending.has(row.bindingId);
            return (
              <div
                key={row.key}
                className={clsx(
                  'animate-fade-in border-b border-borderGray/60 px-3 py-2.5 transition-colors',
                  focused ? 'bg-[#E8EEF4]' : 'hover:bg-bgGray',
                )}
                style={{ animationDelay: `${Math.min(i * 30, 240)}ms` }}
              >
                <div className="flex items-start gap-2">
                  {/* 引导列：可确认建议给多选框，已绑定给对勾，其余占位 */}
                  <div className="flex w-5 shrink-0 items-center justify-center pt-0.5">
                    {row.bindingStatus === 'proposed' && row.bindingId ? (
                      <input
                        type="checkbox"
                        checked={checked.has(row.bindingId)}
                        onChange={() => toggleChecked(row.bindingId!)}
                        aria-label={`选择 ${row.contractNo}`}
                        className="h-3.5 w-3.5 cursor-pointer accent-[#0F3A5C]"
                      />
                    ) : row.bindingStatus === 'confirmed' ? (
                      <Check className="h-3.5 w-3.5 text-success" aria-hidden />
                    ) : null}
                  </div>

                  <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onFocus(focused ? null : row.key)}>
                    <div className="flex items-baseline gap-2">
                      <span
                        className={clsx(
                          'truncate text-[13px] font-medium leading-5',
                          row.route === 'none' ? 'text-textGray' : 'text-textDark',
                        )}
                      >
                        {row.ledger?.title || row.ledger?.displayContractNo || row.contractNo}
                      </span>
                      <span className="ml-auto shrink-0 text-[12px] font-medium tabular-nums text-textDark">{pct}%</span>
                    </div>
                    <div className="mt-1 flex items-center gap-1.5">
                      <span className="max-w-[45%] truncate font-mono text-[10px] text-textGray">
                        {row.ledger?.displayContractNo ?? row.contractNo}
                      </span>
                      <RouteBadge route={row.route} />
                      {row.savedProposal && (
                        <span className="shrink-0 rounded border border-[#CFDCE6] bg-white px-1.5 py-px text-[10px] text-steelBlue">
                          已保存
                        </span>
                      )}
                      {row.bindingStatus === 'confirmed' && (
                        <span className="shrink-0 rounded border border-[#CBE5D3] bg-[#E9F4EC] px-1.5 py-px text-[10px] text-[#15803D]">
                          已绑定
                        </span>
                      )}
                    </div>
                    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-bgGray">
                      <div
                        className={clsx(
                          'h-full rounded-full transition-[width] duration-300',
                          row.route === 'none' ? 'bg-[#C4CBD4]' : 'bg-deepSea',
                        )}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    {batchError && <div className="mt-1.5 text-[11px] leading-4 text-danger">确认失败：{batchError}</div>}
                  </button>

                  {row.bindingStatus === 'proposed' && row.bindingId && (
                    <div className="flex shrink-0 flex-col gap-1.5 pt-0.5">
                      <button
                        type="button"
                        onClick={() => onConfirm(row)}
                        disabled={isPending || batchPending}
                        className="flex h-6 items-center gap-1 rounded-md bg-deepSea px-2 text-[11px] font-medium text-white transition-colors hover:bg-[#164a76] disabled:opacity-50"
                      >
                        {isPending && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
                        确认
                      </button>
                      <button
                        type="button"
                        onClick={() => onReject(row)}
                        disabled={isPending || batchPending}
                        className="flex h-6 items-center rounded-md border border-borderGray bg-white px-2 text-[11px] text-textGray transition-colors hover:border-danger hover:text-danger disabled:opacity-50"
                      >
                        拒绝
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* 手动创建绑定 */}
      <div className="shrink-0 border-t border-borderGray">
        <button
          type="button"
          onClick={() => setManualOpen((v) => !v)}
          className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-[13px] font-medium text-deepSea transition-colors hover:bg-bgGray"
        >
          {manualOpen ? <ChevronDown className="h-4 w-4" aria-hidden /> : <Plus className="h-4 w-4" aria-hidden />}
          手动创建绑定
        </button>
        {manualOpen && (
          <div className="animate-fade-in space-y-3 border-t border-borderGray/60 px-4 pb-4 pt-3">
            {contracts.length === 0 ? (
              <div className="rounded-md bg-bgGray px-3 py-2 text-[12px] leading-5 text-textGray">
                合同台账为空，请先上传合同类文档并完成抽取
              </div>
            ) : (
              <>
                <div>
                  <label className="text-[11px] font-medium text-textGray">搜索合同</label>
                  <input
                    type="text"
                    value={manualSearch}
                    onChange={(e) => setManualSearch(e.target.value)}
                    placeholder="按合同号或名称过滤"
                    className={inputCls}
                  />
                </div>
                <div>
                  <label className="text-[11px] font-medium text-textGray">选择合同</label>
                  <select
                    value={manualContract}
                    onChange={(e) => setManualContract(e.target.value)}
                    className={inputCls}
                  >
                    <option value="">请选择合同</option>
                    {filteredContracts.map((c) => (
                      <option key={c.contractNo} value={c.contractNo}>
                        {c.displayContractNo}
                        {c.title ? ` · ${c.title}` : ''}
                      </option>
                    ))}
                  </select>
                  {filteredContracts.length === 0 && (
                    <div className="mt-1 text-[11px] text-textGray">没有匹配「{manualSearch}」的合同</div>
                  )}
                </div>
                <div>
                  <label className="text-[11px] font-medium text-textGray">关系类型</label>
                  <select
                    value={manualRelation}
                    onChange={(e) => setManualRelation(e.target.value)}
                    className={inputCls}
                  >
                    <option value="">请选择关系</option>
                    {RELATION_PRESETS.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                    <option value="__custom">自定义</option>
                  </select>
                  {manualRelation === '__custom' && (
                    <input
                      type="text"
                      value={manualCustomRelation}
                      onChange={(e) => setManualCustomRelation(e.target.value)}
                      placeholder="输入自定义关系类型"
                      className={inputCls}
                    />
                  )}
                </div>
                <div>
                  <label className="text-[11px] font-medium text-textGray">备注（选填）</label>
                  <input
                    type="text"
                    value={manualNote}
                    onChange={(e) => setManualNote(e.target.value)}
                    placeholder="补充说明，便于后续审计"
                    className={inputCls}
                  />
                </div>
                {formError && <div className="text-[12px] text-danger">{formError}</div>}
                <div className="flex items-center justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => {
                      setManualOpen(false);
                      setFormError(null);
                    }}
                    className="h-7 rounded-md border border-borderGray bg-white px-3 text-[12px] text-textGray hover:bg-bgGray"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={() => void submitManual()}
                    disabled={manualPending}
                    className="flex h-7 items-center gap-1 rounded-md bg-deepSea px-3 text-[12px] font-medium text-white transition-colors hover:bg-[#164a76] disabled:opacity-50"
                  >
                    {manualPending && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
                    创建绑定
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* 批量确认条 */}
      {doc && confirmable.length > 0 && (
        <div className="shrink-0 border-t border-borderGray bg-white px-4 py-2.5">
          <div className="flex items-center gap-3">
            <span className="text-[12px] text-textGray">
              已选 <span className="font-medium tabular-nums text-textDark">{checkedCount}</span> / {confirmable.length} 项
            </span>
            <button
              type="button"
              onClick={() => setChecked(new Set(confirmable.map((r) => r.bindingId!)))}
              className="text-[12px] text-deepSea hover:underline"
            >
              全选
            </button>
            <button type="button" onClick={() => setChecked(new Set())} className="text-[12px] text-textGray hover:underline">
              清空
            </button>
            <button
              type="button"
              disabled={checkedCount === 0 || batchPending}
              onClick={() => onBatchConfirm(confirmable.filter((r) => checked.has(r.bindingId!)).map((r) => r.bindingId!))}
              className="ml-auto flex h-7 items-center gap-1 rounded-md bg-deepSea px-3 text-[12px] font-medium text-white transition-colors hover:bg-[#164a76] disabled:opacity-50"
            >
              {batchPending && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
              确认所选{checkedCount > 0 ? `（${checkedCount}）` : ''}
            </button>
          </div>
          <div className="mt-1 text-[11px] text-textGray">自动匹配的高分建议已默认勾选</div>
        </div>
      )}
    </section>
  );
}
