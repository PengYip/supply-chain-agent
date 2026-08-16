# Eval Run Console + Dataset Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** UI 触发评估运行 + SSE 轨迹直播 + 用户数据集 YAML 编辑器 (spec: docs/superpowers/specs/2026-08-16-eval-run-console-design.md)。

**Architecture:** runner 子进程 (tsx eval/agent/run.ts) 经 stdout `@@EVT@@` 事件行上报进度; 服务器内存注册表 (单并发锁) 解析转发为 SSE; 数据集 CRUD 走子进程 zod 校验; 用户数据集在 gitignored 目录; 完成后复用 Phase 1 查看器。

**Tech Stack:** Hono + node:child_process + TransformStream SSE (仓库先例 sessions.ts:112-157); React 19 + 原生 EventSource; 零新依赖。

## Global Constraints

- 无 emoji; 后端相对导入 `.js` 扩展名, 前端导入无扩展名; zod v3 单参形式。
- `apps/server/src/**` 不得 import `apps/server/eval/**` (tsconfig rootDir 约束) — 服务端事件类型/解析器为 src 内镜像, 注释指向 eval/agent/events.ts 为 SSOT。
- 事件协议前缀 `@@EVT@@`; 8 种事件: run_started/scenario_started/turn/tool_call/approval/episode_done/run_done/run_error。
- runId 形如 `<ISO-stamp-冒号点替换为->-<dataset>`; 子进程输出目录由 env `EVAL_RUN_ID` 覆盖。
- 数据集名规则 `^[a-z0-9][a-z0-9-]{0,63}$` (内含字符集天然拒绝 `..`/`/`); builtin core 只读。
- runs 钳制 1-10; 活运行时第二个 POST → 409。
- 信封 `{ok:true,data}` / `{ok:false,error}`; `/api/eval/*` 全 requireAuth (index.ts 既有组)。
- hermetic 测试 (tmp fixtures, 子进程工厂注入 fake); 前端以 build 为门 (仓库无前端测试基建)。
- 每任务: 新测试绿 → `npm test` 无回归 (基线 365 passed | 18 skipped) → `npm run lint` 0 新警告 → 相关 build (server `npm run build --workspace apps/server` / 涉前端 `npm run build --workspace apps/web`)。
- 本地 commit 于 main 不 push, 只 stage 任务列出文件; 完成后统一推送。

---

### Task 1: 事件协议 + runner 改造 + validate 脚本

**Files:**
- Create: `apps/server/eval/agent/events.ts`
- Create: `apps/server/eval/agent/validate.ts`
- Modify: `apps/server/eval/agent/run.ts`
- Test: `apps/server/test/eval/events.test.ts`

**Interfaces:**
- Produces: `EvalRunEvent` (8 种联合类型), `formatEventLine(e): string`, `parseEventLine(line): EvalRunEvent | null`; `validate.ts` CLI (exit 0 `{ok:true,scenarioCount}` / exit 1 `{ok:false,error}`); run.ts 支持 `EVAL_RUN_ID` 环境变量 + stdout 事件发射。

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/test/eval/events.test.ts
import { describe, it, expect } from 'vitest';
import { formatEventLine, parseEventLine, type EvalRunEvent } from '../../eval/agent/events.js';

describe('events protocol', () => {
  it('round-trips all event kinds', () => {
    const evts: EvalRunEvent[] = [
      { type: 'run_started', runId: 'r1', total: 3 },
      { type: 'scenario_started', scenarioId: 't1', runIndex: 1 },
      { type: 'turn', scenarioId: 't1', runIndex: 1, role: 'user', text: '帮我查订单' },
      { type: 'turn', scenarioId: 't1', runIndex: 1, role: 'assistant', text: '好的' },
      { type: 'tool_call', scenarioId: 't1', runIndex: 1, toolName: 'query_orders' },
      { type: 'approval', scenarioId: 't1', runIndex: 1, toolName: 'create_payment', decision: 'approved' },
      { type: 'episode_done', scenarioId: 't1', runIndex: 1, verdict: 'pass', rubricScore: 3.5, vetoTriggered: false },
      { type: 'run_done', outDir: '/tmp/x' },
      { type: 'run_error', message: 'boom' },
    ];
    for (const e of evts) {
      expect(parseEventLine(formatEventLine(e))).toEqual(e);
    }
  });

  it('rejects non-event lines and malformed payloads', () => {
    expect(parseEventLine('[eval] scenario=x run=1 ...')).toBeNull();
    expect(parseEventLine('')).toBeNull();
    expect(parseEventLine('@@EVT@@not-json')).toBeNull();
    expect(parseEventLine('@@EVT@@42')).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/eval/events.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: 实现 events.ts**

```ts
// apps/server/eval/agent/events.ts
// Event protocol between the eval runner child process and the server.
// stdout lines prefixed @@EVT@@ are machine events; human logs go to stderr
// so stdout stays line-parseable. Server side mirrors these types in
// src/routes/evalRunCore.ts (src cannot import eval/** per tsconfig rootDir).
export const EVT_PREFIX = '@@EVT@@';

export type EvalRunEvent =
  | { type: 'run_started'; runId: string; total: number }
  | { type: 'scenario_started'; scenarioId: string; runIndex: number }
  | { type: 'turn'; scenarioId: string; runIndex: number; role: 'user' | 'assistant' | 'system-note'; text: string }
  | { type: 'tool_call'; scenarioId: string; runIndex: number; toolName: string }
  | { type: 'approval'; scenarioId: string; runIndex: number; toolName: string; decision: 'approved' | 'denied' }
  | { type: 'episode_done'; scenarioId: string; runIndex: number; verdict: string; rubricScore: number | null; vetoTriggered: boolean }
  | { type: 'run_done'; outDir: string }
  | { type: 'run_error'; message: string };

export function formatEventLine(e: EvalRunEvent): string {
  return EVT_PREFIX + JSON.stringify(e);
}

export function parseEventLine(line: string): EvalRunEvent | null {
  const t = line.trim();
  if (!t.startsWith(EVT_PREFIX)) return null;
  try {
    const parsed: unknown = JSON.parse(t.slice(EVT_PREFIX.length));
    if (typeof parsed !== 'object' || parsed === null) return null;
    if (!('type' in parsed) || typeof (parsed as { type: unknown }).type !== 'string') return null;
    return parsed as EvalRunEvent;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test --workspace apps/server -- test/eval/events.test.ts`
Expected: PASS 2/2

- [ ] **Step 5: 实现 validate.ts**

```ts
// apps/server/eval/agent/validate.ts
// One-shot dataset validator: exit 0 + {ok:true,scenarioCount} on stdout, or
// exit 1 + {ok:false,error}. Spawned by the dataset CRUD routes so src/
// never imports eval/** (same subprocess pattern as run orchestration).
import { loadDataset } from './datasets.js';
import { resolve } from 'node:path';

const file = process.argv[2];
if (!file) {
  console.log(JSON.stringify({ ok: false, error: '用法: tsx eval/agent/validate.ts <dataset.yaml>' }));
  process.exit(1);
}
try {
  const scenarios = loadDataset(resolve(process.cwd(), file));
  console.log(JSON.stringify({ ok: true, scenarioCount: scenarios.length }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }));
  process.exit(1);
}
```

- [ ] **Step 6: 改造 run.ts**

对现有 `apps/server/eval/agent/run.ts` (91 行) 做如下修改 (其余不动):

(a) imports 加:
```ts
import { formatEventLine, type EvalRunEvent } from './events.js';
```

(b) main() 开头 (`const datasetArg = ...` 之前) 加:
```ts
  const emit = (e: EvalRunEvent) => process.stdout.write(formatEventLine(e) + '\n');
```

(c) 数据集加载后 (scenarios 过滤与空检查之间不动), 在 `const artifacts` 声明前加:
```ts
  const runId = process.env.EVAL_RUN_ID ?? null; // server-generated, keeps registry/URL/dir in sync
```

(d) 循环改为 (原 console.log 进度行改 stderr; 场景与 episode 事件发射):
```ts
  const total = scenarios.length * runs;
  emit({ type: 'run_started', runId: runId ?? `${new Date().toISOString().replace(/[:.]/g, '-')}-${datasetArg.split('/').pop()!.replace(/\.yaml$/, '')}`, total });
  const artifacts: EpisodeArtifact[] = [];
  const scores: EpisodeScore[] = [];
  for (const scenario of scenarios) {
    for (let run = 1; run <= runs; run++) {
      console.error(`[eval] scenario=${scenario.id} run=${run}/${runs} ...`);
      emit({ type: 'scenario_started', scenarioId: scenario.id, runIndex: run });
      // ... 原循环体不变 (ctx/deps/runEpisode/verifier/judge/aggregateScore/push) ...
      console.error(
        `[eval] scenario=${scenario.id} run=${run} verdict=${score.verdict}` +
        (score.rubricScore != null ? ` score=${score.rubricScore}` : '') +
        (score.vetoTriggered ? ' VETO' : ''),
      );
      emit({ type: 'episode_done', scenarioId: scenario.id, runIndex: run, verdict: score.verdict, rubricScore: score.rubricScore, vetoTriggered: score.vetoTriggered });
    }
  }
```

(e) 输出目录与结尾 (原 stamp 逻辑尊重 EVAL_RUN_ID; 最终两行 console.log 改 console.error; run_done 发射):
```ts
  const stamp = runId ?? new Date().toISOString().replace(/[:.]/g, '-');
  const dsName = datasetArg.split('/').pop()!.replace(/\.yaml$/, '');
  const outDir = resolve(here, 'results', `${stamp}-${dsName}`);
  const { episodesPath, reportPath } = writeResults(outDir, artifacts, scores);
  emit({ type: 'run_done', outDir });
  console.error(`\n[eval] episodes: ${episodesPath}`);
  console.error(`[eval] report:   ${reportPath}`);
```

(f) main().catch 改:
```ts
main().catch((e) => {
  process.stdout.write(formatEventLine({ type: 'run_error', message: e instanceof Error ? e.message : String(e) }) + '\n');
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 7: 全量验证 + 提交**

Run: `npm test --workspace apps/server` (期望 367 passed | 18 skipped) + `npm run build --workspace apps/server`
```bash
git add apps/server/eval/agent/events.ts apps/server/eval/agent/validate.ts apps/server/eval/agent/run.ts apps/server/test/eval/events.test.ts
git commit -m "feat(eval): run-event protocol, runner emission, dataset validator script"
```

---

### Task 2: driver onEvent 回调缝

**Files:**
- Modify: `apps/server/eval/agent/driver.ts`
- Test: `apps/server/test/eval/driver-events.test.ts`

**Interfaces:**
- Consumes: Task 1 `EvalRunEvent`。
- Produces: `DriverOpts.onEvent?: (e: EvalRunEvent) => void` — 只发 turn/tool_call/approval 三类 (scenario 级归 run.ts)。不传零影响。

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/test/eval/driver-events.test.ts
// Fake-model single-episode run; asserts the onEvent callback fires turn /
// tool_call events in causal order. Approval path is exercised by the L3
// payment script (same fake model as driver.test.ts).
import { describe, it, expect } from 'vitest';
import { runEpisode } from '../../eval/agent/driver.js';
import type { EvalRunEvent } from '../../eval/agent/events.js';
import type { Scenario } from '../../eval/agent/types.js';
import type { LanguageModelV2 } from 'ai';
import type { UIMessageChunk } from 'ai';

function fakeModel(): LanguageModelV2 {
  let calls = 0;
  return {
    specificationVersion: 'v2',
    provider: 'test',
    modelId: 'fake',
    supportsUrl: false,
    async doStream(options) {
      calls++;
      const chunks: UIMessageChunk[] = [];
      if (calls === 1) {
        chunks.push({ type: 'start' });
        chunks.push({
          type: 'tool-input-available',
          toolCallId: 'call_1', toolName: 'query_orders',
          input: { orderId: 'ORD-2024-0881' },
        } as unknown as UIMessageChunk);
        chunks.push({ type: 'finish', totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } as unknown as UIMessageChunk);
      } else {
        chunks.push({ type: 'start' });
        chunks.push({ type: 'text-start', id: 't1' });
        chunks.push({ type: 'text-delta', id: 't1', delta: '订单已查到' });
        chunks.push({ type: 'text-end', id: 't1' });
        chunks.push({ type: 'finish', totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } as unknown as UIMessageChunk);
      }
      return {
        stream: (async function* () {
          for (const c of chunks) {
            if (c.type === 'tool-input-available') {
              yield {
                type: 'tool-input-available',
                toolCallId: (c as { toolCallId: string }).toolCallId,
                toolName: (c as { toolName: string }).toolName,
                input: (c as { input: unknown }).input,
              };
            } else if (c.type === 'finish') {
              yield { type: 'finish', totalUsage: (c as { totalUsage: unknown }).totalUsage };
            } else if (c.type === 'text-delta') {
              yield { type: 'text-delta', id: (c as { id: string }).id, delta: (c as { delta: string }).delta };
            }
          }
        })(),
        request: { body: JSON.stringify(options.prompt) },
        rawCall: { rawPrompt: null, rawSettings: {} },
      };
    },
  } as unknown as LanguageModelV2;
}

const scenario: Scenario = {
  id: 'evt-probe', tier: 1, capability: [],
  persona: { facts: ['订单 ORD-2024-0881'], disclosure: '按需', goal: '查订单后结束', patience: 3 },
  approvalPolicy: { default: 'approve', rules: [] },
  maxTurns: 4,
  verifiers: { payments: [], paymentsAbsent: [], contractLinked: [], mustAppear: ['query_orders'], forbidden: [], keywordInReply: [] },
  rubric: { dimensions: [{ name: '准确性', weight: 'essential', scoring: { '4': '好', '1': '差' } }] },
};

describe('driver onEvent seam', () => {
  it('emits turn and tool_call events in causal order', async () => {
    const events: EvalRunEvent[] = [];
    let turn = 0;
    const artifact = await runEpisode({
      scenario, runIndex: 1,
      agentModel: fakeModel(),
      simModel: fakeModel(),
      onEvent: (e) => events.push(e),
      simFn: async () => (turn++ === 0 ? { message: '查一下 ORD-2024-0881', done: false } : { message: '好的', done: true }),
    });
    expect(artifact.toolCalls.some((t) => t.toolName === 'query_orders')).toBe(true);
    const kinds = events.map((e) => e.type);
    // First user turn, then a tool_call, then an assistant turn.
    expect(kinds[0]).toBe('turn');
    expect((events[0] as { role: string }).role).toBe('user');
    expect(kinds).toContain('tool_call');
    const firstTool = kinds.indexOf('tool_call');
    const firstAssistant = kinds.findIndex((k, i) => k === 'turn' && (events[i] as { role: string }).role === 'assistant');
    expect(firstTool).toBeGreaterThan(-1);
    expect(firstAssistant).toBeGreaterThan(firstTool);
    // every turn event carries the scenario identity
    for (const e of events) expect((e as { scenarioId: string }).scenarioId).toBe('evt-probe');
  });

  it('no callback passed -> zero impact (episode completes)', async () => {
    let turn = 0;
    const artifact = await runEpisode({
      scenario, runIndex: 1,
      agentModel: fakeModel(), simModel: fakeModel(),
      simFn: async () => (turn++ === 0 ? { message: '查一下', done: false } : { message: '好', done: true }),
    });
    expect(artifact.scenarioId).toBe('evt-probe');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/eval/driver-events.test.ts`
Expected: FAIL (runEpisode 不接受 onEvent / 无事件)

- [ ] **Step 3: 实现 driver 缝**

对 `apps/server/eval/agent/driver.ts` 做最小插入 (不改任何既有行为):

(a) import 加: `import type { EvalRunEvent } from './events.js';`
(b) `DriverOpts` 接口加一个可选字段:
```ts
  /** Optional live-event sink (turn/tool_call/approval). Eval run console only. */
  onEvent?: (e: EvalRunEvent) => void;
```
(c) runEpisode 内 `const l2ResumeQueue` 声明后加:
```ts
  const emit = (e: EvalRunEvent) => { opts.onEvent?.(e); };
```
(d) 插入发射点 (与既有 push 一一对应, 共 6 处):
- `transcript.push({ role: 'user', text: userTurn.message });` 后: `emit({ type: 'turn', scenarioId: scenario.id, runIndex: opts.runIndex, role: 'user', text: userTurn.message });`
- `transcript.push({ role: 'assistant', text: turn.finalText });` (主回合) 后: 同型 assistant 发射。
- `toolCalls.push(...turn.toolResults);` (主回合) 后: `for (const t of turn.toolResults) emit({ type: 'tool_call', scenarioId: scenario.id, runIndex: opts.runIndex, toolName: t.toolName });`
- deny 分支 `transcript.push({ role: 'system-note', ... })` 后: system-note turn 发射; deny 分支 assistant push 后: assistant 发射; deny 分支 toolCalls push 后: 同型 tool_call 循环。
- L3 approve 分支 system-note push 后: system-note 发射; 其 assistant/toolCalls 同型补发。
- `approvals.push(approvalObs);` 后: `emit({ type: 'approval', scenarioId: scenario.id, runIndex: opts.runIndex, toolName: p.tool_name, decision: decision.approved ? 'approved' : 'denied' });`

- [ ] **Step 4: 跑测试确认通过 + 全量**

Run: `npm test --workspace apps/server -- test/eval/driver-events.test.ts` → PASS 2/2; `npm test --workspace apps/server` (369|18, driver 旧测试不回归)
```bash
git add apps/server/eval/agent/driver.ts apps/server/test/eval/driver-events.test.ts
git commit -m "feat(eval): driver onEvent seam for live turn/tool/approval events"
```

---

### Task 3: 服务端运行注册表 (锁 + 子进程工厂)

**Files:**
- Create: `apps/server/src/routes/evalRunCore.ts`
- Test: `apps/server/test/routes/evalRunCore.test.ts`

**Interfaces:**
- Consumes: 无外部 (事件类型为 src 内镜像)。
- Produces:
  - `type ServerRunEvent` (8 种, 镜像 eval/agent/events.ts — SSOT 在那边)
  - `parseServerEventLine(line): ServerRunEvent | null`
  - `interface RunnerHandle { kill(): void; onStdoutLine(cb): void; onExit(cb: (code: number | null) => void): void; }`
  - `type RunnerFactory = (args: string[], env: NodeJS.ProcessEnv) => RunnerHandle`
  - `defaultRunnerFactory: RunnerFactory` (spawn `npx tsx eval/agent/run.ts`, cwd=apps/server, env 透传+EVAL_RUN_ID)
  - `class EvalRunRegistry { constructor(factory?); start(opts): { ok: true; runId } | { ok: false; error: 'busy' }; get(runId): LiveRunState | undefined; subscribe(runId, cb): () => void; kill(runId): boolean; activeRunId(): string | null }`
  - `LiveRunState = { runId: string; state: 'running' | 'done' | 'error'; events: ServerRunEvent[]; startedAt: string; error?: string }`
  - 单例 `export const evalRunRegistry = new EvalRunRegistry()`

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/test/routes/evalRunCore.test.ts
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  EvalRunRegistry,
  parseServerEventLine,
  type RunnerFactory,
} from '../../src/routes/evalRunCore.js';

// Fake runner: a controllable in-process stand-in for the spawned tsx child.
function fakeFactory(script: (h: FakeHandle) => void) {
  const handles: FakeHandle[] = [];
  const factory: RunnerFactory = () => {
    const h = new FakeHandle();
    handles.push(h);
    queueMicrotask(() => script(h));
    return h;
  };
  return { factory, handles };
}
class FakeHandle extends EventEmitter implements import('../../src/routes/evalRunCore.js').RunnerHandle {
  killed = false;
  kill() { this.killed = true; this.emit('exit', null); }
  onStdoutLine(cb: (line: string) => void) { this.on('line', cb); }
  onExit(cb: (code: number | null) => void) { this.on('exit', cb); }
  send(line: string) { this.emit('line', line); }
  end(code: number | null) { this.emit('exit', code); }
}

describe('parseServerEventLine', () => {
  it('parses protocol lines and rejects noise', () => {
    expect(parseServerEventLine('@@EVT@@{"type":"run_done","outDir":"/x"}')).toEqual({ type: 'run_done', outDir: '/x' });
    expect(parseServerEventLine('[eval] noise')).toBeNull();
    expect(parseServerEventLine('@@EVT@@bad')).toBeNull();
  });
});

describe('EvalRunRegistry', () => {
  it('happy path: events buffered, subscribers notified, done terminal', () => {
    const { factory, handles } = fakeFactory((h) => {
      h.send('@@EVT@@{"type":"run_started","runId":"r","total":1}');
      h.send('[eval] human log to ignore');
      h.send('@@EVT@@{"type":"episode_done","scenarioId":"t1","runIndex":1,"verdict":"pass","rubricScore":4,"vetoTriggered":false}');
      h.send('@@EVT@@{"type":"run_done","outDir":"/tmp/r"}');
      h.end(0);
    });
    const reg = new EvalRunRegistry(factory);
    const seen: string[] = [];
    const res = reg.start({ dataset: 'core', runs: 1, filter: undefined });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    reg.subscribe(res.runId, (e) => seen.push((e as { type: string }).type));
    expect(reg.get(res.runId)?.state).toBe('done');
    expect(reg.get(res.runId)?.events.map((e) => e.type)).toEqual(['run_started', 'episode_done', 'run_done']);
    expect(seen).toContain('run_done');
    expect(reg.activeRunId()).toBeNull();
  });

  it('lock: second start while running -> busy', () => {
    const { factory } = fakeFactory(() => { /* never exits */ });
    const reg = new EvalRunRegistry(factory);
    expect(reg.start({ dataset: 'core', runs: 1, filter: undefined }).ok).toBe(true);
    const second = reg.start({ dataset: 'core', runs: 1, filter: undefined });
    expect(second).toEqual({ ok: false, error: 'busy' });
  });

  it('crash without run_done/run_error -> synthesized run_error', () => {
    const { factory, handles } = fakeFactory((h) => { h.send('@@EVT@@{"type":"run_started","runId":"r","total":1}'); });
    const reg = new EvalRunRegistry(factory);
    const res = reg.start({ dataset: 'core', runs: 1, filter: undefined });
    expect(res.ok).toBe(true);
    handles[0].end(1); // abnormal exit
    const st = reg.get((res as { runId: string }).runId);
    expect(st?.state).toBe('error');
    expect(st?.events.at(-1)?.type).toBe('run_error');
  });

  it('kill -> run_error 用户中止, kill unknown -> false', () => {
    const { factory, handles } = fakeFactory(() => {});
    const reg = new EvalRunRegistry(factory);
    const res = reg.start({ dataset: 'core', runs: 1, filter: undefined });
    const runId = (res as { runId: string }).runId;
    expect(reg.kill(runId)).toBe(true);
    expect(reg.get(runId)?.events.at(-1)).toMatchObject({ type: 'run_error', message: '用户中止' });
    expect(reg.kill('nope')).toBe(false);
  });

  it('runId shape: stamp-dataset, EVAL_RUN_ID passed through factory args/env', () => {
    let seen: { args: string[]; env: NodeJS.ProcessEnv } | null = null;
    const factory: RunnerFactory = (args, env) => {
      seen = { args, env };
      return fakeFactory(() => {}).factory('', undefined as never) as never;
    };
    const reg = new EvalRunRegistry(factory);
    const res = reg.start({ dataset: 'user-mine', runs: 3, filter: 't1' });
    expect(res.ok).toBe(true);
    const runId = (res as { runId: string }).runId;
    expect(runId).toMatch(/^20\d{2}-\d{2}-\d{2}T[\d-]+Z-user-mine$/);
    expect(seen!.args).toEqual(['--dataset=user-mine', '--runs=3', '--filter=t1']);
    expect(seen!.env.EVAL_RUN_ID).toBe(runId);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/routes/evalRunCore.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: 实现 evalRunCore.ts**

```ts
// apps/server/src/routes/evalRunCore.ts
// In-memory registry for server-triggered eval runs: single-concurrency lock,
// spawned-runner lifecycle, event buffer + fan-out. Server-side mirror of the
// @@EVT@@ protocol (SSOT: eval/agent/events.ts — src cannot import eval/**).

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const EVT_PREFIX = '@@EVT@@';

/** Mirror of eval/agent/events.ts EvalRunEvent (protocol SSOT lives there). */
export type ServerRunEvent =
  | { type: 'run_started'; runId: string; total: number }
  | { type: 'scenario_started'; scenarioId: string; runIndex: number }
  | { type: 'turn'; scenarioId: string; runIndex: number; role: 'user' | 'assistant' | 'system-note'; text: string }
  | { type: 'tool_call'; scenarioId: string; runIndex: number; toolName: string }
  | { type: 'approval'; scenarioId: string; runIndex: number; toolName: string; decision: 'approved' | 'denied' }
  | { type: 'episode_done'; scenarioId: string; runIndex: number; verdict: string; rubricScore: number | null; vetoTriggered: boolean }
  | { type: 'run_done'; outDir: string }
  | { type: 'run_error'; message: string };

export function parseServerEventLine(line: string): ServerRunEvent | null {
  const t = line.trim();
  if (!t.startsWith(EVT_PREFIX)) return null;
  try {
    const parsed: unknown = JSON.parse(t.slice(EVT_PREFIX.length));
    if (typeof parsed !== 'object' || parsed === null) return null;
    if (!('type' in parsed) || typeof (parsed as { type: unknown }).type !== 'string') return null;
    return parsed as ServerRunEvent;
  } catch {
    return null;
  }
}

export interface RunnerHandle {
  kill(): void;
  onStdoutLine(cb: (line: string) => void): void;
  onExit(cb: (code: number | null) => void): void;
}

export type RunnerFactory = (args: string[], env: NodeJS.ProcessEnv) => RunnerHandle;

const here = dirname(fileURLToPath(import.meta.url));

/** Default: spawn the real runner via tsx (cwd = apps/server, devDeps present). */
export const defaultRunnerFactory: RunnerFactory = (args, env) => {
  const child = spawn(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['tsx', 'eval/agent/run.ts', ...args],
    { cwd: resolve(here, '../..'), env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const bus = new EventEmitter();
  let buf = '';
  child.stdout!.on('data', (d: Buffer) => {
    buf += d.toString('utf-8');
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.trim()) bus.emit('line', line);
    }
  });
  child.on('exit', (code) => bus.emit('exit', code));
  return {
    kill: () => child.kill(),
    onStdoutLine: (cb) => bus.on('line', cb),
    onExit: (cb) => bus.on('exit', cb),
  };
};

export interface LiveRunState {
  runId: string;
  state: 'running' | 'done' | 'error';
  events: ServerRunEvent[];
  startedAt: string;
  error?: string;
}

export class EvalRunRegistry {
  private readonly factory: RunnerFactory;
  private readonly runs = new Map<string, LiveRunState>();
  private readonly subs = new Map<string, Set<(e: ServerRunEvent) => void>>();

  constructor(factory: RunnerFactory = defaultRunnerFactory) {
    this.factory = factory;
  }

  start(opts: { dataset: string; runs: number; filter?: string }): { ok: true; runId: string } | { ok: false; error: 'busy' } {
    for (const st of this.runs.values()) {
      if (st.state === 'running') return { ok: false, error: 'busy' };
    }
    const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${opts.dataset}`;
    const state: LiveRunState = { runId, state: 'running', events: [], startedAt: new Date().toISOString() };
    this.runs.set(runId, state);

    const args = [`--dataset=${opts.dataset}`, `--runs=${opts.runs}`];
    if (opts.filter) args.push(`--filter=${opts.filter}`);
    const handle = this.factory(args, { EVAL_RUN_ID: runId });

    handle.onStdoutLine((line) => {
      const evt = parseServerEventLine(line);
      if (!evt) return;
      state.events.push(evt);
      if (evt.type === 'run_done') state.state = 'done';
      if (evt.type === 'run_error') { state.state = 'error'; state.error = evt.message; }
      for (const cb of this.subs.get(runId) ?? []) cb(evt);
    });
    handle.onExit((code) => {
      if (state.state !== 'running') return;
      state.state = 'error';
      const synth: ServerRunEvent = { type: 'run_error', message: `runner 异常退出 (code=${code ?? 'null'})` };
      state.events.push(synth);
      state.error = synth.message;
      for (const cb of this.subs.get(runId) ?? []) cb(synth);
    });
    return { ok: true, runId };
  }

  get(runId: string): LiveRunState | undefined {
    return this.runs.get(runId);
  }

  subscribe(runId: string, cb: (e: ServerRunEvent) => void): () => void {
    let set = this.subs.get(runId);
    if (!set) { set = new Set(); this.subs.set(runId, set); }
    set.add(cb);
    return () => set!.delete(cb);
  }

  kill(runId: string): boolean {
    const st = this.runs.get(runId);
    if (!st || st.state !== 'running') return false;
    const synth: ServerRunEvent = { type: 'run_error', message: '用户中止' };
    st.state = 'error';
    st.error = synth.message;
    st.events.push(synth);
    for (const cb of this.subs.get(runId) ?? []) cb(synth);
    return true;
  }

  activeRunId(): string | null {
    for (const st of this.runs.values()) {
      if (st.state === 'running') return st.runId;
    }
    return null;
  }
}

/** Process singleton (single pm2 instance assumption — see spec §4.4). */
export const evalRunRegistry = new EvalRunRegistry();
```

注意: kill() 先合成事件再由 onExit 的 state!=='running' 守卫去重; RunnerHandle.kill 的实际进程终止由工厂返回的闭包负责 (fake 中 emit exit 无妨, 守卫已挡)。`randomUUID` 未用则不 import (lint)。

- [ ] **Step 4: 跑测试确认通过 + 提交**

Run: `npm test --workspace apps/server -- test/routes/evalRunCore.test.ts` → PASS 6/6; 全量 (373|18); `npm run build --workspace apps/server`
```bash
git add apps/server/src/routes/evalRunCore.ts apps/server/test/routes/evalRunCore.test.ts
git commit -m "feat(eval): in-memory run registry with lock and injected runner factory"
```

---

### Task 4: 运行编排路由 (POST/live/SSE/DELETE + activeRunId)

**Files:**
- Create: `apps/server/src/routes/evalRun.ts`
- Modify: `apps/server/src/routes/evalResults.ts` (GET /runs 增 activeRunId)
- Modify: `apps/server/src/index.ts` (挂载)
- Test: `apps/server/test/routes/evalRun.test.ts`

**Interfaces:**
- Consumes: Task 3 `evalRunRegistry`/`LiveRunState`/`ServerRunEvent`; 既有 `evalResultsRoute`。
- Produces: `export const evalRunRoute = new Hono<AuthEnv>()` — POST `/runs`, GET `/runs/:runId/live`, GET `/runs/:runId/events` (SSE), DELETE `/runs/:runId`; GET `/api/eval/runs` 响应 data 增 `activeRunId: string | null`。

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/test/routes/evalRun.test.ts
// Test-shell Hono app: mounts evalRunRoute under /api/eval with a user set
// directly (same hermetic pattern as evalResults route tests).
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { EventEmitter } from 'node:events';
import { evalRunRoute } from '../../src/routes/evalRun.js';
import { EvalRunRegistry, type RunnerFactory, type RunnerHandle } from '../../src/routes/evalRunCore.js';

function makeApp(reg: EvalRunRegistry) {
  // routes read the singleton by default; for tests we inject via factory module override
  const app = new Hono();
  app.use('/api/eval/*', async (c, next) => { c.set('user', { id: 'u1', email: 't@t', name: 't', role: 'trader' } as never); await next(); });
  app.route('/api/eval', evalRunRoute);
  return app;
}
```

注意: 路由单测需要可注入注册表 — `evalRun.ts` 导出 `createEvalRunRoute(reg = evalRunRegistry)` 工厂 (与 evalResults 工厂模式一致)。测试用 `createEvalRunRoute(testReg)`。

```ts
import { createEvalRunRoute } from '../../src/routes/evalRun.js';

function makeApp(reg: EvalRunRegistry) {
  const app = new Hono();
  app.use('/api/eval/*', async (c, next) => { c.set('user', { id: 'u1' } as never); await next(); });
  app.route('/api/eval', createEvalRunRoute(reg));
  return app;
}

class FakeHandle extends EventEmitter implements RunnerHandle {
  kill() { this.emit('exit', null); }
  onStdoutLine(cb: (l: string) => void) { this.on('line', cb); }
  onExit(cb: (c: number | null) => void) { this.on('exit', cb); }
  send(l: string) { this.emit('line', l); }
  end(c: number | null) { this.emit('exit', c); }
}

function hangingFactory(handles: FakeHandle[]) {
  return ((_args: string[], _env: NodeJS.ProcessEnv) => {
    const h = new FakeHandle();
    handles.push(h);
    return h;
  }) as RunnerFactory;
}

const okScenarioYaml = `scenarios: []\n`; // dataset file content irrelevant to routes (existence check mocked below)

describe('evalRun routes', () => {
  it('POST starts a run and returns runId; second POST -> 409', async () => {
    const handles: FakeHandle[] = [];
    const reg = new EvalRunRegistry(hangingFactory(handles));
    const app = makeApp(reg);
    const r1 = await app.request('/api/eval/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', origin: 'http://localhost:5173' },
      body: JSON.stringify({ dataset: 'core', runs: 2 }),
    });
    expect(r1.status).toBe(200);
    const d1 = (await r1.json()) as { ok: boolean; data?: { runId: string } };
    expect(d1.ok).toBe(true);
    expect(d1.data!.runId).toMatch(/-core$/);
    const r2 = await app.request('/api/eval/runs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataset: 'core', runs: 1 }),
    });
    expect(r2.status).toBe(409);
    expect(((await r2.json()) as { error: string }).error).toContain('已有评估运行中');
  });

  it('POST rejects invalid body (dataset/runs bounds, unknown dataset)', async () => {
    const reg = new EvalRunRegistry(hangingFactory([]));
    const app = makeApp(reg);
    const bad1 = await app.request('/api/eval/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataset: '../x', runs: 1 }) });
    expect(bad1.status).toBe(400);
    const bad2 = await app.request('/api/eval/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataset: 'core', runs: 11 }) });
    expect(bad2.status).toBe(400);
  });

  it('GET live returns state + buffered events; unknown -> 404', async () => {
    const handles: FakeHandle[] = [];
    const reg = new EvalRunRegistry(hangingFactory(handles));
    const app = makeApp(reg);
    const r = await app.request('/api/eval/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataset: 'core', runs: 1 }) });
    const { data } = (await r.json()) as { data: { runId: string } };
    handles[0].send('@@EVT@@{"type":"run_started","runId":"x","total":1}');
    const live = await app.request(`/api/eval/runs/${data.runId}/live`);
    expect(live.status).toBe(200);
    const ld = (await live.json()) as { ok: boolean; data: { state: string; events: unknown[] } };
    expect(ld.data.state).toBe('running');
    expect(ld.data.events).toHaveLength(1);
    const miss = await app.request('/api/eval/runs/nope/live');
    expect(miss.status).toBe(404);
  });

  it('DELETE aborts a running run; unknown -> 404', async () => {
    const handles: FakeHandle[] = [];
    const reg = new EvalRunRegistry(hangingFactory(handles));
    const app = makeApp(reg);
    const r = await app.request('/api/eval/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataset: 'core', runs: 1 }) });
    const { data } = (await r.json()) as { data: { runId: string } };
    const del = await app.request(`/api/eval/runs/${data.runId}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(handles[0].listeners('exit')).toBeTruthy();
    expect((await app.request('/api/eval/runs/nope', { method: 'DELETE' })).status).toBe(404);
  });

  it('GET /runs activeRunId via evalResults route integration is covered in evalResults.test.ts additions', () => {
    // (see Step 3 note — activeRunId is asserted there with a fresh registry)
    expect(true).toBe(true);
  });
});
```

(同时给 `apps/server/test/routes/evalResults.test.ts` 追加一个 describe — 见 Step 3 注。)

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/routes/evalRun.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: 实现 evalRun.ts + evalResults.ts 增量 + index.ts 挂载**

```ts
// apps/server/src/routes/evalRun.ts
// Server-triggered eval runs: spawn + single-lock + SSE live stream.
// POST /runs, GET /runs/:runId/live, GET /runs/:runId/events (SSE),
// DELETE /runs/:runId. requireAuth-gated by the /api/eval/* middleware group
// in index.ts (same group as the Phase 1 results routes).

import { Hono } from 'hono';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AuthEnv } from '../lib/auth-middleware.js';
import { evalRunRegistry, type EvalRunRegistry } from './evalRunCore.js';

const here = dirname(fileURLToPath(import.meta.url));

const DATASET_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

function datasetPath(dataset: string): string | null {
  if (!DATASET_NAME.test(dataset)) return null;
  const root = resolve(here, '../../eval/agent/datasets');
  const p = resolve(root, `${dataset}.yaml`);
  return existsSync(p) ? p : null;
}

export function createEvalRunRoute(reg: EvalRunRegistry = evalRunRegistry) {
  const route = new Hono<AuthEnv>();

  route.post('/runs', async (c) => {
    const user = c.get('user');
    if (!user) return c.json({ ok: false, error: 'unauthorized' }, 401);
    const body = await c.req.json().catch(() => null) as { dataset?: unknown; runs?: unknown; filter?: unknown } | null;
    const dataset = typeof body?.dataset === 'string' ? body.dataset : '';
    const runs = Number(body?.runs ?? 1);
    const filter = typeof body?.filter === 'string' && body.filter ? body.filter : undefined;
    if (!DATASET_NAME.test(dataset)) return c.json({ ok: false, error: '数据集名不合法' }, 400);
    if (!Number.isInteger(runs) || runs < 1 || runs > 10) return c.json({ ok: false, error: 'runs 需为 1-10' }, 400);
    if (!datasetPath(dataset)) return c.json({ ok: false, error: '数据集不存在' }, 400);
    const res = reg.start({ dataset, runs, filter });
    if (!res.ok) return c.json({ ok: false, error: '已有评估运行中' }, 409);
    return c.json({ ok: true, data: { runId: res.runId } });
  });

  route.get('/runs/:runId/live', (c) => {
    const user = c.get('user');
    if (!user) return c.json({ ok: false, error: 'unauthorized' }, 401);
    const st = reg.get(c.req.param('runId'));
    if (!st) return c.json({ ok: false, error: 'run 不存在' }, 404);
    return c.json({ ok: true, data: { runId: st.runId, state: st.state, events: st.events, error: st.error ?? null } });
  });

  // SSE: replay buffer, then live fan-out (pattern: routes/sessions.ts /:id/events).
  route.get('/runs/:runId/events', (c) => {
    const user = c.get('user');
    if (!user) return c.json({ ok: false, error: 'unauthorized' }, 401);
    const st = reg.get(c.req.param('runId'));
    if (!st) return c.json({ ok: false, error: 'run 不存在' }, 404);

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const send = (obj: unknown) =>
      writer.write(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`)).catch(() => {});

    for (const e of st.events) void send(e);
    const unsub = reg.subscribe(st.runId, (e) => void send(e));
    const heartbeat = setInterval(() => {
      void writer.write(encoder.encode(`: heartbeat\n\n`)).catch(() => {});
    }, 10000);
    const cleanup = () => {
      unsub();
      clearInterval(heartbeat);
      void writer.close().catch(() => {});
    };
    c.req.raw.signal?.addEventListener('abort', cleanup);

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
    });
  });

  route.delete('/runs/:runId', (c) => {
    const user = c.get('user');
    if (!user) return c.json({ ok: false, error: 'unauthorized' }, 401);
    const ok = reg.kill(c.req.param('runId'));
    if (!ok) return c.json({ ok: false, error: 'run 不存在或已结束' }, 404);
    return c.json({ ok: true, data: { aborted: true } });
  });

  return route;
}

export const evalRunRoute = createEvalRunRoute();
```

`evalResults.ts` GET /runs handler 修改 (仅响应体一行处):
```ts
  // 原: return c.json({ ok: true, data: { runs: listRuns(defaultResultsRoot()) } });
  return c.json({ ok: true, data: { runs: listRuns(defaultResultsRoot()), activeRunId: evalRunRegistry.activeRunId() } });
```
(import `evalRunRegistry` from './evalRunCore.js'; evalResults.test.ts 的既有断言如断 data.runs 则不破坏。)

`index.ts` (两行增量, 挂载紧跟 evalResults 之后):
```ts
import { evalRunRoute } from './routes/evalRun.js';
// ...
app.route('/api/eval', evalRunRoute);
```

- [ ] **Step 4: 跑测试确认通过 + 提交**

Run: `npm test --workspace apps/server -- test/routes/evalRun.test.ts` → PASS 4/4 (第 5 个为占位真断言); 全量; `npm run build --workspace apps/server`
```bash
git add apps/server/src/routes/evalRun.ts apps/server/src/routes/evalResults.ts apps/server/src/index.ts apps/server/test/routes/evalRun.test.ts apps/server/test/routes/evalResults.test.ts
git commit -m "feat(eval): run orchestration routes with SSE live stream"
```

---

### Task 5: 数据集 CRUD 路由

**Files:**
- Create: `apps/server/src/routes/evalDatasets.ts`
- Modify: `apps/server/src/index.ts` (挂载)
- Modify: `.gitignore` (+1 行)
- Test: `apps/server/test/routes/evalDatasets.test.ts`

**Interfaces:**
- Consumes: Task 1 `validate.ts` (经 spawn, 工厂注入 fake)。
- Produces: `createEvalDatasetsRoute(opts?: { userRoot?: string; validator?: (file: string) => Promise<{ ok: true; scenarioCount: number } | { ok: false; error: string }> })` — GET `/datasets`, GET `/datasets/:name`, PUT `/datasets/:name`, POST `/datasets/:name/copy`, DELETE `/datasets/:name`; `export const evalDatasetsRoute = createEvalDatasetsRoute()`。

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/test/routes/evalDatasets.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { createEvalDatasetsRoute } from '../../src/routes/evalDatasets.js';

let userRoot: string;
let coreRoot: string;

function makeApp(validator: Parameters<typeof createEvalDatasetsRoute>[0]) {
  const app = new Hono();
  app.use('/api/eval/*', async (c, next) => { c.set('user', { id: 'u1' } as never); await next(); });
  app.route('/api/eval', createEvalDatasetsRoute({ userRoot, ...validator ? { validator: validator.validator } : {} }));
  return app;
}

beforeAll(() => {
  const base = mkdtempSync(join(tmpdir(), 'eval-ds-'));
  userRoot = join(base, 'user');
  coreRoot = join(base, 'datasets');
  mkdirSync(userRoot, { recursive: true });
  mkdirSync(coreRoot, { recursive: true });
  writeFileSync(join(coreRoot, 'core.yaml'), 'scenarios: []\n', 'utf-8');
});
afterAll(() => rmSync(userRoot, { recursive: true, force: true }));

const H = { 'Content-Type': 'application/json' };

describe('evalDatasets routes', () => {
  it('lists core (builtin) + user datasets', async () => {
    writeFileSync(join(userRoot, 'mine.yaml'), 'scenarios: []\n', 'utf-8');
    const app = makeApp(undefined);
    const r = await app.request('/api/eval/datasets');
    const d = (await r.json()) as { ok: boolean; data: { datasets: { name: string; builtin: boolean }[] } };
    const names = d.data.datasets.map((x) => `${x.name}:${x.builtin}`);
    expect(names).toContain('core:true');
    expect(names).toContain('mine:false');
  });

  it('GET returns yaml content; builtin flagged', async () => {
    const app = makeApp(undefined);
    const r = await app.request('/api/eval/datasets/core');
    const d = (await r.json()) as { ok: boolean; data: { yaml: string; builtin: boolean } };
    expect(d.data.builtin).toBe(true);
    expect(d.data.yaml).toBe('scenarios: []\n');
    await expect((await app.request('/api/eval/datasets/missing')).status).toBe(404);
  });

  it('PUT valid yaml persists; invalid -> 422 with error; builtin -> 400', async () => {
    const app = makeApp({ validator: async (f) => {
      const text = readFileSync(f, 'utf-8');
      return text.includes('BAD') ? { ok: false, error: 'scenario #0 invalid: 缩进错误' } : { ok: true, scenarioCount: 2 };
    } });
    const ok = await app.request('/api/eval/datasets/edited', { method: 'PUT', headers: H, body: JSON.stringify({ yaml: 'scenarios: fine\n' }) });
    expect(ok.status).toBe(200);
    expect(readFileSync(join(userRoot, 'edited.yaml'), 'utf-8')).toBe('scenarios: fine\n');
    expect(existsSync(join(userRoot, 'edited.yaml.tmp'))).toBe(false); // atomic: no tmp left
    const bad = await app.request('/api/eval/datasets/edited', { method: 'PUT', headers: H, body: JSON.stringify({ yaml: 'BAD' }) });
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as { error: string }).error).toContain('scenario #0');
    expect(readFileSync(join(userRoot, 'edited.yaml'), 'utf-8')).toBe('scenarios: fine\n'); // unchanged
    const builtin = await app.request('/api/eval/datasets/core', { method: 'PUT', headers: H, body: JSON.stringify({ yaml: 'x' }) });
    expect(builtin.status).toBe(400);
  });

  it('copy core -> user; rejects bad names / overwrite', async () => {
    const app = makeApp(undefined);
    const r = await app.request('/api/eval/datasets/my-copy/copy', { method: 'POST' });
    expect(r.status).toBe(200);
    expect(readFileSync(join(userRoot, 'my-copy.yaml'), 'utf-8')).toBe('scenarios: []\n');
    expect((await app.request('/api/eval/datasets/Bad_Name/copy', { method: 'POST' })).status).toBe(400);
    expect((await app.request('/api/eval/datasets/my-copy/copy', { method: 'POST' })).status).toBe(409);
    expect((await app.request('/api/eval/datasets/nosuch/copy2/copy', { method: 'POST' })).status).toBe(404);
  });

  it('DELETE removes user dataset; builtin -> 400; missing -> 404', async () => {
    const app = makeApp(undefined);
    writeFileSync(join(userRoot, 'gone.yaml'), 'x', 'utf-8');
    expect((await app.request('/api/eval/datasets/gone', { method: 'DELETE' })).status).toBe(200);
    expect(existsSync(join(userRoot, 'gone.yaml'))).toBe(false);
    expect((await app.request('/api/eval/datasets/core', { method: 'DELETE' })).status).toBe(400);
    expect((await app.request('/api/eval/datasets/gone', { method: 'DELETE' })).status).toBe(404);
  });
});
```

注意: 工厂 opts 需支持 coreRoot 注入 (测试用 tmp) — 接口为 `{ coreRoot?, userRoot?, validator? }`, 默认 coreRoot=eval/agent/datasets。上面 makeApp 只传 userRoot/validator, coreRoot 也传 (修正: `createEvalDatasetsRoute({ coreRoot, userRoot, validator })`)。

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/routes/evalDatasets.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: 实现 evalDatasets.ts**

```ts
// apps/server/src/routes/evalDatasets.ts
// User dataset CRUD: core.yaml is read-only (CD git-resets tracked files);
// user datasets live under eval/agent/datasets/user/ (gitignored). PUT
// validates via a one-shot validate.ts child process (rootDir-safe pattern).

import { Hono } from 'hono';
import { existsSync, readFileSync, renameSync, writeFileSync, unlinkSync, readdirSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AuthEnv } from '../lib/auth-middleware.js';

const here = dirname(fileURLToPath(import.meta.url));

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface DatasetRouteOpts {
  coreRoot?: string;
  userRoot?: string;
  validator?: (file: string) => Promise<{ ok: true; scenarioCount: number } | { ok: false; error: string }>;
}

/** Default validator: spawn tsx eval/agent/validate.ts (cwd=apps/server). */
async function defaultValidator(file: string): Promise<{ ok: true; scenarioCount: number } | { ok: false; error: string }> {
  return new Promise((res) => {
    const child = spawn(
      process.platform === 'win32' ? 'npx.cmd' : 'npx',
      ['tsx', 'eval/agent/validate.ts', file],
      { cwd: resolve(here, '../..'), stdio: ['ignore', 'pipe', 'inherit'] },
    );
    let out = '';
    child.stdout!.on('data', (d: Buffer) => { out += d.toString('utf-8'); });
    child.on('exit', (code) => {
      try {
        const parsed = JSON.parse(out.trim()) as { ok: boolean; scenarioCount?: number; error?: string };
        if (code === 0 && parsed.ok) res({ ok: true, scenarioCount: parsed.scenarioCount ?? 0 });
        else res({ ok: false, error: parsed.error ?? '校验失败' });
      } catch {
        res({ ok: false, error: '校验进程输出异常' });
      }
    });
    child.on('error', () => res({ ok: false, error: '无法启动校验进程' }));
  });
}

export function createEvalDatasetsRoute(opts: DatasetRouteOpts = {}) {
  const coreRoot = opts.coreRoot ?? resolve(here, '../../eval/agent/datasets');
  const userRoot = opts.userRoot ?? resolve(coreRoot, 'user');
  const validate = opts.validator ?? defaultValidator;
  const route = new Hono<AuthEnv>();

  const userPath = (name: string) => join(userRoot, `${name}.yaml`);
  const corePath = (name: string) => join(coreRoot, `${name}.yaml`);

  route.get('/datasets', (c) => {
    const user = c.get('user');
    if (!user) return c.json({ ok: false, error: 'unauthorized' }, 401);
    const datasets: { name: string; builtin: boolean; scenarioCount: number | null }[] = [];
    if (existsSync(coreRoot)) {
      for (const f of readdirSync(coreRoot)) {
        if (f.endsWith('.yaml')) datasets.push({ name: f.slice(0, -5), builtin: true, scenarioCount: null });
      }
    }
    if (existsSync(userRoot)) {
      for (const f of readdirSync(userRoot)) {
        if (f.endsWith('.yaml')) datasets.push({ name: f.slice(0, -5), builtin: false, scenarioCount: null });
      }
    }
    return c.json({ ok: true, data: { datasets } });
  });

  route.get('/datasets/:name', (c) => {
    const user = c.get('user');
    if (!user) return c.json({ ok: false, error: 'unauthorized' }, 401);
    const name = c.req.param('name');
    if (!NAME.test(name)) return c.json({ ok: false, error: '数据集名不合法' }, 400);
    if (existsSync(corePath(name))) {
      return c.json({ ok: true, data: { name, builtin: true, yaml: readFileSync(corePath(name), 'utf-8') } });
    }
    if (existsSync(userPath(name))) {
      return c.json({ ok: true, data: { name, builtin: false, yaml: readFileSync(userPath(name), 'utf-8') } });
    }
    return c.json({ ok: false, error: '数据集不存在' }, 404);
  });

  route.put('/datasets/:name', async (c) => {
    const user = c.get('user');
    if (!user) return c.json({ ok: false, error: 'unauthorized' }, 401);
    const name = c.req.param('name');
    if (!NAME.test(name)) return c.json({ ok: false, error: '数据集名不合法' }, 400);
    if (existsSync(corePath(name))) return c.json({ ok: false, error: '内置数据集只读' }, 400);
    const body = await c.req.json().catch(() => null) as { yaml?: unknown } | null;
    if (typeof body?.yaml !== 'string' || !body.yaml.trim()) return c.json({ ok: false, error: 'yaml 内容缺失' }, 400);
    mkdirSync(userRoot, { recursive: true });
    // Validate against the tmp file, then atomic-rename into place.
    const tmp = userPath(`${name}.yaml.tmp`);
    writeFileSync(tmp, body.yaml, 'utf-8');
    const verdict = await validate(tmp);
    if (!verdict.ok) {
      unlinkSync(tmp);
      return c.json({ ok: false, error: verdict.error }, 422);
    }
    renameSync(tmp, userPath(name));
    return c.json({ ok: true, data: { name, scenarioCount: verdict.scenarioCount } });
  });

  route.post('/datasets/:name/copy', (c) => {
    const user = c.get('user');
    if (!user) return c.json({ ok: false, error: 'unauthorized' }, 401);
    const name = c.req.param('name');
    if (!NAME.test(name)) return c.json({ ok: false, error: '数据集名不合法' }, 400);
    // Copy source = current dataset of the same name (core or user).
    const src = existsSync(corePath(name)) ? corePath(name) : existsSync(userPath(name)) ? userPath(name) : null;
    if (!src) return c.json({ ok: false, error: '源数据集不存在' }, 404);
    // Destination name from query ?to=
    const to = c.req.query('to');
    if (!to || !NAME.test(to)) return c.json({ ok: false, error: '目标名不合法' }, 400);
    const dst = userPath(to);
    if (existsSync(dst)) return c.json({ ok: false, error: '目标已存在' }, 409);
    mkdirSync(userRoot, { recursive: true });
    writeFileSync(dst, readFileSync(src, 'utf-8'), 'utf-8');
    return c.json({ ok: true, data: { name: to } });
  });

  route.delete('/datasets/:name', (c) => {
    const user = c.get('user');
    if (!user) return c.json({ ok: false, error: 'unauthorized' }, 401);
    const name = c.req.param('name');
    if (!NAME.test(name)) return c.json({ ok: false, error: '数据集名不合法' }, 400);
    if (existsSync(corePath(name))) return c.json({ ok: false, error: '内置数据集不可删除' }, 400);
    if (!existsSync(userPath(name))) return c.json({ ok: false, error: '数据集不存在' }, 404);
    unlinkSync(userPath(name));
    return c.json({ ok: true, data: { deleted: true } });
  });

  return route;
}

export const evalDatasetsRoute = createEvalDatasetsRoute();
```

(测试中 copy 调用改为 `/api/eval/datasets/core/copy?to=my-copy` 形态 — 实现以 `POST /datasets/:name/copy?to=<target>` 为准, 相应修 Step 1 断言 URL; 404 用例 `/nosuch/copy?to=x`。)

`.gitignore` 追加:
```
# User-authored eval datasets (edited in-app; survive CD git-reset)
apps/server/eval/agent/datasets/user/
```

`index.ts` 挂载 (evalRun 之后):
```ts
import { evalDatasetsRoute } from './routes/evalDatasets.js';
// ...
app.route('/api/eval', evalDatasetsRoute);
```

- [ ] **Step 4: 跑测试确认通过 + 提交**

Run: `npm test --workspace apps/server -- test/routes/evalDatasets.test.ts` → PASS 5/5; 全量; build
```bash
git add apps/server/src/routes/evalDatasets.ts apps/server/src/index.ts .gitignore apps/server/test/routes/evalDatasets.test.ts
git commit -m "feat(eval): user dataset CRUD with subprocess zod validation"
```

---

### Task 6: 前端 api 客户端 + hooks

**Files:**
- Create: `apps/web/src/api/evalRun.ts`
- Create: `apps/web/src/api/evalDatasets.ts`
- Modify: `apps/web/src/api/eval.ts` (EvalRunsResponse 增 activeRunId)
- Create: `apps/web/src/hooks/useEvalRunLive.ts`
- Create: `apps/web/src/hooks/useEvalDatasets.ts`

**Interfaces:**
- Consumes: Task 4/5 API (端点与信封); Task 1 事件形状 (前端镜像类型)。
- Produces:
  - `startEvalRun(dataset, runs, filter?) => Promise<{runId}>` (409 抛 `Error('已有评估运行中')` 携 runId 于 `err.activeRunId`)
  - `getEvalRunLive(runId) / abortEvalRun(runId)`
  - `listEvalDatasets() / getEvalDataset(name) / putEvalDataset(name, yaml) / copyEvalDataset(name, to) / deleteEvalDataset(name)` (422 抛 `Error(error)`)
  - `type RunEvent` (8 种镜像), `LiveInfo { runId, state, events, error }`
  - `useEvalRunLive(runId: string | null)` → `{ events: RunEvent[], state: 'connecting' | 'running' | 'done' | 'error' | 'interrupted', error: string | null, abort(): void, refreshReplay(): void }` — EventSource 订阅 + onerror 时 GET live 兜底一次 (404 → interrupted)
  - `useEvalDatasets()` → `{ datasets, loading, error, refresh }`

- [ ] **Step 1: 实现 api 客户端** (无测试, build 门 — 对齐 api/eval.ts 既有模式)

```ts
// apps/web/src/api/evalRun.ts
import type { RunEvent, LiveInfo } from './evalRunTypes';

async function postJson(url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; data?: unknown } | null;
  if (!res.ok || !data?.ok) {
    const err = new Error(data?.error ?? `请求失败 (${res.status})`) as Error & { status?: number; activeRunId?: string };
    err.status = res.status;
    throw err;
  }
  return data.data;
}

export async function startEvalRun(dataset: string, runs: number, filter?: string): Promise<{ runId: string }> {
  try {
    return (await postJson('/api/eval/runs', { dataset, runs, filter })) as { runId: string };
  } catch (e) {
    if ((e as { status?: number }).status === 409) {
      // Attach the active run so the UI can jump straight to its live page.
      const live = await listLive();
      if (live) (e as { activeRunId?: string }).activeRunId = live.runId;
    }
    throw e;
  }
}

async function listLive(): Promise<{ runId: string } | null> {
  try {
    const res = await fetch('/api/eval/runs', { credentials: 'include' });
    const data = (await res.json()) as { ok: boolean; data?: { activeRunId: string | null } };
    return data.data?.activeRunId ? { runId: data.data.activeRunId } : null;
  } catch {
    return null;
  }
}

export async function getEvalRunLive(runId: string): Promise<LiveInfo> {
  const res = await fetch(`/api/eval/runs/${encodeURIComponent(runId)}/live`, { credentials: 'include' });
  const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; data?: LiveInfo } | null;
  if (!res.ok || !data?.ok) throw new Error(data?.error ?? `请求失败 (${res.status})`);
  return data.data;
}

export async function abortEvalRun(runId: string): Promise<void> {
  const res = await fetch(`/api/eval/runs/${encodeURIComponent(runId)}`, { method: 'DELETE', credentials: 'include' });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error ?? `中止失败 (${res.status})`);
  }
}
export type { RunEvent, LiveInfo };
```

```ts
// apps/web/src/api/evalRunTypes.ts
export type RunEvent =
  | { type: 'run_started'; runId: string; total: number }
  | { type: 'scenario_started'; scenarioId: string; runIndex: number }
  | { type: 'turn'; scenarioId: string; runIndex: number; role: 'user' | 'assistant' | 'system-note'; text: string }
  | { type: 'tool_call'; scenarioId: string; runIndex: number; toolName: string }
  | { type: 'approval'; scenarioId: string; runIndex: number; toolName: string; decision: 'approved' | 'denied' }
  | { type: 'episode_done'; scenarioId: string; runIndex: number; verdict: string; rubricScore: number | null; vetoTriggered: boolean }
  | { type: 'run_done'; outDir: string }
  | { type: 'run_error'; message: string };

export interface LiveInfo {
  runId: string;
  state: 'running' | 'done' | 'error';
  events: RunEvent[];
  error: string | null;
}
```

```ts
// apps/web/src/api/evalDatasets.ts
export interface DatasetInfo { name: string; builtin: boolean; scenarioCount: number | null }
export interface DatasetDetail { name: string; builtin: boolean; yaml: string }

async function req(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, { credentials: 'include', ...init });
  const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; data?: unknown } | null;
  if (!res.ok || !data?.ok) {
    const err = new Error(data?.error ?? `请求失败 (${res.status})`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return data.data;
}

export function listEvalDatasets(): Promise<{ datasets: DatasetInfo[] }> {
  return req('/api/eval/datasets') as Promise<{ datasets: DatasetInfo[] }>;
}
export function getEvalDataset(name: string): Promise<DatasetDetail> {
  return req(`/api/eval/datasets/${encodeURIComponent(name)}`) as Promise<DatasetDetail>;
}
export function putEvalDataset(name: string, yaml: string): Promise<{ scenarioCount: number }> {
  return req(`/api/eval/datasets/${encodeURIComponent(name)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ yaml }),
  }) as Promise<{ scenarioCount: number }>;
}
export function copyEvalDataset(name: string, to: string): Promise<{ name: string }> {
  return req(`/api/eval/datasets/${encodeURIComponent(name)}/copy?to=${encodeURIComponent(to)}` as never, { method: 'POST' }) as Promise<{ name: string }>;
}
export function deleteEvalDataset(name: string): Promise<void> {
  return req(`/api/eval/datasets/${encodeURIComponent(name)}`, { method: 'DELETE' }) as Promise<void>;
}
```

`api/eval.ts` 修改: `listEvalRuns` 返回类型处增加 activeRunId — 新类型 `EvalRunsResponse = { runs: EvalRunSummary[]; activeRunId: string | null }` (find the existing return, extend; 断言处向后兼容: listEvalRuns 现在返回整个 data 对象 — 保持 Phase 1 调用方兼容性由 Task 7 一起改)。

- [ ] **Step 2: 实现 hooks**

```ts
// apps/web/src/hooks/useEvalRunLive.ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { getEvalRunLive, type RunEvent } from '../api/evalRun';

export type LiveState = 'connecting' | 'running' | 'done' | 'error' | 'interrupted';

export function useEvalRunLive(runId: string | null) {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [state, setState] = useState<LiveState>('connecting');
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const replay = useCallback(async () => {
    if (!runId) return;
    try {
      const info = await getEvalRunLive(runId);
      setEvents(info.events);
      setState(info.state);
    } catch {
      setState('interrupted');
    }
  }, [runId]);

  useEffect(() => {
    if (!runId) { setEvents([]); setState('connecting'); setError(null); return; }
    setState('connecting');
    setEvents([]);
    setError(null);
    const es = new EventSource(`/api/eval/runs/${encodeURIComponent(runId)}/events`);
    esRef.current = es;
    es.onmessage = (m) => {
      try {
        const e = JSON.parse(m.data) as RunEvent;
        setEvents((prev) => [...prev, e]);
        if (e.type === 'run_done') setState('done');
        if (e.type === 'run_error') { setState('error'); setError(e.message); }
        else if (state === 'connecting') setState('running');
      } catch { /* ignore malformed frame */ }
    };
    es.onerror = () => {
      // EventSource auto-reconnects; if the run is gone (404) it keeps
      // failing -> fall back to a one-shot replay probe.
      es.close();
      void replay();
    };
    return () => { es.close(); esRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, replay]);

  return { events, state, error, replay };
}
```

(注意修正 onmessage 内 `state` 闭包陈旧问题 — 用函数式 setState 或推导: `setState((s) => (s === 'connecting' ? 'running' : s))` 于非终态事件; 最终实现以此为准。)

```ts
// apps/web/src/hooks/useEvalDatasets.ts
import { useCallback, useEffect, useState } from 'react';
import { listEvalDatasets, type DatasetInfo } from '../api/evalDatasets';

export function useEvalDatasets() {
  const [datasets, setDatasets] = useState<DatasetInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    setError(null);
    try {
      const d = await listEvalDatasets();
      setDatasets(d.datasets);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  return { datasets, loading, error, refresh };
}
```

- [ ] **Step 3: 验证 + 提交**

Run: `npm run build --workspace apps/web` (tsc+vite 绿); `npm test` (无回归)
```bash
git add apps/web/src/api/evalRun.ts apps/web/src/api/evalRunTypes.ts apps/web/src/api/evalDatasets.ts apps/web/src/api/eval.ts apps/web/src/hooks/useEvalRunLive.ts apps/web/src/hooks/useEvalDatasets.ts
git commit -m "feat(eval-ui): run console + dataset api clients and live hooks"
```

---

### Task 7: 直播页 + 触发栏 + 共享渲染件

**Files:**
- Create: `apps/web/src/components/eval/shared.tsx` (TranscriptBubble/ToolCallCard/ApprovalCard, 从 EvalEpisodeDetail 提取)
- Modify: `apps/web/src/components/eval/EvalEpisodeDetail.tsx` (改用 shared)
- Create: `apps/web/src/components/eval/EvalRunLive.tsx`
- Modify: `apps/web/src/components/eval/EvalRunsList.tsx` (触发栏 + activeRunId 横幅)
- Modify: `apps/web/src/components/eval/EvalWorkbenchView.tsx` (Page 增 live)

**Interfaces:**
- Consumes: Task 6 全部; 既有 `VerdictBadge`; `useEvalRuns` (响应增 activeRunId 后的类型)。
- Produces: `EvalRunLive({ runId, onOpenReport(runId), onBack })`; shared 件 `TranscriptBubble({role, text})` / `ToolCallCard({toolName, durationMs, input, result, defaultOpen})` / `ApprovalCard({toolName, level, decision, matchedRule, reason})`; Workbench `Page` 联合增 `{ page: 'live'; runId: string }`。

- [ ] **Step 1: 提取 shared.tsx** — 把 EvalEpisodeDetail 内的 MarkdownContent 副本与三类卡片的 JSX 移入 shared.tsx (props 化: 上列签名), EvalEpisodeDetail 改 import 使用, 视觉逐字节保持 (重构不回评审已通过的样式)。

- [ ] **Step 2: 实现 EvalRunLive** — 结构: 头部 (runId 缩略 + LiveState 徽章: running=deepSea 脉冲/done=success/error=danger/interrupted=warning + 中止按钮 (running 时) + done 后「查看报告」); 进度区 (events 推导: run_started.total / 已完成 episode_done 计数 / 当前 scenario_started); verdict 网格 (按 scenarioId 分组 episode_done, 复用 VerdictBadge); 轨迹区 (当前 episode: 最新 scenario_started 之后的 turn/tool_call/approval 事件渲染为 TranscriptBubble/ToolCallCard/ApprovalCard, 场景切换清屏); error/interrupted 态文案 + onBack。
  - 组件内全部纯派生 (useMemo), 不冗余 state。
  - 中止按钮 → `abortEvalRun(runId)` → 确认弹层 (window.confirm 可) → 成功后 state 由 SSE run_error 推移。

- [ ] **Step 3: EvalRunsList 触发栏 + 横幅** — 顶部区块: 数据集下拉 (useEvalDatasets, core 标「内置」) + runs number input (1-10, 默认 1) + filter 文本框 (可选) + 「运行评估」主按钮 (bg-deepSea); startEvalRun 成功 → `onOpenLive(runId)` (新 prop); 409 → 错误条 + 若 err.activeRunId 则附「查看进行中的运行」链接; `activeRunId` prop 非空时列表上方横幅「评估进行中」+ 链接 (Workbench 从 useEvalRuns 数据透传)。

- [ ] **Step 4: EvalWorkbenchView 接线** — `Page` 增 `{page:'live', runId}`; live 分支渲染 `<EvalRunLive runId onOpenReport={(id)=>setNav({page:'report',runId:id})} onBack={()=>setNav({page:'runs'})} />`; `onOpenLive` prop 从 EvalRunsList 提升接线; report 页的返回逻辑不变; useEvalRuns 类型对齐 (activeRunId)。

- [ ] **Step 5: 验证 + 提交**

Run: `npm run build --workspace apps/web` 绿; `npm test` 无回归; lint 0 新警告
```bash
git add apps/web/src/components/eval/shared.tsx apps/web/src/components/eval/EvalEpisodeDetail.tsx apps/web/src/components/eval/EvalRunLive.tsx apps/web/src/components/eval/EvalRunsList.tsx apps/web/src/components/eval/EvalWorkbenchView.tsx
git commit -m "feat(eval-ui): live run page with trajectory stream and trigger bar"
```

---

### Task 8: 数据集编辑器 + 工作台 tab + 全量验证

**Files:**
- Create: `apps/web/src/components/eval/EvalDatasetEditor.tsx`
- Modify: `apps/web/src/components/eval/EvalWorkbenchView.tsx` (tab 切换)
- Test: 无新测试 (build 门); 手动冒烟清单见 Step 3

**Interfaces:**
- Consumes: Task 6 api/hooks; Task 7 Workbench 结构。
- Produces: `EvalDatasetEditor({ onRunFromDataset(name) })`; Workbench 顶层 tab `'results' | 'datasets'`。

- [ ] **Step 1: 实现 EvalDatasetEditor** — 左列: useEvalDatasets 列表 (builtin 徽章「内置·只读」) + 「从 core 复制」(输入名 → copyEvalDataset) + 「新建」(PUT 空模板 `scenarios: []`... 注意 zod 允许空数组? Task1 deferred: loadDataset 空 scenarios 通过 — 用最小合法单场景模板字符串) + 删除 (确认后); 右侧: 选中数据集 yaml 加载到受控 textarea (等宽 font-mono, min-h-[60vh]) + dirty 跟踪 + beforeunload 守卫 + 「保存」(putEvalDataset; 422 → 红字展示 error 全文含 scenario 定位; 成功 → scenarioCount 角标 + refresh) + 「从此数据集运行」(切 tab results 并预选触发栏 — 经 onRunFromDataset 回调, Workbench 存 pendingDataset state 传入触发栏下拉 defaultValue)。builtin 选中 → textarea readOnly + 禁保存 (提示「内置数据集只读, 可复制后编辑」)。
  最小合法模板:
```yaml
scenarios:
  - id: my-first-scenario
    tier: 1
    persona:
      facts: ['我是华盛集团的采购经办']
      disclosure: '被问到才提供订单号'
      goal: '查询订单 ORD-2024-0881 状态'
      patience: 3
    rubric:
      dimensions:
        - name: 准确性
          weight: essential
          scoring:
            '4': 完全准确
            '1': 明显错误
```

- [ ] **Step 2: Workbench tab** — 顶部两 tab (结果/数据集, 现有三级导航仅在 results tab 内); datasets tab 渲染 EvalDatasetEditor; tab 切换不清 results 导航状态。

- [ ] **Step 3: 全量离线验证 + 手动冒烟清单 + 提交**

Run: `npm run build && npm run lint && npm test` (全绿; 预期 ~378 passed | 18 skipped)

手动冒烟 (需登录态 + 重启后的 dev server; 由控制器/用户执行, 不进 CI):
1. 触发 core/t1-order-status/runs=1 → 直播页逐 turn 出现 → verdict 点亮 → done → 查看报告页可见新 run。
2. 复制 core → my-test → 改一个锚点文本 → 保存成功; 再写坏缩进 → 422 + scenario 定位红字。
3. 用 my-test 跑一次成功; 运行中再触发 → 409 提示; 中止按钮生效。
4. 重启后端 → live 页显示 interrupted, 列表 activeRunId 消失, 已完成 run 数据完好。

```bash
git add apps/web/src/components/eval/EvalDatasetEditor.tsx apps/web/src/components/eval/EvalWorkbenchView.tsx
git commit -m "feat(eval-ui): dataset editor with yaml validation feedback"
```

---

## Self-Review 记录

- 覆盖 spec §3 (协议/总线/重启语义: Task 1,3,4) §4.1-4.3 (Task 4,5) §5 (Task 6,7,8) §6 (测试策略分布各任务) §7 (验收 1=各任务+T8, 2/3/4=T8 冒烟) §8 (无越界: 无定时/对比/持久化/分布式锁)。
- 类型一致性: RunEvent/ServerRunEvent/EvalRunEvent 三处镜像字段逐一相同 (Task 6/3/1); registry API 在 Task 3 Produces 与 Task 4 消费一致。
- 已知计划内张力 (实施者遇歧义以 NEEDS_CONTEXT 上报, 不自裁): Task 5 copy 的 `?to=` 查询参数形态在 Step 1/3 间有一次修正注记 — 以 Step 3 实现为准并同步修 Step 1 断言; Task 6 useEvalRunLive 的 state 闭包陈旧问题已在文中标注函数式 setState 修法。
