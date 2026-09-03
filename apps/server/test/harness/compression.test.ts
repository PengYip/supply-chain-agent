import { describe, it, expect } from 'vitest';
import type { ModelMessage } from 'ai';
import {
  compressByBudget,
  createFailureTracker,
  makeCircuitBreaker,
  DeterministicSummarizer,
  type ContractLookup,
  type Summarizer,
} from '../../src/harness/compression.js';

// Build a tool message carrying one tool-result part.
function toolMessage(
  toolName: string,
  output: unknown,
  toolCallId = 'tc_1',
): ModelMessage {
  return {
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId, toolName, output }],
  } as unknown as ModelMessage;
}

function userMessage(text: string): ModelMessage {
  return { role: 'user', content: text } as unknown as ModelMessage;
}

function assistantToolCallMessage(toolName: string, toolCallId = 'tc_1'): ModelMessage {
  return {
    role: 'assistant',
    content: [{ type: 'tool-call', toolCallId, toolName, input: {} }],
  } as unknown as ModelMessage;
}

// Extract the (first) tool-result output from a compressed history.
function firstOutput(messages: ModelMessage[]): unknown {
  for (const m of messages) {
    const content = (m as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content as Array<{ type?: string; output?: unknown }>) {
      if (part?.type === 'tool-result') return part.output;
    }
  }
  return undefined;
}

describe('compressByBudget - full budget', () => {
  it('passes the result through unchanged and returns the SAME array reference', () => {
    const lookup: ContractLookup = () => 'full';
    const messages: ModelMessage[] = [
      userMessage('hi'),
      assistantToolCallMessage('query_contract'),
      toolMessage('query_contract', {
        type: 'json',
        value: { ok: true, contractNo: 'HT-001', big: 'x'.repeat(5000) },
      }),
    ];
    const out = compressByBudget(messages, { contractLookup: lookup });
    // cache-friendly: nothing to compress -> same reference
    expect(out).toBe(messages);
    expect(firstOutput(out)).toEqual({
      type: 'json',
      value: { ok: true, contractNo: 'HT-001', big: 'x'.repeat(5000) },
    });
  });
});

describe('compressByBudget - summary budget', () => {
  it('truncates a large JSON output to key fields + a truncation marker', () => {
    const lookup: ContractLookup = () => 'summary';
    const big = {
      ok: true,
      contractNo: 'HT-2024-001',
      overallConfidence: 0.9,
      huge: 'x'.repeat(5000), // forces compression
      irrelevant: 'y'.repeat(2000),
    };
    const messages: ModelMessage[] = [
      assistantToolCallMessage('extract_fields'),
      toolMessage('extract_fields', { type: 'json', value: big }),
    ];
    const out = compressByBudget(messages, { contractLookup: lookup });
    const o = firstOutput(out) as { type: string; value: Record<string, unknown> };
    expect(o.type).toBe('json');
    // key fields retained
    expect(o.value.ok).toBe(true);
    expect(o.value.contractNo).toBe('HT-2024-001');
    expect(o.value.overallConfidence).toBe(0.9);
    // dropped noise
    expect(o.value.huge).toBeUndefined();
    expect(o.value.irrelevant).toBeUndefined();
    // marker present
    expect(o.value._summarized).toBe(true);
    expect(typeof o.value._omittedBytes).toBe('number');
    expect(o.value._omittedBytes as number).toBeGreaterThan(5000);
  });

  it('keeps a small JSON output verbatim (below the threshold)', () => {
    const lookup: ContractLookup = () => 'summary';
    const small = { type: 'json', value: { ok: true, status: 'verified' } };
    const messages: ModelMessage[] = [
      assistantToolCallMessage('verify_document_fields'),
      toolMessage('verify_document_fields', small),
    ];
    const out = compressByBudget(messages, { contractLookup: lookup });
    expect(firstOutput(out)).toEqual(small);
  });

  it('truncates long text output', () => {
    const lookup: ContractLookup = () => 'summary';
    const longText = { type: 'text', value: 'A'.repeat(2000) };
    const messages: ModelMessage[] = [
      assistantToolCallMessage('query_orders'),
      toolMessage('query_orders', longText),
    ];
    const out = compressByBudget(messages, {
      contractLookup: lookup,
      summaryMaxChars: 100,
    });
    const o = firstOutput(out) as { type: string; value: string };
    expect(o.type).toBe('text');
    expect(o.value.length).toBeLessThan(2000);
    expect(o.value).toContain('truncated');
  });
});

describe('compressByBudget - structured evidence summaries', () => {
  it('keeps review-card fields available to the model while dropping bulky chunk text', () => {
    const review = {
      docId: 'DOC-lab',
      docType: '化验报告',
      classificationConfidence: 0.9,
      fields: [
        {
          name: '指标',
          value: JSON.stringify([
            { 基准: 'ar', 全水_百分比: 18.2, 低位发热量_千卡每kg: 4871 },
            { 基准: 'ad', 灰分_百分比: 14.63, 全硫_百分比: 0.81 },
            { 基准: 'daf', 挥发分_百分比: 30.84 },
          ]),
          confidence: 0.9,
          needsReview: false,
        },
        { name: '重量_吨', value: 5429.24, confidence: 0.9, needsReview: false },
      ],
      overallConfidence: 0.9,
      proposedRelationships: [],
      tags: ['化验报告'],
      chunkTags: ['noise'],
      chunkTagDetails: [
        { tag: 'noise', chunks: [{ chunkIndex: 0, text: 'x'.repeat(3000) }] },
      ],
      vectorization: { status: 'skipped', mode: 'test', chunkCount: 1 },
      reviewStatus: 'confirmed',
      warnings: [],
      batch: null,
    };
    const messages: ModelMessage[] = [
      assistantToolCallMessage('present_document_review'),
      toolMessage('present_document_review', { type: 'json', value: review }),
    ];

    const out = compressByBudget(messages);
    const o = firstOutput(out) as { type: string; value: Record<string, unknown> };
    expect(o.type).toBe('json');
    expect(o.value.docType).toBe('化验报告');
    expect(JSON.stringify(o.value.fields)).toContain('4871');
    expect(JSON.stringify(o.value.fields)).toContain('0.81');
    expect(JSON.stringify(o.value.fields)).toContain('30.84');
    expect(o.value.chunkTagDetails).toBeUndefined();
    expect(o.value._summarized).toBe(true);
  });

  it('keeps extract_fields evidence fields available to the model', () => {
    const extraction = {
      extractionId: 'EX-lab',
      fields: [
        {
          name: '指标1.低位发热量_千卡每kg',
          value: '<external_content source="document">\n4871\n</external_content>',
          confidence: 0.6,
          needsReview: true,
          autoAccepted: false,
        },
        {
          name: '指标2.全硫_百分比',
          value: '<external_content source="document">\n0.81\n</external_content>',
          confidence: 0.6,
          needsReview: true,
          autoAccepted: false,
        },
      ],
      overallConfidence: 0.6,
      needsReview: true,
      missingRequired: [],
      reason: 'large_serialization:' + 'x'.repeat(5000),
    };
    const messages: ModelMessage[] = [
      assistantToolCallMessage('extract_fields'),
      toolMessage('extract_fields', { type: 'json', value: extraction }),
    ];

    const out = compressByBudget(messages);
    const o = firstOutput(out) as { type: string; value: Record<string, unknown> };
    expect(o.type).toBe('json');
    expect(o.value.extractionId).toBe('EX-lab');
    const fields = o.value.fields as Array<{ name: string; value: string }>;
    expect(fields.find((f) => f.name === '指标1.低位发热量_千卡每kg')?.value).toContain('4871');
    expect(fields.find((f) => f.name === '指标2.全硫_百分比')?.value).toContain('0.81');
    expect(o.value._summarized).toBe(true);
  });
});

describe('compressByBudget - verdict budget', () => {
  it('reduces a JSON output to a one-line text status', () => {
    const lookup: ContractLookup = () => 'verdict';
    const messages: ModelMessage[] = [
      assistantToolCallMessage('query_orders'),
      toolMessage('query_orders', {
        type: 'json',
        value: {
          ok: true,
          status: 'verified',
          contractNo: 'HT-001',
          rows: Array.from({ length: 100 }, (_, i) => i), // noise
        },
      }),
    ];
    const out = compressByBudget(messages, { contractLookup: lookup });
    const o = firstOutput(out) as { type: string; value: string };
    expect(o.type).toBe('text');
    // one line, carries the key fields, drops the rows noise
    expect(o.value).not.toContain('\n');
    expect(o.value).toMatch(/ok=true/);
    expect(o.value).toMatch(/status=verified/);
    expect(o.value).toMatch(/contractNo=HT-001/);
  });
});

describe('compressByBudget - safety', () => {
  it('preserves tool-call / tool-result pairing (never drops a result)', () => {
    const lookup: ContractLookup = () => 'verdict';
    const messages: ModelMessage[] = [
      userMessage('go'),
      assistantToolCallMessage('query_orders'),
      toolMessage('query_orders', { type: 'json', value: { ok: true } }),
    ];
    const out = compressByBudget(messages, { contractLookup: lookup });
    // the tool result part is still present (paired with the call), only shrunk
    const hasResult = (out as unknown as Array<{ content?: unknown }>).some((m) => {
      const c = m.content;
      return Array.isArray(c) && c.some((p) => (p as { type?: string }).type === 'tool-result');
    });
    expect(hasResult).toBe(true);
  });

  it('injects a custom Summarizer (pluggable hook for a future LLM impl)', () => {
    const lookup: ContractLookup = () => 'summary';
    const custom: Summarizer = {
      summarize: (_n, _o) => ({ type: 'text', value: 'CUSTOM-SUMMARY' }),
      verdict: (_n, _o) => ({ type: 'text', value: 'CUSTOM-VERDICT' }),
    };
    const messages: ModelMessage[] = [
      assistantToolCallMessage('extract_fields'),
      toolMessage('extract_fields', { type: 'json', value: { big: 'x'.repeat(5000) } }),
    ];
    const out = compressByBudget(messages, { contractLookup: lookup, summarizer: custom });
    const o = firstOutput(out) as { type: string; value: string };
    expect(o.value).toBe('CUSTOM-SUMMARY');
  });
});

describe('DeterministicSummarizer', () => {
  const s = new DeterministicSummarizer(100);
  it('summarize keeps small json verbatim and shrinks large json to key fields', () => {
    expect(s.summarize('t', { type: 'json', value: { ok: true } })).toEqual({
      type: 'json',
      value: { ok: true },
    });
    const out = s.summarize('t', {
      type: 'json',
      value: { ok: false, status: 'err', noise: 'z'.repeat(500) },
    }) as { type: string; value: Record<string, unknown> };
    expect(out.value.ok).toBe(false);
    expect(out.value.status).toBe('err');
    expect(out.value.noise).toBeUndefined();
    expect(out.value._summarized).toBe(true);
  });

  it('verdict yields a single line for json and text', () => {
    const v1 = s.verdict('t', { type: 'json', value: { ok: true, ticketId: 'ESC-1' } }) as {
      type: string; value: string;
    };
    expect(v1.type).toBe('text');
    expect(v1.value).not.toContain('\n');
    expect(v1.value).toMatch(/ok=true/);

    const v2 = s.verdict('t', { type: 'text', value: 'line one\nline two' }) as {
      type: string; value: string;
    };
    expect(v2.value).toBe('line one');
  });
});

describe('circuit breaker (L5)', () => {
  it('createFailureTracker trips after threshold consecutive failures and resets on success', () => {
    const f = createFailureTracker(3);
    expect(f.shouldStop).toBe(false);
    f.recordToolFinish(false); // 1
    expect(f.consecutiveFailures).toBe(1);
    expect(f.shouldStop).toBe(false);
    f.recordToolFinish(false); // 2
    expect(f.shouldStop).toBe(false);
    f.recordToolFinish(false); // 3
    expect(f.consecutiveFailures).toBe(3);
    expect(f.shouldStop).toBe(true);
    // a success resets the streak
    f.recordToolFinish(true);
    expect(f.consecutiveFailures).toBe(0);
    expect(f.shouldStop).toBe(false);
  });

  it('makeCircuitBreaker returns a StopCondition that mirrors the predicate', () => {
    let failures = 0;
    const cond = makeCircuitBreaker(() => failures >= 3);
    expect(cond({ steps: [] })).toBe(false);
    failures = 2;
    expect(cond({ steps: [] })).toBe(false);
    failures = 3;
    expect(cond({ steps: [] })).toBe(true);
    failures = 5;
    expect(cond({ steps: [] })).toBe(true);
  });
});
