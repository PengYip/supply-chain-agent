/** 合同台账写路径 API 客户端(business-loop Wave 7)。请求/错误处理对齐 api/projects.ts:
 *  中文错误码映射 + credentials include。只封装 PATCH /api/contracts/:no/type。 */

/** 受控六值(与后端 TRADE_VOCAB.contractTypes 白名单一致)。修正入口只允许从这里
 *  选, 禁自由文本 —— '购销合同' 等无方向语义的歧义值从入口就进不来。 */
export const CONTRACT_TYPE_OPTIONS = ['采购', '销售', '物流', '租赁', '服务', '其他'] as const;
export type ContractTypeOption = (typeof CONTRACT_TYPE_OPTIONS)[number];

export function isControlledContractType(v: string | null | undefined): v is ContractTypeOption {
  return v != null && (CONTRACT_TYPE_OPTIONS as readonly string[]).includes(v);
}

/** PATCH /api/contracts/:no/type 200 响应(与 server routes/contracts.ts 一致)。
 *  refreshedDocuments 语义 = 重建流水的文档数(张/单据), 不是流水条数。
 *  refreshedFlows 为同名遗留别名(deprecated, 同值, 供旧服务端/旧消费兼容)。
 *  @deprecated refreshedFlows —— 单位同样=文档张数, 新消费方用 refreshedDocuments。 */
export interface ContractTypeChangeResult {
  ok: boolean;
  contractNo: string;
  contractType: string;
  refreshedDocuments: number;
  /** @deprecated 同 refreshedDocuments 值(单位=文档张数), 遗留别名。 */
  refreshedFlows: number;
  failed: number;
  skipped: Array<{ bindingId: string | null; contractNo: string | null; reason: string }>;
}

/** 服务端错误码 -> 中文文案。 */
const CONTRACT_ERROR_TEXT: Record<string, string> = {
  invalid_body: '请求参数错误，请重试',
  invalid_contract_type: '合同类型只能从：采购 / 销售 / 物流 / 租赁 / 服务 / 其他 中选择',
  contract_not_found: '未找到可修正的合同台账行',
};

export async function patchContractType(
  contractNo: string,
  contractType: ContractTypeOption,
): Promise<ContractTypeChangeResult> {
  let res: Response;
  try {
    res = await fetch(`/api/contracts/${encodeURIComponent(contractNo)}/type`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contractType }),
    });
  } catch {
    throw new Error('网络错误，请稍后重试');
  }
  if (!res.ok) {
    let message = `请求失败（${res.status}）`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data?.error && CONTRACT_ERROR_TEXT[data.error]) message = CONTRACT_ERROR_TEXT[data.error];
      else if (data?.error) message = data.error;
    } catch {
      /* 非 JSON 响应，保留状态码消息 */
    }
    throw new Error(message);
  }
  let data: Partial<ContractTypeChangeResult> & { error?: unknown };
  try {
    data = (await res.json()) as Partial<ContractTypeChangeResult> & { error?: unknown };
  } catch {
    throw new Error('响应格式异常');
  }
  // 契约上失败走 4xx + error 码; 防御 200 带 ok:false 的异常形状——按错误码映射
  // 给接地文案, 无码按响应异常, 绝不误判成功。
  if (data.ok === false) {
    const code = typeof data.error === 'string' ? data.error : '';
    throw new Error(CONTRACT_ERROR_TEXT[code] ?? '响应异常，请稍后重试');
  }
  return {
    ok: data.ok === true,
    contractNo: typeof data.contractNo === 'string' ? data.contractNo : contractNo,
    contractType: typeof data.contractType === 'string' ? data.contractType : contractType,
    // W8 T4: refreshedDocuments 为主口径; 旧服务端仅返 refreshedFlows -> 互相回退(同部署幂等)。
    refreshedDocuments: typeof data.refreshedDocuments === 'number'
      ? data.refreshedDocuments
      : (typeof data.refreshedFlows === 'number' ? data.refreshedFlows : 0),
    refreshedFlows: typeof data.refreshedFlows === 'number'
      ? data.refreshedFlows
      : (typeof data.refreshedDocuments === 'number' ? data.refreshedDocuments : 0),
    failed: typeof data.failed === 'number' ? data.failed : 0,
    skipped: Array.isArray(data.skipped) ? data.skipped : [],
  };
}
