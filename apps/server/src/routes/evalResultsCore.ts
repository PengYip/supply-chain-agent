// apps/server/src/routes/evalResultsCore.ts
// 评估结果只读查看器的解析/聚合核心 (spec: 2026-08-15-eval-results-viewer §4)。
// 纯函数 + 显式根目录注入, 便于 hermetic 测试。注意: src/ 不得 import eval/**
// (tsconfig rootDir 约束), 故此处定义 JSONL 的结构镜像类型。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

// ---- JSONL 结构镜像 (与 eval/agent/types.ts 字段逐一对应, 仅声明消费的字段) ----

export interface UsageJson { inputTokens: number; outputTokens: number; totalTokens: number; }

export interface ArtifactJson {
  scenarioId: string; runIndex: number; sessionId: string; startedAt: string;
  wallMs: number; turnsUsed: number;
  transcript: Array<{ role: string; text: string }>;
  toolCalls: Array<{ toolName: string; args: unknown; result: unknown; durationMs: number }>;
  approvals: Array<{ id: string; level: string; toolName: string; input: unknown; decision: string; reason: string; matchedRule?: string }>;
  finalAssistantText: string;
  totalUsage: UsageJson;
  simError?: string;
}

export interface ScoreJson {
  scenarioId: string; runIndex: number; verdict: string;
  verifierFailures: Array<{ check: string; detail: string }>;
  judge: { ok: boolean; dimensions: Array<{ name: string; weight: string; score: number; rationale: string }>; vetoTriggered: boolean; confidence: number } | null;
  rubricScore: number | null;
  vetoTriggered: boolean;
  firstFailure: { check: string; detail: string } | null;
}

export interface EpisodePair { artifact: ArtifactJson; score: ScoreJson; }

// ---- API 视图模型 (spec §4.1 / §4.2) ----

export interface EvalScenarioRow {
  scenarioId: string;
  tier: number | null;
  verdicts: string[];
  passAt1: boolean;
  passConsecutiveK: boolean;
  avgRubricScore: number | null;
  totalTokens: number;
  avgWallMs: number;
}

export interface EvalRunSummary {
  runId: string;
  startedAt: string | null;
  dataset: string;
  episodeCount: number;
  runsPerScenario: number;
  verdictDist: Record<string, number>;
  totalTokens: number;
  totalWallMs: number;
  scenarios: EvalScenarioRow[];
}

export type TranscriptSegment = { kind: 'text'; role: 'user' | 'assistant' | 'system'; content: string };

export interface EvalEpisodeView {
  scenarioId: string;
  runIndex: number;
  verdict: string;
  vetoTriggered: boolean;
  rubricScore: number | null;
  judgeConfidence: number | null;
  judgeDimensions: Array<{ name: string; weight: string; score: number; rationale: string }>;
  verifierFailures: Array<{ check: string; detail: string }>;
  simError: string | null;
  approvals: Array<{ toolName: string; level: string; decision: string; matchedRule: string | null; reason: string }>;
  toolCalls: Array<{ toolName: string; args: unknown; result: unknown; durationMs: number | null }>;
  totalUsage: UsageJson;
  wallMs: number;
  turnsUsed: number;
  transcript: TranscriptSegment[];
}

// ---- 解析 ----

const RUN_ID_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-(.+)$/;

export function parseRunId(runId: string): { startedAt: string | null; dataset: string } {
  const m = RUN_ID_RE.exec(runId);
  if (!m) return { startedAt: null, dataset: runId };
  const [, d, h, min, s, ms, ds] = m;
  return { startedAt: `${d}T${h}:${min}:${s}.${ms}Z`, dataset: ds! };
}

function isPair(v: unknown): v is EpisodePair {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return !!o.artifact && !!o.score
    && typeof (o.artifact as Record<string, unknown>).scenarioId === 'string'
    && typeof (o.score as Record<string, unknown>).verdict === 'string';
}

export function parseEpisodesFile(text: string): { pairs: EpisodePair[]; droppedLines: number } {
  const pairs: EpisodePair[] = [];
  let droppedLines = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isPair(parsed)) pairs.push(parsed);
      else droppedLines++;
    } catch {
      droppedLines++;
    }
  }
  return { pairs, droppedLines };
}

export function loadTierMap(datasetsRoot: string, dataset: string): Map<string, number> {
  const map = new Map<string, number>();
  const file = join(datasetsRoot, `${dataset}.yaml`);
  if (!existsSync(file)) return map;
  try {
    const doc = parseYaml(readFileSync(file, 'utf-8')) as
      | { scenarios?: Array<{ id?: unknown; tier?: unknown }> }
      | null;
    for (const s of doc?.scenarios ?? []) {
      if (typeof s?.id === 'string' && (s.tier === 1 || s.tier === 2 || s.tier === 3)) {
        map.set(s.id, s.tier);
      }
    }
  } catch {
    // 数据集解析失败降级为无 tier (spec: 评估结果与数据集版本可能已分离)
  }
  return map;
}

// ---- 聚合 ----

export function listRuns(resultsRoot: string): EvalRunSummary[] {
  const out: EvalRunSummary[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(resultsRoot).filter((e) => {
      try {
        return statSync(join(resultsRoot, e)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return []; // results 根不存在 → 空列表
  }
  const datasetsRoot = resolve(resultsRoot, '../datasets');
  for (const runId of entries) {
    const episodesPath = join(resultsRoot, runId, 'episodes.jsonl');
    if (!existsSync(episodesPath)) continue;
    let text: string;
    try {
      text = readFileSync(episodesPath, 'utf-8');
    } catch {
      continue;
    }
    const { pairs } = parseEpisodesFile(text);
    if (pairs.length === 0) continue;
    out.push(summarizeRun(runId, pairs, loadTierMap(datasetsRoot, parseRunId(runId).dataset)));
  }
  out.sort((a, b) => (a.runId < b.runId ? 1 : -1)); // stamp 字典序 = 时间倒序
  return out;
}

function summarizeRun(runId: string, pairs: EpisodePair[], tierMap: Map<string, number>): EvalRunSummary {
  const { startedAt, dataset } = parseRunId(runId);
  const verdictDist: Record<string, number> = {};
  let totalTokens = 0;
  let totalWallMs = 0;
  const byId = new Map<string, EpisodePair[]>();
  for (const p of pairs) {
    verdictDist[p.score.verdict] = (verdictDist[p.score.verdict] ?? 0) + 1;
    totalTokens += p.artifact.totalUsage?.totalTokens ?? 0;
    totalWallMs += p.artifact.wallMs ?? 0;
    const list = byId.get(p.artifact.scenarioId) ?? [];
    list.push(p);
    byId.set(p.artifact.scenarioId, list);
  }
  const runsPerScenario = Math.max(...[...byId.values()].map((l) => l.length));
  const scenarios: EvalScenarioRow[] = [...byId.entries()].map(([scenarioId, list]) => {
    list.sort((a, b) => a.artifact.runIndex - b.artifact.runIndex);
    const verdicts = list.map((p) => p.score.verdict);
    const scored = list.filter((p) => p.score.rubricScore != null);
    const tokens = list.reduce((t, p) => t + (p.artifact.totalUsage?.totalTokens ?? 0), 0);
    return {
      scenarioId,
      tier: tierMap.get(scenarioId) ?? null,
      verdicts,
      passAt1: verdicts[0] === 'pass',
      passConsecutiveK: verdicts.length === runsPerScenario && verdicts.every((v) => v === 'pass'),
      avgRubricScore: scored.length ? scored.reduce((t, p) => t + p.score.rubricScore!, 0) / scored.length : null,
      totalTokens: tokens,
      avgWallMs: list.reduce((t, p) => t + (p.artifact.wallMs ?? 0), 0) / list.length,
    };
  });
  return { runId, startedAt, dataset, episodeCount: pairs.length, runsPerScenario, verdictDist, totalTokens, totalWallMs, scenarios };
}

export function toEpisodeView(pair: EpisodePair): EvalEpisodeView {
  const { artifact: a, score: s } = pair;
  return {
    scenarioId: a.scenarioId,
    runIndex: a.runIndex,
    verdict: s.verdict,
    vetoTriggered: s.vetoTriggered,
    rubricScore: s.rubricScore,
    judgeConfidence: s.judge?.confidence ?? null,
    judgeDimensions: s.judge?.dimensions ?? [],
    verifierFailures: s.verifierFailures ?? [],
    simError: a.simError ?? null,
    approvals: (a.approvals ?? []).map((ap) => ({
      toolName: ap.toolName, level: ap.level, decision: ap.decision,
      matchedRule: ap.matchedRule ?? null, reason: ap.reason,
    })),
    toolCalls: (a.toolCalls ?? []).map((t) => ({
      toolName: t.toolName, args: t.args, result: t.result,
      durationMs: typeof t.durationMs === 'number' ? t.durationMs : null,
    })),
    totalUsage: a.totalUsage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    wallMs: a.wallMs ?? 0,
    turnsUsed: a.turnsUsed ?? 0,
    transcript: (a.transcript ?? [])
      .filter((e) => typeof e?.text === 'string' && e.text.length > 0)
      .map((e) => ({
        kind: 'text' as const,
        role: e.role === 'user' ? ('user' as const) : e.role === 'assistant' ? ('assistant' as const) : ('system' as const),
        content: e.text,
      })),
  };
}

export function defaultResultsRoot(): string {
  // dev: src/routes -> apps/server/eval/agent/results; prod: dist/routes -> 同一位置
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '../../eval/agent/results');
}
