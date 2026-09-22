import { useState } from 'react';
import clsx from 'clsx';
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import {
  CONTRACT_TYPE_OPTIONS,
  isControlledContractType,
  patchContractType,
  type ContractTypeChangeResult,
  type ContractTypeOption,
} from '../../api/contracts';

/* ---------- 合同类型人工修正入口(business-loop Wave 7) ----------
 *
 * 背景: 合同抽取值可能无方向语义(如「购销合同」分不出采购/销售), 系统诚实留空
 * contract_type, 绑定凭证的执行流水因方向不可判定被跳过。此入口让用户在台账
 * 行详情侧人工消歧: 受控六值选择(禁自由文本, 歧义值进不来), 提交走
 * PATCH /api/contracts/:no/type, 后端落 contract_ledger.contract_type 并对
 * 已绑定单据重建执行流水。
 *
 * 两态: 类型空/值不当 -> 默认展开的弱化引导(warning 色系, 与台账页「待确认」
 * 提示同级, 不抢主视觉); 类型已是受控值 -> 一行小字 + 安静的「修正」入口。
 * 成功反馈按 refreshedFlows 语义 = 重建流水的文档数(张), 不写「条」。
 */

export function ContractTypeCorrection({
  contractNo,
  currentType,
  onChanged,
}: {
  contractNo: string;
  currentType: string | null;
  /** 修正成功回调: 父级刷新台账行字段 + 重挂对账面板。 */
  onChanged?: () => void;
}) {
  const needsFix = !isControlledContractType(currentType);
  const [editing, setEditing] = useState(needsFix);
  const [selected, setSelected] = useState<ContractTypeOption | ''>('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ContractTypeChangeResult | null>(null);

  const openEditor = () => {
    setResult(null);
    setError(null);
    setSelected('');
    setEditing(true);
  };

  const submit = async () => {
    if (!selected || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await patchContractType(contractNo, selected);
      setResult(res);
      setEditing(false);
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div data-testid="contract-type-correction" className="space-y-2">
      {/* 成功反馈: 独立于 currentType 存活(父级刷新后引导态消失, 反馈不丢)。 */}
      {result && !editing && (() => {
        // W8 T4: 主口径 refreshedDocuments; 旧服务端仅返 refreshedFlows 时回退(同部署幂等)。
        const docs = result.refreshedDocuments ?? result.refreshedFlows;
        return (
        <div className="animate-fade-in flex items-start gap-1.5 rounded border border-success/30 bg-success/5 px-2 py-1.5" data-testid="contract-type-result">
          <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" aria-hidden />
          <div className="min-w-0 text-xs leading-5">
            <span className="text-ink">
              已改为「{result.contractType}」。
              {docs > 0
                ? `已重建 ${docs} 张单据的执行流水。`
                : '该合同名下暂无已确认绑定的单据，本次没有流水需要重建。'}
            </span>
            {result.failed > 0 && (
              <span className="text-warning"> 另有 {result.failed} 张单据重建失败，可稍后重试。</span>
            )}
            {result.skipped.length > 0 && (
              <span className="text-ink-soft"> 另有 {result.skipped.length} 项绑定未生成流水（如方向仍无法判定）。</span>
            )}
          </div>
        </div>
        );
      })()}

      {/* 类型已是受控值: 一行小字 + 安静的修正入口(不展开不占空间)。 */}
      {!needsFix && !editing && (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-ink-soft">合同类型</span>
          <span className="font-medium text-ink">{currentType}</span>
          <button
            type="button"
            onClick={openEditor}
            data-testid="contract-type-edit-trigger"
            className="rounded border border-line px-1.5 py-px text-[11px] text-ink-soft transition-colors hover:border-primary/40 hover:text-primary"
          >
            修正
          </button>
        </div>
      )}

      {/* 待消歧引导(弱化态): 类型空/值不当时默认展开, warning 色系不抢主视觉。 */}
      {needsFix && !editing && !result && (
        <button
          type="button"
          onClick={openEditor}
          data-testid="contract-type-pending"
          className="flex w-full items-start gap-1.5 rounded border border-warning/30 bg-warning/5 px-2 py-1.5 text-left transition-colors hover:bg-warning/10"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden />
          <span className="text-xs leading-5 text-ink">
            合同类型待判定
            <span className="text-ink-soft">
              {' '}（当前为{currentType ? `「${currentType}」` : '空'}，分不出采购还是销售，执行流水方向定不了）。点击选择实际类型。
            </span>
          </span>
        </button>
      )}

      {/* 修正控件: 受控六值下拉, 无自由文本输入位。 */}
      {editing && (
        <div
          className={clsx(
            'rounded border px-2 py-2',
            needsFix ? 'border-warning/30 bg-warning/5' : 'border-line bg-surface/30',
          )}
          data-testid="contract-type-editor"
        >
          {needsFix && (
            <div className="mb-1.5 flex items-start gap-1.5 text-xs leading-5">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden />
              <span className="text-ink-soft">
                这份合同的类型当前为{currentType ? `「${currentType}」` : '空'}，分不出采购还是销售，
                已绑定单据的执行流水会因此跳过。请选择实际类型，保存后自动重建。
              </span>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-1.5">
            <label htmlFor="contract-type-select" className="shrink-0 text-xs text-ink-soft">
              合同类型
            </label>
            <select
              id="contract-type-select"
              aria-label="选择合同类型"
              value={selected}
              onChange={(e) => setSelected(e.target.value as ContractTypeOption | '')}
              disabled={submitting}
              data-testid="contract-type-select"
              className="h-7 rounded border border-line bg-white px-1.5 text-xs text-ink focus:outline-none focus:ring-1 focus:ring-primary/40"
            >
              <option value="" disabled>请选择</option>
              {CONTRACT_TYPE_OPTIONS.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!selected || submitting}
              data-testid="contract-type-submit"
              className="flex h-7 items-center gap-1 rounded-md bg-primary px-2.5 text-xs font-medium text-white transition-colors hover:bg-primary-800 disabled:opacity-40"
            >
              {submitting && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
              保存
            </button>
            {!needsFix && (
              <button
                type="button"
                onClick={() => { setEditing(false); setError(null); }}
                disabled={submitting}
                className="h-7 rounded border border-line px-2 text-xs text-ink-soft transition-colors hover:bg-surface disabled:opacity-40"
              >
                取消
              </button>
            )}
            <span className="font-mono text-[10px] text-ink-soft" title={contractNo}>{contractNo}</span>
          </div>
          {error && (
            <div className="mt-1.5 text-xs leading-5 text-danger" data-testid="contract-type-error" role="alert">
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
