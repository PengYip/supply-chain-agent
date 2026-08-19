import { useCallback, useRef, useState } from 'react';
import clsx from 'clsx';
import { AlertTriangle, Building2, CheckCircle2, Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useParties, type PartyCandidate, type SelfParty } from '../../hooks/useParties';

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
          title="由环境变量提供，不可在此移除"
        >
          来自环境变量
        </span>
      ) : confirming ? (
        <span className="flex shrink-0 items-center gap-1.5">
          <span className="text-[10px] leading-4 text-textGray">移除后已生成的执行流水不会回收</span>
          <button
            type="button"
            onClick={onCancelRemove}
            disabled={deleting}
            className="h-6 rounded-md border border-borderGray bg-white px-2 text-[11px] text-textGray transition-colors hover:bg-bgGray disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onConfirmRemove}
            disabled={deleting}
            className="flex h-6 items-center gap-1 rounded-md bg-danger px-2 text-[11px] font-medium text-white transition-colors hover:bg-[#991B1B] disabled:opacity-50"
          >
            {deleting && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
            移除
          </button>
        </span>
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

/** 候选主体行: 名称 + 合同当事方徽章 + 出现频次证据 + 确认/忽略。 */
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
      <div className="mt-1 text-[11px] leading-4 text-textGray">
        出现在 {candidate.docCount} 份文档{date ? ` · 最近出现于 ${date}` : ''}
      </div>
    </div>
  );
}

/** 主体名单管理页: 左列已配置名单(添加 + 移除), 右列候选建议(确认 + 忽略)。 */
export function SelfPartyPanel() {
  const p = useParties();
  const { parties, candidates, ignored } = p;

  const [input, setInput] = useState('');
  const [adding, setAdding] = useState(false);
  const [addNote, setAddNote] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);

  const [confirmingName, setConfirmingName] = useState<string | null>(null);
  const [deletingName, setDeletingName] = useState<string | null>(null);

  const [confirmingCandidate, setConfirmingCandidate] = useState<string | null>(null);

  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastIdRef = useRef(0);

  const visibleCandidates = candidates.filter((c) => !ignored.has(c.name));

  const pushToast = useCallback((kind: 'success' | 'error', text: string) => {
    const id = ++toastIdRef.current;
    setToasts((prev) => [...prev.slice(-2), { id, kind, text }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3000);
  }, []);

  /** 添加成功的回填反馈: refreshedFlows>0 时提示, failed>0 追加说明(不阻塞)。 */
  const notifyBackfill = (res: { added: boolean; refreshedFlows: number; failed: number }, name: string) => {
    const flows = Number.isFinite(res.refreshedFlows) ? res.refreshedFlows : 0;
    const failed = Number.isFinite(res.failed) ? res.failed : 0;
    if (flows > 0) {
      pushToast(
        'success',
        failed > 0 ? `已回填 ${flows} 份文档的执行流水，其中 ${failed} 份失败` : `已回填 ${flows} 份文档的执行流水`,
      );
    } else if (res.added !== false) {
      pushToast('success', `已添加「${name}」`);
    }
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

  const handleConfirmRemove = async (name: string) => {
    if (deletingName) return;
    setDeletingName(name);
    try {
      await p.removeParty(name);
      setConfirmingName(null);
      pushToast('success', `已移除「${name}」`);
      void p.refresh();
    } catch (e) {
      pushToast('error', e instanceof Error ? e.message : '移除失败');
    } finally {
      setDeletingName(null);
    }
  };

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
      {/* 顶部工具条(样式与 BindingsView 一致) */}
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-borderGray bg-white px-4">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-deepSea">
            <Building2 className="h-4 w-4 text-white" aria-hidden />
          </span>
          <div>
            <div className="text-[15px] font-semibold leading-5 text-textDark">主体名单</div>
            <div className="text-[11px] leading-4 text-textGray">维护我方主体名单，用于判定执行流水方向</div>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2.5">
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
        </div>
      </div>

      {/* 双栏主体: 左列已配置名单, 右列候选建议; 窄窗口自动堆叠 */}
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
                    placeholder="输入主体名称，如公司全称"
                    aria-label="输入主体名称"
                    className={inputCls}
                  />
                  <button
                    type="button"
                    onClick={() => void handleAdd()}
                    disabled={adding || input.trim() === ''}
                    className="flex h-8 shrink-0 items-center gap-1 rounded-md bg-deepSea px-3 text-[12px] font-medium text-white transition-colors hover:bg-[#164a76] disabled:opacity-50"
                  >
                    {adding ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Plus className="h-3.5 w-3.5" aria-hidden />}
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
                      onConfirmRemove={() => void handleConfirmRemove(party.name)}
                    />
                  ))
                )}
              </div>
            </section>

            {/* 右列: 候选建议 */}
            <section className="overflow-hidden rounded-md border border-borderGray bg-white">
              <div className="flex items-baseline gap-1.5 border-b border-borderGray px-4 py-2.5">
                <span className="text-[13px] font-semibold text-textDark">候选主体</span>
                <span className="text-[11px] text-textGray">从文档中高频出现的主体生成，确认后加入名单</span>
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
        )}
      </div>

      {/* 右上角 toast(3s 自动消失, 样式与 BindingsView 一致) */}
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
              <span className="text-[12px] leading-5 text-textDark">{t.text}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default SelfPartyPanel;
