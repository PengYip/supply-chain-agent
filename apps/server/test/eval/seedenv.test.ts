import { describe, it, expect } from 'vitest';
import { contracts, linkDocumentToContract } from '../../src/data/seed.js';
import { resetSeedForEval, snapshotEnv } from '../../eval/agent/seedEnv.js';

describe('seedEnv', () => {
  it('resetSeedForEval restores linkedDocuments', () => {
    resetSeedForEval();
    linkDocumentToContract('HT-2024-001', 'FP-2024-0920-009');
    expect(contracts.find((x) => x.contractNo === 'HT-2024-001')!.linkedDocuments).toContain('FP-2024-0920-009');
    resetSeedForEval();
    expect(contracts.find((x) => x.contractNo === 'HT-2024-001')!.linkedDocuments).toEqual(['BL-2024-0815-001']);
  });
  it('snapshotEnv clones live state (later mutations do not leak in)', () => {
    resetSeedForEval();
    const snap = snapshotEnv();
    expect(snap.contractLinked['HT-2024-001']).toEqual(['BL-2024-0815-001']);
  });
  it('reset is repeatable across multiple calls', () => {
    resetSeedForEval();
    resetSeedForEval();
    expect(contracts).toHaveLength(1);
  });
});
