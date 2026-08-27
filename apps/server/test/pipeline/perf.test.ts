import { describe, expect, it, vi } from 'vitest';
import { StageProfiler } from '../../src/pipeline/perf.js';

describe('StageProfiler', () => {
  it('logs per-stage durations, a TOTAL rollup, and finish() is idempotent', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      // Clock ticks on each call: t0=0, mark(a)=120, mark(b)=400, finish=1520.
      const ticks = [0, 120, 520, 1520];
      let i = 0;
      const p = new StageProfiler('test docId=D1', { now: () => ticks[i++] ?? 1600 });

      p.mark('a');
      p.mark('b', 'x=1');
      p.finish();
      p.finish(); // second call must be a no-op

      const lines = log.mock.calls.map((c) => c.join(' '));
      expect(lines).toHaveLength(3);
      expect(lines[0]).toContain('[perf] test docId=D1 a=120ms');
      expect(lines[1]).toContain('b=400ms (x=1)');
      expect(lines[2]).toContain('TOTAL=1520ms');
      expect(lines[2]).toContain('a=120 b=400');
    } finally {
      log.mockRestore();
    }
  });

  it('supports an outcome note in the TOTAL line', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const ticks = [0, 30, 40];
      let i = 0;
      const p = new StageProfiler('process docId=D2', { now: () => ticks[i++] ?? 50 });
      p.mark('parse', 'digital, 5 blocks');
      p.finish('needs_ocr: parse failed');

      const lines = log.mock.calls.map((c) => c.join(' '));
      // TOTAL spans the profiler's whole lifetime (t0 -> finish), not the sum of stages.
      expect(lines[1]).toContain('TOTAL=40ms | needs_ocr: parse failed | parse=30');
    } finally {
      log.mockRestore();
    }
  });
});
