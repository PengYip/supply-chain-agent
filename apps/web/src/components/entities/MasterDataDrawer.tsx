import { useState } from 'react';
import { clsx } from 'clsx';
import {
  submitMasterData, MasterDataValidationError,
  type MasterDataSubmitResult, type MasterDataTypeFormDTO,
} from '../../api/ontology';

interface Props {
  /** 登记目标类型（打开入口所在台账的实体；字段投影来自 master-data/schema）。 */
  masterType: MasterDataTypeFormDTO;
  onClose: () => void;
  /** 登记成功回调（台账列表刷新，新记录立即可见）。 */
  onSaved: () => void;
}

/** 全部输入先持字符串，提交时按字段 kind 归一（number 转 Number，可选项空值剔除）。 */
type ValueMap = Record<string, string>;

/** 主数据登记抽屉（商品/交易对手/内部组织）：字段由注册表反射投影驱动，
 *  提交经 POST /api/ontology/master-data 直写台账（主数据非资金事实，不走审批）。 */
export function MasterDataDrawer({ masterType, onClose, onSaved }: Props) {
  const [values, setValues] = useState<ValueMap>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<MasterDataSubmitResult | null>(null);

  const setValue = (name: string, value: string) => {
    setValues((prev) => ({ ...prev, [name]: value }));
    setFieldErrors((prev) => {
      if (!(name in prev)) return prev;
      const next = { ...prev };
      delete next[name];
      return next;
    });
  };

  const buildInput = (): { ok: true; input: Record<string, string | number> } | { ok: false; error: string } => {
    const input: Record<string, string | number> = {};
    for (const f of masterType.fields) {
      const raw = (values[f.name] ?? '').trim();
      if (raw === '') {
        if (f.required) return { ok: false, error: `必填字段为空：${f.description || f.name}` };
        continue;
      }
      if (f.kind === 'number') {
        const n = Number(raw);
        if (!Number.isFinite(n)) return { ok: false, error: `字段 ${f.name} 必须是数字` };
        input[f.name] = n;
      } else {
        input[f.name] = raw;
      }
    }
    return { ok: true, input: { entityType: masterType.name, ...input } };
  };

  const onSubmit = async () => {
    setSubmitError(null);
    setFieldErrors({});
    setFormErrors([]);
    const built = buildInput();
    if (!built.ok) {
      setSubmitError(built.error);
      return;
    }
    setSubmitting(true);
    try {
      const res = await submitMasterData(built.input);
      setResult(res);
      onSaved();
    } catch (e) {
      if (e instanceof MasterDataValidationError) {
        setFieldErrors(e.detail.fieldErrors);
        setFormErrors(e.detail.formErrors);
      } else {
        setSubmitError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" role="dialog" aria-modal="true">
      <div className="flex h-full w-[520px] max-w-[90vw] flex-col bg-white shadow-lg">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <div>
            <div className="text-sm font-medium text-ink">登记{masterType.label}</div>
            <div className="mt-0.5 text-xs leading-5 text-ink-soft">{masterType.description}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="rounded p-1 text-ink-soft transition-colors hover:bg-surface hover:text-ink"
          >
            关闭
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <div className="space-y-3">
            {masterType.fields.map((f) => {
              const value = values[f.name] ?? '';
              const errors = fieldErrors[f.name] ?? [];
              return (
                <div key={f.name}>
                  <label className="mb-1 flex items-baseline gap-1 text-xs font-medium text-ink-soft" htmlFor={`mf-${f.name}`}>
                    {f.name}
                    {f.required && <span className="text-danger">必填</span>}
                  </label>
                  <input
                    id={`mf-${f.name}`}
                    type={f.kind === 'number' ? 'number' : 'text'}
                    step={f.kind === 'number' ? 'any' : undefined}
                    value={value}
                    onChange={(e) => setValue(f.name, e.target.value)}
                    className={clsx(
                      'h-8 w-full rounded border bg-white px-2 text-sm text-ink placeholder:text-ink-soft/60 focus:outline-none focus:ring-1 focus:ring-primary/40',
                      errors.length ? 'border-danger' : 'border-line',
                    )}
                  />
                  <div className="mt-0.5 text-xs text-ink-soft/80">{f.description}</div>
                  {errors.map((msg) => (
                    <div key={msg} className="mt-0.5 text-xs text-danger">{msg}</div>
                  ))}
                </div>
              );
            })}
          </div>

          {result && (
            <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
              <div>登记成功，{masterType.label}已写入台账。</div>
              <div className="mt-1 text-xs">记录 ID：<span className="font-mono">{result.id}</span></div>
              <div className="mt-1 text-xs">关闭本抽屉即可在列表中看到新记录。</div>
            </div>
          )}
          {formErrors.length > 0 && (
            <div className="mt-4 rounded-lg border border-danger/30 bg-danger/5 p-3 text-sm text-danger">
              {formErrors.map((msg) => <div key={msg}>{msg}</div>)}
            </div>
          )}
          {submitError && (
            <div className="mt-4 rounded-lg border border-danger/30 bg-danger/5 p-3 text-sm text-danger">{submitError}</div>
          )}
        </div>

        <div className="flex items-center gap-3 border-t border-line px-4 py-3">
          <button
            type="button"
            disabled={submitting || !!result}
            onClick={() => void onSubmit()}
            className="rounded-md bg-blue-600 px-4 py-1.5 text-sm text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? '提交中...' : '登记'}
          </button>
          <span className="text-xs text-ink-soft">字段组合由本体注册表校验；来源标注 manual，写入后台账即时可见。</span>
        </div>
      </div>
    </div>
  );
}
