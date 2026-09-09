import { useMemo, useState } from 'react';
import { clsx } from 'clsx';
import {
  submitMasterData, changeMasterData, MasterDataValidationError,
  type MasterDataTypeFormDTO,
} from '../../api/ontology';
import { maskBankAccount } from '../../lib/mask';

interface Props {
  /** 登记目标类型（打开入口所在台账的实体；字段投影来自 master-data/schema）。 */
  masterType: MasterDataTypeFormDTO;
  onClose: () => void;
  /** 登记成功回调（台账列表刷新，新记录立即可见）。 */
  onSaved: () => void;
  /** 变更模式（spec 主体身份 §4，2026-09-09）：预填现行值，提交走
   *  POST /master-data/change（supersede 换代：同主体新事实+旧事实失效）。 */
  changeTarget?: {
    prevFactId: string;
    /** 现行事实 payload（预填与敏感字段掩码还原的原始值来源）。 */
    current: Record<string, unknown>;
  };
}

/** 全部输入先持字符串，提交时按字段 kind 归一（number 转 Number，可选项空值剔除）。 */
type ValueMap = Record<string, string>;

/** 自定义属性键值行（TradeGoods.attributes 受控袋，spec 决策 #8：不进字段投影，
 *  由本键值编辑区承载录入；上限与注册表写入边界一致 32 条）。 */
interface KvRow { key: string; value: string }
const ATTRIBUTES_CAP = 32;

const asString = (v: unknown): string => (v == null ? '' : String(v));

/** 主数据登记/变更抽屉（商品/交易对手/内部组织）：字段由注册表反射投影驱动，
 *  登记经 POST /api/ontology/master-data、变更经 POST /api/ontology/master-data/change
 *  直写台账（主数据非资金事实，不走审批）。 */
export function MasterDataDrawer({ masterType, onClose, onSaved, changeTarget }: Props) {
  const changeMode = changeTarget != null;
  const [values, setValues] = useState<ValueMap>(() => {
    if (!changeTarget) return {};
    // 预填现行值（决策 #7a 整包提交：一条事实=主体在时点上的属性快照）；
    // 收款账号等敏感字段回显脱敏（提交侧识别掩码还原原值）。
    const current = changeTarget.current;
    const prefilled: ValueMap = {};
    for (const f of masterType.fields) {
      const raw = asString(current[f.name]);
      if (raw !== '') prefilled[f.name] = f.name === 'bankAccount' ? maskBankAccount(raw) : raw;
    }
    return prefilled;
  });
  const [attributes, setAttributes] = useState<KvRow[]>(() => {
    if (!changeTarget) return [];
    const bag = changeTarget.current['attributes'];
    if (bag == null || typeof bag !== 'object') return [];
    return Object.entries(bag as Record<string, unknown>)
      .slice(0, ATTRIBUTES_CAP)
      .map(([key, value]) => ({ key, value: asString(value) }));
  });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ kind: 'create'; id: string } | { kind: 'change'; newId: string } | null>(null);
  // 变更生效时间（仅 change 模式；缺省=提交时刻，服务端归一 UTC ISO）。
  const [validAt, setValidAt] = useState('');

  const showAttributes = masterType.name === 'TradeGoods';
  const attributesFull = attributes.length >= ATTRIBUTES_CAP;

  const setValue = (name: string, value: string) => {
    setValues((prev) => ({ ...prev, [name]: value }));
    setFieldErrors((prev) => {
      if (!(name in prev)) return prev;
      const next = { ...prev };
      delete next[name];
      return next;
    });
  };

  const setKvRow = (idx: number, patch: Partial<KvRow>) => {
    setAttributes((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  };
  const addKvRow = () => {
    if (attributesFull) return;
    setAttributes((prev) => [...prev, { key: '', value: '' }]);
  };
  const removeKvRow = (idx: number) => {
    setAttributes((prev) => prev.filter((_, i) => i !== idx));
  };

  const buildAttributes = (): { ok: true; attributes: Record<string, string> | null } | { ok: false; error: string } => {
    if (!showAttributes) return { ok: true, attributes: null };
    const bag: Record<string, string> = {};
    for (const row of attributes) {
      const k = row.key.trim();
      if (k === '') continue; // 空键行剔除（与选填字段空值剔除同惯例）
      if (k in bag) return { ok: false, error: `自定义属性键重复：${k}` };
      bag[k] = row.value.trim();
    }
    return { ok: true, attributes: Object.keys(bag).length > 0 ? bag : null };
  };

  const buildPayload = (): { ok: true; payload: Record<string, string | number | Record<string, string>> } | { ok: false; error: string } => {
    const payload: Record<string, string | number | Record<string, string>> = {};
    for (const f of masterType.fields) {
      const raw = (values[f.name] ?? '').trim();
      if (raw === '') {
        if (f.required && !(changeMode && f.name === 'uscc')) {
          // change 模式 uscc 预填且禁改（readonly input 无值即数据异常，仍走服务端校验兜底）
          return { ok: false, error: `必填字段为空：${f.description || f.name}` };
        }
        continue;
      }
      if (f.kind === 'number') {
        const n = Number(raw);
        if (!Number.isFinite(n)) return { ok: false, error: `字段 ${f.name} 必须是数字` };
        payload[f.name] = n;
      } else if (f.name === 'bankAccount') {
        // 脱敏回显未被修改 -> 还原原始值提交（掩码串绝不能入库）
        const original = changeTarget ? asString(changeTarget.current['bankAccount']) : '';
        payload[f.name] = changeTarget && raw === maskBankAccount(original) ? original : raw;
      } else {
        payload[f.name] = raw;
      }
    }
    const attrs = buildAttributes();
    if (!attrs.ok) return attrs;
    if (attrs.attributes) payload['attributes'] = attrs.attributes;
    return { ok: true, payload };
  };

  const onSubmit = async () => {
    setSubmitError(null);
    setFieldErrors({});
    setFormErrors([]);
    const built = buildPayload();
    if (!built.ok) {
      setSubmitError(built.error);
      return;
    }
    setSubmitting(true);
    try {
      if (changeTarget) {
        const res = await changeMasterData({
          prevFactId: changeTarget.prevFactId,
          payload: built.payload,
          ...(validAt.trim() !== '' ? { validAt: validAt.trim() } : {}),
        });
        setResult({ kind: 'change', newId: res.newId });
      } else {
        const res = await submitMasterData({ entityType: masterType.name, ...built.payload });
        setResult({ kind: 'create', id: res.id });
      }
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

  const headerText = useMemo(
    () => (changeMode ? `变更${masterType.label}` : `登记${masterType.label}`),
    [changeMode, masterType.label],
  );

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" role="dialog" aria-modal="true">
      <div className="flex h-full w-[520px] max-w-[90vw] flex-col bg-white shadow-lg">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <div>
            <div className="text-sm font-medium text-ink">{headerText}</div>
            <div className="mt-0.5 text-xs leading-5 text-ink-soft">
              {changeMode
                ? '变更=同主体新事实+旧信息失效（supersede）：名称史与属性史在时间线留痕。'
                : masterType.description}
            </div>
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
              const readonly = changeMode && f.name === 'uscc';
              return (
                <div key={f.name}>
                  <label className="mb-1 flex items-baseline gap-1 text-xs font-medium text-ink-soft" htmlFor={`mf-${f.name}`}>
                    {f.name}
                    {f.required && <span className="text-danger">必填</span>}
                    {readonly && <span className="text-ink-soft/70">（主体锚不可变更）</span>}
                  </label>
                  <input
                    id={`mf-${f.name}`}
                    type={f.kind === 'number' ? 'number' : 'text'}
                    step={f.kind === 'number' ? 'any' : undefined}
                    value={value}
                    readOnly={readonly}
                    disabled={readonly}
                    onChange={(e) => setValue(f.name, e.target.value)}
                    className={clsx(
                      'h-8 w-full rounded border bg-white px-2 text-sm text-ink placeholder:text-ink-soft/60 focus:outline-none focus:ring-1 focus:ring-primary/40',
                      errors.length ? 'border-danger' : 'border-line',
                      readonly && 'bg-surface/60 text-ink-soft',
                    )}
                  />
                  <div className="mt-0.5 text-xs text-ink-soft/80">
                    {f.name === 'bankAccount' && value !== '' ? '敏感信息脱敏回显；未修改则提交原值，修改则替换。' : f.description}
                  </div>
                  {errors.map((msg) => (
                    <div key={msg} className="mt-0.5 text-xs text-danger">{msg}</div>
                  ))}
                </div>
              );
            })}

            {showAttributes && (
              <div>
                <div className="mb-1 flex items-baseline gap-2 text-xs font-medium text-ink-soft">
                  自定义属性（attributes 键值袋，选填）
                  <span className="font-normal text-ink-soft/70">{attributes.length}/{ATTRIBUTES_CAP} 条</span>
                </div>
                <div className="space-y-1.5">
                  {attributes.map((row, idx) => (
                    <div key={idx} className="flex items-center gap-1.5">
                      <input
                        type="text"
                        value={row.key}
                        placeholder="键（如 牌号）"
                        aria-label={`属性键 ${idx + 1}`}
                        onChange={(e) => setKvRow(idx, { key: e.target.value })}
                        className="h-8 w-2/5 rounded border border-line bg-white px-2 text-sm text-ink placeholder:text-ink-soft/60 focus:outline-none focus:ring-1 focus:ring-primary/40"
                      />
                      <input
                        type="text"
                        value={row.value}
                        placeholder="值"
                        aria-label={`属性值 ${idx + 1}`}
                        onChange={(e) => setKvRow(idx, { value: e.target.value })}
                        className="h-8 min-w-0 flex-1 rounded border border-line bg-white px-2 text-sm text-ink placeholder:text-ink-soft/60 focus:outline-none focus:ring-1 focus:ring-primary/40"
                      />
                      <button
                        type="button"
                        onClick={() => removeKvRow(idx)}
                        aria-label={`删除属性 ${idx + 1}`}
                        className="rounded border border-line px-1.5 py-1 text-xs text-ink-soft transition-colors hover:border-danger/40 hover:text-danger"
                      >
                        删
                      </button>
                    </div>
                  ))}
                </div>
                <div className="mt-1.5 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={addKvRow}
                    disabled={attributesFull}
                    className="rounded border border-line px-2 py-1 text-xs text-ink-soft transition-colors hover:border-primary/40 hover:text-primary disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    加一条
                  </button>
                  {attributesFull && <span className="text-xs text-danger">最多 {ATTRIBUTES_CAP} 条</span>}
                </div>
                <div className="mt-0.5 text-xs text-ink-soft/80">
                  品类异构属性（钢材牌号/煤炭发热量等）自由键值；键非空不超过 40 字，最多 {ATTRIBUTES_CAP} 条。
                </div>
              </div>
            )}

            {changeMode && (
              <div>
                <label className="mb-1 flex items-baseline gap-1 text-xs font-medium text-ink-soft" htmlFor="mf-validAt">
                  变更生效时间（选填，缺省=提交时刻）
                </label>
                <input
                  id="mf-validAt"
                  type="date"
                  value={validAt}
                  onChange={(e) => setValidAt(e.target.value)}
                  className="h-8 w-full rounded border border-line bg-white px-2 text-sm text-ink focus:outline-none focus:ring-1 focus:ring-primary/40"
                />
              </div>
            )}
          </div>

          {result && (
            <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
              {result.kind === 'change' ? (
                <>
                  <div>变更已提交：新信息生效，旧信息已失效（supersede 换代）。</div>
                  <div className="mt-1 text-xs">新记录 ID：<span className="font-mono">{result.newId}</span></div>
                  <div className="mt-1 text-xs">台账按统一社会信用代码归一，名称史见详情时间线。</div>
                </>
              ) : (
                <>
                  <div>登记成功，{masterType.label}已写入台账。</div>
                  <div className="mt-1 text-xs">记录 ID：<span className="font-mono">{result.id}</span></div>
                  <div className="mt-1 text-xs">关闭本抽屉即可在列表中看到新记录。</div>
                </>
              )}
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
            {submitting ? '提交中...' : changeMode ? '提交变更' : '登记'}
          </button>
          <span className="text-xs text-ink-soft">
            {changeMode
              ? '整包提交：留空字段不会带入新快照；uscc 必须与现行事实一致。'
              : '字段组合由本体注册表校验；来源标注 manual，写入后台账即时可见。'}
          </span>
        </div>
      </div>
    </div>
  );
}
