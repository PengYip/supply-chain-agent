import { useEffect, useMemo, useState } from 'react';
import { clsx } from 'clsx';
import {
  fetchTradeEventFormSchema, submitTradeEvent, TradeEventValidationError,
  type TradeEventFormField, type TradeEventFormSchema, type TradeEventSubmitResult,
} from '../../api/tradeEvents';

interface Props {
  /** 事件实体清单（注册表 schema phase==='event' 派生，禁止前端硬编码）。 */
  eventEntities: Array<{ name: string; label: string }>;
  /** 打开入口所在台账的实体类型（预选）。 */
  initialType: string;
  /** 注册表实体说明（key=实体名，schema 端点透出；顶部显示所选类型说明）。 */
  entityDescriptions?: Record<string, string>;
  onClose: () => void;
}

/** 全部输入先持字符串，提交时按字段 kind 归一（number 转 Number，可选项空值剔除）。 */
type ValueMap = Record<string, string>;

/** amount 与 currency 同缺同在（服务端写入边界不变量，缺失组合整单拒绝）：
 *  amount 为空时 currency 禁用并清空；amount 恢复有值时 currency 回到预填
 *  （删除显式值，让 formDefault=CNY 兜底重新生效）。数量-only 收/发货（不填金额）
 *  是本表单主用例，联动保证前端不向服务端发空串 currency。 */
const AMOUNT_FIELD = 'amount';
const CURRENCY_FIELD = 'currency';

const inputValueOf = (f: TradeEventFormField, values: ValueMap): string =>
  values[f.name] ?? (f.formDefault != null ? String(f.formDefault) : '');

/** enum 字段的选项展示：entityType 用注册表中文标签，其余直接用枚举值。 */
function optionLabelOf(field: TradeEventFormField, option: string,
  entityLabels: Map<string, string>): string {
  if (field.name === 'entityType') {
    const label = entityLabels.get(option);
    return label ? `${label}（${option}）` : option;
  }
  return option;
}

/** 事件登记抽屉（表单入口第二个客户端）：字段由 create_trade_event inputSchema
 *  投影驱动，提交经 POST /api/trade-events 走后台会话与 L2 审批（同核销工作台）。 */
export function EventRegisterDrawer({ eventEntities, initialType, entityDescriptions, onClose }: Props) {
  const [formSchema, setFormSchema] = useState<TradeEventFormSchema | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [values, setValues] = useState<ValueMap>({ entityType: initialType, currency: '' });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<TradeEventSubmitResult | null>(null);

  useEffect(() => {
    let alive = true;
    fetchTradeEventFormSchema()
      .then((s) => { if (alive) setFormSchema(s); })
      .catch((e: unknown) => { if (alive) setLoadError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, []);

  const entityLabels = useMemo(
    () => new Map(eventEntities.map((e) => [e.name, e.label])),
    [eventEntities],
  );

  const setValue = (name: string, value: string) => {
    setValues((prev) => {
      const next = { ...prev, [name]: value };
      if (name === AMOUNT_FIELD) {
        // 联动（见 AMOUNT_FIELD 注释）：清空 amount 时连带清空 currency；
        // amount 重新有值则删除显式 currency 值，formDefault 预填重新生效。
        if (value.trim() === '') next[CURRENCY_FIELD] = '';
        else delete next[CURRENCY_FIELD];
      }
      return next;
    });
    // 字段一旦改动即清其错误回显，避免陈旧红线；currency 随 amount 联动一并清。
    setFieldErrors((prev) => {
      const names = name === AMOUNT_FIELD ? [name, CURRENCY_FIELD] : [name];
      if (!names.some((n) => n in prev)) return prev;
      const next = { ...prev };
      for (const n of names) delete next[n];
      return next;
    });
  };

  const buildInput = (): { ok: true; input: Record<string, string | number> } | { ok: false; error: string } => {
    if (!formSchema) return { ok: false, error: '表单定义未加载' };
    const input: Record<string, string | number> = {};
    for (const f of formSchema.fields) {
      const raw = inputValueOf(f, values).trim();
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
    return { ok: true, input };
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
      const res = await submitTradeEvent(built.input);
      setResult(res);
    } catch (e) {
      if (e instanceof TradeEventValidationError) {
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
            <div className="text-sm font-medium text-ink">登记业务事件</div>
            <div className="mt-0.5 text-xs text-ink-soft">提交后经审批中心批准生效（create_trade_event 同一审批链）</div>
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
          {entityDescriptions?.[values['entityType'] ?? ''] && (
            <div className="mb-3 rounded border border-line bg-surface/40 px-3 py-2 text-xs leading-5 text-ink-soft">
              {entityDescriptions[values['entityType'] ?? '']}
            </div>
          )}
          {loadError && (
            <div className="rounded-lg border border-danger/30 bg-danger/5 p-3 text-sm text-danger">{loadError}</div>
          )}
          {!loadError && !formSchema && <div className="text-sm text-ink-soft">加载表单定义...</div>}
          {formSchema && (
            <div className="space-y-3">
              {formSchema.fields.map((f) => {
                const value = inputValueOf(f, values);
                const errors = fieldErrors[f.name] ?? [];
                const isEnum = f.kind === 'enum';
                const options = f.options ?? [];
                const amountField = formSchema.fields.find((x) => x.name === AMOUNT_FIELD);
                const currencyLocked =
                  f.name === CURRENCY_FIELD &&
                  (!amountField || inputValueOf(amountField, values).trim() === '');
                return (
                  <div key={f.name}>
                    <label className="mb-1 flex items-baseline gap-1 text-xs font-medium text-ink-soft" htmlFor={`ef-${f.name}`}>
                      {f.name}
                      {f.required && <span className="text-danger">必填</span>}
                    </label>
                    {isEnum ? (
                      <select
                        id={`ef-${f.name}`}
                        value={value}
                        onChange={(e) => setValue(f.name, e.target.value)}
                        className={clsx(
                          'h-8 w-full rounded border bg-white px-2 text-sm text-ink focus:outline-none focus:ring-1 focus:ring-primary/40',
                          errors.length ? 'border-danger' : 'border-line',
                        )}
                      >
                        <option value="">请选择...</option>
                        {options.map((opt) => (
                          <option key={opt} value={opt}>{optionLabelOf(f, opt, entityLabels)}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        id={`ef-${f.name}`}
                        type={f.widget === 'date' ? 'date' : f.kind === 'number' ? 'number' : 'text'}
                        step={f.kind === 'number' ? 'any' : undefined}
                        value={value}
                        disabled={currencyLocked}
                        onChange={(e) => setValue(f.name, e.target.value)}
                        className={clsx(
                          'h-8 w-full rounded border bg-white px-2 text-sm text-ink placeholder:text-ink-soft/60 focus:outline-none focus:ring-1 focus:ring-primary/40 disabled:cursor-not-allowed disabled:bg-surface disabled:text-ink-soft',
                          errors.length ? 'border-danger' : 'border-line',
                        )}
                      />
                    )}
                    <div className="mt-0.5 text-xs text-ink-soft/80">{f.description}</div>
                    {errors.map((msg) => (
                      <div key={msg} className="mt-0.5 text-xs text-danger">{msg}</div>
                    ))}
                  </div>
                );
              })}
            </div>
          )}

          {result && (
            <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
              <div>已提交，等待审批中心批准后写入台账。</div>
              <div className="mt-1 text-xs">工单号：<span className="font-mono">{result.ticketId}</span></div>
              <div className="mt-1 flex gap-3 text-xs">
                <a className="text-blue-600 hover:underline" href="#/approvals">前往审批中心</a>
                <a className="text-blue-600 hover:underline" href={`#/chat?session=${result.sessionId}`}>查看会话</a>
              </div>
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
            disabled={!formSchema || submitting || !!result}
            onClick={() => void onSubmit()}
            className="rounded-md bg-blue-600 px-4 py-1.5 text-sm text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? '提交中...' : '提交审批'}
          </button>
          <span className="text-xs text-ink-soft">金额正负与字段组合由注册表校验；批准前不产生任何写入。</span>
        </div>
      </div>
    </div>
  );
}
