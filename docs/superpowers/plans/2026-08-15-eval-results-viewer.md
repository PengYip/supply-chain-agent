# Eval Results Viewer (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 只读评估结果查看器 — 后端 2 个结构化 API (扫描/聚合 results/ JSONL) + 前端三级页面 (运行列表 → 运行报告 → episode 详情)。

**Architecture:** 服务端解析聚合放 `apps/server/src/routes/` (落入 tsc 检查范围, 不 import `eval/**` — tsconfig rootDir 约束, 故定义结构镜像 JSON 类型); 前端零新依赖, App 内视图切换, 状态导航三级页面。`report.md` 不是数据源, 矩阵从 `episodes.jsonl` 重算。

**Tech Stack:** Hono + 现有 requireAuth; React 19 + Tailwind tokens (deepSea/bgGray/borderGray) + clsx + lucide-react + react-markdown; vitest (hermetic)。

**Spec:** `docs/superpowers/specs/2026-08-15-eval-results-viewer-design.md` (已含三处自审修正: transcript 仅文本分段; 挂载对齐 sibling 模式; approvals 含 level)

## Global Constraints

- 无 emoji (repo 约定); 服务端相对导入 `.js` 扩展; zod v3 单参形式 (`z.record(z.string())`)。
- 前端零新依赖; Tailwind 类 + 现有 tokens, 不用内联 style; clsx 条件类; lucide-react 图标; tabular-nums 数字列。
- 测试 hermetic: tmp 目录 fixture, 不触网, 不依赖真实 results/ 与数据集文件。
- 状态色映射 (前后端共用语义): pass→success, fail→danger, veto→danger+VETO 标, needs_human_review→warning, sim_error/judge_error→textGray。
- 每任务本地 commit 于 main, 不 push; 提交信息 `feat(eval-ui): ...` / `test(eval-ui): ...`。
- 验证顺序: build → lint → test (报完成前必须全绿)。
- Windows shell: git CRLF warning 属预期噪音; heredoc 写多行文件时验证写入完整性 (wc -l / 结构检查)。

## File Structure

```
apps/server/src/routes/evalResultsCore.ts   # Task 1: 纯函数解析/聚合 + JSON 镜像类型
apps/server/src/routes/evalResults.ts       # Task 2: Hono 路由 (工厂注入 resultsRoot)
apps/server/src/index.ts                    # Task 2: 挂载 (requireAuth + route)
apps/server/test/routes/evalResultsCore.test.ts  # Task 1 测试
apps/server/test/routes/evalResults.test.ts      # Task 2 测试
apps/web/src/api/eval.ts                    # Task 3: fetch 信封 + 视图类型
apps/web/src/hooks/useEvalRuns.ts           # Task 3
apps/web/src/hooks/useEvalRunEpisodes.ts    # Task 3
apps/web/src/components/eval/EvalWorkbenchView.tsx   # Task 4: 壳 + 三级状态导航
apps/web/src/components/eval/EvalRunsList.tsx        # Task 4
apps/web/src/components/eval/EvalRunReport.tsx       # Task 5
apps/web/src/components/eval/EvalEpisodeDetail.tsx   # Task 6
apps/web/src/components/eval/verdictBadge.tsx        # Task 4: 共享 verdict 徽章/色映射
apps/web/src/App.tsx                        # Task 7: view 切换接线
```

---

### Task 1: 结果解析聚合核心 (纯函数)

**Files:**
- Create: `apps/server/src/routes/evalResultsCore.ts`
- Test: `apps/server/test/routes/evalResultsCore.test.ts`

**Interfaces:**
- Consumes: results/ 目录布局 (`<stamp>-<dataset>/episodes.jsonl`, 每行 `{artifact, score}`), datasets 布局 (`../datasets/<dataset>.yaml`, 顶层 `scenarios:` 数组, 每项含 `id`/`tier`)。结构镜像 eval/agent/types.ts 的 EpisodeArtifact/EpisodeScore (字段名逐一同)。
- Produces (Task 2 依赖, 精确签名):
  - `parseRunId(runId: string): { startedAt: string | null; dataset: string }`
  - `parseEpisodesFile(text: string): { pairs: EpisodePair[]; droppedLines: number }`
  - `loadTierMap(datasetsRoot: string, dataset: string): Map<string, number>`
  - `listRuns(resultsRoot: string): EvalRunSummary[]` (时间倒序; 无 episodes.jsonl 或全损的目录跳过)
  - `toEpisodeView(pair: EpisodePair): EvalEpisodeView`
  - 类型: `EpisodePair`, `EvalRunSummary`, `EvalScenarioRow`, `EvalEpisodeView`, `TranscriptSegment`

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/test/routes/evalResultsCore.test.ts
// Hermetic: tmp 目录 fixture, 不触网。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  parseRunId, parseEpisodesFile, loadTierMap, listRuns, toEpisodeView,
  type EpisodePair,
} from '../../src/routes/evalResultsCore.js';

const artifact = (scenarioId: string, runIndex: number) => ({
  scenarioId, runIndex, sessionId: 's1', startedAt: '2026-08-15T03:00:00.000Z',
  wallMs: 1000 * runIndex, turnsUsed: 3,
  transcript: [
    { role: 'user', text: '查一下订单' },
    { role: 'system-note', text: 'L3 ticket created' },
    { role: 'assistant', text: '已查到' },
  ],
  toolCalls: [{ toolName: 'query_orders', args: { no: 'ORD-2024-0881' }, result: { ok: true }, durationMs: 12 }],
  approvals: [{ id: 'p1', level: 'L3', toolName: 'create_payment', input: {}, decision: 'approved', reason: '财务已审批', matchedRule: undefined }],
  envSnapshot: { payments: [], contractLinked: {} },
  finalAssistantText: '已查到', totalUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
});
const score = (scenarioId: string, runIndex: number, verdict: string, rubricScore: number | null) => ({
  scenarioId, runIndex, verdict,
  verifierFailures: verdict === 'fail' ? [{ check: 'keywordInReply', detail: '缺少关键词' }] : [],
  judge: { ok: true, dimensions: [{ name: '准确性', weight: 'essential', score: 3, rationale: 'ok' }], vetoTriggered: false, confidence: 0.9 },
  rubricScore, vetoTriggered: false, firstFailure: null,
});
const pair = (sid: string, ri: number, v = 'pass', rs: number | null = 3): EpisodePair =>
  ({ artifact: artifact(sid, ri) as EpisodePair['artifact'], score: score(sid, ri, v, rs) as EpisodePair['score'] });

describe('parseRunId', () => {
  it('解析 stamp 与 dataset', () => {
    const r = parseRunId('2026-08-15T03-21-07-123Z-core');
    expect(r.dataset).toBe('core');
    expect(r.startedAt).toBe('2026-08-15T03:21:07.123Z');
  });
  it('无法解析时 startedAt=null, dataset=整个串', () => {
    const r = parseRunId('manual-run');
    expect(r.startedAt).toBeNull();
    expect(r.dataset).toBe('manual-run');
  });
});

describe('parseEpisodesFile', () => {
  it('逐行解析 {artifact, score} 对', () => {
    const text = JSON.stringify(pair('a', 1)) + '\n' + JSON.stringify(pair('a', 2)) + '\n';
    expect(parseEpisodesFile(text).pairs).toHaveLength(2);
  });
  it('损坏行跳过并计数; 缺 artifact/score 核心字段的行也跳过', () => {
    const text = '{not json\n' + JSON.stringify({ artifact: {}, score: {} }) + '\n';
    const r = parseEpisodesFile(text);
    expect(r.pairs).toHaveLength(0);
    expect(r.droppedLines).toBe(2);
  });
});

describe('loadTierMap', () => {
  it('从 yaml 读 id→tier; 文件缺失返回空 map', () => {
    const dir = mkdtempSync(join(tmpdir(), 'evaltier-'));
    writeFileSync(join(dir, 'core.yaml'), 'scenarios:\n  - id: t1-order-status\n    tier: 1\n  - id: t3-pressure-claim\n    tier: 3\n', 'utf-8');
    const m = loadTierMap(dir, 'core');
    expect(m.get('t1-order-status')).toBe(1);
    expect(m.get('t3-pressure-claim')).toBe(3);
    expect(loadTierMap(dir, 'nope')).toEqual(new Map());
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('listRuns + toEpisodeView', () => {
  const root = mkdtempSync(join(tmpdir(), 'evalruns-'));
  const runA = join(root, '2026-08-15T03-00-00-000Z-core');
  const runB = join(root, '2026-08-14T09-00-00-000Z-core');
  const emptyDir = join(root, '2026-08-15T04-00-00-000Z-core');
  mkdirSync(runA); mkdirSync(runB); mkdirSync(emptyDir);
  writeFileSync(join(runA, 'episodes.jsonl'),
    [pair('t1-order-status', 1, 'fail', 2), pair('t1-order-status', 2, 'pass', 3), pair('t3-pressure-claim', 1, 'pass', 4)].map((p) => JSON.stringify(p)).join('\n') + '\n', 'utf-8');
  writeFileSync(join(runB, 'episodes.jsonl'), JSON.stringify(pair('t1-order-status', 1)) + '\n', 'utf-8');
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('时间倒序, 跳过无 episodes.jsonl 的目录, 聚合 verdict 分布与场景行', () => {
    const runs = listRuns(root);
    expect(runs.map((r) => r.runId)).toEqual([ '2026-08-15T03-00-00-000Z-core', '2026-08-14T09-00-00-000Z-core' ]);
    const a = runs[0];
    expect(a.episodeCount).toBe(3);
    expect(a.verdictDist).toEqual({ fail: 1, pass: 2 });
    expect(a.totalTokens).toBe(45);
    const row = a.scenarios.find((s) => s.scenarioId === 't1-order-status')!;
    expect(row.verdicts).toEqual(['fail', 'pass']);
    expect(row.passAt1).toBe(false);
    expect(row.passConsecutiveK).toBe(false); // k=2 (全局 max), fail 起始
    expect(row.avgRubricScore).toBe(2.5);
    expect(row.tier).toBeNull(); // datasets 目录不存在
  });

  it('toEpisodeView: 文本分段映射 system-note→system; 工具/审批独立数组透传', () => {
    const v = toEpisodeView(pair('t1-order-status', 1));
    expect(v.transcript).toEqual([
      { kind: 'text', role: 'user', content: '查一下订单' },
      { kind: 'text', role: 'system', content: 'L3 ticket created' },
      { kind: 'text', role: 'assistant', content: '已查到' },
    ]);
    expect(v.toolCalls).toHaveLength(1);
    expect(v.toolCalls[0].toolName).toBe('query_orders');
    expect(v.approvals[0].level).toBe('L3');
    expect(v.judgeDimensions[0].name).toBe('准确性');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/routes/evalResultsCore.test.ts`
Expected: FAIL — `Cannot find module ... evalResultsCore.js`

- [ ] **Step 3: 实现**

```ts
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
  envSnapshot: unknown;
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
  return { startedAt: `${d}T${h}:${min}:${s}.${ms}Z`, dataset: ds };
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test --workspace apps/server -- test/routes/evalResultsCore.test.ts`
Expected: PASS (7 tests)。再跑全量: `npm test` — 353+7 passed | 18 skipped。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes/evalResultsCore.ts apps/server/test/routes/evalResultsCore.test.ts
git commit -m "feat(eval-ui): results parsing and aggregation core for eval viewer"
```

---

### Task 2: Hono 路由 + 挂载

**Files:**
- Create: `apps/server/src/routes/evalResults.ts`
- Modify: `apps/server/src/index.ts` (requireAuth 块后挂载)
- Test: `apps/server/test/routes/evalResults.test.ts`

**Interfaces:**
- Consumes: Task 1 全部导出; `AuthEnv` (src/lib/auth-middleware.ts:24)。
- Produces: `GET /api/eval/runs` → `{ok:true, data:{runs: EvalRunSummary[]}}`; `GET /api/eval/runs/:runId/episodes` → `{ok:true, data:{episodes: EvalEpisodeView[], droppedLines: number}}`; 404 `{ok:false, error}`; `createEvalResultsRoute(resultsRoot: string)` 工厂。

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/test/routes/evalResults.test.ts
// Hermetic: 工厂注入 tmp results 根; 测试壳直接 set user 绕过 Better Auth。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { AuthEnv } from '../../src/lib/auth-middleware.js';
import { createEvalResultsRoute } from '../../src/routes/evalResults.js';
import type { EpisodePair } from '../../src/routes/evalResultsCore.js';

const pairLine = (sid: string, ri: number, verdict: string) => JSON.stringify({
  artifact: {
    scenarioId: sid, runIndex: ri, sessionId: 's', startedAt: '2026-08-15T00:00:00.000Z',
    wallMs: 100, turnsUsed: 2, transcript: [{ role: 'user', text: 'hi' }],
    toolCalls: [], approvals: [], envSnapshot: {}, finalAssistantText: 'ok',
    totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  },
  score: {
    scenarioId: sid, runIndex: ri, verdict, verifierFailures: [], judge: null,
    rubricScore: null, vetoTriggered: false, firstFailure: null,
  },
} satisfies EpisodePair);

function appWith(root: string, authed = true) {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => { if (authed) c.set('user', { id: 't', email: 't@t.test' }); await next(); });
  app.route('/api/eval', createEvalResultsRoute(root));
  return app;
}

describe('evalResults routes', () => {
  const root = mkdtempSync(join(tmpdir(), 'evalroute-'));
  const runDir = join(root, '2026-08-15T03-00-00-000Z-core');
  mkdirSync(runDir);
  writeFileSync(join(runDir, 'episodes.jsonl'), pairLine('t1-order-status', 1, 'pass') + '\n{broken\n', 'utf-8');
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('GET /runs 返回聚合与信封', async () => {
    const res = await appWith(root).request('/api/eval/runs');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.runs).toHaveLength(1);
    expect(body.data.runs[0].runId).toBe('2026-08-15T03-00-00-000Z-core');
    expect(body.data.runs[0].verdictDist).toEqual({ pass: 1 });
  });

  it('GET /runs/:runId/episodes 返回视图与 droppedLines', async () => {
    const res = await appWith(root).request('/api/eval/runs/2026-08-15T03-00-00-000Z-core/episodes');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.episodes).toHaveLength(1);
    expect(body.data.episodes[0].transcript[0]).toEqual({ kind: 'text', role: 'user', content: 'hi' });
    expect(body.data.droppedLines).toBe(1);
  });

  it('未知 runId 404', async () => {
    const res = await appWith(root).request('/api/eval/runs/nope/episodes');
    expect(res.status).toBe(404);
    expect((await res.json()).ok).toBe(false);
  });

  it('空 results 根返回空列表而非报错', async () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), 'evalempty-'));
    try {
      const res = await appWith(emptyRoot).request('/api/eval/runs');
      expect(res.status).toBe(200);
      expect((await res.json()).data.runs).toEqual([]);
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/routes/evalResults.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 实现路由 + index.ts 挂载**

```ts
// apps/server/src/routes/evalResults.ts
// 评估结果只读 API (spec §4.2/§4.3)。工厂注入 resultsRoot; requireAuth 由
// index.ts 统一门控 (对齐 sessions/files/review 模式)。
import { Hono } from 'hono';
import type { AuthEnv } from '../lib/auth-middleware.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listRuns, parseEpisodesFile, toEpisodeView, defaultResultsRoot } from './evalResultsCore.js';

export function createEvalResultsRoute(resultsRoot: string = defaultResultsRoot()) {
  const evalResultsRoute = new Hono<AuthEnv>();

  evalResultsRoute.get('/runs', (c) => {
    return c.json({ ok: true, data: { runs: listRuns(resultsRoot) } });
  });

  evalResultsRoute.get('/runs/:runId/episodes', (c) => {
    const runId = c.req.param('runId');
    const episodesPath = join(resultsRoot, runId, 'episodes.jsonl');
    // runId 来自路径参数, 直接拼 join 有目录穿越风险, 只允许目录名字符集。
    if (!/^[\w.-]+$/.test(runId) || !existsSync(episodesPath)) {
      return c.json({ ok: false, error: 'run 不存在' }, 404);
    }
    const { pairs, droppedLines } = parseEpisodesFile(readFileSync(episodesPath, 'utf-8'));
    const episodes = pairs
      .slice()
      .sort((a, b) => a.artifact.scenarioId.localeCompare(b.artifact.scenarioId) || a.artifact.runIndex - b.artifact.runIndex)
      .map(toEpisodeView);
    return c.json({ ok: true, data: { episodes, droppedLines } });
  });

  return evalResultsRoute;
}
```

`apps/server/src/index.ts` 修改 (两处, 精确插入点):

(a) import 区, `import { reviewRoute } from './routes/review.js';` 之后加:
```ts
import { createEvalResultsRoute } from './routes/evalResults.js';
```

(b) `app.use('/api/documents/*', requireAuth);` 之后加一行同组门控:
```ts
app.use('/api/eval/*', requireAuth);
```
并在 `app.route('/api/documents', reviewRoute);` 之后挂载:
```ts
// Eval results viewer (read-only): scan/aggregate CLI-written results dirs.
app.route('/api/eval', createEvalResultsRoute());
```

- [ ] **Step 4: 跑测试 + 全量验证**

Run: `npm test --workspace apps/server -- test/routes/evalResults.test.ts` → PASS (4 tests)
Run: `npm run build && npm run lint && npm test` → 全绿 (365 passed | 18 skipped 量级)。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes/evalResults.ts apps/server/src/index.ts apps/server/test/routes/evalResults.test.ts
git commit -m "feat(eval-ui): read-only eval results api with requireAuth gating"
```

---

### Task 3: 前端 API 层与 hooks

**Files:**
- Create: `apps/web/src/api/eval.ts`, `apps/web/src/hooks/useEvalRuns.ts`, `apps/web/src/hooks/useEvalRunEpisodes.ts`

**Interfaces:**
- Consumes: Task 2 的两个端点与 JSON 形状 (字段同 evalResultsCore.ts 视图模型)。
- Produces (Tasks 4-6 依赖):
  - `listEvalRuns(): Promise<EvalRunSummary[]>` / `getEvalRunEpisodes(runId: string): Promise<{ episodes: EvalEpisodeView[]; droppedLines: number }>`
  - `useEvalRuns(): { runs, loading, error, refresh }` / `useEvalRunEpisodes(runId | null): { episodes, droppedLines, loading, error, refresh }`
  - 类型 `EvalRunSummary`, `EvalScenarioRow`, `EvalEpisodeView`, `TranscriptSegment` (与后端字段逐一对应, 前端再导出一次)

- [ ] **Step 1: 实现 api/eval.ts** (无前端测试基建, 本任务以 tsc 编译为验证; 对齐 process.ts 信封模式)

```ts
// apps/web/src/api/eval.ts
/** 评估结果只读 API 客户端 (spec §5.3)。信封/错误处理对齐 api/process.ts。 */

export interface EvalScenarioRow {
  scenarioId: string
  tier: number | null
  verdicts: string[]
  passAt1: boolean
  passConsecutiveK: boolean
  avgRubricScore: number | null
  totalTokens: number
  avgWallMs: number
}

export interface EvalRunSummary {
  runId: string
  startedAt: string | null
  dataset: string
  episodeCount: number
  runsPerScenario: number
  verdictDist: Record<string, number>
  totalTokens: number
  totalWallMs: number
  scenarios: EvalScenarioRow[]
}

export type TranscriptSegment = { kind: 'text'; role: 'user' | 'assistant' | 'system'; content: string }

export interface EvalEpisodeView {
  scenarioId: string
  runIndex: number
  verdict: string
  vetoTriggered: boolean
  rubricScore: number | null
  judgeConfidence: number | null
  judgeDimensions: Array<{ name: string; weight: string; score: number; rationale: string }>
  verifierFailures: Array<{ check: string; detail: string }>
  simError: string | null
  approvals: Array<{ toolName: string; level: string; decision: string; matchedRule: string | null; reason: string }>
  toolCalls: Array<{ toolName: string; args: unknown; result: unknown; durationMs: number | null }>
  totalUsage: { inputTokens: number; outputTokens: number; totalTokens: number }
  wallMs: number
  turnsUsed: number
  transcript: TranscriptSegment[]
}

async function getJson<T>(url: string): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, { credentials: 'include' })
  } catch {
    throw new Error('网络错误，请稍后重试')
  }
  if (!res.ok) {
    let message = `请求失败（${res.status}）`
    try {
      const data = (await res.json()) as { ok?: boolean; error?: string }
      if (data && data.ok === false && typeof data.error === 'string' && data.error) message = data.error
    } catch { /* 非 JSON 响应, 保留状态码消息 */ }
    throw new Error(message)
  }
  let data: unknown
  try {
    data = await res.json()
  } catch {
    throw new Error('响应格式异常')
  }
  const envelope = data as { ok: true; data: T }
  if (!envelope || envelope.ok !== true || envelope.data == null) throw new Error('响应格式异常')
  return envelope.data
}

export async function listEvalRuns(): Promise<EvalRunSummary[]> {
  const data = await getJson<{ runs: EvalRunSummary[] }>('/api/eval/runs')
  return data.runs
}

export async function getEvalRunEpisodes(runId: string): Promise<{ episodes: EvalEpisodeView[]; droppedLines: number }> {
  return getJson<{ episodes: EvalEpisodeView[]; droppedLines: number }>(
    `/api/eval/runs/${encodeURIComponent(runId)}/episodes`,
  )
}
```

- [ ] **Step 2: 实现 hooks** (对齐 useSessions 的 refresh useCallback + mount effect 模式)

```ts
// apps/web/src/hooks/useEvalRuns.ts
import { useCallback, useEffect, useState } from 'react'
import { listEvalRuns, type EvalRunSummary } from '../api/eval'

export function useEvalRuns() {
  const [runs, setRuns] = useState<EvalRunSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setRuns(await listEvalRuns())
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])
  return { runs, loading, error, refresh }
}
```

```ts
// apps/web/src/hooks/useEvalRunEpisodes.ts
import { useCallback, useEffect, useState } from 'react'
import { getEvalRunEpisodes, type EvalEpisodeView } from '../api/eval'

export function useEvalRunEpisodes(runId: string | null) {
  const [episodes, setEpisodes] = useState<EvalEpisodeView[]>([])
  const [droppedLines, setDroppedLines] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!runId) { setEpisodes([]); setDroppedLines(0); return }
    setLoading(true)
    setError(null)
    try {
      const data = await getEvalRunEpisodes(runId)
      setEpisodes(data.episodes)
      setDroppedLines(data.droppedLines)
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [runId])

  useEffect(() => { void refresh() }, [refresh])
  return { episodes, droppedLines, loading, error, refresh }
}
```

- [ ] **Step 3: 编译验证**

Run: `npm run build --workspace apps/web` → tsc + vite 通过。

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/api/eval.ts apps/web/src/hooks/useEvalRuns.ts apps/web/src/hooks/useEvalRunEpisodes.ts
git commit -m "feat(eval-ui): frontend api client and hooks for eval results"
```

---

### Task 4: 工作台壳 + 运行列表页

**Files:**
- Create: `apps/web/src/components/eval/verdictBadge.tsx`, `apps/web/src/components/eval/EvalRunsList.tsx`, `apps/web/src/components/eval/EvalWorkbenchView.tsx`

**Interfaces:**
- Consumes: Task 3 的 `useEvalRuns` + 类型。
- Produces (Tasks 5-7 依赖):
  - `VerdictBadge({ verdict, veto }: { verdict: string; veto?: boolean })` — 全局状态色映射组件
  - `EvalRunsList({ onOpenRun }: { onOpenRun: (runId: string) => void })`
  - `EvalWorkbenchView()` — 内部三级状态 `{page:'runs'} | {page:'report', runId} | {page:'episode', runId, scenarioId, runIndex}`; 场景行点击 → `page:'episode'` (Task 5 的报告页通过 props 回调上抛)。Task 4 本步先渲染 runs 页 + 占位分支, Task 5/6 填充。

- [ ] **Step 1: verdictBadge.tsx** (状态色映射唯一出口, 全局约束)

```tsx
// apps/web/src/components/eval/verdictBadge.tsx
import clsx from 'clsx'
import { ShieldAlert, ShieldCheck, CircleAlert, CircleHelp } from 'lucide-react'

/** verdict -> 视觉类 (全局约束: pass=success, fail/veto=danger, review=warning, 机器故障=灰)。 */
function verdictClass(verdict: string, veto: boolean): string {
  if (veto) return 'bg-danger/15 text-danger border-danger/40 font-semibold'
  switch (verdict) {
    case 'pass': return 'bg-success/10 text-success border-success/25'
    case 'fail': return 'bg-danger/10 text-danger border-danger/25'
    case 'needs_human_review': return 'bg-warning/10 text-warning border-warning/30'
    case 'sim_error':
    case 'judge_error': return 'bg-bgGray text-textGray border-borderGray'
    default: return 'bg-bgGray text-textGray border-borderGray'
  }
}

const VERDICT_LABEL: Record<string, string> = {
  pass: '通过', fail: '失败', veto: '一票否决',
  needs_human_review: '待人工复核', sim_error: '模拟器故障', judge_error: '裁判故障',
}

export function VerdictBadge({ verdict, veto }: { verdict: string; veto?: boolean }) {
  const label = veto ? '一票否决' : (VERDICT_LABEL[verdict] ?? verdict)
  const Icon = verdict === 'pass' && !veto ? ShieldCheck : veto ? ShieldAlert : verdict === 'needs_human_review' ? CircleHelp : CircleAlert
  return (
    <span className={clsx('inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs whitespace-nowrap', verdictClass(verdict, !!veto))}>
      <Icon className="h-3 w-3" aria-hidden />
      {label}
    </span>
  )
}
```

- [ ] **Step 2: EvalRunsList.tsx**

```tsx
// apps/web/src/components/eval/EvalRunsList.tsx
import clsx from 'clsx'
import { ChevronRight, RefreshCw, FlaskConical } from 'lucide-react'
import { useEvalRuns } from '../../hooks/useEvalRuns'

const VERDICT_ORDER = ['pass', 'fail', 'needs_human_review', 'sim_error', 'judge_error'] as const
const VERDICT_BAR: Record<string, string> = {
  pass: 'bg-success', fail: 'bg-danger', needs_human_review: 'bg-warning',
  sim_error: 'bg-textGray/40', judge_error: 'bg-textGray/40',
}
const VERDICT_SHORT: Record<string, string> = {
  pass: '通过', fail: '失败', needs_human_review: '复核',
  sim_error: 'sim故障', judge_error: 'judge故障',
}

function formatTime(iso: string | null, runId: string): string {
  if (!iso) return runId
  try {
    const d = new Date(iso)
    return d.toLocaleString('zh-CN', { hour12: false })
  } catch {
    return runId
  }
}

export function EvalRunsList({ onOpenRun }: { onOpenRun: (runId: string) => void }) {
  const { runs, loading, error, refresh } = useEvalRuns()

  if (loading) {
    return <div className="p-8 text-sm text-textGray">加载中...</div>
  }
  if (error) {
    return (
      <div className="p-8">
        <p className="text-sm text-danger mb-3">{error}</p>
        <button type="button" onClick={() => void refresh()}
          className="inline-flex items-center gap-1.5 rounded border border-borderGray bg-white px-3 py-1.5 text-sm text-deepSea hover:bg-bgGray">
          <RefreshCw className="h-3.5 w-3.5" aria-hidden /> 重试
        </button>
      </div>
    )
  }
  if (runs.length === 0) {
    return (
      <div className="p-8">
        <div className="rounded-lg border border-borderGray bg-white p-6 max-w-xl">
          <div className="flex items-center gap-2 mb-2 text-textDark font-medium">
            <FlaskConical className="h-4 w-4 text-deepSea" aria-hidden /> 还没有评估结果
          </div>
          <p className="text-sm text-textGray mb-3">在服务器上运行一次评估后, 结果会出现在这里。</p>
          <pre className="bg-bgGray rounded p-2 text-xs overflow-auto">npm run eval:agent --workspace apps/server</pre>
        </div>
      </div>
    )
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-base font-medium text-textDark">评估运行</h2>
        <button type="button" onClick={() => void refresh()}
          className="inline-flex items-center gap-1.5 rounded border border-borderGray bg-white px-2.5 py-1 text-xs text-textGray hover:text-deepSea">
          <RefreshCw className="h-3 w-3" aria-hidden /> 刷新
        </button>
      </div>
      <div className="rounded-lg border border-borderGray bg-white overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-bgGray text-left text-xs text-textGray">
            <tr>
              <th className="px-4 py-2 font-medium">开始时间</th>
              <th className="px-4 py-2 font-medium">数据集</th>
              <th className="px-4 py-2 font-medium">Episodes</th>
              <th className="px-4 py-2 font-medium">判定分布</th>
              <th className="px-4 py-2 font-medium text-right">Tokens</th>
              <th className="px-2 py-2" aria-label="操作" />
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => {
              const total = Math.max(1, r.episodeCount)
              return (
                <tr key={r.runId} className="border-t border-borderGray hover:bg-bgGray/60 cursor-pointer" onClick={() => onOpenRun(r.runId)}>
                  <td className="px-4 py-2.5 text-textDark">{formatTime(r.startedAt, r.runId)}</td>
                  <td className="px-4 py-2.5 text-textGray">{r.dataset}</td>
                  <td className="px-4 py-2.5 tabular-nums text-textGray">{r.episodeCount}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <div className="flex h-2 w-32 overflow-hidden rounded" aria-hidden>
                        {VERDICT_ORDER.filter((v) => r.verdictDist[v]).map((v) => (
                          <div key={v} className={clsx('h-full', VERDICT_BAR[v])} style={{ width: `${((r.verdictDist[v] ?? 0) / total) * 100}%` }} />
                        ))}
                      </div>
                      <span className="text-xs text-textGray">
                        {VERDICT_ORDER.filter((v) => r.verdictDist[v]).map((v) => `${VERDICT_SHORT[v]} ${r.verdictDist[v]}`).join(' / ')}
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-2.5 tabular-nums text-right text-textGray">{r.totalTokens.toLocaleString()}</td>
                  <td className="px-2 py-2.5"><ChevronRight className="h-4 w-4 text-textGray" aria-hidden /></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: EvalWorkbenchView.tsx** (壳 + 三级状态; report/episode 分支本任务为占位, Task 5/6 替换)

```tsx
// apps/web/src/components/eval/EvalWorkbenchView.tsx
import { useState } from 'react'
import { EvalRunsList } from './EvalRunsList'

type Page =
  | { page: 'runs' }
  | { page: 'report'; runId: string }
  | { page: 'episode'; runId: string; scenarioId: string; runIndex: number }

export function EvalWorkbenchView() {
  const [nav, setNav] = useState<Page>({ page: 'runs' })
  return (
    <div className="h-full overflow-auto bg-bgGray">
      {nav.page === 'runs' && <EvalRunsList onOpenRun={(runId) => setNav({ page: 'report', runId })} />}
      {nav.page === 'report' && (
        <div className="p-8 text-sm text-textGray">
          报告页 (Task 5) — runId={nav.runId}
          <button type="button" className="ml-2 text-deepSea underline" onClick={() => setNav({ page: 'runs' })}>返回</button>
        </div>
      )}
      {nav.page === 'episode' && (
        <div className="p-8 text-sm text-textGray">episode 页 (Task 6)</div>
      )}
    </div>
  )
}
```

- [ ] **Step 4: 编译验证**

Run: `npm run build --workspace apps/web` → 通过。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/eval/
git commit -m "feat(eval-ui): workbench shell and runs list page"
```

---

### Task 5: 运行报告页

**Files:**
- Create: `apps/web/src/components/eval/EvalRunReport.tsx`
- Modify: `apps/web/src/components/eval/EvalWorkbenchView.tsx` (替换 report 占位分支)

**Interfaces:**
- Consumes: Task 3 `useEvalRunEpisodes` + `EvalRunSummary` 类型; Task 4 `VerdictBadge`; `ReactMarkdown + remarkGfm` 不用于本页 (纯结构化渲染)。
- Produces: `EvalRunReport({ runId, summary, onOpenEpisode, onBack }: { runId: string; summary: EvalRunSummary; onOpenEpisode: (scenarioId: string, runIndex: number) => void; onBack: () => void })`。episode 数据由本页内部 `useEvalRunEpisodes(runId)` 拉取 (报告矩阵行点击 → 场景筛选的 episode 小节内点击 → `onOpenEpisode`)。

- [ ] **Step 1: EvalRunReport.tsx**

```tsx
// apps/web/src/components/eval/EvalRunReport.tsx
import clsx from 'clsx'
import { ArrowLeft, ChevronRight } from 'lucide-react'
import { useState } from 'react'
import type { EvalRunSummary } from '../../api/eval'
import { useEvalRunEpisodes } from '../../hooks/useEvalRunEpisodes'
import { VerdictBadge } from './verdictBadge'

function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`
}

export function EvalRunReport({ runId, summary, onOpenEpisode, onBack }: {
  runId: string
  summary: EvalRunSummary
  onOpenEpisode: (scenarioId: string, runIndex: number) => void
  onBack: () => void
}) {
  const [selected, setSelected] = useState<string | null>(null)
  const { episodes, loading, error } = useEvalRunEpisodes(runId)
  const k = summary.runsPerScenario

  return (
    <div className="p-6 max-w-5xl">
      <div className="flex items-center gap-3 mb-4">
        <button type="button" onClick={onBack}
          className="inline-flex items-center gap-1 text-sm text-deepSea hover:underline">
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> 运行列表
        </button>
        <h2 className="text-base font-medium text-textDark">运行报告</h2>
        <span className="text-xs text-textGray font-mono">{runId}</span>
      </div>

      {/* 汇总卡 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
        <div className="rounded-lg border border-borderGray bg-white p-3">
          <div className="text-xs text-textGray mb-1">判定分布</div>
          <div className="flex flex-wrap gap-1">
            {Object.entries(summary.verdictDist).map(([v, n]) => (
              <span key={v} className="inline-flex items-center gap-1 text-xs text-textDark">
                <VerdictBadge verdict={v} /> <span className="tabular-nums">{n}</span>
              </span>
            ))}
          </div>
        </div>
        <div className="rounded-lg border border-borderGray bg-white p-3">
          <div className="text-xs text-textGray mb-1">Episodes</div>
          <div className="text-lg tabular-nums text-textDark">{summary.episodeCount}</div>
          <div className="text-xs text-textGray">每场景 {k} 轮</div>
        </div>
        <div className="rounded-lg border border-borderGray bg-white p-3">
          <div className="text-xs text-textGray mb-1">总 Tokens</div>
          <div className="text-lg tabular-nums text-textDark">{summary.totalTokens.toLocaleString()}</div>
        </div>
        <div className="rounded-lg border border-borderGray bg-white p-3">
          <div className="text-xs text-textGray mb-1">总耗时</div>
          <div className="text-lg tabular-nums text-textDark">{formatMs(summary.totalWallMs)}</div>
        </div>
      </div>

      {/* 场景矩阵 */}
      <div className="rounded-lg border border-borderGray bg-white overflow-x-auto mb-5">
        <table className="w-full text-sm">
          <thead className="bg-bgGray text-left text-xs text-textGray">
            <tr>
              <th className="px-4 py-2 font-medium">场景</th>
              <th className="px-3 py-2 font-medium">Tier</th>
              <th className="px-3 py-2 font-medium">判定 (按轮)</th>
              <th className="px-3 py-2 font-medium">Pass@{k}</th>
              <th className="px-3 py-2 font-medium">Pass^{k}</th>
              <th className="px-3 py-2 font-medium">均分</th>
              <th className="px-3 py-2 font-medium text-right">Tokens</th>
            </tr>
          </thead>
          <tbody>
            {summary.scenarios.map((s) => (
              <tr key={s.scenarioId}
                className={clsx('border-t border-borderGray cursor-pointer hover:bg-bgGray/60', selected === s.scenarioId && 'bg-bgGray/60')}
                onClick={() => setSelected(selected === s.scenarioId ? null : s.scenarioId)}>
                <td className="px-4 py-2.5 font-mono text-xs text-textDark">{s.scenarioId}</td>
                <td className="px-3 py-2.5">
                  {s.tier == null
                    ? <span className="text-xs text-textGray">-</span>
                    : <span className="inline-block rounded bg-deepSea/10 text-deepSea border border-deepSea/20 px-1.5 py-0.5 text-xs">T{s.tier}</span>}
                </td>
                <td className="px-3 py-2.5">
                  <div className="flex flex-wrap gap-1">
                    {s.verdicts.map((v, i) => <VerdictBadge key={i} verdict={v} />)}
                  </div>
                </td>
                <td className="px-3 py-2.5 text-center">{s.passAt1
                  ? <span className="text-success font-medium">Y</span>
                  : <span className="text-textGray">N</span>}</td>
                <td className="px-3 py-2.5 text-center">{s.passConsecutiveK
                  ? <span className="text-success font-medium">Y</span>
                  : <span className="text-textGray">N</span>}</td>
                <td className="px-3 py-2.5 tabular-nums text-textDark">{s.avgRubricScore == null ? '-' : s.avgRubricScore.toFixed(2)}</td>
                <td className="px-3 py-2.5 tabular-nums text-right text-textGray">{s.totalTokens.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 场景筛选的 episode 列表 */}
      {selected && (
        <div className="rounded-lg border border-borderGray bg-white">
          <div className="px-4 py-2.5 border-b border-borderGray text-sm font-medium text-textDark">
            {selected} — episodes
          </div>
          {loading && <div className="px-4 py-3 text-sm text-textGray">加载中...</div>}
          {error && <div className="px-4 py-3 text-sm text-danger">{error}</div>}
          {!loading && !error && (
            <div className="divide-y divide-borderGray">
              {episodes.filter((e) => e.scenarioId === selected).map((e) => (
                <button type="button" key={`${e.scenarioId}-${e.runIndex}`}
                  onClick={() => onOpenEpisode(e.scenarioId, e.runIndex)}
                  className="w-full flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-bgGray/60 text-left">
                  <span className="text-textGray w-14">第 {e.runIndex} 轮</span>
                  <VerdictBadge verdict={e.verdict} veto={e.vetoTriggered} />
                  <span className="tabular-nums text-textGray text-xs">
                    {e.rubricScore == null ? '' : `均分维度 ${e.rubricScore.toFixed(1)}`}
                  </span>
                  <span className="flex-1" />
                  <ChevronRight className="h-4 w-4 text-textGray" aria-hidden />
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: EvalWorkbenchView.tsx 接线** — report 占位分支替换为真组件。runs 数据在工作台层再持有一份: `const { runs } = useEvalRuns()` 提升到 EvalWorkbenchView, report 分支从 runs 里找 summary; 找不到 (理论不可达) 显示返回链接。episode 分支保持占位。完整替换后的文件:

```tsx
// apps/web/src/components/eval/EvalWorkbenchView.tsx
import { useState } from 'react'
import { EvalRunsList } from './EvalRunsList'
import { EvalRunReport } from './EvalRunReport'
import { useEvalRuns } from '../../hooks/useEvalRuns'

type Page =
  | { page: 'runs' }
  | { page: 'report'; runId: string }
  | { page: 'episode'; runId: string; scenarioId: string; runIndex: number }

export function EvalWorkbenchView() {
  const [nav, setNav] = useState<Page>({ page: 'runs' })
  const { runs } = useEvalRuns()
  const summary = nav.page !== 'runs' ? runs.find((r) => r.runId === nav.runId) : undefined

  return (
    <div className="h-full overflow-auto bg-bgGray">
      {nav.page === 'runs' && <EvalRunsList onOpenRun={(runId) => setNav({ page: 'report', runId })} />}
      {nav.page === 'report' && summary && (
        <EvalRunReport
          runId={nav.runId}
          summary={summary}
          onBack={() => setNav({ page: 'runs' })}
          onOpenEpisode={(scenarioId, runIndex) => setNav({ page: 'episode', runId: nav.runId, scenarioId, runIndex })}
        />
      )}
      {nav.page === 'report' && !summary && (
        <div className="p-8 text-sm text-textGray">运行数据不在列表中, 可能已被清理。
          <button type="button" className="ml-2 text-deepSea underline" onClick={() => setNav({ page: 'runs' })}>返回</button>
        </div>
      )}
      {nav.page === 'episode' && (
        <div className="p-8 text-sm text-textGray">episode 页 (Task 6)</div>
      )}
    </div>
  )
}
```

注意: 这使 runs 列表页与工作台各持一次 useEvalRuns (列表页自己也调了一次)。为避免双拉, 移除 EvalRunsList 内部的 useEvalRuns, 改为 props: `EvalRunsList({ runs, loading, error, onRefresh, onOpenRun })`, 由工作台下发。同步修改 Task 4 的 EvalRunsList 签名与实现 (删除 hook 调用, 顶部 loading/error/空态逻辑保留, 数据来自 props)。

- [ ] **Step 3: 编译验证**

Run: `npm run build --workspace apps/web` → 通过。

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/eval/
git commit -m "feat(eval-ui): run report page with scenario matrix and episode drilldown"
```

---

### Task 6: Episode 详情页

**Files:**
- Create: `apps/web/src/components/eval/EvalEpisodeDetail.tsx`
- Modify: `apps/web/src/components/eval/EvalWorkbenchView.tsx` (替换 episode 占位分支)

**Interfaces:**
- Consumes: Task 3 `useEvalRunEpisodes` + `EvalEpisodeView`; Task 4 `VerdictBadge`; `ReactMarkdown + remarkGfm` (组件映射复制 RealMessageItem.tsx:74-109 的 MarkdownContent 模式 — 由于该组件未导出, 在本文件内新建同构 `MarkdownContent`, 类名逐一对齐)。
- Produces: `EvalEpisodeDetail({ runId, scenarioId, runIndex, onBack }: { runId: string; scenarioId: string; runIndex: number; onBack: () => void })`

- [ ] **Step 1: EvalEpisodeDetail.tsx**

```tsx
// apps/web/src/components/eval/EvalEpisodeDetail.tsx
import clsx from 'clsx'
import { ArrowLeft, Wrench, ShieldCheck } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useEvalRunEpisodes } from '../../hooks/useEvalRunEpisodes'
import { VerdictBadge } from './verdictBadge'

// Markdown 渲染与 RealMessageItem.MarkdownContent 同构 (该组件未导出, 类名对齐)。
const MarkdownContent: React.FC<{ children: string }> = ({ children }) => {
  return (
    <div className="text-sm leading-relaxed text-textDark">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
          strong: ({ children }) => <strong className="font-bold text-textDark">{children}</strong>,
          ul: ({ children }) => <ul className="list-disc pl-5 mb-2">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal pl-5 mb-2">{children}</ol>,
          li: ({ children }) => <li className="mb-0.5">{children}</li>,
          code: ({ children, className }) => {
            const isBlock = className?.includes('language-')
            if (isBlock) {
              return (
                <pre className="bg-bgGray rounded p-2 overflow-auto mb-2">
                  <code className="font-mono text-xs text-textDark bg-transparent">{children}</code>
                </pre>
              )
            }
            return <code className="font-mono text-xs bg-bgGray px-1 py-0.5 rounded text-textDark">{children}</code>
          },
          table: ({ children }) => <table className="w-full text-xs border-collapse border border-borderGray mb-2">{children}</table>,
          thead: ({ children }) => <thead className="bg-bgGray">{children}</thead>,
          th: ({ children }) => <th className="border border-borderGray px-2 py-1 text-left font-medium">{children}</th>,
          td: ({ children }) => <td className="border border-borderGray px-2 py-1">{children}</td>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}

function summarize(v: unknown): string {
  try {
    const s = JSON.stringify(v)
    return s && s.length > 200 ? `${s.slice(0, 200)}...` : (s ?? 'null')
  } catch {
    return String(v)
  }
}

function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`
}

export function EvalEpisodeDetail({ runId, scenarioId, runIndex, onBack }: {
  runId: string
  scenarioId: string
  runIndex: number
  onBack: () => void
}) {
  const { episodes, droppedLines, loading, error } = useEvalRunEpisodes(runId)
  const ep = episodes.find((e) => e.scenarioId === scenarioId && e.runIndex === runIndex)

  return (
    <div className="p-6 max-w-6xl">
      <div className="flex items-center gap-3 mb-4">
        <button type="button" onClick={onBack}
          className="inline-flex items-center gap-1 text-sm text-deepSea hover:underline">
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> 返回报告
        </button>
        <h2 className="text-base font-medium text-textDark font-mono text-sm">{scenarioId} · 第 {runIndex} 轮</h2>
        {droppedLines > 0 && (
          <span className="text-xs text-warning">另有 {droppedLines} 行损坏数据被跳过</span>
        )}
      </div>

      {loading && <div className="text-sm text-textGray">加载中...</div>}
      {error && <div className="text-sm text-danger">{error}</div>}
      {!loading && !error && !ep && <div className="text-sm text-textGray">episode 不存在。</div>}
      {ep && (
        <div className="flex flex-col lg:flex-row gap-4 items-start">
          {/* 左: 聊天列 + 工具/审批卡片区 */}
          <div className="flex-1 min-w-0 space-y-4">
            <div className="rounded-lg border border-borderGray bg-white p-4 space-y-3">
              {ep.transcript.map((seg, i) => {
                if (seg.role === 'system') {
                  return (
                    <div key={i} className="text-center text-xs text-textGray bg-bgGray rounded px-3 py-1.5">{seg.content}</div>
                  )
                }
                const isUser = seg.role === 'user'
                return (
                  <div key={i} className={clsx('flex', isUser ? 'justify-end' : 'justify-start')}>
                    <div className={clsx(
                      'max-w-[85%] rounded-lg px-3.5 py-2',
                      isUser ? 'bg-deepSea text-white' : 'bg-bgGray text-textDark',
                    )}>
                      {isUser ? <div className="text-sm whitespace-pre-wrap">{seg.content}</div> : <MarkdownContent>{seg.content}</MarkdownContent>}
                    </div>
                  </div>
                )
              })}
            </div>

            {ep.toolCalls.length > 0 && (
              <div className="rounded-lg border border-borderGray bg-white">
                <div className="px-4 py-2.5 border-b border-borderGray flex items-center gap-1.5 text-sm font-medium text-textDark">
                  <Wrench className="h-3.5 w-3.5 text-steelBlue" aria-hidden /> 工具调用 ({ep.toolCalls.length})
                </div>
                <div className="divide-y divide-borderGray">
                  {ep.toolCalls.map((t, i) => (
                    <details key={i} className="px-4 py-2">
                      <summary className="cursor-pointer text-sm text-textDark flex items-center gap-2">
                        <span className="font-mono text-xs">{t.toolName}</span>
                        {t.durationMs != null && <span className="text-xs text-textGray tabular-nums">{formatMs(t.durationMs)}</span>}
                      </summary>
                      <div className="mt-2 space-y-1 text-xs">
                        <div><span className="text-textGray">输入: </span><code className="font-mono bg-bgGray rounded px-1">{summarize(t.args)}</code></div>
                        <div><span className="text-textGray">结果: </span><code className="font-mono bg-bgGray rounded px-1">{summarize(t.result)}</code></div>
                      </div>
                    </details>
                  ))}
                </div>
              </div>
            )}

            {ep.approvals.length > 0 && (
              <div className="rounded-lg border border-borderGray bg-white">
                <div className="px-4 py-2.5 border-b border-borderGray flex items-center gap-1.5 text-sm font-medium text-textDark">
                  <ShieldCheck className="h-3.5 w-3.5 text-amber" aria-hidden /> 审批记录 ({ep.approvals.length})
                </div>
                <div className="divide-y divide-borderGray">
                  {ep.approvals.map((ap, i) => (
                    <div key={i} className="px-4 py-2.5 text-sm">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="rounded bg-amber/10 text-amber border border-amber/25 px-1.5 py-0.5 text-xs">{ap.level}</span>
                        <span className="font-mono text-xs text-textDark">{ap.toolName}</span>
                        <span className={clsx('text-xs', ap.decision === 'approved' ? 'text-success' : 'text-danger')}>
                          {ap.decision === 'approved' ? '已批准' : '已拒绝'}
                        </span>
                      </div>
                      <div className="mt-1 text-xs text-textGray">{ap.reason}{ap.matchedRule ? ` (规则: ${ap.matchedRule})` : ''}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* 右: 信息栏 */}
          <div className="w-full lg:w-80 space-y-3 shrink-0">
            <div className="rounded-lg border border-borderGray bg-white p-4">
              <div className="flex items-center gap-2 mb-3">
                <VerdictBadge verdict={ep.verdict} veto={ep.vetoTriggered} />
                <span className="text-xs text-textGray">判定</span>
              </div>
              <dl className="text-xs space-y-1.5">
                <div className="flex justify-between"><dt className="text-textGray">rubric 均分</dt><dd className="tabular-nums text-textDark">{ep.rubricScore == null ? '-' : ep.rubricScore.toFixed(1)}</dd></div>
                <div className="flex justify-between"><dt className="text-textGray">judge 置信度</dt><dd className="tabular-nums text-textDark">{ep.judgeConfidence == null ? '-' : ep.judgeConfidence.toFixed(2)}</dd></div>
                <div className="flex justify-between"><dt className="text-textGray">轮数</dt><dd className="tabular-nums text-textDark">{ep.turnsUsed}</dd></div>
                <div className="flex justify-between"><dt className="text-textGray">耗时</dt><dd className="tabular-nums text-textDark">{formatMs(ep.wallMs)}</dd></div>
                <div className="flex justify-between"><dt className="text-textGray">tokens (in/out)</dt><dd className="tabular-nums text-textDark">{ep.totalUsage.inputTokens}/{ep.totalUsage.outputTokens}</dd></div>
              </dl>
              {ep.simError && (
                <div className="mt-3 rounded border border-danger/25 bg-danger/5 p-2 text-xs text-danger">模拟器故障: {ep.simError}</div>
              )}
            </div>

            {ep.judgeDimensions.length > 0 && (
              <div className="rounded-lg border border-borderGray bg-white p-4">
                <div className="text-xs text-textGray mb-2">Judge 评分</div>
                <div className="space-y-2.5">
                  {ep.judgeDimensions.map((d, i) => (
                    <div key={i}>
                      <div className="flex items-center gap-2 text-sm">
                        <span className="text-textDark">{d.name}</span>
                        <span className="text-xs text-textGray">{d.weight}</span>
                        <span className="flex-1" />
                        <span className={clsx('tabular-nums font-medium', d.score >= 3 ? 'text-success' : d.score === 2 ? 'text-warning' : 'text-danger')}>{d.score}/4</span>
                      </div>
                      <div className="text-xs text-textGray mt-0.5">{d.rationale}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {ep.verifierFailures.length > 0 && (
              <div className="rounded-lg border border-danger/25 bg-danger/5 p-4">
                <div className="text-xs text-danger mb-2">Verifier 失败</div>
                <div className="space-y-2">
                  {ep.verifierFailures.map((f, i) => (
                    <div key={i} className="text-xs">
                      <span className="font-mono text-danger">{f.check}</span>
                      <div className="text-textGray mt-0.5">{f.detail}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: EvalWorkbenchView.tsx episode 分支替换**

占位分支替换为:
```tsx
      {nav.page === 'episode' && summary && (
        <EvalEpisodeDetail
          runId={nav.runId}
          scenarioId={nav.scenarioId}
          runIndex={nav.runIndex}
          onBack={() => setNav({ page: 'report', runId: nav.runId })}
        />
      )}
```
并在文件顶部加 import。episode 分支无 summary 时 (runs 列表刷新后丢失) 沿用 report 的「已被清理」分支条件扩展: `{(nav.page === 'episode' || nav.page === 'report') && !summary && (...)}`。

- [ ] **Step 3: 编译验证**

Run: `npm run build --workspace apps/web` → 通过。

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/eval/
git commit -m "feat(eval-ui): episode detail page with transcript judge and verifier panels"
```

---

### Task 7: App 壳集成 + 全量验证

**Files:**
- Modify: `apps/web/src/App.tsx`

**Interfaces:**
- Consumes: Task 4-6 的 `EvalWorkbenchView`。
- Produces: 顶层 `view: 'chat' | 'eval'` 切换; 验收 = spec §6。

- [ ] **Step 1: App.tsx 修改**

(a) import 区加:
```tsx
import { EvalWorkbenchView } from './components/eval/EvalWorkbenchView';
import { FlaskConical, MessageSquare } from 'lucide-react';
```
(b) 组件内加状态 (与 `filePanelVisible` 相邻):
```tsx
  const [view, setView] = useState<'chat' | 'eval'>('chat');
```
(c) 主 chat 区域的 flex 容器内、`<FilePanel ...>` 之前插入评估视图 (互斥渲染, 保 chat 状态不卸载 — 用条件渲染而非替换):
```tsx
      {view === 'eval' ? (
        <EvalWorkbenchView />
      ) : (
        <div style={{ flex: 1, position: 'relative', minWidth: 0 }}>
          {/* ...原 RealChatView + 文件按钮块整体保持不动... */}
        </div>
      )}
```
即: 将原 `<div style={{ flex: 1, position: 'relative', minWidth: 0 }}>...</div>` 包进条件分支, 内容零改动。
(d) 侧栏上方加切换按钮组 (SessionSidebar 右侧, 主区域之前插一个窄条):
```tsx
      <div className="w-12 shrink-0 border-r border-borderGray bg-white flex flex-col items-center py-3 gap-2">
        <button type="button" title="对话" aria-label="对话" onClick={() => setView('chat')}
          className={clsx('w-9 h-9 rounded-lg flex items-center justify-center', view === 'chat' ? 'bg-deepSea text-white' : 'text-textGray hover:bg-bgGray')}>
          <MessageSquare className="h-5 w-5" aria-hidden />
        </button>
        <button type="button" title="评估" aria-label="评估" onClick={() => setView('eval')}
          className={clsx('w-9 h-9 rounded-lg flex items-center justify-center', view === 'eval' ? 'bg-deepSea text-white' : 'text-textGray hover:bg-bgGray')}>
          <FlaskConical className="h-5 w-5" aria-hidden />
        </button>
      </div>
```
需要 `import clsx from 'clsx'` (App.tsx 目前未引入)。

- [ ] **Step 2: 全量验证 (离线)**

Run: `npm run build && npm run lint && npm test`
Expected: 全绿; 服务端测试 365 passed | 18 skipped 量级; 无新 lint 告警 (lucide `h-4.5` 若不被 Tailwind 识别, 换 `h-4 w-4` / `h-5 w-5`, 不自定义类)。

- [ ] **Step 3: 手动冒烟 (在线, 可选但推荐)**

1. `npm run dev:all` (若 5173 已有前端在跑, 只起 `npm run dev:server`)。
2. 登录 → 左侧新图标条点「评估」→ 运行列表出现既有 run (Task 10 冒烟产物)。
3. 点 run → 报告矩阵 Tier 列显示 1/3 (非 `-`) → 点场景行 → episode 小节 → 点 episode → 轨迹/工具/审批/judge 面板齐全。
4. 未登录 curl `/api/eval/runs` → 401。

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/App.tsx
git commit -m "feat(eval-ui): integrate eval workbench view switch into app shell"
```

---

## Self-Review 记录

- Spec 覆盖: §3 架构 (Task 1-2 后端, 4-7 前端), §4 API 两端点+门控+工厂 (Task 2), §5 三级页面+api/hooks+视觉 (Tasks 3-7), §6 验收 (Task 7 Step 2/3), §7 YAGNI 未越界 (无分页/无自动刷新/无新依赖)。
- 类型一致性: 前后端视图模型字段逐一核对 (Task 1 定义 → Task 2 序列化 → Task 3 前端镜像); `runsPerScenario` 为计划新增字段 (spec §4.1 未列), 用于 Pass@k/Pass^k 列头与 passConsecutiveK 判定, 已在 Task 1 接口中声明。
- 已知决策: EvalRunsList 数据提升到工作台 (Task 5 Step 2) 避免双拉 — Task 4 先内部 hook, Task 5 改 props, 属计划内的两步演进, review 时以 Task 5 终态为准。
- MarkdownContent 在 EvalEpisodeDetail 内复制 (RealMessageItem 未导出) — 类名逐一对齐, 不改 RealMessageItem (避免动生产聊天组件)。
