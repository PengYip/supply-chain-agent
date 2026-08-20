import { useCallback, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { AlertTriangle, CheckCircle2, Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import {
  useParties,
  type AddPartyResult,
  type PartyCandidate,
  type PartyConflict,
  type SelfParty,
} from '../../hooks/useParties';
import { formatFlowSkipLines } from '../../lib/flowSkip';
import { PageHeader } from '../shell/PageHeader';

const inputCls =
  'h-8 w-full min-w-0 rounded-md border border-borderGray bg-white px-2.5 text-[12px] text-textDark focus:border-deepSea focus:outline-none';

function formatDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

interface ToastItem {
  id: number;
  kind: 'success' | 'error';
  text: string;
}

/** 服务端错误码 -> 中文文案(assertOk 会透传 data.error)。 */
const PARTY_ERROR_TEXT: Record<string, string> = {
  invalid_name: '请输入有效的主体名称',
};

/** 行内移除二次确认: 不回收说明 + 取消/移除。名单行与冲突条共用。 */
function RemoveConfirm({
  deleting,
  onCancel,
  onConfirm,
}: {
  deleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <span className="text-[10px] leading-4 text-textGray">移除后已生成的执行流水不会回收</span>
      <button
        type="button"
        onClick={onCancel}
        disabled={deleting}
        className="h-6 rounded-md border border-borderGray bg-white px-2 text-[11px] text-textGray transition-colors hover:bg-bgGray disabled:opacity-50"
      >
        取消
      </button>
      <button
        type="button"
        onClick={onConfirm}
        disabled={deleting}
        className="flex h-6 items-center gap-1 rounded-md bg-danger px-2 text-[11px] font-medium text-white transition-colors hover:bg-[#991B1B] disabled:opacity-50"
      >
        {deleting && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
        移除
      </button>
    </span>
  );
}

/** 已配置主体行: 名称 + 来源徽章(环境变量行不提供删除) / 行内二次确认移除。 */
function PartyRow({
  party,
  confirming,
  deleting,
  onAskRemove,
  onCancelRemove,
  onConfirmRemove,
}: {
  party: SelfParty;
  confirming: boolean;
  deleting: boolean;
  onAskRemove: () => void;
  onCancelRemove: () => void;
  onConfirmRemove: () => void;
}) {
  const envSourced = party.source === 'env';
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-borderGray/60 px-4 py-2.5 last:border-b-0">
      <span className="min-w-0 flex-1 break-all text-[13px] leading-5 text-textDark">{party.name}</span>
      {envSourced ? (
        <span
          className="shrink-0 rounded border border-[#CFDCE6] bg-[#EBF1F5] px-1.5 py-px text-[10px] text-steelBlue"
          title="已由环境变量配置，不可在此移除"
        >
          已由环境变量配置
        </span>
      ) : confirming ? (
        <RemoveConfirm deleting={deleting} onCancel={onCancelRemove} onConfirm={onConfirmRemove} />
      ) : (
        <button
          type="button"
          onClick={onAskRemove}
          title="移除主体"
          aria-label={`移除主体 ${party.name}`}
          className="flex h-6 shrink-0 items-center gap-1 rounded-md border border-borderGray bg-white px-2 text-[11px] text-textGray transition-colors hover:border-danger hover:text-danger"
        >
          <Trash2 className="h-3 w-3" aria-hidden />
          移除
        </button>
      )}
    </div>
  );
}

/** 候选主体行: 名称 + 合同当事方徽章 + 出现频次/买卖侧证据 + 确认/忽略。 */
function CandidateRow({
  candidate,
  confirming,
  onConfirm,
  onIgnore,
}: {
  candidate: PartyCandidate;
  confirming: boolean;
  onConfirm: () => void;
  onIgnore: () => void;
}) {
  const date = formatDate(candidate.lastSeenAt);
  // 证据行: 角色统计为后端扩展字段, 缺省(undefined)时隐藏该侧, 0 会正常展示。
  const metaParts = [`出现在 ${candidate.docCount} 份文档`];
  if (typeof candidate.buyerCount === 'number') metaParts.push(`买方侧 ${candidate.buyerCount}`);
  if (typeof candidate.sellerCount === 'number') metaParts.push(`卖方侧 ${candidate.sellerCount}`);
  if (date) metaParts.push(`最近出现于 ${date}`);
  return (
    <div className="border-b border-borderGray/60 px-4 py-2.5 last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <span className="min-w-0 flex-1 break-all text-[13px] leading-5 text-textDark">{candidate.name}</span>
        {candidate.isContractParty && (
          <span className="shrink-0 rounded border border-[#CBE5D3] bg-[#E9F4EC] px-1.5 py-px text-[10px] text-[#15803D]">
            合同当事方
          </span>
        )}
        <span className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={onConfirm}
            disabled={confirming}
            className="flex h-6 items-center gap-1 rounded-md bg-deepSea px-2 text-[11px] font-medium text-white transition-colors hover:bg-[#164a76] disabled:opacity-50"
          >
            {confirming && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
            确认
          </button>
          <button
            type="button"
            onClick={onIgnore}
            disabled={confirming}
            className="h-6 rounded-md border border-borderGray bg-white px-2 text-[11px] text-textGray transition-colors hover:bg-bgGray disabled:opacity-50"
          >
            忽略
          </button>
        </span>
      </div>
      <div className="mt-1 text-[11px] leading-4 text-textGray">{metaParts.join(' · ')}</div>
    </div>
  );
}

/** 冲突条一侧: 角色前缀 + 名称 + 移除入口(环境变量来源的一侧不可在此移除)。 */
function ConflictSide({
  roleLabel,
  name,
  removable,
  confirming,
  deleting,
  onAskRemove,
  onCancelRemove,
  onConfirmRemove,
}: {
  roleLabel: string;
  name: string;
  removable: boolean;
  confirming: boolean;
  deleting: boolean;
  onAskRemove: () => void;
  onCancelRemove: () => void;
  onConfirmRemove: () => void;
}) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="shrink-0 text-[10px] text-textGray">{roleLabel}</span>
      <span className="min-w-0 break-all text-[12px] font-medium leading-5 text-textDark">{name}</span>
      {removable ? (
        confirming ? (
          <RemoveConfirm deleting={deleting} onCancel={onCancelRemove} onConfirm={onConfirmRemove} />
        ) : (
          <button
            type="button"
            onClick={onAskRemove}
            title={`移除主体 ${name}`}
            aria-label={`移除主体 ${name}`}
            className="h-5 shrink-0 rounded px-1 text-[11px] text-textGray transition-colors hover:bg-[#FBE9E9] hover:text-danger"
          >
            移除
          </button>
        )
      ) : (
        <span
          className="shrink-0 rounded border border-[#CFDCE6] bg-[#EBF1F5] px-1.5 py-px text-[10px] text-steelBlue"
          title="已由环境变量配置，不可在此移除"
        >
          已由环境变量配置
        </span>
      )}
    </span>
  );
}

/** 冲突红条: 名单同时命中买卖双方的单据逐条列出, 每侧可就地发起移除(复用删除流程)。 */
function ConflictsBanner({
  conflicts,
  envNames,
  confirmingName,
  deletingName,
  onAskRemove,
  onCancelRemove,
  onConfirmRemove,
}: {
  conflicts: PartyConflict[];
  envNames: Set<string>;
  confirmingName: string | null;
  deletingName: string | null;
  onAskRemove: (name: string) => void;
  onCancelRemove: () => void;
  onConfirmRemove: (name: string) => void;
}) {
  return (
    <div className="mb-4 overflow-hidden rounded-md border border-[#F0C4C4]">
      <div className="flex items-center gap-2 bg-[#FBE9E9] px-4 py-2.5">
        <AlertTriangle className="h-4 w-4 shrink-0 text-danger" aria-hidden />
        <span className="text-[13px] font-medium leading-5 text-danger">
          名单同时命中以下单据的双方，方向无法判定，请移除其中非己方名称
        </span>
      </div>
      <div className="bg-white">
        {conflicts.map((c, i) => (
          <div
            key={`${c.documentId}-${c.buyer}-${c.seller}-${i}`}
            className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-t border-borderGray/60 px-4 py-2.5 first:border-t-0"
            title={c.documentId || undefined}
          >
            <span className="shrink-0 rounded border border-[#D8E2EB] bg-[#EEF2F6] px-1.5 py-px text-[10px] text-steelBlue">
              {c.docType || '单据'}
            </span>
            <ConflictSide
              roleLabel="买方"
              name={c.buyer}
              removable={!envNames.has(c.buyer)}
              confirming={confirmingName === c.buyer}
              deleting={deletingName === c.buyer}
              onAskRemove={() => onAskRemove(c.buyer)}
              onCancelRemove={onCancelRemove}
              onConfirmRemove={() => onConfirmRemove(c.buyer)}
            />
            <span className="shrink-0 text-[12px] text-textGray" aria-hidden>
              ↔
            </span>
            <ConflictSide
              roleLabel="卖方"
              name={c.seller}
              removable={!envNames.has(c.seller)}
              confirming={confirmingName === c.seller}
              deleting={deletingName === c.seller}
              onAskRemove={() => onAskRemove(c.seller)}
              onCancelRemove={onCancelRemove}
              onConfirmRemove={() => onConfirmRemove(c.seller)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

/** 己方主体名单管理页: 冲突红条 + 左列已配置名单(添加/移除) + 右列候选建议(确认/忽略)。 */
export function SelfPartyPanel() {
  const p = useParties();
  const { parties, candidates, conflicts, ignored } = p;

  const [input, setInput] = useState('');
  const [adding, setAdding] = useState(false);
  const [addNote, setAddNote] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);

  const [confirmingName, setConfirmingName] = useState<string | null>(null);
  const [conflictConfirmName, setConflictConfirmName] = useState<string | null>(null);
  const [deletingName, setDeletingName] = useState<string | null>(null);

  const [confirmingCandidate, setConfirmingCandidate] = useState<string | null>(null);

  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastIdRef = useRef(0);

  const visibleCandidates = candidates.filter((c) => !ignored.has(c.name));
  // 环境变量来源的名称集合: 冲突红条里这些名称不提供移除入口(删除会被服务端拒绝)。
  const envNames = useMemo(() => new Set(parties.filter((x) => x.source === 'env').map((x) => x.name)), [parties]);

  const pushToast = useCallback((kind: 'success' | 'error', text: string, duration = 3000) => {
    const id = ++toastIdRef.current;
    setToasts((prev) => [...prev.slice(-2), { id, kind, text }]);
    // 多行结果(如跳过原因清单)给更长停留时间, 便于读完。
    setTimeout(
      () => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      },
      text.includes('\n') ? Math.max(duration, 6000) : duration,
    );
  }, []);

  /** 添加/回填反馈: 成功行 + 失败说明 + 跳过原因明细, 一条 toast 讲清。 */
  const notifyBackfill = (res: AddPartyResult, name: string) => {
    const flows = Number.isFinite(res.refreshedFlows) ? res.refreshedFlows : 0;
    const failed = Number.isFinite(res.failed) ? res.failed : 0;
    let head = '';
    if (flows > 0) {
      head = failed > 0 ? `已回填 ${flows} 份文档的执行流水，其中 ${failed} 份失败` : `已回填 ${flows} 份文档的执行流水`;
    } else if (res.added !== false) {
      head = `已添加「${name}」`;
    }
    const lines = [...(head ? [head] : []), ...formatFlowSkipLines(res.skipped ?? [])];
    if (lines.length > 0) pushToast('success', lines.join('\n'));
  };

  const handleAdd = async () => {
    const name = input.trim();
    if (!name || adding) return;
    setAdding(true);
    setAddError(null);
    setAddNote(null);
    try {
      const res = await p.addParty(name);
      setInput('');
      // added=false: 名称已在名单中, 轻提示不弹 toast。
      if (res.added === false) setAddNote('已在名单中');
      notifyBackfill(res, name);
      void p.refresh();
    } catch (e) {
      const code = e instanceof Error ? e.message : '';
      setAddError(PARTY_ERROR_TEXT[code] ?? (e instanceof Error ? e.message : '添加失败'));
    } finally {
      setAdding(false);
    }
  };

  /** 移除执行(名单行与冲突条共用): 删除 + 成功/失败反馈 + 重新拉取(冲突条随之收敛)。 */
  const runRemove = async (name: string, onDone: () => void) => {
    if (deletingName) return;
    setDeletingName(name);
    try {
      const res = await p.removeParty(name);
      if (res.removed === false) {
        pushToast('error', '该主体已由环境变量配置，无法在此移除');
        return;
      }
      onDone();
      pushToast('success', `已移除「${name}」`);
      void p.refresh();
    } catch (e) {
      pushToast('error', e instanceof Error ? e.message : '移除失败');
    } finally {
      setDeletingName(null);
    }
  };

  const handleConfirmRemove = (name: string) => void runRemove(name, () => setConfirmingName(null));

  const handleConflictRemove = (name: string) => void runRemove(name, () => setConflictConfirmName(null));

  const handleConfirmCandidate = async (name: string) => {
    if (confirmingCandidate) return;
    setConfirmingCandidate(name);
    try {
      const res = await p.addParty(name);
      notifyBackfill(res, name);
      void p.refresh();
    } catch (e) {
      const code = e instanceof Error ? e.message : '';
      pushToast('error', PARTY_ERROR_TEXT[code] ?? (e instanceof Error ? e.message : '添加失败'));
    } finally {
      setConfirmingCandidate(null);
    }
  };

  const handleIgnore = (name: string) => {
    p.ignoreCandidate(name);
  };

  return (
    <div className="flex h-full flex-col bg-bgGray">
      {/* 二级工具条（视图标题与提示语由 AppTopbar 承担） */}
      <PageHeader
        actions={
          <>
            <span className="flex items-center gap-1.5 rounded-md bg-bgGray px-2.5 py-1 text-[11px] text-textGray">
              已配置 <span className="font-semibold tabular-nums text-textDark">{parties.length}</span>
            </span>
            <span className="flex items-center gap-1.5 rounded-md bg-bgGray px-2.5 py-1 text-[11px] text-textGray">
              候选 <span className="font-semibold tabular-nums text-textDark">{visibleCandidates.length}</span>
            </span>
            <button
              type="button"
              onClick={() => void p.refresh()}
              className="flex h-7 items-center gap-1 rounded-md border border-borderGray bg-white px-2.5 text-[12px] text-textDark hover:bg-bgGray"
            >
              <RefreshCw className={clsx('h-3.5 w-3.5', p.loading && 'animate-spin')} aria-hidden />
              刷新
            </button>
          </>
        }
      />

      {/* 主体区: 冲突红条(可选) + 双栏(左列已配置名单, 右列候选建议); 窄窗口自动堆叠 */}
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {p.error && !p.loading ? (
          <div className="flex flex-col items-center px-4 py-14 text-center">
            <AlertTriangle className="h-7 w-7 text-danger" aria-hidden />
            <div className="mt-2 max-w-[320px] break-all text-[13px] leading-5 text-danger">{p.error}</div>
            <button
              type="button"
              onClick={() => void p.refresh()}
              className="mt-3 flex items-center gap-1 rounded-md border border-borderGray bg-white px-2.5 py-1 text-[11px] text-textDark transition-colors hover:bg-bgGray"
            >
              <RefreshCw className="h-3 w-3" aria-hidden />
              重试
            </button>
          </div>
        ) : (
          <>
            {conflicts.length > 0 && (
              <ConflictsBanner
                conflicts={conflicts}
                envNames={envNames}
                confirmingName={conflictConfirmName}
                deletingName={deletingName}
                onAskRemove={setConflictConfirmName}
                onCancelRemove={() => setConflictConfirmName(null)}
                onConfirmRemove={handleConflictRemove}
              />
            )}
            <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
              {/* 左列: 已配置名单 */}
              <section className="overflow-hidden rounded-md border border-borderGray bg-white">
                <div className="flex items-baseline gap-1.5 border-b border-borderGray px-4 py-2.5">
                  <span className="text-[13px] font-semibold text-textDark">已配置主体</span>
                  <span className="text-[11px] text-textGray">共 {parties.length} 个</span>
                </div>
                <div className="border-b border-borderGray px-4 py-3">
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={input}
                      onChange={(e) => {
                        setInput(e.target.value);
                        setAddNote(null);
                        setAddError(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void handleAdd();
                      }}
                      placeholder="输入己方公司全称"
                      aria-label="输入己方公司全称"
                      className={inputCls}
                    />
                    <button
                      type="button"
                      onClick={() => void handleAdd()}
                      disabled={adding || input.trim() === ''}
                      className="flex h-8 shrink-0 items-center gap-1 rounded-md bg-deepSea px-3 text-[12px] font-medium text-white transition-colors hover:bg-[#164a76] disabled:opacity-50"
                    >
                      {adding ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                      ) : (
                        <Plus className="h-3.5 w-3.5" aria-hidden />
                      )}
                      添加
                    </button>
                  </div>
                  {addNote && <div className="mt-1.5 text-[11px] text-textGray">{addNote}</div>}
                  {addError && <div className="mt-1.5 text-[11px] text-danger">{addError}</div>}
                </div>
                <div>
                  {p.loading ? (
                    <div className="space-y-2 p-4">
                      {[0, 1, 2].map((i) => (
                        <div key={i} className="h-10 animate-pulse rounded-lg bg-bgGray" />
                      ))}
                      <div className="pt-1 text-center text-[12px] text-textGray">主体名单加载中</div>
                    </div>
                  ) : parties.length === 0 ? (
                    <div className="flex flex-col items-center px-5 py-10 text-center">
                      <div className="text-[13px] font-medium text-textDark">暂无主体</div>
                      <div className="mt-1 text-[12px] leading-5 text-textGray">在上方添加，或从右侧候选中确认</div>
                    </div>
                  ) : (
                    parties.map((party) => (
                      <PartyRow
                        key={party.name}
                        party={party}
                        confirming={confirmingName === party.name}
                        deleting={deletingName === party.name}
                        onAskRemove={() => setConfirmingName(party.name)}
                        onCancelRemove={() => setConfirmingName(null)}
                        onConfirmRemove={() => handleConfirmRemove(party.name)}
                      />
                    ))
                  )}
                </div>
              </section>

              {/* 右列: 候选建议 */}
              <section className="overflow-hidden rounded-md border border-borderGray bg-white">
                <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 border-b border-borderGray px-4 py-2.5">
                  <span className="text-[13px] font-semibold text-textDark">候选主体</span>
                  <span className="text-[11px] leading-4 text-textGray">
                    以下为单据中识别出的往来主体，仅勾选属于己方的名称
                  </span>
                </div>
                <div>
                  {p.loading ? (
                    <div className="space-y-2 p-4">
                      {[0, 1, 2].map((i) => (
                        <div key={i} className="h-12 animate-pulse rounded-lg bg-bgGray" />
                      ))}
                      <div className="pt-1 text-center text-[12px] text-textGray">候选加载中</div>
                    </div>
                  ) : visibleCandidates.length === 0 ? (
                    <div className="flex flex-col items-center px-5 py-10 text-center">
                      <div className="text-[13px] font-medium text-textDark">暂无待确认候选</div>
                      <div className="mt-1 text-[12px] leading-5 text-textGray">
                        上传并解析文档后，系统会自动识别高频主体
                      </div>
                    </div>
                  ) : (
                    visibleCandidates.map((c) => (
                      <CandidateRow
                        key={c.name}
                        candidate={c}
                        confirming={confirmingCandidate === c.name}
                        onConfirm={() => void handleConfirmCandidate(c.name)}
                        onIgnore={() => handleIgnore(c.name)}
                      />
                    ))
                  )}
                </div>
              </section>
            </div>
          </>
        )}
      </div>

      {/* 右上角 toast(样式与 BindingsView 一致, 多行用于跳过原因清单) */}
      <div className="pointer-events-none fixed right-4 top-4 z-[60] flex w-80 flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={clsx(
              'animate-fade-in rounded-md border border-borderGray border-l-4 bg-white px-3.5 py-2.5 shadow-card',
              t.kind === 'error' ? 'border-l-danger' : 'border-l-success',
            )}
          >
            <div className="flex items-start gap-2">
              {t.kind === 'error' ? (
                <AlertTriangle className="mt-px h-4 w-4 shrink-0 text-danger" aria-hidden />
              ) : (
                <CheckCircle2 className="mt-px h-4 w-4 shrink-0 text-success" aria-hidden />
              )}
              <span className="whitespace-pre-line text-[12px] leading-5 text-textDark">{t.text}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default SelfPartyPanel;
