// apps/server/eval/agent/verifiers.ts
// Deterministic checks over the episode artifact (tau-bench three layers:
// state / tool-sequence / reply-content). These run BEFORE and INDEPENDENT of
// the LLM judge -- a verifier failure vetoes the episode (book Ch6 aggregation
// skeleton: bottom-line items are vetoed by ground truth first).
import type { EpisodeArtifact, VerifierChecks, VerifierFailure } from './types.js';

export interface VerifierResult {
  passed: boolean;
  failures: VerifierFailure[];
}

export function runVerifiers(checks: VerifierChecks, artifact: EpisodeArtifact): VerifierResult {
  const failures: VerifierFailure[] = [];
  const toolNames = artifact.toolCalls.map((t) => t.toolName);
  const reply = artifact.finalAssistantText;

  for (const want of checks.payments) {
    const hit = artifact.envSnapshot.payments.find(
      (p) => p.contractNo === want.contractNo && p.amount === want.amount,
    );
    if (!hit) {
      failures.push({
        check: 'payments',
        detail: `期望存在付款 {contractNo=${want.contractNo}, amount=${want.amount}}, 实际: ${JSON.stringify(artifact.envSnapshot.payments)}`,
      });
    }
  }
  for (const want of checks.paymentsAbsent) {
    const hit = artifact.envSnapshot.payments.find((p) => p.contractNo === want.contractNo);
    if (hit) {
      failures.push({
        check: 'paymentsAbsent',
        detail: `期望不存在 ${want.contractNo} 的付款, 实际存在: ${JSON.stringify(hit)}`,
      });
    }
  }
  for (const want of checks.contractLinked) {
    const linked = artifact.envSnapshot.contractLinked[want.contractNo] ?? [];
    if (!linked.includes(want.documentId)) {
      failures.push({
        check: 'contractLinked',
        detail: `期望合同 ${want.contractNo} 已挂接 ${want.documentId}, 实际: ${JSON.stringify(linked)}`,
      });
    }
  }
  for (const name of checks.mustAppear) {
    if (!toolNames.includes(name)) {
      failures.push({
        check: 'mustAppear',
        detail: `期望出现工具调用 ${name}, 实际调用: ${JSON.stringify(toolNames)}`,
      });
    }
  }
  for (const name of checks.forbidden) {
    if (toolNames.includes(name)) {
      failures.push({ check: 'forbidden', detail: `禁止调用的工具 ${name} 被调用了` });
    }
  }
  for (const kw of checks.keywordInReply) {
    if (!reply.includes(kw)) {
      failures.push({ check: 'keywordInReply', detail: `最终回复缺少关键词 "${kw}"` });
    }
  }
  return { passed: failures.length === 0, failures };
}
