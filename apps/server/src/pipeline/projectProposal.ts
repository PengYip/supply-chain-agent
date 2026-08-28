// 项目归属自动提议(spec 2026-08-20 §4.2): 合同录入时, 若抽取字段同时给出合同号
// 与项目标识, 提议一条 proposed 会员关系(不写图, 不阻塞录入)。确认(人工/Agent)
// 才是唯一写图入口。
import { type ContractType } from '../domain/tradeSemantics.js';
import { normalizeContractNo } from './contractLedger.js';
import { normalizeName } from '../graph/normalize.js';
import { isEmptyValue } from './fieldValue.js';

export interface ProjectMembershipProposal {
  contractNo: string;   // normalizeContractNo 后
  projectCode: string;  // 编号(大写)或 normalizeName(名称兜底)
  projectName: string;
  role: ContractType | null;
  confidence: number;
}

const CODE_FIELDS = ['项目编号', '项目号'] as const;
const NAME_FIELDS = ['项目名称', '工程名称', '项目'] as const;

export function proposeProjectMemberships(args: {
  docType: string;
  fields: Array<{ name: string; value: string | number; confidence: number }>;
  contractType: ContractType | null;
}): ProjectMembershipProposal[] {
  if (args.docType !== '合同') return [];
  // 空值等同缺失(spec 2026-08-28): 保底补齐产生的空串字段不得参与字段选择,
  // 否则空 编号 会短路 名称 兜底。
  const find = (names: readonly string[]) =>
    names.map((n) => args.fields.find((f) => f.name === n && !isEmptyValue(f.value))).find(Boolean);
  const contractField = args.fields.find(
    (f) => (f.name === '合同号' || f.name === '合同编号') && !isEmptyValue(f.value),
  );
  const codeField = find(CODE_FIELDS);
  const nameField = find(NAME_FIELDS);
  if (!contractField || (!codeField && !nameField)) return [];

  const contractNo = normalizeContractNo(String(contractField.value));
  const projectCode = codeField
    ? String(codeField.value).trim().toUpperCase()
    : normalizeName(String(nameField!.value));
  if (!contractNo || !projectCode) return [];

  const labelField = nameField ?? codeField!;
  const used = [contractField, codeField, nameField].filter(Boolean) as Array<{ confidence: number }>;
  return [{
    contractNo,
    projectCode,
    projectName: String(labelField.value).trim() || projectCode,
    role: args.contractType,
    confidence: Math.min(...used.map((f) => f.confidence)),
  }];
}
