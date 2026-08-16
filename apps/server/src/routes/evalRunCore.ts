// apps/server/src/routes/evalRunCore.ts
// In-memory registry for server-triggered eval runs: single-concurrency lock,
// spawned-runner lifecycle, event buffer + fan-out. Server-side mirror of the
// @@EVT@@ protocol (SSOT: eval/agent/events.ts — src cannot import eval/**).

import { spawn } from 'node:child_process';
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
      // Stop-parsing semantic: once a terminal error state is reached (e.g.
      // run_error from the runner, or user kill), ignore any trailing stdout
      // lines -- never let a stray run_done flip an errored run back to done.
      if (state.state !== 'running') return;
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
