// Lightweight stage profiler for the document parse pipeline.
//
// Purpose: quantify per-stage wall-clock cost of ingest/process (OCR parse,
// LLM classify/tag/extract, embedding, DB writes) so slow stages get targeted
// with data instead of guesswork. Pure console output, zero deps: visible via
// pm2 logs and greppable on the fixed `[perf]` tag.

export interface StageSample {
  stage: string;
  ms: number;
  detail?: string;
}

export interface StageProfilerOptions {
  /** Clock injection (tests). Defaults to the monotonic performance.now. */
  now?: () => number;
}

/**
 * Logs each stage the moment it closes as
 * `[perf] <label> <stage>=<ms>ms (<detail>)`, and rolls up a
 * `[perf] <label> TOTAL=<ms>ms | s1=x s2=y ...` timeline on finish().
 * Immediate per-stage logging means even a crashed run leaves partial data;
 * finish() is idempotent so multiple early-return paths stay safe.
 */
export class StageProfiler {
  private readonly nowFn: () => number;
  private readonly t0: number;
  private prev: number;
  private readonly samples: StageSample[] = [];
  private finished = false;

  constructor(private readonly label: string, opts: StageProfilerOptions = {}) {
    this.nowFn = opts.now ?? (() => performance.now());
    this.t0 = this.nowFn();
    this.prev = this.t0;
  }

  /** Close the current stage interval and log its duration. */
  mark(stage: string, detail?: string): void {
    const end = this.nowFn();
    const ms = Math.round(end - this.prev);
    this.prev = end;
    this.samples.push(detail === undefined ? { stage, ms } : { stage, ms, detail });
    console.log(`[perf] ${this.label} ${stage}=${ms}ms${detail ? ` (${detail})` : ''}`);
  }

  /** Emit the TOTAL rollup. Idempotent; optional trailing note (outcome etc). */
  finish(note?: string): void {
    if (this.finished) return;
    this.finished = true;
    const total = Math.round(this.nowFn() - this.t0);
    const timeline = this.samples.map((s) => `${s.stage}=${s.ms}`).join(' ');
    console.log(
      `[perf] ${this.label} TOTAL=${total}ms${note ? ` | ${note}` : ''}${timeline ? ` | ${timeline}` : ''}`,
    );
  }
}
