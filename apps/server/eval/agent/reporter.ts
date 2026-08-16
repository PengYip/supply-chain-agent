// apps/server/eval/agent/reporter.ts
// JSONL persistence + Markdown summary (spec section 8). Reports the book's
// dual metrics: Pass@k (capability ceiling) and Pass^k (business reliability).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EpisodeArtifact, EpisodeScore, Scenario } from './types.js';

export function passAtK(scores: EpisodeScore[], k: number): boolean {
  const runs = scores.slice(0, k);
  return runs.length === k && runs.some((s) => s.verdict === 'pass');
}

export function passConsecutiveK(scores: EpisodeScore[], k: number): boolean {
  const runs = scores.slice(0, k);
  return runs.length === k && runs.every((s) => s.verdict === 'pass');
}

export function buildReport(
  scenarios: Scenario[],
  artifacts: EpisodeArtifact[],
  scores: EpisodeScore[],
): string {
  // Matrix rows derive from scores grouped by scenarioId (works even when the
  // scenarios array is empty); scenarios only enrich tier/capability columns.
  const metaById = new Map(scenarios.map((s) => [s.id, s]));
  const ids = [...new Set(scores.map((s) => s.scenarioId))];
  const k = Math.max(1, ...ids.map((id) => scores.filter((x) => x.scenarioId === id).length));
  const lines: string[] = [];
  lines.push('# Agent Eval Report');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Scenarios: ${scenarios.length || ids.length} | Episodes: ${artifacts.length} | Runs/scenario: ${k}`);
  lines.push('');
  lines.push('## Scenario matrix');
  lines.push('');
  lines.push('| Scenario | Tier | Verdicts | Pass@' + k + ' | Pass^' + k + ' | Avg score | Veto |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const id of ids) {
    const ss = scores.filter((x) => x.scenarioId === id).sort((a, b) => a.runIndex - b.runIndex);
    const verdicts = ss.map((x) => x.verdict).join(', ');
    const avg = ss.filter((x) => x.rubricScore != null);
    const avgStr = avg.length ? (avg.reduce((t, x) => t + x.rubricScore!, 0) / avg.length).toFixed(2) : '-';
    const tier = metaById.get(id)?.tier ?? '-';
    lines.push(`| ${id} | ${tier} | ${verdicts} | ${passAtK(ss, k) ? 'Y' : 'N'} | ${passConsecutiveK(ss, k) ? 'Y' : 'N'} | ${avgStr} | ${ss.some((x) => x.vetoTriggered) ? 'TRIGGERED' : '-'} |`);
  }
  lines.push('');
  lines.push('## Failure clustering');
  const failByCheck = new Map<string, number>();
  const failByDim = new Map<string, number>();
  for (const sc of scores) {
    if (sc.verdict === 'pass') continue;
    for (const f of sc.verifierFailures) failByCheck.set(f.check, (failByCheck.get(f.check) ?? 0) + 1);
    if (sc.verdict === 'fail' && sc.judge?.ok) {
      for (const d of sc.judge.dimensions) {
        if (d.score <= 2) failByDim.set(`${d.name}(${d.weight})`, (failByDim.get(`${d.name}(${d.weight})`) ?? 0) + 1);
      }
    }
  }
  lines.push('');
  lines.push('| Failure source | Count |');
  lines.push('|---|---|');
  for (const [check, n] of [...failByCheck.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`| verifier:${check} | ${n} |`);
  }
  for (const [dim, n] of [...failByDim.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`| rubric:${dim} | ${n} |`);
  }
  const judgeErr = scores.filter((x) => x.verdict === 'judge_error').length;
  const simErr = scores.filter((x) => x.verdict === 'sim_error').length;
  const review = scores.filter((x) => x.verdict === 'needs_human_review').length;
  if (judgeErr || simErr || review) {
    lines.push('');
    lines.push(`Infra noise: judge_error=${judgeErr} sim_error=${simErr} needs_human_review=${review}`);
  }
  lines.push('');
  lines.push('## Cost');
  const totalTokens = artifacts.reduce((t, a) => t + a.totalUsage.totalTokens, 0);
  const totalMs = artifacts.reduce((t, a) => t + a.wallMs, 0);
  const inT = artifacts.reduce((t, a) => t + a.totalUsage.inputTokens, 0);
  const outT = artifacts.reduce((t, a) => t + a.totalUsage.outputTokens, 0);
  const tools = artifacts.reduce((t, a) => t + a.toolCalls.length, 0);
  lines.push(`Total tokens: ${totalTokens} (in ${inT} / out ${outT}); wall ${totalMs}ms; tool calls ${tools}`);
  lines.push('');
  return lines.join('\n');
}

export function writeResults(
  outDir: string,
  artifacts: EpisodeArtifact[],
  scores: EpisodeScore[],
): { episodesPath: string; reportPath: string } {
  mkdirSync(outDir, { recursive: true });
  const episodesPath = join(outDir, 'episodes.jsonl');
  const jsonl = artifacts.map((a, i) => JSON.stringify({ artifact: a, score: scores[i] }));
  writeFileSync(episodesPath, jsonl.join('\n') + (jsonl.length ? '\n' : ''), 'utf-8');
  const reportPath = join(outDir, 'report.md');
  writeFileSync(reportPath, buildReport([], artifacts, scores), 'utf-8');
  return { episodesPath, reportPath };
}
