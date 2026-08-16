// apps/server/src/routes/evalRunCore.ts
// In-memory registry for server-triggered eval runs: single-concurrency lock,
// spawned-runner lifecycle, event buffer + fan-out. Server-side mirror of the
// @@EVT@@ protocol (SSOT: eval/agent/events.ts — src cannot import eval/**).

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const EVT_PREFIX = '@@EVT@@';

// Spawn tsx via node directly (no npx wrapper) so the registry's child.kill()
// signals the actual runner process, not an orphaned npx wrapper. The package
// bin entry is the exported path (probe-verified: 'tsx/cli' -> dist/cli.mjs;
// 'tsx/dist/cli.mjs' is NOT exported).
const require_ = createRequire(import.meta.url);
let tsxCliPath: string | null = null;
try {
  tsxCliPath = require_.resolve('tsx/cli');
} catch {
  tsxCliPath = null;
}

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
  // node <tsx-cli> keeps child.kill() on the real runner process. Fall back to
  // the npx wrapper only when the tsx bin path could not be resolved.
  const command = tsxCliPath ? process.execPath : process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const spawnArgs = tsxCliPath
    ? [tsxCliPath, 'eval/agent/run.ts', ...args]
    : ['tsx', 'eval/agent/run.ts', ...args];
  const child = spawn(
    command,
    spawnArgs,
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

/**
 * Dataset identifier contract: 'core' or 'user/<name>' (single segment).
 * Returns the runner CLI arg value. Rejects traversal ('..'), absolute paths,
 * and any other form by throwing (T4 maps this to 422).
 */
export function datasetArgFor(dataset: string): string {
  if (dataset.includes('..')) throw new Error(`无效数据集: ${dataset}`);
  if (dataset === 'core') return 'datasets/core.yaml';
  const m = /^user\/([^/]+)$/.exec(dataset);
  if (m && m[1]) return `datasets/user/${m[1]}.yaml`;
  throw new Error(`无效数据集: ${dataset}`);
}

export class EvalRunRegistry {
  private readonly factory: RunnerFactory;
  private readonly runs = new Map<string, LiveRunState>();
  private readonly subs = new Map<string, Set<(e: ServerRunEvent) => void>>();
  private readonly handles = new Map<string, RunnerHandle>();

  constructor(factory: RunnerFactory = defaultRunnerFactory) {
    this.factory = factory;
  }

  start(opts: { dataset: string; runs: number; filter?: string }): { ok: true; runId: string } | { ok: false; error: 'busy' } {
    const datasetArg = datasetArgFor(opts.dataset); // throws 无效数据集 for bad identifiers
    for (const st of this.runs.values()) {
      if (st.state === 'running') return { ok: false, error: 'busy' };
    }
    const tag = opts.dataset.split('/').pop()!;
    const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${tag}`;
    const state: LiveRunState = { runId, state: 'running', events: [], startedAt: new Date().toISOString() };
    this.runs.set(runId, state);

    const args = [`--dataset=${datasetArg}`, `--runs=${opts.runs}`];
    if (opts.filter) args.push(`--filter=${opts.filter}`);
    const handle = this.factory(args, { EVAL_RUN_ID: runId });
    this.handles.set(runId, handle);

    const dropHandle = () => { this.handles.delete(runId); };

    handle.onStdoutLine((line) => {
      // Stop-parsing semantic: once a terminal error state is reached (e.g.
      // run_error from the runner, or user kill), ignore any trailing stdout
      // lines -- never let a stray run_done flip an errored run back to done.
      if (state.state !== 'running') return;
      const evt = parseServerEventLine(line);
      if (!evt) return;
      state.events.push(evt);
      if (evt.type === 'run_done') { state.state = 'done'; dropHandle(); }
      if (evt.type === 'run_error') { state.state = 'error'; state.error = evt.message; dropHandle(); }
      for (const cb of this.subs.get(runId) ?? []) cb(evt);
    });
    handle.onExit((code) => {
      if (state.state !== 'running') { dropHandle(); return; }
      state.state = 'error';
      const synth: ServerRunEvent = { type: 'run_error', message: `runner 异常退出 (code=${code ?? 'null'})` };
      state.events.push(synth);
      state.error = synth.message;
      dropHandle();
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
    const handle = this.handles.get(runId);
    try { handle?.kill(); } catch { /* best-effort process termination */ }
    this.handles.delete(runId);
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
