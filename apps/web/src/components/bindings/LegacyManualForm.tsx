import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { ContractOption } from '../../hooks/useBindings';
import { ContractSearchBar } from '../common/ContractSearchBar';

/** 关系类型常用值(对应服务端 bindingRelationFor 映射), 支持自定义。
 *  「引用」用于把合同类型文件挂到合同实体上——绑定链条的第一步。 */
const RELATION_PRESETS = ['引用', '货权转移', '付款', '质检', '凭证'];

const inputCls =
  'mt-1 h-8 w-full rounded-md border border-line bg-white px-2.5 text-[12px] text-ink focus:border-primary focus:outline-none';

interface LegacyManualFormProps {
  contracts: ContractOption[];
  establishedContracts: Set<string>;
  isExecutionDoc: boolean;
  pending: boolean;
  onManualCreate: (p: { contractNo: string; relation: string; note?: string }) => Promise<boolean>;
  onCancel: () => void;
}

/** 旧手动绑定表单(搜索 + RELATION_PRESETS 词表)。行为冻结: 仅作模板上下文
 *  加载失败时的降级模式保留, 不再迭代。 */
export function LegacyManualForm({
  contracts,
  establishedContracts,
  isExecutionDoc,
  pending,
  onManualCreate,
  onCancel,
}: LegacyManualFormProps) {
  const [manualContract, setManualContract] = useState('');
  const [manualRelation, setManualRelation] = useState('');
  const [manualCustomRelation, setManualCustomRelation] = useState('');
  const [manualNote, setManualNote] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const resetManualForm = () => {
    setManualContract('');
    setManualRelation('');
    setManualCustomRelation('');
    setManualNote('');
    setFormError(null);
  };

  const submitManual = async () => {
    const relation = manualRelation === '__custom' ? manualCustomRelation.trim() : manualRelation;
    if (!manualContract) {
      setFormError('请选择合同');
      return;
    }
    if (!relation) {
      setFormError('请选择或输入关系类型');
      return;
    }
    // 业务顺序门禁(2026-08-25): 执行类单据只能绑定到已挂合同文件的合同。
    if (isExecutionDoc && !establishedContracts.has(manualContract)) {
      setFormError('该合同尚未绑定合同类型文件：请先将合同文件绑定到该合同（关系=引用），再绑定执行类单据');
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
      onCancel();
    }
  };

  return (
    <div className="animate-fade-in space-y-3">
      <div>
        <label className="text-[11px] font-medium text-ink-soft">搜索合同</label>
        <ContractSearchBar
          placeholder="按合同编号 / 买方 / 卖方 / 标题搜索"
          idleItems={contracts.slice(0, 20).map((c) => ({
            contractNo: c.contractNo,
            displayContractNo: c.displayContractNo,
            title: c.title,
            buyer: null,
            seller: null,
            docType: c.docType,
            overallConfidence: c.overallConfidence,
            matchedField: 'contractNo' as const,
          }))}
          itemNote={(it) =>
            establishedContracts.has(it.contractNo)
              ? '已挂合同文件'
              : isExecutionDoc
                ? '未挂合同文件（不可选）'
                : '未挂合同文件'
          }
          onSelect={(it) => {
            if (isExecutionDoc && !establishedContracts.has(it.contractNo)) {
              setFormError('执行类单据只能绑定「已挂合同文件」的合同；请先把合同类型文件绑定到该合同（关系选「引用」）');
              return;
            }
            setFormError(null);
            setManualContract(it.contractNo);
          }}
        />
        {manualContract && (
          <div className="mt-1 flex items-center gap-1 text-[11px] text-ink-soft">
            <span className="truncate">
              已选 {contracts.find((c) => c.contractNo === manualContract)?.displayContractNo ?? manualContract}
            </span>
            <button type="button" onClick={() => setManualContract('')} className="text-danger hover:underline">
              清除
            </button>
          </div>
        )}
        {isExecutionDoc && (
          <div className="mt-1 text-[11px] leading-4 text-ink-soft">
            执行类单据只能绑定到「已挂合同文件」的合同；请先把合同类型文件绑定到该合同（关系选「引用」）
          </div>
        )}
      </div>
      <div>
        <label className="text-[11px] font-medium text-ink-soft">关系类型</label>
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
        <label className="text-[11px] font-medium text-ink-soft">备注（选填）</label>
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
          onClick={onCancel}
          className="h-7 rounded-md border border-line bg-white px-3 text-[12px] text-ink-soft hover:bg-surface"
        >
          取消
        </button>
        <button
          type="button"
          onClick={() => void submitManual()}
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