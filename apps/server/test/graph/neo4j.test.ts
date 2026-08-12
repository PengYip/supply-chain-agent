import { describe, it, expect } from 'vitest';
import { getDriver, closeNeo4j } from '../../src/graph/neo4j.js';

// Live cases require a reachable Neo4j + creds; offline-dev / CI without
// NEO4J_PASSWORD -> the whole live block skips, the offline block still runs.
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD ?? '';

describe.skipIf(!NEO4J_PASSWORD)('neo4j driver singleton (live)', () => {
  it('getDriver returns a connected driver and is a singleton', async () => {
    const d1 = getDriver();
    const d2 = getDriver();
    expect(d1).toBe(d2); // singleton
    await d1.verifyConnectivity(); // throws if unreachable
    await closeNeo4j();
  });

  it('closeNeo4j resets the singleton so the next getDriver creates a new one', async () => {
    const d1 = getDriver();
    await closeNeo4j();
    const d2 = getDriver();
    expect(d2).not.toBe(d1);
    await d2.verifyConnectivity();
    await closeNeo4j();
  });
});

describe('neo4j driver (offline)', () => {
  it('getDriver throws when NEO4J_PASSWORD is empty', async () => {
    const orig = process.env.NEO4J_PASSWORD;
    process.env.NEO4J_PASSWORD = '';
    try {
      await closeNeo4j(); // ensure singleton cleared
      expect(() => getDriver()).toThrow(/NEO4J_PASSWORD/);
    } finally {
      process.env.NEO4J_PASSWORD = orig;
      await closeNeo4j();
    }
  });
});
