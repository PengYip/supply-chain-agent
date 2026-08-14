import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { ScenarioSchema, type Scenario } from './types.js';

/** Load + validate a YAML dataset file. Throws with scenario index on any invalid entry. */
export function loadDataset(path: string): Scenario[] {
  const raw = parseYaml(readFileSync(path, 'utf-8'));
  if (!raw || !Array.isArray(raw.scenarios)) {
    throw new Error(`dataset ${path} must contain a top-level 'scenarios' array`);
  }
  const scenarios = (raw.scenarios as unknown[]).map((s, i) => {
    const r = ScenarioSchema.safeParse(s);
    if (!r.success) {
      throw new Error(
        `scenario #${i} invalid: ${JSON.stringify(r.error.flatten().fieldErrors)}`,
      );
    }
    return r.data;
  });
  const ids = new Set<string>();
  for (const s of scenarios) {
    if (ids.has(s.id)) throw new Error(`duplicate scenario id: ${s.id}`);
    ids.add(s.id);
  }
  return scenarios;
}
