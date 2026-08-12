// Context compression (integration point 2 of the tool-context contract).
//
// Consumes the `budget` field declared per tool in contextContract.ts and
// rewrites the message history handed to the model so a tool result only enters
// the context window at its declared fidelity:
//   - 'full'    -> pass-through unchanged (the model sees everything).
//   - 'summary' -> deterministic compress: large JSON outputs are shrunk to a
//                  few key fields + a truncation marker; long text is truncated.
//                  No LLM call (latency + nondeterminism); a pluggable
//                  Summarizer interface is exposed for a future LLM hook (L4).
//   - 'verdict' -> one-line status string.
//
// It also runs a conservative drop tier: old tool-call/result PAIRS for
// summary/verdict-budget tools are pruned (keep recent N messages) via the
// SDK's pruneMessages, which removes both halves of a pair so the
// tool-call <-> tool-result correlation required by OpenAI-compatible APIs
// stays valid. 'full'-budget tools are never pruned.
//
// Wiring (AUTO-LOOP variant): compressByBudget is called from streamText's
// prepareStep (returns {messages}); it runs one step LATE (the step that just
// produced the result is already committed), which is acceptable for the short
// stepCountIs(5) internal tool. withAudit in agent.ts already archived the FULL
// result before any compression on the NEXT step, so audit/status see full data
// -- this module must NOT re-archive.
//
// DEFERRED (not in v1):
//  - L3: API-level micro-compression (provider-gated; N/A on @ai-sdk/openai
//    which exposes no cache-control / context-compression knob).
//  - L4: LLM archival summary. The Summarizer interface below is the hook; the
//    DeterministicSummarizer is the default. A future LlmSummarizer can be
//    injected via CompressionOpts without touching call sites.
//
// Prefix-cache note: any mid-history rewrite invalidates OpenAI prefix caching
// for the rewritten prefix. We mitigate by returning the SAME array reference
// when nothing actually changed (all-'full' history), so cache hits are
// preserved on the common path.

import {
  pruneMessages,
  type ModelMessage,
  type StopCondition,
} from 'ai';
import {
  getContract,
  type ContractBudget,
  type ToolContextContract,
} from './contextContract.js';

/** Budget above which a 'summary' output is compressed (approx char count). */
const DEFAULT_SUMMARY_MAX_CHARS = 800;
/** Keep at least this many trailing messages when pruning (drop tier). */
const DEFAULT_KEEP_LAST_N = 8;
/** Max length of a 'verdict' one-liner. */
const VERDICT_MAX_CHARS = 160;

/**
 * Top-level fields worth retaining when a 'summary'-budget JSON output is too
 * large. These are the handles the agent reasons over (handles, statuses,
 * confidence, escalation ticket) -- everything else is dropped on compress.
 */
const KEY_FIELDS = [
  'ok',
  'status',
  'needsReview',
  'needsManualReview',
  'contractNo',
  'paymentId',
  'ticketId',
  'bindingId',
  'docId',
  'extractionId',
  'overallConfidence',
  'reason',
] as const;

/**
 * Pluggable summarizer. The deterministic default impl is exported below; a
 * future LLM-backed summarizer (L4) can implement this and be injected via
 * CompressionOpts without changing call sites or the prepareStep wiring.
 */
export interface Summarizer {
  /** budget 'summary': shrink a tool output, keeping key fields. */
  summarize(toolName: string, output: unknown): unknown;
  /** budget 'verdict': reduce a tool output to a one-line status. */
  verdict(toolName: string, output: unknown): unknown;
}

/** Look up a tool's budget. Returns 'full' for unknown tools (fail open). */
export type ContractLookup = (toolName: string) => ContractBudget | undefined;

/** Options for compressByBudget. */
export interface CompressionOpts {
  /** Contract budget lookup. Defaults to the real getContract. */
  contractLookup?: ContractLookup;
  /** Summarizer for summary/verdict budgets. Defaults to DeterministicSummarizer. */
  summarizer?: Summarizer;
  /** 'summary' compression threshold (chars). */
  summaryMaxChars?: number;
  /** Keep at least this many trailing messages in the drop tier. */
  keepLastN?: number;
}

// ---- internal helpers -------------------------------------------------------

/** Structural view of a tool-result content part (robust to SDK minor changes). */
interface ToolResultPartLike {
  type: 'tool-result';
  toolCallId: string;
  toolName: string;
  output: unknown;
  providerOptions?: unknown;
}
interface ToolMessageLike {
  role: 'tool';
  content: ToolResultPartLike[];
}
interface AnyMessage {
  role: string;
  content: unknown;
  [k: string]: unknown;
}

function isToolMessage(m: AnyMessage): m is AnyMessage & ToolMessageLike {
  return m.role === 'tool' && Array.isArray(m.content);
}

/** Normalize an SDK tool output into {type, value}; tolerant of raw shapes. */
function asOutput(o: unknown): { type: string; value: unknown } {
  if (o !== null && typeof o === 'object' && typeof (o as { type?: unknown }).type === 'string') {
    return { type: (o as { type: string }).type, value: (o as { value?: unknown }).value };
  }
  // Some paths hand a bare string/object; coerce to the nearest structured form.
  if (typeof o === 'string') return { type: 'text', value: o };
  return { type: 'json', value: o };
}

function pickKeyFields(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of KEY_FIELDS) {
    if (k in src) out[k] = src[k];
  }
  return out;
}

function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `...[truncated ${text.length - max} chars]`;
}

// ---- DeterministicSummarizer ------------------------------------------------

/**
 * Default Summarizer: pure, deterministic, no LLM call. Safe to run inside
 * prepareStep (no latency / nondeterminism).
 */
export class DeterministicSummarizer implements Summarizer {
  constructor(private readonly maxChars: number = DEFAULT_SUMMARY_MAX_CHARS) {}

  summarize(_toolName: string, output: unknown): unknown {
    const { type, value } = asOutput(output);
    if (type === 'text') {
      return { type: 'text', value: truncateText(String(value ?? ''), this.maxChars) };
    }
    if (type === 'json') {
      const serialized = safeStringify(value);
      if (serialized.length <= this.maxChars) return output; // small enough -> keep verbatim
      const kept = pickKeyFields(value);
      return {
        type: 'json',
        value: {
          _summarized: true,
          _omittedBytes: serialized.length,
          ...kept,
        },
      };
    }
    // error-text / error-json / content / unknown -> preserve (signals/binary).
    return output;
  }

  verdict(_toolName: string, output: unknown): unknown {
    const { type, value } = asOutput(output);
    if (type === 'json') {
      const fields = pickKeyFields(value);
      const pairs = Object.entries(fields)
        .map(([k, v]) => `${k}=${formatScalar(v)}`)
        .join('; ');
      const line = pairs.length > 0 ? pairs : '[verdict: no key fields]';
      return { type: 'text', value: truncateText(line, VERDICT_MAX_CHARS) };
    }
    if (type === 'text') {
      const firstLine = String(value ?? '').split(/\r?\n/)[0] ?? '';
      return { type: 'text', value: truncateText(firstLine, VERDICT_MAX_CHARS) };
    }
    if (type === 'error-text') {
      const firstLine = String(value ?? '').split(/\r?\n/)[0] ?? '';
      return { type: 'error-text', value: truncateText(firstLine, VERDICT_MAX_CHARS) };
    }
    // error-json / content / unknown: fall back to a minimal json verdict.
    const fields = pickKeyFields(value);
    const line = Object.entries(fields)
      .map(([k, v]) => `${k}=${formatScalar(v)}`)
      .join('; ');
    return { type: 'text', value: line || '[verdict]' };
  }
}

function formatScalar(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'object') return '[obj]';
  return String(v);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

// ---- compressByBudget -------------------------------------------------------

/**
 * Compress a message history according to each tool result's declared budget.
 * Returns a NEW array only when something actually changed; otherwise returns
 * the original `messages` reference (preserves OpenAI prefix-cache hits on the
 * all-'full' common path).
 *
 * Two phases:
 *  (1) per-result fidelity: full=keep, summary=deterministic shrink,
 *      verdict=one-line. Never removes a result (tool-call/result pairing stays
 *      intact), only shrinks the output payload.
 *  (2) drop tier: prune OLD tool-call/result pairs for summary/verdict-budget
 *      tools via pruneMessages (keeps the last `keepLastN` messages). 'full'
 *      tools are never pruned. Skipped entirely when no prunable tool is present
 *      or the history is short.
 */
export function compressByBudget(
  messages: ModelMessage[],
  opts: CompressionOpts = {},
): ModelMessage[] {
  const lookup = opts.contractLookup ?? defaultLookup;
  const summarizer = opts.summarizer ?? new DeterministicSummarizer(opts.summaryMaxChars);
  const keepLastN = opts.keepLastN ?? DEFAULT_KEEP_LAST_N;

  const any = messages as unknown as AnyMessage[];

  // Phase 1: per-result budget compression.
  const prunableTools = new Set<string>();
  let changed = false;
  const phase1: AnyMessage[] = any.map((msg) => {
    if (!isToolMessage(msg)) return msg;
    let partChanged = false;
    const newContent = msg.content.map((part) => {
      const budget = lookup(part.toolName) ?? 'full';
      if (budget === 'summary' || budget === 'verdict') prunableTools.add(part.toolName);
      if (budget === 'full') return part;
      const next =
        budget === 'summary'
          ? summarizer.summarize(part.toolName, part.output)
          : summarizer.verdict(part.toolName, part.output);
      if (next === part.output) return part;
      partChanged = true;
      return { ...part, output: next };
    });
    if (!partChanged) return msg;
    changed = true;
    return { ...msg, content: newContent };
  });

  if (!changed) {
    // Nothing compressed. Only prune if there is something prunable + a long
    // enough history; otherwise return the original reference (cache-friendly).
    if (prunableTools.size === 0 || any.length <= keepLastN + 2) {
      return messages;
    }
  }

  let result = changed ? (phase1 as unknown as ModelMessage[]) : messages;

  // Phase 2: drop tier for summary/verdict-budget tools only.
  if (prunableTools.size > 0 && any.length > keepLastN + 2) {
    result = pruneMessages({
      messages: result,
      toolCalls: [
        {
          type: `before-last-${keepLastN}-messages`,
          tools: [...prunableTools],
        },
      ],
    });
  }

  return result;
}

function defaultLookup(toolName: string): ContractBudget | undefined {
  let c: ToolContextContract | undefined;
  try {
    c = getContract(toolName);
  } catch {
    return undefined;
  }
  return c?.budget;
}

// ---- circuit breaker (L5) ---------------------------------------------------

/**
 * Deterministic JSON stringification (sorted object keys) so two structurally
 * identical args produce the same fingerprint regardless of key insertion order.
 * Throw-safe on circular input (falls back to String(value)).
 */
export function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_k, v) =>
      v && typeof v === 'object' && !Array.isArray(v)
        ? Object.keys(v).sort().reduce((acc: Record<string, unknown>, k) => {
            acc[k] = (v as Record<string, unknown>)[k];
            return acc;
          }, {})
        : v,
    );
  } catch {
    return String(value);
  }
}

/**
 * Stateful consecutive-failure tracker. recordToolFinish(true) resets the
 * streak; recordToolFinish(false) increments it. `shouldStop` flips true once
 * the streak reaches `threshold` (default 3). Exposed for unit testing and so
 * runStream's onToolCallFinish / stopWhen share one source of truth.
 *
 * Phase 6 T2 (book Ch5:186): also tracks repeat-call fingerprints via
 * recordToolCall(toolName, args). `isLooping` flips true when any single
 * (toolName, args) fingerprint accumulates >= threshold records — a no-progress
 * loop signal. The map is cumulative within a turn (the tracker is fresh per
 * runStream call, max 5 steps, so 3 identical calls in one turn IS a loop).
 */
export interface FailureTracker {
  recordToolFinish(success: boolean): void;
  /** Record a tool call for repeat-call fingerprint loop detection (book Ch5:186). */
  recordToolCall(toolName: string, args: unknown): void;
  readonly consecutiveFailures: number;
  readonly shouldStop: boolean;
  /** True when any single (toolName,args) fingerprint has been recorded >= threshold times. */
  readonly isLooping: boolean;
}

export function createFailureTracker(threshold = 3): FailureTracker {
  let consecutiveFailures = 0;
  const fpCounts = new Map<string, number>();
  let looping = false;
  return {
    recordToolFinish(success: boolean): void {
      consecutiveFailures = success ? 0 : consecutiveFailures + 1;
    },
    recordToolCall(toolName: string, args: unknown): void {
      const fp = `${toolName}::${stableStringify(args)}`;
      const next = (fpCounts.get(fp) ?? 0) + 1;
      fpCounts.set(fp, next);
      if (next >= threshold) looping = true;
    },
    get consecutiveFailures(): number {
      return consecutiveFailures;
    },
    get shouldStop(): boolean {
      return consecutiveFailures >= threshold;
    },
    get isLooping(): boolean {
      return looping;
    },
  };
}

/**
 * Build a StopCondition that stops the loop when `shouldStop` returns true.
 * `shouldStop` is a thunk (typically `() => failures.shouldStop`) so it reads
 * the live counter updated by onToolCallFinish between steps. The steps array
 * is accepted to satisfy the StopCondition signature but intentionally unused
 * -- the failure signal comes from onToolCallFinish, not step inspection.
 */
export function makeCircuitBreaker(
  shouldStop: () => boolean,
): StopCondition<any> {
  return function circuitBreakerStop(): boolean {
    return shouldStop();
  };
}
