import { describe, it, expect } from 'vitest';
import { contracts, payments, linkDocumentToContract, recordPayment } from '../../src/data/seed.js';
import { resetSeedForEval, snapshotEnv } from '../../eval/agent/seedEnv.js';

describe('seedEnv', () => {
  it('resetSeedForEval clears payments and restores linkedDocuments', () => {
    resetSeedForEval();
    linkDocumentToContract('HT-2024-001', 'FP-2024-0920-009');
    recordPayment({ contractNo: 'HT-2024-001', amount: 1, authorizedTicketId: 'T-x' });
    expect(payments.length).toBe(1);
    resetSeedForEval();
    expect(payments).toHaveLength(0);
    const c = contracts.find((x) => x.contractNo === 'HT-2024-001')!;
    expect(c.linkedDocuments).toEqual(['BL-2024-0815-001']);
  });
  it('snapshotEnv clones live state (later mutations do not leak in)', () => {
    resetSeedForEval();
    const snap = snapshotEnv();
    expect(snap.payments).toHaveLength(0);
    expect(snap.contractLinked['HT-2024-001']).toEqual(['BL-2024-0815-001']);
    recordPayment({ contractNo: 'HT-2024-001', amount: 5, authorizedTicketId: 'T-y' });
    expect(snap.payments).toHaveLength(0);
  });
  it('reset is repeatable across multiple calls', () => {
    resetSeedForEval();
    resetSeedForEval();
    expect(contracts).toHaveLength(1);
  });
});
