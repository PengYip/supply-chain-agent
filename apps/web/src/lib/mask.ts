// 敏感字段展示脱敏（spec 主体身份 §3 边界 b，2026-09-09）：台账字段表、
// 详情抽屉、变更表单回显统一走本 helper——掩码形态固定「前4+****+后4」，
// 变更提交侧据此识别"未修改的掩码值"并还原原始值（见 MasterDataDrawer）。

/** 收款账号等敏感串脱敏：长度 > 8 保留前后各 4 位，否则整体打码；空值原样返回。 */
export function maskBankAccount(value: unknown): string {
  if (typeof value !== 'string' || value === '') return '';
  if (value.length <= 8) return '****';
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}
