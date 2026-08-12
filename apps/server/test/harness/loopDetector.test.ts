import { describe, it, expect } from 'vitest';
import { createFailureTracker, stableStringify } from '../../src/harness/compression.js';

describe('FailureTracker repeat-call fingerprint', () => {
  it('stableStringify is key-order-independent', () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
    expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: 2 }));
  });

  it('isLooping flips true after the SAME (tool,args) is recorded 3 times', () => {
    const f = createFailureTracker(3);
    expect(f.isLooping).toBe(false);
    f.recordToolCall('ingest_document', { docId: 'd1' });
    f.recordToolCall('ingest_document', { docId: 'd1' });
    expect(f.isLooping).toBe(false); // 2 calls = 1 repeat, not yet a loop
    f.recordToolCall('ingest_document', { docId: 'd1' });
    expect(f.isLooping).toBe(true); // 3rd identical = stuck
  });

  it('different args do not trip the loop guard', () => {
    const f = createFailureTracker(3);
    f.recordToolCall('ingest_document', { docId: 'd1' });
    f.recordToolCall('ingest_document', { docId: 'd2' });
    f.recordToolCall('ingest_document', { docId: 'd3' });
    expect(f.isLooping).toBe(false);
  });

  it('different tools with same args do not trip (fingerprint includes toolName)', () => {
    const f = createFailureTracker(3);
    f.recordToolCall('ingest_document', { x: 1 });
    f.recordToolCall('extract_fields', { x: 1 });
    f.recordToolCall('ingest_document', { x: 1 });
    expect(f.isLooping).toBe(false);
  });
});
