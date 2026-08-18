// apps/server/eval/agent/seedEnv.ts
// The business tools read/write in-memory module state in src/data/seed.ts
// (contracts.linkedDocuments). Episodes must reset that state so each run
// starts from an identical initial condition (book Ch6: reliable reset
// semantics), and verifiers need a point-in-time snapshot of the outcome.
import { contracts, orders, documents, inventory } from '../../src/data/seed.js';
import type { EnvSnapshot } from './types.js';

const pristine = {
  contracts: structuredClone(contracts),
  orders: structuredClone(orders),
  documents: structuredClone(documents),
  inventory: structuredClone(inventory),
};

/** Restore seed business state to its import-time pristine copy. */
export function resetSeedForEval(): void {
  contracts.splice(0, contracts.length, ...structuredClone(pristine.contracts));
  orders.splice(0, orders.length, ...structuredClone(pristine.orders));
  documents.splice(0, documents.length, ...structuredClone(pristine.documents));
  inventory.splice(0, inventory.length, ...structuredClone(pristine.inventory));
}

/** Point-in-time clone of the observable outcome state. */
export function snapshotEnv(): EnvSnapshot {
  return {
    contractLinked: Object.fromEntries(
      contracts.map((c) => [c.contractNo, [...c.linkedDocuments]]),
    ),
  };
}
