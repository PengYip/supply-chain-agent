/* ---------- 六向流水跳过原因(主体名单/文档类型回填共用) ---------- */

/** 回填跳过条目: 一条已确认绑定因该原因未生成流水。contractNo 缺省为 null。 */
export interface FlowSkipEntry {
  bindingId: string | null;
  contractNo: string | null;
  reason: 'direction-undeterminable' | 'not-whitelisted' | 'no-confirmed-binding';
}

/** 跳过原因 -> 中文文案(与后端回填逻辑的枚举一一对应)。 */
const FLOW_SKIP_REASON_TEXT: Record<string, string> = {
  'direction-undeterminable': '方向无法判定（名单未命中单方或双侧命中）',
  'not-whitelisted': '该类型不在六向流水白名单内',
  'no-confirmed-binding': '暂无已确认绑定',
};

function asStr(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** 防御性解析 skipped 数组: 旧后端不带该字段或格式非法 -> 空数组(行为不变)。 */
export function normalizeFlowSkips(v: unknown): FlowSkipEntry[] {
  if (!Array.isArray(v)) return [];
  const out: FlowSkipEntry[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const r = raw as Record<string, unknown>;
    const reason = asStr(r.reason);
    if (!reason) continue;
    out.push({
      bindingId: asStr(r.bindingId) || null,
      contractNo: asStr(r.contractNo) || null,
      reason: reason as FlowSkipEntry['reason'],
    });
  }
  return out;
}

/** 跳过条目 -> 一行文案: 有合同号时带 「合同号：」 前缀, 未知原因给兜底话术。 */
function skipLine(entry: FlowSkipEntry): string {
  const text = FLOW_SKIP_REASON_TEXT[entry.reason] ?? `流水未生成（${entry.reason}）`;
  return entry.contractNo ? `· ${entry.contractNo}：${text}` : `· ${text}`;
}

/** toast 用的跳过说明: 引导行 + 逐条原因, 最多列 maxLines 条, 超出以 「……等 N 项」 收尾。 */
export function formatFlowSkipLines(entries: FlowSkipEntry[], maxLines = 3): string[] {
  if (entries.length === 0) return [];
  const lines = [`以下 ${entries.length} 项流水未生成：`];
  lines.push(...entries.slice(0, maxLines).map(skipLine));
  if (entries.length > maxLines) lines.push(`……等 ${entries.length} 项`);
  return lines;
}
