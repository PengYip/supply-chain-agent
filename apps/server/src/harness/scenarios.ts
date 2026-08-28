// Scenario-based tool mounting (tool-inventory methodology 阶段3, 2026-08-28).
//
// The registry builds the full role toolset; activeTools then narrows what the
// MODEL may call for this request to the union of the scenario set + CORE.
// Design rules (docs/tool-design-methodology.md):
//   - CORE rides along in every scenario (retrieval + ledger + human fallback).
//   - Writes live in exactly one scenario each -- a misrouted request degrades
//     to "tool not visible" (the model asks/answers differently) instead of a
//     surprise mutation.
//   - Detection is CONSERVATIVE: no keyword match -> 'all' (no narrowing).
//     Narrowing on a wrong guess is worse than not narrowing.
//   - Scenario visibility is capped by docs/tool-inventory.json
//     policy.maxToolsMountedPerScenario (asserted in toolInventory.test.ts).

export type Scenario = 'entry' | 'qa' | 'settlement';
/** 'all' = detection uncertain -> mount everything, narrow nothing. */
export type ScenarioOrAll = Scenario | 'all';

/** Tools available in EVERY scenario (retrieval/ledger/HITL spine). */
export const SCENARIO_CORE: readonly string[] = [
  'query_business',
  'recall_documents',
  'escalate_to_human',
  'inspect_extraction',
] as const;

const CORE = [...SCENARIO_CORE];

/** 录入态: 单据上传/解析/复核/字段更正/绑定. */
const ENTRY: readonly string[] = [
  ...CORE,
  'ingest_document',
  'extract_fields',
  'present_document_review',
  'update_document_fields',
  'bind_document',
  'list_binding_proposals',
] as const;

/** 问答态: 检索/台账/图谱读 + 关系维护(背靠背/修订是高频对话动作). */
const QA: readonly string[] = [
  ...CORE,
  'graph_query',
  'graph_find_entity',
  'link_entities',
  'link_documents',
  'gather_settlement_evidence',
] as const;

/** 结算态: 取证 -> 计算确认 -> 额度核对. */
const SETTLEMENT: readonly string[] = [
  ...CORE,
  'gather_settlement_evidence',
  'confirm_settlement',
  'manage_quota',
] as const;

export const SCENARIO_TOOLS: Record<Scenario, readonly string[]> = {
  entry: ENTRY,
  qa: QA,
  settlement: SETTLEMENT,
};

const SETTLEMENT_RE = /结算|扣款|额度|对账|质保金|煤款结算|结算单/;
// 录入动词要求带宾语指示(这份/文件/合同...), 避免"系统里都录入了哪些合同"
// 这类枚举问句被误路由到 entry(那是台账问答, 走 query_business)。
const ENTRY_RE = /上传|解析|复核|重新抽取|绑定|纠错|更正字段|打标签?|标注|录入这|录入该|录入一份|录入文件|录入合同|录入发票|录入单据/;
const TEMPLATE_RE = /模板|新增.{0,6}类型|词表/;

/**
 * Conservative scenario router over the CURRENT user message. Returns 'all'
 * (no narrowing) when nothing matches or the message mentions template
 * management -- a false narrowing hides tools the request legitimately needs.
 */
export function detectScenario(lastUserMessage: string): ScenarioOrAll {
  const text = (lastUserMessage ?? '').trim();
  if (text.length === 0) return 'all';
  if (TEMPLATE_RE.test(text)) return 'all';
  if (SETTLEMENT_RE.test(text)) return 'settlement';
  if (ENTRY_RE.test(text)) return 'entry';
  return 'qa';
}

/** Visible tool names for a scenario ('all' -> undefined = no narrowing). */
export function scenarioActiveTools(
  scenario: ScenarioOrAll,
  mounted: readonly string[],
): readonly string[] | undefined {
  if (scenario === 'all') return undefined;
  const allowed = new Set<string>(SCENARIO_TOOLS[scenario]);
  return mounted.filter((n) => allowed.has(n));
}
