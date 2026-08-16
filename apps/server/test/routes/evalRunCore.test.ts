// apps/server/test/routes/evalRunCore.test.ts
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  EvalRunRegistry,
  parseServerEventLine,
  datasetArgFor,
  type RunnerFactory,
  type RunnerHandle,
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
class FakeHandle extends EventEmitter implements RunnerHandle {
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
  it('happy path: events buffered, subscribers notified, done terminal', async () => {
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
    // The fake runner emits via queueMicrotask; yield once so the script runs.
    await new Promise((r) => setTimeout(r, 0));
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

  it('runId shape: stamp-basename, normalized dataset arg, EVAL_RUN_ID passed through', () => {
    let seen: { args: string[]; env: NodeJS.ProcessEnv } | null = null;
    const factory: RunnerFactory = (args, env) => {
      seen = { args, env };
      return fakeFactory(() => {}).factory('', undefined as never) as never;
    };
    const reg = new EvalRunRegistry(factory);
    const res = reg.start({ dataset: 'user/mine', runs: 3, filter: 't1' });
    expect(res.ok).toBe(true);
    const runId = (res as { runId: string }).runId;
    expect(runId).toMatch(/^20\d{2}-\d{2}-\d{2}T[\d-]+Z-mine$/);
    expect(seen!.args).toEqual(['--dataset=datasets/user/mine.yaml', '--runs=3', '--filter=t1']);
    expect(seen!.env.EVAL_RUN_ID).toBe(runId);
  });

  it('kill wires the runner handle (process actually signaled), unknown -> false', () => {
    const { factory, handles } = fakeFactory(() => {});
    const reg = new EvalRunRegistry(factory);
    const res = reg.start({ dataset: 'core', runs: 1, filter: undefined });
    const runId = (res as { runId: string }).runId;
    expect(reg.kill(runId)).toBe(true);
    expect(handles[0].killed).toBe(true); // FakeHandle.kill was invoked by the registry
    expect((reg as unknown as { handles: Map<string, unknown> }).handles.size).toBe(0);
    expect(reg.kill('nope')).toBe(false);
  });

  it('terminal state clears the handle (no leak)', async () => {
    const { factory, handles } = fakeFactory((h) => {
      h.send('@@EVT@@{"type":"run_started","runId":"r","total":1}');
      h.send('@@EVT@@{"type":"run_done","outDir":"/tmp/r"}');
      h.end(0);
    });
    const reg = new EvalRunRegistry(factory);
    const res = reg.start({ dataset: 'core', runs: 1, filter: undefined });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    await new Promise((r) => setTimeout(r, 0));
    expect(reg.get((res as { runId: string }).runId)?.state).toBe('done');
    expect((reg as unknown as { handles: Map<string, unknown> }).handles.size).toBe(0);
    expect(handles[0].killed).toBe(false); // natural cleanup must not call kill
  });

  it('datasetArgFor: core/user normalization, rejects traversal and absolute paths', () => {
    expect(datasetArgFor('core')).toBe('datasets/core.yaml');
    expect(datasetArgFor('user/mine')).toBe('datasets/user/mine.yaml');
    expect(() => datasetArgFor('../x')).toThrow(/无效数据集/);
    expect(() => datasetArgFor('C:\\evil\\core')).toThrow(/无效数据集/);
    expect(() => datasetArgFor('/abs/core')).toThrow(/无效数据集/);
    expect(() => datasetArgFor('user/../core')).toThrow(/无效数据集/);
    expect(() => datasetArgFor('user-mine')).toThrow(/无效数据集/);
  });
});
