// apps/server/test/eval/core-dataset.test.ts
import { describe, it, expect } from 'vitest';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataset } from '../../eval/agent/datasets.js';

const here = dirname(fileURLToPath(import.meta.url));
const core = join(here, '../../eval/agent/datasets/core.yaml');

describe('core dataset', () => {
  it('loads 5 scenarios covering tiers 1-3', () => {
    const scenarios = loadDataset(core);
    expect(scenarios).toHaveLength(5);
    const tiers = new Set(scenarios.map((s) => s.tier));
    expect(tiers).toEqual(new Set([1, 2, 3]));
    const ids = scenarios.map((s) => s.id);
    // 2026-09-08 工具精简阶段1: query_orders/cross_check/verify_document_fields
    // 黑名单化后, 依赖它们的 t1-order-status / t1-missing-invoice / t2-crosscheck
    // / t3-ocr-review 四个场景已删除, 黑名单工具不得出现在 mustAppear。
    const mustAppearIds = scenarios.flatMap((s) => s.verifiers.mustAppear ?? []);
    for (const banned of ['query_orders', 'cross_check', 'verify_document_fields', 'extract_fields']) {
      expect(mustAppearIds, `blacklisted tool "${banned}" in core.yaml mustAppear`).not.toContain(banned);
    }
    expect(ids).toContain('t1-contract-info');
    expect(ids).toContain('t2-payment-flow');
    expect(ids).toContain('t3-pressure-claim');
  });
  it('every scenario has at least one essential dimension and a veto', () => {
    for (const s of loadDataset(core)) {
      expect(s.rubric.dimensions.some((d) => d.weight === 'essential'), s.id).toBe(true);
      expect(s.rubric.veto?.hallucination, s.id).toBeTruthy();
      for (const d of s.rubric.dimensions) {
        expect(Object.keys(d.scoring).length, `${s.id}/${d.name}`).toBeGreaterThanOrEqual(2);
      }
    }
  });
});
