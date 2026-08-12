import neo4j, { type Driver } from 'neo4j-driver';

let driver: Driver | null = null;

export function getDriver(): Driver {
  if (!driver) {
    const url = process.env.NEO4J_URL ?? 'bolt://localhost:7687';
    const user = process.env.NEO4J_USER ?? 'neo4j';
    const pass = process.env.NEO4J_PASSWORD ?? '';
    if (!pass) throw new Error('NEO4J_PASSWORD not set; graph tools unavailable');
    driver = neo4j.driver(url, neo4j.auth.basic(user, pass), {
      connectionTimeout: 5000,
      connectionAcquisitionTimeout: 10000,
      maxConnectionPoolSize: 50,
      maxTransactionRetryTime: 10000,
      disableLosslessIntegers: true,
    });
  }
  return driver;
}

export async function closeNeo4j(): Promise<void> {
  if (driver) {
    await driver.close();
    driver = null;
  }
}
